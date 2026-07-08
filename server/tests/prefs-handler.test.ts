import { afterAll, describe, expect, test } from "bun:test";
import { createPrefsHandler } from "../src/prefs-handler";
import { rmSync } from "node:fs";

const DIR = `/tmp/thumbmux-prefs-test-${process.pid}`;
const FILE = `${DIR}/prefs.json`;
const handle = createPrefsHandler({ file: FILE });

afterAll(() => rmSync(DIR, { recursive: true, force: true }));

const put = (body: unknown) =>
  handle(new Request("http://x/api/prefs", { method: "PUT", body: JSON.stringify(body) }));
const get = () => handle(new Request("http://x/api/prefs"));

describe("createPrefsHandler", () => {
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
