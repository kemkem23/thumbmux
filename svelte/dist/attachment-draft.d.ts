/**
 * attachment-draft — internal helpers behind AttachmentDraftPicker (A20/A22)
 * and ImageAnnotator (A21).
 *
 * Not exported from the package barrel on purpose: the public surface is the
 * two components. Everything here is host-agnostic — no topic, no team, no
 * endpoint, no fetch. Object-URL and Image creation go through injectable
 * ports so the browser-only pieces (blob URLs, image decode, canvas export)
 * stay observable from a plain unit test instead of needing a real browser.
 *
 * The draft lives entirely in the tab: picking, pasting, drawing and removing
 * never touch the network. Turning a draft into an upload is the host's job.
 */
/** The two browser calls a draft needs; injected so tests can count them. */
export type ObjectUrlPorts = {
    createObjectURL: (blob: Blob) => string;
    revokeObjectURL: (url: string) => void;
};
/** Reads the globals at call time so a test stub installed later still wins. */
export declare function defaultObjectUrlPorts(): ObjectUrlPorts;
/** One pending attachment: the host's File plus the preview URL we own. */
export type AttachmentDraftItem = {
    /** Stable key for `{#each}`; unrelated to anything the host stores. */
    readonly id: string;
    readonly file: File;
    readonly name: string;
    /** Object URL created for this item — this module revokes it, nobody else. */
    readonly url: string;
    readonly isImage: boolean;
};
/** Unique within the tab; never sent anywhere. */
export declare function nextDraftId(): string;
/**
 * Clipboard images arrive as nameless Files. Mirrors the host's naming so a
 * pasted screenshot still reaches the server with a usable extension.
 */
export declare function draftFileName(file: File, index: number, now: number): string;
/** Badge text for non-image attachments: `report.pdf` → `PDF`. */
export declare function attachmentLabel(name: string): string;
/** Creates one item and, with it, the object URL that must later be revoked. */
export declare function createDraftItem(file: File, ports: ObjectUrlPorts, index?: number, now?: number): AttachmentDraftItem;
/** Builds a fresh list; every file gets its own preview URL. */
export declare function createDraftItems(files: readonly File[], ports: ObjectUrlPorts, now?: number): AttachmentDraftItem[];
/** Appends without disturbing (or re-creating URLs for) what is already there. */
export declare function appendDraftFiles(items: readonly AttachmentDraftItem[], files: readonly File[], ports: ObjectUrlPorts, now?: number): AttachmentDraftItem[];
/** Drops one item by id and revokes exactly that item's URL. */
export declare function removeDraftItem(items: readonly AttachmentDraftItem[], id: string, ports: ObjectUrlPorts): AttachmentDraftItem[];
/**
 * Re-seeds the list from a host-supplied `File[]`, keeping the URL of every
 * file that survives and revoking the ones that left. Identity match, so two
 * distinct File objects with the same name stay two separate attachments.
 */
export declare function syncDraftItems(items: readonly AttachmentDraftItem[], files: readonly File[], ports: ObjectUrlPorts, now?: number): AttachmentDraftItem[];
/** Revokes every URL the list owns. Call on clear and on unmount. */
export declare function releaseDraftItems(items: readonly AttachmentDraftItem[], ports: ObjectUrlPorts): void;
/** The plain `File[]` a host gets back — no ids, no URLs, no extra metadata. */
export declare function draftFilesOf(items: readonly AttachmentDraftItem[]): File[];
/** Keeps only what a picker configured with `accept`/`multiple` may take in. */
export declare function acceptableDraftFiles(files: readonly File[], options?: {
    accept?: string;
    multiple?: boolean;
}): File[];
/** Same grammar as the `accept` attribute: `image/*`, `.png`, `text/plain`. */
export declare function fileMatchesAccept(file: File, accept?: string): boolean;
/** Pulls image files out of a paste without reaching for the clipboard API. */
export declare function imageFilesFromClipboard(items: ReadonlyArray<{
    kind: string;
    type: string;
    getAsFile(): File | null;
}>): File[];
export type AnnotationPoint = {
    x: number;
    y: number;
};
export type AnnotationStroke = AnnotationPoint[];
/** White halo first, then the red-orange core — readable on any screenshot. */
export declare const ANNOTATION_HALO_COLOR = "rgba(255, 255, 255, 0.95)";
export declare const ANNOTATION_HALO_WIDTH = 9;
export declare const ANNOTATION_STROKE_COLOR = "#FF1744";
export declare const ANNOTATION_STROKE_WIDTH = 5;
/** The slice of a 2D context this module touches — easy to fake in a test. */
export interface AnnotationContext2DLike {
    lineCap: CanvasLineCap;
    lineJoin: CanvasLineJoin;
    lineWidth: number;
    strokeStyle: string | CanvasGradient | CanvasPattern;
    beginPath(): void;
    moveTo(x: number, y: number): void;
    lineTo(x: number, y: number): void;
    stroke(): void;
    clearRect(x: number, y: number, width: number, height: number): void;
    drawImage(image: CanvasImageSource, dx: number, dy: number, dw: number, dh: number): void;
}
/** Just enough of a canvas to size it, draw on it and export it. */
export interface AnnotationCanvasLike {
    width: number;
    height: number;
    getContext(contextId: '2d'): AnnotationContext2DLike | null;
    toBlob(callback: (blob: Blob | null) => void, type?: string): void;
    getBoundingClientRect(): {
        left: number;
        top: number;
        width: number;
        height: number;
    };
}
/**
 * Screen point → bitmap point. The canvas keeps the image's native pixel size
 * while CSS shrinks it to fit a phone, so every coordinate has to be scaled by
 * the bitmap/box ratio — otherwise the stroke lands somewhere else on export.
 */
export declare function canvasPointFromClient(rect: {
    left: number;
    top: number;
    width: number;
    height: number;
}, canvas: {
    width: number;
    height: number;
}, client: {
    clientX: number;
    clientY: number;
}): AnnotationPoint;
/** Draws one polyline; a single point is not a stroke yet, so it is skipped. */
export declare function drawAnnotationStroke(ctx: AnnotationContext2DLike, points: readonly AnnotationPoint[]): void;
/** Repaints the image then replays every stroke, committed and in-progress. */
export declare function renderAnnotation(ctx: AnnotationContext2DLike, image: unknown, width: number, height: number, strokes: readonly AnnotationStroke[], current?: readonly AnnotationPoint[]): void;
/** UNDO removes the last committed stroke only; the image itself stays. */
export declare function undoLastStroke(strokes: readonly AnnotationStroke[]): AnnotationStroke[];
/** A stroke is committed only when it actually went somewhere (2+ points). */
export declare function commitStroke(strokes: readonly AnnotationStroke[], current: readonly AnnotationPoint[]): AnnotationStroke[];
/** Exports the bitmap at whatever size the canvas currently is. */
export declare function canvasToPngBlob(canvas: AnnotationCanvasLike): Promise<Blob>;
/** The image surface we need; a real HTMLImageElement satisfies it at runtime. */
export interface AnnotationImageLike {
    width: number;
    height: number;
    onload: (() => void) | null;
    onerror: (() => void) | null;
    src: string;
}
export type AnnotationImagePorts = ObjectUrlPorts & {
    createImage: () => AnnotationImageLike;
};
export declare function defaultAnnotationImagePorts(): AnnotationImagePorts;
export type AnnotationImageHandlers = {
    onLoad: (image: AnnotationImageLike, url: string) => void;
    onError?: () => void;
};
export type AnnotationImageLoad = {
    /** Cancels the load; a decode that finishes later is dropped, not shown. */
    cancel: () => void;
    /** Revokes the URL once the loaded image is no longer displayed. */
    release: () => void;
};
/**
 * Loads a Blob into an Image and hands back the object URL that came with it.
 *
 * The stale guard is the point: an image whose decode finishes *after* the
 * user removed it must not resurrect the draft. `cancel()` marks the load dead
 * and gives the URL back immediately, and a late `onload` then finds itself
 * cancelled, revokes nothing twice, and calls no handler.
 */
export declare function loadAnnotationImage(blob: Blob, ports: AnnotationImagePorts, handlers: AnnotationImageHandlers): AnnotationImageLoad;
