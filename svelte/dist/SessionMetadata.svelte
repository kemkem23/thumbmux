<script lang="ts">
  /** SessionMetadata (A24) — the two read-only facts a session detail surface
   * shows above the terminal: its working directory and when it last moved.
   *
   * Presentation only. Every value arrives as an opaque string: the package
   * never learns what a topic, a team or an agent is, never reads a store and
   * never touches host storage keys (the host's `kx-*` namespace stays in the
   * host). The host resolves `cwd` / `activityLabel` from whatever source it
   * likes and formats the label in whatever language it likes.
   *
   * Names the host's tests and global CSS hook onto are props, not constants,
   * so a host can keep the selectors it already ships instead of rewriting
   * them to match this package. */

  let {
    cwd = undefined,
    activityLabel = undefined,
    activityDatetime = undefined,
    cwdLabel = 'CWD',
    activityLabelText = undefined,
    testid = 'session-metadata',
    cwdTestid = 'session-cwd-panel',
    activityTestid = 'session-activity',
    extraClass = undefined,
  }: {
    /** absolute path shown verbatim; blank or whitespace-only hides the row */
    cwd?: string;
    /** already-formatted "last moved" text, e.g. "3 นาทีที่แล้ว" */
    activityLabel?: string;
    /** machine-readable timestamp for <time datetime>; omit for a plain span */
    activityDatetime?: string;
    /** caption in front of the path — host's wording, host's language */
    cwdLabel?: string;
    /** optional caption in front of the activity text; omitted by default so
     * the row reads as bare relative time the way the grid already shows it */
    activityLabelText?: string;
    /** selectors the host depends on — override to keep existing host hooks */
    testid?: string;
    cwdTestid?: string;
    activityTestid?: string;
    /** extra class on the wrapper for host layout (global CSS only — Svelte
     * scoping means a host's scoped rules never reach this subtree) */
    extraClass?: string;
  } = $props();

  function present(value: string | undefined): string | undefined {
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    return trimmed.length > 0 ? value : undefined;
  }

  let shownCwd = $derived(present(cwd));
  let shownActivity = $derived(present(activityLabel));
  // Nothing to say = render nothing, so a host snippet does not get an empty
  // bordered shell where a session simply has no cwd yet.
  let rendered = $derived(shownCwd !== undefined || shownActivity !== undefined);
</script>

{#if rendered}
  <div class="session-meta {extraClass ?? ''}" data-testid={testid}>
    {#if shownCwd !== undefined}
      <div class="meta-row cwd" data-testid={cwdTestid}>
        <span class="meta-label">{cwdLabel}</span>
        <code title={shownCwd}>{shownCwd}</code>
      </div>
    {/if}
    {#if shownActivity !== undefined}
      <div class="meta-row activity" data-testid={activityTestid}>
        {#if activityLabelText}<span class="meta-label">{activityLabelText}</span>{/if}
        {#if activityDatetime}
          <time datetime={activityDatetime}>{shownActivity}</time>
        {:else}
          <span class="meta-value">{shownActivity}</span>
        {/if}
      </div>
    {/if}
  </div>
{/if}

<style>
  .session-meta {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .meta-row {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    align-items: baseline;
    gap: 8px;
    padding: 6px 8px;
    border-top: 1px solid var(--hud-line);
    color: var(--hud-fg);
  }
  .meta-row.activity {
    grid-template-columns: minmax(0, 1fr);
  }
  .meta-row.activity:has(.meta-label) {
    grid-template-columns: auto minmax(0, 1fr);
  }
  .meta-label {
    color: var(--agent);
    font: 800 9px var(--font-mono);
    letter-spacing: 0.08em;
  }
  /* The path is never shortened in the DOM — copy and the title tooltip keep
   * the whole string; only the pixels are clipped. */
  .meta-row code,
  .meta-row time,
  .meta-value {
    min-width: 0;
    overflow: hidden;
    color: inherit;
    font: 500 10px var(--font-mono);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
