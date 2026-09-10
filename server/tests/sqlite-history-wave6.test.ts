/**
 * Wave 6 fixture proofs: expansion tooling (first half) and the write-path
 * door (second half).
 *
 * Everything runs on synthetic temp databases and temp directories. No tmux,
 * no production history, no `brain.db`, no network, and no production session
 * or group is enabled anywhere. The four deliverables of the fixture half of
 * the wave-6 row in DESIGN.md each have a test below:
 *
 *  1. per-group allowlist       -> undeclared/unenabled groups stay legacy, and
 *                                  enabling refuses every missing readiness item;
 *                                  evidence computed from empty input never passes
 *  2. restore drill per batch   -> bundle restored into a fresh store, compared
 *                                  to independent oracles, repeatable, and a
 *                                  tampered bundle with a recomputed seal is caught
 *  3. backup coverage audit     -> reports coverage plus its own completion time;
 *                                  an unknown source is unknown, never "preserved"
 *  4. legacy writer retirement  -> opt-in; a retired group's writer refuses to
 *                                  double-write, overwrites of recorded legacy
 *                                  artifacts are detected, and exporter/rollback
 *                                  bundle/sealed originals stay intact
 */
import { describe, expect, test } from 'bun:test';
import { appendFileSync, chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AuthoritativeHistoryBridge, readMirror } from '../src/sqlite-history/authoritative';
import { HistoryRolloutAllowlist, assessGroupReadiness, auditBackupCoverage, runRestoreDrill } from '../src/sqlite-history/rollout';
import * as rolloutMod from '../src/sqlite-history/rollout';
import { exportHistoryBundle, importHistorySnapshot, readSeal, sealHistorySnapshot } from '../src/sqlite-history/transfer';
import { rowsDigest, sha } from '../src/sqlite-history/codec';
import type { HistoryStore } from '../src/sqlite-history/store';
import type { CaptureBatch, CaptureReceipt, HistoryCaptureDriver, HistoryFault, LegacyProjection } from '../src/sqlite-history/types';
import { batch, evidence, fixture, observation } from './sqlite-history/helpers';

const stubDriver: HistoryCaptureDriver = {
  geometryGeneration: () => 1,
  capture: () => Promise.reject(new Error('unused-in-wave6-fixtures')),
};

function bridgeFor(store: HistoryStore, mirrorDirectory: string): AuthoritativeHistoryBridge {
  return new AuthoritativeHistoryBridge(store, { mirrorDirectory, driver: stubDriver, sessions: () => [] });
}

/** Like helpers.batch but the appended rows keep their kind (terminal or gap). */
function rawBatch(store: HistoryStore, sid: string, rows: Array<{ kind: 'terminal' | 'gap'; text: string }>,
  screen: string[], requestId?: string, recordFrames = false): CaptureBatch {
  const o = observation([...rows.map(row => row.text), ...screen], screen.length);
  return { ticket: store.ticket(sid, requestId), observation: o, appended: rows, liveLineLimit: screen.length,
    recordFrames, evidence: { classification: 'initial', depth: 'shallow', source: {}, rawSha256: sha(JSON.stringify(o)) } };
}

/** Write and seal a small legacy file-jsonl source with `count` archived rows. */
function sealedJsonlSource(dir: string, name: string, count: number): { sealed: string; rows: string[] } {
  const source = join(dir, `${name}-src`), sealed = join(dir, `${name}-sealed`);
  mkdirSync(source, { mode: 0o700 });
  const rows = Array.from({ length: count }, (_, index) => `imported:${index}:ไทย漢字\x1b[32m${index % 3 === 0 ? '' : 'OK'}`);
  writeFileSync(join(source, 'history.jsonl'), rows.map((text, line) => JSON.stringify({ line, text })).join('\n') + '\n');
  writeFileSync(join(source, 'meta.json'), JSON.stringify({ liveStart: count, nextLine: count + 2, live: ['pane-1', 'pane-2'] }));
  sealHistorySnapshot(source, sealed);
  return { sealed, rows };
}

type RolloutRouterCtor = new (
  store: HistoryStore,
  allowlist: HistoryRolloutAllowlist,
  writers: { sqlite: { commitBatch: (batch: CaptureBatch) => Promise<CaptureReceipt> }; legacy: { commitBatch: (batch: CaptureBatch) => Promise<CaptureReceipt> } },
) => { commitBatch: (batch: CaptureBatch) => Promise<CaptureReceipt> };
type ExpandGroupFn = (
  store: HistoryStore,
  allowlist: HistoryRolloutAllowlist,
  group: string,
  options: { mirrorDirectory: string; scratchDirectory: string },
) => Promise<{
  group: string; state: { state: 'enabled' | 'disabled' };
  drills: Array<{ sessionId: string; rows: number; frames: number; rowsSha256: string }>;
  startedAt: number; completedAt: number;
}>;
function requireRouter(): RolloutRouterCtor {
  const Router = (rolloutMod as { HistoryRolloutRouter?: RolloutRouterCtor }).HistoryRolloutRouter;
  if (typeof Router !== 'function') throw new Error('HistoryRolloutRouter missing');
  return Router;
}
function requireExpandGroup(): ExpandGroupFn {
  const expandGroup = (rolloutMod as { expandGroup?: ExpandGroupFn }).expandGroup;
  if (typeof expandGroup !== 'function') throw new Error('expandGroup missing');
  return expandGroup;
}

/** Import a sealed source into a registered session, add live commits, and
 * bring the mirror up to the committed revision. Returns computed state. */
async function readyGroupSession(f: ReturnType<typeof fixture>, group: string, key: string, sourceRecords: number, mirrorDirectory?: string) {
  const { sealed } = sealedJsonlSource(f.dir, key, sourceRecords);
  const sid = await f.store.register({ name: key, lifecycleKey: `wave6-${key}`, group });
  const imported = await importHistorySnapshot(f.store, { sourceId: `wave6-source-${key}`, sessionId: sid, snapshotDirectory: sealed, format: 'file-jsonl' });
  expect(imported.state).toBe('verified');
  const mirror = mirrorDirectory ?? join(f.dir, `${key}-mirror`);
  const bridge = bridgeFor(f.store, mirror);
  // The import committed through the store directly; the mirror replays it
  // before the live commit so the seq files stay contiguous.
  bridge.resumeMirror(sid);
  await bridge.commitBatch(batch(f.store, sid, [`live:${key}:0`, `live:${key}:1 ไทย`], ['screen-row']));
  return { sid, sealed, mirror, bridge, imported, sessionMirror: join(mirror, sha(sid)) };
}

const faultsOf = (alarms: HistoryFault[], detector: string) => alarms.filter(alarm => alarm.detector === detector);

describe('wave 6 expansion tooling (fixture half)', () => {
  test('per-group allowlist: undeclared and unenabled groups stay legacy, empty input is refused, and every readiness item is enforced', async () => {
    const f = fixture();
    try {
      const { sid, mirror, bridge, sessionMirror } = await readyGroupSession(f, 'canary', 'allowlist', 5);
      const emptySid = await f.store.register({ name: 'empty-1', lifecycleKey: 'wave6-empty', group: 'empty-group' });
      const rollout = new HistoryRolloutAllowlist(f.store, { directory: join(f.dir, 'rollout'), declaredGroups: ['canary', 'empty-group'], mirrorDirectory: mirror });

      // Routing default: nothing is enabled, nothing routes to the new writer.
      expect(rollout.route('canary')).toBe('legacy');
      expect(rollout.route('empty-group')).toBe('legacy');
      expect(rollout.route('never-declared')).toBe('legacy');

      // Empty input never passes: the group exists but has no imported source.
      const emptyEvidence = await assessGroupReadiness(f.store, 'empty-group', join(f.dir, 'no-mirror'));
      expect(emptyEvidence.sourceCount).toBe(0);
      expect(emptyEvidence.expectedSessions).toEqual([emptySid]);
      expect(() => rollout.enableGroup(emptyEvidence)).toThrow(/rollout-refused/);
      evidence(faultsOf(f.alarms, 'rollout-refused').at(-1));
      expect(rollout.route('empty-group')).toBe('legacy');

      // A really lagging mirror refuses: block the export of the next commit,
      // then read the watermark this tool reads itself.
      chmodSync(sessionMirror, 0o500);
      await bridge.commitBatch(batch(f.store, sid, ['live:allowlist:2'], ['screen-row']));
      evidence(faultsOf(f.alarms, 'export-failed').at(-1));
      const lagging = await assessGroupReadiness(f.store, 'canary', mirror);
      expect(lagging.sourceCount).toBe(5);
      expect(lagging.watermarks).toEqual([{ sessionId: sid, exportedRevision: 2, targetRevision: 3 }]);
      expect(() => rollout.enableGroup(lagging)).toThrow(/watermark-behind-writer/);

      chmodSync(sessionMirror, 0o700);
      bridge.resumeMirror(sid);
      const ready = await assessGroupReadiness(f.store, 'canary', mirror);
      expect(ready.watermarks).toEqual([{ sessionId: sid, exportedRevision: 3, targetRevision: 3 }]);
      expect(ready.faultProbeIds.length).toBe(1);

      // Each stripped or tampered readiness item refuses on its own.
      expect(() => rollout.enableGroup({ ...ready, group: 'ghost' })).toThrow(/group-not-declared/);
      expect(() => rollout.enableGroup({ ...ready, expectedSessions: [] })).toThrow(/no-expected-sessions/);
      expect(() => rollout.enableGroup({ ...ready, sourcePaths: [] })).toThrow(/no-source-paths/);
      expect(() => rollout.enableGroup({ ...ready, faultProbeIds: [] })).toThrow(/no-fault-probes/);
      expect(() => rollout.enableGroup({ ...ready, faultProbeIds: ['fabricated-probe-id'] })).toThrow(/fault-probe-unknown/);
      expect(() => rollout.enableGroup({ ...ready, sourceCount: 0 })).toThrow(/empty-or-stale-source-count/);
      expect(() => rollout.enableGroup({ ...ready, watermarks: [{ sessionId: sid, exportedRevision: 1, targetRevision: 2 }] }))
        .toThrow(/watermark-behind-writer/);
      expect(rollout.route('canary')).toBe('legacy');

      // The complete computed evidence enables, and per-group rollback works.
      const enabled = rollout.enableGroup(ready);
      expect(enabled.state).toBe('enabled');
      expect(rollout.route('canary')).toBe('sqlite-authoritative');
      expect(rollout.route('empty-group')).toBe('legacy');
      rollout.disableGroup('canary');
      expect(rollout.route('canary')).toBe('legacy');
      rollout.enableGroup(await assessGroupReadiness(f.store, 'canary', mirror));

      // The decision survives a restart of the allowlist over the same directory.
      const reopened = new HistoryRolloutAllowlist(f.store, { directory: join(f.dir, 'rollout'), declaredGroups: ['canary', 'empty-group'], mirrorDirectory: mirror });
      expect(reopened.route('canary')).toBe('sqlite-authoritative');
      // A stray receipt does not outrank the declared roster.
      const rosterless = new HistoryRolloutAllowlist(f.store, { directory: join(f.dir, 'rollout'), declaredGroups: ['some-other-group'], mirrorDirectory: mirror });
      expect(rosterless.route('canary')).toBe('legacy');
      console.log('WAVE6_ALLOWLIST', JSON.stringify({ sourceCount: ready.sourceCount, sessions: ready.expectedSessions.length,
        probes: ready.faultProbeIds.length, watermark: ready.watermarks[0], refusals: faultsOf(f.alarms, 'rollout-refused').length }));
    } finally { await f.cleanup(); }
  }, 60000);

  test('restore drill: a bundle restores into a fresh store, matches independent oracles, repeats, and a tampered bundle with a recomputed seal is caught', async () => {
    const f = fixture();
    try {
      const sid = await f.store.register({ name: 'drill', lifecycleKey: 'wave6-drill' });
      const bridge = bridgeFor(f.store, join(f.dir, 'mirror'));
      const rows: Array<{ kind: 'terminal' | 'gap'; text: string }> = [
        { kind: 'terminal', text: '' },
        { kind: 'terminal', text: 'สวัสดี wave6 ไทย' },
        { kind: 'terminal', text: '漢字テスト 한국어' },
        { kind: 'terminal', text: '\x1b[31mred\x1b[0m tail' },
        ...Array.from({ length: 40 }, () => ({ kind: 'terminal' as const, text: 'OK' })),
        { kind: 'gap', text: '[history continuity unknown]' },
        { kind: 'terminal', text: 'après 🚀 end' },
      ];
      await bridge.commitBatch(rawBatch(f.store, sid, rows.slice(0, 20), ['s1'], 'drill-1', true));
      await bridge.commitBatch(rawBatch(f.store, sid, rows.slice(20), ['s2'], 'drill-2', true));
      const bundle = join(f.dir, 'bundle');
      exportHistoryBundle(f.store, sid, bundle);

      const first = await runRestoreDrill(bundle, join(f.dir, 'scratch'));
      const second = await runRestoreDrill(bundle, join(f.dir, 'scratch'));
      expect(first.rows).toBe(rows.length);
      expect(first.frames).toBe(2);
      expect(second.rows).toBe(first.rows);
      expect(second.rowsSha256).toBe(first.rowsSha256);
      expect(second.completedAt).toBeGreaterThanOrEqual(second.startedAt);

      // Tamper one byte inside the bundle and recompute the seal so the seal
      // digest alone cannot save the drill: the independent oracle must.
      const tampered = join(f.dir, 'bundle-tampered');
      cpSync(bundle, tampered, { recursive: true });
      const jsonlPath = join(tampered, 'history.jsonl');
      chmodSync(jsonlPath, 0o600);
      const original = readFileSync(jsonlPath, 'utf8');
      expect(original).toContain('"OK"');
      const rewritten = original.replace('"OK"', '"KO"');
      expect(rewritten).not.toBe(original);
      writeFileSync(jsonlPath, rewritten);
      const sealPath = join(tampered, 'seal.json');
      chmodSync(sealPath, 0o600);
      const seal = JSON.parse(readFileSync(sealPath, 'utf8')) as { version: 1; files: Array<{ path: string; bytes: number; sha256: string }> };
      const entry = seal.files.find(value => value.path === 'history.jsonl');
      entry!.sha256 = sha(Buffer.from(rewritten, 'utf8'));
      entry!.bytes = Buffer.byteLength(rewritten);
      writeFileSync(sealPath, JSON.stringify(seal));
      await expect(runRestoreDrill(tampered, join(f.dir, 'scratch'))).rejects.toThrow(/drill-jsonl-bytes/);
      console.log('WAVE6_DRILL', JSON.stringify({ rows: first.rows, frames: first.frames, rowsSha256: first.rowsSha256,
        repeatable: second.rowsSha256 === first.rowsSha256, tamperedCaught: true }));
    } finally { await f.cleanup(); }
  }, 60000);

  test('backup coverage audit: reports completion time, an unknown source is never counted preserved, and broken storage is failed', async () => {
    const f = fixture();
    try {
      const mirror = join(f.dir, 'mirror');
      const bridge = bridgeFor(f.store, mirror);
      const healthy = await f.store.register({ name: 'audit-healthy', lifecycleKey: 'wave6-audit-healthy', group: 'audit' });
      await bridge.commitBatch(batch(f.store, healthy, ['a', 'b ไทย'], ['screen']));
      bridge.resumeMirror(healthy);
      const broken = await f.store.register({ name: 'audit-broken', lifecycleKey: 'wave6-audit-broken', group: 'audit' });
      await bridge.commitBatch(batch(f.store, broken, ['x', 'y', 'z'], ['screen']));
      bridge.resumeMirror(broken);

      // Storage green + mirror caught up, but the source is unknown: unknown, not preserved.
      const before = auditBackupCoverage(f.store, mirror);
      expect(before.completedAt).toBeGreaterThanOrEqual(before.startedAt);
      const healthyEntry = before.sessions.find(entry => entry.sessionId === healthy)!;
      expect(healthyEntry.storage).toBe('verified');
      expect(healthyEntry.mirror.caughtUp).toBe(true);
      expect(healthyEntry.source).toBe('unknown');
      expect(healthyEntry.coverage).toBe('unknown');
      expect(before.totals).toEqual({ preserved: 0, unknown: 2, failed: 0 });

      // No shipping code path writes continuity='verified' yet; simulate the
      // future source evidence directly to prove the preserved branch is real.
      f.db.query("UPDATE history_session SET continuity='verified' WHERE session_id=?").run(healthy);
      const withEvidence = auditBackupCoverage(f.store, mirror);
      expect(withEvidence.sessions.find(entry => entry.sessionId === healthy)!.coverage).toBe('preserved');
      expect(withEvidence.totals).toEqual({ preserved: 1, unknown: 1, failed: 0 });
      f.db.query("UPDATE history_session SET continuity='unknown' WHERE session_id=?").run(healthy);

      // Delete a committed row under its receipt: the audit must fail that
      // session loudly instead of keeping it in the unknown bucket.
      f.db.exec('DROP TRIGGER line_delete');
      f.db.query('DELETE FROM history_line WHERE session_id=? AND line_no=1').run(broken);
      const after = auditBackupCoverage(f.store, mirror);
      const brokenEntry = after.sessions.find(entry => entry.sessionId === broken)!;
      expect(brokenEntry.storage).toBe('failed');
      expect(brokenEntry.coverage).toBe('failed');
      expect(after.totals).toEqual({ preserved: 0, unknown: 1, failed: 1 });
      evidence(faultsOf(f.alarms, 'integrity-audit').at(-1));
      console.log('WAVE6_BACKUP_AUDIT', JSON.stringify({ sessions: after.sessions.length, totals: after.totals,
        durationMs: after.completedAt - after.startedAt }));
    } finally { await f.cleanup(); }
  }, 60000);

  test('legacy writer retirement: opt-in, refuses double writes, detects overwrites, and leaves exporter, rollback bundle and originals intact', async () => {
    const f = fixture();
    try {
      const { sid, sealed, mirror, bridge } = await readyGroupSession(f, 'canary', 'retire', 4);
      bridge.resumeMirror(sid);
      const rollout = new HistoryRolloutAllowlist(f.store, { directory: join(f.dir, 'rollout'), declaredGroups: ['canary', 'cold-group'], mirrorDirectory: mirror });
      rollout.enableGroup(await assessGroupReadiness(f.store, 'canary', mirror));

      let legacyWrites = 0;
      const sink = { write: async (projection: LegacyProjection) => { legacyWrites++; return { requestId: projection.requestId, digest: sha(JSON.stringify(projection)) }; } };
      const wrapped = rollout.wrapLegacyWriter(sink);
      const projectionFor = (requestId: string): LegacyProjection => ({ requestId, sessionId: sid, rows: [], screen: [], raw: [],
        geometry: { kind: 'pane', rows: 1, cols: 1, generation: 1, alternate: false }, source: {}, at: 1 });
      await wrapped.write(projectionFor('before-retirement'));
      expect(legacyWrites).toBe(1);

      // Retirement is gated on the allowlist: a group that is not enabled cannot retire.
      expect(() => rollout.retireLegacyWriter('cold-group', [join(sealed, 'history.jsonl')])).toThrow(/retire-requires-enabled-group/);
      expect(() => rollout.retireLegacyWriter('canary', [])).toThrow(/retire-without-artifact-ledger/);

      const artifacts = [join(sealed, 'history.jsonl'), join(sealed, 'meta.json')];
      const sourceDigestBefore = readSeal(sealed).digest;
      const receipt = rollout.retireLegacyWriter('canary', artifacts);
      expect(receipt.artifacts.length).toBe(2);

      // The retired group's legacy writer refuses; it cannot write next to the new path.
      await expect(wrapped.write(projectionFor('after-retirement'))).rejects.toThrow(/legacy-writer-retired/);
      expect(legacyWrites).toBe(1);
      evidence(faultsOf(f.alarms, 'legacy-writer-retired').at(-1));

      // Exporter, rollback bundle and the sealed originals are all still there.
      const bundle = join(f.dir, 'post-retirement-bundle');
      exportHistoryBundle(f.store, sid, bundle);
      expect(readSeal(bundle).files.size).toBeGreaterThan(0);
      expect(readSeal(sealed).digest).toBe(sourceDigestBefore);
      expect(readMirror(mirror, sid).exportedRevision).toBe(f.store.session(sid).revision);
      expect(rollout.verifyLegacyWriterSilence('canary').artifacts).toBe(2);

      // The silence check survives a restart, and a later write into a recorded
      // legacy artifact is detected as an overlapping old writer.
      const reopened = new HistoryRolloutAllowlist(f.store, { directory: join(f.dir, 'rollout'), declaredGroups: ['canary', 'cold-group'], mirrorDirectory: mirror });
      expect(reopened.retirement('canary')?.retiredAt).toBe(receipt.retiredAt);
      chmodSync(artifacts[0], 0o600);
      appendFileSync(artifacts[0], '{"line":999,"text":"stray legacy write"}\n');
      expect(() => reopened.verifyLegacyWriterSilence('canary')).toThrow(/legacy-writer-overwrite/);
      evidence(faultsOf(f.alarms, 'legacy-writer-overwrite').at(-1));
      console.log('WAVE6_RETIREMENT', JSON.stringify({ artifacts: receipt.artifacts.length, legacyWrites,
        overwriteDetected: true, bundleFiles: readSeal(bundle).files.size }));
    } finally { await f.cleanup(); }
  }, 60000);
  test('the enable gate re-reads the mirror itself: evidence that was true when written cannot enable a group whose mirror is gone or unreadable', async () => {
    const f = fixture();
    try {
      const { sid, mirror, bridge, sessionMirror } = await readyGroupSession(f, 'canary', 'mirrorgone', 3);
      bridge.resumeMirror(sid);
      const rollout = new HistoryRolloutAllowlist(f.store,
        { directory: join(f.dir, 'rollout'), declaredGroups: ['canary'], mirrorDirectory: mirror });
      const ready = await assessGroupReadiness(f.store, 'canary', mirror);
      expect(ready.watermarks).toEqual([{ sessionId: sid, exportedRevision: f.store.session(sid).revision, targetRevision: f.store.session(sid).revision }]);

      // The mirror the evidence attests to is destroyed after the assessment.
      // The evidence numbers still agree with the store, so a gate that only
      // compares numbers inside the evidence would enable a group whose backup
      // copy no longer exists.
      rmSync(sessionMirror, { recursive: true, force: true });
      expect(existsSync(sessionMirror)).toBe(false);
      expect(() => rollout.enableGroup(ready)).toThrow(/rollout-refused:mirror-missing/);
      expect(rollout.route('canary')).toBe('legacy');
      evidence(faultsOf(f.alarms, 'rollout-refused').at(-1));

      // A mirror that exists but cannot be read is refused with its own reason,
      // never silently treated as "watermark 0" and never as a pass.
      bridge.resumeMirror(sid);
      const watermarkPath = join(sessionMirror, 'watermark.json');
      chmodSync(watermarkPath, 0o600);
      writeFileSync(watermarkPath, JSON.stringify({ version: 1, sessionId: 'a-different-session', exportedRevision: 1 }));
      expect(() => rollout.enableGroup(ready)).toThrow(/rollout-refused:mirror-unreadable/);
      expect(rollout.route('canary')).toBe('legacy');

      // Restoring the mirror restores the pass, so the gate is not simply stuck.
      rmSync(sessionMirror, { recursive: true, force: true });
      bridge.resumeMirror(sid);
      expect(readMirror(mirror, sid).exportedRevision).toBe(f.store.session(sid).revision);
      expect(rollout.enableGroup(await assessGroupReadiness(f.store, 'canary', mirror)).state).toBe('enabled');
      expect(rollout.route('canary')).toBe('sqlite-authoritative');
      console.log('WAVE6_GATE_MIRROR', JSON.stringify({ session: sid,
        refusals: faultsOf(f.alarms, 'rollout-refused').map(fault => fault.expected).slice(-2) }));
    } finally { await f.cleanup(); }
  }, 60000);

  test('the enable gate reads the live group roster: a session that joins the group after the assessment is refused, not enabled for free', async () => {
    const f = fixture();
    try {
      const { sid, mirror, bridge } = await readyGroupSession(f, 'canary', 'roster', 4);
      bridge.resumeMirror(sid);
      const rollout = new HistoryRolloutAllowlist(f.store,
        { directory: join(f.dir, 'rollout'), declaredGroups: ['canary'], mirrorDirectory: mirror });
      const ready = await assessGroupReadiness(f.store, 'canary', mirror);
      expect(ready.expectedSessions).toEqual([sid]);

      // A second session joins the same group after the evidence was computed.
      // It has no receipts, no import and no mirror: enabling the group on the
      // first session's evidence would route this one to the new writer too.
      const late = await f.store.register({ name: 'roster-late', lifecycleKey: 'wave6-roster-late', group: 'canary' });
      expect(f.store.session(late).revision).toBe(0);
      expect(() => rollout.enableGroup(ready)).toThrow(/rollout-refused:session-without-receipts/);
      expect(rollout.route('canary')).toBe('legacy');
      const refusal = faultsOf(f.alarms, 'rollout-refused').at(-1);
      evidence(refusal);
      expect(JSON.stringify(refusal?.observed)).toContain(late);

      // Re-assessing does not help while the newcomer is unbacked, and the
      // stale evidence cannot be replayed either.
      const reassessed = await assessGroupReadiness(f.store, 'canary', mirror);
      expect(() => rollout.enableGroup(reassessed)).toThrow(/rollout-refused:session-without-receipts/);
      expect(() => rollout.enableGroup(ready)).toThrow(/rollout-refused/);
      expect(rollout.route('canary')).toBe('legacy');

      // Once the newcomer really has receipts, an import and a caught-up
      // mirror, the whole group passes — the gate refuses, it does not block.
      const { sealed } = sealedJsonlSource(f.dir, 'roster-late', 2);
      expect((await importHistorySnapshot(f.store, { sourceId: 'wave6-source-roster-late', sessionId: late, snapshotDirectory: sealed, format: 'file-jsonl' })).state).toBe('verified');
      const lateBridge = bridgeFor(f.store, mirror);
      lateBridge.resumeMirror(late);
      await lateBridge.commitBatch(batch(f.store, late, ['live:roster-late:0'], ['screen-row']));
      const complete = await assessGroupReadiness(f.store, 'canary', mirror);
      expect(complete.expectedSessions).toEqual([sid, late].sort());
      expect(rollout.enableGroup(complete).state).toBe('enabled');
      expect(rollout.route('canary')).toBe('sqlite-authoritative');
      console.log('WAVE6_GATE_ROSTER', JSON.stringify({ enrolled: complete.expectedSessions.length,
        refusals: faultsOf(f.alarms, 'rollout-refused').map(fault => fault.expected).slice(-2) }));
    } finally { await f.cleanup(); }
  }, 60000);
  test('routing is per session: a session that joins an already-enabled group keeps the legacy path until the group is enabled again over it', async () => {
    const f = fixture();
    try {
      const { sid, mirror, bridge } = await readyGroupSession(f, 'canary', 'perssession', 3);
      bridge.resumeMirror(sid);
      const rollout = new HistoryRolloutAllowlist(f.store,
        { directory: join(f.dir, 'rollout'), declaredGroups: ['canary'], mirrorDirectory: mirror });
      rollout.enableGroup(await assessGroupReadiness(f.store, 'canary', mirror));
      expect(rollout.routeSession(sid)).toBe('sqlite-authoritative');

      // Enrolment after the fact must not inherit the verdict: this session was
      // in no roster the gate ever checked.
      const late = await f.store.register({ name: 'late-join', lifecycleKey: 'wave6-late-join', group: 'canary' });
      expect(rollout.route('canary')).toBe('sqlite-authoritative');
      expect(rollout.routeSession(late)).toBe('legacy');
      expect(rollout.routeSession(sid)).toBe('sqlite-authoritative');

      // A session outside the declared roster is legacy on both doors.
      const outsider = await f.store.register({ name: 'outsider', lifecycleKey: 'wave6-outsider', group: 'never-declared' });
      expect(rollout.routeSession(outsider)).toBe('legacy');
      console.log('WAVE6_GATE_ROUTE_SESSION', JSON.stringify({ group: rollout.route('canary'),
        enrolled: rollout.routeSession(sid), lateJoin: rollout.routeSession(late), outsider: rollout.routeSession(outsider) }));
    } finally { await f.cleanup(); }
  }, 60000);
});

describe('wave 6 expansion wiring (second half)', () => {
  test('write path: every capture is routed per session, not per group', async () => {
    const f = fixture();
    try {
      const Router = requireRouter();
      const mirror = join(f.dir, 'shared-mirror');
      const { sid } = await readyGroupSession(f, 'canary', 'wired', 3, mirror);
      const allowlist = new HistoryRolloutAllowlist(f.store,
        { directory: join(f.dir, 'rollout'), declaredGroups: ['canary'], mirrorDirectory: mirror });
      allowlist.enableGroup(await assessGroupReadiness(f.store, 'canary', mirror));
      const sqlite = bridgeFor(f.store, mirror);
      const sqliteSessions: string[] = [];
      const legacySessions: string[] = [];
      const router = new Router(f.store, allowlist, {
        sqlite: { commitBatch: async (next) => { sqliteSessions.push(next.ticket.sessionId); return sqlite.commitBatch(next); } },
        legacy: { commitBatch: async (next) => { legacySessions.push(next.ticket.sessionId); return sqlite.commitBatch(next); } },
      });

      await router.commitBatch(batch(f.store, sid, ['via-router:enrolled'], ['screen']));
      expect(sqliteSessions).toEqual([sid]);
      expect(legacySessions).toEqual([]);

      // A late joiner of an already-enabled group must not inherit the group
      // verdict. The write door has to ask routeSession, not route(group).
      const late = await f.store.register({ name: 'wired-late', lifecycleKey: 'wave6-wired-late', group: 'canary' });
      await router.commitBatch(batch(f.store, late, ['via-router:late'], ['screen']));
      expect(sqliteSessions).toEqual([sid]);
      expect(legacySessions).toEqual([late]);
      expect(allowlist.route('canary')).toBe('sqlite-authoritative');
      expect(allowlist.routeSession(late)).toBe('legacy');
      console.log('WAVE6_WRITE_PATH', JSON.stringify({ enrolled: sid, late, sqliteSessions, legacySessions }));
    } finally { await f.cleanup(); }
  }, 60000);

  test('live guard: a mirror that dies after enable drops the group back to legacy instead of writing as authoritative', async () => {
    const f = fixture();
    try {
      const Router = requireRouter();
      const { sid, mirror, sessionMirror } = await readyGroupSession(f, 'canary', 'liveguard', 3);
      const allowlist = new HistoryRolloutAllowlist(f.store,
        { directory: join(f.dir, 'rollout'), declaredGroups: ['canary'], mirrorDirectory: mirror });
      allowlist.enableGroup(await assessGroupReadiness(f.store, 'canary', mirror));
      expect(typeof (allowlist as { guardSession?: unknown }).guardSession).toBe('function');
      const sqlite = bridgeFor(f.store, mirror);
      const sqliteSessions: string[] = [];
      const legacySessions: string[] = [];
      const router = new Router(f.store, allowlist, {
        sqlite: { commitBatch: async (next) => { sqliteSessions.push(next.ticket.sessionId); return sqlite.commitBatch(next); } },
        legacy: { commitBatch: async (next) => { legacySessions.push(next.ticket.sessionId); return sqlite.commitBatch(next); } },
      });
      await router.commitBatch(batch(f.store, sid, ['before-mirror-gone'], ['screen']));
      expect(sqliteSessions).toEqual([sid]);
      expect(legacySessions).toEqual([]);

      rmSync(sessionMirror, { recursive: true, force: true });
      expect(existsSync(sessionMirror)).toBe(false);
      await router.commitBatch(batch(f.store, sid, ['after-mirror-gone'], ['screen']));
      expect(legacySessions).toEqual([sid]);
      expect(sqliteSessions).toEqual([sid]);
      expect(allowlist.route('canary')).toBe('legacy');
      expect(allowlist.routeSession(sid)).toBe('legacy');
      const lost = faultsOf(f.alarms, 'rollout-mirror-lost').at(-1);
      evidence(lost);
      expect(lost?.expected).toBe('mirror-missing');

      await router.commitBatch(batch(f.store, sid, ['after-disable'], ['screen']));
      expect(legacySessions).toEqual([sid, sid]);

      // Unreadable is its own reason, not a silent watermark-0 pass.
      sqlite.resumeMirror(sid);
      allowlist.enableGroup(await assessGroupReadiness(f.store, 'canary', mirror));
      const watermarkPath = join(sessionMirror, 'watermark.json');
      chmodSync(watermarkPath, 0o600);
      writeFileSync(watermarkPath, JSON.stringify({ version: 1, sessionId: 'a-different-session', exportedRevision: 1 }));
      sqliteSessions.length = 0;
      legacySessions.length = 0;
      await router.commitBatch(batch(f.store, sid, ['after-mirror-unreadable'], ['screen']));
      expect(legacySessions).toEqual([sid]);
      expect(sqliteSessions).toEqual([]);
      expect(allowlist.route('canary')).toBe('legacy');
      const unreadable = faultsOf(f.alarms, 'rollout-mirror-lost').at(-1);
      evidence(unreadable);
      expect(unreadable?.expected).toBe('mirror-unreadable');
      console.log('WAVE6_LIVE_GUARD', JSON.stringify({
        missing: lost?.expected, unreadable: unreadable?.expected, disabled: allowlist.route('canary') }));
    } finally { await f.cleanup(); }
  }, 60000);

  test('expansion batch: restore-drill every enrolled session after enable; a failed drill never leaves the group enabled', async () => {
    const f = fixture();
    try {
      const expandGroup = requireExpandGroup();
      const mirror = join(f.dir, 'shared-mirror');
      const first = await readyGroupSession(f, 'canary', 'batch-a', 4, mirror);
      const second = await readyGroupSession(f, 'canary', 'batch-b', 3, mirror);
      const allowlist = new HistoryRolloutAllowlist(f.store,
        { directory: join(f.dir, 'rollout'), declaredGroups: ['canary'], mirrorDirectory: mirror });

      const receipt = await expandGroup(f.store, allowlist, 'canary', {
        mirrorDirectory: mirror, scratchDirectory: join(f.dir, 'scratch'),
      });
      expect(receipt.state.state).toBe('enabled');
      expect(allowlist.route('canary')).toBe('sqlite-authoritative');
      expect(receipt.drills.length).toBe(2);
      expect(receipt.drills.map(drill => drill.sessionId).sort()).toEqual([first.sid, second.sid].sort());
      expect(receipt.completedAt).toBeGreaterThanOrEqual(receipt.startedAt);
      for (const drill of receipt.drills) {
        expect(drill.rows).toBeGreaterThan(0);
        const session = f.store.session(drill.sessionId);
        const rows = f.store.rows(drill.sessionId, session.first_line, session.next_line);
        expect(drill.rows).toBe(rows.length);
        expect(drill.rowsSha256).toBe(rowsDigest(rows));
      }
      expect(allowlist.routeSession(first.sid)).toBe('sqlite-authoritative');
      expect(allowlist.routeSession(second.sid)).toBe('sqlite-authoritative');

      const probe = f.store.persistFault(first.sid, 'post-expand-probe', 'fault channel still live after expansion', { at: 1 });
      expect(f.db.query('SELECT issue_id FROM history_issue WHERE issue_id=?').get(probe.issue_id))
        .toEqual({ issue_id: probe.issue_id });

      allowlist.disableGroup('canary');
      const badScratch = join(f.dir, 'scratch-is-a-file');
      writeFileSync(badScratch, 'not-a-directory');
      await expect(expandGroup(f.store, allowlist, 'canary', {
        mirrorDirectory: mirror, scratchDirectory: badScratch,
      })).rejects.toThrow(/rollout-directory-must-be-private/);
      expect(allowlist.route('canary')).toBe('legacy');
      console.log('WAVE6_EXPAND_BATCH', JSON.stringify({
        drills: receipt.drills.length, rows: receipt.drills.map(drill => drill.rows),
        failedDrillLeftDisabled: allowlist.route('canary') === 'legacy' }));
    } finally { await f.cleanup(); }
  }, 60000);

  test('opt-in factory exposes the write-path router and expansion batch', async () => {
    const f = fixture();
    try {
      const { createSqliteHistoryStore } = await import('../src/sqlite-history');
      const history = await createSqliteHistoryStore({ file: join(f.dir, 'opt-in-wave6.db') });
      try {
        expect(typeof (history as { createRolloutRouter?: unknown }).createRolloutRouter).toBe('function');
        expect(typeof (history as { expandGroup?: unknown }).expandGroup).toBe('function');
      } finally { await history.close(); }
    } finally { await f.cleanup(); }
  }, 60000);
});
