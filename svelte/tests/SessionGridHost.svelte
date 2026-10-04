<script lang="ts">
  /** Test host — replaces SessionGrid snapshots without remounting the grid. */
  import SessionGrid from '../src/SessionGrid.svelte';
  import type { AnsiPalette } from '@thumbmux/core';
  import type { GridFilterOption, GridSession } from '../src/session-grid';

  let {
    palette,
    initialSessions,
    onOpen = () => {},
    onNew = () => {},
    onKill,
    cardLayout = 'default',
    showNew = true,
    controls = false,
  }: {
    palette: AnsiPalette;
    initialSessions: GridSession[];
    onOpen?: (name: string) => void;
    onNew?: () => void;
    onKill?: (name: string) => void;
    cardLayout?: 'default' | 'dense';
    showNew?: boolean;
    /** Render the search / filter / group row (as /m/hub does). */
    controls?: boolean;
  } = $props();

  const filterOptions: GridFilterOption[] = [
    { value: 'cc', label: 'CC' },
    { value: 'codex', label: 'CDX' },
  ];

  let sessions = $state(initialSessions);

  export function replaceSessions(next: GridSession[]) {
    sessions = next;
  }
</script>

<SessionGrid
  {sessions} {palette} {onOpen} {onNew} {onKill} {cardLayout} {showNew}
  searchable={controls}
  groupable={controls}
  filterOptions={controls ? filterOptions : []}
/>
