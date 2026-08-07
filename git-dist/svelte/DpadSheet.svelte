<script lang="ts">
  /** DpadSheet — arrow/enter/escape pad for TUI menus. */
  let {
    open = $bindable(false),
    onKey,
  }: {
    open?: boolean;
    onKey: (seq: string) => void;
  } = $props();
</script>

{#if open}
  <div class="dpad">
    <span></span>
    <button onclick={() => onKey('\x1b[A')}>↑</button>
    <button class="x" onclick={() => (open = false)}>✕</button>
    <button onclick={() => onKey('\x1b[D')}>←</button>
    <button class="ent" onclick={() => onKey('\r')}>⏎</button>
    <button onclick={() => onKey('\x1b[C')}>→</button>
    <button class="x" onclick={() => onKey('\x1b')}>ESC</button>
    <button onclick={() => onKey('\x1b[B')}>↓</button>
    <span></span>
  </div>
{/if}

<style>
  .dpad {
    position: absolute; left: 12px; bottom: calc(14px + env(safe-area-inset-bottom)); z-index: 38;
    display: grid; grid-template-columns: repeat(3, 52px); grid-template-rows: repeat(3, 52px); gap: 4px;
  }
  .dpad button {
    background: var(--hud); border: 1px solid var(--hud-line); color: var(--hud-fg);
    font: 700 16px var(--font-mono); touch-action: manipulation;
  }
  .dpad button:active { background: var(--agent); color: var(--tstage); border-color: var(--agent); }
  .dpad .ent { color: var(--agent); border-color: var(--agent); font-size: 13px; }
  .dpad .x { color: #ff7a6e; border-color: #804040; font-size: 11px; }
</style>
