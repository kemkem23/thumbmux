<script lang="ts">
  import type { Snippet } from 'svelte';

  /** Structurally-typed snippet: Svelte's `Snippet` carries a nominal brand
   * (unique symbol), so in monorepos where the host and this package resolve
   * different copies of svelte, `Snippet !== Snippet`. A callable type keeps
   * the prop assignable from any copy; we brand it back at the render site. */
  type PanelSnippet = (() => unknown) | Snippet;

  /** TermHud — pinned top bar: back, agent chip, session name + note, status
   * LED. Tapping the name toggles an expandable panel whose CONTENT the host
   * supplies (recent prompts, notes — host-specific). */
  let {
    chip,
    title,
    note = '',
    status = '',
    working = false,
    expanded = $bindable(false),
    onBack,
    onToggleExpand,
    backAria = 'Back',
    panel,
    barHeight = $bindable(0),
    titleAdornment,
    notePrefix = '✎ ',
    statusCase = 'upper',
  }: {
    chip: string;
    title: string;
    note?: string;
    status?: string;
    working?: boolean;
    expanded?: boolean;
    onBack: () => void;
    onToggleExpand?: () => void;
    backAria?: string;
    panel?: PanelSnippet;
    /** measured rendered height of the pinned bar (incl. safe-area padding) —
     * bind it and inset your terminal host below the (opaque) HUD. */
    barHeight?: number;
    /** Inline slot on the session-name row, rendered after the title and
     * before the caret, at the row's own font size and never case-transformed.
     *
     * It COLLAPSES rather than competing for width: when the name and the slot
     * cannot both be read on one row, the slot leaves the row and the name
     * keeps all of it. Half a badge beside a name clipped to its caret is two
     * unreadable things where one of them is what the operator came to read —
     * so the slot yields entirely instead of both shrinking. The row may
     * therefore drop the slot briefly while it is still measuring.
     *
     * Omit the prop and this row renders exactly as it did before it existed. */
    titleAdornment?: PanelSnippet;
    /** Text placed before `note`. Defaults to the historical `'✎ '`; pass `''`
     * to render the note exactly as given. */
    notePrefix?: string;
    /** `'upper'` (default, historical) uppercases `status`; `'none'` renders it
     * exactly as given. */
    statusCase?: 'upper' | 'none';
  } = $props();

  /** Used only when the row's own `column-gap` cannot be read (no layout
   * engine). The measured value is always preferred so the predicate below
   * cannot drift away from the stylesheet. */
  const FALLBACK_GAP_PX = 8;

  let nmEl: HTMLElement | undefined = $state();
  let titleEl: HTMLElement | undefined = $state();
  let slotEl: HTMLElement | undefined = $state();
  let caretEl: HTMLElement | undefined = $state();
  let adornmentFits = $state(true);

  /** Decide on INTRINSIC widths only (`scrollWidth` of the clipped name and of
   * the out-of-flow slot), never on the widths they currently occupy. Those do
   * not depend on the collapsed/open state, so the answer cannot oscillate. */
  function measureAdornment(): void {
    const row = nmEl;
    const name = titleEl;
    const slot = slotEl;
    const caret = caretEl;
    if (!row || !name || !slot || !caret) return;
    const available = row.clientWidth;
    // No positive measurement, no hiding. Without a layout engine (SSR, jsdom,
    // happy-dom) every width reads 0, and the honest answer to "does it fit" is
    // "unknown" — which must render the host's content, not swallow it.
    if (available <= 0) {
      adornmentFits = true;
      return;
    }
    const parsed = Number.parseFloat(
      row.ownerDocument?.defaultView?.getComputedStyle(row).columnGap ?? '',
    );
    const gap = Number.isFinite(parsed) ? parsed : FALLBACK_GAP_PX;
    adornmentFits =
      name.scrollWidth + gap + slot.scrollWidth + gap + caret.offsetWidth <= available;
  }

  $effect(() => {
    if (!titleAdornment) return;
    const row = nmEl;
    const slot = slotEl;
    if (!row || !slot) return;
    measureAdornment();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => measureAdornment());
    // The row for available width; the slot for host content that changes size.
    // NOT the name: it is clipped, so its border box only ever moves as a
    // consequence of this decision — observing it just feeds the loop back.
    ro.observe(row);
    ro.observe(slot);
    return () => ro.disconnect();
  });

  // Same reason the name is not observed: a clipped box does not resize when
  // its text does, so a longer session name has to re-trigger the measurement
  // by value or the row keeps answering for the previous one.
  $effect(() => {
    if (!titleAdornment) return;
    void title;
    measureAdornment();
  });
</script>

<div class="hud-top" bind:offsetHeight={barHeight}>
  <button class="bk" onclick={onBack} aria-label={backAria}>‹</button>
  <span class="agchip">{chip}</span>
  <button class="hud-names" onclick={() => { expanded = !expanded; onToggleExpand?.(); }} aria-expanded={expanded} data-testid="hud-expand">
    {#if titleAdornment}
      {@const adornSnippet = titleAdornment as Snippet}
      <span class="nm nm-slotted" bind:this={nmEl}><span class="nm-title" bind:this={titleEl}>{title}</span><span
          class="nm-slot"
          class:nm-slot-collapsed={!adornmentFits}
          data-testid="hud-title-adornment"
          data-collapsed={adornmentFits ? 'false' : 'true'}
          bind:this={slotEl}
        >{@render adornSnippet()}</span><span class="hud-caret" bind:this={caretEl}>{expanded ? '▴' : '▾'}</span></span>
    {:else}
      <span class="nm">{title} <span class="hud-caret">{expanded ? '▴' : '▾'}</span></span>
    {/if}
    {#if note}
      <span class="hud-note" lang="th">{notePrefix}{note}</span>
    {/if}
  </button>
  <span class="st">
    <span class="led" class:pulse={working}></span>
    {statusCase === 'upper' ? (status || '…').toUpperCase() : (status || '…')}
  </span>
</div>

{#if expanded && panel}
  {@const panelSnippet = panel as Snippet}
  <div class="hud-panel" style:top={`${barHeight}px`} data-testid="hud-panel">
    {@render panelSnippet()}
  </div>
{/if}

<style>
  .hud-top {
    position: absolute; top: 0; left: 0; right: 0; z-index: 10;
    display: flex; align-items: center; gap: 8px;
    /* layer the (possibly translucent) hud tint over the opaque stage color —
       terminal rows must never be readable through the bar (fleet finding) */
    background: linear-gradient(var(--hud), var(--hud)), var(--tbg);
    color: var(--hud-fg);
    padding: calc(4px + env(safe-area-inset-top)) 10px 4px;
    border-bottom: 2px solid var(--agent);
    font-family: var(--font-mono);
  }
  .bk {
    font: 700 16px var(--font-mono); color: var(--hud-fg);
    background: none; border: 1px solid var(--hud-line);
    min-width: 44px; min-height: 44px; touch-action: manipulation;
  }
  .agchip { font: 700 8.5px var(--font-mono); letter-spacing: .05em; padding: 2px 6px; background: var(--agent); color: var(--tstage); flex: 0 0 auto; }
  .hud-names {
    min-width: 0; flex: 1; text-align: left; min-height: 44px;
    display: flex; flex-direction: column; justify-content: center;
    background: none; border: none; color: var(--hud-fg); padding: 0;
    touch-action: manipulation; cursor: pointer;
  }
  .nm { display: block; font: 700 12px var(--font-mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  /* Slotted variant — only reached when `titleAdornment` is passed, so a row
     without one keeps the block layout above byte for byte. */
  .nm-slotted { display: flex; align-items: baseline; column-gap: 8px; position: relative; }
  /* The name shrinks to its own ellipsis and stops there; it never disappears. */
  .nm-title { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .nm-slot { flex: 0 0 auto; white-space: nowrap; overflow: hidden; }
  /* Out of flow rather than `display: none`: a collapsed slot must keep
     reporting its intrinsic width and keep firing its ResizeObserver, or the
     row would have no way to discover that it fits again. */
  .nm-slot-collapsed {
    position: absolute; left: 0; top: 0; max-width: 100%;
    visibility: hidden; pointer-events: none;
  }
  .hud-caret { color: var(--agent); font-size: 10px; }
  .nm-slotted .hud-caret { flex: 0 0 auto; }
  .hud-note { display: block; font: 600 10px var(--font-thai); opacity: .8; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .st { display: flex; align-items: center; gap: 5px; font: 700 9px var(--font-mono); color: var(--agent); flex: 0 0 auto; }
  .led { width: 8px; height: 8px; border-radius: 50%; background: var(--agent); }
  .led.pulse { animation: mpulse 1.6s ease-in-out infinite; }
  @keyframes mpulse { 50% { opacity: .3; } }

  .hud-panel {
    position: absolute; left: 0; right: 0;
    top: calc(52px + env(safe-area-inset-top)); z-index: 9;
    background: linear-gradient(var(--hud), var(--hud)), var(--tbg);
    color: var(--hud-fg);
    border-bottom: 1px solid var(--agent);
    padding: 10px 12px calc(12px + 2px);
    max-height: 55dvh; overflow-y: auto;
  }
</style>
