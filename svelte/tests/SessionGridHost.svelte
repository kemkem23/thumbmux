<script lang="ts">
  /** Test host — replaces SessionGrid snapshots without remounting the grid. */
  import SessionGrid from '../src/SessionGrid.svelte';
  import type { AnsiPalette } from '@thumbmux/core';
  import type { GridSession } from '../src/session-grid';

  let {
    palette,
    initialSessions,
    onOpen = () => {},
    onNew = () => {},
    onKill,
    cardLayout = 'default',
    showNew = true,
  }: {
    palette: AnsiPalette;
    initialSessions: GridSession[];
    onOpen?: (name: string) => void;
    onNew?: () => void;
    onKill?: (name: string) => void;
    cardLayout?: 'default' | 'dense';
    showNew?: boolean;
  } = $props();

  let sessions = $state(initialSessions);

  export function replaceSessions(next: GridSession[]) {
    sessions = next;
  }
</script>

<SessionGrid {sessions} {palette} {onOpen} {onNew} {onKill} {cardLayout} {showNew} />
