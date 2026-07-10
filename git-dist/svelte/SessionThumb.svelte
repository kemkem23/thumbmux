<script lang="ts">
  /** SessionThumb — a live, read-only miniature of a tmux pane. Subscribes
   * through the shared ws-mux (captures are shared server-side with any full
   * viewer) and renders the pane tail with the same ANSI renderer as
   * TermView, just tiny. Never sends keys or resizes the pane. */
  import { onMount, onDestroy } from 'svelte';
  import { tmuxMux } from './ws-mux.svelte';
  import { deriveThumbnailPalette } from './session-grid';
  import { createSgrState, lineToHtml, type AnsiPalette } from '../core/index.js';

  let {
    session,
    palette,
    maxLines = 30,
  }: {
    session: string;
    palette: AnsiPalette;
    maxLines?: number;
  } = $props();

  let content = $state('');
  let connected = $state(false);
  let unsubscribe: (() => void) | null = null;
  let thumbPalette = $derived(deriveThumbnailPalette(palette));
  let html = $derived(renderContent(content, maxLines, thumbPalette));

  function renderContent(raw: string, linesToKeep: number, renderPalette: AnsiPalette) {
    const lines = raw.replace(/\r/g, '').split('\n');
    const tail = lines.slice(-linesToKeep);
    const st = createSgrState();
    return tail.map((line) => `<div>${lineToHtml(line, st, renderPalette) || '&nbsp;'}</div>`).join('');
  }

  onMount(() => {
    unsubscribe = tmuxMux.subscribe(session, (data, type) => {
      if (type === 'history' || type === 'error' || type === 'cursor') return;
      connected = true;
      content = data;
    }, { tail: maxLines + 10 }); // tail mode: a few KB per update, not the full window
  });

  onDestroy(() => {
    unsubscribe?.();
  });
</script>

<div
  class="thumb"
  style:--tfg={thumbPalette.defaultFg}
  style:--tbg={thumbPalette.defaultBg}
  data-testid="session-thumb"
  data-live={connected}
>
  {#if connected}
    <div class="tail">{@html html}</div>
  {:else}
    <div class="wait">…</div>
  {/if}
</div>

<style>
  .thumb {
    position: absolute;
    inset: 0;
    overflow: hidden;
    container-type: inline-size;
    background: var(--tbg);
    color: var(--tfg);
    font-family: var(--font-mono, ui-monospace, monospace);
    pointer-events: none;
  }
  .tail {
    position: absolute;
    left: 6px;
    right: 0;
    bottom: 4px;
    overflow: hidden;
    font-size: 7px;
    font-size: clamp(7px, 4.2cqw, 13px);
    line-height: 1.38;
    white-space: pre;
    -webkit-mask-image: linear-gradient(90deg, #000 calc(100% - clamp(18px, 12cqw, 42px)), transparent);
    mask-image: linear-gradient(90deg, #000 calc(100% - clamp(18px, 12cqw, 42px)), transparent);
  }
  .tail :global(div) {
    width: max-content;
    min-width: max-content;
    max-width: none;
    white-space: pre;
  }
  .wait {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: clamp(14px, 9cqw, 24px);
    opacity: .4;
  }
</style>
