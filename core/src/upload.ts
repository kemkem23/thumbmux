/**
 * Upload plumbing shared by client and server: safe stored names and the
 * composer prefill message. Pure — the actual I/O lives in
 * @thumbmux/server (createUploadHandler) and @thumbmux/svelte (UploadAction).
 */

export type UploadedFile = { original: string; stored: string };

/** Filesystem-safe stored name: path bits stripped, hostile chars collapsed,
 * length-capped, prefixed with a timestamp + entropy so names never collide. */
export function makeStoredName(original: string, now: number, entropy: string): string {
  const base = original.split(/[/\\]/).pop() ?? "file";
  const cleaned = base.replace(/[^\w.\-]+/g, "_").replace(/^[._]+/, "").slice(0, 80) || "file";
  return `${now}_${entropy}_${cleaned}`;
}

/** The message prefilled into the composer after an upload — one line per
 * file so a single SEND hands every path to the agent. */
export function formatUploadMessage(files: UploadedFile[], dir = "uploads"): string {
  return files.map((f) => `Uploaded "${f.original}" → ${dir}/${f.stored}`).join("\n");
}
