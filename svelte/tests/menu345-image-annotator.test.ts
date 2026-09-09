/**
 * W3-I1 · A21 — draw on an image before the host uploads it.
 *
 * happy-dom has no 2D context and decodes no images, so the browser pieces are
 * faked *at the seam the component actually uses*: `new Image()`, the canvas'
 * `getContext`/`toBlob`, and the element's bounding box. That keeps the
 * assertions on real component behaviour — coordinates, export size, stroke
 * bookkeeping, promise handling and object-URL lifetime — instead of on a
 * reimplementation of it.
 * Mouse and touch events go through the mounted component's DOM listeners.
 * This is not proof of physical phone gestures or real canvas pixels.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { flushSync, mount, tick, unmount } from "./svelte-client";

import ImageAnnotator from "../src/ImageAnnotator.svelte";
import {
  ANNOTATION_HALO_COLOR,
  ANNOTATION_HALO_WIDTH,
  ANNOTATION_STROKE_COLOR,
  ANNOTATION_STROKE_WIDTH,
  canvasPointFromClient,
  canvasToPngBlob,
  commitStroke,
  drawAnnotationStroke,
  loadAnnotationImage,
  renderAnnotation,
  undoLastStroke,
  type AnnotationCanvasLike,
  type AnnotationContext2DLike,
  type AnnotationImageLike,
  type AnnotationImagePorts,
} from "../src/attachment-draft";

type CtxCall = { op: string; args: unknown[] };

type FakeContext = AnnotationContext2DLike & { calls: CtxCall[] };

type AnnotatorInstance = {
  clearAll(): void;
  removeImage(): void;
  submit(): Promise<void>;
};

type Mounted = {
  app: AnnotatorInstance;
  target: HTMLElement;
};

/** Records the drawing calls so a test can read back what was painted. */
function createFakeContext(): FakeContext {
  const calls: CtxCall[] = [];
  const ctx: FakeContext = {
    calls,
    lineCap: "butt",
    lineJoin: "miter",
    lineWidth: 1,
    strokeStyle: "",
    beginPath: () => calls.push({ op: "beginPath", args: [] }),
    moveTo: (x, y) => calls.push({ op: "moveTo", args: [x, y] }),
    lineTo: (x, y) => calls.push({ op: "lineTo", args: [x, y] }),
    stroke: () => calls.push({ op: "stroke", args: [ctx.strokeStyle, ctx.lineWidth] }),
    clearRect: (x, y, w, h) => calls.push({ op: "clearRect", args: [x, y, w, h] }),
    drawImage: (_image, dx, dy, dw, dh) => calls.push({ op: "drawImage", args: [dx, dy, dw, dh] }),
  };
  return ctx;
}

/** Splits a call log into one entry per `beginPath()` path. */
function pathsOf(calls: readonly CtxCall[]): Array<Array<[number, number]>> {
  const paths: Array<Array<[number, number]>> = [];
  for (const call of calls) {
    if (call.op === "beginPath") paths.push([]);
    if (call.op === "moveTo" || call.op === "lineTo") {
      paths.at(-1)?.push([call.args[0] as number, call.args[1] as number]);
    }
  }
  return paths;
}

class FakeImage {
  width = 0;
  height = 0;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  #src = "";

  set src(value: string) {
    this.#src = value;
    createdImages.push(this as unknown as FakeImage);
  }

  get src(): string {
    return this.#src;
  }
}

let createdImages: FakeImage[] = [];
let created: string[] = [];
let revoked: string[] = [];
let exportedSizes: Array<{ width: number; height: number; type?: string }> = [];
let eventErrors: string[] = [];
function recordEventError(event: ErrorEvent): void {
  eventErrors.push(event.error?.message ?? event.message);
}

const mounted: Array<{ app: unknown; target: HTMLElement }> = [];
const canvasProto = Object.getPrototypeOf(
  document.createElement("canvas"),
) as HTMLCanvasElement;
const originalGetContext = canvasProto.getContext;
const originalToBlob = canvasProto.toBlob;
const originalImage = (globalThis as { Image?: unknown }).Image;
const originalCreate = URL.createObjectURL;
const originalRevoke = URL.revokeObjectURL;
const contexts = new WeakMap<object, FakeContext>();

function contextOf(canvas: HTMLCanvasElement): FakeContext {
  const ctx = contexts.get(canvas);
  if (!ctx) throw new Error("canvas never asked for a 2D context");
  return ctx;
}

function pngBlob(): Blob {
  return new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" });
}

function mountAnnotator(props: {
  image?: Blob | null;
  comment?: string;
  onSubmit: (draft: { image: Blob; comment: string }) => void | Promise<void>;
  onClose: () => void;
}): Mounted {
  const target = document.createElement("div");
  document.body.appendChild(target);
  let app!: AnnotatorInstance;
  flushSync(() => {
    app = mount(ImageAnnotator, { target, props }) as unknown as AnnotatorInstance;
  });
  mounted.push({ app, target });
  return { app, target };
}

/** Completes the pending decode at the given natural size. */
async function decodeImage(width: number, height: number): Promise<void> {
  const image = createdImages.at(-1);
  if (!image) throw new Error("no image load was started");
  image.width = width;
  image.height = height;
  image.onload?.();
  flushSync();
  await tick();
}

/** Puts the canvas in a box smaller than the bitmap, like a phone would. */
function displayAt(
  canvas: HTMLCanvasElement,
  box: { left: number; top: number; width: number; height: number },
): void {
  Object.defineProperty(canvas, "getBoundingClientRect", {
    configurable: true,
    value: () => ({
      ...box,
      right: box.left + box.width,
      bottom: box.top + box.height,
      x: box.left,
      y: box.top,
      toJSON: () => box,
    }),
  });
}

/** Boolean, not the element: a failed DOM assertion should not dump the DOM. */
function hasCanvas(target: HTMLElement): boolean {
  return target.querySelector('[data-testid="image-annotator-canvas"]') !== null;
}

function hasEmptyState(target: HTMLElement): boolean {
  return target.querySelector('[data-testid="image-annotator-empty"]') !== null;
}

function canvasOf(target: HTMLElement): HTMLCanvasElement {
  const canvas = target.querySelector<HTMLCanvasElement>('[data-testid="image-annotator-canvas"]');
  if (!canvas) throw new Error("annotator is not showing a canvas");
  return canvas;
}

function drawStrokeOn(
  canvas: HTMLCanvasElement,
  points: Array<[number, number]>,
): void {
  const [first, ...rest] = points;
  canvas.dispatchEvent(
    new MouseEvent("mousedown", { clientX: first![0], clientY: first![1], bubbles: true }),
  );
  for (const [clientX, clientY] of rest) {
    canvas.dispatchEvent(new MouseEvent("mousemove", { clientX, clientY, bubbles: true }));
  }
  canvas.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  flushSync();
}

function commentInput(target: HTMLElement): HTMLInputElement {
  return target.querySelector<HTMLInputElement>('[data-testid="image-annotator-comment"]')!;
}

function toolButton(target: HTMLElement, name: string): HTMLButtonElement {
  return target.querySelector<HTMLButtonElement>(`[data-testid="image-annotator-${name}"]`)!;
}

function touchOn(
  canvas: HTMLCanvasElement,
  type: "touchstart" | "touchmove" | "touchend" | "touchcancel",
  points: Array<[number, number]> = [],
): TouchEvent {
  const touches = points.map(([clientX, clientY], identifier) => ({
    identifier, clientX, clientY, target: canvas,
  }) as Touch);
  const event = new TouchEvent(type, { touches, bubbles: true, cancelable: true });
  canvas.dispatchEvent(event);
  flushSync();
  return event;
}

function typeComment(target: HTMLElement, value: string): void {
  const input = commentInput(target);
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  flushSync();
}

function submitButton(target: HTMLElement): HTMLButtonElement {
  return target.querySelector<HTMLButtonElement>('[data-testid="image-annotator-submit"]')!;
}

beforeEach(() => {
  createdImages = [];
  created = [];
  revoked = [];
  exportedSizes = [];
  eventErrors = [];
  window.addEventListener("error", recordEventError);

  let counter = 0;
  URL.createObjectURL = ((_blob: Blob) => {
    counter += 1;
    const url = `blob:annotator/${counter}`;
    created.push(url);
    return url;
  }) as typeof URL.createObjectURL;
  URL.revokeObjectURL = ((url: string) => {
    revoked.push(url);
  }) as typeof URL.revokeObjectURL;

  (globalThis as { Image?: unknown }).Image = FakeImage;

  (canvasProto as unknown as Record<string, unknown>).getContext = function (
    this: HTMLCanvasElement,
    contextId: string,
  ) {
    if (contextId !== "2d") return null;
    let ctx = contexts.get(this);
    if (!ctx) {
      ctx = createFakeContext();
      contexts.set(this, ctx);
    }
    return ctx;
  };

  (canvasProto as unknown as Record<string, unknown>).toBlob = function (
    this: HTMLCanvasElement,
    callback: (blob: Blob | null) => void,
    type?: string,
  ) {
    exportedSizes.push({ width: this.width, height: this.height, type });
    callback(pngBlob());
  };
});

afterEach(() => {
  while (mounted.length > 0) {
    const entry = mounted.pop()!;
    try {
      unmount(entry.app);
    } catch {
      // already torn down
    }
    entry.target.remove();
  }
  (canvasProto as unknown as Record<string, unknown>).getContext = originalGetContext;
  (canvasProto as unknown as Record<string, unknown>).toBlob = originalToBlob;
  (globalThis as { Image?: unknown }).Image = originalImage;
  URL.createObjectURL = originalCreate;
  URL.revokeObjectURL = originalRevoke;
  window.removeEventListener("error", recordEventError);
  // DOM listeners can report exceptions to window instead of dispatchEvent's
  // caller. Such exceptions must fail even a test expecting no submission.
  expect(eventErrors).toEqual([]);
});

describe("annotation helpers", () => {
  test("screen points scale into bitmap points by the box ratio", () => {
    const rect = { left: 20, top: 10, width: 400, height: 225 };
    const canvas = { width: 1600, height: 900 };

    expect(canvasPointFromClient(rect, canvas, { clientX: 20, clientY: 10 })).toEqual({
      x: 0,
      y: 0,
    });
    expect(canvasPointFromClient(rect, canvas, { clientX: 120, clientY: 60 })).toEqual({
      x: 400,
      y: 200,
    });
    // A collapsed box must not divide by zero.
    expect(
      canvasPointFromClient({ left: 0, top: 0, width: 0, height: 0 }, canvas, {
        clientX: 5,
        clientY: 7,
      }),
    ).toEqual({ x: 5, y: 7 });
  });

  test("a stroke paints halo then core, and a single point paints nothing", () => {
    const ctx = createFakeContext();
    drawAnnotationStroke(ctx, [{ x: 1, y: 2 }]);
    expect(ctx.calls).toEqual([]);

    drawAnnotationStroke(ctx, [
      { x: 1, y: 2 },
      { x: 3, y: 4 },
    ]);
    expect(ctx.calls.map((call) => call.op)).toEqual([
      "beginPath",
      "moveTo",
      "lineTo",
      "stroke",
      "stroke",
    ]);
    expect(ctx.calls.filter((call) => call.op === "stroke").map((call) => call.args)).toEqual([
      [ANNOTATION_HALO_COLOR, ANNOTATION_HALO_WIDTH],
      [ANNOTATION_STROKE_COLOR, ANNOTATION_STROKE_WIDTH],
    ]);
    expect(ctx.lineCap).toBe("round");
  });

  test("render repaints the image first, then every stroke including the live one", () => {
    const ctx = createFakeContext();
    renderAnnotation(
      ctx,
      {},
      1600,
      900,
      [
        [
          { x: 0, y: 0 },
          { x: 1, y: 1 },
        ],
      ],
      [
        { x: 5, y: 5 },
        { x: 6, y: 6 },
      ],
    );

    expect(ctx.calls[0]).toEqual({ op: "drawImage", args: [0, 0, 1600, 900] });
    expect(pathsOf(ctx.calls)).toEqual([
      [
        [0, 0],
        [1, 1],
      ],
      [
        [5, 5],
        [6, 6],
      ],
    ]);
  });

  test("undo drops the last stroke; a stroke needs two points to commit", () => {
    const a = [{ x: 0, y: 0 }, { x: 1, y: 1 }];
    const b = [{ x: 2, y: 2 }, { x: 3, y: 3 }];
    expect(undoLastStroke([a, b])).toEqual([a]);
    expect(undoLastStroke([])).toEqual([]);

    expect(commitStroke([a], [{ x: 9, y: 9 }])).toEqual([a]);
    expect(commitStroke([a], b)).toEqual([a, b]);
    // The committed stroke is a copy — later mutation of the live buffer cannot
    // reach back into history.
    const live = [{ x: 4, y: 4 }, { x: 5, y: 5 }];
    const committed = commitStroke([], live);
    live.push({ x: 6, y: 6 });
    expect(committed[0]).toHaveLength(2);
  });

  test("a decode that lands after cancel neither reports nor leaks", () => {
    const events: string[] = [];
    const ports: AnnotationImagePorts = {
      createObjectURL: () => "blob:unit/1",
      revokeObjectURL: (url) => events.push(`revoke ${url}`),
      createImage: () => image as unknown as AnnotationImageLike,
    };
    const image = new FakeImage();

    const load = loadAnnotationImage(pngBlob(), ports, {
      onLoad: () => events.push("load"),
      onError: () => events.push("error"),
    });

    load.cancel();
    image.onload?.();
    load.release();

    expect(events).toEqual(["revoke blob:unit/1"]);
  });

  test("a live decode reports once and the URL is revoked only on release", () => {
    const events: string[] = [];
    const image = new FakeImage();
    const ports: AnnotationImagePorts = {
      createObjectURL: () => "blob:unit/2",
      revokeObjectURL: (url) => events.push(`revoke ${url}`),
      createImage: () => image as unknown as AnnotationImageLike,
    };

    const load = loadAnnotationImage(pngBlob(), ports, {
      onLoad: (_loaded, url) => events.push(`load ${url}`),
    });
    image.width = 8;
    image.height = 4;
    image.onload?.();

    expect(events).toEqual(["load blob:unit/2"]);
    load.release();
    load.release();
    expect(events).toEqual(["load blob:unit/2", "revoke blob:unit/2"]);
  });

  test("a broken image revokes its URL and reports the failure once", () => {
    const events: string[] = [];
    const image = new FakeImage();
    const ports: AnnotationImagePorts = {
      createObjectURL: () => "blob:unit/3",
      revokeObjectURL: (url) => events.push(`revoke ${url}`),
      createImage: () => image as unknown as AnnotationImageLike,
    };

    const load = loadAnnotationImage(pngBlob(), ports, {
      onLoad: () => events.push("load"),
      onError: () => events.push("error"),
    });
    image.onerror?.();
    load.cancel();

    expect(events).toEqual(["revoke blob:unit/3", "error"]);
  });

  test("export rejects instead of resolving with nothing", async () => {
    const canvas: AnnotationCanvasLike = {
      width: 4,
      height: 2,
      getContext: () => null,
      toBlob: (callback) => callback(null),
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 4, height: 2 }),
    };
    await expect(canvasToPngBlob(canvas)).rejects.toThrow("canvas.toBlob returned no image");
  });
});

describe("ImageAnnotator", () => {
  test("touch draws and commits exactly the same scaled stroke as the mouse", async () => {
    const { target } = mountAnnotator({ image: pngBlob(), onSubmit: () => {}, onClose: () => {} });
    await tick();
    await decodeImage(1600, 900);
    const canvas = canvasOf(target);
    displayAt(canvas, { left: 20, top: 10, width: 400, height: 225 });
    const points: Array<[number, number]> = [[120, 60], [170, 85], [220, 110]];
    const expected = [[[400, 200], [600, 300], [800, 400]]];
    const ctx = contextOf(canvas);

    ctx.calls.length = 0;
    drawStrokeOn(canvas, points);
    const mousePaths = pathsOf(ctx.calls);
    expect(mousePaths).toEqual(expected);
    toolButton(target, "undo").click();
    flushSync();
    expect(toolButton(target, "undo").disabled).toBe(true);

    touchOn(canvas, "touchstart", [points[0]!]);
    for (const point of points.slice(1)) {
      touchOn(canvas, "touchmove", [point]);
    }
    ctx.calls.length = 0;
    expect(touchOn(canvas, "touchend").defaultPrevented).toBe(true);
    expect(pathsOf(ctx.calls)).toEqual(mousePaths);
    expect(toolButton(target, "undo").disabled).toBe(false);

    // An ended stroke must not grow if a later move arrives without a start.
    ctx.calls.length = 0;
    touchOn(canvas, "touchmove", [[300, 200]]);
    expect(ctx.calls).toEqual([]);
    toolButton(target, "undo").click();
    flushSync();
    expect(pathsOf(ctx.calls)).toEqual([]);
    expect(toolButton(target, "undo").disabled).toBe(true);
  });

  test("touchcancel commits the partial stroke and the next gesture is separate", async () => {
    const { target } = mountAnnotator({ image: pngBlob(), onSubmit: () => {}, onClose: () => {} });
    await tick();
    await decodeImage(400, 300);
    const canvas = canvasOf(target);
    displayAt(canvas, { left: 0, top: 0, width: 400, height: 300 });
    const ctx = contextOf(canvas);
    touchOn(canvas, "touchstart", [[10, 20]]);
    touchOn(canvas, "touchmove", [[30, 40]]);
    ctx.calls.length = 0;
    expect(touchOn(canvas, "touchcancel").defaultPrevented).toBe(true);
    expect(pathsOf(ctx.calls)).toEqual([[[10, 20], [30, 40]]]);
    expect(toolButton(target, "undo").disabled).toBe(false);

    ctx.calls.length = 0;
    touchOn(canvas, "touchmove", [[80, 90]]);
    touchOn(canvas, "touchend");
    expect(ctx.calls).toEqual([]);
    touchOn(canvas, "touchstart", [[100, 110]]);
    touchOn(canvas, "touchmove", [[120, 130]]);
    ctx.calls.length = 0;
    touchOn(canvas, "touchend");
    expect(pathsOf(ctx.calls)).toEqual([
      [[10, 20], [30, 40]], [[100, 110], [120, 130]],
    ]);
    ctx.calls.length = 0;
    toolButton(target, "undo").click();
    flushSync();
    expect(pathsOf(ctx.calls)).toEqual([[[10, 20], [30, 40]]]);
  });

  test("mouseleave commits the stroke and later movement cannot extend it", async () => {
    const { target } = mountAnnotator({ image: pngBlob(), onSubmit: () => {}, onClose: () => {} });
    await tick();
    await decodeImage(400, 300);
    const canvas = canvasOf(target);
    displayAt(canvas, { left: 0, top: 0, width: 400, height: 300 });
    const ctx = contextOf(canvas);
    canvas.dispatchEvent(new MouseEvent("mousedown", { clientX: 10, clientY: 20, bubbles: true }));
    canvas.dispatchEvent(new MouseEvent("mousemove", { clientX: 30, clientY: 40, bubbles: true }));
    canvas.dispatchEvent(new MouseEvent("mouseleave"));
    flushSync();
    expect(toolButton(target, "undo").disabled).toBe(false);
    expect(pathsOf(ctx.calls)).toEqual([[[10, 20], [30, 40]]]);
    ctx.calls.length = 0;
    canvas.dispatchEvent(new MouseEvent("mousemove", { clientX: 80, clientY: 90, bubbles: true }));
    canvas.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    flushSync();
    expect(ctx.calls).toEqual([]);
    drawStrokeOn(canvas, [[100, 110], [120, 130]]);
    expect(pathsOf(ctx.calls)).toEqual([
      [[10, 20], [30, 40]], [[100, 110], [120, 130]],
    ]);
  });

  test("the component reports a broken image without exporting or closing", async () => {
    let submissions = 0;
    let closes = 0;
    const { target } = mountAnnotator({
      image: pngBlob(), comment: "เก็บไว้เลือกภาพใหม่",
      onSubmit: () => { submissions += 1; },
      onClose: () => { closes += 1; },
    });
    await tick();
    expect(createdImages).toHaveLength(1);
    expect(typeof createdImages[0]!.onerror).toBe("function");
    createdImages[0]!.onerror!();
    flushSync();
    await tick();
    expect(target.querySelector('[data-testid="image-annotator-error"]')?.textContent)
      .toBe("Unable to read that image.");
    expect(hasCanvas(target)).toBe(false);
    expect(hasEmptyState(target)).toBe(true);
    expect(submitButton(target).disabled).toBe(true);
    expect(submitButton(target).textContent?.trim()).toBe("SUBMIT");
    expect(commentInput(target).value).toBe("เก็บไว้เลือกภาพใหม่");
    expect(revoked).toEqual([created[0]!]);
    expect(exportedSizes).toEqual([]);
    expect(submissions).toBe(0);
    expect(closes).toBe(0);
  });

  test("the X button closes exactly once without submitting", async () => {
    let closes = 0;
    let submissions = 0;
    const { target } = mountAnnotator({
      image: pngBlob(),
      onSubmit: () => { submissions += 1; },
      onClose: () => { closes += 1; },
    });
    await tick();
    await decodeImage(400, 300);
    toolButton(target, "close").click();
    flushSync();
    expect(closes).toBe(1);
    expect(submissions).toBe(0);
    expect(exportedSizes).toEqual([]);
  });

  test("Enter before decode does not start submitting or export an empty image", async () => {
    let submissions = 0;
    let closes = 0;
    const { target } = mountAnnotator({
      image: pngBlob(), comment: "รอภาพ",
      onSubmit: () => { submissions += 1; },
      onClose: () => { closes += 1; },
    });
    await tick();
    expect(createdImages).toHaveLength(1);
    commentInput(target).dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    flushSync();
    await tick();
    expect(submissions).toBe(0);
    expect(exportedSizes).toEqual([]);
    expect(submitButton(target).textContent?.trim()).toBe("SUBMIT");
    expect(submitButton(target).disabled).toBe(true);
    expect(commentInput(target).disabled).toBe(false);
    expect(commentInput(target).value).toBe("รอภาพ");
    expect(hasEmptyState(target)).toBe(true);
    expect(target.querySelector('[data-testid="image-annotator-error"]') === null).toBe(true);
    expect(closes).toBe(0);
    expect(revoked).toEqual([]);
  });

  test("sizes the canvas to the image's own pixels and paints it once", async () => {
    const { target } = mountAnnotator({ image: pngBlob(), onSubmit: () => {}, onClose: () => {} });
    await tick();

    expect(hasEmptyState(target)).toBe(true);
    await decodeImage(1600, 900);

    const canvas = canvasOf(target);
    expect(canvas.width).toBe(1600);
    expect(canvas.height).toBe(900);
    expect(contextOf(canvas).calls[0]).toEqual({ op: "drawImage", args: [0, 0, 1600, 900] });
    expect(
      target.querySelector('[data-testid="image-annotator-selected"]')?.textContent ?? "",
    ).toContain("1600×900");
  });

  test("a stroke drawn on a small box lands on the bitmap and exports full size", async () => {
    const submissions: Array<{ image: Blob; comment: string }> = [];
    const { target } = mountAnnotator({
      image: pngBlob(),
      onSubmit: (draft) => {
        submissions.push(draft);
      },
      onClose: () => {},
    });
    await tick();
    await decodeImage(1600, 900);

    const canvas = canvasOf(target);
    // 1600×900 bitmap shown in a 400×225 box → every coordinate scales ×4.
    displayAt(canvas, { left: 20, top: 10, width: 400, height: 225 });
    const ctx = contextOf(canvas);
    ctx.calls.length = 0;

    drawStrokeOn(canvas, [
      [120, 60],
      [220, 110],
    ]);
    await tick();

    expect(pathsOf(ctx.calls).at(-1)).toEqual([
      [400, 200],
      [800, 400],
    ]);

    typeComment(target, "  ขอบซ้ายเพี้ยน  ");
    submitButton(target).click();
    for (let i = 0; i < 10 && submissions.length === 0; i += 1) await tick();

    expect(exportedSizes).toEqual([{ width: 1600, height: 900, type: "image/png" }]);
    expect(submissions).toHaveLength(1);
    expect(submissions[0]!.comment).toBe("ขอบซ้ายเพี้ยน");
    expect(submissions[0]!.image.type).toBe("image/png");
  });

  test("UNDO removes the last stroke and leaves the image alone", async () => {
    const { target } = mountAnnotator({ image: pngBlob(), onSubmit: () => {}, onClose: () => {} });
    await tick();
    await decodeImage(800, 600);

    const canvas = canvasOf(target);
    displayAt(canvas, { left: 0, top: 0, width: 800, height: 600 });
    const undo = target.querySelector<HTMLButtonElement>('[data-testid="image-annotator-undo"]')!;
    expect(undo.disabled).toBe(true);

    drawStrokeOn(canvas, [
      [10, 10],
      [20, 20],
    ]);
    drawStrokeOn(canvas, [
      [30, 30],
      [40, 40],
    ]);
    await tick();
    expect(undo.disabled).toBe(false);

    const ctx = contextOf(canvas);
    ctx.calls.length = 0;
    undo.click();
    flushSync();
    await tick();

    expect(ctx.calls[0]).toEqual({ op: "drawImage", args: [0, 0, 800, 600] });
    expect(pathsOf(ctx.calls)).toEqual([
      [
        [10, 10],
        [20, 20],
      ],
    ]);

    ctx.calls.length = 0;
    undo.click();
    flushSync();
    await tick();
    expect(pathsOf(ctx.calls)).toEqual([]);
    expect(undo.disabled).toBe(true);
  });

  test("CLEAR wipes the comment too; REMOVE keeps what was typed", async () => {
    const { target } = mountAnnotator({ image: pngBlob(), onSubmit: () => {}, onClose: () => {} });
    await tick();
    await decodeImage(400, 300);
    typeComment(target, "ตรงนี้ผิด");

    target.querySelector<HTMLButtonElement>('[data-testid="image-annotator-remove"]')!.click();
    flushSync();
    await tick();

    expect(hasCanvas(target)).toBe(false);
    expect(commentInput(target).value).toBe("ตรงนี้ผิด");
    expect(revoked).toEqual([created[0]!]);
    expect(submitButton(target).disabled).toBe(true);

    // A fresh image can come back in without remounting.
    const { target: second } = mountAnnotator({
      image: pngBlob(),
      comment: "ยังอยู่",
      onSubmit: () => {},
      onClose: () => {},
    });
    await tick();
    await decodeImage(400, 300);
    second.querySelector<HTMLButtonElement>('[data-testid="image-annotator-clear"]')!.click();
    flushSync();
    await tick();

    expect(hasCanvas(second)).toBe(false);
    expect(commentInput(second).value).toBe("");
  });

  test("a decode that finishes after REMOVE does not resurrect the draft", async () => {
    const { app, target } = mountAnnotator({ image: pngBlob(), onSubmit: () => {}, onClose: () => {} });
    await tick();

    // Removed while the decode is still in flight — the panel has no remove
    // button yet, which is exactly the window this guards.
    const stale = createdImages.at(-1)!;
    app.removeImage();
    flushSync();
    await tick();

    stale.width = 1200;
    stale.height = 800;
    stale.onload?.();
    flushSync();
    await tick();

    expect(hasCanvas(target)).toBe(false);
    expect(hasEmptyState(target)).toBe(true);
    // The cancelled load handed its URL back exactly once.
    expect(revoked).toEqual([created[0]!]);
  });

  test("submit waits for the host promise, then clears the draft and closes", async () => {
    let settle!: () => void;
    const gate = new Promise<void>((resolve) => {
      settle = resolve;
    });
    let closes = 0;
    const { target } = mountAnnotator({
      image: pngBlob(),
      onSubmit: () => gate,
      onClose: () => {
        closes += 1;
      },
    });
    await tick();
    await decodeImage(640, 480);
    typeComment(target, "รอผลก่อน");

    submitButton(target).click();
    flushSync();
    await tick();

    expect(submitButton(target).disabled).toBe(true);
    expect(submitButton(target).textContent?.trim()).toBe("UPLOADING...");
    expect(closes).toBe(0);
    expect(hasCanvas(target)).toBe(true);

    settle();
    for (let i = 0; i < 10 && closes === 0; i += 1) await tick();
    flushSync();

    expect(closes).toBe(1);
    expect(hasCanvas(target)).toBe(false);
    expect(commentInput(target).value).toBe("");
    expect(revoked).toEqual([created[0]!]);
  });

  test("a failed upload keeps the whole draft: image, strokes and comment", async () => {
    let closes = 0;
    const { target } = mountAnnotator({
      image: pngBlob(),
      onSubmit: () => Promise.reject(new Error("อัปโหลดไฟล์ไม่สำเร็จ")),
      onClose: () => {
        closes += 1;
      },
    });
    await tick();
    await decodeImage(1024, 768);

    const canvas = canvasOf(target);
    displayAt(canvas, { left: 0, top: 0, width: 1024, height: 768 });
    drawStrokeOn(canvas, [
      [10, 10],
      [50, 50],
    ]);
    typeComment(target, "ลองใหม่ได้");
    await tick();

    submitButton(target).click();
    for (let i = 0; i < 10 && closes === 0; i += 1) await tick();
    flushSync();

    expect(closes).toBe(0);
    expect(
      target.querySelector('[data-testid="image-annotator-error"]')?.textContent?.trim(),
    ).toBe("อัปโหลดไฟล์ไม่สำเร็จ");
    expect(hasCanvas(target)).toBe(true);
    expect(commentInput(target).value).toBe("ลองใหม่ได้");
    expect(
      target.querySelector<HTMLButtonElement>('[data-testid="image-annotator-undo"]')!.disabled,
    ).toBe(false);
    expect(submitButton(target).disabled).toBe(false);
    // Nothing was revoked: the same draft is still on screen, ready to retry.
    expect(revoked).toEqual([]);

    const ctx = contextOf(canvasOf(target));
    ctx.calls.length = 0;
    drawStrokeOn(canvasOf(target), [
      [1, 1],
      [9, 9],
    ]);
    await tick();
    // Both strokes replay: the one drawn before the failure and the new one.
    expect(pathsOf(ctx.calls).length).toBeGreaterThanOrEqual(2);
  });

  test("unmount hands the object URL back", async () => {
    const { app, target } = mountAnnotator({
      image: pngBlob(),
      onSubmit: () => {},
      onClose: () => {},
    });
    await tick();
    await decodeImage(320, 240);
    expect(revoked).toEqual([]);

    const entry = mounted.pop()!;
    unmount(app);
    entry.target.remove();
    flushSync();

    expect(revoked).toEqual([created[0]!]);
    expect(hasCanvas(target)).toBe(false);
  });

  test("Escape closes, and Enter with an image submits", async () => {
    let closes = 0;
    const submissions: Array<{ comment: string }> = [];
    const { target } = mountAnnotator({
      image: pngBlob(),
      onSubmit: (draft) => {
        submissions.push({ comment: draft.comment });
      },
      onClose: () => {
        closes += 1;
      },
    });
    await tick();

    await decodeImage(200, 100);
    typeComment(target, "ส่งด้วย Enter");
    commentInput(target).dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
    for (let i = 0; i < 10 && submissions.length === 0; i += 1) await tick();
    expect(submissions).toEqual([{ comment: "ส่งด้วย Enter" }]);

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    flushSync();
    expect(closes).toBeGreaterThanOrEqual(1);
  });
});
