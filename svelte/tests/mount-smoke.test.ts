/**
 * Mount smoke tests — real Svelte 5 component mount in a DOM.
 *
 * Why this exists: prior "component tests" only `readFile()`'d `.svelte` sources
 * and asserted on the text. A component that throws `effect_update_depth_exceeded`
 * on mount still passed every unit test. These tests actually `mount()` the
 * Svelte 5 components under happy-dom and assert they render without throwing
 * and without self-invalidating $effect loops.
 *
 * Command (from packages/thumbmux — same suite command as the rest of svelte):
 *   bun test ./svelte/tests/*.test.ts
 *
 * Infrastructure (packages/thumbmux/bunfig.toml + this file):
 *   - `[test].preload = ./svelte/tests/preload.ts` — registers the Svelte
 *     compile plugin before parallel test imports; happy-dom only when argv
 *     path is the svelte suite (core/server keep Bun Headers/Request)
 *   - `./svelte-client.ts` — mount/unmount/flushSync from Svelte's client entry
 *     (Bun's default condition serves the server stub which has no mount)
 *
 * Covered components (v0.4.0 surface + TermView):
 *   RecordingPlayer, NotificationPermission, TermSearch, TermView
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { Component } from "svelte";
import { flushSync, mount, unmount, tick } from "./svelte-client";

import RecordingPlayer from "../src/RecordingPlayer.svelte";
import NotificationPermission from "../src/NotificationPermission.svelte";
import TermSearch from "../src/TermSearch.svelte";
import TermView from "../src/TermView.svelte";
import type { AnsiPalette } from "@thumbmux/core";

type Mounted = { app: Record<string, unknown>; target: HTMLElement };

const mounted: Mounted[] = [];

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

/**
 * Strings Svelte emits (console.error or thrown Error) when an $effect both
 * reads and writes the same $state. In Svelte 5.56 the depth-exceeded Error is
 * often handed to the mount boundary rather than escaping mount() — so a green
 * mount() return is not enough. We also fail on the DEV "updated at" traces.
 */
const SELF_INVALIDATING_MARKERS = [
  "effect_update_depth_exceeded",
  "Maximum update depth exceeded",
  "updated at",
] as const;

function stringifyConsoleArg(arg: unknown): string {
  if (arg instanceof Error) return `${arg.name}: ${arg.message}\n${arg.stack ?? ""}`;
  if (typeof arg === "string") return arg;
  try {
    return String(arg);
  } catch {
    return "[unprintable]";
  }
}

/**
 * Mount under flushSync while watching console.error + thrown errors for the
 * self-invalidating $effect class of bugs that previously shipped green.
 */
function mountSmoke<Props extends Record<string, unknown>>(
  Component: Component<Props>,
  props: Props,
): Mounted {
  const target = document.createElement("div");
  document.body.appendChild(target);

  const diagnostics: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    diagnostics.push(args.map(stringifyConsoleArg).join(" "));
    originalError.apply(console, args as Parameters<typeof console.error>);
  };

  let app: Record<string, unknown>;
  try {
    try {
      flushSync(() => {
        app = mount(Component, { target, props }) as Record<string, unknown>;
      });
    } catch (err) {
      const text = stringifyConsoleArg(err);
      if (SELF_INVALIDATING_MARKERS.some((m) => text.includes(m))) {
        throw new Error(
          `Component self-invalidating $effect on mount (effect_update_depth_exceeded class):\n${text}`,
        );
      }
      throw err;
    }

    const joined = diagnostics.join("\n");
    const hit = SELF_INVALIDATING_MARKERS.find((m) => joined.includes(m));
    if (hit) {
      throw new Error(
        `Component self-invalidating $effect on mount (detected via console diagnostic "${hit}"):\n${joined.slice(0, 1500)}`,
      );
    }
  } finally {
    console.error = originalError;
  }

  const entry = { app: app!, target };
  mounted.push(entry);
  return entry;
}

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
});

describe("mount smoke — v0.4.0 components actually render", () => {
  test("TermSearch mounts and exposes search UI", async () => {
    const { target } = mountSmoke(TermSearch, {
      query: "find-me",
      matchCount: 3,
      activeIndex: 1,
      onQueryChange: () => {},
      onNavigate: () => {},
      onClose: () => {},
    });
    await tick();

    const root = target.querySelector('[data-testid="term-search"]');
    expect(root).toBeTruthy();
    const match = target.querySelector('[data-testid="term-search-match"]');
    expect(match?.textContent ?? "").toContain("3 matches");
    const active = target.querySelector('[data-testid="term-search-active"]');
    expect(active?.textContent ?? "").toContain("2 of 3");
  });

  test("RecordingPlayer mounts with a minimal journal and shows controls", async () => {
    const journal = {
      durationMs: 1_000,
      startAt: 0,
      seek(_absoluteTime: number) {
        return { recordIndex: 0, lines: ["frame-zero"] };
      },
    };

    // Critical: mount must not self-invalidate (effect_update_depth_exceeded).
    // mountSmoke fails the test if Svelte emits "updated at" / depth-exceeded.
    const { target } = mountSmoke(RecordingPlayer, { journal, palette });
    await tick();

    const controls = target.querySelector('[data-testid="recording-controls"]');
    expect(controls).toBeTruthy();
    const timeline = target.querySelector('[data-testid="recording-timeline"]');
    expect(timeline).toBeTruthy();
    expect(
      target.querySelector('button[aria-label*="Play"]') || target.textContent,
    ).toBeTruthy();
  });

  test("NotificationPermission mounts with a stubbed environment", async () => {
    const { target } = mountSmoke(NotificationPermission, {
      environment: {
        isSecureContext: true,
        Notification: {
          permission: "default",
          requestPermission: async () => "granted" as const,
        },
      },
    });
    await tick();

    const root = target.querySelector('[data-testid="notification-permission"]');
    expect(root).toBeTruthy();
    const status = target.querySelector('[data-testid="notification-permission-status"]');
    expect(status?.textContent ?? "").toMatch(/permission/i);
    const enable = target.querySelector('[data-testid="notification-permission-enable"]');
    expect(enable).toBeTruthy();
  });

  test("TermView mounts and unmounts without throwing (no live WebSocket required)", async () => {
    // TermView's onMount calls tmuxMux.subscribe → open WebSocket. A real
    // happy-dom/Bun socket emits unhandled error events that abort the rest of
    // the suite. Stub a silent socket for this test only.
    const originalWebSocket = globalThis.WebSocket;
    class SilentWebSocket {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSING = 2;
      static readonly CLOSED = 3;
      readonly url: string;
      readyState = SilentWebSocket.CONNECTING;
      onopen: ((ev?: unknown) => void) | null = null;
      onclose: ((ev?: unknown) => void) | null = null;
      onerror: ((ev?: unknown) => void) | null = null;
      onmessage: ((ev?: unknown) => void) | null = null;
      constructor(url: string) {
        this.url = url;
        // Stay CONNECTING forever — no open, no error, no reconnect storm.
      }
      send(_data?: unknown): void {}
      close(): void {
        this.readyState = SilentWebSocket.CLOSED;
      }
      addEventListener(_type: string, _listener: unknown): void {}
      removeEventListener(_type: string, _listener: unknown): void {}
      dispatchEvent(_event: unknown): boolean {
        return false;
      }
    }
    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      writable: true,
      value: SilentWebSocket,
    });

    try {
      // claimGeometry=false: pure viewer, no resize side-effects.
      const { target, app } = mountSmoke(TermView, {
        session: "sh-mount-smoke",
        palette,
        claimGeometry: false,
      });
      await tick();

      // Host root is present; content may be empty until a frame arrives.
      expect(target.childNodes.length).toBeGreaterThan(0);
      expect(target.innerHTML.length).toBeGreaterThan(0);

      // Explicit unmount before restoring WebSocket so reconnect timers stop.
      unmount(app);
      const idx = mounted.findIndex((m) => m.app === app);
      if (idx >= 0) mounted.splice(idx, 1);
      target.remove();
      await tick();
      await Promise.resolve();
    } finally {
      Object.defineProperty(globalThis, "WebSocket", {
        configurable: true,
        writable: true,
        value: originalWebSocket,
      });
    }
  });
});
