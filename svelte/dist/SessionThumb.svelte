<script lang="ts">
  /** SessionThumb — a live, read-only miniature of a tmux pane. Subscribes
   * through the shared ws-mux (captures are shared server-side with any full
   * viewer) and renders the pane tail with the same ANSI renderer as
   * TermView, just tiny. Never sends keys or resizes the pane. */
  import { onMount, onDestroy } from 'svelte';
  import { tmuxMux } from './ws-mux.svelte';
  import { createSgrState, lineToHtml, type AnsiPalette } from '@thumbmux/core';

  let {
    session,
    palette,
    maxLines = 30,
  }: {
    session: string;
    palette: AnsiPalette;
    maxLines?: number;
  } = $props();

  let html = $state('');
  let connected = $state(false);
  let unsubscribe: (() => void) | null = null;

  function render(content: string) {
    const lines = content.replace(/\r/g, '').split('\n');
    const tail = lines.slice(-maxLines);
    const st = createSgrState();
    html = tail.map((l) => `<div>${lineToHtml(l, st, palette) || '&nbsp;'}</div>`).join('');
  }

  onMount(() => {
    unsubscribe = tmuxMux.subscribe(session, (data, type) => {
      if (type === 'history' || type === 'error' || type === 'cursor') return;
      connected = true;
      render(data);
    }, { tail: maxLines + 10 }); // tail mode: a few KB per update, not the full window
  });

  onDestroy(() => {
    unsubscribe?.();
  });
</script>

<div class="thumb" style:--tfg={palette.defaultFg} style:--tbg={palette.defaultBg} data-testid="session-thumb" data-live={connected}>
  {#if connected}
    <div class="tail">{@html html}</div>
  {:else}
    <div class="wait">…</div>
  {/if}
</div>

<style>
  .thumb {
    position: absolute; inset: 0;
    overflow: hidden;
    background: var(--tbg);
    color: var(--tfg);
    font-family: var(--font-mono, ui-monospace, monospace);
    pointer-events: none;
  }
  .tail {
    position: absolute; left: 6px; right: 2px; bottom: 4px;
    font-size: 6.5px; line-height: 1.5;
    white-space: pre;
  }
  .wait {
    position: absolute; inset: 0;
    display: flex; align-items: center; justify-content: center;
    font-size: 14px; opacity: .4;
  }
</style>
