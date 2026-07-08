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
    /** display prefix used in the prefill message */
    dir?: string;
    accept?: string;
    busy?: boolean;
    /** message = formatUploadMessage(files, dir) — prefill your composer */
    onUploaded: (message: string, files: UploadedFile[]) => void;
    onError: (message: string) => void;
  } = $props();

  let inputEl = $state<HTMLInputElement | null>(null);

  export function open() {
    inputEl?.click();
  }

  async function onChange() {
    const files = Array.from(inputEl?.files ?? []);
    if (inputEl) inputEl.value = '';
    if (files.length === 0) return;
    busy = true;
    try {
      const form = new FormData();
      for (const f of files) form.append('files', f);
      const res = await fetch(endpoint, { method: 'POST', body: form });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
      const stored: UploadedFile[] = data?.files ?? [];
      onUploaded(formatUploadMessage(stored, dir), stored);
    } catch (e: any) {
      onError(String(e?.message ?? e));
    } finally {
      busy = false;
    }
  }
</script>

<input bind:this={inputEl} type="file" multiple {accept} hidden onchange={onChange} data-testid="upload-input" />
