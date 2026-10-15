<script lang="ts">
  import { onMount } from 'svelte';
  import type { AnsiPalette } from '@thumbmux/core';
  import { createCanvasModelRows } from './model';
  import { paintCanvasRows, effectiveStrokeWidth } from './paint';
  import { canvasHtmlLinkHits } from './links';
  import { glyphCoverage } from './glyphs';

  let {
    lines,
    htmlRows = [],
    geometry = [],
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
    htmlRows?: readonly string[];
    geometry?: readonly { top: number; height: number; id: number; visualRow: number; absoluteTop: number }[];
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
  const hits = $derived(canvasHtmlLinkHits(htmlRows));
  const height = $derived(Math.max(1, geometry.length
    ? geometry.at(-1)!.top + geometry.at(-1)!.height : lines.length * lineHeight));
  const effectiveWidth = $derived(effectiveStrokeWidth(strokeWidth));
  const hasFallback = $derived(vectorFont && rows.some(row => row.cells.some(cell =>
    !cell.continuation && glyphCoverage(cell.text) === 'outline-fallback')));
  let resolvedFamily = $state('monospace');

  function copyText(event: ClipboardEvent): void {
    const selection = window.getSelection();
    if (!selection || !host?.contains(selection.anchorNode) || !host.contains(selection.focusNode)) return;
    event.clipboardData?.setData('text/plain', selection.toString().split('\n').map(line => line.replace(/\s+$/, '')).join('\n'));
    if (event.clipboardData) event.preventDefault();
  }

  function repaint(): void {
    if (!canvas || width <= 0 || cellWidth <= 0 || lineHeight <= 0) return;
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const pixelWidth = Math.ceil(width * dpr);
    const pixelHeight = Math.ceil(height * dpr);
    if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
    if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
    // CSS resolves var() and inherited families; CanvasRenderingContext2D cannot.
    resolvedFamily = host ? getComputedStyle(host).fontFamily || 'monospace' : 'monospace';
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    const context = canvas.getContext('2d');
    if (!context) return;
    paintCanvasRows(context, rows, {
      fontFamily: resolvedFamily,
      rowGeometry: geometry,
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
    geometry;
    height;
    repaint();
  });
</script>

<div
  bind:this={host}
  class="canvas-terminal"
  data-testid="canvas-terminal"
  data-first-line-id={firstLineId}
  data-row-count={rows.length}
  data-font-mode={vectorFont ? (hasFallback ? 'single-line-with-outline-fallback' : 'single-line') : 'outline'}
  data-stroke-width={effectiveWidth}
  style:font-family={fontFamily}
  style:font-size={`${fontSize}px`}
  style:line-height={`${lineHeight}px`}
  oncopy={copyText}
  style:height={`${height}px`}
>
  <canvas bind:this={canvas} aria-hidden="true"></canvas>
  <div class="text-mirror" aria-label="Terminal viewport text">
    {#each rows as row, index (row.id)}
      <div class="mirror-row mtv-line"
        data-line-id={geometry[index]?.id ?? row.id}
        data-visual-row={geometry[index]?.visualRow ?? index}
        data-presentation-top={geometry[index]?.absoluteTop ?? index * lineHeight}
        data-presentation-height={geometry[index]?.height ?? lineHeight}
        style:top={`${geometry[index]?.top ?? index * lineHeight}px`}
        style:height={`${geometry[index]?.height ?? lineHeight}px`}
      >{#each row.cells.filter(cell => !cell.continuation) as cell}<span style:display="inline-block" style:width={`${cell.width * cellWidth}px`}>{cell.text}</span>{/each}</div>
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
        style:top={`${geometry[hit.row]?.top ?? hit.row * lineHeight}px`}
        style:width={`${Math.max(1, hit.endCol - hit.startCol) * cellWidth}px`}
        style:height={`${geometry[hit.row]?.height ?? lineHeight}px`}
      ></a>
    {/each}
  </div>
</div>

<style>
  .canvas-terminal { position: relative; width: 100%; }
  canvas { position: absolute; inset: 0; display: block; pointer-events: none; }
  .text-mirror { position: absolute; inset: 0; color: transparent; background: transparent; white-space: pre; user-select: text; -webkit-user-select: text; }
  .mirror-row { position: absolute; left: 0; right: 0; white-space: pre; overflow: hidden; }
  .link-layer { position: absolute; inset: 0; pointer-events: none; }
  .link-layer a { position: absolute; pointer-events: auto; color: transparent; text-decoration: none; }
  .link-layer a:focus { outline: 2px solid currentColor; outline-offset: -2px; color: var(--tfg); }
</style>
