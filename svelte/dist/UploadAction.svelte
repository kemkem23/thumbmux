<script lang="ts">
  /** UploadAction — the turnkey attach-files piece. Renders only a hidden
   * file input; call open() from any button (ActionFab slot, toolbar…), and
   * it uploads the picked files to `endpoint`, then hands you the stored
   * paths — ready for formatUploadMessage → composer prefill. */
  import { formatUploadMessage, type UploadedFile } from '@thumbmux/core';

  let {
    endpoint = '/api/upload',
    dir = 'uploads',
    accept = undefined,
    busy = $bindable(false),
    onUploaded,
    onError,
  }: {
    endpoint?: string;
    /** fallback prefix for prefill paths when the upload response omits `dir` */
    dir?: string;
    accept?: string;
    busy?: boolean;
    /** message uses the response `dir`, falling back to the `dir` prop */
    onUploaded: (message: string, files: UploadedFile[]) => void;
    onError: (message: string) => void;
  } = $props();

  let inputEl = $state<HTMLInputElement | null>(null);
  // Count overlapping picker/programmatic uploads instead of dropping later
  // calls: uploadFiles has no feedback channel for a rejected call, so a guard
  // could make an attach/paste action silently disappear.
  let uploadsInFlight = 0;

  export function open() {
    inputEl?.click();
  }

  /** Programmatic path — clipboard-pasted images, drag-and-drop, share
   * targets: same upload + prefill flow as the picker. */
  export async function uploadFiles(files: File[] | FileList) {
    await doUpload(Array.from(files));
  }

  async function onChange() {
    const files = Array.from(inputEl?.files ?? []);
    if (inputEl) inputEl.value = '';
    await doUpload(files);
  }

  async function doUpload(files: File[]) {
    if (files.length === 0) return;
    uploadsInFlight += 1;
    busy = true;
    try {
      const form = new FormData();
      for (const f of files) form.append('files', f);
      const res = await fetch(endpoint, { method: 'POST', body: form });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
      const responseFiles = data?.files;
      const hasUsableFiles =
        Array.isArray(responseFiles) &&
        responseFiles.length > 0 &&
        responseFiles.every(
          (file) =>
            typeof file === 'object' &&
            file !== null &&
            typeof file.stored === 'string' &&
            file.stored.length > 0,
        );
      if (!hasUsableFiles) {
        throw new Error(
          'Invalid upload response: expected a non-empty files array with stored paths',
        );
      }
      const stored = responseFiles as UploadedFile[];
      const messageDir = data?.dir ?? dir;
      onUploaded(formatUploadMessage(stored, messageDir), stored);
    } catch (e: any) {
      onError(String(e?.message ?? e));
    } finally {
      uploadsInFlight -= 1;
      busy = uploadsInFlight > 0;
    }
  }
</script>

<input bind:this={inputEl} type="file" multiple {accept} hidden onchange={onChange} data-testid="upload-input" />
