import type { HistoryStore } from './store.js';
import type { CaptureBatch, CaptureReceipt, Continuity, LegacyProjectionWriter } from './types.js';
export interface GroupReadinessEvidence {
    group: string;
    /** Verified imported source records for the group's sessions. Must be > 0. */
    sourceCount: number;
    expectedSessions: string[];
    sourcePaths: string[];
    /** Issue IDs of fault probes that really landed in history_issue. */
    faultProbeIds: string[];
    /** Mirror watermark per session as this tool read it from the mirror. */
    watermarks: Array<{
        sessionId: string;
        exportedRevision: number;
        targetRevision: number;
    }>;
    assessedAt: number;
}
export type RolloutRoute = 'legacy' | 'sqlite-authoritative';
export interface RolloutGroupState {
    version: 1;
    group: string;
    state: 'enabled' | 'disabled';
    evidence: GroupReadinessEvidence | null;
    changedAt: number;
}
export interface LegacyArtifactDigest {
    path: string;
    bytes: number;
    sha256: string;
}
export interface LegacyRetirementReceipt {
    version: 1;
    group: string;
    retiredAt: number;
    artifacts: LegacyArtifactDigest[];
}
export interface RestoreDrillReceipt {
    sessionId: string;
    rows: number;
    frames: number;
    rowsSha256: string;
    startedAt: number;
    completedAt: number;
}
export interface BackupAuditEntry {
    sessionId: string;
    group: string;
    storage: 'verified' | 'failed';
    mirror: {
        targetRevision: number;
        exportedRevision: number;
        caughtUp: boolean;
    };
    imports: 'verified' | 'quarantined' | 'incomplete' | 'none';
    source: Continuity;
    coverage: 'preserved' | 'unknown' | 'failed';
}
export interface BackupAuditReport {
    startedAt: number;
    completedAt: number;
    sessions: BackupAuditEntry[];
    totals: {
        preserved: number;
        unknown: number;
        failed: number;
    };
}
export interface HistoryWriter {
    commitBatch(batch: CaptureBatch): Promise<CaptureReceipt>;
}
export interface ExpansionReceipt {
    group: string;
    state: RolloutGroupState;
    drills: RestoreDrillReceipt[];
    startedAt: number;
    completedAt: number;
}
/** Compute the readiness evidence for one declared group. Every number comes
 * from the store, the sealed sources or the mirror — nothing is typed in. The
 * fault probes are persisted through the real fault path and read back from
 * history_issue so the ID list proves the alarm channel was live. */
export declare function assessGroupReadiness(store: HistoryStore, group: string, mirrorDirectory: string): Promise<GroupReadinessEvidence>;
/** Per-group writer allowlist. Only a declared, explicitly enabled group routes
 * to the authoritative writer; everything else takes the legacy path. */
export declare class HistoryRolloutAllowlist {
    private store;
    private directory;
    private mirrorDirectory;
    private declared;
    private states;
    private retirements;
    constructor(store: HistoryStore, options: {
        directory: string;
        declaredGroups: readonly string[];
        mirrorDirectory: string;
    });
    /** The group-level routing decision. A group missing from the declared roster
     * is legacy even if a stray receipt file names it. Production wiring must ask
     * `routeSession`: a group verdict alone cannot speak for a session that was
     * never part of the verified roster. */
    route(group: string): RolloutRoute;
    /** The per-session routing decision. A session only leaves the legacy path
     * when its own group is enabled *and* the session was in the roster the gate
     * verified at enable time. A session that joined the group afterwards keeps
     * the legacy path until the group is enabled again over the new roster. */
    routeSession(sessionId: string): RolloutRoute;
    /** Live routing decision for a write. Enrolment is not enough: the mirror is
     * re-read from disk now. A missing or unreadable mirror is not a lagging
     * watermark — the group is disabled and the capture stays on the legacy path
     * so a vanished backup cannot keep serving as the authoritative writer. */
    guardSession(sessionId: string): RolloutRoute;
    private loseMirror;
    private refuse;
    /** Read one session's mirror from disk right now. A missing mirror and an
     * unreadable mirror each refuse under their own reason; neither is allowed to
     * collapse into "watermark 0", which would read as a merely lagging mirror. */
    private observeMirror;
    /** The group's membership as the store has it right now, unioned with the
     * sessions the evidence claims. The store's answer is what the gate judges;
     * a claimed session that has since left the group still has to answer for
     * itself through `session-outside-group`. */
    private rosterOf;
    /** Enable one group. Every readiness item is re-read from the store and from
     * the mirror at enable time — the roster comes from `history_session`, not
     * from the evidence, and the watermark comes from the mirror on disk, not
     * from the number the evidence carries. Evidence produced from empty input
     * never passes, and evidence that was true when it was written does not pass
     * once the world it describes has changed. */
    enableGroup(evidence: GroupReadinessEvidence): RolloutGroupState;
    /** Per-group rollback of the routing decision. Nothing is deleted. */
    disableGroup(group: string): RolloutGroupState;
    /** Opt-in retirement of the old capture writer for an enabled group. Records
     * the byte digests of the group's legacy artifacts; deletes nothing. */
    retireLegacyWriter(group: string, legacyArtifacts: readonly string[]): LegacyRetirementReceipt;
    retirement(group: string): LegacyRetirementReceipt | null;
    /** Every legacy write is routed through this guard: a retired group's writer
     * refuses loudly instead of double-writing next to the authoritative path. */
    wrapLegacyWriter(writer: LegacyProjectionWriter): LegacyProjectionWriter;
    /** Re-read every artifact recorded at retirement. Any changed, missing or
     * grown file after retirement is evidence of an overlapping legacy writer. */
    verifyLegacyWriterSilence(group: string): {
        group: string;
        artifacts: number;
        verifiedAt: number;
    };
}
/** Restore an export bundle into a fresh throwaway store and compare the
 * restored history against independent oracle parsers, byte for byte. The
 * receipt's numbers are computed from the restored database, never copied from
 * the bundle's own claims. */
export declare function runRestoreDrill(bundleDirectory: string, scratchDirectory: string): Promise<RestoreDrillReceipt>;
/** Coverage audit over every session the store knows. Coverage is `preserved`
 * only when storage integrity, the mirror watermark, the import states and the
 * source continuity all say so; an unknown source stays `unknown`. */
export declare function auditBackupCoverage(store: HistoryStore, mirrorDirectory: string): BackupAuditReport;
/** One capture door. Every write asks `guardSession`, never the group-level
 * `route`. Late joiners and a mirror that dies after enable stay on legacy. */
export declare class HistoryRolloutRouter {
    private store;
    private allowlist;
    private writers;
    constructor(store: HistoryStore, allowlist: HistoryRolloutAllowlist, writers: {
        sqlite: HistoryWriter;
        legacy: HistoryWriter;
    });
    commitBatch(batch: CaptureBatch): Promise<CaptureReceipt>;
}
/** One expansion batch. Assess, enable, then restore-drill every enrolled
 * session against independent oracles. A failed drill disables the group;
 * nothing is deleted. */
export declare function expandGroup(store: HistoryStore, allowlist: HistoryRolloutAllowlist, group: string, options: {
    mirrorDirectory: string;
    scratchDirectory: string;
}): Promise<ExpansionReceipt>;
