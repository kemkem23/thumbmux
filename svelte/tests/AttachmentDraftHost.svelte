<script lang="ts">
  /** Test host — lets a test move the `files` prop *after* mount, the way a real
   * host does (seed a draft, echo `onChange` back, empty it after a send).
   *
   * `$state.raw` on purpose: a deep `$state` would hand the picker a proxy of the
   * array, and the picker's whole re-seed contract is built on identity
   * (`incoming === known`, `item.file === file`). Proxying would silently change
   * the thing under test.
   */
  import AttachmentDraftPicker from '../src/AttachmentDraftPicker.svelte';

  type Picker = {
    open(): void;
    addFiles(files: File[] | FileList): void;
    acceptPaste(event: ClipboardEvent): boolean;
    clear(): void;
    currentFiles(): File[];
  };

  let {
    initialFiles = [],
    accept = undefined,
    multiple = true,
    disabled = false,
    onChange,
  }: {
    initialFiles?: File[];
    accept?: string;
    multiple?: boolean;
    disabled?: boolean;
    onChange: (files: File[]) => void;
  } = $props();

  // Seeded once on purpose — after mount the test drives it through setFiles().
  // svelte-ignore state_referenced_locally
  let files = $state.raw<File[]>(initialFiles);
  let picker = $state<Picker | null>(null);

  /** What the host does: hand the picker a different `File[]`. */
  export function setFiles(next: File[]): void {
    files = next;
  }

  /** The array identity the picker is currently being given. */
  export function currentProp(): File[] {
    return files;
  }

  export function inner(): Picker {
    if (!picker) throw new Error('picker not bound');
    return picker;
  }
</script>

<AttachmentDraftPicker bind:this={picker} {files} {accept} {multiple} {disabled} {onChange} />
