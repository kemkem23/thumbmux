<script lang="ts">
  /** AttachmentDraftPicker — hold files *before* sending them (A20 + A22).
   *
   * This is the deliberate opposite of UploadAction, which posts the moment a
   * file is picked. Here nothing leaves the tab: picking, pasting and removing
   * only change a local list of `File` objects and preview URLs, and every
   * change is reported through `onChange(File[])`. The host decides when — and
   * whether — any of it becomes a request. UploadAction is untouched; a host
   * that wants send-immediately keeps using it exactly as before.
   *
   * Like UploadAction it renders no trigger button of its own: call `open()`
   * from whatever the host already has (composer icon, FAB slot, toolbar), and
   * feed pastes in through `acceptPaste(event)`.
   *
   * Preview URLs are owned here and revoked on remove, on clear, when a file
   * disappears from the `files` prop, and on unmount.
   */
  import { onDestroy } from 'svelte';
  import {
    acceptableDraftFiles,
    appendDraftFiles,
    attachmentLabel,
    createDraftItems,
    defaultObjectUrlPorts,
    draftFilesOf,
    imageFilesFromClipboard,
    releaseDraftItems,
    removeDraftItem,
    syncDraftItems,
    type AttachmentDraftItem,
  } from './attachment-draft';

  let {
    files = [],
    accept = undefined,
    multiple = true,
    disabled = false,
    onChange,
  }: {
    /** Files the draft starts with; pass a new array to re-seed (e.g. `[]` after send). */
    files?: File[];
    accept?: string;
    multiple?: boolean;
    disabled?: boolean;
    /** Every draft change, as plain `File[]` — no ids, URLs or host metadata. */
    onChange: (files: File[]) => void;
  } = $props();

  const ports = defaultObjectUrlPorts();

  // `tracked` is the non-reactive twin of `items`. The re-seed effect reads it
  // instead of `items` so the effect never depends on state it also writes.
  let tracked: AttachmentDraftItem[] = createDraftItems(files, ports);
  let items = $state<AttachmentDraftItem[]>(tracked);
  // Last `File[]` we either seeded from or handed to the host. A host that
  // echoes our array straight back must not cause a re-seed.
  let known: File[] = files;
  let inputEl = $state<HTMLInputElement | null>(null);

  $effect(() => {
    const incoming = files;
    if (incoming === known) return;
    known = incoming;
    apply(syncDraftItems(tracked, incoming, ports), false);
  });

  function apply(next: AttachmentDraftItem[], notify: boolean): void {
    tracked = next;
    items = next;
    if (!notify) return;
    const nextFiles = draftFilesOf(next);
    known = nextFiles;
    onChange(nextFiles);
  }

  /** Opens the OS picker (Photos / Camera / Files — browser behaviour, as is). */
  export function open(): void {
    if (disabled) return;
    inputEl?.click();
  }

  /** Programmatic path: drag-and-drop, share targets, clipboard reads. */
  export function addFiles(incoming: File[] | FileList): void {
    if (disabled) return;
    const allowed = acceptableDraftFiles(Array.from(incoming), { accept, multiple });
    if (allowed.length === 0) return;
    // Single-file mode replaces the draft instead of growing it.
    const base = multiple === false ? release(tracked) : tracked;
    apply(appendDraftFiles(base, allowed, ports), true);
  }

  /**
   * Handles a paste that carries images. Returns true when the draft took it,
   * so the host can `preventDefault()` only then and let plain text through.
   */
  export function acceptPaste(event: ClipboardEvent): boolean {
    if (disabled) return false;
    const clipboardItems = event.clipboardData?.items;
    if (!clipboardItems) return false;
    const images = imageFilesFromClipboard(Array.from(clipboardItems));
    if (images.length === 0) return false;
    addFiles(images);
    return true;
  }

  /** Drops the whole draft and gives every preview URL back. */
  export function clear(): void {
    if (tracked.length === 0) return;
    apply(release(tracked), true);
  }

  /** Current draft, for a host that would rather ask than mirror onChange. */
  export function currentFiles(): File[] {
    return draftFilesOf(tracked);
  }

  function release(current: AttachmentDraftItem[]): AttachmentDraftItem[] {
    releaseDraftItems(current, ports);
    return [];
  }

  function remove(id: string): void {
    apply(removeDraftItem(tracked, id, ports), true);
  }

  function onInputChange(): void {
    const picked = Array.from(inputEl?.files ?? []);
    if (inputEl) inputEl.value = '';
    if (picked.length === 0) return;
    addFiles(picked);
  }

  onDestroy(() => {
    releaseDraftItems(tracked, ports);
    tracked = [];
  });
</script>

<div class="attachment-draft" data-testid="attachment-draft">
  <input
    bind:this={inputEl}
    type="file"
    class="attachment-draft-input"
    {accept}
    {multiple}
    {disabled}
    onchange={onInputChange}
    data-testid="attachment-draft-input"
    aria-hidden="true"
    tabindex="-1"
  />

  {#if items.length > 0}
    <ul class="attachment-draft-list" data-testid="attachment-draft-list">
      {#each items as item (item.id)}
        <li class="attachment-draft-item" data-testid="attachment-draft-item">
          {#if item.isImage}
            <img
              class="attachment-draft-thumb"
              src={item.url}
              alt={item.name}
              data-testid="attachment-draft-thumb"
            />
          {:else}
            <span class="attachment-draft-thumb attachment-draft-badge" data-testid="attachment-draft-badge">
              {attachmentLabel(item.name)}
            </span>
          {/if}
          <span class="attachment-draft-name" data-testid="attachment-draft-name">{item.name}</span>
          <button
            type="button"
            class="attachment-draft-remove"
            {disabled}
            onclick={() => remove(item.id)}
            aria-label={`Remove ${item.name}`}
            data-testid="attachment-draft-remove"
          >
            &times;
          </button>
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .attachment-draft-input {
    position: absolute;
    width: 1px;
    height: 1px;
    margin: -1px;
    padding: 0;
    border: 0;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }

  .attachment-draft-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .attachment-draft-item {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 8px;
    border: 1px solid var(--border, #1a1a1a);
    background: var(--bg-elevated, #faf7f2);
  }

  .attachment-draft-thumb {
    width: 44px;
    height: 44px;
    flex-shrink: 0;
    object-fit: cover;
    border: 1px solid var(--border, #1a1a1a);
    background: var(--bg-surface, #fff);
  }

  .attachment-draft-badge {
    display: flex;
    align-items: center;
    justify-content: center;
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.75rem;
    font-weight: 700;
    letter-spacing: 0.04em;
    color: var(--text, #1a1a1a);
  }

  .attachment-draft-name {
    flex: 1;
    min-width: 0;
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.875rem;
    line-height: 1.4;
    word-break: break-word;
    color: var(--text, #1a1a1a);
  }

  .attachment-draft-remove {
    flex-shrink: 0;
    min-width: 44px;
    min-height: 44px;
    border: 1px solid var(--border, #1a1a1a);
    background: transparent;
    color: var(--text, #1a1a1a);
    font-size: 1.25rem;
    line-height: 1;
    cursor: pointer;
    touch-action: manipulation;
  }

  .attachment-draft-remove:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
</style>
