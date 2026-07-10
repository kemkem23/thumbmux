import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileHistoryArchive, type HistoryPage } from "./history-archive";

const roots: string[] = [];

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function makeArchive(maxLines = 10_000): { archive: FileHistoryArchive; root: string } {
  const root = mkdtempSync(join(tmpdir(), "thumbmux-history-test-"));
  roots.push(root);
  return { archive: new FileHistoryArchive({ root, maxLines }), root };
}

function capture(from: number, until: number): string {
  return Array.from({ length: until - from }, (_, index) => `line-${from + index}`).join("\n");
}

function ingest(archive: FileHistoryArchive, session: string, content: string, fullHistory: boolean, liveLineLimit: number) {
  return archive.ingestSnapshot(session, content, {
    previousContent: null,
    fullHistory,
    liveLineLimit,
  });
}

function page(archive: FileHistoryArchive, session: string, beforeLine: number | null, limit = 10_000): HistoryPage {
  return archive.readBefore(session, beforeLine, limit);
}

describe("FileHistoryArchive", () => {
  test("splits a 4,000+ line initial history into archive and live windows", () => {
    const { archive } = makeArchive();
    const content = capture(0, 4_004);

    expect(ingest(archive, "alpha", content, true, 400).liveContent).toBe(capture(3_604, 4_004));
    const result = page(archive, "alpha", null);
    expect(result.lines).toHaveLength(3_604);
    expect(result.lines[0]).toBe("line-0");
    expect(result.lines.at(-1)).toBe("line-3603");
    expect(result.startLine).toBe(0);
    expect(result.hasMore).toBe(false);
  });

  test("uses stable overlap so shifted snapshots archive each departed line once", () => {
    const { archive } = makeArchive();
    ingest(archive, "alpha", capture(0, 8), true, 4);
    ingest(archive, "alpha", capture(6, 10), false, 4);
    ingest(archive, "alpha", capture(6, 10), false, 4);

    const result = page(archive, "alpha", null);
    expect(result.lines).toEqual(capture(0, 6).split("\n"));
    expect(result.startLine).toBe(0);
    expect(result.hasMore).toBe(false);
  });

  test("evicts the oldest archived records at a deterministic per-session cap", () => {
    const { archive } = makeArchive(5);
    ingest(archive, "alpha", capture(0, 12), true, 2);
    ingest(archive, "alpha", capture(11, 13), false, 2);

    const result = page(archive, "alpha", null);
    expect(result.lines).toEqual(capture(6, 11).split("\n"));
    expect(result.startLine).toBe(6);
    expect(result.hasMore).toBe(false);
  });

  test("reads page boundaries in display order and reports whether earlier data remains", () => {
    const { archive } = makeArchive();
    ingest(archive, "alpha", capture(0, 20), true, 4);

    expect(page(archive, "alpha", null, 5)).toEqual({
      lines: capture(11, 16).split("\n"),
      startLine: 11,
      hasMore: true,
    });
    expect(page(archive, "alpha", 11, 20)).toEqual({
      lines: capture(0, 11).split("\n"),
      startLine: 0,
      hasMore: false,
    });
    expect(page(archive, "alpha", 0)).toEqual({ lines: [], startLine: null, hasMore: false });
  });

  test("recovers persisted state after restart and preserves logical line numbering", () => {
    const { archive, root } = makeArchive();
    ingest(archive, "alpha", capture(0, 12), true, 4);

    const restarted = new FileHistoryArchive({ root });
    expect(page(restarted, "alpha", null).lines).toEqual(capture(0, 8).split("\n"));
    expect(ingest(restarted, "alpha", capture(9, 13), false, 4).liveContent).toBe(capture(9, 13));
    const result = page(restarted, "alpha", null);
    expect(result.lines).toEqual(capture(0, 9).split("\n"));
    expect(result.startLine).toBe(0);
  });

  test("renames persisted archive state without retaining the old session key", () => {
    const { archive, root } = makeArchive();
    ingest(archive, "alpha", capture(0, 8), true, 2);
    archive.renameSession("alpha", "beta");

    const restarted = new FileHistoryArchive({ root });
    expect(page(restarted, "beta", null).lines).toEqual(capture(0, 6).split("\n"));
    expect(page(restarted, "alpha", null)).toEqual({ lines: [], startLine: null, hasMore: false });
  });

  test("hashes hostile session names into safe storage filenames", () => {
    const { archive, root } = makeArchive();
    ingest(archive, "../../not-a-path", capture(0, 8), true, 2);

    expect(readdirSync(root).sort()).toEqual(expect.arrayContaining([
      expect.stringMatching(/^history-[a-f0-9]{64}\.json$/),
      expect.stringMatching(/^history-[a-f0-9]{64}\.jsonl$/),
    ]));
    expect(readdirSync(root).every((name) => /^history-[a-f0-9]{64}\.(json|jsonl)$/.test(name))).toBe(true);
  });

  test("fails closed for a corrupt partial archive without interrupting live output", () => {
    const { archive, root } = makeArchive();
    ingest(archive, "alpha", capture(0, 8), true, 2);
    const key = createHash("sha256").update("alpha").digest("hex");
    writeFileSync(join(root, `history-${key}.jsonl`), '{"line":', { flag: "a" });

    const restarted = new FileHistoryArchive({ root });
    expect(page(restarted, "alpha", null)).toEqual({ lines: [], startLine: null, hasMore: false });
    expect(ingest(restarted, "alpha", capture(8, 10), false, 2)).toEqual({ liveContent: capture(8, 10) });
  });
});
