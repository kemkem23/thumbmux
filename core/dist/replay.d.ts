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
import { type MuxCursor, type MuxDeltaFrame, type MuxFullOutputFrame } from "./protocol";
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
/** Internal materialized state used as a reconstruction start point. */
interface SeekSnapshot {
    recordIndex: number;
    lines: readonly string[];
    cursor?: MuxCursor | null;
}
/** Timeline API over a validated journal. */
export declare class ReplayJournal {
    private readonly session;
    private readonly records;
    private readonly checkpoints;
    private readonly seekSnapshots;
    private readonly firstAt;
    private readonly lastAt;
    /** Memo of the most recent reconstruction — makes repeated/forward seeks O(1) amortized. */
    private lastState;
    private constructor();
    /**
     * Construct only from records already validated by this module.
     * `seekSnapshots` is optional: when omitted, full-frame checkpoints are used
     * as the only reconstruction start points (legacy public 3-arg signature).
     */
    static fromValidated(session: string, records: ParsedReplayRecord[], checkpoints: ReplayFullCheckpoint[], seekSnapshots?: SeekSnapshot[]): ReplayJournal;
    /** Total duration covered by parsed records (`lastAt - firstAt`). */
    get durationMs(): number;
    /** Time of the first parsed journal record. */
    get startAt(): number;
    /** Time of the last parsed journal record. */
    get endAt(): number;
    /** Canonical session for this journal. */
    get sessionName(): string;
    /** Number of parsed journal records. */
    get count(): number;
    /** Number of immutable full-frame checkpoints. */
    get checkpointCount(): number;
    /** Read-only access to full-frame checkpoints. */
    get fullCheckpoints(): readonly ReplayFullCheckpoint[];
    /** Return reconstructed full output at a given timeline time. */
    getFrameAt(time: number): MuxFullOutputFrame;
    /** Return reconstructed raw output lines at a given timeline time. */
    getLinesAt(time: number): readonly string[];
    /** Return source NDJSON line at a given timeline time. */
    getRawLineAt(time: number): string;
    /** Return full replay lookup at a given timeline time. */
    seek(time: number): ReplayLookup;
    private findRecordIndexByTime;
    private reconstructState;
    /** Greatest seek snapshot with `recordIndex <= target` (binary search). */
    private findSeekSnapshotForRecordIndex;
}
/** Parse and validate a Journal V1 NDJSON payload into a strict replay timeline. */
export declare function parseReplayJournal(source: string): ReplayJournal;
export {};
