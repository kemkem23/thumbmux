/**
 * Regression coverage for the TermView compositor-scroll hot path.
 *
 * A scroll gesture must consume the height cached by ResizeObserver and keep
 * diagnostics off the compositor hot path. Per-frame layout reads, diagnostic
 * attributes, or host callbacks all move fling work back to the main thread.
 */
import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
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
  meta?: { source: "full" | "delta"; replace: boolean },
) => void;

type Mounted = { app: Record<string, unknown>; target: HTMLElement };
type ScrollState = { bottomOffset: number; scrolledUp: boolean };
type TermViewOverrides = {
  altScreenMouse?: boolean;
  bottomInsetPx?: number;
  onKeys?: (data: string) => void;
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
): Promise<Mounted & { viewport: HTMLElement }> {
  const mountedView = mountTermView(onScrollStateChange);
  const viewport = mountedView.target.querySelector('[data-testid="mtv"]') as HTMLElement | null;
  if (!viewport) throw new Error("TermView root not found");

  Object.defineProperty(viewport, "clientHeight", {
    configurable: true,
    get: () => 240,
  });

  const resizeObserver = ControlledResizeObserver.latest;
  if (!resizeObserver) throw new Error("TermView did not observe its viewport");
  resizeObserver.fire();
  deliverOutput(lineCount);
  await tick();
  drainAnimationFrames();
  flushSync();

  return { ...mountedView, viewport };
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

async function prepareAltScreenTermView(onKeys: (data: string) => void) {
  const mountedView = mountTermView(undefined, { altScreenMouse: true, onKeys });
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

function median(values: number[]): number {
  if (values.length === 0) throw new Error("cannot take the median of an empty sample");
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.floor(ordered.length / 2)]!;
}

/** Request, parse, and commit one history page under the controlled schedulers.
 * The history-prepend event is queued by commitStagedPrepend itself, so the
 * final idle batch before that event is the commit cost (not an ANSI slice). */
function prependHistoryPage(
  viewport: HTMLElement,
  lines: string[],
  initialUpperBound: number,
  beforeDeliver?: () => void,
): { commitNs: number; lineCount: number; startLine: number } {
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
  let batches = 0;
  try {
    while (!committed && batches < 100) {
      let progressed = false;
      if (idleCallbacks.size > 0) {
        const started = process.hrtime.bigint();
        runIdleCallbackBatch();
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
  drainScheduledWork();
  return { commitNs: lastIdleBatchNs, lineCount: committedLineCount, startLine };
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

describe("TermView alt-screen touch hit testing", () => {
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
});

describe("TermView retained history budgets", () => {
  test("page 150 commit stays within 3x page 10 after repeated prepends", async () => {
    const { viewport } = await prepareScrollableTermView(undefined, 240);
    const durations: number[] = [];

    for (let page = 1; page <= 152; page++) {
      const lines = Array.from(
        { length: 500 },
        (_, row) => `history-page-${page}-row-${row}`,
      );
      const committed = prependHistoryPage(
        viewport,
        lines,
        1_000_000,
      );
      if (committed.lineCount !== lines.length) {
        throw new Error(`page ${page} retained ${committed.lineCount}/${lines.length} rows`);
      }
      durations.push(committed.commitNs);
    }

    // Medians centred on the requested pages suppress GC/timer noise while
    // preserving the page-10 versus page-150 asymptotic comparison.
    const page10Ns = median(durations.slice(7, 12));
    const page150Ns = median(durations.slice(147, 152));
    expect(page150Ns / page10Ns).toBeLessThanOrEqual(3);
  }, 120_000);

  test("200 pages of 500 rows stay capped without evicting the mounted window", async () => {
    const { viewport } = await prepareScrollableTermView(undefined, 240);
    let finalWindow = new Map<number, string>();
    let finalStartLine = -1;
    const cappedTotals: number[] = [];

    for (let page = 1; page <= 200; page++) {
      const lines = Array.from(
        { length: 500 },
        (_, row) => `retained-page-${page}-row-${row}`,
      );
      let mountedBefore = new Map<number, string>();
      const committed = prependHistoryPage(
        viewport,
        lines,
        2_000_000,
        page >= 20
          ? () => { mountedBefore = mountedLineContent(viewport); }
          : undefined,
      );
      if (committed.lineCount !== lines.length) {
        throw new Error(`page ${page} retained ${committed.lineCount}/${lines.length} rows`);
      }
      if (page >= 20) {
        expectMountedContentPreserved(mountedBefore, viewport);
        cappedTotals.push(Number(viewport.getAttribute("data-total")));
      }
      if (page === 200) {
        finalWindow = mountedBefore;
        finalStartLine = committed.startLine;
      }
    }

    expect(cappedTotals.length).toBeGreaterThan(0);
    expect(cappedTotals.every((rows) => rows === 10_000)).toBe(true);
    expect(finalWindow.size).toBeGreaterThan(60);

    // The retained page remains reachable at the top, and the next request
    // advances from its start instead of refetching/discarding the same page.
    wheelTowardHistory(viewport, -1_000_000);
    expect(Array.from(mountedLineContent(viewport).values()).some(
      (content) => content.startsWith("retained-page-200-row-"),
    )).toBe(true);
    expect(historyRequests.at(-1)?.beforeLine).toBe(finalStartLine);
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
