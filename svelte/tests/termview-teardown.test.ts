import { expect, test } from "bun:test";
import type { AnsiPalette } from "@thumbmux/core";
import type { Component } from "svelte";
import { flushSync, mount, tick, unmount } from "./svelte-client";

import TermView from "../src/TermView.svelte";
import { tmuxMux } from "../src/ws-mux.svelte";

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

function restoreProperty(
  target: object,
  key: string,
  descriptor: PropertyDescriptor | undefined,
): void {
  if (descriptor) Object.defineProperty(target, key, descriptor);
  else Reflect.deleteProperty(target, key);
}

test("TermView cancels every queued animation frame when it is unmounted", async () => {
  const originalRequestFrame = Object.getOwnPropertyDescriptor(
    globalThis,
    "requestAnimationFrame",
  );
  const originalCancelFrame = Object.getOwnPropertyDescriptor(
    globalThis,
    "cancelAnimationFrame",
  );
  const originalWindowRequestFrame = Object.getOwnPropertyDescriptor(
    window,
    "requestAnimationFrame",
  );
  const originalWindowCancelFrame = Object.getOwnPropertyDescriptor(
    window,
    "cancelAnimationFrame",
  );
  const originalSubscribe = Object.getOwnPropertyDescriptor(tmuxMux, "subscribe");
  const pending = new Map<number, FrameRequestCallback>();
  let nextFrame = 1;
  let app: Record<string, unknown> | undefined;
  const target = document.createElement("div");
  document.body.appendChild(target);

  const requestFrame = (callback: FrameRequestCallback): number => {
    const id = nextFrame++;
    pending.set(id, callback);
    return id;
  };
  const cancelFrame = (id: number): void => { pending.delete(id); };
  const requestDescriptor: PropertyDescriptor = {
    configurable: true,
    writable: true,
    value: requestFrame,
  };
  const cancelDescriptor: PropertyDescriptor = {
    configurable: true,
    writable: true,
    value: cancelFrame,
  };
  Object.defineProperty(globalThis, "requestAnimationFrame", requestDescriptor);
  Object.defineProperty(globalThis, "cancelAnimationFrame", cancelDescriptor);
  Object.defineProperty(window, "requestAnimationFrame", requestDescriptor);
  Object.defineProperty(window, "cancelAnimationFrame", cancelDescriptor);
  tmuxMux.subscribe = (() => () => {}) as typeof tmuxMux.subscribe;

  try {
    flushSync(() => {
      app = mount(TermView as Component, {
        target,
        props: {
          session: "teardown-session",
          palette,
          claimGeometry: false,
        },
      }) as Record<string, unknown>;
    });
    await tick();

    const outgoingFrames = new Set(pending.keys());
    expect(outgoingFrames.size).toBeGreaterThan(0);

    flushSync(() => unmount(app!));
    app = undefined;

    const framesAfterTeardown = [...outgoingFrames]
      .filter((id) => pending.has(id))
      .length;
    expect(framesAfterTeardown).toBe(0);
    expect(pending.size).toBe(0);
  } finally {
    if (app) {
      try {
        unmount(app);
      } catch {
        // already torn down
      }
    }
    target.remove();
    restoreProperty(tmuxMux, "subscribe", originalSubscribe);
    restoreProperty(window, "requestAnimationFrame", originalWindowRequestFrame);
    restoreProperty(window, "cancelAnimationFrame", originalWindowCancelFrame);
    restoreProperty(globalThis, "requestAnimationFrame", originalRequestFrame);
    restoreProperty(globalThis, "cancelAnimationFrame", originalCancelFrame);
  }
});
