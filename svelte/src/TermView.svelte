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
   * re-claimed when the app returns to foreground). With altScreenMouse on,
   * wheel and touch-drag input are forwarded as SGR mouse events here, so
   * hosts do not need a separate touch capture shim.
   */
  import { onMount, onDestroy } from 'svelte';
  import { tmuxMux } from './ws-mux.svelte';
  import {
    createContentUpdateGate, flushContentUpdate, receiveContentUpdate,
    type ContentUpdate,
  } from './content-update-gate';
  import {
    createSgrState, cloneSgrState, sgrStateKey, lineToHtml,
    type AnsiPalette, type SgrState, type LineLinkRange,
    collectTerminalUrlSegments,
    mergeCapturedLinesForStableScroll,
    prefixForCells, stripAnsi, paneTextForCopy,
    contentCellFromPoint, centerContentCell,
    sgrWheel, sgrClick, sgrSnapToBottom, DEFAULT_WHEEL_MAX_PER_CALL,
    wheelDeltaToLines, consumeWholeWheelLines,
  } from '@thumbmux/core';

  let {
    session,
    palette,
    fontPx = 13,
    minCols = 20,
    minRows = 15,
    bottomInsetPx = 0,
    claimGeometry = true,
    altScreenMouse = false,
    onKeys = undefined,
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
    claimGeometry?: boolean;
    /** Forward wheel, clean click, and touch-drag gestures as SGR mouse input
     * for alt-screen TUIs. */
    altScreenMouse?: boolean;
    onKeys?: (data: string) => void;
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
  const HISTORY_PARSE_CHUNK_LINES = 300;
  const HISTORY_LINK_SEAM_LINES = 12;
  const ARCHIVE_OFFSET_START = 1 << 26;
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
  let stateBefore: SgrState[] = [];      // sgr state before each line
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
  let archiveOffset = $state(ARCHIVE_OFFSET_START);
  let contentEpoch = $state(0);
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
  let altTouchY: number | null = null;
  let altTouchMoved = false;
  let contentUpdateGate = createContentUpdateGate();
  let pendingContentFlushFrame: number | null = null;
  let paletteRefreshPending = false;
  let renderRefreshPending = false;
  let prependParseFrame: number | null = null;
  let prependCommitFrame: number | null = null;
  let prependParseSeq = 0;

  type PrependLinkPlan = {
    batchLinks: (LineLinkRange[] | undefined)[];
    seamLinks: Map<number, LineLinkRange[]>;
  };

  type PrependStage = {
    seq: number;
    lines: string[];
    html: string[];
    entryStates: SgrState[];
    exitStates: SgrState[];
    endState: SgrState;
    linkPlan: PrependLinkPlan;
  };

  type HistoryPrependSnapshot = {
    transform: string;
    anchorText: string;
    rowCount: number;
  };

  type MuxDeliveryMeta = {
    source: 'full' | 'delta';
    replace: boolean;
  };

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

  function cachedLineHtml(idx: number, epoch: number): string {
    void epoch;
    return htmlCache[idx] ?? ' ';
  }

  export function scrollToBottom() {
    updateSelectionActive();
    if (selectionActive) return;
    stopInertia();
    bottomOffsetPx = 0;
    if (altScreenMouse) {
      const geom = currentGeometry();
      if (geom) {
        const composerRows = Math.max(0, Math.ceil(bottomInsetPx / Math.max(1, lineH)));
        const { cx, cy } = centerContentCell(geom, { composerRows });
        sendSgr(sgrSnapToBottom(cx, cy));
      }
    }
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
  function rebuildAllLinks() {
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

  function addLinkRange(target: (LineLinkRange[] | undefined)[], idx: number, range: LineLinkRange) {
    (target[idx] ??= []).push(range);
  }

  function addSeamLinkRange(target: Map<number, LineLinkRange[]>, idx: number, range: LineLinkRange) {
    const existing = target.get(idx);
    if (existing) existing.push(range);
    else target.set(idx, [range]);
  }

  function mergeLineLinks(
    primary: LineLinkRange[] | undefined,
    secondary: LineLinkRange[] | undefined,
  ): LineLinkRange[] | undefined {
    if (!primary?.length) return secondary?.length ? [...secondary] : undefined;
    if (!secondary?.length) return [...primary];
    const out = [...primary];
    for (const link of secondary) {
      if (!out.some((x) => x.start === link.start && x.end === link.end && x.href === link.href)) {
        out.push(link);
      }
    }
    return out;
  }

  function planPrependLinks(batch: string[]): PrependLinkPlan {
    const batchLinks: (LineLinkRange[] | undefined)[] = new Array(batch.length);
    const seamLinks = new Map<number, LineLinkRange[]>();
    if (batch.length === 0) return { batchLinks, seamLinks };

    const cols = lastPushedCols > 0 ? lastPushedCols : 60;
    const seam = rawLines.slice(0, HISTORY_LINK_SEAM_LINES);
    const windowLines = [...batch, ...seam];
    try {
      for (const match of collectTerminalUrlSegments(windowLines, 0, batch.length, cols)) {
        for (const seg of match.segments) {
          const range = { start: seg.startCol, end: seg.endCol, href: match.url };
          if (seg.lineIdx < batch.length) addLinkRange(batchLinks, seg.lineIdx, range);
          else addSeamLinkRange(seamLinks, seg.lineIdx - batch.length, range);
        }
      }
    } catch { /* never break rendering over a link parse */ }
    return { batchLinks, seamLinks };
  }

  function linksAfterPrepend(stage: PrependStage): (LineLinkRange[] | undefined)[] {
    const count = stage.lines.length;
    const next: (LineLinkRange[] | undefined)[] = new Array(rawLines.length + count);
    for (let i = 0; i < count; i++) next[i] = stage.linkPlan.batchLinks[i];
    for (let i = 0; i < linksByLine.length; i++) {
      const links = linksByLine[i];
      if (links?.length) next[i + count] = links;
    }
    for (const [existingOffset, links] of stage.linkPlan.seamLinks) {
      const idx = count + existingOffset;
      if (idx >= count && idx < next.length) next[idx] = mergeLineLinks(links, next[idx]);
    }
    return next;
  }

  function rebuildFrom(idx: number) {
    let st: SgrState = idx > 0 ? cloneSgrState(stateAfter[idx - 1]) : createSgrState();
    for (let i = idx; i < rawLines.length; i++) {
      stateBefore[i] = cloneSgrState(st);
      htmlCache[i] = lineToHtml(rawLines[i], st, palette, linksByLine[i]);
      stateAfter[i] = cloneSgrState(st);
    }
    htmlCache.length = rawLines.length;
    stateBefore.length = rawLines.length;
    stateAfter.length = rawLines.length;
  }

  function reconcileExistingFrom(idx: number, entryState: SgrState): number {
    let st = cloneSgrState(entryState);
    for (let i = idx; i < rawLines.length; i++) {
      const cachedEntry = stateBefore[i];
      if (cachedEntry && sgrStateKey(st) === sgrStateKey(cachedEntry)) return i;
      stateBefore[i] = cloneSgrState(st);
      htmlCache[i] = lineToHtml(rawLines[i], st, palette, linksByLine[i]);
      stateAfter[i] = cloneSgrState(st);
    }
    return rawLines.length;
  }

  function rerenderLineWithCachedEntry(idx: number) {
    if (idx < 0 || idx >= rawLines.length) return;
    const st = stateBefore[idx] ? cloneSgrState(stateBefore[idx]) : createSgrState();
    htmlCache[idx] = lineToHtml(rawLines[idx], st, palette, linksByLine[idx]);
  }

  function rerenderPrependSeam(stage: PrependStage) {
    const count = stage.lines.length;
    for (const existingOffset of stage.linkPlan.seamLinks.keys()) {
      rerenderLineWithCachedEntry(count + existingOffset);
    }
  }

  function commitLines(next: string[], opts: { preserveReaderAnchor?: boolean } = {}) {
    // Find common prefix so unchanged history isn't re-parsed.
    let common = 0;
    const minLen = Math.min(rawLines.length, next.length);
    while (common < minLen && rawLines[common] === next[common]) common++;

    const pureAppend = opts.preserveReaderAnchor
      && next.length >= rawLines.length
      && common === rawLines.length;
    if (bottomOffsetPx > 0 && pureAppend) {
      // A retained full prefix means the reader's mounted row still has the
      // same raw index. Compensate exactly for lines appended below it.
      bottomOffsetPx += (next.length - rawLines.length) * lineH;
    }

    rawLines = next;
    total = next.length;
    rebuildAllLinks();
    rebuildFrom(common);
    bottomOffsetPx = Math.min(bottomOffsetPx, maxOffset());
    contentEpoch++;
    applyScroll();
    onLinesChange?.(rawLines);
    emitScrollState();
  }

  function setLines(nextLive: string[], replace = false) {
    let preserveReaderAnchor = false;
    if (replace) {
      // Resize/resync captures reflow only the current live window. Archived
      // rows remain physical history at their original width.
      liveLines = nextLive;
    } else if (bottomOffsetPx > 0 && liveLines.length > 0) {
      const merged = mergeCapturedLinesForStableScroll(liveLines, nextLive);
      liveLines = merged.lines;
      preserveReaderAnchor = merged.preservedPrefix;
      if (merged.appendedLineCount > 0) archiveExhausted = false;
    } else {
      liveLines = nextLive;
    }
    commitLines([...archivedLines, ...liveLines], { preserveReaderAnchor });
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

  function historyPrefetchThreshold(): number {
    return Math.max(2 * viewH, 24 * lineH);
  }

  function maybeRequestOlderHistory(projectedBottomOffset = bottomOffsetPx) {
    if (archiveLoading || archiveExhausted || total === 0) return;
    if (projectedBottomOffset >= maxOffset() - historyPrefetchThreshold()) requestOlderHistory();
  }

  function historyPrependSnapshot(): HistoryPrependSnapshot {
    const transform = layerEl?.style.transform ?? '';
    let anchorText = '';
    let rowCount = 0;
    if (viewportEl) {
      const viewport = viewportEl.getBoundingClientRect();
      const centerY = viewport.top + viewport.height / 2;
      let bestDistance = Infinity;
      const rows = Array.from(viewportEl.querySelectorAll<HTMLElement>('.mtv-line'));
      rowCount = rows.length;
      for (const row of rows) {
        const rect = row.getBoundingClientRect();
        if (rect.bottom <= viewport.top + 1 || rect.top >= viewport.bottom - 1) continue;
        const distance = Math.abs((rect.top + rect.bottom) / 2 - centerY);
        if (distance < bestDistance) {
          bestDistance = distance;
          anchorText = (row.textContent || '').replace(/\u00a0/g, ' ').replace(/[ \t]+$/g, '');
        }
      }
    }
    return { transform, anchorText, rowCount };
  }

  function emitHistoryPrependEvent(
    lineCount: number,
    cacheValid: boolean,
    before: HistoryPrependSnapshot,
    after: HistoryPrependSnapshot,
  ) {
    viewportEl?.dispatchEvent(new CustomEvent('thumbmux-history-prepend', {
      detail: {
        lineCount,
        cacheValid,
        before,
        after,
        transformStable: before.transform === after.transform,
      },
    }));
  }

  function finishArchiveRequest() {
    archiveLoading = false;
    if (archiveRequestTimer) {
      clearTimeout(archiveRequestTimer);
      archiveRequestTimer = null;
    }
  }

  function commitStagedPrepend(stage: PrependStage) {
    if (stage.seq !== prependParseSeq || stage.lines.length === 0) {
      finishArchiveRequest();
      return;
    }

    const lineCount = stage.lines.length;
    const before = historyPrependSnapshot();
    const currentFirstState = stateBefore[0] ? cloneSgrState(stateBefore[0]) : createSgrState();
    const existingCacheValid = sgrStateKey(stage.endState) === sgrStateKey(currentFirstState);

    archivedLines = [...stage.lines, ...archivedLines];
    rawLines = [...stage.lines, ...rawLines];
    htmlCache = [...stage.html, ...htmlCache];
    stateBefore = [...stage.entryStates, ...stateBefore];
    stateAfter = [...stage.exitStates, ...stateAfter];
    linksByLine = linksAfterPrepend(stage);

    archiveOffset -= lineCount;
    total = rawLines.length;
    winStart += lineCount;
    winEnd += lineCount;

    if (!existingCacheValid) reconcileExistingFrom(lineCount, stage.endState);
    rerenderPrependSeam(stage);

    contentEpoch++;
    applyScroll();
    const after = historyPrependSnapshot();
    const meta = import.meta as unknown as { env?: { DEV?: boolean } };
    if (meta.env?.DEV) {
      console.assert(
        before.transform === after.transform,
        'TermView history prepend changed the scroll transform',
        { before: before.transform, after: after.transform, lineCount },
      );
    }
    requestAnimationFrame(() => {
      emitHistoryPrependEvent(lineCount, existingCacheValid, before, after);
    });
    onLinesChange?.(rawLines);
    emitScrollState();
    finishArchiveRequest();
  }

  function schedulePrependCommit(stage: PrependStage) {
    if (prependCommitFrame !== null) cancelAnimationFrame(prependCommitFrame);
    prependCommitFrame = requestAnimationFrame(() => {
      prependCommitFrame = null;
      commitStagedPrepend(stage);
    });
  }

  function stageHistoryPrepend(lines: string[]) {
    if (lines.length === 0) {
      finishArchiveRequest();
      return;
    }

    const seq = ++prependParseSeq;
    const batch = [...lines];
    const linkPlan = planPrependLinks(batch);
    const html: string[] = new Array(batch.length);
    const entryStates: SgrState[] = new Array(batch.length);
    const exitStates: SgrState[] = new Array(batch.length);
    const st = createSgrState();
    let idx = 0;

    const parseSlice = () => {
      prependParseFrame = null;
      if (seq !== prependParseSeq) return;
      const stop = Math.min(batch.length, idx + HISTORY_PARSE_CHUNK_LINES);
      for (; idx < stop; idx++) {
        entryStates[idx] = cloneSgrState(st);
        html[idx] = lineToHtml(batch[idx], st, palette, linkPlan.batchLinks[idx]);
        exitStates[idx] = cloneSgrState(st);
      }
      if (idx < batch.length) {
        prependParseFrame = requestAnimationFrame(parseSlice);
        return;
      }
      const endState = cloneSgrState(st);
      schedulePrependCommit({
        seq,
        lines: batch,
        html,
        entryStates,
        exitStates,
        endState,
        linkPlan,
      });
    };

    prependParseFrame = requestAnimationFrame(parseSlice);
  }

  function applyArchivedHistory(data: string) {
    if (archiveRequestTimer) {
      clearTimeout(archiveRequestTimer);
      archiveRequestTimer = null;
    }

    let payload: {
      lines?: string[];
      startLine?: number;
      hasMore?: boolean;
    } | null = null;
    try {
      payload = JSON.parse(data);
    } catch {
      finishArchiveRequest();
      return;
    }

    const lines = Array.isArray(payload?.lines) ? payload.lines : [];
    archiveBeforeLine = typeof payload?.startLine === 'number' ? payload.startLine : archiveBeforeLine;
    archiveExhausted = !payload?.hasMore || lines.length === 0;
    if (lines.length === 0) {
      finishArchiveRequest();
      return;
    }

    stageHistoryPrepend(lines);
  }

  function contentUpdateBlock() {
    return { busy: busy(), selectionActive };
  }

  function applyContentDelivery(delivery: ContentUpdate) {
    if (delivery.cursor !== undefined) cursor = delivery.cursor;
    setLines(delivery.data.replace(/\r/g, '').split('\n'), delivery.meta.replace);
  }

  function receiveLiveContent(
    data: string,
    nextCursor: { row: number; col: number } | null | undefined,
    meta?: MuxDeliveryMeta,
  ) {
    const result = receiveContentUpdate(contentUpdateGate, {
      data,
      cursor: nextCursor,
      meta: meta ?? { source: 'full', replace: false },
    }, contentUpdateBlock());
    contentUpdateGate = result.gate;
    if (result.delivery) applyContentDelivery(result.delivery);
  }

  function flushPendingContent() {
    const result = flushContentUpdate(contentUpdateGate, contentUpdateBlock());
    contentUpdateGate = result.gate;
    if (result.delivery) applyContentDelivery(result.delivery);
    flushDeferredPresentation();
  }

  function flushDeferredPresentation() {
    if (busy() || selectionActive) return;
    if (paletteRefreshPending) {
      paletteRefreshPending = false;
      if (rawLines.length) rebuildFrom(0);
    }
    if (renderRefreshPending) {
      renderRefreshPending = false;
      renderEpoch++;
    }
    applyScroll();
  }

  function schedulePendingContentFlush() {
    if (pendingContentFlushFrame !== null) return;
    pendingContentFlushFrame = requestAnimationFrame(() => {
      pendingContentFlushFrame = null;
      flushPendingContent();
    });
  }

  // --- virtual window + transform (the 120Hz hot path) ---
  function applyScroll() {
    // The browser selection owns the currently mounted native text nodes.
    // Do not move its virtual window until the selection has been released.
    if (selectionActive) return;
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
    if (startIdx < winStart - 1 || endIdx > winEnd) {
      winStart = Math.max(0, startIdx - OVERSCAN_ROWS);
      winEnd = Math.min(total, endIdx + OVERSCAN_ROWS);
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
    if (altScreenMouse) {
      forwardAltWheel(e);
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    const delta = -wheelPixels(e);
    bottomOffsetPx = Math.max(0, Math.min(bottomOffsetPx + delta, maxOffset()));
    applyScroll();
    if (delta > 0) maybeRequestOlderHistory();
  }

  let warnedMissingKeys = false;
  function warnMissingOnKeys() {
    if (warnedMissingKeys) return;
    warnedMissingKeys = true;
    const meta = import.meta as unknown as { env?: { DEV?: boolean } };
    if (meta.env?.DEV) {
      console.warn('TermView altScreenMouse requires onKeys; SGR mouse action ignored.');
    }
  }

  function sendSgr(data: string) {
    if (!onKeys) {
      warnMissingOnKeys();
      return;
    }
    onKeys(data);
  }

  function currentGeometry(): { cols: number; rows: number } | null {
    if ((lastPushedCols <= 0 || lastPushedRows <= 0) && viewportEl) {
      measureGeometry({ force: true });
    }
    if (lastPushedCols <= 0 || lastPushedRows <= 0) return null;
    return { cols: lastPushedCols, rows: lastPushedRows };
  }

  function contentHitArea(): {
    rect: { left: number; top: number; width: number; height: number };
    geom: { cols: number; rows: number };
  } | null {
    if (!viewportEl) return null;
    const geom = currentGeometry();
    if (!geom) return null;
    const bounds = viewportEl.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) return null;
    const cellW = Math.max(1, charW || measureCharWidth());
    const gridW = Math.min(Math.max(1, bounds.width - 12), geom.cols * cellW);
    const gridH = Math.min(Math.max(1, bounds.height), geom.rows * lineH);
    return {
      rect: { left: bounds.left + 6, top: bounds.top, width: gridW, height: gridH },
      geom,
    };
  }

  // Trackpads emit dozens of sub-line pixel deltas per second — accumulate a
  // fractional remainder and flush only WHOLE lines per animation frame (same
  // scale + accumulation as the local-scroll wheel path), otherwise every
  // micro-event would be inflated to a full SGR wheel line.
  let altWheelRemainder = 0;
  let altWheelFrame: number | null = null;
  let altWheelCell: { cx: number; cy: number } | null = null;

  function queueAltWheelDelta(clientX: number, clientY: number, delta: { deltaY: number; deltaMode: number }): boolean {
    const area = contentHitArea();
    if (!area) return false;
    const hit = contentCellFromPoint(clientX, clientY, area.rect, area.geom);
    if (!hit) return false;
    // Full-screen TUIs ignore wheel events over their bottom composer box —
    // keep the target row in the conversation area (same clamp as
    // centerContentCell's composer margin).
    altWheelCell = { cx: hit.cx, cy: Math.max(1, Math.min(hit.cy, area.geom.rows - 8)) };
    altWheelRemainder += wheelDeltaToLines(delta, lineH, area.geom.rows);
    scheduleAltWheelFlush();
    return true;
  }

  function forwardAltWheel(e: WheelEvent) {
    e.preventDefault();
    e.stopPropagation();
    queueAltWheelDelta(e.clientX, e.clientY, e);
  }

  function scheduleAltWheelFlush() {
    if (altWheelFrame !== null) return;
    altWheelFrame = requestAnimationFrame(() => {
      altWheelFrame = null;
      const consumed = consumeWholeWheelLines(altWheelRemainder);
      altWheelRemainder = consumed.remainder;
      if (consumed.wholeLines !== 0 && altWheelCell) {
        const count = Math.min(DEFAULT_WHEEL_MAX_PER_CALL, Math.abs(consumed.wholeLines));
        // browser sign: positive deltaY = wheel toward the user = scroll down
        sendSgr(sgrWheel(consumed.wholeLines > 0 ? 'down' : 'up', altWheelCell.cx, altWheelCell.cy, count));
      }
      if (Math.abs(altWheelRemainder) >= 1) scheduleAltWheelFlush();
    });
  }

  function updateSelectionActive() {
    const wasActive = selectionActive;
    const sel = typeof window !== 'undefined' ? window.getSelection() : null;
    selectionActive = !!(
      sel && !sel.isCollapsed && viewportEl && (
        (sel.anchorNode && viewportEl.contains(sel.anchorNode)) ||
        (sel.focusNode && viewportEl.contains(sel.focusNode))
      )
    );
    if (wasActive && !selectionActive) schedulePendingContentFlush();
  }

  function hasSelectionInView(): boolean {
    const sel = typeof window !== 'undefined' ? window.getSelection?.() : null;
    return !!(
      sel && !sel.isCollapsed && viewportEl && (
        (sel.anchorNode && viewportEl.contains(sel.anchorNode)) ||
        (sel.focusNode && viewportEl.contains(sel.focusNode))
      )
    );
  }

  // --- gesture physics (px-true, no quantization, iOS decel curve) ---
  function onTouchStart(e: TouchEvent) {
    updateSelectionActive();
    if (selectionActive) return; // user is adjusting a selection — hands off
    if (altScreenMouse) {
      stopInertia();
      tapStart = null;
      touching = false;
      altTouchMoved = false;
      const touch = e.touches.item(0);
      altTouchY = e.touches.length === 1 && touch ? touch.clientY : null;
      return;
    }
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
    if (altScreenMouse) {
      if (selectionActive || altTouchY === null) {
        updateSelectionActive();
        if (selectionActive) {
          altTouchY = null;
          return; // let iOS drag the selection handles
        }
      }
      const touch = e.touches.item(0);
      if (e.touches.length !== 1 || !touch || altTouchY === null) {
        altTouchY = null;
        return;
      }
      e.stopPropagation();
      if (e.cancelable) e.preventDefault();
      const dy = touch.clientY - altTouchY;
      altTouchY = touch.clientY;
      if (dy !== 0) {
        altTouchMoved = true;
        queueAltWheelDelta(touch.clientX, touch.clientY, { deltaY: -dy, deltaMode: 0 });
      }
      return;
    }
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
  let altPointerStart: {
    x: number;
    y: number;
    pointerId: number;
    target: EventTarget | null;
    time: number;
    hadSelection: boolean;
  } | null = null;
  let suppressClickUntil = 0;

  function closestLink(target: EventTarget | null): HTMLAnchorElement | null {
    return target instanceof Element ? target.closest('a') : null;
  }

  function cleanTapTarget(target: EventTarget | null): boolean {
    return !closestLink(target);
  }

  function maybeTap(e: TouchEvent | MouseEvent, x: number, y: number) {
    if (altScreenMouse || !onTap || !tapStart) return;
    const moved = Math.abs(x - tapStart.x) + Math.abs(y - tapStart.y);
    const dur = performance.now() - tapStart.t;
    const sel = window.getSelection?.();
    if (dur < 350 && moved < 10 && (!sel || sel.isCollapsed) && cleanTapTarget(e.target)) {
      onTap();
    }
  }

  function hasPointerModifier(e: PointerEvent): boolean {
    return e.altKey || e.ctrlKey || e.metaKey || e.shiftKey;
  }

  function isPlainPrimaryPointer(e: PointerEvent): boolean {
    return e.button === 0 && e.isPrimary !== false && !hasPointerModifier(e);
  }

  function onPointerDown(e: PointerEvent) {
    if (!altScreenMouse || !isPlainPrimaryPointer(e)) return;
    altPointerStart = {
      x: e.clientX,
      y: e.clientY,
      pointerId: e.pointerId,
      target: e.target,
      time: performance.now(),
      hadSelection: hasSelectionInView(),
    };
  }

  function onPointerUp(e: PointerEvent) {
    if (!altScreenMouse || !altPointerStart || e.pointerId !== altPointerStart.pointerId) return;
    const start = altPointerStart;
    altPointerStart = null;
    if (!isPlainPrimaryPointer(e)) return;
    const cleanClick = Math.hypot(e.clientX - start.x, e.clientY - start.y) <= 6;
    if (cleanClick && (closestLink(e.target) || closestLink(start.target))) return;
    if (!cleanClick || start.hadSelection || hasSelectionInView()) return;
    const area = contentHitArea();
    if (!area) return;
    const hit = contentCellFromPoint(e.clientX, e.clientY, area.rect, area.geom);
    if (!hit) return;
    sendSgr(sgrClick(hit.cx, hit.cy));
    suppressClickUntil = performance.now() + 700;
  }

  function onClick(e: MouseEvent) {
    if (altScreenMouse) {
      if (suppressClickUntil > 0) {
        if (performance.now() <= suppressClickUntil) {
          e.preventDefault();
          e.stopPropagation();
        }
        suppressClickUntil = 0;
      }
      return;
    }
    if (!onTap) return;
    if (performance.now() - lastTouchEndAt < 500) return; // synthesized click
    const sel = window.getSelection?.();
    if ((!sel || sel.isCollapsed) && cleanTapTarget(e.target)) onTap();
  }

  function onTouchEnd(e?: TouchEvent) {
    lastTouchEndAt = performance.now();
    if (altScreenMouse) {
      if (altTouchMoved) {
        e?.stopPropagation();
        if (e?.cancelable) e.preventDefault();
      }
      tapStart = null;
      altTouchY = null;
      altTouchMoved = false;
      touching = false;
      flushPendingContent();
      return;
    }
    if (e && e.changedTouches?.[0] && tapStart) {
      maybeTap(e, e.changedTouches[0].clientX, e.changedTouches[0].clientY);
    }
    tapStart = null;
    if (selectionActive) {
      updateSelectionActive();
      touching = false;
      flushPendingContent();
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
    if (vel > 0) maybeRequestOlderHistory(bottomOffsetPx + vel * MOMENTUM_TAU);
    let lastT = performance.now();
    const step = () => {
      const now = performance.now();
      const dt = Math.min(64, Math.max(1, now - lastT));
      lastT = now;
      const decay = Math.exp(-dt / TAU);
      scrollBy(vel * TAU * (1 - decay));
      vel *= decay;
      if (vel > 0) maybeRequestOlderHistory(bottomOffsetPx + vel * TAU);
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

  function canSendResize(): boolean {
    return !!(
      claimGeometry &&
      typeof document !== 'undefined' &&
      document.visibilityState === 'visible'
    );
  }

  function measureGeometry(opts: { force?: boolean } = {}): {
    cols: number;
    rows: number;
    changed: boolean;
  } | null {
    if (!viewportEl) return null;
    const w = viewportEl.clientWidth;
    const visibleH = viewportEl.clientHeight;
    // Rows always derive from the FULL host height (inset added back): the
    // docked composer shrinks what's visible, not the pane the agent runs in.
    const h = visibleH + Math.max(0, bottomInsetPx);
    if (w <= 0 || visibleH <= 0 || h <= 0) return null;
    const cw = measureCharWidth();
    charW = cw;
    const cols = Math.max(minCols, Math.floor((w - 12) / cw));
    const rows = Math.max(minRows, Math.min(60, Math.floor(h / lineH)));
    const changed = !!opts.force || cols !== lastPushedCols || rows !== lastPushedRows;
    if (!changed) return { cols, rows, changed: false };
    lastPushedCols = cols;
    lastPushedRows = rows;
    onGeometryChange?.({ cols, rows });
    return { cols, rows, changed };
  }

  function pushGeometry(opts: { force?: boolean } = {}) {
    const measured = measureGeometry(opts);
    if (!measured?.changed || !canSendResize()) return;
    tmuxMux.sendResize(session, measured.cols, measured.rows);
  }

  /** Re-measure and re-claim geometry (e.g. after a host font-size change —
   * glyph resizes don't fire the ResizeObserver). */
  export function refreshGeometry() {
    lastPushedCols = 0;
    pushGeometry({ force: true });
    if (selectionActive) {
      renderRefreshPending = true;
      return;
    }
    renderEpoch++;
    applyScroll();
  }

  let lastFontPx: number | null = null;
  $effect(() => {
    if (lastFontPx !== null && fontPx !== lastFontPx) refreshGeometry();
    lastFontPx = fontPx;
  });

  let lastClaimGeometry = $state<boolean | null>(null);
  $effect(() => {
    if (lastClaimGeometry === null) {
      lastClaimGeometry = claimGeometry;
      return;
    }
    if (claimGeometry === lastClaimGeometry) return;
    lastClaimGeometry = claimGeometry;
    if (claimGeometry) refreshGeometry();
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
    updateSelectionActive();
    unsubscribe = tmuxMux.subscribe(session, (
      data: string,
      type?: string,
      cur?: { row: number; col: number } | null,
      meta?: MuxDeliveryMeta,
    ) => {
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
      receiveLiveContent(data, cur, meta);
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
    if (pendingContentFlushFrame !== null) cancelAnimationFrame(pendingContentFlushFrame);
    if (prependParseFrame !== null) { cancelAnimationFrame(prependParseFrame); prependParseFrame = null; }
    if (prependCommitFrame !== null) { cancelAnimationFrame(prependCommitFrame); prependCommitFrame = null; }
    if (altWheelFrame !== null) { cancelAnimationFrame(altWheelFrame); altWheelFrame = null; }
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
      if (selectionActive) {
        paletteRefreshPending = true;
        return;
      }
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
  data-archive-offset={archiveOffset}
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
  onpointerdown={onPointerDown}
  onpointerup={onPointerUp}
  onwheel={onWheel}
  onclick={onClick}
>
  <div bind:this={layerEl} class="mtv-layer">
    {#key renderEpoch}
      {#each { length: winEnd - winStart } as _, i (archiveOffset + winStart + i)}
        {@const lineIdx = winStart + i}
        <div class="mtv-line" data-line-id={archiveOffset + lineIdx}>{@html cachedLineHtml(lineIdx, contentEpoch)}</div>
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
