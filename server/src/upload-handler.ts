/**
 * Turnkey upload endpoint — a fetch-style handler (works in Bun.serve, Hono,
 * or anything that speaks Request/Response). Receives multipart form-data
 * ("files" fields), stores them under `dir` with collision-proof sanitized
 * names, and returns { ok, files: [{ original, stored }] } — the shape
 * UploadAction and formatUploadMessage expect.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeStoredName, type UploadedFile } from "@thumbmux/core";

export type UploadHandlerOptions = {
  /** absolute or cwd-relative directory to store files in (created if absent) */
  dir: string;
  maxFiles?: number;      // default 10
  maxBytesPerFile?: number; // default 200 MB
};

export function createUploadHandler(opts: UploadHandlerOptions) {
  const maxFiles = opts.maxFiles ?? 10;
  const maxBytes = opts.maxBytesPerFile ?? 200 * 1024 * 1024;

  return async function handleUpload(req: Request): Promise<Response> {
    const form = await req.formData().catch(() => null);
    if (!form) return Response.json({ error: "expected multipart form-data" }, { status: 400 });
    // Structural file type — dodges the DOM/undici/bun `File` global clash.
    type UploadFile = { name: string; size: number; arrayBuffer(): Promise<ArrayBuffer> };
    const entries = form.getAll("files") as unknown as Array<string | UploadFile>;
    const files = entries.filter((f): f is UploadFile => typeof f !== "string" && typeof f?.arrayBuffer === "function");
    if (files.length === 0) return Response.json({ error: "no files" }, { status: 400 });
    if (files.length > maxFiles) return Response.json({ error: `max ${maxFiles} files` }, { status: 413 });

    await mkdir(opts.dir, { recursive: true });
    const stored: UploadedFile[] = [];
    for (const f of files) {
      if (f.size > maxBytes) return Response.json({ error: `"${f.name}" exceeds ${maxBytes} bytes` }, { status: 413 });
      const name = makeStoredName(f.name, Date.now(), Math.random().toString(36).slice(2, 8));
      await writeFile(join(opts.dir, name), new Uint8Array(await f.arrayBuffer()));
      stored.push({ original: f.name, stored: name });
    }
    return Response.json({ ok: true, files: stored }, { status: 201 });
  };
}
