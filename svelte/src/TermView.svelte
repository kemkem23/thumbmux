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
  import TermSearch from './TermSearch.svelte';
  import {
    contentLinesChangeSource, createContentUpdateGate, flushContentUpdate, receiveContentUpdate,
    updatePendingContentCursor,
    type ContentUpdate,
  } from './content-update-gate';
  import {
    searchKeyIntent,
    moveActiveIndex,
    readSparseOverlay,
    writeSparseOverlay,
    nextGeneration,
    createArchiveContinuationState,
    beginArchiveContinuation,
    settleArchiveContinuation,
    searchJumpBottomOffset,
    hasSearchOverlayState,
    shouldDeferSearchWork,
    rememberDeferredSearchRerun,
    clearDeferredSearchRerun,
    type SearchDirection,
    type ArchiveContinuationState,
    type ArchiveContinuationSettlement,
  } from './term-search';
  import {
    createSgrState, cloneSgrState, sgrStateKey, lineToHtml, searchLines,
    type AnsiPalette, type SgrState, type LineLinkRange,
    type LineOverlayRange,
    type SearchMatch,
    collectTerminalUrlSegments,
    mergeCapturedLinesForStableScroll,
    readerAnchorLineDelta,
    prefixForCells, stripAnsi, paneTextForCopy,
    contentCellFromPoint, centerContentCell,
    sgrWheel, sgrClick, sgrSnapToBottom, DEFAULT_WHEEL_MAX_PER_CALL,
    wheelDeltaToLines, consumeWholeWheelLines,
  } from '@thumbmux/core';

  type LinesChangeMeta = {
    source: 'live' | 'prepend' | 'replace';
  };

  type ContentHitArea = {
    rect: { left: number; top: number; width: number; height: number };
    geom: { cols: number; rows: number };
  };

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
    onLinesChange?: (lines: string[], meta: LinesChangeMeta) => void;
    onGeometryChange?: (geometry: { cols: number; rows: number }) => void;
    onScrollStateChange?: (state: { bottomOffset: number; scrolledUp: boolean }) => void;
  } = $props();

  const LINE_RATIO = 1.6;
  const OVERSCAN_ROWS = 60;
  const RUBBER_PX = 90;
  const HISTORY_BATCH_LINES = 2000;
  const HISTORY_PARSE_CHUNK_LINES = 300;
  const HISTORY_LINK_SEAM_LINES = 12;
  const HISTORY_GAP_LINK_ROWS = 128;
  const HISTORY_RETAINED_ROW_BUDGET = 10_000;
  const HISTORY_RETAINED_BYTE_BUDGET = 8 * 1024 * 1024;
  // Deterministic heap estimate for array slots, two full SGR state objects,
  // and per-row bookkeeping. String payloads are counted separately below.
  const HISTORY_ROW_OVERHEAD_BYTES = 384;
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
  let rawEntryState: SgrState = createSgrState();
  // When newer archived rows are evicted, the retained archive and live tail
  // have a gap. Preserve the renderer state on the live side of that gap.
  let liveGapEntryState: SgrState | null = null;
  let retainedEstimatedBytes = $state(0);
  let total = $state(0);
  let connected = $state(false);
  let archiveBeforeLine: number | null = null;
  let archiveLoading = false;
  let archiveExhausted = false;
  // Client-side request id for history_expand. The wire protocol has no token,
  // so we only match "currently inflight" vs "stale/lost": a timeout clears
  // the inflight id and allows a retry; a late reply with no inflight id is
  // discarded without permanently disabling expansion.
  let archiveRequestActive = false;
  let archiveRequestSeq = 0;
  let archiveInflightRequestId: number | null = null;
  let archiveRequestTimer: ReturnType<typeof setTimeout> | null = null;

  // --- scroll model: bottomOffsetPx 0 = pinned to live tail ---
  // Keep the per-frame compositor offset out of Svelte reactivity. Diagnostics
  // get a settled mirror, while the only reactive hot-path state is the coarse
  // scrolled-up boundary needed by the cursor and host controls.
  let bottomOffsetPx = 0;
  let settledBottomOffsetPx = $state(0);
  let scrollStateScrolledUp = $state(false);
  let winStart = $state(0);
  let winEnd = $state(0);
  let archiveOffset = $state(ARCHIVE_OFFSET_START);
  let contentEpoch = $state(0);
  let renderEpoch = $state(0); // bump to force window re-render

  // --- search + matching overlay ---
  let searchOpen = $state(false);
  let searchQuery = $state('');
  let searchMatches = $state<SearchMatch[]>([]);
  let searchActiveIndex = $state(-1);
  let searchError = $state<string | null>(null);
  let searchLineByIndex = new Map<number, LineOverlayRange[]>();
  let searchSparseCache = new Map<number, { generation: number; html: string }>();
  let searchGeneration = $state(0);
  let searchQueryGeneration = $state(0);
  let searchPanelEl: HTMLDivElement | null = $state(null);
  let searchComponent: ReturnType<typeof TermSearch> | null = $state(null);
  let pendingSearchJumpLine: number | null = null;
  let searchPresentationPending = false;
  let searchRerunPending = false;
  let pendingSearchRerunIdentity: SearchActiveIdentity | null = null;
  let keydownCaptureHost: HTMLElement | null = $state(null);
  let archiveContinuationState: ArchiveContinuationState = createArchiveContinuationState();

  let touching = false;
  let selectionActive = false; // native text selection in progress — scroll yields
  let momentumFrame: number | null = null;
  let springFrame: number | null = null;
  let momentumWindowFrozen = false;
  let touchY = 0;
  let touchVel = 0;
  let touchAt = 0;
  let pendingDragPx = 0;
  let dragFrame: number | null = null;
  let altTouchY: number | null = null;
  let altTouchMoved = false;
  let altTouchHitArea: ContentHitArea | null = null;
  let contentUpdateGate = createContentUpdateGate();
  let pendingContentFlushFrame: number | null = null;
  let paletteRefreshPending = false;
  let renderRefreshPending = false;
  let pendingPrependWork: (() => void) | null = null;
  let cancelPrependWorkTask: (() => void) | null = null;
  let prependParseSeq = 0;
  let destroyed = false;

  type PrependLinkPlan = {
    batchLinks: (LineLinkRange[] | undefined)[];
    seamLinks: Map<number, LineLinkRange[]>;
  };

  type PrependStage = {
    seq: number;
    startLine: number | null;
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

  type SearchActiveIdentity = {
    rowId: number;
    start: number;
    end: number;
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
    // Declare outside try so a failed select/execCommand still removes the
    // node — plain HTTP has no navigator.clipboard, so this path is common
    // and a multi-megabyte buffer must not leak a hidden textarea forever.
    let ta: HTMLTextAreaElement | null = null;
    try {
      ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
      document.body.appendChild(ta);
      ta.select();
      return document.execCommand('copy');
    } catch {
      return false;
    } finally {
      ta?.remove();
    }
  }

  export function isScrolledUp(): boolean {
    return bottomOffsetPx > lineH;
  }

  function isSearchTarget(target: EventTarget | null): boolean {
    return !!(
      keydownCaptureHost && target instanceof Node && keydownCaptureHost.contains(target)
    );
  }

  function selectionInSearchPanel(selection: Selection | null): boolean {
    if (!selection || !searchPanelEl) return false;
    const anchor = selection.anchorNode;
    const focus = selection.focusNode;
    return (
      (anchor && searchPanelEl.contains(anchor)) ||
      (focus && searchPanelEl.contains(focus))
    );
  }

  function invalidateSearchOverlayHtml() {
    searchSparseCache = new Map();
    searchGeneration = nextGeneration(searchGeneration);
  }

  function requestSearchPresentation() {
    if (shouldDeferSearchWork({ busy: busy(), selectionActive })) {
      searchPresentationPending = true;
      return;
    }
    renderEpoch++;
    applyScroll();
  }

  function clearSearchRerunDeferral() {
    const cleared = clearDeferredSearchRerun<SearchActiveIdentity>();
    searchRerunPending = cleared.pending;
    pendingSearchRerunIdentity = cleared.identity;
  }

  function currentSearchActiveIdentity(): SearchActiveIdentity | null {
    const active = searchActiveIndex >= 0 ? searchMatches[searchActiveIndex] : null;
    if (!active) return null;
    // This is identity preservation only.  Search spans and jump math always
    // remain rawLines indexes plus visible UTF-16 offsets.
    return { rowId: archiveOffset + active.line, start: active.start, end: active.end };
  }

  function requestSearchRerun(prependIdentity: SearchActiveIdentity | null = null) {
    if (shouldDeferSearchWork({ busy: busy(), selectionActive })) {
      const next = rememberDeferredSearchRerun(
        { pending: searchRerunPending, identity: pendingSearchRerunIdentity },
        prependIdentity,
      );
      searchRerunPending = next.pending;
      pendingSearchRerunIdentity = next.identity;
      return;
    }

    if (!searchQuery) {
      searchMatches = [];
      searchActiveIndex = -1;
      searchError = null;
      searchLineByIndex = new Map();
      clearSearchRerunDeferral();
      invalidateSearchOverlayHtml();
      requestSearchPresentation();
      return;
    }

    const result = searchLines(rawLines, searchQuery);
    const previousActive = searchActiveIndex >= 0 ? searchMatches[searchActiveIndex] : null;
    const nextMatches = result.matches;
    searchMatches = nextMatches;

    if (nextMatches.length === 0) {
      searchActiveIndex = -1;
    } else if (prependIdentity) {
      let nextActive = -1;
      for (let i = 0; i < nextMatches.length; i += 1) {
        const current = nextMatches[i];
        if (
          archiveOffset + current.line === prependIdentity.rowId &&
          current.start === prependIdentity.start &&
          current.end === prependIdentity.end
        ) {
          nextActive = i;
          break;
        }
      }
      searchActiveIndex = nextActive >= 0 ? nextActive : 0;
    } else if (previousActive) {
      let nextActive = -1;
      for (let i = 0; i < nextMatches.length; i += 1) {
        const current = nextMatches[i];
        if (
          current.line === previousActive.line &&
          current.start === previousActive.start &&
          current.end === previousActive.end
        ) {
          nextActive = i;
          break;
        }
      }
      searchActiveIndex = nextActive >= 0 ? nextActive : 0;
    } else {
      searchActiveIndex = 0;
    }

    searchError = result.error?.message ?? null;

    const nextRanges = new Map<number, LineOverlayRange[]>();
    for (const match of nextMatches) {
      const ranges = nextRanges.get(match.line) ?? [];
      ranges.push({ start: match.start, end: match.end, kind: 'search-match' });
      nextRanges.set(match.line, ranges);
    }

    if (searchActiveIndex >= 0 && searchActiveIndex < nextMatches.length) {
      const active = nextMatches[searchActiveIndex];
      const ranges = nextRanges.get(active.line) ?? [];
      let promoted = false;
      for (let i = 0; i < ranges.length; i += 1) {
        if (ranges[i].start === active.start && ranges[i].end === active.end) {
          ranges[i] = { ...ranges[i], kind: 'search-active' };
          promoted = true;
          break;
        }
      }
      if (!promoted) {
        ranges.push({ start: active.start, end: active.end, kind: 'search-active' });
      }
      nextRanges.set(active.line, ranges);
    }

    searchLineByIndex = nextRanges;
    invalidateSearchOverlayHtml();
    requestSearchPresentation();
  }

  function updateSearchActiveRange(nextIndex: number) {
    if (nextIndex < 0 || nextIndex >= searchMatches.length || !searchQuery) {
      searchActiveIndex = -1;
      return;
    }

    searchActiveIndex = nextIndex;
    const next = new Map<number, LineOverlayRange[]>();
    for (const [line, ranges] of searchLineByIndex.entries()) {
      next.set(line, ranges.map((range) =>
        range.kind === 'search-active'
          ? { ...range, kind: 'search-match' as const }
          : range,
      ));
    }

    const active = searchMatches[nextIndex];
    const ranges = next.get(active.line) ?? [];
    let applied = false;
    for (let i = 0; i < ranges.length; i += 1) {
      if (ranges[i].start === active.start && ranges[i].end === active.end) {
        ranges[i] = { ...ranges[i], kind: 'search-active' };
        applied = true;
        break;
      }
    }
    if (!applied) {
      ranges.push({ start: active.start, end: active.end, kind: 'search-active' });
    }
    next.set(active.line, ranges);

    searchLineByIndex = next;
    invalidateSearchOverlayHtml();
    requestSearchPresentation();
  }

  function cachedLineHtml(idx: number, epoch: number): string {
    void epoch;
    const base = htmlCache[idx] ?? ' ';
    const ranges = searchLineByIndex.get(idx);
    if (!ranges || ranges.length === 0) return base;

    const cached = readSparseOverlay(searchSparseCache, idx, searchGeneration);
    if (cached !== undefined) return cached;

    const rawLine = rawLines[idx];
    if (rawLine === undefined) return base;
    const st = stateBefore[idx] ? cloneSgrState(stateBefore[idx]) : createSgrState();
    const html = lineToHtml(rawLine, st, palette, linksByLine[idx], ranges);
    writeSparseOverlay(searchSparseCache, idx, searchGeneration, html);
    return html;
  }

  export function scrollToBottom(): boolean {
    updateSelectionActive();
    if (selectionActive) return false;
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
    return true;
  }

  function maxOffset(): number {
    return Math.max(0, total * lineH - Math.max(1, viewH));
  }

  function busy(): boolean {
    return touching || momentumFrame !== null || springFrame !== null;
  }

  function stopInertia() {
    const stopped = momentumFrame !== null || springFrame !== null;
    if (momentumFrame !== null) { cancelAnimationFrame(momentumFrame); momentumFrame = null; }
    if (springFrame !== null) { cancelAnimationFrame(springFrame); springFrame = null; }
    if (stopped) schedulePendingPrependWork();
  }

  // --- ANSI render bookkeeping (incremental, off the scroll path) ---
  let linksByLine: (LineLinkRange[] | undefined)[] = [];

  /** URL detection — mid-line URLs and URLs that wrap across lines (segments
   * reconstructed at the pane width) all become tappable <a> ranges. */
  function rebuildAllLinks() {
    linksByLine = new Array(rawLines.length);
    const cols = lastPushedCols > 0 ? lastPushedCols : 60;
    const collect = (lines: string[], targetOffset: number) => {
      for (const match of collectTerminalUrlSegments(lines, 0, lines.length, cols)) {
        for (const seg of match.segments) {
          (linksByLine[targetOffset + seg.lineIdx] ??= []).push({
            start: seg.startCol,
            end: seg.endCol,
            href: match.url,
          });
        }
      }
    };
    try {
      if (liveGapEntryState && liveLines.length > 0) {
        collect(archivedLines, 0);
        collect(liveLines, archivedLines.length);
      } else {
        collect(rawLines, 0);
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

  function prependColumn<T>(target: T[], values: T[]): void {
    // Bound argument expansion even if a peer violates HISTORY_BATCH_LINES.
    for (let end = values.length; end > 0;) {
      const start = Math.max(0, end - HISTORY_PARSE_CHUNK_LINES);
      target.splice(0, 0, ...values.slice(start, end));
      end = start;
    }
  }

  function prependLinks(stage: PrependStage): void {
    const count = stage.lines.length;
    prependColumn(linksByLine, stage.linkPlan.batchLinks);
    for (const [existingOffset, links] of stage.linkPlan.seamLinks) {
      const idx = count + existingOffset;
      if (idx >= count && idx < linksByLine.length) {
        linksByLine[idx] = mergeLineLinks(links, linksByLine[idx]);
      }
    }
  }

  function estimatedLineStorageBytes(
    raw: string,
    html: string,
    links: LineLinkRange[] | undefined,
  ): number {
    let bytes = HISTORY_ROW_OVERHEAD_BYTES + 2 * (raw.length + html.length);
    if (links) {
      for (const link of links) bytes += 64 + 2 * link.href.length;
    }
    return bytes;
  }

  function recalculateRetainedEstimatedBytes(): void {
    let bytes = 0;
    for (let i = 0; i < rawLines.length; i++) {
      bytes += estimatedLineStorageBytes(
        rawLines[i] ?? '',
        htmlCache[i] ?? '',
        linksByLine[i],
      );
    }
    retainedEstimatedBytes = bytes;
  }

  type PrependRetentionPlan = {
    keepFrom: number;
    evictArchivedFrom: number;
  };

  function planPrependRetention(stage: PrependStage): PrependRetentionPlan {
    let stageBytes = 0;
    for (let i = 0; i < stage.lines.length; i++) {
      stageBytes += estimatedLineStorageBytes(
        stage.lines[i] ?? '',
        stage.html[i] ?? '',
        stage.linkPlan.batchLinks[i],
      );
    }

    let projectedRows = rawLines.length + stage.lines.length;
    let projectedBytes = retainedEstimatedBytes + stageBytes;

    // History replies arrive while the reader is at (or searching toward) the
    // old end of the archive. Prefer evicting the newest archived suffix below
    // the mounted viewport+overscan so the incoming older page remains usable.
    const protectedExistingEnd = Math.min(archivedLines.length, winEnd);
    let evictArchivedFrom = archivedLines.length;
    while (evictArchivedFrom > protectedExistingEnd && (
      projectedRows > HISTORY_RETAINED_ROW_BUDGET ||
      projectedBytes > HISTORY_RETAINED_BYTE_BUDGET
    )) {
      evictArchivedFrom--;
      projectedRows--;
      projectedBytes -= estimatedLineStorageBytes(
        rawLines[evictArchivedFrom] ?? '',
        htmlCache[evictArchivedFrom] ?? '',
        linksByLine[evictArchivedFrom],
      );
    }

    // A page can itself exceed the byte budget (or the protected/live suffix
    // can leave too little room). In that case discard only as much of the
    // incoming oldest prefix as is necessary; existing mounted rows stay safe.
    let keepFrom = 0;
    while (keepFrom < stage.lines.length && (
      projectedRows > HISTORY_RETAINED_ROW_BUDGET ||
      projectedBytes > HISTORY_RETAINED_BYTE_BUDGET
    )) {
      projectedRows--;
      projectedBytes -= estimatedLineStorageBytes(
        stage.lines[keepFrom] ?? '',
        stage.html[keepFrom] ?? '',
        stage.linkPlan.batchLinks[keepFrom],
      );
      keepFrom++;
    }
    return { keepFrom, evictArchivedFrom };
  }

  function slicePrependStage(stage: PrependStage, keepFrom: number): PrependStage {
    if (keepFrom === 0) return stage;
    return {
      ...stage,
      lines: stage.lines.slice(keepFrom),
      html: stage.html.slice(keepFrom),
      entryStates: stage.entryStates.slice(keepFrom),
      exitStates: stage.exitStates.slice(keepFrom),
      linkPlan: {
        batchLinks: stage.linkPlan.batchLinks.slice(keepFrom),
        seamLinks: stage.linkPlan.seamLinks,
      },
    };
  }

  /** Remove an archived suffix that is strictly below the mounted window.
   * The live tail stays retained; its SGR entry checkpoint bridges the gap. */
  function evictArchivedTail(from: number): number {
    const archiveLength = archivedLines.length;
    const evicted = Math.max(0, archiveLength - Math.max(0, from));
    if (evicted === 0) return 0;

    if (liveLines.length > 0) {
      const liveEntry = stateBefore[archiveLength];
      if (liveEntry) liveGapEntryState = cloneSgrState(liveEntry);
    }

    archivedLines.splice(from, evicted);
    rawLines.splice(from, evicted);
    htmlCache.splice(from, evicted);
    stateBefore.splice(from, evicted);
    stateAfter.splice(from, evicted);
    linksByLine.splice(from, evicted);

    // Removing rows below the reader lowers maxOffset. Reduce bottomOffset by
    // the same height so scrollTop, transform, and mounted content stay fixed.
    bottomOffsetPx = Math.max(0, bottomOffsetPx - evicted * lineH);
    return evicted;
  }

  function dropRetainedPrependPrefix(count: number): void {
    if (count <= 0) return;
    const nextEntryState = stateBefore[count]
      ? cloneSgrState(stateBefore[count])
      : cloneSgrState(rawEntryState);
    archivedLines.splice(0, count);
    rawLines.splice(0, count);
    htmlCache.splice(0, count);
    stateBefore.splice(0, count);
    stateAfter.splice(0, count);
    linksByLine.splice(0, count);
    rawEntryState = nextEntryState;
    archiveOffset += count;
    winStart = Math.max(0, winStart - count);
    winEnd = Math.max(0, winEnd - count);
  }

  function tailEvictionStartForCurrentBudget(protectedEnd: number): number {
    let projectedRows = rawLines.length;
    let projectedBytes = retainedEstimatedBytes;
    let from = archivedLines.length;
    const minimum = Math.min(from, Math.max(0, protectedEnd));
    while (from > minimum && (
      projectedRows > HISTORY_RETAINED_ROW_BUDGET ||
      projectedBytes > HISTORY_RETAINED_BYTE_BUDGET
    )) {
      from--;
      projectedRows--;
      projectedBytes -= estimatedLineStorageBytes(
        rawLines[from] ?? '',
        htmlCache[from] ?? '',
        linksByLine[from],
      );
    }
    return from;
  }

  function rebuildFrom(idx: number) {
    const gapIndex = liveGapEntryState ? archivedLines.length : -1;
    let st: SgrState = gapIndex === idx && liveGapEntryState
      ? cloneSgrState(liveGapEntryState)
      : idx > 0
        ? cloneSgrState(stateAfter[idx - 1])
        : cloneSgrState(rawEntryState);
    for (let i = idx; i < rawLines.length; i++) {
      if (i === gapIndex && liveGapEntryState) st = cloneSgrState(liveGapEntryState);
      stateBefore[i] = cloneSgrState(st);
      htmlCache[i] = lineToHtml(rawLines[i], st, palette, linksByLine[i]);
      stateAfter[i] = cloneSgrState(st);
    }
    htmlCache.length = rawLines.length;
    stateBefore.length = rawLines.length;
    stateAfter.length = rawLines.length;
    recalculateRetainedEstimatedBytes();
  }

  function reconcileExistingFrom(idx: number, entryState: SgrState): number {
    let st = cloneSgrState(entryState);
    const gapIndex = liveGapEntryState ? archivedLines.length : -1;
    for (let i = idx; i < rawLines.length; i++) {
      if (i === gapIndex && liveGapEntryState) st = cloneSgrState(liveGapEntryState);
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

  /** Clear link metadata that used to cross an evicted archive/live seam, then
   * rebuild only the bounded continuation corridor on each side of the gap. */
  function rebuildGapLinkSeam(): void {
    if (!liveGapEntryState || liveLines.length === 0) return;
    const gapIndex = archivedLines.length;
    const clearStart = Math.max(0, gapIndex - HISTORY_GAP_LINK_ROWS);
    const clearEnd = Math.min(rawLines.length, gapIndex + HISTORY_GAP_LINK_ROWS);
    for (let i = clearStart; i < clearEnd; i++) linksByLine[i] = undefined;

    const cols = lastPushedCols > 0 ? lastPushedCols : 60;
    const collect = (lines: string[], targetOffset: number) => {
      for (const match of collectTerminalUrlSegments(lines, 0, lines.length, cols)) {
        for (const seg of match.segments) {
          const idx = targetOffset + seg.lineIdx;
          if (idx < clearStart || idx >= clearEnd) continue;
          addLinkRange(linksByLine, idx, {
            start: seg.startCol,
            end: seg.endCol,
            href: match.url,
          });
        }
      }
    };

    try {
      // Scan one additional max-continuation corridor so a valid link whose
      // origin is just before clearStart can restore its retained segments.
      const archiveScanStart = Math.max(0, clearStart - HISTORY_GAP_LINK_ROWS);
      collect(archivedLines.slice(archiveScanStart), archiveScanStart);
      collect(liveLines.slice(0, HISTORY_GAP_LINK_ROWS * 2), gapIndex);
    } catch { /* malformed link text must not break history commit */ }

    for (let i = clearStart; i < clearEnd; i++) rerenderLineWithCachedEntry(i);
  }

  function commitLines(next: string[], opts: {
    preserveReaderAnchor?: boolean;
    source: LinesChangeMeta['source'];
  }) {
    // Find common prefix so unchanged history isn't re-parsed.
    let common = 0;
    const minLen = Math.min(rawLines.length, next.length);
    while (common < minLen && rawLines[common] === next[common]) common++;
    const linesChanged = rawLines.length !== next.length || common !== minLen;

    if (bottomOffsetPx > 0 && opts.preserveReaderAnchor) {
      const lineDelta = readerAnchorLineDelta(rawLines, next);
      if (lineDelta !== 0) {
        // Live captures may rewrite the prompt and one adjacent tail row
        // while appending. A stable prefix through that small tail keeps the
        // same reader row under the finger without treating resets as appends.
        bottomOffsetPx = Math.max(0, bottomOffsetPx + lineDelta * lineH);
      }
    }

    rawLines = next;
    total = next.length;
    rebuildAllLinks();
    rebuildFrom(common);
    bottomOffsetPx = Math.min(bottomOffsetPx, maxOffset());
    contentEpoch++;
    applyScroll();
    if (linesChanged) onLinesChange?.(rawLines, { source: opts.source });
    emitScrollState();

    if (searchQuery && linesChanged) {
      requestSearchRerun();
    } else if (
      !searchQuery &&
      hasSearchOverlayState({
        matchCount: searchMatches.length,
        rangeCount: searchLineByIndex.size,
        activeIndex: searchActiveIndex,
        hasError: searchError !== null,
      })
    ) {
      searchLineByIndex = new Map();
      searchMatches = [];
      searchActiveIndex = -1;
      searchError = null;
      clearSearchRerunDeferral();
      invalidateSearchOverlayHtml();
      requestSearchPresentation();
    }
  }

  /** Bump generation and settle any in-flight archive continuation as query-change. */
  function settleSearchQueryChange(): void {
    searchQueryGeneration = nextGeneration(searchQueryGeneration);

    if (archiveContinuationState.pendingRequestToken !== null) {
      const settled = settleArchiveContinuation(
        archiveContinuationState,
        archiveContinuationState.pendingRequestToken,
        { kind: 'query-change' },
      );
      archiveContinuationState = settled.state;
    }
  }

  function updateSearchOpen(on?: boolean): void {
    searchOpen = !!on;
    if (!searchOpen) {
      // Closing the panel ends the search session: drop query, cancel
      // archive continuation, and let the empty-query rerun path clear
      // matches / highlights / presentation so closed search cannot keep
      // painting overlays or re-scanning on every content delivery.
      searchQuery = '';
      settleSearchQueryChange();
      pendingSearchJumpLine = null;
      requestSearchRerun();
      return;
    }
    requestAnimationFrame(() => searchComponent?.focusInput());
  }

  function updateSearchQuery(next: string): void {
    searchQuery = next;
    settleSearchQueryChange();
    requestSearchRerun();
  }

  function beginSearchContinuation(): boolean {
    if (archiveLoading || archiveExhausted) return false;
    const transition = beginArchiveContinuation(archiveContinuationState, {
      queryGeneration: searchQueryGeneration,
      archiveLoading,
      archiveExhausted,
    });
    archiveContinuationState = transition.state;
    if (transition.requestToken === null) return false;
    if (!requestOlderHistory()) {
      settleArchiveContinuationRequest('timeout');
      return false;
    }
    return true;
  }

  function settleArchiveContinuationRequest(kind: ArchiveContinuationSettlement['kind']) {
    const token = archiveContinuationState.pendingRequestToken;
    if (token === null) return false;
    const settled = settleArchiveContinuation(
      archiveContinuationState,
      token,
      kind === 'committed'
        ? { kind, queryGeneration: searchQueryGeneration }
        : { kind },
    );
    archiveContinuationState = settled.state;
    return settled.shouldRerunSearch;
  }

  function jumpToSearchLine(line: number) {
    if (selectionActive) {
      pendingSearchJumpLine = line;
      return;
    }

    if (line < 0 || total === 0) return;
    // Cancel any in-flight flick before snapping — otherwise momentum scrolls
    // straight past the match we just centred.
    stopInertia();
    bottomOffsetPx = searchJumpBottomOffset({ line, total, lineH, viewH });
    applyScroll();
  }

  function onSearchNavigate(direction: SearchDirection) {
    if (!searchQuery || searchMatches.length === 0) return;

    const nextState = moveActiveIndex(searchActiveIndex, searchMatches.length, direction);
    updateSearchActiveRange(nextState.activeIndex);
    if (searchActiveIndex < 0) return;

    const match = searchMatches[searchActiveIndex];
    if (!match) return;

    if (direction === 'previous' && nextState.wrapped) {
      beginSearchContinuation();
    }

    jumpToSearchLine(match.line);
  }

  function setLines(
    nextLive: string[],
    replace = false,
    source: LinesChangeMeta['source'] = replace ? 'replace' : 'live',
  ) {
    if (replace) {
      // Resize/resync captures reflow only the current live window. Archived
      // rows remain physical history at their original width.
      liveLines = nextLive;
    } else if (bottomOffsetPx > 0 && liveLines.length > 0) {
      const merged = mergeCapturedLinesForStableScroll(liveLines, nextLive);
      liveLines = merged.lines;
      if (merged.appendedLineCount > 0) archiveExhausted = false;
    } else {
      liveLines = nextLive;
    }
    commitLines([...archivedLines, ...liveLines], {
      preserveReaderAnchor: !replace,
      source,
    });
  }

  function requestOlderHistory(): boolean {
    if (archiveLoading || archiveExhausted) return false;
    const requestId = ++archiveRequestSeq;
    archiveInflightRequestId = requestId;
    archiveLoading = true;
    archiveRequestActive = true;
    tmuxMux.requestHistory(session, archiveBeforeLine, HISTORY_BATCH_LINES);
    if (archiveRequestTimer) clearTimeout(archiveRequestTimer);
    archiveRequestTimer = setTimeout(() => {
      // Superseded by a newer request (or already finished) — ignore.
      if (archiveInflightRequestId !== requestId) return;
      const settled = settleArchiveContinuationRequest('timeout');
      if (searchQuery && settled) {
        requestSearchRerun();
      }
      archiveLoading = false;
      archiveRequestActive = false;
      archiveInflightRequestId = null;
      archiveRequestTimer = null;
    }, 5000);
    return true;
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

  function finishArchiveRequest(settlement?: ArchiveContinuationSettlement['kind']) {
    if (settlement) settleArchiveContinuationRequest(settlement);
    archiveLoading = false;
    archiveRequestActive = false;
    archiveInflightRequestId = null;
    if (archiveRequestTimer) {
      clearTimeout(archiveRequestTimer);
      archiveRequestTimer = null;
    }
  }

  function cancelScheduledPrependWork() {
    const cancel = cancelPrependWorkTask;
    cancelPrependWorkTask = null;
    cancel?.();
  }

  /** Run history parsing and commit only in background time after scrolling
   * settles. The callback checks busy again because a new gesture may begin
   * after the task was scheduled but before the browser invokes it. */
  function schedulePendingPrependWork() {
    if (destroyed || busy() || pendingPrependWork === null || cancelPrependWorkTask) return;

    const run = () => {
      cancelPrependWorkTask = null;
      if (destroyed || busy() || pendingPrependWork === null) return;
      const work = pendingPrependWork;
      pendingPrependWork = null;
      work();
    };

    if (typeof requestIdleCallback === 'function') {
      const taskId = requestIdleCallback(run, { timeout: 250 });
      cancelPrependWorkTask = () => {
        if (typeof cancelIdleCallback === 'function') cancelIdleCallback(taskId);
      };
      return;
    }

    const taskId = setTimeout(run, 0);
    cancelPrependWorkTask = () => clearTimeout(taskId);
  }

  function enqueuePrependWork(work: () => void) {
    if (destroyed) return;
    pendingPrependWork = work;
    schedulePendingPrependWork();
  }

  function commitStagedPrepend(stage: PrependStage) {
    if (stage.seq !== prependParseSeq || stage.lines.length === 0) {
      finishArchiveRequest('malformed');
      return;
    }

    const receivedLineCount = stage.lines.length;
    const activeIdentity = currentSearchActiveIdentity();
    const before = historyPrependSnapshot();
    const currentFirstState = stateBefore[0] ? cloneSgrState(stateBefore[0]) : createSgrState();
    const existingCacheValid = sgrStateKey(stage.endState) === sgrStateKey(currentFirstState);

    const retention = planPrependRetention(stage);
    const retainedStage = slicePrependStage(stage, retention.keepFrom);
    let droppedIncomingPrefix = retention.keepFrom;
    let lineCount = retainedStage.lines.length;

    if (lineCount === 0) {
      if (stage.startLine !== null) {
        const reloadBeforeLine = stage.startLine + droppedIncomingPrefix;
        if (Number.isSafeInteger(reloadBeforeLine)) {
          archiveBeforeLine = reloadBeforeLine;
        }
      }
      archiveExhausted = true;
      const shouldRerun = settleArchiveContinuationRequest('committed');
      if (searchQuery && shouldRerun) requestSearchRerun(activeIdentity);
      finishArchiveRequest();
      return;
    }

    // This suffix is below the mounted window by construction. Removing it
    // makes room for the newly requested older page without losing the rows
    // the reader is looking at (or turning page N into a no-op at the cap).
    const gapChanged = evictArchivedTail(retention.evictArchivedFrom) > 0;

    // Mutate the bounded columns in place: no prepend allocates/copies every
    // accumulated row into a new array. Work is capped by the retained budget.
    prependColumn(archivedLines, retainedStage.lines);
    prependColumn(rawLines, retainedStage.lines);
    prependColumn(htmlCache, retainedStage.html);
    prependColumn(stateBefore, retainedStage.entryStates);
    prependColumn(stateAfter, retainedStage.exitStates);
    prependLinks(retainedStage);
    rawEntryState = cloneSgrState(retainedStage.entryStates[0] ?? stage.endState);

    archiveOffset -= lineCount;
    total = rawLines.length;
    winStart += lineCount;
    winEnd += lineCount;

    if (!existingCacheValid) reconcileExistingFrom(lineCount, stage.endState);
    rerenderPrependSeam(retainedStage);
    if (gapChanged) rebuildGapLinkSeam();
    recalculateRetainedEstimatedBytes();

    // Reconciliation can enlarge HTML (for example a persistent SGR state).
    // Enforce the byte cap again using only rows below the protected window.
    const postRenderTailStart = tailEvictionStartForCurrentBudget(winEnd);
    if (postRenderTailStart < archivedLines.length) {
      evictArchivedTail(postRenderTailStart);
      rebuildGapLinkSeam();
      total = rawLines.length;
      recalculateRetainedEstimatedBytes();
    }

    // If the live/protected suffix leaves insufficient room, trim more of the
    // incoming prefix. It is entirely above the pre-existing mounted window.
    let extraPrefix = 0;
    let projectedRows = rawLines.length;
    let projectedBytes = retainedEstimatedBytes;
    while (extraPrefix < lineCount && (
      projectedRows > HISTORY_RETAINED_ROW_BUDGET ||
      projectedBytes > HISTORY_RETAINED_BYTE_BUDGET
    )) {
      projectedRows--;
      projectedBytes -= estimatedLineStorageBytes(
        rawLines[extraPrefix] ?? '',
        htmlCache[extraPrefix] ?? '',
        linksByLine[extraPrefix],
      );
      extraPrefix++;
    }
    if (extraPrefix > 0) {
      dropRetainedPrependPrefix(extraPrefix);
      droppedIncomingPrefix += extraPrefix;
      lineCount -= extraPrefix;
      total = rawLines.length;
      recalculateRetainedEstimatedBytes();
    }

    if (droppedIncomingPrefix > 0 && stage.startLine !== null) {
      const reloadBeforeLine = stage.startLine + droppedIncomingPrefix;
      if (Number.isSafeInteger(reloadBeforeLine)) {
        archiveBeforeLine = reloadBeforeLine;
        archiveExhausted = false;
      }
    }

    if (lineCount === 0) {
      // A page rejected in full must not recolor/relink retained rows through
      // an invisible SGR/URL transition. Keep any safe off-window eviction,
      // restore the retained model from its previous entry checkpoint, and do
      // not emit a zero-row prepend event.
      rawEntryState = currentFirstState;
      archiveExhausted = true;
      rebuildAllLinks();
      rebuildFrom(0);
      total = rawLines.length;
      contentEpoch++;
      applyScroll();
      if (onLinesChange) onLinesChange([...rawLines], { source: 'prepend' });
      emitScrollState();
      const shouldRerun = settleArchiveContinuationRequest('committed');
      if (searchQuery && shouldRerun) requestSearchRerun(activeIdentity);
      finishArchiveRequest();
      return;
    }

    contentEpoch++;
    applyScroll();
    const after = historyPrependSnapshot();
    const meta = import.meta as unknown as { env?: { DEV?: boolean } };
    if (meta.env?.DEV) {
      console.assert(
        before.transform === after.transform,
        'TermView history prepend changed the scroll transform',
        { before: before.transform, after: after.transform, lineCount, receivedLineCount },
      );
    }
    requestAnimationFrame(() => {
      emitHistoryPrependEvent(lineCount, existingCacheValid, before, after);
    });
    if (onLinesChange) onLinesChange([...rawLines], { source: 'prepend' });
    emitScrollState();
    const shouldRerun = settleArchiveContinuationRequest('committed');
    if (searchQuery || shouldRerun) {
      requestSearchRerun(activeIdentity);
    }
    finishArchiveRequest();
  }

  function schedulePrependCommit(stage: PrependStage) {
    enqueuePrependWork(() => commitStagedPrepend(stage));
  }

  function stageHistoryPrepend(lines: string[], startLine: number | null) {
    if (lines.length === 0) {
      finishArchiveRequest('empty');
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
      if (seq !== prependParseSeq) return;
      const stop = Math.min(batch.length, idx + HISTORY_PARSE_CHUNK_LINES);
      for (; idx < stop; idx++) {
        entryStates[idx] = cloneSgrState(st);
        html[idx] = lineToHtml(batch[idx], st, palette, linkPlan.batchLinks[idx]);
        exitStates[idx] = cloneSgrState(st);
      }
      if (idx < batch.length) {
        enqueuePrependWork(parseSlice);
        return;
      }
      const endState = cloneSgrState(st);
      schedulePrependCommit({
        seq,
        startLine,
        lines: batch,
        html,
        entryStates,
        exitStates,
        endState,
        linkPlan,
      });
    };

    enqueuePrependWork(parseSlice);
  }

  function processArchivedHistory(data: string) {
    let payload: unknown = null;
    try {
      payload = JSON.parse(data);
    } catch {
      finishArchiveRequest('malformed');
      return;
    }

    const candidate = payload as { lines?: unknown; startLine?: unknown; hasMore?: unknown };
    const validStartLine = candidate.startLine === undefined || candidate.startLine === null || (
      typeof candidate.startLine === 'number' &&
      Number.isSafeInteger(candidate.startLine) &&
      candidate.startLine >= 0
    );
    if (
      !payload ||
      typeof payload !== 'object' ||
      Array.isArray(payload) ||
      !Array.isArray(candidate.lines) ||
      !candidate.lines.every((line) => typeof line === 'string') ||
      typeof candidate.hasMore !== 'boolean' ||
      !validStartLine
    ) {
      finishArchiveRequest('malformed');
      return;
    }

    const history = candidate as { lines: string[]; startLine?: number | null; hasMore: boolean };
    const lines = history.lines;
    const historyStartLine = typeof history.startLine === 'number' ? history.startLine : null;
    archiveBeforeLine = historyStartLine;
    // A nonempty page without a numeric cursor can be rendered once, but it
    // cannot be advanced safely: requesting before null would duplicate it.
    archiveExhausted = historyStartLine === null || !history.hasMore || lines.length === 0;
    if (lines.length === 0) {
      const settlement = archiveExhausted ? 'exhausted' : 'empty';
      finishArchiveRequest(settlement);
      return;
    }

    stageHistoryPrepend(lines, historyStartLine);
  }

  function applyArchivedHistory(data: string) {
    // Only the currently inflight request may consume a reply. A timed-out or
    // otherwise abandoned request leaves archiveInflightRequestId null, so a
    // late/lost-then-replayed frame is discarded without locking retries out.
    if (!archiveRequestActive || archiveInflightRequestId === null) return;

    if (archiveRequestTimer) {
      clearTimeout(archiveRequestTimer);
      archiveRequestTimer = null;
    }

    // Claim the wire reply immediately so a duplicate cannot overwrite the
    // queued raw page. Keep archiveLoading true until validation/commit ends.
    const requestId = archiveInflightRequestId;
    archiveRequestActive = false;
    enqueuePrependWork(() => {
      if (archiveInflightRequestId !== requestId || !archiveLoading) return;
      processArchivedHistory(data);
    });
  }

  function contentUpdateBlock() {
    return { busy: busy(), selectionActive };
  }

  function applyContentDelivery(delivery: ContentUpdate) {
    if (delivery.cursor !== undefined) cursor = delivery.cursor;
    setLines(
      delivery.data.replace(/\r/g, '').split('\n'),
      delivery.meta.replace,
      contentLinesChangeSource(delivery),
    );
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
    schedulePendingPrependWork();
  }

  function flushDeferredPresentation() {
    if (busy() || selectionActive) return;

    // Deferred search re-parse first (may itself request presentation).
    if (searchRerunPending) {
      const identity = pendingSearchRerunIdentity;
      clearSearchRerunDeferral();
      requestSearchRerun(identity);
      // Rerun already presented when not re-deferred; drop a stale paint flag.
      searchPresentationPending = false;
    }

    let bumpRenderEpoch = false;
    if (paletteRefreshPending) {
      paletteRefreshPending = false;
      if (rawLines.length) {
        rebuildFrom(0);
        invalidateSearchOverlayHtml();
        bumpRenderEpoch = true;
      }
    }
    if (renderRefreshPending) {
      renderRefreshPending = false;
      bumpRenderEpoch = true;
    }
    if (searchPresentationPending) {
      searchPresentationPending = false;
      bumpRenderEpoch = true;
    }
    if (bumpRenderEpoch) renderEpoch++;
    applyScroll();
  }

  function schedulePendingContentFlush() {
    if (pendingContentFlushFrame !== null) return;
    pendingContentFlushFrame = requestAnimationFrame(() => {
      pendingContentFlushFrame = null;
      flushPendingContent();
    });
  }

  type VisibleRowRange = { startIdx: number; endIdx: number };

  function visibleRowRange(bottomOffset: number): VisibleRowRange {
    const mo = maxOffset();
    const scrollTop = mo - Math.max(0, Math.min(bottomOffset, mo));
    return {
      endIdx: Math.min(total, Math.ceil((scrollTop + viewH) / lineH) + 1),
      startIdx: Math.max(0, Math.floor(scrollTop / lineH) - 1),
    };
  }

  function rebuildWindow({ startIdx, endIdx }: VisibleRowRange) {
    winStart = Math.max(0, startIdx - OVERSCAN_ROWS);
    winEnd = Math.min(total, endIdx + OVERSCAN_ROWS);
  }

  function prebuildMomentumWindow(velocity: number) {
    const current = visibleRowRange(bottomOffsetPx);
    // The exponential integrator's remaining displacement is strictly less
    // than velocity * tau, so this uncapped corridor covers every normal frame.
    const projected = visibleRowRange(bottomOffsetPx + velocity * MOMENTUM_TAU);
    winStart = Math.max(0, Math.min(
      winStart,
      current.startIdx - OVERSCAN_ROWS,
      projected.startIdx - OVERSCAN_ROWS,
    ));
    winEnd = Math.min(total, Math.max(
      winEnd,
      current.endIdx + OVERSCAN_ROWS,
      projected.endIdx + OVERSCAN_ROWS,
    ));
    momentumWindowFrozen = true;
  }

  // --- virtual window + transform (the 120Hz hot path) ---
  function applyScroll(): boolean {
    // The browser selection owns the currently mounted native text nodes.
    // Do not move its virtual window until the selection has been released.
    if (selectionActive) return true;
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

    const outsideWindow = startIdx < winStart - 1 || endIdx > winEnd;
    let windowCovered = true;
    if (momentumWindowFrozen && busy() && outsideWindow) {
      // Geometry/content invalidated the projected corridor. End inertia and
      // rebuild at the true offset in this callback, before the browser can
      // paint an uncovered transform. The owner sees false and does not queue
      // another momentum/spring frame.
      stopInertia();
      momentumWindowFrozen = false;
      rebuildWindow({ startIdx, endIdx });
      windowCovered = false;
    }

    if (windowCovered) {
      // Momentum owns a prebuilt corridor and must never reconcile keyed rows.
      // Once idle, force-shrink that corridor around the actual settled view.
      if (momentumWindowFrozen && !busy()) {
        momentumWindowFrozen = false;
        rebuildWindow({ startIdx, endIdx });
      } else if (!momentumWindowFrozen && outsideWindow) {
        rebuildWindow({ startIdx, endIdx });
      }
    }

    if (layerEl) {
      const y = winStart * lineH - scrollTop - (overshoot * 0.35);
      layerEl.style.transform = `translate3d(0, ${y.toFixed(2)}px, 0)`;
    }
    emitScrollState();
    if (!busy()) settledBottomOffsetPx = Math.round(bottomOffsetPx);
    if (!windowCovered && !busy()) schedulePendingContentFlush();
    return windowCovered;
  }

  function scrollBy(dyPx: number): boolean {
    bottomOffsetPx += dyPx;
    const windowCovered = applyScroll();
    if (dyPx > 0) maybeRequestOlderHistory();
    return windowCovered;
  }

  function emitScrollState() {
    const scrolledUp = bottomOffsetPx > lineH;
    if (scrolledUp === scrollStateScrolledUp) return;
    scrollStateScrolledUp = scrolledUp;
    onScrollStateChange?.({
      bottomOffset: Math.round(bottomOffsetPx),
      scrolledUp,
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

  function contentHitArea(): ContentHitArea | null {
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

  function refreshAltTouchHitArea() {
    if (altTouchY === null) return;
    altTouchHitArea = contentHitArea();
  }

  // Trackpads emit dozens of sub-line pixel deltas per second — accumulate a
  // fractional remainder and flush only WHOLE lines per animation frame (same
  // scale + accumulation as the local-scroll wheel path), otherwise every
  // micro-event would be inflated to a full SGR wheel line.
  let altWheelRemainder = 0;
  let altWheelFrame: number | null = null;
  let altWheelCell: { cx: number; cy: number } | null = null;

  function queueAltWheelDelta(
    clientX: number,
    clientY: number,
    delta: { deltaY: number; deltaMode: number },
    area: ContentHitArea | null = contentHitArea(),
  ): boolean {
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
      sel && !sel.isCollapsed && !selectionInSearchPanel(sel) && viewportEl && (
        (sel.anchorNode && viewportEl.contains(sel.anchorNode)) ||
        (sel.focusNode && viewportEl.contains(sel.focusNode))
      )
    );
    if (wasActive && !selectionActive) {
      const pendingJump = pendingSearchJumpLine;
      pendingSearchJumpLine = null;
      schedulePendingContentFlush();
      if (pendingJump !== null) {
        requestAnimationFrame(() => jumpToSearchLine(pendingJump));
      }
    }
  }

  function hasSelectionInView(): boolean {
    const sel = typeof window !== 'undefined' ? window.getSelection?.() : null;
    return !!(
      sel && !sel.isCollapsed && !selectionInSearchPanel(sel) && viewportEl && (
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
      if (momentumWindowFrozen) applyScroll();
      tapStart = null;
      touching = false;
      altTouchMoved = false;
      const touch = e.touches.item(0);
      altTouchY = e.touches.length === 1 && touch ? touch.clientY : null;
      altTouchHitArea = altTouchY === null ? null : contentHitArea();
      return;
    }
    stopInertia();
    if (momentumWindowFrozen) applyScroll();
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
          altTouchHitArea = null;
          return; // let iOS drag the selection handles
        }
      }
      const touch = e.touches.item(0);
      if (e.touches.length !== 1 || !touch || altTouchY === null) {
        altTouchY = null;
        altTouchHitArea = null;
        return;
      }
      e.stopPropagation();
      if (e.cancelable) e.preventDefault();
      const dy = touch.clientY - altTouchY;
      altTouchY = touch.clientY;
      if (dy !== 0) {
        altTouchMoved = true;
        queueAltWheelDelta(
          touch.clientX,
          touch.clientY,
          { deltaY: -dy, deltaMode: 0 },
          altTouchHitArea,
        );
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
      const windowCovered = applyScroll();
      if (!windowCovered) {
        springFrame = null;
        bottomOffsetPx = Math.max(0, Math.min(bottomOffsetPx, maxOffset()));
        flushPendingContent();
        return;
      }
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

  function stopSearchOverlayEvent(event: Event) {
    event.stopPropagation();
  }

  function isSearchEditableTarget(target: EventTarget | null): boolean {
    if (!(target instanceof Element)) return false;
    return !!target.closest('input,textarea,select,button,a,[contenteditable]');
  }

  function resolveKeydownCaptureHost(): HTMLElement | null {
    if (!viewportEl) return null;
    return viewportEl.closest('.desktop-keys') ?? viewportEl;
  }

  function onTermViewKeydown(event: KeyboardEvent) {
    const target = event.target;
    if (!isSearchTarget(target)) return;

    const intent = searchKeyIntent(event, 'terminal');
    if (!intent) return;

    if (intent === 'open') {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      updateSearchOpen(true);
      return;
    }

    if (!searchOpen || isSearchEditableTarget(target)) return;

    if (intent === 'close') {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      updateSearchOpen(false);
      return;
    }

    if (intent === 'next' || intent === 'previous') {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      onSearchNavigate(intent);
      return;
    }
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
      altTouchHitArea = null;
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
    if (dragFrame !== null) { cancelAnimationFrame(dragFrame); flushDrag(); }
    // Keep the final queued drag inside the gesture. Otherwise applyScroll()
    // would publish an intermediate diagnostic value immediately before
    // momentum starts, producing two settle mutations for one fling.
    const mo = maxOffset();
    if (bottomOffsetPx < 0 || bottomOffsetPx > mo) {
      touching = false;
      springBack();
      return;
    }
    let vel = touchVel;
    if (Math.abs(vel) < 0.04) {
      touching = false;
      flushPendingContent();
      return;
    }
    const TAU = MOMENTUM_TAU;
    vel *= MOMENTUM_GAIN;
    prebuildMomentumWindow(vel);
    applyScroll();
    touching = false;
    if (vel > 0) maybeRequestOlderHistory(bottomOffsetPx + vel * MOMENTUM_TAU);
    let lastT = performance.now();
    const step = () => {
      const now = performance.now();
      const dt = Math.min(64, Math.max(1, now - lastT));
      lastT = now;
      const decay = Math.exp(-dt / TAU);
      const windowCovered = scrollBy(vel * TAU * (1 - decay));
      vel *= decay;
      if (!windowCovered) {
        momentumFrame = null;
        flushPendingContent();
        return;
      }
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
  let observedVisualViewport: VisualViewport | null = null;

  onMount(() => {
    viewH = viewportEl?.clientHeight ?? 0;
    updateSelectionActive();
    keydownCaptureHost = resolveKeydownCaptureHost();
    keydownCaptureHost?.addEventListener('keydown', onTermViewKeydown, { capture: true });
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
        if (cur !== undefined) {
          contentUpdateGate = updatePendingContentCursor(contentUpdateGate, cur);
          cursor = cur;
        }
        return;
      }
      receiveLiveContent(data, cur, meta);
    });
    pushGeometry({ force: true });
    requestAnimationFrame(() => pushGeometry({ force: true }));
    resizeObs = new ResizeObserver(() => {
      viewH = viewportEl?.clientHeight ?? viewH;
      pushGeometry();
      refreshAltTouchHitArea();
      applyScroll();
    });
    if (viewportEl) resizeObs.observe(viewportEl);
    observedVisualViewport = window.visualViewport;
    observedVisualViewport?.addEventListener('resize', refreshAltTouchHitArea, { passive: true });
    observedVisualViewport?.addEventListener('scroll', refreshAltTouchHitArea, { passive: true });
    window.addEventListener('pageshow', onReturn);
    document.addEventListener('visibilitychange', onReturn);
    document.addEventListener('selectionchange', updateSelectionActive);
  });

  onDestroy(() => {
    // Svelte 5 runs onDestroy during SSR too — guard all browser APIs.
    if (typeof window === 'undefined') return;
    destroyed = true;
    stopInertia();
    if (dragFrame !== null) cancelAnimationFrame(dragFrame);
    if (pendingContentFlushFrame !== null) cancelAnimationFrame(pendingContentFlushFrame);
    cancelScheduledPrependWork();
    pendingPrependWork = null;
    prependParseSeq++;
    if (altWheelFrame !== null) { cancelAnimationFrame(altWheelFrame); altWheelFrame = null; }
    if (archiveRequestTimer) {
      clearTimeout(archiveRequestTimer);
      archiveRequestTimer = null;
    }
    if (unsubscribe) unsubscribe();
    resizeObs?.disconnect();
    observedVisualViewport?.removeEventListener('resize', refreshAltTouchHitArea);
    observedVisualViewport?.removeEventListener('scroll', refreshAltTouchHitArea);
    observedVisualViewport = null;
    window.removeEventListener('pageshow', onReturn);
    document.removeEventListener('visibilitychange', onReturn);
    document.removeEventListener('selectionchange', updateSelectionActive);
    keydownCaptureHost?.removeEventListener('keydown', onTermViewKeydown, { capture: true });
    keydownCaptureHost = null;
    // Drop deferred search work so a destroyed view cannot flush into a dead tree.
    clearSearchRerunDeferral();
    searchPresentationPending = false;
    pendingSearchJumpLine = null;
    settleArchiveContinuationRequest('destroy');
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
        invalidateSearchOverlayHtml();
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
  data-retained-estimated-bytes={retainedEstimatedBytes}
  data-retained-byte-budget={HISTORY_RETAINED_BYTE_BUDGET}
  data-bottom-offset={settledBottomOffsetPx}
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
  {#if searchOpen}
    <div
      bind:this={searchPanelEl}
      class="mtv-search"
      onpointerdown={stopSearchOverlayEvent}
      onpointerup={stopSearchOverlayEvent}
      ontouchstart={stopSearchOverlayEvent}
      ontouchmove={stopSearchOverlayEvent}
      ontouchend={stopSearchOverlayEvent}
      onclick={stopSearchOverlayEvent}
      onwheel={stopSearchOverlayEvent}
    >
      <TermSearch
        bind:this={searchComponent}
        query={searchQuery}
        matchCount={searchMatches.length}
        activeIndex={searchActiveIndex}
        error={searchError}
        onQueryChange={updateSearchQuery}
        onNavigate={onSearchNavigate}
        onClose={() => updateSearchOpen(false)}
      />
    </div>
  {/if}
  <div bind:this={layerEl} class="mtv-layer">
    {#key renderEpoch}
      {#each { length: winEnd - winStart } as _, i (archiveOffset + winStart + i)}
        {@const lineIdx = winStart + i}
        <div class="mtv-line" data-line-id={archiveOffset + lineIdx}>{@html cachedLineHtml(lineIdx, contentEpoch)}</div>
      {/each}
    {/key}
    {#if cursor && connected && !scrollStateScrolledUp && charW > 0}
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
  .mtv-search {
    position: absolute;
    top: 0.45rem;
    left: 0.45rem;
    z-index: 4;
    max-width: min(24rem, calc(100% - 0.9rem));
    pointer-events: auto;
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
  :global(.search-match) {
    background: rgba(173, 216, 230, 0.23);
  }
  :global(.search-active) {
    background: rgba(250, 224, 66, 0.26);
    outline: 1px solid rgba(255, 255, 255, 0.2);
    outline-offset: -1px;
  }

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
