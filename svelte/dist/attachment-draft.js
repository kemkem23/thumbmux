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
/** Reads the globals at call time so a test stub installed later still wins. */
export function defaultObjectUrlPorts() {
    return {
        createObjectURL: (blob) => URL.createObjectURL(blob),
        revokeObjectURL: (url) => URL.revokeObjectURL(url),
    };
}
let draftIdCounter = 0;
/** Unique within the tab; never sent anywhere. */
export function nextDraftId() {
    draftIdCounter += 1;
    return `draft-${draftIdCounter.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
/**
 * Clipboard images arrive as nameless Files. Mirrors the host's naming so a
 * pasted screenshot still reaches the server with a usable extension.
 */
export function draftFileName(file, index, now) {
    if (file.name)
        return file.name;
    const subtype = file.type.split('/')[1];
    return `pasted-${now}-${index}.${subtype && subtype.length > 0 ? subtype : 'png'}`;
}
/** Badge text for non-image attachments: `report.pdf` → `PDF`. */
export function attachmentLabel(name) {
    const ext = name.split('.').pop()?.trim();
    return ext && ext !== name ? ext.slice(0, 4).toUpperCase() : 'FILE';
}
/** Creates one item and, with it, the object URL that must later be revoked. */
export function createDraftItem(file, ports, index = 0, now = Date.now()) {
    const name = draftFileName(file, index, now);
    return {
        id: nextDraftId(),
        file,
        name,
        url: ports.createObjectURL(file),
        isImage: file.type.startsWith('image/'),
    };
}
/** Builds a fresh list; every file gets its own preview URL. */
export function createDraftItems(files, ports, now = Date.now()) {
    return files.map((file, index) => createDraftItem(file, ports, index, now));
}
/** Appends without disturbing (or re-creating URLs for) what is already there. */
export function appendDraftFiles(items, files, ports, now = Date.now()) {
    if (files.length === 0)
        return items;
    return [...items, ...files.map((file, index) => createDraftItem(file, ports, index, now))];
}
/** Drops one item by id and revokes exactly that item's URL. */
export function removeDraftItem(items, id, ports) {
    const doomed = items.find((item) => item.id === id);
    if (!doomed)
        return items;
    ports.revokeObjectURL(doomed.url);
    return items.filter((item) => item.id !== id);
}
/**
 * Re-seeds the list from a host-supplied `File[]`, keeping the URL of every
 * file that survives and revoking the ones that left. Identity match, so two
 * distinct File objects with the same name stay two separate attachments.
 */
export function syncDraftItems(items, files, ports, now = Date.now()) {
    const spare = [...items];
    const next = [];
    files.forEach((file, index) => {
        const keptAt = spare.findIndex((item) => item.file === file);
        if (keptAt >= 0) {
            next.push(spare[keptAt]);
            spare.splice(keptAt, 1);
            return;
        }
        next.push(createDraftItem(file, ports, index, now));
    });
    for (const dropped of spare)
        ports.revokeObjectURL(dropped.url);
    return next;
}
/** Revokes every URL the list owns. Call on clear and on unmount. */
export function releaseDraftItems(items, ports) {
    for (const item of items)
        ports.revokeObjectURL(item.url);
}
/** The plain `File[]` a host gets back — no ids, no URLs, no extra metadata. */
export function draftFilesOf(items) {
    return items.map((item) => item.file);
}
/** Keeps only what a picker configured with `accept`/`multiple` may take in. */
export function acceptableDraftFiles(files, options = {}) {
    const matching = files.filter((file) => fileMatchesAccept(file, options.accept));
    if (options.multiple === false)
        return matching.slice(0, 1);
    return matching;
}
/** Same grammar as the `accept` attribute: `image/*`, `.png`, `text/plain`. */
export function fileMatchesAccept(file, accept) {
    if (!accept)
        return true;
    const patterns = accept
        .split(',')
        .map((pattern) => pattern.trim().toLowerCase())
        .filter((pattern) => pattern.length > 0);
    if (patterns.length === 0)
        return true;
    const type = file.type.toLowerCase();
    const name = file.name.toLowerCase();
    return patterns.some((pattern) => {
        if (pattern.startsWith('.'))
            return name.endsWith(pattern);
        if (pattern.endsWith('/*'))
            return type.startsWith(`${pattern.slice(0, -1)}`);
        return type === pattern;
    });
}
/** Pulls image files out of a paste without reaching for the clipboard API. */
export function imageFilesFromClipboard(items) {
    const found = [];
    for (const item of items) {
        if (item.kind !== 'file')
            continue;
        if (!item.type.startsWith('image/'))
            continue;
        const file = item.getAsFile();
        if (file)
            found.push(file);
    }
    return found;
}
/** White halo first, then the red-orange core — readable on any screenshot. */
export const ANNOTATION_HALO_COLOR = 'rgba(255, 255, 255, 0.95)';
export const ANNOTATION_HALO_WIDTH = 9;
export const ANNOTATION_STROKE_COLOR = '#FF1744';
export const ANNOTATION_STROKE_WIDTH = 5;
/**
 * Screen point → bitmap point. The canvas keeps the image's native pixel size
 * while CSS shrinks it to fit a phone, so every coordinate has to be scaled by
 * the bitmap/box ratio — otherwise the stroke lands somewhere else on export.
 */
export function canvasPointFromClient(rect, canvas, client) {
    const scaleX = rect.width > 0 ? canvas.width / rect.width : 1;
    const scaleY = rect.height > 0 ? canvas.height / rect.height : 1;
    return {
        x: (client.clientX - rect.left) * scaleX,
        y: (client.clientY - rect.top) * scaleY,
    };
}
/** Draws one polyline; a single point is not a stroke yet, so it is skipped. */
export function drawAnnotationStroke(ctx, points) {
    if (points.length < 2)
        return;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i += 1) {
        ctx.lineTo(points[i].x, points[i].y);
    }
    ctx.strokeStyle = ANNOTATION_HALO_COLOR;
    ctx.lineWidth = ANNOTATION_HALO_WIDTH;
    ctx.stroke();
    ctx.strokeStyle = ANNOTATION_STROKE_COLOR;
    ctx.lineWidth = ANNOTATION_STROKE_WIDTH;
    ctx.stroke();
}
/** Repaints the image then replays every stroke, committed and in-progress. */
export function renderAnnotation(ctx, image, width, height, strokes, current = []) {
    ctx.drawImage(image, 0, 0, width, height);
    for (const stroke of strokes)
        drawAnnotationStroke(ctx, stroke);
    drawAnnotationStroke(ctx, current);
}
/** UNDO removes the last committed stroke only; the image itself stays. */
export function undoLastStroke(strokes) {
    if (strokes.length === 0)
        return strokes;
    return strokes.slice(0, -1);
}
/** A stroke is committed only when it actually went somewhere (2+ points). */
export function commitStroke(strokes, current) {
    if (current.length < 2)
        return strokes;
    return [...strokes, [...current]];
}
/** Exports the bitmap at whatever size the canvas currently is. */
export function canvasToPngBlob(canvas) {
    return new Promise((resolve, reject) => {
        canvas.toBlob((blob) => {
            if (blob)
                resolve(blob);
            else
                reject(new Error('canvas.toBlob returned no image'));
        }, 'image/png');
    });
}
export function defaultAnnotationImagePorts() {
    return {
        ...defaultObjectUrlPorts(),
        createImage: () => new Image(),
    };
}
/**
 * Loads a Blob into an Image and hands back the object URL that came with it.
 *
 * The stale guard is the point: an image whose decode finishes *after* the
 * user removed it must not resurrect the draft. `cancel()` marks the load dead
 * and gives the URL back immediately, and a late `onload` then finds itself
 * cancelled, revokes nothing twice, and calls no handler.
 */
export function loadAnnotationImage(blob, ports, handlers) {
    const url = ports.createObjectURL(blob);
    const image = ports.createImage();
    let cancelled = false;
    let settled = false;
    let revoked = false;
    const revoke = () => {
        if (revoked)
            return;
        revoked = true;
        ports.revokeObjectURL(url);
    };
    image.onload = () => {
        settled = true;
        if (cancelled) {
            revoke();
            return;
        }
        handlers.onLoad(image, url);
    };
    image.onerror = () => {
        settled = true;
        revoke();
        if (cancelled)
            return;
        handlers.onError?.();
    };
    image.src = url;
    return {
        cancel: () => {
            if (cancelled)
                return;
            cancelled = true;
            if (!settled)
                revoke();
        },
        release: revoke,
    };
}
