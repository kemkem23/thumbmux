/**
 * FS2 — TermView reacts to a live `screen` prop (pane alt/mouse flags)
 * instead of being told only via the static `altScreenMouse` boolean.
 *
 * When `screen` is present it wins for pointer routing (mouseSgr) and for
 * scrollback (alt). When absent, `altScreenMouse` keeps today's behaviour.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
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
  meta?: {
    source: "full" | "delta";
    replace: boolean;
    screen?: ScreenMode | null;
  },
) => void;

type ScreenMode = { alt: boolean; mouseSgr: boolean; mouseAny: boolean };

type TermViewProps = {
  session: string;
  palette: AnsiPalette;
  claimGeometry: boolean;
  fontPx: number;
  altScreenMouse: boolean;
  screen: ScreenMode | null | undefined;
  onKeys?: (data: string) => void;
};

type Mounted = {
  app: Record<string, unknown>;
  target: HTMLElement;
  props: TermViewProps;
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

  fire(): void {
    this.callback([], this);
  }
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

const SESSION = "sh-termview-screen-mode";
const mounted: Mounted[] = [];

let sessionCallback: MuxCallback | null = null;
let historyCalls: Array<{ session: string; beforeLine?: number | null; limit?: number }> = [];
let originalSubscribe: typeof tmuxMux.subscribe;
let originalRequestHistory: typeof tmuxMux.requestHistory;
let originalResizeObserver: typeof ResizeObserver;
let originalWindowResizeObserver: typeof ResizeObserver;
let originalRequestAnimationFrame: typeof requestAnimationFrame;
let originalCancelAnimationFrame: typeof cancelAnimationFrame;

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
  flushSync();
  return callbacks.length;
}

function drainAnimationFrames(limit = 100): void {
  let batches = 0;
  while (frameCallbacks.size > 0 && batches < limit) {
    runAnimationFrameBatch();
    batches++;
  }
}

function mountTermView(overrides: Partial<TermViewProps> = {}): Mounted {
  const target = document.createElement("div");
  target.style.cssText = "position:relative;width:320px;height:420px;";
  document.body.appendChild(target);

  const props = proxy({
    session: SESSION,
    palette,
    claimGeometry: false,
    fontPx: 13,
    altScreenMouse: false,
    screen: null as ScreenMode | null | undefined,
    ...overrides,
  }) as TermViewProps;

  let app!: Record<string, unknown>;
  flushSync(() => {
    app = mount(TermView as Component, {
      target,
      props,
    }) as Record<string, unknown>;
  });

  const viewport = target.querySelector('[data-testid="mtv"]') as HTMLElement | null;
  if (!viewport) throw new Error("TermView root not found");

  Object.defineProperties(viewport, {
    clientWidth: { configurable: true, get: () => 168 },
    clientHeight: { configurable: true, get: () => 420 },
  });
  const rect = {
    x: 10,
    y: 20,
    left: 10,
    top: 20,
    right: 178,
    bottom: 440,
    width: 168,
    height: 420,
    toJSON: () => ({}),
  } as DOMRect;
  viewport.getBoundingClientRect = () => rect;

  const resizeObserver = ControlledResizeObserver.latest;
  if (!resizeObserver) throw new Error("TermView did not observe its viewport");
  resizeObserver.fire();
  flushSync();
  drainAnimationFrames();

  const entry = { app, target, props, viewport };
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

function wheelTowardHistory(viewport: HTMLElement, deltaY = -1_000_000): void {
  // clientX/Y must land inside the content hit rect (mocked at left:10,top:20).
  // A default (0,0) misses the area and the SGR path no-ops after preventDefault.
  viewport.dispatchEvent(
    new WheelEvent("wheel", {
      deltaY,
      deltaMode: WheelEvent.DOM_DELTA_PIXEL,
      clientX: 55,
      clientY: 225,
      bubbles: true,
      cancelable: true,
    }),
  );
  flushSync();
  drainAnimationFrames();
}

function pointerClick(viewport: HTMLElement): void {
  const pointer = {
    button: 0,
    isPrimary: true,
    pointerId: 11,
    clientX: 55,
    clientY: 225,
    bubbles: true,
  };
  viewport.dispatchEvent(new PointerEvent("pointerdown", pointer));
  viewport.dispatchEvent(new PointerEvent("pointerup", pointer));
  flushSync();
}

function settledBottomOffset(viewport: HTMLElement): number {
  const raw = viewport.getAttribute("data-bottom-offset");
  if (raw === null) throw new Error("data-bottom-offset missing");
  return Number(raw);
}

function totalRows(viewport: HTMLElement): number {
  const raw = viewport.getAttribute("data-total");
  if (raw === null) throw new Error("data-total missing");
  return Number(raw);
}

beforeEach(() => {
  historyCalls = [];
  sessionCallback = null;
  ControlledResizeObserver.latest = null;
  frameNow = 0;
  nextFrameId = 1;
  frameCallbacks = new Map();

  originalSubscribe = tmuxMux.subscribe;
  originalRequestHistory = tmuxMux.requestHistory;
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

  originalResizeObserver = globalThis.ResizeObserver;
  originalWindowResizeObserver = window.ResizeObserver;
  globalThis.ResizeObserver = ControlledResizeObserver;
  window.ResizeObserver = ControlledResizeObserver;

  originalRequestAnimationFrame = globalThis.requestAnimationFrame;
  originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame = requestControlledFrame;
  globalThis.cancelAnimationFrame = cancelControlledFrame;
  window.requestAnimationFrame = requestControlledFrame;
  window.cancelAnimationFrame = cancelControlledFrame;
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
  window.requestAnimationFrame = originalRequestAnimationFrame;
  window.cancelAnimationFrame = originalCancelAnimationFrame;
  frameCallbacks.clear();
});

describe("TermView screen prop — pointer routing", () => {
  test("screen.mouseSgr=true routes wheel/touch as SGR even when altScreenMouse is false", async () => {
    const sgr: string[] = [];
    const { viewport } = mountTermView({
      altScreenMouse: false,
      screen: { alt: false, mouseSgr: true, mouseAny: false },
      onKeys: (data) => sgr.push(data),
    });
    await tick();
    deliverOutput(40);
    await tick();
    flushSync();

    historyCalls = [];
    // Wheel must not local-scroll (SGR path takes over).
    wheelTowardHistory(viewport, -240);
    expect(historyCalls).toHaveLength(0);
    expect(settledBottomOffset(viewport)).toBe(0);

    // Touch-drag is the reliable happy-dom path for emitting SGR wheel bytes
    // (same corpus the alt-screen perf suite asserts).
    const asTouchList = (points: Array<{ clientX: number; clientY: number }>) => {
      const list = points.slice() as Array<{ clientX: number; clientY: number }> & {
        item(index: number): Touch | null;
      };
      list.item = (index: number) => (list[index] as Touch | undefined) ?? null;
      return list as unknown as TouchList;
    };
    const touchEvent = (
      type: "touchstart" | "touchmove" | "touchend",
      touches: Array<{ clientX: number; clientY: number }>,
      changed = touches,
    ) => {
      const event = new Event(type, { bubbles: true, cancelable: true }) as TouchEvent;
      Object.defineProperties(event, {
        touches: { value: asTouchList(touches) },
        targetTouches: { value: asTouchList(touches) },
        changedTouches: { value: asTouchList(changed) },
      });
      return event;
    };
    viewport.dispatchEvent(touchEvent("touchstart", [{ clientX: 55, clientY: 400 }]));
    viewport.dispatchEvent(touchEvent("touchmove", [{ clientX: 55, clientY: 300 }]));
    runAnimationFrameBatch();
    viewport.dispatchEvent(
      touchEvent("touchend", [], [{ clientX: 55, clientY: 300 }]),
    );
    expect(sgr.some((seq) => seq.includes("\x1b[<64;") || seq.includes("\x1b[<65;"))).toBe(true);
  });

  test("screen.mouseSgr=true forwards a clean click as SGR when altScreenMouse is false", async () => {
    const sgr: string[] = [];
    const { viewport } = mountTermView({
      altScreenMouse: false,
      screen: { alt: true, mouseSgr: true, mouseAny: false },
      onKeys: (data) => sgr.push(data),
    });
    await tick();
    pointerClick(viewport);
    expect(sgr.some((seq) => seq.includes("\x1b[<0;"))).toBe(true);
  });

  test("screen.mouseSgr=false keeps local scroll even when altScreenMouse is true", async () => {
    const sgr: string[] = [];
    const { viewport } = mountTermView({
      altScreenMouse: true,
      screen: { alt: false, mouseSgr: false, mouseAny: false },
      onKeys: (data) => sgr.push(data),
    });
    await tick();
    deliverOutput(120);
    await tick();
    flushSync();

    historyCalls = [];
    wheelTowardHistory(viewport);
    // Local scroll path: history may be requested; SGR must not fire.
    expect(sgr).toHaveLength(0);
    expect(historyCalls.length).toBeGreaterThan(0);
  });

  test("TM-26: a wire reporting mouseSgr must not take pointer input from a host with no onKeys", async () => {
    // The exact shape of a view-only preview: it passes no onKeys because it
    // never wanted input, and it got local scrolling. 0.10.0 let the wire flip
    // routing to SGR anyway, and every event reached sendSgr, which had nothing
    // to call — tap and scroll vanished from a surface that still rendered.
    // Our own mobile team-tree previews mount TermView exactly like this.
    const { viewport } = mountTermView({
      altScreenMouse: false,
      screen: { alt: false, mouseSgr: true, mouseAny: true },
    });
    await tick();
    deliverOutput(120);
    await tick();
    flushSync();

    historyCalls = [];
    wheelTowardHistory(viewport);
    // Local scroll survives: the wire cannot take input away from a host that
    // has nowhere to receive it.
    expect(historyCalls.length).toBeGreaterThan(0);
  });

  test("TM-26: an explicit altScreenMouse also needs a destination", async () => {
    const { viewport } = mountTermView({
      altScreenMouse: true,
      screen: null,
    });
    await tick();
    deliverOutput(120);
    await tick();
    flushSync();

    historyCalls = [];
    wheelTowardHistory(viewport);
    expect(historyCalls.length).toBeGreaterThan(0);
  });

  test("without screen, altScreenMouse=true still forwards click as SGR (frozen path)", async () => {
    const sgr: string[] = [];
    const { viewport } = mountTermView({
      altScreenMouse: true,
      screen: null,
      onKeys: (data) => sgr.push(data),
    });
    await tick();
    pointerClick(viewport);
    expect(sgr.some((seq) => seq.includes("\x1b[<0;"))).toBe(true);
  });

  test("without screen, altScreenMouse=false still local-scrolls (frozen path)", async () => {
    const sgr: string[] = [];
    const { viewport } = mountTermView({
      altScreenMouse: false,
      screen: null,
      onKeys: (data) => sgr.push(data),
    });
    await tick();
    deliverOutput(120);
    await tick();
    flushSync();

    historyCalls = [];
    wheelTowardHistory(viewport);
    expect(sgr).toHaveLength(0);
    expect(historyCalls.length).toBeGreaterThan(0);
  });
});

describe("TermView screen prop — alt scrollback", () => {
  test("screen.alt=true never requests history expansion", async () => {
    const { viewport } = mountTermView({
      altScreenMouse: false,
      screen: { alt: true, mouseSgr: false, mouseAny: false },
    });
    await tick();
    deliverOutput(120);
    await tick();
    flushSync();

    historyCalls = [];
    wheelTowardHistory(viewport);
    expect(historyCalls).toHaveLength(0);
  });

  test("screen.alt=true replaces a repaint instead of inventing scrollback from a coincidental seam", async () => {
    const { viewport } = mountTermView({
      altScreenMouse: false,
      screen: { alt: true, mouseSgr: false, mouseAny: false },
    });
    await tick();
    deliverOutput(120);
    await tick();
    flushSync();
    wheelTowardHistory(viewport);
    expect(settledBottomOffset(viewport)).toBeGreaterThan(0);

    if (!sessionCallback) throw new Error("subscribe was not invoked");
    const next = [
      ...Array.from({ length: 8 }, (_, row) => `line-${52 + row}`),
      ...Array.from({ length: 112 }, (_, row) => `alt-repaint-${row}`),
    ];
    sessionCallback(
      next.join("\n"),
      "output",
      null,
      {
        source: "full",
        replace: false,
        screen: { alt: true, mouseSgr: false, mouseAny: false },
      },
    );
    await tick();
    flushSync();
    drainAnimationFrames();

    expect(totalRows(viewport)).toBe(120);
    expect(viewport.textContent ?? "").not.toContain("line-0");
    expect(viewport.textContent ?? "").toContain("line-52");
  });

  test("screen.alt=true does not prepend a history reply that arrives while alt", async () => {
    const entry = mountTermView({
      screen: { alt: false, mouseSgr: false, mouseAny: false },
    });
    await tick();
    deliverOutput(80);
    await tick();
    flushSync();

    // Arm a real history request while still in normal scrollback mode.
    wheelTowardHistory(entry.viewport);
    expect(historyCalls.length).toBeGreaterThan(0);
    const mid = totalRows(entry.viewport);

    // Flip into alt before the reply lands — stale offset must clear, and the
    // late reply must not grow the buffer.
    flushSync(() => {
      entry.props.screen = { alt: true, mouseSgr: false, mouseAny: false };
    });
    await tick();
    flushSync();
    expect(settledBottomOffset(entry.viewport)).toBe(0);

    deliverHistory(
      Array.from({ length: 30 }, (_, i) => `older-${i}`),
      { startLine: 0, hasMore: false },
    );
    await tick();
    drainAnimationFrames();
    flushSync();

    expect(totalRows(entry.viewport)).toBe(mid);
  });

  test("flipping screen.alt resets a scrolled-up bottom offset", async () => {
    const entry = mountTermView({
      screen: { alt: false, mouseSgr: false, mouseAny: false },
    });
    await tick();
    deliverOutput(120);
    await tick();
    flushSync();

    wheelTowardHistory(entry.viewport);
    await tick();
    flushSync();
    expect(settledBottomOffset(entry.viewport)).toBeGreaterThan(0);

    flushSync(() => {
      entry.props.screen = { alt: true, mouseSgr: false, mouseAny: false };
    });
    await tick();
    flushSync();
    expect(settledBottomOffset(entry.viewport)).toBe(0);

    // Flip back the other way also resets.
    flushSync(() => {
      entry.props.screen = { alt: false, mouseSgr: false, mouseAny: false };
    });
    await tick();
    flushSync();
    expect(settledBottomOffset(entry.viewport)).toBe(0);
  });

  test("screen.alt=true renders the no-scrollback signpost (a11y note)", async () => {
    const { viewport, target } = mountTermView({
      screen: { alt: true, mouseSgr: false, mouseAny: false },
    });
    await tick();
    deliverOutput(40);
    await tick();
    flushSync();

    expect(viewport.getAttribute("data-no-scrollback")).toBe("1");
    const note = target.querySelector<HTMLElement>('[data-testid="mtv-no-scrollback"]');
    expect(note).not.toBeNull();
    expect(note?.getAttribute("role")).toBe("note");
    expect(note?.getAttribute("aria-label") ?? "").toMatch(/alternate screen/i);
    expect(note?.textContent ?? "").toMatch(/no scrollback/i);

    historyCalls = [];
    wheelTowardHistory(viewport);
    expect(historyCalls).toHaveLength(0);
  });

  test("omitted screen prop still requests history (unknown = normal)", async () => {
    // Hosts that never populate `screen` must keep loading older rows.
    // 34f7afe gated every expand on a sample and silently killed history.
    const { viewport } = mountTermView({ screen: undefined });
    await tick();
    deliverOutput(80);
    await tick();
    flushSync();

    expect(viewport.getAttribute("data-screen-mode-known")).toBeNull();
    historyCalls = [];
    wheelTowardHistory(viewport);
    expect(historyCalls.length).toBeGreaterThan(0);
  });

  test("history prepended while screen is unknown is dropped when first sample is alt", async () => {
    const { viewport } = mountTermView({ screen: undefined });
    await tick();
    deliverOutput(80);
    await tick();
    flushSync();

    historyCalls = [];
    wheelTowardHistory(viewport);
    expect(historyCalls.length).toBeGreaterThan(0);
    const liveOnly = totalRows(viewport);

    deliverHistory(
      Array.from({ length: 30 }, (_, i) => `stale-archive-${i}`),
      { startLine: 0, hasMore: false },
    );
    for (let i = 0; i < 40; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      drainAnimationFrames();
      await tick();
      if (totalRows(viewport) > liveOnly) break;
    }
    expect(totalRows(viewport)).toBeGreaterThan(liveOnly);

    // First screen sample is alt — drop the speculative prepend.
    if (!sessionCallback) throw new Error("subscribe was not invoked");
    sessionCallback(
      Array.from({ length: 40 }, (_, i) => `alt-pane-${i}`).join("\n"),
      "output",
      null,
      {
        source: "full",
        replace: true,
        screen: { alt: true, mouseSgr: false, mouseAny: false },
      },
    );
    await tick();
    flushSync();
    drainAnimationFrames();

    expect(viewport.getAttribute("data-no-scrollback")).toBe("1");
    expect(viewport.textContent ?? "").not.toMatch(/stale-archive-/);
    historyCalls = [];
    wheelTowardHistory(viewport);
    expect(historyCalls).toHaveLength(0);
  });
});

describe("TermView history-ceiling signpost (D4)", () => {
  test("retention budget stop surfaces a ceiling note, not a gap marker", async () => {
    const { viewport, target } = mountTermView({
      screen: { alt: false, mouseSgr: false, mouseAny: false },
    });
    await tick();
    // Fill the 10,000-row client budget in one capture.
    deliverOutput(10_000);
    await tick();
    flushSync();
    drainAnimationFrames();
    expect(totalRows(viewport)).toBe(10_000);

    historyCalls = [];
    // Scroll to the oldest retained rows so winStart === 0 and the note can show.
    wheelTowardHistory(viewport);
    await tick();
    flushSync();
    drainAnimationFrames();

    // Budget full → refuse further expand (no storm) and raise the ceiling flag.
    expect(historyCalls).toHaveLength(0);
    expect(viewport.getAttribute("data-history-stop")).toBe("ceiling");
    expect(viewport.getAttribute("data-history-ceiling")).toBe("1");

    const note = target.querySelector<HTMLElement>('[data-testid="mtv-history-ceiling"]');
    expect(note).not.toBeNull();
    expect(note?.getAttribute("role")).toBe("note");
    expect(note?.getAttribute("aria-label") ?? "").toMatch(/10,?000 rows|8 mebibytes/i);
    expect(note?.textContent ?? "").toMatch(/Older history not loaded/i);
    // Distinct vocabulary from the retention-gap gutter.
    expect(target.querySelectorAll(".mtv-gap-marker")).toHaveLength(0);
  }, 60_000);

  test("server hasMore=false is exhausted, not ceiling", async () => {
    const { viewport, target } = mountTermView({
      screen: { alt: false, mouseSgr: false, mouseAny: false },
    });
    await tick();
    deliverOutput(80);
    await tick();
    flushSync();

    historyCalls = [];
    wheelTowardHistory(viewport);
    expect(historyCalls.length).toBeGreaterThan(0);

    // Let wheel inertia settle so busy() is false and prepend work can run.
    for (let i = 0; i < 40; i += 1) {
      drainAnimationFrames();
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    deliverHistory(
      Array.from({ length: 20 }, (_, i) => `older-${i}`),
      { startLine: 0, hasMore: false },
    );
    for (let i = 0; i < 40; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      drainAnimationFrames();
      await tick();
      if (totalRows(viewport) > 80) break;
    }
    flushSync();

    expect(totalRows(viewport)).toBeGreaterThan(80);
    expect(viewport.getAttribute("data-history-stop")).toBe("exhausted");
    expect(viewport.getAttribute("data-history-ceiling")).toBeNull();
    expect(target.querySelector('[data-testid="mtv-history-ceiling"]')).toBeNull();
  });
});
