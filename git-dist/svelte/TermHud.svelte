<script lang="ts">
  import type { Snippet } from 'svelte';
  import { copyPlainText } from './clipboard';

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
    layout = 'default',
    copyTitleAria = 'Copy tmux session name',
    expandAria = 'Expand session details',
    onCopyTitle,
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
    /** Opt-in compact metadata layout. The default preserves the historical
     * stacked title/note button and its whole-row expand target. */
    layout?: 'default' | 'dense';
    /** Accessible labels for the dense layout's two independent controls. */
    copyTitleAria?: string;
    expandAria?: string;
    /** Override the dense title button's clipboard transport. When omitted the
     * component writes to the browser clipboard with a plain-HTTP fallback. */
    onCopyTitle?: (title: string) => void | Promise<void>;
  } = $props();

  async function copyTitle(): Promise<void> {
    try {
      if (onCopyTitle) await onCopyTitle(title);
      else await copyPlainText(title);
    } catch { /* a clipboard denial must not break the HUD */ }
  }

  function toggleExpanded(): void {
    expanded = !expanded;
    onToggleExpand?.();
  }

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

<div class="hud-top" class:dense={layout === 'dense'} bind:offsetHeight={barHeight}>
  <button class="bk" onclick={onBack} aria-label={backAria}>‹</button>
  <span class="agchip">{chip}</span>
  {#if layout === 'dense'}
    <div class="hud-dense-fields" data-testid="hud-dense-fields">
      <button
        type="button"
        class="hud-copy-title"
        data-testid="hud-copy-title"
        aria-label={`${copyTitleAria}: ${title}`}
        onclick={() => { void copyTitle(); }}
      >{title}</button>
      {#if note}
        <span class="hud-separator" aria-hidden="true">:</span>
        <span class="hud-note hud-note-dense" lang="th">{note}</span>
      {/if}
      {#if titleAdornment}
        {@const denseAdornment = titleAdornment as Snippet}
        <span class="hud-separator" aria-hidden="true">:</span>
        <span
          class="hud-dense-adornment"
          data-testid="hud-title-adornment"
          data-collapsed="false"
        >{@render denseAdornment()}</span>
      {/if}
      <span class="hud-separator" aria-hidden="true">:</span>
      <button
        type="button"
        class="hud-dense-expand"
        onclick={toggleExpanded}
        aria-label={expandAria}
        aria-expanded={expanded}
        data-testid="hud-expand"
      >{expanded ? '▴' : '▾'}</button>
    </div>
  {:else}
    <button class="hud-names" onclick={toggleExpanded} aria-expanded={expanded} data-testid="hud-expand">
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
  {/if}
  {#if layout === 'default'}
    <span class="st">
      <span class="led" class:pulse={working}></span>
      {statusCase === 'upper' ? (status || '…').toUpperCase() : (status || '…')}
    </span>
  {/if}
</div>

{#if expanded && panel}
  {@const panelSnippet = panel as Snippet}
  <div class="hud-panel" class:dense={layout === 'dense'} style:top={`${barHeight}px`} data-testid="hud-panel">
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
  .hud-top.dense {
    align-items: flex-start;
    gap: 4px;
    padding: calc(2px + env(safe-area-inset-top)) 4px 2px;
    background: var(--tbg);
    border-bottom-width: 1px;
  }
  .hud-top.dense .agchip {
    display: none;
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
  .hud-dense-fields {
    min-width: 0;
    flex: 1 1 auto;
    min-height: 44px;
    display: flex;
    align-items: center;
    align-content: center;
    flex-wrap: wrap;
    gap: 0 4px;
    color: var(--hud-fg);
    font-family: var(--font-mono);
    font-size: 12px;
    font-weight: 600;
    line-height: 1.7;
  }
  .hud-copy-title,
  .hud-dense-expand {
    min-height: 44px;
    border: 0;
    border-radius: 0;
    background: transparent;
    color: var(--hud-fg);
    font: inherit;
    touch-action: manipulation;
    cursor: pointer;
  }
  .hud-copy-title {
    min-width: 44px;
    max-width: 100%;
    padding: 0;
    font-weight: 700;
    text-align: left;
    white-space: normal;
    overflow-wrap: anywhere;
  }
  .hud-dense-expand {
    flex: 0 0 44px;
    width: 44px;
    padding: 0;
    color: var(--agent);
  }
  .hud-copy-title:focus-visible,
  .hud-dense-expand:focus-visible {
    outline: 2px solid var(--agent);
    outline-offset: -2px;
  }
  .hud-separator {
    flex: 0 0 auto;
    color: var(--agent);
    font-weight: 700;
  }
  .hud-note.hud-note-dense,
  .hud-dense-adornment {
    min-width: 0;
    max-width: 100%;
    overflow: hidden;
    text-overflow: clip;
    white-space: normal;
    overflow-wrap: anywhere;
    opacity: .86;
    display: -webkit-box;
    -webkit-box-orient: vertical;
  }
  .hud-note.hud-note-dense {
    /* A short note must end where its text ends. Giving note and activity the
       same grow factor creates a large invisible half-row between their two
       separators on wide screens. The activity is normally the long field,
       so it owns the remaining width while both fields can still shrink/wrap. */
    flex: 0 1 auto;
    font-family: var(--font-thai);
    font-size: 12px;
    font-weight: 600;
    line-height: 1.7;
    letter-spacing: 0;
    word-break: normal;
    -webkit-line-clamp: 2;
    line-clamp: 2;
  }
  .hud-dense-adornment {
    flex: 1 1 180px;
    font: inherit;
    -webkit-line-clamp: 3;
    line-clamp: 3;
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
  .hud-panel.dense {
    background: var(--tbg);
  }
</style>
