import { afterAll, describe, expect, test } from "bun:test";
import { createPrefsHandler } from "../src/prefs-handler";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";

const DIR = `/tmp/thumbmux-prefs-test-${process.pid}`;
const FILE = `${DIR}/prefs.json`;
const handle = createPrefsHandler({ file: FILE });

afterAll(() => rmSync(DIR, { recursive: true, force: true }));

const put = (body: unknown) =>
  handle(new Request("http://x/api/prefs", { method: "PUT", body: JSON.stringify(body) }));
const get = () => handle(new Request("http://x/api/prefs"));

describe("createPrefsHandler", () => {
  test("GET and PUT preserve existing preferences on real Node", () => {
    const nodeDir = `${DIR}/node-runtime`;
    const nodeFile = `${nodeDir}/prefs.json`;
    const initial = {
      fontPx: 15,
      shortcuts: [{ id: "deploy", label: "deploy", send: "deploy" }],
    };
    const expected = { ...initial, fontPx: 16, theme: { mode: "dark" } };
    mkdirSync(nodeDir, { recursive: true });
    writeFileSync(nodeFile, `${JSON.stringify(initial)}\n`);

    const sourceUrl = new URL("../src/prefs-handler.ts", import.meta.url).href;
    const script = `
      import { readFile } from "node:fs/promises";
      import { createPrefsHandler } from ${JSON.stringify(sourceUrl)};

      const handle = createPrefsHandler({ file: ${JSON.stringify(nodeFile)} });
      const get = () => handle(new Request("http://x/api/prefs"));
      const getResponse = await get();
      const before = await getResponse.json();
      console.log(JSON.stringify({
        runtime: process.release.name,
        bun: typeof globalThis.Bun,
        status: getResponse.status,
        before,
      }));

      const put = await handle(new Request("http://x/api/prefs", {
        method: "PUT",
        body: JSON.stringify({ fontPx: 16, theme: { mode: "dark" } }),
      }));
      const after = await put.json();
      const disk = JSON.parse(await readFile(${JSON.stringify(nodeFile)}, "utf8"));
      console.log(JSON.stringify({ status: put.status, after, disk }));
    `;
    const result = spawnSync("node", ["--input-type=module", "--eval", script], {
      encoding: "utf8",
    });
    if (result.status !== 0) {
      throw new Error(
        `Node prefs subprocess exited ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
      );
    }

    const [readLine, writeLine] = result.stdout.trim().split("\n").map(JSON.parse);
    expect(readLine).toEqual({ runtime: "node", bun: "undefined", status: 200, before: initial });
    expect(writeLine).toEqual({ status: 200, after: expected, disk: expected });
  });

  test("GET before any save → {}", async () => {
    expect(await (await get()).json()).toEqual({});
  });

  test("PUT merge-patches and persists atomically", async () => {
    await put({ fontPx: 15, theme: { bg: "#101014" } });
    const r = await put({ fontPx: 16 });
    expect(await r.json()).toEqual({ fontPx: 16, theme: { bg: "#101014" } });
    expect(await (await get()).json()).toEqual({ fontPx: 16, theme: { bg: "#101014" } });
  });

  test("malformed JSON → 400; non-object → 400; huge → 413", async () => {
    const bad = await handle(new Request("http://x/", { method: "PUT", body: "{nope" }));
    expect(bad.status).toBe(400);
    const arr = await put([1, 2]);
    expect(arr.status).toBe(400);
    const huge = await handle(new Request("http://x/", { method: "PUT", body: `{"a":"${"x".repeat(300 * 1024)}"}` }));
    expect(huge.status).toBe(413);
  });

  test("null deletes a key (RFC 7386 style) — the only delete JSON can carry", async () => {
    await put({ toDelete: "x", keep: 1 });
    const r = await put({ toDelete: null });
    const saved = await r.json();
    expect("toDelete" in saved).toBe(false);
    expect(saved.keep).toBe(1);
    expect("toDelete" in (await (await get()).json())).toBe(false);
  });

  test("20 concurrent PUTs with distinct keys all survive (serialized writes)", async () => {
    await Promise.all(Array.from({ length: 20 }, (_, i) => put({ [`k${i}`]: i })));
    const final = await (await get()).json();
    for (let i = 0; i < 20; i++) expect(final[`k${i}`]).toBe(i);
  });

  test("other methods → 405", async () => {
    expect((await handle(new Request("http://x/", { method: "DELETE" }))).status).toBe(405);
  });
});
