import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, rm, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { createUploadHandler } from "../src/upload-handler";
import { makeStoredName, formatUploadMessage } from "../../core/src/upload";

const DIR = `/tmp/thumbmux-upload-test-${Date.now()}`;
const CONFIGURED_DIR = relative(process.cwd(), DIR);
const handler = createUploadHandler({ dir: CONFIGURED_DIR, maxFiles: 2, maxBytesPerFile: 1024 });

function reqWith(files: Array<[string, string]>): Request {
  const form = new FormData();
  for (const [name, content] of files) form.append("files", new File([content], name));
  return new Request("http://x/api/upload", { method: "POST", body: form });
}

async function listDir(dir: string): Promise<string[]> {
  return readdir(dir).catch(() => []);
}

async function freshDir(tag: string): Promise<string> {
  const dir = `/tmp/thumbmux-upload-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return dir;
}

afterAll(async () => { await rm(DIR, { recursive: true, force: true }); });

describe("upload handler", () => {
  test("stores files and returns the storage directory with the original→stored mapping", async () => {
    const res = await handler(reqWith([["photo.png", "PNGDATA"], ["error.log", "boom"]]));
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.files.length).toBe(2);
    expect(data.files[0].original).toBe("photo.png");
    expect(typeof data.files[0].stored).toBe("string");
    expect(data.files[1].original).toBe("error.log");
    expect(typeof data.files[1].stored).toBe("string");
    const onDisk = await readdir(DIR);
    expect(onDisk).toContain(data.files[0].stored);
    const writtenPath = await realpath(join(DIR, data.files[0].stored));
    expect(data.dir).toBeTruthy();
    expect(data.dir).toBe(dirname(writtenPath));
    expect((await readFile(`${DIR}/${data.files[1].stored}`)).toString()).toBe("boom");
  });

  test("path traversal in filenames cannot escape the directory", async () => {
    const res = await handler(reqWith([["../../etc/passwd", "nope"]]));
    const data = await res.json();
    expect(data.files[0].stored).not.toContain("/");
    expect(data.files[0].stored).not.toContain("..");
    const onDisk = await readdir(DIR);
    expect(onDisk).toContain(data.files[0].stored);
  });

  test("enforces file-count and per-file size limits", async () => {
    expect((await handler(reqWith([["a", "1"], ["b", "2"], ["c", "3"]]))).status).toBe(413);
    expect((await handler(reqWith([["big.bin", "x".repeat(2048)]]))).status).toBe(413);
    expect((await handler(new Request("http://x", { method: "POST", body: "junk" }))).status).toBe(400);
  });

  test("stored-name sanitizer and composer message format", () => {
    expect(makeStoredName("../we ird/名前 file.png", 1000, "abc")).toBe("1000_abc_file.png");
    expect(formatUploadMessage([{ original: "a.png", stored: "1_x_a.png" }]))
      .toBe('Uploaded "a.png" → uploads/1_x_a.png');
  });

  test("all-or-nothing: 2 files, second oversized leaves zero on disk", async () => {
    const dir = await freshDir("aon-2");
    try {
      const h = createUploadHandler({ dir, maxBytesPerFile: 3 });
      const res = await h(reqWith([["a.txt", "ab"], ["b.txt", "too-big"]]));
      expect(res.status).toBe(413);
      const body = await res.json();
      expect(body.error).toBe('"b.txt" exceeds 3 bytes');
      expect(await listDir(dir)).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("all-or-nothing: 4 files, 3rd oversized leaves zero on disk", async () => {
    const dir = await freshDir("aon-4");
    try {
      const h = createUploadHandler({ dir, maxBytesPerFile: 3 });
      const res = await h(reqWith([
        ["one.txt", "ab"],
        ["two.txt", "cd"],
        ["three.txt", "overflow"],
        ["four.txt", "ef"],
      ]));
      expect(res.status).toBe(413);
      expect(await listDir(dir)).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("first-violation wins when multiple files are oversized", async () => {
    const dir = await freshDir("first-win");
    try {
      const h = createUploadHandler({ dir, maxBytesPerFile: 3 });
      const res = await h(reqWith([
        ["ok.txt", "ab"],
        ["big1.bin", "xxxx"],
        ["big2.bin", "yyyyyy"],
      ]));
      expect(res.status).toBe(413);
      const body = await res.json();
      expect(body.error).toBe('"big1.bin" exceeds 3 bytes');
      expect(await listDir(dir)).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("count limit writes nothing", async () => {
    const dir = await freshDir("count");
    try {
      const h = createUploadHandler({ dir, maxFiles: 2 });
      const res = await h(reqWith([["a", "1"], ["b", "2"], ["c", "3"]]));
      expect(res.status).toBe(413);
      const body = await res.json();
      expect(body.error).toBe("max 2 files");
      expect(await listDir(dir)).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("write failure mid-request cleans up and rethrows original error", async () => {
    const dir = await freshDir("write-fail");
    try {
      const h = createUploadHandler({ dir });
      const fakeReq = {
        formData: async () => ({
          getAll: () => [
            { name: "good.txt", size: 4, arrayBuffer: async () => new TextEncoder().encode("good").buffer },
            { name: "bad.txt", size: 4, arrayBuffer: async () => { throw new Error("boom"); } },
          ],
        }),
      } as unknown as Request;

      let caught: unknown;
      try {
        await h(fakeReq);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toBe("boom");
      expect(await listDir(dir)).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("cleanup never touches other files (sentinel + prior success)", async () => {
    const dir = await freshDir("sentinel");
    try {
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "sentinel.keep"), "keep-me");
      const h = createUploadHandler({ dir, maxBytesPerFile: 10 });

      const ok = await h(reqWith([["prior.txt", "ok"]]));
      expect(ok.status).toBe(201);
      const okData = await ok.json() as { files: Array<{ stored: string }> };
      const priorStored = okData.files[0].stored;

      const fail = await h(reqWith([["a.txt", "ab"], ["b.txt", "way-too-big"]]));
      expect(fail.status).toBe(413);

      const onDisk = await listDir(dir);
      expect(onDisk).toContain("sentinel.keep");
      expect(onDisk).toContain(priorStored);
      expect(onDisk.length).toBe(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("malformed part does not orphan previously-written files from this request", async () => {
    const dir = await freshDir("malformed");
    try {
      const h = createUploadHandler({ dir });
      const fakeReq = {
        formData: async () => ({
          getAll: () => [
            { name: "good.txt", size: 4, arrayBuffer: async () => new TextEncoder().encode("good").buffer },
            // Bun's multipart parser can hand back a nameless Blob for a zero-byte part.
            { name: undefined as unknown as string, size: 0, arrayBuffer: async () => new ArrayBuffer(0) },
          ],
        }),
      } as unknown as Request;

      let status: number | "threw" = "threw";
      try {
        const res = await h(fakeReq);
        status = res.status;
      } catch {
        status = "threw";
      }
      // Do not pin status/message — current code may throw; only the no-orphan invariant.
      expect(status).not.toBe(201);
      expect(await listDir(dir)).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("maxTotalBytes: unlimited by default; rejects over cap; per-file still wins", async () => {
    const content = "x".repeat(100);
    const parts: Array<[string, string]> = [
      ["a.bin", content],
      ["b.bin", content],
      ["c.bin", content],
    ];

    const dirOk = await freshDir("total-ok");
    try {
      const unlimited = createUploadHandler({ dir: dirOk, maxBytesPerFile: 200 });
      const res = await unlimited(reqWith(parts));
      expect(res.status).toBe(201);
      expect((await res.json()).files.length).toBe(3);
    } finally {
      await rm(dirOk, { recursive: true, force: true });
    }

    const dirCap = await freshDir("total-cap");
    try {
      const capped = createUploadHandler({ dir: dirCap, maxBytesPerFile: 200, maxTotalBytes: 250 });
      const res = await capped(reqWith(parts));
      expect(res.status).toBe(413);
      const body = await res.json();
      expect(body.error).toBe("request total exceeds 250 bytes");
      expect(await listDir(dirCap)).toEqual([]);
    } finally {
      await rm(dirCap, { recursive: true, force: true });
    }

    const dirPer = await freshDir("total-vs-per");
    try {
      // per-file max 50; total max 100; first file is already 100 → per-file wins
      const both = createUploadHandler({ dir: dirPer, maxBytesPerFile: 50, maxTotalBytes: 100 });
      const res = await both(reqWith([["big.bin", "x".repeat(100)], ["small.bin", "yy"]]));
      expect(res.status).toBe(413);
      const body = await res.json();
      expect(body.error).toBe('"big.bin" exceeds 50 bytes');
      expect(await listDir(dirPer)).toEqual([]);
    } finally {
      await rm(dirPer, { recursive: true, force: true });
    }
  });

  test("exact-boundary size equal to maxBytesPerFile is accepted", async () => {
    const dir = await freshDir("exact");
    try {
      const h = createUploadHandler({ dir, maxBytesPerFile: 5 });
      const res = await h(reqWith([["exact.txt", "12345"]]));
      expect(res.status).toBe(201);
      const data = await res.json();
      expect(data.files[0].original).toBe("exact.txt");
      const onDisk = await listDir(dir);
      expect(onDisk).toContain(data.files[0].stored);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
