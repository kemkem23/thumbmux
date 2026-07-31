/**
 * Turnkey upload endpoint — a fetch-style handler (works in Bun.serve, Hono,
 * or anything that speaks Request/Response). Receives multipart form-data
 * ("files" fields), validates every decoded part before writing, then stores
 * each selected file under `dir` with collision-proof sanitized names
 * (all-or-nothing: a reject or mid-write failure leaves zero orphans from this
 * request). Returns
 * { ok, files: [{ original, stored }], dir } — the shape UploadAction and
 * formatUploadMessage expect.
 */
import { Buffer } from "node:buffer";
import { mkdir, open, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { makeStoredName, type UploadedFile } from "@thumbmux/core";

type MultipartFilePart = {
  name?: string;
  size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
};

function isMultipartFilePart(value: unknown): value is MultipartFilePart {
  return typeof value !== "string"
    && value !== null
    && typeof (value as MultipartFilePart).size === "number"
    && typeof (value as MultipartFilePart).arrayBuffer === "function";
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && (error as { code?: unknown }).code === "EEXIST";
}

async function openUniqueDestination(dir: string, original: string) {
  for (let attempt = 0; ; attempt += 1) {
    const random = Math.random().toString(36).slice(2, 8) || "0";
    const entropy = attempt === 0 ? random : `${random}-${attempt.toString(36)}`;
    const name = makeStoredName(original, Date.now(), entropy);
    const dest = join(dir, name);
    try {
      // Exclusive creation refuses both existing regular files and leaf symlinks.
      const handle = await open(dest, "wx");
      return { dest, handle, name };
    } catch (error) {
      if (isAlreadyExists(error)) continue;
      throw error;
    }
  }
}

export type UploadHandlerOptions = {
  /** absolute or cwd-relative directory to store files in (created if absent) */
  dir: string;
  maxFiles?: number;      // all file parts across all fields; default 10
  maxBytesPerFile?: number; // every file part; default 200 MB
  /**
   * Optional cap on decoded payload bytes across every part in one request.
   * String values count as UTF-8; file/blob values use their byte size. The
   * platform parses multipart data before these decoded values are available.
   * Default undefined = unlimited. When set and exceeded, rejects with 413
   * after the count and per-file checks (per-file wins).
   */
  maxTotalBytes?: number;
};

export function createUploadHandler(opts: UploadHandlerOptions) {
  const dir = resolve(opts.dir);
  const maxFiles = opts.maxFiles ?? 10;
  const maxBytes = opts.maxBytesPerFile ?? 200 * 1024 * 1024;
  const maxTotal = opts.maxTotalBytes;

  return async function handleUpload(req: Request): Promise<Response> {
    if (req.method !== "POST") {
      return Response.json(
        { error: "method not allowed" },
        { status: 405, headers: { Allow: "POST" } },
      );
    }

    const form = await req.formData().catch(() => null);
    if (!form) return Response.json({ error: "expected multipart form-data" }, { status: 400 });

    // FormData file values are structural to avoid DOM/undici/Bun `File` clashes.
    const parts = Array.from(form.values()) as unknown[];
    const allFileParts = parts.filter(isMultipartFilePart);
    if (allFileParts.length > maxFiles) {
      return Response.json({ error: `max ${maxFiles} files` }, { status: 413 });
    }

    // Validate every part before creating the directory or writing a byte.
    for (const f of allFileParts) {
      if (f.size > maxBytes) {
        const name = typeof f.name === "string" && f.name ? f.name : "file";
        return Response.json({ error: `"${name}" exceeds ${maxBytes} bytes` }, { status: 413 });
      }
    }

    const uploadParts = form.getAll("files") as unknown[];
    if (uploadParts.some((part) => isMultipartFilePart(part) && typeof part.name !== "string")) {
      return Response.json({ error: "invalid file part" }, { status: 400 });
    }
    const files = uploadParts
      .filter((part): part is MultipartFilePart & { name: string } => (
        isMultipartFilePart(part) && typeof part.name === "string"
      ));
    if (files.length === 0) return Response.json({ error: "no files" }, { status: 400 });

    if (maxTotal !== undefined) {
      let total = 0;
      for (const part of parts) {
        total += typeof part === "string"
          ? Buffer.byteLength(part, "utf8")
          : isMultipartFilePart(part) ? part.size : 0;
        if (total > maxTotal) {
          return Response.json({ error: `request total exceeds ${maxTotal} bytes` }, { status: 413 });
        }
      }
    }

    await mkdir(dir, { recursive: true });
    const stored: UploadedFile[] = [];
    const writtenPaths: string[] = [];
    try {
      for (const f of files) {
        const contents = new Uint8Array(await f.arrayBuffer());
        const { dest, handle, name } = await openUniqueDestination(dir, f.name);
        // The exclusive open establishes ownership before cleanup can touch it.
        writtenPaths.push(dest);
        try {
          await handle.writeFile(contents);
        } finally {
          // A close failure must not mask a write error; cleanup still owns dest.
          await handle.close().catch(() => {});
        }
        stored.push({ original: f.name, stored: name });
      }
    } catch (err) {
      // Cleanup must never throw or mask the original error.
      await Promise.allSettled(
        writtenPaths.map((p) => rm(p, { force: true }).catch(() => {})),
      );
      throw err;
    }
    return Response.json({ ok: true, files: stored, dir }, { status: 201 });
  };
}
