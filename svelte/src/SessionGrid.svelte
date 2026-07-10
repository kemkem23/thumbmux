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
  import SessionThumb from './SessionThumb.svelte';
  import {
    buildSessionGridModel,
    displayStateLabel,
    type SessionGridProps,
  } from './session-grid';

  const NEW_FOCUS_KEY = '__thumbmux_new__';

  let {
    sessions,
    palette,
    onOpen,
    onNew,
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
  }: SessionGridProps = $props();

  let gridEl = $state<HTMLDivElement | null>(null);
  let filterValue = $state('');
  let searchText = $state('');
  let grouped = $state(false);
  let previousDefaultGrouped = $state<boolean | null>(null);
  let activeFocusKey = $state<string | null>(null);

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
  let focusKeys = $derived([...model.items.map((item) => item.session.name), NEW_FOCUS_KEY]);

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
</script>

<svelte:window onkeydown={handleGridKeydown} />

<div
  class="grid"
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
      {/each}
    {/each}
  {:else}
    {#each model.items as rawItem (rawItem.session.name)}
      {@const item = rawItem}
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
    {/each}
  {/if}

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
