/**
 * A click in the first half-second of a page's life must still open the host's
 * composer.
 *
 * TermView drops a click that follows a touchend within 500ms, because mobile
 * browsers synthesize one and firing onTap twice for one finger is worse than
 * firing it never. The comparison is `performance.now() - lastTouchEndAt`, and
 * lastTouchEndAt started at 0 — but performance.now() counts from when the
 * document started, so on a page younger than 500ms the difference is smaller
 * than the threshold and every click is discarded as the echo of a touch that
 * never happened.
 *
 * A sentinel only works when it cannot be mistaken for a real reading. Zero is
 * a real reading on this clock.
 */
import { afterEach, describe, expect, jest, test } from "bun:test";
import type { Component } from "svelte";
import { flushSync, mount, unmount } from "./svelte-client";

import TermView from "../src/TermView.svelte";
import type { AnsiPalette } from "@thumbmux/core";

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

type Mounted = { app: Record<string, unknown>; target: HTMLElement };
const mounted: Mounted[] = [];

afterEach(() => {
  jest.restoreAllMocks();
  while (mounted.length > 0) {
    const entry = mounted.pop()!;
    try { unmount(entry.app); } catch { /* already torn down */ }
    entry.target.remove();
  }
});

function mountTermView(onTap: () => void): Mounted {
  const target = document.createElement("div");
  document.body.appendChild(target);
  let app!: Record<string, unknown>;
  flushSync(() => {
    app = mount(TermView as Component, {
      target,
      props: {
        session: "early-tap",
        palette,
        claimGeometry: false,
        fontPx: 13,
        onTap,
      },
    }) as Record<string, unknown>;
  });
  const entry = { app, target };
  mounted.push(entry);
  return entry;
}

function clickTerminal(target: HTMLElement): void {
  const surface = target.querySelector<HTMLElement>("[data-testid='mtv']");
  expect(surface, "TermView should render its surface").not.toBeNull();
  flushSync(() => {
    surface!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

describe("TermView tap on a freshly loaded page", () => {
  test("a click at 120ms into the document still reaches onTap", () => {
    // A page barely older than a blink: no touch has occurred, so nothing has
    // been synthesized and the click is the user's own.
    jest.spyOn(performance, "now").mockReturnValue(120);

    const taps: number[] = [];
    const entry = mountTermView(() => taps.push(1));
    clickTerminal(entry.target);

    expect(taps.length).toBe(1);
  });

  test("a click 200ms after a real touchend is still suppressed", () => {
    const nowSpy = jest.spyOn(performance, "now");
    nowSpy.mockReturnValue(10_000);

    const taps: number[] = [];
    const entry = mountTermView(() => taps.push(1));
    const surface = entry.target.querySelector<HTMLElement>("[data-testid='mtv']")!;

    // A finger lifts. The touch path is what reports the tap; the browser then
    // sends a synthesized click for the same finger, which must be ignored.
    flushSync(() => {
      surface.dispatchEvent(new Event("touchend", { bubbles: true, cancelable: true }));
    });
    const afterTouch = taps.length;
    nowSpy.mockReturnValue(10_200);
    clickTerminal(entry.target);

    // The guard's whole job: one finger must not become two taps.
    expect(taps.length).toBe(afterTouch);
  });
});
