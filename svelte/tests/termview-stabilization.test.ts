/**
 * Stabilization defects in TermView (v0.4.0):
 * 1. A lost history_expand reply must not disable history forever.
 * 2. The non-secure clipboard fallback must not leak a hidden textarea.
 *
 * Scope: only these two behaviours. Mounts real TermView under happy-dom
 * (preload.ts) and stubs the mux singleton so no live WebSocket is needed.
 */
import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import type { Component } from "svelte";
import { flushSync, mount, unmount, tick } from "./svelte-client";

import TermView from "../src/TermView.svelte";
import { tmuxMux } from "../src/ws-mux.svelte";
import type { AnsiPalette } from "@thumbmux/core";

type Mounted = { app: Record<string, unknown>; target: HTMLElement };

const mounted: Mounted[] = [];

const palette: AnsiPalette = {
  defaultFg: "#eeeeee",
  defaultBg: "#111111",
  base: [
    "#000000",
    "#aa0000",
    "#00aa00",
    "#aa5500",
    "#0000aa",
    "#aa00aa",
    "#00aaaa",
    "#aaaaaa",
    "#555555",
    "#ff5555",
    "#55ff55",
    "#ffff55",
    "#5555ff",
    "#ff55ff",
    "#55ffff",
    "#ffffff",
  ],
};

type MuxCallback = (
  data: string,
  type?: string,
  cursor?: { row: number; col: number } | null,
  meta?: { source: "full" | "delta"; replace: boolean },
) => void;

const SESSION = "sh-termview-stabilization";

let historyCalls: Array<{ session: string; beforeLine?: number | null; limit?: number }> = [];
let sessionCallback: MuxCallback | null = null;
let originalSubscribe: typeof tmuxMux.subscribe;
let originalRequestHistory: typeof tmuxMux.requestHistory;

function mountTermView(): Mounted {
  const target = document.createElement("div");
  // Give the host a real box so clientHeight / maxOffset math is non-zero.
  target.style.cssText = "position:relative;width:320px;height:240px;";
  document.body.appendChild(target);

  let app: Record<string, unknown>;
  flushSync(() => {
    app = mount(TermView as Component, {
      target,
      props: {
        session: SESSION,
        palette,
        claimGeometry: false,
        fontPx: 13,
      },
    }) as Record<string, unknown>;
  });

  const entry = { app: app!, target };
  mounted.push(entry);
  return entry;
}

function deliverOutput(lineCount: number) {
  if (!sessionCallback) throw new Error("subscribe was not invoked");
  const data = Array.from({ length: lineCount }, (_, i) => `line-${i}`).join("\n");
  sessionCallback(data, "output", null, { source: "full", replace: true });
}

/** Scroll toward history far enough to cross the prefetch threshold. */
function scrollTowardHistory(target: HTMLElement) {
  const mtv = target.querySelector('[data-testid="mtv"]') as HTMLElement | null;
  if (!mtv) throw new Error("TermView root not found");
  // Negative deltaY = finger/trackpad scroll up = positive bottomOffset.
  mtv.dispatchEvent(
    new WheelEvent("wheel", {
      deltaY: -1_000_000,
      deltaMode: 0,
      bubbles: true,
      cancelable: true,
    }),
  );
}

beforeEach(() => {
  historyCalls = [];
  sessionCallback = null;
  originalSubscribe = tmuxMux.subscribe.bind(tmuxMux);
  originalRequestHistory = tmuxMux.requestHistory.bind(tmuxMux);

  // Avoid opening a real WebSocket; capture the delivery callback instead.
  tmuxMux.subscribe = ((session: string, cb: MuxCallback) => {
    if (session === SESSION) sessionCallback = cb;
    return () => {
      if (sessionCallback === cb) sessionCallback = null;
    };
  }) as typeof tmuxMux.subscribe;

  tmuxMux.requestHistory = ((session: string, beforeLine?: number | null, limit?: number) => {
    historyCalls.push({ session, beforeLine, limit });
  }) as typeof tmuxMux.requestHistory;
});

afterEach(() => {
  jest.useRealTimers();
  while (mounted.length > 0) {
    const entry = mounted.pop()!;
    try {
      unmount(entry.app);
    } catch {
      // already torn down
    }
    entry.target.remove();
  }
  tmuxMux.subscribe = originalSubscribe;
  tmuxMux.requestHistory = originalRequestHistory;
  // Leftover textareas from a leaking copy path would pollute later tests.
  for (const ta of Array.from(document.body.querySelectorAll("textarea"))) {
    ta.remove();
  }
});

describe("TermView history expansion recovers after a lost reply", () => {
  test("a timed-out history request still allows a later request to be sent", async () => {
    const { target } = mountTermView();
    await tick();

    deliverOutput(80);
    await tick();

    // Arm fake timers BEFORE the first request so the 5s quarantine timeout
    // is controllable (a real timer would not be advanced by jest).
    jest.useFakeTimers();

    // First prefetch while near the top of scrollback.
    scrollTowardHistory(target);
    expect(historyCalls.length).toBe(1);
    expect(historyCalls[0]?.session).toBe(SESSION);

    // Drop the reply entirely — advance past the 5s archive timeout.
    jest.advanceTimersByTime(5_000);

    // After a lost reply, a subsequent scroll-triggered request must still go out.
    // (Pre-fix: archiveReplyTimedOut stayed true forever → length stays 1.)
    scrollTowardHistory(target);
    expect(historyCalls.length).toBe(2);
    expect(historyCalls[1]?.session).toBe(SESSION);
  });
});

describe("TermView copyAll clipboard fallback cleanup", () => {
  test("failed execCommand path does not leave a hidden textarea in the DOM", async () => {
    const { app } = mountTermView();
    await tick();
    deliverOutput(12);
    await tick();

    // Force the non-secure fallback: no clipboard API (plain HTTP product path).
    const nav = navigator as Navigator & { clipboard?: Clipboard };
    const clipboardDesc = Object.getOwnPropertyDescriptor(nav, "clipboard");
    Object.defineProperty(nav, "clipboard", {
      configurable: true,
      value: undefined,
    });

    // happy-dom may not implement execCommand — install a throwing stub so the
    // fallback enters the catch path (the leak: textarea appended, not removed).
    const doc = document as Document & { execCommand?: (commandId: string) => boolean };
    const previousExec = doc.execCommand;
    doc.execCommand = () => {
      throw new Error("execCommand copy failed");
    };

    const before = document.body.querySelectorAll("textarea").length;

    try {
      const copyAll = app.copyAll as (() => Promise<boolean>) | undefined;
      expect(typeof copyAll).toBe("function");
      const ok = await copyAll!();
      expect(ok).toBe(false);

      const after = document.body.querySelectorAll("textarea").length;
      // Pre-fix: catch returned false without ta.remove() → after === before + 1.
      expect(after).toBe(before);
    } finally {
      if (previousExec) doc.execCommand = previousExec;
      else delete doc.execCommand;
      if (clipboardDesc) {
        Object.defineProperty(nav, "clipboard", clipboardDesc);
      } else {
        delete (nav as { clipboard?: Clipboard }).clipboard;
      }
    }
  });
});
