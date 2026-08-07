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
  } = $props();
</script>

<div class="hud-top" bind:offsetHeight={barHeight}>
  <button class="bk" onclick={onBack} aria-label={backAria}>‹</button>
  <span class="agchip">{chip}</span>
  <button class="hud-names" onclick={() => { expanded = !expanded; onToggleExpand?.(); }} aria-expanded={expanded} data-testid="hud-expand">
    <span class="nm">{title} <span class="hud-caret">{expanded ? '▴' : '▾'}</span></span>
    {#if note}
      <span class="hud-note" lang="th">✎ {note}</span>
    {/if}
  </button>
  <span class="st">
    <span class="led" class:pulse={working}></span>
    {(status || '…').toUpperCase()}
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
  .hud-caret { color: var(--agent); font-size: 10px; }
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
