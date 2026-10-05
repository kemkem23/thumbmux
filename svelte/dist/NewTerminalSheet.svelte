<script module lang="ts">
  export type SpawnAgent = { id: string; label: string; color: string };
</script>

<script lang="ts">
  /** NewTerminalSheet — the "+ terminal" agent picker. Pure presentation:
   * the host owns naming, the spawn call, and navigation. */
  let {
    open = false,
    dark = false,
    title,
    hint,
    agents,
    busy = false,
    busyLabel = '⏳ Opening session…',
    error = null,
    onPick,
    onClose,
    closeAria = 'Close',
  }: {
    open?: boolean;
    dark?: boolean;
    title: string;
    hint: string;
    agents: SpawnAgent[];
    busy?: boolean;
    busyLabel?: string;
    error?: string | null;
    onPick: (agentId: string) => void;
    onClose: () => void;
    closeAria?: string;
  } = $props();
</script>

{#if open}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="mh-sheet-backdrop" onclick={onClose}></div>
  <div class="mh-sheet" class:dark data-testid="mh-spawn-sheet">
    <div class="mh-sheet-head">
      <span class="mh-sheet-title" lang="th">{title}</span>
      <button class="mh-sheet-close" onclick={onClose} aria-label={closeAria}>✕</button>
    </div>
    <div class="mh-sheet-hint" lang="th">{hint}</div>
    <div class="mh-agent-row">
      {#each agents as ag (ag.id)}
        <button
          class="mh-agent-btn"
          style:border-color={ag.color}
          style:color={ag.color}
          disabled={busy}
          onclick={() => onPick(ag.id)}
        >
          <span class="mh-agent-dot" style:background={ag.color}></span>
          {ag.label}
        </button>
      {/each}
    </div>
    {#if busy}
      <div class="mh-sheet-status" lang="th">{busyLabel}</div>
    {/if}
    {#if error}
      <div class="mh-sheet-status mh-sheet-err" lang="th">{error}</div>
    {/if}
  </div>
{/if}

<style>
  .mh-sheet-backdrop {
    position: fixed; inset: 0; z-index: 60; background: rgba(0,0,0,.45);
  }
  .mh-sheet {
    /* Self-contained palette (light) — .dark flips it below. */
    --m-bg: #F5F0E8; --m-bg2: #FAF7F2; --m-ink: #1A1A1A; --m-ink2: #6B6560;
    --m-ink3: #6A645C; --m-acc-text: #C45200;
    position: fixed; left: 0; right: 0; bottom: 0; z-index: 61;
    background: var(--m-bg2); border-top: 1px solid var(--m-ink);
    color: var(--m-ink);
    padding: 12px 12px calc(16px + env(safe-area-inset-bottom));
    font-family: var(--font-mono);
  }
  .mh-sheet.dark {
    --m-bg: #141414; --m-bg2: #1E1E1E; --m-ink: #E8E4DC; --m-ink2: #9B9590;
    --m-ink3: #96928B; --m-acc-text: #FF7A1A;
  }
  .mh-sheet-head { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
  .mh-sheet-title { font: 700 13px var(--font-thai); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .mh-sheet-close { margin-left: auto; min-width: 38px; min-height: 36px; background: none; border: 1px solid var(--m-ink); color: var(--m-ink); font: 700 13px var(--font-mono); touch-action: manipulation; flex: 0 0 auto; }
  .mh-sheet-hint { font: 400 11.5px var(--font-thai); line-height: 1.6; color: var(--m-ink3); margin-bottom: 10px; }
  .mh-agent-row { display: flex; gap: 8px; }
  .mh-agent-btn {
    flex: 1; min-height: 52px;
    display: flex; align-items: center; justify-content: center; gap: 7px;
    background: var(--m-bg); border: 1px solid var(--m-ink);
    font: 700 12px var(--font-mono); letter-spacing: .04em;
    touch-action: manipulation;
  }
  .mh-agent-btn:disabled { opacity: .45; }
  .mh-agent-dot { width: 9px; height: 9px; border-radius: 50%; flex: 0 0 auto; }
  .mh-sheet-status { margin-top: 10px; font: 600 12px var(--font-thai); color: var(--m-ink2); }
  .mh-sheet-err { color: var(--m-acc-text); }
</style>
