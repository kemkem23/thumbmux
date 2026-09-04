<script module lang="ts">
  export type {
    GridFilterOption,
    GridOrder,
    GridSession,
    GridSessionState,
    SessionGridProps,
  } from './session-grid';
</script>

<script lang="ts">
  /** SessionGrid — the "which terminal?" screen. A grid of live pane
   * miniatures (SessionThumb) plus a "+ terminal" card. Pure presentation:
   * the host supplies sessions and handles open/new. */
  import { onDestroy } from 'svelte';
  import SessionThumb from './SessionThumb.svelte';
  import { copyPlainText } from './clipboard';
  import {
    buildSessionGridModel,
    displayStateLabel,
    type GridSession,
    type PreparedGridSession,
    type SessionGridProps,
  } from './session-grid';

  const NEW_FOCUS_KEY = '__thumbmux_new__';
  const DENSE_IDLE_BACKGROUND = '#666666';
  const PREVIEW_TAP_SLOP_PX = 12;
  const PREVIEW_SCROLL_SLOP_PX = 4;
  const PREVIEW_CLICK_WAIT_MS = 48;
  const PREVIEW_CLICK_DEDUPE_MS = 1_500;

  type PreviewGesture = {
    pointerKey: string;
    pointerId: number;
    pointerType: string;
    name: string;
    target: HTMLButtonElement;
    startX: number;
    startY: number;
    startRect: PreviewRect;
    scrollTarget: Element;
    startScrollLeft: number;
    startScrollTop: number;
    moved: boolean;
  };

  type PreviewRect = {
    left: number;
    right: number;
    top: number;
    bottom: number;
    width: number;
    height: number;
  };

  type PendingPreviewActivation = {
    pointerKey: string;
    pointerId: number;
    pointerType: string;
    name: string;
    target: HTMLButtonElement;
    timer: ReturnType<typeof setTimeout>;
  };

  type SuppressedPreviewClick = {
    pointerKey: string;
    pointerId: number;
    pointerType: string;
    target: HTMLButtonElement;
    until: number;
  };

  type PreviewPointerIdentity = {
    pointerKey: string;
    pointerId: number;
    pointerType: string;
  };

  let {
    sessions,
    palette,
    onOpen,
    onNew,
    onKill,
    newLabel = '+ terminal',
    emptyLabel = 'No sessions yet — start one',
    loading = false,
    skeletonCount = 6,
    loadingLabel = 'Loading sessions',
    filterOptions = [],
    allFilterLabel = 'ALL',
    searchable = false,
    searchLabel = 'Search sessions',
    searchPlaceholder = 'Search sessions',
    groupable = false,
    groupToggleLabel = 'Group',
    defaultGrouped = false,
    ungroupedLabel = 'Ungrouped',
    order = 'input',
    cardLayout = 'default',
    showNew = true,
    copyNameLabel = 'Copy tmux session name',
    expandLabel = 'Expand terminal',
    killLabel = 'Kill tmux session',
  }: SessionGridProps = $props();

  let gridEl = $state<HTMLDivElement | null>(null);
  let filterValue = $state('');
  let searchText = $state('');
  let grouped = $state(false);
  let previousDefaultGrouped = $state<boolean | null>(null);
  let activeFocusKey = $state<string | null>(null);
  let hoveredPreview = $state<string | null>(null);
  let focusedPreview = $state<string | null>(null);
  // These records do not render UI, so keep them outside the reactive graph.
  // `isPrimary` is only singular per pointer type: a touch and an XR/mouse
  // pointer can both be primary at once, hence the per-pointer maps.
  const previewGestures = new Map<string, PreviewGesture>();
  const pendingPreviewActivations = new Map<string, PendingPreviewActivation>();
  const suppressedPreviewClicks = new Map<string, SuppressedPreviewClick>();

  let model = $derived(buildSessionGridModel(sessions, {
    filterValue,
    search: searchText,
    grouped: groupable && grouped,
    order,
    ungroupedLabel,
  }));
  let controlsVisible = $derived(searchable || filterOptions.length > 0 || groupable);
  let showSkeletons = $derived(loading && sessions.length === 0);
  let skeletonSlots = $derived(Array.from({ length: skeletonSlotCount(skeletonCount) }, (_, index) => index));
  let focusKeys = $derived([
    ...model.items.map((item) => item.session.name),
    ...(showNew ? [NEW_FOCUS_KEY] : []),
  ]);

  $effect(() => {
    if (previousDefaultGrouped !== defaultGrouped) {
      grouped = defaultGrouped;
      previousDefaultGrouped = defaultGrouped;
    }
    if (!groupable && grouped) grouped = false;
  });

  $effect(() => {
    if (focusKeys.length === 0) {
      activeFocusKey = null;
      return;
    }
    if (!activeFocusKey || !focusKeys.includes(activeFocusKey)) activeFocusKey = focusKeys[0] ?? null;
  });

  function skeletonSlotCount(value: number): number {
    return Math.max(1, Math.min(24, Math.floor(Number.isFinite(value) ? value : 6)));
  }

  function focusKey(): string | null {
    return activeFocusKey ?? focusKeys[0] ?? null;
  }

  function tabIndexFor(key: string): 0 | -1 {
    return focusKey() === key ? 0 : -1;
  }

  function setFilter(next: string) {
    filterValue = next;
  }

  function setSearch(event: Event) {
    const target = event.currentTarget;
    if (target instanceof HTMLInputElement) searchText = target.value;
  }

  function isFormTarget(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    if (target.isContentEditable) return true;
    return ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(target.tagName) && target.getAttribute('data-focus-key') === null;
  }

  function focusableButtons(): HTMLButtonElement[] {
    if (!gridEl) return [];
    return Array.from(gridEl.querySelectorAll<HTMLButtonElement>('button[data-focus-key]'))
      .filter((button) => !button.disabled && button.offsetParent !== null);
  }

  function directionalScore(direction: string, current: DOMRect, candidate: DOMRect): number | null {
    const currentX = current.left + current.width / 2;
    const currentY = current.top + current.height / 2;
    const candidateX = candidate.left + candidate.width / 2;
    const candidateY = candidate.top + candidate.height / 2;
    const dx = candidateX - currentX;
    const dy = candidateY - currentY;

    if (direction === 'ArrowRight') {
      if (dx <= 1) return null;
      return dx * 2 + Math.abs(dy);
    }
    if (direction === 'ArrowLeft') {
      if (dx >= -1) return null;
      return Math.abs(dx) * 2 + Math.abs(dy);
    }
    if (direction === 'ArrowDown') {
      if (dy <= 1) return null;
      return dy * 2 + Math.abs(dx) * 3;
    }
    if (direction === 'ArrowUp') {
      if (dy >= -1) return null;
      return Math.abs(dy) * 2 + Math.abs(dx) * 3;
    }
    return null;
  }

  function moveFocus(direction: string) {
    const buttons = focusableButtons();
    if (buttons.length === 0) return;
    const active = document.activeElement instanceof HTMLButtonElement && document.activeElement.dataset.focusKey
      ? document.activeElement
      : buttons.find((button) => button.dataset.focusKey === focusKey()) ?? buttons[0];
    if (!active) return;

    const currentRect = active.getBoundingClientRect();
    let best: { button: HTMLButtonElement; score: number } | null = null;
    for (const button of buttons) {
      if (button === active) continue;
      const score = directionalScore(direction, currentRect, button.getBoundingClientRect());
      if (score === null) continue;
      if (!best || score < best.score) best = { button, score };
    }
    if (!best) return;
    activeFocusKey = best.button.dataset.focusKey ?? null;
    best.button.focus();
  }

  function handleGridKeydown(event: KeyboardEvent) {
    if (!['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp'].includes(event.key)) return;
    if (!gridEl || !(event.target instanceof Node) || !gridEl.contains(event.target)) return;
    if (isFormTarget(event.target)) return;
    event.preventDefault();
    moveFocus(event.key);
  }

  function stateClass(state: string | undefined): string {
    return state === 'working' ? 'state working' : 'state idle';
  }

  function denseSummary(session: GridSession): string | undefined {
    return session.summary ?? session.subtitle;
  }

  function copySessionName(name: string): void {
    void copyPlainText(name);
  }

  function densePreviewBackground(name: string): string | undefined {
    return hoveredPreview === name || focusedPreview === name
      ? undefined
      : DENSE_IDLE_BACKGROUND;
  }

  function leavePreview(name: string): void {
    if (hoveredPreview === name) hoveredPreview = null;
  }

  function blurPreview(name: string): void {
    if (focusedPreview === name) focusedPreview = null;
  }

  function previewPointerKey(pointerType: string, pointerId: number): string {
    return `${pointerType || 'unknown'}:${pointerId}`;
  }

  function clearPendingPreviewActivation(pending: PendingPreviewActivation): void {
    clearTimeout(pending.timer);
    if (pendingPreviewActivations.get(pending.pointerKey) === pending) {
      pendingPreviewActivations.delete(pending.pointerKey);
    }
  }

  function suppressLatePreviewClick(
    pointerKey: string,
    pointerId: number,
    pointerType: string,
    target: HTMLButtonElement,
  ): void {
    suppressedPreviewClicks.set(pointerKey, {
      pointerKey,
      pointerId,
      pointerType,
      target,
      until: Date.now() + PREVIEW_CLICK_DEDUPE_MS,
    });
  }

  function clearExpiredPreviewSuppressions(): void {
    const now = Date.now();
    for (const [key, suppression] of suppressedPreviewClicks) {
      if (suppression.until < now) suppressedPreviewClicks.delete(key);
    }
  }

  function cancelAllPreviewWork(): void {
    for (const gesture of previewGestures.values()) {
      suppressLatePreviewClick(gesture.pointerKey, gesture.pointerId, gesture.pointerType, gesture.target);
      if (gesture.pointerType === 'touch') leavePreview(gesture.name);
    }
    previewGestures.clear();
    for (const pending of pendingPreviewActivations.values()) {
      clearTimeout(pending.timer);
      suppressLatePreviewClick(pending.pointerKey, pending.pointerId, pending.pointerType, pending.target);
    }
    pendingPreviewActivations.clear();
  }

  function previewSessionStillExists(name: string): boolean {
    return sessions.some((session) => session.name === name);
  }

  function commitPreviewActivation(pending: PendingPreviewActivation): void {
    if (pendingPreviewActivations.get(pending.pointerKey) !== pending) return;
    const canOpen = pending.target.isConnected && previewSessionStillExists(pending.name);
    cancelAllPreviewWork();
    if (canOpen) onOpen(pending.name);
  }

  function previewRect(target: HTMLButtonElement): PreviewRect {
    const rect = target.getBoundingClientRect();
    return {
      left: rect.left,
      right: rect.right,
      top: rect.top,
      bottom: rect.bottom,
      width: rect.width,
      height: rect.height,
    };
  }

  function previewRectContains(rect: PreviewRect, x: number, y: number): boolean {
    return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
  }

  function previewReleaseIsInside(gesture: PreviewGesture, event: PointerEvent): boolean {
    const currentRect = previewRect(gesture.target);
    // DOM-only test shims report a zero rect. Real laid-out cards must contain
    // the release in either their pressed or current (possibly reordered) box.
    const hasLayout = gesture.startRect.width > 0 || gesture.startRect.height > 0
      || currentRect.width > 0 || currentRect.height > 0;
    return !hasLayout
      || previewRectContains(gesture.startRect, event.clientX, event.clientY)
      || previewRectContains(currentRect, event.clientX, event.clientY);
  }

  function eventPreviewPointerIdentity(event: MouseEvent): PreviewPointerIdentity | null {
    if (typeof PointerEvent === 'undefined' || !(event instanceof PointerEvent)) return null;
    return {
      pointerKey: previewPointerKey(event.pointerType, event.pointerId),
      pointerId: event.pointerId,
      pointerType: event.pointerType,
    };
  }

  function previewPointerEnter(event: PointerEvent, name: string): void {
    // Direct-touch pointers do not hover. Treating their synthetic enter as a
    // hover repaints a large live miniature before the press has even settled,
    // and leaves a misleading sticky highlight when the browser starts a pan.
    if (event.pointerType !== 'touch') hoveredPreview = name;
  }

  function previewPointerLeave(event: PointerEvent, name: string): void {
    if (event.pointerType !== 'touch') leavePreview(name);
  }

  function previewScrollTarget(target: HTMLElement): Element {
    let parent = target.parentElement;
    while (parent && parent !== document.body) {
      const style = getComputedStyle(parent);
      const scrollable = /(auto|scroll|overlay)/.test(`${style.overflowX} ${style.overflowY}`);
      if (scrollable && (parent.scrollHeight > parent.clientHeight || parent.scrollWidth > parent.clientWidth)) {
        return parent;
      }
      parent = parent.parentElement;
    }
    return document.scrollingElement ?? document.documentElement;
  }

  function previewPointerDown(event: PointerEvent, name: string): void {
    if (event.isPrimary === false || event.button !== 0) return;
    const target = event.currentTarget;
    if (!(target instanceof HTMLButtonElement)) return;

    const pointerKey = previewPointerKey(event.pointerType, event.pointerId);
    const existingPending = pendingPreviewActivations.get(pointerKey);
    if (existingPending) {
      clearPendingPreviewActivation(existingPending);
      suppressLatePreviewClick(
        existingPending.pointerKey,
        existingPending.pointerId,
        existingPending.pointerType,
        existingPending.target,
      );
    }
    previewGestures.delete(pointerKey);
    clearExpiredPreviewSuppressions();

    const scrollTarget = previewScrollTarget(target);
    previewGestures.set(pointerKey, {
      pointerKey,
      pointerId: event.pointerId,
      pointerType: event.pointerType,
      name,
      target,
      startX: event.clientX,
      startY: event.clientY,
      startRect: previewRect(target),
      scrollTarget,
      startScrollLeft: scrollTarget.scrollLeft,
      startScrollTop: scrollTarget.scrollTop,
      moved: false,
    });
    // Touch has implicit capture in modern browsers; explicit capture also
    // covers mouse-like XR/WebView pointers and keeps the original session
    // attached when a live host reorders keyed cards under the pointer.
    try {
      target.setPointerCapture(event.pointerId);
    } catch {
      // Some DOM shims and older embedded browsers do not implement capture.
      // The pointerup fallback still improves their clean-tap path.
    }
    hoveredPreview = name;
  }

  function updatePreviewPointerDistance(event: PointerEvent): PreviewGesture | null {
    const gesture = previewGestures.get(previewPointerKey(event.pointerType, event.pointerId));
    if (!gesture) return null;
    const pointerDistance = Math.hypot(event.clientX - gesture.startX, event.clientY - gesture.startY);
    const scrollDistance = Math.hypot(
      gesture.scrollTarget.scrollLeft - gesture.startScrollLeft,
      gesture.scrollTarget.scrollTop - gesture.startScrollTop,
    );
    if (pointerDistance > PREVIEW_TAP_SLOP_PX || scrollDistance > PREVIEW_SCROLL_SLOP_PX) {
      gesture.moved = true;
    }
    return gesture;
  }

  function previewPointerMove(event: PointerEvent): void {
    updatePreviewPointerDistance(event);
  }

  function previewPointerCancel(event: PointerEvent): void {
    const pointerKey = previewPointerKey(event.pointerType, event.pointerId);
    const gesture = previewGestures.get(pointerKey);
    if (!gesture) return;
    previewGestures.delete(pointerKey);
    suppressLatePreviewClick(pointerKey, gesture.pointerId, gesture.pointerType, gesture.target);
    if (gesture.pointerType === 'touch') leavePreview(gesture.name);
  }

  function previewContextMenu(event: MouseEvent): void {
    const target = event.currentTarget;
    if (!(target instanceof HTMLButtonElement)) return;
    const pointer = eventPreviewPointerIdentity(event);

    for (const [key, gesture] of previewGestures) {
      const samePointer = pointer && (
        key === pointer.pointerKey
        || (gesture.pointerId === pointer.pointerId && gesture.pointerType === pointer.pointerType)
      );
      if (samePointer || gesture.target === target) {
        previewGestures.delete(key);
        suppressLatePreviewClick(key, gesture.pointerId, gesture.pointerType, gesture.target);
        if (gesture.pointerType === 'touch') leavePreview(gesture.name);
      }
    }
    for (const [key, pending] of pendingPreviewActivations) {
      const samePointer = pointer && (
        key === pointer.pointerKey
        || (pending.pointerId === pointer.pointerId && pending.pointerType === pointer.pointerType)
      );
      if (samePointer || pending.target === target) {
        clearPendingPreviewActivation(pending);
        suppressLatePreviewClick(key, pending.pointerId, pending.pointerType, pending.target);
      }
    }
    // Keep the browser's context menu available. This handler only makes sure
    // a long-press cannot also turn into a delayed session activation.
  }

  function previewPointerUp(event: PointerEvent): void {
    const gesture = updatePreviewPointerDistance(event);
    if (!gesture) return;
    previewGestures.delete(gesture.pointerKey);
    if (gesture.pointerType === 'touch') leavePreview(gesture.name);

    // Without capture, a keyed reorder can deliver pointerup to the card that
    // moved underneath the coordinates. The connected pointerdown target is
    // still authoritative; a removed target is never activated.
    if (gesture.moved || !gesture.target.isConnected || !previewReleaseIsInside(gesture, event)) {
      suppressLatePreviewClick(
        gesture.pointerKey,
        gesture.pointerId,
        gesture.pointerType,
        gesture.target,
      );
      return;
    }

    const priorPending = pendingPreviewActivations.get(gesture.pointerKey);
    if (priorPending) clearPendingPreviewActivation(priorPending);
    // Let a standards-compliant click win. Embedded browsers that deliver
    // pointerup but omit the compatibility click still open after one frame;
    // any unusually late click is then absorbed below instead of opening twice.
    const timer = setTimeout(() => {
      const pending = pendingPreviewActivations.get(gesture.pointerKey);
      if (!pending || pending.timer !== timer) return;
      commitPreviewActivation(pending);
    }, PREVIEW_CLICK_WAIT_MS);
    pendingPreviewActivations.set(gesture.pointerKey, {
      pointerKey: gesture.pointerKey,
      pointerId: gesture.pointerId,
      pointerType: gesture.pointerType,
      name: gesture.name,
      target: gesture.target,
      timer,
    });
  }

  function previewClick(event: MouseEvent, name: string): void {
    const target = event.currentTarget;
    if (!(target instanceof HTMLButtonElement)) return;

    // detail=0 is a keyboard, switch-control, voice or programmatic action.
    // It must win over any unrelated touch that happens to be pending.
    if (event.detail === 0) {
      cancelAllPreviewWork();
      onOpen(name);
      return;
    }

    clearExpiredPreviewSuppressions();
    const pointer = eventPreviewPointerIdentity(event);
    let pending = pointer ? pendingPreviewActivations.get(pointer.pointerKey) : undefined;
    if (!pending && pointer) {
      const sameId = [...pendingPreviewActivations.values()]
        .filter((candidate) => candidate.pointerId === pointer.pointerId);
      if (sameId.length === 1) pending = sameId[0];
    }
    // Safari/WebViews that still expose click as MouseEvent have no pointerId;
    // match the original node instead. A correlated modern PointerEvent can
    // safely keep the pointerdown session even if a live reorder retargets it.
    if (!pending) {
      pending = [...pendingPreviewActivations.values()].find((candidate) => candidate.target === target);
    }
    if (pending) {
      commitPreviewActivation(pending);
      return;
    }

    let suppressed = pointer ? suppressedPreviewClicks.get(pointer.pointerKey) : undefined;
    if (!suppressed && pointer) {
      const sameId = [...suppressedPreviewClicks.values()]
        .filter((candidate) => candidate.pointerId === pointer.pointerId);
      if (sameId.length === 1) suppressed = sameId[0];
    }
    if (!suppressed) {
      suppressed = [...suppressedPreviewClicks.values()].find((candidate) => candidate.target === target);
    }
    if (suppressed) return;

    // A normal click with no preceding PointerEvent remains supported for old
    // engines. Since it is a complete activation, abandon unrelated gestures.
    cancelAllPreviewWork();
    onOpen(name);
  }

  onDestroy(() => {
    for (const pending of pendingPreviewActivations.values()) clearTimeout(pending.timer);
    pendingPreviewActivations.clear();
    previewGestures.clear();
    suppressedPreviewClicks.clear();
  });
</script>

{#snippet denseCard(item: PreparedGridSession)}
  <div
    class="card dense-card"
    style:--accent={item.session.color ?? 'var(--hub-accent, #1a1a1a)'}
    title={item.session.name}
    data-testid="grid-card"
    data-session={item.session.name}
    data-filter-value={item.session.filterValue ?? ''}
    data-group-key={item.session.groupKey ?? ''}
    role="group"
    aria-label={item.session.name}
  >
    <div class="dense-head" class:has-kill={!!onKill} data-testid="grid-dense-head">
      <div class="dense-section dense-name-section" data-section="name">
        <button
          type="button"
          class="dense-name"
          data-testid="grid-copy-name"
          aria-label={`${copyNameLabel}: ${item.session.name}`}
          onclick={() => copySessionName(item.session.name)}
        >{item.session.name}</button>
      </div>
      <div class="dense-section dense-note-section" data-section="note">
        {#if item.session.note}
          <span class="dense-note" data-testid="grid-note">{item.session.note}</span>
        {/if}
      </div>
      <div class="dense-section dense-summary-section" data-section="summary">
        {#if denseSummary(item.session)}
          <span class="dense-summary" data-testid="grid-summary">{denseSummary(item.session)}</span>
        {/if}
      </div>
      {#if onKill}
        <button
          type="button"
          class="dense-kill"
          data-testid="grid-kill"
          aria-label={`${killLabel}: ${item.session.name}`}
          title={`${killLabel}: ${item.session.name}`}
          onclick={(event) => {
            event.stopPropagation();
            onKill?.(item.session.name);
          }}
        ><span aria-hidden="true">×</span></button>
      {/if}
    </div>
    {#if item.session.state}
      <div class={stateClass(item.session.state)} data-testid="grid-state" data-state={item.session.state}>
        <span class="dot" aria-hidden="true"></span>
        <span>{displayStateLabel(item.session)}</span>
        {#if item.activityDatetime}
          <time data-testid="grid-activity" datetime={item.activityDatetime}>{item.session.lastActivityLabel ?? item.activityDatetime}</time>
        {/if}
      </div>
    {/if}
    <div class="live dense-preview">
      <SessionThumb
        session={item.session.name}
        palette={item.session.palette ?? palette}
        density="dense"
        previewBackground={densePreviewBackground(item.session.name)}
      />
      <!-- Keep the inert terminal miniature outside the interactive subtree
           so activation never relies on browser-specific retargeting across
           inert content. Embedded/XR pointers may repaint the miniature on a
           hover exit immediately before press; this stable sibling overlay
           remains the complete preview hit target throughout. -->
      <button
        type="button"
        class="dense-open"
        onclick={(event) => previewClick(event, item.session.name)}
        onpointerenter={(event) => previewPointerEnter(event, item.session.name)}
        onpointerleave={(event) => previewPointerLeave(event, item.session.name)}
        onpointerdown={(event) => previewPointerDown(event, item.session.name)}
        onpointermove={previewPointerMove}
        onpointerup={previewPointerUp}
        onpointercancel={previewPointerCancel}
        oncontextmenu={previewContextMenu}
        onfocus={() => {
          activeFocusKey = item.session.name;
          focusedPreview = item.session.name;
        }}
        onblur={() => blurPreview(item.session.name)}
        tabindex={tabIndexFor(item.session.name)}
        aria-label={`${expandLabel}: ${item.session.name}`}
        data-testid="grid-expand"
        data-session={item.session.name}
        data-focus-key={item.session.name}
      ></button>
    </div>
  </div>
{/snippet}

<svelte:window onkeydown={handleGridKeydown} />

<div
  class="grid"
  class:dense={cardLayout === 'dense'}
  data-testid="session-grid"
  aria-busy={loading ? 'true' : 'false'}
  bind:this={gridEl}
>
  {#if controlsVisible}
    <div class="controls" data-testid="grid-controls">
      {#if searchable}
        <label class="search">
          <span class="sr-only">{searchLabel}</span>
          <input
            data-testid="grid-search"
            type="search"
            value={searchText}
            placeholder={searchPlaceholder}
            aria-label={searchLabel}
            oninput={setSearch}
          />
        </label>
      {/if}
      {#if filterOptions.length > 0}
        <div class="filters" aria-label="Session filters">
          <button
            type="button"
            class:active={filterValue === ''}
            data-testid="grid-filter"
            data-filter-value=""
            onclick={() => setFilter('')}
          >{allFilterLabel}</button>
          {#each filterOptions as option (option.value)}
            <button
              type="button"
              class:active={filterValue === option.value}
              data-testid="grid-filter"
              data-filter-value={option.value}
              onclick={() => setFilter(option.value)}
            >{option.label}</button>
          {/each}
        </div>
      {/if}
      {#if groupable}
        <button
          class="group-toggle"
          type="button"
          aria-pressed={grouped ? 'true' : 'false'}
          data-testid="grid-group-toggle"
          onclick={() => (grouped = !grouped)}
        >{groupToggleLabel}</button>
      {/if}
    </div>
  {/if}

  {#if showSkeletons}
    {#each skeletonSlots as index (index)}
      <div
        class="card skeleton"
        data-testid="grid-skeleton"
        aria-label={loadingLabel}
        style:--skeleton-index={`${index}`}
      >
        <div class="skeleton-head"></div>
        <div class="skeleton-live"></div>
      </div>
    {/each}
  {:else if model.items.length === 0}
    <div class="empty">{emptyLabel}</div>
  {:else if model.grouped}
    {#each model.groups as group (group.key)}
      <div class="group-heading" data-testid="grid-group" data-group-key={group.key}>
        <span>{group.label}</span>
        <span>{group.items.length}</span>
      </div>
      {#each group.items as rawItem (rawItem.session.name)}
        {@const item = rawItem}
        {#if cardLayout === 'dense'}
          {@render denseCard(item)}
        {:else}
          <button
          class="card"
          style:--accent={item.session.color ?? 'var(--hub-accent, #1a1a1a)'}
          onclick={() => onOpen(item.session.name)}
          onfocus={() => (activeFocusKey = item.session.name)}
          tabindex={tabIndexFor(item.session.name)}
          title={item.session.name}
          data-testid="grid-card"
          data-session={item.session.name}
          data-filter-value={item.session.filterValue ?? ''}
          data-group-key={item.session.groupKey ?? ''}
          data-focus-key={item.session.name}
        >
          <div class="head">
            {#if item.session.chip}<span class="chip" aria-hidden="true">{item.session.chip}</span>{/if}
            <span class="name" aria-hidden="true">
              {#if item.displayName.truncated}
                <span class="name-head">{item.displayName.head}</span><span class="name-gap">…</span><span class="name-tail">{item.displayName.tail}</span>
              {:else}
                <span class="name-full">{item.displayName.full}</span>
              {/if}
            </span>
            <span class="sr-only">{item.session.name}</span>
          </div>
          {#if item.session.subtitle}
            <div class="subtitle" data-testid="grid-subtitle">{item.session.subtitle}</div>
          {/if}
          {#if item.session.state}
            <div class={stateClass(item.session.state)} data-testid="grid-state" data-state={item.session.state}>
              <span class="dot" aria-hidden="true"></span>
              <span>{displayStateLabel(item.session)}</span>
              {#if item.activityDatetime}
                <time data-testid="grid-activity" datetime={item.activityDatetime}>{item.session.lastActivityLabel ?? item.activityDatetime}</time>
              {/if}
            </div>
          {/if}
          <div class="live">
            <SessionThumb session={item.session.name} palette={item.session.palette ?? palette} />
          </div>
          </button>
        {/if}
      {/each}
    {/each}
  {:else}
    {#each model.items as rawItem (rawItem.session.name)}
      {@const item = rawItem}
      {#if cardLayout === 'dense'}
        {@render denseCard(item)}
      {:else}
        <button
        class="card"
        style:--accent={item.session.color ?? 'var(--hub-accent, #1a1a1a)'}
        onclick={() => onOpen(item.session.name)}
        onfocus={() => (activeFocusKey = item.session.name)}
        tabindex={tabIndexFor(item.session.name)}
        title={item.session.name}
        data-testid="grid-card"
        data-session={item.session.name}
        data-filter-value={item.session.filterValue ?? ''}
        data-group-key={item.session.groupKey ?? ''}
        data-focus-key={item.session.name}
      >
        <div class="head">
          {#if item.session.chip}<span class="chip" aria-hidden="true">{item.session.chip}</span>{/if}
          <span class="name" aria-hidden="true">
            {#if item.displayName.truncated}
              <span class="name-head">{item.displayName.head}</span><span class="name-gap">…</span><span class="name-tail">{item.displayName.tail}</span>
            {:else}
              <span class="name-full">{item.displayName.full}</span>
            {/if}
          </span>
          <span class="sr-only">{item.session.name}</span>
        </div>
        {#if item.session.subtitle}
          <div class="subtitle" data-testid="grid-subtitle">{item.session.subtitle}</div>
        {/if}
        {#if item.session.state}
          <div class={stateClass(item.session.state)} data-testid="grid-state" data-state={item.session.state}>
            <span class="dot" aria-hidden="true"></span>
            <span>{displayStateLabel(item.session)}</span>
            {#if item.activityDatetime}
              <time data-testid="grid-activity" datetime={item.activityDatetime}>{item.session.lastActivityLabel ?? item.activityDatetime}</time>
            {/if}
          </div>
        {/if}
        <div class="live">
          <SessionThumb session={item.session.name} palette={item.session.palette ?? palette} />
        </div>
        </button>
      {/if}
    {/each}
  {/if}

  {#if showNew}
    <button
      class="card new"
      onclick={onNew}
      onfocus={() => (activeFocusKey = NEW_FOCUS_KEY)}
      tabindex={tabIndexFor(NEW_FOCUS_KEY)}
      data-testid="grid-new"
      data-focus-key={NEW_FOCUS_KEY}
    >
      <span class="plus">+</span>
      <span class="new-label">{newLabel}</span>
    </button>
  {/if}
</div>

<style>
  .grid {
    --grid-cols: 2;
    display: grid;
    grid-template-columns: repeat(var(--grid-cols), minmax(0, 1fr));
    gap: 10px;
    width: min(100%, 1680px);
    margin: 0 auto;
    padding: 10px;
    box-sizing: border-box;
    overflow-x: clip;
  }
  @media (min-width: 768px) {
    .grid { --grid-cols: 4; gap: 12px; padding: 12px; }
  }
  @media (min-width: 1024px) {
    .grid { --grid-cols: 5; }
  }
  @media (min-width: 1440px) {
    .grid { --grid-cols: 6; }
  }
  .grid.dense {
    grid-template-columns: minmax(0, 1fr);
    gap: 8px;
    width: 100%;
    max-width: none;
    padding: 0;
  }
  .grid.dense .card {
    box-sizing: border-box;
    width: 100%;
    height: auto;
    aspect-ratio: 1 / 1;
    border-radius: 0;
  }
  @media (min-width: 768px) and (pointer: fine) {
    .grid.dense {
      grid-template-columns: repeat(auto-fit, 500px);
      justify-content: start;
    }
    .grid.dense .card {
      width: 500px;
      height: 500px;
      aspect-ratio: auto;
    }
  }
  .controls,
  .group-heading,
  .empty {
    grid-column: 1 / -1;
  }
  .controls {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    min-width: 0;
  }
  .search {
    flex: 1 1 180px;
    min-width: min(100%, 150px);
  }
  .search input {
    width: 100%;
    min-width: 0;
    box-sizing: border-box;
    border: 1px solid var(--hub-line, #d8d2c8);
    background: var(--hub-card, #ffffff);
    color: var(--hub-ink, #1a1a1a);
    padding: 9px 10px;
    font: 700 12px var(--font-mono, ui-monospace, monospace);
    border-radius: 6px;
  }
  .filters {
    display: flex;
    flex: 0 1 auto;
    gap: 6px;
    flex-wrap: wrap;
    min-width: 0;
  }
  .filters button,
  .group-toggle {
    min-height: 34px;
    border: 1px solid var(--hub-line, #d8d2c8);
    background: var(--hub-card, #ffffff);
    color: var(--hub-ink2, #6b6560);
    padding: 0 10px;
    border-radius: 6px;
    font: 800 10px var(--font-mono, ui-monospace, monospace);
    cursor: pointer;
  }
  .filters button.active,
  .group-toggle[aria-pressed="true"] {
    background: var(--hub-ink, #1a1a1a);
    border-color: var(--hub-ink, #1a1a1a);
    color: var(--hub-card, #ffffff);
  }
  .group-toggle {
    margin-left: auto;
  }
  .group-heading {
    display: flex;
    align-items: center;
    justify-content: space-between;
    min-width: 0;
    padding: 7px 2px 0;
    color: var(--hub-ink2, #6b6560);
    font: 800 10px var(--font-mono, ui-monospace, monospace);
    text-transform: uppercase;
  }
  .card {
    position: relative;
    aspect-ratio: 1 / 1;
    width: 100%;
    min-width: 0;
    display: flex;
    flex-direction: column;
    background: var(--hub-card, #ffffff);
    border: 1px solid var(--hub-line, #d8d2c8);
    border-radius: 8px;
    padding: 0;
    text-align: left;
    touch-action: manipulation;
    cursor: pointer;
    overflow: hidden;
  }
  .card:focus-visible,
  .filters button:focus-visible,
  .group-toggle:focus-visible,
  .search input:focus-visible {
    outline: 3px solid color-mix(in srgb, var(--accent, var(--hub-accent, #1a1a1a)) 80%, white);
    outline-offset: 2px;
  }
  .head {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    padding: 7px 9px;
    border-bottom: 2px solid var(--accent);
    background: var(--hub-card, #ffffff);
    z-index: 1;
  }
  .dense-head {
    position: relative;
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    align-items: stretch;
    gap: 0;
    min-width: 0;
    height: 72px;
    padding: 0;
    border-bottom: 1px solid var(--hub-dense-divider, #9b9590);
    background: var(--hub-card, #ffffff);
    color: var(--hub-ink, #1a1a1a);
    font: 600 12px/1.7 var(--font-mono, ui-monospace, monospace);
    z-index: 1;
  }
  .dense-section {
    min-width: 0;
    min-height: 0;
    box-sizing: border-box;
    padding: 4px 6px;
    overflow: hidden;
    color: var(--hub-ink, #1a1a1a);
  }
  .dense-section + .dense-section {
    border-inline-start: 1px solid var(--hub-dense-divider, #9b9590);
  }
  .dense-name-section {
    padding: 0;
  }
  .dense-name {
    width: 100%;
    height: 100%;
    min-width: 44px;
    min-height: 44px;
    box-sizing: border-box;
    border: 0;
    border-radius: 0;
    background: transparent;
    color: var(--hub-ink, #1a1a1a);
    font: 700 12px/1.4 var(--font-mono, ui-monospace, monospace);
    cursor: pointer;
    touch-action: manipulation;
    padding: 4px 6px;
    text-align: left;
    white-space: normal;
    overflow-wrap: anywhere;
  }
  .dense-name:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }
  .dense-note,
  .dense-summary {
    width: 100%;
    min-width: 0;
    max-width: 100%;
    overflow-wrap: anywhere;
    word-break: normal;
    letter-spacing: 0;
    font-family: var(--font-thai, var(--font-mono, ui-monospace, monospace));
    line-height: 1.7;
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 3;
    line-clamp: 3;
    overflow: hidden;
    color: var(--hub-ink, #1a1a1a);
  }
  .dense-note {
    font-weight: 500;
  }
  .dense-summary {
    font-weight: 600;
  }
  .dense-head.has-kill .dense-summary-section {
    padding-inline-end: 48px;
  }
  .dense-kill {
    position: absolute;
    inset-block-start: 0;
    inset-inline-end: 0;
    z-index: 2;
    width: 44px;
    height: 44px;
    display: grid;
    place-items: center;
    padding: 0;
    border: 0;
    border-inline-start: 1px solid var(--hub-dense-divider, #9b9590);
    border-block-end: 1px solid var(--hub-dense-divider, #9b9590);
    border-radius: 0;
    background: var(--hub-card, #ffffff);
    color: var(--hub-ink, #1a1a1a);
    font: 400 24px/1 var(--font-mono, ui-monospace, monospace);
    cursor: pointer;
    touch-action: manipulation;
  }
  .dense-kill:hover,
  .dense-kill:active {
    background: var(--hub-ink, #1a1a1a);
    color: var(--hub-card, #ffffff);
  }
  .dense-kill:focus-visible {
    outline: 3px solid var(--hub-ink, #1a1a1a);
    outline-offset: -3px;
  }
  .dense-card .state {
    min-height: 20px;
    padding: 2px 4px 0;
  }
  .dense-card {
    cursor: default;
  }
  .dense-card .state .dot {
    box-shadow: none;
  }
  .dense-card .live {
    border-top: 0;
  }
  .dense-preview {
    isolation: isolate;
  }
  .dense-open {
    position: absolute;
    inset: 0;
    z-index: 1;
    width: 100%;
    height: 100%;
    min-width: 0;
    min-height: 0;
    margin: 0;
    padding: 0;
    appearance: none;
    border: 0;
    border-radius: 0;
    background: transparent;
    color: inherit;
    text-align: left;
    cursor: pointer;
    pointer-events: auto;
    touch-action: manipulation;
    -webkit-tap-highlight-color: transparent;
  }
  .dense-open:focus-visible {
    z-index: 2;
    outline: 0;
  }
  .dense-open:focus-visible::after {
    content: '';
    position: absolute;
    inset: 0;
    z-index: 3;
    box-sizing: border-box;
    pointer-events: none;
    box-shadow: inset 0 0 0 3px #ffffff, inset 0 0 0 6px #111111;
  }
  @media (forced-colors: active) {
    .dense-open:focus-visible {
      outline: 0;
    }
    .dense-open:focus-visible::after {
      border: 3px solid CanvasText;
      box-shadow: none;
    }
  }
  .subtitle {
    padding: 5px 9px 0;
    color: var(--hub-ink, #1a1a1a);
    font: 600 9.5px var(--font-thai, var(--font-mono, ui-monospace, monospace));
    line-height: 1.4;
    opacity: .75;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .chip {
    font: 700 8px var(--font-mono, ui-monospace, monospace);
    letter-spacing: .05em;
    padding: 2px 5px;
    background: var(--accent);
    color: var(--hub-card, #ffffff);
    flex: 0 0 auto;
    border-radius: 3px;
  }
  .name {
    min-width: 0;
    flex: 1 1 auto;
    display: flex;
    align-items: baseline;
    color: var(--hub-ink, #1a1a1a);
    font: 700 10.5px var(--font-mono, ui-monospace, monospace);
    white-space: nowrap;
  }
  .name-full,
  .name-head {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }
  .name-full {
    flex: 1 1 auto;
  }
  .name-head {
    flex: 1 1 auto;
  }
  .name-gap {
    flex: 0 0 auto;
    padding: 0 1px;
  }
  .name-tail {
    /* The tail IS the distinguishing part — it must never shrink or clip;
     * .name-head (min-width:0 + ellipsis) absorbs all the squeeze. */
    flex: 0 0 auto;
    white-space: nowrap;
  }
  .state {
    display: flex;
    align-items: center;
    gap: 5px;
    min-height: 24px;
    min-width: 0;
    padding: 5px 9px 0;
    color: var(--hub-ink2, #6b6560);
    font: 800 8.5px var(--font-mono, ui-monospace, monospace);
    line-height: 1.2;
    text-transform: uppercase;
    z-index: 1;
  }
  .state .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    /* State is a UNIVERSAL color (green=working), not the agent accent —
     * dark agent accents (near-black/deep blue) vanish on dark card
     * surfaces, and the agent identity already lives in the chip. Hosts
     * theme via --dot-working / --dot-idle. */
    background: var(--dot-working, #22c55e);
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--dot-working, #22c55e) 22%, transparent);
    flex: 0 0 auto;
  }
  .state.idle .dot {
    background: var(--dot-idle, #9aa3af);
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--dot-idle, #9aa3af) 18%, transparent);
    opacity: 1;
  }
  .state.working .dot {
    animation: grid-pulse 1.1s ease-in-out infinite;
  }
  .state time {
    margin-left: auto;
    min-width: 0;
    max-width: 48%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--hub-ink2, #6b6560);
    opacity: .88;
    text-transform: none;
  }
  .live {
    position: relative;
    flex: 1;
    min-height: 0;
    container-type: inline-size;
  }
  .card.new {
    align-items: center;
    justify-content: center;
    border-style: dashed;
    background: transparent;
  }
  .plus {
    font: 300 44px var(--font-mono, ui-monospace, monospace);
    color: var(--hub-accent, #1a1a1a);
    line-height: 1;
  }
  .new-label {
    font: 700 11px var(--font-mono, ui-monospace, monospace);
    color: var(--hub-ink2, #6b6560);
    margin-top: 6px;
    max-width: 80%;
    overflow-wrap: anywhere;
    text-align: center;
  }
  .empty {
    font: 400 13px var(--font-thai, sans-serif);
    color: var(--hub-ink2, #6b6560);
    padding: 18px 8px;
  }
  .skeleton {
    cursor: default;
    border-color: color-mix(in srgb, var(--hub-line, #d8d2c8) 70%, transparent);
    background: color-mix(in srgb, var(--hub-card, #ffffff) 86%, var(--hub-line, #d8d2c8));
  }
  .skeleton::after {
    content: "";
    position: absolute;
    inset: 0;
    transform: translateX(-100%);
    background: linear-gradient(90deg, transparent, rgba(255,255,255,.55), transparent);
    animation: grid-shimmer 1.25s ease-in-out infinite;
    animation-delay: calc(var(--skeleton-index, 0) * 70ms);
  }
  .grid.dense .skeleton::after {
    display: none;
  }
  .skeleton-head,
  .skeleton-live {
    position: relative;
    z-index: 1;
    background: rgba(0,0,0,.08);
  }
  .skeleton-head {
    height: 26px;
    margin: 10px;
    border-radius: 4px;
  }
  .skeleton-live {
    flex: 1;
    margin: 0 10px 10px;
    border-radius: 6px;
  }
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }
  @keyframes grid-pulse {
    0%, 100% { transform: scale(1); opacity: 1; }
    50% { transform: scale(.68); opacity: .52; }
  }
  @keyframes grid-shimmer {
    100% { transform: translateX(100%); }
  }
  @media (prefers-reduced-motion: reduce) {
    .state.working .dot,
    .skeleton::after {
      animation: none;
    }
    .skeleton::after {
      transform: none;
      opacity: .35;
    }
  }
</style>
