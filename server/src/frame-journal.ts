import { appendFile, mkdir, readdir, readFile, stat, truncate, unlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import {
  applyMuxDelta,
  chooseMuxOutputFrame,
  splitMuxOutputData,
  type MuxDeltaFrame,
  type MuxFullOutputFrame,
  shouldUseMuxDelta,
} from "@thumbmux/core";

/** Exact persisted NDJSON record shape (journal version 1). */
export interface FrameJournalRecordV1 {
  readonly v: 1;
  readonly session: string;
  readonly at: number;
  readonly frame: MuxFullOutputFrame | MuxDeltaFrame;
}

/** @deprecated since v0.8.0 — use FrameJournalRecordV1; removal no earlier than v0.9.0 */
export type JournalRecordV1 = FrameJournalRecordV1;

/** Error callback payload for isolated, session-scoped failures. */
export interface FrameJournalErrorReport {
  /** Session name this error belongs to. */
  readonly session: string;
  /** Resolved output file path for the session. */
  readonly path: string;
  /**
   * Error type for integration routing.
   * - `"recover"` — journal recovery/parse failure (or refuse-to-repair torn tail).
   * - `"write"` — append / first-write probe failure.
   * - `"limit"` — per-session `maxBytes` or aggregate `maxRootBytes` hard cap hit.
   * - `"drop"` — capture refused because `maxPendingWrites` backpressure is saturated.
   */
  readonly phase: "recover" | "write" | "limit" | "drop";
  /** Optional journal timestamp associated with the failing write or dropped capture. */
  readonly at?: number;
  /** Optional physical NDJSON line number when parsing recovered journals. */
  readonly line?: number;
  /** Original error object (or thrown value). */
  readonly cause: unknown;
}

/** Injectable asynchronous storage seam; the default uses Node/Bun filesystem APIs. */
export interface FrameJournalStorage {
  /** Create a directory, including any missing parents. */
  ensureDirectory(path: string): Promise<void>;
  /** Read a UTF-8 journal, rejecting with a normal ENOENT-shaped error when absent. */
  readText(path: string): Promise<string>;
  /** Append one complete UTF-8 NDJSON record. */
  appendText(path: string, source: string): Promise<void>;
  /** Truncate a journal back to a known-good byte offset (crash-tail repair). */
  truncate?(path: string, byteLength: number): Promise<void>;
  /**
   * List entry names directly under a directory (not recursive).
   * Used to establish durable aggregate root accounting on startup.
   */
  listNames?(dir: string): Promise<string[]>;
  /**
   * Return the on-disk byte length of a file.
   * Reject with an ENOENT-shaped error when the path is absent.
   */
  byteLength?(path: string): Promise<number>;
  /**
   * Delete a journal file. ENOENT is treated as success by the journal.
   * Required for `deleteSessionJournal`.
   */
  remove?(path: string): Promise<void>;
}

/** Optional constructor/input configuration for the journal. */
export interface FrameJournalOptions {
  /** Root directory that contains all session journal files. */
  readonly rootDir?: string;
  /** Deterministic clock source for capture timestamps (defaults to `Date.now`). */
  readonly clock?: () => number;
  /** Positive delta-run bound before forcing a full-frame checkpoint. */
  readonly checkpointCadence?: number;
  /**
   * Hard per-session journal size cap in UTF-8 bytes of the durable file.
   * Defaults to 64 MiB. Use `Infinity` to disable the cap.
   * Checked synchronously at capture admission (reserve-then-settle) and
   * rechecked against durable file length before each append.
   */
  readonly maxBytes?: number;
  /**
   * Hard aggregate cap on all `*.ndjson` journal files under `rootDir`.
   * Defaults to 256 MiB. Use `Infinity` to disable the cap.
   * Prevents unbounded disk growth across many closed/ephemeral sessions.
   * Checked at admission and rechecked after durable root accounting is known.
   */
  readonly maxRootBytes?: number;
  /**
   * Maximum number of admitted-but-not-yet-persisted captures per session.
   * Defaults to 128. Use `Infinity` to disable the cap.
   * When saturated, further `capture()` calls return `false` and report `phase: "drop"`.
   */
  readonly maxPendingWrites?: number;
  /** Hook for errors that should not escape capture hot paths. */
  readonly onError?: (report: FrameJournalErrorReport) => void;
  /** Optional deterministic storage adapter for hosts and focused tests. */
  readonly storage?: FrameJournalStorage;
}

/** Recover result for a started or recovered session handle. */
export interface RecoveredSessionState {
  /** Session channel this state owns. */
  readonly session: string;
  /** Safe session journal file path under the configured root. */
  readonly path: string;
  /** Canonical last persisted lines (`data.split("\n")`) if present. */
  readonly base: readonly string[];
  /** Number of records parsed during recovery; zero for fresh sessions. */
  readonly recordCount: number;
  /** Timestamp from the newest parsed record, or `null` for an empty journal. */
  readonly lastAt: number | null;
  /** Number of accepted delta records since the last persisted full checkpoint. */
  readonly deltasSinceCheckpoint: number;
}

interface SessionState {
  readonly session: string;
  readonly path: string;
  /** Canonical lines of the last successfully persisted full state. */
  base: string[] | null;
  /** Count of successfully persisted deltas since last full. */
  deltasSinceCheckpoint: number;
  /** Timestamp of last persisted record, if any. */
  lastAt: number | null;
  /** Number of successfully persisted records. */
  recordCount: number;
  /** Whether this recording currently admits new captures. */
  accepting: boolean;
  /** A corrupt recovery never silently resumes appending to that journal. */
  recoveryFailed: boolean;
  /** Per-session FIFO chain preserving in-order writes. */
  queue: Promise<void>;
  /**
   * Byte length of the valid complete prefix of the journal file
   * (the known-good write offset). Only authoritative when `bytesKnown`.
   */
  bytes: number;
  /** Whether `bytes` is authoritative for this session. */
  bytesKnown: boolean;
  /** Bytes reserved by admitted-but-not-yet-persisted captures. */
  reservedBytes: number;
  /** Count of admitted-but-not-yet-persisted captures. */
  pending: number;
  /** Sticky stop flag — once set, recovery must not re-arm accepting. */
  stopRequested: boolean;
  /** Whether a `phase: "limit"` error has already been reported for this session. */
  limitReported: boolean;
}

/** Default hard per-session journal size cap (64 MiB). */
export const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
/**
 * Default hard aggregate root cap across all session journals (256 MiB).
 * Conservative: ~4 full per-session caps. Integrators who configure nothing
 * get bounded disk use; raise or set `Infinity` explicitly if needed.
 */
export const DEFAULT_MAX_ROOT_BYTES = 256 * 1024 * 1024;
const DEFAULT_CHECKPOINT_CADENCE = 64;
const DEFAULT_MAX_PENDING_WRITES = 128;
const DEFAULT_ROOT = resolve(process.cwd(), "thumbmux-frame-journal");
const NODE_STORAGE: FrameJournalStorage = {
  ensureDirectory: async (path) => { await mkdir(path, { recursive: true }); },
  readText: async (path) => readFile(path, "utf8"),
  appendText: async (path, source) => { await appendFile(path, source, "utf8"); },
  truncate: async (path, byteLength) => { await truncate(path, byteLength); },
  listNames: async (dir) => readdir(dir),
  byteLength: async (path) => (await stat(path)).size,
  remove: async (path) => { await unlink(path); },
};

/** Host-neutral, per-session NDJSON output-frame journal for frame capture/replay. */
export class FrameJournal {
  /** @see DEFAULT_MAX_BYTES */
  public static readonly DEFAULT_MAX_BYTES = DEFAULT_MAX_BYTES;
  /** @see DEFAULT_MAX_ROOT_BYTES */
  public static readonly DEFAULT_MAX_ROOT_BYTES = DEFAULT_MAX_ROOT_BYTES;

  private readonly rootDir: string;
  private readonly clock: () => number;
  private readonly checkpointCadence: number;
  private readonly maxBytes: number;
  private readonly maxRootBytes: number;
  private readonly maxPendingWrites: number;
  private readonly onError: (report: FrameJournalErrorReport) => void;
  private readonly storage: FrameJournalStorage;
  private readonly rootReady: Promise<void>;
  private readonly sessions = new Map<string, SessionState>();
  private stopped = false;
  /**
   * Durable aggregate byte total of complete journal content under rootDir.
   * Authoritative after `rootReady` resolves.
   */
  private rootBytes = 0;
  private rootBytesKnown = false;
  /** Bytes reserved by admitted-but-not-yet-persisted captures across sessions. */
  private rootReservedBytes = 0;

  public constructor(options: FrameJournalOptions = {}) {
    this.rootDir = resolve(options.rootDir ?? DEFAULT_ROOT);
    this.clock = options.clock ?? (() => Date.now());
    this.checkpointCadence = options.checkpointCadence ?? DEFAULT_CHECKPOINT_CADENCE;
    if (!Number.isFinite(this.checkpointCadence) || !Number.isInteger(this.checkpointCadence) || this.checkpointCadence <= 0) {
      throw new Error("checkpointCadence must be a positive integer.");
    }
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    if (this.maxBytes !== Infinity && (!Number.isFinite(this.maxBytes) || this.maxBytes <= 0)) {
      throw new Error("maxBytes must be a finite positive number or Infinity.");
    }
    this.maxRootBytes = options.maxRootBytes ?? DEFAULT_MAX_ROOT_BYTES;
    if (this.maxRootBytes !== Infinity && (!Number.isFinite(this.maxRootBytes) || this.maxRootBytes <= 0)) {
      throw new Error("maxRootBytes must be a finite positive number or Infinity.");
    }
    this.maxPendingWrites = options.maxPendingWrites ?? DEFAULT_MAX_PENDING_WRITES;
    if (
      this.maxPendingWrites !== Infinity
      && (
        !Number.isFinite(this.maxPendingWrites)
        || !Number.isInteger(this.maxPendingWrites)
        || this.maxPendingWrites <= 0
      )
    ) {
      throw new Error("maxPendingWrites must be a positive integer or Infinity.");
    }
    this.onError = options.onError ?? (() => undefined);
    this.storage = options.storage ?? NODE_STORAGE;
    this.rootReady = this.storage.ensureDirectory(this.rootDir).then(() => this.scanRootBytes());
  }

  /**
   * Start a session without reading disk state. Use this when no prior journal is
   * expected or after a clean startup path.
   */
  public startSession(session: string): RecoveredSessionState {
    const state = this.getOrCreateState(session);
    if (!state.recoveryFailed) state.accepting = true;
    return this.snapshotState(state);
  }

  /**
   * Recover a session from an existing NDJSON journal.
   * Rejects on the first invalid complete line and reports only through the
   * injected error hook. A crash-torn trailing partial line is repaired via
   * `storage.truncate` when available; without truncate the session fails closed.
   */
  public async recoverSession(session: string): Promise<RecoveredSessionState> {
    const state = this.getOrCreateState(session);
    const recovery = state.queue.then(async () => {
      await this.rootReady;

      let source = "";
      try {
        source = await this.storage.readText(state.path);
      } catch (cause) {
        if (!isFileNotFound(cause)) throw cause;
        state.base = null;
        state.deltasSinceCheckpoint = 0;
        state.lastAt = null;
        state.recordCount = 0;
        state.recoveryFailed = false;
        state.bytes = 0;
        state.bytesKnown = true;
        state.accepting = !state.stopRequested;
        return this.snapshotState(state);
      }

      const prefix = completePrefixInfo(source);
      const priorFileBytes = Buffer.byteLength(source, "utf8");
      // Repair a crash-torn trailing partial line before accepting any writes.
      if (priorFileBytes > prefix.byteLength) {
        if (!this.storage.truncate) {
          throw new Error(
            "Journal has a crash-torn trailing line and storage.truncate is unavailable; refusing to accept writes.",
          );
        }
        await this.storage.truncate(state.path, prefix.byteLength);
        // Keep aggregate root accounting aligned with the repaired file size.
        this.adjustRootBytes(prefix.byteLength - priorFileBytes);
        source = source.slice(0, prefix.charLength);
      }
      state.bytes = prefix.byteLength;
      state.bytesKnown = true;

      const recovered = parseAndValidateJournal(source, session, this.checkpointCadence);
      state.base = recovered.base;
      state.deltasSinceCheckpoint = recovered.deltasSinceCheckpoint;
      state.lastAt = recovered.lastAt;
      state.recordCount = recovered.recordCount;
      state.recoveryFailed = false;
      state.accepting = !state.stopRequested;
      return this.snapshotState(state);
    });

    // Install the recovery barrier immediately, so a later capture cannot race
    // a read that is rebuilding this session's canonical base.
    state.queue = recovery.then(
      () => undefined,
      (cause) => {
        state.base = null;
        state.deltasSinceCheckpoint = 0;
        state.lastAt = null;
        state.recordCount = 0;
        state.recoveryFailed = true;
        // Always refuse writes after a corrupt recovery; also honor stopSession.
        state.accepting = false;
        this.reportError({ session, path: state.path, phase: "recover", cause });
      },
    );
    return recovery;
  }

  /** Return the absolute, safe path derived from a cryptographic hash. */
  public getSessionPath(session: string): string {
    return this.makeSessionPath(session);
  }

  /**
   * Number of sessions currently tracked in memory.
   * Drops to zero after `closeSession` / `stop` release their handles.
   */
  public get sessionCount(): number {
    return this.sessions.size;
  }

  /**
   * Durable aggregate byte total of journal files under the root (known after
   * the constructor's root scan completes; also updated on successful writes
   * and deletions). Useful for host dashboards and tests.
   */
  public get rootByteCount(): number {
    return this.rootBytes;
  }

  /**
   * Queue one canonical full snapshot write.
   * The call is synchronous and does not await disk I/O.
   * Returns `false` when the journal is stopped, the session is not accepting,
   * a size cap is exhausted, or write backpressure is saturated.
   */
  public capture(session: string, frame: MuxFullOutputFrame, at?: number): boolean {
    if (this.stopped) return false;
    const state = this.getOrCreateState(session);
    if (state.stopRequested || !state.accepting || state.recoveryFailed) return false;
    const fullFrame = normalizeFullFrame(session, frame);
    const recordAt = at ?? this.clock();
    if (!Number.isFinite(recordAt)) {
      throw new Error("Frame journal capture timestamp must be finite.");
    }

    // Bound in-flight write closures so a stalled storage cannot pin unbounded
    // pane snapshots in memory. Dropping intermediate samples is safe: each
    // queued write recomputes its delta against `state.base` at write time.
    if (state.pending >= this.maxPendingWrites) {
      this.reportError({
        session,
        path: state.path,
        phase: "drop",
        at: recordAt,
        cause: new Error("maxPendingWrites exceeded; capture dropped."),
      });
      return false;
    }

    // Synchronous admission-time size check (reserve-then-settle). Estimating
    // against a full-frame serialization is always an upper bound: a delta is
    // never larger than the full frame it replaces.
    //
    // When durable lengths are not yet known (reopen / root scan still pending),
    // admission may be provisional — persistCapture rechecks exact sizes after
    // ensureBytesKnown/rootReady and refuses the append if over either cap.
    let estimate = 0;
    const capsEnabled = this.maxBytes !== Infinity || this.maxRootBytes !== Infinity;
    if (capsEnabled) {
      estimate = Buffer.byteLength(
        JSON.stringify({ v: 1, session, at: recordAt, frame: fullFrame }),
        "utf8",
      ) + 33;

      if (this.maxBytes !== Infinity) {
        if (state.bytes + state.reservedBytes + estimate > this.maxBytes) {
          // Per-session cap is sticky: this file cannot shrink without delete.
          this.refuseSessionLimit(state, recordAt, "maxBytes exceeded; session recording stopped.");
          return false;
        }
      }
      if (this.maxRootBytes !== Infinity) {
        if (this.rootBytes + this.rootReservedBytes + estimate > this.maxRootBytes) {
          // Root cap is non-sticky: other sessions may free space later.
          this.reportRootLimit(state, recordAt);
          return false;
        }
      }

      if (this.maxBytes !== Infinity) state.reservedBytes += estimate;
      if (this.maxRootBytes !== Infinity) this.rootReservedBytes += estimate;
    }

    state.pending += 1;

    state.queue = state.queue.then(async () => {
      try {
        // A capture admitted while recovery was pending must not append after a
        // later recovery failure has declared the existing file corrupt.
        // Do NOT gate on `accepting` here: a later admission may have flipped
        // accepting=false (limit/stop) while this already-admitted write still
        // owes a durable attempt (stop()/flush wait on the queue for that).
        if (state.recoveryFailed) return;
        await this.persistCapture(state, fullFrame, recordAt);
      } finally {
        state.pending -= 1;
        if (this.maxBytes !== Infinity) state.reservedBytes -= estimate;
        if (this.maxRootBytes !== Infinity) this.rootReservedBytes -= estimate;
      }
    }).catch((cause) => {
      state.base = null;
      state.deltasSinceCheckpoint = 0;
      this.reportError({
        session,
        path: state.path,
        phase: "write",
        at: recordAt,
        cause,
      });
    });
    return true;
  }

  /**
   * Flush queued writes for one session and resolve when drained.
   * Never throws for captured write failures; use hook reports for diagnostics.
   */
  public async flushSession(session: string): Promise<void> {
    const state = this.sessions.get(session);
    if (!state) return;
    await state.queue;
  }

  /** Flush every active session queue and wait for completion. */
  public async flushAll(): Promise<void> {
    const flushes = Array.from(this.sessions.values()).map((state) => state.queue);
    await Promise.all(flushes);
  }

  /** Stop one recording after all captures already admitted to it are durable or reported. */
  public async stopSession(session: string): Promise<void> {
    const state = this.sessions.get(session);
    if (!state) return;
    // Set the sticky flag before awaiting so an in-flight recovery cannot re-arm.
    state.stopRequested = true;
    state.accepting = false;
    await state.queue;
    state.accepting = false;
  }

  /**
   * Stop a session and release its in-memory state (including the canonical base
   * snapshot) so long-lived hosts do not leak per-session memory.
   * A later `capture()` for the same name starts a fresh in-memory session that
   * appends to the same file beginning with a full frame.
   * Does **not** delete the durable journal file (root quota still accounts for it).
   * Use `deleteSessionJournal` to reclaim disk.
   */
  public async closeSession(session: string): Promise<void> {
    const state = this.sessions.get(session);
    if (!state) return;
    state.stopRequested = true;
    state.accepting = false;
    await state.queue;
    this.sessions.delete(session);
  }

  /**
   * Stop accepting captures for a session, flush pending writes, delete the
   * durable journal file under `rootDir`, release root accounting, and drop
   * in-memory state. Safe to call when the file is already absent (returns
   * `false`). Requires `storage.remove`.
   */
  public async deleteSessionJournal(session: string): Promise<boolean> {
    await this.rootReady;
    const path = this.makeSessionPath(session);
    const existing = this.sessions.get(session);
    let knownBytes: number | null = null;
    if (existing) {
      existing.stopRequested = true;
      existing.accepting = false;
      await existing.queue;
      if (existing.bytesKnown) knownBytes = existing.bytes;
      this.sessions.delete(session);
    }

    if (!this.storage.remove) {
      throw new Error("storage.remove is unavailable; cannot delete session journal.");
    }

    let removedBytes = knownBytes;
    if (removedBytes === null) {
      removedBytes = await this.measureFileBytes(path);
    }

    try {
      await this.storage.remove(path);
    } catch (cause) {
      if (!isFileNotFound(cause)) throw cause;
      return false;
    }

    if (removedBytes > 0) {
      this.adjustRootBytes(-removedBytes);
    }
    return true;
  }

  /** Flush all pending writes, stop accepting new writes, and release session state. */
  public async stop(): Promise<void> {
    this.stopped = true;
    for (const state of this.sessions.values()) {
      state.stopRequested = true;
      state.accepting = false;
    }
    await this.flushAll();
    this.sessions.clear();
  }

  private getOrCreateState(session: string): SessionState {
    const existing = this.sessions.get(session);
    if (existing) return existing;

    const path = this.makeSessionPath(session);
    const state: SessionState = {
      session,
      path,
      base: null,
      deltasSinceCheckpoint: 0,
      lastAt: null,
      recordCount: 0,
      accepting: true,
      recoveryFailed: false,
      queue: Promise.resolve(),
      bytes: 0,
      bytesKnown: false,
      reservedBytes: 0,
      pending: 0,
      stopRequested: false,
      limitReported: false,
    };
    this.sessions.set(session, state);
    return state;
  }

  private snapshotState(state: SessionState): RecoveredSessionState {
    return {
      session: state.session,
      path: state.path,
      base: state.base ? state.base.slice() : [],
      recordCount: state.recordCount,
      lastAt: state.lastAt,
      deltasSinceCheckpoint: state.deltasSinceCheckpoint,
    };
  }

  private makeSessionPath(session: string): string {
    const digest = hashSession(session);
    return join(this.rootDir, `${digest}.ndjson`);
  }

  private reportError(report: FrameJournalErrorReport): void {
    try {
      this.onError(report);
    } catch {
      // Error hooks must never crash hot-path behavior.
    }
  }

  /** Sticky per-session maxBytes refusal — further captures stay rejected. */
  private refuseSessionLimit(state: SessionState, at: number, message: string): void {
    state.accepting = false;
    if (!state.limitReported) {
      state.limitReported = true;
      this.reportError({
        session: state.session,
        path: state.path,
        phase: "limit",
        at,
        cause: new Error(message),
      });
    }
  }

  /**
   * Non-sticky aggregate root refusal. Report once per session handle, but keep
   * `accepting` true so a later `deleteSessionJournal` of another session can
   * free headroom and allow this session to record again.
   */
  private reportRootLimit(state: SessionState, at: number): void {
    if (!state.limitReported) {
      state.limitReported = true;
      this.reportError({
        session: state.session,
        path: state.path,
        phase: "limit",
        at,
        cause: new Error("maxRootBytes exceeded; capture refused."),
      });
    }
  }

  private adjustRootBytes(delta: number): void {
    this.rootBytes = Math.max(0, this.rootBytes + delta);
  }

  /**
   * Scan rootDir for `*.ndjson` files and establish durable aggregate accounting.
   * When list/size primitives are unavailable, start at 0 and track only writes
   * performed by this process (still bounded going forward).
   */
  private async scanRootBytes(): Promise<void> {
    if (!this.storage.listNames) {
      this.rootBytes = 0;
      this.rootBytesKnown = true;
      return;
    }

    let names: string[];
    try {
      names = await this.storage.listNames(this.rootDir);
    } catch {
      this.rootBytes = 0;
      this.rootBytesKnown = true;
      return;
    }

    let total = 0;
    for (const name of names) {
      if (!name.endsWith(".ndjson")) continue;
      const path = join(this.rootDir, name);
      total += await this.measureFileBytes(path);
    }
    this.rootBytes = total;
    this.rootBytesKnown = true;
  }

  private async measureFileBytes(path: string): Promise<number> {
    if (this.storage.byteLength) {
      try {
        return await this.storage.byteLength(path);
      } catch (cause) {
        if (isFileNotFound(cause)) return 0;
        throw cause;
      }
    }
    try {
      const text = await this.storage.readText(path);
      return Buffer.byteLength(text, "utf8");
    } catch (cause) {
      if (isFileNotFound(cause)) return 0;
      throw cause;
    }
  }

  /**
   * Establish `state.bytes` / `state.bytesKnown` from disk on the first write
   * of a session that never recovered (e.g. `startSession` or bare `capture`).
   * Repairs a crash-torn trailing line via truncate, or fails closed.
   */
  private async ensureBytesKnown(state: SessionState): Promise<void> {
    let source: string;
    try {
      source = await this.storage.readText(state.path);
    } catch (cause) {
      if (isFileNotFound(cause)) {
        state.bytes = 0;
        state.bytesKnown = true;
        return;
      }
      throw cause;
    }

    const prefix = completePrefixInfo(source);
    const priorFileBytes = Buffer.byteLength(source, "utf8");
    state.bytes = prefix.byteLength;
    state.bytesKnown = true;

    if (priorFileBytes > prefix.byteLength) {
      if (!this.storage.truncate) {
        state.accepting = false;
        state.recoveryFailed = true;
        throw new Error(
          "Journal has a crash-torn trailing line and storage.truncate is unavailable; refusing to append.",
        );
      }
      await this.storage.truncate(state.path, prefix.byteLength);
      this.adjustRootBytes(prefix.byteLength - priorFileBytes);
    }
  }

  private async persistCapture(state: SessionState, fullFrame: MuxFullOutputFrame, at: number): Promise<void> {
    await this.rootReady;

    if (!state.bytesKnown) {
      await this.ensureBytesKnown(state);
    }

    // The queue serializes this calculation with preceding writes, preventing a
    // backwards injected clock from creating an on-disk timeline replay rejects.
    const recordAt = state.lastAt === null ? at : Math.max(state.lastAt, at);

    const base = state.base;
    let frame: MuxFullOutputFrame | MuxDeltaFrame;
    if (
      base === null ||
      fullFrame.reset !== undefined ||
      state.deltasSinceCheckpoint >= this.checkpointCadence
    ) {
      frame = fullFrame;
    } else {
      frame = chooseMuxOutputFrame(fullFrame, base);
    }

    const record: FrameJournalRecordV1 = {
      v: 1,
      session: state.session,
      at: recordAt,
      frame,
    };

    let nextBase: string[];
    let nextDeltaCount = state.deltasSinceCheckpoint;
    if (frame.type === "delta") {
      if (!shouldUseMuxDelta(fullFrame, frame) || base === null) {
        nextBase = splitMuxOutputData(fullFrame.data);
        nextDeltaCount = 0;
      } else {
        const next = applyMuxDelta(base, frame);
        if (!next) {
          throw new Error("Unable to apply delta for persistent journal write.");
        }
        nextBase = next;
        nextDeltaCount = state.deltasSinceCheckpoint + 1;
      }
    } else {
      nextBase = splitMuxOutputData(frame.data);
      nextDeltaCount = 0;
    }

    const line = `${JSON.stringify(record)}\n`;
    const lineBytes = Buffer.byteLength(line, "utf8");

    // Recheck exact serialized size against durable counters now that
    // ensureBytesKnown / rootReady have established authoritative lengths.
    // This closes the reopen bypass where admission saw state.bytes === 0.
    if (this.maxBytes !== Infinity && state.bytes + lineBytes > this.maxBytes) {
      this.refuseSessionLimit(state, recordAt, "maxBytes exceeded; session recording stopped.");
      return;
    }
    if (this.maxRootBytes !== Infinity && this.rootBytes + lineBytes > this.maxRootBytes) {
      this.reportRootLimit(state, recordAt);
      return;
    }

    await this.storage.ensureDirectory(dirname(state.path));
    try {
      await this.storage.appendText(state.path, line);
    } catch (cause) {
      // Self-heal a partial append (e.g. ENOSPC) so a torn record cannot poison
      // the durable file. If rollback is unavailable or itself fails, fail closed:
      // leave accepting=false and recoveryFailed=true so the next capture cannot
      // append after torn bytes and destroy every earlier valid record.
      let rolledBack = false;
      if (state.bytesKnown && this.storage.truncate) {
        try {
          await this.storage.truncate(state.path, state.bytes);
          rolledBack = true;
        } catch {
          rolledBack = false;
        }
      }
      if (!rolledBack) {
        state.recoveryFailed = true;
        state.accepting = false;
      }
      throw cause;
    }

    state.bytes += lineBytes;
    this.adjustRootBytes(lineBytes);
    state.base = nextBase;
    state.deltasSinceCheckpoint = nextDeltaCount;
    state.lastAt = recordAt;
    state.recordCount += 1;
  }
}

/**
 * Byte/char length of the last complete NDJSON line prefix.
 * A torn tail (no trailing newline) lies entirely after this offset; measuring
 * only the complete prefix is safe even when the torn bytes decode to
 * replacement characters under UTF-8.
 */
function completePrefixInfo(source: string): { charLength: number; byteLength: number } {
  const lastNewline = source.lastIndexOf("\n");
  if (lastNewline === -1) {
    return { charLength: 0, byteLength: 0 };
  }
  const charLength = lastNewline + 1;
  return {
    charLength,
    byteLength: Buffer.byteLength(source.slice(0, charLength), "utf8"),
  };
}

function hashSession(session: string): string {
  if (typeof session !== "string") throw new Error("Frame journal session must be a string.");
  // Hash the exact session identifier. Normalizing/trimming here could merge
  // distinct host sessions and route one journal into another's opaque file.
  return createHash("sha256").update(session, "utf8").digest("hex");
}

function isFileNotFound(cause: unknown): boolean {
  return Boolean(
    cause &&
      typeof cause === "object" &&
      "code" in cause &&
      (cause as { code?: unknown }).code === "ENOENT",
  );
}

function normalizeFullFrame(session: string, frame: MuxFullOutputFrame): MuxFullOutputFrame {
  if (frame.type !== "output") {
    throw new Error("Frame journal only accepts output frames as captures.");
  }
  if (frame.channel !== session) {
    throw new Error("Frame journal capture channel must equal its session.");
  }
  if (typeof frame.data !== "string") {
    throw new Error("Frame journal capture data must be a string.");
  }
  const canonical: MuxFullOutputFrame = {
    channel: session,
    type: "output",
    data: frame.data,
  };
  // Fail closed at admission: JSON turns NaN into null, so a non-finite cursor
  // would poison the file into a shape parseReplayJournal rejects wholesale.
  if (Object.prototype.hasOwnProperty.call(frame, "cursor")) {
    const cursor = frame.cursor as unknown;
    if (cursor === undefined) {
      // Explicit undefined is treated as "absent" (not persisted).
    } else if (cursor === null) {
      canonical.cursor = null;
    } else if (isFiniteIntegerCursor(cursor)) {
      canonical.cursor = { row: cursor.row, col: cursor.col };
    } else {
      throw new Error(
        "Frame journal capture cursor must be {row:number,col:number} or null.",
      );
    }
  }
  if (Object.prototype.hasOwnProperty.call(frame, "reset")) {
    const reset = frame.reset as unknown;
    if (reset !== "resize" && reset !== "resync") {
      throw new Error(
        'Frame journal capture reset must be "resize" or "resync".',
      );
    }
    canonical.reset = reset;
  }
  return canonical;
}

/** Cursor shape accepted by both admission and parseReplayJournal. */
function isFiniteIntegerCursor(
  value: unknown,
): value is { row: number; col: number } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const cursor = value as Record<string, unknown>;
  // Exact key set matches parseOptionalCursor / core replay parser.
  if (
    Object.keys(cursor).length !== 2
    || !Object.prototype.hasOwnProperty.call(cursor, "row")
    || !Object.prototype.hasOwnProperty.call(cursor, "col")
  ) {
    return false;
  }
  // Number.isInteger is false for NaN, ±Infinity, non-integers, and non-numbers.
  return Number.isInteger(cursor.row) && Number.isInteger(cursor.col);
}

function parseAndValidateJournal(
  source: string,
  expectedSession: string,
  checkpointCadence: number,
): {
  base: string[];
  lastAt: number | null;
  recordCount: number;
  deltasSinceCheckpoint: number;
} {
  const lines = splitCompleteNdjsonLines(source);
  if (lines.length === 0) {
    return { base: [], lastAt: null, recordCount: 0, deltasSinceCheckpoint: 0 };
  }

  let currentBase: string[] | null = null;
  let deltaCount = 0;
  let previousAt = Number.NEGATIVE_INFINITY;
  let recordCount = 0;
  let lastAt: number | null = null;

  for (let i = 0; i < lines.length; i += 1) {
    const rawLine = lines[i];
    const lineNo = i + 1;
    if (rawLine.length === 0) {
      throw new Error(`Malformed blank line at NDJSON line ${lineNo}.`);
    }

    const record = parseJournalRecord(rawLine, lineNo);
    if (record.session !== expectedSession) {
      throw new Error(
        `Session mismatch at NDJSON line ${lineNo}: expected "${expectedSession}" but got "${record.session}".`,
      );
    }
    if (!Number.isFinite(record.at)) {
      throw new Error(`Invalid at timestamp at NDJSON line ${lineNo}: must be finite.`);
    }
    if (record.at < previousAt) {
      throw new Error(
        `Out-of-order timestamp at NDJSON line ${lineNo}: ${record.at} < ${previousAt}.`,
      );
    }

    if (record.frame.channel !== record.session) {
      throw new Error(
        `Session/channel mismatch at NDJSON line ${lineNo}: record.session="${record.session}" but frame.channel="${record.frame.channel}".`,
      );
    }

    if (recordCount === 0 && record.frame.type === "delta") {
      throw new Error(
        `Invalid first record at NDJSON line ${lineNo}: journal must start with a full frame.`,
      );
    }

    if (record.frame.type === "output") {
      currentBase = splitMuxOutputData(record.frame.data);
      deltaCount = 0;
    } else {
      if (currentBase === null) {
        throw new Error(
          `Invalid delta at NDJSON line ${lineNo}: no prior full frame available.`,
        );
      }
      const next = applyMuxDelta(currentBase, record.frame);
      if (!next) {
        throw new Error(
          `Invalid delta at NDJSON line ${lineNo}: apply failed against current base.`,
        );
      }
      const candidate: MuxFullOutputFrame = {
        channel: expectedSession,
        type: "output" as const,
        data: next.join("\n"),
      };
      if (Object.prototype.hasOwnProperty.call(record.frame, "cursor")) {
        candidate.cursor = record.frame.cursor;
      }
      if (!shouldUseMuxDelta(candidate, record.frame)) {
        throw new Error(
          `Invalid delta at NDJSON line ${lineNo}: candidate delta is not eligible under strict protocol semantics.`,
        );
      }
      currentBase = next;
      deltaCount += 1;
      if (deltaCount > checkpointCadence) {
        throw new Error(
          `Checkpoint cadence exceeded at NDJSON line ${lineNo}: more than ${checkpointCadence} deltas follow one full frame.`,
        );
      }
    }

    recordCount += 1;
    previousAt = record.at;
    lastAt = record.at;
  }

  return {
    base: currentBase ?? [],
    lastAt,
    recordCount,
    deltasSinceCheckpoint: deltaCount,
  };
}

function splitCompleteNdjsonLines(source: string): string[] {
  const lines: string[] = [];
  let start = 0;
  while (true) {
    const newline = source.indexOf("\n", start);
    if (newline === -1) break;
    lines.push(source.slice(start, newline));
    start = newline + 1;
  }
  return lines;
}

function parseJournalRecord(rawLine: string, lineNo: number): FrameJournalRecordV1 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawLine);
  } catch (cause) {
    throw new Error(
      `Malformed JSON at NDJSON line ${lineNo}: ${cause instanceof Error ? cause.message : "invalid JSON."}`,
    );
  }

  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`Invalid record at NDJSON line ${lineNo}: must be an object.`);
  }

  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record);
  const expected = ["v", "session", "at", "frame"];
  if (keys.length !== expected.length || keys.some((key) => !expected.includes(key))) {
    throw new Error(
      `Invalid record shape at NDJSON line ${lineNo}: must contain exactly v, session, at, frame.`,
    );
  }

  if (record.v !== 1) {
    throw new Error(`Invalid journal version at NDJSON line ${lineNo}: expected 1.`);
  }
  if (typeof record.session !== "string") {
    throw new Error(
      `Invalid session at NDJSON line ${lineNo}: expected a string session.`,
    );
  }
  if (typeof record.at !== "number" || !Number.isFinite(record.at)) {
    throw new Error(
      `Invalid at at NDJSON line ${lineNo}: expected a finite number.`,
    );
  }

  const frame = parseFrame(record.frame, lineNo, record.session);
  return {
    v: 1,
    session: record.session,
    at: record.at,
    frame,
  };
}

function parseFrame(
  value: unknown,
  lineNo: number,
  session: string,
): MuxFullOutputFrame | MuxDeltaFrame {
  if (value === null || typeof value !== "object") {
    throw new Error(`Invalid frame at NDJSON line ${lineNo}: must be an object.`);
  }

  const frame = value as Record<string, unknown>;
  const type = frame.type;
  if (type === "output") {
    return parseFullFrame(frame, lineNo, session);
  }
  if (type === "delta") {
    return parseDeltaFrame(frame, lineNo, session);
  }
  throw new Error(
    `Invalid frame at NDJSON line ${lineNo}: unsupported frame type "${String(type)}".`,
  );
}

function parseFullFrame(
  frame: Record<string, unknown>,
  lineNo: number,
  session: string,
): MuxFullOutputFrame {
  const keys = Object.keys(frame);
  const allowed = new Set(["channel", "type", "data", "cursor", "reset"]);
  const required = ["channel", "type", "data"] as const;
  if (keys.some((key) => !allowed.has(key))) {
    throw new Error(
      `Invalid full frame keys at NDJSON line ${lineNo}: unexpected property "${keys.find((key) => !allowed.has(key))}".`,
    );
  }
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(frame, key)) {
      throw new Error(
        `Invalid full frame at NDJSON line ${lineNo}: missing "${key}".`,
      );
    }
  }
  if (typeof frame.channel !== "string" || frame.channel !== session) {
    throw new Error(
      `Invalid full frame at NDJSON line ${lineNo}: channel must equal record.session.`,
    );
  }
  if (frame.type !== "output" || typeof frame.type !== "string") {
    throw new Error(
      `Invalid full frame at NDJSON line ${lineNo}: expected type "output".`,
    );
  }
  if (typeof frame.data !== "string") {
    throw new Error(
      `Invalid full frame at NDJSON line ${lineNo}: data must be a string.`,
    );
  }
  if (Object.prototype.hasOwnProperty.call(frame, "reset")) {
    if (frame.reset !== "resize" && frame.reset !== "resync") {
      throw new Error(
        `Invalid full frame at NDJSON line ${lineNo}: reset must be "resize" or "resync".`,
      );
    }
  }

  const cursor = parseOptionalCursor(frame, lineNo, "full frame");
  const parsed: MuxFullOutputFrame = {
    channel: session,
    type: "output",
    data: frame.data,
  };
  if (cursor !== undefined) parsed.cursor = cursor;
  if (Object.prototype.hasOwnProperty.call(frame, "reset")) {
    parsed.reset = frame.reset === "resize" || frame.reset === "resync"
      ? frame.reset
      : undefined;
  }
  return parsed;
}

function parseDeltaFrame(
  frame: Record<string, unknown>,
  lineNo: number,
  session: string,
): MuxDeltaFrame {
  const keys = Object.keys(frame);
  const allowed = new Set(["channel", "type", "baseLength", "prefix", "prefixHash", "lines", "cursor"]);
  const required = ["channel", "type", "baseLength", "prefix", "prefixHash", "lines"] as const;
  if (keys.some((key) => !allowed.has(key))) {
    throw new Error(
      `Invalid delta frame keys at NDJSON line ${lineNo}: unexpected property "${keys.find((key) => !allowed.has(key))}".`,
    );
  }
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(frame, key)) {
      throw new Error(
        `Invalid delta frame at NDJSON line ${lineNo}: missing "${key}".`,
      );
    }
  }
  if (typeof frame.channel !== "string" || frame.channel !== session) {
    throw new Error(
      `Invalid delta frame at NDJSON line ${lineNo}: channel must equal record.session.`,
    );
  }
  if (frame.type !== "delta" || typeof frame.type !== "string") {
    throw new Error(
      `Invalid delta frame at NDJSON line ${lineNo}: expected type "delta".`,
    );
  }
  if (typeof frame.baseLength !== "number" || !Number.isInteger(frame.baseLength) || frame.baseLength < 0) {
    throw new Error(
      `Invalid delta frame at NDJSON line ${lineNo}: baseLength must be a non-negative integer.`,
    );
  }
  if (typeof frame.prefix !== "number" || !Number.isInteger(frame.prefix) || frame.prefix < 0) {
    throw new Error(
      `Invalid delta frame at NDJSON line ${lineNo}: prefix must be a non-negative integer.`,
    );
  }
  if (typeof frame.prefixHash !== "string") {
    throw new Error(
      `Invalid delta frame at NDJSON line ${lineNo}: prefixHash must be a string.`,
    );
  }
  if (!Array.isArray(frame.lines) || !frame.lines.every((line) => typeof line === "string")) {
    throw new Error(
      `Invalid delta frame at NDJSON line ${lineNo}: lines must be string[].`,
    );
  }
  const cursor = parseOptionalCursor(frame, lineNo, "delta frame");
  if (frame.baseLength < 0 || frame.prefix > frame.baseLength) {
    throw new Error(
      `Invalid delta frame at NDJSON line ${lineNo}: prefix must be <= baseLength.`,
    );
  }

  return {
    channel: frame.channel,
    type: "delta",
    baseLength: frame.baseLength,
    prefix: frame.prefix,
    prefixHash: frame.prefixHash,
    lines: frame.lines.slice(),
    ...(Object.prototype.hasOwnProperty.call(frame, "cursor") ? { cursor } : {}),
  };
}

function parseOptionalCursor(
  frame: Record<string, unknown>,
  lineNo: number,
  frameKind: "full frame" | "delta frame",
): { row: number; col: number } | null | undefined {
  if (!Object.prototype.hasOwnProperty.call(frame, "cursor")) return undefined;
  const value = frame.cursor;
  if (value === null) return null;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(
      `Invalid ${frameKind} at NDJSON line ${lineNo}: cursor must be {row:number,col:number} or null.`,
    );
  }
  const cursor = value as Record<string, unknown>;
  if (
    Object.keys(cursor).length !== 2 ||
    !Number.isInteger(cursor.row as number) ||
    !Number.isInteger(cursor.col as number)
  ) {
    throw new Error(
      `Invalid ${frameKind} at NDJSON line ${lineNo}: cursor must be {row:number,col:number} or null.`,
    );
  }
  return {
    row: cursor.row as number,
    col: cursor.col as number,
  };
}
