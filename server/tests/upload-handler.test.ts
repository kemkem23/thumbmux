import { afterAll, describe, expect, test } from "bun:test";
import { rm, readdir, readFile } from "node:fs/promises";
import { createUploadHandler } from "../src/upload-handler";
import { makeStoredName, formatUploadMessage } from "../../core/src/upload";

const DIR = `/tmp/thumbmux-upload-test-${Date.now()}`;
const handler = createUploadHandler({ dir: DIR, maxFiles: 2, maxBytesPerFile: 1024 });

function reqWith(files: Array<[string, string]>): Request {
  const form = new FormData();
  for (const [name, content] of files) form.append("files", new File([content], name));
  return new Request("http://x/api/upload", { method: "POST", body: form });
}

afterAll(async () => { await rm(DIR, { recursive: true, force: true }); });

describe("upload handler", () => {
  test("stores files and returns the original→stored mapping", async () => {
    const res = await handler(reqWith([["photo.png", "PNGDATA"], ["error.log", "boom"]]));
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.files.length).toBe(2);
    expect(data.files[0].original).toBe("photo.png");
    const onDisk = await readdir(DIR);
    expect(onDisk).toContain(data.files[0].stored);
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
});
