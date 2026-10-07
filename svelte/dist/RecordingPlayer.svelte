<script lang="ts">
  import { untrack } from 'svelte';
  import { createSgrState, lineToHtml, type AnsiPalette } from '@thumbmux/core';
  import {
    PLAYBACK_SPEEDS,
    RECORDING_PLAYER_TEST_IDS,
    createFrameHtmlCache,
    createPlaybackController,
    joinRenderedFrameHtml,
    resolveReplayFrame,
    type ReplayJournalLike,
    type PlaybackSnapshot,
  } from './recording-player';

  type RecordedFrame = {
    recordIndex: number;
    lines: readonly string[];
  };

  let { journal, palette }: {
    journal: ReplayJournalLike<RecordedFrame>;
    palette: AnsiPalette;
  } = $props();

  const paletteThemeKey = (input: AnsiPalette): string =>
    `${input.defaultFg}\u0000${input.defaultBg}\u0000${input.base.join('\u0000')}`;

  const safeDuration = (value: number): number => {
    if (!Number.isFinite(value) || value <= 0) return 0;
    return value;
  };

  const formatMs = (value: number): string => `${Math.max(0, Math.floor(value))}ms`;

  // Plain let — never read from the template. Must NOT be $state: the journal
  // effect both reads and writes it, and a reactive controller self-invalidates
  // into effect_update_depth_exceeded on mount.
  let controller: ReturnType<typeof createPlaybackController> | null = null;
  /** Scrubber value — updates every playback tick (cheap number). */
  let elapsedMs = $state(0);
  /**
   * Textual timeline readout — throttled independently of frame rendering so a
   * 120 Hz rAF loop does not thrash the DOM text node every frame.
   */
  let displayElapsedMs = $state(0);
  let durationMs = $state(safeDuration(journal.durationMs));
  let speed = $state(1);
  let isPlaying = $state(false);
  let renderedHtml = $state('');
  let renderedRecordIndex = $state(-1);
  let frameError = $state<string | null>(null);
  let activePaletteThemeKey = $derived(paletteThemeKey(palette));

  let frameSgrState = createSgrState();
  const frameCache = createFrameHtmlCache<string>({
    lineToHtml: (line: string) => lineToHtml(line, frameSgrState, palette) || '&nbsp;',
  });

  /** Last snapshot applied to component state — used for idempotent applySnapshot. */
  let lastAppliedSnapshot: PlaybackSnapshot | null = null;
  /** When true, the next applySnapshot refreshes the frame even if snapshot fields match. */
  let forceFrameRefresh = false;
  /**
   * Theme key of the last frame actually rendered. Palette effect skips when
   * unchanged so mount does not double-render the first frame (D6).
   */
  let lastRenderedThemeKey: string | null = null;
  /** Theme key used for the HTML currently in `renderedHtml`. */
  let renderedThemeKey: string | null = null;
  /** Wall-clock of the last textual readout update (performance.now domain). */
  let lastReadoutWallMs = 0;
  /** Minimum interval between textual timeline readout updates while playing. */
  const READOUT_THROTTLE_MS = 100;

  function readoutNow(): number {
    if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
      return performance.now();
    }
    if (typeof Date !== 'undefined' && typeof Date.now === 'function') {
      return Date.now();
    }
    return 0;
  }

  /**
   * Update the human-readable timeline text independently of frame HTML.
   * Always flushes on pause/seek-to-end/force; throttles mid-playout.
   */
  function updateReadout(nextElapsed: number, playing: boolean, force: boolean): void {
    if (force || !playing) {
      displayElapsedMs = nextElapsed;
      lastReadoutWallMs = readoutNow();
      return;
    }
    const now = readoutNow();
    if (
      now - lastReadoutWallMs >= READOUT_THROTTLE_MS ||
      nextElapsed <= 0 ||
      nextElapsed >= durationMs
    ) {
      displayElapsedMs = nextElapsed;
      lastReadoutWallMs = now;
    }
  }

  function applySnapshot(snapshot: PlaybackSnapshot): void {
    const identical =
      lastAppliedSnapshot !== null &&
      lastAppliedSnapshot.elapsedMs === snapshot.elapsedMs &&
      lastAppliedSnapshot.durationMs === snapshot.durationMs &&
      lastAppliedSnapshot.speed === snapshot.speed &&
      lastAppliedSnapshot.isPlaying === snapshot.isPlaying;

    if (identical && !forceFrameRefresh) {
      return;
    }

    const prev = lastAppliedSnapshot;
    const elapsedChanged = prev === null || prev.elapsedMs !== snapshot.elapsedMs;
    const shouldForceFrame = forceFrameRefresh;
    forceFrameRefresh = false;

    // Timeline / transport state always tracks the snapshot (cheap).
    elapsedMs = snapshot.elapsedMs;
    durationMs = snapshot.durationMs;
    speed = snapshot.speed;
    isPlaying = snapshot.isPlaying;
    lastAppliedSnapshot = {
      elapsedMs: snapshot.elapsedMs,
      durationMs: snapshot.durationMs,
      speed: snapshot.speed,
      isPlaying: snapshot.isPlaying,
    };

    // Textual readout is independent of frame rendering (and throttled).
    updateReadout(snapshot.elapsedMs, snapshot.isPlaying, shouldForceFrame || !snapshot.isPlaying);

    // Frame HTML only when the selected record may have changed, or when a
    // palette/journal force is requested. refreshFrame itself no-ops when the
    // resolved recordIndex + theme match the currently painted frame.
    if (shouldForceFrame || elapsedChanged || prev === null) {
      refreshFrame(snapshot.elapsedMs, shouldForceFrame);
    }
  }

  function refreshFrame(nextElapsed: number, force = false): void {
    const result = resolveReplayFrame(journal, nextElapsed);
    if (!result.ok) {
      // Keep the last good rendered frame; surface a non-throwing error readout.
      frameError =
        result.code === 'seek-failed'
          ? 'Failed to seek recording frame'
          : 'Invalid recording frame';
      return;
    }

    frameError = null;
    const lookup = result.frame;

    // Same record + same palette → keep the painted HTML. A 120 Hz playback
    // loop over a sparse journal would otherwise re-join thousands of rows on
    // every tick even though the selected record never changed.
    if (
      !force &&
      lookup.recordIndex === renderedRecordIndex &&
      renderedThemeKey === activePaletteThemeKey &&
      renderedHtml !== ''
    ) {
      return;
    }

    renderedRecordIndex = lookup.recordIndex;
    renderedThemeKey = activePaletteThemeKey;
    frameSgrState = createSgrState();
    renderedHtml = frameCache.getJoined(
      {
        recordIndex: lookup.recordIndex,
        paletteThemeKey: activePaletteThemeKey,
        lines: lookup.lines,
      },
      joinRenderedFrameHtml,
    );
  }

  function clampTimeline(value: string): number {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return 0;
    return Math.max(0, Math.min(durationMs, parsed));
  }

  function destroyController(): void {
    const currentController = controller;
    if (!currentController) return;
    currentController.destroy();
    controller = null;
  }

  function togglePlayPause(): void {
    if (!controller) return;
    const next = isPlaying ? controller.pause() : controller.play();
    applySnapshot(next);
  }

  function seekTimeline(event: Event): void {
    if (!controller) {
      elapsedMs = clampTimeline((event.currentTarget as HTMLInputElement).value);
      displayElapsedMs = elapsedMs;
      refreshFrame(elapsedMs, true);
      return;
    }
    const elapsed = clampTimeline((event.currentTarget as HTMLInputElement).value);
    applySnapshot(controller.seek(elapsed));
  }

  function setPlaybackSpeed(nextSpeed: number): void {
    if (!controller) return;
    applySnapshot(controller.setSpeed(nextSpeed));
  }

  function createBrowserClock(): () => number {
    if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
      return () => performance.now();
    }
    if (typeof Date !== 'undefined' && typeof Date.now === 'function') {
      return () => Date.now();
    }
    return () => 0;
  }

  function createBrowserScheduler(): {
    schedule: (callback: () => void) => unknown;
    cancel: (handle: unknown) => void;
  } {
    const hasRaf =
      typeof requestAnimationFrame === 'function' && typeof cancelAnimationFrame === 'function';

    const schedule = (callback: () => void): unknown => {
      if (hasRaf) return requestAnimationFrame(callback);
      if (typeof setTimeout === 'function') return setTimeout(callback, 16);
      return undefined;
    };

    const cancel = (handle: unknown): void => {
      if (hasRaf && typeof handle === 'number') {
        cancelAnimationFrame(handle);
        return;
      }
      if (!hasRaf && typeof clearTimeout === 'function') {
        // ReturnType<typeof clearTimeout> is `void` — that cast was a type-only
        // lie (assertions are erased) so runtime still passed the real handle,
        // but strict check rejected it. Use the parameter type of clearTimeout.
        clearTimeout(handle as Parameters<typeof clearTimeout>[0]);
      }
    };

    return { schedule, cancel };
  }

  // Journal-keyed wiring: tear down the previous controller, clear the frame
  // cache, and rebuild from the new recording whenever `journal` changes.
  // Track ONLY the journal prop — everything else (controller, palette, cache)
  // is untracked so this effect cannot self-invalidate or rewind on theme change.
  $effect(() => {
    const currentJournal = journal;
    untrack(() => {
      const { schedule, cancel } = createBrowserScheduler();
      const now = createBrowserClock();

      destroyController();
      frameCache.clear();
      forceFrameRefresh = true;
      lastAppliedSnapshot = null;
      frameError = null;
      renderedHtml = '';
      renderedRecordIndex = -1;
      renderedThemeKey = null;
      elapsedMs = 0;
      displayElapsedMs = 0;
      lastReadoutWallMs = 0;
      durationMs = safeDuration(currentJournal.durationMs);
      speed = 1;
      isPlaying = false;

      controller = createPlaybackController({
        durationMs: durationMs,
        now,
        scheduler: schedule,
        canceller: cancel,
        onChange: applySnapshot,
        initialSpeed: 1,
      });
      applySnapshot(controller.snapshot());
      // First frame already rendered under the current theme — prevent the
      // palette effect from re-rendering the same frame on mount (D6).
      lastRenderedThemeKey = activePaletteThemeKey;
    });

    return () => {
      untrack(() => {
        destroyController();
      });
    };
  });

  // Palette change must force a frame re-render even when playback state is
  // unchanged — but must NOT rebuild the controller or rewind elapsed.
  // Track ONLY activePaletteThemeKey; skip when the key matches the last
  // rendered frame so mount does not double-paint.
  $effect(() => {
    const themeKey = activePaletteThemeKey;
    untrack(() => {
      if (themeKey === lastRenderedThemeKey) return;
      if (!controller) return;
      lastRenderedThemeKey = themeKey;
      forceFrameRefresh = true;
      applySnapshot(controller.snapshot());
    });
  });
</script>

<section class="recording-player">
  <div
    class="frame-canvas"
    style:background={palette.defaultBg}
    style:color={palette.defaultFg}
    data-record-index={renderedRecordIndex}
  >
    <div class="frame-lines" class:empty={!renderedHtml}>
      {@html renderedHtml || '&nbsp;'}
    </div>
  </div>

  {#if frameError}
    <p class="frame-error" role="status" aria-live="polite">{frameError}</p>
  {/if}

  <section
    class="controls"
    role="region"
    aria-label="Recording controls"
    data-testid={RECORDING_PLAYER_TEST_IDS.controls}
  >
    <p class="time-readout" aria-live="polite">
      {formatMs(displayElapsedMs)} / {formatMs(durationMs)}
    </p>

    <button type="button" onclick={togglePlayPause} aria-pressed={isPlaying} aria-label={isPlaying ? 'Pause recording playback' : 'Play recording playback'}>
      {isPlaying ? 'Pause' : 'Play'}
    </button>

    <fieldset class="speed-controls">
      <legend>Playback speed</legend>
      {#each PLAYBACK_SPEEDS as playbackSpeed}
        <button
          type="button"
          class:active={playbackSpeed === speed}
          onclick={() => setPlaybackSpeed(playbackSpeed)}
          aria-label={`Set playback speed to ${playbackSpeed}x`}
          aria-pressed={playbackSpeed === speed}
        >
          {playbackSpeed}×
        </button>
      {/each}
    </fieldset>

    <label for="recording-player-timeline">Recording timeline scrubber</label>
    <input
      id="recording-player-timeline"
      class="timeline"
      type="range"
      min="0"
      max={durationMs}
      value={elapsedMs}
      step="1"
      oninput={seekTimeline}
      data-testid={RECORDING_PLAYER_TEST_IDS.timeline}
      aria-label="Scrub through recording timeline"
      aria-describedby="recording-player-timeline-description"
    />
    <p id="recording-player-timeline-description">
      Drag or use arrow keys to scrub the recording timeline between 0 and end.
    </p>
  </section>
</section>

<style>
  .recording-player {
    display: grid;
    gap: 0.65rem;
    font-family: Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  }

  .frame-canvas {
    overflow: auto;
    border: 1px solid rgb(180, 180, 180);
    border-radius: 8px;
    min-height: 12rem;
    padding: 0.5rem;
    line-height: 1.15;
  }

  .frame-lines {
    font-family: ui-monospace, 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
    white-space: pre;
  }

  .frame-lines.empty {
    opacity: 0.5;
    color: currentColor;
  }

  .frame-error {
    margin: 0;
    color: #b00020;
    font-size: 0.85rem;
  }

  .controls {
    display: grid;
    gap: 0.65rem;
  }

  .time-readout {
    margin: 0;
  }

  .speed-controls {
    display: inline-flex;
    gap: 0.35rem;
    padding: 0.25rem 0.4rem;
    border: 1px solid #d0d0d0;
    border-radius: 8px;
  }

  .speed-controls button.active {
    font-weight: 700;
    background: #0b6cff;
    color: #fff;
  }

  .timeline {
    width: 100%;
  }
</style>
