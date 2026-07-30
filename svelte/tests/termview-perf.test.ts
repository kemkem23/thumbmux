/**
 * Regression coverage for the TermView compositor-scroll hot path.
 *
 * A scroll gesture must consume the height cached by ResizeObserver and keep
 * diagnostics off the compositor hot path. Per-frame layout reads, diagnostic
 * attributes, or host callbacks all move fling work back to the main thread.
 */
import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import type { Component } from "svelte";
import { flushSync, mount, unmount, tick } from "./svelte-client";

import TermView from "../src/TermView.svelte";
import { tmuxMux } from "../src/ws-mux.svelte";
import type { AnsiPalette } from "@thumbmux/core";

type MuxCallback = (
  data: string,
  type?: string,
  cursor?: { row: number; col: number } | null,
  meta?: { source: "full" | "delta"; replace: boolean },
) => void;

type Mounted = { app: Record<string, unknown>; target: HTMLElement };
type ScrollState = { bottomOffset: number; scrolledUp: boolean };

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

let frameNow = 0;
let nextFrameId = 1;
let frameCallbacks = new Map<number, FrameRequestCallback>();

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

function mountTermView(onScrollStateChange?: (state: ScrollState) => void): Mounted {
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

  originalSubscribe = tmuxMux.subscribe;
  originalRequestHistory = tmuxMux.requestHistory;
  tmuxMux.subscribe = ((session: string, callback: MuxCallback) => {
    if (session === SESSION) sessionCallback = callback;
    return () => {
      if (sessionCallback === callback) sessionCallback = null;
    };
  }) as typeof tmuxMux.subscribe;
  tmuxMux.requestHistory = (() => {}) as typeof tmuxMux.requestHistory;

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
  frameCallbacks.clear();
  jest.restoreAllMocks();
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
