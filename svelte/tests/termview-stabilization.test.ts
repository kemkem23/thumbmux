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
import { TmuxMux, tmuxMux } from "../src/ws-mux.svelte";
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

type SocketListener = (event?: any) => void;

class HistoryFakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: HistoryFakeWebSocket[] = [];

  readyState = HistoryFakeWebSocket.CONNECTING;
  onopen: SocketListener | null = null;
  onmessage: SocketListener | null = null;
  onclose: SocketListener | null = null;
  onerror: SocketListener | null = null;
  sent: string[] = [];

  constructor(_url: string) {
    HistoryFakeWebSocket.instances.push(this);
  }

  send(data: string) {
    if (this.readyState !== HistoryFakeWebSocket.OPEN) {
      throw new Error(`send while readyState=${this.readyState}`);
    }
    this.sent.push(data);
  }

  close() {
    if (
      this.readyState === HistoryFakeWebSocket.OPEN
      || this.readyState === HistoryFakeWebSocket.CONNECTING
    ) {
      this.readyState = HistoryFakeWebSocket.CLOSING;
    }
  }

  open() {
    this.readyState = HistoryFakeWebSocket.OPEN;
    this.onopen?.({ type: "open" });
  }

  receive(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  frames() {
    return this.sent.map((frame) => JSON.parse(frame));
  }
}

const SESSION = "sh-termview-stabilization";

let historyCalls: Array<{ session: string; beforeLine?: number | null; limit?: number }> = [];
let sessionCallback: MuxCallback | null = null;
let originalSubscribeDescriptor: PropertyDescriptor | undefined;
let originalRequestHistoryDescriptor: PropertyDescriptor | undefined;

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
  originalSubscribeDescriptor = Object.getOwnPropertyDescriptor(tmuxMux, "subscribe");
  originalRequestHistoryDescriptor = Object.getOwnPropertyDescriptor(tmuxMux, "requestHistory");

  // Avoid opening a real WebSocket; capture the delivery callback instead.
  tmuxMux.subscribe = ((session: string, cb: MuxCallback) => {
    if (session === SESSION) sessionCallback = cb;
    return () => {
      if (sessionCallback === cb) sessionCallback = null;
    };
  }) as typeof tmuxMux.subscribe;

  tmuxMux.requestHistory = ((session: string, beforeLine?: number | null, limit?: number) => {
    historyCalls.push({ session, beforeLine, limit });
    return true;
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
  if (originalSubscribeDescriptor) {
    Object.defineProperty(tmuxMux, "subscribe", originalSubscribeDescriptor);
  } else {
    Reflect.deleteProperty(tmuxMux, "subscribe");
  }
  if (originalRequestHistoryDescriptor) {
    Object.defineProperty(tmuxMux, "requestHistory", originalRequestHistoryDescriptor);
  } else {
    Reflect.deleteProperty(tmuxMux, "requestHistory");
  }
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
    // This stub covers TermView's local state only; the real-mux test below
    // separately verifies that the second request reaches a fresh wire.
    scrollTowardHistory(target);
    expect(historyCalls.length).toBe(2);
    expect(historyCalls[1]?.session).toBe(SESSION);
  });

  test("a rejected request remains retryable and owns no recovery", async () => {
    jest.useFakeTimers();
    let recoverCalls = 0;
    const originalRecoverDescriptor = Object.getOwnPropertyDescriptor(
      tmuxMux,
      "recoverHistoryRequest",
    );
    tmuxMux.recoverHistoryRequest = ((_session: string) => {
      recoverCalls += 1;
      return true;
    }) as typeof tmuxMux.recoverHistoryRequest;
    tmuxMux.requestHistory = ((
      session: string,
      beforeLine?: number | null,
      limit?: number,
    ) => {
      historyCalls.push({ session, beforeLine, limit });
      return false;
    }) as typeof tmuxMux.requestHistory;

    let entry: Mounted | null = null;
    try {
      entry = mountTermView();
      await tick();
      deliverOutput(80);
      await tick();

      scrollTowardHistory(entry.target);
      scrollTowardHistory(entry.target);
      expect(historyCalls).toHaveLength(2);

      jest.advanceTimersByTime(5_000);
      const index = mounted.indexOf(entry);
      if (index >= 0) mounted.splice(index, 1);
      unmount(entry.app);
      entry.target.remove();
      entry = null;

      expect(recoverCalls).toBe(0);
    } finally {
      if (entry) {
        const index = mounted.indexOf(entry);
        if (index >= 0) mounted.splice(index, 1);
        try {
          unmount(entry.app);
        } catch {
          // already torn down
        }
        entry.target.remove();
      }
      if (originalRecoverDescriptor) {
        Object.defineProperty(tmuxMux, "recoverHistoryRequest", originalRecoverDescriptor);
      } else {
        Reflect.deleteProperty(tmuxMux, "recoverHistoryRequest");
      }
    }
  });

  test("an already-queued timeout cannot recover after its reply was claimed", async () => {
    const originalSetTimeoutDescriptor = Object.getOwnPropertyDescriptor(globalThis, "setTimeout");
    const originalClearTimeoutDescriptor = Object.getOwnPropertyDescriptor(globalThis, "clearTimeout");
    const originalSetTimeout = globalThis.setTimeout.bind(globalThis);
    const originalClearTimeout = globalThis.clearTimeout.bind(globalThis);
    const originalRecoverDescriptor = Object.getOwnPropertyDescriptor(
      tmuxMux,
      "recoverHistoryRequest",
    );
    const queuedHandle = { kind: "queued-history-timeout" } as unknown as ReturnType<typeof setTimeout>;
    let queuedTimeout: (() => void) | null = null;
    let recoverCalls = 0;

    Object.defineProperty(globalThis, "setTimeout", {
      configurable: true,
      writable: true,
      value: ((handler: TimerHandler, delay?: number, ...args: any[]) => {
        if (delay === 5_000 && typeof handler === "function") {
          queuedTimeout = () => handler(...args);
          return queuedHandle;
        }
        return originalSetTimeout(handler, delay, ...args);
      }) as typeof setTimeout,
    });
    Object.defineProperty(globalThis, "clearTimeout", {
      configurable: true,
      writable: true,
      value: ((handle?: ReturnType<typeof setTimeout>) => {
        // Model a timer task already queued by the browser: clearing its timer
        // record can no longer prevent that queued callback from running.
        if (handle === queuedHandle) return;
        originalClearTimeout(handle);
      }) as typeof clearTimeout,
    });
    tmuxMux.recoverHistoryRequest = ((_session: string) => {
      recoverCalls += 1;
      return true;
    }) as typeof tmuxMux.recoverHistoryRequest;

    try {
      mountTermView();
      await tick();
      deliverOutput(80);
      await tick();
      scrollTowardHistory(mounted.at(-1)!.target);
      expect(queuedTimeout).not.toBeNull();

      sessionCallback?.(
        '{"lines":[],"startLine":null,"hasMore":false}',
        "history",
      );
      queuedTimeout!();

      expect(recoverCalls).toBe(0);
    } finally {
      if (originalSetTimeoutDescriptor) {
        Object.defineProperty(globalThis, "setTimeout", originalSetTimeoutDescriptor);
      } else {
        Reflect.deleteProperty(globalThis, "setTimeout");
      }
      if (originalClearTimeoutDescriptor) {
        Object.defineProperty(globalThis, "clearTimeout", originalClearTimeoutDescriptor);
      } else {
        Reflect.deleteProperty(globalThis, "clearTimeout");
      }
      if (originalRecoverDescriptor) {
        Object.defineProperty(tmuxMux, "recoverHistoryRequest", originalRecoverDescriptor);
      } else {
        Reflect.deleteProperty(tmuxMux, "recoverHistoryRequest");
      }
    }
  });

  test("a real mux puts the post-timeout retry on a fresh wire", async () => {
    jest.useFakeTimers();
    HistoryFakeWebSocket.instances = [];
    const originalWebSocket = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");
    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      writable: true,
      value: HistoryFakeWebSocket,
    });

    const isolatedMux = new TmuxMux();
    const originalRecoverDescriptor = Object.getOwnPropertyDescriptor(
      tmuxMux,
      "recoverHistoryRequest",
    );
    tmuxMux.recoverHistoryRequest = isolatedMux.recoverHistoryRequest.bind(isolatedMux);

    const isolatedRequestHistory = isolatedMux.requestHistory.bind(isolatedMux);
    let requestAttempts = 0;
    tmuxMux.subscribe = isolatedMux.subscribe.bind(isolatedMux) as typeof tmuxMux.subscribe;
    tmuxMux.requestHistory = ((
      session: string,
      beforeLine?: number | null,
      limit?: number,
    ) => {
      requestAttempts += 1;
      return isolatedRequestHistory(session, beforeLine, limit);
    }) as typeof tmuxMux.requestHistory;

    let entry: Mounted | null = null;
    try {
      entry = mountTermView();
      await tick();

      const firstSocket = HistoryFakeWebSocket.instances[0]!;
      firstSocket.open();
      firstSocket.receive({
        channel: SESSION,
        type: "output",
        data: Array.from({ length: 80 }, (_, i) => `line-${i}`).join("\n"),
        cursor: null,
        reset: "resize",
      });
      await tick();

      scrollTowardHistory(entry.target);
      expect(requestAttempts).toBe(1);
      expect(
        HistoryFakeWebSocket.instances.flatMap((socket) => socket.frames())
          .filter((frame) => frame.type === "history_expand"),
      ).toHaveLength(1);

      // Lose the reply. TermView's 5s timeout must retire the ambiguous old
      // socket; once the replacement opens, its next scroll retries on wire.
      jest.advanceTimersByTime(5_000);
      await tick();
      expect(HistoryFakeWebSocket.instances).toHaveLength(2);
      expect(firstSocket.readyState).toBe(HistoryFakeWebSocket.CLOSING);
      const replacement = HistoryFakeWebSocket.instances[1]!;
      replacement.open();
      scrollTowardHistory(entry.target);

      expect(requestAttempts).toBe(2);
      expect(firstSocket.frames().filter((frame) => frame.type === "history_expand"))
        .toHaveLength(1);
      expect(replacement.frames().filter((frame) => frame.type === "history_expand"))
        .toHaveLength(1);
    } finally {
      if (entry) {
        const index = mounted.indexOf(entry);
        if (index >= 0) mounted.splice(index, 1);
        try {
          unmount(entry.app);
        } catch {
          // already torn down
        }
        entry.target.remove();
      }
      isolatedMux.dispose();
      if (originalRecoverDescriptor) {
        Object.defineProperty(tmuxMux, "recoverHistoryRequest", originalRecoverDescriptor);
      } else {
        Reflect.deleteProperty(tmuxMux, "recoverHistoryRequest");
      }
      if (originalWebSocket) Object.defineProperty(globalThis, "WebSocket", originalWebSocket);
      else delete (globalThis as Record<string, unknown>).WebSocket;
    }
  });

  test("unmount fences an accepted request so a remounted viewer can page", async () => {
    jest.useFakeTimers();
    HistoryFakeWebSocket.instances = [];
    const originalWebSocket = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");
    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      writable: true,
      value: HistoryFakeWebSocket,
    });

    const isolatedMux = new TmuxMux();
    const originalRecoverDescriptor = Object.getOwnPropertyDescriptor(
      tmuxMux,
      "recoverHistoryRequest",
    );
    tmuxMux.recoverHistoryRequest = isolatedMux.recoverHistoryRequest.bind(isolatedMux);
    tmuxMux.subscribe = isolatedMux.subscribe.bind(isolatedMux) as typeof tmuxMux.subscribe;
    tmuxMux.requestHistory = isolatedMux.requestHistory.bind(isolatedMux) as typeof tmuxMux.requestHistory;

    let firstEntry: Mounted | null = null;
    let secondEntry: Mounted | null = null;
    try {
      firstEntry = mountTermView();
      await tick();

      const firstSocket = HistoryFakeWebSocket.instances[0]!;
      firstSocket.open();
      firstSocket.receive({
        channel: SESSION,
        type: "output",
        data: Array.from({ length: 80 }, (_, i) => `first-${i}`).join("\n"),
        cursor: null,
        reset: "resize",
      });
      await tick();
      scrollTowardHistory(firstEntry.target);
      expect(firstSocket.frames().filter((frame) => frame.type === "history_expand"))
        .toHaveLength(1);

      const firstIndex = mounted.indexOf(firstEntry);
      if (firstIndex >= 0) mounted.splice(firstIndex, 1);
      unmount(firstEntry.app);
      firstEntry.target.remove();
      firstEntry = null;

      expect(HistoryFakeWebSocket.instances).toHaveLength(2);
      expect(firstSocket.readyState).toBe(HistoryFakeWebSocket.CLOSING);
      const replacement = HistoryFakeWebSocket.instances[1]!;
      replacement.open();

      secondEntry = mountTermView();
      await tick();
      replacement.receive({
        channel: SESSION,
        type: "output",
        data: Array.from({ length: 80 }, (_, i) => `second-${i}`).join("\n"),
        cursor: null,
        reset: "resize",
      });
      await tick();
      scrollTowardHistory(secondEntry.target);

      expect(replacement.frames().filter((frame) => frame.type === "history_expand"))
        .toHaveLength(1);
      replacement.receive({
        channel: SESSION,
        type: "history",
        data: '{"lines":[],"startLine":null,"hasMore":false}',
      });
      await tick();
    } finally {
      for (const entry of [firstEntry, secondEntry]) {
        if (!entry) continue;
        const index = mounted.indexOf(entry);
        if (index >= 0) mounted.splice(index, 1);
        try {
          unmount(entry.app);
        } catch {
          // already torn down
        }
        entry.target.remove();
      }
      isolatedMux.dispose();
      if (originalRecoverDescriptor) {
        Object.defineProperty(tmuxMux, "recoverHistoryRequest", originalRecoverDescriptor);
      } else {
        Reflect.deleteProperty(tmuxMux, "recoverHistoryRequest");
      }
      if (originalWebSocket) Object.defineProperty(globalThis, "WebSocket", originalWebSocket);
      else delete (globalThis as Record<string, unknown>).WebSocket;
    }
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
      else Reflect.deleteProperty(doc, "execCommand");
      if (clipboardDesc) {
        Object.defineProperty(nav, "clipboard", clipboardDesc);
      } else {
        delete (nav as { clipboard?: Clipboard }).clipboard;
      }
    }
  });
});
