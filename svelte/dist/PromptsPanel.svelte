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
    labels = {
      title: 'RECENT PROMPTS — tap to edit/resend',
      loading: 'scanning…',
      none: 'no prompts found yet',
    },
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
  let rowOpen = $state<Record<number, boolean>>({});
  let overflow = $state<Record<number, boolean>>({});
  const PREVIEW_LINES = 8;
  // Do not grow the public labels type. A Thai title (the host already
  // localizes that string) selects Thai disclosure copy.
  let showAllLabel = $derived(/\p{Script=Thai}/u.test(labels.title) ? 'แสดงทั้งหมด' : 'Show all');
  let showLessLabel = $derived(/\p{Script=Thai}/u.test(labels.title) ? 'ย่อ' : 'Show less');
  let overflowReady = $state(false);

  function hasThai(text: string): boolean {
    return /\p{Script=Thai}/u.test(text);
  }

  function measureRows(root: HTMLElement | null): void {
    if (!root) return;
    const next: Record<number, boolean> = {};
    const rows = root.querySelectorAll<HTMLElement>('[data-testid="prompt-item"]');
    rows.forEach((row, index) => {
      if (rowOpen[index]) {
        next[index] = overflow[index] ?? false;
        return;
      }
      const style = row.ownerDocument?.defaultView?.getComputedStyle(row);
      const lineHeight = Number.parseFloat(style?.lineHeight ?? '') || 20;
      const pad = Number.parseFloat(style?.paddingTop ?? '') + Number.parseFloat(style?.paddingBottom ?? '');
      const limit = lineHeight * PREVIEW_LINES + (Number.isFinite(pad) ? pad : 0) + 1;
      // happy-dom / SSR report 0 — treat as "unknown" and do not hide text.
      if (row.clientHeight <= 0 || row.scrollHeight <= 0) {
        next[index] = false;
        return;
      }
      next[index] = row.scrollHeight > limit;
    });
    const keys = Object.keys(next);
    if (
      keys.length !== Object.keys(overflow).length
      || keys.some((key) => overflow[Number(key)] !== next[Number(key)])
    ) {
      overflow = next;
    }
    overflowReady = true;
  }

  let rootEl: HTMLElement | undefined = $state();
  $effect(() => {
    const root = rootEl;
    void prompts;
    void expanded;
    void rowOpen;
    if (!root) return;
    measureRows(root);
    // Observe each row, not just the root box. A row can grow in
    // scrollHeight (font load, wrap, late text) without changing the
    // panel's border box — root-only ResizeObserver misses that.
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => measureRows(root));
    ro?.observe(root);
    const observeRows = () => {
      for (const row of root.querySelectorAll<HTMLElement>('[data-testid="prompt-item"]')) {
        ro?.observe(row);
      }
    };
    observeRows();
    const mo = typeof MutationObserver === 'undefined'
      ? null
      : new MutationObserver(() => {
        observeRows();
        measureRows(root);
      });
    mo?.observe(root, { childList: true, subtree: true, characterData: true });
    return () => {
      ro?.disconnect();
      mo?.disconnect();
    };
  });
</script>

<div
    class="promptsp"
    data-testid="prompts-panel"
    data-overflow-ready={overflowReady ? 'true' : 'false'}
    bind:this={rootEl}
  >
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
        {@const long = !!overflow[i]}
        {@const openRow = !!rowOpen[i]}
        <div class="prompt-row" data-testid="prompt-row">
          <button
            class="prompt"
            class:clamped={long && !openRow}
            onclick={() => onPick(p)}
            data-testid="prompt-item"
            lang={hasThai(p) ? 'th' : undefined}
          >{p}</button>
          {#if long}
            <button
              type="button"
              class="prompt-disclose"
              aria-expanded={openRow}
              data-testid="prompt-disclose"
              onclick={() => { rowOpen = { ...rowOpen, [i]: !openRow }; }}
            >{openRow ? showLessLabel : showAllLabel}</button>
          {/if}
        </div>
      {/each}
    {/if}
  {/if}
</div>

<style>
  .promptsp { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
  .ptitle { font: 700 9.5px var(--font-thai, var(--font-mono)); color: var(--hud-fg); opacity: .6; letter-spacing: .04em; }
  .ptoggle {
    display: flex; align-items: center; gap: 5px;
    min-height: 44px; min-width: 44px; padding: 0;
    background: none; border: 0; text-align: left;
    touch-action: manipulation; cursor: pointer;
  }
  .ptoggle:focus-visible { outline: 2px solid var(--agent, var(--border-focus, #ff6b00)); outline-offset: 2px; }
  .pcaret { opacity: .9; }
  .pcount { opacity: .8; }
  .pnone { font: 600 11px var(--font-thai, var(--font-mono)); color: var(--hud-fg); opacity: .5; }
  .prompt-row { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
  .prompt {
    min-height: 44px; padding: 8px 10px; text-align: left; width: 100%; min-width: 0;
    background: var(--tbg); color: var(--tfg);
    border: 1px solid var(--hud-line);
    font: 600 12px var(--font-thai, var(--font-mono)); line-height: 1.7; letter-spacing: 0;
    white-space: pre-wrap; overflow-wrap: anywhere; word-break: normal;
    overflow: visible; touch-action: manipulation; cursor: pointer;
  }
  .prompt:lang(th) { word-break: keep-all; }
  .prompt:focus-visible { outline: 2px solid var(--agent, var(--border-focus, #ff6b00)); outline-offset: 2px; }
  .prompt.clamped {
    display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 8; line-clamp: 8;
    overflow: hidden;
  }
  .prompt-disclose {
    align-self: flex-start;
    min-height: 44px; min-width: 44px; padding: 0 12px;
    background: none; border: 1px solid var(--hud-line); color: var(--hud-fg);
    font: 700 11px var(--font-thai, var(--font-mono)); letter-spacing: 0;
    touch-action: manipulation; cursor: pointer;
  }
  .prompt-disclose:focus-visible { outline: 2px solid var(--agent, var(--border-focus, #ff6b00)); outline-offset: 2px; }
</style>
