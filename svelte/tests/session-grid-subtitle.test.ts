import { afterEach, describe, expect, test } from "bun:test";
import type { AnsiPalette } from "@thumbmux/core";
import { flushSync, mount, tick, unmount } from "./svelte-client";

import SessionGrid from "../src/SessionGrid.svelte";
import SessionGridHost from "./SessionGridHost.svelte";
import type { GridSession } from "../src/session-grid";

const palette: AnsiPalette = {
  base: [
    "#111111", "#333333", "#444444", "#555555", "#666666", "#777777", "#888888", "#999999",
    "#aaaaaa", "#bbbbbb", "#cccccc", "#dddddd", "#eeeeee", "#f0f0f0", "#fafafa", "#ffffff",
  ],
  defaultFg: "#777777",
  defaultBg: "#666666",
};

const mounted: Array<{ app: Record<string, unknown>; target: HTMLElement }> = [];

function mountGrid(sessions: GridSession[], extra: Record<string, unknown> = {}) {
  const target = document.createElement("div");
  document.body.appendChild(target);
  let app!: Record<string, unknown>;
  flushSync(() => {
    app = mount(SessionGrid, {
      target,
      props: { sessions, palette, onOpen: () => {}, onNew: () => {}, ...extra },
    }) as Record<string, unknown>;
  });
  mounted.push({ app, target });
  return target;
}

function pointer(
  target: Element,
  type: "pointerdown" | "pointermove" | "pointerup" | "pointercancel",
  init: Partial<PointerEventInit> = {},
): void {
  target.dispatchEvent(new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    pointerId: 7,
    pointerType: "touch",
    isPrimary: true,
    button: 0,
    clientX: 20,
    clientY: 20,
    ...init,
  }));
}

function pointerClick(target: Element): void {
  target.dispatchEvent(new MouseEvent("click", {
    bubbles: true,
    cancelable: true,
    detail: 1,
  }));
}

function pointerCompatibilityClick(
  target: Element,
  init: Partial<PointerEventInit> = {},
): void {
  target.dispatchEvent(new PointerEvent("click", {
    bubbles: true,
    cancelable: true,
    pointerId: 7,
    pointerType: "touch",
    isPrimary: true,
    button: 0,
    detail: 1,
    ...init,
  }));
}

function contextMenu(
  target: Element,
  init: Partial<PointerEventInit> = {},
): void {
  target.dispatchEvent(new PointerEvent("contextmenu", {
    bubbles: true,
    cancelable: true,
    pointerId: 7,
    pointerType: "touch",
    isPrimary: true,
    button: 2,
    ...init,
  }));
}

function fixedRect(left: number, top: number, right: number, bottom: number): DOMRect {
  return {
    x: left,
    y: top,
    left,
    top,
    right,
    bottom,
    width: right - left,
    height: bottom - top,
    toJSON: () => ({}),
  } as DOMRect;
}

afterEach(() => {
  while (mounted.length) {
    const entry = mounted.pop()!;
    flushSync(() => { void unmount(entry.app); });
    entry.target.remove();
  }
});

describe("grid card subtitle", () => {
  test("a card without a subtitle renders no subtitle node", async () => {
    const target = mountGrid([{ name: "alpha-1", state: "idle" }]);
    await tick();
    expect(target.querySelectorAll('[data-testid="grid-card"]').length).toBeGreaterThan(0);
    expect(target.querySelector('[data-testid="grid-subtitle"]')).toBeNull();
  });

  test("a subtitle renders as text under the name", async () => {
    const target = mountGrid([
      { name: "alpha-1", state: "working", subtitle: "กำลังรันเทสต์ชุดใหญ่อยู่" },
    ]);
    await tick();
    const subtitle = target.querySelector('[data-testid="grid-subtitle"]');
    expect(subtitle).not.toBeNull();
    expect(subtitle!.textContent).toBe("กำลังรันเทสต์ชุดใหญ่อยู่");
    // Text, not markup: a host summary is untrusted model output.
    expect(subtitle!.childElementCount).toBe(0);
  });

  test("markup in a subtitle stays text", async () => {
    const target = mountGrid([
      { name: "alpha-1", subtitle: "<img src=x onerror=alert(1)> done" },
    ]);
    await tick();
    const subtitle = target.querySelector('[data-testid="grid-subtitle"]')!;
    expect(subtitle.childElementCount).toBe(0);
    expect(subtitle.textContent).toContain("<img src=x onerror=alert(1)>");
    expect(target.querySelector("img")).toBeNull();
  });

  test("the subtitle survives grouping (both card branches render it)", async () => {
    const target = mountGrid(
      [
        { name: "alpha-1", groupKey: "build", groupLabel: "Build", subtitle: "หนึ่ง" },
        { name: "beta-1", groupKey: "review", groupLabel: "Review", subtitle: "สอง" },
      ],
      { groupable: true, defaultGrouped: true },
    );
    await tick();
    const texts = Array.from(target.querySelectorAll('[data-testid="grid-subtitle"]')).map(
      (node) => node.textContent,
    );
    expect(texts.sort()).toEqual(["สอง", "หนึ่ง"]);
  });

  test("a long subtitle is clamped rather than growing the card", async () => {
    const target = mountGrid([{ name: "alpha-1", subtitle: "ก".repeat(400) }]);
    await tick();
    const style = getComputedStyle(target.querySelector('[data-testid="grid-subtitle"]')!);
    expect(style.getPropertyValue("-webkit-line-clamp").trim()).toBe("2");
    expect(style.getPropertyValue("overflow").trim()).toBe("hidden");
  });
});

describe("dense grid card metadata", () => {
  test("keeps default cards unchanged when dense fields are supplied but not enabled", async () => {
    const target = mountGrid([{ name: "alpha-1", note: "operator note", summary: "live summary" }]);
    await tick();
    expect(target.querySelector('[data-testid="grid-card"]')?.tagName).toBe("BUTTON");
    expect(target.querySelector('[data-testid="grid-dense-head"]')).toBeNull();
    expect(target.querySelector('[data-testid="grid-note"]')).toBeNull();
    expect(target.querySelector('[data-testid="grid-summary"]')).toBeNull();
  });

  test("renders balanced dense sections, copies the name, opens from the preview, and can hide new", async () => {
    const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    let copied = "";
    const opened: string[] = [];
    const killed: string[] = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (text: string) => { copied = text; } },
    });
    try {
      const target = mountGrid(
        [{
          name: "alpha-dense-1",
          note: "โน้ต <b>ต้องเป็น text</b>",
          summary: "กำลังรัน integration tests",
        }],
        {
          cardLayout: "dense",
          showNew: false,
          onOpen: (name: string) => opened.push(name),
          onKill: (name: string) => killed.push(name),
        },
      );
      await tick();

      const card = target.querySelector<HTMLElement>('[data-testid="grid-card"]')!;
      const head = card.querySelector<HTMLElement>('[data-testid="grid-dense-head"]')!;
      expect(card.tagName).toBe("DIV");
      expect(Array.from(head.querySelectorAll<HTMLElement>(':scope > .dense-section')).map(
        (section) => section.dataset.section,
      )).toEqual(["name", "note", "summary"]);
      expect(head.querySelector('[data-testid="grid-expand"]')).toBeNull();
      expect(head.textContent).not.toContain("↗");
      expect(head.querySelector('.dense-separator')).toBeNull();
      expect(card.querySelector('[data-testid="grid-note"]')!.textContent).toBe(
        "โน้ต <b>ต้องเป็น text</b>",
      );
      expect(card.querySelector('[data-testid="grid-note"]')!.childElementCount).toBe(0);
      expect(card.querySelector('[data-testid="grid-summary"]')!.textContent).toBe(
        "กำลังรัน integration tests",
      );
      expect(card.querySelector('[data-testid="session-thumb"]')!.classList.contains("dense")).toBe(true);
      expect(target.querySelector('[data-testid="grid-new"]')).toBeNull();

      const copy = card.querySelector<HTMLButtonElement>('[data-testid="grid-copy-name"]')!;
      const openPreview = card.querySelector<HTMLButtonElement>('[data-testid="grid-expand"]')!;
      const kill = card.querySelector<HTMLButtonElement>('[data-testid="grid-kill"]')!;
      const preview = card.querySelector<HTMLElement>('.dense-preview')!;
      const thumb = card.querySelector<HTMLElement>('[data-testid="session-thumb"]')!;
      const note = card.querySelector<HTMLElement>('[data-testid="grid-note"]')!;
      const summary = card.querySelector<HTMLElement>('[data-testid="grid-summary"]')!;
      expect(getComputedStyle(copy).minWidth).toBe("44px");
      expect(openPreview.tagName).toBe("BUTTON");
      expect(openPreview.classList.contains("dense-open")).toBe(true);
      expect(openPreview.querySelector('[data-testid="session-thumb"]')).toBeNull();
      expect(preview.contains(openPreview)).toBe(true);
      expect(preview.contains(thumb)).toBe(true);
      expect(openPreview.previousElementSibling).toBe(thumb);
      expect(thumb.hasAttribute("inert")).toBe(true);
      expect(kill.textContent).toBe("×");
      expect(head.contains(kill)).toBe(true);
      expect(getComputedStyle(note).getPropertyValue("-webkit-line-clamp").trim()).toBe("3");
      expect(getComputedStyle(summary).getPropertyValue("-webkit-line-clamp").trim()).toBe("3");

      flushSync(() => {
        copy.click();
      });
      await Promise.resolve();
      expect(copied).toBe("alpha-dense-1");
      expect(opened).toEqual([]);

      flushSync(() => {
        openPreview.click();
      });
      expect(opened).toEqual(["alpha-dense-1"]);
      expect(copied).toBe("alpha-dense-1");

      flushSync(() => {
        kill.click();
      });
      expect(killed).toEqual(["alpha-dense-1"]);
      expect(opened).toEqual(["alpha-dense-1"]);
    } finally {
      if (clipboardDescriptor) {
        Object.defineProperty(navigator, "clipboard", clipboardDescriptor);
      } else {
        delete (navigator as Navigator & { clipboard?: Clipboard }).clipboard;
      }
    }
  });

  test("renders dense metadata through the grouped branch and accepts subtitle as summary fallback", async () => {
    const target = mountGrid(
      [{
        name: "alpha-grouped",
        groupKey: "build",
        groupLabel: "Build",
        note: "pinned",
        subtitle: "legacy summary",
      }],
      { cardLayout: "dense", groupable: true, defaultGrouped: true },
    );
    await tick();
    expect(target.querySelector('[data-testid="grid-note"]')?.textContent).toBe("pinned");
    expect(target.querySelector('[data-testid="grid-summary"]')?.textContent).toBe("legacy summary");
  });

  test("opens once from pointerup when an embedded browser omits click", async () => {
    const opened: string[] = [];
    const target = mountGrid(
      [{ name: "alpha-pointerup" }],
      { cardLayout: "dense", showNew: false, onOpen: (name: string) => opened.push(name) },
    );
    await tick();
    const open = target.querySelector<HTMLElement>('[data-testid="grid-expand"]')!;

    pointer(open, "pointerdown");
    pointer(open, "pointerup");
    expect(opened).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 70));
    expect(opened).toEqual(["alpha-pointerup"]);

    // A delayed compatibility click after the fallback must not open twice.
    pointerClick(open);
    expect(opened).toEqual(["alpha-pointerup"]);

    // Reusing the same pointer id for a later genuine tap must still work.
    pointer(open, "pointerdown");
    pointer(open, "pointerup");
    pointerClick(open);
    expect(opened).toEqual(["alpha-pointerup", "alpha-pointerup"]);
  });

  test("lets native click win without double activation", async () => {
    const opened: string[] = [];
    const target = mountGrid(
      [{ name: "alpha-native-click" }],
      { cardLayout: "dense", showNew: false, onOpen: (name: string) => opened.push(name) },
    );
    await tick();
    const open = target.querySelector<HTMLElement>('[data-testid="grid-expand"]')!;

    pointer(open, "pointerdown");
    pointer(open, "pointerup");
    pointerClick(open);
    expect(opened).toEqual(["alpha-native-click"]);
    await new Promise((resolve) => setTimeout(resolve, 70));
    expect(opened).toEqual(["alpha-native-click"]);
  });

  test("does not activate a drag or a cancelled scroll gesture", async () => {
    const opened: string[] = [];
    const target = mountGrid(
      [{ name: "alpha-scroll" }],
      { cardLayout: "dense", showNew: false, onOpen: (name: string) => opened.push(name) },
    );
    await tick();
    const open = target.querySelector<HTMLElement>('[data-testid="grid-expand"]')!;

    pointer(open, "pointerdown");
    pointer(open, "pointermove", { clientY: 36 });
    pointer(open, "pointerup", { clientY: 36 });
    pointerClick(open);
    await new Promise((resolve) => setTimeout(resolve, 70));
    expect(opened).toEqual([]);

    pointer(open, "pointerdown", { pointerId: 8 });
    pointer(open, "pointercancel", { pointerId: 8 });
    pointerClick(open);
    await new Promise((resolve) => setTimeout(resolve, 70));
    expect(opened).toEqual([]);
  });

  test("keeps the pressed session through a keyed reorder and rejects a removed card", async () => {
    const opened: string[] = [];
    const target = document.createElement("div");
    document.body.appendChild(target);
    let app!: Record<string, unknown> & { replaceSessions?: (sessions: GridSession[]) => void };
    flushSync(() => {
      app = mount(SessionGridHost, {
        target,
        props: {
          palette,
          initialSessions: [{ name: "alpha" }, { name: "beta" }],
          onOpen: (name: string) => opened.push(name),
          cardLayout: "dense",
          showNew: false,
        },
      }) as typeof app;
    });
    mounted.push({ app, target });
    await tick();

    const alpha = target.querySelector<HTMLElement>('[data-testid="grid-expand"][data-session="alpha"]')!;
    pointer(alpha, "pointerdown");
    flushSync(() => app.replaceSessions?.([{ name: "beta" }, { name: "alpha" }]));
    await tick();
    expect(alpha.isConnected).toBe(true);
    pointer(alpha, "pointerup");
    // Browsers can retarget the compatibility click to the card now occupying
    // the old coordinates. A modern click retains the pointerId, so the
    // pointerdown session must still win.
    const retargetedBeta = target.querySelector<HTMLElement>('[data-testid="grid-expand"][data-session="beta"]')!;
    pointerCompatibilityClick(retargetedBeta, { pointerId: 7 });
    expect(opened).toEqual(["alpha"]);
    await new Promise((resolve) => setTimeout(resolve, 70));
    expect(opened).toEqual(["alpha"]);

    const beta = target.querySelector<HTMLElement>('[data-testid="grid-expand"][data-session="beta"]')!;
    pointer(beta, "pointerdown", { pointerId: 9 });
    flushSync(() => app.replaceSessions?.([{ name: "alpha" }]));
    await tick();
    expect(beta.isConnected).toBe(false);
    pointer(beta, "pointerup", { pointerId: 9 });
    await new Promise((resolve) => setTimeout(resolve, 70));
    expect(opened).toEqual(["alpha"]);
  });

  test("keeps simultaneous primary pointer types isolated", async () => {
    const opened: string[] = [];
    const target = mountGrid(
      [{ name: "alpha-touch" }, { name: "beta-xr" }],
      { cardLayout: "dense", showNew: false, onOpen: (name: string) => opened.push(name) },
    );
    await tick();
    const alpha = target.querySelector<HTMLElement>('[data-testid="grid-expand"][data-session="alpha-touch"]')!;
    const beta = target.querySelector<HTMLElement>('[data-testid="grid-expand"][data-session="beta-xr"]')!;

    pointer(alpha, "pointerdown", { pointerId: 7, pointerType: "touch" });
    pointer(alpha, "pointerup", { pointerId: 7, pointerType: "touch" });
    pointer(beta, "pointerdown", { pointerId: 8, pointerType: "mouse" });
    pointer(beta, "pointerup", { pointerId: 8, pointerType: "mouse" });
    pointerCompatibilityClick(beta, { pointerId: 8, pointerType: "mouse" });
    expect(opened).toEqual(["beta-xr"]);

    await new Promise((resolve) => setTimeout(resolve, 70));
    pointerCompatibilityClick(alpha, { pointerId: 7, pointerType: "touch" });
    expect(opened).toEqual(["beta-xr"]);
  });

  test("lets keyboard activation win over an unrelated pending touch", async () => {
    const opened: string[] = [];
    const target = mountGrid(
      [{ name: "alpha-touch" }, { name: "beta-keyboard" }],
      { cardLayout: "dense", showNew: false, onOpen: (name: string) => opened.push(name) },
    );
    await tick();
    const alpha = target.querySelector<HTMLElement>('[data-testid="grid-expand"][data-session="alpha-touch"]')!;
    const beta = target.querySelector<HTMLButtonElement>('[data-testid="grid-expand"][data-session="beta-keyboard"]')!;

    pointer(alpha, "pointerdown");
    pointer(alpha, "pointerup");
    beta.click();
    expect(opened).toEqual(["beta-keyboard"]);
    await new Promise((resolve) => setTimeout(resolve, 70));
    pointerCompatibilityClick(alpha);
    expect(opened).toEqual(["beta-keyboard"]);
  });

  test("rejects a card removed after pointerup but before the fallback", async () => {
    const opened: string[] = [];
    const target = document.createElement("div");
    document.body.appendChild(target);
    let app!: Record<string, unknown> & { replaceSessions?: (sessions: GridSession[]) => void };
    flushSync(() => {
      app = mount(SessionGridHost, {
        target,
        props: {
          palette,
          initialSessions: [{ name: "removed-after-up" }],
          onOpen: (name: string) => opened.push(name),
          cardLayout: "dense",
          showNew: false,
        },
      }) as typeof app;
    });
    mounted.push({ app, target });
    await tick();
    const open = target.querySelector<HTMLElement>('[data-testid="grid-expand"][data-session="removed-after-up"]')!;

    pointer(open, "pointerdown");
    pointer(open, "pointerup");
    await new Promise((resolve) => setTimeout(resolve, 10));
    flushSync(() => app.replaceSessions?.([]));
    await tick();
    await new Promise((resolve) => setTimeout(resolve, 70));
    expect(opened).toEqual([]);
  });

  test("cancels release outside both the pressed and reordered card bounds", async () => {
    const opened: string[] = [];
    const target = mountGrid(
      [{ name: "alpha-edge" }],
      { cardLayout: "dense", showNew: false, onOpen: (name: string) => opened.push(name) },
    );
    await tick();
    const open = target.querySelector<HTMLElement>('[data-testid="grid-expand"][data-session="alpha-edge"]')!;
    open.getBoundingClientRect = () => fixedRect(100, 100, 200, 200);

    pointer(open, "pointerdown", { clientX: 101, clientY: 150 });
    pointer(open, "pointermove", { clientX: 96, clientY: 150 });
    pointer(open, "pointerup", { clientX: 96, clientY: 150 });
    pointerCompatibilityClick(open);
    await new Promise((resolve) => setTimeout(resolve, 70));
    expect(opened).toEqual([]);
  });

  test("accepts an unchanged pointer position when a keyed card moves", async () => {
    const opened: string[] = [];
    const target = mountGrid(
      [{ name: "alpha-moving-card" }],
      { cardLayout: "dense", showNew: false, onOpen: (name: string) => opened.push(name) },
    );
    await tick();
    const open = target.querySelector<HTMLElement>('[data-testid="grid-expand"][data-session="alpha-moving-card"]')!;
    let cardRect = fixedRect(100, 100, 200, 200);
    open.getBoundingClientRect = () => cardRect;

    pointer(open, "pointerdown", { clientX: 101, clientY: 150 });
    cardRect = fixedRect(300, 100, 400, 200);
    pointer(open, "pointerup", { clientX: 101, clientY: 150 });
    pointerCompatibilityClick(open);
    expect(opened).toEqual(["alpha-moving-card"]);
  });

  test("rejects scrolling without pointer displacement", async () => {
    const opened: string[] = [];
    const target = mountGrid(
      [{ name: "alpha-scroll-position" }],
      { cardLayout: "dense", showNew: false, onOpen: (name: string) => opened.push(name) },
    );
    await tick();
    const open = target.querySelector<HTMLElement>('[data-testid="grid-expand"][data-session="alpha-scroll-position"]')!;
    const scrollTarget = document.scrollingElement ?? document.documentElement;
    const originalScrollTop = scrollTarget.scrollTop;

    pointer(open, "pointerdown");
    scrollTarget.scrollTop = originalScrollTop + 8;
    pointer(open, "pointerup");
    pointerCompatibilityClick(open);
    await new Promise((resolve) => setTimeout(resolve, 70));
    expect(opened).toEqual([]);
    scrollTarget.scrollTop = originalScrollTop;
  });

  test("long-press context menus never become delayed activations", async () => {
    const opened: string[] = [];
    const target = mountGrid(
      [{ name: "alpha-context" }],
      { cardLayout: "dense", showNew: false, onOpen: (name: string) => opened.push(name) },
    );
    await tick();
    const open = target.querySelector<HTMLElement>('[data-testid="grid-expand"][data-session="alpha-context"]')!;

    pointer(open, "pointerdown", { pointerId: 7 });
    contextMenu(open, { pointerId: 7 });
    pointer(open, "pointerup", { pointerId: 7 });
    pointerCompatibilityClick(open, { pointerId: 7 });

    pointer(open, "pointerdown", { pointerId: 8 });
    pointer(open, "pointerup", { pointerId: 8 });
    contextMenu(open, { pointerId: 8 });
    await new Promise((resolve) => setTimeout(resolve, 70));
    pointerCompatibilityClick(open, { pointerId: 8 });
    expect(opened).toEqual([]);
  });

  test("preserves keyboard and assistive click activation", async () => {
    const opened: string[] = [];
    const target = mountGrid(
      [{ name: "alpha-keyboard" }],
      { cardLayout: "dense", showNew: false, onOpen: (name: string) => opened.push(name) },
    );
    await tick();
    const open = target.querySelector<HTMLButtonElement>('[data-testid="grid-expand"]')!;
    open.click();
    expect(opened).toEqual(["alpha-keyboard"]);
  });
});
