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
    styledBashHeader(`printf ${label}`),
    `  ⎿  output-${label}`,
    `● boundary-${label}`,
  ];
}

function styledBashHeader(command: string): string {
  return `\x1b[38;5;114m●\x1b[39m \x1b[1mBash\x1b[0m(${command})`;
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

  test("keeps a deferred legacy Grok capture offscreen while a detached archive pages forward", async () => {
    const { viewport } = mountTermView();
    await tick();

    deliverOutput(liveLines("legacy-before", 240), undefined, undefined, {
      source: "full",
      replace: true,
    });
    wheel(viewport, -1_000_000);
    expect(historyCalls.at(-1)).toMatchObject({ direction: "before", cursor: null });

    const newestGrok = liveLines("legacy-grok-newest", 240);
    deliverOutput(newestGrok, undefined, undefined, {
      source: "delta",
      replace: false,
    });
    expect(viewport.getAttribute("data-live-rejoin-pending")).toBe("1");

    // This tokenless reply knows that newer archive rows exist, so it owns a
    // detached window. Rejoining live must request those rows instead of
    // concatenating the window directly with the deferred capture.
    deliverHistory(0, archiveLines(0, 20), false, 100);
    expect(viewport.getAttribute("data-history-window-attached")).toBe("0");
    expect(viewport.getAttribute("data-live-rejoin-pending")).toBe("1");
    expect(deliveredLines.at(-1)).toEqual(archiveLines(0, 20));

    wheel(viewport, 1_000_000);
    expect(viewport.getAttribute("data-live-rejoin-pending")).toBeNull();
    expect(viewport.getAttribute("data-history-window-attached")).toBe("0");
    expect(historyCalls.at(-1)).toEqual({ direction: "after", cursor: 19, limit: 2_000 });
    expect(deliveredLines.at(-1)).toEqual(archiveLines(0, 20));

    deliverHistory(20, archiveLines(20, 80), false, 100);
    expect(viewport.getAttribute("data-history-window-attached")).toBe("1");
    expect(deliveredLines.at(-1)).toEqual([
      ...archiveLines(0, 100),
      ...newestGrok,
    ]);
    expect(new Set(deliveredLines.at(-1)).size).toBe(340);
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

  test("keeps Bash-shaped prompt continuation raw when live history precedes row zero", async () => {
    const { viewport } = mountTermView({ mode: "hide" });
    await tick();
    deliverOutput([
      "● Bash(prompt-owned-at-live-start)",
      "  ⎿  prompt-owned output",
      "● apparent boundary",
      ...liveLines("bounded-live", 7),
    ], undefined, historyBoundary("g-leading-live", 18_000, 1));

    expect(viewport.getAttribute("data-history-live-start")).toBe("18000");
    expect(numberAttr(viewport, "data-raw-total")).toBe(10);
    expect(numberAttr(viewport, "data-total")).toBe(10);
    expect(viewport.querySelector(".mtv-bash-hidden")).toBeNull();
    expect(viewport.querySelector<HTMLElement>('[data-raw-start="0"]')?.textContent)
      .toBe("● Bash(prompt-owned-at-live-start)");
  });

  test("keeps initial Bash-shaped rows raw when sliding output has no boundary proof", async () => {
    const { viewport } = mountTermView({ mode: "hide" });
    await tick();
    deliverOutput([
      "● Bash(prompt-owned-without-boundary)",
      "  ⎿  prompt-owned output",
      "● apparent boundary",
      ...liveLines("boundaryless-live", 7),
    ]);

    expect(viewport.getAttribute("data-history-live-start")).toBeNull();
    expect(numberAttr(viewport, "data-raw-total")).toBe(10);
    expect(numberAttr(viewport, "data-total")).toBe(10);
    expect(viewport.querySelector(".mtv-bash-hidden")).toBeNull();
    expect(viewport.querySelector<HTMLElement>('[data-raw-start="0"]')?.textContent)
      .toBe("● Bash(prompt-owned-without-boundary)");
  });

  test("does not reuse a prior boundary for a boundaryless replacement frame", async () => {
    const { viewport } = mountTermView({ mode: "hide" });
    await tick();
    deliverOutput(
      liveLines("proven-live", 10),
      undefined,
      historyBoundary("g-boundary-drop", 0, 1),
    );
    expect(viewport.getAttribute("data-history-live-start")).toBe("0");

    deliverOutput([
      "● Bash(prompt-owned-on-cached-reconnect-frame)",
      "  ⎿  prompt-owned output",
      "● apparent boundary",
      ...liveLines("boundaryless-reconnect", 7),
    ]);

    expect(numberAttr(viewport, "data-raw-total")).toBe(10);
    expect(numberAttr(viewport, "data-total")).toBe(10);
    expect(viewport.querySelector(".mtv-bash-hidden")).toBeNull();
    expect(viewport.querySelector<HTMLElement>('[data-raw-start="0"]')?.textContent)
      .toBe("● Bash(prompt-owned-on-cached-reconnect-frame)");
  });

  test("guards the live seam when an attached archive has no paired boundary", async () => {
    const { viewport } = mountTermView({ mode: "hide" });
    await tick();
    deliverOutput(liveLines("unpaired-archive-live", 120));

    wheel(viewport, -1_000_000);
    deliverHistory(0, archiveLines(0, 5), false, 5);
    expect(viewport.getAttribute("data-history-window-attached")).toBe("1");
    expect(viewport.getAttribute("data-history-window-start")).toBe("0");

    deliverOutput([
      "● Bash(prompt-owned-at-unproven-live-seam)",
      "  ⎿  prompt-owned output",
      "● apparent boundary",
      ...liveLines("unpaired-live-replacement", 117),
    ]);

    expect(numberAttr(viewport, "data-raw-total")).toBe(125);
    expect(numberAttr(viewport, "data-total")).toBe(125);
    expect(viewport.querySelector(".mtv-bash-hidden")).toBeNull();
    wheel(viewport, -1_000_000);
    expect(viewport.querySelector<HTMLElement>('[data-raw-start="5"]')?.textContent)
      .toBe("● Bash(prompt-owned-at-unproven-live-seam)");
  });

  test("guards the live seam below a known-origin ceiling archive", async () => {
    const { viewport } = mountTermView({ mode: "hide", historyPaging: "ceiling" });
    await tick();
    deliverOutput(liveLines("ceiling-seam-live", 120));

    wheel(viewport, -1_000_000);
    deliverHistory(0, archiveLines(0, 5), false, 5);
    expect(viewport.getAttribute("data-history-paging")).toBe("ceiling");
    expect(viewport.getAttribute("data-history-stop")).toBe("exhausted");

    deliverOutput([
      "● Bash(prompt-owned-at-ceiling-live-seam)",
      "  ⎿  prompt-owned output",
      "● apparent boundary",
      ...liveLines("ceiling-live-replacement", 117),
    ]);

    expect(numberAttr(viewport, "data-raw-total")).toBe(125);
    expect(numberAttr(viewport, "data-total")).toBe(125);
    expect(viewport.querySelector(".mtv-bash-hidden")).toBeNull();
    wheel(viewport, -1_000_000);
    expect(viewport.querySelector<HTMLElement>('[data-raw-start="5"]')?.textContent)
      .toBe("● Bash(prompt-owned-at-ceiling-live-seam)");
  });

  test("keeps Bash-shaped initial live rows raw while ceiling history is unresolved", async () => {
    const { viewport } = mountTermView({ mode: "hide", historyPaging: "ceiling" });
    await tick();
    deliverOutput([
      "● Bash(prompt-owned-before-ceiling-load)",
      "  ⎿  prompt-owned output",
      "● apparent boundary",
      ...liveLines("unresolved-ceiling", 7),
    ]);

    expect(viewport.getAttribute("data-history-paging")).toBe("ceiling");
    expect(viewport.getAttribute("data-history-stop")).toBe("none");
    expect(numberAttr(viewport, "data-raw-total")).toBe(10);
    expect(numberAttr(viewport, "data-total")).toBe(10);
    expect(viewport.querySelector(".mtv-bash-hidden")).toBeNull();
    expect(viewport.querySelector<HTMLElement>('[data-raw-start="0"]')?.textContent)
      .toBe("● Bash(prompt-owned-before-ceiling-load)");

    deliverOutput([
      styledBashHeader("printf proven-ceiling-bash"),
      "  ⎿  real command output",
      "● apparent boundary",
      ...liveLines("unresolved-ceiling", 7),
    ]);
    expect(numberAttr(viewport, "data-raw-total")).toBe(10);
    expect(numberAttr(viewport, "data-total")).toBe(9);
    expect(viewport.querySelector<HTMLElement>('[data-raw-start="0"].mtv-bash-hidden'))
      .not.toBeNull();
  });

  test("keeps ceiling row zero unknown after an empty EOF without a numeric floor", async () => {
    const { viewport } = mountTermView({ mode: "hide", historyPaging: "ceiling" });
    await tick();
    const promptOwned = [
      "● Bash(prompt-owned-before-empty-eof)",
      "  ⎿  prompt-owned output",
      "● apparent boundary",
      ...liveLines("empty-eof-live", 117),
    ];
    deliverOutput(promptOwned);

    wheel(viewport, -1_000_000);
    expect(historyCalls.at(-1)).toEqual({
      direction: "before",
      cursor: null,
      limit: 2_000,
    });
    deliverHistory(null, [], false);

    const repainted = [...promptOwned];
    repainted[repainted.length - 1] = "empty-eof-live-repainted-tail";
    deliverOutput(repainted);

    expect(viewport.getAttribute("data-history-stop")).toBe("exhausted");
    expect(numberAttr(viewport, "data-raw-total")).toBe(120);
    expect(numberAttr(viewport, "data-total")).toBe(120);
    expect(viewport.querySelector(".mtv-bash-hidden")).toBeNull();
    expect(viewport.querySelector<HTMLElement>('[data-raw-start="0"]')?.textContent)
      .toBe("● Bash(prompt-owned-before-empty-eof)");
  });

  test("does not reuse an empty numeric-floor proof for a later live window", async () => {
    const { viewport } = mountTermView({ mode: "hide", historyPaging: "ceiling" });
    await tick();
    deliverOutput(liveLines("numeric-eof-live", 120));

    wheel(viewport, -1_000_000);
    expect(historyCalls.at(-1)).toEqual({
      direction: "before",
      cursor: null,
      limit: 2_000,
    });
    deliverHistory(0, [], false);

    deliverOutput([
      "● Bash(prompt-owned-after-empty-floor-zero)",
      "  ⎿  prompt-owned output",
      "● apparent boundary",
      ...liveLines("later-live-window", 117),
    ]);

    expect(viewport.getAttribute("data-history-stop")).toBe("exhausted");
    expect(numberAttr(viewport, "data-raw-total")).toBe(120);
    expect(numberAttr(viewport, "data-total")).toBe(120);
    expect(viewport.querySelector(".mtv-bash-hidden")).toBeNull();
    expect(viewport.querySelector<HTMLElement>('[data-raw-start="0"]')?.textContent)
      .toBe("● Bash(prompt-owned-after-empty-floor-zero)");
  });

  test("does not move a resident ceiling floor with an empty numeric page", async () => {
    const { viewport } = mountTermView({ mode: "hide", historyPaging: "ceiling" });
    await tick();
    deliverOutput(liveLines("resident-floor-live", 120));

    wheel(viewport, -1_000_000);
    const resident = archiveLines(18_000, 5);
    resident[0] = "● Bash(prompt-owned-at-resident-floor)";
    resident[1] = "  ⎿  prompt-owned output";
    resident[2] = "● apparent boundary";
    deliverHistory(18_000, resident, true, 18_005);
    expect(numberAttr(viewport, "data-raw-total")).toBe(125);
    expect(numberAttr(viewport, "data-total")).toBe(125);

    wheel(viewport, -1_000_000);
    expect(historyCalls.at(-1)).toEqual({
      direction: "before",
      cursor: 18_000,
      limit: 2_000,
    });
    deliverHistory(0, [], false);

    const repainted = liveLines("resident-floor-live", 120);
    repainted[repainted.length - 1] = "resident-floor-repainted-tail";
    deliverOutput(repainted);

    expect(viewport.getAttribute("data-history-stop")).toBe("exhausted");
    expect(numberAttr(viewport, "data-raw-total")).toBe(125);
    expect(numberAttr(viewport, "data-total")).toBe(125);
    expect(viewport.querySelector(".mtv-bash-hidden")).toBeNull();
    wheel(viewport, -1_000_000);
    expect(viewport.querySelector<HTMLElement>('[data-raw-start="0"]')?.textContent)
      .toBe("● Bash(prompt-owned-at-resident-floor)");
  });

  test("rejects a ceiling page whose row range exceeds safe integer coordinates", async () => {
    const { viewport } = mountTermView({ mode: "hide", historyPaging: "ceiling" });
    await tick();
    deliverOutput(liveLines("unsafe-floor-live", 120));

    wheel(viewport, -1_000_000);
    expect(historyCalls).toHaveLength(1);
    deliverHistory(
      Number.MAX_SAFE_INTEGER,
      ["unsafe-floor-a", "unsafe-floor-b"],
      false,
    );

    expect(numberAttr(viewport, "data-raw-total")).toBe(120);
    expect(viewport.getAttribute("data-history-stop")).toBe("none");
    expect(viewport.getAttribute("data-history-request-direction")).toBeNull();
    wheel(viewport, -1_000_000);
    expect(historyCalls).toHaveLength(2);
  });

  test("never re-requests a cursorless ceiling page after trimming its prefix", async () => {
    const { viewport } = mountTermView({ mode: "hide", historyPaging: "ceiling" });
    await tick();
    deliverOutput(liveLines("cursorless-retention-live", 9_999));

    wheel(viewport, -1_000_000);
    expect(historyCalls).toEqual([{ direction: "before", cursor: null, limit: 2_000 }]);
    deliverHistory(null, ["cursorless-old-a", "cursorless-old-b"], false);

    expect(numberAttr(viewport, "data-raw-total")).toBe(10_000);
    expect(viewport.getAttribute("data-history-stop")).toBe("exhausted");

    deliverOutput(liveLines("cursorless-retention-shrunk", 120));
    expect(numberAttr(viewport, "data-raw-total")).toBe(121);
    wheel(viewport, -1_000_000);
    expect(historyCalls).toHaveLength(1);
  });

  test("keeps prompt continuation raw after client retention cuts its anchor", async () => {
    const { viewport } = mountTermView({ mode: "hide" });
    await tick();
    const oversized = Array.from(
      { length: 12_000 },
      (_, index) => `retention-row-${index}`,
    );
    oversized[1_999] = "  ❯ submitted prompt anchor outside retained rows";
    oversized[2_000] = "● Bash(prompt-owned-after-client-cut)";
    oversized[2_001] = "  ⎿  prompt-owned output";
    oversized[2_002] = "● apparent boundary";

    deliverOutput(
      oversized,
      undefined,
      historyBoundary("g-client-leading-cut", 0, 1),
    );

    expect(numberAttr(viewport, "data-raw-total")).toBe(10_000);
    expect(numberAttr(viewport, "data-total")).toBe(10_000);
    expect(viewport.querySelector(".mtv-bash-hidden")).toBeNull();
    wheel(viewport, -1_000_000);
    expect(viewport.querySelector<HTMLElement>('[data-raw-start="0"]')?.textContent)
      .toBe("● Bash(prompt-owned-after-client-cut)");

    // A paired replacement at absolute origin zero is a new authoritative raw
    // world. It may safely retire the conservative client-cut provenance.
    deliverOutput(
      [
        "● Bash(printf restored-known-origin)",
        "  ⎿  real command output",
        "● real boundary",
        ...liveLines("restored-known-origin", 7),
      ],
      undefined,
      historyBoundary("g-client-leading-cut", 0, 2),
      { replace: true },
    );
    expect(numberAttr(viewport, "data-raw-total")).toBe(10);
    expect(numberAttr(viewport, "data-total")).toBe(9);
    expect(viewport.querySelector<HTMLElement>('[data-raw-start="0"].mtv-bash-hidden'))
      .not.toBeNull();
  });

  test("does not authorize Haiku work before an oversized origin restore is retained", async () => {
    let summaryCalls = 0;
    const summaryBatches: string[][] = [];
    const { viewport } = mountTermView({
      mode: "haiku",
      onSummary: (requests) => {
        summaryCalls += 1;
        summaryBatches.push(requests.map((request) => request.command));
        return {};
      },
    });
    await tick();
    deliverOutput(
      Array.from({ length: 12_000 }, (_, index) => `initial-cut-${index}`),
      undefined,
      historyBoundary("g-oversized-origin-restore", 0, 1),
    );
    expect(numberAttr(viewport, "data-raw-total")).toBe(10_000);

    const oversizedRestore = Array.from(
      { length: 12_000 },
      (_, index) => `oversized-restore-${index}`,
    );
    oversizedRestore[0] = styledBashHeader("printf evicted-before-summary");
    oversizedRestore[1] = "  ⎿  must never reach Haiku";
    oversizedRestore[2] = "● apparent boundary";
    deliverOutput(
      oversizedRestore,
      undefined,
      historyBoundary("g-oversized-origin-restore", 0, 2),
      { replace: true },
    );
    await settleUi();

    expect(numberAttr(viewport, "data-raw-total")).toBe(10_000);
    expect(summaryCalls).toBe(0);
    expect(viewport.querySelector(".mtv-bash-placeholder")).toBeNull();

    const retainedRestore = Array.from(
      { length: 12_000 },
      (_, index) => `retained-restore-${index}`,
    );
    retainedRestore.splice(11_980, 3, ...completedBash("retained-bootstrap-a"));
    retainedRestore.splice(11_990, 3, ...completedBash("retained-bootstrap-b"));
    deliverOutput(
      retainedRestore,
      undefined,
      historyBoundary("g-oversized-origin-restore", 0, 3),
      { replace: true },
    );
    await settleUi();

    expect(numberAttr(viewport, "data-raw-total")).toBe(10_000);
    expect(summaryCalls).toBe(1);
    expect(summaryBatches).toEqual([[
      "printf retained-bootstrap-a",
      "printf retained-bootstrap-b",
    ]]);
    expect(viewport.querySelector(".mtv-bash-placeholder")).not.toBeNull();
  });

  test("retention finalizes eligibility before a synchronous Haiku callback re-enters", async () => {
    const batches: string[][] = [];
    let nestedFrame: string[] | null = null;
    let nestedDelivered = false;
    mountTermView({
      mode: "haiku",
      onSummary: (requests) => {
        const commands = requests.map((request) => request.command);
        batches.push(commands);
        if (
          !nestedDelivered
          && commands.includes("printf retained-newest-b")
          && nestedFrame
        ) {
          nestedDelivered = true;
          if (!sessionCallback) throw new Error("subscribe was not invoked");
          const frame = [...nestedFrame];
          frame[frame.length - 30] = "reentrant-pre-group-repaint";
          sessionCallback(frame.join("\n"), "output", null, {
            source: "delta",
            replace: true,
            boundary: historyBoundary("g-retention-reentrant", 0, 3),
          });
        }
        return Object.fromEntries(
          requests.map((request) => [request.id, `summary ${request.command}`]),
        );
      },
    });
    await tick();

    deliverOutput(
      completedBash("bootstrap-before-retention"),
      undefined,
      historyBoundary("g-retention-reentrant", 0, 1),
    );
    await settleUi();
    batches.length = 0;

    const oversized = Array.from(
      { length: 12_000 },
      (_, index) => `reentrant-retention-${index}`,
    );
    oversized.splice(11_980, 3, ...completedBash("retained-older-a"));
    oversized.splice(11_990, 3, ...completedBash("retained-newest-b"));
    nestedFrame = oversized.slice(2_000);
    deliverOutput(
      oversized,
      undefined,
      historyBoundary("g-retention-reentrant", 0, 2),
      { source: "delta", replace: true },
    );
    await settleUi();
    await settleUi();

    expect(nestedDelivered).toBe(true);
    expect(batches).toEqual([["printf retained-newest-b"]]);
  });

  test("defers Haiku until cross-seam URL byte retention has settled", async () => {
    let summaryCalls = 0;
    const { viewport } = mountTermView({
      mode: "haiku",
      historyPaging: "ceiling",
      onSummary: () => {
        summaryCalls += 1;
        return {};
      },
    });
    await tick();

    const continuation = "c".repeat(20);
    const resident = liveLines("seam-byte-live", 120);
    resident[0] = continuation;
    resident[1] = "x".repeat(4_000_000);
    deliverOutput(resident);

    const url = `https://example.com/${"a".repeat(40)}`;
    expect(url).toHaveLength(60);
    const page = [
      styledBashHeader("printf evicted-after-seam-accounting"),
      "  ⎿  must not reach Haiku",
      "● completed-before-url-seam",
      url,
    ];
    const wrappedHrefLength = url.length + continuation.length;
    const stageBytes = page.reduce(
      (bytes, line) => bytes + 64 + 2 * line.length,
      64 + 2 * wrappedHrefLength,
    );
    const budget = numberAttr(viewport, "data-retained-byte-budget");
    const initialBytes = numberAttr(viewport, "data-retained-estimated-bytes");
    const fillerGrowth = Math.floor((budget - stageBytes - 100 - initialBytes) / 2);
    expect(fillerGrowth).toBeGreaterThan(0);
    resident[1] += "x".repeat(fillerGrowth);
    deliverOutput(resident);

    const tunedBytes = numberAttr(viewport, "data-retained-estimated-bytes");
    expect(budget - tunedBytes - stageBytes).toBeGreaterThanOrEqual(100);
    expect(budget - tunedBytes - stageBytes).toBeLessThanOrEqual(101);

    wheel(viewport, -1_000_000);
    deliverHistory(0, page, false, page.length);
    await settleUi();

    expect(numberAttr(viewport, "data-retained-estimated-bytes")).toBeLessThanOrEqual(budget);
    expect(numberAttr(viewport, "data-raw-total")).toBe(123);
    expect(deliveredLines.at(-1)).not.toContain(page[0]);
    expect(summaryCalls).toBe(0);
  });

  test("keeps resident prompt rows raw while an origin page is still parsing", async () => {
    const { viewport } = mountTermView({ mode: "hide", historyPaging: "ceiling" });
    await tick();
    deliverOutput(liveLines("atomic-history-live", 120));

    wheel(viewport, -1_000_000);
    const resident = archiveLines(600, 5);
    resident[0] = "● Bash(prompt-owned-during-history-parse)";
    resident[1] = "  ⎿  prompt-owned output";
    resident[2] = "● apparent boundary";
    deliverHistory(600, resident, true, 605);
    expect(numberAttr(viewport, "data-total")).toBe(125);

    wheel(viewport, -1_000_000);
    if (!sessionCallback) throw new Error("subscribe was not invoked");
    sessionCallback(JSON.stringify({
      lines: archiveLines(0, 600),
      startLine: 0,
      endLine: 600,
      totalArchivedLines: 600,
      hasMore: false,
    }), "history");
    flushSync();

    const processReply = idleCallbacks.entries().next().value as
      | [number, IdleRequestCallback]
      | undefined;
    if (!processReply) throw new Error("history reply was not queued");
    idleCallbacks.delete(processReply[0]);
    processReply[1]({ didTimeout: false, timeRemaining: () => 50 });
    flushSync();
    expect(idleCallbacks.size).toBeGreaterThan(0);

    const repainted = liveLines("atomic-history-live", 120);
    repainted[repainted.length - 1] = "atomic-history-live-repainted-tail";
    sessionCallback(repainted.join("\n"), "output", null, {
      source: "full",
      replace: true,
    });
    flushSync();

    expect(numberAttr(viewport, "data-raw-total")).toBe(125);
    expect(numberAttr(viewport, "data-total")).toBe(125);
    expect(viewport.querySelector(".mtv-bash-hidden")).toBeNull();
    drainScheduledWork();
  });

  test("keeps prompt continuation raw when retention cuts only the archive anchor", async () => {
    const { viewport } = mountTermView({ mode: "hide", historyPaging: "ceiling" });
    await tick();
    deliverOutput(liveLines("archive-cut-live", 240));

    wheel(viewport, -1_000_000);
    const archive = archiveLines(0, 9_760);
    archive[0] = "  ❯ submitted prompt anchor at archive origin";
    archive[1] = "● Bash(prompt-owned-after-archive-cut)";
    archive[2] = "  ⎿  prompt-owned output";
    archive[3] = "● apparent boundary";
    deliverHistory(0, archive, false, 9_760);

    expect(numberAttr(viewport, "data-raw-total")).toBe(10_000);
    expect(numberAttr(viewport, "data-total")).toBe(10_000);
    expect(viewport.querySelector(".mtv-bash-hidden")).toBeNull();

    // Growing only the live tail by one row forces the 10k retention gate to
    // remove archive row zero. The plain Bash-shaped continuation becomes the
    // new resident row zero, but its submitted-prompt anchor is now missing.
    deliverOutput(liveLines("archive-cut-live-grown", 241));

    expect(numberAttr(viewport, "data-raw-total")).toBe(10_000);
    expect(numberAttr(viewport, "data-total")).toBe(10_000);
    expect(viewport.querySelector(".mtv-bash-hidden")).toBeNull();
    wheel(viewport, -1_000_000);
    expect(viewport.querySelector<HTMLElement>('[data-raw-start="0"]')?.textContent)
      .toBe("● Bash(prompt-owned-after-archive-cut)");
  });

  test("keeps Bash-shaped prompt continuation raw at a ceiling-history leading edge", async () => {
    const { viewport } = mountTermView({ mode: "hide", historyPaging: "ceiling" });
    await tick();
    deliverOutput(liveLines());

    wheel(viewport, -1_000_000);
    const firstPage = archiveLines(18_000, 2_000);
    firstPage[0] = "● Bash(prompt-owned-before-ceiling-page)";
    firstPage[1] = "  ⎿  prompt-owned output";
    firstPage[2] = "● apparent boundary";
    deliverHistory(18_000, firstPage, true);

    expect(viewport.getAttribute("data-history-paging")).toBe("ceiling");
    expect(numberAttr(viewport, "data-raw-total")).toBe(2_240);
    expect(numberAttr(viewport, "data-total")).toBe(2_240);
    expect(viewport.querySelector(".mtv-bash-hidden")).toBeNull();
    wheel(viewport, -1_000_000);
    expect(historyCalls.at(-1)).toEqual({
      direction: "before",
      cursor: 18_000,
      limit: 2_000,
    });
    expect(viewport.querySelector<HTMLElement>('[data-raw-start="0"]')?.textContent)
      .toBe("● Bash(prompt-owned-before-ceiling-page)");

    deliverHistory(null, [], false);
    deliverOutput(liveLines("ceiling-repaint", 240));
    expect(viewport.getAttribute("data-history-stop")).toBe("exhausted");
    expect(numberAttr(viewport, "data-raw-total")).toBe(2_240);
    expect(numberAttr(viewport, "data-total")).toBe(2_240);
    expect(viewport.querySelector(".mtv-bash-hidden")).toBeNull();
    expect(viewport.querySelector<HTMLElement>('[data-raw-start="0"]')?.textContent)
      .toBe("● Bash(prompt-owned-before-ceiling-page)");
  });

  test("keeps Bash-shaped prompt continuation raw across a nonzero history floor", async () => {
    const { viewport } = mountTermView({ mode: "hide" });
    await tick();
    deliverOutput(liveLines());

    wheel(viewport, -1_000_000);
    const firstPage = archiveLines(18_000, 2_000);
    firstPage[0] = "● Bash(prompt-owned-before-page)";
    firstPage[1] = "  ⎿  prompt-owned output";
    firstPage[2] = "● apparent boundary";
    deliverHistory(18_000, firstPage, true);

    expect(viewport.getAttribute("data-history-window-has-older")).toBe("1");
    expect(numberAttr(viewport, "data-raw-total")).toBe(2_240);
    expect(numberAttr(viewport, "data-total")).toBe(2_240);
    expect(viewport.querySelector(".mtv-bash-hidden")).toBeNull();

    wheel(viewport, -1_000_000);
    expect(historyCalls.at(-1)).toEqual({
      direction: "before",
      cursor: 18_000,
      limit: 2_000,
    });
    expect(viewport.querySelector<HTMLElement>('[data-raw-start="0"]')?.textContent)
      .toBe("● Bash(prompt-owned-before-page)");
    deliverHistory(null, [], false);

    // The server floor makes older rows unreachable, but absolute row 18,000
    // still has unknown physical predecessors. Flipping hasOlder must not make
    // the same prompt-owned bytes suddenly eligible for HIDE.
    expect(viewport.getAttribute("data-history-window-start")).toBe("18000");
    expect(viewport.getAttribute("data-history-window-has-older")).toBe("0");
    expect(numberAttr(viewport, "data-raw-total")).toBe(2_240);
    expect(numberAttr(viewport, "data-total")).toBe(2_240);
    expect(viewport.querySelector(".mtv-bash-hidden")).toBeNull();
    expect(viewport.querySelector<HTMLElement>('[data-raw-start="0"]')?.textContent)
      .toBe("● Bash(prompt-owned-before-page)");
  });

  test("keeps Bash-shaped prompt continuation raw after a leading server-pruning gap", async () => {
    const { viewport } = mountTermView({ mode: "hide" });
    await tick();
    deliverOutput(liveLines());

    for (const startLine of [18_000, 16_000, 14_000, 12_000, 10_000, 8_000]) {
      wheel(viewport, -1_000_000);
      deliverHistory(startLine, archiveLines(startLine, 2_000), true);
    }
    expect(numberAttr(viewport, "data-history-window-end")).toBe(17_760);

    wheel(viewport, 1_000_000);
    expect(historyCalls.at(-1)).toEqual({
      direction: "after",
      cursor: 17_759,
      limit: 2_000,
    });

    const replacement = archiveLines(18_000, 2_000);
    replacement[0] = "● Bash(prompt-owned-after-leading-gap)";
    replacement[1] = "  ⎿  prompt-owned output";
    replacement[2] = "● apparent boundary";
    deliverHistory(18_000, replacement, true);

    expect(numberAttr(viewport, "data-raw-total")).toBe(2_000);
    expect(numberAttr(viewport, "data-total")).toBe(2_000);
    expect(viewport.querySelector(".mtv-bash-hidden")).toBeNull();
    const firstRow = viewport.querySelector<HTMLElement>('[data-raw-start="0"]');
    expect(firstRow?.textContent).toBe("● Bash(prompt-owned-after-leading-gap)");
    expect(viewport.querySelector('[data-gap-marker-rows="240"]')).not.toBeNull();
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
    // form one grouped presentation row covering 9.5k raw rows. Their strict
    // Claude paint proves these are real Bash headers despite the missing
    // archive prefix before resident row zero.
    for (let block = 0; block < 5; block++) {
      const start = block * 1_900;
      resident[start] = styledBashHeader(`printf protected-reader-group-${block}`);
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

  test("invalidates Bash detection when a same-length sliding window replaces raw content", async () => {
    const { viewport } = mountTermView({ mode: "hide" });
    await tick();
    deliverOutput(liveLines("cache-tail", 240));

    wheel(viewport, -1_000_000);
    const resident = archiveLines(2_000, 9_760);
    resident[0] = styledBashHeader("printf old-window");
    resident[1] = "  ⎿  old-output";
    resident[2] = "● old-boundary";
    deliverHistory(2_000, resident, true, 11_760);
    expect(numberAttr(viewport, "data-raw-total")).toBe(10_000);
    expect(numberAttr(viewport, "data-total")).toBe(9_999);
    expect(numberAttr(viewport, "data-claude-bash-detection-scan-rows"))
      .toBeGreaterThan(0);

    wheel(viewport, -1_000_000);
    expect(historyCalls.at(-1)).toEqual({ direction: "before", cursor: 2_000, limit: 2_000 });
    // Processing the reply first detaches the 240-row live suffix and builds a
    // 9,760-row cache, then applies the incoming page as another 9,760-row raw
    // world inside the same delivery. Those equal lengths are not identity.
    expect(numberAttr(viewport, "data-raw-total")).toBe(10_000);
    deliverHistory(0, archiveLines(0, 2_000), false, 11_760);

    // The raw array still has 9,760 rows, but row zero now belongs to the new
    // absolute page. Coordinate-only cache reuse would hide archive-0/1 under
    // the stale old-window block and report a zero-row detector scan.
    expect(numberAttr(viewport, "data-raw-total")).toBe(9_760);
    expect(numberAttr(viewport, "data-claude-bash-detection-scan-rows"))
      .toBeGreaterThan(0);
    wheel(viewport, -1_000_000);
    expect(viewport.querySelector<HTMLElement>('[data-raw-start="0"].mtv-bash-hidden'))
      .toBeNull();
    expect(Array.from(viewport.querySelectorAll<HTMLElement>(".mtv-line"))
      .some((row) => row.textContent === "archive-0")).toBe(true);
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
