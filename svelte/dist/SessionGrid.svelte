<script module lang="ts">
  export type GridSession = {
    name: string;
    /** small badge text, e.g. agent kind */
    chip?: string;
    /** accent for the badge/border */
    color?: string;
    /** per-session thumbnail palette override */
    palette?: import('@thumbmux/core').AnsiPalette;
  };
</script>

<script lang="ts">
  /** SessionGrid — the "which terminal?" screen. A grid of live pane
   * miniatures (SessionThumb) plus a "+ terminal" card. Pure presentation:
   * the host supplies sessions and handles open/new. */
  import SessionThumb from './SessionThumb.svelte';
  import type { AnsiPalette } from '@thumbmux/core';

  let {
    sessions,
    palette,
    onOpen,
    onNew,
    newLabel = '+ terminal',
    emptyLabel = 'No sessions yet — start one',
  }: {
    sessions: GridSession[];
    /** default thumbnail palette (per-session override via GridSession.palette) */
    palette: AnsiPalette;
    onOpen: (name: string) => void;
    onNew: () => void;
    newLabel?: string;
    emptyLabel?: string;
  } = $props();
</script>

<div class="grid" data-testid="session-grid">
  {#each sessions as s (s.name)}
    <button class="card" style:--accent={s.color ?? 'var(--hub-accent, #1a1a1a)'} onclick={() => onOpen(s.name)} data-testid="grid-card" data-session={s.name}>
      <div class="head">
        {#if s.chip}<span class="chip">{s.chip}</span>{/if}
        <span class="name">{s.name}</span>
      </div>
      <div class="live">
        <SessionThumb session={s.name} palette={s.palette ?? palette} />
      </div>
    </button>
  {:else}
    <div class="empty">{emptyLabel}</div>
  {/each}
  <button class="card new" onclick={onNew} data-testid="grid-new">
    <span class="plus">+</span>
    <span class="new-label">{newLabel}</span>
  </button>
</div>

<style>
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(168px, 1fr));
    gap: 10px;
    padding: 10px;
  }
  .card {
    position: relative;
    aspect-ratio: 1 / 1;
    max-width: 320px;
    width: 100%;
    display: flex; flex-direction: column;
    background: var(--hub-card, #ffffff);
    border: 1px solid var(--hub-line, #d8d2c8);
    padding: 0;
    text-align: left;
    touch-action: manipulation;
    cursor: pointer;
    overflow: hidden;
  }
  .head {
    display: flex; align-items: center; gap: 6px;
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
  }
  .name {
    font: 700 10.5px var(--font-mono, ui-monospace, monospace);
    color: var(--hub-ink, #1a1a1a);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    min-width: 0;
  }
  .live { position: relative; flex: 1; }
  .card.new {
    align-items: center; justify-content: center;
    border-style: dashed;
    background: transparent;
  }
  .plus { font: 300 44px var(--font-mono, ui-monospace, monospace); color: var(--hub-accent, #1a1a1a); line-height: 1; }
  .new-label { font: 700 11px var(--font-mono, ui-monospace, monospace); color: var(--hub-ink2, #6b6560); margin-top: 6px; }
  .empty {
    grid-column: 1 / -1;
    font: 400 13px var(--font-thai, sans-serif);
    color: var(--hub-ink2, #6b6560);
    padding: 18px 8px;
  }
</style>
