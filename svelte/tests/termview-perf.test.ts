/**
 * Regression coverage for the TermView compositor-scroll hot path.
 *
 * A scroll gesture must consume the height cached by ResizeObserver. Reading
 * clientHeight from applyScroll() forces layout on every animation frame.
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

function drainAnimationFrames(limit = 500): void {
  let batches = 0;
  while (frameCallbacks.size > 0 && batches < limit) {
    const callbacks = [...frameCallbacks.values()];
    frameCallbacks.clear();
    frameNow += 16;
    for (const callback of callbacks) callback(frameNow);
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

function mountTermView(): Mounted {
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
