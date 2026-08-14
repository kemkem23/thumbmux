<script lang="ts">
  /** SessionThumb — a live, read-only miniature of a tmux pane. Subscribes
   * through the shared ws-mux (captures are shared server-side with any full
   * viewer) and renders the pane tail with the same ANSI renderer as
   * TermView, just tiny. Never sends keys or resizes the pane. */
  import { tmuxMux } from './ws-mux.svelte';
  import { deriveThumbnailPalette } from './session-grid';
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

  let content = $state('');
  let connected = $state(false);
  let thumbEl = $state<HTMLDivElement | null>(null);
  let thumbPalette = $derived(deriveThumbnailPalette(palette));
  let html = $derived(renderContent(content, maxLines, thumbPalette));

  /** Pin boxes must use a *measured* cell in px. `width: 1ch` plus
   * `font-size: calc(1ch * 0.92)` on the same element is circular — ch
   * follows the new font-size and the box shrinks. TermView avoids this
   * by setting `--mtv-cw` from ten ASCII Ms. */
  function measureThumbCell(el: HTMLElement): void {
    const probe = document.createElement('span');
    probe.textContent = 'MMMMMMMMMM';
    probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre';
    el.appendChild(probe);
    const cw = probe.getBoundingClientRect().width / 10;
    probe.remove();
    if (!(cw > 0) || !Number.isFinite(cw)) return;
    const lh = parseFloat(getComputedStyle(el.querySelector('.tail') ?? el).lineHeight);
    el.style.setProperty('--mtv-cw', `${cw}px`);
    el.style.setProperty('--mtv-lineh', `${Number.isFinite(lh) && lh > 0 ? lh : cw * 1.38}px`);
  }

  $effect(() => {
    const el = thumbEl;
    void html;
    void connected;
    if (!el) return;
    measureThumbCell(el);
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => measureThumbCell(el));
    ro.observe(el);
    return () => ro.disconnect();
  });

  /** Advance SGR/OSC through the full tail first, then keep only the last
   * linesToKeep for display — otherwise a color/link opened in the discarded
   * +10 context lines is lost on the visible suffix (A6-19). */
  function renderContent(raw: string, linesToKeep: number, renderPalette: AnsiPalette) {
    const lines = raw.replace(/\r/g, '').split('\n');
    const start = Math.max(0, lines.length - linesToKeep);
    const st = createSgrState();
    for (let i = 0; i < start; i++) {
      lineToHtml(lines[i]!, st, renderPalette);
    }
    return lines
      .slice(start)
      .map((line) => `<div class="mtv-line">${lineToHtml(line, st, renderPalette) || '&nbsp;'}</div>`)
      .join('');
  }

  // A6-10: resubscribe when session or maxLines changes (not only on mount).
  $effect(() => {
    const name = session;
    const tail = maxLines + 10;
    let active = true;
    content = '';
    connected = false;
    const unsubscribe = tmuxMux.subscribe(name, (data, type) => {
      if (!active) return;
      if (type === 'history' || type === 'error' || type === 'cursor') return;
      connected = true;
      content = data;
    }, { tail });
    return () => {
      active = false;
      unsubscribe();
    };
  });
</script>

<!-- A6-11: read-only miniature — inert + aria-hidden so OSC-8 anchors inside
     grid cards are never keyboard-focusable and do not join the card name. -->
<div
  bind:this={thumbEl}
  class="thumb"
  style:--tfg={thumbPalette.defaultFg}
  style:--tbg={thumbPalette.defaultBg}
  data-testid="session-thumb"
  data-live={connected}
  inert
  aria-hidden="true"
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
  /*
   * Same pin as TermView, owned here because TermView's `.mtv-line :global()`
   * is component-scoped and never matches a thumbnail. 1ch is one cell in
   * this mono face (measured 0.997–1.000 × M at every thumbnail size 7–13).
   */
  .tail :global(.mtv-w1),
  .tail :global(.mtv-w2),
  .tail :global(.mtv-wx) {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    height: 1.38em;
    box-sizing: border-box;
    vertical-align: top;
    overflow: visible;
    white-space: pre;
    line-height: 1;
  }
  .tail :global(.mtv-w1) {
    width: var(--mtv-cw, 1ch);
    font-size: inherit;
  }
  .tail :global(.mtv-w1.mtv-fit) {
    font-size: min(var(--mtv-lineh, 1.38em), calc(var(--mtv-cw, 1ch) * 0.92));
    overflow: hidden;
  }
  .tail :global(.mtv-w2) {
    width: calc(2 * var(--mtv-cw, 1ch));
    font-size: min(var(--mtv-lineh, 1.38em), calc(2 * var(--mtv-cw, 1ch) * 0.92));
  }
  .tail :global(.mtv-wx) {
    width: calc(var(--mtv-cells, 1) * var(--mtv-cw, 1ch));
    font-size: inherit;
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
