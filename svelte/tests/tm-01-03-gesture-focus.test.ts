/**
 * TM-01 / TM-02 / TM-03 — one tap must raise a keyboard that stays up.
 *
 * Acceptance (consumer adoption report vs v0.10.1-dist):
 *   TM-01  openDock() in DIRECT flushes open before focus → ghost is
 *          activeElement and sheet visibility is visible before return.
 *   TM-02  openCompose({ focus: true }) focuses the textarea before return;
 *          no-arg keeps v0.10.1 quiet open.
 *   TM-03  cancelSyntheticClickOnTap cancels only touchends that actually
 *          fired onTap (moved/long/link/selection taps are untouched);
 *          prop off leaves event flow byte-identical to v0.10.1.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { Component } from "svelte";
import { flushSync, mount, unmount, tick } from "./svelte-client";
import type { AnsiPalette } from "@thumbmux/core";

import ComposerDock from "../src/ComposerDock.svelte";
import TermView from "../src/TermView.svelte";

type DockApi = {
  openDock: (opts?: { focus?: boolean }) => void;
  openCompose: (opts?: { focus?: boolean }) => void;
  closeDock: () => void;
};

type Mounted = { app: Record<string, unknown>; target: HTMLElement };
const mounted: Mounted[] = [];

const palette: AnsiPalette = {
  defaultFg: "#eeeeee",
  defaultBg: "#111111",
  base: [
    "#000000", "#aa0000", "#00aa00", "#aa5500",
    "#0000aa", "#aa00aa", "#00aaaa", "#aaaaaa",
    "#555555", "#ff5555", "#55ff55", "#ffff55",
    "#5555ff", "#ff55ff", "#55ffff", "#ffffff",
  ],
};

afterEach(() => {
  while (mounted.length > 0) {
    const entry = mounted.pop()!;
    try {
      unmount(entry.app);
    } catch {
      /* already torn down */
    }
    entry.target.remove();
  }
});

function mountDock(props: Record<string, unknown>): { api: DockApi; target: HTMLElement } {
  const target = document.createElement("div");
  document.body.appendChild(target);
  let app!: Record<string, unknown>;
  flushSync(() => {
    app = mount(ComposerDock as Component, {
      target,
      props: {
        onSend: () => {},
        onDirectText: () => {},
        onDirectKey: () => {},
        ...props,
      },
    }) as Record<string, unknown>;
  });
  mounted.push({ app, target });
  const api = app as unknown as DockApi;
  if (typeof api.openDock !== "function" || typeof api.openCompose !== "function") {
    throw new Error("ComposerDock did not export openDock/openCompose");
  }
  return { api, target };
}

function asTouchList(points: Array<{ clientX: number; clientY: number }>): TouchList {
  const list = points.slice() as Array<{ clientX: number; clientY: number }> & {
    item(index: number): Touch | null;
  };
  list.item = (index: number) => (list[index] as Touch | undefined) ?? null;
  return list as unknown as TouchList;
}

function touchEvent(
  type: "touchstart" | "touchmove" | "touchend",
  touches: Array<{ clientX: number; clientY: number }>,
  changedTouches = touches,
): TouchEvent {
  const event = new Event(type, { bubbles: true, cancelable: true }) as TouchEvent;
  Object.defineProperties(event, {
    touches: { value: asTouchList(touches) },
    targetTouches: { value: asTouchList(touches) },
    changedTouches: { value: asTouchList(changedTouches) },
  });
  return event;
}

function mountTerm(
  props: Record<string, unknown>,
): { target: HTMLElement; surface: HTMLElement } {
  const target = document.createElement("div");
  target.style.cssText = "position:relative;width:320px;height:240px;";
  document.body.appendChild(target);
  let app!: Record<string, unknown>;
  flushSync(() => {
    app = mount(TermView as Component, {
      target,
      props: {
        session: "tm-gesture",
        palette,
        claimGeometry: false,
        fontPx: 13,
        ...props,
      },
    }) as Record<string, unknown>;
  });
  mounted.push({ app, target });
  const surface = target.querySelector<HTMLElement>("[data-testid='mtv']");
  if (!surface) throw new Error("TermView surface missing");
  return { target, surface };
}

// ─── TM-01 ──────────────────────────────────────────────────────────────────

describe("TM-01 openDock flushes before DIRECT focus", () => {
  test("mode=direct openDock() leaves ghost focused and sheet visible before return", () => {
    const { api, target } = mountDock({ open: false, mode: "direct" });
    const sheet = target.querySelector<HTMLElement>('[data-testid="input-sheet"]');
    const ghost = target.querySelector<HTMLInputElement>('[data-testid="ghost-key"]');
    if (!sheet || !ghost) throw new Error("sheet/ghost missing");

    expect(sheet.classList.contains("open")).toBe(false);
    expect(getComputedStyle(sheet).visibility).toBe("hidden");

    // Call and assert BEFORE any later tick/flush — acceptance requires the
    // method itself to leave the DOM in the focused+visible state.
    api.openDock();

    expect(sheet.classList.contains("open")).toBe(true);
    expect(getComputedStyle(sheet).visibility).toBe("visible");
    expect(document.activeElement).toBe(ghost);
  });
});

// ─── TM-02 ──────────────────────────────────────────────────────────────────

describe("TM-02 openCompose/openDock optional focus", () => {
  test("openCompose({ focus: true }) focuses the compose textarea before return", () => {
    const { api, target } = mountDock({ open: false, mode: "direct" });

    api.openCompose({ focus: true });

    const ta = target.querySelector<HTMLTextAreaElement>("textarea");
    if (!ta) throw new Error("compose textarea missing after openCompose");
    expect(document.activeElement).toBe(ta);
    const sheet = target.querySelector<HTMLElement>('[data-testid="input-sheet"]')!;
    expect(getComputedStyle(sheet).visibility).toBe("visible");
  });

  test("openCompose() with no argument stays quiet (v0.10.1)", () => {
    const { api, target } = mountDock({ open: false, mode: "compose" });

    api.openCompose();

    const ta = target.querySelector<HTMLTextAreaElement>("textarea");
    // Quiet open: textarea may exist but must not take focus.
    expect(document.activeElement).not.toBe(ta);
    expect(document.activeElement?.tagName).not.toBe("TEXTAREA");
  });

  test("openDock({ focus: true }) in COMPOSE focuses the textarea before return", () => {
    const { api, target } = mountDock({ open: false, mode: "compose" });

    api.openDock({ focus: true });

    const ta = target.querySelector<HTMLTextAreaElement>("textarea");
    if (!ta) throw new Error("compose textarea missing");
    expect(document.activeElement).toBe(ta);
  });

  test("openDock() with no argument in COMPOSE stays quiet", () => {
    const { api, target } = mountDock({ open: false, mode: "compose" });

    api.openDock();

    const ta = target.querySelector<HTMLTextAreaElement>("textarea");
    expect(document.activeElement).not.toBe(ta);
  });
});

// ─── TM-03 ──────────────────────────────────────────────────────────────────

describe("TM-03 cancelSyntheticClickOnTap", () => {
  test("clean tap cancels touchend when prop is true", async () => {
    let taps = 0;
    const { surface } = mountTerm({
      cancelSyntheticClickOnTap: true,
      onTap: () => {
        taps += 1;
      },
    });
    await tick();

    const pt = { clientX: 40, clientY: 80 };
    surface.dispatchEvent(touchEvent("touchstart", [pt]));
    const end = touchEvent("touchend", [], [pt]);
    surface.dispatchEvent(end);

    expect(taps).toBe(1);
    expect(end.defaultPrevented).toBe(true);
  });

  test("moved tap does not cancel touchend even with prop true", async () => {
    let taps = 0;
    const { surface } = mountTerm({
      cancelSyntheticClickOnTap: true,
      onTap: () => {
        taps += 1;
      },
    });
    await tick();

    surface.dispatchEvent(touchEvent("touchstart", [{ clientX: 40, clientY: 80 }]));
    // movement > 10 → maybeTap skips onTap
    const end = touchEvent("touchend", [], [{ clientX: 80, clientY: 160 }]);
    surface.dispatchEvent(end);

    expect(taps).toBe(0);
    expect(end.defaultPrevented).toBe(false);
  });

  test("prop false leaves clean-tap touchend uncancelled (v0.10.1)", async () => {
    let taps = 0;
    const { surface } = mountTerm({
      // prop unset / false — byte-identical event flow
      onTap: () => {
        taps += 1;
      },
    });
    await tick();

    const pt = { clientX: 40, clientY: 80 };
    surface.dispatchEvent(touchEvent("touchstart", [pt]));
    const end = touchEvent("touchend", [], [pt]);
    surface.dispatchEvent(end);

    expect(taps).toBe(1);
    expect(end.defaultPrevented).toBe(false);
  });

  test("focused input from onTap is still activeElement after 500ms when prop is true", async () => {
    const holder = document.createElement("input");
    holder.id = "host-compose-proxy";
    document.body.appendChild(holder);

    try {
      const { surface } = mountTerm({
        cancelSyntheticClickOnTap: true,
        onTap: () => {
          holder.focus();
        },
      });
      await tick();

      const pt = { clientX: 55, clientY: 90 };
      surface.dispatchEvent(touchEvent("touchstart", [pt]));
      const end = touchEvent("touchend", [], [pt]);
      surface.dispatchEvent(end);

      expect(document.activeElement).toBe(holder);
      expect(end.defaultPrevented).toBe(true);

      // Compatibility mouse sequence must not reach the pane for this gesture.
      let paneClicks = 0;
      surface.addEventListener("click", () => {
        paneClicks += 1;
      });
      // Host-level: if the browser had synthesized a click it would land here.
      // Because we cancelled touchend, hosts that re-dispatch only when
      // !defaultPrevented leave paneClicks at 0 — model that contract.
      if (!end.defaultPrevented) {
        surface.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      }

      await new Promise((r) => setTimeout(r, 520));
      expect(document.activeElement).toBe(holder);
      expect(paneClicks).toBe(0);
    } finally {
      holder.remove();
    }
  });
});
