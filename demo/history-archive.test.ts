import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
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

function ingest(
  archive: FileHistoryArchive,
  session: string,
  content: string,
  fullHistory: boolean,
  liveLineLimit: number,
  replace = false,
) {
  return archive.ingestSnapshot(session, content, {
    previousContent: null,
    fullHistory,
    liveLineLimit,
    replace,
  });
}

function page(archive: FileHistoryArchive, session: string, beforeLine: number | null, limit = 10_000): HistoryPage {
  return archive.readBefore(session, beforeLine, limit);
}

function archiveRoot(archive: FileHistoryArchive): string {
  return (archive as unknown as { root: string }).root;
}

function storedPaths(root: string, session: string): { data: string; meta: string } {
  const key = createHash("sha256").update(session).digest("hex");
  return {
    data: join(root, `history-${key}.jsonl`),
    meta: join(root, `history-${key}.json`),
  };
}

function permissions(path: string): number {
  return statSync(path).mode & 0o777;
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

  test("normalizes newline-terminated captures and strips only trailing blank viewport rows", () => {
    const { archive } = makeArchive();
    const tmuxCapture = `${capture(0, 8)}\n\n   \n`;

    expect(ingest(archive, "alpha", tmuxCapture, true, 4).liveContent).toBe(capture(4, 8));
    expect(page(archive, "alpha", null).lines).toEqual(capture(0, 4).split("\n"));

    const withInteriorBlank = "head\n\ntail\n\n  \n";
    expect(ingest(archive, "interior", withInteriorBlank, true, 2).liveContent).toBe("\ntail");
    expect(page(archive, "interior", null).lines).toEqual(["head"]);
  });

  test("treats zero-overlap typing as an in-place repaint without history churn", () => {
    const { archive, root } = makeArchive();
    ingest(archive, "alpha", `${capture(0, 8)}\n`, true, 4);
    const paths = storedPaths(root, "alpha");
    const initialDataInode = statSync(paths.data).ino;

    const typed = ["line-4", "line-5", "line-6", "line-7 typed"].join("\n");
    expect(ingest(archive, "alpha", `${typed}\n\n`, false, 4).liveContent).toBe(typed);
    expect(page(archive, "alpha", null).lines).toEqual(capture(0, 4).split("\n"));
    expect(statSync(paths.data).ino).toBe(initialDataInode);

    const meta = JSON.parse(readFileSync(paths.meta, "utf8"));
    expect(meta).toMatchObject({ liveStart: 4, nextLine: 8, live: typed.split("\n") });

    const unchangedDataInode = statSync(paths.data).ino;
    const unchangedMetaInode = statSync(paths.meta).ino;
    ingest(archive, "alpha", `${typed}\n   \n`, false, 4);
    expect(statSync(paths.data).ino).toBe(unchangedDataInode);
    expect(statSync(paths.meta).ino).toBe(unchangedMetaInode);
  });

  test("does not mistake a repeated edge row for proof that the window scrolled", () => {
    const { archive } = makeArchive();
    ingest(archive, "alpha", "status\nmiddle\nstatus\n", true, 3);

    const next = "status\nmiddle\nstatus updated";
    expect(ingest(archive, "alpha", `${next}\n`, false, 3).liveContent).toBe(next);
    expect(page(archive, "alpha", null)).toEqual({
      lines: [],
      startLine: null,
      hasMore: false,
    });
  });

  test("rejects an ambiguous tiny overlap in a normal-sized repeated window", () => {
    const { archive } = makeArchive();
    const previous = ["one", "two", "three", "four", "five", "six", "repeat-a", "repeat-b"];
    const next = ["repeat-a", "repeat-b", "new-three", "new-four", "new-five", "new-six", "new-seven", "new-eight"];
    ingest(archive, "alpha", `${previous.join("\n")}\n`, true, previous.length);

    expect(ingest(archive, "alpha", `${next.join("\n")}\n`, false, next.length).liveContent).toBe(next.join("\n"));
    expect(page(archive, "alpha", null).lines).toEqual([]);
  });

  test("does not archive a whole window from a matching single-row snapshot", () => {
    const { archive } = makeArchive();
    const previous = ["one", "two", "three", "four", "status"];
    ingest(archive, "alpha", `${previous.join("\n")}\n`, true, previous.length);

    expect(ingest(archive, "alpha", "status\n", false, previous.length).liveContent).toBe("status");
    expect(page(archive, "alpha", null)).toEqual({
      lines: [],
      startLine: null,
      hasMore: false,
    });
  });

  test("a resize replacement refreshes live metadata without rewriting archive data", () => {
    const { archive, root } = makeArchive();
    ingest(archive, "alpha", `${capture(0, 12)}\n`, true, 4);
    const paths = storedPaths(root, "alpha");
    const dataBefore = readFileSync(paths.data, "utf8");
    const dataInodeBefore = statSync(paths.data).ino;

    // This has a reliable three-row suffix→prefix overlap and would normally
    // archive line-8. A resize reflow must never infer scroll from it.
    const reflowed = ["line-9", "line-10", "line-11", "line-12 reflowed"];
    expect(ingest(archive, "alpha", `${reflowed.join("\n")}\n`, false, 4, true).liveContent)
      .toBe(reflowed.join("\n"));

    expect(page(archive, "alpha", null).lines).toEqual(capture(0, 8).split("\n"));
    expect(readFileSync(paths.data, "utf8")).toBe(dataBefore);
    expect(statSync(paths.data).ino).toBe(dataInodeBefore);
    expect(JSON.parse(readFileSync(paths.meta, "utf8"))).toMatchObject({
      live: reflowed,
      liveStart: 8,
      nextLine: 12,
    });
  });

  test("a repaint cannot duplicate or evict history before the next proven scroll", () => {
    const { archive } = makeArchive(3);
    ingest(archive, "alpha", `${capture(0, 8)}\n`, true, 4);

    const typed = ["line-4", "line-5", "line-6", "line-7 typed"].join("\n");
    ingest(archive, "alpha", `${typed}\n`, false, 4);
    ingest(archive, "alpha", `${typed}\n\n`, false, 4);
    expect(page(archive, "alpha", null).lines).toEqual(capture(1, 4).split("\n"));

    const shifted = ["line-5", "line-6", "line-7 typed", "line-8"].join("\n");
    ingest(archive, "alpha", `${shifted}\n`, false, 4);
    ingest(archive, "alpha", `${shifted}\n`, false, 4);
    expect(page(archive, "alpha", null).lines).toEqual(capture(2, 5).split("\n"));
  });

  test("evicts the oldest archived records at a deterministic per-session cap", () => {
    const { archive } = makeArchive(5);
    ingest(archive, "alpha", capture(0, 12), true, 4);
    ingest(archive, "alpha", capture(9, 13), false, 4);

    const result = page(archive, "alpha", null);
    expect(result.lines).toEqual(capture(4, 9).split("\n"));
    expect(result.startLine).toBe(4);
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

  test("reconciles a unique persisted live window inside a restart full-history capture", () => {
    const { archive, root } = makeArchive();
    ingest(archive, "alpha", capture(0, 8), true, 4);

    const restarted = new FileHistoryArchive({ root });
    expect(ingest(restarted, "alpha", capture(0, 12), true, 4).liveContent).toBe(capture(8, 12));
    expect(page(restarted, "alpha", null)).toEqual({
      lines: capture(0, 8).split("\n"),
      startLine: 0,
      hasMore: false,
    });
  });

  test("prefers a unique full-history bridge over a shorter new-live suffix overlap", () => {
    const { archive, root } = makeArchive();
    ingest(archive, "alpha", "p0\np1\np2\np3\nA\nB\nC\nD", true, 4);

    const restarted = new FileHistoryArchive({ root });
    const full = ["p0", "p1", "p2", "p3", "A", "B", "C", "D", "X", "Y", "C", "D", "N1", "N2"];
    expect(ingest(restarted, "alpha", full.join("\n"), true, 4).liveContent).toBe("C\nD\nN1\nN2");
    expect(page(restarted, "alpha", null).lines).toEqual([
      "p0", "p1", "p2", "p3", "A", "B", "C", "D", "X", "Y",
    ]);
  });

  test("does not infer departed rows from a prefix occurrence when live is unchanged", () => {
    const { archive, root } = makeArchive();
    ingest(archive, "alpha", "archived\nA\nB", true, 2);
    const paths = storedPaths(root, "alpha");
    const dataBefore = readFileSync(paths.data, "utf8");

    const restarted = new FileHistoryArchive({ root });
    const repeatedCurrent = ["archived", "A", "B", "middle", "A", "B"];
    expect(ingest(restarted, "alpha", repeatedCurrent.join("\n"), true, 2, true).liveContent).toBe("A\nB");
    expect(page(restarted, "alpha", null).lines).toEqual(["archived"]);
    expect(readFileSync(paths.data, "utf8")).toBe(dataBefore);
  });

  test("reconciles a unique restart full history even when geometry also requests replacement", () => {
    const { archive, root } = makeArchive();
    ingest(archive, "alpha", capture(0, 8), true, 4);

    const restarted = new FileHistoryArchive({ root });
    expect(ingest(restarted, "alpha", capture(0, 12), true, 4, true).liveContent).toBe(capture(8, 12));
    expect(page(restarted, "alpha", null).lines).toEqual(capture(0, 8).split("\n"));
  });

  test("reconciles the proven departed prefix of a live window that straddles the boundary", () => {
    const { archive, root } = makeArchive();
    ingest(archive, "alpha", capture(0, 8), true, 4);

    const restarted = new FileHistoryArchive({ root });
    expect(ingest(restarted, "alpha", capture(0, 9), true, 4, true).liveContent).toBe(capture(5, 9));
    expect(page(restarted, "alpha", null).lines).toEqual(capture(0, 5).split("\n"));
  });

  test("rejects a full-history bridge repeated at the current live boundary", () => {
    const { archive, root } = makeArchive();
    ingest(archive, "alpha", "archived\nA\nB", true, 2);

    const restarted = new FileHistoryArchive({ root });
    const repeated = ["archived", "A", "B", "middle", "A", "B", "tail-1", "tail-2"];
    expect(ingest(restarted, "alpha", repeated.join("\n"), true, 4, true).liveContent)
      .toBe("A\nB\ntail-1\ntail-2");
    expect(page(restarted, "alpha", null).lines).toEqual(["archived"]);
  });

  test("falls back to reliable live overlap when a full capture has no persisted-prefix proof", () => {
    const { archive, root } = makeArchive();
    ingest(archive, "alpha", capture(0, 8), true, 4);

    const restarted = new FileHistoryArchive({ root });
    expect(ingest(restarted, "alpha", capture(6, 10), true, 4).liveContent).toBe(capture(6, 10));
    expect(page(restarted, "alpha", null).lines).toEqual(capture(0, 6).split("\n"));
  });

  test("does not reconcile an ambiguous repeated live window after restart", () => {
    const { archive, root } = makeArchive();
    ingest(archive, "alpha", "archived\nrepeat-a\nrepeat-b", true, 2);

    const restarted = new FileHistoryArchive({ root });
    const ambiguous = [
      "archived",
      "repeat-a",
      "repeat-b",
      "middle",
      "repeat-a",
      "repeat-b",
      "new-1",
      "new-2",
    ];
    expect(ingest(restarted, "alpha", ambiguous.join("\n"), true, 2).liveContent).toBe("new-1\nnew-2");
    expect(page(restarted, "alpha", null)).toEqual({
      lines: ["archived"],
      startLine: 0,
      hasMore: false,
    });
  });

  test("physically removes rows evicted by a lower cap after restart", () => {
    const { archive, root } = makeArchive(100);
    ingest(archive, "alpha", capture(0, 20), true, 4);
    const paths = storedPaths(root, "alpha");
    expect(readFileSync(paths.data, "utf8").trim().split("\n")).toHaveLength(16);

    const restarted = new FileHistoryArchive({ root, maxLines: 3 });
    expect(page(restarted, "alpha", null).lines).toEqual(capture(13, 16).split("\n"));

    const persisted = readFileSync(paths.data, "utf8").trim().split("\n").map((record) => JSON.parse(record));
    expect(persisted).toEqual([
      { line: 13, text: "line-13" },
      { line: 14, text: "line-14" },
      { line: 15, text: "line-15" },
    ]);
    expect(permissions(paths.data)).toBe(0o600);
    expect(permissions(paths.meta)).toBe(0o600);
  });

  test("uses a private per-run default root so recycled demo names cannot resurrect history", () => {
    const first = new FileHistoryArchive();
    const firstRoot = archiveRoot(first);
    roots.push(firstRoot);
    ingest(first, "demo-1", `${capture(0, 8)}\n`, true, 2);

    const second = new FileHistoryArchive();
    const secondRoot = archiveRoot(second);
    roots.push(secondRoot);

    expect(secondRoot).not.toBe(firstRoot);
    expect(permissions(firstRoot)).toBe(0o700);
    expect(permissions(secondRoot)).toBe(0o700);
    expect(readdirSync(firstRoot).map((name) => permissions(join(firstRoot, name)))).toEqual([0o600, 0o600]);
    expect(page(second, "demo-1", null)).toEqual({ lines: [], startLine: null, hasMore: false });
  });

  test("enforces 0700/0600 modes for explicit persistent storage and atomic rewrites", () => {
    const root = mkdtempSync(join(tmpdir(), "thumbmux-history-mode-test-"));
    roots.push(root);
    chmodSync(root, 0o777);

    const archive = new FileHistoryArchive({ root });
    ingest(archive, "alpha", `${capture(0, 8)}\n`, true, 2);
    const paths = storedPaths(root, "alpha");

    expect(permissions(root)).toBe(0o700);
    expect(permissions(paths.data)).toBe(0o600);
    expect(permissions(paths.meta)).toBe(0o600);

    chmodSync(paths.data, 0o666);
    chmodSync(paths.meta, 0o666);
    const restarted = new FileHistoryArchive({ root });
    expect(page(restarted, "alpha", null).lines).toEqual(capture(0, 6).split("\n"));
    expect(permissions(paths.data)).toBe(0o600);
    expect(permissions(paths.meta)).toBe(0o600);

    ingest(restarted, "alpha", `${capture(5, 9)}\n`, false, 4);
    expect(permissions(paths.data)).toBe(0o600);
    expect(permissions(paths.meta)).toBe(0o600);
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
