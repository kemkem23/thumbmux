<script lang="ts">
  /** NotePanel — a session note editor made to live inside TermHud's panel
   * snippet: view/edit the note plus host-supplied actions ("distill with
   * the LLM", "refresh", …). Pure UI: the host owns storage and pipelines. */
  let {
    note = '',
    placeholder = 'no note yet',
    editable = true,
    saving = false,
    onSave,
    actions = [],
    labels = { edit: '✎ edit', save: 'save', cancel: 'cancel' },
  }: {
    note?: string;
    placeholder?: string;
    editable?: boolean;
    saving?: boolean;
    onSave?: (text: string) => void;
    /** host actions rendered as buttons, e.g. { label: '✨ distill', onTap, busy } */
    actions?: { label: string; onTap: () => void; busy?: boolean }[];
    labels?: { edit: string; save: string; cancel: string };
  } = $props();

  let editing = $state(false);
  let draft = $state('');

  function startEdit() { draft = note; editing = true; }
  function save() { onSave?.(draft.trim()); editing = false; }
</script>

<div class="notep" data-testid="note-panel">
  {#if editing}
    <textarea class="draft" bind:value={draft} rows="3" data-testid="note-draft"></textarea>
    <div class="ops">
      <button class="op go" onclick={save} disabled={saving} data-testid="note-save">{saving ? '…' : labels.save}</button>
      <button class="op" onclick={() => (editing = false)}>{labels.cancel}</button>
    </div>
  {:else}
    <div class="text" class:empty={!note} data-testid="note-text">{note || placeholder}</div>
    <div class="ops">
      {#if editable}
        <button class="op" onclick={startEdit} data-testid="note-edit">{labels.edit}</button>
      {/if}
      {#each actions as a (a.label)}
        <button class="op" onclick={a.onTap} disabled={a.busy}>{a.busy ? '…' : a.label}</button>
      {/each}
    </div>
  {/if}
</div>

<style>
  .notep { display: flex; flex-direction: column; gap: 8px; }
  .text {
    font: 600 12.5px var(--font-thai, var(--font-mono)); color: var(--hud-fg);
    white-space: pre-wrap; word-break: break-word; line-height: 1.5;
  }
  .text.empty { opacity: .5; }
  .draft {
    min-height: 72px; padding: 8px 10px; resize: vertical;
    background: var(--tbg); color: var(--tfg);
    border: 1px solid var(--hud-line);
    font: 600 16px var(--font-thai, var(--font-mono)); line-height: 1.5; /* <16px makes iOS zoom on focus */
  }
  .ops { display: flex; gap: 8px; flex-wrap: wrap; }
  .op {
    min-height: 44px; padding: 0 14px;
    background: none; border: 1px solid var(--hud-line); color: var(--hud-fg);
    font: 700 11px var(--font-thai, var(--font-mono)); touch-action: manipulation;
  }
  .op.go { border-color: var(--agent); color: var(--agent); }
  .op:disabled { opacity: .5; }
</style>
