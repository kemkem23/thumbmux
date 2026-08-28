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
   * re-claimed when the app returns to foreground). With SGR mouse routing on
   * (static altScreenMouse, or live screen.mouseSgr when screen is present),
   * wheel and touch-drag input are forwarded as SGR mouse events here, so
   * hosts do not need a separate touch capture shim. A live `screen` prop also
   * suppresses scrollback when screen.alt is true (alternate screen has none).
   */
  import { onMount, onDestroy, untrack } from 'svelte';
  import { tmuxMux } from './ws-mux.svelte';
  import TermSearch from './TermSearch.svelte';
  import {
    contentLinesChangeSource, createContentUpdateGate, flushContentUpdate, receiveContentUpdate,
    updatePendingContentCursor,
    type ContentUpdate,
  } from './content-update-gate';
  import {
    admitLiveBoundary,
    createLiveBoundaryAdmission,
  } from './live-boundary-admission';
  import {
    applyHistoryWindowPage,
    createHistoryWindow,
    historyWindowEndLine,
    historyWindowRequestCursor,
    type HistoryWindowDirection,
    type HistoryWindowLimits,
    type HistoryWindowState,
  } from './history-window';
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
    findLineOverlap,
    mergeCapturedLinesForStableScroll,
    charCellWidth, prefixForCells, stringCells, stripAnsi, paneTextForCopy,
    contentCellFromPoint, centerContentCell,
    sgrWheel, sgrClick, sgrSnapToBottom, DEFAULT_WHEEL_MAX_PER_CALL,
    wheelDeltaToLines, consumeWholeWheelLines,
    muxHistoryBoundaryTransition,
    type MuxHistoryBoundary,
    detectClaudeBashBlocks,
    groupClaudeBashBlocks,
    projectClaudeBashGroupedLines,
    type ClaudeBashBlock,
    type ClaudeBashGroup,
    type ClaudeBashDetection,
    type ClaudeBashMode,
    type ClaudeBashGroupedProjection,
    type ClaudeBashGroupedProjectionRow,
    type ClaudeBashGroupedSummaryRequest,
    type ClaudeBashSummaries,
    type ClaudeBashSummaryRequest,
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
    maxRows = 60,
    bottomInsetPx = 0,
    claimGeometry = true,
    altScreenMouse = false,
    /**
     * Default is `undefined` (host did not pass the prop) so live screen mode
     * from mux meta can drive routing. An explicit `null` or object wins —
     * hosts that know better (demo, static alt-screen surfaces) stay in charge.
     */
    screen = undefined,
    onKeys = undefined,
    onTap = undefined,
    /**
     * When true, a touchend that actually fires `onTap` is cancelled
     * (stopPropagation + preventDefault) so the browser's compatibility
     * mouse sequence cannot steal focus from an input the host just focused
     * inside the gesture stack (TM-03). Default false = v0.10.1 event flow.
     * Moved / long / selection / link taps never cancel.
     */
    cancelSyntheticClickOnTap = false,
    historyPaging = 'sliding',
    onLinesChange = undefined,
    onGeometryChange = undefined,
    onScrollStateChange = undefined,
    /** Presentation-only Claude Code Bash compaction. Raw terminal rows remain
     * canonical for copy, search, retention, history, and ANSI state. */
    claudeBashMode = 'off',
    claudeBashSummaries = undefined,
    /** Lifecycle-bounded Bash groups selected for distillation. A cold view
     * requests at most the newest ten groups; later live output queues only its
     * newest completed group. Return summaries by id; rejection/missing ids
     * settle to a deterministic fallback. Active groups are never sent. */
    onClaudeBashSummaryRequest = undefined,
  }: {
    session: string;
    palette: AnsiPalette;
    fontPx?: number;
    minCols?: number;
    minRows?: number;
    maxRows?: number;
    /** Visual-only inset: the host shrank this many px (composer docked below).
     * Geometry math adds it back so the tmux pane is NEVER resized by a
     * transient overlay — only the scroll pin follows the shorter viewport. */
    bottomInsetPx?: number;
    claimGeometry?: boolean;
    /** Forward wheel, clean click, and touch-drag gestures as SGR mouse input
     * for alt-screen TUIs. Ignored for pointer routing when `screen` is set —
     * then `screen.mouseSgr` wins. */
    altScreenMouse?: boolean;
    /** Explicit host override of pane screen mode (tmux #{alternate_on} /
     * #{mouse_sgr_flag} / #{mouse_any_flag}). When the prop is omitted
     * (`undefined`), live `meta.screen` from the mux subscription is used.
     * An explicit `null` or object always wins over the wire. Structural
     * inline type so this file compiles alone. */
    screen?: { alt: boolean; mouseSgr: boolean; mouseAny: boolean } | null;
    onKeys?: (data: string) => void;
    /** Fired on a CLEAN tap (short, low-movement, not a link, no selection) —
     * call your composer's openDock() here, synchronously, so iOS raises the
     * keyboard (gesture call stack). */
    onTap?: () => void;
    /** Opt-in: cancel the touchend that fired `onTap` so the synthesized
     * mousedown/click cannot blur the focused input (default false). */
    cancelSyntheticClickOnTap?: boolean;
    /** Bounded bidirectional archive paging is the default. `ceiling` keeps
     * the pre-0.17 backward-only retention path as an instant rollback. */
    historyPaging?: 'ceiling' | 'sliding';
    onLinesChange?: (lines: string[], meta: LinesChangeMeta) => void;
    onGeometryChange?: (geometry: { cols: number; rows: number }) => void;
    onScrollStateChange?: (state: { bottomOffset: number; scrolledUp: boolean }) => void;
    claudeBashMode?: ClaudeBashMode;
    claudeBashSummaries?: ClaudeBashSummaries;
    onClaudeBashSummaryRequest?: (
      requests: readonly ClaudeBashSummaryRequest[],
    ) => ClaudeBashSummaries | void | Promise<ClaudeBashSummaries | void>;
  } = $props();

  /**
   * Screen mode sampled from the last mux delivery that carried `meta.screen`.
   * Only used when the host did not pass the `screen` prop explicitly.
   */
  let liveScreen = $state<{ alt: boolean; mouseSgr: boolean; mouseAny: boolean } | null>(null);
  let liveScreenSeen = $state(false);

  /**
   * Effective screen mode: explicit prop (including null) wins; otherwise the
   * sticky live value from wire meta when one has been observed.
   */
  const resolvedScreen = $derived(
    screen !== undefined
      ? screen
      : (liveScreenSeen ? liveScreen : null),
  );

  /** Pointer routing: live/explicit screen.mouseSgr wins; otherwise static
   *  altScreenMouse — but ONLY when there is somewhere to send the bytes.
   *
   *  Without this guard, 0.10.0 silently removed tap and scroll from every
   *  view-only surface in existence. A host that mounts a preview passes no
   *  `onKeys` because it never wanted input; it also passed
   *  `altScreenMouse={false}` and got local scrolling. Then the server started
   *  sampling `screen`, a grok pane reported `mouseSgr` (it does even inline),
   *  routing flipped to SGR, and every event went to `sendSgr`, which had
   *  nothing to call. The surface kept rendering and stopped responding, with a
   *  warning that only existed in DEV builds.
   *
   *  So the destination is part of the condition. No `onKeys` means the wire
   *  cannot take pointer input away from a host that never asked for it. */
  const canRouteSgr = $derived(typeof onKeys === 'function');
  const useSgrMouse = $derived(
    canRouteSgr && (resolvedScreen != null ? resolvedScreen.mouseSgr : altScreenMouse),
  );
  /** Alternate screen has no scrollback — suppress history expand/prepend.
   * Unknown screen (no sample yet, no explicit prop) is treated as **normal**
   * — asking is harmless; blocking until a sample arrives silently killed
   * history for every host that never populates `screen` (34f7afe regression). */
  const noScrollback = $derived(resolvedScreen != null && resolvedScreen.alt);
  /** Diagnostic only: a sample or explicit prop has arrived. Never a request gate. */
  const screenModeKnown = $derived(screen !== undefined || liveScreenSeen);

  /**
   * Drop `.mtv-w1` / `.mtv-wx` when an ancestor opted out. Not a TermView
   * prop (F-tier surface stays frozen): SessionView sets
   * `data-mtv-unpin-narrow` from `sessionPresentation.pinNarrowCells`.
   * Dual-width `.mtv-w2` from CJK/emoji is left alone.
   */
  function applyPinPolicy(html: string): string {
    if (!viewportEl?.closest?.('[data-mtv-unpin-narrow]')) return html;
    return html
      .replace(/<span class="mtv-w1(?: mtv-fit)?">([^<]*)<\/span>/g, '$1')
      .replace(/<span class="mtv-wx" style="--mtv-cells:\d+">([^<]*)<\/span>/g, '$1');
  }

  function htmlLine(
    raw: string,
    st: SgrState,
    links?: LineLinkRange[],
    overlays?: LineOverlayRange[],
  ): string {
    return applyPinPolicy(lineToHtml(raw, st, palette, links, overlays));
  }

  const LINE_RATIO = 1.6;
  const OVERSCAN_ROWS = 60;
  const RUBBER_PX = 90;
  const HISTORY_BATCH_LINES = 2000;
  const HISTORY_REPLY_TIMEOUT_MS = 5_000;
  const HISTORY_PARSE_CHUNK_LINES = 300;
  const HISTORY_LINK_SEAM_LINES = 12;
  const HISTORY_GAP_LINK_ROWS = 128;
  const HISTORY_RETAINED_ROW_BUDGET = 10_000;
  const HISTORY_RETAINED_BYTE_BUDGET = 8 * 1024 * 1024;
  /** Human-readable copy for the retention-ceiling note (also the aria-label). */
  const HISTORY_CEILING_LABEL =
    'Older history is not loaded. This viewer keeps at most 10,000 rows or about 8 mebibytes; more rows may still exist on the server.';
  const HISTORY_WINDOW_LABEL =
    'History is shown through a bounded sliding window. Scroll to either edge to load the adjacent archive page.';
  const NO_SCROLLBACK_LABEL =
    'This session is on the alternate screen. There is no scrollback history; only the current full-screen view is shown.';
  // The authorized 100k-row Chrome benchmark chose 300 over 256 to retain
  // fewer states while keeping measured cold-window rebuild p95 below 1 ms.
  const SGR_CHECKPOINT_INTERVAL = 300;
  // Raw/archive/link array slots, string header, and the amortized sparse SGR
  // checkpoint. Rendered HTML and per-line entry states exist only for the
  // bounded DOM window and are not retained per history row.
  const HISTORY_ROW_OVERHEAD_BYTES = 64;
  const ARCHIVE_OFFSET_START = 1 << 26;
  const MOMENTUM_TAU = 520;
  const MOMENTUM_GAIN = 1.25;

  let viewportEl = $state<HTMLDivElement | null>(null);
  // Last measured physical bottom edge. A height alone cannot tell whether a
  // viewport shrank from its top (HUD growth) or bottom (docked controls).
  let viewportBottom: number | null = null;
  let cursor = $state<{ row: number; col: number } | null>(null);
  let charW = $state(0);
  let layerEl = $state<HTMLDivElement | null>(null);
  let viewH = $state(0);
  let lineH = $derived(Math.round(fontPx * LINE_RATIO));

  // --- content model ---
  let rawLines: string[] = [];
  let liveLines: string[] = [];
  let archivedLines: string[] = [];
  /**
   * A legacy (boundary-less) capture can advance farther than content overlap
   * can prove while a reader is off the live tail. Replacing the mounted model
   * in that state preserves only a pixel index, not the row the person was
   * reading. Keep the newest canonical capture offscreen until the reader
   * explicitly rejoins; one bounded capture is retained, never a frame queue.
   */
  let deferredLegacyLiveCapture = $state.raw<{
    lines: string[];
    source: LinesChangeMeta['source'];
    replace: boolean;
    boundary?: MuxHistoryBoundary;
  } | null>(null);
  // Visual projection is a second coordinate space, never a replacement for
  // rawLines. Every projected row owns a half-open raw range and every raw row
  // maps back to one visual row. This is what lets Bash blocks occupy one row
  // without corrupting copy/search/history or the stateful ANSI parser.
  // `null` is the zero-allocation off-mode identity projection. Keeping the
  // frozen default path avoids an O(rawRows) row-object rebuild on every live
  // frame and preserves the pre-feature cache/retention behaviour exactly.
  let bashProjection: ClaudeBashGroupedProjection | null = null;
  /**
   * Hide markers are one third of a terminal row. Keep their visual indexes as
   * a sparse column (the detector retains at most 512 blocks) instead of
   * rebuilding a 10k-entry prefix sum after every live-tail repaint.
   *
   * Geometry is expressed in integer thirds: a terminal/Haiku row is 3 units,
   * a hide marker is 1. Pixel conversion happens only at the boundary, using
   * `lineH / 3`, so every caller shares the exact same fractional coordinates.
   */
  const PRESENTATION_UNITS_PER_LINE = 3;
  let compactBashVisualRows: number[] = [];
  let compactBashVisualRowSet = new Set<number>();
  let cachedClaudeBashDetection: ClaudeBashDetection | null = null;
  let cachedClaudeBashDetectionRawLength = 0;
  let cachedClaudeBashDetectionScreenMode: 'normal' | 'alternate' | 'unknown' | null = null;
  let cachedClaudeBashBarrierKey = '';
  let lastClaudeBashProjectionRebuildStart = 0;
  let lastClaudeBashProjectionSummaryKey = '';
  let htmlCache = new Map<number, string>();
  let bashPlaceholderHtmlCache = new Map<number, string>();
  let bashPlaceholderEntryStates = new Map<number, SgrState>();
  let renderEntryStates = new Map<number, SgrState>();
  let sgrCheckpoints = new Map<number, SgrState>(); // state before sparse row
  // Older discontinuities move inside archivedLines when another safe middle
  // cut is needed. Keep only one SGR entry checkpoint and count per such gap;
  // raw terminal rows and rendered HTML remain absent.
  let archivedRetentionGaps = new Map<number, { rowCount: number; entryState: SgrState }>();
  let rawEntryState: SgrState = createSgrState();
  // When newer archived rows are evicted, the retained archive and live tail
  // have a gap. Preserve the renderer state on the live side of that gap.
  let liveGapEntryState: SgrState | null = null;
  // Presentation-only metadata for that gap. It never enters rawLines, render
  // caches, search/copy, byte accounting, or onLinesChange payloads.
  let gapRowIndex = $state(-1);
  let gapRowCount = $state(0);
  let retainedEstimatedBytes = $state(0);
  let renderCacheRows = $state(0);
  let sgrCheckpointCount = $state(0);
  let renderCacheBuilds = $state(0);
  let total = $state(0);
  let connected = $state(false);
  let archiveBeforeLine: number | null = null;
  /** Sliding mode keeps archived absolute identity separate from the current
   * pane capture. `$state.raw` avoids proxying up to 10k immutable rows. */
  let archiveWindow = $state.raw<HistoryWindowState | null>(null);
  let archiveWindowAttachedToLive = $state(true);
  /** Live captures received while the reader owns a detached archive are kept
   * offscreen. Remember that projection work is owed so reattaching can admit
   * exactly the newest completed live Bash group without replaying archive
   * backlog through the Distill queue. */
  let detachedLiveProjectionPending = false;
  /** Last mux-validated durable seam paired with the current live capture. */
  let liveBoundary = $state.raw<MuxHistoryBoundary | null>(null);
  /** Rows retained ahead of the current durable seam solely to keep an
   * archive-less reader stable while its first history page is in flight.
   * Their identity comes from monotonic boundary movement, never content
   * matching; the page consumes this prefix exactly when it reaches the seam. */
  let retainedLivePrefixBeforeBoundary = 0;
  /** Newest total observed in a history reply (may lead the next output tick). */
  let archiveTotalHint = 0;
  let archiveLoading = false;
  let archiveExhausted = false;
  /**
   * Why further upward history expansion has stopped.
   * - `'none'` — still eligible to ask (or never tried).
   * - `'exhausted'` — server reported the true start of archived history
   *   (`hasMore: false` / null cursor). The top row *is* the start.
   * - `'ceiling'` — client retention budget (10k rows / ~8 MiB) is full, so
   *   TermView refuses further pages even if the server still has older rows.
   *   Distinct from a gap marker: no rows were dropped *between* retained
   *   lines; older history simply was never loaded.
   */
  let historyStopReason = $state<'none' | 'exhausted' | 'ceiling'>('none');
  // Client-side request ids guard local deferred work, not wire identity: the
  // protocol echoes no token. On timeout the mux retires the old socket before
  // this state allows a retry, fencing any late reply from the abandoned wire.
  let archiveRequestActive = false;
  let archiveRequestSeq = 0;
  let archiveInflightRequestId: number | null = null;
  let archiveInflightSession: string | null = null;
  // History replies are tokenless and carry no direction. These fields are
  // therefore part of the wire fence: only the locally accepted request may
  // interpret a reply, and it interprets it with this remembered direction.
  let archiveInflightDirection = $state<HistoryWindowDirection | null>(null);
  let archiveInflightAnchorLine: number | null = null;
  let archiveRequestTimer: ReturnType<typeof setTimeout> | null = null;
  // The applied boundary can lag while content is held behind a selection or
  // gesture. Remember the newest frame admitted from the wire as a separate
  // high-water fence so a reconnecting cached frame cannot replace that
  // pending delivery before reconcileLiveBoundary() gets a chance to run.
  let liveBoundaryAdmission = createLiveBoundaryAdmission();

  // --- scroll model: bottomOffsetPx 0 = pinned to live tail ---
  // Keep the per-frame compositor offset out of Svelte reactivity. Diagnostics
  // get a settled mirror, while the only reactive hot-path state is the coarse
  // scrolled-up boundary needed by the cursor and host controls.
  let bottomOffsetPx = 0;
  // An upward reader gesture can request the first archive page while a short
  // live screen has no physical scroll range. Keep that logical reader state
  // separate from the zero-pixel tail coordinate so live updates do not steal
  // the anchor before the newly available history can be scrolled.
  let historyReaderAtUnscrollableTail = false;
  let deferredUnscrollableHistoryPx = 0;
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
  let preparingMomentum = false;
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
  let renderWindowPending = false;
  const requestedClaudeBashSummaries = new Set<string>();
  const settledClaudeBashSummaries = new Map<string, string>();
  /** Missing group IDs which this distill epoch is allowed to send. Everything
   * else renders as a one-third-row `hidden bash` divider. */
  const eligibleClaudeBashSummaries = new Set<string>();
  const CLAUDE_BASH_INITIAL_SUMMARY_GROUPS = 10;
  // The host proxy allows five minutes so a request can wait behind one
  // serialized model batch and still finish its own bounded subprocess. Keep a
  // small client-side grace period, then settle to the deterministic preview
  // and release the live-latest lane even if a custom adapter never resolves.
  const CLAUDE_BASH_SUMMARY_TIMEOUT_MS = 305_000;
  let claudeBashSummaryPolicyMode: ClaudeBashMode = 'off';
  let claudeBashSummaryBootstrapPending = false;
  let claudeBashSummaryInFlight = false;
  let claudeBashSummaryTimeout: ReturnType<typeof setTimeout> | null = null;
  let pendingClaudeBashInitialBatch: readonly ClaudeBashGroupedSummaryRequest[] | null = null;
  let pendingLatestClaudeBashSummary: ClaudeBashGroupedSummaryRequest | null = null;
  let requestedClaudeBashSummaryCount = $state(0);
  let settledClaudeBashSummaryCount = $state(0);
  let lastClaudeBashDetectionScanRows = $state(0);
  let lastClaudeBashProjectionBuildRows = $state(0);
  let bashProjectionRefreshPending = false;
  let pendingPrependWork: (() => void) | null = null;
  let cancelPrependWorkTask: (() => void) | null = null;
  let prependParseSeq = 0;
  let destroyed = false;
  const deferredFrames = new Set<number>();

  function scheduleDeferredFrame(callback: FrameRequestCallback): void {
    if (destroyed) return;
    let frameId = 0;
    frameId = requestAnimationFrame((timestamp) => {
      deferredFrames.delete(frameId);
      if (!destroyed) callback(timestamp);
    });
    deferredFrames.add(frameId);
  }

  function cancelDeferredFrames(): void {
    for (const frameId of deferredFrames) cancelAnimationFrame(frameId);
    deferredFrames.clear();
  }

  type PrependLinkPlan = {
    batchLinks: (LineLinkRange[] | undefined)[];
    seamLinks: Map<number, LineLinkRange[]>;
  };

  type PrependStage = {
    seq: number;
    startLine: number | null;
    lines: string[];
    checkpoints: Map<number, SgrState>;
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
    screen?: { alt: boolean; mouseSgr: boolean; mouseAny: boolean } | null;
    boundary?: MuxHistoryBoundary;
    historyError?: {
      code: 'history_temporarily_unavailable';
      retryable: true;
    };
  };

  type SearchActiveIdentity = {
    rowId: number;
    start: number;
    end: number;
  };

  type PresentationAnchor = {
    /** Absolute raw-row identity, so a history prepend can change array indexes
     * without changing the row held under the reader's eye. */
    rowId: number;
    intraRowPx: number;
  };

  let bashSummaryRequestByFingerprint = new Map<string, ClaudeBashGroupedSummaryRequest>();
  let activeClaudeBashFingerprints = new Set<string>();

  type ClaudeBashProjectionCause = 'presentation' | 'live' | 'replace' | 'history';

  function syncClaudeBashSummaryPolicyMode(mode: ClaudeBashMode): void {
    if (mode === claudeBashSummaryPolicyMode) return;
    claudeBashSummaryPolicyMode = mode;
    eligibleClaudeBashSummaries.clear();
    pendingClaudeBashInitialBatch = null;
    pendingLatestClaudeBashSummary = null;
    claudeBashSummaryBootstrapPending = mode === 'haiku';
  }

  function publishClaudeBashSummaryDiagnostics(): void {
    requestedClaudeBashSummaryCount = requestedClaudeBashSummaries.size;
    settledClaudeBashSummaryCount = settledClaudeBashSummaries.size;
  }

  function pruneClaudeBashSummaryState(): void {
    for (const id of requestedClaudeBashSummaries) {
      if (!activeClaudeBashFingerprints.has(id)) requestedClaudeBashSummaries.delete(id);
    }
    for (const id of settledClaudeBashSummaries.keys()) {
      if (!activeClaudeBashFingerprints.has(id)) settledClaudeBashSummaries.delete(id);
    }
    for (const id of eligibleClaudeBashSummaries) {
      if (!activeClaudeBashFingerprints.has(id)) eligibleClaudeBashSummaries.delete(id);
    }
    if (
      pendingLatestClaudeBashSummary
      && !activeClaudeBashFingerprints.has(pendingLatestClaudeBashSummary.fingerprint)
    ) pendingLatestClaudeBashSummary = null;
    publishClaudeBashSummaryDiagnostics();
  }

  function normalizedClaudeBashMode(): ClaudeBashMode {
    return claudeBashMode === 'hide' || claudeBashMode === 'haiku'
      ? claudeBashMode
      : 'off';
  }

  function claudeBashScreenMode(): 'normal' | 'alternate' | 'unknown' {
    if (!screenModeKnown || resolvedScreen === null) return 'unknown';
    return resolvedScreen.alt ? 'alternate' : 'normal';
  }

  function projectionRowAt(visualRow: number): ClaudeBashGroupedProjectionRow | null {
    if (bashProjection) return bashProjection.rows[visualRow] ?? null;
    if (visualRow < 0 || visualRow >= rawLines.length) return null;
    return {
      visualRow,
      kind: 'raw',
      line: rawLines[visualRow] ?? '',
      rawStart: visualRow,
      rawEndExclusive: visualRow + 1,
      rawRange: { startLine: visualRow, endLine: visualRow + 1 },
      group: null,
      block: null,
      fingerprint: null,
      status: null,
      summaryState: 'none',
    };
  }

  function presentationRowCount(): number {
    return bashProjection?.rows.length ?? rawLines.length;
  }

  function rebuildPresentationGeometry(): void {
    if (!bashProjection) {
      compactBashVisualRows = [];
      compactBashVisualRowSet = new Set();
      return;
    }

    // Walk groups, not every projected row. This preserves the bounded
    // incremental path for a 10k-row retained buffer and remains correct when
    // one placeholder spans several adjacent Bash blocks plus separator rows.
    const compact = new Set<number>();
    const groups = bashProjection.detectedGroups;
    for (const group of groups) {
      const visualRow = bashProjection.rawToVisualRow[group.rawStart];
      if (visualRow === undefined) continue;
      const row = bashProjection.rows[visualRow];
      if (
        row?.kind === 'bash-placeholder'
        && (bashProjection.mode === 'hide' || row.summaryState === 'suppressed')
      ) {
        compact.add(visualRow);
      }
    }
    compactBashVisualRows = [...compact].sort((a, b) => a - b);
    compactBashVisualRowSet = compact;
  }

  function compactRowsBefore(visualBoundary: number): number {
    let low = 0;
    let high = compactBashVisualRows.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if ((compactBashVisualRows[middle] ?? Infinity) < visualBoundary) low = middle + 1;
      else high = middle;
    }
    return low;
  }

  function presentationUnitsBefore(visualBoundary: number): number {
    const bounded = Math.max(0, Math.min(total, Math.floor(visualBoundary)));
    if (compactBashVisualRows.length === 0) {
      return bounded * PRESENTATION_UNITS_PER_LINE;
    }
    return (
      bounded * PRESENTATION_UNITS_PER_LINE
      - compactRowsBefore(bounded) * (PRESENTATION_UNITS_PER_LINE - 1)
    );
  }

  function presentationRowTopPx(visualBoundary: number): number {
    if (compactBashVisualRows.length === 0) {
      return Math.max(0, Math.min(total, Math.floor(visualBoundary))) * lineH;
    }
    return presentationUnitsBefore(visualBoundary) * (lineH / PRESENTATION_UNITS_PER_LINE);
  }

  function presentationRowHeightPx(visualRow: number): number {
    return compactBashVisualRowSet.has(visualRow)
      ? lineH / PRESENTATION_UNITS_PER_LINE
      : lineH;
  }

  function presentationContentHeightPx(): number {
    return presentationRowTopPx(total);
  }

  /** Visual row containing a presentation-space pixel. Exact boundaries own
   * the following row, matching floor(scrollTop / lineH) in the uniform path. */
  function visualRowAtPresentationPixel(pixel: number): number {
    if (total <= 0) return 0;
    const boundedPixel = Number.isFinite(pixel) ? Math.max(0, pixel) : 0;
    if (compactBashVisualRows.length === 0) {
      return Math.max(0, Math.min(total - 1, Math.floor(boundedPixel / Math.max(1, lineH))));
    }

    let low = 0;
    let high = total;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (presentationRowTopPx(middle) <= boundedPixel) low = middle;
      else high = middle - 1;
    }
    return Math.min(total - 1, low);
  }

  /** First visual boundary at or after a content pixel. This is the
   * variable-height equivalent of ceil(pixel / lineH), suitable as an
   * exclusive viewport end. */
  function visualBoundaryAtOrAfterPresentationPixel(pixel: number): number {
    if (total <= 0) return 0;
    const boundedPixel = Number.isFinite(pixel) ? Math.max(0, pixel) : 0;
    if (compactBashVisualRows.length === 0) {
      return Math.max(0, Math.min(total, Math.ceil(boundedPixel / Math.max(1, lineH))));
    }

    let low = 0;
    let high = total;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (presentationRowTopPx(middle) < boundedPixel) low = middle + 1;
      else high = middle;
    }
    return low;
  }

  function visualRowForRaw(rawRow: number): number {
    if (!bashProjection) return Math.max(0, Math.min(rawRow, rawLines.length));
    if (bashProjection.rows.length === 0) return 0;
    if (rawRow <= 0) return bashProjection.rawToVisualRow[0] ?? 0;
    if (rawRow >= rawLines.length) return bashProjection.rows.length;
    return bashProjection.rawToVisualRow[rawRow] ?? Math.min(rawRow, bashProjection.rows.length - 1);
  }

  /** Raw half-open range covered by a visual half-open window. */
  function rawRangeForVisualWindow(start: number, end: number): { start: number; end: number } {
    const rowCount = presentationRowCount();
    const boundedStart = Math.max(0, Math.min(start, rowCount));
    const boundedEnd = Math.max(boundedStart, Math.min(end, rowCount));
    const startRow = projectionRowAt(boundedStart);
    const endRow = boundedEnd > boundedStart ? projectionRowAt(boundedEnd - 1) : null;
    return {
      start: startRow?.rawRange.startLine ?? rawLines.length,
      end: endRow?.rawRange.endLine ?? (startRow?.rawRange.startLine ?? rawLines.length),
    };
  }

  function capturePresentationAnchor(force = false): PresentationAnchor | null {
    const rowCount = presentationRowCount();
    if ((!force && !isAwayFromLiveTail()) || rowCount === 0) return null;
    const scrollTop = maxOffset() - Math.max(0, Math.min(bottomOffsetPx, maxOffset()));
    const visualRow = visualRowAtPresentationPixel(scrollTop);
    const row = projectionRowAt(visualRow);
    if (!row) return null;
    return {
      rowId: archiveOffset + row.rawRange.startLine,
      intraRowPx: scrollTop - presentationRowTopPx(visualRow),
    };
  }

  /** Sliding history can reveal semantic context that changes whether a blank
   * at the resident seam belongs to a compact Bash group. Prefer a visible,
   * nonblank raw row whose membership cannot change under that blank-only
   * expansion; fall back to the ordinary top-row anchor when none is visible. */
  function captureStableHistoryPresentationAnchor(force = false): PresentationAnchor | null {
    const fallback = capturePresentationAnchor(force);
    if (!fallback || !bashProjection) return fallback;
    const scrollTop = maxOffset() - Math.max(0, Math.min(bottomOffsetPx, maxOffset()));
    const visible = strictVisibleRowRange(bottomOffsetPx);
    const centerPx = scrollTop + Math.max(0, viewH / 2);
    let best: { row: ClaudeBashGroupedProjectionRow; distance: number } | null = null;
    for (let visual = visible.startIdx; visual < visible.endIdx; visual += 1) {
      const row = projectionRowAt(visual);
      if (
        row?.kind !== 'raw'
        || !stripAnsi(rawLines[row.rawRange.startLine] ?? '').replace(/\u00a0/g, ' ').trim()
      ) continue;
      const midpoint = presentationRowTopPx(visual) + presentationRowHeightPx(visual) / 2;
      const distance = Math.abs(midpoint - centerPx);
      if (!best || distance < best.distance) best = { row, distance };
    }
    if (!best) return fallback;
    return {
      rowId: archiveOffset + best.row.rawRange.startLine,
      intraRowPx: scrollTop - presentationRowTopPx(best.row.visualRow),
    };
  }

  function restorePresentationAnchor(anchor: PresentationAnchor | null): void {
    if (!anchor) {
      bottomOffsetPx = 0;
      return;
    }
    const rawRow = Math.max(0, Math.min(rawLines.length - 1, anchor.rowId - archiveOffset));
    const visualRow = visualRowForRaw(rawRow);
    const scrollTop = Math.max(0, presentationRowTopPx(visualRow) + anchor.intraRowPx);
    bottomOffsetPx = Math.max(0, Math.min(maxOffset(), maxOffset() - scrollTop));
  }

  function externalClaudeBashSummary(id: string): string | null {
    const summaries = claudeBashSummaries;
    if (!summaries) return null;
    const maybeMap = summaries as ReadonlyMap<string, string>;
    if (typeof maybeMap.get === 'function') return maybeMap.get(id) ?? null;
    const record = summaries as Readonly<Record<string, string>>;
    if (!Object.prototype.hasOwnProperty.call(record, id)) return null;
    return record[id] ?? null;
  }

  function mergedClaudeBashSummaries(): ClaudeBashSummaries | undefined {
    if (!claudeBashSummaries && settledClaudeBashSummaries.size === 0) return undefined;
    const merged = new Map<string, string>();
    if (claudeBashSummaries instanceof Map) {
      for (const [id, summary] of claudeBashSummaries) {
        if (typeof summary === 'string' && summary.trim()) merged.set(id, summary);
      }
    } else if (claudeBashSummaries) {
      for (const [id, summary] of Object.entries(claudeBashSummaries)) {
        if (typeof summary === 'string' && summary.trim()) merged.set(id, summary);
      }
    }
    // Host results win over a prior local fallback as soon as props arrive.
    for (const [id, summary] of settledClaudeBashSummaries) {
      if (!merged.has(id)) merged.set(id, summary);
    }
    return merged;
  }

  // Core refuses candidates longer than 2,000 rows. Rescanning 2,048 rows
  // before the first changed raw line therefore catches every candidate that
  // could have started in the stable prefix and completed in the new suffix,
  // while avoiding a 10k-row detector pass on each live delta.
  const CLAUDE_BASH_INCREMENTAL_RESCAN_ROWS = 2_048;
  const CLAUDE_BASH_MAX_CACHED_BLOCKS = 512;

  function claudeBashBarriers(): number[] {
    const barriers = new Set<number>();
    for (const index of archivedRetentionGaps.keys()) barriers.add(index);
    if (liveGapEntryState && liveLines.length > 0) barriers.add(archivedLines.length);
    if (gapRowIndex > 0 && gapRowCount > 0) barriers.add(gapRowIndex);
    return [...barriers]
      .filter((index) => index > 0 && index < rawLines.length)
      .sort((a, b) => a - b);
  }

  function shiftedClaudeBashBlock(block: ClaudeBashBlock, offset: number): ClaudeBashBlock {
    const shiftedRange = (source: { startLine: number; endLine: number }) => ({
      startLine: source.startLine + offset,
      endLine: source.endLine + offset,
    });
    return {
      ...block,
      rawStart: block.rawStart + offset,
      rawEndExclusive: block.rawEndExclusive + offset,
      sourceRange: shiftedRange(block.sourceRange),
      commandRange: shiftedRange(block.commandRange),
      outputRange: shiftedRange(block.outputRange),
    };
  }

  function shiftedClaudeBashGroup(group: ClaudeBashGroup, offset: number): ClaudeBashGroup {
    const shiftedBlocks = group.blocks.map((block) => shiftedClaudeBashBlock(block, offset));
    return {
      ...group,
      rawStart: group.rawStart + offset,
      rawEndExclusive: group.rawEndExclusive + offset,
      sourceRange: {
        startLine: group.sourceRange.startLine + offset,
        endLine: group.sourceRange.endLine + offset,
      },
      blocks: shiftedBlocks,
    };
  }

  /** Detect independently inside each retained continuous segment. A retention
   * gap is a hard semantic barrier: rows on opposite sides were never adjacent
   * in the terminal and must never become one Bash block or one Haiku prompt. */
  function detectClaudeBashSegments(
    startLine: number,
    barriers: readonly number[],
  ): ClaudeBashBlock[] {
    const blocks: ClaudeBashBlock[] = [];
    const boundaries = [
      ...barriers.filter((barrier) => barrier > startLine),
      rawLines.length,
    ];
    let segmentStart = startLine;
    for (const segmentEnd of boundaries) {
      if (segmentEnd <= segmentStart) continue;
      const detection = detectClaudeBashBlocks(
        rawLines.slice(segmentStart, segmentEnd),
        { screenMode: 'normal' },
      );
      for (const block of detection.blocks) {
        blocks.push(shiftedClaudeBashBlock(block, segmentStart));
      }
      segmentStart = segmentEnd;
    }
    return blocks;
  }

  function detectionForClaudeBashProjection(changedFromRaw?: number): ClaudeBashDetection {
    const screenMode = claudeBashScreenMode();
    const barriers = claudeBashBarriers();
    const barrierKey = barriers.join(',');
    const cacheMatchesCoordinates =
      cachedClaudeBashDetection !== null
      && cachedClaudeBashDetectionScreenMode === screenMode
      && cachedClaudeBashBarrierKey === barrierKey;

    if (screenMode !== 'normal') {
      const disabled = detectClaudeBashBlocks(rawLines, { screenMode });
      lastClaudeBashDetectionScanRows = 0;
      lastClaudeBashProjectionRebuildStart = 0;
      cachedClaudeBashDetection = disabled;
      cachedClaudeBashDetectionRawLength = rawLines.length;
      cachedClaudeBashDetectionScreenMode = screenMode;
      cachedClaudeBashBarrierKey = barrierKey;
      return disabled;
    }

    if (
      cacheMatchesCoordinates
      && changedFromRaw === undefined
      && cachedClaudeBashDetectionRawLength === rawLines.length
    ) {
      lastClaudeBashDetectionScanRows = 0;
      lastClaudeBashProjectionRebuildStart = rawLines.length;
      return cachedClaudeBashDetection!;
    }

    let rescanStart = 0;
    let retained: ClaudeBashBlock[] = [];
    if (cacheMatchesCoordinates && changedFromRaw !== undefined) {
      const commonPrefix = Math.max(0, Math.min(changedFromRaw, rawLines.length));
      rescanStart = Math.max(0, commonPrefix - CLAUDE_BASH_INCREMENTAL_RESCAN_ROWS);
      // If the nominal rescan boundary lands inside a formerly detected block,
      // include its header. Starting mid-block must fail open, not silently
      // discard a still-valid placeholder.
      for (const block of cachedClaudeBashDetection!.blocks) {
        if (block.rawStart < rescanStart && block.rawEndExclusive > rescanStart) {
          rescanStart = block.rawStart;
        }
      }
      retained = cachedClaudeBashDetection!.blocks.filter(
        (block) => block.rawEndExclusive <= rescanStart,
      );
    }

    const rescanned = detectClaudeBashSegments(rescanStart, barriers);
    lastClaudeBashDetectionScanRows = rawLines.length - rescanStart;
    const combinedBlocks = [...retained, ...rescanned]
      .sort((a, b) => a.rawStart - b.rawStart);
    const overflow = Math.max(0, combinedBlocks.length - CLAUDE_BASH_MAX_CACHED_BLOCKS);
    // Projection may still contain a placeholder for the oldest retained
    // block while the detector's 512-block cap ejects it. Rebuild from that
    // block so it expands back to raw rows; otherwise an old Haiku placeholder
    // could survive without an active request and remain "summarising" forever.
    const projectionRebuildStart = overflow > 0
      ? Math.min(rescanStart, combinedBlocks[0]?.rawStart ?? rescanStart)
      : rescanStart;
    const blocks = combinedBlocks.slice(-CLAUDE_BASH_MAX_CACHED_BLOCKS);
    const detection: ClaudeBashDetection = {
      enabled: true,
      blocks,
      scanRange: { startLine: 0, endLine: rawLines.length },
    };
    cachedClaudeBashDetection = detection;
    cachedClaudeBashDetectionRawLength = rawLines.length;
    cachedClaudeBashDetectionScreenMode = screenMode;
    cachedClaudeBashBarrierKey = barrierKey;
    lastClaudeBashProjectionRebuildStart = projectionRebuildStart;
    return detection;
  }

  function claudeBashSummaryKey(summaries: ClaudeBashSummaries | undefined): string {
    if (!summaries) return '';
    const entries = summaries instanceof Map
      ? [...summaries.entries()]
      : Object.entries(summaries);
    entries.sort(([a], [b]) => a.localeCompare(b));
    return entries.map(([id, summary]) => `${id}\u0000${summary}`).join('\u0001');
  }

  function claudeBashEligibilityKey(): string {
    return [...eligibleClaudeBashSummaries].sort().join('\u0001');
  }

  function hasClaudeBashSummary(id: string): boolean {
    if (settledClaudeBashSummaries.get(id)?.trim()) return true;
    return !!externalClaudeBashSummary(id)?.trim();
  }

  /** Select model work before projection so core can render every non-selected
   * group as a compact divider immediately (never a spinner that will not run).
   * Returns which queue lane should consume the resulting summary requests. */
  function updateClaudeBashSummaryEligibility(
    groups: readonly ClaudeBashGroup[],
    cause: ClaudeBashProjectionCause,
    changedFromRaw: number | undefined,
  ): { bootstrap: boolean; liveFingerprint: string | null } {
    if (normalizedClaudeBashMode() !== 'haiku' || claudeBashScreenMode() !== 'normal') {
      return { bootstrap: false, liveFingerprint: null };
    }
    const completed = groups.filter((group) => group.status === 'completed');

    // Do not consume the cold-start budget when the prop effect runs before the
    // first pane capture. Once content exists (or the user enters Distill on an
    // already-open pane), admit only the newest ten completed semantic groups.
    if (claudeBashSummaryBootstrapPending && completed.length > 0) {
      for (const group of completed.slice(-CLAUDE_BASH_INITIAL_SUMMARY_GROUPS)) {
        eligibleClaudeBashSummaries.add(group.fingerprint);
      }
      claudeBashSummaryBootstrapPending = false;
      return { bootstrap: true, liveFingerprint: null };
    }

    if (cause !== 'live' || changedFromRaw === undefined) {
      return { bootstrap: false, liveFingerprint: null };
    }
    // A coalesced frame may finish several non-adjacent groups. The open-tab
    // policy deliberately keeps only the newest missing one. A queued-but-not-
    // dispatched older group becomes a compact divider rather than backlog.
    const previousCompleted = new Set(
      (bashProjection?.detectedGroups ?? [])
        .filter((group) => group.status === 'completed')
        .map((group) => group.fingerprint),
    );
    const newest = completed
      .filter((group) => (
        !previousCompleted.has(group.fingerprint)
        && group.rawEndExclusive >= changedFromRaw
        && !requestedClaudeBashSummaries.has(group.fingerprint)
        && !hasClaudeBashSummary(group.fingerprint)
      ))
      .at(-1);
    if (!newest) return { bootstrap: false, liveFingerprint: null };

    if (
      pendingLatestClaudeBashSummary
      && !requestedClaudeBashSummaries.has(pendingLatestClaudeBashSummary.fingerprint)
    ) {
      eligibleClaudeBashSummaries.delete(pendingLatestClaudeBashSummary.fingerprint);
    }
    eligibleClaudeBashSummaries.add(newest.fingerprint);
    return { bootstrap: false, liveFingerprint: newest.fingerprint };
  }

  function localizedClaudeBashDetection(
    detection: ClaudeBashDetection,
    startLine: number,
  ): ClaudeBashDetection {
    return {
      enabled: detection.enabled,
      blocks: detection.blocks
        .filter((block) => block.rawStart >= startLine)
        .map((block) => shiftedClaudeBashBlock(block, -startLine)),
      scanRange: { startLine: 0, endLine: rawLines.length - startLine },
    };
  }

  function shiftedClaudeBashProjectionRow(
    row: ClaudeBashGroupedProjectionRow,
    rawOffset: number,
    visualOffset: number,
  ): ClaudeBashGroupedProjectionRow {
    return {
      ...row,
      visualRow: row.visualRow + visualOffset,
      rawStart: row.rawStart + rawOffset,
      rawEndExclusive: row.rawEndExclusive + rawOffset,
      rawRange: {
        startLine: row.rawRange.startLine + rawOffset,
        endLine: row.rawRange.endLine + rawOffset,
      },
      group: row.group ? shiftedClaudeBashGroup(row.group, rawOffset) : null,
      block: row.block ? shiftedClaudeBashBlock(row.block, rawOffset) : null,
    };
  }

  /** Reuse immutable prefix rows/mappings and project only the detector's
   * bounded changed suffix. This removes the remaining 10k object-freeze pass
   * from steady live updates; a cold/mode/summary/gap change still takes the
   * conservative full path. */
  function incrementalClaudeBashProjection(
    detection: ClaudeBashDetection,
    detectedGroups: readonly ClaudeBashGroup[],
    summaries: ClaudeBashSummaries | undefined,
    projectionKey: string,
    changedFromRaw: number | undefined,
    barrierLines: readonly number[],
  ): ClaudeBashGroupedProjection | null {
    const previous = bashProjection;
    const startLine = lastClaudeBashProjectionRebuildStart;
    if (
      changedFromRaw === undefined
      || !previous
      || previous.mode !== normalizedClaudeBashMode()
      || lastClaudeBashProjectionSummaryKey !== projectionKey
      || claudeBashScreenMode() !== 'normal'
      || startLine <= 0
      || startLine >= rawLines.length
    ) return null;

    // Grouping is semantic across adjacent blocks. If the bounded suffix seam
    // lands inside a group, reusing its old prefix placeholder would split one
    // burst into two rows/requests; take the conservative full projection.
    // A group can also begin exactly on the seam because it absorbed separator
    // blanks before its first detected block. In the sliced suffix that blank
    // becomes unproven capture padding and stays raw, so that seam must use the
    // same full fallback to keep incremental and cold projection identical.
    if (detectedGroups.some((group) => (
      (group.rawStart < startLine && group.rawEndExclusive > startLine)
      || (
        group.rawStart === startLine
        && (group.blocks[0]?.rawStart ?? group.rawStart) > startLine
      )
    ))) return null;

    const retainedBlockCoordinates = new Set(detection.blocks.map((block) =>
      `${block.rawStart}:${block.rawEndExclusive}:${block.fingerprint}`));
    // This should normally be guaranteed by projectionRebuildStart above. Keep
    // a fail-safe for a future detector cap/policy change: never reuse a prefix
    // placeholder which no longer exists in the current detection.
    if (previous.detectedBlocks.some((block) => (
      block.rawEndExclusive <= startLine
      && !retainedBlockCoordinates.has(
        `${block.rawStart}:${block.rawEndExclusive}:${block.fingerprint}`,
      )
    ))) return null;

    const prefixVisualEnd = (previous.rawToVisualRow[startLine - 1] ?? -1) + 1;
    const prefixRows = previous.rows.slice(0, prefixVisualEnd);
    const prefixRawEnd = prefixRows.at(-1)?.rawRange.endLine ?? 0;
    if (prefixRawEnd !== startLine) return null;

    const suffixRaw = rawLines.slice(startLine);
    const suffix = projectClaudeBashGroupedLines(suffixRaw, {
      mode: normalizedClaudeBashMode(),
      summaries,
      detection: localizedClaudeBashDetection(detection, startLine),
      groupingOptions: {
        barrierLines: barrierLines
          .filter((line) => line > startLine)
          .map((line) => line - startLine),
      },
      summaryEligibleIds: eligibleClaudeBashSummaries,
    });
    lastClaudeBashProjectionBuildRows = suffixRaw.length;
    const visualOffset = prefixRows.length;
    const suffixRows = suffix.rows.map((row) =>
      shiftedClaudeBashProjectionRow(row, startLine, visualOffset));
    const rows = [...prefixRows, ...suffixRows];
    const rawToVisualRow = [
      ...previous.rawToVisualRow.slice(0, startLine),
      ...suffix.rawToVisualRow.map((visualRow) => visualRow + visualOffset),
    ];

    const retainedRequestFingerprints = new Set(
      detectedGroups
        .filter((group) => group.rawEndExclusive <= startLine)
        .map((group) => group.fingerprint),
    );
    const summaryRequests: ClaudeBashGroupedSummaryRequest[] = [];
    const requestIds = new Set<string>();
    for (const request of previous.summaryRequests) {
      if (!retainedRequestFingerprints.has(request.fingerprint) || requestIds.has(request.id)) continue;
      requestIds.add(request.id);
      summaryRequests.push(request);
    }
    for (const request of suffix.summaryRequests) {
      if (requestIds.has(request.id)) continue;
      requestIds.add(request.id);
      summaryRequests.push(request);
    }

    const visualToRawRange = rows.map((row) => row.rawRange);
    return {
      mode: normalizedClaudeBashMode(),
      rawLines,
      lines: rows.map((row) => row.line),
      rows,
      visualToRawRange,
      visualToRaw: visualToRawRange,
      rawToVisualRow,
      rawToVisual: rawToVisualRow,
      detectedBlocks: detection.blocks,
      detectedGroups,
      summaryRequests,
    };
  }

  /** Rebuild only the visual coordinate space. rawLines and every raw-indexed
   * column remain untouched. Summary arrival therefore repaints text in the
   * same placeholder row instead of changing scroll height. */
  function rebuildClaudeBashProjection(
    anchor: PresentationAnchor | null,
    changedFromRaw?: number,
    cause: ClaudeBashProjectionCause = 'presentation',
  ): void {
    const mode = normalizedClaudeBashMode();
    syncClaudeBashSummaryPolicyMode(mode);
    if (mode === 'off') {
      const changedCoordinateSpace = bashProjection !== null;
      bashProjection = null;
      bashSummaryRequestByFingerprint = new Map();
      cachedClaudeBashDetection = null;
      cachedClaudeBashDetectionRawLength = 0;
      cachedClaudeBashDetectionScreenMode = null;
      cachedClaudeBashBarrierKey = '';
      lastClaudeBashDetectionScanRows = 0;
      lastClaudeBashProjectionBuildRows = 0;
      lastClaudeBashProjectionSummaryKey = '';
      total = rawLines.length;
      rebuildPresentationGeometry();
      if (changedCoordinateSpace) {
        invalidateRenderedCache();
        invalidateSearchOverlayHtml();
        restorePresentationAnchor(anchor);
        const visible = visibleRowRange(bottomOffsetPx);
        winStart = Math.max(0, visible.startIdx - OVERSCAN_ROWS);
        winEnd = Math.min(total, visible.endIdx + OVERSCAN_ROWS);
      }
      return;
    }
    const summaries = mergedClaudeBashSummaries();
    const detection = detectionForClaudeBashProjection(changedFromRaw);
    const barrierLines = claudeBashBarriers();
    const detectedGroups = groupClaudeBashBlocks(rawLines, detection.blocks, {
      barrierLines,
    });
    const queueSelection = updateClaudeBashSummaryEligibility(
      detectedGroups,
      cause,
      changedFromRaw,
    );
    const projectionKey = [
      claudeBashSummaryKey(summaries),
      claudeBashEligibilityKey(),
      barrierLines.join(','),
    ].join('\u0002');
    // The incremental helper overwrites this with its bounded suffix length
    // when it can safely reuse the immutable prefix.
    lastClaudeBashProjectionBuildRows = rawLines.length;
    bashProjection = incrementalClaudeBashProjection(
      detection,
      detectedGroups,
      summaries,
      projectionKey,
      changedFromRaw,
      barrierLines,
    ) ?? projectClaudeBashGroupedLines(rawLines, {
      mode,
      summaries,
      detection,
      groupingOptions: { barrierLines },
      summaryEligibleIds: eligibleClaudeBashSummaries,
    });
    lastClaudeBashProjectionSummaryKey = projectionKey;
    bashSummaryRequestByFingerprint = new Map(
      bashProjection.summaryRequests.map((request) => [request.fingerprint, request]),
    );
    if (claudeBashScreenMode() === 'normal') {
      activeClaudeBashFingerprints = new Set(
        bashProjection.detectedGroups.map((group) => group.fingerprint),
      );
      pruneClaudeBashSummaryState();
    }
    total = bashProjection.rows.length;
    rebuildPresentationGeometry();
    invalidateRenderedCache();
    invalidateSearchOverlayHtml();
    restorePresentationAnchor(anchor);
    const visible = visibleRowRange(bottomOffsetPx);
    winStart = Math.max(0, visible.startIdx - OVERSCAN_ROWS);
    winEnd = Math.min(total, visible.endIdx + OVERSCAN_ROWS);
    queueClaudeBashSummaryWork(queueSelection);
  }

  function returnedClaudeBashSummary(
    summaries: ClaudeBashSummaries | void,
    id: string,
  ): string | null {
    if (!summaries) return null;
    const maybeMap = summaries as ReadonlyMap<string, string>;
    if (typeof maybeMap.get === 'function') return maybeMap.get(id) ?? null;
    const record = summaries as Readonly<Record<string, string>>;
    if (!Object.prototype.hasOwnProperty.call(record, id)) return null;
    return record[id] ?? null;
  }

  function fallbackClaudeBashSummary(request: ClaudeBashGroupedSummaryRequest): string {
    const command = request.command
      .replace(/\u00a0/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const preview = command.length > 96 ? `${command.slice(0, 95)}…` : command;
    return `${preview || 'คำสั่ง shell'} · ${request.lineCount} แถว`;
  }

  function presentSettledClaudeBashSummaries(): void {
    if (destroyed) return;
    if (busy() || selectionActive) {
      bashProjectionRefreshPending = true;
      return;
    }
    const anchor = capturePresentationAnchor();
    rebuildClaudeBashProjection(anchor);
    buildRenderedWindow(winStart, winEnd);
    invalidateSearchOverlayHtml();
    renderEpoch++;
    applyScroll();
  }

  function settleClaudeBashSummaryBatch(
    requests: readonly ClaudeBashGroupedSummaryRequest[],
    summaries: ClaudeBashSummaries | void,
  ): void {
    if (destroyed) return;
    let changed = false;
    for (const request of requests) {
      if (!activeClaudeBashFingerprints.has(request.fingerprint)) continue;
      const returned = returnedClaudeBashSummary(summaries, request.id)
        ?? returnedClaudeBashSummary(summaries, request.fingerprint)
        ?? externalClaudeBashSummary(request.id)
        ?? externalClaudeBashSummary(request.fingerprint);
      const clean = typeof returned === 'string'
        ? returned.replace(/\s+/g, ' ').trim()
        : '';
      settledClaudeBashSummaries.set(
        request.fingerprint,
        clean || fallbackClaudeBashSummary(request),
      );
      changed = true;
    }
    publishClaudeBashSummaryDiagnostics();
    if (changed) presentSettledClaudeBashSummaries();
  }

  function dispatchClaudeBashSummaryBatch(
    candidates: readonly ClaudeBashGroupedSummaryRequest[],
  ): void {
    const requests = candidates.filter((request) => (
      activeClaudeBashFingerprints.has(request.fingerprint)
      && !requestedClaudeBashSummaries.has(request.fingerprint)
    ));
    if (requests.length === 0) {
      pumpClaudeBashSummaryQueue();
      return;
    }
    claudeBashSummaryInFlight = true;
    for (const request of requests) requestedClaudeBashSummaries.add(request.fingerprint);
    publishClaudeBashSummaryDiagnostics();

    let finished = false;
    const finish = (summaries: ClaudeBashSummaries | void): void => {
      if (finished) return;
      finished = true;
      if (claudeBashSummaryTimeout !== null) {
        clearTimeout(claudeBashSummaryTimeout);
        claudeBashSummaryTimeout = null;
      }
      if (destroyed) return;
      claudeBashSummaryInFlight = false;
      settleClaudeBashSummaryBatch(requests, summaries);
      pumpClaudeBashSummaryQueue();
    };
    claudeBashSummaryTimeout = setTimeout(
      () => finish(undefined),
      CLAUDE_BASH_SUMMARY_TIMEOUT_MS,
    );
    if (typeof onClaudeBashSummaryRequest !== 'function') {
      Promise.resolve().then(() => finish(undefined));
      return;
    }
    try {
      const result = onClaudeBashSummaryRequest(requests);
      Promise.resolve(result).then(
        (summaries) => finish(summaries),
        () => finish(undefined),
      );
    } catch {
      Promise.resolve().then(() => finish(undefined));
    }
  }

  /** One serial lane keeps a cold batch and live tail work deterministic. While
   * a request is in flight, repeated live frames replace the waiting tail item
   * instead of building a model backlog. */
  function pumpClaudeBashSummaryQueue(): void {
    if (
      destroyed
      || claudeBashSummaryInFlight
      || normalizedClaudeBashMode() !== 'haiku'
      || claudeBashScreenMode() !== 'normal'
    ) return;

    if (pendingClaudeBashInitialBatch) {
      const batch = pendingClaudeBashInitialBatch;
      pendingClaudeBashInitialBatch = null;
      dispatchClaudeBashSummaryBatch(batch);
      return;
    }
    if (pendingLatestClaudeBashSummary) {
      const latest = pendingLatestClaudeBashSummary;
      pendingLatestClaudeBashSummary = null;
      dispatchClaudeBashSummaryBatch([latest]);
    }
  }

  function queueClaudeBashSummaryWork(selection: {
    bootstrap: boolean;
    liveFingerprint: string | null;
  }): void {
    if (normalizedClaudeBashMode() !== 'haiku') return;
    if (selection.bootstrap) {
      pendingClaudeBashInitialBatch = bashProjection?.summaryRequests
        .filter((request) => eligibleClaudeBashSummaries.has(request.fingerprint))
        .slice(-CLAUDE_BASH_INITIAL_SUMMARY_GROUPS) ?? [];
    }
    if (selection.liveFingerprint) {
      const latest = bashSummaryRequestByFingerprint.get(selection.liveFingerprint);
      if (latest) pendingLatestClaudeBashSummary = latest;
    }
    pumpClaudeBashSummaryQueue();
  }

  function visualRowKey(visualRow: number): string {
    const row = projectionRowAt(visualRow);
    if (!row) return `empty:${visualRow}`;
    const rawId = archiveOffset + row.rawRange.startLine;
    return row.kind === 'bash-placeholder'
      ? `bash:${rawId}:${row.fingerprint ?? 'active'}`
      : `raw:${rawId}`;
  }

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

  function isAwayFromLiveTail(): boolean {
    // A detached archive window can be at its own local bottom while still
    // being many pages away from the live pane. Keep cursor/latest-button
    // semantics tied to the real live seam, not local scroll coordinates.
    return deferredLegacyLiveCapture !== null
      || historyReaderAtUnscrollableTail || bottomOffsetPx > 0 || (
      historyPaging === 'sliding' &&
      archiveWindow !== null &&
      !archiveWindowAttachedToLive
    );
  }

  /** Boundary diagnostics are integer pixels, but must never round a real
   * positive offset down to the sentinel 0 (which means exact live-tail). */
  function reportedBottomOffset(): number {
    const rounded = Math.round(bottomOffsetPx);
    return isAwayFromLiveTail() ? Math.max(1, rounded) : rounded;
  }

  export function isScrolledUp(): boolean {
    return isAwayFromLiveTail();
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
    // `node && contains(node)` is `Node | boolean | null` under strict TS —
    // coerce to boolean so the predicate matches its annotation.
    return (
      !!(anchor && searchPanelEl.contains(anchor)) ||
      !!(focus && searchPanelEl.contains(focus))
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

  function placeholderSearchKind(
    row: ClaudeBashGroupedProjectionRow,
  ): 'search-match' | 'search-active' | null {
    let matched = false;
    for (let rawRow = row.rawRange.startLine; rawRow < row.rawRange.endLine; rawRow += 1) {
      const ranges = searchLineByIndex.get(rawRow);
      if (!ranges) continue;
      if (ranges.some((range) => range.kind === 'search-active')) return 'search-active';
      if (ranges.length > 0) matched = true;
    }
    return matched ? 'search-match' : null;
  }

  function cachedLineHtml(visualRow: number, epoch: number): string {
    void epoch;
    const projectionRow = projectionRowAt(visualRow);
    if (!projectionRow) return ' ';
    if (projectionRow.kind === 'bash-placeholder') {
      const base = bashPlaceholderHtmlCache.get(visualRow) ?? ' ';
      const kind = placeholderSearchKind(projectionRow);
      if (!kind) return base;
      const cacheKey = -(visualRow + 1);
      const cached = readSparseOverlay(searchSparseCache, cacheKey, searchGeneration);
      if (cached !== undefined) return cached;
      const entry = bashPlaceholderEntryStates.get(visualRow);
      if (!entry) return base;
      const html = htmlLine(projectionRow.line, cloneSgrState(entry), undefined, [{
        start: 0,
        end: Math.max(1, stripAnsi(projectionRow.line).length),
        kind,
      }]);
      writeSparseOverlay(searchSparseCache, cacheKey, searchGeneration, html);
      return html;
    }

    const idx = projectionRow.rawRange.startLine;
    const base = htmlCache.get(idx) ?? ' ';
    const ranges = searchLineByIndex.get(idx);
    if (!ranges || ranges.length === 0) return base;

    const cached = readSparseOverlay(searchSparseCache, idx, searchGeneration);
    if (cached !== undefined) return cached;

    const rawLine = rawLines[idx];
    if (rawLine === undefined) return base;
    const cachedEntry = renderEntryStates.get(idx);
    if (!cachedEntry) return base;
    const st = cloneSgrState(cachedEntry);
    const html = htmlLine(rawLine, st, linksByLine[idx], ranges);
    writeSparseOverlay(searchSparseCache, idx, searchGeneration, html);
    return html;
  }

  export function scrollToBottom(): boolean {
    updateSelectionActive();
    if (selectionActive) return false;
    stopInertia();
    historyReaderAtUnscrollableTail = false;
    deferredUnscrollableHistoryPx = 0;
    bottomOffsetPx = 0;
    if (useSgrMouse) {
      const geom = currentGeometry();
      if (geom) {
        const composerRows = Math.max(0, Math.ceil(bottomInsetPx / Math.max(1, lineH)));
        const { cx, cy } = centerContentCell(geom, { composerRows });
        sendSgr(sgrSnapToBottom(cx, cy));
      }
    }
    rejoinDeferredLegacyLiveCapture();
    applyScroll();
    if (
      historyPaging === 'sliding' &&
      archiveWindow !== null &&
      !archiveWindowAttachedToLive
    ) {
      maybeRequestNewerHistory(0);
    }
    flushPendingContent();
    emitScrollState();
    return true;
  }

  function maxOffset(): number {
    const contentHeight = presentationContentHeightPx();
    if (
      historyPaging === 'sliding'
      && archiveWindow !== null
      && archiveWindowAttachedToLive
      && liveLines.length > 0
    ) {
      // A pane capture may temporarily contain fewer rows than the browser
      // viewport (most visibly while geometry catches up). At the live tail
      // those rows are top-aligned and leave unused space below them. Once an
      // archive page is prepended, preserve that same live-screen alignment;
      // subtracting the whole viewport would consume the prior slack and move
      // every live row even though the reader's absolute anchor is unchanged.
      const liveStart = visualRowForRaw(archivedLines.length);
      const liveTop = presentationRowTopPx(liveStart);
      const liveHeight = Math.max(0, contentHeight - liveTop);
      return Math.max(0, liveTop + Math.max(0, liveHeight - Math.max(1, viewH)));
    }
    return Math.max(0, contentHeight - Math.max(1, viewH));
  }

  /** Preserve an off-bottom row's physical screen position across layout.
   *
   * `bottomOffsetPx` is measured from the live tail. For a fixed content row,
   * its screen Y changes only with `viewport.bottom + bottomOffsetPx`; a top-edge
   * HUD resize therefore needs no compensation, while a bottom-docked control
   * does. SessionView exposes the latter immediately: its 44px "latest" control
   * plus 8px gap appears on the first off-bottom scroll. Before this correction,
   * a 4px wheel gesture was counter-scrolled 48px toward the tail.
   */
  function updateViewportGeometry(
    viewport: HTMLDivElement | null,
    bounds = viewport?.getBoundingClientRect(),
  ): void {
    if (!viewport) return;
    const nextHeight = viewport.clientHeight;
    const nextBottom = bounds?.bottom ?? Number.NaN;
    if (
      viewportBottom !== null
      && Number.isFinite(nextBottom)
      && isAwayFromLiveTail()
    ) {
      bottomOffsetPx = Math.max(0, bottomOffsetPx + viewportBottom - nextBottom);
    }
    viewH = nextHeight;
    viewportBottom = Number.isFinite(nextBottom) ? nextBottom : null;
  }

  function busy(): boolean {
    return touching || preparingMomentum || momentumFrame !== null || springFrame !== null;
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
      const boundaries = new Set<number>(archivedRetentionGaps.keys());
      if (liveGapEntryState && liveLines.length > 0) boundaries.add(archivedLines.length);
      let segmentStart = 0;
      for (const boundary of [...boundaries].sort((a, b) => a - b)) {
        const bounded = Math.max(segmentStart, Math.min(boundary, rawLines.length));
        if (bounded > segmentStart) {
          collect(rawLines.slice(segmentStart, bounded), segmentStart);
        }
        segmentStart = bounded;
      }
      if (segmentStart < rawLines.length) collect(rawLines.slice(segmentStart), segmentStart);
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
    links: LineLinkRange[] | undefined,
  ): number {
    let bytes = HISTORY_ROW_OVERHEAD_BYTES + 2 * raw.length;
    if (links) {
      for (const link of links) bytes += 64 + 2 * link.href.length;
    }
    return bytes;
  }

  /** Page-model byte estimates include the same retained URL metadata as the
   * rendered TermView columns, while remaining independent of DOM/HTML rows. */
  function estimatedHistoryWindowLineStorage(lines: readonly string[]): number[] {
    const links: (LineLinkRange[] | undefined)[] = new Array(lines.length);
    const cols = lastPushedCols > 0 ? lastPushedCols : 60;
    try {
      for (const match of collectTerminalUrlSegments([...lines], 0, lines.length, cols)) {
        for (const segment of match.segments) {
          if (segment.lineIdx < 0 || segment.lineIdx >= lines.length) continue;
          (links[segment.lineIdx] ??= []).push({
            start: segment.startCol,
            end: segment.endCol,
            href: match.url,
          });
        }
      }
    } catch { /* malformed URL-like text falls back to raw row storage */ }
    return lines.map((line, index) => estimatedLineStorageBytes(line, links[index]));
  }

  function recalculateRetainedEstimatedBytes(): void {
    let bytes = 0;
    for (let i = 0; i < rawLines.length; i++) {
      bytes += estimatedLineStorageBytes(
        rawLines[i] ?? '',
        linksByLine[i],
      );
    }
    retainedEstimatedBytes = bytes;
  }

  type PrependRetentionPlan = {
    keepFrom: number;
  };

  function recordRetentionGap(rowIndex: number, dropped: number): void {
    if (dropped <= 0) return;
    const extendsCurrent =
      gapRowIndex === rowIndex ||
      gapRowIndex === rowIndex + dropped;
    gapRowCount = extendsCurrent ? gapRowCount + dropped : dropped;
    gapRowIndex = rowIndex;
  }

  function clearRetentionGap(): void {
    gapRowIndex = -1;
    gapRowCount = 0;
  }

  function gapEntryStateAt(index: number): SgrState | null {
    if (liveGapEntryState && index === archivedLines.length) return liveGapEntryState;
    return archivedRetentionGaps.get(index)?.entryState ?? null;
  }

  function retentionGapRowsAt(index: number, epoch: number): number {
    void epoch;
    const archivedCount = archivedRetentionGaps.get(index)?.rowCount ?? 0;
    const liveCount = index === gapRowIndex ? gapRowCount : 0;
    return archivedCount + liveCount;
  }

  function archiveCurrentRetentionGap(): void {
    if (gapRowIndex < 0 || gapRowCount <= 0) return;
    const entryState = liveGapEntryState ?? (gapRowIndex === 0 ? rawEntryState : null);
    if (!entryState) return;
    const next = new Map(archivedRetentionGaps);
    const existing = next.get(gapRowIndex);
    next.set(gapRowIndex, {
      rowCount: (existing?.rowCount ?? 0) + gapRowCount,
      entryState: cloneSgrState(entryState),
    });
    archivedRetentionGaps = next;
  }

  function planPrependRetention(stage: PrependStage): PrependRetentionPlan {
    let stageBytes = 0;
    for (let i = 0; i < stage.lines.length; i++) {
      stageBytes += estimatedLineStorageBytes(
        stage.lines[i] ?? '',
        stage.linkPlan.batchLinks[i],
      );
    }

    let projectedRows = rawLines.length + stage.lines.length;
    let projectedBytes = retainedEstimatedBytes + stageBytes;

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
        stage.linkPlan.batchLinks[keepFrom],
      );
      keepFrom++;
    }
    return { keepFrom };
  }

  function publishStorageDiagnostics(): void {
    renderCacheRows = htmlCache.size + bashPlaceholderHtmlCache.size;
    sgrCheckpointCount = sgrCheckpoints.size;
  }

  function invalidateRenderedCache(): void {
    htmlCache = new Map();
    bashPlaceholderHtmlCache = new Map();
    bashPlaceholderEntryStates = new Map();
    renderEntryStates = new Map();
    renderCacheRows = 0;
  }

  function invalidateCheckpointsAfter(index: number): void {
    for (const checkpoint of sgrCheckpoints.keys()) {
      if (checkpoint > index) sgrCheckpoints.delete(checkpoint);
    }
    if (rawLines.length > 0 && !sgrCheckpoints.has(0)) {
      sgrCheckpoints.set(0, cloneSgrState(rawEntryState));
    }
    sgrCheckpointCount = sgrCheckpoints.size;
  }

  function stateBeforeLine(index: number): SgrState {
    const target = Math.max(0, Math.min(index, rawLines.length));
    let checkpointIndex = 0;
    let checkpointState = rawEntryState;
    for (const [candidate, state] of sgrCheckpoints) {
      if (candidate <= target && candidate >= checkpointIndex) {
        checkpointIndex = candidate;
        checkpointState = state;
      }
    }

    for (const [gapIndex, gap] of archivedRetentionGaps) {
      if (gapIndex >= checkpointIndex && gapIndex <= target) {
        checkpointIndex = gapIndex;
        checkpointState = gap.entryState;
      }
    }
    const liveGapIndex = liveGapEntryState ? archivedLines.length : -1;
    if (liveGapIndex >= checkpointIndex && liveGapIndex <= target && liveGapEntryState) {
      checkpointIndex = liveGapIndex;
      checkpointState = liveGapEntryState;
    }
    if (checkpointIndex > 0 || archivedRetentionGaps.has(0) || liveGapIndex === 0) {
      sgrCheckpoints.set(checkpointIndex, cloneSgrState(checkpointState));
    }

    const state = cloneSgrState(checkpointState);
    for (let i = checkpointIndex; i < target; i++) {
      const gapEntry = gapEntryStateAt(i);
      if (gapEntry) {
        Object.assign(state, cloneSgrState(gapEntry));
      }
      if (i !== checkpointIndex && i % SGR_CHECKPOINT_INTERVAL === 0) {
        sgrCheckpoints.set(i, cloneSgrState(state));
      }
      lineToHtml(rawLines[i] ?? '', state, palette);
      if ((i + 1) % SGR_CHECKPOINT_INTERVAL === 0) {
        sgrCheckpoints.set(i + 1, cloneSgrState(state));
      }
    }
    sgrCheckpointCount = sgrCheckpoints.size;
    return state;
  }

  function buildRenderedWindow(start: number, end: number): void {
    const rowCount = presentationRowCount();
    const boundedStart = Math.max(0, Math.min(start, rowCount));
    const boundedEnd = Math.max(boundedStart, Math.min(end, rowCount));
    const nextHtml = new Map<number, string>();
    const nextPlaceholderHtml = new Map<number, string>();
    const nextPlaceholderEntries = new Map<number, SgrState>();
    const nextEntries = new Map<number, SgrState>();
    const rawWindow = rawRangeForVisualWindow(boundedStart, boundedEnd);
    const state = stateBeforeLine(rawWindow.start);

    for (let visualRow = boundedStart; visualRow < boundedEnd; visualRow += 1) {
      const projectionRow = projectionRowAt(visualRow);
      if (!projectionRow) continue;
      for (
        let rawRow = projectionRow.rawRange.startLine;
        rawRow < projectionRow.rawRange.endLine;
        rawRow += 1
      ) {
        const gapEntry = gapEntryStateAt(rawRow);
        if (gapEntry) {
          Object.assign(state, cloneSgrState(gapEntry));
          sgrCheckpoints.set(rawRow, cloneSgrState(state));
        }
        if (rawRow === projectionRow.rawRange.startLine) {
          if (projectionRow.kind === 'bash-placeholder') {
            // Synthetic UI must never inherit an unrelated unclosed SGR/OSC 8
            // from the row before the tool call (black-on-black text, inverse,
            // strike, or a bogus clickable link). Hidden source still advances
            // the canonical `state` below, so the following real row is exact.
            const entry = createSgrState();
            nextPlaceholderEntries.set(visualRow, entry);
            // Render in a deterministic neutral style, but advance canonical
            // state only through the original hidden rows below.
            nextPlaceholderHtml.set(
              visualRow,
              htmlLine(projectionRow.line, cloneSgrState(entry)),
            );
          } else {
            nextEntries.set(rawRow, cloneSgrState(state));
            nextHtml.set(rawRow, htmlLine(rawLines[rawRow] ?? '', state, linksByLine[rawRow]));
            if ((rawRow + 1) % SGR_CHECKPOINT_INTERVAL === 0) {
              sgrCheckpoints.set(rawRow + 1, cloneSgrState(state));
            }
            continue;
          }
        }

        // Hidden rows still drive SGR + OSC 8 state so the first visible row
        // after a collapsed block is byte-for-byte equivalent to off mode.
        lineToHtml(rawLines[rawRow] ?? '', state, palette);
        if ((rawRow + 1) % SGR_CHECKPOINT_INTERVAL === 0) {
          sgrCheckpoints.set(rawRow + 1, cloneSgrState(state));
        }
      }
    }

    htmlCache = nextHtml;
    bashPlaceholderHtmlCache = nextPlaceholderHtml;
    bashPlaceholderEntryStates = nextPlaceholderEntries;
    renderEntryStates = nextEntries;
    renderCacheBuilds++;
    renderWindowPending = false;
    publishStorageDiagnostics();
  }

  function reindexSparseAfterRemoval(
    start: number,
    count: number,
    boundaryState: SgrState | null,
  ): void {
    const end = start + count;
    const nextCheckpoints = new Map<number, SgrState>();
    for (const [index, state] of sgrCheckpoints) {
      if (index < start) nextCheckpoints.set(index, state);
      else if (index >= end) nextCheckpoints.set(index - count, state);
    }
    if (boundaryState && start <= rawLines.length) {
      nextCheckpoints.set(start, cloneSgrState(boundaryState));
    }
    if (rawLines.length > 0 && !nextCheckpoints.has(0)) {
      nextCheckpoints.set(0, cloneSgrState(rawEntryState));
    }
    sgrCheckpoints = nextCheckpoints;

    const nextArchivedGaps = new Map<number, { rowCount: number; entryState: SgrState }>();
    for (const [index, gap] of archivedRetentionGaps) {
      if (index < start) nextArchivedGaps.set(index, gap);
      else if (index >= end) nextArchivedGaps.set(index - count, gap);
    }
    archivedRetentionGaps = nextArchivedGaps;

    const nextHtml = new Map<number, string>();
    const nextEntries = new Map<number, SgrState>();
    for (const [index, html] of htmlCache) {
      if (index < start) nextHtml.set(index, html);
      else if (index >= end) nextHtml.set(index - count, html);
    }
    for (const [index, state] of renderEntryStates) {
      if (index < start) nextEntries.set(index, state);
      else if (index >= end) nextEntries.set(index - count, state);
    }
    htmlCache = nextHtml;
    bashPlaceholderHtmlCache = new Map();
    bashPlaceholderEntryStates = new Map();
    renderEntryStates = nextEntries;
    publishStorageDiagnostics();
  }

  function reindexSparseAfterPrepend(stage: PrependStage): void {
    const count = stage.lines.length;
    const nextCheckpoints = new Map<number, SgrState>();
    for (const [index, state] of sgrCheckpoints) {
      nextCheckpoints.set(index + count, state);
    }
    for (const [index, state] of stage.checkpoints) {
      nextCheckpoints.set(index, cloneSgrState(state));
    }
    nextCheckpoints.set(count, cloneSgrState(stage.endState));
    sgrCheckpoints = nextCheckpoints;

    const nextArchivedGaps = new Map<number, { rowCount: number; entryState: SgrState }>();
    for (const [index, gap] of archivedRetentionGaps) {
      nextArchivedGaps.set(index + count, gap);
    }
    archivedRetentionGaps = nextArchivedGaps;

    const nextHtml = new Map<number, string>();
    const nextEntries = new Map<number, SgrState>();
    for (const [index, html] of htmlCache) nextHtml.set(index + count, html);
    for (const [index, state] of renderEntryStates) nextEntries.set(index + count, state);
    htmlCache = nextHtml;
    bashPlaceholderHtmlCache = new Map();
    bashPlaceholderEntryStates = new Map();
    renderEntryStates = nextEntries;
    publishStorageDiagnostics();
  }

  function stageStateBefore(stage: PrependStage, index: number): SgrState {
    const target = Math.max(0, Math.min(index, stage.lines.length));
    let checkpointIndex = 0;
    let checkpointState = stage.checkpoints.get(0) ?? createSgrState();
    for (const [candidate, state] of stage.checkpoints) {
      if (candidate <= target && candidate >= checkpointIndex) {
        checkpointIndex = candidate;
        checkpointState = state;
      }
    }
    const state = cloneSgrState(checkpointState);
    for (let i = checkpointIndex; i < target; i++) {
      lineToHtml(stage.lines[i] ?? '', state, palette);
    }
    return state;
  }

  function slicePrependStage(stage: PrependStage, keepFrom: number): PrependStage {
    if (keepFrom === 0) return stage;
    const checkpoints = new Map<number, SgrState>();
    checkpoints.set(0, stageStateBefore(stage, keepFrom));
    for (const [index, state] of stage.checkpoints) {
      if (index > keepFrom) checkpoints.set(index - keepFrom, state);
    }
    return {
      ...stage,
      lines: stage.lines.slice(keepFrom),
      checkpoints,
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
    const projectBash = normalizedClaudeBashMode() !== 'off';
    const presentationAnchor = projectBash ? capturePresentationAnchor() : null;

    if (liveLines.length > 0) {
      let absorbedGapRows = 0;
      for (const [index, gap] of archivedRetentionGaps) {
        if (index >= from && index < archiveLength) absorbedGapRows += gap.rowCount;
      }
      liveGapEntryState = stateBeforeLine(archiveLength);
      recordRetentionGap(from, evicted);
      gapRowCount += absorbedGapRows;
    }

    archivedLines.splice(from, evicted);
    rawLines.splice(from, evicted);
    linksByLine.splice(from, evicted);
    reindexSparseAfterRemoval(from, evicted, liveGapEntryState);
    if (projectBash) rebuildClaudeBashProjection(presentationAnchor, undefined, 'history');
    else {
      total = rawLines.length;
      bottomOffsetPx = Math.max(0, bottomOffsetPx - evicted * lineH);
    }
    return evicted;
  }

  function dropRetainedPrependPrefix(count: number): void {
    if (count <= 0) return;
    const projectBash = normalizedClaudeBashMode() !== 'off';
    const presentationAnchor = projectBash ? capturePresentationAnchor() : null;
    const nextEntryState = stateBeforeLine(count);
    const archivedCount = Math.min(count, archivedLines.length);
    const liveCount = count - archivedCount;
    archivedLines.splice(0, archivedCount);
    if (liveCount > 0) {
      liveLines.splice(0, liveCount);
      retainedLivePrefixBeforeBoundary = Math.max(
        0,
        retainedLivePrefixBeforeBoundary - liveCount,
      );
    }
    rawLines.splice(0, count);
    linksByLine.splice(0, count);
    rawEntryState = nextEntryState;
    reindexSparseAfterRemoval(0, count, nextEntryState);
    if (archivedLines.length === 0) liveGapEntryState = null;
    archiveOffset += count;
    if (gapRowIndex >= 0) {
      if (gapRowIndex < count) clearRetentionGap();
      else gapRowIndex -= count;
    }
    if (projectBash) rebuildClaudeBashProjection(presentationAnchor, undefined, 'history');
    else {
      total = rawLines.length;
      winStart = Math.max(0, winStart - count);
      winEnd = Math.max(0, winEnd - count);
    }
  }

  /** Drop the oldest live rows immediately below the archive/live seam while
   * retaining the newest live tail and its exact SGR entry state. */
  function dropRetainedLivePrefix(count: number): void {
    const bounded = Math.min(count, liveLines.length);
    if (bounded <= 0) return;
    const projectBash = normalizedClaudeBashMode() !== 'off';
    const presentationAnchor = projectBash ? capturePresentationAnchor() : null;
    const seam = archivedLines.length;
    const suffixEntry = stateBeforeLine(seam + bounded);
    liveLines.splice(0, bounded);
    retainedLivePrefixBeforeBoundary = Math.max(
      0,
      retainedLivePrefixBeforeBoundary - bounded,
    );
    rawLines.splice(seam, bounded);
    linksByLine.splice(seam, bounded);
    liveGapEntryState = liveLines.length > 0 ? suffixEntry : null;
    reindexSparseAfterRemoval(seam, bounded, liveGapEntryState);
    if (liveLines.length > 0) recordRetentionGap(seam, bounded);
    else clearRetentionGap();
    if (projectBash) rebuildClaudeBashProjection(presentationAnchor, undefined, 'history');
    else {
      total = rawLines.length;
      bottomOffsetPx = Math.max(0, bottomOffsetPx - bounded * lineH);
    }
  }

  /** Split live capture around the oldest safe rows below the mounted window.
   * The old seam becomes one sparse archived discontinuity, preserving both
   * what the reader sees and the newest live tail across repeated cuts. */
  function dropRetainedMiddle(from: number, count: number): void {
    const start = Math.max(0, Math.min(from, rawLines.length));
    const bounded = Math.min(count, rawLines.length - start);
    if (bounded <= 0) return;
    const projectBash = normalizedClaudeBashMode() !== 'off';
    const presentationAnchor = projectBash ? capturePresentationAnchor() : null;
    const suffixEntry = stateBeforeLine(start + bounded);
    archiveCurrentRetentionGap();
    rawLines.splice(start, bounded);
    linksByLine.splice(start, bounded);
    archivedLines = rawLines.slice(0, start);
    liveLines = rawLines.slice(start);
    // The legacy middle-gap split no longer has one contiguous absolute live
    // origin. A later durable page must establish a fresh seam rather than
    // consuming a stale prefix count across that explicit retention gap.
    retainedLivePrefixBeforeBoundary = 0;
    liveGapEntryState = liveLines.length > 0 ? suffixEntry : null;
    reindexSparseAfterRemoval(start, bounded, liveGapEntryState);
    if (liveGapEntryState) {
      gapRowIndex = start;
      gapRowCount = bounded;
    } else clearRetentionGap();
    if (projectBash) rebuildClaudeBashProjection(presentationAnchor, undefined, 'history');
    else {
      total = rawLines.length;
      bottomOffsetPx = Math.max(0, bottomOffsetPx - bounded * lineH);
    }
  }

  /** Enforce the same row/byte limits for live captures as history prepends.
   * The mounted window (including overscan) is inviolate: discard oldest rows
   * above it first, then the oldest safely representable rows below it. */
  function enforceLiveRetention(): void {
    let projectedRows = rawLines.length;
    let projectedBytes = retainedEstimatedBytes;
    let prefixCount = 0;
    const protectedRaw = rawRangeForVisualWindow(winStart, winEnd);
    const protectedStart = Math.max(0, Math.min(protectedRaw.start, rawLines.length));

    while (prefixCount < protectedStart && (
      projectedRows > HISTORY_RETAINED_ROW_BUDGET ||
      projectedBytes > HISTORY_RETAINED_BYTE_BUDGET
    )) {
      projectedRows--;
      projectedBytes -= estimatedLineStorageBytes(
        rawLines[prefixCount] ?? '',
        linksByLine[prefixCount],
      );
      prefixCount++;
    }

    if (prefixCount > 0) dropRetainedPrependPrefix(prefixCount);

    const protectedEnd = Math.max(0, Math.min(
      rawRangeForVisualWindow(winStart, winEnd).end,
      rawLines.length,
    ));
    let lowerCount = 0;
    if (protectedEnd <= archivedLines.length) {
      const archiveLength = archivedLines.length;
      let archiveFrom = archiveLength;
      while (archiveFrom > protectedEnd && (
        projectedRows > HISTORY_RETAINED_ROW_BUDGET ||
        projectedBytes > HISTORY_RETAINED_BYTE_BUDGET
      )) {
        archiveFrom--;
        projectedRows--;
        projectedBytes -= estimatedLineStorageBytes(
          rawLines[archiveFrom] ?? '',
          linksByLine[archiveFrom],
        );
        lowerCount++;
      }
      let livePrefixCount = 0;
      while (livePrefixCount < liveLines.length && (
        projectedRows > HISTORY_RETAINED_ROW_BUDGET ||
        projectedBytes > HISTORY_RETAINED_BYTE_BUDGET
      )) {
        const idx = archiveLength + livePrefixCount;
        projectedRows--;
        projectedBytes -= estimatedLineStorageBytes(
          rawLines[idx] ?? '',
          linksByLine[idx],
        );
        livePrefixCount++;
        lowerCount++;
      }
      if (archiveFrom < archiveLength) evictArchivedTail(archiveFrom);
      if (livePrefixCount > 0) dropRetainedLivePrefix(livePrefixCount);
      if (lowerCount > 0 && liveGapEntryState) rebuildGapLinkSeam();
    } else {
      let middleEnd = protectedEnd;
      // Keep a small newest overlap tail so the next capture can merge at the
      // server head even if the protected rows themselves consume the budget.
      const middleLimit = Math.max(
        protectedEnd,
        rawLines.length - HISTORY_LINK_SEAM_LINES,
      );
      while (middleEnd < middleLimit && (
        projectedRows > HISTORY_RETAINED_ROW_BUDGET ||
        projectedBytes > HISTORY_RETAINED_BYTE_BUDGET
      )) {
        projectedRows--;
        projectedBytes -= estimatedLineStorageBytes(
          rawLines[middleEnd] ?? '',
          linksByLine[middleEnd],
        );
        middleEnd++;
        lowerCount++;
      }
      if (lowerCount > 0) dropRetainedMiddle(protectedEnd, lowerCount);
    }

    if (prefixCount > 0 || lowerCount > 0) {
      total = presentationRowCount();
      recalculateRetainedEstimatedBytes();
      // Live eviction that fills the budget is the same stop as a refused
      // history page — older rows exist (or just got dropped) and we will
      // not ask for more. Without this, a 12k first capture sat at
      // total=10000 with history-stop still "none".
      if (atRetentionBudget()) markHistoryCeiling();
    }
  }

  function tailEvictionStartForCurrentBudget(_protectedEnd: number): number {
    // Sparse checkpoint/window reconstruction does not change retained bytes,
    // and retained archive rows are immutable at this stage. The caller's
    // incoming-prefix pass handles any excess without reopening a hole below
    // the reader.
    return archivedLines.length;
  }

  function rebuildFrom(idx: number) {
    if (idx <= 0) {
      sgrCheckpoints = rawLines.length > 0
        ? new Map([[0, cloneSgrState(rawEntryState)]])
        : new Map();
      sgrCheckpointCount = sgrCheckpoints.size;
    } else {
      invalidateCheckpointsAfter(idx);
    }
    invalidateRenderedCache();
    recalculateRetainedEstimatedBytes();
  }

  function reconcileExistingFrom(idx: number, entryState: SgrState): number {
    const previous = new Map(sgrCheckpoints);
    for (const checkpoint of sgrCheckpoints.keys()) {
      if (checkpoint >= idx) sgrCheckpoints.delete(checkpoint);
    }
    const state = cloneSgrState(entryState);
    sgrCheckpoints.set(idx, cloneSgrState(state));
    for (let i = idx; i < rawLines.length; i++) {
      const gapEntry = gapEntryStateAt(i);
      if (gapEntry) {
        Object.assign(state, cloneSgrState(gapEntry));
      }
      const cachedEntry = previous.get(i);
      if (i > idx && cachedEntry && sgrStateKey(state) === sgrStateKey(cachedEntry)) {
        for (const [checkpoint, checkpointState] of previous) {
          if (checkpoint >= i) sgrCheckpoints.set(checkpoint, checkpointState);
        }
        sgrCheckpointCount = sgrCheckpoints.size;
        return i;
      }
      if (i === idx || i % SGR_CHECKPOINT_INTERVAL === 0) {
        sgrCheckpoints.set(i, cloneSgrState(state));
      }
      lineToHtml(rawLines[i] ?? '', state, palette);
    }
    sgrCheckpoints.set(rawLines.length, cloneSgrState(state));
    sgrCheckpointCount = sgrCheckpoints.size;
    return rawLines.length;
  }

  function rerenderLineWithCachedEntry(idx: number) {
    if (idx < 0 || idx >= rawLines.length) return;
    const cachedEntry = renderEntryStates.get(idx);
    if (!cachedEntry || !htmlCache.has(idx)) return;
    const state = cloneSgrState(cachedEntry);
    htmlCache.set(idx, htmlLine(rawLines[idx], state, linksByLine[idx]));
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
    followTail: boolean;
    source: LinesChangeMeta['source'];
    /** A structural archive detach carries a live host cause but must not be
     * mistaken for newly completed shell work by the presentation queue. */
    projectionCause?: ClaudeBashProjectionCause;
    /** Sliding archive ownership enforces its own combined archive/live
     * budget. The legacy middle-gap retention algorithm must not mutate the
     * pure absolute window behind its back. */
    enforceRetention?: boolean;
  }) {
    // Snapshot the physical viewport before changing total/maxOffset. A
    // reader who is even one pixel away from the live tail owns this scroll
    // position; content updates may repaint any number of tail rows without
    // moving the rows already under their eyes. At exactly offset=0 the live
    // tail owns the viewport and follows the new maxOffset instead.
    const projectBash = normalizedClaudeBashMode() !== 'off';
    const presentationAnchor = projectBash && !opts.followTail
      ? capturePresentationAnchor()
      : null;
    const readerScrollTop = !projectBash && !opts.followTail
      ? maxOffset() - Math.max(0, Math.min(bottomOffsetPx, maxOffset()))
      : null;

    // Find common prefix so unchanged history isn't re-parsed.
    let common = 0;
    const minLen = Math.min(rawLines.length, next.length);
    while (common < minLen && rawLines[common] === next[common]) common++;
    const linesChanged = rawLines.length !== next.length || common !== minLen;

    rawLines = next;
    if (projectBash) rebuildClaudeBashProjection(
      presentationAnchor,
      common,
      opts.projectionCause ?? (opts.source === 'live' ? 'live' : 'replace'),
    );
    else {
      bashProjection = null;
      rebuildPresentationGeometry();
      cachedClaudeBashDetection = null;
      cachedClaudeBashDetectionRawLength = 0;
      cachedClaudeBashDetectionScreenMode = null;
      cachedClaudeBashBarrierKey = '';
      lastClaudeBashDetectionScanRows = 0;
      lastClaudeBashProjectionBuildRows = 0;
      total = next.length;
    }
    rebuildAllLinks();
    rebuildFrom(common);
    if (!projectBash) {
      bottomOffsetPx = opts.followTail
        ? 0
        : Math.max(0, maxOffset() - (readerScrollTop ?? 0));
    }
    bottomOffsetPx = Math.min(bottomOffsetPx, maxOffset());
    // Content delivery is already gated outside gestures. Establish the exact
    // protected viewport+overscan for the enlarged model before trimming it.
    rebuildWindow(visibleRowRange(bottomOffsetPx));
    if (opts.enforceRetention !== false) enforceLiveRetention();
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
    scheduleDeferredFrame(() => searchComponent?.focusInput());
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
    // straight past the match we just centred. Stopping inertia removes the
    // settle callback that would have flushed deferred live content, so flush
    // here or the command's final output can stay invisible under the match.
    stopInertia();
    flushPendingContent();
    const visualRow = visualRowForRaw(line);
    if (compactBashVisualRows.length === 0) {
      bottomOffsetPx = searchJumpBottomOffset({
        line: visualRow,
        total,
        lineH,
        viewH,
      });
    } else {
      const mo = maxOffset();
      const rowTop = presentationRowTopPx(visualRow);
      const rowHeight = presentationRowHeightPx(visualRow);
      const targetScrollTop = Math.max(
        0,
        Math.min(rowTop - (viewH / 2 - rowHeight / 2), mo),
      );
      bottomOffsetPx = Math.max(0, Math.min(mo - targetScrollTop, mo));
    }
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

  /** Exact content is the only row identity available across a reset. An
   * in-place resize/resync can retain same-position prefix/suffix rows, while
   * an advanced capture retains an old suffix at the new prefix. Keep the
   * stronger exact continuity proof. Every scan is bounded linear time; only
   * the shared matcher's KMP fallback allocates O(nextLive.length) scratch. */
  function replaceRetainedOverlapRows(previousLive: string[], nextLive: string[]): number {
    const alignedLimit = Math.min(previousLive.length, nextLive.length);
    let alignedPrefix = 0;
    while (
      alignedPrefix < alignedLimit &&
      previousLive[alignedPrefix] === nextLive[alignedPrefix]
    ) {
      alignedPrefix++;
    }

    let overlap: number;
    if (alignedPrefix === alignedLimit) {
      overlap = alignedPrefix;
    } else {
      let alignedSuffix = 0;
      while (
        alignedPrefix + alignedSuffix < alignedLimit &&
        previousLive[previousLive.length - 1 - alignedSuffix] ===
          nextLive[nextLive.length - 1 - alignedSuffix]
      ) {
        alignedSuffix++;
      }
      const inPlaceOverlap = alignedPrefix + alignedSuffix;
      overlap = Math.max(inPlaceOverlap, findLineOverlap(previousLive, nextLive));
    }

    // Repetitive content can match on a full shorter-window overlap that does
    // not prove continuity. Keep one row of churn when shrinking a repeated
    // run so a real discard is still recorded in the retention gap.
    if (
      alignedLimit > 1 &&
      previousLive.length > nextLive.length &&
      overlap === alignedLimit &&
      previousLive[previousLive.length - alignedLimit - 1] === nextLive[0]
    ) {
      overlap -= 1;
    }

    return overlap;
  }

  /** Merge a polling capture without letting a repainting TUI move the reader.
   *
   * A fixed tmux capture window commonly advances by one or more rows while
   * Claude/Codex repaint their whole composer/status area. The core exact
   * suffix-to-prefix merge cannot prove that shift because the old mutable
   * screen tail no longer equals the new prefix, so replacing the snapshot
   * would move every visible row forward on every streaming frame.
   *
   * tmux can only repaint the current pane. Trim one maximum pane from the old
   * capture, use the remaining immutable suffix as the chronological seam,
   * retain only the rows that genuinely left the new window, and take the new
   * snapshot verbatim for the overlap + live tail. A weak seam fails closed to
   * the ordinary replacement path instead of guessing from repeated chrome.
   */
  function mergeLiveCaptureForStableReader(
    previousLive: string[],
    nextLive: string[],
  ) {
    const exact = mergeCapturedLinesForStableScroll(previousLive, nextLive);
    const measuredRows = Number.isFinite(lastPushedRows)
      ? Math.max(0, Math.floor(lastPushedRows))
      : 0;
    const configuredRows = Number.isFinite(maxRows)
      ? Math.max(0, Math.floor(maxRows))
      : 0;
    const mutableTailRows = Math.max(measuredRows, configuredRows);
    const immutableLength = previousLive.length - mutableTailRows;
    const minimumReliableOverlap = 8;
    if (
      immutableLength < minimumReliableOverlap
      || nextLive.length < minimumReliableOverlap
    ) {
      return exact;
    }

    const immutablePrevious = previousLive.slice(0, immutableLength);
    const overlap = findLineOverlap(immutablePrevious, nextLive);
    if (overlap >= minimumReliableOverlap) {
      const departedRows = immutablePrevious.length - overlap;
      const lines = [
        ...previousLive.slice(0, departedRows),
        ...nextLive,
      ];
      return {
        lines,
        appendedLineCount: lines.length - previousLive.length,
        preservedPrefix: true,
      };
    }

    // Short tail-only deliveries legitimately rely on the core exact seam.
    // For full windows the pane seam above wins first, so repeated composer
    // chrome cannot override a stronger chronological match.
    return exact;
  }

  /**
   * Preserve the reader-owned projection when a legacy capture has no durable
   * row boundary and neither exact overlap nor the immutable pane seam proves
   * continuity. The newest whole capture replaces the previous deferred one,
   * matching the content gate's bounded coalescing contract.
   */
  function deferUnprovenLegacyLiveCapture(
    nextLive: string[],
    source: LinesChangeMeta['source'],
    replace = false,
    boundary?: MuxHistoryBoundary,
  ): void {
    const previous = deferredLegacyLiveCapture;
    const boundedLines = archiveWindow === null
      ? boundLinesToRetentionBudget(nextLive)
      : boundLiveLinesForArchive(nextLive, archiveWindow);
    deferredLegacyLiveCapture = {
      lines: boundedLines,
      source: previous?.source === 'live' || source === 'live' ? 'live' : source,
      replace: previous?.replace === true || replace,
      boundary: boundary ? { ...boundary } : undefined,
    };
    // SessionView uses this signal to label its already-visible tail control
    // as new content. Keep the payload truthful to the frozen visible model;
    // the newest canonical capture is published only when it is committed.
    onLinesChange?.([...rawLines], { source: deferredLegacyLiveCapture.source });
    emitScrollState();
  }

  /** Apply the newest deferred legacy delivery only at an explicit/local tail
   * rejoin. Route it through the ordinary boundary/archive path so a history
   * window that detached in the meantime remains pageable instead of being
   * accidentally concatenated to the live pane. */
  function rejoinDeferredLegacyLiveCapture(): boolean {
    const pending = deferredLegacyLiveCapture;
    if (!pending) return false;
    deferredLegacyLiveCapture = null;
    const boundaryReconciliation = reconcileLiveBoundary(pending.boundary);
    if (!boundaryReconciliation.acceptDelivery) return true;
    setLines(
      pending.lines,
      pending.replace,
      pending.source,
      boundaryReconciliation,
    );
    return true;
  }

  /** Bound a deferred whole capture by the same retained row/byte ceilings as
   * a committed legacy model. This is one newest suffix, never an event queue. */
  function boundLinesToRetentionBudget(lines: readonly string[]): string[] {
    let rowsLeft = HISTORY_RETAINED_ROW_BUDGET;
    let bytesLeft = HISTORY_RETAINED_BYTE_BUDGET;
    let start = lines.length;
    while (start > 0 && rowsLeft > 0) {
      // Deferred state stores raw strings only. URL/render metadata is built
      // after commit, so accounting it here would add work without bounding
      // any additional pending allocation.
      const bytes = estimatedLineStorageBytes(lines[start - 1] ?? '', undefined);
      if (bytes > bytesLeft) break;
      start--;
      rowsLeft--;
      bytesLeft -= bytes;
    }
    return Array.from(lines.slice(start));
  }

  /** Keep the newest pane capture rows that fit beside the resident archive.
   * Detached live content is never rendered, but it is still bounded RAM and
   * is ready to rejoin when forward paging reaches the archive/live seam. */
  function boundLiveLinesForArchive(
    lines: readonly string[],
    state: HistoryWindowState,
  ): string[] {
    const lineBytes = estimatedHistoryWindowLineStorage(lines);
    let rowsLeft = Math.max(0, HISTORY_RETAINED_ROW_BUDGET - state.lines.length);
    let bytesLeft = Math.max(0, HISTORY_RETAINED_BYTE_BUDGET - state.estimatedBytes);
    let start = lines.length;
    while (start > 0 && rowsLeft > 0) {
      const bytes = lineBytes[start - 1] ?? 0;
      if (bytes > bytesLeft) break;
      start--;
      rowsLeft--;
      bytesLeft -= bytes;
    }
    return Array.from(lines.slice(start));
  }

  function clearSlidingArchiveAtBoundary(liveStartLine: number, resetReader: boolean): void {
    archiveWindow = null;
    archiveWindowAttachedToLive = true;
    detachedLiveProjectionPending = false;
    archivedLines = [];
    archiveBeforeLine = null;
    archiveExhausted = false;
    historyStopReason = 'none';
    archiveOffset = liveStartLine;
    retainedLivePrefixBeforeBoundary = 0;
    if (resetReader) {
      historyReaderAtUnscrollableTail = false;
      deferredUnscrollableHistoryPx = 0;
      bottomOffsetPx = 0;
    }
  }

  function detachSlidingArchiveFromLive(liveStartLine: number): void {
    if (
      !archiveWindow
      || historyWindowEndLine(archiveWindow) >= liveStartLine
      || (archiveWindow.hasNewer && !archiveWindowAttachedToLive)
    ) return;
    const readerScrollTop = maxOffset() - Math.max(0, Math.min(bottomOffsetPx, maxOffset()));
    archiveWindow = { ...archiveWindow, hasNewer: true };
    archiveWindowAttachedToLive = false;
    archivedLines = Array.from(archiveWindow.lines);
    commitLines([...archivedLines], {
      followTail: false,
      source: 'live',
      projectionCause: 'history',
      enforceRetention: false,
    });
    bottomOffsetPx = Math.max(0, Math.min(maxOffset(), maxOffset() - readerScrollTop));
    rebuildWindow(visibleRowRange(bottomOffsetPx), true);
    applyScroll();
    emitScrollState();
  }

  /**
   * If the reader's mounted viewport overlaps rows that just crossed the seam,
   * promote that exact old-live prefix into the resident archive. This keeps
   * the same absolute rows under the reader while the paired new live capture
   * replaces the suffix. It is only an optimization for rows proven by the
   * monotonic boundary; all other detached readers page from the server.
   */
  function promoteCrossedLiveRows(
    previousLiveStart: number,
    nextLiveStart: number,
  ): boolean {
    if (!archiveWindow || historyWindowEndLine(archiveWindow) !== previousLiveStart) return false;
    const crossed = nextLiveStart - previousLiveStart;
    if (crossed <= 0 || crossed > liveLines.length) return false;
    const visible = strictVisibleRowRange(bottomOffsetPx);
    const visibleRaw = rawRangeForVisualWindow(visible.startIdx, visible.endIdx);
    if (visibleRaw.end <= archiveWindow.lines.length) return false;
    const promoted = liveLines.slice(0, crossed);
    try {
      archiveWindow = createHistoryWindow({
        startLine: archiveWindow.startLine,
        lines: [...archiveWindow.lines, ...promoted],
        lineBytes: [...archiveWindow.lineBytes, ...estimatedHistoryWindowLineStorage(promoted)],
        hasOlder: archiveWindow.hasOlder,
        hasNewer: false,
        limits: archiveWindow.limits,
      });
      archivedLines = Array.from(archiveWindow.lines);
      archiveWindowAttachedToLive = true;
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Reconcile a mux-validated durable seam before applying its paired live
   * capture. At the tail, stale archive rows are cheap to discard and can be
   * re-seeded from the new liveStart later. A detached reader keeps the exact
   * resident absolute rows and scrollTop, but the window becomes pageable on
   * its newer edge so it can walk to the new seam without a hole or duplicate.
   */
  type LiveBoundaryReconciliation = {
    acceptDelivery: boolean;
    advancedRows: number;
    useCanonicalLiveCapture: boolean;
  };

  function reconcileLiveBoundary(
    boundary: MuxHistoryBoundary | undefined,
  ): LiveBoundaryReconciliation {
    const unchanged: LiveBoundaryReconciliation = {
      acceptDelivery: true,
      advancedRows: 0,
      useCanonicalLiveCapture: false,
    };
    if (!boundary || historyPaging !== 'sliding') return unchanged;
    const previous = liveBoundary;
    if (previous && muxHistoryBoundaryTransition(previous, boundary) === 'regression') {
      // A reconnecting transport can race a cached full frame behind the last
      // accepted durable seam. Its absolute identity is stale even if its
      // bytes look plausible, so reject its content and cursor together with
      // every monotonic coordinate instead of only preserving the boundary.
      return { ...unchanged, acceptDelivery: false };
    }
    liveBoundary = { ...boundary };
    archiveTotalHint = Math.max(archiveTotalHint, boundary.liveStartLine);

    if (previous && previous.generation !== boundary.generation) {
      // ws-mux only accepts a generation switch on a resync full. Absolute row
      // identities from the old WAL lane are meaningless in the new one.
      cancelScheduledPrependWork();
      pendingPrependWork = null;
      prependParseSeq++;
      if (archiveRequestActive && archiveInflightRequestId !== null) {
        try {
          tmuxMux.recoverHistoryRequest(archiveInflightSession ?? session);
        } catch {
          // The generation reset still owns the local fence even if socket
          // recovery throws after detaching the abandoned transport.
        }
      }
      if (archiveInflightRequestId !== null || archiveLoading) {
        finishArchiveRequest('malformed');
      }
      archiveTotalHint = boundary.liveStartLine;
      liveLines = [];
      clearSlidingArchiveAtBoundary(boundary.liveStartLine, true);
      return unchanged;
    }
    const advancedRows = previous
      ? Math.max(0, boundary.liveStartLine - previous.liveStartLine)
      : 0;
    const advanced: LiveBoundaryReconciliation = {
      acceptDelivery: true,
      advancedRows,
      useCanonicalLiveCapture: false,
    };
    if (
      !archiveWindow
      || (previous && boundary.liveStartLine <= previous.liveStartLine)
    ) return advanced;

    const residentEnd = historyWindowEndLine(archiveWindow);
    if (
      residentEnd === boundary.liveStartLine
      && archiveWindow.hasNewer
      && !archiveWindowAttachedToLive
    ) {
      // A history reply can observe a newer durable head before its paired
      // output frame reaches this client. Keep that page detached until this
      // exact equality arrives, then join it to the canonical capture without
      // content-merging the stale live snapshot that preceded the boundary.
      archiveWindow = { ...archiveWindow, hasNewer: false };
      archivedLines = Array.from(archiveWindow.lines);
      archiveWindowAttachedToLive = true;
      return { acceptDelivery: true, advancedRows, useCanonicalLiveCapture: true };
    }
    if (residentEnd >= boundary.liveStartLine) return advanced;
    if (!isAwayFromLiveTail()) {
      clearSlidingArchiveAtBoundary(boundary.liveStartLine, false);
      return advanced;
    }

    if (previous && promoteCrossedLiveRows(previous.liveStartLine, boundary.liveStartLine)) {
      return { acceptDelivery: true, advancedRows, useCanonicalLiveCapture: true };
    }

    detachSlidingArchiveFromLive(boundary.liveStartLine);
    return advanced;
  }

  function setLines(
    nextLive: string[],
    replace = false,
    source: LinesChangeMeta['source'] = replace ? 'replace' : 'live',
    boundaryReconciliation: LiveBoundaryReconciliation = {
      acceptDelivery: true,
      advancedRows: 0,
      useCanonicalLiveCapture: false,
    },
  ) {
    if (
      historyPaging === 'sliding' &&
      archiveWindow !== null &&
      !archiveWindowAttachedToLive
    ) {
      // A reader in a detached archive owns the visible model. Keep only a
      // bounded fresh live suffix offscreen; repainting it must not change
      // total/maxOffset, cursor visibility, search, selection, or the anchor.
      liveLines = boundLiveLinesForArchive(nextLive, archiveWindow);
      deferredLegacyLiveCapture = null;
      retainedLivePrefixBeforeBoundary = 0;
      detachedLiveProjectionPending = true;
      return;
    }

    const followTail = !isAwayFromLiveTail();
    const replaceRetainedRows = replace
      ? replaceRetainedOverlapRows(liveLines, nextLive)
      : 0;
    if (boundaryReconciliation.useCanonicalLiveCapture) {
      // The monotonic seam already moved the crossed old-live prefix into the
      // archive. The paired capture starts at the new boundary, so retaining
      // the same prefix in liveLines would render those absolute rows twice.
      liveLines = nextLive;
      retainedLivePrefixBeforeBoundary = 0;
    } else if (
      !followTail
      && historyPaging === 'sliding'
      && archiveWindow === null
      && liveLines.length > 0
      && !noScrollback
      && (
        retainedLivePrefixBeforeBoundary > 0
        || boundaryReconciliation.advancedRows > 0
      )
    ) {
      // Once a durable seam has identified an immutable prefix, every frame
      // at that seam must compose that prefix with the complete canonical live
      // snapshot. Text overlap is not row identity: a full-screen repaint can
      // change every byte, while a repeated status screen can make unrelated
      // rows look identical.
      const canonicalResidentRows = Math.max(
        0,
        liveLines.length - retainedLivePrefixBeforeBoundary,
      );
      const advancedRows = boundaryReconciliation.advancedRows;
      if (advancedRows <= canonicalResidentRows) {
        const previousLength = liveLines.length;
        retainedLivePrefixBeforeBoundary += advancedRows;
        liveLines = [
          ...liveLines.slice(0, retainedLivePrefixBeforeBoundary),
          ...nextLive,
        ];
        if (liveLines.length > previousLength) {
          archiveExhausted = false;
          clearHistoryStopIfResumed();
        }
      } else {
        // The seam jumped beyond every resident canonical row. Keep no
        // guessed prefix; the next absolute history page will fill whatever
        // durable range the server still retains.
        liveLines = nextLive;
        retainedLivePrefixBeforeBoundary = 0;
      }
    } else if (replace) {
      // Resize/resync captures reflow only the current live window. Archived
      // rows remain physical history at their original width. A resync can
      // replay the same cached content, so count only old rows not covered by
      // exact content continuity proven across both live windows.
      const discardedLiveRows = gapRowIndex >= 0 && gapRowCount > 0
        ? liveLines.length - replaceRetainedRows
        : 0;
      liveLines = nextLive;
      retainedLivePrefixBeforeBoundary = 0;
      if (discardedLiveRows > 0) {
        recordRetentionGap(archivedLines.length, discardedLiveRows);
      }
    } else if (!followTail && liveLines.length > 0 && !noScrollback) {
      const merged = mergeLiveCaptureForStableReader(liveLines, nextLive);
      if (!merged.preservedPrefix && liveBoundary === null) {
        deferUnprovenLegacyLiveCapture(nextLive, source);
        return;
      }
      liveLines = merged.lines;
      if (historyPaging === 'sliding' && archiveWindow === null && merged.preservedPrefix) {
        retainedLivePrefixBeforeBoundary = Math.min(
          liveLines.length,
          retainedLivePrefixBeforeBoundary + boundaryReconciliation.advancedRows,
        );
      } else if (!merged.preservedPrefix) {
        retainedLivePrefixBeforeBoundary = 0;
      }
      if (merged.appendedLineCount > 0) {
        archiveExhausted = false;
        clearHistoryStopIfResumed();
      }
    } else {
      liveLines = nextLive;
      retainedLivePrefixBeforeBoundary = 0;
    }

    deferredLegacyLiveCapture = null;

    if (historyPaging === 'sliding' && archiveWindow !== null) {
      liveLines = boundLiveLinesForArchive(liveLines, archiveWindow);
      archivedLines = Array.from(archiveWindow.lines);
    }
    commitLines([...archivedLines, ...liveLines], {
      followTail,
      source,
      enforceRetention: historyPaging !== 'sliding' || archiveWindow === null,
    });
    detachedLiveProjectionPending = false;
    if (historyPaging === 'sliding' && archiveWindow === null) {
      // Legacy live-only retention may report a client ceiling at exactly
      // 10k. Sliding mode can still page by replacing the opposite archive
      // side, so this is not a terminal stop.
      historyStopReason = 'none';
    }
  }

  function atRetentionBudget(): boolean {
    return (
      rawLines.length >= HISTORY_RETAINED_ROW_BUDGET ||
      retainedEstimatedBytes >= HISTORY_RETAINED_BYTE_BUDGET
    );
  }

  function markHistoryCeiling(): void {
    historyStopReason = 'ceiling';
  }

  function clearHistoryStopIfResumed(): void {
    // Live growth or a successful prepend may re-open the ask path.
    if (!archiveExhausted && !atRetentionBudget()) {
      historyStopReason = 'none';
    }
  }

  function requestArchiveHistory(direction: HistoryWindowDirection): boolean {
    // Unknown screen → treat as normal (has scrollback). Only a *known*
    // alternate screen suppresses expand. 0.15.2 discarded a late alt reply
    // (one wasted RT); refusing to ask until a sample arrived made history
    // stop for every host that never sends `screen`.
    if (noScrollback) return false;
    if (archiveLoading) return false;
    if (direction === 'after' && (historyPaging !== 'sliding' || archiveWindow === null)) {
      return false;
    }
    if (direction === 'before' && archiveExhausted) return false;
    if (historyPaging === 'ceiling' && atRetentionBudget()) {
      markHistoryCeiling();
      return false;
    }

    const slidingCursor = historyPaging === 'sliding' && archiveWindow !== null
      ? historyWindowRequestCursor(archiveWindow, direction)
      : null;
    if (historyPaging === 'sliding' && archiveWindow !== null && slidingCursor === null) {
      if (direction === 'before') archiveExhausted = true;
      return false;
    }
    const cursorLine = slidingCursor === null
      ? null
      : slidingCursor.direction === 'before'
        ? slidingCursor.beforeLine
        : slidingCursor.afterLine;

    const requestId = ++archiveRequestSeq;
    const requestSession = session;
    archiveInflightRequestId = requestId;
    archiveInflightSession = requestSession;
    archiveInflightDirection = direction;
    archiveInflightAnchorLine = cursorLine;
    archiveLoading = true;
    archiveRequestActive = true;
    if (archiveRequestTimer) clearTimeout(archiveRequestTimer);
    archiveRequestTimer = setTimeout(() => {
      // Superseded, finished, or already claimed by a reply — ignore. A timer
      // task can still run after clearTimeout when it was already queued.
      if (archiveInflightRequestId !== requestId || !archiveRequestActive) return;
      // A tokenless late reply cannot be distinguished from a retry on the
      // same wire. Retire that wire first; all mux subscriptions re-arm on the
      // replacement connection and the next eligible scroll can retry safely.
      try {
        tmuxMux.recoverHistoryRequest(requestSession);
      } catch {
        // Recovery detaches the ambiguous wire before it attempts a new
        // connection. A host URL/socket failure must not strand local state.
      }
      const settled = settleArchiveContinuationRequest('timeout');
      if (searchQuery && settled) {
        requestSearchRerun();
      }
      archiveLoading = false;
      archiveRequestActive = false;
      archiveInflightRequestId = null;
      archiveInflightSession = null;
      archiveInflightDirection = null;
      archiveInflightAnchorLine = null;
      archiveRequestTimer = null;
      if (archiveWindow === null && historyReaderAtUnscrollableTail) {
        historyReaderAtUnscrollableTail = false;
        deferredUnscrollableHistoryPx = 0;
        applyScroll();
      }
    }, HISTORY_REPLY_TIMEOUT_MS);

    // Mux rejection (another request owns this session, no open socket, or a
    // failed send) must not leave a phantom request that consumes another
    // caller's broadcast history reply or waits through a pointless timeout.
    const accepted = direction === 'before'
      ? tmuxMux.requestHistory(
          requestSession,
          historyPaging === 'sliding' ? cursorLine : archiveBeforeLine,
          HISTORY_BATCH_LINES,
        )
      : tmuxMux.requestHistoryAfter(requestSession, cursorLine, HISTORY_BATCH_LINES);
    if (!accepted) {
      if (archiveRequestTimer) clearTimeout(archiveRequestTimer);
      archiveRequestTimer = null;
      archiveLoading = false;
      archiveRequestActive = false;
      archiveInflightRequestId = null;
      archiveInflightSession = null;
      archiveInflightDirection = null;
      archiveInflightAnchorLine = null;
      return false;
    }
    return true;
  }

  function requestOlderHistory(): boolean {
    return requestArchiveHistory('before');
  }

  function requestNewerHistory(): boolean {
    return requestArchiveHistory('after');
  }

  function historyPrefetchThreshold(): number {
    return Math.max(2 * viewH, 24 * lineH);
  }

  function maybeRequestOlderHistory(projectedBottomOffset = bottomOffsetPx): boolean {
    const canDeferUnscrollableHistory = (
      historyPaging === 'sliding'
      && maxOffset() === 0
    );
    if (
      canDeferUnscrollableHistory
      && archiveLoading
      && archiveInflightDirection === 'before'
      && projectedBottomOffset > 0
    ) {
      deferredUnscrollableHistoryPx = Math.max(
        deferredUnscrollableHistoryPx,
        projectedBottomOffset,
      );
      // A downward gesture may have relinquished the logical reader claim
      // without cancelling the already accepted tokenless request. A fresh
      // upward gesture must reclaim that same in-flight page so its new pixel
      // intent is replayed when the reply arrives.
      historyReaderAtUnscrollableTail = true;
      applyScroll();
    }
    if (archiveLoading || archiveExhausted || total === 0) return false;
    if (projectedBottomOffset < maxOffset() - historyPrefetchThreshold()) return false;
    const accepted = requestOlderHistory();
    if (accepted && canDeferUnscrollableHistory) {
      historyReaderAtUnscrollableTail = true;
      deferredUnscrollableHistoryPx = Math.max(
        deferredUnscrollableHistoryPx,
        Math.max(0, projectedBottomOffset),
      );
      // The physical transform is unchanged, but the public/coarse state must
      // immediately say that the reader—not the live tail—owns this viewport.
      applyScroll();
    }
    return accepted;
  }

  function maybeRequestNewerHistory(projectedBottomOffset = bottomOffsetPx) {
    if (
      historyPaging !== 'sliding' ||
      archiveLoading ||
      archiveWindow === null ||
      !archiveWindow.hasNewer ||
      total === 0
    ) return;
    if (projectedBottomOffset <= historyPrefetchThreshold()) requestNewerHistory();
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
    page?: {
      direction: HistoryWindowDirection;
      indexDelta: number;
      startLine: number;
      endLine: number;
    },
  ) {
    const transformStable = before.transform === after.transform;
    viewportEl?.dispatchEvent(new CustomEvent('thumbmux-history-prepend', {
      detail: {
        lineCount,
        // The public cache diagnostic is valid only when the compositor origin
        // is unchanged too. A compact Bash divider can preserve the exact
        // raw/SGR corridor while changing presentation geometry by one third
        // of a row; report that seam as uncached instead of a false success.
        cacheValid: cacheValid && transformStable,
        before,
        after,
        transformStable,
        ...page,
      },
    }));
  }

  function finishArchiveRequest(settlement?: ArchiveContinuationSettlement['kind']) {
    if (settlement) settleArchiveContinuationRequest(settlement);
    archiveLoading = false;
    archiveRequestActive = false;
    archiveInflightRequestId = null;
    archiveInflightSession = null;
    archiveInflightDirection = null;
    archiveInflightAnchorLine = null;
    if (archiveRequestTimer) {
      clearTimeout(archiveRequestTimer);
      archiveRequestTimer = null;
    }
    if (
      settlement !== undefined
      && settlement !== 'committed'
      && archiveWindow === null
      && historyReaderAtUnscrollableTail
    ) {
      // A rejected/empty first page left no history world for the logical
      // reader claim to own. Return to ordinary live-tail following.
      historyReaderAtUnscrollableTail = false;
      deferredUnscrollableHistoryPx = 0;
      applyScroll();
    }
  }

  function cancelScheduledPrependWork() {
    const cancel = cancelPrependWorkTask;
    cancelPrependWorkTask = null;
    cancel?.();
  }

  /** Run history parsing and commit only in background time after scrolling
   * settles. The callback checks busy again because a new gesture may begin
   * after the task was scheduled but before the browser invokes it. Native
   * selection also owns the mounted nodes — same deferral as live content. */
  function schedulePendingPrependWork() {
    if (
      destroyed ||
      busy() ||
      selectionActive ||
      pendingPrependWork === null ||
      cancelPrependWorkTask
    ) return;

    const run = () => {
      cancelPrependWorkTask = null;
      if (destroyed || busy() || selectionActive || pendingPrependWork === null) return;
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
    const projectBash = normalizedClaudeBashMode() !== 'off';
    const presentationAnchor = projectBash ? capturePresentationAnchor() : null;
    const previousWinStart = winStart;
    const previousWinEnd = winEnd;
    const previousWindowFirstRaw = projectBash
      ? projectionRowAt(previousWinStart)?.rawRange.startLine ?? 0
      : 0;
    const currentFirstState = cloneSgrState(rawEntryState);
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
      // Entire page discarded to stay inside the retention budget — more rows
      // may still exist on the server; this is the client ceiling, not EOF.
      archiveExhausted = true;
      markHistoryCeiling();
      const shouldRerun = settleArchiveContinuationRequest('committed');
      if (searchQuery && shouldRerun) requestSearchRerun(activeIdentity);
      finishArchiveRequest();
      return;
    }

    // Mutate the bounded columns in place: no prepend allocates/copies every
    // accumulated row into a new array. Work is capped by the retained budget.
    prependColumn(archivedLines, retainedStage.lines);
    prependColumn(rawLines, retainedStage.lines);
    prependLinks(retainedStage);
    reindexSparseAfterPrepend(retainedStage);
    rawEntryState = cloneSgrState(
      retainedStage.checkpoints.get(0) ?? retainedStage.endState,
    );

    archiveOffset -= lineCount;
    if (gapRowIndex >= 0) gapRowIndex += lineCount;
    if (projectBash) rebuildClaudeBashProjection(presentationAnchor, undefined, 'history');
    else {
      total = rawLines.length;
      winStart += lineCount;
      winEnd += lineCount;
    }
    if (projectBash) {
      // Preserve the existing mounted corridor just as off mode does. The
      // number of prepended *visual* rows may be much smaller than lineCount,
      // so derive the shift from the old first raw row after its index moves.
      const shiftedFirstVisual = visualRowForRaw(previousWindowFirstRaw + lineCount);
      const visualShift = Math.max(0, shiftedFirstVisual - previousWinStart);
      winStart = Math.max(0, Math.min(total, previousWinStart + visualShift));
      winEnd = Math.max(winStart, Math.min(total, previousWinEnd + visualShift));
    }

    if (!existingCacheValid) reconcileExistingFrom(lineCount, stage.endState);
    rerenderPrependSeam(retainedStage);
    recalculateRetainedEstimatedBytes();

    // Keep the post-reconciliation retention gate explicit. With window-only
    // HTML it normally short-circuits, but it must never evict retained rows.
    const postRenderTailStart = tailEvictionStartForCurrentBudget(winEnd);
    if (postRenderTailStart < archivedLines.length) {
      evictArchivedTail(postRenderTailStart);
      rebuildGapLinkSeam();
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
        linksByLine[extraPrefix],
      );
      extraPrefix++;
    }
    if (extraPrefix > 0) {
      dropRetainedPrependPrefix(extraPrefix);
      droppedIncomingPrefix += extraPrefix;
      lineCount -= extraPrefix;
      recalculateRetainedEstimatedBytes();
    }

    if (droppedIncomingPrefix > 0 && stage.startLine !== null) {
      const reloadBeforeLine = stage.startLine + droppedIncomingPrefix;
      if (Number.isSafeInteger(reloadBeforeLine)) {
        archiveBeforeLine = reloadBeforeLine;
        archiveExhausted = false;
        // Prefix was trimmed for budget — further expand is still blocked by
        // atRetentionBudget(), and the ceiling note must stay up.
        if (atRetentionBudget()) markHistoryCeiling();
        else clearHistoryStopIfResumed();
      }
    }

    if (lineCount === 0) {
      // A page rejected in full must not recolor/relink retained rows through
      // an invisible SGR/URL transition. Keep any safe off-window eviction,
      // restore the retained model from its previous entry checkpoint, and do
      // not emit a zero-row prepend event.
      rawEntryState = currentFirstState;
      archiveExhausted = true;
      markHistoryCeiling();
      rebuildAllLinks();
      rebuildFrom(0);
      if (projectBash) rebuildClaudeBashProjection(
        capturePresentationAnchor(),
        undefined,
        'history',
      );
      else total = rawLines.length;
      rebuildWindow(visibleRowRange(bottomOffsetPx));
      contentEpoch++;
      applyScroll();
      if (onLinesChange) onLinesChange([...rawLines], { source: 'prepend' });
      emitScrollState();
      const shouldRerun = settleArchiveContinuationRequest('committed');
      if (searchQuery && shouldRerun) requestSearchRerun(activeIdentity);
      finishArchiveRequest();
      return;
    }

    buildRenderedWindow(winStart, winEnd);
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
    scheduleDeferredFrame(() => {
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
    const checkpoints = new Map<number, SgrState>();
    const st = createSgrState();
    checkpoints.set(0, cloneSgrState(st));
    let idx = 0;

    const parseSlice = () => {
      if (seq !== prependParseSeq) return;
      const stop = Math.min(batch.length, idx + HISTORY_PARSE_CHUNK_LINES);
      for (; idx < stop; idx++) {
        if (idx % SGR_CHECKPOINT_INTERVAL === 0) {
          checkpoints.set(idx, cloneSgrState(st));
        }
        lineToHtml(batch[idx], st, palette, linkPlan.batchLinks[idx]);
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
        checkpoints,
        endState,
        linkPlan,
      });
    };

    enqueuePrependWork(parseSlice);
  }

  type ParsedHistoryPage = {
    lines: string[];
    startLine: number | null;
    endLine: number;
    totalArchivedLines: number;
    hasMore: boolean;
  };

  function parseHistoryPage(data: string): ParsedHistoryPage | null {
    let payload: unknown = null;
    try {
      payload = JSON.parse(data);
    } catch {
      return null;
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
    const candidate = payload as {
      lines?: unknown;
      startLine?: unknown;
      endLine?: unknown;
      totalArchivedLines?: unknown;
      hasMore?: unknown;
    };
    const validStartLine = candidate.startLine === undefined || candidate.startLine === null || (
      typeof candidate.startLine === 'number' &&
      Number.isSafeInteger(candidate.startLine) &&
      candidate.startLine >= 0
    );
    const validEndLine = candidate.endLine === undefined || candidate.endLine === null || (
      typeof candidate.endLine === 'number' &&
      Number.isSafeInteger(candidate.endLine) &&
      candidate.endLine >= 0
    );
    const validTotal = candidate.totalArchivedLines === undefined || (
      typeof candidate.totalArchivedLines === 'number' &&
      Number.isSafeInteger(candidate.totalArchivedLines) &&
      candidate.totalArchivedLines >= 0
    );
    if (
      !Array.isArray(candidate.lines) ||
      !candidate.lines.every((line) => typeof line === 'string') ||
      typeof candidate.hasMore !== 'boolean' ||
      !validStartLine ||
      !validEndLine ||
      !validTotal
    ) return null;

    const lines = candidate.lines as string[];
    const startLine = typeof candidate.startLine === 'number' ? candidate.startLine : null;
    const derivedEnd = startLine === null ? 0 : startLine + lines.length;
    const endLine = typeof candidate.endLine === 'number' ? candidate.endLine : derivedEnd;
    if (startLine !== null && endLine !== derivedEnd) return null;
    if (startLine === null && lines.length > 0) return null;
    const totalArchivedLines = typeof candidate.totalArchivedLines === 'number'
      ? candidate.totalArchivedLines
      : endLine;
    if (endLine > totalArchivedLines) return null;
    return {
      lines: [...lines],
      startLine,
      endLine,
      totalArchivedLines,
      hasMore: candidate.hasMore,
    };
  }

  function seedSlidingHistoryWindow(history: ParsedHistoryPage): {
    state: HistoryWindowState;
    live: string[];
    livePrefixDropped: number;
    entryState: SgrState;
    liveEntryState: SgrState | null;
    consumedRetainedLivePrefixRows: number;
  } | null {
    if (history.startLine === null || history.lines.length === 0) return null;

    // A reader can retain old live rows while the first tokenless history
    // request is in flight. Once a page reaches the current durable seam, its
    // suffix is authoritative for those crossed rows. Carry only any older
    // retained prefix that lies before the returned page, then let canonical
    // live content begin exactly at liveStartLine. This is absolute arithmetic
    // and remains correct when every row has identical text.
    const consumedRetainedLivePrefixRows = history.endLine === liveBoundary?.liveStartLine
      ? Math.min(retainedLivePrefixBeforeBoundary, liveLines.length)
      : 0;
    const pageOverlapRows = Math.min(
      consumedRetainedLivePrefixRows,
      history.lines.length,
    );
    const carriedPrefixRows = consumedRetainedLivePrefixRows - pageOverlapRows;
    const normalizedStartLine = history.startLine - carriedPrefixRows;
    if (normalizedStartLine < 0) return null;
    const normalizedHistoryLines = [
      ...liveLines.slice(0, carriedPrefixRows),
      ...history.lines,
    ];
    const canonicalLiveLines = liveLines.slice(consumedRetainedLivePrefixRows);

    // Make room for at least the newest incoming archive row. This only
    // matters for a live capture already sitting exactly on a client budget;
    // production captures are normally a much smaller pane-tail window.
    const lineBytes = estimatedHistoryWindowLineStorage(normalizedHistoryLines);
    const liveLineBytes = estimatedHistoryWindowLineStorage(canonicalLiveLines);
    const newestBytes = lineBytes.at(-1) ?? 0;
    let liveBytes = liveLineBytes.reduce((sum, bytes) => sum + bytes, 0);
    let livePrefixDropped = 0;
    while (
      livePrefixDropped < canonicalLiveLines.length && (
        canonicalLiveLines.length - livePrefixDropped >= HISTORY_RETAINED_ROW_BUDGET ||
        liveBytes + newestBytes > HISTORY_RETAINED_BYTE_BUDGET
      )
    ) {
      liveBytes -= liveLineBytes[livePrefixDropped] ?? 0;
      livePrefixDropped++;
    }
    const live = canonicalLiveLines.slice(livePrefixDropped);

    const limits: HistoryWindowLimits = {
      maxRows: Math.max(1, HISTORY_RETAINED_ROW_BUDGET - live.length),
      maxBytes: Math.max(1, HISTORY_RETAINED_BYTE_BUDGET - liveBytes),
      rowOverheadBytes: HISTORY_ROW_OVERHEAD_BYTES,
    };
    let keepFrom = 0;
    let retainedBytes = lineBytes.reduce((sum, bytes) => sum + bytes, 0);
    while (
      keepFrom < normalizedHistoryLines.length && (
        normalizedHistoryLines.length - keepFrom > limits.maxRows ||
        retainedBytes > limits.maxBytes
      )
    ) {
      retainedBytes -= lineBytes[keepFrom] ?? 0;
      keepFrom++;
    }
    if (keepFrom >= normalizedHistoryLines.length) return null;

    try {
      const entryState = createSgrState();
      for (let index = 0; index < keepFrom; index++) {
        lineToHtml(normalizedHistoryLines[index] ?? '', entryState, palette);
      }
      let liveEntryState: SgrState | null = null;
      if (livePrefixDropped > 0 && live.length > 0) {
        // `entryState` is the state before the retained archive. Replay only
        // the bounded resident archive and the evicted live prefix to preserve
        // the exact SGR state at the archive/live gap without storing either
        // missing live rows or per-row render state.
        liveEntryState = cloneSgrState(entryState);
        for (let index = keepFrom; index < normalizedHistoryLines.length; index++) {
          lineToHtml(normalizedHistoryLines[index] ?? '', liveEntryState, palette);
        }
        for (let index = 0; index < livePrefixDropped; index++) {
          lineToHtml(canonicalLiveLines[index] ?? '', liveEntryState, palette);
        }
      }
      return {
        state: createHistoryWindow({
          startLine: normalizedStartLine + keepFrom,
          lines: normalizedHistoryLines.slice(keepFrom),
          lineBytes: lineBytes.slice(keepFrom),
          hasOlder: history.hasMore || keepFrom > 0,
          // Equality with the client-observed durable seam is the only proof
          // that archive and live are adjacent. A reply may see a newer server
          // head before the paired output frame; keep it detached until that
          // exact boundary arrives instead of overlapping the stale live view.
          hasNewer: liveBoundary
            ? history.endLine !== liveBoundary.liveStartLine
            : history.endLine < history.totalArchivedLines,
          limits,
        }),
        live,
        livePrefixDropped,
        entryState,
        liveEntryState,
        consumedRetainedLivePrefixRows,
      };
    } catch {
      return null;
    }
  }

  function slidingReaderAnchor(state: HistoryWindowState): {
    anchor: { line: number; viewportOffsetPx: number };
    protectedRange: { startLine: number; endLine: number };
    scrollTop: number;
  } {
    const scrollTop = maxOffset() - Math.max(0, Math.min(bottomOffsetPx, maxOffset()));
    const centerVisual = visualRowAtPresentationPixel(
      scrollTop + Math.max(0, viewH / 2),
    );
    const centerRow = projectionRowAt(centerVisual);
    const anchorIndex = Math.max(0, Math.min(
      state.lines.length - 1,
      centerRow?.rawRange.startLine ?? 0,
    ));
    const visible = strictVisibleRowRange(bottomOffsetPx);
    const visibleRaw = rawRangeForVisualWindow(visible.startIdx, visible.endIdx);
    let protectedStart = Math.max(0, Math.min(state.lines.length - 1, visibleRaw.start));
    let protectedEnd = Math.max(
      protectedStart + 1,
      Math.min(state.lines.length, visibleRaw.end),
    );
    if (anchorIndex < protectedStart || anchorIndex >= protectedEnd) {
      protectedStart = anchorIndex;
      protectedEnd = anchorIndex + 1;
    }
    return {
      anchor: {
        line: state.startLine + anchorIndex,
        viewportOffsetPx: presentationRowTopPx(visualRowForRaw(anchorIndex)) - scrollTop,
      },
      protectedRange: {
        startLine: state.startLine + protectedStart,
        endLine: state.startLine + protectedEnd,
      },
      scrollTop,
    };
  }

  function commitSlidingHistoryWindow(
    state: HistoryWindowState,
    options: {
      direction: HistoryWindowDirection;
      indexDelta: number;
      oldScrollTop: number;
      acceptedLineCount: number;
      live?: string[];
      entryState?: SgrState;
      /** Count and exact renderer state for live rows sacrificed while first
       * seeding a full retention window beside a non-empty archive page. */
      liveGapRows?: number;
      liveEntryState?: SgrState | null;
      nextScrollTop?: number;
      gapBeforeRows?: number;
    },
  ): void {
    if (
      liveBoundary
      && historyWindowEndLine(state) !== liveBoundary.liveStartLine
      && !state.hasNewer
    ) {
      // Attachment is legal only at exact durable equality. This defensive
      // normalization covers initial pages, forward pages, and replacement
      // paths so a future caller cannot concatenate overlapping archive/live
      // ranges merely because a server reply said it had no newer page.
      state = { ...state, hasNewer: true };
    }
    const activeIdentity = currentSearchActiveIdentity();
    const before = historyPrependSnapshot();
    const projectBash = normalizedClaudeBashMode() !== 'off';
    // Sliding pages can evict either edge, so raw indexDelta is not a stable
    // presentation coordinate once Bash blocks collapse to one visual row.
    // Capture the absolute raw row under the reader before replacing the
    // resident window and restore that same row after rebuilding projection.
    // A short live screen can fit entirely inside the viewport, leaving
    // bottomOffsetPx at the live-tail sentinel even after an upward wheel has
    // accepted an older-history request. This commit is still reader-driven:
    // force an absolute anchor for backward pages so the newly prepended rows
    // move above the existing screen instead of pinning the reader back to the
    // tail. Ordinary live projection rebuilds keep the default follow-tail
    // behavior.
    const presentationAnchor = projectBash
      ? captureStableHistoryPresentationAnchor(options.direction === 'before')
      : null;
    const previousWinStart = winStart;
    const previousWinEnd = winEnd;
    const previousWindowFirstRow = projectionRowAt(previousWinStart);
    const previousWindowLastRow = previousWinEnd > previousWinStart
      ? projectionRowAt(previousWinEnd - 1)
      : null;
    const previousWindowFirstEntryKey = previousWindowFirstRow
      ? sgrStateKey(stateBeforeLine(previousWindowFirstRow.rawRange.startLine))
      : null;
    const previousWindowFirstRawId = previousWindowFirstRow
      ? archiveOffset + previousWindowFirstRow.rawRange.startLine
      : null;
    const previousWindowEndRawId = previousWindowLastRow
      ? archiveOffset + previousWindowLastRow.rawRange.endLine
      : null;
    const previousWindowStart = archiveWindow?.startLine ?? null;
    const previousArchiveOffset = archiveOffset;
    const wasDetached = archiveWindow !== null && !archiveWindowAttachedToLive;
    archiveWindow = state;
    archiveWindowAttachedToLive = !state.hasNewer;
    archiveBeforeLine = state.startLine;
    archiveExhausted = !state.hasOlder;
    historyStopReason = archiveExhausted ? 'exhausted' : 'none';

    liveLines = boundLiveLinesForArchive(options.live ?? liveLines, state);
    archivedLines = Array.from(state.lines);
    rawLines = archiveWindowAttachedToLive
      ? [...archivedLines, ...liveLines]
      : [...archivedLines];
    // Keep DOM/search row identities stable across the first seed as well as
    // later two-sided slides. With a durable boundary the bias is naturally
    // zero (liveStart - prepended rows = state.startLine); legacy/no-boundary
    // viewers retain their synthetic high coordinate without pretending it is
    // a server cursor. `historyWindow.startLine` remains the wire authority.
    archiveOffset = previousWindowStart === null
      ? previousArchiveOffset - options.indexDelta
      : previousArchiveOffset + (state.startLine - previousWindowStart);

    // A slid absolute range is a new bounded render world. Rebuild sparse ANSI
    // and URL state only for the resident rows; no evicted row remains in DOM,
    // search/copy metadata, or checkpoint maps.
    archivedRetentionGaps = new Map();
    liveGapEntryState = null;
    clearRetentionGap();
    if ((options.gapBeforeRows ?? 0) > 0) {
      recordRetentionGap(0, options.gapBeforeRows ?? 0);
    }
    if (
      (options.liveGapRows ?? 0) > 0
      && archiveWindowAttachedToLive
      && liveLines.length > 0
    ) {
      liveGapEntryState = cloneSgrState(options.liveEntryState ?? createSgrState());
      recordRetentionGap(archivedLines.length, options.liveGapRows ?? 0);
    }
    rawEntryState = cloneSgrState(options.entryState ?? createSgrState());
    htmlCache = new Map();
    renderEntryStates = new Map();
    sgrCheckpoints = new Map();
    rebuildAllLinks();
    rebuildFrom(0);

    let preservedProjectedCorridor = false;
    if (projectBash) {
      const reattachingPendingLive = (
        wasDetached
        && archiveWindowAttachedToLive
        && detachedLiveProjectionPending
        && liveLines.length > 0
      );
      if (reattachingPendingLive) {
        // Archive pages may have shifted both raw edges, so force a complete
        // detector rebuild. Keep the previous projection alive just long
        // enough for live-latest eligibility to distinguish the newly visible
        // completed group from historical backlog.
        cachedClaudeBashDetection = null;
        cachedClaudeBashDetectionRawLength = 0;
        cachedClaudeBashDetectionScreenMode = null;
        cachedClaudeBashBarrierKey = '';
        lastClaudeBashProjectionRebuildStart = 0;
        rebuildClaudeBashProjection(presentationAnchor, archivedLines.length, 'live');
      } else {
        rebuildClaudeBashProjection(presentationAnchor, undefined, 'history');
      }
    } else {
      bashProjection = null;
      rebuildPresentationGeometry();
      cachedClaudeBashDetection = null;
      cachedClaudeBashDetectionRawLength = 0;
      cachedClaudeBashDetectionScreenMode = null;
      cachedClaudeBashBarrierKey = '';
      lastClaudeBashDetectionScanRows = 0;
      lastClaudeBashProjectionBuildRows = 0;
      total = rawLines.length;
      const nextScrollTop = Math.max(0, Math.min(
        maxOffset(),
        options.nextScrollTop ?? options.oldScrollTop + options.indexDelta * lineH,
      ));
      bottomOffsetPx = Math.max(0, maxOffset() - nextScrollTop);
    }
    if (
      previousWindowFirstRawId !== null
      && previousWindowEndRawId !== null
    ) {
      const firstRaw = previousWindowFirstRawId - archiveOffset;
      const endRaw = previousWindowEndRawId - archiveOffset;
      if (firstRaw >= 0 && firstRaw < rawLines.length && endRaw > firstRaw && endRaw <= rawLines.length) {
        const nextStart = visualRowForRaw(firstRaw);
        const nextEnd = visualRowForRaw(endRaw - 1) + 1;
        const visible = visibleRowRange(bottomOffsetPx);
        // Keep the exact keyed corridor mounted in both raw and grouped modes.
        // A sliding prepend moves its visual indexes and scrollTop together;
        // rebuilding around the new overscan origin would otherwise change the
        // compositor transform for one frame and move the sampled anchor by
        // OVERSCAN_ROWS. visible.startIdx already includes one guard row, so
        // one slot below it remains covered.
        if (nextStart <= visible.startIdx + 1) {
          winStart = nextStart;
          winEnd = Math.min(total, Math.max(
            nextEnd,
            visible.endIdx + OVERSCAN_ROWS,
          ));
          buildRenderedWindow(winStart, winEnd);
          preservedProjectedCorridor = true;
        }
      }
    }
    if (archiveWindowAttachedToLive) detachedLiveProjectionPending = false;
    if (!preservedProjectedCorridor) {
      rebuildWindow(visibleRowRange(bottomOffsetPx), true);
    }
    contentEpoch++;
    renderEpoch++;
    applyScroll();
    emitScrollState();
    if (onLinesChange) onLinesChange([...rawLines], { source: 'prepend' });

    const after = historyPrependSnapshot();
    const deferredReaderScrollPx = (
      options.direction === 'before'
      && historyReaderAtUnscrollableTail
    )
      ? Math.max(0, Math.min(deferredUnscrollableHistoryPx, maxOffset()))
      : 0;
    const corridorCacheValid = preservedProjectedCorridor
      && previousWindowFirstEntryKey !== null
      && previousWindowFirstRawId !== null
      && sgrStateKey(stateBeforeLine(previousWindowFirstRawId - archiveOffset))
        === previousWindowFirstEntryKey;
    if (options.acceptedLineCount > 0) {
      scheduleDeferredFrame(() => {
        emitHistoryPrependEvent(
          options.acceptedLineCount,
          corridorCacheValid,
          before,
          after,
          {
            direction: options.direction,
            indexDelta: options.indexDelta,
            startLine: state.startLine,
            endLine: historyWindowEndLine(state),
          },
        );
        if (
          deferredReaderScrollPx > 0
          && historyReaderAtUnscrollableTail
          && deferredUnscrollableHistoryPx > 0
        ) {
          // First preserve and publish the exact prepend anchor, then replay
          // the wheel/drag distance that could not exist before history was
          // resident. This makes one reader gesture both load and enter the
          // archive without conflating that gesture with the atomic commit.
          deferredUnscrollableHistoryPx = 0;
          historyReaderAtUnscrollableTail = false;
          bottomOffsetPx = Math.min(
            maxOffset(),
            bottomOffsetPx + deferredReaderScrollPx,
          );
          applyScroll();
        }
      });
    }

    const shouldRerun = settleArchiveContinuationRequest('committed');
    if (searchQuery || shouldRerun) requestSearchRerun(activeIdentity);
    finishArchiveRequest();
  }

  function processSlidingArchivedHistory(
    data: string,
    direction: HistoryWindowDirection,
    requestAnchorLine: number | null,
  ): void {
    if (noScrollback) {
      finishArchiveRequest('empty');
      return;
    }
    const history = parseHistoryPage(data);
    if (!history || (history.lines.length === 0 && history.hasMore)) {
      finishArchiveRequest('malformed');
      return;
    }
    archiveTotalHint = Math.max(archiveTotalHint, history.totalArchivedLines);
    if (archiveWindow && isAwayFromLiveTail()) {
      detachSlidingArchiveFromLive(archiveTotalHint);
    }

    if (archiveWindow === null) {
      if (direction !== 'before') {
        finishArchiveRequest('malformed');
        return;
      }
      if (history.lines.length === 0) {
        archiveExhausted = !history.hasMore;
        historyStopReason = archiveExhausted ? 'exhausted' : 'none';
        finishArchiveRequest(archiveExhausted ? 'exhausted' : 'empty');
        return;
      }
      const seeded = seedSlidingHistoryWindow(history);
      if (!seeded) {
        finishArchiveRequest('malformed');
        return;
      }
      const oldScrollTop = maxOffset() - Math.max(0, Math.min(bottomOffsetPx, maxOffset()));
      if (seeded.consumedRetainedLivePrefixRows > 0) {
        retainedLivePrefixBeforeBoundary = 0;
      }
      commitSlidingHistoryWindow(seeded.state, {
        direction,
        // Archive rows enter before live; an emergency live-prefix trim moves
        // the same anchor back by the number of rows it removed.
        indexDelta: seeded.state.lines.length
          - seeded.consumedRetainedLivePrefixRows
          - seeded.livePrefixDropped,
        oldScrollTop,
        acceptedLineCount: seeded.state.lines.length,
        live: seeded.live,
        entryState: seeded.entryState,
        liveGapRows: seeded.livePrefixDropped,
        liveEntryState: seeded.liveEntryState,
      });
      return;
    }

    if (requestAnchorLine === null) {
      finishArchiveRequest('malformed');
      return;
    }
    const reader = slidingReaderAnchor(archiveWindow);
    const previousWindow = archiveWindow;
    const previousEntryState = cloneSgrState(rawEntryState);
    const applied = applyHistoryWindowPage(
      archiveWindow,
      {
        direction,
        anchorLine: requestAnchorLine,
        startLine: history.startLine,
        lines: history.lines,
        lineBytes: estimatedHistoryWindowLineStorage(history.lines),
        hasMore: direction === 'after'
          ? history.hasMore || (
              liveBoundary
                ? history.endLine !== liveBoundary.liveStartLine
                : history.endLine < archiveTotalHint
            )
          : history.hasMore,
      },
      { anchor: reader.anchor, protectedRange: reader.protectedRange },
    );
    if (applied.kind === 'rejected') {
      const previousEnd = historyWindowEndLine(previousWindow);
      // The archive may prune its oldest prefix while a user reads a detached
      // window. `readAfter` then truthfully jumps beyond our exclusive cursor.
      // The pure model rejects that non-contiguous page; the UI turns it into
      // an explicit, counted gap and resumes from the new server floor.
      if (
        direction === 'after' &&
        applied.reason === 'non-contiguous-page' &&
        history.startLine !== null &&
        history.startLine > previousEnd &&
        history.lines.length > 0
      ) {
        const bytes = estimatedHistoryWindowLineStorage(history.lines);
        let keepEnd = history.lines.length;
        let retainedBytes = bytes.reduce((sum, value) => sum + value, 0);
        while (
          keepEnd > 0 && (
            keepEnd > previousWindow.limits.maxRows ||
            retainedBytes > previousWindow.limits.maxBytes
          )
        ) {
          keepEnd--;
          retainedBytes -= bytes[keepEnd] ?? 0;
        }
        if (keepEnd > 0) {
          try {
            const replacement = createHistoryWindow({
              startLine: history.startLine,
              lines: history.lines.slice(0, keepEnd),
              lineBytes: bytes.slice(0, keepEnd),
              // Rows below the new floor no longer exist; the marker carries
              // that loss, while a truncated incoming suffix remains pageable.
              hasOlder: false,
              hasNewer: history.hasMore || keepEnd < history.lines.length,
              limits: previousWindow.limits,
            });
            commitSlidingHistoryWindow(replacement, {
              direction,
              indexDelta: 0,
              oldScrollTop: reader.scrollTop,
              nextScrollTop: 0,
              acceptedLineCount: keepEnd,
              entryState: createSgrState(),
              gapBeforeRows: history.startLine - previousEnd,
            });
            return;
          } catch {
            // Fall through to the ordinary malformed-page fence.
          }
        }
      }
      finishArchiveRequest('malformed');
      return;
    }
    let entryState = previousEntryState;
    if (applied.state.startLine > previousWindow.startLine) {
      // Forward sliding evicts an existing archive prefix. Capture the exact
      // SGR state at the new absolute first row before replacing rawLines.
      entryState = stateBeforeLine(applied.state.startLine - previousWindow.startLine);
    } else if (applied.state.startLine < previousWindow.startLine) {
      // Backward pages normally retain their first row. If protection forced
      // a far-edge prefix discard, replay only that discarded prefix to seed
      // the first accepted row's ANSI state.
      entryState = createSgrState();
      if (history.startLine !== null) {
        const discardCount = Math.max(0, applied.state.startLine - history.startLine);
        for (let index = 0; index < discardCount; index++) {
          lineToHtml(history.lines[index] ?? '', entryState, palette);
        }
      }
    }
    commitSlidingHistoryWindow(applied.state, {
      direction,
      indexDelta: applied.anchor.indexDelta,
      oldScrollTop: reader.scrollTop,
      acceptedLineCount: applied.acceptedPage?.rowCount ?? 0,
      entryState,
    });
  }

  function processArchivedHistory(data: string) {
    // A late history reply must not prepend into an alternate-screen buffer.
    if (noScrollback) {
      finishArchiveRequest('empty');
      return;
    }
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
    const serverSaysEnd =
      historyStartLine === null || !history.hasMore || lines.length === 0;
    archiveExhausted = serverSaysEnd;
    if (serverSaysEnd) {
      // Server-side end of archive — the top row *is* the start of retained
      // history (not a client ceiling).
      historyStopReason = 'exhausted';
    }
    if (lines.length === 0) {
      const settlement = archiveExhausted ? 'exhausted' : 'empty';
      finishArchiveRequest(settlement);
      return;
    }

    stageHistoryPrepend(lines, historyStartLine);
    if (archiveExhausted) historyStopReason = 'exhausted';
    else if (atRetentionBudget()) markHistoryCeiling();
    else clearHistoryStopIfResumed();
  }

  function applyArchivedHistory(data: string) {
    // Only a locally accepted request may consume a reply. Timeout recovery
    // replaces the socket before clearing this id, so an abandoned wire cannot
    // later satisfy a different local request.
    if (!archiveRequestActive || archiveInflightRequestId === null) return;

    if (archiveRequestTimer) {
      clearTimeout(archiveRequestTimer);
      archiveRequestTimer = null;
    }

    // Claim the wire reply immediately so a duplicate cannot overwrite the
    // queued raw page. Keep archiveLoading true until validation/commit ends.
    const requestId = archiveInflightRequestId;
    const direction = archiveInflightDirection;
    const requestAnchorLine = archiveInflightAnchorLine;
    archiveRequestActive = false;
    enqueuePrependWork(() => {
      if (archiveInflightRequestId !== requestId || !archiveLoading) return;
      if (historyPaging === 'sliding') {
        if (direction === null) {
          finishArchiveRequest('malformed');
          return;
        }
        processSlidingArchivedHistory(data, direction, requestAnchorLine);
      } else {
        processArchivedHistory(data);
      }
    });
  }

  function applyArchiveReadError(): void {
    // `history_error` is a correlated, retryable reply. The mux has already
    // released its per-session wire gate before invoking subscribers, so only
    // settle the matching local request. Do not turn a transient I/O failure
    // into archive exhaustion; the next eligible scroll may ask again with
    // the same absolute cursor.
    if (!archiveRequestActive || archiveInflightRequestId === null) return;
    finishArchiveRequest('empty');
  }

  function contentUpdateBlock() {
    return { busy: busy(), selectionActive };
  }

  /**
   * Fence the complete live frame before any of its screen, cursor, or content
   * state is observed. `liveBoundary` covers committed deliveries; the
   * high-water mark also covers a newer whole frame waiting in the content
   * gate. Both are needed because the gate deliberately coalesces by arrival.
   */
  function admitLiveDelivery(meta?: MuxDeliveryMeta): boolean {
    const boundary = meta?.boundary;
    if (!boundary || historyPaging !== 'sliding') return true;
    const result = admitLiveBoundary(liveBoundaryAdmission, liveBoundary, boundary);
    liveBoundaryAdmission = result.admission;
    return result.accepted;
  }

  function applyLiveScreen(meta?: MuxDeliveryMeta): void {
    if (!meta || !Object.prototype.hasOwnProperty.call(meta, 'screen')) return;
    // Accepted screen mode remains immediate while a selection/gesture holds
    // paint, preserving pointer routing without letting a rejected stale frame
    // reset scrollback or mouse policy.
    liveScreen = meta.screen ?? null;
    liveScreenSeen = true;
  }

  function applyContentDelivery(delivery: ContentUpdate) {
    const meta = delivery.meta as MuxDeliveryMeta;
    const source = contentLinesChangeSource(delivery);
    const nextLive = delivery.data.replace(/\r/g, '').split('\n');
    // Once an unproven legacy frame has been deferred, keep every later whole
    // delivery behind the same reader-owned fence. Reconcile only the newest
    // boundary at explicit rejoin; otherwise a resync or first durable seam
    // could mutate the archive/projection underneath the reader.
    if (
      !noScrollback && (
        deferredLegacyLiveCapture !== null || (
          isAwayFromLiveTail()
          && liveBoundary === null
          && (meta.replace || meta.boundary !== undefined)
        )
      )
    ) {
      if (delivery.cursor !== undefined) cursor = delivery.cursor;
      deferUnprovenLegacyLiveCapture(
        nextLive,
        source,
        meta.replace,
        meta.boundary,
      );
      return;
    }
    const boundaryReconciliation = reconcileLiveBoundary(meta.boundary);
    if (!boundaryReconciliation.acceptDelivery) return;
    if (delivery.cursor !== undefined) cursor = delivery.cursor;
    setLines(
      nextLive,
      delivery.meta.replace,
      source,
      boundaryReconciliation,
    );
  }

  function receiveLiveContent(
    data: string,
    nextCursor: { row: number; col: number } | null | undefined,
    meta?: MuxDeliveryMeta,
  ) {
    if (!admitLiveDelivery(meta)) return;
    applyLiveScreen(meta);
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
    if (bashProjectionRefreshPending) {
      bashProjectionRefreshPending = false;
      const anchor = capturePresentationAnchor();
      rebuildClaudeBashProjection(anchor);
      buildRenderedWindow(winStart, winEnd);
      invalidateSearchOverlayHtml();
      bumpRenderEpoch = true;
    }
    if (paletteRefreshPending) {
      paletteRefreshPending = false;
      if (rawLines.length) {
        invalidateRenderedCache();
        buildRenderedWindow(winStart, winEnd);
        invalidateSearchOverlayHtml();
        bumpRenderEpoch = true;
      }
    }
    if (renderWindowPending) {
      rebuildWindow(visibleRowRange(bottomOffsetPx));
      bumpRenderEpoch = true;
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

  function strictVisibleRowRange(bottomOffset: number): VisibleRowRange {
    const mo = maxOffset();
    const scrollTop = mo - Math.max(0, Math.min(bottomOffset, mo));
    const startIdx = total > 0 ? visualRowAtPresentationPixel(scrollTop) : 0;
    const endIdx = visualBoundaryAtOrAfterPresentationPixel(scrollTop + viewH);
    return {
      startIdx: Math.max(0, Math.min(total, startIdx)),
      endIdx: Math.max(startIdx, Math.min(total, endIdx)),
    };
  }

  function visibleRowRange(bottomOffset: number): VisibleRowRange {
    const strict = strictVisibleRowRange(bottomOffset);
    return {
      endIdx: Math.min(total, strict.endIdx + 1),
      startIdx: Math.max(0, strict.startIdx - 1),
    };
  }

  function rebuildWindow({ startIdx, endIdx }: VisibleRowRange, force = false): boolean {
    const nextStart = Math.max(0, startIdx - OVERSCAN_ROWS);
    const nextEnd = Math.min(total, endIdx + OVERSCAN_ROWS);
    if (busy() && !force) {
      renderWindowPending = true;
      return false;
    }
    buildRenderedWindow(nextStart, nextEnd);
    winStart = nextStart;
    winEnd = nextEnd;
    return true;
  }

  function prebuildMomentumWindow(velocity: number) {
    const current = visibleRowRange(bottomOffsetPx);
    // The exponential integrator's remaining displacement is strictly less
    // than velocity * tau, so this uncapped corridor covers every normal frame.
    const projected = visibleRowRange(bottomOffsetPx + velocity * MOMENTUM_TAU);
    const nextStart = Math.max(0, Math.min(
      winStart,
      current.startIdx - OVERSCAN_ROWS,
      projected.startIdx - OVERSCAN_ROWS,
    ));
    const nextEnd = Math.min(total, Math.max(
      winEnd,
      current.endIdx + OVERSCAN_ROWS,
      projected.endIdx + OVERSCAN_ROWS,
    ));
    buildRenderedWindow(nextStart, nextEnd);
    winStart = nextStart;
    winEnd = nextEnd;
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

    const strictVisible = strictVisibleRowRange(clamped);
    const strictVisibleStart = strictVisible.startIdx;
    const strictVisibleEnd = strictVisible.endIdx;
    // Rendering keeps one guard row on each side to avoid clipped glyph ink.
    // Distill scheduling is lifecycle/live-event based and deliberately never
    // follows scrolling through the virtual window.
    const endIdx = Math.min(total, strictVisibleEnd + 1);
    const startIdx = Math.max(0, strictVisibleStart - 1);

    const outsideWindow = startIdx < winStart - 1 || endIdx > winEnd;
    let windowCovered = true;
    if (busy() && touching && outsideWindow) {
      // Touch can outrun the fixed overscan corridor. Force a rebuild under the
      // finger so the transform never paints blank space over unmounted rows.
      // Unlike momentum, the gesture continues — window is covered after force.
      rebuildWindow({ startIdx, endIdx }, true);
    } else if (momentumWindowFrozen && busy() && outsideWindow) {
      // Geometry/content invalidated the projected corridor. End inertia and
      // rebuild at the true offset in this callback, before the browser can
      // paint an uncovered transform. The owner sees false and does not queue
      // another momentum/spring frame.
      stopInertia();
      momentumWindowFrozen = false;
      rebuildWindow({ startIdx, endIdx }, true);
      windowCovered = false;
    }

    if (windowCovered) {
      // Momentum owns a prebuilt corridor and must never reconcile keyed rows.
      // Once idle, force-shrink that corridor around the actual settled view.
      if (momentumWindowFrozen && !busy()) {
        momentumWindowFrozen = false;
        rebuildWindow({ startIdx, endIdx });
      } else if (!momentumWindowFrozen && outsideWindow) {
        windowCovered = rebuildWindow({ startIdx, endIdx });
      }
    }

    if (layerEl) {
      const y = presentationRowTopPx(winStart) - scrollTop - (overshoot * 0.35);
      layerEl.style.transform = `translate3d(0, ${y.toFixed(2)}px, 0)`;
    }
    emitScrollState();
    if (!busy()) settledBottomOffsetPx = reportedBottomOffset();
    if (!windowCovered && !busy()) schedulePendingContentFlush();
    return windowCovered;
  }

  function scrollBy(dyPx: number): boolean {
    bottomOffsetPx += dyPx;
    if (dyPx < 0 && bottomOffsetPx <= 0) {
      historyReaderAtUnscrollableTail = false;
      deferredUnscrollableHistoryPx = 0;
      bottomOffsetPx = 0;
      rejoinDeferredLegacyLiveCapture();
    }
    const windowCovered = applyScroll();
    if (dyPx > 0) maybeRequestOlderHistory();
    else if (dyPx < 0) maybeRequestNewerHistory();
    return windowCovered;
  }

  function emitScrollState() {
    const scrolledUp = isAwayFromLiveTail();
    if (scrolledUp === scrollStateScrolledUp) return;
    scrollStateScrolledUp = scrolledUp;
    onScrollStateChange?.({
      bottomOffset: reportedBottomOffset(),
      scrolledUp,
    });
  }

  function wheelPixels(e: WheelEvent): number {
    if (e.deltaMode === WheelEvent.DOM_DELTA_LINE) return e.deltaY * lineH;
    if (e.deltaMode === WheelEvent.DOM_DELTA_PAGE) return e.deltaY * Math.max(viewH, lineH);
    return e.deltaY;
  }

  function onWheel(e: WheelEvent) {
    updateSelectionActive();
    if (selectionActive) return;

    if (useSgrMouse) {
      forwardAltWheel(e);
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    const delta = -wheelPixels(e);
    const projectedBottomOffset = bottomOffsetPx + delta;
    bottomOffsetPx = Math.max(0, Math.min(bottomOffsetPx + delta, maxOffset()));
    if (delta < 0 && bottomOffsetPx <= 0) {
      historyReaderAtUnscrollableTail = false;
      deferredUnscrollableHistoryPx = 0;
      rejoinDeferredLegacyLiveCapture();
    }
    applyScroll();
    if (delta > 0) maybeRequestOlderHistory(
      maxOffset() === 0
        ? deferredUnscrollableHistoryPx + projectedBottomOffset
        : projectedBottomOffset,
    );
    else if (delta < 0) maybeRequestNewerHistory();
  }

  let warnedMissingKeys = false;
  function warnMissingOnKeys() {
    if (warnedMissingKeys) return;
    warnedMissingKeys = true;
    // Warns in production too, once per instance. Dropping a user's tap is not a
    // development-time concern — it is the one failure mode where the surface
    // looks completely healthy and simply stops answering, and a DEV-only
    // warning is invisible in exactly the build where that matters.
    console.warn('TermView SGR mouse routing requires onKeys; SGR mouse action ignored.');
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

  function contentHitArea(bounds = viewportEl?.getBoundingClientRect()): ContentHitArea | null {
    if (!viewportEl) return null;
    const geom = currentGeometry();
    if (!geom) return null;
    if (!bounds) return null;
    if (bounds.width <= 0 || bounds.height <= 0) return null;
    const cellW = Math.max(1, charW || measureCharWidth());
    const gridW = Math.min(Math.max(1, bounds.width - 12), geom.cols * cellW);
    // contentCellFromPoint scales the rect across geom.rows, so the rect it gets
    // must be the box those rows actually occupy — rows * lineH — not the box the
    // user can currently see. Those are the same number until a docked composer
    // sets bottomInsetPx, at which point rows keep deriving from visibleH + inset
    // (measureGeometry) while bounds.height shrinks, and clamping to the smaller
    // one silently rescales every row. The rect may extend under the dock; a click
    // cannot land there, so no reachable point maps outside the grid.
    const gridH = Math.max(1, geom.rows * lineH);
    return {
      rect: { left: bounds.left + 6, top: bounds.top, width: gridW, height: gridH },
      geom,
    };
  }

  function refreshAltTouchHitArea() {
    if (altTouchY === null) return;
    altTouchHitArea = contentHitArea();
  }

  function refreshAltTouchHitAreaFromBounds(bounds: DOMRect | undefined) {
    if (altTouchY === null) return;
    altTouchHitArea = contentHitArea(bounds);
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
      // Selection blocked history prepend commits; re-arm idle work now.
      schedulePendingPrependWork();
      schedulePendingContentFlush();
      if (pendingJump !== null) {
        scheduleDeferredFrame(() => jumpToSearchLine(pendingJump));
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

  function abortTouchGesture() {
    if (dragFrame !== null) {
      cancelAnimationFrame(dragFrame);
      dragFrame = null;
    }
    pendingDragPx = 0;
    touching = false;
    tapStart = null;
    touchVel = 0;
  }

  // --- gesture physics (px-true, no quantization, iOS decel curve) ---
  function onTouchStart(e: TouchEvent) {
    updateSelectionActive();
    if (selectionActive) return; // user is adjusting a selection — hands off
    if (useSgrMouse) {
      stopInertia();
      if (momentumWindowFrozen) applyScroll();
      tapStart = null;
      touching = false;
      altTouchMoved = false;
      const touch = e.touches.item(0);
      if (e.touches.length !== 1 || !touch) {
        altTouchY = null;
        altTouchHitArea = null;
        return;
      }
      altTouchY = touch.clientY;
      altTouchHitArea = contentHitArea();
      return;
    }
    stopInertia();
    if (momentumWindowFrozen) applyScroll();
    const touch = e.touches.item(0);
    // Multi-finger starts never establish a scroll gesture — leave touchY/At
    // alone so a later move cannot compute dy from the zero sentinels.
    if (e.touches.length !== 1 || !touch) return;
    touching = true;
    pendingDragPx = 0;
    tapStart = { x: touch.clientX, y: touch.clientY, t: performance.now() };
    touchY = touch.clientY;
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
    if (useSgrMouse) {
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
      // Selection collapsed mid-move without an accepted touchstart — do not
      // fall through into dy math against the zero/stale touchY/touchAt sentinels.
      if (!touching) return;
    }
    if (e.touches.length !== 1) {
      abortTouchGesture();
      return;
    }
    e.preventDefault();
    const touch = e.touches.item(0);
    if (!touch) return;
    const y = touch.clientY;
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
      if (target === 0) rejoinDeferredLegacyLiveCapture();
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
        if (target === 0) rejoinDeferredLegacyLiveCapture();
        applyScroll();
        flushPendingContent();
      } else {
        springFrame = requestAnimationFrame(step);
      }
    };
    springFrame = requestAnimationFrame(step);
  }

  let tapStart: { x: number; y: number; t: number } | null = null;
  // Not 0. This is compared against performance.now(), which counts from when
  // the document started — so on a page younger than the 500ms suppression
  // window, zero reads as "a touch just ended" and every click is thrown away
  // as its echo. A sentinel has to be a value the clock cannot produce.
  let lastTouchEndAt = Number.NEGATIVE_INFINITY;
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

  /** Returns true only when `onTap` was actually invoked for this gesture. */
  function maybeTap(e: TouchEvent | MouseEvent, x: number, y: number): boolean {
    if (useSgrMouse || !onTap || !tapStart) return false;
    const moved = Math.abs(x - tapStart.x) + Math.abs(y - tapStart.y);
    const dur = performance.now() - tapStart.t;
    const sel = window.getSelection?.();
    if (dur < 350 && moved < 10 && (!sel || sel.isCollapsed) && cleanTapTarget(e.target)) {
      onTap();
      return true;
    }
    return false;
  }

  function hasPointerModifier(e: PointerEvent): boolean {
    return e.altKey || e.ctrlKey || e.metaKey || e.shiftKey;
  }

  function isPlainPrimaryPointer(e: PointerEvent): boolean {
    return e.button === 0 && e.isPrimary !== false && !hasPointerModifier(e);
  }

  function onPointerDown(e: PointerEvent) {
    if (!useSgrMouse || !isPlainPrimaryPointer(e)) return;
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
    if (!useSgrMouse || !altPointerStart || e.pointerId !== altPointerStart.pointerId) return;
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
    if (useSgrMouse) {
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
    if (useSgrMouse) {
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
    if (!touching) {
      // Multi-touch abort or a start that never accepted this contact — drop
      // any queued drag so a partial end cannot scroll from stale state.
      abortTouchGesture();
      return;
    }
    if (e && e.changedTouches?.[0] && tapStart) {
      // TM-03: only cancel a touchend that actually fired onTap — moved /
      // long / selection / link taps keep native behaviour. Default off so
      // event flow stays byte-identical to v0.10.1 when the prop is unset.
      const didTap = maybeTap(e, e.changedTouches[0].clientX, e.changedTouches[0].clientY);
      if (didTap && cancelSyntheticClickOnTap) {
        e.stopPropagation();
        if (e.cancelable) e.preventDefault();
      }
    }
    tapStart = null;
    if (selectionActive) {
      updateSelectionActive();
      // Cancel the queued drag frame before it mutates the offset behind a
      // selection the user still thinks is frozen.
      if (dragFrame !== null) {
        cancelAnimationFrame(dragFrame);
        dragFrame = null;
      }
      pendingDragPx = 0;
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
    // The gesture is over before any cold corridor reconstruction. Momentum
    // then consumes only the fully prepared cache until it settles.
    touching = false;
    prebuildMomentumWindow(vel);
    preparingMomentum = true;
    applyScroll();
    if (vel > 0) maybeRequestOlderHistory(bottomOffsetPx + vel * MOMENTUM_TAU);
    else if (vel < 0) maybeRequestNewerHistory(bottomOffsetPx + vel * MOMENTUM_TAU);
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
      else if (vel < 0) maybeRequestNewerHistory(bottomOffsetPx + vel * TAU);
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
    preparingMomentum = false;
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

  // Caret column on the terminal grid. Dual-width glyphs (CJK/emoji) are
  // pinned to two cells by `mtv-w2` in the render path, so cell arithmetic
  // matches the DOM. Font advances alone do not — a CJK glyph is often ~1.6
  // ASCII cells of ink while the grid still owes it two. Memoized: scroll
  // re-renders hit the cache (the key ignores winStart).
  let cursorPosCache = { key: '', left: 0, width: 0 };
  function cursorPos(cline: number, col: number): { left: number; width: number } {
    const raw = rawLines[cline] ?? '';
    const key = `${col}|${fontPx}|${charW}|${raw}`;
    if (cursorPosCache.key === key) return cursorPosCache;
    const left = col * charW;
    let width = charW;
    const line = stripAnsi(raw);
    const { prefix } = prefixForCells(line, col);
    // Cursor ownership follows terminal cells, not browser grapheme clusters.
    // A spacing combining mark (Mc) is its own tmux cell even when the browser
    // shapes it with the preceding consonant. Wide code points and FE0F
    // promotion remain atomic two-cell glyphs, matching ansi-html's pinning.
    const tail = line.slice(prefix.length);
    const first = tail.codePointAt(0);
    if (first !== undefined) {
      const firstWidth = charCellWidth(first);
      width = Math.max(1, firstWidth) * charW;
      if (firstWidth === 1) {
        const firstLength = first > 0xffff ? 2 : 1;
        for (const ch of tail.slice(firstLength)) {
          const cp = ch.codePointAt(0)!;
          if (charCellWidth(cp) > 0) break;
          if (cp === 0xfe0f) {
            width = 2 * charW;
            break;
          }
        }
      }
    }
    cursorPosCache = { key, left, width };
    return cursorPosCache;
  }

  /** rawLines stays deliberately unproxied because it may retain 10k terminal
   * rows.  contentEpoch is the explicit reactive revision: without consuming
   * it here, a content delta that keeps cursor.row unchanged can leave the
   * caret anchored against the previous rawLines length. */
  function lastContentLine(contentRevision: number): number {
    void contentRevision;
    let index = rawLines.length;
    while (index > 0 && !(rawLines[index - 1] ?? '').trim()) index--;
    return index - 1;
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
    const rows = Math.max(minRows, Math.min(maxRows, Math.floor(h / lineH)));
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

  /**
   * Font-driven pane resize settle window. Rapid A+/A− is ~120–180ms between
   * taps on a phone thumb; 220ms swallows a burst so Claude Code reprints its
   * header once. A single deliberate tap still flushes without needing a
   * second press. Viewport ResizeObserver is not on this timer.
   */
  const FONT_RESIZE_SETTLE_MS = 220;
  let fontResizeTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingFontResize = false;

  function flushFontResize(): void {
    if (fontResizeTimer) {
      clearTimeout(fontResizeTimer);
      fontResizeTimer = null;
    }
    if (!pendingFontResize) return;
    pendingFontResize = false;
    lastPushedCols = 0;
    pushGeometry({ force: true });
  }

  function scheduleFontResize(): void {
    pendingFontResize = true;
    if (fontResizeTimer) clearTimeout(fontResizeTimer);
    fontResizeTimer = setTimeout(() => {
      fontResizeTimer = null;
      flushFontResize();
    }, FONT_RESIZE_SETTLE_MS);
  }

  function refreshVisualLayout(): void {
    if (selectionActive) {
      renderRefreshPending = true;
      return;
    }
    renderEpoch++;
    applyScroll();
  }

  /** Re-measure and re-claim geometry immediately (viewport / visibility).
   * Glyph resizes don't fire the ResizeObserver — those use the font path. */
  export function refreshGeometry() {
    lastPushedCols = 0;
    pushGeometry({ force: true });
    refreshVisualLayout();
  }

  let lastFontPx: number | null = null;
  $effect(() => {
    if (lastFontPx !== null && fontPx !== lastFontPx) {
      // Paint on every tap. Only the tmux resize is deferred — a burst of
      // A+ must not reprint the agent header N times (BRIEF-H).
      refreshVisualLayout();
      scheduleFontResize();
    }
    lastFontPx = fontPx;
  });

  const warnedBottomInsetValues = new Set<number>();
  function warnInvalidBottomInset(value: number) {
    if (!(import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV) return;
    const viewportHeight = typeof window === 'undefined' ? 0 : window.innerHeight;
    const invalid =
      !Number.isFinite(value) ||
      !Number.isInteger(value) ||
      value < 0 ||
      (viewportHeight > 0 && value >= viewportHeight);
    if (!invalid || warnedBottomInsetValues.has(value)) return;
    warnedBottomInsetValues.add(value);
    console.warn(
      `TermView received invalid bottomInsetPx=${String(value)}. ` +
      'It must be a finite, non-negative integer smaller than the viewport height and ' +
      'only the portion of the composer dock that exceeds the safe-area inset.',
    );
  }

  function revalidateBottomInset() {
    warnInvalidBottomInset(bottomInsetPx);
  }

  $effect(() => {
    // Re-check after terminal-box resizes without adding a fresh layout read:
    // viewH is populated by the existing ResizeObserver. A window listener
    // below covers layout-viewport changes that leave this box unchanged.
    void viewH;
    revalidateBottomInset();
  });

  // A5-2: bottomInsetPx is a geometry input but does not change the observed
  // box size, so ResizeObserver never fires. Re-measure only when the prop
  // itself changes — never call refreshGeometry() from the viewH effect
  // (that loops via renderEpoch / lastPushedCols $state writes).
  let lastBottomInsetPx: number | null = null;
  $effect(() => {
    const inset = bottomInsetPx;
    warnInvalidBottomInset(inset);
    if (lastBottomInsetPx !== null && lastBottomInsetPx !== inset) {
      pushGeometry({ force: true });
    }
    lastBottomInsetPx = inset;
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

  /** Drop compositor scroll offset + in-flight history when screen.alt flips.
   * A viewer scrolled up in normal scrollback must not keep a stale offset on
   * the alternate screen (and the reverse). First observation is not a flip. */
  function resetScrollForScreenMode() {
    stopInertia();
    if (dragFrame !== null) {
      cancelAnimationFrame(dragFrame);
      dragFrame = null;
    }
    pendingDragPx = 0;
    touching = false;
    tapStart = null;
    altTouchY = null;
    altTouchHitArea = null;
    altTouchMoved = false;
    altPointerStart = null;
    altWheelRemainder = 0;
    if (altWheelFrame !== null) {
      cancelAnimationFrame(altWheelFrame);
      altWheelFrame = null;
    }
    cancelScheduledPrependWork();
    pendingPrependWork = null;
    prependParseSeq++;
    if (archiveRequestActive && archiveInflightRequestId !== null) {
      try {
        tmuxMux.recoverHistoryRequest(archiveInflightSession ?? session);
      } catch {
        // Mode flip must continue even if recovery throws.
      }
    }
    if (archiveRequestTimer) {
      clearTimeout(archiveRequestTimer);
      archiveRequestTimer = null;
    }
    archiveLoading = false;
    archiveRequestActive = false;
    archiveInflightRequestId = null;
    archiveInflightSession = null;
    archiveInflightDirection = null;
    archiveInflightAnchorLine = null;
    // Screen-mode flip is a new scroll world; drop any prior stop reason so an
    // alt-screen banner is not confused with a normal-mode ceiling note.
    historyStopReason = 'none';
    historyReaderAtUnscrollableTail = false;
    deferredUnscrollableHistoryPx = 0;
    deferredLegacyLiveCapture = null;
    bottomOffsetPx = 0;
    applyScroll();
    emitScrollState();
    settledBottomOffsetPx = 0;
  }

  /**
   * Alternate screen has no tmux scrollback. If we speculatively prepended
   * while mode was unknown (or the pane just entered alt), drop archived
   * rows so a reused session name cannot keep a stale archive on screen.
   * Live pane content stays.
   */
  function discardArchiveForAltScreen(): void {
    cancelScheduledPrependWork();
    pendingPrependWork = null;
    prependParseSeq++;
    archiveWindow = null;
    archiveWindowAttachedToLive = true;
    detachedLiveProjectionPending = false;
    deferredLegacyLiveCapture = null;
    retainedLivePrefixBeforeBoundary = 0;
    if (archivedLines.length === 0) return;
    archivedLines = [];
    rawLines = liveLines.slice();
    archiveOffset = ARCHIVE_OFFSET_START;
    archiveBeforeLine = null;
    archiveExhausted = false;
    historyStopReason = 'none';
    archivedRetentionGaps = new Map();
    liveGapEntryState = null;
    clearRetentionGap();
    htmlCache = new Map();
    renderEntryStates = new Map();
    rawEntryState = createSgrState();
    rebuildAllLinks();
    rebuildFrom(0);
    rebuildClaudeBashProjection(null);
    recalculateRetainedEstimatedBytes();
    historyReaderAtUnscrollableTail = false;
    deferredUnscrollableHistoryPx = 0;
    bottomOffsetPx = 0;
    rebuildWindow(visibleRowRange(0), true);
    contentEpoch++;
    renderEpoch++;
    applyScroll();
    emitScrollState();
    settledBottomOffsetPx = 0;
  }

  /** Oldest retained rows are in the virtual window — show the ceiling note. */
  let showHistoryCeiling = $derived(
    historyPaging === 'ceiling' &&
    historyStopReason === 'ceiling' &&
    winStart === 0 &&
    !noScrollback,
  );

  /** A sliding boundary is navigable, not a terminal ceiling. Show the same
   * neutral instruction at whichever pageable edge is currently mounted. */
  let showHistoryWindowSignpost = $derived(
    historyPaging === 'sliding' &&
    archiveWindow !== null &&
    !noScrollback && (
      (archiveWindow.hasOlder && winStart === 0) ||
      (archiveWindow.hasNewer && winEnd === total)
    ),
  );

  let screenAltObserved = false;
  let lastScreenAlt = false;
  $effect(() => {
    const alt = noScrollback;
    if (!screenAltObserved) {
      screenAltObserved = true;
      lastScreenAlt = alt;
      // First sample is not a "flip", but if it is alt we may already have
      // prepended a stale archive while mode was unknown — drop it.
      if (alt) {
        discardArchiveForAltScreen();
        resetScrollForScreenMode();
      }
      return;
    }
    if (alt === lastScreenAlt) return;
    lastScreenAlt = alt;
    if (alt) discardArchiveForAltScreen();
    resetScrollForScreenMode();
  });

  function onReturn() {
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
    lastPushedCols = 0; // force re-claim — desktop may have resized while hidden
    pushGeometry({ force: true });
  }

  let unsubscribe: (() => void) | null = null;
  let resizeObs: ResizeObserver | null = null;
  let observedVisualViewport: VisualViewport | null = null;
  let observedFontSet: FontFaceSet | null = null;

  function onFontMetricsChanged(): void {
    if (destroyed) return;
    // A swap-loaded web font changes glyph metrics without changing the
    // viewport box, so ResizeObserver cannot see it. Re-measure normally: the
    // CSS cell width always updates, while tmux receives a resize only when
    // the rounded cols/rows actually changed.
    pushGeometry();
  }

  onMount(() => {
    updateViewportGeometry(viewportEl);
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
      if (type === 'error' && meta?.historyError?.retryable) {
        applyArchiveReadError();
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
    scheduleDeferredFrame(() => pushGeometry({ force: true }));
    resizeObs = new ResizeObserver(() => {
      const bounds = viewportEl?.getBoundingClientRect();
      updateViewportGeometry(viewportEl, bounds);
      pushGeometry();
      refreshAltTouchHitAreaFromBounds(bounds);
      applyScroll();
    });
    if (viewportEl) resizeObs.observe(viewportEl);
    const fontSet = (document as Document & { fonts?: FontFaceSet }).fonts;
    if (fontSet) {
      observedFontSet = fontSet;
      observedFontSet.addEventListener('loadingdone', onFontMetricsChanged);
      void observedFontSet.ready.then(onFontMetricsChanged, () => {
        // Font loading failure leaves the currently measured fallback grid.
      });
    }
    observedVisualViewport = window.visualViewport;
    observedVisualViewport?.addEventListener('resize', refreshAltTouchHitArea, { passive: true });
    observedVisualViewport?.addEventListener('scroll', refreshAltTouchHitArea, { passive: true });
    if ((import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV) {
      window.addEventListener('resize', revalidateBottomInset, { passive: true });
    }
    window.addEventListener('pageshow', onReturn);
    document.addEventListener('visibilitychange', onReturn);
    document.addEventListener('selectionchange', updateSelectionActive);
  });

  onDestroy(() => {
    // Svelte 5 runs onDestroy during SSR too — guard all browser APIs.
    if (typeof window === 'undefined') return;
    // Flush a mid-burst font resize so unmount / session switch does not
    // leave tmux at the previous size (worse than the storm).
    flushFontResize();
    destroyed = true;
    cancelDeferredFrames();
    stopInertia();
    if (dragFrame !== null) cancelAnimationFrame(dragFrame);
    if (pendingContentFlushFrame !== null) cancelAnimationFrame(pendingContentFlushFrame);
    cancelScheduledPrependWork();
    pendingPrependWork = null;
    prependParseSeq++;
    if (altWheelFrame !== null) { cancelAnimationFrame(altWheelFrame); altWheelFrame = null; }
    // Unmount can abandon an accepted tokenless request before its timeout.
    // Fence that request's wire now so a later viewer of the same session is
    // neither blocked forever nor able to consume the abandoned reply.
    if (archiveRequestActive && archiveInflightRequestId !== null) {
      try {
        tmuxMux.recoverHistoryRequest(archiveInflightSession ?? session);
      } catch {
        // Teardown must continue even if host connection setup throws after
        // the abandoned wire has already been detached.
      }
    }
    if (archiveRequestTimer) {
      clearTimeout(archiveRequestTimer);
      archiveRequestTimer = null;
    }
    if (claudeBashSummaryTimeout !== null) {
      clearTimeout(claudeBashSummaryTimeout);
      claudeBashSummaryTimeout = null;
    }
    if (unsubscribe) unsubscribe();
    resizeObs?.disconnect();
    observedFontSet?.removeEventListener('loadingdone', onFontMetricsChanged);
    observedFontSet = null;
    observedVisualViewport?.removeEventListener('resize', refreshAltTouchHitArea);
    observedVisualViewport?.removeEventListener('scroll', refreshAltTouchHitArea);
    observedVisualViewport = null;
    window.removeEventListener('resize', revalidateBottomInset);
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

  function externalClaudeBashSummarySignature(): string {
    const summaries = claudeBashSummaries;
    if (!summaries) return '';
    const entries = summaries instanceof Map
      ? [...summaries.entries()]
      : Object.entries(summaries);
    entries.sort(([a], [b]) => a.localeCompare(b));
    return entries.map(([id, summary]) => `${id}\u0000${summary}`).join('\u0001');
  }

  let lastClaudeBashProjectionKey = '';
  $effect(() => {
    const key = [
      normalizedClaudeBashMode(),
      claudeBashScreenMode(),
      externalClaudeBashSummarySignature(),
    ].join('\u0002');
    if (key === lastClaudeBashProjectionKey) return;
    lastClaudeBashProjectionKey = key;
    // Helpers read total/scroll state while restoring the anchor. Keep those
    // implementation reads out of this prop-driven effect's dependency set.
    untrack(() => presentSettledClaudeBashSummaries());
  });

  // Re-render everything when the palette changes (theme/bg switch).
  let paletteKey = $derived(`${palette.defaultFg}|${palette.defaultBg}|${palette.base.join(',')}`);
  let lastPaletteKey = '';
  $effect(() => {
    if (paletteKey !== lastPaletteKey) {
      lastPaletteKey = paletteKey;
      if (selectionActive || busy()) {
        paletteRefreshPending = true;
        return;
      }
      if (rawLines.length) {
        invalidateRenderedCache();
        buildRenderedWindow(winStart, winEnd);
        invalidateSearchOverlayHtml();
        renderEpoch++;
        applyScroll();
      }
    }
  });

  // applyScroll after the window re-renders (layerEl content changed).
  $effect(() => {
    renderEpoch;
    scheduleDeferredFrame(() => applyScroll());
  });

  $effect(() => {
    const connectedNow = tmuxMux.connected;
    if (!connectedNow) {
      connectedGeometryPushed = false;
      return;
    }
    if (connectedGeometryPushed) return;
    connectedGeometryPushed = true;
    scheduleDeferredFrame(() => pushGeometry({ force: true }));
  });
</script>

<!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
<div
  bind:this={viewportEl}
  class="mtv"
  data-testid="mtv"
  data-total={total}
  data-raw-total={rawLines.length}
  data-presentation-height={presentationContentHeightPx()}
  data-claude-bash-mode={normalizedClaudeBashMode()}
  data-claude-bash-detection-scan-rows={lastClaudeBashDetectionScanRows}
  data-claude-bash-projection-build-rows={lastClaudeBashProjectionBuildRows}
  data-claude-bash-requested-count={requestedClaudeBashSummaryCount}
  data-claude-bash-settled-count={settledClaudeBashSummaryCount}
  data-retained-estimated-bytes={retainedEstimatedBytes}
  data-retained-byte-budget={HISTORY_RETAINED_BYTE_BUDGET}
  data-sgr-checkpoint-count={sgrCheckpointCount}
  data-sgr-checkpoint-interval={SGR_CHECKPOINT_INTERVAL}
  data-render-cache-rows={renderCacheRows}
  data-render-cache-builds={renderCacheBuilds}
  data-bottom-offset={settledBottomOffsetPx}
  data-archive-offset={archiveOffset}
  data-last-cols={lastPushedCols}
  data-last-rows={lastPushedRows}
  data-history-stop={historyStopReason}
  data-history-paging={historyPaging}
  data-history-ceiling={historyPaging === 'ceiling' && historyStopReason === 'ceiling' ? '1' : undefined}
  data-history-window-start={archiveWindow?.startLine}
  data-history-window-end={archiveWindow ? historyWindowEndLine(archiveWindow) : undefined}
  data-history-window-rows={archiveWindow?.lines.length}
  data-history-window-estimated-bytes={archiveWindow?.estimatedBytes}
  data-history-window-attached={archiveWindow ? (archiveWindowAttachedToLive ? '1' : '0') : undefined}
  data-history-window-has-older={archiveWindow ? (archiveWindow.hasOlder ? '1' : '0') : undefined}
  data-history-window-has-newer={archiveWindow ? (archiveWindow.hasNewer ? '1' : '0') : undefined}
  data-history-live-start={liveBoundary?.liveStartLine}
  data-history-generation={liveBoundary?.generation}
  data-history-total-hint={archiveTotalHint}
  data-history-request-direction={archiveInflightDirection ?? undefined}
  data-no-scrollback={noScrollback ? '1' : undefined}
  data-screen-mode-known={screenModeKnown ? '1' : undefined}
  data-content-update-pending={contentUpdateGate.pending ? '1' : '0'}
  data-live-rejoin-pending={deferredLegacyLiveCapture ? '1' : undefined}
  data-content-update-pending-cursor-row={contentUpdateGate.pending?.cursor?.row}
  data-content-update-pending-cursor-col={contentUpdateGate.pending?.cursor?.col}
  data-content-update-busy={busy() ? '1' : '0'}
  data-content-update-selection={selectionActive ? '1' : '0'}
  style:font-size={`${fontPx}px`}
  style:line-height={`${lineH}px`}
  style:--mtv-lineh={`${lineH}px`}
  style:--mtv-cw={charW > 0 ? `${charW}px` : '1ch'}
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
      {#each { length: winEnd - winStart } as _, i (visualRowKey(winStart + i))}
        {@const visualRow = winStart + i}
        {@const projectionRow = projectionRowAt(visualRow)}
        {@const rawLineIdx = projectionRow?.rawRange.startLine ?? rawLines.length}
        {@const droppedRows = retentionGapRowsAt(rawLineIdx, contentEpoch)}
        {@const presentationTop = presentationRowTopPx(visualRow) - presentationRowTopPx(winStart)}
        {@const presentationHeight = presentationRowHeightPx(visualRow)}
        {@const compactBash = compactBashVisualRowSet.has(visualRow)}
        {@const bashSearchKind = compactBash && projectionRow
          ? placeholderSearchKind(projectionRow)
          : null}
        {#if droppedRows > 0}<span
            class="mtv-gap-marker"
            role="note"
            aria-label={`${droppedRows} rows dropped before this row`}
            data-gap-marker-rows={droppedRows}
            style:top={`${presentationTop}px`}
            style:height={`${presentationHeight}px`}
          ></span>{/if}
        <div
          class="mtv-line"
          class:mtv-gap={droppedRows > 0}
          class:mtv-bash-placeholder={projectionRow?.kind === 'bash-placeholder'}
          class:mtv-bash-hidden={compactBash}
          data-line-id={archiveOffset + rawLineIdx}
          data-visual-row={visualRow}
          data-raw-start={projectionRow?.rawRange.startLine}
          data-raw-end={projectionRow?.rawRange.endLine}
          data-presentation-top={presentationRowTopPx(visualRow)}
          data-presentation-height={presentationHeight}
          data-bash-id={projectionRow?.fingerprint ?? undefined}
          data-bash-status={projectionRow?.status ?? undefined}
          data-gap-rows={droppedRows > 0 ? droppedRows : undefined}
          title={droppedRows > 0 ? `${droppedRows} rows dropped before this row` : undefined}
          style:height={`${presentationHeight}px`}
          style:line-height={`${presentationHeight}px`}
        >{#if compactBash && projectionRow}<span
              class={`mtv-bash-divider ${bashSearchKind ?? ''}`}
              role="note"
              aria-label={projectionRow.status === 'active'
                ? `hidden bash, running, ${projectionRow.rawEndExclusive - projectionRow.rawStart} rows`
                : `hidden bash, ${projectionRow.rawEndExclusive - projectionRow.rawStart} rows`}
              title={projectionRow.status === 'active'
                ? 'hidden bash · running'
                : `hidden bash · ${projectionRow.rawEndExclusive - projectionRow.rawStart} rows`}
            ><span class="mtv-bash-divider-label">hidden bash</span><span
                class="mtv-bash-divider-rule"
                aria-hidden="true"
              ></span></span>{:else}{@html cachedLineHtml(visualRow, contentEpoch)}{/if}</div>
      {/each}
    {#if cursor && connected && !scrollStateScrolledUp && charW > 0}
      {@const lastContent = lastContentLine(contentEpoch)}
      {@const cline = lastContent - cursor.row}
      {@const cvisual = visualRowForRaw(cline)}
      {@const blankRowsPastRawEnd = Math.max(0, cline - rawLines.length)}
      {@const cursorProjectionRow = projectionRowAt(cvisual)}
      {#if cline >= 0
        && cursorProjectionRow?.kind !== 'bash-placeholder'
        && cvisual >= winStart
        && cvisual < winEnd + (cursor.row < 0 ? -cursor.row : 0)}
        <!-- negative row = caret on a blank row BELOW the last content line;
             the overlay is pixel-positioned, so it renders fine past the last
             DOM row (a bottom-clipped caret just stays hidden, never wrong) -->
        {@const cpos = cursorPos(cline, cursor.col)}
        <div
          class="mtv-cursor"
          style:top={`${presentationRowTopPx(cvisual) + blankRowsPastRawEnd * lineH - presentationRowTopPx(winStart)}px`}
          style:left={`${6 + cpos.left}px`}
          style:width={`${Math.max(2, cpos.width)}px`}
          style:height={`${lineH}px`}
          data-testid="mtv-cursor"
          data-cursor-row={cursor.row}
          data-cursor-col={cursor.col}
          data-cursor-raw-line={cline}
          data-cursor-visual-row={cvisual}
        ></div>
      {/if}
    {/if}
    {/key}
  </div>
  {#if !connected}
    <div class="mtv-wait" lang="th">กำลังเชื่อมต่อ…</div>
  {/if}
  {#if noScrollback}
    <!--
      Alternate screen has no tmux scrollback. Without this note the surface is
      indistinguishable from a frozen terminal (audit D5). Distinct from the
      retention-gap gutter marker — different fact, different vocabulary.
    -->
    <div
      class="mtv-no-scrollback"
      data-testid="mtv-no-scrollback"
      role="note"
      aria-label={NO_SCROLLBACK_LABEL}
    >
      <span class="mtv-signpost-text">Alternate screen · no scrollback</span>
    </div>
  {/if}
  {#if showHistoryCeiling}
    <!--
      Client retention ceiling (audit D4). Not a gap marker: no rows were
      dropped between retained lines; older archive rows simply were never
      loaded. Shown only when the oldest retained row is in the window.
    -->
    <div
      class="mtv-history-ceiling"
      data-testid="mtv-history-ceiling"
      role="note"
      aria-label={HISTORY_CEILING_LABEL}
    >
      <span class="mtv-signpost-text">Older history not loaded · limit 10k rows / 8 MiB</span>
    </div>
  {/if}
  {#if showHistoryWindowSignpost}
    <div
      class="mtv-history-window"
      data-testid="mtv-history-window"
      role="note"
      aria-label={HISTORY_WINDOW_LABEL}
    >
      <span class="mtv-signpost-text">History window · scroll to load</span>
    </div>
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
  .mtv-no-scrollback,
  .mtv-history-ceiling,
  .mtv-history-window {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    z-index: 3;
    padding: 5px 8px;
    box-sizing: border-box;
    pointer-events: none;
    user-select: none;
    -webkit-user-select: none;
    border-bottom: 1px solid color-mix(in srgb, var(--tfg) 32%, transparent);
    background: color-mix(in srgb, var(--tbg) 82%, var(--tfg));
  }
  .mtv-signpost-text {
    display: block;
    font: 600 11px / 1.35 var(--font-mono, ui-monospace, monospace);
    color: var(--tfg);
    opacity: 0.92;
    letter-spacing: 0.01em;
    white-space: normal;
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
  /* Hide mode is a true one-third-row separator, not a full terminal row with
     smaller ink. The virtual geometry uses the same fractional height, so the
     following terminal row starts immediately after this box with no phantom
     whitespace. Haiku placeholders deliberately keep the normal row style. */
  .mtv-line.mtv-bash-hidden {
    display: flex;
    align-items: center;
    box-sizing: border-box;
    overflow: hidden;
    color: #4ade80;
  }
  .mtv-bash-divider {
    display: flex;
    align-items: center;
    width: 100%;
    height: 100%;
    min-width: 0;
    color: inherit;
    font: 500 max(6px, calc(var(--mtv-lineh) * 0.29)) / 1 var(--font-mono, ui-monospace, monospace);
    letter-spacing: 0.02em;
    white-space: nowrap;
  }
  .mtv-bash-divider-rule {
    height: 1px;
    min-width: 8px;
    flex: 1 1 auto;
    background: currentColor;
    opacity: 0.72;
  }
  .mtv-bash-divider-label {
    flex: 0 0 auto;
    padding: 0 4px 0 0;
    opacity: 0.82;
  }
  .mtv-bash-divider.search-match {
    background: rgba(74, 222, 128, 0.14);
  }
  .mtv-bash-divider.search-active {
    background: rgba(250, 224, 66, 0.24);
    outline: 1px solid rgba(250, 224, 66, 0.42);
    outline-offset: -1px;
  }
  /*
   * Dual-width cells (CJK / fullwidth / emoji / EAW=W dingbats / base+FE0F).
   * ansi-html wraps each dual-width unit in .mtv-w2; we pin the box to exactly
   * two measured ASCII cells so column N lands where tmux says it does.
   *
   * Colour emoji fonts often paint ~1em×1em ink while two mono cells are only
   * ~1.2em wide — overflow:hidden alone *clips* the picture. Cap font-size so
   * 1em of ink fits the box on both axes. Letter boxes must NOT clip: Thai ำ
   * (and Devanagari, and any mark that reaches left of its origin) is a
   * letter in its own cell whose ink belongs over the previous consonant.
   * The clip stays only on .mtv-fit, where we scale square symbol ink on
   * purpose. The box size itself never changes (grid is sacrosanct).
   */
  .mtv-line :global(.mtv-w1),
  .mtv-line :global(.mtv-w2),
  .mtv-line :global(.mtv-wx) {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    height: var(--mtv-lineh);
    box-sizing: border-box;
    vertical-align: top;
    overflow: visible;
    white-space: pre;
    line-height: 1;
  }
  .mtv-line :global(.mtv-w1) {
    width: var(--mtv-cw, 1ch);
    /* Letters are designed to fit a 0.6em cell at the inherited size.
     * min(lineh, cw*0.92) is 0.552em forever and shrank Thai to 55%. */
    font-size: inherit;
  }
  .mtv-line :global(.mtv-w1.mtv-fit) {
    /* Square-ink 1-cell symbols (⚠) really do overflow the cell. */
    font-size: min(var(--mtv-lineh), calc(var(--mtv-cw, 1ch) * 0.92));
    overflow: hidden;
  }
  .mtv-line :global(.mtv-w2) {
    width: calc(2 * var(--mtv-cw, 1ch));
    font-size: min(var(--mtv-lineh), calc(2 * var(--mtv-cw, 1ch) * 0.92));
  }
  .mtv-line :global(.mtv-wx) {
    width: calc(var(--mtv-cells, 1) * var(--mtv-cw, 1ch));
    /* N≥3 is a letter conjunct, not square ink — inherit like .mtv-w1. */
    font-size: inherit;
  }
  /* Keep the virtual row stride exactly N * lineH. Moving the old text label
     to top:0 would only cover this row instead; doubling the row would break
     scroll/prepend geometry; and an inline badge can collide with an
     arbitrarily long terminal line. This absolute bracket is a sibling in the
     6px layer gutter reserved outside terminal column geometry, so it changes
     no box size and cannot paint any glyph. The exact count remains in the
     row title and the named semantic note. */
  .mtv-gap-marker {
    position: absolute;
    left: 1px;
    width: 4px;
    height: var(--mtv-lineh);
    box-sizing: border-box;
    z-index: 2;
    border: 1px solid color-mix(in srgb, var(--tfg) 62%, transparent);
    border-right: 0;
    pointer-events: none;
    user-select: none;
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
