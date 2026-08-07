<script lang="ts">
  /** PromptsPanel — recent prompts extracted from the pane (core prompt-scan);
   * tap one to prefill the composer (host calls ComposerDock.openCompose()).
   * Lives inside TermHud's panel snippet next to NotePanel. */
  let {
    prompts = [],
    loading = false,
    onPick,
    collapsible = false,
    initiallyOpen = false,
    labels = { title: 'RECENT PROMPTS — tap to edit/resend', loading: 'scanning…', none: 'no prompts found yet' },
  }: {
    prompts?: string[];
    loading?: boolean;
    onPick: (prompt: string) => void;
    /** Render the title as a disclosure control. Default false keeps the
     *  always-open list, DOM and CSS identical to before this prop existed. */
    collapsible?: boolean;
    /** Start expanded. Ignored unless `collapsible`. */
    initiallyOpen?: boolean;
    labels?: { title: string; loading: string; none: string };
  } = $props();

  // Only meaningful when collapsible; a non-collapsible panel reads `open` as
  // permanently true below, so the initial value cannot affect it.
  let open = $state(initiallyOpen);
  let expanded = $derived(!collapsible || open);
</script>

<div class="promptsp" data-testid="prompts-panel">
  {#if collapsible}
    <button
      class="ptitle ptoggle"
      onclick={() => (open = !open)}
      aria-expanded={open}
      data-testid="prompts-toggle"
    >
      <span class="pcaret" aria-hidden="true">{open ? '▾' : '▸'}</span>
      <span>{labels.title}</span>
      {#if prompts.length > 0}<span class="pcount">({prompts.length})</span>{/if}
    </button>
  {:else}
    <div class="ptitle">{labels.title}</div>
  {/if}
  {#if expanded}
    {#if loading && prompts.length === 0}
      <div class="pnone">{labels.loading}</div>
    {:else if prompts.length === 0}
      <div class="pnone">{labels.none}</div>
    {:else}
      {#each prompts as p, i (i)}
        <button class="prompt" onclick={() => onPick(p)} data-testid="prompt-item">{p}</button>
      {/each}
    {/if}
  {/if}
</div>

<style>
  .promptsp { display: flex; flex-direction: column; gap: 6px; }
  .ptitle { font: 700 9.5px var(--font-thai, var(--font-mono)); color: var(--hud-fg); opacity: .6; letter-spacing: .04em; }
  .ptoggle {
    display: flex; align-items: baseline; gap: 5px;
    min-height: 32px; padding: 0;
    background: none; border: 0; text-align: left;
    touch-action: manipulation; cursor: pointer;
  }
  .pcaret { opacity: .9; }
  .pcount { opacity: .8; }
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
