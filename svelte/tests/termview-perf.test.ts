/**
 * Regression coverage for the TermView compositor-scroll hot path.
 *
 * A scroll gesture must consume the height cached by ResizeObserver and keep
 * diagnostics off the compositor hot path. Per-frame layout reads, diagnostic
 * attributes, or host callbacks all move fling work back to the main thread.
 */
import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import type { Component } from "svelte";
import { flushSync, mount, unmount, tick } from "./svelte-client";

import TermView from "../src/TermView.svelte";
import { tmuxMux } from "../src/ws-mux.svelte";
import type { AnsiPalette } from "@thumbmux/core";

const require = createRequire(import.meta.url);
const svelteClientInternals = join(
  dirname(require.resolve("svelte/package.json")),
  "src/internal/client/index.js",
);
const { proxy } = (await import(svelteClientInternals)) as {
  proxy: <T extends object>(value: T) => T;
};

type MuxCallback = (
  data: string,
  type?: string,
  cursor?: { row: number; col: number } | null,
  meta?: {
    source: "full" | "delta";
    replace: boolean;
    screen?: { alt: boolean; mouseSgr: boolean; mouseAny: boolean } | null;
    boundary?: {
      generation: string;
      liveStartLine: number;
      walSequence: string;
      walOffset: number;
    };
  },
) => void;

type Mounted = { app: Record<string, unknown>; target: HTMLElement };
type ScrollState = { bottomOffset: number; scrolledUp: boolean };
type TermViewOverrides = {
  altScreenMouse?: boolean;
  bottomInsetPx?: number;
  claimGeometry?: boolean;
  onKeys?: (data: string) => void;
  onLinesChange?: (
    lines: string[],
    meta: { source: "live" | "prepend" | "replace"; pending?: boolean },
  ) => void;
  onGeometryChange?: (geometry: { cols: number; rows: number }) => void;
  minRows?: number;
  maxRows?: number;
  historyPaging?: "ceiling" | "sliding";
};

type MutableViewportLayout = {
  clientWidth: number;
  clientHeight: number;
  left: number;
  top: number;
  width: number;
  height: number;
};

class ControlledResizeObserver implements ResizeObserver {
  static latest: ControlledResizeObserver | null = null;

  constructor(private readonly callback: ResizeObserverCallback) {
    ControlledResizeObserver.latest = this;
  }

  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}

  fire(): void {
    this.callback([], this);
  }
}

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

const SESSION = "sh-termview-scroll-layout-read";
const mounted: Mounted[] = [];

let sessionCallback: MuxCallback | null = null;
let originalSubscribe: typeof tmuxMux.subscribe;
let originalRequestHistory: typeof tmuxMux.requestHistory;
let originalResizeObserver: typeof ResizeObserver;
let originalWindowResizeObserver: typeof ResizeObserver;
let originalRequestAnimationFrame: typeof requestAnimationFrame;
let originalCancelAnimationFrame: typeof cancelAnimationFrame;
let originalWindowRequestAnimationFrame: typeof window.requestAnimationFrame;
let originalWindowCancelAnimationFrame: typeof window.cancelAnimationFrame;
let originalRequestIdleCallbackDescriptor: PropertyDescriptor | undefined;
let originalCancelIdleCallbackDescriptor: PropertyDescriptor | undefined;
let originalWindowRequestIdleCallbackDescriptor: PropertyDescriptor | undefined;
let originalWindowCancelIdleCallbackDescriptor: PropertyDescriptor | undefined;

let frameNow = 0;
let nextFrameId = 1;
let frameCallbacks = new Map<number, FrameRequestCallback>();
let nextIdleId = 1;
let idleCallbacks = new Map<number, IdleRequestCallback>();
let historyRequestCount = 0;
let historyRequests: Array<{ beforeLine?: number | null; limit?: number }> = [];

function requestControlledFrame(callback: FrameRequestCallback): number {
  const id = nextFrameId++;
  frameCallbacks.set(id, callback);
  return id;
}

function cancelControlledFrame(id: number): void {
  frameCallbacks.delete(id);
}

function runAnimationFrameBatch(): number {
  const callbacks = [...frameCallbacks.values()];
  frameCallbacks.clear();
  frameNow += 16;
  for (const callback of callbacks) callback(frameNow);
  // A real browser flushes Svelte's queued DOM work between animation frames.
  // Keep the controlled clock equally observable so hot-path mutations cannot
  // be hidden by batching the entire fling into one synchronous task.
  flushSync();
  return callbacks.length;
}

function drainAnimationFrames(limit = 500): void {
  let batches = 0;
  while (frameCallbacks.size > 0 && batches < limit) {
    runAnimationFrameBatch();
    batches++;
  }
  if (frameCallbacks.size > 0) {
    throw new Error(`animation frame queue did not settle after ${limit} batches`);
  }
}

function requestControlledIdle(callback: IdleRequestCallback): number {
  const id = nextIdleId++;
  idleCallbacks.set(id, callback);
  return id;
}

function cancelControlledIdle(id: number): void {
  idleCallbacks.delete(id);
}

function restoreOwnProperty(
  target: object,
  property: string,
  descriptor: PropertyDescriptor | undefined,
): void {
  if (descriptor) Object.defineProperty(target, property, descriptor);
  else Reflect.deleteProperty(target, property);
}

function runIdleCallbackBatch(): number {
  const callbacks = [...idleCallbacks.values()];
  idleCallbacks.clear();
  const deadline: IdleDeadline = {
    didTimeout: false,
    timeRemaining: () => 50,
  };
  for (const callback of callbacks) callback(deadline);
  flushSync();
  return callbacks.length;
}

function drainScheduledWork(limit = 1_000): void {
  let batches = 0;
  while ((frameCallbacks.size > 0 || idleCallbacks.size > 0) && batches < limit) {
    if (frameCallbacks.size > 0) runAnimationFrameBatch();
    if (idleCallbacks.size > 0) runIdleCallbackBatch();
    batches++;
  }
  if (frameCallbacks.size > 0 || idleCallbacks.size > 0) {
    throw new Error(`scheduled work did not settle after ${limit} batches`);
  }
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

function mountTermView(
  onScrollStateChange?: (state: ScrollState) => void,
  overrides: TermViewOverrides = {},
): Mounted {
  const target = document.createElement("div");
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
        // Preserve the historical benchmark/retention corpus as an explicit
        // rollback-path contract; sliding has its own focused component test.
        historyPaging: "ceiling",
        onScrollStateChange,
        ...overrides,
      },
    }) as Record<string, unknown>;
  });

  const entry = { app: app!, target };
  mounted.push(entry);
  return entry;
}

function deliverOutput(lineCount: number): void {
  if (!sessionCallback) throw new Error("subscribe was not invoked");
  const data = Array.from({ length: lineCount }, (_, i) => `line-${i}`).join("\n");
  sessionCallback(data, "output", null, { source: "full", replace: true });
}

function deliverLiveAppend(previousLastLine: number, appendedLineCount: number): number {
  if (!sessionCallback) throw new Error("subscribe was not invoked");
  const nextLastLine = previousLastLine + appendedLineCount;
  const captureStart = Math.max(0, previousLastLine - 7);
  const data = Array.from(
    { length: nextLastLine - captureStart + 1 },
    (_, i) => `line-${captureStart + i}`,
  ).join("\n");
  sessionCallback(data, "output", null, { source: "full", replace: false });
  return nextLastLine;
}

function deliverHistory(
  lines: string[],
  { startLine = 0, hasMore = false }: { startLine?: number; hasMore?: boolean } = {},
): void {
  if (!sessionCallback) throw new Error("subscribe was not invoked");
  sessionCallback(JSON.stringify({ lines, startLine, hasMore }), "history");
}

async function prepareScrollableTermView(
  onScrollStateChange?: (state: ScrollState) => void,
  lineCount = 240,
  overrides: TermViewOverrides = {},
): Promise<Mounted & {
  viewport: HTMLElement;
  layout: MutableViewportLayout;
  resizeObserver: ControlledResizeObserver;
}> {
  const mountedView = mountTermView(onScrollStateChange, overrides);
  const viewport = mountedView.target.querySelector('[data-testid="mtv"]') as HTMLElement | null;
  if (!viewport) throw new Error("TermView root not found");

  const layout: MutableViewportLayout = {
    clientWidth: 320,
    clientHeight: 240,
    left: 0,
    top: 0,
    width: 320,
    height: 240,
  };
  Object.defineProperty(viewport, "clientHeight", {
    configurable: true,
    get: () => layout.clientHeight,
  });

  const resizeObserver = ControlledResizeObserver.latest;
  if (!resizeObserver) throw new Error("TermView did not observe its viewport");
  resizeObserver.fire();
  deliverOutput(lineCount);
  await tick();
  drainAnimationFrames();
  flushSync();

  return { ...mountedView, viewport, layout, resizeObserver };
}

function viewportRect(layout: MutableViewportLayout): DOMRect {
  return {
    x: layout.left,
    y: layout.top,
    left: layout.left,
    top: layout.top,
    right: layout.left + layout.width,
    bottom: layout.top + layout.height,
    width: layout.width,
    height: layout.height,
    toJSON: () => ({}),
  } as DOMRect;
}

async function prepareAltScreenTermView(
  onKeys: (data: string) => void,
  extraProps: { bottomInsetPx?: number } = {},
) {
  const mountedView = mountTermView(undefined, { altScreenMouse: true, onKeys, ...extraProps });
  const viewport = mountedView.target.querySelector('[data-testid="mtv"]') as HTMLElement | null;
  if (!viewport) throw new Error("TermView root not found");

  const layout: MutableViewportLayout = {
    clientWidth: 168,
    clientHeight: 420,
    left: 10,
    top: 20,
    width: 168,
    height: 420,
  };
  Object.defineProperties(viewport, {
    clientWidth: {
      configurable: true,
      get: () => layout.clientWidth,
    },
    clientHeight: {
      configurable: true,
      get: () => layout.clientHeight,
    },
  });
  const rectSpy = jest
    .spyOn(viewport, "getBoundingClientRect")
    .mockImplementation(() => viewportRect(layout));

  const resizeObserver = ControlledResizeObserver.latest;
  if (!resizeObserver) throw new Error("TermView did not observe its viewport");
  resizeObserver.fire();
  await tick();
  drainAnimationFrames();
  flushSync();
  rectSpy.mockClear();

  return { ...mountedView, viewport, layout, rectSpy, resizeObserver };
}

function wheelTowardHistory(viewport: HTMLElement, deltaY = -120): void {
  viewport.dispatchEvent(
    new WheelEvent("wheel", {
      deltaY,
      deltaMode: WheelEvent.DOM_DELTA_PIXEL,
      bubbles: true,
      cancelable: true,
    }),
  );
  flushSync();
  drainAnimationFrames();
}

function startTouchFling(viewport: HTMLElement, travelPx = 60): number {
  const startY = 80;
  const endY = startY + travelPx;
  viewport.dispatchEvent(touchEvent("touchstart", [{ clientX: 40, clientY: startY }]));
  frameNow += 16;
  viewport.dispatchEvent(touchEvent("touchmove", [{ clientX: 40, clientY: endY }]));
  return endY;
}

function releaseTouchFling(viewport: HTMLElement, endY = 140): void {
  viewport.dispatchEvent(
    touchEvent("touchend", [], [{ clientX: 40, clientY: endY }]),
  );
}

function mountedLineKeys(viewport: HTMLElement): number[] {
  return Array.from(viewport.querySelectorAll(".mtv-line"), (row) => {
    const value = row.getAttribute("data-line-id");
    if (value === null) throw new Error("mounted terminal row is missing data-line-id");
    const key = Number(value);
    if (!Number.isFinite(key)) throw new Error(`invalid terminal row key: ${value}`);
    return key;
  }).sort((a, b) => a - b);
}

function mountedLineContent(viewport: HTMLElement): Map<number, string> {
  return new Map(Array.from(viewport.querySelectorAll<HTMLElement>(".mtv-line"), (row) => {
    const value = row.getAttribute("data-line-id");
    if (value === null) throw new Error("mounted terminal row is missing data-line-id");
    const key = Number(value);
    if (!Number.isFinite(key)) throw new Error(`invalid terminal row key: ${value}`);
    const content = (row.textContent ?? "")
      .replace(/\u00a0/g, " ")
      .replace(/[ \t]+$/g, "");
    return [key, content] as const;
  }));
}

function expectMountedContentPreserved(
  before: Map<number, string>,
  viewport: HTMLElement,
): void {
  const after = mountedLineContent(viewport);
  for (const [key, content] of before) {
    expect(after.get(key)).toBe(content);
  }
}

function compositorLineY(viewport: HTMLElement, lineId: number): number {
  const layer = viewport.querySelector<HTMLElement>(".mtv-layer");
  const firstLine = layer?.querySelector<HTMLElement>(".mtv-line");
  const target = layer?.querySelector<HTMLElement>(`[data-line-id="${lineId}"]`);
  if (!layer || !firstLine || !target) {
    throw new Error(`mounted compositor row ${lineId} not found`);
  }
  const translateMatch = layer.style.transform.match(
    /translate3d\(0(?:px)?,\s*(-?\d+(?:\.\d+)?)px,\s*0(?:px)?\)/,
  );
  const firstLineId = Number(firstLine.getAttribute("data-line-id"));
  const lineHeight = Number.parseFloat(viewport.style.getPropertyValue("--mtv-lineh"));
  if (!translateMatch?.[1] || !Number.isFinite(firstLineId) || !Number.isFinite(lineHeight)) {
    throw new Error("terminal compositor diagnostics are incomplete");
  }
  return Number(translateMatch[1]) + (lineId - firstLineId) * lineHeight;
}

function median(values: number[]): number {
  if (values.length === 0) throw new Error("cannot take the median of an empty sample");
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.floor(ordered.length / 2)]!;
}

function percentile(values: number[], quantile: number): number {
  if (values.length === 0) throw new Error("cannot take a percentile of an empty sample");
  const ordered = [...values].sort((a, b) => a - b);
  const index = Math.min(ordered.length - 1, Math.ceil(ordered.length * quantile) - 1);
  return ordered[index]!;
}

function heapMiB(bytes: number): number {
  return bytes / (1024 * 1024);
}

/** Count a conservative lower bound on array elements moved by a commit.
 * Current prepends shift retained columns with splice; the push hook also
 * catches a full-array rebuild that clears and repopulates those columns. */
function measureArrayElementTouches(run: () => void): number {
  const originalSplice = Array.prototype.splice;
  const originalPush = Array.prototype.push;
  let touches = 0;

  Array.prototype.splice = function (this: unknown[], ...args: unknown[]) {
    if (args[0] === 0 && args[1] === 0 && args.length > 2) {
      touches += this.length + args.length - 2;
    }
    return Reflect.apply(originalSplice, this, args);
  } as typeof Array.prototype.splice;
  Array.prototype.push = function (this: unknown[], ...items: unknown[]) {
    touches += items.length;
    return Reflect.apply(originalPush, this, items);
  } as typeof Array.prototype.push;

  try {
    run();
  } finally {
    Array.prototype.splice = originalSplice;
    Array.prototype.push = originalPush;
  }
  return touches;
}

/** Request, parse, and commit one history page under the controlled schedulers.
 * The history-prepend event is queued by commitStagedPrepend itself, so the
 * final idle batch before that event is the commit cost (not an ANSI slice). */
function prependHistoryPage(
  viewport: HTMLElement,
  lines: string[],
  initialUpperBound: number,
  beforeDeliver?: () => void,
  measureElementTouches = false,
): { commitNs: number; elementTouches: number; lineCount: number; startLine: number } {
  const requestsBefore = historyRequestCount;
  wheelTowardHistory(viewport, -1_000_000);
  if (historyRequestCount !== requestsBefore + 1) {
    throw new Error("history page was delivered without a matching request");
  }
  const request = historyRequests.at(-1);
  const upperBound = typeof request?.beforeLine === "number"
    ? request.beforeLine
    : initialUpperBound;
  const startLine = upperBound - lines.length;
  beforeDeliver?.();

  let committed = false;
  let committedLineCount = -1;
  const onPrepend = (event: Event) => {
    committed = true;
    committedLineCount = Number((event as CustomEvent<{ lineCount?: number }>).detail?.lineCount);
  };
  viewport.addEventListener("thumbmux-history-prepend", onPrepend);
  deliverHistory(lines, { startLine, hasMore: true });

  let lastIdleBatchNs = 0;
  let lastIdleElementTouches = 0;
  let batches = 0;
  try {
    while (!committed && batches < 100) {
      let progressed = false;
      if (idleCallbacks.size > 0) {
        const started = process.hrtime.bigint();
        if (measureElementTouches) {
          lastIdleElementTouches = measureArrayElementTouches(runIdleCallbackBatch);
        } else {
          runIdleCallbackBatch();
        }
        lastIdleBatchNs = Number(process.hrtime.bigint() - started);
        progressed = true;
      }
      if (frameCallbacks.size > 0) {
        runAnimationFrameBatch();
        progressed = true;
      }
      if (!progressed) break;
      batches++;
    }
  } finally {
    viewport.removeEventListener("thumbmux-history-prepend", onPrepend);
  }

  if (!committed) throw new Error("history prepend did not commit");
  if (lastIdleBatchNs <= 0) throw new Error("history prepend commit was not timed");
  if (!Number.isSafeInteger(committedLineCount) || committedLineCount < 0) {
    throw new Error("history prepend event did not report a valid retained line count");
  }
  const retainedRows = Number(viewport.getAttribute("data-total"));
  if (!Number.isSafeInteger(retainedRows) || retainedRows < 0) {
    throw new Error("history prepend commit did not report a valid retained row count");
  }
  drainScheduledWork();
  // These benchmark rows have no links. The one byte-estimate rescan on this
  // commit path reads rawLines and linksByLine once per row.
  const retainedByteRecalculationTouches = measureElementTouches ? retainedRows * 2 : 0;
  return {
    commitNs: lastIdleBatchNs,
    elementTouches: lastIdleElementTouches + retainedByteRecalculationTouches,
    lineCount: committedLineCount,
    startLine,
  };
}

function visibleLineKeyBounds(
  viewport: HTMLElement,
  bottomOffset: number,
): { first: number; last: number } {
  const total = Number(viewport.getAttribute("data-total"));
  const archiveOffset = Number(viewport.getAttribute("data-archive-offset"));
  const lineHeight = Number.parseFloat(viewport.style.getPropertyValue("--mtv-lineh"));
  const maxOffset = Math.max(0, total * lineHeight - viewport.clientHeight);
  const scrollTop = maxOffset - Math.max(0, Math.min(bottomOffset, maxOffset));
  return {
    first: archiveOffset + Math.max(0, Math.floor(scrollTop / lineHeight)),
    last: archiveOffset + Math.min(
      total - 1,
      Math.ceil((scrollTop + viewport.clientHeight) / lineHeight) - 1,
    ),
  };
}

function expectMountedLinesCover(
  viewport: HTMLElement,
  keys: number[],
  bottomOffset: number,
): void {
  const visible = visibleLineKeyBounds(viewport, bottomOffset);
  const mountedKeys = new Set(keys);
  expect(keys[0]).toBeLessThanOrEqual(visible.first);
  expect(keys.at(-1)).toBeGreaterThanOrEqual(visible.last);
  for (let key = visible.first; key <= visible.last; key++) {
    expect(mountedKeys.has(key)).toBe(true);
  }
}

function compositorBottomOffset(viewport: HTMLElement): number {
  const layer = viewport.querySelector(".mtv-layer") as HTMLElement | null;
  const firstLine = layer?.querySelector(".mtv-line") as HTMLElement | null;
  if (!layer || !firstLine) throw new Error("TermView compositor rows not found");

  const translateMatch = layer.style.transform.match(
    /translate3d\(0(?:px)?,\s*(-?\d+(?:\.\d+)?)px,\s*0(?:px)?\)/,
  );
  if (!translateMatch?.[1]) throw new Error(`unexpected transform: ${layer.style.transform}`);

  const totalAttr = viewport.getAttribute("data-total");
  const archiveOffsetAttr = viewport.getAttribute("data-archive-offset");
  const firstLineIdAttr = firstLine.getAttribute("data-line-id");
  if (totalAttr === null || archiveOffsetAttr === null || firstLineIdAttr === null) {
    throw new Error("TermView compositor diagnostics are missing");
  }

  const total = Number(totalAttr);
  const archiveOffset = Number(archiveOffsetAttr);
  const firstLineId = Number(firstLineIdAttr);
  const lineHeight = Number.parseFloat(viewport.style.getPropertyValue("--mtv-lineh"));
  if (![total, archiveOffset, firstLineId, lineHeight].every(Number.isFinite)) {
    throw new Error("TermView compositor diagnostics are not numeric");
  }
  const maxOffset = Math.max(0, total * lineHeight - viewport.clientHeight);
  const winStart = firstLineId - archiveOffset;
  return Math.round(maxOffset + Number(translateMatch[1]) - winStart * lineHeight);
}

function observeBottomOffset(viewport: HTMLElement): {
  observer: MutationObserver;
  takeCount: () => number;
} {
  const delivered: MutationRecord[] = [];
  const observer = new MutationObserver((records) => delivered.push(...records));
  observer.observe(viewport, {
    attributes: true,
    attributeFilter: ["data-bottom-offset"],
  });

  return {
    observer,
    takeCount: () => {
      const records = [...delivered.splice(0), ...observer.takeRecords()];
      return records.filter((record) => record.attributeName === "data-bottom-offset").length;
    },
  };
}

beforeEach(() => {
  sessionCallback = null;
  ControlledResizeObserver.latest = null;
  frameNow = 0;
  nextFrameId = 1;
  frameCallbacks = new Map();
  nextIdleId = 1;
  idleCallbacks = new Map();
  historyRequestCount = 0;
  historyRequests = [];

  originalSubscribe = tmuxMux.subscribe;
  originalRequestHistory = tmuxMux.requestHistory;
  tmuxMux.subscribe = ((session: string, callback: MuxCallback) => {
    if (session === SESSION) sessionCallback = callback;
    return () => {
      if (sessionCallback === callback) sessionCallback = null;
    };
  }) as typeof tmuxMux.subscribe;
  tmuxMux.requestHistory = ((_session: string, beforeLine?: number | null, limit?: number) => {
    historyRequestCount++;
    historyRequests.push({ beforeLine, limit });
    return true;
  }) as typeof tmuxMux.requestHistory;

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
  originalRequestIdleCallbackDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "requestIdleCallback",
  );
  originalCancelIdleCallbackDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "cancelIdleCallback",
  );
  originalWindowRequestIdleCallbackDescriptor = Object.getOwnPropertyDescriptor(
    window,
    "requestIdleCallback",
  );
  originalWindowCancelIdleCallbackDescriptor = Object.getOwnPropertyDescriptor(
    window,
    "cancelIdleCallback",
  );
  globalThis.requestIdleCallback = requestControlledIdle;
  globalThis.cancelIdleCallback = cancelControlledIdle;
  window.requestIdleCallback = requestControlledIdle;
  window.cancelIdleCallback = cancelControlledIdle;
  jest.spyOn(performance, "now").mockImplementation(() => frameNow);
});

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

  tmuxMux.subscribe = originalSubscribe;
  tmuxMux.requestHistory = originalRequestHistory;
  globalThis.ResizeObserver = originalResizeObserver;
  window.ResizeObserver = originalWindowResizeObserver;
  globalThis.requestAnimationFrame = originalRequestAnimationFrame;
  globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
  window.requestAnimationFrame = originalWindowRequestAnimationFrame;
  window.cancelAnimationFrame = originalWindowCancelAnimationFrame;
  restoreOwnProperty(globalThis, "requestIdleCallback", originalRequestIdleCallbackDescriptor);
  restoreOwnProperty(globalThis, "cancelIdleCallback", originalCancelIdleCallbackDescriptor);
  restoreOwnProperty(window, "requestIdleCallback", originalWindowRequestIdleCallbackDescriptor);
  restoreOwnProperty(window, "cancelIdleCallback", originalWindowCancelIdleCallbackDescriptor);
  frameCallbacks.clear();
  idleCallbacks.clear();
  jest.restoreAllMocks();
});

describe("TM-25 TermView configurable row ceiling", () => {
  function measureTallViewportRows(maxRows?: number, minRows = 1): number {
    const geometryCalls: Array<{ cols: number; rows: number }> = [];
    const { target } = mountTermView(undefined, {
      claimGeometry: false,
      minRows,
      ...(maxRows === undefined ? {} : { maxRows }),
      onGeometryChange: (geometry) => geometryCalls.push(geometry),
    });
    const viewport = target.querySelector('[data-testid="mtv"]') as HTMLElement | null;
    if (!viewport) throw new Error("TermView root not found");
    Object.defineProperties(viewport, {
      clientWidth: { configurable: true, get: () => 320 },
      // fontPx=13 gives a rounded 21px line height, so this fits 100 rows.
      clientHeight: { configurable: true, get: () => 2_100 },
    });

    const resizeObserver = ControlledResizeObserver.latest;
    if (!resizeObserver) throw new Error("TermView did not observe its viewport");
    resizeObserver.fire();
    flushSync();

    const geometry = geometryCalls.at(-1);
    if (!geometry) throw new Error("TermView did not report geometry");
    return geometry.rows;
  }

  test("defaults to 60 rows when maxRows is omitted", () => {
    expect(measureTallViewportRows()).toBe(60);
  });

  test("preserves the existing minRows-over-default-ceiling behavior", () => {
    expect(measureTallViewportRows(undefined, 85)).toBe(85);
  });

  test("claims more than 60 rows when maxRows is raised", () => {
    expect(measureTallViewportRows(200)).toBe(100);
  });
});

describe("TermView bottomInsetPx development warnings", () => {
  const VIEWPORT_HEIGHT = 240;

  function withDevWarnings(run: () => void): void {
    const originalDev = process.env.DEV;
    const originalInnerHeight = Object.getOwnPropertyDescriptor(window, "innerHeight");
    process.env.DEV = "true";
    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      value: VIEWPORT_HEIGHT,
    });
    try {
      run();
    } finally {
      restoreOwnProperty(window, "innerHeight", originalInnerHeight);
      if (originalDev === undefined) delete process.env.DEV;
      else process.env.DEV = originalDev;
    }
  }

  function mountWithViewportHeight(bottomInsetPx: number): void {
    const { target } = mountTermView(undefined, { bottomInsetPx });
    const viewport = target.querySelector('[data-testid="mtv"]') as HTMLElement | null;
    if (!viewport) throw new Error("TermView root not found");
    Object.defineProperty(viewport, "clientHeight", {
      configurable: true,
      // Deliberately smaller than the browser viewport: the prop contract is
      // bounded by the whole viewport, not the already-shrunken terminal box.
      get: () => VIEWPORT_HEIGHT / 2,
    });

    const resizeObserver = ControlledResizeObserver.latest;
    if (!resizeObserver) throw new Error("TermView did not observe its viewport");
    resizeObserver.fire();
    flushSync();
  }

  test("warns for every invalid category and identifies the received value", () => {
    withDevWarnings(() => {
      const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
      const invalidValues = [12.5, -1, VIEWPORT_HEIGHT, Number.NaN, Number.POSITIVE_INFINITY];

      for (const value of invalidValues) mountWithViewportHeight(value);

      const messages = warn.mock.calls.map((args) => args.map(String).join(" "));
      expect(messages).toHaveLength(invalidValues.length);
      for (const value of invalidValues) {
        expect(messages.filter((message) => message.includes(`bottomInsetPx=${String(value)}`)))
          .toHaveLength(1);
      }
      expect(messages.every((message) =>
        message.includes("only the portion") && message.includes("exceeds the safe-area")
      )).toBe(true);
    });
  });

  test("does not warn for valid inset values", () => {
    withDevWarnings(() => {
      const warn = jest.spyOn(console, "warn").mockImplementation(() => {});

      for (const value of [0, 12, VIEWPORT_HEIGHT - 1]) {
        mountWithViewportHeight(value);
      }

      expect(warn).not.toHaveBeenCalled();
    });
  });

  test("does not warn for invalid values outside development builds", () => {
    const originalDev = process.env.DEV;
    const originalInnerHeight = Object.getOwnPropertyDescriptor(window, "innerHeight");
    delete process.env.DEV;
    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      value: VIEWPORT_HEIGHT,
    });
    try {
      const warn = jest.spyOn(console, "warn").mockImplementation(() => {});

      for (const value of [12.5, -1, VIEWPORT_HEIGHT, Number.NaN, Number.POSITIVE_INFINITY]) {
        mountWithViewportHeight(value);
      }

      expect(warn).not.toHaveBeenCalled();
    } finally {
      restoreOwnProperty(window, "innerHeight", originalInnerHeight);
      if (originalDev === undefined) delete process.env.DEV;
      else process.env.DEV = originalDev;
    }
  });

  test("revalidates against the new viewport height on window resize", () => {
    withDevWarnings(() => {
      const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
      mountWithViewportHeight(120);
      expect(warn).not.toHaveBeenCalled();

      Object.defineProperty(window, "innerHeight", {
        configurable: true,
        value: 100,
      });
      window.dispatchEvent(new Event("resize"));
      flushSync();

      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.map(String).join(" ")).toContain("bottomInsetPx=120");
    });
  });

  test("warns only once when the same invalid value is checked five times", () => {
    withDevWarnings(() => {
      const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
      const target = document.createElement("div");
      target.style.cssText = "position:relative;width:320px;height:240px;";
      document.body.appendChild(target);
      const props = proxy({
        session: SESSION,
        palette,
        claimGeometry: false,
        fontPx: 13,
        bottomInsetPx: 0,
      });
      let app: Record<string, unknown>;
      flushSync(() => {
        app = mount(TermView as Component, { target, props }) as Record<string, unknown>;
      });
      mounted.push({ app: app!, target });

      const viewport = target.querySelector('[data-testid="mtv"]') as HTMLElement | null;
      if (!viewport) throw new Error("TermView root not found");
      Object.defineProperty(viewport, "clientHeight", {
        configurable: true,
        get: () => VIEWPORT_HEIGHT / 2,
      });

      const resizeObserver = ControlledResizeObserver.latest;
      if (!resizeObserver) throw new Error("TermView did not observe its viewport");
      resizeObserver.fire();
      flushSync();

      for (let check = 0; check < 5; check++) {
        flushSync(() => { props.bottomInsetPx = 500; });
        flushSync(() => { props.bottomInsetPx = 0; });
      }

      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.map(String).join(" ")).toContain("bottomInsetPx=500");
    });
  });

  // A5-2: bottomInsetPx alone does not fire ResizeObserver; row math must still
  // re-measure so a staggered host update (box first, inset later) does not leave
  // the pty short of visibleH + inset.
  test("refreshes measured geometry when bottomInsetPx changes without resizing", () => {
    const geometryCalls: Array<{ cols: number; rows: number }> = [];
    const target = document.createElement("div");
    target.style.cssText = "position:relative;width:320px;height:240px;";
    document.body.appendChild(target);

    const props = proxy({
      session: SESSION,
      palette,
      claimGeometry: true,
      fontPx: 13,
      minRows: 1,
      onGeometryChange: (geometry: { cols: number; rows: number }) => {
        geometryCalls.push(geometry);
      },
      bottomInsetPx: 0,
    });
    let app: Record<string, unknown>;
    flushSync(() => {
      app = mount(TermView as Component, {
        target,
        props,
      }) as Record<string, unknown>;
    });
    mounted.push({ app: app!, target });

    const viewport = target.querySelector('[data-testid="mtv"]') as HTMLElement | null;
    if (!viewport) throw new Error("TermView root not found");
    Object.defineProperties(viewport, {
      clientWidth: { configurable: true, get: () => 320 },
      clientHeight: { configurable: true, get: () => 240 },
    });

    const resizeObserver = ControlledResizeObserver.latest;
    if (!resizeObserver) throw new Error("TermView did not observe its viewport");
    resizeObserver.fire();
    flushSync();

    expect(geometryCalls.length).toBe(1);
    const baseRows = geometryCalls[0]!.rows;

    flushSync(() => { props.bottomInsetPx = 20; });
    flushSync();

    expect(geometryCalls).toHaveLength(2);
    expect(geometryCalls[0]!.cols).toBe(geometryCalls[1]!.cols);
    expect(geometryCalls[1]!.rows).toBe(baseRows + 1);
  });
});

describe("TermView compositor scroll layout reads", () => {
  test("scroll sequence uses cached height while resize still reads the viewport", async () => {
    const { target } = mountTermView();
    const viewport = target.querySelector('[data-testid="mtv"]') as HTMLElement | null;
    if (!viewport) throw new Error("TermView root not found");

    let viewportHeight = 240;
    let clientHeightReads = 0;
    Object.defineProperty(viewport, "clientHeight", {
      configurable: true,
      get: () => {
        clientHeightReads++;
        return viewportHeight;
      },
    });

    const resizeObserver = ControlledResizeObserver.latest;
    if (!resizeObserver) throw new Error("TermView did not observe its viewport");

    // Seed the cached height and content, then discard setup/layout reads.
    resizeObserver.fire();
    deliverOutput(240);
    await tick();
    drainAnimationFrames();
    clientHeightReads = 0;

    viewport.dispatchEvent(
      new WheelEvent("wheel", {
        deltaY: -120,
        deltaMode: WheelEvent.DOM_DELTA_PIXEL,
        bubbles: true,
        cancelable: true,
      }),
    );

    viewport.dispatchEvent(touchEvent("touchstart", [{ clientX: 40, clientY: 80 }]));
    frameNow += 16;
    viewport.dispatchEvent(touchEvent("touchmove", [{ clientX: 40, clientY: 140 }]));
    drainAnimationFrames();
    frameNow += 16;
    viewport.dispatchEvent(
      touchEvent("touchend", [], [{ clientX: 40, clientY: 140 }]),
    );
    drainAnimationFrames();

    const scrollSequenceReads = clientHeightReads;
    expect(scrollSequenceReads).toBe(0);

    viewportHeight = 320;
    resizeObserver.fire();
    expect(clientHeightReads).toBeGreaterThan(scrollSequenceReads);
  });
});

describe("TermView alt-screen pointer and touch hit testing", () => {
  test("forwards a clean primary pointer pair as one computed SGR click", async () => {
    const sgrCorpus: string[] = [];
    const { viewport } = await prepareAltScreenTermView((data) => sgrCorpus.push(data));

    const pointer = {
      button: 0,
      isPrimary: true,
      pointerId: 7,
      clientX: 55,
      clientY: 225,
      bubbles: true,
    };
    viewport.dispatchEvent(new PointerEvent("pointerdown", pointer));
    viewport.dispatchEvent(new PointerEvent("pointerup", pointer));

    expect(sgrCorpus).toEqual(["\x1b[<0;6;10M\x1b[<0;6;10m"]);
  });

  // A docked composer covers the bottom of the pane. It does not move the rows
  // that are still on screen, so the same pixel must still address the same row.
  //
  // Asserting equality against the no-inset case rather than a literal row keeps
  // this honest: rows come from visibleH + inset while the hit rect came from the
  // shrunken visible height, and any expected number written here would have to be
  // derived from whichever of those two the code currently uses — which is the
  // thing under test.
  test("a docked inset does not move which row a pixel addresses", async () => {
    const clickAt = async (bottomInsetPx: number) => {
      const seen: string[] = [];
      const { viewport } = await prepareAltScreenTermView(
        (data) => seen.push(data),
        { bottomInsetPx },
      );
      const pointer = {
        button: 0, isPrimary: true, pointerId: 7,
        clientX: 55, clientY: 225, bubbles: true,
      };
      viewport.dispatchEvent(new PointerEvent("pointerdown", pointer));
      viewport.dispatchEvent(new PointerEvent("pointerup", pointer));
      return seen;
    };

    expect(await clickAt(140)).toEqual(await clickAt(0));
  });

  test("reads the viewport rect at most once while preserving the per-point SGR corpus", async () => {
    const sgrCorpus: string[] = [];
    const { viewport, rectSpy } = await prepareAltScreenTermView((data) => sgrCorpus.push(data));

    viewport.dispatchEvent(touchEvent("touchstart", [{ clientX: 55, clientY: 400 }]));
    for (let index = 1; index <= 10; index++) {
      frameNow += 16;
      viewport.dispatchEvent(
        touchEvent("touchmove", [{ clientX: 55, clientY: 400 - index * 35 }]),
      );
      runAnimationFrameBatch();
    }
    viewport.dispatchEvent(
      touchEvent("touchend", [], [{ clientX: 55, clientY: 50 }]),
    );

    expect(sgrCorpus).toEqual([
      "\x1b[<65;6;12M",
      "\x1b[<65;6;12M",
      "\x1b[<65;6;12M",
      "\x1b[<65;6;12M",
      "\x1b[<65;6;10M",
      "\x1b[<65;6;9M",
      "\x1b[<65;6;7M",
      "\x1b[<65;6;5M",
      "\x1b[<65;6;4M",
      "\x1b[<65;6;2M",
    ]);
    expect(rectSpy.mock.calls.length).toBeLessThanOrEqual(1);
  });

  test("refreshes the cached rect and geometry when ResizeObserver fires mid-gesture", async () => {
    const sgrCorpus: string[] = [];
    const { viewport, layout, rectSpy, resizeObserver } = await prepareAltScreenTermView(
      (data) => sgrCorpus.push(data),
    );

    viewport.dispatchEvent(touchEvent("touchstart", [{ clientX: 55, clientY: 260 }]));
    viewport.dispatchEvent(touchEvent("touchmove", [{ clientX: 55, clientY: 225 }]));
    runAnimationFrameBatch();

    layout.clientWidth = 324;
    layout.left = 100;
    layout.top = 100;
    layout.width = 324;
    resizeObserver.fire();

    viewport.dispatchEvent(touchEvent("touchmove", [{ clientX: 139, clientY: 190 }]));
    runAnimationFrameBatch();
    viewport.dispatchEvent(
      touchEvent("touchend", [], [{ clientX: 139, clientY: 190 }]),
    );

    expect(sgrCorpus).toEqual([
      "\x1b[<65;6;10M",
      "\x1b[<65;5;5M",
    ]);
    expect(rectSpy).toHaveBeenCalledTimes(2);
  });
});

describe("TermView compositor scroll diagnostics", () => {
  test("preserves the reader's physical anchor when the viewport shrinks off-bottom", async () => {
    const { app, viewport, layout, resizeObserver } = await prepareScrollableTermView();
    const isScrolledUp = app.isScrolledUp as (() => boolean) | undefined;
    jest.spyOn(viewport, "getBoundingClientRect").mockImplementation(() => viewportRect(layout));
    // Establish the physical-edge baseline while the exact tail still owns the
    // viewport, just as onMount does in a real browser.
    resizeObserver.fire();

    // SessionView inserts a 44px scroll control plus an 8px gap as soon as the
    // first wheel event leaves the live tail. That makes the observed terminal
    // viewport 52px shorter. Holding bottomOffset constant would move the
    // physical rows 52px toward the live tail and mostly undo a tiny scroll.
    wheelTowardHistory(viewport, -4);
    const offsetBeforeResize = compositorBottomOffset(viewport);
    const total = Number(viewport.getAttribute("data-total"));
    const lineHeight = Number.parseFloat(viewport.style.getPropertyValue("--mtv-lineh"));
    const bottomBeforeResize = viewportRect(layout).bottom;
    const physicalAnchorBefore = bottomBeforeResize + offsetBeforeResize - total * lineHeight;
    const scrollTopBefore = Math.max(0, total * lineHeight - layout.clientHeight)
      - offsetBeforeResize;
    const layer = viewport.querySelector<HTMLElement>(".mtv-layer");
    if (!layer) throw new Error("TermView compositor layer not found");
    const transformBefore = layer.style.transform;

    layout.clientHeight -= 52;
    layout.height -= 52;
    resizeObserver.fire();
    flushSync();
    drainAnimationFrames();

    const offsetAfterResize = compositorBottomOffset(viewport);
    const scrollTopAfter = Math.max(0, total * lineHeight - layout.clientHeight)
      - offsetAfterResize;
    expect(isScrolledUp?.()).toBe(true);
    expect(offsetAfterResize).toBe(offsetBeforeResize + 52);
    expect(scrollTopAfter).toBe(scrollTopBefore);
    expect(viewportRect(layout).bottom + offsetAfterResize - total * lineHeight)
      .toBe(physicalAnchorBefore);
    expect(layer.style.transform).toBe(transformBefore);

    // Once the layout has moved, later live output must still preserve the
    // same reader-owned row instead of silently rejoining tail-follow.
    deliverLiveAppend(239, 1);
    flushSync();
    drainScheduledWork();
    const totalAfterAppend = Number(viewport.getAttribute("data-total"));
    const offsetAfterAppend = compositorBottomOffset(viewport);
    expect(isScrolledUp?.()).toBe(true);
    expect(offsetAfterAppend).toBe(offsetAfterResize + lineHeight);
    expect(viewportRect(layout).bottom + offsetAfterAppend - totalAfterAppend * lineHeight)
      .toBe(physicalAnchorBefore);
    expect(layer.style.transform).toBe(transformBefore);
  });

  test("does not compensate an off-bottom reader when only the viewport top moves", async () => {
    const { app, viewport, layout, resizeObserver } = await prepareScrollableTermView();
    const isScrolledUp = app.isScrolledUp as (() => boolean) | undefined;
    jest.spyOn(viewport, "getBoundingClientRect").mockImplementation(() => viewportRect(layout));
    resizeObserver.fire();

    wheelTowardHistory(viewport, -4);
    const offsetBeforeResize = compositorBottomOffset(viewport);
    const bottomBeforeResize = viewportRect(layout).bottom;

    // A taller HUD moves the terminal's top downward while leaving its bottom
    // edge fixed. Height-only compensation would incorrectly move every row.
    layout.top += 52;
    layout.clientHeight -= 52;
    layout.height -= 52;
    resizeObserver.fire();
    flushSync();
    drainAnimationFrames();

    const offsetAfterResize = compositorBottomOffset(viewport);
    expect(isScrolledUp?.()).toBe(true);
    expect(viewportRect(layout).bottom).toBe(bottomBeforeResize);
    expect(offsetAfterResize).toBe(offsetBeforeResize);
    expect(viewportRect(layout).bottom + offsetAfterResize)
      .toBe(bottomBeforeResize + offsetBeforeResize);
  });

  test("keeps exact-tail ownership when the viewport bottom moves", async () => {
    const { app, viewport, layout, resizeObserver } = await prepareScrollableTermView();
    const isScrolledUp = app.isScrolledUp as (() => boolean) | undefined;
    jest.spyOn(viewport, "getBoundingClientRect").mockImplementation(() => viewportRect(layout));
    resizeObserver.fire();

    layout.clientHeight -= 52;
    layout.height -= 52;
    resizeObserver.fire();
    flushSync();
    drainAnimationFrames();

    expect(isScrolledUp?.()).toBe(false);
    expect(compositorBottomOffset(viewport)).toBe(0);
    expect(viewport.getAttribute("data-bottom-offset")).toBe("0");
  });

  test("preserves an off-bottom anchor on expansion until the live tail enters view", async () => {
    const { app, viewport, layout, resizeObserver } = await prepareScrollableTermView();
    const isScrolledUp = app.isScrolledUp as (() => boolean) | undefined;
    jest.spyOn(viewport, "getBoundingClientRect").mockImplementation(() => viewportRect(layout));
    resizeObserver.fire();

    wheelTowardHistory(viewport, -80);
    const offsetBeforeExpand = compositorBottomOffset(viewport);
    const bottomBeforeExpand = viewportRect(layout).bottom;

    layout.clientHeight += 52;
    layout.height += 52;
    resizeObserver.fire();
    flushSync();
    drainAnimationFrames();

    const offsetAfterExpand = compositorBottomOffset(viewport);
    expect(isScrolledUp?.()).toBe(true);
    expect(offsetAfterExpand).toBe(offsetBeforeExpand - 52);
    expect(viewportRect(layout).bottom + offsetAfterExpand)
      .toBe(bottomBeforeExpand + offsetBeforeExpand);

    // A second expansion reaches past the old reader anchor. At that point
    // there is no content below the viewport to preserve, so exact-tail
    // ownership is the truthful state rather than a negative offset.
    layout.clientHeight += 52;
    layout.height += 52;
    resizeObserver.fire();
    flushSync();
    drainAnimationFrames();

    expect(isScrolledUp?.()).toBe(false);
    expect(compositorBottomOffset(viewport)).toBe(0);
  });

  test("treats any positive bottom offset as scrolled up", async () => {
    const scrollStates: ScrollState[] = [];
    const { app, viewport } = await prepareScrollableTermView((state) => scrollStates.push(state));
    const isScrolledUp = app.isScrolledUp as (() => boolean) | undefined;
    expect(isScrolledUp?.()).toBe(false);
    scrollStates.length = 0;

    // A fractional pixel is deliberately much smaller than the 21px terminal
    // row and would normally round to zero. Follow state is exact: only the
    // actual offset=0 is the live tail, and diagnostics must preserve that
    // sentinel distinction.
    wheelTowardHistory(viewport, -0.25);

    expect(isScrolledUp?.()).toBe(true);
    expect(scrollStates).toEqual([{ bottomOffset: 1, scrolledUp: true }]);
    expect(viewport.getAttribute("data-bottom-offset")).toBe("1");
  });

  test("bottom offset is mirrored once at settle, never during a fling", async () => {
    const { app, viewport } = await prepareScrollableTermView();
    wheelTowardHistory(viewport);

    const isScrolledUp = app.isScrolledUp as (() => boolean) | undefined;
    expect(isScrolledUp?.()).toBe(true);

    const { observer, takeCount } = observeBottomOffset(viewport);
    let duringFlingMutations = 0;
    let settleMutations = 0;

    try {
      startTouchFling(viewport);
      runAnimationFrameBatch();
      duringFlingMutations += takeCount();
      releaseTouchFling(viewport);

      let batches = 0;
      while (frameCallbacks.size > 0 && batches < 500) {
        runAnimationFrameBatch();
        const mutations = takeCount();
        if (frameCallbacks.size > 0) duringFlingMutations += mutations;
        else settleMutations += mutations;
        batches++;
      }
      if (frameCallbacks.size > 0) {
        throw new Error("touch fling did not settle after 500 animation frames");
      }

      expect(duringFlingMutations).toBe(0);
      expect(settleMutations).toBe(1);
      const mirroredOffsetAttr = viewport.getAttribute("data-bottom-offset");
      if (mirroredOffsetAttr === null) throw new Error("settled bottom offset is missing");
      const mirroredOffset = Number(mirroredOffsetAttr);
      expect(Number.isFinite(mirroredOffset)).toBe(true);
      expect(mirroredOffset).toBe(compositorBottomOffset(viewport));
    } finally {
      observer.disconnect();
    }
  });

  test("an unchanged scrolled-up flag does not notify the host during a fling", async () => {
    const scrollStates: ScrollState[] = [];
    const { app, viewport } = await prepareScrollableTermView((state) => scrollStates.push(state));
    wheelTowardHistory(viewport);

    const isScrolledUp = app.isScrolledUp as (() => boolean) | undefined;
    expect(isScrolledUp?.()).toBe(true);
    scrollStates.length = 0;

    startTouchFling(viewport);
    runAnimationFrameBatch();
    releaseTouchFling(viewport);
    drainAnimationFrames();

    expect(isScrolledUp?.()).toBe(true);
    expect(scrollStates).toHaveLength(0);
  });

  test("crossing the scrolled-up boundary notifies the host", async () => {
    const scrollStates: ScrollState[] = [];
    const { app, viewport } = await prepareScrollableTermView((state) => scrollStates.push(state));
    const isScrolledUp = app.isScrolledUp as (() => boolean) | undefined;
    expect(isScrolledUp?.()).toBe(false);
    scrollStates.length = 0;

    startTouchFling(viewport);
    runAnimationFrameBatch();
    releaseTouchFling(viewport);
    drainAnimationFrames();

    expect(scrollStates.some((state) => state.scrolledUp)).toBe(true);
    expect(scrollStates).toHaveLength(1);
  });

  // A5-3: search navigation stopInertia must flush content deferred while
  // momentum is still the busy source. Do not drain the fling to settle —
  // settle would flush itself and hide the missing call. Open search and
  // build matches while idle first so navigate reaches jumpToSearchLine.
  test("flushes deferred content when search navigation cancels momentum", async () => {
    const { viewport } = await prepareScrollableTermView();

    viewport.dispatchEvent(new KeyboardEvent("keydown", {
      key: "f",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    }));
    flushSync();
    const input = viewport.querySelector<HTMLInputElement>(
      '[data-testid="term-search-input"]',
    );
    expect(input).not.toBeNull();
    if (!input) throw new Error("terminal search input did not open");
    input.value = "line-10";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    flushSync();
    drainAnimationFrames();

    const endY = startTouchFling(viewport, 320);
    runAnimationFrameBatch();
    releaseTouchFling(viewport, endY);
    runAnimationFrameBatch();
    // Momentum must still be scheduled; otherwise this is not the reported path.
    expect(frameCallbacks.size).toBeGreaterThan(0);

    const totalBefore = Number(viewport.getAttribute("data-total"));
    if (!sessionCallback) throw new Error("subscribe was not invoked");
    deliverLiveAppend(239, 1);
    expect(Number(viewport.getAttribute("data-total"))).toBe(totalBefore);

    input.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
    }));
    flushSync();

    expect(Number(viewport.getAttribute("data-total"))).toBe(totalBefore + 1);
  });

  // A5-5: wheel must not mutate the scroll model while a native selection is
  // active — otherwise release teleports to a position the user never saw.
  test("ignores wheel deltas while a native selection is active", async () => {
    const { viewport } = await prepareScrollableTermView();
    wheelTowardHistory(viewport, -200);

    const beforeOffset = Number(viewport.getAttribute("data-bottom-offset"));
    const selection = window.getSelection();
    if (!selection) throw new Error("window selection was unavailable");

    const range = document.createRange();
    range.selectNodeContents(viewport);
    selection.removeAllRanges();
    selection.addRange(range);
    // selectionchange is what TermView listens for
    document.dispatchEvent(new Event("selectionchange"));
    flushSync();

    viewport.dispatchEvent(new WheelEvent("wheel", {
      deltaY: -400,
      deltaMode: WheelEvent.DOM_DELTA_PIXEL,
      bubbles: true,
      cancelable: true,
    }));
    flushSync();
    drainAnimationFrames();

    // Still selected: settled mirror stays put either way. Clear selection and
    // require no teleport from a hidden model mutation.
    selection.removeAllRanges();
    document.dispatchEvent(new Event("selectionchange"));
    flushSync();
    drainAnimationFrames();

    expect(Number(viewport.getAttribute("data-bottom-offset"))).toBe(beforeOffset);
  });
});

describe("TermView momentum virtual window", () => {
  test("keeps mounted row keys fixed during long momentum, then rebuilds at settle", async () => {
    const { viewport } = await prepareScrollableTermView(undefined, 2_000);
    const endY = startTouchFling(viewport, 320);

    // Flush the queued drag while the touch is still active. The subsequent
    // distance measurement therefore covers momentum rather than typed input.
    runAnimationFrameBatch();
    const offsetAtRelease = compositorBottomOffset(viewport);

    releaseTouchFling(viewport, endY);
    flushSync();
    const preSettleOffset = viewport.getAttribute("data-bottom-offset");
    const momentumSnapshots: number[][] = [];
    let settled = false;

    for (let frame = 0; frame < 500 && frameCallbacks.size > 0; frame++) {
      runAnimationFrameBatch();
      if (viewport.getAttribute("data-bottom-offset") === preSettleOffset) {
        const keys = mountedLineKeys(viewport);
        expectMountedLinesCover(viewport, keys, compositorBottomOffset(viewport));
        momentumSnapshots.push(keys);
      } else {
        settled = true;
        break;
      }
    }

    expect(settled).toBe(true);
    expect(momentumSnapshots.length).toBeGreaterThan(1);
    const firstMomentumKeys = momentumSnapshots[0]!;
    const momentumWindowRebuilds = momentumSnapshots.slice(1).filter((keys, i) => {
      const previous = momentumSnapshots[i]!;
      return keys.length !== previous.length || keys.some((key, keyIndex) => key !== previous[keyIndex]);
    }).length;
    const changedMomentumFrames = momentumSnapshots.slice(1).filter(
      (keys) => keys.length !== firstMomentumKeys.length || keys.some((key, i) => key !== firstMomentumKeys[i]),
    ).length;
    expect(momentumWindowRebuilds).toBe(0);
    expect(changedMomentumFrames).toBe(0);
    for (const keys of momentumSnapshots) expect(keys).toEqual(firstMomentumKeys);

    drainAnimationFrames();
    flushSync();
    const finalKeys = mountedLineKeys(viewport);
    const finalOffset = compositorBottomOffset(viewport);
    const settledOffset = Number(viewport.getAttribute("data-bottom-offset"));
    const lineHeight = Number.parseFloat(viewport.style.getPropertyValue("--mtv-lineh"));
    expect(finalOffset).toBe(settledOffset);
    expect(finalOffset - offsetAtRelease).toBeGreaterThan(60 * lineHeight);
    expect(finalKeys).not.toEqual(firstMomentumKeys);
    expectMountedLinesCover(viewport, finalKeys, settledOffset);
  });

  test("settles and rebuilds before paint if resize leaves the projected window", async () => {
    const { viewport } = await prepareScrollableTermView(undefined, 2_000);
    const endY = startTouchFling(viewport, 320);
    runAnimationFrameBatch();
    releaseTouchFling(viewport, endY);
    flushSync();
    runAnimationFrameBatch();

    Object.defineProperty(viewport, "clientHeight", {
      configurable: true,
      get: () => 5_000,
    });
    const resizeObserver = ControlledResizeObserver.latest;
    if (!resizeObserver) throw new Error("TermView did not observe its viewport");
    resizeObserver.fire();
    flushSync();

    // The resize invalidates the prebuilt corridor. The same callback must
    // stop inertia and mount the newly visible rows, not paint a blank gap.
    const interruptedKeys = mountedLineKeys(viewport);
    expectMountedLinesCover(viewport, interruptedKeys, compositorBottomOffset(viewport));

    drainAnimationFrames();
    flushSync();
    const settledOffset = Number(viewport.getAttribute("data-bottom-offset"));
    expect(compositorBottomOffset(viewport)).toBe(settledOffset);
    expectMountedLinesCover(viewport, mountedLineKeys(viewport), settledOffset);
  });

  // A5-8: a long touch drag can leave the fixed overscan corridor; rebuild
  // while the finger is still down so the transform never paints blank rows.
  test("rebuilds the rendered corridor when a touch gesture leaves it", async () => {
    const { viewport } = await prepareScrollableTermView(undefined, 2_000);
    const beforeDrag = compositorBottomOffset(viewport);

    viewport.dispatchEvent(touchEvent("touchstart", [{ clientX: 40, clientY: 80 }]));
    frameNow += 16;
    // Drag far past OVERSCAN_ROWS in one frame so the virtual window cannot
    // cover the new visible range without a forced rebuild mid-gesture.
    viewport.dispatchEvent(touchEvent("touchmove", [{ clientX: 40, clientY: 80 + 2_000 }]));
    runAnimationFrameBatch();

    const afterDrag = compositorBottomOffset(viewport);
    expect(afterDrag).toBeGreaterThan(beforeDrag);
    const keys = mountedLineKeys(viewport);
    expectMountedLinesCover(viewport, keys, afterDrag);
  });

  // A5-4: multi-touch after a single-finger start must not apply the pending
  // single-finger drag distance (or a second-contact dy) as a real scroll.
  test("drops stale touch drag distance on a multi-touch transition", async () => {
    const { viewport } = await prepareScrollableTermView(undefined, 2_000);
    wheelTowardHistory(viewport, -200);
    const beforeOffset = compositorBottomOffset(viewport);

    // Control: a clean single-finger drag does move the compositor.
    viewport.dispatchEvent(touchEvent("touchstart", [{ clientX: 40, clientY: 80 }]));
    frameNow += 16;
    viewport.dispatchEvent(touchEvent("touchmove", [{ clientX: 40, clientY: 200 }]));
    runAnimationFrameBatch();
    const afterSingleDrag = compositorBottomOffset(viewport);
    expect(afterSingleDrag).toBeGreaterThan(beforeOffset);
    viewport.dispatchEvent(
      touchEvent("touchend", [], [{ clientX: 40, clientY: 200 }]),
    );
    runAnimationFrameBatch();
    drainAnimationFrames();

    const baseline = compositorBottomOffset(viewport);
    viewport.dispatchEvent(touchEvent("touchstart", [{ clientX: 40, clientY: 80 }]));
    frameNow += 16;
    viewport.dispatchEvent(touchEvent("touchmove", [{ clientX: 40, clientY: 200 }]));
    // Second contact before the drag frame flushes — abort, do not apply dy.
    viewport.dispatchEvent(touchEvent("touchmove", [
      { clientX: 40, clientY: 200 },
      { clientX: 120, clientY: 160 },
    ]));
    viewport.dispatchEvent(
      touchEvent("touchend", [], [{ clientX: 40, clientY: 200 }]),
    );
    runAnimationFrameBatch();
    drainAnimationFrames();

    expect(compositorBottomOffset(viewport)).toBe(baseline);
  });
});

describe("TermView history prepend scheduling", () => {
  test("defers history parse, layout reads, and commit until momentum settles", async () => {
    const { viewport } = await prepareScrollableTermView(undefined, 2_000);
    const baselineTotal = Number(viewport.getAttribute("data-total"));
    const baselineArchiveOffset = Number(viewport.getAttribute("data-archive-offset"));
    const lineHeight = Number.parseFloat(viewport.style.getPropertyValue("--mtv-lineh"));
    const maxOffset = Math.max(0, baselineTotal * lineHeight - viewport.clientHeight);

    // Stop 900px short of the archive threshold. The fling projection crosses
    // it, so the request is issued as momentum starts rather than by the wheel.
    wheelTowardHistory(viewport, -(maxOffset - 900));
    expect(historyRequestCount).toBe(0);
    const endY = startTouchFling(viewport, 60);
    runAnimationFrameBatch();
    releaseTouchFling(viewport, endY);
    flushSync();
    expect(historyRequestCount).toBe(1);

    const settledMirrorBeforeFling = viewport.getAttribute("data-bottom-offset");
    const originalGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;
    let historyRectReads = 0;
    jest.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function () {
      if (this === viewport || this.classList.contains("mtv-line")) historyRectReads++;
      return originalGetBoundingClientRect.call(this);
    });

    const historyLines = Array.from(
      { length: 2_000 },
      (_, i) => `\u001b[31mhistory-${i}\u001b[0m`,
    );
    deliverHistory(historyLines);

    // The old implementation finishes seven 300-row ANSI slices and commits
    // on frame eight. Exercise idle callbacks too: each one must re-check busy.
    for (let frame = 0; frame < 12; frame++) {
      expect(frameCallbacks.size).toBeGreaterThan(0);
      runAnimationFrameBatch();
      if (idleCallbacks.size > 0) runIdleCallbackBatch();
      expect(viewport.getAttribute("data-bottom-offset")).toBe(settledMirrorBeforeFling);
    }

    expect(historyRectReads).toBe(0);
    expect(Number(viewport.getAttribute("data-total"))).toBe(baselineTotal);
    expect(Number(viewport.getAttribute("data-archive-offset"))).toBe(baselineArchiveOffset);

    drainScheduledWork();
    flushSync();

    expect(historyRectReads).toBeGreaterThan(0);
    expect(Number(viewport.getAttribute("data-total"))).toBe(
      baselineTotal + historyLines.length,
    );
    expect(Number(viewport.getAttribute("data-archive-offset"))).toBe(
      baselineArchiveOffset - historyLines.length,
    );
  });

  test("starts an idle history response without waiting for a settle transition", async () => {
    const { viewport } = await prepareScrollableTermView(undefined, 240);
    const baselineTotal = Number(viewport.getAttribute("data-total"));
    const baselineArchiveOffset = Number(viewport.getAttribute("data-archive-offset"));
    const historyLines = ["\u001b[32molder-a\u001b[0m", "older-b", "older-c"];

    wheelTowardHistory(viewport, -1_000_000);
    expect(historyRequestCount).toBe(1);
    deliverHistory(historyLines);
    drainScheduledWork();
    flushSync();

    expect(Number(viewport.getAttribute("data-total"))).toBe(
      baselineTotal + historyLines.length,
    );
    expect(Number(viewport.getAttribute("data-archive-offset"))).toBe(
      baselineArchiveOffset - historyLines.length,
    );
  });

  // A5-7: history prepend must not rebuild mounted DOM while a native selection
  // owns those nodes (same deferral policy as live content / search).
  test("defers history prepend commits while a selection is active", async () => {
    const { viewport } = await prepareScrollableTermView(undefined, 240);
    wheelTowardHistory(viewport, -1_000_000);
    const totalBefore = Number(viewport.getAttribute("data-total"));
    expect(historyRequestCount).toBeGreaterThan(0);

    const selection = window.getSelection();
    if (!selection) throw new Error("window selection was unavailable");
    const range = document.createRange();
    range.selectNodeContents(viewport);
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
    flushSync();

    const onPrepend = jest.fn();
    viewport.addEventListener("thumbmux-history-prepend", onPrepend);

    deliverHistory(["\u001b[31mdeferred-older-1", "\u001b[32mdeferred-older-2"]);
    runAnimationFrameBatch();
    drainScheduledWork();

    expect(onPrepend).not.toHaveBeenCalled();
    expect(Number(viewport.getAttribute("data-total"))).toBe(totalBefore);

    selection.removeAllRanges();
    document.dispatchEvent(new Event("selectionchange"));
    flushSync();
    // Idle task armed on selection release; drain both idle and rAF paths.
    drainScheduledWork();

    expect(onPrepend).toHaveBeenCalledTimes(1);
    expect(Number(viewport.getAttribute("data-total"))).toBe(totalBefore + 2);
  });
});

describe("TermView retained history budgets", () => {
  test("repeated live-only overflow preserves mounted rows and the newest tail", async () => {
    let retainedLines: string[] = [];
    const { viewport } = await prepareScrollableTermView(undefined, 10_000, {
      onLinesChange: (lines) => { retainedLines = [...lines]; },
    });
    wheelTowardHistory(viewport, -1_000_000);
    const mountedBefore = mountedLineContent(viewport);

    let liveLastLine = deliverLiveAppend(9_999, 400);
    flushSync();
    drainScheduledWork();

    expect(Number(viewport.getAttribute("data-total"))).toBeLessThanOrEqual(10_000);
    expectMountedContentPreserved(mountedBefore, viewport);
    expect(retainedLines.at(-1)).toBe(`line-${liveLastLine}`);

    // Cross the first retention seam while the oldest overscan still starts at
    // row zero. A second overflow must introduce another presentational gap,
    // not discard the newest suffix merely because one gap already exists.
    wheelTowardHistory(viewport, 20);
    const mountedBeforeSecondAppend = mountedLineContent(viewport);
    liveLastLine = deliverLiveAppend(liveLastLine, 400);
    flushSync();
    drainScheduledWork();

    expect(Number(viewport.getAttribute("data-total"))).toBeLessThanOrEqual(10_000);
    expectMountedContentPreserved(mountedBeforeSecondAppend, viewport);
    expect(retainedLines.at(-1)).toBe(`line-${liveLastLine}`);

    const lineHeight = Number.parseFloat(viewport.style.getPropertyValue("--mtv-lineh"));
    wheelTowardHistory(viewport, 70 * lineHeight);
    deliverLiveAppend(liveLastLine, 0);
    flushSync();
    drainScheduledWork();
    const gapCounts = Array.from(
      viewport.querySelectorAll<HTMLElement>(".mtv-gap"),
      (row) => Number(row.getAttribute("data-gap-rows")),
    ).sort((a, b) => a - b);
    expect(gapCounts).toEqual([400, 400]);
  }, 120_000);

  test("clears a retention-gap marker when its marked row is evicted", async () => {
    const { viewport } = await prepareScrollableTermView(undefined, 10_000);
    wheelTowardHistory(viewport, -1_000_000);

    let liveLastLine = deliverLiveAppend(9_999, 400);
    flushSync();
    drainScheduledWork();

    const lineHeight = Number.parseFloat(viewport.style.getPropertyValue("--mtv-lineh"));
    wheelTowardHistory(viewport, 70 * lineHeight);
    const marker = viewport.querySelector<HTMLElement>(".mtv-gap");
    expect(marker).not.toBeNull();
    const markerLineId = Number(marker?.getAttribute("data-line-id"));
    const archiveOffsetBefore = Number(viewport.getAttribute("data-archive-offset"));
    expect(markerLineId).toBeGreaterThan(archiveOffsetBefore);

    // Move the protected window below the marked row, then overflow again so
    // prefix retention evicts the row that used to carry the marker.
    wheelTowardHistory(viewport, 700 * lineHeight);
    liveLastLine = deliverLiveAppend(liveLastLine, 400);
    flushSync();
    drainScheduledWork();

    const archiveOffsetAfter = Number(viewport.getAttribute("data-archive-offset"));
    expect(archiveOffsetAfter).toBeGreaterThan(markerLineId);

    wheelTowardHistory(viewport, -1_000_000);
    const firstRetainedRow = viewport.querySelector<HTMLElement>(
      `[data-line-id="${archiveOffsetAfter}"]`,
    );
    expect(firstRetainedRow).not.toBeNull();
    expect(firstRetainedRow?.classList.contains("mtv-gap")).toBe(false);
    expect(firstRetainedRow?.getAttribute("data-gap-rows")).toBeNull();
    expect(viewport.querySelectorAll(".mtv-gap")).toHaveLength(0);
  }, 120_000);

  test("adds the discarded live tail to the gap count on replace", async () => {
    const { viewport } = await prepareScrollableTermView(undefined, 10_000);
    wheelTowardHistory(viewport, -1_000_000);

    deliverLiveAppend(9_999, 400);
    flushSync();
    drainScheduledWork();

    const lineHeight = Number.parseFloat(viewport.style.getPropertyValue("--mtv-lineh"));
    wheelTowardHistory(viewport, 70 * lineHeight);
    const markerBefore = viewport.querySelector<HTMLElement>(".mtv-gap");
    expect(markerBefore).not.toBeNull();

    const markerLineId = Number(markerBefore?.getAttribute("data-line-id"));
    const gapRowsBefore = Number(markerBefore?.getAttribute("data-gap-rows"));
    const archiveOffset = Number(viewport.getAttribute("data-archive-offset"));
    const totalBeforeReplace = Number(viewport.getAttribute("data-total"));
    const markerIndex = markerLineId - archiveOffset;
    const discardedLiveRows = totalBeforeReplace - markerIndex;
    expect(discardedLiveRows).toBeGreaterThan(0);
    const expectedGapRows = gapRowsBefore + discardedLiveRows;

    if (!sessionCallback) throw new Error("subscribe was not invoked");
    sessionCallback(
      Array.from({ length: 12 }, (_, row) => `replacement-row-${row}`).join("\n"),
      "output",
      null,
      { source: "full", replace: true },
    );
    flushSync();
    drainScheduledWork();
    wheelTowardHistory(viewport, 1_000_000);

    const markerAfter = viewport.querySelector<HTMLElement>(".mtv-gap");
    expect(markerAfter).not.toBeNull();
    expect(Number(markerAfter?.getAttribute("data-line-id"))).toBe(markerLineId);
    expect(Number(markerAfter?.getAttribute("data-gap-rows"))).toBe(expectedGapRows);
  }, 120_000);

  test("keeps the gap count stable for a byte-identical replace", async () => {
    let retainedLines: string[] = [];
    let lineChangeCalls = 0;
    const { viewport } = await prepareScrollableTermView(undefined, 10_000, {
      onLinesChange: (lines) => {
        retainedLines = [...lines];
        lineChangeCalls++;
      },
    });
    wheelTowardHistory(viewport, -1_000_000);

    deliverLiveAppend(9_999, 400);
    flushSync();
    drainScheduledWork();

    const lineHeight = Number.parseFloat(viewport.style.getPropertyValue("--mtv-lineh"));
    wheelTowardHistory(viewport, 70 * lineHeight);
    const markerBefore = viewport.querySelector<HTMLElement>(".mtv-gap");
    expect(markerBefore).not.toBeNull();

    const markerLineId = Number(markerBefore?.getAttribute("data-line-id"));
    const gapRowsBefore = Number(markerBefore?.getAttribute("data-gap-rows"));
    const archiveOffset = Number(viewport.getAttribute("data-archive-offset"));
    const totalBefore = Number(viewport.getAttribute("data-total"));
    const markerIndex = markerLineId - archiveOffset;
    const liveTail = retainedLines.slice(markerIndex);
    const callsBefore = lineChangeCalls;

    if (!sessionCallback) throw new Error("subscribe was not invoked");
    sessionCallback(liveTail.join("\n"), "output", null, {
      source: "full",
      replace: true,
    });
    flushSync();
    drainScheduledWork();
    wheelTowardHistory(viewport, -1_000_000);
    wheelTowardHistory(viewport, 70 * lineHeight);

    const markerAfter = viewport.querySelector<HTMLElement>(".mtv-gap");
    expect(Number(viewport.getAttribute("data-total"))).toBe(totalBefore);
    expect(lineChangeCalls).toBe(callsBefore);
    expect(Number(markerAfter?.getAttribute("data-line-id"))).toBe(markerLineId);
    expect(Number(markerAfter?.getAttribute("data-gap-rows"))).toBe(gapRowsBefore);
  }, 120_000);

  // A5-6: replace=true with a stable common prefix must still shift the reader
  // anchor so the same physical row stays under the finger.
  test("preserves the reader anchor when replace keeps a stable prefix", async () => {
    let retainedLines: string[] = [];
    const { viewport } = await prepareScrollableTermView(undefined, 240, {
      onLinesChange: (lines) => { retainedLines = [...lines]; },
    });
    wheelTowardHistory(viewport, -200);
    const beforeOffset = Number(viewport.getAttribute("data-bottom-offset"));
    const lineHeight = Number.parseFloat(viewport.style.getPropertyValue("--mtv-lineh"));

    if (!sessionCallback) throw new Error("subscribe was not invoked");
    sessionCallback(
      [...retainedLines, "replacement-tail-line"].join("\n"),
      "output",
      null,
      { source: "full", replace: true },
    );
    flushSync();
    drainScheduledWork();

    const afterOffset = Number(viewport.getAttribute("data-bottom-offset"));
    expect(afterOffset - beforeOffset).toBeCloseTo(lineHeight, 5);
  }, 120_000);

  test("keeps the viewport fixed when a full replace rewrites a long tail", async () => {
    let retainedLines: string[] = [];
    const { viewport } = await prepareScrollableTermView(undefined, 240, {
      onLinesChange: (lines) => { retainedLines = [...lines]; },
    });
    wheelTowardHistory(viewport, -1);

    const layer = viewport.querySelector<HTMLElement>(".mtv-layer");
    if (!layer) throw new Error("TermView compositor layer not found");
    const transformBefore = layer.style.transform;
    const offsetBefore = compositorBottomOffset(viewport);
    const totalBefore = Number(viewport.getAttribute("data-total"));
    const stablePrefix = retainedLines.slice(0, -6);

    if (!sessionCallback) throw new Error("subscribe was not invoked");
    sessionCallback(
      [
        ...stablePrefix,
        "rewritten-tail-1",
        "rewritten-tail-2",
        "rewritten-tail-3",
        "rewritten-tail-4",
        "rewritten-tail-5",
        "rewritten-tail-6",
        "new-tail-1",
        "new-tail-2",
        "new-tail-3",
        "new-tail-4",
      ].join("\n"),
      "output",
      null,
      { source: "full", replace: true },
    );
    flushSync();
    drainScheduledWork();

    expect(Number(viewport.getAttribute("data-total"))).toBe(totalBefore + 4);
    expect(compositorBottomOffset(viewport)).toBe(offsetBefore + 4 * 21);
    expect(layer.style.transform).toBe(transformBefore);
  }, 120_000);

  test("keeps a reader fixed while a sliding live window repaints its screen tail", async () => {
    let retainedLines: string[] = [];
    const { app, viewport } = await prepareScrollableTermView(undefined, 240, {
      onLinesChange: (lines) => { retainedLines = [...lines]; },
    });
    wheelTowardHistory(viewport, -200);

    const mountedBefore = mountedLineContent(viewport);
    const mountedIds = [...mountedBefore.keys()];
    const anchorId = mountedIds[Math.floor(mountedIds.length / 2)];
    if (anchorId === undefined) throw new Error("no mounted reader anchor was available");
    const anchorText = mountedBefore.get(anchorId);
    const anchorYBefore = compositorLineY(viewport, anchorId);
    const offsetBefore = compositorBottomOffset(viewport);
    const lineHeight = Number.parseFloat(viewport.style.getPropertyValue("--mtv-lineh"));
    let wireCapture = retainedLines.slice();

    if (!sessionCallback) throw new Error("subscribe was not invoked");
    for (let frame = 1; frame <= 5; frame++) {
      // Real agents keep a fixed capture window: one finalized row leaves the
      // top while their 5-8 row composer/status tail is repainted in place.
      // Exact suffix-to-prefix matching sees no overlap in that shape, but the
      // immutable rows above one pane still prove the chronological shift.
      wireCapture = [
        ...wireCapture.slice(1, -6),
        ...Array.from({ length: 7 }, (_, row) => `stream-${frame}-tail-${row}`),
      ];
      sessionCallback(
        wireCapture.join("\n"),
        "output",
        null,
        { source: "full", replace: false },
      );
      flushSync();
      drainScheduledWork();

      expect(Number(viewport.getAttribute("data-total"))).toBe(240 + frame);
      expect(compositorBottomOffset(viewport)).toBe(offsetBefore + frame * lineHeight);
      expect(mountedLineContent(viewport).get(anchorId)).toBe(anchorText);
      expect(compositorLineY(viewport, anchorId)).toBe(anchorYBefore);
      expect(retainedLines.slice(-wireCapture.length)).toEqual(wireCapture);
      for (let oldFrame = 1; oldFrame < frame; oldFrame++) {
        const marker = `stream-${oldFrame}-tail-`;
        expect(retainedLines.filter((line) => line.startsWith(marker))).toHaveLength(
          wireCapture.filter((line) => line.startsWith(marker)).length,
        );
      }
    }

    const scrollToBottom = app.scrollToBottom as (() => boolean) | undefined;
    expect(scrollToBottom?.()).toBe(true);
    flushSync();
    drainScheduledWork();
    expect(compositorBottomOffset(viewport)).toBe(0);

    wireCapture = [
      ...wireCapture.slice(1, -6),
      ...Array.from({ length: 7 }, (_, row) => `resumed-tail-${row}`),
    ];
    sessionCallback(
      wireCapture.join("\n"),
      "output",
      null,
      { source: "full", replace: false },
    );
    flushSync();
    drainScheduledWork();

    expect(compositorBottomOffset(viewport)).toBe(0);
    expect(retainedLines.at(-1)).toBe("resumed-tail-6");
  }, 120_000);

  test("freezes a short Grok Minimal repaint whose row continuity cannot be proven", async () => {
    let retainedLines: string[] = [];
    const { viewport } = await prepareScrollableTermView(undefined, 56, {
      historyPaging: "sliding",
      onLinesChange: (lines) => { retainedLines = [...lines]; },
    });
    wheelTowardHistory(viewport, -200);

    const mountedBefore = mountedLineContent(viewport);
    const mountedIds = [...mountedBefore.keys()];
    const anchorId = mountedIds[Math.floor(mountedIds.length / 2)];
    if (anchorId === undefined) throw new Error("no short Grok reader anchor was available");
    const anchorText = mountedBefore.get(anchorId);
    const anchorYBefore = compositorLineY(viewport, anchorId);

    // Grok Minimal commits a block with insert_before, then repaints its live
    // viewport. While the conversation is shorter than one maximum pane there
    // is no immutable suffix-to-prefix seam strong enough to identify rows.
    const nextCapture = [
      "line-0",
      "line-1",
      "line-2",
      "line-3",
      ...Array.from({ length: 8 }, (_, row) => `grok-committed-${row}`),
      ...Array.from({ length: 44 }, (_, row) => `grok-live-repaint-${row}`),
    ];
    if (!sessionCallback) throw new Error("subscribe was not invoked");
    sessionCallback(nextCapture.join("\n"), "output", null, {
      source: "delta",
      replace: false,
      screen: { alt: false, mouseSgr: false, mouseAny: false },
    });
    flushSync();
    drainScheduledWork();

    expect(viewport.getAttribute("data-live-rejoin-pending")).toBe("1");
    expect(mountedLineContent(viewport).get(anchorId)).toBe(anchorText);
    expect(compositorLineY(viewport, anchorId)).toBe(anchorYBefore);
    expect(retainedLines.at(-1)).toBe("line-55");

    wheelTowardHistory(viewport, 1_000_000);
    expect(viewport.getAttribute("data-live-rejoin-pending")).toBeNull();
    expect(compositorBottomOffset(viewport)).toBe(0);
    expect(retainedLines.at(-1)).toBe("grok-live-repaint-43");
    expect([...mountedLineContent(viewport).values()]).toContain("grok-live-repaint-43");

    const followedCapture = [...nextCapture.slice(1), "grok-followed-at-tail"];
    sessionCallback(followedCapture.join("\n"), "output", null, {
      source: "delta",
      replace: false,
      screen: { alt: false, mouseSgr: false, mouseAny: false },
    });
    flushSync();
    drainScheduledWork();
    expect(viewport.getAttribute("data-live-rejoin-pending")).toBeNull();
    expect(compositorBottomOffset(viewport)).toBe(0);
    expect([...mountedLineContent(viewport).values()]).toContain("grok-followed-at-tail");
  }, 120_000);

  test("keeps a pending Grok reader frozen across resync and its first durable boundary", async () => {
    let retainedLines: string[] = [];
    const lineEvents: Array<{
      lines: string[];
      meta: { source: "live" | "prepend" | "replace"; pending?: boolean };
    }> = [];
    const { app, viewport } = await prepareScrollableTermView(undefined, 240, {
      historyPaging: "sliding",
      onLinesChange: (lines, meta) => {
        retainedLines = [...lines];
        lineEvents.push({ lines: [...lines], meta: { ...meta } });
      },
    });
    wheelTowardHistory(viewport, -400);

    const mountedBefore = mountedLineContent(viewport);
    const mountedIds = [...mountedBefore.keys()];
    const anchorId = mountedIds[Math.floor(mountedIds.length / 2)];
    if (anchorId === undefined) throw new Error("no resync reader anchor was available");
    const anchorText = mountedBefore.get(anchorId);
    const anchorYBefore = compositorLineY(viewport, anchorId);

    if (!sessionCallback) throw new Error("subscribe was not invoked");
    const unproven = Array.from({ length: 240 }, (_, row) => `grok-unproven-${row}`);
    sessionCallback(unproven.join("\n"), "output", { row: 1, col: 2 }, {
      source: "delta",
      replace: false,
      screen: { alt: false, mouseSgr: false, mouseAny: false },
    });
    flushSync();
    drainScheduledWork();
    expect(viewport.getAttribute("data-live-rejoin-pending")).toBe("1");
    expect(lineEvents.at(-1)?.meta.pending).toBe(true);
    expect(lineEvents.at(-1)?.lines.at(-1)).toBe("line-239");

    const resync = Array.from({ length: 240 }, (_, row) => `grok-resync-${row}`);
    sessionCallback(resync.join("\n"), "output", undefined, {
      source: "full",
      replace: true,
      screen: { alt: false, mouseSgr: false, mouseAny: false },
      boundary: {
        generation: "grok-generation-1",
        liveStartLine: 12_000,
        walSequence: "42",
        walOffset: 4_096,
      },
    });
    sessionCallback("", "cursor", { row: 7, col: 8 });
    flushSync();
    drainScheduledWork();

    expect(viewport.getAttribute("data-live-rejoin-pending")).toBe("1");
    expect(mountedLineContent(viewport).get(anchorId)).toBe(anchorText);
    expect(compositorLineY(viewport, anchorId)).toBe(anchorYBefore);
    expect(retainedLines.at(-1)).toBe("line-239");
    expect(lineEvents.at(-1)?.meta).toMatchObject({ source: "live", pending: true });
    const deferredEventCount = lineEvents.length;

    const scrollToBottom = app.scrollToBottom as (() => boolean) | undefined;
    expect(scrollToBottom?.()).toBe(true);
    flushSync();
    drainScheduledWork();
    expect(viewport.getAttribute("data-live-rejoin-pending")).toBeNull();
    expect(lineEvents).toHaveLength(deferredEventCount + 1);
    expect(lineEvents.at(-1)?.meta.pending).toBeUndefined();
    expect(lineEvents.at(-1)?.lines.at(-1)).toBe("grok-resync-239");
    expect([...mountedLineContent(viewport).values()]).toContain("grok-resync-239");
    expect(viewport.querySelector('[data-testid="mtv-cursor"]')?.getAttribute("data-cursor-row"))
      .toBe("7");
  }, 120_000);

  test("bounds an unproven deferred capture before it rejoins the live tail", async () => {
    const { app, viewport } = await prepareScrollableTermView(undefined, 240, {
      historyPaging: "sliding",
    });
    wheelTowardHistory(viewport, -400);

    const oversized = Array.from(
      { length: 12_000 },
      (_, row) => `grok-oversized-deferred-${row}`,
    );
    if (!sessionCallback) throw new Error("subscribe was not invoked");
    sessionCallback(oversized.join("\n"), "output", null, {
      source: "delta",
      replace: false,
      screen: { alt: false, mouseSgr: false, mouseAny: false },
      boundary: {
        generation: "grok-oversized-boundary",
        liveStartLine: 50_000,
        walSequence: "99",
        walOffset: 9_900,
      },
    });
    flushSync();
    drainScheduledWork();

    expect(viewport.getAttribute("data-live-rejoin-pending")).toBe("1");
    expect(Number(viewport.getAttribute("data-total"))).toBe(240);

    const scrollToBottom = app.scrollToBottom as (() => boolean) | undefined;
    expect(scrollToBottom?.()).toBe(true);
    flushSync();
    drainScheduledWork();
    expect(viewport.getAttribute("data-live-rejoin-pending")).toBeNull();
    expect(Number(viewport.getAttribute("data-raw-total"))).toBeLessThanOrEqual(10_000);
    expect(Number(viewport.getAttribute("data-retained-estimated-bytes")))
      .toBeLessThanOrEqual(Number(viewport.getAttribute("data-retained-byte-budget")));
    expect(viewport.getAttribute("data-history-generation")).toBeNull();
    expect([...mountedLineContent(viewport).values()])
      .toContain("grok-oversized-deferred-11999");

    const recoveredBoundaryCapture = Array.from(
      { length: 240 },
      (_, row) => `grok-boundary-recovered-${row}`,
    );
    sessionCallback(recoveredBoundaryCapture.join("\n"), "output", null, {
      source: "delta",
      replace: false,
      screen: { alt: false, mouseSgr: false, mouseAny: false },
      boundary: {
        generation: "grok-oversized-boundary",
        liveStartLine: 50_000,
        walSequence: "99",
        walOffset: 9_900,
      },
    });
    flushSync();
    drainScheduledWork();
    expect(viewport.getAttribute("data-history-generation"))
      .toBe("grok-oversized-boundary");
  }, 120_000);

  test("keeps the Grok reader model frozen across a 300-frame touch burst", async () => {
    let retainedLines: string[] = [];
    const { app, viewport } = await prepareScrollableTermView(undefined, 240, {
      historyPaging: "sliding",
      onLinesChange: (lines) => { retainedLines = [...lines]; },
    });
    const grokCapture = (start: number, frame: number) => [
      ...Array.from({ length: 190 }, (_, row) => `grok-history-${start + row}`),
      ...Array.from({ length: 50 }, (_, row) => `grok-frame-${frame}-live-${row}`),
    ];

    if (!sessionCallback) throw new Error("subscribe was not invoked");
    sessionCallback(grokCapture(0, 0).join("\n"), "output", null, {
      source: "full",
      replace: true,
      screen: { alt: false, mouseSgr: false, mouseAny: false },
    });
    flushSync();
    drainScheduledWork();
    wheelTowardHistory(viewport, -400);

    viewport.dispatchEvent(touchEvent("touchstart", [{ clientX: 40, clientY: 120 }]));
    viewport.dispatchEvent(touchEvent("touchmove", [{ clientX: 40, clientY: 180 }]));
    drainScheduledWork();
    // Decay the sampled velocity without moving again, so touchend exercises
    // the real drag path but does not leave an unrelated momentum animation.
    for (let sample = 0; sample < 32; sample++) {
      viewport.dispatchEvent(touchEvent("touchmove", [{ clientX: 40, clientY: 180 }]));
    }

    const mountedBefore = mountedLineContent(viewport);
    const mountedIds = [...mountedBefore.keys()];
    const anchorId = mountedIds[Math.floor(mountedIds.length / 2)];
    if (anchorId === undefined) throw new Error("no burst reader anchor was available");
    const anchorText = mountedBefore.get(anchorId);
    const anchorYBefore = compositorLineY(viewport, anchorId);

    // Mobile content delivery deliberately coalesces to the newest whole frame
    // while a finger owns the compositor. A long Grok turn can therefore move
    // farther than every text-overlap heuristic before the gesture releases.
    for (let frame = 1; frame <= 300; frame++) {
      sessionCallback(grokCapture(frame, frame).join("\n"), "output", null, {
        source: "delta",
        replace: false,
        screen: { alt: false, mouseSgr: false, mouseAny: false },
      });
    }
    viewport.dispatchEvent(
      touchEvent("touchend", [], [{ clientX: 40, clientY: 180 }]),
    );
    flushSync();
    drainScheduledWork();

    expect(viewport.getAttribute("data-live-rejoin-pending")).toBe("1");
    expect(mountedLineContent(viewport).get(anchorId)).toBe(anchorText);
    expect(compositorLineY(viewport, anchorId)).toBe(anchorYBefore);

    const scrollToBottom = app.scrollToBottom as (() => boolean) | undefined;
    expect(scrollToBottom?.()).toBe(true);
    flushSync();
    drainScheduledWork();
    expect(viewport.getAttribute("data-live-rejoin-pending")).toBeNull();
    expect(compositorBottomOffset(viewport)).toBe(0);
    expect(retainedLines.at(-1)).toBe("grok-frame-300-live-49");
    expect([...mountedLineContent(viewport).values()]).toContain("grok-frame-300-live-49");
  }, 120_000);

  test("prefers the pane seam when repeated chrome makes a false exact overlap", async () => {
    let retainedLines: string[] = [];
    const { viewport } = await prepareScrollableTermView(undefined, 240, {
      onLinesChange: (lines) => { retainedLines = [...lines]; },
    });
    const chrome = Array.from({ length: 8 }, (_, row) => `repeated-chrome-${row}`);
    const initial = Array.from({ length: 240 }, (_, row) => `seam-line-${row}`);
    initial.splice(4, chrome.length, ...chrome);
    initial.splice(initial.length - chrome.length, chrome.length, ...chrome);

    if (!sessionCallback) throw new Error("subscribe was not invoked");
    sessionCallback(
      initial.join("\n"),
      "output",
      null,
      { source: "full", replace: true },
    );
    flushSync();
    drainScheduledWork();
    wheelTowardHistory(viewport, -200);

    const mountedBefore = mountedLineContent(viewport);
    const mountedIds = [...mountedBefore.keys()];
    const anchorId = mountedIds[Math.floor(mountedIds.length / 2)];
    if (anchorId === undefined) throw new Error("no repeated-chrome anchor was available");
    const anchorText = mountedBefore.get(anchorId);
    const anchorYBefore = compositorLineY(viewport, anchorId);
    const offsetBefore = compositorBottomOffset(viewport);
    const lineHeight = Number.parseFloat(viewport.style.getPropertyValue("--mtv-lineh"));
    const nextCapture = [
      ...initial.slice(4, -chrome.length),
      ...Array.from({ length: 12 }, (_, row) => `repainted-tail-${row}`),
    ];

    sessionCallback(
      nextCapture.join("\n"),
      "output",
      null,
      { source: "full", replace: false },
    );
    flushSync();
    drainScheduledWork();

    expect(Number(viewport.getAttribute("data-total"))).toBe(244);
    expect(compositorBottomOffset(viewport)).toBe(offsetBefore + 4 * lineHeight);
    expect(mountedLineContent(viewport).get(anchorId)).toBe(anchorText);
    expect(compositorLineY(viewport, anchorId)).toBe(anchorYBefore);
    expect(retainedLines.slice(-nextCapture.length)).toEqual(nextCapture);
    for (const marker of chrome) {
      expect(retainedLines.filter((line) => line === marker)).toHaveLength(1);
    }
  }, 120_000);

  // A5-9 (replace path): full-window identical overlap must not claim every
  // shortened row as "already retained" — keep one row of churn so gap math
  // still records a real discard when a repetitive live window shrinks.
  test("keeps at least one churn row when an identical capture shortens by one", async () => {
    let retainedLines: string[] = [];
    const { viewport } = await prepareScrollableTermView(undefined, 10_000, {
      onLinesChange: (lines) => { retainedLines = [...lines]; },
    });
    wheelTowardHistory(viewport, -1_000_000);

    deliverLiveAppend(9_999, 400);
    flushSync();
    drainScheduledWork();

    const lineHeight = Number.parseFloat(viewport.style.getPropertyValue("--mtv-lineh"));
    wheelTowardHistory(viewport, 70 * lineHeight);
    const markerBefore = viewport.querySelector<HTMLElement>(".mtv-gap");
    expect(markerBefore).not.toBeNull();

    const markerLineId = Number(markerBefore?.getAttribute("data-line-id"));
    const gapRowsBefore = Number(markerBefore?.getAttribute("data-gap-rows"));
    const archiveOffset = Number(viewport.getAttribute("data-archive-offset"));
    const markerIndex = markerLineId - archiveOffset;
    const oldTail = retainedLines.slice(markerIndex);
    expect(oldTail.length).toBeGreaterThan(1);

    if (!sessionCallback) throw new Error("subscribe was not invoked");
    sessionCallback(
      Array.from({ length: oldTail.length }, () => "repetitive-row").join("\n"),
      "output",
      null,
      { source: "full", replace: true },
    );
    flushSync();
    drainScheduledWork();

    const markerAfterNormalize = viewport.querySelector<HTMLElement>(".mtv-gap");
    expect(markerAfterNormalize).not.toBeNull();
    const gapRowsAfterNormalize = Number(markerAfterNormalize?.getAttribute("data-gap-rows"));

    sessionCallback(
      Array.from({ length: oldTail.length - 1 }, () => "repetitive-row").join("\n"),
      "output",
      null,
      { source: "full", replace: true },
    );
    flushSync();
    drainScheduledWork();

    const markerAfter = viewport.querySelector<HTMLElement>(".mtv-gap");
    expect(markerAfter).not.toBeNull();
    const gapRowsAfter = Number(markerAfter?.getAttribute("data-gap-rows"));
    expect(gapRowsAfter - gapRowsAfterNormalize).toBe(2);
    // silence unused - marker identity is the gap seam, not re-asserted here
    expect(gapRowsBefore).toBeGreaterThanOrEqual(0);
  }, 120_000);

  test("counts only rows absent after a suffix-overlap replace", async () => {
    let retainedLines: string[] = [];
    const { viewport } = await prepareScrollableTermView(undefined, 10_000, {
      onLinesChange: (lines) => { retainedLines = [...lines]; },
    });
    wheelTowardHistory(viewport, -1_000_000);

    deliverLiveAppend(9_999, 400);
    flushSync();
    drainScheduledWork();

    const lineHeight = Number.parseFloat(viewport.style.getPropertyValue("--mtv-lineh"));
    wheelTowardHistory(viewport, 70 * lineHeight);
    const markerBefore = viewport.querySelector<HTMLElement>(".mtv-gap");
    expect(markerBefore).not.toBeNull();

    const markerLineId = Number(markerBefore?.getAttribute("data-line-id"));
    const gapRowsBefore = Number(markerBefore?.getAttribute("data-gap-rows"));
    const archiveOffset = Number(viewport.getAttribute("data-archive-offset"));
    const markerIndex = markerLineId - archiveOffset;
    const oldLiveTail = retainedLines.slice(markerIndex);
    const replacement = oldLiveTail.slice(-100);

    if (!sessionCallback) throw new Error("subscribe was not invoked");
    sessionCallback(replacement.join("\n"), "output", null, {
      source: "full",
      replace: true,
    });
    flushSync();
    drainScheduledWork();
    wheelTowardHistory(viewport, -1_000_000);
    wheelTowardHistory(viewport, 70 * lineHeight);

    const markerAfter = viewport.querySelector<HTMLElement>(".mtv-gap");
    const liveRowsAfter = retainedLines.length - markerIndex;
    const expectedGapRows = gapRowsBefore + oldLiveTail.length - liveRowsAfter;
    expect(Number(markerAfter?.getAttribute("data-line-id"))).toBe(markerLineId);
    expect(Number(markerAfter?.getAttribute("data-gap-rows"))).toBe(expectedGapRows);
  }, 120_000);

  test("counts a bottom-aligned unchanged suffix as retained on replace", async () => {
    let retainedLines: string[] = [];
    const { viewport } = await prepareScrollableTermView(undefined, 10_000, {
      onLinesChange: (lines) => { retainedLines = [...lines]; },
    });
    wheelTowardHistory(viewport, -1_000_000);

    deliverLiveAppend(9_999, 400);
    flushSync();
    drainScheduledWork();

    const lineHeight = Number.parseFloat(viewport.style.getPropertyValue("--mtv-lineh"));
    wheelTowardHistory(viewport, 70 * lineHeight);
    const markerBefore = viewport.querySelector<HTMLElement>(".mtv-gap");
    expect(markerBefore).not.toBeNull();

    const markerLineId = Number(markerBefore?.getAttribute("data-line-id"));
    const gapRowsBefore = Number(markerBefore?.getAttribute("data-gap-rows"));
    const archiveOffset = Number(viewport.getAttribute("data-archive-offset"));
    const markerIndex = markerLineId - archiveOffset;
    const oldLiveTail = retainedLines.slice(markerIndex);
    const replacement = [
      ...oldLiveTail.slice(0, -100).map((_, row) => `reflowed-row-${row}`),
      ...oldLiveTail.slice(-100),
    ];

    if (!sessionCallback) throw new Error("subscribe was not invoked");
    sessionCallback(replacement.join("\n"), "output", null, {
      source: "full",
      replace: true,
    });
    flushSync();
    drainScheduledWork();
    wheelTowardHistory(viewport, -1_000_000);
    wheelTowardHistory(viewport, 70 * lineHeight);

    const newLiveTail = retainedLines.slice(markerIndex);
    let retainedSuffixRows = 0;
    while (
      retainedSuffixRows < Math.min(oldLiveTail.length, newLiveTail.length) &&
      oldLiveTail[oldLiveTail.length - 1 - retainedSuffixRows] ===
        newLiveTail[newLiveTail.length - 1 - retainedSuffixRows]
    ) {
      retainedSuffixRows++;
    }
    const markerAfter = viewport.querySelector<HTMLElement>(".mtv-gap");
    const expectedGapRows = gapRowsBefore + oldLiveTail.length - retainedSuffixRows;
    expect(Number(markerAfter?.getAttribute("data-line-id"))).toBe(markerLineId);
    expect(Number(markerAfter?.getAttribute("data-gap-rows"))).toBe(expectedGapRows);
  }, 120_000);

  test("retains an unchanged prefix when replace repaints only the live tail", async () => {
    let retainedLines: string[] = [];
    const { viewport } = await prepareScrollableTermView(undefined, 10_000, {
      onLinesChange: (lines) => { retainedLines = [...lines]; },
    });
    wheelTowardHistory(viewport, -1_000_000);

    deliverLiveAppend(9_999, 400);
    flushSync();
    drainScheduledWork();

    const lineHeight = Number.parseFloat(viewport.style.getPropertyValue("--mtv-lineh"));
    wheelTowardHistory(viewport, 70 * lineHeight);
    const markerBefore = viewport.querySelector<HTMLElement>(".mtv-gap");
    expect(markerBefore).not.toBeNull();

    const markerLineId = Number(markerBefore?.getAttribute("data-line-id"));
    const gapRowsBefore = Number(markerBefore?.getAttribute("data-gap-rows"));
    const archiveOffset = Number(viewport.getAttribute("data-archive-offset"));
    const markerIndex = markerLineId - archiveOffset;
    const oldLiveTail = retainedLines.slice(markerIndex);
    const replacement = [...oldLiveTail.slice(0, -1), "repainted-live-tail"];

    if (!sessionCallback) throw new Error("subscribe was not invoked");
    sessionCallback(replacement.join("\n"), "output", null, {
      source: "full",
      replace: true,
    });
    flushSync();
    drainScheduledWork();
    wheelTowardHistory(viewport, -1_000_000);
    wheelTowardHistory(viewport, 70 * lineHeight);

    const newLiveTail = retainedLines.slice(markerIndex);
    let retainedPrefixRows = 0;
    while (
      retainedPrefixRows < Math.min(oldLiveTail.length, newLiveTail.length) &&
      oldLiveTail[retainedPrefixRows] === newLiveTail[retainedPrefixRows]
    ) {
      retainedPrefixRows++;
    }
    const markerAfter = viewport.querySelector<HTMLElement>(".mtv-gap");
    const expectedGapRows = gapRowsBefore + oldLiveTail.length - retainedPrefixRows;
    expect(Number(markerAfter?.getAttribute("data-line-id"))).toBe(markerLineId);
    expect(Number(markerAfter?.getAttribute("data-gap-rows"))).toBe(expectedGapRows);
  }, 120_000);

  test("does not create a retention-gap marker on replace without an existing gap", async () => {
    const { viewport } = await prepareScrollableTermView(undefined, 240);
    expect(viewport.querySelectorAll(".mtv-gap")).toHaveLength(0);

    if (!sessionCallback) throw new Error("subscribe was not invoked");
    sessionCallback(
      Array.from({ length: 12 }, (_, row) => `no-gap-replacement-${row}`).join("\n"),
      "output",
      null,
      { source: "full", replace: true },
    );
    flushSync();
    drainScheduledWork();
    wheelTowardHistory(viewport, -1_000_000);

    expect(viewport.querySelectorAll(".mtv-gap")).toHaveLength(0);
  }, 120_000);

  test("live append stays within retention budgets without changing mounted rows", async () => {
    let retainedLines: string[] = [];
    const { viewport } = await prepareScrollableTermView(undefined, 240, {
      onLinesChange: (lines) => { retainedLines = [...lines]; },
    });

    for (let page = 1; page <= 20; page++) {
      const lines = Array.from(
        { length: 500 },
        (_, row) => `live-budget-page-${page}-row-${row}`,
      );
      prependHistoryPage(viewport, lines, 1_000_000);
    }

    const mountedBefore = mountedLineContent(viewport);

    expect(mountedBefore.size).toBeGreaterThan(60);
    expect(Number(viewport.getAttribute("data-total"))).toBe(10_000);

    let liveLastLine = 239;
    for (let tickIndex = 1; tickIndex <= 30; tickIndex++) {
      liveLastLine = deliverLiveAppend(liveLastLine, 400);
      flushSync();
      drainScheduledWork();
      const mountedAfterTick = mountedLineContent(viewport);
      for (const key of mountedBefore.keys()) {
        if (!mountedAfterTick.has(key)) {
          throw new Error(
            `mounted key ${key} disappeared on live tick ${tickIndex}; ` +
            `archiveOffset=${viewport.getAttribute("data-archive-offset")} ` +
            `bottomOffset=${viewport.getAttribute("data-bottom-offset")}`,
          );
        }
      }
    }
    await tick();
    drainScheduledWork();
    flushSync();

    const retainedRows = Number(viewport.getAttribute("data-total"));
    const retainedBytes = Number(viewport.getAttribute("data-retained-estimated-bytes"));
    const byteBudget = Number(viewport.getAttribute("data-retained-byte-budget"));
    expect(retainedRows).toBeLessThanOrEqual(10_000);
    expect(retainedBytes).toBeLessThanOrEqual(byteBudget);
    expectMountedContentPreserved(mountedBefore, viewport);
    expect(retainedLines.at(-1)).toBe("line-12239");
  }, 120_000);

  test("marks the exact dropped-row gap without adding terminal content", async () => {
    let retainedLines: string[] = [];
    const { viewport } = await prepareScrollableTermView(undefined, 240, {
      onLinesChange: (lines) => { retainedLines = [...lines]; },
    });
    let priorGapRows = 0;

    for (let page = 1; page <= 20; page++) {
      const beforeTotal = Number(viewport.getAttribute("data-total"));
      const committed = prependHistoryPage(
        viewport,
        Array.from(
          { length: 500 },
          (_, row) => `gap-page-${page}-row-${row}`,
        ),
        1_000_000,
      );
      const afterTotal = Number(viewport.getAttribute("data-total"));
      priorGapRows += Math.max(0, committed.lineCount - (afterTotal - beforeTotal));
    }

    const totalBeforeLive = Number(viewport.getAttribute("data-total"));
    const archiveOffsetBeforeLive = Number(viewport.getAttribute("data-archive-offset"));
    let liveLastLine = 239;
    for (let tickIndex = 0; tickIndex < 2; tickIndex++) {
      liveLastLine = deliverLiveAppend(liveLastLine, 400);
      flushSync();
      drainScheduledWork();
    }

    const totalAfterLive = Number(viewport.getAttribute("data-total"));
    const archiveOffsetAfterLive = Number(viewport.getAttribute("data-archive-offset"));
    const prefixRowsDropped = archiveOffsetAfterLive - archiveOffsetBeforeLive;
    const liveRowsAppended = liveLastLine - 239;
    const liveGapRows = totalBeforeLive + liveRowsAppended - totalAfterLive - prefixRowsDropped;
    const expectedGapRows = priorGapRows + liveGapRows;
    expect(expectedGapRows).toBeGreaterThan(0);

    const gapIndex = retainedLines.findIndex((line) => /^line-\d+$/.test(line));
    expect(gapIndex).toBeGreaterThan(0);
    const total = Number(viewport.getAttribute("data-total"));
    const lineHeight = Number.parseFloat(viewport.style.getPropertyValue("--mtv-lineh"));
    const maxOffset = Math.max(0, total * lineHeight - viewport.clientHeight);
    const desiredScrollTop = Math.max(0, (gapIndex - 5) * lineHeight);
    const desiredBottomOffset = maxOffset - desiredScrollTop;
    const currentBottomOffset = Number(viewport.getAttribute("data-bottom-offset"));
    wheelTowardHistory(viewport, currentBottomOffset - desiredBottomOffset);

    const marker = viewport.querySelector<HTMLElement>(".mtv-gap");
    expect(marker).not.toBeNull();
    expect(marker?.classList.contains("mtv-line")).toBe(true);
    expect(Number(marker?.getAttribute("data-gap-rows"))).toBe(expectedGapRows);
    const expectedGapLabel = `${expectedGapRows} rows dropped before this row`;
    expect(marker?.getAttribute("title")).toBe(expectedGapLabel);
    const semanticMarker = marker?.previousElementSibling as HTMLElement | null;
    expect(semanticMarker?.matches('.mtv-gap-marker[role="note"]')).toBe(true);
    expect(semanticMarker?.getAttribute("aria-label")).toBe(expectedGapLabel);
    expect(semanticMarker?.textContent).toBe("");
    expect(viewport.querySelectorAll(".mtv-gap-marker")).toHaveLength(1);
    expect(viewport.querySelectorAll(".mtv-gap")).toHaveLength(1);
    expect(retainedLines).toHaveLength(totalAfterLive);
    expect(retainedLines.some((line) => line.includes("rows dropped"))).toBe(false);

    deliverLiveAppend(liveLastLine, 0);
    flushSync();
    drainScheduledWork();
    expect(Number(
      viewport.querySelector<HTMLElement>(".mtv-gap")?.getAttribute("data-gap-rows"),
    )).toBe(expectedGapRows);
  }, 120_000);

  test("retains sparse SGR checkpoints and HTML for only the mounted window", async () => {
    const { viewport } = await prepareScrollableTermView(undefined, 10_000);
    const checkpointAttr = viewport.getAttribute("data-sgr-checkpoint-count");
    const intervalAttr = viewport.getAttribute("data-sgr-checkpoint-interval");
    const cacheAttr = viewport.getAttribute("data-render-cache-rows");

    expect(checkpointAttr).not.toBeNull();
    expect(intervalAttr).not.toBeNull();
    expect(cacheAttr).not.toBeNull();

    const checkpointCount = Number(checkpointAttr);
    const checkpointInterval = Number(intervalAttr);
    const cacheRowsAtBottom = Number(cacheAttr);
    const mountedRowsAtBottom = viewport.querySelectorAll(".mtv-line").length;
    expect(checkpointInterval).toBeGreaterThan(1);
    expect(checkpointCount).toBeGreaterThan(1);
    expect(checkpointCount).toBeLessThanOrEqual(Math.ceil(10_000 / checkpointInterval) + 2);
    expect(cacheRowsAtBottom).toBeLessThanOrEqual(mountedRowsAtBottom);
    expect(cacheRowsAtBottom).toBeLessThan(10_000 / 10);

    wheelTowardHistory(viewport, -1_000_000);
    const cacheRowsAtTop = Number(viewport.getAttribute("data-render-cache-rows"));
    const mountedRowsAtTop = viewport.querySelectorAll(".mtv-line").length;
    expect(cacheRowsAtTop).toBeLessThanOrEqual(mountedRowsAtTop);
    expect(cacheRowsAtTop).toBeLessThan(10_000 / 10);
  }, 120_000);

  test("search rebuilds and highlights a cold sparse window", async () => {
    const { viewport } = await prepareScrollableTermView(undefined, 10_000);
    wheelTowardHistory(viewport, -1_000_000);

    viewport.dispatchEvent(new KeyboardEvent("keydown", {
      key: "f",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    }));
    flushSync();
    drainAnimationFrames();

    const input = viewport.querySelector<HTMLInputElement>(
      '[data-testid="term-search-input"]',
    );
    expect(input).not.toBeNull();
    if (!input) throw new Error("terminal search input did not open");
    input.value = "line-9999";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    flushSync();
    drainAnimationFrames();

    expect(
      viewport.querySelector('[data-testid="term-search-match"]')?.textContent,
    ).toContain("1 matches");
    input.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
    }));
    flushSync();
    drainAnimationFrames();

    const active = viewport.querySelector<HTMLElement>(".search-active");
    expect(active).not.toBeNull();
    expect(active?.textContent).toBe("line-9999");
  }, 120_000);

  test("defers a cold render-cache rebuild until the touch gesture ends", async () => {
    const { viewport } = await prepareScrollableTermView(undefined, 2_000);
    const buildAttr = viewport.getAttribute("data-render-cache-builds");
    expect(buildAttr).not.toBeNull();
    const buildsBeforeTouch = Number(buildAttr);

    // A short drag stays inside the overscan corridor: no mid-gesture rebuild.
    // (A long drag that leaves the corridor is free to force-rebuild — A5-8 —
    // so this pin must use a travel that does not exit the window.)
    const endY = startTouchFling(viewport, 80);
    runAnimationFrameBatch();
    expect(Number(viewport.getAttribute("data-render-cache-builds"))).toBe(buildsBeforeTouch);

    releaseTouchFling(viewport, endY);
    flushSync();
    const buildsAfterTouch = Number(viewport.getAttribute("data-render-cache-builds"));
    expect(buildsAfterTouch).toBeGreaterThan(buildsBeforeTouch);
    const settledMirrorBeforeMomentum = viewport.getAttribute("data-bottom-offset");

    for (let frame = 0; frame < 10 && frameCallbacks.size > 0; frame++) {
      runAnimationFrameBatch();
      if (viewport.getAttribute("data-bottom-offset") !== settledMirrorBeforeMomentum) break;
      expect(Number(viewport.getAttribute("data-render-cache-builds"))).toBe(buildsAfterTouch);
    }
    drainAnimationFrames();
  }, 120_000);

  test("last accepted prepend touches at most 2x page 10 before saturation", async () => {
    const { viewport } = await prepareScrollableTermView(undefined, 240);
    const elementTouches: number[] = [];

    for (let page = 1; page <= 25; page++) {
      const lines = Array.from(
        { length: 500 },
        (_, row) => `history-page-${page}-row-${row}`,
      );
      const beforeTotal = Number(viewport.getAttribute("data-total"));
      const committed = prependHistoryPage(
        viewport,
        lines,
        1_000_000,
        undefined,
        true,
      );
      const afterTotal = Number(viewport.getAttribute("data-total"));
      // Accepted rows are the whole growth: a prepend may reject part of its
      // incoming oldest prefix, but it must never make room by deleting rows
      // that were retained before this request.
      expect(afterTotal - beforeTotal).toBe(committed.lineCount);
      elementTouches.push(committed.elementTouches);
      if (afterTotal >= 10_000) break;
    }

    expect(elementTouches.length).toBeGreaterThanOrEqual(15);
    const page10Touches = median(elementTouches.slice(7, 12));
    const terminalTouches = median(elementTouches.slice(-5));
    expect(terminalTouches / page10Touches).toBeLessThanOrEqual(2);
  }, 120_000);

  test("last accepted wall-clock commit stays within 3x page 10", async () => {
    const { viewport } = await prepareScrollableTermView(undefined, 240);
    const durations: number[] = [];

    for (let page = 1; page <= 25; page++) {
      const lines = Array.from(
        { length: 500 },
        (_, row) => `history-page-${page}-row-${row}`,
      );
      const beforeTotal = Number(viewport.getAttribute("data-total"));
      const committed = prependHistoryPage(
        viewport,
        lines,
        1_000_000,
      );
      const afterTotal = Number(viewport.getAttribute("data-total"));
      expect(afterTotal - beforeTotal).toBe(committed.lineCount);
      durations.push(committed.commitNs);
      if (afterTotal >= 10_000) break;
    }

    expect(durations.length).toBeGreaterThanOrEqual(15);
    const page10Ns = median(durations.slice(7, 12));
    const terminalNs = median(durations.slice(-5));
    expect(terminalNs / page10Ns).toBeLessThanOrEqual(3);
  }, 120_000);

  test("saturation preserves traversed rows and blocks six futile refetch ticks", async () => {
    let retainedLines: string[] = [];
    const { viewport } = await prepareScrollableTermView(undefined, 240, {
      onLinesChange: (lines) => { retainedLines = [...lines]; },
    });
    let mountedAtCap = new Map<number, string>();

    for (let page = 1; page <= 25; page++) {
      const lines = Array.from(
        { length: 500 },
        (_, row) => `retained-page-${page}-row-${row}`,
      );
      const beforeTotal = Number(viewport.getAttribute("data-total"));
      const committed = prependHistoryPage(
        viewport,
        lines,
        2_000_000,
      );
      const afterTotal = Number(viewport.getAttribute("data-total"));
      expect(afterTotal - beforeTotal).toBe(committed.lineCount);
      if (afterTotal >= 10_000) {
        mountedAtCap = mountedLineContent(viewport);
        break;
      }
    }

    expect(Number(viewport.getAttribute("data-total"))).toBe(10_000);
    expect(retainedLines).toHaveLength(10_000);
    expect(mountedAtCap.size).toBeGreaterThan(60);
    const retainedAtCap = new Set(retainedLines);
    for (const content of mountedAtCap.values()) expect(retainedAtCap.has(content)).toBe(true);
    const requestsAtCap = historyRequestCount;
    let liveLastLine = 239;

    for (let tickIndex = 1; tickIndex <= 6; tickIndex++) {
      liveLastLine = deliverLiveAppend(liveLastLine, 1);
      flushSync();
      drainScheduledWork();
      const requestsBeforeWheel = historyRequestCount;
      wheelTowardHistory(viewport, -1_000_000);
      if (historyRequestCount > requestsBeforeWheel) {
        const beforeLine = historyRequests.at(-1)?.beforeLine;
        const upperBound = typeof beforeLine === "number" ? beforeLine : 2_000_000;
        deliverHistory(
          Array.from(
            { length: 500 },
            (_, row) => `futile-page-${tickIndex}-row-${row}`,
          ),
          { startLine: Math.max(0, upperBound - 500), hasMore: true },
        );
        drainScheduledWork();
        flushSync();
      }
    }

    expect(historyRequestCount - requestsAtCap).toBe(0);
  }, 120_000);

  test("oversized history rows are bounded by bytes before the row cap", async () => {
    const { viewport } = await prepareScrollableTermView(undefined, 240);
    let mountedBefore = new Map<number, string>();
    const longLines = Array.from(
      { length: 500 },
      (_, row) => `wide-history-${row}-${"x".repeat(12_000)}`,
    );

    const committed = prependHistoryPage(
      viewport,
      longLines,
      3_000_000,
      () => { mountedBefore = mountedLineContent(viewport); },
    );

    // 740 rows is below the row cap, so this can only pass when the byte
    // budget evicts part of the oversized page.
    const retainedRows = Number(viewport.getAttribute("data-total"));
    const retainedBytes = Number(viewport.getAttribute("data-retained-estimated-bytes"));
    const byteBudget = Number(viewport.getAttribute("data-retained-byte-budget"));
    expect(committed.lineCount).toBeGreaterThan(0);
    expect(committed.lineCount).toBeLessThan(longLines.length);
    expect(retainedRows).toBeGreaterThan(240);
    expect(retainedRows).toBeLessThan(740);
    expect(byteBudget).toBe(8 * 1024 * 1024);
    expect(retainedBytes).toBeGreaterThan(0);
    expect(retainedBytes).toBeLessThanOrEqual(byteBudget);
    expectMountedContentPreserved(mountedBefore, viewport);

    wheelTowardHistory(viewport, -1_000_000);
    expect(Array.from(mountedLineContent(viewport).values()).some(
      (content) => content.startsWith("wide-history-"),
    )).toBe(true);
  }, 120_000);
});

describe("TermView sparse retained-storage benchmark", () => {
  const playwrightChromiumPath = chromium.executablePath();
  const playwrightChromiumAvailable = existsSync(playwrightChromiumPath);
  const chromiumBenchmarkTest = playwrightChromiumAvailable ? test : test.skip;
  const chromiumBenchmarkName = playwrightChromiumAvailable
    ? "100k-row Chrome heap, cold rebuild, and search stay within measured gates"
    : "100k-row Chrome heap, cold rebuild, and search stay within measured gates " +
      `(skipped: Playwright Chromium is not installed at ${playwrightChromiumPath})`;

  chromiumBenchmarkTest(chromiumBenchmarkName, async () => {
    const browser = await chromium.launch({
      headless: true,
      args: ["--js-flags=--expose-gc"],
    });

    try {
      const page = await browser.newPage();
      const client = await page.context().newCDPSession(page);
      const coreDistPath = join(
        dirname(fileURLToPath(import.meta.url)),
        "../../core/dist/index.js",
      );
      const coreSource = await Bun.file(coreDistPath).text();
      await page.addScriptTag({
        type: "module",
        content: `${coreSource}\n;globalThis.__thumbmuxBench = { createSgrState, cloneSgrState, lineToHtml, searchLines };`,
      });
      await page.waitForFunction(() => Boolean((globalThis as Record<string, unknown>).__thumbmuxBench));

      await page.evaluate(() => {
        const api = (globalThis as Record<string, any>).__thumbmuxBench;
        const palette = {
          defaultFg: "#eeeeee",
          defaultBg: "#111111",
          base: Array.from({ length: 16 }, (_, i) => `#${i.toString(16).repeat(6)}`),
        };
        const state = api.createSgrState();
        for (let i = 0; i < 2_000; i++) {
          api.lineToHtml(`\u001b[38;5;${i % 256}mWARM-${i}\u001b[0m`, state, palette);
        }
        api.searchLines(["warm-search-line"], "search");
      });

      const collectGarbage = async () => {
        await client.send("HeapProfiler.collectGarbage");
        await client.send("HeapProfiler.collectGarbage");
      };
      const heapUsed = async () => {
        const usage = await client.send("Runtime.getHeapUsage") as { usedSize: number };
        return usage.usedSize;
      };

      const measureShape = async (mode: "legacy" | "sparse") => {
        await page.evaluate(() => { (globalThis as Record<string, any>).__retainedModel = null; });
        await collectGarbage();
        const baseline = await heapUsed();
        const result = await page.evaluate((shape) => {
          const api = (globalThis as Record<string, any>).__thumbmuxBench;
          const palette = {
            defaultFg: "#eeeeee",
            defaultBg: "#111111",
            base: [
              "#000000", "#aa0000", "#00aa00", "#aa5500",
              "#0000aa", "#aa00aa", "#00aaaa", "#aaaaaa",
              "#555555", "#ff5555", "#55ff55", "#ffff55",
              "#5555ff", "#ff55ff", "#55ffff", "#ffffff",
            ],
          };
          const rowCount = 100_000;
          const payload = "x".repeat(112);
          const raw = Array.from(
            { length: rowCount },
            (_, i) => `\u001b[38;5;${i % 256}mROW-${i}-${payload}\u001b[0m`,
          );
          const archived = raw.slice(0, rowCount - 240);
          const live = raw.slice(rowCount - 240);
          const links = new Array(rowCount);

          if (shape === "legacy") {
            const html = new Array(rowCount);
            const stateBefore = new Array(rowCount);
            const stateAfter = new Array(rowCount);
            const state = api.createSgrState();
            for (let i = 0; i < rowCount; i++) {
              stateBefore[i] = api.cloneSgrState(state);
              html[i] = api.lineToHtml(raw[i], state, palette);
              stateAfter[i] = api.cloneSgrState(state);
            }
            (globalThis as Record<string, any>).__retainedModel = {
              raw, archived, live, links, html, stateBefore, stateAfter,
            };
          } else {
            const stride = 300;
            const checkpoints = new Map<number, unknown>();
            const html = new Map<number, string>();
            const stateBefore = new Map<number, unknown>();
            const state = api.createSgrState();
            const windowStart = rowCount - 132;
            for (let i = 0; i < rowCount; i++) {
              if (i % stride === 0) checkpoints.set(i, api.cloneSgrState(state));
              if (i >= windowStart) stateBefore.set(i, api.cloneSgrState(state));
              const rendered = api.lineToHtml(raw[i], state, palette);
              if (i >= windowStart) html.set(i, rendered);
            }
            checkpoints.set(rowCount, api.cloneSgrState(state));
            (globalThis as Record<string, any>).__retainedModel = {
              raw, archived, live, links, checkpoints, html, stateBefore,
            };
          }

          const searchDurations: number[] = [];
          let searchMatches = 0;
          for (let run = 0; run < 9; run++) {
            const started = performance.now();
            const search = api.searchLines(raw, "ROW-99991-");
            searchDurations.push(performance.now() - started);
            searchMatches += search.matches.length;
          }
          return { searchDurations, searchMatches };
        }, mode);
        await collectGarbage();
        const used = await heapUsed();
        return { ...result, heapBytes: Math.max(0, used - baseline) };
      };

      const legacy = await measureShape("legacy");
      const sparse = await measureShape("sparse");
      const rebuild = await page.evaluate(() => {
        const api = (globalThis as Record<string, any>).__thumbmuxBench;
        const model = (globalThis as Record<string, any>).__retainedModel;
        const raw = model.raw as string[];
        const palette = {
          defaultFg: "#eeeeee",
          defaultBg: "#111111",
          base: [
            "#000000", "#aa0000", "#00aa00", "#aa5500",
            "#0000aa", "#aa00aa", "#00aaaa", "#aaaaaa",
            "#555555", "#ff5555", "#55ff55", "#ffff55",
            "#5555ff", "#ff55ff", "#55ffff", "#ffffff",
          ],
        };
        const result: Record<string, { median: number; p95: number; max: number }> = {};
        for (const stride of [128, 256, 300, 512]) {
          const checkpoints = new Map<number, unknown>();
          const checkpointState = api.createSgrState();
          for (let i = 0; i < raw.length; i++) {
            if (i % stride === 0) checkpoints.set(i, api.cloneSgrState(checkpointState));
            api.lineToHtml(raw[i], checkpointState, palette);
          }

          const durations: number[] = [];
          for (let sample = 0; sample < 25; sample++) {
            const start = 1_000 + ((sample * 3_791) % (raw.length - 1_300));
            const checkpoint = Math.floor(start / stride) * stride;
            const state = api.cloneSgrState(checkpoints.get(checkpoint));
            const started = performance.now();
            let checksum = 0;
            for (let i = checkpoint; i < Math.min(raw.length, start + 132); i++) {
              const html = api.lineToHtml(raw[i], state, palette);
              if (i >= start) checksum += html.length;
            }
            if (checksum <= 0) throw new Error("cold render produced no HTML");
            durations.push(performance.now() - started);
          }
          durations.sort((a, b) => a - b);
          result[String(stride)] = {
            median: durations[Math.floor(durations.length / 2)]!,
            p95: durations[Math.ceil(durations.length * 0.95) - 1]!,
            max: durations.at(-1)!,
          };
        }
        return result;
      });

      const legacySearchP95 = percentile(legacy.searchDurations.slice(1), 0.95);
      const sparseSearchP95 = percentile(sparse.searchDurations.slice(1), 0.95);
      const selectedRebuild = rebuild["300"]!;
      const candidateP95 = [128, 256, 300, 512]
        .map((stride) => `${stride}:${rebuild[String(stride)]!.p95.toFixed(2)}`)
        .join(",");
      console.log(
        `[W1-S4 benchmark] heap ${heapMiB(legacy.heapBytes).toFixed(2)} MiB -> ` +
        `${heapMiB(sparse.heapBytes).toFixed(2)} MiB; ` +
        `stride300 rebuild median/p95/max ${selectedRebuild.median.toFixed(2)}/` +
        `${selectedRebuild.p95.toFixed(2)}/${selectedRebuild.max.toFixed(2)} ms; ` +
        `candidate p95 ms ${candidateP95}; ` +
        `search p95 ${legacySearchP95.toFixed(2)} -> ${sparseSearchP95.toFixed(2)} ms`,
      );

      expect(legacy.searchMatches).toBeGreaterThan(0);
      expect(sparse.searchMatches).toBe(legacy.searchMatches);
      expect(sparse.heapBytes).toBeLessThan(legacy.heapBytes * 0.5);
      expect(selectedRebuild.p95).toBeLessThan(12);
      expect(selectedRebuild.max).toBeLessThan(25);
      expect(sparseSearchP95).toBeLessThanOrEqual(legacySearchP95 * 1.5 + 5);
    } finally {
      await browser.close();
    }
  }, 120_000);
});
