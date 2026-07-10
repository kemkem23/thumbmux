<script lang="ts">
  /** PromptsPanel — recent prompts extracted from the pane (core prompt-scan);
   * tap one to prefill the composer (host calls ComposerDock.openCompose()).
   * Lives inside TermHud's panel snippet next to NotePanel. */
  let {
    prompts = [],
    loading = false,
    onPick,
    labels = { title: 'RECENT PROMPTS — tap to edit/resend', loading: 'scanning…', none: 'no prompts found yet' },
  }: {
    prompts?: string[];
    loading?: boolean;
    onPick: (prompt: string) => void;
    labels?: { title: string; loading: string; none: string };
  } = $props();
</script>

<div class="promptsp" data-testid="prompts-panel">
  <div class="ptitle">{labels.title}</div>
  {#if loading && prompts.length === 0}
    <div class="pnone">{labels.loading}</div>
  {:else if prompts.length === 0}
    <div class="pnone">{labels.none}</div>
  {:else}
    {#each prompts as p, i (i)}
      <button class="prompt" onclick={() => onPick(p)} data-testid="prompt-item">{p}</button>
    {/each}
  {/if}
</div>

<style>
  .promptsp { display: flex; flex-direction: column; gap: 6px; }
  .ptitle { font: 700 9.5px var(--font-thai, var(--font-mono)); color: var(--hud-fg); opacity: .6; letter-spacing: .04em; }
  .pnone { font: 600 11px var(--font-thai, var(--font-mono)); color: var(--hud-fg); opacity: .5; }
  .prompt {
    min-height: 44px; padding: 8px 10px; text-align: left;
    background: var(--tbg); color: var(--tfg);
    border: 1px solid var(--hud-line);
    font: 600 12px var(--font-thai, var(--font-mono)); line-height: 1.45;
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
    overflow: hidden; touch-action: manipulation; cursor: pointer;
  }
</style>
