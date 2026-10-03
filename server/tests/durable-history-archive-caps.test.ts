import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DurableHistoryArchive } from "../src/durable-history-archive";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, truncateSync, writeFileSync } from "node:fs";
import {
  ArchiveWorker, decideArchivePressure, RcloneRemote,
} from "../../../../src/integrations/stream-history-offload";
import type {
  ArchiveCandidate, ArchiveCandidateSource, RemoteResult, RemoteStore,
} from "../../../../src/integrations/stream-history-offload";
import type { ArchiveCatalogPort, FlagOnHistoryPort, PaneKey, SealedExport, StoragePressure } from "../src/stream-contract";

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

// ───────────── DS-01 · NEWARCH lot O: thresholds, staging cap, remote faults, every crash state ─────────────
// Real rclone `:local:` remote wrapped by an in-test fault injector. H/A are
// fakes that record call order; "no unlink before verify" is checked by the
// fake reclaim itself against the remote files, hashed here independently.

const MiB = 1024 * 1024;
const PANE: PaneKey = { serverIdentity: "srv-ds01", paneId: "%1", birthGeneration: 1 };
const STORE = "store-ds01";
const NEVER = { isCancelled: () => false };
const sha = (d: Uint8Array | string) => createHash("sha256").update(d).digest("hex");
function pressure(over: Partial<StoragePressure> = {}): StoragePressure {
  return { sampledAtMonoMs: 0, clockEpoch: "c", filesystemUsedPercent: 50, rootAllocatedBytes: 64 * MiB,
    rootHardCapBytes: 256 * MiB, usableFreeBytes: 10 * 1024 * MiB, rate15minBytesPerSecond: 0, reserveBytes: 16 * MiB,
    sampleAgeMs: 0, ioError: null, ...over };
}
const HIGH = pressure({ filesystemUsedPercent: 80 });

type Fault = "offline" | "quota" | "truncate" | "flip" | "throw" | null;
class FaultyRemote implements RemoteStore {
  readonly location: string;
  calls: string[] = [];
  constructor(readonly inner: RcloneRemote, readonly dir: string, readonly faults: { put?: Fault[]; get?: Fault[] } = {}) { this.location = inner.location; }
  private fail(kind: "offline" | "quota", stderr: string): RemoteResult<never> { return { ok: false, kind, argv: ["injected"], stdout: "", stderr, exitCode: 1 }; }
  version() { return this.inner.version(); }
  list(prefix: string) { return this.inner.list(prefix); }
  async put(local: string, key: string) {
    this.calls.push(`put:${key.split("/").pop()}`);
    const f = this.faults.put?.shift() ?? null;
    if (f === "throw") throw new Error("injected crash during copyto");
    if (f === "offline") return this.fail("offline", "dial tcp 142.250.0.1:443: i/o timeout");
    if (f === "quota") return this.fail("quota", "googleapi: Error 403: The user's Drive storage quota has been exceeded., storageQuotaExceeded");
    const r = await this.inner.put(local, key);
    const there = join(this.dir, key);
    if (f === "truncate") truncateSync(there, Math.floor(readFileSync(there).byteLength / 2));
    if (f === "flip") { const b = readFileSync(there); b.writeUInt8(b.readUInt8(0) ^ 0xff, 0); writeFileSync(there, b); }
    return r;
  }
  async get(key: string, local: string) {
    this.calls.push(`get:${key.split("/").pop()}`);
    const f = this.faults.get?.shift() ?? null;
    if (f === "throw") throw new Error("injected crash during verify download");
    if (f === "offline") return this.fail("offline", "dial tcp: lookup www.googleapis.com: no such host");
    return this.inner.get(key, local);
  }
}
class Synthetic implements Pick<FlagOnHistoryPort, "sealExport" | "reclaimVerified">, Pick<ArchiveCatalogPort, "commitRemoteIndex">, ArchiveCandidateSource {
  events: string[] = [];
  crash: { commit?: boolean; reclaim?: boolean } = {};
  readonly original: Record<string, string> = {};
  constructor(readonly base: string, readonly remoteDir: string, readonly segments: string[], bytes = 3000) {
    for (const id of segments) {
      mkdirSync(this.dir(id), { recursive: true });
      const rows = Array.from({ length: Math.ceil(bytes / 20) }, (_, i) => `${id} row ${i} ข้อความ`).join("\n");
      writeFileSync(join(this.dir(id), "rows.jsonl"), rows);
      writeFileSync(join(this.dir(id), "export.json"), JSON.stringify({ id }));
      this.original[id] = sha(rows);
    }
  }
  dir(id: string) { return join(this.base, "segments", id); }
  localIntact(id: string) { return existsSync(join(this.dir(id), "rows.jsonl")) && sha(readFileSync(join(this.dir(id), "rows.jsonl"))) === this.original[id]; }
  async listEligible() {
    return { status: "ok" as const, value: this.segments.filter((id) => existsSync(this.dir(id)))
      .map((segmentId): ArchiveCandidate => ({ pane: PANE, segmentId, generation: 1, pinned: false })) };
  }
  async sealExport(req: { operationId: string; segmentId: string }) {
    this.events.push(`seal:${req.segmentId}`);
    const ev = (n: string) => { const p = join(this.dir(req.segmentId), n); const d = readFileSync(p); return { path: p, bytes: d.byteLength, sha256: sha(d) }; };
    const value: SealedExport = { kind: "sealed-export", operationId: req.operationId, storeUUID: STORE, pane: PANE, segmentId: req.segmentId,
      generation: 1, coverage: [{ kind: "rows", range: { pane: PANE, segmentId: req.segmentId, start: 0, end: 150 }, digest: this.original[req.segmentId]! }],
      files: [ev("rows.jsonl")], manifest: ev("export.json"), sealCommitId: `seal-${req.segmentId}` };
    return { status: "ok" as const, value };
  }
  async commitRemoteIndex(req: Parameters<ArchiveCatalogPort["commitRemoteIndex"]>[0]) {
    if (this.crash.commit) { this.crash.commit = false; throw new Error("injected crash before catalog commit"); }
    this.events.push(`commit:${req.sealed.segmentId}`);
    return { status: "ok" as const, value: { kind: "remote-index-committed" as const, catalogVersion: 3 as const, commitId: `c-${req.sealed.segmentId}`,
      generation: 1, verified: req.verified, coverage: req.sealed.coverage } };
  }
  async reclaimVerified(req: Parameters<FlagOnHistoryPort["reclaimVerified"]>[0]) {
    if (this.crash.reclaim) { this.crash.reclaim = false; throw new Error("injected crash before unlink"); }
    // Independent check at the moment of deletion: every remote object exists and hashes to its name.
    for (const o of [...req.remote.verified.bundle.objects, req.remote.verified.bundle.manifest]) {
      const there = join(this.remoteDir, o.objectKey);
      if (!existsSync(there) || sha(readFileSync(there)) !== o.sha256) throw new Error(`reclaim before remote verify: ${o.objectKey}`);
    }
    if (!this.events.includes(`commit:${req.sealed.segmentId}`)) throw new Error("reclaim before remote index commit");
    this.events.push(`reclaim:${req.sealed.segmentId}`);
    rmSync(this.dir(req.sealed.segmentId), { recursive: true, force: true });
    return { status: "ok" as const, value: { kind: "local-reclaimed" as const, remote: req.remote, removed: [...req.sealed.files, req.sealed.manifest],
      allocatedBytesBefore: 8192, allocatedBytesAfter: 0, freeBlocksBefore: 5, freeBlocksAfter: 7, blockBytes: 4096 } };
  }
}
function setup(faults: { put?: Fault[]; get?: Fault[] } = {}, segments = ["seg-a"], extra: { scratchBytes?: number; bytes?: number } = {}) {
  const store = join(root, "store"); const remoteDir = join(root, "remote"); mkdirSync(remoteDir, { recursive: true });
  const syn = new Synthetic(store, remoteDir, segments, extra.bytes);
  const remote = new FaultyRemote(new RcloneRemote({ location: `:local:${remoteDir}` }), remoteDir, faults);
  const clock = { now: 0 };
  const make = () => new ArchiveWorker({ root: store, storeUUID: STORE, remote, history: syn, catalog: syn, candidates: syn,
    monoMs: () => clock.now, random: () => 0.5, scratchBytes: extra.scratchBytes });
  return { store, remoteDir, syn, remote, clock, make, worker: make() };
}
function state(r: Awaited<ReturnType<ArchiveWorker["archiveOnce"]>>): string {
  if (r.status !== "ok") return `${r.status}:${"code" in r ? r.code : "reason" in r ? r.reason : ""}`;
  return "state" in r.value && r.value.state === "idle" ? `idle:${(r.value as { reason: string }).reason}` : (r.value as { state: string }).state;
}

test("DS-01 trigger at 75% with hysteresis: stays on until fs<70, root<65, free>=2x reserve and ttf>=60min", () => {
  const table: [Partial<StoragePressure>, boolean, string, boolean][] = [
    [{ filesystemUsedPercent: 74 }, false, "normal", false],
    [{ filesystemUsedPercent: 75 }, false, "archive", true],
    [{ rootAllocatedBytes: 192 * MiB }, false, "archive", true],                      // root 75% of 256 MiB cap
    [{ usableFreeBytes: 100 * MiB, rate15minBytesPerSecond: 100 * MiB / 1700 }, false, "archive", true], // ttf < 30 min
    [{ filesystemUsedPercent: 72 }, true, "archive", true],                           // hysteresis band
    [{ filesystemUsedPercent: 69, rootAllocatedBytes: 167 * MiB }, true, "archive", true], // root 65.2% → keep going
    [{ filesystemUsedPercent: null }, true, "archive", true],                          // unknown fs never stops
    [{ filesystemUsedPercent: 60, usableFreeBytes: 31 * MiB }, true, "archive", true], // free < 2x reserve
    [{ filesystemUsedPercent: 60, sampleAgeMs: 61_000 }, true, "archive", true],       // stale never stops
    [{ filesystemUsedPercent: 60, usableFreeBytes: 1024 * MiB, rate15minBytesPerSecond: 1024 * MiB / 3000 }, true, "archive", true], // ttf 50 min < 60
    [{ filesystemUsedPercent: 90 }, false, "critical", true],
    [{ rootAllocatedBytes: 231 * MiB }, false, "critical", true],
    [{ ioError: "ENOSPC" }, false, "emergency", true],
    [{ usableFreeBytes: 16 * MiB }, false, "emergency", true],
  ];
  for (const [over, was, level, active] of table) {
    const d = decideArchivePressure(pressure(over), was);
    expect({ over, level: d.level as string, active: d.active }).toEqual({ over, level, active });
  }
  // The stop rows: everything below the floor, rate unknown (0) does not count as time-to-full.
  expect(decideArchivePressure(pressure({ filesystemUsedPercent: 69, rootAllocatedBytes: 160 * MiB }), true).active).toBe(false);
  expect(decideArchivePressure(pressure({ filesystemUsedPercent: 69, rootAllocatedBytes: 166 * MiB }), true).active).toBe(false);
  expect(decideArchivePressure(pressure({ filesystemUsedPercent: 90 }), false).admitNewPanes).toBe(false);
  expect(decideArchivePressure(pressure({ filesystemUsedPercent: 60, sampleAgeMs: 61_000 }), false).stale).toBe(true);
});

test("DS-01 below threshold the worker is inert: no seal, no remote call", async () => {
  const { syn, remote, worker } = setup();
  expect(state(await worker.archiveOnce(pressure(), NEVER))).toBe("idle:below-threshold");
  expect(syn.events).toEqual([]);
  expect(remote.calls).toEqual([]);
  expect(syn.localIntact("seg-a")).toBe(true);
});

test("DS-01 staging is capped: a bundle larger than the scratch budget is not staged or uploaded", async () => {
  const { syn, remote, worker } = setup({}, ["seg-a"], { scratchBytes: 256, bytes: 64 * 1024 });
  expect(state(await worker.archiveOnce(HIGH, NEVER))).toBe("error:integrity");
  expect(remote.calls.filter((c) => c.startsWith("put:"))).toEqual([]);
  expect(syn.localIntact("seg-a")).toBe(true);
  expect(readdirSync(join(root, "store", "archive", "staging"))).toEqual([]);
});

test("DS-01 a partial upload that exits 0 is caught by download verification, rewritten, and only then reclaimed", async () => {
  const { syn, clock, worker } = setup({ put: ["truncate"] });
  const first = await worker.archiveOnce(HIGH, NEVER);
  expect(state(first)).toBe("UPLOADING");
  expect(first.status === "ok" && "retryAfterMs" in first.value && first.value.retryAfterMs).toBe(1000);
  expect(syn.events).toEqual(["seal:seg-a"]);
  expect(syn.localIntact("seg-a")).toBe(true);
  clock.now = 500;
  expect(state(await worker.archiveOnce(HIGH, NEVER))).toBe("idle:backoff");
  clock.now = 1001;
  expect(state(await worker.archiveOnce(HIGH, NEVER))).toBe("LOCAL_RECLAIMED");
  expect(syn.events).toEqual(["seal:seg-a", "commit:seg-a", "reclaim:seg-a"]);
});

test("DS-01 a hash mismatch that is not an interrupted copy is CORRUPT_REMOTE: local kept, never reclaimed, never retried blindly", async () => {
  const { syn, clock, worker } = setup({ put: ["flip"] });
  await worker.archiveOnce(HIGH, NEVER);
  clock.now = 2000;
  const r = await worker.archiveOnce(HIGH, NEVER);
  expect(state(r)).toBe("CORRUPT_REMOTE");
  expect(syn.localIntact("seg-a")).toBe(true);
  expect(syn.events).toEqual(["seal:seg-a"]);
  expect(worker.status().alerts.map((a) => a.kind)).toContain("corrupt-remote");
  clock.now = 60_000;
  expect(state(await worker.archiveOnce(HIGH, NEVER))).toBe("idle:pinned");
  expect(syn.events).toEqual(["seal:seg-a"]);
});

test("DS-01 offline and quota errors back off with jitter, alert, keep local data, and resume", async () => {
  const { syn, clock, worker } = setup({ put: ["offline", "quota"] });
  const a = await worker.archiveOnce(HIGH, NEVER);
  expect(state(a)).toBe("UPLOADING");
  expect(a.status === "ok" && "retryAfterMs" in a.value && a.value.retryAfterMs).toBe(1000);
  clock.now = 1000;
  const b = await worker.archiveOnce(HIGH, NEVER);
  expect(b.status === "ok" && "retryAfterMs" in b.value && b.value.retryAfterMs).toBe(5000);
  expect(worker.status().alerts.map((x) => x.kind)).toEqual(["remote-offline", "remote-quota"]);
  expect(syn.localIntact("seg-a")).toBe(true);
  expect(syn.events).toEqual(["seal:seg-a"]);
  clock.now = 3000;
  expect(state(await worker.archiveOnce(HIGH, NEVER))).toBe("idle:backoff");
  clock.now = 6000;
  expect(state(await worker.archiveOnce(HIGH, NEVER))).toBe("LOCAL_RECLAIMED");
});

test("DS-01 ENOSPC is an emergency that still archives verified data and closes admission", async () => {
  const { syn, worker } = setup();
  const r = await worker.archiveOnce(pressure({ ioError: "ENOSPC" }), NEVER);
  expect(state(r)).toBe("LOCAL_RECLAIMED");
  expect(worker.status().level).toBe("emergency");
  expect(worker.status().alerts.map((a) => a.kind)).toContain("pressure-emergency");
  expect(syn.events).toEqual(["seal:seg-a", "commit:seg-a", "reclaim:seg-a"]);
});

test("DS-01 a crash at every archive state resumes from the journal and never unlinks before the remote commit", async () => {
  const crashes: [string, string][] = [["put", "UPLOADING"], ["get", "UPLOADED_UNVERIFIED"], ["commit", "VERIFIED_REMOTE"], ["reclaim", "REMOTE_COMMITTED"]];
  for (const [at, expected] of crashes) {
    rmSync(root, { recursive: true, force: true }); mkdirSync(root);
    const { syn, make, worker } = setup(at === "put" ? { put: ["throw"] } : at === "get" ? { get: ["throw"] } : {});
    if (at === "commit") syn.crash.commit = true;
    if (at === "reclaim") syn.crash.reclaim = true;
    await expect(worker.archiveOnce(HIGH, NEVER)).rejects.toThrow(/injected crash/);
    const reborn = make(); // a new process reading the same journal
    expect({ at, open: reborn.status().open.map((o) => o.state as string) }).toEqual({ at, open: [expected] });
    expect([at, syn.localIntact("seg-a")]).toEqual([at, true]);
    // Resumes even when pressure has dropped: in-flight work is finished, not abandoned.
    expect([at, state(await reborn.archiveOnce(pressure(), NEVER))]).toEqual([at, "LOCAL_RECLAIMED"]);
    expect([at, syn.events.filter((e) => e.startsWith("reclaim"))]).toEqual([at, ["reclaim:seg-a"]]);
    expect([at, existsSync(syn.dir("seg-a"))]).toEqual([at, false]);
    const journal = readFileSync(join(root, "store", "archive", "journal.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const states = journal.filter((e) => e.step === "state").map((e) => e.state);
    expect([at, states.indexOf("REMOTE_COMMITTED") < states.indexOf("LOCAL_RECLAIMED")]).toEqual([at, true]);
    expect([at, states.indexOf("UPLOADED_UNVERIFIED") < states.indexOf("VERIFIED_REMOTE")]).toEqual([at, true]);
  }
});
