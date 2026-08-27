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
import type {
  AnsiPalette,
  ClaudeBashMode,
  ClaudeBashSummaries,
  ClaudeBashSummaryRequest,
  MuxHistoryBoundary,
} from "@thumbmux/core";

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
    historyError?: {
      code: "history_temporarily_unavailable";
      retryable: true;
    };
  },
) => void;
type HistoryCall =
  | { direction: "before"; cursor: number | null; limit?: number }
  | { direction: "after"; cursor: number | null; limit?: number };
type HistoryPrependDetail = {
  lineCount: number;
  cacheValid: boolean;
  transformStable: boolean;
  before: { transform: string; anchorText: string; rowCount: number };
  after: { transform: string; anchorText: string; rowCount: number };
};
type Mounted = {
  app: Record<string, unknown>;
  target: HTMLElement;
  viewport: HTMLElement;
};
type SummaryHandler = (
  requests: readonly ClaudeBashSummaryRequest[],
) => ClaudeBashSummaries | void | Promise<ClaudeBashSummaries | void>;

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

function mountTermView(options: {
  mode?: ClaudeBashMode;
  onSummary?: SummaryHandler;
  historyPaging?: "ceiling" | "sliding";
} = {}): Mounted {
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
        ...(options.mode && options.mode !== "off"
          ? { screen: { alt: false, mouseSgr: false, mouseAny: false } }
          : {}),
        claudeBashMode: options.mode ?? "off",
        onClaudeBashSummaryRequest: options.onSummary,
        // Omit unless a test explicitly exercises the legacy ceiling mode;
        // the rest of this file therefore continues to verify the default.
        ...(options.historyPaging ? { historyPaging: options.historyPaging } : {}),
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
  delivery: {
    source?: "full" | "delta";
    replace?: boolean;
    cursor?: { row: number; col: number } | null;
  } = {},
): void {
  if (!sessionCallback) throw new Error("subscribe was not invoked");
  sessionCallback(lines.join("\n"), "output", delivery.cursor ?? null, {
    source: delivery.source ?? "full",
    replace: delivery.replace ?? true,
    ...(screen === undefined ? {} : { screen }),
    ...(boundary === undefined ? {} : { boundary }),
  });
  flushSync();
  drainScheduledWork();
}

async function settleUi(): Promise<void> {
  await Promise.resolve();
  await tick();
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

function deliverHistoryError(): void {
  if (!sessionCallback) throw new Error("subscribe was not invoked");
  sessionCallback("history_temporarily_unavailable", "error", undefined, {
    source: "full",
    replace: false,
    historyError: {
      code: "history_temporarily_unavailable",
      retryable: true,
    },
  });
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

function touchEvent(
  type: "touchstart" | "touchend",
  touches: Array<{ clientX: number; clientY: number }>,
  changedTouches = touches,
): TouchEvent {
  const asTouchList = (points: Array<{ clientX: number; clientY: number }>): TouchList => {
    const list = points.slice() as Array<{ clientX: number; clientY: number }> & {
      item(index: number): Touch | null;
    };
    list.item = (index: number) => (list[index] as Touch | undefined) ?? null;
    return list as unknown as TouchList;
  };
  const event = new Event(type, { bubbles: true, cancelable: true }) as TouchEvent;
  Object.defineProperties(event, {
    touches: { value: asTouchList(touches) },
    targetTouches: { value: asTouchList(touches) },
    changedTouches: { value: asTouchList(changedTouches) },
  });
  return event;
}

function numberAttr(viewport: HTMLElement, name: string): number {
  const raw = viewport.getAttribute(name);
  if (raw === null) throw new Error(`${name} missing`);
  return Number(raw);
}

function historyBoundary(
  generation: string,
  liveStartLine: number,
  sequence = liveStartLine,
): MuxHistoryBoundary {
  return {
    generation,
    liveStartLine,
    walSequence: String(sequence),
    walOffset: sequence * 100,
  };
}

function layerTranslateY(viewport: HTMLElement): number {
  const transform = viewport.querySelector<HTMLElement>(".mtv-layer")?.style.transform ?? "";
  const match = /translate3d\(0(?:px)?,\s*(-?\d+(?:\.\d+)?)px,\s*0(?:px)?\)/.exec(transform);
  if (!match?.[1]) throw new Error(`missing layer translate: ${transform}`);
  return Number(match[1]);
}

function projectedScreenY(viewport: HTMLElement, row: HTMLElement): number {
  const first = viewport.querySelector<HTMLElement>(".mtv-line");
  if (!first) throw new Error("virtual window has no first row");
  return (
    Number(row.getAttribute("data-presentation-top"))
    - Number(first.getAttribute("data-presentation-top"))
    + layerTranslateY(viewport)
  );
}

function completedBash(label: string): string[] {
  return [
    `● Bash(printf ${label})`,
    `  ⎿  output-${label}`,
    `● boundary-${label}`,
  ];
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
  test("replays an upward wheel after loading history for a short Bash-projected live screen", async () => {
    const { viewport } = mountTermView({ mode: "hide" });
    await tick();
    deliverOutput(
      liveLines("short-live", 10),
      { alt: false, mouseSgr: false, mouseAny: false },
      historyBoundary("g-short-live", 10_000, 1),
    );
    expect(numberAttr(viewport, "data-bottom-offset")).toBe(0);
    const beforeRow = Array.from(viewport.querySelectorAll<HTMLElement>(".mtv-line"))
      .find((row) => row.textContent?.includes("short-live-0"));
    if (!beforeRow) throw new Error("short live reader row was not mounted before history expansion");
    const beforeY = projectedScreenY(viewport, beforeRow);
    const prepends: HistoryPrependDetail[] = [];
    viewport.addEventListener("thumbmux-history-prepend", (event) => {
      prepends.push((event as CustomEvent<HistoryPrependDetail>).detail);
    });

    const deferredWheelPx = 84;
    wheel(viewport, -deferredWheelPx);
    expect(historyCalls).toEqual([{ direction: "before", cursor: null, limit: 2_000 }]);
    deliverHistory(8_000, archiveLines(8_000, 2_000), true, 10_000);

    const prepend = prepends.at(-1);
    expect(prepend).toBeDefined();
    expect(prepend?.cacheValid).toBe(true);
    expect(prepend?.transformStable).toBe(true);
    expect(prepend?.after.transform).toBe(prepend?.before.transform);
    expect(numberAttr(viewport, "data-bottom-offset")).toBe(deferredWheelPx);
    const afterRow = Array.from(viewport.querySelectorAll<HTMLElement>(".mtv-line"))
      .find((row) => row.textContent?.includes("short-live-0"));
    if (!afterRow) throw new Error("short live reader row disappeared after history expansion");
    expect(projectedScreenY(viewport, afterRow)).toBeCloseTo(beforeY + deferredWheelPx, 5);
  });

  test("accumulates repeated wheels while a short-screen history request is in flight", async () => {
    const { viewport } = mountTermView({ mode: "hide" });
    await tick();
    deliverOutput(
      liveLines("short-repeat", 10),
      { alt: false, mouseSgr: false, mouseAny: false },
      historyBoundary("g-short-repeat", 10_000, 1),
    );
    const beforeRow = Array.from(viewport.querySelectorAll<HTMLElement>(".mtv-line"))
      .find((row) => row.textContent?.includes("short-repeat-0"));
    if (!beforeRow) throw new Error("repeated-wheel anchor row was not mounted");
    const beforeY = projectedScreenY(viewport, beforeRow);

    wheel(viewport, -42);
    wheel(viewport, -63);
    expect(historyCalls).toEqual([{ direction: "before", cursor: null, limit: 2_000 }]);
    deliverHistory(8_000, archiveLines(8_000, 2_000), true, 10_000);

    expect(numberAttr(viewport, "data-bottom-offset")).toBe(105);
    const afterRow = Array.from(viewport.querySelectorAll<HTMLElement>(".mtv-line"))
      .find((row) => row.textContent?.includes("short-repeat-0"));
    if (!afterRow) throw new Error("repeated-wheel anchor row disappeared");
    expect(projectedScreenY(viewport, afterRow)).toBeCloseTo(beforeY + 105, 5);
  });

  test("drops short-screen wheel intent after a retryable history error", async () => {
    const { viewport } = mountTermView({ mode: "hide" });
    await tick();
    deliverOutput(
      liveLines("short-retry", 10),
      { alt: false, mouseSgr: false, mouseAny: false },
      historyBoundary("g-short-retry", 10_000, 1),
    );
    const beforeRow = Array.from(viewport.querySelectorAll<HTMLElement>(".mtv-line"))
      .find((row) => row.textContent?.includes("short-retry-0"));
    if (!beforeRow) throw new Error("retry anchor row was not mounted");
    const beforeY = projectedScreenY(viewport, beforeRow);

    wheel(viewport, -84);
    expect(numberAttr(viewport, "data-bottom-offset")).toBe(1);
    deliverHistoryError();
    expect(numberAttr(viewport, "data-bottom-offset")).toBe(0);

    wheel(viewport, -42);
    expect(historyCalls).toEqual([
      { direction: "before", cursor: null, limit: 2_000 },
      { direction: "before", cursor: null, limit: 2_000 },
    ]);
    deliverHistory(8_000, archiveLines(8_000, 2_000), true, 10_000);

    expect(numberAttr(viewport, "data-bottom-offset")).toBe(42);
    const afterRow = Array.from(viewport.querySelectorAll<HTMLElement>(".mtv-line"))
      .find((row) => row.textContent?.includes("short-retry-0"));
    if (!afterRow) throw new Error("retry anchor row disappeared");
    expect(projectedScreenY(viewport, afterRow)).toBeCloseTo(beforeY + 42, 5);
  });

  test("reclaims an in-flight short-screen request after down cancels the first wheel", async () => {
    const { viewport } = mountTermView({ mode: "hide" });
    await tick();
    deliverOutput(
      liveLines("short-reclaim", 10),
      { alt: false, mouseSgr: false, mouseAny: false },
      historyBoundary("g-short-reclaim", 10_000, 1),
    );
    const beforeRow = Array.from(viewport.querySelectorAll<HTMLElement>(".mtv-line"))
      .find((row) => row.textContent?.includes("short-reclaim-0"));
    if (!beforeRow) throw new Error("reclaimed-wheel anchor row was not mounted");
    const beforeY = projectedScreenY(viewport, beforeRow);

    wheel(viewport, -84);
    expect(numberAttr(viewport, "data-bottom-offset")).toBe(1);
    wheel(viewport, 84);
    expect(numberAttr(viewport, "data-bottom-offset")).toBe(0);
    wheel(viewport, -42);
    expect(numberAttr(viewport, "data-bottom-offset")).toBe(1);
    expect(historyCalls).toEqual([{ direction: "before", cursor: null, limit: 2_000 }]);

    deliverHistory(8_000, archiveLines(8_000, 2_000), true, 10_000);
    expect(numberAttr(viewport, "data-bottom-offset")).toBe(42);
    const afterRow = Array.from(viewport.querySelectorAll<HTMLElement>(".mtv-line"))
      .find((row) => row.textContent?.includes("short-reclaim-0"));
    if (!afterRow) throw new Error("reclaimed-wheel anchor row disappeared");
    expect(projectedScreenY(viewport, afterRow)).toBeCloseTo(beforeY + 42, 5);
  });

  test("does not retain sliding-only short-screen intent in ceiling mode", async () => {
    const { viewport } = mountTermView({ mode: "hide", historyPaging: "ceiling" });
    await tick();
    deliverOutput(
      liveLines("short-ceiling", 10),
      { alt: false, mouseSgr: false, mouseAny: false },
    );

    wheel(viewport, -84);
    expect(historyCalls).toEqual([{ direction: "before", cursor: null, limit: 2_000 }]);
    expect(numberAttr(viewport, "data-bottom-offset")).toBe(0);
    deliverHistory(8_000, archiveLines(8_000, 2_000), true, 10_000);
    expect(viewport.getAttribute("data-history-paging")).toBe("ceiling");
    expect(numberAttr(viewport, "data-bottom-offset")).toBe(0);

    deliverOutput(
      liveLines("short-ceiling-fresh", 10),
      { alt: false, mouseSgr: false, mouseAny: false },
    );
    expect(numberAttr(viewport, "data-bottom-offset")).toBe(0);
    expect(Array.from(viewport.querySelectorAll<HTMLElement>(".mtv-line"))
      .some((row) => row.textContent?.includes("short-ceiling-fresh-9"))).toBe(true);
  });

  test("keeps the raw rendered corridor and compositor transform stable across prepends", async () => {
    const { viewport } = mountTermView();
    await tick();
    deliverOutput(liveLines("stable-live", 2_000));
    const prepends: HistoryPrependDetail[] = [];
    viewport.addEventListener("thumbmux-history-prepend", (event) => {
      prepends.push((event as CustomEvent<HistoryPrependDetail>).detail);
    });

    for (const startLine of [4_000, 2_000]) {
      wheel(viewport, -1_000_000);
      const transformBefore = viewport.querySelector<HTMLElement>(".mtv-layer")?.style.transform;
      deliverHistory(startLine, archiveLines(startLine, 2_000), true, 6_000);
      const prepend = prepends.at(-1);
      expect(prepend).toBeDefined();
      expect(prepend?.lineCount).toBe(2_000);
      expect(prepend?.cacheValid).toBe(true);
      expect(prepend?.transformStable).toBe(true);
      expect(prepend?.after.transform).toBe(prepend?.before.transform);
      expect(viewport.querySelector<HTMLElement>(".mtv-layer")?.style.transform)
        .toBe(transformBefore);
    }
  });

  test("reports a compact Bash seam as uncached while preserving the raw reader anchor", async () => {
    const { viewport } = mountTermView({ mode: "hide" });
    await tick();
    deliverOutput(liveLines("seam-live", 240));
    const prepends: HistoryPrependDetail[] = [];
    viewport.addEventListener("thumbmux-history-prepend", (event) => {
      prepends.push((event as CustomEvent<HistoryPrependDetail>).detail);
    });

    wheel(viewport, -1_000_000);
    const resident = archiveLines(2_000, 9_760);
    resident[0] = "  ⎿  split-output";
    resident[1] = "     split-detail";
    resident[2] = "● resident-boundary";
    resident[24] = "resident-reader-anchor";
    deliverHistory(2_000, resident, true, 11_760);

    // Enter the prefetch corridor in one gesture but stop 420px below the
    // absolute top. The accepted request now snapshots non-zero scrollTop, so
    // a compact cross-page group must rebase presentation geometry.
    const maxOffset = numberAttr(viewport, "data-presentation-height") - VIEW_HEIGHT;
    const bottomOffset = numberAttr(viewport, "data-bottom-offset");
    wheel(viewport, -(maxOffset - 420 - bottomOffset));
    expect(historyCalls.at(-1)).toEqual({
      direction: "before",
      cursor: 2_000,
      limit: 2_000,
    });
    const beforeAnchor = Array.from(viewport.querySelectorAll<HTMLElement>(".mtv-line"))
      .find((row) => row.textContent?.includes("resident-reader-anchor"));
    if (!beforeAnchor) throw new Error("compact-seam reader anchor was not mounted");
    const anchorId = beforeAnchor.getAttribute("data-line-id");
    if (!anchorId) throw new Error("compact-seam reader anchor had no absolute identity");
    const beforeY = projectedScreenY(viewport, beforeAnchor);
    const transformBefore = viewport.querySelector<HTMLElement>(".mtv-layer")?.style.transform;
    const eventCountBefore = prepends.length;

    const older = archiveLines(0, 2_000);
    older[older.length - 1] = "● Bash(printf split-history)";
    deliverHistory(0, older, false, 11_760);

    expect(prepends).toHaveLength(eventCountBefore + 1);
    const prepend = prepends.at(-1);
    expect(prepend?.lineCount).toBe(2_000);
    expect(prepend?.transformStable).toBe(false);
    expect(prepend?.before.transform).toBe(transformBefore);
    expect(prepend?.after.transform).not.toBe(prepend?.before.transform);
    expect(prepend?.cacheValid).toBe(false);
    expect(prepend?.cacheValid && !prepend.transformStable).toBe(false);
    expect(numberAttr(viewport, "data-history-window-rows")).toBe(9_760);
    expect(viewport.getAttribute("data-history-window-has-newer")).toBe("1");
    const afterAnchor = viewport.querySelector<HTMLElement>(`[data-line-id="${anchorId}"]`);
    if (!afterAnchor) throw new Error("compact-seam reader anchor disappeared");
    expect(afterAnchor.textContent).toContain("resident-reader-anchor");
    expect(projectedScreenY(viewport, afterAnchor)).toBeCloseTo(beforeY, 5);
  });

  test("settles a retryable archive error without marking EOF and retries the identical cursor", async () => {
    const { viewport } = mountTermView();
    await tick();
    deliverOutput(liveLines());

    wheel(viewport, -1_000_000);
    expect(historyCalls).toEqual([{ direction: "before", cursor: null, limit: 2_000 }]);
    expect(viewport.getAttribute("data-history-request-direction")).toBe("before");

    deliverHistoryError();
    expect(viewport.getAttribute("data-history-request-direction")).toBeNull();
    expect(viewport.getAttribute("data-history-stop")).toBe("none");
    expect(viewport.getAttribute("data-history-window-start")).toBeNull();
    expect(recoverCalls).toBe(0);

    wheel(viewport, -1_000_000);
    expect(historyCalls).toEqual([
      { direction: "before", cursor: null, limit: 2_000 },
      { direction: "before", cursor: null, limit: 2_000 },
    ]);
    deliverHistory(18_000, archiveLines(18_000, 2_000), true);
    expect(numberAttr(viewport, "data-history-window-start")).toBe(18_000);
    expect(viewport.getAttribute("data-history-stop")).toBe("none");
  });

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

  test("does not duplicate crossed live rows when the initial history reply races a newer seam", async () => {
    const { viewport } = mountTermView();
    await tick();

    deliverOutput(
      absoluteLines(100, 20),
      undefined,
      historyBoundary("g-race", 100, 10),
      { source: "full", replace: false },
    );
    wheel(viewport, -1_000_000);
    expect(historyCalls.at(-1)).toMatchObject({ direction: "before", cursor: null });

    // The reader is already away from the tail while the first tokenless
    // history request is in flight. A normal non-replace capture advances the
    // durable seam by five rows; the stable-reader merge deliberately retains
    // those crossed rows until the absolute history page arrives.
    deliverOutput(
      absoluteLines(105, 20),
      undefined,
      historyBoundary("g-race", 105, 15),
      { source: "full", replace: false },
    );
    expect(deliveredLines.at(-1)).toEqual(absoluteLines(100, 25));
    const anchorBefore = Array.from(viewport.querySelectorAll<HTMLElement>(".mtv-line"))
      .find((row) => row.textContent?.includes("absolute-100"));
    if (!anchorBefore) throw new Error("startup race anchor was not mounted");
    const anchorY = projectedScreenY(viewport, anchorBefore);

    // The page is authoritative for [85, 105), so the retained live prefix
    // [100, 105) must be consumed at the seam instead of being rendered twice.
    deliverHistory(85, absoluteLines(85, 20), false, 105);
    expect(viewport.getAttribute("data-history-window-attached")).toBe("1");
    expect(deliveredLines.at(-1)).toEqual(absoluteLines(85, 40));
    expect(new Set(deliveredLines.at(-1)).size).toBe(40);
    const anchorAfter = Array.from(viewport.querySelectorAll<HTMLElement>(".mtv-line"))
      .find((row) => row.textContent?.includes("absolute-100"));
    if (!anchorAfter) throw new Error("startup race anchor disappeared");
    expect(projectedScreenY(viewport, anchorAfter)).toBeCloseTo(anchorY, 5);
  });

  test("uses absolute seam movement when every startup row has identical text", async () => {
    const { viewport } = mountTermView();
    await tick();
    const repeated = Array.from({ length: 20 }, () => "same-status-row");

    deliverOutput(
      repeated,
      undefined,
      historyBoundary("g-repeated-race", 100, 10),
      { source: "full", replace: false },
    );
    wheel(viewport, -1_000_000);
    deliverOutput(
      repeated,
      undefined,
      historyBoundary("g-repeated-race", 105, 15),
      { source: "full", replace: false },
    );

    // Five distinct absolute rows crossed the seam even though their bytes are
    // indistinguishable from both snapshots.
    expect(numberAttr(viewport, "data-raw-total")).toBe(25);
    deliverHistory(85, repeated, false, 105);
    expect(numberAttr(viewport, "data-raw-total")).toBe(40);
    expect(deliveredLines.at(-1)).toHaveLength(40);
    const mountedIds = Array.from(viewport.querySelectorAll<HTMLElement>(".mtv-line"))
      .map((row) => row.getAttribute("data-line-id"));
    expect(new Set(mountedIds).size).toBe(mountedIds.length);
  });

  test("keeps an ahead-of-output history page detached until its exact seam arrives", async () => {
    const { viewport } = mountTermView();
    await tick();
    deliverOutput(
      absoluteLines(100, 20),
      undefined,
      historyBoundary("g-history-ahead", 100, 10),
      { source: "full", replace: false },
    );
    wheel(viewport, -1_000_000);

    // The archive transaction reached 105 first, but this viewer has only seen
    // the output frame paired with boundary 100. Rendering both sides now
    // would overlap absolute rows 100..104.
    deliverHistory(85, absoluteLines(85, 20), false, 105);
    expect(viewport.getAttribute("data-history-window-attached")).toBe("0");
    expect(deliveredLines.at(-1)).toEqual(absoluteLines(85, 20));

    deliverOutput(
      absoluteLines(105, 20),
      undefined,
      historyBoundary("g-history-ahead", 105, 15),
      { source: "full", replace: false },
    );
    expect(viewport.getAttribute("data-history-window-attached")).toBe("1");
    expect(deliveredLines.at(-1)).toEqual(absoluteLines(85, 40));
    expect(new Set(deliveredLines.at(-1)).size).toBe(40);
  });

  test("replaces canonically when a repeated-text boundary jump exceeds the resident live window", async () => {
    const { viewport } = mountTermView();
    await tick();
    const repeated = Array.from({ length: 20 }, () => "same-status-row");

    deliverOutput(
      repeated,
      undefined,
      historyBoundary("g-large-jump", 100, 10),
      { source: "full", replace: false },
    );
    wheel(viewport, -1_000_000);

    // Twenty resident rows cannot prove the five missing absolute rows in a
    // 25-row seam advance. Repeated bytes must not be mistaken for identity.
    deliverOutput(
      repeated,
      undefined,
      historyBoundary("g-large-jump", 125, 35),
      { source: "full", replace: false },
    );
    expect(numberAttr(viewport, "data-raw-total")).toBe(20);

    // The authoritative page [105, 125) now meets the exact durable seam and
    // must attach beside the complete canonical live screen [125, 145).
    deliverHistory(105, repeated, false, 125);
    expect(viewport.getAttribute("data-history-window-attached")).toBe("1");
    expect(numberAttr(viewport, "data-raw-total")).toBe(40);
    expect(deliveredLines.at(-1)).toHaveLength(40);
  });

  test("preserves an absolute crossed prefix across a same-boundary repaint", async () => {
    const { viewport } = mountTermView();
    await tick();

    deliverOutput(
      absoluteLines(100, 20),
      undefined,
      historyBoundary("g-same-boundary", 100, 10),
      { source: "full", replace: false },
    );
    wheel(viewport, -1_000_000);
    deliverOutput(
      absoluteLines(105, 20),
      undefined,
      historyBoundary("g-same-boundary", 105, 15),
      { source: "full", replace: false },
    );
    const anchorBefore = Array.from(viewport.querySelectorAll<HTMLElement>(".mtv-line"))
      .find((row) => row.textContent?.includes("absolute-100"));
    if (!anchorBefore) throw new Error("same-boundary anchor was not mounted");
    const anchorY = projectedScreenY(viewport, anchorBefore);

    // A repaint at the same durable seam may change every visible byte. The
    // already-proven prefix [100, 105) is still immutable absolute history.
    const repainted = Array.from({ length: 20 }, (_, index) => `repaint-${105 + index}`);
    deliverOutput(
      repainted,
      undefined,
      historyBoundary("g-same-boundary", 105, 16),
      { source: "full", replace: false },
    );
    expect(numberAttr(viewport, "data-raw-total")).toBe(25);
    const anchorAfter = Array.from(viewport.querySelectorAll<HTMLElement>(".mtv-line"))
      .find((row) => row.textContent?.includes("absolute-100"));
    if (!anchorAfter) throw new Error("same-boundary repaint dropped the absolute anchor");
    expect(projectedScreenY(viewport, anchorAfter)).toBeCloseTo(anchorY, 5);

    deliverHistory(85, absoluteLines(85, 20), false, 105);
    expect(viewport.getAttribute("data-history-window-attached")).toBe("1");
    expect(deliveredLines.at(-1)).toEqual([
      ...absoluteLines(85, 20),
      ...repainted,
    ]);
  });

  test("keeps a forward page detached when it outruns the current output boundary", async () => {
    const { viewport } = mountTermView();
    await tick();

    deliverOutput(
      absoluteLines(100, 20),
      undefined,
      historyBoundary("g-forward-ahead", 100, 10),
      { source: "full", replace: false },
    );
    wheel(viewport, -1_000_000);
    deliverHistory(80, absoluteLines(80, 20), false, 100);
    wheel(viewport, -1_000_000);
    deliverOutput(
      absoluteLines(105, 20),
      undefined,
      historyBoundary("g-forward-ahead", 105, 15),
      { source: "full", replace: false },
    );

    wheel(viewport, 1_000_000);
    expect(historyCalls.at(-1)).toEqual({ direction: "after", cursor: 99, limit: 2_000 });

    // The server head has reached 110, but this client still owns output 105.
    // Joining page [100, 110) to live [105, 125) would duplicate 105..109.
    deliverHistory(100, absoluteLines(100, 10), false, 110);
    expect(viewport.getAttribute("data-history-window-attached")).toBe("0");
    expect(viewport.getAttribute("data-history-window-has-newer")).toBe("1");
    expect(deliveredLines.at(-1)).toEqual(absoluteLines(80, 30));

    deliverOutput(
      absoluteLines(110, 20),
      undefined,
      historyBoundary("g-forward-ahead", 110, 20),
      { source: "full", replace: false },
    );
    expect(viewport.getAttribute("data-history-window-attached")).toBe("1");
    expect(deliveredLines.at(-1)).toEqual(absoluteLines(80, 50));
    expect(new Set(deliveredLines.at(-1)).size).toBe(50);
  });

  test("rejects a stale same-generation boundary regression", async () => {
    const { viewport } = mountTermView();
    await tick();

    const accepted = absoluteLines(105, 20);
    deliverOutput(
      accepted,
      undefined,
      historyBoundary("g-regression", 105, 15),
      { source: "full", replace: false, cursor: { row: 0, col: 7 } },
    );
    const acceptedDeliveryCount = deliveredLines.length;
    deliverOutput(
      absoluteLines(103, 20),
      undefined,
      historyBoundary("g-regression", 103, 14),
      { source: "full", replace: false, cursor: { row: 0, col: 3 } },
    );

    expect(numberAttr(viewport, "data-history-live-start")).toBe(105);
    expect(viewport.getAttribute("data-history-generation")).toBe("g-regression");
    expect(deliveredLines).toHaveLength(acceptedDeliveryCount);
    expect(deliveredLines.at(-1)).toEqual(accepted);
    const cursor = viewport.querySelector<HTMLElement>('[data-testid="mtv-cursor"]');
    expect(cursor?.getAttribute("data-cursor-col")).toBe("7");
  });

  test("drops stale screen mode with the rejected content and cursor frame", async () => {
    const { viewport } = mountTermView();
    await tick();

    const accepted = absoluteLines(105, 20);
    deliverOutput(
      accepted,
      { alt: false, mouseSgr: false, mouseAny: false },
      historyBoundary("g-screen-regression", 105, 15),
      { source: "full", replace: false, cursor: { row: 0, col: 7 } },
    );
    const acceptedDeliveryCount = deliveredLines.length;

    deliverOutput(
      absoluteLines(103, 20).map((line) => `stale-${line}`),
      { alt: true, mouseSgr: true, mouseAny: true },
      historyBoundary("g-screen-regression", 103, 14),
      { source: "full", replace: false, cursor: { row: 0, col: 3 } },
    );

    expect(viewport.getAttribute("data-no-scrollback")).toBeNull();
    expect(numberAttr(viewport, "data-history-live-start")).toBe(105);
    expect(deliveredLines).toHaveLength(acceptedDeliveryCount);
    expect(deliveredLines.at(-1)).toEqual(accepted);
    const cursor = viewport.querySelector<HTMLElement>('[data-testid="mtv-cursor"]');
    expect(cursor?.getAttribute("data-cursor-col")).toBe("7");
  });

  test("keeps a newer pending boundary when a stale cached frame arrives", async () => {
    const { viewport } = mountTermView();
    await tick();

    deliverOutput(
      absoluteLines(100, 20),
      { alt: false, mouseSgr: false, mouseAny: false },
      historyBoundary("g-pending-regression", 100, 10),
      { source: "full", replace: false, cursor: { row: 0, col: 1 } },
    );
    const appliedDeliveryCount = deliveredLines.length;

    const pending = absoluteLines(105, 20);
    const touch = { clientX: 40, clientY: 80 };
    viewport.dispatchEvent(touchEvent("touchstart", [touch]));
    flushSync();

    deliverOutput(
      pending,
      { alt: false, mouseSgr: false, mouseAny: false },
      historyBoundary("g-pending-regression", 105, 15),
      { source: "full", replace: false, cursor: { row: 0, col: 5 } },
    );
    expect(viewport.getAttribute("data-content-update-pending")).toBe("1");
    expect(viewport.getAttribute("data-content-update-pending-cursor-col")).toBe("5");
    expect(numberAttr(viewport, "data-history-live-start")).toBe(100);

    deliverOutput(
      absoluteLines(103, 20).map((line) => `stale-${line}`),
      { alt: true, mouseSgr: true, mouseAny: true },
      historyBoundary("g-pending-regression", 103, 13),
      { source: "full", replace: false, cursor: { row: 0, col: 3 } },
    );
    expect(viewport.getAttribute("data-content-update-pending-cursor-col")).toBe("5");
    expect(viewport.getAttribute("data-no-scrollback")).toBeNull();
    expect(deliveredLines).toHaveLength(appliedDeliveryCount);

    viewport.dispatchEvent(touchEvent("touchend", [], [touch]));
    flushSync();
    drainScheduledWork();

    expect(viewport.getAttribute("data-content-update-pending")).toBe("0");
    expect(numberAttr(viewport, "data-history-live-start")).toBe(105);
    expect(deliveredLines.at(-1)).toEqual(pending);
    const cursor = viewport.querySelector<HTMLElement>('[data-testid="mtv-cursor"]');
    expect(cursor?.getAttribute("data-cursor-col")).toBe("5");
  });

  test("rejects stale WAL coordinates at an unchanged live seam", async () => {
    const { viewport } = mountTermView();
    await tick();

    const accepted = absoluteLines(105, 20);
    deliverOutput(
      accepted,
      undefined,
      historyBoundary("g-wal-regression", 105, 15),
      { source: "full", replace: false, cursor: { row: 0, col: 9 } },
    );
    const acceptedDeliveryCount = deliveredLines.length;
    deliverOutput(
      absoluteLines(105, 20).map((line) => `stale-${line}`),
      undefined,
      {
        ...historyBoundary("g-wal-regression", 105, 14),
        liveStartLine: 105,
      },
      { source: "full", replace: false, cursor: { row: 0, col: 2 } },
    );

    expect(numberAttr(viewport, "data-history-live-start")).toBe(105);
    expect(deliveredLines).toHaveLength(acceptedDeliveryCount);
    expect(deliveredLines.at(-1)).toEqual(accepted);
    const cursor = viewport.querySelector<HTMLElement>('[data-testid="mtv-cursor"]');
    expect(cursor?.getAttribute("data-cursor-col")).toBe("9");
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

  test("protects the full raw Bash group represented by a compact reader row", async () => {
    const { viewport } = mountTermView({ mode: "hide" });
    await tick();
    deliverOutput(liveLines("tail", 240));

    wheel(viewport, -1_000_000);
    const resident = Array.from(
      { length: 9_760 },
      (_, index) => `     long-output-${index}`,
    );
    // Five adjacent blocks stay below the detector's 2k-row per-block cap but
    // form one grouped presentation row covering 9.5k raw rows.
    for (let block = 0; block < 5; block++) {
      const start = block * 1_900;
      resident[start] = `● Bash(printf protected-reader-group-${block})`;
      resident[start + 1] = `  ⎿  long-output-${start + 1}`;
    }
    resident[9_500] = "● protected-reader-boundary";
    for (let index = 9_501; index < resident.length; index++) {
      resident[index] = `archive-tail-${index}`;
    }
    deliverHistory(2_000, resident, true, 11_760);

    wheel(viewport, -1_000_000);
    expect(historyCalls.at(-1)).toEqual({ direction: "before", cursor: 2_000, limit: 2_000 });
    expect(viewport.querySelector(".mtv-bash-hidden")).not.toBeNull();

    deliverHistory(0, archiveLines(0, 2_000), false, 11_760);

    // The one-third-height row covers ~9.5k physical archive rows. Protection
    // must retain that complete raw range, so the page discards its far prefix
    // instead of cutting the Bash group at visual index 12 or 13.
    expect(numberAttr(viewport, "data-history-window-rows")).toBe(9_760);
    expect(numberAttr(viewport, "data-history-window-start")).toBeGreaterThan(1_000);
    expect(numberAttr(viewport, "data-history-window-end")).toBeGreaterThan(11_000);
    const retainedGroup = viewport.querySelector<HTMLElement>(".mtv-bash-hidden");
    expect(retainedGroup).not.toBeNull();
    expect(
      Number(retainedGroup?.getAttribute("data-raw-end"))
      - Number(retainedGroup?.getAttribute("data-raw-start")),
    ).toBeGreaterThan(9_000);
  });

  test("promotes crossed live rows when a collapsed archive makes visual indexes smaller than raw indexes", async () => {
    const { viewport } = mountTermView({ mode: "hide" });
    await tick();
    deliverOutput(
      absoluteLines(100, 20),
      undefined,
      historyBoundary("g-collapsed", 100, 10),
    );
    wheel(viewport, -1_000_000);

    const collapsedArchive = Array.from(
      { length: 100 },
      (_, index) => `     archived-output-${index}`,
    );
    collapsedArchive[0] = "● Bash(printf collapsed-archive)";
    collapsedArchive[1] = "  ⎿  archived-output-1";
    collapsedArchive[99] = "● archived-boundary";
    deliverHistory(0, collapsedArchive, false, 100);

    // Stay away from the tail while keeping live rows inside the viewport.
    wheel(viewport, -42);
    const before = Array.from(viewport.querySelectorAll<HTMLElement>(".mtv-line"))
      .find((row) => row.textContent?.includes("absolute-108"));
    if (!before) throw new Error("live anchor row was not mounted before seam advance");
    const beforeY = projectedScreenY(viewport, before);

    deliverOutput(
      absoluteLines(105, 20),
      undefined,
      historyBoundary("g-collapsed", 105, 15),
      { source: "full", replace: false },
    );

    expect(viewport.getAttribute("data-history-window-attached")).toBe("1");
    expect(numberAttr(viewport, "data-history-window-end")).toBe(105);
    const after = Array.from(viewport.querySelectorAll<HTMLElement>(".mtv-line"))
      .find((row) => row.textContent?.includes("absolute-108"));
    if (!after) throw new Error("live anchor row disappeared after seam promotion");
    expect(projectedScreenY(viewport, after)).toBeCloseTo(beforeY, 5);
    expect(new Set(deliveredLines.at(-1)).size).toBe(deliveredLines.at(-1)?.length);
  });

  test("generation reset retires both an active tokenless request and a claimed queued reply", async () => {
    const { viewport } = mountTermView();
    await tick();
    deliverOutput(
      absoluteLines(100, 20),
      undefined,
      historyBoundary("g-old", 100, 10),
    );
    wheel(viewport, -1_000_000);
    expect(viewport.getAttribute("data-history-request-direction")).toBe("before");

    deliverOutput(
      absoluteLines(0, 20),
      undefined,
      historyBoundary("g-new", 0, 1),
    );
    expect(recoverCalls).toBe(1);
    expect(viewport.getAttribute("data-history-request-direction")).toBeNull();
    deliverHistory(80, absoluteLines(80, 20), false, 100);
    expect(viewport.getAttribute("data-history-window-start")).toBeNull();

    wheel(viewport, -1_000_000);
    expect(viewport.getAttribute("data-history-request-direction")).toBe("before");
    if (!sessionCallback) throw new Error("subscribe was not invoked");
    sessionCallback(JSON.stringify({
      lines: absoluteLines(0, 20),
      startLine: 0,
      endLine: 20,
      totalArchivedLines: 20,
      hasMore: false,
    }), "history");
    flushSync();
    expect(idleCallbacks.size + frameCallbacks.size).toBeGreaterThan(0);

    // The reply has already released the wire but has not parsed/committed.
    // A newer generation must cancel that queued local work as well.
    deliverOutput(
      absoluteLines(500, 20),
      undefined,
      historyBoundary("g-newer", 500, 2),
    );
    expect(recoverCalls).toBe(1);
    expect(viewport.getAttribute("data-history-window-start")).toBeNull();
    expect(viewport.getAttribute("data-history-generation")).toBe("g-newer");
    expect(deliveredLines.at(-1)).toEqual(absoluteLines(500, 20));
  });

  test("marks an emergency live-prefix trim and restores its ANSI entry state", async () => {
    const { viewport } = mountTermView();
    await tick();
    const fullLive = liveLines("bounded", 10_000);
    fullLive[0] = "\u001b[31mremoved-red-entry";
    fullLive[1] = "retained-red-row";
    deliverOutput(fullLive);
    wheel(viewport, -1_000_000);
    deliverHistory(0, ["archive-seed"], false, 1);

    const marker = viewport.querySelector<HTMLElement>('[data-gap-marker-rows="1"]');
    expect(marker).not.toBeNull();
    expect(marker?.getAttribute("aria-label")).toBe("1 rows dropped before this row");
    const retained = Array.from(viewport.querySelectorAll<HTMLElement>(".mtv-line"))
      .find((row) => row.textContent?.includes("retained-red-row"));
    expect(retained?.getAttribute("data-gap-rows")).toBe("1");
    expect(retained?.innerHTML).toContain("color:#aa0000");
    expect(deliveredLines.at(-1)).not.toContain("removed-red-entry");
  });

  test("reattach admits exactly the newest completed Bash received while live was detached", async () => {
    const batches: ClaudeBashSummaryRequest[][] = [];
    const { viewport } = mountTermView({
      mode: "haiku",
      onSummary: async (requests) => {
        batches.push([...requests]);
        return Object.fromEntries(
          requests.map((request) => [request.id, `สรุป ${request.command}`]),
        );
      },
    });
    await tick();

    deliverOutput(
      [...completedBash("cold"), ...absoluteLines(100, 17)],
      undefined,
      historyBoundary("g-distill", 100, 10),
    );
    await settleUi();
    await settleUi();
    expect(batches).toHaveLength(1);
    batches.length = 0;

    wheel(viewport, -1_000_000);
    const archived = absoluteLines(0, 100);
    archived.splice(10, 3, ...completedBash("archive-backlog"));
    deliverHistory(0, archived, false, 100);
    await settleUi();
    expect(batches).toHaveLength(0);
    wheel(viewport, -1_000_000);

    const detachedLive = [
      "absolute-105",
      ...completedBash("live-latest"),
      ...absoluteLines(109, 16),
    ];
    deliverOutput(
      detachedLive,
      undefined,
      historyBoundary("g-distill", 105, 15),
    );
    await settleUi();
    expect(viewport.getAttribute("data-history-window-attached")).toBe("0");
    expect(batches).toHaveLength(0);

    wheel(viewport, 1_000_000);
    expect(historyCalls.at(-1)).toEqual({ direction: "after", cursor: 99, limit: 2_000 });
    deliverHistory(100, absoluteLines(100, 5), false, 105);
    await settleUi();
    await settleUi();

    expect(viewport.getAttribute("data-history-window-attached")).toBe("1");
    expect(batches).toHaveLength(1);
    expect(batches[0]?.map((request) => request.command)).toEqual(["printf live-latest"]);
  });

  test("settling history never cancels the independent Distill watchdog", async () => {
    const never = new Promise<ClaudeBashSummaries>(() => {});
    const originalSetTimeout = globalThis.setTimeout.bind(globalThis);
    const originalClearTimeout = globalThis.clearTimeout.bind(globalThis);
    const watchdogHandle = 987_654_322 as unknown as ReturnType<typeof setTimeout>;
    let watchdogInstalled = false;
    let watchdogCleared = false;
    Object.defineProperty(globalThis, "setTimeout", {
      configurable: true,
      writable: true,
      value: ((handler: TimerHandler, delay?: number, ...args: unknown[]) => {
        if (delay === 305_000) {
          watchdogInstalled = true;
          void handler;
          void args;
          return watchdogHandle;
        }
        return originalSetTimeout(handler, delay, ...args);
      }) as typeof setTimeout,
    });
    Object.defineProperty(globalThis, "clearTimeout", {
      configurable: true,
      writable: true,
      value: ((handle?: ReturnType<typeof setTimeout>) => {
        if (handle === watchdogHandle) {
          watchdogCleared = true;
          return;
        }
        originalClearTimeout(handle);
      }) as typeof clearTimeout,
    });

    try {
      const { viewport } = mountTermView({
        mode: "haiku",
        onSummary: () => never,
      });
      await tick();
      deliverOutput(completedBash("hung-during-history"));
      await settleUi();
      expect(watchdogInstalled).toBe(true);
      expect(watchdogCleared).toBe(false);

      wheel(viewport, -1_000_000);
      deliverHistory(0, ["archive-does-not-own-distill-timeout"], false, 1);
      expect(watchdogCleared).toBe(false);
    } finally {
      Object.defineProperty(globalThis, "setTimeout", {
        configurable: true,
        writable: true,
        value: originalSetTimeout,
      });
      Object.defineProperty(globalThis, "clearTimeout", {
        configurable: true,
        writable: true,
        value: originalClearTimeout,
      });
    }
  });
});
