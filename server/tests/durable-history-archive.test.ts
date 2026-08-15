import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DurableHistoryArchive, isHistoryMarker } from "../src/durable-history-archive";

let root = "";
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "thumbmux-durable-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const SCREEN = ["+--+", "| >", "+--+", "hints", "tokens"];
const OPTS = { paneRows: SCREEN.length, liveLineLimit: 10 };

function capture(scrollback: string[]) { return [...scrollback, ...SCREEN]; }
function rows(from: number, to: number) {
  const out: string[] = [];
  for (let index = from; index <= to; index++) out.push(`L${index}`);
  return out;
}
function readAll(archive: DurableHistoryArchive, session: string): string[] {
  const lines: string[] = [];
  let before: number | null = null;
  for (;;) {
    const page = archive.readBefore(session, before, 500);
    if (page.lines.length === 0 || page.startLine === null) break;
    lines.unshift(...page.lines);
    if (!page.hasMore) break;
    before = page.startLine;
  }
  return lines;
}

test("the live window is stored, and reported separately from the end of the archive", () => {
  const archive = new DurableHistoryArchive({ root });
  const result = archive.appendAnchored("s", capture(rows(1, 30)), OPTS);

  // 35 captured rows, 5 of them still repaintable screen
  expect(result.appended).toBe(30);
  expect(result.totalLines).toBe(30);
  // the newest 10 stored lines are what the mux is still serving live
  expect(result.liveStartLine).toBe(20);
  expect(archive.liveStartLine("s")).toBe(20);
});

test("a second capture appends only what is new", () => {
  const archive = new DurableHistoryArchive({ root });
  archive.appendAnchored("s", capture(rows(1, 30)), OPTS);
  const second = archive.appendAnchored("s", capture(rows(1, 36)), OPTS);

  expect(second.appended).toBe(6);
  expect(second.totalLines).toBe(36);
});

test("history the viewer still shows is durable, but is not served as history", () => {
  // The whole point: at the last tmux server death every session's newest
  // thousand lines existed nowhere else. They are stored now — and still kept
  // out of `readBefore`, or a viewer scrolling up would see them twice.
  const archive = new DurableHistoryArchive({ root });
  archive.appendAnchored("s", capture(rows(1, 30)), OPTS);

  expect(readAll(archive, "s")).toEqual(rows(1, 20));
  const reopened = new DurableHistoryArchive({ root });
  expect(reopened.readAfter("s", 19, 500).lines).toEqual([]);
  expect(reopened.liveStartLine("s")).toBe(20);
});

test("a lost thread records a marker in the history itself", () => {
  const archive = new DurableHistoryArchive({ root });
  archive.appendAnchored("s", capture(rows(1, 30)), OPTS);
  const jumped = archive.appendAnchored("s", capture(rows(900, 930)), OPTS);

  expect(jumped.gap).toBe(true);
  expect(readAll(archive, "s").some((line) => isHistoryMarker(line))).toBe(true);
});

test("a marker never becomes the anchor, so one gap cannot breed another", () => {
  const archive = new DurableHistoryArchive({ root });
  archive.appendAnchored("s", capture(rows(1, 30)), OPTS);
  archive.appendAnchored("s", capture(rows(900, 930)), OPTS);   // writes one marker
  const resumed = archive.appendAnchored("s", capture(rows(900, 934)), OPTS);

  expect(resumed.gap).toBe(false);
  expect(resumed.appended).toBe(4);
});

test("an archive that has caught up appends nothing and calls it no gap", () => {
  const archive = new DurableHistoryArchive({ root });
  archive.appendAnchored("s", capture(rows(1, 30)), OPTS);
  const again = archive.appendAnchored("s", capture(rows(1, 30)), OPTS);

  expect(again.appended).toBe(0);
  expect(again.gap).toBe(false);
  expect(again.deferred).toBe(false);
});

test("history is plain text a shell can read, grouped by the host's label", () => {
  const archive = new DurableHistoryArchive({ root, group: () => "my-topic" });
  archive.appendAnchored("cc-demo", capture(["hello", "[31mred[0m"]), OPTS);

  const dir = join(root, "my-topic", "cc-demo");
  const chunk = readdirSync(dir).find((name) => name.endsWith(".log"))!;
  expect(chunk).toBe("000000000000.log");
  const text = readFileSync(join(dir, chunk), "utf8");
  expect(text.split("\n")[0]).toBe("hello");
  expect(text).toContain("[31mred[0m");
});

test("the index and meta are caches: deleting them costs nothing", () => {
  const archive = new DurableHistoryArchive({ root, group: () => "g", chunkLines: 8 });
  for (let batch = 0; batch < 3; batch++) {
    archive.appendAnchored("s", capture(rows(1, 10 + batch * 10)), OPTS);
  }
  const before = readAll(archive, "s");
  expect(before.length).toBeGreaterThan(0);

  rmSync(join(root, "g", "s", "index.jsonl"), { force: true });
  rmSync(join(root, "g", "s", "meta.json"), { force: true });
  const reopened = new DurableHistoryArchive({ root, group: () => "g", chunkLines: 8 });

  // liveStart is meta-only, so a rescan serves everything it holds; no line is lost
  expect(reopened.readBefore("s", null, 500).lines.length).toBeGreaterThanOrEqual(before.length);
});

test("a line torn by a power cut is dropped, and the rest survives", () => {
  const archive = new DurableHistoryArchive({ root, group: () => "g" });
  archive.appendAnchored("s", capture(rows(1, 30)), OPTS);

  const chunk = join(root, "g", "s", "000000000000.log");
  writeFileSync(chunk, `${readFileSync(chunk, "utf8")}partial-write-no-newline`);
  const reopened = new DurableHistoryArchive({ root, group: () => "g" });

  // the torn remains are gone, and nothing else moved
  expect(reopened.readBefore("s", null, 500).lines).toEqual(rows(1, 20));
});

test("a session name that is not path-safe cannot escape its root", () => {
  const archive = new DurableHistoryArchive({ root, group: () => "g" });

  // "." and ".." are made entirely of allowed characters, so they survive
  // character filtering and have to be rejected by name.
  for (const hostile of ["../../escape", "..", ".", "/etc/passwd"]) {
    const dir = archive.sessionDir(hostile);
    expect(resolve(dir).startsWith(resolve(join(root, "g")) + "/")).toBe(true);
    expect(dir.split("/").every((segment) => segment !== ".." && segment !== ".")).toBe(true);
  }
});
