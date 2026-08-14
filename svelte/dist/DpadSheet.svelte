<script lang="ts">
  import {
    DEFAULT_DPAD_PLACEMENT,
    resolveDpadPlacement,
    type DpadPlacement,
  } from './dpad';

  /** DpadSheet — arrow/enter/escape pad for TUI menus.
   *
   * Through 0.15.2 the pad was hardcoded bottom-left, which on a phone covers
   * the newest output (exactly what the user is reading when they reach for
   * arrows). Placement is now a prop; default stays bottom-left so existing
   * hosts (Hispeed) do not see a silent move. */
  let {
    open = $bindable(false),
    onKey,
    placement = DEFAULT_DPAD_PLACEMENT,
  }: {
    open?: boolean;
    onKey: (seq: string) => void;
    /** Stage corner. Defaults to `'bottom-left'` (historical stock). */
    placement?: DpadPlacement;
  } = $props();

  let corner = $derived(resolveDpadPlacement(placement));
</script>

{#if open}
  <div
    class="dpad"
    data-testid="dpad-sheet"
    data-placement={corner}
  >
    <span></span>
    <button type="button" data-testid="dpad-up" onclick={() => onKey('\x1b[A')}>↑</button>
    <button type="button" class="x" data-testid="dpad-close" onclick={() => (open = false)}>✕</button>
    <button type="button" data-testid="dpad-left" onclick={() => onKey('\x1b[D')}>←</button>
    <button type="button" class="ent" data-testid="dpad-enter" onclick={() => onKey('\r')}>⏎</button>
    <button type="button" data-testid="dpad-right" onclick={() => onKey('\x1b[C')}>→</button>
    <button type="button" class="x" data-testid="dpad-esc" onclick={() => onKey('\x1b')}>ESC</button>
    <button type="button" data-testid="dpad-down" onclick={() => onKey('\x1b[B')}>↓</button>
    <span></span>
  </div>
{/if}

<style>
  .dpad {
    position: absolute;
    z-index: 38;
    display: grid;
    grid-template-columns: repeat(3, 52px);
    grid-template-rows: repeat(3, 52px);
    gap: 4px;
    /* Every corner clears the device safe area. Playwright's env() is always
       0 — the inset must be verified on a real device, not claimed from CI. */
  }
  .dpad[data-placement='bottom-left'] {
    left: max(12px, env(safe-area-inset-left, 0px));
    bottom: calc(14px + env(safe-area-inset-bottom, 0px));
  }
  .dpad[data-placement='bottom-right'] {
    right: max(12px, env(safe-area-inset-right, 0px));
    bottom: calc(14px + env(safe-area-inset-bottom, 0px));
  }
  .dpad[data-placement='top-left'] {
    left: max(12px, env(safe-area-inset-left, 0px));
    top: calc(14px + env(safe-area-inset-top, 0px));
  }
  .dpad[data-placement='top-right'] {
    right: max(12px, env(safe-area-inset-right, 0px));
    top: calc(14px + env(safe-area-inset-top, 0px));
  }
  .dpad button {
    background: var(--hud); border: 1px solid var(--hud-line); color: var(--hud-fg);
    font: 700 16px var(--font-mono); touch-action: manipulation;
  }
  .dpad button:active { background: var(--agent); color: var(--tstage); border-color: var(--agent); }
  .dpad .ent { color: var(--agent); border-color: var(--agent); font-size: 13px; }
  .dpad .x { color: #ff7a6e; border-color: #804040; font-size: 11px; }
</style>
