/**
 * createPrefsHandler — a tiny "config file" REST endpoint for viewer
 * preferences (theme, font, shortcuts…): GET returns the JSON file,
 * PUT/POST merge-patches it (null deletes a key — RFC 7386 style) with an
 * atomic tmp+rename write, so a crash mid-save never leaves a torn file
 * (the very last save may be lost on power failure — prefs are cheap).
 * Writes are serialized per handler instance: concurrent PUTs from two
 * devices merge in order instead of losing updates.
 */
import { mergePrefs, type ThumbmuxPrefs } from "@thumbmux/core";
import { mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";

const MAX_BYTES = 256 * 1024; // prefs are small; anything bigger is a bug

export function createPrefsHandler(opts: { file: string }) {
  const { file } = opts;
  let seq = 0;
  let chain: Promise<unknown> = Promise.resolve();
  /** promise-chain mutex — the read-merge-write-rename section must never
   * interleave (two concurrent PUTs both reading the old file = lost update;
   * a shared tmp path = torn file). */
  function serialized<T>(fn: () => Promise<T>): Promise<T> {
    const p = chain.then(fn, fn);
    chain = p.then(() => {}, () => {});
    return p;
  }

  async function read(): Promise<ThumbmuxPrefs> {
    try {
      const data = await Bun.file(file).json();
      return data && typeof data === "object" && !Array.isArray(data) ? data : {};
    } catch {
      return {}; // missing or unparsable → start fresh
    }
  }

  return async function handlePrefs(req: Request): Promise<Response> {
    if (req.method === "GET") {
      return Response.json(await read());
    }
    if (req.method === "PUT" || req.method === "POST") {
      const body = await req.text();
      if (body.length > MAX_BYTES) {
        return Response.json({ error: "prefs too large" }, { status: 413 });
      }
      let patch: unknown;
      try { patch = JSON.parse(body); } catch {
        return Response.json({ error: "invalid JSON" }, { status: 400 });
      }
      if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
        return Response.json({ error: "prefs patch must be a JSON object" }, { status: 400 });
      }
      const next = await serialized(async () => {
        const merged = mergePrefs(await read(), patch as Partial<ThumbmuxPrefs>);
        mkdirSync(dirname(file), { recursive: true });
        const tmp = `${file}.tmp-${process.pid}-${++seq}`;
        await Bun.write(tmp, JSON.stringify(merged, null, 2) + "\n");
        renameSync(tmp, file);
        return merged;
      });
      return Response.json(next);
    }
    return Response.json({ error: "method not allowed" }, { status: 405 });
  };
}
