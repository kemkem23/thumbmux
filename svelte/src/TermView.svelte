<script lang="ts">
  /**
   * MobileTermView — purpose-built scroll engine for the phone terminal.
   *
   * Why not xterm here: any scroll through xterm means parse→buffer→repaint
   * per step, which can never feel like native 120Hz. This view renders
   * captured lines (ANSI→HTML, parsed OFF the gesture) into a virtualized
   * DOM window and scrolls it with translate3d only — during a gesture the
   * compositor is the only thing working, so it runs at whatever Hz the
   * display has. Content updates while reading are anchored (no jumps) and
   * applied outside the gesture.
   *
   * Input still flows through tmuxMux (composer/D-pad/presets in the route);
   * this view also owns the tmux pane geometry (measured cols/rows → resize,
   * re-claimed when the app returns to foreground).
   */
  import { onMount, onDestroy } from 'svelte';
  import { tmuxMux } from './ws-mux.svelte';
  import {
    createSgrState, cloneSgrState, sgrStateKey, lineToHtml,
    type AnsiPalette, type SgrState, type LineLinkRange,
    collectTerminalUrlSegments,
    mergeCapturedLinesForStableScroll,
    prefixForCells, stripAnsi, paneTextForCopy,
  } from '@thumbmux/core';

  let {
    session,
    palette,
    fontPx = 13,
    minCols = 20,
    minRows = 15,
    bottomInsetPx = 0,
    onTap = undefined,
    onLinesChange = undefined,
    onGeometryChange = undefined,
    onScrollStateChange = undefined,
  }: {
    session: string;
    palette: AnsiPalette;
    fontPx?: number;
    minCols?: number;
    minRows?: number;
    /** Visual-only inset: the host shrank this many px (composer docked below).
     * Geometry math adds it back so the tmux pane is NEVER resized by a
     * transient overlay — only the scroll pin follows the shorter viewport. */
    bottomInsetPx?: number;
    /** Fired on a CLEAN tap (short, low-movement, not a link, no selection) —
     * call your composer's openDock() here, synchronously, so iOS raises the
     * keyboard (gesture call stack). */
    onTap?: () => void;
    onLinesChange?: (lines: string[]) => void;
    onGeometryChange?: (geometry: { cols: number; rows: number }) => void;
    onScrollStateChange?: (state: { bottomOffset: number; scrolledUp: boolean }) => void;
  } = $props();

  const LINE_RATIO = 1.6;
  const OVERSCAN_ROWS = 60;
  const RUBBER_PX = 90;
  const HISTORY_BATCH_LINES = 2000;
  const HISTORY_PREFETCH_ROWS = 8;
  const MOMENTUM_TAU = 520;
  const MOMENTUM_GAIN = 1.25;

  let viewportEl = $state<HTMLDivElement | null>(null);
  let cursor = $state<{ row: number; col: number } | null>(null);
  let charW = $state(0);
  let layerEl = $state<HTMLDivElement | null>(null);
  let viewH = $state(0);
  let lineH = $derived(Math.round(fontPx * LINE_RATIO));

  // --- content model ---
  let rawLines: string[] = [];
  let liveLines: string[] = [];
  let archivedLines: string[] = [];
  let htmlCache: string[] = [];          // rendered html per line
  let stateAfter: SgrState[] = [];        // sgr state after each line
  let total = $state(0);
  let connected = $state(false);
  let archiveBeforeLine: number | null = null;
  let archiveLoading = false;
  let archiveExhausted = false;
  let archiveRequestTimer: ReturnType<typeof setTimeout> | null = null;

  // --- scroll model: bottomOffsetPx 0 = pinned to live tail ---
  let bottomOffsetPx = $state(0);
  let winStart = $state(0);
  let winEnd = $state(0);
  let renderEpoch = $state(0); // bump to force window re-render

  let touching = false;
  let selectionActive = false; // native text selection in progress — scroll yields
  let momentumFrame: number | null = null;
  let springFrame: number | null = null;
  let touchY = 0;
  let touchVel = 0;
  let touchAt = 0;
  let pendingDragPx = 0;
  let dragFrame: number | null = null;
  let pendingContent: string | null = null;

  /** Copy the whole buffer (ANSI stripped, grid padding trimmed) to the
   * clipboard. Falls back to a hidden-textarea execCommand copy for
   * non-secure origins (plain http on a LAN), where navigator.clipboard
   * does not exist. Returns success. */
  export async function copyAll(): Promise<boolean> {
    return copyText(paneTextForCopy(rawLines));
  }

  /** Copy the current native text selection (or nothing → false). */
  export async function copySelection(): Promise<boolean> {
    const sel = typeof window !== 'undefined' ? window.getSelection?.() : null;
    const text = sel && !sel.isCollapsed ? sel.toString() : '';
    if (!text) return false;
    return copyText(text);
  }

  async function copyText(text: string): Promise<boolean> {
    if (!text) return false;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch { /* fall through to the legacy path */ }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch { return false; }
  }

  export function isScrolledUp(): boolean {
    return bottomOffsetPx > lineH;
  }

  export function scrollToBottom() {
    stopInertia();
    bottomOffsetPx = 0;
    applyScroll();
    flushPendingContent();
    emitScrollState();
  }

  function maxOffset(): number {
    return Math.max(0, total * lineH - Math.max(1, viewH));
  }

  function busy(): boolean {
    return touching || momentumFrame !== null || springFrame !== null;
  }

  function stopInertia() {
    if (momentumFrame !== null) { cancelAnimationFrame(momentumFrame); momentumFrame = null; }
    if (springFrame !== null) { cancelAnimationFrame(springFrame); springFrame = null; }
  }

  // --- ANSI render bookkeeping (incremental, off the scroll path) ---
  let linksByLine: (LineLinkRange[] | undefined)[] = [];

  /** URL detection — mid-line URLs and URLs that wrap across lines (segments
   * reconstructed at the pane width) all become tappable <a> ranges. */
  function rebuildLinks() {
    linksByLine = new Array(rawLines.length);
    const cols = lastPushedCols > 0 ? lastPushedCols : 60;
    try {
      for (const match of collectTerminalUrlSegments(rawLines, 0, rawLines.length, cols)) {
        for (const seg of match.segments) {
          (linksByLine[seg.lineIdx] ??= []).push({ start: seg.startCol, end: seg.endCol, href: match.url });
        }
      }
    } catch { /* never break rendering over a link parse */ }
  }

  function rebuildFrom(idx: number) {
    let st: SgrState = idx > 0 ? cloneSgrState(stateAfter[idx - 1]) : createSgrState();
    for (let i = idx; i < rawLines.length; i++) {
      htmlCache[i] = lineToHtml(rawLines[i], st, palette, linksByLine[i]);
      stateAfter[i] = cloneSgrState(st);
    }
    htmlCache.length = rawLines.length;
    stateAfter.length = rawLines.length;
  }

  function commitLines(next: string[], opts: { prependedLineCount?: number } = {}) {
    // Find common prefix so unchanged history isn't re-parsed.
    let common = 0;
    const minLen = Math.min(rawLines.length, next.length);
    while (common < minLen && rawLines[common] === next[common]) common++;

    // Anchor: when reading history, keep the same content under the finger.
    if (opts.prependedLineCount && bottomOffsetPx > 0) {
      bottomOffsetPx += opts.prependedLineCount * lineH;
    } else if (bottomOffsetPx > 0) {
      const grewBy = next.length - rawLines.length;
      if (grewBy !== 0 && common >= minLen - 2) {
        // Pure append/trim at the tail — shift the offset to compensate.
        bottomOffsetPx = Math.max(0, bottomOffsetPx + grewBy * lineH);
      }
    }

    rawLines = next;
    total = next.length;
    rebuildLinks();
    rebuildFrom(common);
    bottomOffsetPx = Math.min(bottomOffsetPx, maxOffset());
    renderEpoch++;
    applyScroll();
    onLinesChange?.(rawLines);
    emitScrollState();
  }

  function setLines(nextLive: string[]) {
    if (bottomOffsetPx > 0 && liveLines.length > 0) {
      const merged = mergeCapturedLinesForStableScroll(liveLines, nextLive);
      liveLines = merged.lines;
      if (merged.appendedLineCount > 0) archiveExhausted = false;
    } else {
      liveLines = nextLive;
    }
    commitLines([...archivedLines, ...liveLines]);
  }

  function requestOlderHistory() {
    if (archiveLoading || archiveExhausted) return;
    archiveLoading = true;
    tmuxMux.requestHistory(session, archiveBeforeLine, HISTORY_BATCH_LINES);
    if (archiveRequestTimer) clearTimeout(archiveRequestTimer);
    archiveRequestTimer = setTimeout(() => {
      archiveLoading = false;
      archiveRequestTimer = null;
    }, 5000);
  }

  function maybeRequestOlderHistory() {
    if (archiveLoading || archiveExhausted || total === 0) return;
    const threshold = Math.max(lineH * HISTORY_PREFETCH_ROWS, viewH * 0.18);
    if (bottomOffsetPx >= maxOffset() - threshold) requestOlderHistory();
  }

  function applyArchivedHistory(data: string) {
    if (archiveRequestTimer) {
      clearTimeout(archiveRequestTimer);
      archiveRequestTimer = null;
    }
    archiveLoading = false;

    let payload: {
      lines?: string[];
      startLine?: number;
      hasMore?: boolean;
    } | null = null;
    try {
      payload = JSON.parse(data);
    } catch {
      return;
    }

    const lines = Array.isArray(payload?.lines) ? payload.lines : [];
    archiveBeforeLine = typeof payload?.startLine === 'number' ? payload.startLine : archiveBeforeLine;
    archiveExhausted = !payload?.hasMore || lines.length === 0;
    if (lines.length === 0) return;

    archivedLines = [...lines, ...archivedLines];
    commitLines([...archivedLines, ...liveLines], { prependedLineCount: lines.length });
  }

  function flushPendingContent() {
    if (busy()) return;
    if (pendingContent !== null) {
      const c = pendingContent;
      pendingContent = null;
      setLines(c.replace(/\r/g, '').split('\n'));
    }
  }

  // --- virtual window + transform (the 120Hz hot path) ---
  function applyScroll() {
    // Re-read the live visible height — Safari's dvh/URL-bar dance must never
    // leave the model taller than reality (= bottom rows below the fold).
    if (viewportEl) {
      const vh = viewportEl.clientHeight;
      if (vh > 0 && vh !== viewH) viewH = vh;
    }
    const mo = maxOffset();
    // Viewport growth (composer dock closing, URL-bar dance) can drop
    // maxOffset below the model offset while the pane is idle — nothing else
    // re-clamps until a touch, leaving a stuck rubber-band overshoot. Only
    // outside gestures: mid-rubber-band the overshoot is legitimate.
    if (!busy() && bottomOffsetPx > mo) bottomOffsetPx = mo;
    const clamped = Math.max(-RUBBER_PX, Math.min(bottomOffsetPx, mo + RUBBER_PX));
    const scrollTop = mo - Math.max(0, Math.min(clamped, mo));
    const overshoot = clamped < 0 ? clamped : clamped > mo ? clamped - mo : 0;

    const endIdx = Math.min(total, Math.ceil((scrollTop + viewH) / lineH) + 1);
    const startIdx = Math.max(0, Math.floor(scrollTop / lineH) - 1);

    // Extend the rendered window only when the view leaves it — a DOM patch,
    // never during a frame that's purely momentum inside the window.
    if (startIdx < winStart || endIdx > winEnd) {
      winStart = Math.max(0, startIdx - OVERSCAN_ROWS);
      winEnd = Math.min(total, endIdx + OVERSCAN_ROWS);
      renderEpoch++;
    }

    if (layerEl) {
      const y = winStart * lineH - scrollTop - (overshoot * 0.35);
      layerEl.style.transform = `translate3d(0, ${y.toFixed(2)}px, 0)`;
    }
    emitScrollState();
  }

  function scrollBy(dyPx: number) {
    bottomOffsetPx += dyPx;
    applyScroll();
    if (dyPx > 0) maybeRequestOlderHistory();
  }

  function emitScrollState() {
    onScrollStateChange?.({
      bottomOffset: Math.round(bottomOffsetPx),
      scrolledUp: bottomOffsetPx > lineH,
    });
  }

  function wheelPixels(e: WheelEvent): number {
    if (e.deltaMode === WheelEvent.DOM_DELTA_LINE) return e.deltaY * lineH;
    if (e.deltaMode === WheelEvent.DOM_DELTA_PAGE) return e.deltaY * Math.max(viewH, lineH);
    return e.deltaY;
  }

  function onWheel(e: WheelEvent) {
    e.preventDefault();
    e.stopPropagation();
    const delta = -wheelPixels(e);
    bottomOffsetPx = Math.max(0, Math.min(bottomOffsetPx + delta, maxOffset()));
    applyScroll();
    if (delta > 0) maybeRequestOlderHistory();
  }

  function updateSelectionActive() {
    const sel = typeof window !== 'undefined' ? window.getSelection() : null;
    selectionActive = !!(
      sel && !sel.isCollapsed && sel.anchorNode && viewportEl?.contains(sel.anchorNode)
    );
  }

  // --- gesture physics (px-true, no quantization, iOS decel curve) ---
  function onTouchStart(e: TouchEvent) {
    updateSelectionActive();
    if (selectionActive) return; // user is adjusting a selection — hands off
    stopInertia();
    touching = true;
    pendingDragPx = 0;
    tapStart = { x: e.touches[0].clientX, y: e.touches[0].clientY, t: performance.now() };
    touchY = e.touches[0].clientY;
    touchAt = performance.now();
    touchVel = 0;
  }

  function flushDrag() {
    dragFrame = null;
    const px = pendingDragPx;
    pendingDragPx = 0;
    if (px !== 0) scrollBy(px);
  }

  function onTouchMove(e: TouchEvent) {
    if (selectionActive || !touching) {
      updateSelectionActive();
      if (selectionActive) return; // let iOS drag the selection handles
    }
    e.preventDefault();
    const y = e.touches[0].clientY;
    const dy = y - touchY;
    touchY = y;
    const now = performance.now();
    const dt = Math.max(1, now - touchAt);
    touchAt = now;
    touchVel = 0.8 * touchVel + 0.2 * (dy / dt);
    pendingDragPx += dy;
    if (dragFrame === null) dragFrame = requestAnimationFrame(flushDrag);
  }

  function springBack() {
    const mo = maxOffset();
    const target = Math.max(0, Math.min(bottomOffsetPx, mo));
    const from = bottomOffsetPx;
    if (Math.abs(from - target) < 0.5) {
      bottomOffsetPx = target;
      applyScroll();
      flushPendingContent();
      return;
    }
    const t0 = performance.now();
    const D = 220;
    const step = () => {
      const k = Math.min(1, (performance.now() - t0) / D);
      bottomOffsetPx = target + (from - target) * (1 - k) * (1 - k);
      applyScroll();
      if (k >= 1) {
        springFrame = null;
        bottomOffsetPx = target;
        applyScroll();
        flushPendingContent();
      } else {
        springFrame = requestAnimationFrame(step);
      }
    };
    springFrame = requestAnimationFrame(step);
  }

  let tapStart: { x: number; y: number; t: number } | null = null;
  let lastTouchEndAt = 0;

  function cleanTapTarget(target: EventTarget | null): boolean {
    return !(target instanceof Element && target.closest('a'));
  }

  function maybeTap(e: TouchEvent | MouseEvent, x: number, y: number) {
    if (!onTap || !tapStart) return;
    const moved = Math.abs(x - tapStart.x) + Math.abs(y - tapStart.y);
    const dur = performance.now() - tapStart.t;
    const sel = window.getSelection?.();
    if (dur < 350 && moved < 10 && (!sel || sel.isCollapsed) && cleanTapTarget(e.target)) {
      onTap();
    }
  }

  function onTouchEnd(e?: TouchEvent) {
    lastTouchEndAt = performance.now();
    if (e && e.changedTouches?.[0] && tapStart) {
      maybeTap(e, e.changedTouches[0].clientX, e.changedTouches[0].clientY);
    }
    tapStart = null;
    if (selectionActive) {
      updateSelectionActive();
      touching = false;
      return; // no momentum after a selection gesture
    }
    touching = false;
    if (dragFrame !== null) { cancelAnimationFrame(dragFrame); flushDrag(); }
    const mo = maxOffset();
    if (bottomOffsetPx < 0 || bottomOffsetPx > mo) { springBack(); return; }
    let vel = touchVel;
    if (Math.abs(vel) < 0.04) { flushPendingContent(); return; }
    const TAU = MOMENTUM_TAU;
    vel *= MOMENTUM_GAIN;
    let lastT = performance.now();
    const step = () => {
      const now = performance.now();
      const dt = Math.min(64, Math.max(1, now - lastT));
      lastT = now;
      const decay = Math.exp(-dt / TAU);
      scrollBy(vel * TAU * (1 - decay));
      vel *= decay;
      const m = maxOffset();
      if (bottomOffsetPx < 0 || bottomOffsetPx > m) {
        momentumFrame = null;
        springBack();
        return;
      }
      if (Math.abs(vel) < 0.015) {
        momentumFrame = null;
        flushPendingContent();
        return;
      }
      momentumFrame = requestAnimationFrame(step);
    };
    momentumFrame = requestAnimationFrame(step);
  }

  // --- tmux pane ownership (measured, exact) ---
  let lastPushedCols = $state(0);
  let lastPushedRows = $state(0);
  let connectedGeometryPushed = false;

  let measureCtx: CanvasRenderingContext2D | null = null;

  function measureFontSpec(): string {
    // Measure the font the DOM actually renders — hardcoding a family drifts
    // the col math when that font isn't installed (issue #1).
    const fam = (viewportEl && getComputedStyle(viewportEl).fontFamily) || "'JetBrains Mono', monospace";
    return `${fontPx}px ${fam}`;
  }

  function measureCharWidth(): number {
    if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
    if (!measureCtx) return fontPx * 0.6;
    measureCtx.font = measureFontSpec();
    return measureCtx.measureText('MMMMMMMMMM').width / 10;
  }

  // Pixel-accurate caret column: measure the ACTUAL text left of the cursor
  // with the live font instead of multiplying col × charW — Thai combining
  // vowels (0 cells), CJK (2 cells) and emoji make cell arithmetic drift
  // from the DOM's real glyph advances. Memoized: scroll re-renders hit the
  // cache (the key ignores winStart), only content/cursor changes re-measure.
  let cursorPosCache = { key: '', left: 0, width: 0 };
  function cursorPos(cline: number, col: number): { left: number; width: number } {
    const raw = rawLines[cline] ?? '';
    const key = `${col}|${fontPx}|${charW}|${raw}`;
    if (cursorPosCache.key === key) return cursorPosCache;
    if (!measureCtx) measureCharWidth();
    let left = col * charW;
    let width = charW;
    if (measureCtx) {
      const line = stripAnsi(raw);
      const { prefix, cells } = prefixForCells(line, col);
      measureCtx.font = measureFontSpec();
      const prefixPx = measureCtx.measureText(prefix).width;
      // cursor past the end of the text (blank cells) → pad with charW
      left = prefixPx + Math.max(0, col - cells) * charW;
      let nextChar: string | undefined;
      for (const c of line.slice(prefix.length)) { nextChar = c; break; }
      if (nextChar) width = measureCtx.measureText(prefix + nextChar).width - prefixPx;
    }
    cursorPosCache = { key, left, width };
    return cursorPosCache;
  }

  function pushGeometry(opts: { force?: boolean } = {}) {
    if (!viewportEl) return;
    const w = viewportEl.clientWidth;
    // Rows always derive from the FULL host height (inset added back): the
    // docked composer shrinks what's visible, not the pane the agent runs in.
    const h = viewportEl.clientHeight + Math.max(0, bottomInsetPx);
    if (w <= 0 || h <= 0) return;
    const cw = measureCharWidth();
    charW = cw;
    const cols = Math.max(minCols, Math.floor((w - 12) / cw));
    const rows = Math.max(minRows, Math.min(60, Math.floor(h / lineH)));
    if (!opts.force && cols === lastPushedCols && rows === lastPushedRows) return;
    lastPushedCols = cols;
    lastPushedRows = rows;
    tmuxMux.sendResize(session, cols, rows);
    onGeometryChange?.({ cols, rows });
  }

  /** Re-measure and re-claim geometry (e.g. after a host font-size change —
   * glyph resizes don't fire the ResizeObserver). */
  export function refreshGeometry() {
    lastPushedCols = 0;
    pushGeometry({ force: true });
    renderEpoch++;
    applyScroll();
  }

  let lastFontPx: number | null = null;
  $effect(() => {
    if (lastFontPx !== null && fontPx !== lastFontPx) refreshGeometry();
    lastFontPx = fontPx;
  });

  function onReturn() {
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
    lastPushedCols = 0; // force re-claim — desktop may have resized while hidden
    pushGeometry({ force: true });
  }

  let unsubscribe: (() => void) | null = null;
  let resizeObs: ResizeObserver | null = null;

  onMount(() => {
    viewH = viewportEl?.clientHeight ?? 0;
    unsubscribe = tmuxMux.subscribe(session, (data: string, type?: string, cur?: { row: number; col: number } | null) => {
      if (type === 'history') {
        applyArchivedHistory(data);
        return;
      }
      if (type === 'error') return;
      connected = true;
      if (type === 'cursor') {
        // caret-only update — content unchanged, nothing else to repaint
        if (cur !== undefined) cursor = cur;
        return;
      }
      if (cur !== undefined) cursor = cur;
      if (busy()) {
        pendingContent = data;
        return;
      }
      setLines(data.replace(/\r/g, '').split('\n'));
    });
    pushGeometry({ force: true });
    requestAnimationFrame(() => pushGeometry({ force: true }));
    resizeObs = new ResizeObserver(() => {
      viewH = viewportEl?.clientHeight ?? viewH;
      pushGeometry();
      applyScroll();
    });
    if (viewportEl) resizeObs.observe(viewportEl);
    window.addEventListener('pageshow', onReturn);
    document.addEventListener('visibilitychange', onReturn);
    document.addEventListener('selectionchange', updateSelectionActive);
  });

  onDestroy(() => {
    // Svelte 5 runs onDestroy during SSR too — guard all browser APIs.
    if (typeof window === 'undefined') return;
    stopInertia();
    if (dragFrame !== null) cancelAnimationFrame(dragFrame);
    if (archiveRequestTimer) {
      clearTimeout(archiveRequestTimer);
      archiveRequestTimer = null;
    }
    if (unsubscribe) unsubscribe();
    resizeObs?.disconnect();
    window.removeEventListener('pageshow', onReturn);
    document.removeEventListener('visibilitychange', onReturn);
    document.removeEventListener('selectionchange', updateSelectionActive);
  });

  // Re-render everything when the palette changes (theme/bg switch).
  let paletteKey = $derived(`${palette.defaultFg}|${palette.defaultBg}|${palette.base.join(',')}`);
  let lastPaletteKey = '';
  $effect(() => {
    if (paletteKey !== lastPaletteKey) {
      lastPaletteKey = paletteKey;
      if (rawLines.length) {
        rebuildFrom(0);
        renderEpoch++;
        applyScroll();
      }
    }
  });

  // applyScroll after the window re-renders (layerEl content changed).
  $effect(() => {
    renderEpoch;
    requestAnimationFrame(() => applyScroll());
  });

  $effect(() => {
    const connectedNow = tmuxMux.connected;
    if (!connectedNow) {
      connectedGeometryPushed = false;
      return;
    }
    if (connectedGeometryPushed) return;
    connectedGeometryPushed = true;
    requestAnimationFrame(() => pushGeometry({ force: true }));
  });
</script>

<!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
<div
  bind:this={viewportEl}
  class="mtv"
  data-testid="mtv"
  data-total={total}
  data-bottom-offset={Math.round(bottomOffsetPx)}
  data-last-cols={lastPushedCols}
  data-last-rows={lastPushedRows}
  style:font-size={`${fontPx}px`}
  style:line-height={`${lineH}px`}
  style:--mtv-lineh={`${lineH}px`}
  style:--tfg={palette.defaultFg}
  style:--tbg={palette.defaultBg}
  ontouchstart={onTouchStart}
  ontouchmove={onTouchMove}
  ontouchend={onTouchEnd}
  ontouchcancel={() => { tapStart = null; onTouchEnd(); }}
  onwheel={onWheel}
  onclick={(e) => {
    if (!onTap) return;
    if (performance.now() - lastTouchEndAt < 500) return; // synthesized click
    const sel = window.getSelection?.();
    if ((!sel || sel.isCollapsed) && cleanTapTarget(e.target)) onTap();
  }}
>
  <div bind:this={layerEl} class="mtv-layer">
    {#key renderEpoch}
      {#each { length: winEnd - winStart } as _, i (winStart + i)}
        <div class="mtv-line">{@html htmlCache[winStart + i] ?? ' '}</div>
      {/each}
    {/key}
    {#if cursor && connected && bottomOffsetPx <= lineH && charW > 0}
      {@const lastContent = (() => { let i = total; while (i > 0 && !(rawLines[i - 1] ?? '').trim()) i--; return i - 1; })()}
      {@const cline = lastContent - cursor.row}
      {#if cline >= winStart && cline < winEnd + (cursor.row < 0 ? -cursor.row : 0)}
        <!-- negative row = caret on a blank row BELOW the last content line;
             the overlay is pixel-positioned, so it renders fine past the last
             DOM row (a bottom-clipped caret just stays hidden, never wrong) -->
        {@const cpos = cursorPos(cline, cursor.col)}
        <div
          class="mtv-cursor"
          style:top={`${(cline - winStart) * lineH}px`}
          style:left={`${6 + cpos.left}px`}
          style:width={`${Math.max(2, cpos.width)}px`}
          style:height={`${lineH}px`}
          data-testid="mtv-cursor"
        ></div>
      {/if}
    {/if}
  </div>
  {#if !connected}
    <div class="mtv-wait" lang="th">กำลังเชื่อมต่อ…</div>
  {/if}
</div>

<style>
  .mtv {
    position: absolute; inset: 0;
    overflow: hidden;
    font-family: var(--font-mono);
    color: var(--tfg);
    background: var(--tbg);
    -webkit-user-select: text;
    user-select: text;
    /* pan/zoom stay ours; long-press text selection is not a touch-action
       gesture so iOS still initiates it on a held finger. */
    touch-action: none;
    -webkit-touch-callout: default;
  }
  .mtv-layer {
    position: absolute; left: 0; right: 0; top: 0;
    will-change: transform;
    padding: 0 6px;
  }
  .mtv-line {
    white-space: pre;
    overflow: hidden;
    letter-spacing: 0;
    /* Hard-clamp the row box: emoji / stacked-Thai glyph extents can push a
       line box past line-height, and a 1px-per-row drift across ~90 rendered
       rows shoved the tail ~90px below the fold. height beats glyph extents. */
    height: var(--mtv-lineh);
    line-height: var(--mtv-lineh);
  }
  /* Inline vertical padding does not move line boxes — it only extends the
     paintable/tappable area, lifting terminal links to a ~40px touch target
     without disturbing the grid (fleet finding: 20px anchors). */
  .mtv-line :global(a) { padding: 10px 0; margin: -10px 0; }

  .mtv-cursor {
    position: absolute;
    background: var(--tfg);
    opacity: .75;
    animation: mtv-blink 1.1s steps(1) infinite;
    pointer-events: none;
  }
  @keyframes mtv-blink { 50% { opacity: .12; } }
  .mtv-wait {
    position: absolute; inset: 0;
    display: flex; align-items: center; justify-content: center;
    font: 600 13px var(--font-thai);
    opacity: .6;
  }
</style>
