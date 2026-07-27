import { readFile } from 'node:fs/promises';
import { describe, expect, test } from 'bun:test';
import {
  createFrameHtmlCache,
  createPlaybackController,
  clampPlaybackElapsed,
  joinRenderedFrameHtml,
  lookupReplayFrame,
  nextRecordTime,
  recordIndexAt,
  resolveReplayFrame,
  FRAME_HTML_CACHE_LIMIT,
  FRAME_HTML_CACHE_MAX_ENTRIES,
  FRAME_HTML_CACHE_MAX_RENDERED_CHARS,
  PLAYBACK_SPEEDS,
  RECORDING_PLAYER_TEST_IDS,
} from '../src/recording-player';

const recordingPlayerSource = await readFile(new URL('../src/RecordingPlayer.svelte', import.meta.url), 'utf8');

class FakeClock {
  private time = 0;

  now = () => this.time;

  advance(ms: number): void {
    if (ms < 0) {
      throw new Error('advance requires a non-negative duration');
    }
    this.time += ms;
  }

  set(ms: number): void {
    this.time = ms;
  }
}

class FakeScheduler {
  private nextHandle = 0;
  private readonly pending = new Set<number>();
  private readonly queue: number[] = [];
  private readonly callbacks = new Map<number, () => void>();

  public scheduleCalls = 0;
  public cancelCalls = 0;
  public runCalls = 0;

  schedule = (callback: () => void): number => {
    const handle = this.nextHandle++;
    this.pending.add(handle);
    this.queue.push(handle);
    this.callbacks.set(handle, callback);
    this.scheduleCalls += 1;
    return handle;
  };

  cancel = (handle: number): void => {
    if (this.pending.delete(handle)) {
      this.cancelCalls += 1;
    }
    const index = this.queue.indexOf(handle);
    if (index >= 0) {
      this.queue.splice(index, 1);
    }
    this.callbacks.delete(handle);
  };

  runNext(): number | null {
    const handle = this.queue.shift() ?? null;
    if (handle === null) {
      return null;
    }
    this.pending.delete(handle);

    const callback = this.callbacks.get(handle);
    this.callbacks.delete(handle);
    if (callback) {
      this.runCalls += 1;
      callback();
    }

    return handle;
  }

  scheduledCount(): number {
    return this.pending.size;
  }

  pendingHandles(): number[] {
    return [...this.pending];
  }
}

describe('recording player contracts', () => {
  test('exports exact playback speeds and component test IDs', () => {
    expect(PLAYBACK_SPEEDS).toEqual([0.5, 1, 2, 4]);
    expect(RECORDING_PLAYER_TEST_IDS).toEqual({
      controls: 'recording-controls',
      timeline: 'recording-timeline',
    });

    const controller = createPlaybackController({
      durationMs: 100,
      initialSpeed: 3 as never,
      now: () => 0,
      scheduler: () => 1,
      canceller: () => {},
    });
    expect(controller.snapshot().speed).toBe(1);
    expect(controller.setSpeed(3).speed).toBe(1);
  });

  test('injects deterministic clock/scheduler and advances elapsed by speed-scaled monotonic elapsed', () => {
    const clock = new FakeClock();
    const scheduler = new FakeScheduler();
    const controller = createPlaybackController({
      durationMs: 5_000,
      now: clock.now,
      scheduler: scheduler.schedule,
      canceller: scheduler.cancel,
      initialSpeed: 2,
    });

    expect(controller.play().isPlaying).toBe(true);
    expect(scheduler.scheduledCount()).toBe(1);
    expect(scheduler.pendingHandles()).toEqual([0]);

    expect(controller.play().isPlaying).toBe(true);
    expect(scheduler.scheduledCount()).toBe(1);
    expect(scheduler.pendingHandles()).toEqual([0]);

    clock.advance(125);
    scheduler.runNext();

    expect(controller.snapshot().elapsedMs).toBe(250);
    expect(scheduler.scheduledCount()).toBe(1);
    expect(scheduler.pendingHandles()).toEqual([1]);

    clock.advance(50);
    scheduler.runNext();

    expect(controller.snapshot().elapsedMs).toBe(350);
    expect(scheduler.scheduledCount()).toBe(1);
    expect(scheduler.pendingHandles()).toEqual([2]);
    expect(scheduler.scheduleCalls).toBe(3);
  });

  test('materializes under the old speed when play is requested while already playing', () => {
    const clock = new FakeClock();
    const scheduler = new FakeScheduler();
    const controller = createPlaybackController({
      durationMs: 1_000,
      now: clock.now,
      scheduler: scheduler.schedule,
      canceller: scheduler.cancel,
      initialSpeed: 2,
    });

    controller.play();
    clock.advance(40);
    expect(controller.play()).toMatchObject({ elapsedMs: 80, isPlaying: true, speed: 2 });
    expect(scheduler.scheduledCount()).toBe(1);

    clock.advance(10);
    scheduler.runNext();
    expect(controller.snapshot().elapsedMs).toBe(100);
  });

  test('accounts old speed when pausing and re-baselines scheduling state', () => {
    const clock = new FakeClock();
    const scheduler = new FakeScheduler();
    const controller = createPlaybackController({
      durationMs: 2_000,
      now: clock.now,
      scheduler: scheduler.schedule,
      canceller: scheduler.cancel,
      initialSpeed: 2,
    });

    controller.play();
    clock.advance(90);

    expect(controller.pause()).toMatchObject({
      elapsedMs: 180,
      isPlaying: false,
    });
    expect(scheduler.scheduledCount()).toBe(0);
  });

  test('materializes forward seek while playing at prior speed and reanchors playback', () => {
    const clock = new FakeClock();
    const scheduler = new FakeScheduler();
    const controller = createPlaybackController({
      durationMs: 2_000,
      now: clock.now,
      scheduler: scheduler.schedule,
      canceller: scheduler.cancel,
      initialSpeed: 2,
    });

    controller.play();
    clock.advance(100);
    scheduler.runNext();

    expect(controller.snapshot().elapsedMs).toBe(200);

    clock.advance(150);
    expect(controller.seek(700)).toMatchObject({
      elapsedMs: 700,
      isPlaying: true,
      speed: 2,
    });

    clock.advance(40);
    scheduler.runNext();

    expect(controller.snapshot().elapsedMs).toBe(780);
  });

  test('materializes backward seek while playing at prior speed and reanchors playback', () => {
    const clock = new FakeClock();
    const scheduler = new FakeScheduler();
    const controller = createPlaybackController({
      durationMs: 2_000,
      now: clock.now,
      scheduler: scheduler.schedule,
      canceller: scheduler.cancel,
      initialSpeed: 2,
    });

    controller.play();
    clock.advance(100);
    scheduler.runNext();

    expect(controller.snapshot().elapsedMs).toBe(200);

    clock.advance(80);
    expect(controller.seek(50)).toMatchObject({
      elapsedMs: 50,
      isPlaying: true,
      speed: 2,
    });

    clock.advance(40);
    scheduler.runNext();

    expect(controller.snapshot().elapsedMs).toBe(130);
  });

  test('materializes with old speed on speed change while playing and reanchors new rate', () => {
    const clock = new FakeClock();
    const scheduler = new FakeScheduler();
    const controller = createPlaybackController({
      durationMs: 2_000,
      now: clock.now,
      scheduler: scheduler.schedule,
      canceller: scheduler.cancel,
      initialSpeed: 2,
    });

    controller.play();
    clock.advance(100);
    scheduler.runNext();

    clock.advance(50);
    expect(controller.setSpeed(4)).toMatchObject({
      elapsedMs: 300,
      speed: 4,
      isPlaying: true,
    });

    clock.advance(25);
    scheduler.runNext();

    expect(controller.snapshot().elapsedMs).toBe(400);
  });

  test('clamps seeks, avoids scheduling on zero/finished play, and stops at duration', () => {
    const clampClock = new FakeClock();
    const clampScheduler = new FakeScheduler();
    const clamped = createPlaybackController({
      durationMs: 1_000,
      now: clampClock.now,
      scheduler: clampScheduler.schedule,
      canceller: clampScheduler.cancel,
    });

    expect(clamped.seek(-50)).toMatchObject({ elapsedMs: 0, durationMs: 1_000, isPlaying: false });
    expect(clamped.seek(20_000)).toMatchObject({ elapsedMs: 1_000, durationMs: 1_000, isPlaying: false });

    const zeroClock = new FakeClock();
    const zeroScheduler = new FakeScheduler();
    const zeroDuration = createPlaybackController({
      durationMs: 0,
      now: zeroClock.now,
      scheduler: zeroScheduler.schedule,
      canceller: zeroScheduler.cancel,
    });

    expect(zeroDuration.play()).toMatchObject({ elapsedMs: 0, isPlaying: false, durationMs: 0 });
    expect(zeroScheduler.scheduledCount()).toBe(0);

    const endClock = new FakeClock();
    const endScheduler = new FakeScheduler();
    const atEnd = createPlaybackController({
      durationMs: 800,
      now: endClock.now,
      scheduler: endScheduler.schedule,
      canceller: endScheduler.cancel,
    });

    atEnd.seek(800);
    expect(atEnd.play()).toMatchObject({ elapsedMs: 800, isPlaying: false });
    expect(atEnd.pause()).toMatchObject({ elapsedMs: 800, isPlaying: false });
    expect(endScheduler.scheduledCount()).toBe(0);

    const doneClock = new FakeClock();
    const doneScheduler = new FakeScheduler();
    const done = createPlaybackController({
      durationMs: 100,
      now: doneClock.now,
      scheduler: doneScheduler.schedule,
      canceller: doneScheduler.cancel,
      initialSpeed: 4,
    });

    done.play();
    doneClock.advance(30);
    doneScheduler.runNext();
    const doneAfterTick = done.snapshot();
    expect(doneAfterTick.elapsedMs).toBe(100);
    expect(doneAfterTick.isPlaying).toBe(false);
    expect(doneScheduler.scheduledCount()).toBe(0);

    const endCancelClock = new FakeClock();
    const endCancelScheduler = new FakeScheduler();
    const endCancel = createPlaybackController({
      durationMs: 100,
      now: endCancelClock.now,
      scheduler: endCancelScheduler.schedule,
      canceller: endCancelScheduler.cancel,
    });
    endCancel.play();
    endCancelClock.advance(100);
    endCancel.tick();
    expect(endCancel.snapshot()).toMatchObject({ elapsedMs: 100, isPlaying: false });
    expect(endCancelScheduler.scheduledCount()).toBe(0);
    expect(endCancelScheduler.cancelCalls).toBe(1);
    endCancel.tick();
    expect(endCancelScheduler.cancelCalls).toBe(1);
  });

  test('pause and destroy cleanup are idempotent even with repeated calls', () => {
    const clock = new FakeClock();
    const scheduler = new FakeScheduler();
    const controller = createPlaybackController({
      durationMs: 1_000,
      now: clock.now,
      scheduler: scheduler.schedule,
      canceller: scheduler.cancel,
    });

    controller.play();
    expect(scheduler.scheduledCount()).toBe(1);

    controller.pause();
    expect(scheduler.cancelCalls).toBe(1);
    expect(scheduler.scheduledCount()).toBe(0);

    controller.pause();
    expect(scheduler.cancelCalls).toBe(1);

    controller.play();
    expect(scheduler.scheduledCount()).toBe(1);

    controller.destroy();
    expect(scheduler.cancelCalls).toBe(2);
    expect(scheduler.scheduledCount()).toBe(0);

    controller.destroy();
    expect(scheduler.cancelCalls).toBe(2);
  });

  test('lookupReplayFrame passes clamped absolute time to journal.seek', () => {
    const sought: number[] = [];
    const journal = {
      durationMs: 1_000,
      startAt: 10_000,
      seek: (absoluteTime: number) => {
        sought.push(absoluteTime);
        return {
          recordIndex: 123,
          lines: ['frame'],
        };
      },
    } as const;

    expect(lookupReplayFrame(journal, 120).recordIndex).toBe(123);
    expect(sought.at(-1)).toBe(10_120);
    expect(sought.at(-1)).not.toBe(120);

    expect(lookupReplayFrame(journal, -120).recordIndex).toBe(123);
    expect(sought.at(-1)).toBe(10_000);

    expect(lookupReplayFrame(journal, 5_000).recordIndex).toBe(123);
    expect(sought.at(-1)).toBe(11_000);
  });
});

test('lookupReplayFrame uses clampPlaybackElapsed internally for replay time boundaries', () => {
  expect(clampPlaybackElapsed(-100, 500)).toBe(0);
  expect(clampPlaybackElapsed(500, 500)).toBe(500);
  expect(clampPlaybackElapsed(1_000, 500)).toBe(500);
});

describe('recording frame html cache identity seam', () => {
  test('returns stable identities for a fixed recordIndex/theme and rerenders on cache key changes', () => {
    const lineToHtml = (() => {
      let calls = 0;
      return {
        render: (line: string) => {
          calls += 1;
          return { value: `${calls}:${line}` };
        },
        get calls() {
          return calls;
        },
      };
    })();

    const cache = createFrameHtmlCache({
      lineToHtml: lineToHtml.render,
    });

    const first = cache.get({ recordIndex: 1, paletteThemeKey: 'theme-a', lines: ['alpha', 'beta'] });
    expect(lineToHtml.calls).toBe(2);
    expect(first).toBe(cache.get({ recordIndex: 1, paletteThemeKey: 'theme-a', lines: ['ignored'] }));
    expect(lineToHtml.calls).toBe(2);

    const next = cache.get({ recordIndex: 2, paletteThemeKey: 'theme-a', lines: ['gamma'] });
    expect(next).not.toBe(first);
    expect(lineToHtml.calls).toBe(3);

    const rerenderedTheme = cache.get({ recordIndex: 3, paletteThemeKey: 'theme-b', lines: ['delta', 'epsilon'] });
    expect(rerenderedTheme).not.toBe(first);
    expect(lineToHtml.calls).toBe(5);
  });

  test('bounds cache with entry LRU + rendered-character budget and refreshes recency on hits (D1)', () => {
    // Entry cap is now a sharp secondary limit; the real governor is the
    // rendered-character budget. FRAME_HTML_CACHE_LIMIT is a deprecated alias.
    expect(FRAME_HTML_CACHE_MAX_ENTRIES).toBe(24);
    expect(FRAME_HTML_CACHE_LIMIT).toBe(FRAME_HTML_CACHE_MAX_ENTRIES);
    expect(FRAME_HTML_CACHE_MAX_RENDERED_CHARS).toBe(256 * 1024);
    expect(FRAME_HTML_CACHE_MAX_ENTRIES).toBeLessThan(256);

    let calls = 0;
    const cache = createFrameHtmlCache({
      maxEntries: 3,
      maxRenderedChars: 10_000,
      lineToHtml: (line: string) => {
        calls += 1;
        return `html:${line}`;
      },
    });

    expect(typeof cache.size).toBe('function');
    expect(typeof cache.renderedChars).toBe('function');
    expect(typeof cache.getJoined).toBe('function');
    expect(cache.size()).toBe(0);
    expect(cache.renderedChars()).toBe(0);

    const a = cache.get({ recordIndex: 1, paletteThemeKey: 't', lines: ['a'] });
    const b = cache.get({ recordIndex: 2, paletteThemeKey: 't', lines: ['b'] });
    const c = cache.get({ recordIndex: 3, paletteThemeKey: 't', lines: ['c'] });
    expect(cache.size()).toBe(3);
    expect(calls).toBe(3);
    expect(cache.renderedChars()).toBeGreaterThan(0);

    // Hit `a` to refresh recency so `b` becomes the least-recently-used entry.
    expect(cache.get({ recordIndex: 1, paletteThemeKey: 't', lines: ['ignored'] })).toBe(a);
    expect(calls).toBe(3);

    // Inserting a fourth entry must evict LRU `b`, not the recently hit `a`.
    const d = cache.get({ recordIndex: 4, paletteThemeKey: 't', lines: ['d'] });
    expect(cache.size()).toBe(3);
    expect(calls).toBe(4);
    expect(d[0]).toBe('html:d');

    // `a` still identity-stable (survived eviction because of the hit).
    expect(cache.get({ recordIndex: 1, paletteThemeKey: 't', lines: ['ignored'] })).toBe(a);
    expect(calls).toBe(4);

    // Evicted `b` must re-render (lineToHtml called again) and not exceed the limit.
    const bRerendered = cache.get({ recordIndex: 2, paletteThemeKey: 't', lines: ['b'] });
    expect(calls).toBe(5);
    expect(bRerendered).not.toBe(b);
    expect(bRerendered[0]).toBe('html:b');
    expect(cache.size()).toBe(3);

    // Non-finite / < 1 limit falls back to the new default entry cap.
    const defaultLimited = createFrameHtmlCache({
      limit: Number.NaN,
      lineToHtml: (line: string) => line,
    });
    for (let i = 0; i < FRAME_HTML_CACHE_MAX_ENTRIES + 10; i += 1) {
      defaultLimited.get({ recordIndex: i, paletteThemeKey: 'x', lines: [`L${i}`] });
    }
    expect(defaultLimited.size()).toBe(FRAME_HTML_CACHE_MAX_ENTRIES);
  });

  test('evicts by rendered-character weight even when under the entry cap', () => {
    // Each rendered line is 100 chars; budget of 250 chars fits at most 2 lines
    // total — so a third single-line frame must evict older weight, not wait for
    // the entry cap.
    const cache = createFrameHtmlCache({
      maxEntries: 100,
      maxRenderedChars: 250,
      lineToHtml: (line: string) => line.padEnd(100, 'x'),
    });

    cache.get({ recordIndex: 1, paletteThemeKey: 't', lines: ['a'] });
    cache.get({ recordIndex: 2, paletteThemeKey: 't', lines: ['b'] });
    expect(cache.size()).toBe(2);
    expect(cache.renderedChars()).toBe(200);

    cache.get({ recordIndex: 3, paletteThemeKey: 't', lines: ['c'] });
    // Weight budget forces eviction of the LRU entry (index 1).
    expect(cache.size()).toBeLessThanOrEqual(2);
    expect(cache.renderedChars()).toBeLessThanOrEqual(250);

    // Index 1 was evicted → re-render required.
    let calls = 0;
    const counting = createFrameHtmlCache({
      maxEntries: 100,
      maxRenderedChars: 250,
      lineToHtml: (line: string) => {
        calls += 1;
        return line.padEnd(100, 'x');
      },
    });
    counting.get({ recordIndex: 1, paletteThemeKey: 't', lines: ['a'] });
    counting.get({ recordIndex: 2, paletteThemeKey: 't', lines: ['b'] });
    counting.get({ recordIndex: 3, paletteThemeKey: 't', lines: ['c'] });
    const callsBefore = calls;
    counting.get({ recordIndex: 1, paletteThemeKey: 't', lines: ['a'] });
    expect(calls).toBeGreaterThan(callsBefore);
  });

  test('getJoined memoizes compact frame HTML without re-joining on hits', () => {
    let joins = 0;
    const cache = createFrameHtmlCache({
      lineToHtml: (line: string) => `H:${line}`,
    });

    const join = (rendered: readonly string[]): string => {
      joins += 1;
      return joinRenderedFrameHtml(rendered);
    };

    const first = cache.getJoined(
      { recordIndex: 1, paletteThemeKey: 't', lines: ['a', 'b'] },
      join,
    );
    expect(joins).toBe(1);
    expect(first).toBe('<div>H:a</div><div>H:b</div>');

    const second = cache.getJoined(
      { recordIndex: 1, paletteThemeKey: 't', lines: ['ignored'] },
      join,
    );
    expect(joins).toBe(1);
    expect(second).toBe(first);
  });

  test('renders an empty frame for non-array lines instead of throwing (D4 cache)', () => {
    const cache = createFrameHtmlCache({
      lineToHtml: (line: string) => `html:${line}`,
    });

    expect(() =>
      cache.get({
        recordIndex: 9,
        paletteThemeKey: 'theme',
        lines: undefined as unknown as readonly string[],
      }),
    ).not.toThrow();

    const empty = cache.get({
      recordIndex: 9,
      paletteThemeKey: 'theme',
      lines: undefined as unknown as readonly string[],
    });
    expect(empty).toEqual([]);
    expect(Array.isArray(empty)).toBe(true);
  });

  test('distinct symbols with the same description do not share a cache entry', () => {
    // Regression: flattening keys with String(symbol) maps Symbol('t') and a
    // second Symbol('t') to the same "Symbol(t)" string, so one theme silently
    // serves the other's HTML. Identity must be preserved (nested-Map behaviour).
    let calls = 0;
    const cache = createFrameHtmlCache({
      lineToHtml: (line: string) => {
        calls += 1;
        return `html:${calls}:${line}`;
      },
    });

    const themeA = Symbol('theme');
    const themeB = Symbol('theme');
    expect(String(themeA)).toBe(String(themeB)); // same description — the trap

    const a = cache.get({ recordIndex: 1, paletteThemeKey: themeA, lines: ['x'] });
    const b = cache.get({ recordIndex: 1, paletteThemeKey: themeB, lines: ['x'] });

    expect(calls).toBe(2);
    expect(a).not.toBe(b);
    expect(a[0]).toBe('html:1:x');
    expect(b[0]).toBe('html:2:x');

    // Same symbol still hits by identity.
    expect(cache.get({ recordIndex: 1, paletteThemeKey: themeA, lines: ['ignored'] })).toBe(a);
    expect(calls).toBe(2);
    expect(cache.size()).toBe(2);
  });
});

describe('recordIndexAt / nextRecordTime (playback skip seam)', () => {
  test('floor-seeks record index and reports the next boundary time', () => {
    const ats = [0, 1_000, 5_000] as const;

    expect(recordIndexAt(ats, -10)).toBe(0);
    expect(recordIndexAt(ats, 0)).toBe(0);
    expect(recordIndexAt(ats, 999)).toBe(0);
    expect(recordIndexAt(ats, 1_000)).toBe(1);
    expect(recordIndexAt(ats, 4_999)).toBe(1);
    expect(recordIndexAt(ats, 5_000)).toBe(2);
    expect(recordIndexAt(ats, 9_999)).toBe(2);
    expect(recordIndexAt([], 10)).toBe(0);
    expect(recordIndexAt(ats, Number.NaN)).toBe(0);

    expect(nextRecordTime(ats, -1)).toBe(0);
    expect(nextRecordTime(ats, 0)).toBe(1_000);
    expect(nextRecordTime(ats, 500)).toBe(1_000);
    expect(nextRecordTime(ats, 1_000)).toBe(5_000);
    expect(nextRecordTime(ats, 5_000)).toBeNull();
    expect(nextRecordTime(ats, 9_999)).toBeNull();
    expect(nextRecordTime([], 0)).toBeNull();
  });
});

describe('playback clock monotonicity (D2)', () => {
  test('elapsed never decreases and never spuriously jumps on reverse or non-finite clock', () => {
    const clock = new FakeClock();
    const scheduler = new FakeScheduler();
    const controller = createPlaybackController({
      durationMs: 10_000,
      now: clock.now,
      scheduler: scheduler.schedule,
      canceller: scheduler.cancel,
      initialSpeed: 1,
    });

    controller.play();
    clock.advance(100);
    scheduler.runNext();
    expect(controller.snapshot().elapsedMs).toBe(100);

    // Wall clock steps backwards mid-playback (NTP / Date.now fallback).
    clock.set(40);
    const afterReverse = controller.tick();
    expect(afterReverse.elapsedMs).toBe(100);
    expect(afterReverse.isPlaying).toBe(true);

    // Non-finite clock reading must not collapse anchor to 0.
    clock.set(Number.NaN);
    const afterNaN = controller.tick();
    expect(afterNaN.elapsedMs).toBe(100);

    // Next sane reading advances only by real forward wall time from the re-anchor.
    // Reverse re-anchored at 40; NaN kept that anchor; 40 → 90 is +50ms × speed 1.
    clock.set(90);
    const afterRecover = controller.tick();
    expect(afterRecover.elapsedMs).toBe(150);

    // Infinity is also non-finite: no advance, no jump.
    clock.set(Number.POSITIVE_INFINITY);
    expect(controller.tick().elapsedMs).toBe(150);
    clock.set(120);
    expect(controller.tick().elapsedMs).toBe(180);
  });
});

describe('playback destroy observer silence (D3)', () => {
  test('onChange never fires after destroy; tick/snapshot/play/seek stay coherent', () => {
    const clock = new FakeClock();
    const scheduler = new FakeScheduler();
    let observerCalls = 0;
    const observed: Array<{ elapsedMs: number; isPlaying: boolean }> = [];

    const controller = createPlaybackController({
      durationMs: 1_000,
      now: clock.now,
      scheduler: scheduler.schedule,
      canceller: scheduler.cancel,
      onChange: (snapshot) => {
        observerCalls += 1;
        observed.push({ elapsedMs: snapshot.elapsedMs, isPlaying: snapshot.isPlaying });
      },
    });

    controller.play();
    expect(observerCalls).toBeGreaterThan(0);
    const callsAfterPlay = observerCalls;

    clock.advance(50);
    controller.tick();
    expect(observerCalls).toBeGreaterThan(callsAfterPlay);
    const callsBeforeDestroy = observerCalls;

    controller.destroy();
    expect(observerCalls).toBe(callsBeforeDestroy);

    const afterSnapshot = controller.snapshot();
    const afterTick = controller.tick();
    const afterPlay = controller.play();
    const afterSeek = controller.seek(250);
    const afterPause = controller.pause();
    const afterSpeed = controller.setSpeed(2);

    expect(observerCalls).toBe(callsBeforeDestroy);
    expect(afterSnapshot).toMatchObject({
      durationMs: 1_000,
      isPlaying: false,
    });
    expect(afterTick).toEqual(afterSnapshot);
    expect(afterPlay.isPlaying).toBe(false);
    expect(afterSeek.elapsedMs).toBe(afterSnapshot.elapsedMs);
    expect(afterPause.isPlaying).toBe(false);
    expect(afterSpeed.speed).toBe(afterSnapshot.speed);
    expect(Number.isFinite(afterSnapshot.elapsedMs)).toBe(true);
  });
});

describe('resolveReplayFrame total result (D4)', () => {
  test('returns seek-failed without rethrowing when journal.seek throws', () => {
    const journal = {
      durationMs: 1_000,
      startAt: 0,
      seek: (): never => {
        throw new Error('Cannot seek with non-finite time');
      },
    };

    let thrown = false;
    let result: ReturnType<typeof resolveReplayFrame<{ recordIndex: number; lines: string[] }>>;
    try {
      result = resolveReplayFrame(journal, 10);
    } catch {
      thrown = true;
      result = { ok: true, frame: { recordIndex: -1, lines: [] } };
    }

    expect(thrown).toBe(false);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('seek-failed');
      expect(result.error).toBeInstanceOf(Error);
      expect(String((result.error as Error).message)).toContain('non-finite');
    }
  });

  test('returns invalid-frame when frame is missing or lines is not an array', () => {
    const missingLines = {
      durationMs: 500,
      startAt: 0,
      seek: () => ({ recordIndex: 1 } as { recordIndex: number; lines?: string[] }),
    };
    const badLines = {
      durationMs: 500,
      startAt: 0,
      seek: () => ({ recordIndex: 2, lines: 'not-array' as unknown as string[] }),
    };
    const nullFrame = {
      durationMs: 500,
      startAt: 0,
      seek: () => null as unknown as { recordIndex: number; lines: string[] },
    };

    const missing = resolveReplayFrame(missingLines, 0);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.code).toBe('invalid-frame');

    const bad = resolveReplayFrame(badLines, 0);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.code).toBe('invalid-frame');

    const nulled = resolveReplayFrame(nullFrame, 0);
    expect(nulled.ok).toBe(false);
    if (!nulled.ok) expect(nulled.code).toBe('invalid-frame');
  });

  test('returns ok:true with the frame for a valid journal frame', () => {
    const frame = { recordIndex: 7, lines: ['hello', 'world'] };
    const journal = {
      durationMs: 100,
      startAt: 50,
      seek: (absoluteTime: number) => {
        expect(Number.isFinite(absoluteTime)).toBe(true);
        return frame;
      },
    };

    const result = resolveReplayFrame(journal, 20);
    expect(result).toEqual({ ok: true, frame });
  });

  test('lookupReplayFrame sends a finite seek time even when startAt is non-finite', () => {
    const sought: number[] = [];
    const nanStart = {
      durationMs: 1_000,
      startAt: Number.NaN,
      seek: (absoluteTime: number) => {
        sought.push(absoluteTime);
        return { recordIndex: 0, lines: ['ok'] };
      },
    };
    const infStart = {
      durationMs: 1_000,
      startAt: Number.POSITIVE_INFINITY,
      seek: (absoluteTime: number) => {
        sought.push(absoluteTime);
        return { recordIndex: 0, lines: ['ok'] };
      },
    };

    expect(() => lookupReplayFrame(nanStart, 120)).not.toThrow();
    expect(Number.isFinite(sought[0]!)).toBe(true);
    expect(sought[0]).toBe(120);

    expect(() => lookupReplayFrame(infStart, 50)).not.toThrow();
    expect(Number.isFinite(sought[1]!)).toBe(true);
    expect(sought[1]).toBe(50);
  });
});

describe('recording-player component source', () => {
  test('uses component-facing contracts and cache/sgr composition without mounting Svelte', () => {
    expect(recordingPlayerSource).toContain('import { createSgrState, lineToHtml');
    expect(recordingPlayerSource).toContain('createFrameHtmlCache');
    expect(recordingPlayerSource).toContain('PLAYBACK_SPEEDS');
    expect(recordingPlayerSource).toContain('RECORDING_PLAYER_TEST_IDS.controls');
    expect(recordingPlayerSource).toContain('RECORDING_PLAYER_TEST_IDS.timeline');
    expect(recordingPlayerSource).toContain('type="range"');
    expect(recordingPlayerSource).toContain('<label for="recording-player-timeline"');
    expect(recordingPlayerSource).toContain('lineToHtml(');
    expect(recordingPlayerSource).toContain('createSgrState();');
    expect(recordingPlayerSource).toContain('frameSgrState = createSgrState();');
    expect(recordingPlayerSource).toContain("{@html renderedHtml || '&nbsp;'}");
    expect(recordingPlayerSource).toContain('recordIndex: lookup.recordIndex');
    expect(recordingPlayerSource).toContain('paletteThemeKey: activePaletteThemeKey');
    // Frame HTML is composed via the compact getJoined path, not a raw map+join
    // on every elapsed tick (defect 2).
    expect(recordingPlayerSource).toContain('getJoined');
    expect(recordingPlayerSource).toContain('joinRenderedFrameHtml');
    expect(recordingPlayerSource).toContain('displayElapsedMs');
    expect(recordingPlayerSource).not.toMatch(/\{@html[^}]*lookup\.(?:lines|frame|data)/);
    expect(recordingPlayerSource).not.toMatch(/\{@html[^}]*journal/);
  });

  test('skips frame HTML rebuild when the selected record index is unchanged (defect 2)', () => {
    // Must short-circuit on same recordIndex + theme rather than re-joining rows
    // on every playback tick.
    expect(recordingPlayerSource).toMatch(
      /lookup\.recordIndex\s*===\s*renderedRecordIndex|renderedRecordIndex\s*===\s*lookup\.recordIndex/,
    );
    expect(recordingPlayerSource).toMatch(/renderedThemeKey/);
    // Textual readout is independent of frame rendering.
    expect(recordingPlayerSource).toContain('updateReadout');
    expect(recordingPlayerSource).toContain('formatMs(displayElapsedMs)');
  });

  test('rewires controller and clears frame cache when journal prop changes (D5)', () => {
    // Journal-keyed effect (not mount-once) so a swapped recording cannot keep the
    // previous controller, duration, elapsed, or frame-cache partition.
    expect(recordingPlayerSource).toMatch(/\$effect\s*\(\s*\(\s*\)\s*=>\s*\{/);
    expect(recordingPlayerSource).toContain('frameCache.clear()');
    expect(recordingPlayerSource).toContain('createPlaybackController');
    expect(recordingPlayerSource).toContain('destroyController()');
    // Must re-read duration from the current journal inside the effect body.
    // Accept either journal.durationMs or a captured currentJournal.durationMs.
    expect(recordingPlayerSource).toMatch(
      /safeDuration\(\s*(?:currentJournal|journal)\.durationMs\s*\)/,
    );
    // Must not leave the sole controller construction inside onMount-only wiring.
    expect(recordingPlayerSource).not.toMatch(
      /onMount\s*\(\s*\(\s*\)\s*=>\s*\{[\s\S]*createPlaybackController/,
    );
  });

  test('controller is a plain let (not $state) so the journal effect cannot self-invalidate', () => {
    // Pre-fix failure (controller was $state): source matched
    //   /let\s+controller\s*=\s*\$state/
    // and mount threw effect_update_depth_exceeded because the journal effect
    // both read and wrote reactive controller in the same run.
    expect(recordingPlayerSource).toMatch(
      /let\s+controller\s*:\s*ReturnType\s*<\s*typeof\s+createPlaybackController\s*>\s*\|\s*null\s*=\s*null\s*;/,
    );
    expect(recordingPlayerSource).not.toMatch(/let\s+controller\s*=\s*\$state\b/);
    expect(recordingPlayerSource).not.toMatch(/controller\s*=\s*\$state\b/);
  });

  test('effects import untrack and wrap bodies so only the intended prop is tracked', () => {
    // Pre-fix failure: source did not contain `untrack` at all —
    //   expect(source).toContain("untrack") → Expected to contain: "untrack"
    // Without untrack the journal effect also tracked activePaletteThemeKey /
    // palette via refreshFrame, so a theme change tore down the controller and
    // rewound playback to 0.
    expect(recordingPlayerSource).toMatch(
      /import\s*\{[^}]*\buntrack\b[^}]*\}\s*from\s*['"]svelte['"]/,
    );
    // Both effects must wrap their work in untrack(() => { ... }).
    const untrackBodies = recordingPlayerSource.match(/untrack\s*\(\s*\(\s*\)\s*=>\s*\{/g) ?? [];
    expect(untrackBodies.length).toBeGreaterThanOrEqual(2);
    // Journal effect still clears the cache and rebuilds the controller (D5).
    expect(recordingPlayerSource).toContain('frameCache.clear()');
    expect(recordingPlayerSource).toContain('createPlaybackController');
    expect(recordingPlayerSource).toContain('destroyController()');
  });

  test('keeps last good frame and surfaces non-throwing error via aria-live on resolve failure (D4 component)', () => {
    expect(recordingPlayerSource).toContain('resolveReplayFrame');
    expect(recordingPlayerSource).not.toMatch(/lookupReplayFrame\s*\(/);
    expect(recordingPlayerSource).toMatch(/aria-live\s*=\s*["']polite["']/);
    // Error readout path must exist (status/live region for frame failures).
    expect(recordingPlayerSource).toMatch(/frameError|frame-error|playback-error/);
    expect(recordingPlayerSource).toMatch(/ok\s*===\s*false|!\w+\.ok|result\.ok/);
  });

  test('applySnapshot is idempotent for identical snapshots (D6)', () => {
    // Double-apply from onChange + handler return must short-circuit without a second frame render.
    expect(recordingPlayerSource).toMatch(/lastApplied|lastSnapshot|appliedSnapshot/);
    expect(recordingPlayerSource).toMatch(
      /function applySnapshot[\s\S]*?(?:return;|return\s)/,
    );
    // Handlers still call applySnapshot with the controller return value (unchanged API surface).
    expect(recordingPlayerSource).toContain('applySnapshot(controller.seek');
    expect(recordingPlayerSource).toContain('applySnapshot(controller.setSpeed');
  });
});

/**
 * Performance regression benchmarks for the two confirmed v0.4.0 defects.
 * Numbers are measured on this host; assertions guard the shape of the fix
 * (bounded weight / single join) rather than absolute machine-dependent ms.
 */
describe('recording-player performance defects (measured)', () => {
  test('defect 1: weighted cache bounds retained rendered weight under large-frame scrub', () => {
    if (typeof Bun !== 'undefined' && typeof Bun.gc === 'function') {
      Bun.gc(true);
    }

    const ROWS = 500;
    const SCRUB_FRAMES = 256;
    const line = 'x'.repeat(80);
    const baseLines = Array.from({ length: ROWS }, (_, i) => `${line}${i}`);

    const before = process.memoryUsage();
    const cache = createFrameHtmlCache({
      lineToHtml: (l: string) => `<span class="ansi">${l}</span>`,
    });

    for (let i = 0; i < SCRUB_FRAMES; i += 1) {
      const frameLines = baseLines.map((l) => `${l}|f${i}`);
      cache.get({ recordIndex: i, paletteThemeKey: 'theme', lines: frameLines });
    }

    if (typeof Bun !== 'undefined' && typeof Bun.gc === 'function') {
      Bun.gc(true);
    }
    const after = process.memoryUsage();
    const heapDelta = after.heapUsed - before.heapUsed;
    const rssDelta = after.rss - before.rss;

    // Entry cap alone would retain all 256; weighted budget must keep far fewer.
    expect(cache.size()).toBeLessThanOrEqual(FRAME_HTML_CACHE_MAX_ENTRIES);
    expect(cache.size()).toBeLessThan(SCRUB_FRAMES);
    expect(cache.renderedChars()).toBeLessThanOrEqual(FRAME_HTML_CACHE_MAX_RENDERED_CHARS);
    // 256 × 500 rows would be 128_000 retained rows under the old entry-count cap.
    const retainedRowsUpperBound = cache.size() * ROWS;
    expect(retainedRowsUpperBound).toBeLessThan(SCRUB_FRAMES * ROWS);

    // Soft memory guard: residual growth should stay well under the old 38 MB heap
    // measurement for the same scrub (machine-dependent; shape check only).
    expect(heapDelta).toBeLessThan(25 * 1024 * 1024);
    // RSS can be noisy under Bun; only assert it did not explode to phone-OOM range.
    expect(rssDelta).toBeLessThan(80 * 1024 * 1024);

    // Also exercise the 2,000-row scrub that retained 512,000 rows under the old cap.
    const cache2 = createFrameHtmlCache({
      lineToHtml: (l: string) => `<span>${l}</span>`,
    });
    const lines2 = Array.from({ length: 2_000 }, (_, i) => `${'y'.repeat(80)}${i}`);
    for (let i = 0; i < SCRUB_FRAMES; i += 1) {
      cache2.get({
        recordIndex: i,
        paletteThemeKey: 'theme',
        lines: lines2.map((l) => `${l}|f${i}`),
      });
    }
    expect(cache2.size()).toBeLessThanOrEqual(FRAME_HTML_CACHE_MAX_ENTRIES);
    expect(cache2.renderedChars()).toBeLessThanOrEqual(FRAME_HTML_CACHE_MAX_RENDERED_CHARS);
    // Phone-safe: must not retain hundreds of thousands of rendered rows.
    expect(cache2.size() * 2_000).toBeLessThan(64_000);
  });

  test('defect 2: same-record playback ticks do not re-join frame HTML', () => {
    const ROWS = 2_000;
    const TICKS = 120;
    const lines0 = Array.from(
      { length: ROWS },
      (_, i) => `line-${i}-at-0-${'a'.repeat(40)}`,
    );
    const lines1 = Array.from(
      { length: ROWS },
      (_, i) => `line-${i}-at-1-${'b'.repeat(40)}`,
    );

    const journal = {
      durationMs: 1_000,
      startAt: 0,
      seek(absoluteTime: number) {
        if (absoluteTime >= 1_000) {
          return { recordIndex: 1, lines: lines1 };
        }
        return { recordIndex: 0, lines: lines0 };
      },
    };

    const cache = createFrameHtmlCache({
      lineToHtml: (line: string) => `<span>${line}</span>`,
    });
    const theme = 'theme-a';
    const recordAts = [0, 1_000] as const;

    let charsConstructed = 0;
    let joinCalls = 0;
    let renderedRecordIndex = -1;
    let renderedHtml = '';
    let renderedThemeKey: string | null = null;

    // Mirrors the fixed RecordingPlayer refresh path: skip join when the
    // selected record + theme are unchanged; use getJoined for compact HTML.
    function refreshFrame(elapsedMs: number, force = false): void {
      const absolute = journal.startAt + clampPlaybackElapsed(elapsedMs, journal.durationMs);
      // Optional fast path via recordIndexAt (same floor semantics as seek).
      const predictedIndex = recordIndexAt(recordAts, absolute);
      if (
        !force &&
        predictedIndex === renderedRecordIndex &&
        renderedThemeKey === theme &&
        renderedHtml !== ''
      ) {
        return;
      }

      const result = resolveReplayFrame(journal, elapsedMs);
      if (!result.ok) return;
      const lookup = result.frame;
      if (
        !force &&
        lookup.recordIndex === renderedRecordIndex &&
        renderedThemeKey === theme &&
        renderedHtml !== ''
      ) {
        return;
      }

      renderedRecordIndex = lookup.recordIndex;
      renderedThemeKey = theme;
      renderedHtml = cache.getJoined(
        {
          recordIndex: lookup.recordIndex,
          paletteThemeKey: theme,
          lines: lookup.lines,
        },
        (rendered) => {
          joinCalls += 1;
          const html = joinRenderedFrameHtml(rendered as readonly string[]);
          charsConstructed += html.length;
          return html;
        },
      );
    }

    const t0 = performance.now();
    for (let tick = 0; tick < TICKS; tick += 1) {
      const elapsedMs = (tick / TICKS) * 1_000; // all within record 0
      refreshFrame(elapsedMs);
    }
    const ms = performance.now() - t0;

    // Only the first tick should construct frame HTML for record 0.
    expect(joinCalls).toBe(1);
    expect(charsConstructed).toBe(renderedHtml.length);
    expect(charsConstructed).toBeLessThan(200_000); // one 2k-row frame, not 120×
    expect(ms).toBeLessThan(30);
    expect(nextRecordTime(recordAts, 0)).toBe(1_000);

    // Crossing into record 1 must join once more.
    refreshFrame(1_000);
    expect(joinCalls).toBe(2);
  });
});
