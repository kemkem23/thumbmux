/**
 * Focused component contract for TermView's bounded bidirectional archive.
 * The pure range/byte model has its own exhaustive tests; this file proves the
 * real Svelte surface wires scroll gestures, tokenless direction, live capture,
 * pixel anchoring, signposts, and alt-screen teardown to that model.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Component } from "svelte";
import { flushSync, mount, unmount, tick } from "./svelte-client";

import TermView from "../src/TermView.svelte";
import { tmuxMux } from "../src/ws-mux.svelte";
import type { AnsiPalette, MuxHistoryBoundary } from "@thumbmux/core";

type ScreenMode = { alt: boolean; mouseSgr: boolean; mouseAny: boolean };
type MuxCallback = (
  data: string,
  type?: string,
  cursor?: { row: number; col: number } | null,
  meta?: {
    source: "full" | "delta";
    replace: boolean;
    screen?: ScreenMode | null;
    boundary?: MuxHistoryBoundary;
  },
) => void;
type HistoryCall =
  | { direction: "before"; cursor: number | null; limit?: number }
  | { direction: "after"; cursor: number | null; limit?: number };
type Mounted = {
  app: Record<string, unknown>;
  target: HTMLElement;
  viewport: HTMLElement;
};

class ControlledResizeObserver implements ResizeObserver {
  static latest: ControlledResizeObserver | null = null;

  constructor(private readonly callback: ResizeObserverCallback) {
    ControlledResizeObserver.latest = this;
  }

  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  fire(): void { this.callback([], this); }
}

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

const SESSION = "sh-termview-sliding-history";
const VIEW_HEIGHT = 240;
const LINE_HEIGHT = 21; // round(13 * 1.6)
const mounted: Mounted[] = [];

let sessionCallback: MuxCallback | null = null;
let historyCalls: HistoryCall[] = [];
let recoverCalls = 0;
let deliveredLines: string[][] = [];

let originalSubscribe: typeof tmuxMux.subscribe;
let originalRequestHistory: typeof tmuxMux.requestHistory;
let originalRequestHistoryAfter: typeof tmuxMux.requestHistoryAfter;
let originalRecoverHistoryRequest: typeof tmuxMux.recoverHistoryRequest;
let originalResizeObserver: typeof ResizeObserver;
let originalWindowResizeObserver: typeof ResizeObserver;
let originalRequestAnimationFrame: typeof requestAnimationFrame;
let originalCancelAnimationFrame: typeof cancelAnimationFrame;
let originalWindowRequestAnimationFrame: typeof window.requestAnimationFrame;
let originalWindowCancelAnimationFrame: typeof window.cancelAnimationFrame;
let originalRequestIdleCallback: typeof requestIdleCallback | undefined;
let originalCancelIdleCallback: typeof cancelIdleCallback | undefined;

let frameNow = 0;
let nextFrameId = 1;
let frameCallbacks = new Map<number, FrameRequestCallback>();
let nextIdleId = 1;
let idleCallbacks = new Map<number, IdleRequestCallback>();

function requestControlledFrame(callback: FrameRequestCallback): number {
  const id = nextFrameId++;
  frameCallbacks.set(id, callback);
  return id;
}

function cancelControlledFrame(id: number): void {
  frameCallbacks.delete(id);
}

function requestControlledIdle(callback: IdleRequestCallback): number {
  const id = nextIdleId++;
  idleCallbacks.set(id, callback);
  return id;
}

function cancelControlledIdle(id: number): void {
  idleCallbacks.delete(id);
}

function drainScheduledWork(limit = 2_000): void {
  let turns = 0;
  while ((frameCallbacks.size > 0 || idleCallbacks.size > 0) && turns < limit) {
    if (frameCallbacks.size > 0) {
      const callbacks = [...frameCallbacks.values()];
      frameCallbacks.clear();
      frameNow += 16;
      for (const callback of callbacks) callback(frameNow);
      flushSync();
    }
    if (idleCallbacks.size > 0) {
      const callbacks = [...idleCallbacks.values()];
      idleCallbacks.clear();
      const deadline: IdleDeadline = { didTimeout: false, timeRemaining: () => 50 };
      for (const callback of callbacks) callback(deadline);
      flushSync();
    }
    turns++;
  }
  if (frameCallbacks.size > 0 || idleCallbacks.size > 0) {
    throw new Error(`controlled scheduler did not settle after ${limit} turns`);
  }
}

function mountTermView(): Mounted {
  const target = document.createElement("div");
  target.style.cssText = "position:relative;width:320px;height:240px;";
  document.body.appendChild(target);

  let app!: Record<string, unknown>;
  flushSync(() => {
    app = mount(TermView as Component, {
      target,
      props: {
        session: SESSION,
        palette,
        claimGeometry: false,
        fontPx: 13,
        // Intentionally omit historyPaging: this verifies sliding is default.
        onLinesChange: (lines: string[]) => deliveredLines.push([...lines]),
      },
    }) as Record<string, unknown>;
  });

  const viewport = target.querySelector<HTMLElement>('[data-testid="mtv"]');
  if (!viewport) throw new Error("TermView root not found");
  Object.defineProperties(viewport, {
    clientWidth: { configurable: true, get: () => 320 },
    clientHeight: { configurable: true, get: () => VIEW_HEIGHT },
  });
  viewport.getBoundingClientRect = () => ({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: 320,
    bottom: VIEW_HEIGHT,
    width: 320,
    height: VIEW_HEIGHT,
    toJSON: () => ({}),
  }) as DOMRect;
  const resizeObserver = ControlledResizeObserver.latest;
  if (!resizeObserver) throw new Error("TermView did not observe its viewport");
  resizeObserver.fire();
  flushSync();
  drainScheduledWork();

  const entry = { app, target, viewport };
  mounted.push(entry);
  return entry;
}

function archiveLines(startLine: number, count: number): string[] {
  return Array.from({ length: count }, (_, index) => `archive-${startLine + index}`);
}

function liveLines(prefix = "live", count = 240): string[] {
  return Array.from({ length: count }, (_, index) => `${prefix}-${index}`);
}

function absoluteLines(startLine: number, count: number): string[] {
  return Array.from({ length: count }, (_, index) => `absolute-${startLine + index}`);
}

function deliverOutput(
  lines: string[],
  screen?: ScreenMode | null,
  boundary?: MuxHistoryBoundary,
): void {
  if (!sessionCallback) throw new Error("subscribe was not invoked");
  sessionCallback(lines.join("\n"), "output", null, {
    source: "full",
    replace: true,
    ...(screen === undefined ? {} : { screen }),
    ...(boundary === undefined ? {} : { boundary }),
  });
  flushSync();
  drainScheduledWork();
}

function deliverHistory(
  startLine: number | null,
  lines: string[],
  hasMore: boolean,
  totalArchivedLines?: number,
): void {
  if (!sessionCallback) throw new Error("subscribe was not invoked");
  sessionCallback(JSON.stringify({
    lines,
    startLine,
    endLine: startLine === null ? null : startLine + lines.length,
    hasMore,
    ...(totalArchivedLines === undefined ? {} : { totalArchivedLines }),
  }), "history");
  flushSync();
  drainScheduledWork();
}

function wheel(viewport: HTMLElement, deltaY: number): void {
  viewport.dispatchEvent(new WheelEvent("wheel", {
    deltaY,
    deltaMode: WheelEvent.DOM_DELTA_PIXEL,
    bubbles: true,
    cancelable: true,
  }));
  flushSync();
  drainScheduledWork();
}

function numberAttr(viewport: HTMLElement, name: string): number {
  const raw = viewport.getAttribute(name);
  if (raw === null) throw new Error(`${name} missing`);
  return Number(raw);
}

/** Absolute archive row at the viewport's top edge (within archive pages). */
function absoluteTopLine(viewport: HTMLElement): number {
  const total = numberAttr(viewport, "data-total");
  const bottomOffset = numberAttr(viewport, "data-bottom-offset");
  const startLine = numberAttr(viewport, "data-history-window-start");
  const maxOffset = Math.max(0, total * LINE_HEIGHT - VIEW_HEIGHT);
  const scrollTop = maxOffset - Math.max(0, Math.min(bottomOffset, maxOffset));
  return startLine + Math.floor(scrollTop / LINE_HEIGHT);
}

beforeEach(() => {
  sessionCallback = null;
  historyCalls = [];
  recoverCalls = 0;
  deliveredLines = [];
  ControlledResizeObserver.latest = null;
  frameNow = 0;
  nextFrameId = 1;
  frameCallbacks = new Map();
  nextIdleId = 1;
  idleCallbacks = new Map();

  originalSubscribe = tmuxMux.subscribe;
  originalRequestHistory = tmuxMux.requestHistory;
  originalRequestHistoryAfter = tmuxMux.requestHistoryAfter;
  originalRecoverHistoryRequest = tmuxMux.recoverHistoryRequest;
  tmuxMux.subscribe = ((session: string, callback: MuxCallback) => {
    if (session === SESSION) sessionCallback = callback;
    return () => {
      if (sessionCallback === callback) sessionCallback = null;
    };
  }) as typeof tmuxMux.subscribe;
  tmuxMux.requestHistory = ((_session: string, beforeLine?: number | null, limit?: number) => {
    historyCalls.push({ direction: "before", cursor: beforeLine ?? null, limit });
    return true;
  }) as typeof tmuxMux.requestHistory;
  tmuxMux.requestHistoryAfter = ((_session: string, afterLine: number | null, limit?: number) => {
    historyCalls.push({ direction: "after", cursor: afterLine, limit });
    return true;
  }) as typeof tmuxMux.requestHistoryAfter;
  tmuxMux.recoverHistoryRequest = ((_session: string) => {
    recoverCalls++;
    return true;
  }) as typeof tmuxMux.recoverHistoryRequest;

  originalResizeObserver = globalThis.ResizeObserver;
  originalWindowResizeObserver = window.ResizeObserver;
  globalThis.ResizeObserver = ControlledResizeObserver;
  window.ResizeObserver = ControlledResizeObserver;

  originalRequestAnimationFrame = globalThis.requestAnimationFrame;
  originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
  originalWindowRequestAnimationFrame = window.requestAnimationFrame;
  originalWindowCancelAnimationFrame = window.cancelAnimationFrame;
  globalThis.requestAnimationFrame = requestControlledFrame;
  globalThis.cancelAnimationFrame = cancelControlledFrame;
  window.requestAnimationFrame = requestControlledFrame;
  window.cancelAnimationFrame = cancelControlledFrame;

  originalRequestIdleCallback = globalThis.requestIdleCallback;
  originalCancelIdleCallback = globalThis.cancelIdleCallback;
  globalThis.requestIdleCallback = requestControlledIdle;
  globalThis.cancelIdleCallback = cancelControlledIdle;
});

afterEach(() => {
  while (mounted.length > 0) {
    const entry = mounted.pop()!;
    try { unmount(entry.app); } catch { /* already unmounted */ }
    entry.target.remove();
  }
  tmuxMux.subscribe = originalSubscribe;
  tmuxMux.requestHistory = originalRequestHistory;
  tmuxMux.requestHistoryAfter = originalRequestHistoryAfter;
  tmuxMux.recoverHistoryRequest = originalRecoverHistoryRequest;
  globalThis.ResizeObserver = originalResizeObserver;
  window.ResizeObserver = originalWindowResizeObserver;
  globalThis.requestAnimationFrame = originalRequestAnimationFrame;
  globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
  window.requestAnimationFrame = originalWindowRequestAnimationFrame;
  window.cancelAnimationFrame = originalWindowCancelAnimationFrame;
  if (originalRequestIdleCallback) globalThis.requestIdleCallback = originalRequestIdleCallback;
  else Reflect.deleteProperty(globalThis, "requestIdleCallback");
  if (originalCancelIdleCallback) globalThis.cancelIdleCallback = originalCancelIdleCallback;
  else Reflect.deleteProperty(globalThis, "cancelIdleCallback");
  frameCallbacks.clear();
  idleCallbacks.clear();
});

describe("TermView sliding archive window", () => {
  test("advances an atomic seam without gaps, duplicates, or a detached-reader jump", async () => {
    const { viewport } = mountTermView();
    await tick();
    const boundary = (
      generation: string,
      liveStartLine: number,
      sequence: number,
    ): MuxHistoryBoundary => ({
      generation,
      liveStartLine,
      walSequence: String(sequence),
      walOffset: sequence * 100,
    });

    deliverOutput(absoluteLines(100, 20), undefined, boundary("g1", 100, 10));
    wheel(viewport, -1_000_000);
    expect(historyCalls.at(-1)).toMatchObject({ direction: "before", cursor: null });
    deliverHistory(80, absoluteLines(80, 20), false, 100);
    expect(viewport.getAttribute("data-history-window-attached")).toBe("1");
    wheel(viewport, -1_000_000);
    const anchoredTop = absoluteTopLine(viewport);

    // Five old live rows crossed into the durable archive while this reader was
    // away. The visible absolute anchor stays fixed and the newer edge becomes
    // pageable instead of pretending the old archive still touches live.
    deliverOutput(absoluteLines(105, 20), undefined, boundary("g1", 105, 15));
    expect(absoluteTopLine(viewport)).toBe(anchoredTop);
    expect(viewport.getAttribute("data-history-window-attached")).toBe("0");
    expect(viewport.getAttribute("data-history-window-has-newer")).toBe("1");

    wheel(viewport, 1_000_000);
    expect(historyCalls.at(-1)).toEqual({ direction: "after", cursor: 99, limit: 2_000 });
    deliverHistory(100, absoluteLines(100, 5), false, 105);
    expect(viewport.getAttribute("data-history-window-attached")).toBe("1");
    expect(deliveredLines.at(-1)).toEqual(absoluteLines(80, 45));
    expect(new Set(deliveredLines.at(-1)).size).toBe(45);

    // At the real bottom an advanced seam invalidates the stale resident
    // archive. The next backward request seeds exactly from the new liveStart.
    wheel(viewport, 1_000_000);
    deliverOutput(absoluteLines(110, 20), undefined, boundary("g1", 110, 20));
    expect(viewport.getAttribute("data-history-window-start")).toBeNull();
    expect(numberAttr(viewport, "data-total")).toBe(20);
    wheel(viewport, -1_000_000);
    expect(historyCalls.at(-1)).toMatchObject({ direction: "before", cursor: null });
    deliverHistory(90, absoluteLines(90, 20), false, 110);
    expect(deliveredLines.at(-1)).toEqual(absoluteLines(90, 40));
    expect(new Set(deliveredLines.at(-1)).size).toBe(40);

    // A generation reset is an explicit new absolute world; old archive rows
    // and scroll position cannot leak into it.
    deliverOutput(absoluteLines(0, 20), undefined, boundary("g2", 0, 1));
    expect(viewport.getAttribute("data-history-generation")).toBe("g2");
    expect(viewport.getAttribute("data-history-window-start")).toBeNull();
    expect(numberAttr(viewport, "data-bottom-offset")).toBe(0);
    expect(deliveredLines.at(-1)).toEqual(absoluteLines(0, 20));
  });

  test("pages backward past 10k, then forward to the live seam without moving the reader anchor", async () => {
    const { viewport, target } = mountTermView();
    await tick();
    deliverOutput(liveLines());
    expect(viewport.getAttribute("data-history-paging")).toBe("sliding");

    const beforePages = [18_000, 16_000, 14_000, 12_000, 10_000, 8_000];
    for (let index = 0; index < beforePages.length; index++) {
      wheel(viewport, -1_000_000);
      const expectedCursor = index === 0 ? null : beforePages[index - 1];
      expect(historyCalls.at(-1)).toEqual({
        direction: "before",
        cursor: expectedCursor,
        limit: 2_000,
      });
      const pageLines = archiveLines(beforePages[index]!, 2_000);
      if (beforePages[index] === 8_000) {
        // No reset: this SGR state must survive later forward-prefix eviction.
        pageLines[0] = `\u001b[31m${pageLines[0]}`;
      }
      deliverHistory(beforePages[index]!, pageLines, true);
    }

    // The sixth page crosses the 9,760-row archive allowance (240 live rows
    // reserve the rest). The newer side is evicted and live detaches.
    expect(numberAttr(viewport, "data-history-window-start")).toBe(8_000);
    expect(numberAttr(viewport, "data-history-window-end")).toBe(17_760);
    expect(numberAttr(viewport, "data-history-window-rows")).toBe(9_760);
    expect(numberAttr(viewport, "data-total")).toBeLessThanOrEqual(10_000);
    expect(viewport.getAttribute("data-history-window-attached")).toBe("0");
    expect(viewport.getAttribute("data-history-window-has-newer")).toBe("1");
    expect(viewport.getAttribute("data-history-ceiling")).toBeNull();
    expect(viewport.querySelector<HTMLElement>(".mtv-line")?.innerHTML)
      .toContain("color:#aa0000");

    // Pixel anchor proof: before the cap-crossing commit the viewport was at
    // archive line 10,000. Prepending 2,000 rows and evicting the opposite
    // side keeps that same absolute line at the top.
    expect(absoluteTopLine(viewport)).toBe(10_000);

    wheel(viewport, 1_000_000);
    expect(historyCalls.at(-1)).toEqual({
      direction: "after",
      cursor: 17_759,
      limit: 2_000,
    });
    expect(viewport.getAttribute("data-history-request-direction")).toBe("after");

    const detachedTotal = numberAttr(viewport, "data-total");
    const detachedStart = numberAttr(viewport, "data-history-window-start");
    const detachedEnd = numberAttr(viewport, "data-history-window-end");
    deliverOutput(liveLines("fresh-live"));
    expect(numberAttr(viewport, "data-total")).toBe(detachedTotal);
    expect(numberAttr(viewport, "data-history-window-start")).toBe(detachedStart);
    expect(numberAttr(viewport, "data-history-window-end")).toBe(detachedEnd);
    expect(historyCalls.filter((call) => call.direction === "after")).toHaveLength(1);

    // The tokenless reply is interpreted with the remembered `after`
    // direction; one request remains the sole in-flight owner.
    deliverHistory(17_760, archiveLines(17_760, 2_000), true);
    expect(viewport.getAttribute("data-history-request-direction")).toBeNull();
    expect(numberAttr(viewport, "data-history-window-start")).toBe(10_000);
    expect(numberAttr(viewport, "data-history-window-end")).toBe(19_760);
    expect(viewport.getAttribute("data-history-window-attached")).toBe("0");
    expect(viewport.querySelector<HTMLElement>(".mtv-line")?.innerHTML)
      .toContain("color:#aa0000");

    wheel(viewport, 1_000_000);
    expect(historyCalls.at(-1)).toEqual({
      direction: "after",
      cursor: 19_759,
      limit: 2_000,
    });
    deliverHistory(19_760, archiveLines(19_760, 240), false);
    expect(numberAttr(viewport, "data-history-window-end")).toBe(20_000);
    expect(viewport.getAttribute("data-history-window-has-newer")).toBe("0");
    expect(viewport.getAttribute("data-history-window-attached")).toBe("1");
    expect(numberAttr(viewport, "data-total")).toBe(10_000);
    expect(deliveredLines.at(-1)?.slice(-3)).toEqual([
      "fresh-live-237",
      "fresh-live-238",
      "fresh-live-239",
    ]);

    wheel(viewport, -1_000_000);
    const signpost = target.querySelector<HTMLElement>('[data-testid="mtv-history-window"]');
    expect(signpost?.textContent).toContain("History window · scroll to load");
    expect(target.querySelector('[data-testid="mtv-history-ceiling"]')).toBeNull();
  });

  test("alt-screen flip fences an accepted sliding request and drops the archive window", async () => {
    const { viewport } = mountTermView();
    await tick();
    deliverOutput(liveLines());
    wheel(viewport, -1_000_000);
    deliverHistory(18_000, archiveLines(18_000, 2_000), true);

    wheel(viewport, -1_000_000);
    expect(viewport.getAttribute("data-history-request-direction")).toBe("before");
    const totalBeforeAlt = numberAttr(viewport, "data-total");

    deliverOutput(liveLines("alt-live", 40), {
      alt: true,
      mouseSgr: false,
      mouseAny: false,
    });
    await tick();
    flushSync();
    drainScheduledWork();
    expect(recoverCalls).toBe(1);
    expect(viewport.getAttribute("data-history-request-direction")).toBeNull();
    expect(viewport.getAttribute("data-history-window-start")).toBeNull();
    expect(viewport.getAttribute("data-no-scrollback")).toBe("1");
    expect(numberAttr(viewport, "data-total")).toBe(40);

    // A tokenless late page from the retired wire cannot repopulate alt mode.
    deliverHistory(16_000, archiveLines(16_000, 2_000), true);
    expect(numberAttr(viewport, "data-total")).toBe(40);
    expect(numberAttr(viewport, "data-total")).toBeLessThan(totalBeforeAlt);
  });

  test("turns a forward jump caused by server pruning into an explicit counted gap", async () => {
    const { viewport } = mountTermView();
    await tick();
    deliverOutput(liveLines());

    for (const startLine of [18_000, 16_000, 14_000, 12_000, 10_000, 8_000]) {
      wheel(viewport, -1_000_000);
      deliverHistory(startLine, archiveLines(startLine, 2_000), true);
    }
    expect(viewport.getAttribute("data-history-window-attached")).toBe("0");
    expect(numberAttr(viewport, "data-history-window-end")).toBe(17_760);

    wheel(viewport, 1_000_000);
    expect(historyCalls.at(-1)).toEqual({
      direction: "after",
      cursor: 17_759,
      limit: 2_000,
    });

    // Rows [17,760, 18,000) disappeared under the archive's retention cap
    // after the request cursor was chosen. Protocol permits startLine to jump.
    deliverHistory(18_000, archiveLines(18_000, 2_000), true);
    expect(numberAttr(viewport, "data-history-window-start")).toBe(18_000);
    expect(numberAttr(viewport, "data-history-window-end")).toBe(20_000);
    expect(viewport.getAttribute("data-history-stop")).toBe("exhausted");
    const marker = viewport.querySelector<HTMLElement>('[data-gap-marker-rows="240"]');
    expect(marker).not.toBeNull();
    expect(marker?.getAttribute("aria-label")).toBe("240 rows dropped before this row");
  });
});
