/**
 * Journal replay primitives for `mux` NDJSON output journals.
 *
 * The journal format is line-oriented NDJSON, where each line is one JSON object:
 * `{ v:1, session, at, frame }`.
 *
 * `at` is treated as an ordered wall-clock timeline (milliseconds or any finite
 * numeric domain with ordering), and lookup uses clamped floor semantics:
 *  - `time <= first.at` clamps to the first record,
 *  - `time >= last.at` clamps to the last record,
 *  - otherwise we seek the latest record with `record.at <= time`.
 */
import {
  applyMuxDelta,
  shouldUseMuxDelta,
  splitMuxOutputData,
  validateMuxDeltaFrame,
  type MuxCursor,
  type MuxDeltaFrame,
  type MuxFullOutputFrame,
} from "./protocol";

type JournalJsonMap = Record<string, unknown>;

/** Exact journal record shape for replay input. */
export type JournalRecordV1 = {
  v: 1;
  session: string;
  at: number;
  frame: MuxFullOutputFrame | MuxDeltaFrame;
};

/** Parsed record paired with its original NDJSON payload (without trailing newline). */
export interface ParsedReplayRecord {
  /** Canonical timeline time for this record. */
  at: number;
  /** Parsed and validated record. */
  record: JournalRecordV1;
  /** Raw NDJSON line content for this record. */
  rawLine: string;
}

/** Immutable full-frame checkpoint used for bounded replay seeks. */
export interface ReplayFullCheckpoint {
  /** Index of the source journal record that became this checkpoint. */
  recordIndex: number;
  /** Timeline time for the full frame record. */
  at: number;
  /** Immutable canonical full frame. */
  frame: MuxFullOutputFrame;
  /** Immutable raw output lines for the checkpoint frame data. */
  lines: readonly string[];
  /** Raw NDJSON line content for this checkpoint record. */
  rawLine: string;
}

/** Reconstructed state returned by timeline lookup operations. */
export interface ReplayLookup {
  /** Time clamped/bounded to the journal timeline and selected record time. */
  at: number;
  /** Index of the selected source record in timeline order. */
  recordIndex: number;
  /** Reconstructed full output at the selected time. */
  frame: MuxFullOutputFrame;
  /** Reconstructed output lines at the selected time (`data.split("\\n")`). */
  lines: readonly string[];
  /** The source NDJSON line for the selected record. */
  rawLine: string;
}

/**
 * Internal seek snapshot stride. During parse we retain a free snapshot of the
 * materialized base at every Nth record so reconstruction is O(stride) worst
 * case rather than O(journal length). Full-frame checkpoints are always
 * snapshotted too (and share this slot when their index is a multiple of N).
 */
const SEEK_SNAPSHOT_STRIDE = 64;

/** Internal materialized state used as a reconstruction start point. */
interface SeekSnapshot {
  recordIndex: number;
  lines: readonly string[];
  cursor?: MuxCursor | null;
}

/** Timeline API over a validated journal. */
export class ReplayJournal {
  private readonly session: string;
  private readonly records: readonly ParsedReplayRecord[];
  private readonly checkpoints: readonly ReplayFullCheckpoint[];
  private readonly seekSnapshots: readonly SeekSnapshot[];
  private readonly firstAt: number;
  private readonly lastAt: number;
  /** Memo of the most recent reconstruction — makes repeated/forward seeks O(1) amortized. */
  private lastState: SeekSnapshot | null = null;

  private constructor(
    session: string,
    records: ParsedReplayRecord[],
    checkpoints: ReplayFullCheckpoint[],
    seekSnapshots: SeekSnapshot[],
  ) {
    this.session = session;
    this.records = records;
    this.checkpoints = checkpoints;
    this.seekSnapshots = seekSnapshots;
    this.firstAt = records[0].at;
    this.lastAt = records[records.length - 1].at;
  }

  /**
   * Construct only from records already validated by this module.
   * `seekSnapshots` is optional: when omitted, full-frame checkpoints are used
   * as the only reconstruction start points (legacy public 3-arg signature).
   */
  public static fromValidated(
    session: string,
    records: ParsedReplayRecord[],
    checkpoints: ReplayFullCheckpoint[],
    seekSnapshots?: SeekSnapshot[],
  ): ReplayJournal {
    const snapshots =
      seekSnapshots
      ?? checkpoints.map((checkpoint) => ({
        recordIndex: checkpoint.recordIndex,
        lines: checkpoint.lines,
        cursor: cloneCursor(checkpoint.frame.cursor),
      }));
    return new ReplayJournal(session, records, checkpoints, snapshots);
  }

  /** Total duration covered by parsed records (`lastAt - firstAt`). */
  public get durationMs(): number {
    return this.lastAt - this.firstAt;
  }

  /** Time of the first parsed journal record. */
  public get startAt(): number {
    return this.firstAt;
  }

  /** Time of the last parsed journal record. */
  public get endAt(): number {
    return this.lastAt;
  }

  /** Canonical session for this journal. */
  public get sessionName(): string {
    return this.session;
  }

  /** Number of parsed journal records. */
  public get count(): number {
    return this.records.length;
  }

  /** Number of immutable full-frame checkpoints. */
  public get checkpointCount(): number {
    return this.checkpoints.length;
  }

  /** Read-only access to full-frame checkpoints. */
  public get fullCheckpoints(): readonly ReplayFullCheckpoint[] {
    return this.checkpoints.map((checkpoint) => ({
      ...checkpoint,
      frame: cloneFullFrame(checkpoint.frame),
      lines: checkpoint.lines.slice(),
    }));
  }

  /** Return reconstructed full output at a given timeline time. */
  public getFrameAt(time: number): MuxFullOutputFrame {
    return this.seek(time).frame;
  }

  /** Return reconstructed raw output lines at a given timeline time. */
  public getLinesAt(time: number): readonly string[] {
    return this.seek(time).lines;
  }

  /** Return source NDJSON line at a given timeline time. */
  public getRawLineAt(time: number): string {
    return this.seek(time).rawLine;
  }

  /** Return full replay lookup at a given timeline time. */
  public seek(time: number): ReplayLookup {
    if (!Number.isFinite(time)) {
      throw new Error(`Cannot seek with non-finite time: ${String(time)}`);
    }

    const recordIndex = this.findRecordIndexByTime(time);
    const record = this.records[recordIndex];
    const state = this.reconstructState(recordIndex);
    const selectedFrame = record.record.frame;
    const frame = makeFrameFromReconstruction(this.session, state.lines, state.cursor);
    if (selectedFrame.type === "output" && Object.prototype.hasOwnProperty.call(selectedFrame, "reset")) {
      frame.reset = selectedFrame.reset;
    }
    return {
      at: record.record.at,
      recordIndex,
      frame,
      // Never hand out the memoized / snapshot array itself — callers must not
      // be able to corrupt internal reconstruction state via mutation.
      lines: state.lines.slice(),
      rawLine: record.rawLine,
    };
  }

  private findRecordIndexByTime(time: number): number {
    if (time <= this.firstAt) return 0;
    if (time >= this.lastAt) return this.records.length - 1;

    let low = 0;
    let high = this.records.length - 1;
    while (low < high) {
      const mid = Math.floor((low + high + 1) / 2);
      if (this.records[mid].at <= time) {
        low = mid;
      } else {
        high = mid - 1;
      }
    }
    return low;
  }

  private reconstructState(recordIndex: number): { lines: readonly string[]; cursor?: MuxCursor | null } {
    if (this.checkpoints.length === 0) {
      throw new Error("Replay has no full-frame checkpoints.");
    }

    const snapshot = this.findSeekSnapshotForRecordIndex(recordIndex);

    let startIndex: number;
    let lines: readonly string[];
    let cursor: MuxCursor | null | undefined;

    // Prefer the memoized last reconstruction when it is at least as recent as
    // the nearest snapshot and still at-or-before the target. Repeated seeks at
    // the same index become O(1); forward playback is O(1) amortized.
    if (
      this.lastState !== null
      && this.lastState.recordIndex <= recordIndex
      && this.lastState.recordIndex >= snapshot.recordIndex
    ) {
      startIndex = this.lastState.recordIndex;
      lines = this.lastState.lines;
      cursor = cloneCursor(this.lastState.cursor);
    } else {
      startIndex = snapshot.recordIndex;
      // Copy so stepping never mutates a retained snapshot array.
      lines = snapshot.lines.slice();
      cursor = cloneCursor(snapshot.cursor);
    }

    for (let i = startIndex + 1; i <= recordIndex; i += 1) {
      const frame = this.records[i].record.frame;
      if (frame.type === "output") {
        lines = splitMuxOutputData(frame.data);
        cursor = cloneCursor(frame.cursor);
        continue;
      }

      const next = applyMuxDelta(lines, frame);
      if (!next) {
        throw new Error(
          `Reconstruction invariant broken at record ${i} (${this.records[i].at})`,
        );
      }
      if (Object.prototype.hasOwnProperty.call(frame, "cursor")) {
        cursor = cloneCursor(frame.cursor);
      }
      lines = next;
    }

    const resultCursor = cloneCursor(cursor);
    this.lastState = {
      recordIndex,
      lines,
      cursor: resultCursor,
    };
    return { lines, cursor: resultCursor };
  }

  /** Greatest seek snapshot with `recordIndex <= target` (binary search). */
  private findSeekSnapshotForRecordIndex(recordIndex: number): SeekSnapshot {
    let low = 0;
    let high = this.seekSnapshots.length - 1;
    while (low < high) {
      const mid = Math.floor((low + high + 1) / 2);
      if (this.seekSnapshots[mid].recordIndex <= recordIndex) {
        low = mid;
      } else {
        high = mid - 1;
      }
    }
    return this.seekSnapshots[low];
  }
}

/** Parse and validate a Journal V1 NDJSON payload into a strict replay timeline. */
export function parseReplayJournal(source: string): ReplayJournal {
  const parsedRecords = [] as ParsedReplayRecord[];
  const checkpoints = [] as ReplayFullCheckpoint[];
  const seekSnapshots = [] as SeekSnapshot[];
  const lines = splitCompleteNdjsonLines(source);

  if (lines.length === 0) {
    throw new Error("Journal contains no complete NDJSON records.");
  }

  let activeSession: string | null = null;
  let currentBase: string[] | null = null;
  let currentCursor: MuxCursor | null | undefined;
  let previousAt = Number.NEGATIVE_INFINITY;

  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index];
    const physicalLine = index + 1;

    if (rawLine.length === 0) {
      throw new Error(`Malformed blank line at NDJSON line ${physicalLine}.`);
    }

    const record = parseJournalRecord(rawLine, physicalLine);
    if (activeSession === null) {
      activeSession = record.session;
    } else if (record.session !== activeSession) {
      throw new Error(
        `Session mismatch at NDJSON line ${physicalLine}: expected "${activeSession}", got "${record.session}".`,
      );
    }

    if (record.frame.channel !== record.session) {
      throw new Error(
        `Session/channel mismatch at NDJSON line ${physicalLine}: record.session="${record.session}" but frame.channel="${record.frame.channel}".`,
      );
    }

    if (!Number.isFinite(record.at)) {
      throw new Error(
        `Invalid at timestamp at NDJSON line ${physicalLine}: must be finite.`,
      );
    }
    if (record.at < previousAt) {
      throw new Error(
        `Out-of-order timestamp at NDJSON line ${physicalLine}: ${record.at} < ${previousAt}.`,
      );
    }
    previousAt = record.at;

    if (index === 0 && record.frame.type === "delta") {
      throw new Error(
        `Invalid first record at NDJSON line ${physicalLine}: journal must start with a full frame.`,
      );
    }

    parsedRecords.push({
      at: record.at,
      record,
      rawLine,
    });

    if (record.frame.type === "output") {
      const fullLines = splitMuxOutputData(record.frame.data);
      currentBase = fullLines;
      currentCursor = record.frame.cursor;

      checkpoints.push({
        recordIndex: index,
        at: record.at,
        frame: cloneFullFrame(record.frame),
        lines: fullLines.slice(),
        rawLine,
      });
      // Full frames are always seek snapshots. Store `lines` by reference —
      // nothing mutates these arrays after materialization.
      seekSnapshots.push({
        recordIndex: index,
        lines: currentBase,
        cursor: cloneCursor(currentCursor),
      });
      continue;
    }

    if (currentBase === null) {
      throw new Error(
        `Invalid delta at NDJSON line ${physicalLine}: no prior full frame available.`,
      );
    }

    const delta = validateMuxDeltaFrame(record.frame, currentBase);
    if (!delta) {
      throw new Error(
        `Invalid delta at NDJSON line ${physicalLine}: does not validate against current base.`,
      );
    }

    const candidateNext = applyMuxDelta(currentBase, delta);
    if (!candidateNext) {
      throw new Error(
        `Invalid delta at NDJSON line ${physicalLine}: apply failed against current base.`,
      );
    }

    const nextCursor =
      Object.prototype.hasOwnProperty.call(delta, "cursor") ? delta.cursor : currentCursor;
    const candidateFull: MuxFullOutputFrame = {
      channel: activeSession,
      type: "output",
      data: candidateNext.join("\n"),
    };
    if (Object.prototype.hasOwnProperty.call(delta, "cursor")) {
      candidateFull.cursor = cloneCursor(delta.cursor);
    }

    if (!shouldUseMuxDelta(candidateFull, delta)) {
      throw new Error(
        `Invalid delta at NDJSON line ${physicalLine}: candidate delta is not eligible under strict protocol size semantics.`,
      );
    }

    currentBase = candidateNext;
    currentCursor = nextCursor;

    // Stride snapshots (full frames already recorded above — no duplicate when
    // a full-frame index is also a multiple of the stride).
    if (index % SEEK_SNAPSHOT_STRIDE === 0) {
      seekSnapshots.push({
        recordIndex: index,
        lines: currentBase,
        cursor: cloneCursor(currentCursor),
      });
    }
  }

  if (activeSession === null) {
    throw new Error("Journal contains no complete NDJSON records.");
  }
  return ReplayJournal.fromValidated(activeSession, parsedRecords, checkpoints, seekSnapshots);
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

function makeFrameFromReconstruction(
  channel: string,
  lines: readonly string[],
  cursor?: MuxCursor | null,
): MuxFullOutputFrame {
  const frame: MuxFullOutputFrame = {
    channel,
    type: "output",
    data: lines.join("\n"),
  };
  if (cursor !== undefined) {
    frame.cursor = cloneCursor(cursor);
  }
  return frame;
}

function parseJournalRecord(rawLine: string, lineNo: number): JournalRecordV1 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawLine);
  } catch (error) {
    throw new Error(
      `Malformed JSON at NDJSON line ${lineNo}: ${error instanceof Error ? error.message : "invalid JSON."}`,
    );
  }

  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`Invalid record at NDJSON line ${lineNo}: must be an object.`);
  }

  const record = parsed as JournalJsonMap;
  const keyCount = Object.keys(record).length;
  const expectedKeys = new Set(["v", "session", "at", "frame"]);
  if (keyCount !== expectedKeys.size) {
    throw new Error(
      `Invalid record shape at NDJSON line ${lineNo}: must contain exactly v, session, at, frame.`,
    );
  }
  for (const key of expectedKeys) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) {
      throw new Error(
        `Invalid record shape at NDJSON line ${lineNo}: missing "${key}".`,
      );
    }
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
  if (typeof value !== "object" || value === null) {
    throw new Error(`Invalid frame at NDJSON line ${lineNo}: must be an object.`);
  }

  const frame = value as JournalJsonMap;
  if (frame.type === undefined) {
    throw new Error(`Invalid frame at NDJSON line ${lineNo}: missing "type".`);
  }

  if (frame.type === "output") {
    return parseFullOutputFrame(frame, lineNo, session);
  }
  if (frame.type === "delta") {
    return parseRawDeltaFrame(frame, lineNo, session);
  }

  throw new Error(
    `Invalid frame at NDJSON line ${lineNo}: unsupported frame type "${String(frame.type)}".`,
  );
}

function parseFullOutputFrame(
  frame: JournalJsonMap,
  lineNo: number,
  session: string,
): MuxFullOutputFrame {
  const required = ["channel", "type", "data"];
  const allowed = new Set(["channel", "type", "data", "cursor", "reset"]);
  for (const key of Object.keys(frame)) {
    if (!allowed.has(key)) {
      throw new Error(
        `Invalid full frame keys at NDJSON line ${lineNo}: unexpected property "${key}".`,
      );
    }
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
  if (frame.type !== "output") {
    throw new Error(
      `Invalid full frame at NDJSON line ${lineNo}: expected type "output".`,
    );
  }
  if (typeof frame.data !== "string") {
    throw new Error(
      `Invalid full frame at NDJSON line ${lineNo}: data must be a string.`,
    );
  }
  let reset: "resize" | "resync" | undefined;
  if (Object.prototype.hasOwnProperty.call(frame, "reset")) {
    const candidateReset = frame.reset;
    if (candidateReset !== "resize" && candidateReset !== "resync") {
      throw new Error(
        `Invalid full frame at NDJSON line ${lineNo}: reset must be "resize" or "resync".`,
      );
    }
    reset = candidateReset;
  }
  const cursor = parseOptionalCursor(frame, lineNo, "full frame");

  const outputFrame: MuxFullOutputFrame = {
    channel: frame.channel,
    type: "output",
    data: frame.data,
  };
  if (cursor !== undefined) {
    outputFrame.cursor = cursor;
  }
  if (reset !== undefined) {
    outputFrame.reset = reset;
  }
  return outputFrame;
}

function parseRawDeltaFrame(
  frame: JournalJsonMap,
  lineNo: number,
  session: string,
): MuxDeltaFrame {
  const required = ["channel", "type", "baseLength", "prefix", "prefixHash", "lines"];
  const allowed = new Set(["channel", "type", "baseLength", "prefix", "prefixHash", "lines", "cursor"]);
  for (const key of Object.keys(frame)) {
    if (!allowed.has(key)) {
      throw new Error(
        `Invalid delta frame keys at NDJSON line ${lineNo}: unexpected property "${key}".`,
      );
    }
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
  if (frame.type !== "delta") {
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
  if (!Array.isArray(frame.lines) || frame.lines.some((line) => typeof line !== "string")) {
    throw new Error(
      `Invalid delta frame at NDJSON line ${lineNo}: lines must be string[].`,
    );
  }
  const cursor = parseOptionalCursor(frame, lineNo, "delta frame");

  const deltaFrame: MuxDeltaFrame = {
    channel: frame.channel,
    type: "delta",
    baseLength: frame.baseLength,
    prefix: frame.prefix,
    prefixHash: frame.prefixHash,
    lines: frame.lines.slice(),
  };

  if (cursor !== undefined) {
    deltaFrame.cursor = cursor;
  }
  return deltaFrame;
}

function isMuxCursor(value: unknown): value is MuxCursor | null {
  if (value === null) return true;
  if (typeof value !== "object" || Array.isArray(value)) return false;
  const cursor = value as JournalJsonMap;
  const keys = Object.keys(cursor);
  return keys.length === 2
    && Object.prototype.hasOwnProperty.call(cursor, "row")
    && Object.prototype.hasOwnProperty.call(cursor, "col")
    && Number.isInteger(cursor.row)
    && Number.isInteger(cursor.col);
}

function parseOptionalCursor(
  frame: JournalJsonMap,
  lineNo: number,
  frameKind: "full frame" | "delta frame",
): MuxCursor | null | undefined {
  if (!Object.prototype.hasOwnProperty.call(frame, "cursor")) return undefined;
  const cursor = frame.cursor;
  if (!isMuxCursor(cursor)) {
    throw new Error(
      `Invalid ${frameKind} at NDJSON line ${lineNo}: cursor must be {row:number,col:number} or null.`,
    );
  }
  return cloneCursor(cursor);
}

function cloneFullFrame(frame: MuxFullOutputFrame): MuxFullOutputFrame {
  const next: MuxFullOutputFrame = {
    channel: frame.channel,
    type: "output",
    data: frame.data,
  };
  if (Object.prototype.hasOwnProperty.call(frame, "cursor")) {
    next.cursor = cloneCursor(frame.cursor);
  }
  if (Object.prototype.hasOwnProperty.call(frame, "reset")) {
    next.reset = frame.reset;
  }
  return next;
}

function cloneCursor(cursor: MuxCursor | null | undefined): MuxCursor | null | undefined {
  if (cursor === null || cursor === undefined) return cursor;
  return { row: cursor.row, col: cursor.col };
}
