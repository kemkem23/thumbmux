<script lang="ts">
  /** Test host — replaces SessionGrid snapshots without remounting the grid. */
  import SessionGrid from '../src/SessionGrid.svelte';
  import type { AnsiPalette } from '@thumbmux/core';
  import type { GridSession } from '../src/session-grid';

  let {
    palette,
    initialSessions,
  }: {
    palette: AnsiPalette;
    initialSessions: GridSession[];
  } = $props();

  let sessions = $state(initialSessions);

  export function replaceSessions(next: GridSession[]) {
    sessions = next;
  }
</script>

<SessionGrid {sessions} {palette} onOpen={() => {}} onNew={() => {}} />
