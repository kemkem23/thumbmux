<script lang="ts">
  /** Test host — exposes setSession/setMaxLines so tests can drive SessionThumb props. */
  import SessionThumb from '../src/SessionThumb.svelte';
  import type { AnsiPalette } from '@thumbmux/core';

  let {
    palette,
    initialSession = 'alpha',
    initialMaxLines = 10,
  }: {
    palette: AnsiPalette;
    initialSession?: string;
    initialMaxLines?: number;
  } = $props();

  let session = $state(initialSession);
  let maxLines = $state(initialMaxLines);

  export function setSession(next: string) {
    session = next;
  }
  export function setMaxLines(next: number) {
    maxLines = next;
  }
</script>

<SessionThumb {session} {palette} {maxLines} />
