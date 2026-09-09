<script lang="ts">
  /**
   * Real-browser scene for the Bash HIDE flicker proof. happy-dom cannot
   * measure a laid-out row, so this mounts the shipping TermView in Chromium
   * and lets the page push pane frames through the same mux callback the
   * WebSocket transport uses.
   */
  import TermView from "../src/TermView.svelte";
  import { tmuxMux } from "../src/ws-mux.svelte";
  import type { AnsiPalette } from "@thumbmux/core";

  const palette: AnsiPalette = {
    defaultFg: "#e6e6e6",
    defaultBg: "#101014",
    base: [
      "#000000", "#aa0000", "#00aa00", "#aa5500",
      "#0000aa", "#aa00aa", "#00aaaa", "#aaaaaa",
      "#555555", "#ff5555", "#55ff55", "#ffff55",
      "#5555ff", "#ff55ff", "#55ffff", "#ffffff",
    ],
  };

  type MuxCallback = (
    data: string,
    type?: string,
    cursor?: { row: number; col: number } | null,
    meta?: unknown,
  ) => void;

  let callback: MuxCallback | null = null;
  const original = tmuxMux.subscribe;
  (tmuxMux as unknown as { subscribe: unknown }).subscribe = (
    _session: string,
    next: MuxCallback,
  ) => {
    callback = next;
    (window as unknown as { __termReady?: boolean }).__termReady = true;
    return () => {
      if (callback === next) callback = null;
      void original;
    };
  };

  (window as unknown as { __feed?: (lines: string[]) => void }).__feed = (lines) => {
    callback?.(lines.join("\n"), "output", null, {
      source: "full",
      replace: true,
      screen: { alt: false, mouseSgr: false, mouseAny: false },
      boundary: {
        generation: "g-flicker",
        liveStartLine: 0,
        walSequence: "0",
        walOffset: 0,
      },
    });
  };
</script>

<div class="stage">
  <TermView
    session="cc-flicker-browser"
    {palette}
    claimGeometry={false}
    fontPx={13}
    screen={{ alt: false, mouseSgr: false, mouseAny: false }}
    claudeBashMode="hide"
    historyPaging="sliding"
  />
</div>

<style>
  .stage { position: relative; width: 100%; height: 100%; }
</style>
