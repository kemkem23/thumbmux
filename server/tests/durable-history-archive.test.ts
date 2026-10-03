import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DurableHistoryArchive, isHistoryMarker } from "../src/durable-history-archive";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, statSync, truncateSync, unlinkSync } from "node:fs";
import { zstdCompressSync } from "node:zlib";
import {
  ArchiveWorker, findInventoryEntry, paneDigest, RcloneRemote, readLatestInventory, restoreFailureReason, restoreRangeFromRemote,
} from "../../../../src/integrations/stream-history-offload";
import type {
  ArchiveCandidate, ArchiveCandidateSource,
} from "../../../../src/integrations/stream-history-offload";
import type {
  ArchiveCatalogPort, Coverage, FlagOnHistoryPort, Gap, PaneKey, RemoteObject, SealedExport, StoragePressure,
} from "../src/stream-contract";

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

test("a missed anchor asks for a deeper look before it calls the history broken", () => {
  // "I looked too shallow" and "tmux dropped it" are different answers, and only
  // the second is worth a marker. Escalating first is what keeps a burst tmux
  // still holds from being recorded as a hole.
  const archive = new DurableHistoryArchive({ root });
  archive.appendAnchored("s", capture(rows(1, 30)), OPTS);

  const shallow = archive.appendAnchored("s", capture(rows(900, 930)), { ...OPTS, deeperAvailable: true });
  expect(shallow.needsDeeper).toBe(true);
  expect(shallow.gap).toBe(false);
  expect(shallow.appended).toBe(0);

  const deeper = archive.appendAnchored("s", capture(rows(1, 40)), OPTS);
  expect(deeper.needsDeeper).toBe(false);
  expect(deeper.gap).toBe(false);
  expect(deeper.appended).toBe(10);
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

// ───────────── DS-02 · NEWARCH lot O: synthetic remote round trip and restore ─────────────
// The remote is a real rclone `:local:` backend in the test root; H/A are
// in-test fakes that only record order and hold sealed files. Expected rows,
// gaps and hashes are literals or computed here with node:crypto, never with
// the module under test.

const DS_PANE: PaneKey = { serverIdentity: "srv-ds02", paneId: "%7", birthGeneration: 3 };
const DS_STORE = "store-ds02";
const DS_ROWS: Record<string, string[]> = {
  "seg-0001": ["เริ่ม session", "L2 \u001b[31mred\u001b[0m", "e\u0301 combining", "  spaces kept  ", "สุดท้าย ✓"],
  "seg-0002": ["same", "same", "same", "ตัวอักษรกว้าง 中文", ""],
};
const DS_GAP: Gap = { version: 1, episodeId: "ep-ds02", parentEpisodeId: null, pane: DS_PANE,
  leftRowId: { pane: DS_PANE, segmentId: "seg-0001", rowOrdinal: 4 }, rightSegmentId: "seg-0002",
  reason: "pipe-eof", countKind: "unknown", missingCount: null, withheldRows: 0, lowerBound: 0,
  openedAt: 10, closedAt: 20, clockEpoch: "clock-ds02", quality: "degraded" };
const NEVER = { isCancelled: () => false };
const HIGH: StoragePressure = { sampledAtMonoMs: 0, clockEpoch: "clock-ds02", filesystemUsedPercent: 80,
  rootAllocatedBytes: 200 * 1024 * 1024, rootHardCapBytes: 256 * 1024 * 1024, usableFreeBytes: 1024 ** 3,
  rate15minBytesPerSecond: 0, reserveBytes: 16 * 1024 * 1024, sampleAgeMs: 0, ioError: null };
const CLI = resolve(import.meta.dir, "../../../../ops/newarch/restore-history.ts");
const sha = (data: Uint8Array | string) => createHash("sha256").update(data).digest("hex");

class SyntheticHistory implements Pick<FlagOnHistoryPort, "sealExport" | "reclaimVerified">,
  Pick<ArchiveCatalogPort, "commitRemoteIndex">, ArchiveCandidateSource {
  readonly events: string[] = [];
  constructor(readonly base: string, readonly segments: string[]) {
    for (const id of segments) {
      mkdirSync(this.segDir(id), { recursive: true });
      writeFileSync(join(this.segDir(id), "rows.jsonl"), DS_ROWS[id]!.map((text, i) => JSON.stringify({ ordinal: i, text })).join("\n") + "\n");
      writeFileSync(join(this.segDir(id), "gaps.jsonl"), id === "seg-0001" ? JSON.stringify(DS_GAP) + "\n" : "");
      writeFileSync(join(this.segDir(id), "export.json"), JSON.stringify({ segmentId: id, rows: DS_ROWS[id]!.length }));
    }
  }
  segDir(id: string) { return join(this.base, "segments", id); }
  coverage(id: string): Coverage {
    const rows = { kind: "rows" as const, range: { pane: DS_PANE, segmentId: id, start: 0, end: DS_ROWS[id]!.length }, digest: sha(DS_ROWS[id]!.join("\n")) };
    return id === "seg-0001" ? [rows, { kind: "gap", gap: DS_GAP, digest: sha(JSON.stringify(DS_GAP)) }] : [rows];
  }
  async listEligible() {
    return { status: "ok" as const, value: this.segments.filter((id) => existsSync(this.segDir(id)))
      .map((segmentId): ArchiveCandidate => ({ pane: DS_PANE, segmentId, generation: 1, pinned: false })) };
  }
  async sealExport(req: { operationId: string; segmentId: string }) {
    this.events.push(`seal:${req.segmentId}`);
    const ev = (name: string) => { const p = join(this.segDir(req.segmentId), name); const d = readFileSync(p); return { path: p, bytes: d.byteLength, sha256: sha(d) }; };
    const value: SealedExport = { kind: "sealed-export", operationId: req.operationId, storeUUID: DS_STORE, pane: DS_PANE,
      segmentId: req.segmentId, generation: 1, coverage: this.coverage(req.segmentId),
      files: [ev("rows.jsonl"), ev("gaps.jsonl")], manifest: ev("export.json"), sealCommitId: `seal-${req.segmentId}` };
    return { status: "ok" as const, value };
  }
  async commitRemoteIndex(req: Parameters<ArchiveCatalogPort["commitRemoteIndex"]>[0]) {
    this.events.push(`commit:${req.sealed.segmentId}`);
    return { status: "ok" as const, value: { kind: "remote-index-committed" as const, catalogVersion: 3 as const,
      commitId: `remote-${req.sealed.segmentId}`, generation: 1, verified: req.verified, coverage: req.sealed.coverage } };
  }
  async reclaimVerified(req: Parameters<FlagOnHistoryPort["reclaimVerified"]>[0]) {
    this.events.push(`reclaim:${req.sealed.segmentId}`);
    const removed = [...req.sealed.files, req.sealed.manifest];
    rmSync(this.segDir(req.sealed.segmentId), { recursive: true, force: true });
    return { status: "ok" as const, value: { kind: "local-reclaimed" as const, remote: req.remote, removed,
      allocatedBytesBefore: 4096, allocatedBytesAfter: 0, freeBlocksBefore: 10, freeBlocksAfter: 13, blockBytes: 4096 } };
  }
}
function dsSetup(segments = ["seg-0001", "seg-0002"]) {
  const store = join(root, "store"); const remoteDir = join(root, "remote");
  mkdirSync(remoteDir, { recursive: true });
  const h = new SyntheticHistory(store, segments);
  const remote = new RcloneRemote({ location: `:local:${remoteDir}`, cacheDir: join(root, "rclone-cache") });
  const worker = new ArchiveWorker({ root: store, storeUUID: DS_STORE, remote, history: h, catalog: h, candidates: h, random: () => 0.5 });
  return { store, remoteDir, h, remote, worker };
}
async function archiveAll(worker: ArchiveWorker, n: number) {
  for (let i = 0; i < n; i++) {
    const r = await worker.archiveOnce(HIGH, NEVER);
    if (r.status !== "ok" || !("operationId" in r.value)) throw new Error(`archive ${i}: ${JSON.stringify(r)}`);
    expect(r.value.state).toBe("LOCAL_RECLAIMED");
  }
}
function remoteFiles(dir: string, prefix = ""): string[] {
  return readdirSync(join(dir, prefix), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? remoteFiles(dir, join(prefix, e.name)) : [join(prefix, e.name)]).sort();
}
function rowsOf(files: readonly { path: string }[]): string[] {
  const p = files.find((f) => f.path.endsWith("rows.jsonl"))!.path;
  return readFileSync(p, "utf8").trimEnd().split("\n").map((l) => (JSON.parse(l) as { text: string }).text);
}
function emptyRoot(name = "empty-root") { const d = join(root, name); mkdirSync(d); return d; }
async function manifestFor(remote: RcloneRemote, segmentId: string): Promise<RemoteObject> {
  const scratch = emptyRoot(`scratch-${segmentId}`);
  const inv = await readLatestInventory(remote, DS_STORE, scratch);
  if (inv.status !== "ok" || !inv.value) throw new Error("no inventory");
  return findInventoryEntry(inv.value, { pane: DS_PANE, segmentId, start: 0, end: 1 })!.manifest;
}

test("DS-02 synthetic remote → verify → local delete → empty-root restore reads every row, gap and hash back", async () => {
  const { remoteDir, h, worker } = dsSetup();
  const before = Object.fromEntries(["seg-0001", "seg-0002"].flatMap((id) =>
    ["rows.jsonl", "gaps.jsonl", "export.json"].map((n) => [`${id}/${n}`, sha(readFileSync(join(h.segDir(id), n)))])));
  await archiveAll(worker, 2);

  // Local copies leave only after A committed the verified remote index.
  expect(h.events).toEqual(["seal:seg-0001", "commit:seg-0001", "reclaim:seg-0001", "seal:seg-0002", "commit:seg-0002", "reclaim:seg-0002"]);
  expect(existsSync(h.segDir("seg-0001")) || existsSync(h.segDir("seg-0002"))).toBe(false);

  // Remote layout: <store>/<paneDigest>/<segment>/<sha>.tar.zst, content-addressed; no crypt.
  const files = remoteFiles(remoteDir);
  const objects = files.filter((f) => f.endsWith(".tar.zst"));
  expect(objects.length).toBeGreaterThanOrEqual(2);
  for (const f of objects) {
    expect(f).toMatch(new RegExp(`^${DS_STORE}/${paneDigest(DS_PANE)}/seg-000[12]/[0-9a-f]{64}\\.tar\\.zst$`));
    expect(f.split("/").pop()).toBe(`${sha(readFileSync(join(remoteDir, f)))}.tar.zst`);
  }
  expect(files.filter((f) => f.startsWith(`${DS_STORE}/inventory/`)).length).toBe(2);

  // Restore with the real CLI into an empty root, finding the bundle from the remote inventory only.
  const target = emptyRoot();
  const cli = Bun.spawnSync([process.execPath, CLI, "restore", "--remote", `:local:${remoteDir}`, "--store", DS_STORE, "--root", target,
    "--pane", JSON.stringify(DS_PANE), "--segment", "seg-0001", "--start", "0", "--end", "5"], { stdout: "pipe", stderr: "pipe" });
  expect(cli.stderr.toString()).toBe("");
  expect(cli.exitCode).toBe(0);
  const out = JSON.parse(cli.stdout.toString()) as { ok: boolean; cacheId: string; files: { path: string; sha256: string }[]; coverage: Coverage };
  expect(out.ok).toBe(true);
  expect(rowsOf(out.files)).toEqual(DS_ROWS["seg-0001"]!);
  const gaps = readFileSync(out.files.find((f) => f.path.endsWith("gaps.jsonl"))!.path, "utf8").trimEnd().split("\n").map((l) => JSON.parse(l));
  expect(gaps).toEqual([DS_GAP]);
  expect(out.coverage.map((c) => c.kind)).toEqual(["rows", "gap"]);
  for (const f of out.files) {
    expect(sha(readFileSync(f.path))).toBe(before[`seg-0001/${f.path.split("/").pop()}`]!);
    expect(f.path.startsWith(join(target, "restore-cache") + "/")).toBe(true);
    expect(statSync(f.path).mode & 0o222).toBe(0);
  }

  // The second segment through the library, repeated rows kept with their count; a repeat restore is idempotent.
  const remote = new RcloneRemote({ location: `:local:${remoteDir}` });
  const req = { operationId: "r2", storeUUID: DS_STORE, range: { pane: DS_PANE, segmentId: "seg-0002", start: 0, end: 5 },
    inventory: await manifestFor(remote, "seg-0002"), allowedRoot: target };
  const second = await restoreRangeFromRemote(req, NEVER, { remote });
  if (second.status !== "ok") throw new Error(JSON.stringify(second));
  expect(rowsOf(second.value.files)).toEqual(DS_ROWS["seg-0002"]!);
  const again = await restoreRangeFromRemote(req, NEVER, { remote });
  expect(again.status === "ok" && again.value.cacheId).toBe(second.value.cacheId);
  // A range the bundle does not cover is refused rather than answered with an empty page.
  const outside = await restoreRangeFromRemote({ ...req, range: { ...req.range, start: 4, end: 9 } }, NEVER, { remote });
  expect(outside.status).toBe("error");
});

test("DS-02 a corrupted remote object is refused and nothing is published to the cache", async () => {
  const { remoteDir, remote, worker } = dsSetup(["seg-0001"]);
  await archiveAll(worker, 1);
  const object = remoteFiles(remoteDir).find((f) => f.endsWith(".tar.zst"))!;
  const bytes = readFileSync(join(remoteDir, object)); bytes.writeUInt8(bytes.readUInt8(bytes.length - 3) ^ 0xff, bytes.length - 3);
  writeFileSync(join(remoteDir, object), bytes);

  const target = emptyRoot();
  const r = await restoreRangeFromRemote({ operationId: "c", storeUUID: DS_STORE, range: { pane: DS_PANE, segmentId: "seg-0001", start: 0, end: 5 },
    inventory: await manifestFor(remote, "seg-0001"), allowedRoot: target }, NEVER, { remote });
  expect(r.status).toBe("error");
  expect(restoreFailureReason(r)).toBe("corrupt");
  expect(existsSync(join(target, "restore-cache", "index.json"))).toBe(false);
  expect(readdirSync(join(target, "restore-cache"))).toEqual([]);
  expect(readdirSync(join(target, "restore-staging"))).toEqual([]);
});

test("DS-02 a missing bundle object reports missing, not an empty history", async () => {
  const { remoteDir, remote, worker } = dsSetup(["seg-0001"]);
  await archiveAll(worker, 1);
  const manifest = await manifestFor(remote, "seg-0001");
  for (const f of remoteFiles(remoteDir).filter((f) => f.endsWith(".tar.zst"))) unlinkSync(join(remoteDir, f));
  const r = await restoreRangeFromRemote({ operationId: "m", storeUUID: DS_STORE, range: { pane: DS_PANE, segmentId: "seg-0001", start: 0, end: 5 },
    inventory: manifest, allowedRoot: emptyRoot() }, NEVER, { remote });
  expect(r.status).toBe("error");
  expect(restoreFailureReason(r)).toBe("missing");
});

/** Independent ustar writer so hostile archives can be planted. */
function rawTar(entries: { name: string; type: string; data: Uint8Array }[]): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const e of entries) {
    const h = new Uint8Array(512); const enc = (o: number, s: string) => h.set(new TextEncoder().encode(s), o);
    enc(0, e.name); enc(100, "0000644\0"); enc(108, "0000000\0"); enc(116, "0000000\0");
    enc(124, e.data.byteLength.toString(8).padStart(11, "0") + "\0"); enc(136, "00000000000\0"); enc(148, "        ");
    enc(156, e.type); if (e.type === "2") enc(157, "/etc/passwd"); enc(257, "ustar\0"); enc(263, "00");
    enc(148, h.reduce((a, b) => a + b, 0).toString(8).padStart(6, "0") + "\0 ");
    parts.push(h, e.data, new Uint8Array((512 - (e.data.byteLength % 512)) % 512));
  }
  parts.push(new Uint8Array(1024));
  return new Uint8Array(Buffer.concat(parts));
}
function plant(remoteDir: string, segmentId: string, tar: Uint8Array, members: { path: string; bytes: number; sha256: string }[]): RemoteObject {
  const prefix = `${DS_STORE}/${paneDigest(DS_PANE)}/${segmentId}`;
  const zst = new Uint8Array(zstdCompressSync(tar));
  const objectKey = `${prefix}/${sha(zst)}.tar.zst`;
  mkdirSync(join(remoteDir, prefix), { recursive: true });
  writeFileSync(join(remoteDir, objectKey), zst);
  const body = JSON.stringify({ version: 1, bundleId: `bundle-${segmentId}`, storeUUID: DS_STORE, pane: DS_PANE, segmentId,
    coverage: [{ kind: "rows", range: { pane: DS_PANE, segmentId, start: 0, end: 1 }, digest: "0".repeat(64) }],
    schemaVersions: { bundle: 1 }, objects: [{ objectKey, bytes: zst.byteLength, sha256: sha(zst) }], members,
    compression: "tar.zst", encryption: "none", checkpointIds: [], rawRanges: [] });
  const manifestKey = `${prefix}/${sha(body)}.manifest.json`;
  writeFileSync(join(remoteDir, manifestKey), body);
  return { objectKey: manifestKey, bytes: Buffer.byteLength(body), sha256: sha(body) };
}

test("DS-02 path traversal, symlink members and a decompression bomb are rejected without writing outside staging", async () => {
  const remoteDir = join(root, "remote"); mkdirSync(remoteDir);
  const remote = new RcloneRemote({ location: `:local:${remoteDir}` });
  const evil = new TextEncoder().encode("owned");
  const cases = [
    { seg: "seg-trav", tar: rawTar([{ name: "../../escaped.txt", type: "0", data: evil }]), member: "../../escaped.txt", why: /unsafe archive member name|escapes/ },
    { seg: "seg-link", tar: rawTar([{ name: "rows.jsonl", type: "2", data: new Uint8Array() }]), member: "rows.jsonl", why: /type 2 refused/ },
    { seg: "seg-bomb", tar: rawTar([{ name: "rows.jsonl", type: "0", data: new Uint8Array(40 * 1024 * 1024) }]), member: "rows.jsonl", why: /zstd/ },
  ];
  for (const c of cases) {
    const target = emptyRoot(`root-${c.seg}`);
    const manifest = plant(remoteDir, c.seg, c.tar, [{ path: c.member, bytes: evil.byteLength, sha256: sha(evil) }]);
    const r = await restoreRangeFromRemote({ operationId: c.seg, storeUUID: DS_STORE, range: { pane: DS_PANE, segmentId: c.seg, start: 0, end: 1 },
      inventory: manifest, allowedRoot: target }, NEVER, { remote });
    expect([c.seg, r.status]).toEqual([c.seg, "error"]);
    expect([c.seg, restoreFailureReason(r)]).toEqual([c.seg, "corrupt"]);
    expect([c.seg, r.status === "error" && c.why.test(r.message)]).toEqual([c.seg, true]);
    expect(remoteFiles(root).filter((f) => f.endsWith("escaped.txt"))).toEqual([]);
    expect(readdirSync(join(target, "restore-cache"))).toEqual([]);
  }
});

test("DS-02 an unreachable remote is retryable remote-unavailable, never an empty or EOF page", async () => {
  const remote = new RcloneRemote({ location: ":http,url='http://127.0.0.1:9':", timeoutMs: 60_000 });
  const target = emptyRoot();
  const r = await restoreRangeFromRemote({ operationId: "off", storeUUID: DS_STORE, range: { pane: DS_PANE, segmentId: "seg-0001", start: 0, end: 5 },
    inventory: { objectKey: `${DS_STORE}/${paneDigest(DS_PANE)}/seg-0001/${"a".repeat(64)}.manifest.json`, bytes: 10, sha256: "a".repeat(64) },
    allowedRoot: target }, NEVER, { remote });
  expect(r.status).toBe("error");
  expect(restoreFailureReason(r)).toBe("offline");
  const inv = await readLatestInventory(remote, DS_STORE, target);
  expect(inv.status).toBe("error");
  expect(restoreFailureReason(inv)).toBe("offline");
});

test("DS-02 the restore cache honours its cap and pins: a pinned entry is never evicted, an interrupted restore publishes nothing", async () => {
  const { h, remote, worker } = dsSetup();
  const size = (id: string) => readdirSync(h.segDir(id)).reduce((n, f) => n + statSync(join(h.segDir(id), f)).size, 0);
  const cap = Math.max(size("seg-0001"), size("seg-0002")); // each fits alone, both together do not
  await archiveAll(worker, 2);
  const target = emptyRoot();
  const m1 = await manifestFor(remote, "seg-0001"); const m2 = await manifestFor(remote, "seg-0002");
  const range = (segmentId: string) => ({ pane: DS_PANE, segmentId, start: 0, end: 5 });
  const first = await restoreRangeFromRemote({ operationId: "a", storeUUID: DS_STORE, range: range("seg-0001"), inventory: m1, allowedRoot: target }, NEVER, { remote, cacheBytes: cap });
  if (first.status !== "ok") throw new Error(JSON.stringify(first));
  const pinned = await restoreRangeFromRemote({ operationId: "b", storeUUID: DS_STORE, range: range("seg-0002"), inventory: m2, allowedRoot: target }, NEVER,
    { remote, cacheBytes: cap, pinnedCacheIds: new Set([first.value.cacheId]) });
  expect(pinned.status).toBe("busy");
  expect(existsSync(first.value.files[0]!.path)).toBe(true);

  let calls = 0;
  const interrupted = await restoreRangeFromRemote({ operationId: "i", storeUUID: DS_STORE, range: range("seg-0002"), inventory: m2, allowedRoot: target },
    { isCancelled: () => ++calls > 2 }, { remote, cacheBytes: cap });
  expect(interrupted.status).toBe("cancelled");
  expect(readdirSync(join(target, "restore-staging"))).toEqual([]);
  expect(existsSync(first.value.files[0]!.path)).toBe(true);

  const evicting = await restoreRangeFromRemote({ operationId: "c", storeUUID: DS_STORE, range: range("seg-0002"), inventory: m2, allowedRoot: target }, NEVER, { remote, cacheBytes: cap });
  if (evicting.status !== "ok") throw new Error(JSON.stringify(evicting));
  expect(existsSync(first.value.files[0]!.path)).toBe(false);
  expect(rowsOf(evicting.value.files)).toEqual(DS_ROWS["seg-0002"]!);
});
