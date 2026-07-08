<script lang="ts">
  /** ShortcutBar — one-tap prompt chips ("continue", "ไปต่อ", …) pinned above
   * the composer dock. Config-driven: the host feeds shortcuts (usually from
   * prefs) and decides what "send" means (smartSubmit per agent). */
  import type { Shortcut } from '@thumbmux/core';

  let {
    shortcuts = [],
    visible = true,
    agent = undefined,
    onSend,
    onManage,
    manageLabel = '⚙',
  }: {
    shortcuts?: Shortcut[];
    visible?: boolean;
    /** current session's agent kind — chips whose s.agent mismatches are
     * hidden (absent prop or absent s.agent = show everywhere) */
    agent?: string;
    onSend: (s: Shortcut) => void;
    /** optional gear chip that opens the host's ShortcutsSheet */
    onManage?: () => void;
    manageLabel?: string;
  } = $props();

  let shown = $derived(shortcuts.filter((s) => !s.agent || !agent || s.agent === agent));
</script>

{#if visible && (shown.length > 0 || onManage)}
  <div class="scbar" data-testid="shortcut-bar">
    {#each shown as s (s.id)}
      <button class="chip" onclick={() => onSend(s)} data-testid="shortcut-chip">{s.label}</button>
    {/each}
    {#if onManage}
      <button class="chip manage" aria-label="manage shortcuts" onclick={onManage} data-testid="shortcut-manage">{manageLabel}</button>
    {/if}
  </div>
{/if}

<style>
  .scbar {
    position: absolute; left: 0; right: 0;
    bottom: calc(var(--dock-full, 0px) + env(safe-area-inset-bottom) + 8px);
    display: flex; gap: 8px; padding: 0 76px 0 10px; /* right gap clears the FAB */
    overflow-x: auto; scrollbar-width: none;
    z-index: 30; pointer-events: none;
  }
  .scbar::-webkit-scrollbar { display: none; }
  .chip {
    pointer-events: auto; flex: 0 0 auto;
    min-height: 44px; padding: 0 16px;
    background: var(--hud); color: var(--hud-fg);
    border: 1px solid var(--agent);
    font: 700 12px var(--font-thai, var(--font-mono));
    touch-action: manipulation;
  }
  .chip.manage { border-color: var(--hud-line); opacity: .85; min-width: 44px; }
</style>
