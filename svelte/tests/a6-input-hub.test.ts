/**
 * F6 / A6 findings — ComposerDock, DesktopKeys, SessionThumb, ActionFab, NotePanel, ShortcutsSheet.
 * Each case must fail without the matching source fix (RED-before-GREEN).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { flushSync, mount, tick, unmount } from "./svelte-client";
import type { AnsiPalette } from "@thumbmux/core";
import { createSgrState, lineToHtml } from "@thumbmux/core";

import ComposerDock from "../src/ComposerDock.svelte";
import DesktopKeys from "../src/DesktopKeys.svelte";
import SessionThumb from "../src/SessionThumb.svelte";
import SessionThumbHost from "./SessionThumbHost.svelte";
import ActionFab from "../src/ActionFab.svelte";
import NotePanel from "../src/NotePanel.svelte";
import ShortcutsSheet from "../src/ShortcutsSheet.svelte";
import { tmuxMux } from "../src/ws-mux.svelte";

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

function track(app: Record<string, unknown>, target: HTMLElement): Mounted {
  const entry = { app, target };
  mounted.push(entry);
  return entry;
}

function mountComponent(
  Component: unknown,
  props: Record<string, unknown>,
): Mounted {
  const target = document.createElement("div");
  document.body.appendChild(target);
  let app!: Record<string, unknown>;
  flushSync(() => {
    app = mount(Component as never, { target, props }) as Record<string, unknown>;
  });
  return track(app, target);
}

afterEach(() => {
  while (mounted.length > 0) {
    const entry = mounted.pop()!;
    try {
      unmount(entry.app);
    } catch {
      // already torn down
    }
    entry.target.remove();
  }
});

// ─── A6-2: ComposerDock must ignore IME composition ─────────────────────────

describe("A6-2 ComposerDock isComposing", () => {
  test("COMPOSE Enter during composition does not SEND", async () => {
    let text = "partial-ime";
    const sent: string[] = [];
    const { target } = mountComponent(ComposerDock, {
      open: true,
      mode: "compose",
      get text() {
        return text;
      },
      set text(v: string) {
        text = v;
      },
      onSend: (t: string) => sent.push(t),
      onDirectText: () => {},
      onDirectKey: () => {},
    });
    await tick();

    const ta = target.querySelector<HTMLTextAreaElement>("textarea");
    if (!ta) throw new Error("compose textarea missing");

    // Control: plain Enter must SEND (proves the path is wired)
    flushSync(() => {
      ta.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
      );
    });
    expect(sent).toEqual(["partial-ime"]);

    // Restore draft and re-open compose field after sendCompose closed the dock
    text = "still-composing";
    sent.length = 0;
    // open may have been set false by sendCompose — force open again via prop if needed
    const sheet = target.querySelector('[data-testid="input-sheet"]');
    // Re-mount a fresh dock for the composition case so closed state cannot mask it
    while (mounted.length > 0) {
      const entry = mounted.pop()!;
      try {
        unmount(entry.app);
      } catch {
        /* */
      }
      entry.target.remove();
    }

    let text2 = "still-composing";
    const { target: target2 } = mountComponent(ComposerDock, {
      open: true,
      mode: "compose",
      get text() {
        return text2;
      },
      set text(v: string) {
        text2 = v;
      },
      onSend: (t: string) => sent.push(t),
      onDirectText: () => {},
      onDirectKey: () => {},
    });
    await tick();
    const ta2 = target2.querySelector<HTMLTextAreaElement>("textarea");
    if (!ta2) throw new Error("compose textarea missing (2)");

    const ev = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    Object.defineProperty(ev, "isComposing", { get: () => true });
    flushSync(() => ta2.dispatchEvent(ev));

    expect(sent).toEqual([]);
    void sheet;
  });

  test("DIRECT input/keydown during composition does not relay", async () => {
    const texts: string[] = [];
    const keys: string[] = [];
    const { target } = mountComponent(ComposerDock, {
      open: true,
      mode: "direct",
      onSend: () => {},
      onDirectText: (t: string) => texts.push(t),
      onDirectKey: (s: string) => keys.push(s),
    });
    await tick();

    const ghost = target.querySelector<HTMLInputElement>('[data-testid="ghost-key"]');
    if (!ghost) throw new Error("ghost-key missing");

    // Control: non-composing input relays
    flushSync(() => {
      ghost.value = "ok";
      ghost.dispatchEvent(new InputEvent("input", { bubbles: true, data: "ok", inputType: "insertText" }));
    });
    expect(texts).toEqual(["ok"]);
    texts.length = 0;

    // Interim composition input must NOT relay
    flushSync(() => {
      ghost.value = "に";
      const inputEv = new InputEvent("input", {
        bubbles: true,
        data: "に",
        inputType: "insertCompositionText",
      });
      Object.defineProperty(inputEv, "isComposing", { get: () => true });
      ghost.dispatchEvent(inputEv);
    });

    // Enter while composing (candidate accept) must NOT relay \r
    flushSync(() => {
      const keyEv = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
      Object.defineProperty(keyEv, "isComposing", { get: () => true });
      ghost.dispatchEvent(keyEv);
    });

    expect(texts).toEqual([]);
    expect(keys).toEqual([]);
  });
});

// ─── A6-4: DesktopKeys async paste must not outlive the component ───────────

describe("A6-4 DesktopKeys paste generation", () => {
  test("accepted paste after unmount does not call onKeys", async () => {
    let resolveConfirm!: (v: boolean) => void;
    const confirmPromise = new Promise<boolean>((r) => {
      resolveConfirm = r;
    });
    const sent: string[] = [];

    const { app, target } = mountComponent(DesktopKeys, {
      enabled: true,
      focused: true,
      onKeys: (data: string) => sent.push(data),
      confirmPaste: () => confirmPromise,
      pasteWarningLines: 1,
    });
    await tick();

    const root = target.querySelector<HTMLElement>(".desktop-keys");
    if (!root) throw new Error("DesktopKeys root missing");
    flushSync(() => root.focus());
    await tick();

    // Multi-line paste triggers confirm (ClipboardEvent may be missing in happy-dom)
    flushSync(() => {
      const pasteEv = new Event("paste", { bubbles: true, cancelable: true }) as Event & {
        clipboardData?: DataTransfer | null;
      };
      Object.defineProperty(pasteEv, "clipboardData", {
        get: () => ({
          files: [],
          items: [],
          getData: (type: string) =>
            type === "text/plain" || type === "text" ? "line1\nline2\nline3\n" : "",
        }),
      });
      root.dispatchEvent(pasteEv);
    });

    // Destroy before the host confirms
    unmount(app);
    const idx = mounted.findIndex((m) => m.app === app);
    if (idx >= 0) mounted.splice(idx, 1);
    target.remove();

    resolveConfirm(true);
    await confirmPromise;
    await tick();
    await new Promise((r) => setTimeout(r, 10));

    expect(sent).toEqual([]);
  });
});

// ─── A6-5: safeBottom must be measured when open is bound true ──────────────

describe("A6-5 ComposerDock safeBottom on external open", () => {
  test("open=true at mount measures safe-area so dockInset excludes it", async () => {
    // Count measureSafeBottom probes: each creates a fixed div then removes it.
    // happy-dom strips env() from style, so we count create+append+remove of
    // 1px-wide fixed probes instead of reading height.
    let probeAppends = 0;
    const origAppend = document.body.appendChild.bind(document.body);
    document.body.appendChild = ((node: Node) => {
      if (
        node instanceof HTMLElement
        && node.style.position === "fixed"
        && node.style.width === "1px"
        && node.style.bottom === "0px"
      ) {
        probeAppends += 1;
      }
      return origAppend(node);
    }) as typeof document.body.appendChild;

    try {
      mountComponent(ComposerDock, {
        open: false,
        mode: "compose",
        onSend: () => {},
        onDirectText: () => {},
        onDirectKey: () => {},
      });
      await tick();
      expect(probeAppends).toBe(0);

      const { target } = mountComponent(ComposerDock, {
        open: true,
        mode: "compose",
        onSend: () => {},
        onDirectText: () => {},
        onDirectKey: () => {},
      });
      await tick();
      // flush effects
      flushSync(() => {});
      await tick();

      const sheet = target.querySelector<HTMLElement>('[data-testid="input-sheet"]');
      if (!sheet) throw new Error("sheet missing");
      // Bound open=true must remeasure (not only imperative openDock).
      expect(probeAppends).toBeGreaterThan(0);
    } finally {
      document.body.appendChild = origAppend;
    }
  });
});

// ─── A6-10 / A6-11 / A6-19: SessionThumb ────────────────────────────────────

describe("A6-10 SessionThumb resubscribe", () => {
  const originalSubscribe = tmuxMux.subscribe.bind(tmuxMux);

  afterEach(() => {
    tmuxMux.subscribe = originalSubscribe as typeof tmuxMux.subscribe;
  });

  test("changing session unsubscribes the old wire subscription", async () => {
    const calls: { session: string; tail?: number }[] = [];
    const unsubLog: string[] = [];

    tmuxMux.subscribe = ((
      session: string,
      _cb: unknown,
      opts?: { tail?: number },
    ) => {
      calls.push({ session, tail: opts?.tail });
      return () => {
        unsubLog.push(session);
      };
    }) as typeof tmuxMux.subscribe;

    const { app } = mountComponent(SessionThumbHost, {
      palette,
      initialSession: "alpha",
      initialMaxLines: 10,
    });
    await tick();

    expect(calls.map((c) => c.session)).toEqual(["alpha"]);
    expect(calls[0]?.tail).toBe(20); // maxLines 10 + 10

    const host = app as {
      setSession?: (s: string) => void;
      setMaxLines?: (n: number) => void;
    };
    if (typeof host.setSession !== "function") {
      throw new Error("SessionThumbHost did not export setSession");
    }

    flushSync(() => host.setSession!("beta"));
    await tick();
    expect(unsubLog).toContain("alpha");
    expect(calls.map((c) => c.session)).toEqual(["alpha", "beta"]);

    flushSync(() => host.setMaxLines!(20));
    await tick();
    expect(unsubLog).toContain("beta");
    expect(calls.at(-1)).toEqual({ session: "beta", tail: 30 });
  });
});

describe("A6-11 SessionThumb OSC-8 not keyboard-focusable", () => {
  test("thumb subtree is inert / not in tab order", async () => {
    const originalSubscribe = tmuxMux.subscribe.bind(tmuxMux);
    tmuxMux.subscribe = ((
      _session: string,
      cb: (data: string, type?: string) => void,
    ) => {
      // OSC-8 hyperlink then text
      queueMicrotask(() => {
        cb("\x1b]8;;https://evil.example\x07click-me\x1b]8;;\x07", "output");
      });
      return () => {};
    }) as typeof tmuxMux.subscribe;

    try {
      const { target } = mountComponent(SessionThumb, {
        session: "linky",
        palette,
        maxLines: 30,
      });
      await tick();
      await new Promise((r) => setTimeout(r, 20));
      await tick();

      const thumb = target.querySelector<HTMLElement>('[data-testid="session-thumb"]');
      if (!thumb) throw new Error("thumb missing");

      // Preferred: inert removes the whole subtree from sequential focus.
      const inert = thumb.hasAttribute("inert") || (thumb as HTMLElement & { inert?: boolean }).inert;
      const ariaHidden = thumb.getAttribute("aria-hidden") === "true";

      const anchors = [...target.querySelectorAll("a")];
      const focusableAnchors = anchors.filter((a) => {
        const ti = a.getAttribute("tabindex");
        return ti !== "-1" && !a.hasAttribute("disabled");
      });

      // Either the container is inert/aria-hidden, or every anchor is tabindex=-1
      expect(inert || ariaHidden || focusableAnchors.length === 0).toBe(true);
    } finally {
      tmuxMux.subscribe = originalSubscribe as typeof tmuxMux.subscribe;
    }
  });
});

describe("A6-19 SessionThumb SGR context before slice", () => {
  test("color set in discarded context lines is inherited by the displayed tail", () => {
    // Pure reproduction of the render pipeline claimed by the finding.
    // When fixed, renderContent advances SGR through discarded lines first.
    // We import the same helpers the component uses and assert the expected
    // contract; the component-level check is that the live path matches.
    const linesToKeep = 2;
    const raw = [
      "\x1b[31mRED-CONTEXT-LINE",
      "still-red-1",
      "still-red-2",
    ].join("\n");
    const lines = raw.replace(/\r/g, "").split("\n");
    const start = Math.max(0, lines.length - linesToKeep);

    // BUG path (slice first):
    const stBug = createSgrState();
    const bugHtml = lines
      .slice(-linesToKeep)
      .map((line) => lineToHtml(line, stBug, palette))
      .join("");

    // FIXED path (advance then slice):
    const stFix = createSgrState();
    for (let i = 0; i < start; i++) lineToHtml(lines[i]!, stFix, palette);
    const fixHtml = lines
      .slice(start)
      .map((line) => lineToHtml(line, stFix, palette))
      .join("");

    // Document the bug shape so the component test can assert the fixed path.
    expect(bugHtml.includes("#aa0000")).toBe(false);
    expect(fixHtml.includes("#aa0000")).toBe(true);

    // Live component must use the fixed path (mock full content delivery)
  });

  test("mounted SessionThumb inherits SGR from discarded context", async () => {
    const originalSubscribe = tmuxMux.subscribe.bind(tmuxMux);
    // 12 lines, maxLines=2 → first 10 discarded; red set on line 0.
    const payload = [
      "\x1b[31mSET-RED",
      ...Array.from({ length: 9 }, (_, i) => `mid-${i}`),
      "tail-a",
      "tail-b",
    ].join("\n");

    let deliver: ((data: string, type?: string) => void) | null = null;
    tmuxMux.subscribe = ((
      _session: string,
      cb: (data: string, type?: string) => void,
    ) => {
      deliver = cb;
      return () => {
        deliver = null;
      };
    }) as typeof tmuxMux.subscribe;

    try {
      const { target } = mountComponent(SessionThumb, {
        session: "sgr",
        palette,
        maxLines: 2,
      });
      await tick();
      if (!deliver) throw new Error("subscribe not called");
      flushSync(() => {
        deliver!(payload, "output");
      });
      await tick();

      // deriveThumbnailPalette remaps red off #aa0000; the contract is that
      // discarded context advanced SGR so the tail has a non-default color span.
      const html = target.querySelector(".tail")?.innerHTML ?? target.innerHTML;
      expect(html).toContain("tail-a");
      expect(html).toContain("color:");
      expect(html).not.toBe("<div>tail-a</div><div>tail-b</div>");
    } finally {
      tmuxMux.subscribe = originalSubscribe as typeof tmuxMux.subscribe;
    }
  });
});

// ─── A6-12: ActionFab closed slots not tabbable ─────────────────────────────

describe("A6-12 ActionFab closed slots", () => {
  test("closed action buttons are not in the tab order and do not fire on click activation", async () => {
    const taps: string[] = [];
    const { target } = mountComponent(ActionFab, {
      open: false,
      actions: [
        { id: "a1", label: "One", testid: "fab-a1", onTap: () => taps.push("a1") },
        { id: "a2", label: "Two", testid: "fab-a2", onTap: () => taps.push("a2") },
      ],
      onFab: () => {},
    });
    await tick();

    const slots = [...target.querySelectorAll<HTMLButtonElement>(".slot")];
    expect(slots.length).toBe(2);

    for (const slot of slots) {
      const tabIndex = slot.tabIndex;
      const disabled = slot.disabled;
      const ariaHidden = slot.getAttribute("aria-hidden") === "true";
      // Closed: not a tab stop
      expect(disabled || tabIndex < 0 || ariaHidden).toBe(true);
    }

    // Enter-style activation must not run the action while closed
    flushSync(() => {
      slots[0]!.click();
    });
    expect(taps).toEqual([]);
  });
});

// ─── A6-15: NotePanel without onSave must not pretend to save ───────────────

describe("A6-15 NotePanel save without onSave", () => {
  test("default editable mount without onSave does not offer a destructive Save", async () => {
    const { target } = mountComponent(NotePanel, {
      note: "hello",
      // editable defaults true; onSave omitted
    });
    await tick();

    const edit = target.querySelector('[data-testid="note-edit"]');
    // Either edit is hidden, or if shown, save must not exit edit discarding draft
    if (!edit) {
      expect(edit).toBeNull();
      return;
    }

    flushSync(() => (edit as HTMLButtonElement).click());
    await tick();
    const draft = target.querySelector<HTMLTextAreaElement>('[data-testid="note-draft"]');
    if (!draft) throw new Error("draft missing");
    flushSync(() => {
      draft.value = "changed and precious";
      draft.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await tick();
    const save = target.querySelector<HTMLButtonElement>('[data-testid="note-save"]');
    if (!save) throw new Error("save missing");
    flushSync(() => save.click());
    await tick();

    // Must still be editing with draft preserved, or still show the new text somehow
    const stillDraft = target.querySelector<HTMLTextAreaElement>('[data-testid="note-draft"]');
    expect(stillDraft?.value ?? "").toBe("changed and precious");
  });
});

// ─── A6-16: ShortcutsSheet scale guard ──────────────────────────────────────

describe("A6-16 ShortcutsSheet pinch-zoom", () => {
  test("scale !== 1 does not lift the sheet via kbOffset", async () => {
    const vv = {
      height: 400, // half of 800 → would look like a huge keyboard without scale guard
      offsetTop: 0,
      scale: 2,
      addEventListener() {},
      removeEventListener() {},
    };
    const desc = Object.getOwnPropertyDescriptor(window, "visualViewport");
    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      value: vv,
    });
    const innerDesc = Object.getOwnPropertyDescriptor(window, "innerHeight");
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 800 });

    try {
      const { target } = mountComponent(ShortcutsSheet, {
        open: true,
        shortcuts: [],
        onChange: () => {},
      });
      await tick();

      const sheet = target.querySelector<HTMLElement>('[data-testid="shortcuts-sheet"]');
      if (!sheet) throw new Error("sheet missing");
      // When scale≠1, bottom must not be a large keyboard offset
      const bottom = sheet.style.bottom;
      expect(bottom === "" || bottom === "0px" || bottom === "null").toBe(true);
    } finally {
      if (desc) Object.defineProperty(window, "visualViewport", desc);
      else Reflect.deleteProperty(window, "visualViewport");
      if (innerDesc) Object.defineProperty(window, "innerHeight", innerDesc);
      else Reflect.deleteProperty(window, "innerHeight");
    }
  });
});
