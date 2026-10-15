<script lang="ts">
  /** ImageAnnotator — mark up an image, then hand the result to the host (A21).
   *
   * Takes a Blob, draws it on a canvas at its native resolution, lets the user
   * scribble on it, and on SUBMIT exports a PNG Blob and calls
   * `onSubmit({ image, comment })`. It never uploads: no fetch, no endpoint, no
   * topic — the host turns the Blob into multipart, receipts, clipboard text or
   * anything else it needs, and this component only waits for its promise.
   *
   * That wait is the contract: while the promise is pending the panel is busy,
   * on resolve the draft is cleared and `onClose()` fires, and on reject the
   * draft — image, strokes and comment — stays exactly as it was so a failed
   * upload can be retried rather than re-drawn.
   *
   * The canvas keeps the source image's pixel size no matter how small the CSS
   * box is, so a stroke drawn on a phone exports at full resolution.
   */
  import { onMount, onDestroy } from 'svelte';
  import {
    canvasPointFromClient,
    canvasToPngBlob,
    commitStroke,
    defaultAnnotationImagePorts,
    loadAnnotationImage,
    renderAnnotation,
    undoLastStroke,
    type AnnotationImageLike,
    type AnnotationImageLoad,
    type AnnotationPoint,
    type AnnotationStroke,
  } from './attachment-draft';

  let {
    image = $bindable(null),
    comment = $bindable(''),
    onSubmit,
    onClose,
  }: {
    /** Source image. Set to null by REMOVE/CLEAR; bind it to follow along. */
    image?: Blob | null;
    /** Draft comment; bind it to keep the text after the panel closes. */
    comment?: string;
    /** Gets the exported PNG plus the trimmed comment. Awaited before success. */
    onSubmit: (draft: { image: Blob; comment: string }) => void | Promise<void>;
    onClose: () => void;
  } = $props();

  const ports = defaultAnnotationImagePorts();

  let canvasEl = $state<HTMLCanvasElement | null>(null);
  let loadedImage = $state<AnnotationImageLike | null>(null);
  let imageWidth = $state(0);
  let imageHeight = $state(0);
  let strokes = $state<AnnotationStroke[]>([]);
  let currentStroke = $state<AnnotationPoint[]>([]);
  let drawing = $state(false);
  let submitting = $state(false);
  let error = $state('');

  // Plain (non-reactive) load bookkeeping: the effect that starts a load must
  // not re-run just because the load finished.
  let loadedFrom: Blob | null = null;
  let pending: AnnotationImageLoad | null = null;

  const hasImage = $derived(loadedImage !== null);

  $effect(() => {
    const source = image;
    if (source === loadedFrom) return;
    loadedFrom = source;
    dropLoadedImage();
    strokes = [];
    currentStroke = [];
    error = '';
    if (!source) return;
    pending = loadAnnotationImage(source, ports, {
      onLoad: (loaded) => {
        // A load that finishes after REMOVE is dropped inside
        // loadAnnotationImage — reaching here means it is still wanted.
        loadedImage = loaded;
        imageWidth = loaded.width;
        imageHeight = loaded.height;
      },
      onError: () => {
        pending = null;
        error = 'Unable to read that image.';
      },
    });
  });

  // Repaint on anything that changes the picture: new image, new stroke, or a
  // stroke still being drawn.
  $effect(() => {
    const canvas = canvasEl;
    const source = loadedImage;
    const committed = strokes;
    const live = currentStroke;
    if (!canvas || !source) return;
    // Native resolution, always. CSS scales the box; the bitmap never shrinks.
    if (canvas.width !== imageWidth) canvas.width = imageWidth;
    if (canvas.height !== imageHeight) canvas.height = imageHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    renderAnnotation(ctx, source, imageWidth, imageHeight, committed, live);
  });

  function dropLoadedImage(): void {
    pending?.cancel();
    pending?.release();
    pending = null;
    loadedImage = null;
    imageWidth = 0;
    imageHeight = 0;
  }

  function pointFrom(event: { clientX: number; clientY: number }): AnnotationPoint {
    if (!canvasEl) return { x: 0, y: 0 };
    return canvasPointFromClient(canvasEl.getBoundingClientRect(), canvasEl, event);
  }

  function startDraw(event: MouseEvent): void {
    if (submitting || !hasImage) return;
    drawing = true;
    currentStroke = [pointFrom(event)];
  }

  function moveDraw(event: MouseEvent): void {
    if (submitting || !drawing) return;
    currentStroke = [...currentStroke, pointFrom(event)];
  }

  function endDraw(): void {
    if (submitting || !drawing) return;
    drawing = false;
    strokes = commitStroke(strokes, currentStroke);
    currentStroke = [];
  }

  function startDrawTouch(event: TouchEvent): void {
    if (submitting || !hasImage || event.touches.length !== 1) return;
    event.preventDefault();
    drawing = true;
    currentStroke = [pointFrom(event.touches[0]!)];
  }

  function moveDrawTouch(event: TouchEvent): void {
    if (submitting || !drawing || event.touches.length !== 1) return;
    event.preventDefault();
    currentStroke = [...currentStroke, pointFrom(event.touches[0]!)];
  }

  function endDrawTouch(event: TouchEvent): void {
    event.preventDefault();
    endDraw();
  }

  function undo(): void {
    strokes = undoLastStroke(strokes);
  }

  /** CLEAR drops everything, comment included — same as the host panel. */
  export function clearAll(): void {
    if (submitting) return;
    resetDraft();
  }

  // Successful submission must clear its snapshot while user edits stay locked.
  function resetDraft(): void {
    drawing = false;
    strokes = [];
    currentStroke = [];
    comment = '';
    error = '';
    image = null;
  }

  /** REMOVE drops the picture only; the comment already typed survives. */
  export function removeImage(): void {
    if (submitting) return;
    drawing = false;
    strokes = [];
    currentStroke = [];
    error = '';
    image = null;
  }

  export async function submit(): Promise<void> {
    if (!canvasEl || !hasImage || submitting) return;
    // End any live gesture before freezing the draft, including instance submit.
    endDraw();
    submitting = true;
    error = '';
    try {
      const exported = await canvasToPngBlob(canvasEl);
      await onSubmit({ image: exported, comment: comment.trim() });
      resetDraft();
      onClose();
    } catch (cause) {
      // Draft intentionally untouched: a failed upload must be retryable.
      error = cause instanceof Error ? cause.message : String(cause ?? 'Unable to upload that image.');
    } finally {
      submitting = false;
    }
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') onClose();
  }

  onMount(() => {
    window.addEventListener('keydown', onKeydown);
    return () => window.removeEventListener('keydown', onKeydown);
  });

  onDestroy(() => {
    dropLoadedImage();
  });
</script>

<div class="annotator" data-testid="image-annotator">
  <div class="annotator-header">
    <span class="annotator-title">ADD IMAGE</span>
    <button
      type="button"
      class="annotator-close"
      onclick={onClose}
      aria-label="Close"
      data-testid="image-annotator-close"
    >&times;</button>
  </div>

  {#if image}
    <div class="annotator-selected" data-testid="image-annotator-selected">
      {#if hasImage}
        <span class="annotator-selected-meta">{imageWidth}&times;{imageHeight}</span>
      {/if}
      <button
        type="button"
        class="annotator-btn"
        onclick={removeImage}
        disabled={submitting}
        aria-label="Remove image"
        data-testid="image-annotator-remove"
      >&times;</button>
    </div>
  {/if}

  {#if hasImage}
    <div class="annotator-canvas-wrap">
      <canvas
        bind:this={canvasEl}
        data-testid="image-annotator-canvas"
        aria-disabled={submitting}
        onmousedown={startDraw}
        onmousemove={moveDraw}
        onmouseup={endDraw}
        onmouseleave={endDraw}
        ontouchstart={startDrawTouch}
        ontouchmove={moveDrawTouch}
        ontouchend={endDrawTouch}
        ontouchcancel={endDrawTouch}
      ></canvas>
    </div>
    <div class="annotator-tools">
      <button
        type="button"
        class="annotator-btn"
        onclick={undo}
        disabled={submitting || strokes.length === 0}
        data-testid="image-annotator-undo"
      >UNDO</button>
      <button
        type="button"
        class="annotator-btn danger"
        onclick={clearAll}
        disabled={submitting}
        data-testid="image-annotator-clear"
      >CLEAR</button>
    </div>
  {:else}
    <p class="annotator-empty" data-testid="image-annotator-empty">No image yet.</p>
  {/if}

  <div class="annotator-comment">
    <input
      type="text"
      class="annotator-input"
      placeholder="comment..."
      lang="th"
      bind:value={comment}
      disabled={submitting}
      onkeydown={(event) => {
        if (event.key === 'Enter' && hasImage) void submit();
      }}
      data-testid="image-annotator-comment"
    />
  </div>

  {#if error}
    <p class="annotator-error" data-testid="image-annotator-error">{error}</p>
  {/if}

  <div class="annotator-actions">
    <button
      type="button"
      class="annotator-btn primary"
      onclick={() => void submit()}
      disabled={!hasImage || submitting}
      data-testid="image-annotator-submit"
    >{submitting ? 'UPLOADING...' : 'SUBMIT'}</button>
  </div>
</div>

<style>
  .annotator {
    display: flex;
    flex-direction: column;
    min-height: 0;
    background: var(--bg, #f5f0e8);
    border: 1px solid var(--border, #1a1a1a);
    color: var(--text, #1a1a1a);
  }

  .annotator-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 12px;
    border-bottom: 1px solid var(--border, #1a1a1a);
  }

  .annotator-title {
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.875rem;
    font-weight: 700;
    letter-spacing: 0.04em;
  }

  .annotator-close {
    min-width: 44px;
    min-height: 44px;
    border: none;
    background: none;
    color: inherit;
    font-size: 1.2rem;
    cursor: pointer;
    touch-action: manipulation;
  }

  .annotator-selected {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 8px 12px;
    border-bottom: 1px solid var(--border, #1a1a1a);
    background: var(--bg-elevated, #faf7f2);
  }

  .annotator-selected-meta {
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.875rem;
    opacity: 0.7;
  }

  .annotator-empty {
    margin: 0;
    padding: 32px 16px;
    text-align: center;
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.875rem;
    opacity: 0.72;
  }

  .annotator-canvas-wrap {
    flex: 1;
    min-height: 0;
    display: flex;
    justify-content: center;
    overflow: auto;
    padding: 8px;
  }

  canvas {
    border: 1px solid var(--border, #1a1a1a);
    cursor: crosshair;
    touch-action: none;
    max-width: 100%;
    height: auto;
  }

  canvas[aria-disabled='true'] {
    cursor: not-allowed;
  }

  .annotator-tools {
    display: flex;
    gap: 8px;
    padding: 8px 12px 0;
  }

  .annotator-comment {
    padding: 8px 12px;
  }

  .annotator-input {
    width: 100%;
    min-height: 44px;
    padding: 8px 12px;
    border: 1px solid var(--border, #1a1a1a);
    background: var(--bg-elevated, #faf7f2);
    color: var(--text, #1a1a1a);
    font-family: 'JetBrains Mono', 'Sarabun', monospace;
    font-size: 16px;
    line-height: 1.7;
  }

  .annotator-error {
    margin: 0;
    padding: 0 12px;
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.875rem;
    color: #b42318;
  }

  .annotator-actions {
    padding: 8px 12px 12px;
  }

  .annotator-btn {
    min-height: 44px;
    padding: 8px 16px;
    border: 1px solid var(--border, #1a1a1a);
    background: transparent;
    color: var(--text, #1a1a1a);
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.875rem;
    font-weight: 700;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    cursor: pointer;
    touch-action: manipulation;
  }

  .annotator-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .annotator-btn.primary {
    width: 100%;
    background: var(--accent, #ff6b00);
    border-color: var(--accent, #ff6b00);
    color: var(--bg, #1a1a1a);
  }

  .annotator-btn.danger {
    color: #c0392b;
    border-color: #c0392b;
  }
</style>
