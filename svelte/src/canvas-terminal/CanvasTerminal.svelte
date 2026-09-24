<script lang="ts">
  import { onMount } from 'svelte';
  import type { AnsiPalette, LineLinkRange } from '@thumbmux/core';
  import { createCanvasModelRows } from './model';
  import { paintCanvasRows } from './paint';
  import { canvasLinkHits, osc8LinkHits } from './links';

  let {
    lines,
    linksByRow = [],
    firstLineId = 0,
    cols,
    cellWidth,
    lineHeight,
    fontSize,
    fontFamily = 'var(--font-mono, ui-monospace, monospace)',
    strokeWidth = 1,
    vectorFont = false,
    palette,
  }: {
    lines: readonly string[];
    linksByRow?: readonly (readonly LineLinkRange[] | undefined)[];
    firstLineId?: number;
    cols: number;
    cellWidth: number;
    lineHeight: number;
    fontSize: number;
    fontFamily?: string;
    strokeWidth?: number;
    vectorFont?: boolean;
    palette: AnsiPalette;
  } = $props();

  let host = $state<HTMLDivElement | null>(null);
  let canvas = $state<HTMLCanvasElement | null>(null);
  let width = $state(0);
  let resizeObserver: ResizeObserver | null = null;
  const rows = $derived(createCanvasModelRows(lines, firstLineId));
  const urlHits = $derived(canvasLinkHits(lines, cols));
  const oscHits = $derived(osc8LinkHits(linksByRow));
  const hits = $derived([...oscHits, ...urlHits]);

  function repaint(): void {
    if (!canvas || width <= 0 || cellWidth <= 0 || lineHeight <= 0) return;
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const height = Math.max(1, lines.length * lineHeight);
    canvas.width = Math.ceil(width * dpr);
    canvas.height = Math.ceil(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    const context = canvas.getContext('2d');
    if (!context) return;
    paintCanvasRows(context, rows, {
      fontFamily,
      fontSize,
      lineHeight,
      cellWidth,
      strokeWidth,
      vectorFont,
      dpr,
      palette,
    });
  }

  onMount(() => {
    resizeObserver = new ResizeObserver(() => {
      width = host?.clientWidth ?? 0;
      repaint();
    });
    if (host) {
      width = host.clientWidth;
      resizeObserver.observe(host);
    }
    repaint();
    return () => resizeObserver?.disconnect();
  });

  $effect(() => {
    rows;
    palette;
    fontFamily;
    fontSize;
    lineHeight;
    cellWidth;
    strokeWidth;
    vectorFont;
    repaint();
  });
</script>

<div
  bind:this={host}
  class="canvas-terminal"
  data-testid="canvas-terminal"
  data-first-line-id={firstLineId}
  data-row-count={rows.length}
  data-font-mode={vectorFont ? 'single-line' : 'outline'}
  data-stroke-width={strokeWidth}
  style:height={`${lines.length * lineHeight}px`}
>
  <canvas bind:this={canvas} aria-hidden="true"></canvas>
  <div class="text-mirror" aria-label="Terminal viewport text">
    {#each rows as row (row.id)}
      <div class="mirror-row" data-line-id={row.id} style:height={`${lineHeight}px`}>{row.text || '\u00a0'}</div>
    {/each}
  </div>
  <div class="link-layer" aria-label="Terminal links">
    {#each hits as hit, index (`${hit.row}:${hit.startCol}:${hit.href}:${index}`)}
      <a
        href={hit.href}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={hit.href}
        title={hit.href}
        style:left={`${hit.startCol * cellWidth}px`}
        style:top={`${hit.row * lineHeight}px`}
        style:width={`${Math.max(1, hit.endCol - hit.startCol) * cellWidth}px`}
        style:height={`${lineHeight}px`}
      ></a>
    {/each}
  </div>
</div>

<style>
  .canvas-terminal { position: relative; width: 100%; }
  canvas { position: absolute; inset: 0; display: block; pointer-events: none; }
  .text-mirror { position: absolute; inset: 0; color: transparent; background: transparent; white-space: pre; user-select: text; -webkit-user-select: text; }
  .mirror-row { white-space: pre; overflow: hidden; }
  .link-layer { position: absolute; inset: 0; pointer-events: none; }
  .link-layer a { position: absolute; pointer-events: auto; color: transparent; text-decoration: none; }
  .link-layer a:focus { outline: 2px solid currentColor; outline-offset: -2px; color: var(--tfg); }
</style>
