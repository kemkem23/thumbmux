/**
 * Turnkey upload endpoint — a fetch-style handler (works in Bun.serve, Hono,
 * or anything that speaks Request/Response). Receives multipart form-data
 * ("files" fields), validates the whole request first, then stores every file
 * under `dir` with collision-proof sanitized names (all-or-nothing: a reject
 * or mid-write failure leaves zero orphans from this request). Returns
 * { ok, files: [{ original, stored }] } — the shape UploadAction and
 * formatUploadMessage expect.
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeStoredName, type UploadedFile } from "@thumbmux/core";

export type UploadHandlerOptions = {
  /** absolute or cwd-relative directory to store files in (created if absent) */
  dir: string;
  maxFiles?: number;      // default 10
  maxBytesPerFile?: number; // default 200 MB
  /**
   * Optional cap on the sum of all part sizes in one request.
   * Default undefined = unlimited (today's behaviour). When set and exceeded,
   * rejects with 413 after the count and per-file checks (per-file wins).
   */
  maxTotalBytes?: number;
};

export function createUploadHandler(opts: UploadHandlerOptions) {
  const maxFiles = opts.maxFiles ?? 10;
  const maxBytes = opts.maxBytesPerFile ?? 200 * 1024 * 1024;
  const maxTotal = opts.maxTotalBytes;

  return async function handleUpload(req: Request): Promise<Response> {
    const form = await req.formData().catch(() => null);
    if (!form) return Response.json({ error: "expected multipart form-data" }, { status: 400 });
    // Structural file type — dodges the DOM/undici/bun `File` global clash.
    type UploadFile = { name: string; size: number; arrayBuffer(): Promise<ArrayBuffer> };
    const entries = form.getAll("files") as unknown as Array<string | UploadFile>;
    const files = entries.filter((f): f is UploadFile => typeof f !== "string" && typeof f?.arrayBuffer === "function");
    if (files.length === 0) return Response.json({ error: "no files" }, { status: 400 });
    if (files.length > maxFiles) return Response.json({ error: `max ${maxFiles} files` }, { status: 413 });

    // Validate every part before creating the directory or writing a byte.
    for (const f of files) {
      if (f.size > maxBytes) {
        return Response.json({ error: `"${f.name}" exceeds ${maxBytes} bytes` }, { status: 413 });
      }
    }
    if (maxTotal !== undefined) {
      let total = 0;
      for (const f of files) total += f.size;
      if (total > maxTotal) {
        return Response.json({ error: `request total exceeds ${maxTotal} bytes` }, { status: 413 });
      }
    }

    await mkdir(opts.dir, { recursive: true });
    const stored: UploadedFile[] = [];
    const writtenPaths: string[] = [];
    try {
      for (const f of files) {
        const name = makeStoredName(f.name, Date.now(), Math.random().toString(36).slice(2, 8));
        const dest = join(opts.dir, name);
        // Record before await so a half-written file is cleaned up too.
        writtenPaths.push(dest);
        await writeFile(dest, new Uint8Array(await f.arrayBuffer()));
        stored.push({ original: f.name, stored: name });
      }
    } catch (err) {
      // Cleanup must never throw or mask the original error.
      await Promise.allSettled(
        writtenPaths.map((p) => rm(p, { force: true }).catch(() => {})),
      );
      throw err;
    }
    return Response.json({ ok: true, files: stored }, { status: 201 });
  };
}
