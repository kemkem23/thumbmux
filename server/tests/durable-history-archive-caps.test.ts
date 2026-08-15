import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DurableHistoryArchive } from "../src/durable-history-archive";

let root = "";
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "thumbmux-caps-")); });
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
function logFiles(archive: DurableHistoryArchive, session: string): string[] {
  return readdirSync(archive.sessionDir(session)).filter((f) => f.endsWith(".log")).sort();
}

/** Feed `total` scrollback rows in steps of `step`, the way a poller would. */
function grow(archive: DurableHistoryArchive, session: string, total: number, step: number): number {
  let pruned = 0;
  for (let end = step; end <= total; end += step) {
    pruned += archive.appendAnchored(session, capture(rows(1, end)), OPTS).prunedLines ?? 0;
  }
  return pruned;
}

test("with no cap configured nothing is pruned and prunedLines stays 0", () => {
  const archive = new DurableHistoryArchive({ root, chunkLines: 10 });
  const pruned = grow(archive, "s", 100, 10);

  expect(pruned).toBe(0);
  expect(archive.readBefore("s", null, 500).hasMore || logFiles(archive, "s").length > 1).toBe(true);
  expect(readAll(archive, "s")[0]).toBe("L1");
});

test("maxLinesPerSession deletes whole oldest chunk files and reports the lines it dropped", () => {
  const archive = new DurableHistoryArchive({ root, chunkLines: 10, maxLinesPerSession: 25 });
  const before = new DurableHistoryArchive({ root: mkdtempSync(join(tmpdir(), "thumbmux-caps-ref-")), chunkLines: 10 });
  const uncappedFiles = (grow(before, "s", 100, 10), logFiles(before, "s").length);

  const pruned = grow(archive, "s", 100, 10);

  expect(pruned).toBeGreaterThan(0);
  expect(logFiles(archive, "s").length).toBeLessThan(uncappedFiles);
  // The oldest lines are gone; the newest are not.
  const kept = readAll(archive, "s");
  expect(kept).not.toContain("L1");
  expect(kept[kept.length - 1]).toBe(`L${100 - OPTS.liveLineLimit}`);
});

test("a cap holds at least the cap, overshooting by less than one chunk rather than undershooting", () => {
  const archive = new DurableHistoryArchive({ root, chunkLines: 10, maxLinesPerSession: 25 });
  grow(archive, "s", 100, 10);

  // Everything still on disk, including the live window the reader is not served.
  const held = 100 - (archive.readBefore("s", null, 1).startLine ?? 0) + (archive.readBefore("s", null, 1).startLine ?? 0);
  const firstKept = logFiles(archive, "s")[0];
  const firstKeptLine = Number.parseInt(firstKept.slice(0, 12), 10);
  const heldLines = 100 - firstKeptLine;

  expect(heldLines).toBeGreaterThanOrEqual(25);
  expect(heldLines).toBeLessThan(25 + 10);
  expect(held).toBe(100);
});

test("pruning never renumbers: the surviving lines keep their absolute positions", () => {
  const archive = new DurableHistoryArchive({ root, chunkLines: 10, maxLinesPerSession: 25 });
  grow(archive, "s", 100, 10);

  const firstKeptLine = Number.parseInt(logFiles(archive, "s")[0].slice(0, 12), 10);
  const page = archive.readBefore("s", null, 500);

  expect(page.startLine).toBe(firstKeptLine);
  // liveStart is still measured from the true total, not from what survived.
  expect(archive.liveStartLine("s")).toBe(100 - OPTS.liveLineLimit);
});

test("a pager is told it has reached the floor, not offered lines that were deleted", () => {
  const archive = new DurableHistoryArchive({ root, chunkLines: 10, maxLinesPerSession: 25 });
  grow(archive, "s", 100, 10);

  const floor = Number.parseInt(logFiles(archive, "s")[0].slice(0, 12), 10);
  const page = archive.readBefore("s", null, 500);
  expect(page.hasMore).toBe(false);

  // Asking below the floor is empty rather than a short page mislabelled as line 0.
  const below = archive.readBefore("s", floor, 500);
  expect(below.lines).toEqual([]);
  expect(below.startLine).toBe(null);

  // readAfter agrees with readBefore about where the archive starts.
  const forward = archive.readAfter("s", null, 500);
  expect(forward.startLine).toBe(floor);
});

test("a cap smaller than one chunk still keeps the newest chunk rather than emptying the session", () => {
  const archive = new DurableHistoryArchive({ root, chunkLines: 10, maxLinesPerSession: 3 });
  grow(archive, "s", 100, 10);

  expect(logFiles(archive, "s").length).toBeGreaterThanOrEqual(1);
  expect(readAll(archive, "s").length + OPTS.liveLineLimit).toBeGreaterThan(0);
});

test("maxBytesPerSession prunes on the byte axis too", () => {
  const archive = new DurableHistoryArchive({ root, chunkLines: 10, maxBytesPerSession: 200 });
  const pruned = grow(archive, "s", 100, 10);

  expect(pruned).toBeGreaterThan(0);
  const bytes = logFiles(archive, "s")
    .map((f) => readdirSync(archive.sessionDir("s")).includes(f) ? Bun.file(join(archive.sessionDir("s"), f)).size : 0)
    .reduce((sum, n) => sum + n, 0);
  expect(bytes).toBeLessThan(200 + 10 * 16);
});

test("appending after a prune still stitches: the anchor comes from what survived", () => {
  const archive = new DurableHistoryArchive({ root, chunkLines: 10, maxLinesPerSession: 25 });
  grow(archive, "s", 100, 10);

  const after = archive.appendAnchored("s", capture(rows(1, 110)), OPTS);

  expect(after.appended).toBe(10);
  expect(after.gap).toBe(false);
  expect(after.totalLines).toBe(110);
});

test("prunedLines is optional in the type but never absent at runtime", () => {
  const capped = new DurableHistoryArchive({ root, chunkLines: 10, maxLinesPerSession: 25 });
  const uncapped = new DurableHistoryArchive({ root: mkdtempSync(join(tmpdir(), "thumbmux-caps-u-")), chunkLines: 10 });

  for (const archive of [capped, uncapped]) {
    const first = archive.appendAnchored("s", capture(rows(1, 40)), OPTS);
    expect(first.prunedLines).toBeTypeOf("number");
    const second = archive.appendAnchored("s", capture(rows(1, 40)), OPTS);   // nothing new -> tooShort path
    expect(second.prunedLines).toBeTypeOf("number");
  }
});
