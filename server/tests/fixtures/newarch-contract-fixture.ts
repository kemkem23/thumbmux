/** Compile with strict tsc. Execute named fixtures with bun test inside the cage.
 * This checks the contract only, never substitutes for engine integration tests.
 */
import { test } from 'bun:test';
import { STREAM_BUDGET as B, eventKey, rowKey, validReadOpen } from '../../src/stream-contract';
import type { PaneKey, StreamIdentity, EventId, FinalizedRow, FrameDelta, RamReceipt, DurableReceipt, DurableInputReceipt, VtCheckpoint, VtState, ReadView, ReadOpenAck, HistoryPage, StreamFailure, CaptureEngine, HistoryEngine, DisplayEngine, StreamObserver, StreamMetric, AppendFinalized, HistoryPageCheckpoint, RepairChunk, RepairReceipt } from '../../src/stream-contract';
const pane: PaneKey = { serverIdentity: 'fixture-server', paneId: '%1', birthGeneration: 1 };
const identity: StreamIdentity = { pane, sourceEpoch: 1, geometryGeneration: 1 };
const eventId: EventId = { pane, sourceEpoch: 1, packetSeq: 1, scrollOrdinal: 0 };
const digest = '0'.repeat(64);
const cursor = { x: 0, y: 0, visible: true } as const;
const geometry = { columns: 120, rows: 40 } as const;
const row: FinalizedRow = { id: { pane, lineId: 0 }, revision: 1, source: eventId, geometryGeneration: 1, geometry, cells: [{ text: 'ก', width: 1, style: [] }], softWrap: false, wrapPad: 0, uncertainFields: [] };
const frame: FrameDelta = { identity, screenRevision: 1, buffer: 'normal', geometry, changedRows: [{ y: 0, content: row }], cursor, overlap: null };
const ram: RamReceipt = { kind: 'ram', eventId, digest, revision: 1, head: 1 };
const durable: DurableReceipt = { kind: 'durable', pane, commitId: 'commit-1', digest, durableRevision: 1, checkpointId: 'checkpoint-1' };
const input: DurableInputReceipt = { kind: 'durable-input', pane, through: { sourceEpoch: 1, packetSeq: 1 }, digest, segmentId: 'segment-1' };
const buffer = { rows: [row], cursor, savedCursor: cursor, savedAttributes: [], savedModes: {}, wrapPending: false };
const state: VtState = { codecVersion: 'fixture-v1', geometry, normal: buffer, alternate: buffer, active: 'normal', modes: {}, margins: { top: 0, bottom: 40, left: 0, right: 120 }, tabStops: [8], pendingUtf8: [0xe0], pendingEscape: [27, 91], attributes: [], wrapPending: false, extensionState: '{}' };
const checkpoint: VtCheckpoint = { kind: 'vt-recovery', checkpointId: 'checkpoint-1', previousCheckpointId: null, identity, inputFence: input, revision: 1, head: 1, state, stateDigest: digest };
const view: ReadView = { requestId: 'request-1', identity, routeGeneration: 1, range: { start: 0, end: 1 }, deadlineMonoMs: 1000, grantRevision: 3, durableAtGrant: 1, headAtGrant: 1, overlayHandle: 'overlay-1' };
const ack: ReadOpenAck = { view, diskSnapshotRevision: 2, snapshotHandle: 'snapshot-1' };
const page: HistoryPage = { view, fragments: [{ row, startCell: 0, endCell: 1, complete: true }], payloadBytes: 3, nextBefore: null, nextAfter: null, hasMoreBefore: false, hasMoreAfter: false };
const append: AppendFinalized = { identity, eventId, digest, expectedRevision: 0, rows: [row], frameDelta: frame, receivedAtMonoMs: 0 };
const block: HistoryPageCheckpoint = { kind: 'history-page', blockId: 'block-1', pane, previousBlockId: null, first: { lineId: 0, cellOffset: 0 }, end: { lineId: 1, cellOffset: 0 }, minRevision: 1, maxRevision: 1, checksum: digest, rowCount: 1, payloadBytes: 3, geometryAndWrap: [{ lineId: 0, geometryGeneration: 1, geometry, softWrap: false, wrapPad: 0 }] };
const repair: RepairChunk = { episode: { episodeId: 'gap-1', pane, epochBefore: 1, epochAfter: 2, lastDurableInput: input.through, lastAdmittedRow: 0, firstObservedAtMonoMs: 1, reason: 'eof', status: 'repairing', missingCount: null }, chunkId: 'repair-1', digest, expectedRevision: 1, rows: [row], final: false };
const repairReceipt: RepairReceipt = { committedIds: [row.id], committedRevision: 1, durable, complete: false };
const failures: readonly StreamFailure[] = [{ status: 'busy', retryAfterMs: 20, reason: 'pressure' }, { status: 'stale', reason: 'late-gap' }, { status: 'cancelled', reason: 'disconnect' }, { status: 'error', code: 'integrity', message: 'same key, different digest' }];
export const CONTRACT_FIXTURE = { pane, identity, eventId, row, frame, ram, durable, input, checkpoint, view, ack, page, append, block, repair, repairReceipt, failures } as const;

// These negative cases must remain compiler errors; unused directives fail tsc.
function negativeTypes() {
  // @ts-expect-error RAM admission is not durable storage.
  const badReceipt: DurableReceipt = ram;
  // @ts-expect-error Input durability is not a full VT checkpoint.
  const badCheckpoint: VtCheckpoint = input;
  // @ts-expect-error Busy is not a successful empty history page.
  const badPage: HistoryPage = failures[0];
  // @ts-expect-error A granted view cannot be mutated by a viewer.
  view.headAtGrant = 5;
  // @ts-expect-error Nested cell data is immutable too.
  row.cells[0]!.text = 'changed';
  return [badReceipt, badCheckpoint, badPage];
}
// Compile each consumer against the same ports without importing implementations.
export async function compileConsumerPorts(c: CaptureEngine, h: HistoryEngine, d: DisplayEngine, q: StreamObserver) {
  const cancel = { isCancelled: () => false };
  await h.appendFinalized(append);
  await h.commitCheckpoint({ checkpoint, expectedRevision: 1, commitId: 'c', digest });
  await h.commitRepair(repair);
  for await (const chunk of h.recover(pane, checkpoint.checkpointId, cancel)) {
    if (chunk.status === 'ok' && chunk.value.kind === 'input') await c.acceptInput(chunk.value.event);
  }
  const grant = await h.grantReadView(view);
  if (grant.status === 'ok') {
    try {
      const opened = await h.openReadView(grant.value);
      if (opened.status === 'ok') await h.readPage(opened.value, null, 500, cancel);
    } finally { await h.releaseReadView(grant.value, 'fixture-finally'); }
  }
  const route = { viewerId: 'viewer', identity, routeGeneration: 1 };
  await d.attach(route, () => {});
  await d.page(route, view, null, 500, cancel);
  await d.detach(route, 'fixture-done');
  for await (const result of c.repair(repair.episode, cancel)) void result;
  await c.checkpoint(pane, 'handoff');
  await c.checkVisible(identity);
  await c.drain(pane, 1000);
  const metric: StreamMetric = { kind: 'gap', episode: repair.episode };
  q.record(metric);
}
export function runContractFixture(): void {
  const assert = (ok: boolean, message: string) => { if (!ok) throw new Error(message); };
  assert(B.processTreePssHardBytes === 1610612736, '1.5 GiB hard cap');
  assert(B.memoryDebtTargetBytes === 536870912 && B.plateauMinMs === 10800000 && B.plateauMaxDeltaBytes === 10485760, 'memory decision');
  assert(B.latencyP95Ms === 45 && B.latencyP99Ms === 80 && B.pairedUpperCi95Ms === 3, 'latency unchanged');
  assert(B.normalMissingRows === 0 && B.plannedMissingRows === 0, 'normal/planned zero loss');
  assert(eventKey(eventId) === eventKey({ ...eventId }), 'retry event stable');
  for (const changed of [{ ...eventId, scrollOrdinal: 1 }, { ...eventId, sourceEpoch: 2 }, { ...eventId, packetSeq: 2 }, { ...eventId, pane: { ...pane, birthGeneration: 2 } }]) assert(eventKey(changed) !== eventKey(eventId), 'event separation');
  assert(rowKey(row.id) !== rowKey({ pane: { ...pane, serverIdentity: 'other' }, lineId: 0 }), 'cross-server rows');
  assert(validReadOpen(ack), 'interior fence');
  assert(validReadOpen({ ...ack, diskSnapshotRevision: 1 }) && validReadOpen({ ...ack, diskSnapshotRevision: 3 }), 'inclusive fence endpoints');
  for (const s of [0, 4, NaN, Infinity, -1, 1.5]) assert(!validReadOpen({ ...ack, diskSnapshotRevision: s }), 'reject invalid disk fence');
  assert(!validReadOpen({ ...ack, view: { ...view, range: { start: 0, end: 2 } } }), 'frozen head');
  assert(!validReadOpen({ ...ack, view: { ...view, range: { start: 1, end: 0 } } }), 'range inversion');
  assert(repair.episode.missingCount === null, 'unknown is not zero');
  assert(checkpoint.state.pendingUtf8.length === 1 && checkpoint.state.pendingEscape.length === 2, 'checkpoint retains incomplete parser input');
}

// Explicit .ts target through the cage: no new *.test.ts file is introduced.
test('legacy v1 contract: identity, immutable read fences and unknown counts', runContractFixture);

// Flag-on examples are hand-authored synthetic data, not matcher-generated
// expectations. They prove shape/consumer compilation, not persistence or tmux.
import type * as F from '../../src/stream-contract';
import { FLAGON_BUDGET, FLAGON_VERSIONS, flagOnNotImplemented } from '../../src/stream-contract';
import { NEWARCH_FLAGON_CAPABILITIES } from '../../../core/src/protocol';
import type { NewarchHistoryExtension, NewarchHistoryState, NewarchMissingCount } from '../../../core/src/protocol';
const capabilities: F.NewarchCapabilities = { extensionVersion: 1, supported: NEWARCH_FLAGON_CAPABILITIES, required: NEWARCH_FLAGON_CAPABILITIES };
const epoch: F.PipeEpoch = { pane, attachId: 'attach-fixture', collectorIncarnation: 'collector-fixture' };
const rawRange: F.RawRange = { epoch, start: 0, end: 8 };
const position: F.RawPosition = { epoch, byteOffset: 8 };
const process: F.ProcessIdentity = { pid: 123, startTime: 'synthetic-start', bootId: 'synthetic-boot' };
const file: F.EvidenceFile = { path: 'synthetic/fixture.bin', bytes: 8, sha256: digest };
const segmentRowId: F.SegmentRowId = { pane, segmentId: 'segment-fixture', rowOrdinal: 0 };
const segmentRange: F.SegmentRowRange = { pane, segmentId: 'segment-fixture', start: 0, end: 1 };
const unknownGap: F.Gap = { version: 1, episodeId: 'episode-fixture', parentEpisodeId: null, pane, leftRowId: segmentRowId, rightSegmentId: 'segment-next', reason: 'pipe-eof', countKind: 'unknown', missingCount: null, withheldRows: 2, lowerBound: 0, openedAt: 100, closedAt: null, clockEpoch: 'clock-fixture', quality: 'degraded' };
const exactGap: F.Gap = { ...unknownGap, countKind: 'exact', missingCount: 13, lowerBound: 13, quality: 'resolved', closedAt: 120 };
const estimatedGap: F.Gap = { ...unknownGap, countKind: 'estimate', missingCount: 20, lowerBound: 2 };
const coverage: F.Coverage = [{ kind: 'rows', range: segmentRange, digest }, { kind: 'gap', gap: unknownGap, digest }];
const fence: F.OperationFence = { operationId: 'op-fixture', pane, expectedGeneration: 1 };
const intent: F.AttachIntent = { ...fence, attachId: epoch.attachId, episodeId: unknownGap.episodeId, parentEpisodeId: null, kind: 'recovery', rootUUID: 'root-fixture' };
const binding: F.Binding = { kind: 'collector-binding', epoch, attachId: intent.attachId, rootUUID: intent.rootUUID, bootNonce: 'nonce', ownerGeneration: 1, process, peerUid: 1000, fifoId: 'fifo-fixture', handshakeId: 'handshake-fixture', artifactSha256: digest };
const boundary: F.BoundaryEvidence = { kind: 'certified-same-turn', pane, epoch, geometry, binarySha256: digest, hookConfigSha256: digest, transcript: file, eventCoverage: file, pipeOpenEvent: 'event-1', captureStartEvent: 'event-2', captureEndEvent: 'event-3', rawStart: { epoch, byteOffset: 0 }, certificateId: 'synthetic-certificate' };
const packet: F.CapturePacket = { version: 1, snapshotId: 'snapshot-fixture', episodeId: intent.episodeId, captureCount: 1, complete: true, pane, geometry, geometryGeneration: 1, historySize: 4500, historyLimit: 4500, cursor, activeBuffer: 'normal', mainHistory: 'available', snapshot: file, commandTranscript: file, rawRange, boundary, startedAtMonoMs: 100, endedAtMonoMs: 101, clockEpoch: 'clock-fixture', stateKnown: { savedCursor: false, pendingUtf8: false, sgr: false } };
const spool: F.SpoolRecord = { version: 1, operationId: fence.operationId, range: rawRange, sequence: 0, previousDigest: null, digest, payload: { kind: 'bytes', bytes: [65, 10, 65, 10, 66, 10, 67, 10] } };
const spoolAck: F.SpoolAck = { version: 1, kind: 'synced-spool', through: position, recordDigest: digest, commitId: 'spool-commit', segmentId: 'spool-fixture' };
const pipeOrigin: F.RowOrigin = { kind: 'pipe', range: rawRange, ordinal: 0 };
const streamRow: F.CommittedStreamRow = { id: segmentRowId, origin: pipeOrigin, cells: [{ text: 'A', width: 1, style: [] }], geometry, buffer: 'normal', wrapStatus: 'unwrapped', wrapPad: 0, finalized: true, uncertainFields: [], cellOrigins: [pipeOrigin] };
const repeatedRow: F.CommittedStreamRow = { ...streamRow, id: { ...segmentRowId, rowOrdinal: 1 }, origin: { ...pipeOrigin, ordinal: 1 }, cellOrigins: [{ ...pipeOrigin, ordinal: 1 }] };
const policy: F.StitchPolicy = { version: 1, minAnchorRows: 8, minDistinctKeys: 4, minNonblankRows: 2, maxCandidates: 4096, deadlineMs: 100 };
const proofs: F.StitchProofs = { policy, episodeId: intent.episodeId, tailToCapture: [{ kind: 'recorded-mapping', range: rawRange, checkpointId: checkpoint.checkpointId, mapping: file, coverage }], captureToPipe: [{ kind: 'independent-boundary', boundary }] };
const decision: F.StitchDecision = { decisionId: 'decision-fixture', acceptedRowMap: [{ source: pipeOrigin, target: segmentRowId }], withheldRanges: [], gaps: [] };
const matched: F.StitchResult = { ...decision, status: 'matched', proofs };
const unproven: F.StitchResult = { ...decision, status: 'unproven', reason: 'content-only', acceptedRowMap: [], withheldRanges: [{ source: 'capture', start: 0, end: 8, reason: 'unproven' }], gaps: [unknownGap] };
const ambiguous: F.StitchResult = { ...unproven, status: 'ambiguous', reason: 'multiple-alignments', candidateCount: 2 };
const stitchError: F.StitchResult = { status: 'error', code: 'integrity', message: 'synthetic hash mismatch' };
const rowsCommit: F.RowsAndGapsCommit = { ...fence, rows: [streamRow], coverage, decision: { ...decision, gaps: [unknownGap] }, inputAck: spoolAck, checkpointId: null, digest };
const rowsReceipt: F.RowsAndGapsReceipt = { kind: 'rows-gaps-durable', operationId: fence.operationId, commitId: 'rows-commit', generation: 1, coverage, digest };
const cut: F.FiniteCut = { pane, lastRow: segmentRowId, rawThrough: position };
const pin: F.SegmentPin = { ...fence, segmentId: 'spool-fixture', reason: 'handoff', pinId: 'pin-fixture', durableCommitId: 'pin-commit' };
const suffix: F.SuffixPin = { kind: 'durable-suffix-pin', cut, pin, through: spoolAck, checkpointId: null };
const exactBatch: F.ExactBatch = { ...fence, handoffId: 'handoff-fixture', archiveIncarnation: 'archive-fixture', epochs: [epoch], cut, rows: [streamRow], coverage, digest };
const legacyReceipt: F.LegacyRangeReceipt = { version: 1, kind: 'legacy-range-durable', operationId: fence.operationId, handoffId: exactBatch.handoffId, pane, ownerGeneration: 1, epochs: [epoch], archiveIncarnation: exactBatch.archiveIncarnation, cut, coverage, coverageDigest: digest, physicalIndexMap: [{ coverageIndex: 0, fileId: file.path, start: 0, end: 1 }, { coverageIndex: 1, fileId: file.path, start: 1, end: 2 }], files: [file], durableCommitId: 'legacy-commit' };
const validatedReceipt: F.ValidatedLegacyReceipt = { kind: 'validated-legacy-receipt', receipt: legacyReceipt, validationId: 'validation-fixture', readbackDigest: digest };
const writerBinding: F.WriterBinding = { ...fence, kind: 'current-writer-binding', handoffId: exactBatch.handoffId, writer: process, leaseGeneration: 1, subscriptionId: 'subscription-fixture', after: cut, archiveIncarnation: exactBatch.archiveIncarnation, bindingId: 'binding-fixture', handshakeId: 'writer-handshake' };
const opaqueCursor: F.NewarchHistoryCursor = { version: 1, token: 'synthetic-opaque-cursor' };
const prepared: F.PreparedHandoff = { state: 'PREPARED', intent: { ...fence, handoffId: exactBatch.handoffId, cut }, prefix: coverage, pendingToken: opaqueCursor, suffix };
const emptyCut: F.FiniteCut = { pane, lastRow: null, rawThrough: { epoch, byteOffset: 0 } };
const emptyReceipt: F.LegacyRangeReceipt = { ...legacyReceipt, operationId: 'empty-op', cut: emptyCut, coverage: [], physicalIndexMap: [], files: [{ ...file, path: 'synthetic/empty-receipt', bytes: 0 }] };
const emptyHandoff: F.CommitHandoffRequest = { prepared: { ...prepared, intent: { ...prepared.intent, cut: emptyCut }, prefix: [], suffix: { ...suffix, cut: emptyCut } }, receipt: { ...validatedReceipt, receipt: emptyReceipt }, binding: { ...writerBinding, after: emptyCut }, suffix: { ...suffix, cut: emptyCut } };
const sealed: F.SealedExport = { kind: 'sealed-export', operationId: fence.operationId, storeUUID: intent.rootUUID, pane, segmentId: segmentRange.segmentId, generation: 1, coverage, files: [file], manifest: file, sealCommitId: 'seal-commit' };
const remoteObject: F.RemoteObject = { objectKey: `root-fixture/pane-fixture/segment-fixture/${digest}.tar.zst`, bytes: 8, sha256: digest };
const bundle: F.ArchiveBundle = { version: 1, bundleId: 'bundle-fixture', storeUUID: intent.rootUUID, pane, segmentId: segmentRange.segmentId, coverage, schemaVersions: { catalog: 3, spool: 1, receipt: 1 }, objects: [remoteObject], members: [file], compression: 'tar.zst', encryption: 'none', manifest: { ...remoteObject, objectKey: 'root-fixture/inventory.json' }, checkpointIds: [], rawRanges: [rawRange] };
const verified: F.VerifiedBundle = { kind: 'verified-remote', bundle, verificationId: 'verify-fixture', method: 'download-sha256', verifiedAtMonoMs: 200, clockEpoch: 'clock-fixture', inventoryDigest: digest, evidence: [file], toolVersion: 'synthetic-verifier-1', command: ['synthetic-download-sha256'], stdout: file, stderr: { ...file, bytes: 0 }, exitCode: 0 };
const remote: F.RemoteIndexReceipt = { kind: 'remote-index-committed', catalogVersion: 3, commitId: 'remote-commit', generation: 1, verified, coverage };
const states: readonly NewarchHistoryState[] = [
  { kind: 'exact' }, { kind: 'gap', gap: unknownGap }, { kind: 'gap', gap: exactGap }, { kind: 'gap', gap: estimatedGap },
  { kind: 'pending', operationId: fence.operationId, retryAfterMs: 100 },
  { kind: 'degraded', episodeId: intent.episodeId, uncertainFields: ['savedCursor'] },
  { kind: 'remote-required', range: segmentRange, bundleId: bundle.bundleId },
  { kind: 'remote-unavailable', range: segmentRange, bundleId: bundle.bundleId, retryAfterMs: 1000, reason: 'offline' },
  { kind: 'remote-unavailable', range: segmentRange, bundleId: bundle.bundleId, retryAfterMs: 1000, reason: 'missing' },
  { kind: 'remote-unavailable', range: segmentRange, bundleId: bundle.bundleId, retryAfterMs: 1000, reason: 'corrupt' },
  { kind: 'pressure', level: 'archive', collecting: true, sinceMonoMs: 200 },
  { kind: 'pressure', level: 'critical', collecting: true, sinceMonoMs: 201 },
  { kind: 'pressure', level: 'emergency', collecting: false, sinceMonoMs: 202 },
];
const extension: NewarchHistoryExtension = { version: 1, capabilities, states, before: { kind: 'end' }, after: { kind: 'blocked', cursor: opaqueCursor, state: { kind: 'pending', operationId: fence.operationId, retryAfterMs: 100 } } };
const flagView: F.FlagOnReadView = { ...view, flagOn: { version: 1, capabilities, committedPrefix: coverage, cursor: opaqueCursor, states } };
const flagPage: F.FlagOnHistoryPage = { view: flagView, rows: [streamRow], payloadBytes: 1, flagOn: extension };
const pressure: F.StoragePressure = { sampledAtMonoMs: 100, clockEpoch: 'clock-fixture', filesystemUsedPercent: 75, rootAllocatedBytes: 192 * 1024 * 1024, rootHardCapBytes: 256 * 1024 * 1024, usableFreeBytes: null, rate15minBytesPerSecond: null, reserveBytes: 16 * 1024 * 1024, sampleAgeMs: 0, ioError: null };
const episodeObservation: F.EpisodeObservation = { atMonoMs: 100, clockEpoch: 'clock-fixture', epoch, episodeId: intent.episodeId, phase: 'trigger', reason: 'pipe-eof', captureCount: 1, eventCoverage: null, rawBytes: 8, gap: unknownGap, rawRecoveredAtMonoMs: null, exactDisplayAtMonoMs: null };
const archiveObservation: F.ArchiveObservation = { atMonoMs: 200, clockEpoch: 'clock-fixture', epoch, operationId: fence.operationId, state: 'UPLOADED_UNVERIFIED', physicalLocalBytes: 8, remoteVerifiedBytes: 0, spoolBytes: 8, scratchBytes: 0, cacheBytes: 0, pressure };
const memoryObservation: F.MemoryObservation = { atMonoMs: 200, clockEpoch: 'clock-fixture', epoch, processes: [{ identity: process, role: 'collector', pssBytes: null }], expectedProcesses: [process], coverage: null, rawBytes: 8, stagingBytes: 0, physicalDiskBytes: null };
export const FLAGON_FIXTURE = { capabilities, epoch, packet, binding, spool, spoolAck, unknownGap, exactGap, estimatedGap, coverage, streamRow, repeatedRow, matched, ambiguous, unproven, stitchError, rowsCommit, rowsReceipt, legacyReceipt, emptyReceipt, emptyHandoff, prepared, sealed, bundle, verified, remote, flagPage, states, pressure, episodeObservation, archiveObservation, memoryObservation } as const;

// Independent expected vectors for C/T. IDs denote separate producer events,
// even where cells repeat. Expected decisions are literals, never matcher output.
export const STITCH_ORACLE_VECTORS = [
  { id: 'ST-short-7', tail: ['a','b','c','d','e','f','g'], capture: ['a','b','c','d','e','f','g'], proof: 'none', expected: 'unproven' },
  { id: 'ST-unique-reprinted-8', tail: ['a','b','c','d','e','f','g','h'], capture: ['a','b','c','d','e','f','g','h'], proof: 'none-after-clear', expected: 'unproven' },
  { id: 'ST-multiple', tail: ['a','b','a','b','a','b','a','b'], capture: ['a','b','a','b','a','b','a','b','a','b'], proof: 'none', expected: 'ambiguous' },
  { id: 'ST-blank', tail: ['','','','','','','',''], capture: ['','','','','','','',''], proof: 'none', expected: 'unproven' },
  { id: 'ST-proven-8', tail: ['a','b','c','d','e','f','g','h'], capture: ['a','b','c','d','e','f','g','h','i'], proof: 'recorded-mapping-and-boundary', expected: 'matched' },
  { id: 'ST-zero-birth', tail: [], capture: [], proof: 'genesis-byte-zero', expected: 'matched' },
] as const;

// Never invoke this function: it is a compile-only cross-lot integration client.
export async function compileFlagOnPorts(a: F.ArchiveCatalogPort, s: F.SourceTransportPort, c: F.StitchPort, h: F.FlagOnHistoryPort, w: F.LegacyWriterPort, o: F.ArchiveWorkerPort, q: F.FlagOnObserver) {
  const cancel = { isCancelled: () => false };
  await a.beginAttach(intent);
  await s.openBirth({ ...intent, kind: 'birth' }, cancel);
  await s.openRecovery(intent, cancel);
  await c.stitch({ pane, rows: [] }, { pane, packet, rows: [] }, { pane, rawRange, rows: [streamRow] }, proofs);
  await h.appendInput(spool);
  await h.commitRowsAndGaps(rowsCommit);
  for await (const chunk of h.recover(pane, position, cancel)) void chunk;
  await a.commitAttach({ ...fence, attachId: intent.attachId, binding, packet, durable: rowsReceipt, admission: 'active-degraded' });
  await a.abortAttach({ ...fence, attachId: intent.attachId, reason: 'synthetic-abort' });
  await a.prepareHandoff(prepared.intent, suffix);
  await w.appendExactBatch(exactBatch);
  await w.bindLegacyWriter(writerBinding);
  await a.commitHandoff({ prepared, receipt: validatedReceipt, binding: writerBinding, suffix });
  await a.commitHandoff(emptyHandoff);
  await a.recoverPending(pane, cancel);
  await h.pinSegment(pin);
  await h.releasePin(pin);
  await h.sealExport({ ...fence, segmentId: sealed.segmentId });
  await a.commitRemoteIndex({ ...fence, sealed, verified });
  await a.getLocation(segmentRange);
  await h.reclaimVerified({ ...fence, sealed, remote });
  await o.archiveOnce(pressure, cancel);
  await o.verifyBundle(bundle, cancel);
  await o.restoreRange({ operationId: fence.operationId, storeUUID: bundle.storeUUID, range: segmentRange, inventory: bundle.manifest, allowedRoot: 'synthetic-root' }, cancel);
  q.observeEpisode(episodeObservation); q.observeArchive(archiveObservation); q.observeMemory(memoryObservation);
}
function negativeFlagOnTypes() {
  // @ts-expect-error Unknown cannot be encoded as zero.
  const badCount: NewarchMissingCount = { countKind: 'unknown', missingCount: 0 };
  // @ts-expect-error An exact count cannot be null.
  const badExact: NewarchMissingCount = { countKind: 'exact', missingCount: null };
  // @ts-expect-error A snapshot is not a VT checkpoint.
  const badCheckpoint: F.VtCheckpoint = packet;
  // @ts-expect-error Zero overlap requires evidence, not a boolean.
  const badBoundary: F.BoundaryEvidence = true;
  // @ts-expect-error Old line IDs are not segment coordinates.
  const badRow: F.SegmentRowId = row.id;
  // @ts-expect-error Upload completion does not authorize reclaim.
  const badRemote: F.RemoteIndexReceipt = { ...remote, verified: { state: 'UPLOADED_UNVERIFIED', bundle } };
  // @ts-expect-error Receipt without a current binding and pin is not ready.
  const badHandoff: F.CommitHandoffRequest = { prepared, receipt: validatedReceipt };
  // @ts-expect-error Legacy optional extension is insufficient for flag-on reads.
  const badView: F.FlagOnReadView = view;
  // @ts-expect-error Pending cannot be an end continuation.
  const badEnd: NewarchHistoryExtension['after'] = { kind: 'end', state: states[4] };
  // @ts-expect-error Capture count is exactly one, not a retry counter.
  const badPacket: F.CapturePacket = { ...packet, captureCount: 2 };
  // @ts-expect-error Minimum anchor threshold cannot silently become 1.
  const badPolicy: F.StitchPolicy = { ...policy, minAnchorRows: 1 };
  return [badCount, badExact, badCheckpoint, badBoundary, badRow, badRemote, badHandoff, badView, badEnd, badPacket, badPolicy];
}
export function runFlagOnContractFixture(): void {
  const assert = (ok: boolean, message: string) => { if (!ok) throw new Error(message); };
  assert(FLAGON_VERSIONS.catalog === 3 && FLAGON_VERSIONS.capture === 1, 'extension versions');
  assert(FLAGON_BUDGET.faultMissingRowsLimit === null && FLAGON_BUDGET.normalMissingRows === 0 && FLAGON_BUDGET.plannedMissingRows === 0, 'Q21 fault scope');
  assert(unknownGap.missingCount === null && unknownGap.countKind === 'unknown', 'unknown preserved');
  assert(exactGap.missingCount === 13 && estimatedGap.countKind === 'estimate', 'over-five loss and estimate');
  assert(streamRow.cells[0]!.text === repeatedRow.cells[0]!.text && streamRow.id.rowOrdinal !== repeatedRow.id.rowOrdinal, 'new identical text is a new event');
  assert(emptyHandoff.receipt.receipt.coverage.length === 0 && emptyHandoff.binding.after.lastRow === null && emptyHandoff.suffix.cut.lastRow === null, 'empty receipt positive with boundary/binding/pin');
  assert(flagPage.flagOn.after.kind === 'blocked' && flagPage.rows.length === 1, 'pending retains prefix');
  assert(memoryObservation.processes[0]!.pssBytes === null && pressure.rate15minBytesPerSecond === null, 'unmeasured is not zero');
  assert(FLAGON_BUDGET.archiveChunkBytes === 16777216 && FLAGON_BUDGET.reserveBytes === 16777216 && FLAGON_BUDGET.restoreCacheBytes === 33554432, 'fixed storage budgets');
  let threw = false;
  try { flagOnNotImplemented('synthetic-port'); } catch (error) { threw = error instanceof Error && error.message.includes('implementation required'); }
  assert(threw, 'placeholder cannot silently succeed');
}
test('flag-on v1 contract: Q21 gaps, empty handoff, remote/pending and fixed budgets', runFlagOnContractFixture);

export const FLAGON_LOCATION_FIXTURES: readonly F.SegmentLocation[] = [
  { kind: 'local', range: segmentRange, files: [file] },
  { kind: 'remote-required', range: segmentRange, remote },
  { kind: 'restored', range: segmentRange, cacheId: 'synthetic-cache', remote },
  { kind: 'remote-unavailable', range: segmentRange, bundleId: bundle.bundleId, reason: 'offline', retryAfterMs: 1000 },
  { kind: 'remote-unavailable', range: segmentRange, bundleId: bundle.bundleId, reason: 'missing', retryAfterMs: 1000 },
  { kind: 'remote-unavailable', range: segmentRange, bundleId: bundle.bundleId, reason: 'corrupt', retryAfterMs: 1000 },
];
const genesisBuffer: F.VtBuffer = { rows: [], cursor: { x: 0, y: 0, visible: true }, savedCursor: { x: 0, y: 0, visible: true }, savedAttributes: [], savedModes: {}, wrapPending: false };
const birthGenesis: F.VtCheckpoint = { ...checkpoint, revision: 0, head: 0, state: { ...state, normal: genesisBuffer, alternate: genesisBuffer, pendingUtf8: [], pendingEscape: [], extensionState: '{}' } };
export const FLAGON_CAPTURE_FIXTURES: readonly F.CapturePacket[] = [
  packet,
  { ...packet, boundary: { kind: 'overlap-unknown', reason: 'split-command' } },
  { ...packet, activeBuffer: 'alternate', mainHistory: 'unavailable', boundary: { kind: 'overlap-unknown', reason: 'parse' } },
  { ...packet, historySize: 0, rawRange: { epoch, start: 0, end: 0 }, boundary: { kind: 'birth', pane, epoch, genesis: birthGenesis, firstByteOffset: 0, transcript: file } },
];
// Shape fixtures only: every evidence digest/path/lease is synthetic.
// These examples are not certificates and cannot authorize a real source attach.

// K-r2 golden conformance: red commit used documented v1 payload fallbacks.
// Owner runtime integration tests remain mandatory; helpers do not provide I/O proof.
import * as KSeam from '../../src/stream-contract';
import { expect } from 'bun:test';
test('K-r2 GOLDEN C semantic default becomes canonical SGR accepted by H/W/A', () => {
  const sgr = KSeam.semanticStyleToSgr({ attrs: 0, fg: -1, bg: -1 });
  expect(sgr).toEqual([]);
  expect(`\x1b[0${sgr.length ? ';' + sgr.join(';') : ''}mA\x1b[0m`).toBe('\x1b[0mA\x1b[0m');
});
test('K-r2 GOLDEN H to W normalized coverage has one digest domain', () => {
  const actual = KSeam.normalizedRowsDigest(segmentRange, [streamRow]);
  const expected = '68042cf134fc017cac6d77863bb18c046d1b8139b4a0406eb6fdd98ab4678fa1';
  expect(actual).toBe(expected);
});
const readbackGolden: F.LegacyReadbackR2 = { kind: 'legacy-readback-r2', revision: 2, receiptCommitId: 'commit-golden', coverageDigest: 'a'.repeat(64), readbackDigest: 'b'.repeat(64) };
test('K-r2 GOLDEN W physical readback accepted by A without cross-domain equality', () => {
  const accepts = KSeam.legacyReadbackMatches(readbackGolden, { ...readbackGolden });
  expect(accepts).toBe(true);
});
const inventorySeal = { ...sealed, manifest: { ...sealed.manifest, path: 'synthetic/seal-manifest.json' } };
const inventoryGolden: F.ArchiveInventoryR2 = {
  revision: 2, sealGeneration: sealed.generation, sealCommitId: sealed.sealCommitId,
  sealManifestSha256: sealed.manifest.sha256, bundleManifestSha256: bundle.manifest.sha256,
  members: [...inventorySeal.files, inventorySeal.manifest].map((source, i) => ({ sourcePath: source.path, relativePath: `member-${i}`, bytes: source.bytes, sha256: source.sha256 })),
};
const mappedBundle = { ...bundle, members: inventoryGolden.members.map(m => ({ path: m.relativePath, bytes: m.bytes, sha256: m.sha256 })) };
test('K-r2 GOLDEN O relative inventory maps payload plus seal manifest for A/H', () => {
  const accepts = KSeam.archiveInventoryMatches(inventorySeal, mappedBundle, inventoryGolden);
  expect(accepts).toBe(true);
});
const attachReceipts = [0, 1].map(i => ({ ...rowsReceipt, operationId: `chunk-${i}`, commitId: `commit-${i}`, coverage: [coverage[i]!], digest: String(i).repeat(64) }));
const attachManifest: F.AttachReceiptSetR2 = {
  revision: 2, transactionId: 'transaction-golden', pane, epoch, decisionId: decision.decisionId,
  expectedGeneration: rowsReceipt.generation,
  entries: attachReceipts.map((r, ordinal) => ({ ordinal, operationId: r.operationId, commitId: r.commitId, digest: r.digest, rows: ordinal === 0 ? 1 : 0, payloadBytes: 128 })),
  terminalCommitId: attachReceipts[1]!.commitId,
  aggregateDigest: KSeam.streamDigest('attach-receipt-set-r2', attachReceipts.map((r, ordinal) => ({ ordinal, operationId: r.operationId, commitId: r.commitId, digest: r.digest, rows: ordinal === 0 ? 1 : 0, payloadBytes: 128 }))),
};
test('K-r2 GOLDEN ordered attach retains every receipt coverage', () => {
  const actual = KSeam.attachCoverage(attachManifest, attachReceipts);
  expect(actual).toEqual(coverage);
});

import { NEWARCH_REPAIR_CAPABILITIES, supportsNewarchRepair } from '../../../core/src/protocol';
const r2Capabilities = { revision: 2, supported: NEWARCH_REPAIR_CAPABILITIES, required: NEWARCH_REPAIR_CAPABILITIES } as const;
test('K-r2 old v1 stays readable; unknown revision and required capability refuse', () => {
  expect(KSeam.STREAM_CONTRACT_VERSION).toBe(1);
  expect(FLAGON_VERSIONS).toEqual({ stitch: 1, capture: 1, spool: 1, receipt: 1, bundle: 1, catalog: 3, history: 1 });
  expect(supportsNewarchRepair(r2Capabilities, r2Capabilities)).toBe(true);
  expect(supportsNewarchRepair(r2Capabilities, { ...r2Capabilities, revision: 3 })).toBe(false);
  expect(supportsNewarchRepair(r2Capabilities, { ...r2Capabilities, supported: NEWARCH_FLAGON_CAPABILITIES })).toBe(false);
  expect(supportsNewarchRepair(r2Capabilities, { ...r2Capabilities, required: ['unknown-r99'] })).toBe(false);
});
// Literal vectors authored independently of converter. Combining marks remain
// in text, wide continuation remains width 0; neither conversion trims cells.
export const CELL_R2_GOLDENS = [
  { semantic: { attrs: 0, fg: -1, bg: -1 }, sgr: [] },
  { semantic: { attrs: 513, fg: 1, bg: 15 }, sgr: [1, 21, 31, 107] },
  { semantic: { attrs: 12, fg: 196, bg: 256 + 0x010203 }, sgr: [3, 4, 38, 5, 196, 48, 2, 1, 2, 3] },
  { semantic: { attrs: 1023, fg: 256 + 0xffffff, bg: 0 }, sgr: [1, 2, 3, 4, 5, 6, 7, 8, 9, 21, 38, 2, 255, 255, 255, 40] },
] as const;
test('K-r2 codec preserves attrs/default/index/RGB/combining/wide; refuses aliases', () => {
  for (const vector of CELL_R2_GOLDENS) {
    expect(KSeam.semanticStyleToSgr(vector.semantic)).toEqual([...vector.sgr]);
    expect(KSeam.sgrToSemanticStyle(vector.sgr)).toEqual(vector.semantic);
    for (const [text, width] of [['e\u0301', 1], ['界', 2], ['', 0]] as const) {
      const semantic = { text, width, style: vector.semantic };
      expect(KSeam.semanticCellToCell(semantic)).toEqual({ text, width, style: vector.sgr });
      expect(KSeam.cellToSemanticCell({ text, width, style: vector.sgr })).toEqual(semantic);
    }
  }
  for (const bad of [[0, -1, -1], [0], [38, 2, 1], [38, 5, 256], [38, 5, 1], [1, 1], [31, 1], [999]]) {
    expect(() => KSeam.sgrToSemanticStyle(bad)).toThrow();
  }
  expect(() => KSeam.semanticStyleToSgr({ attrs: 1024, fg: -1, bg: -1 })).toThrow();
  expect(() => KSeam.semanticStyleToSgr({ attrs: 0, fg: -2, bg: -1 })).toThrow();
});
test('K-r2 source/H/physical domains: independent SHA-256 goldens, no v1 rewrite', () => {
  const { digest: ignored, ...unsigned } = spool;
  expect(KSeam.sourceSpoolDigest(unsigned)).toBe('71bfc94663c091b694594d1e7e6c6c122df10ac12d53b2d4fc43beede566b3ac');
  expect(KSeam.historySpoolDigest(unsigned)).toBe('e3330770be911d54852756fafe0729a10735919f29d656842105b4f2b38f0b16');
  expect(KSeam.normalizedCoverageDigest([])).toBe('b1d1e3dadcad74a5fe385311c3be2c295e16766fe6519b3da150a0269f6ea280');
  const physical: F.PhysicalReadbackR2 = { durableCommitId: 'empty-commit', coverageDigest: 'a'.repeat(64), files: [], physicalIndexMap: [], lineSha: [] };
  expect(KSeam.physicalReadbackDigest(physical)).toBe('1801506a317236ebb5f7cd4b318f73f0f69e4c3f3b55969a9d918e2eff154930');
  for (const changed of [{ ...physical, durableCommitId: 'other' }, { ...physical, files: [file] }, { ...physical, physicalIndexMap: legacyReceipt.physicalIndexMap }, { ...physical, lineSha: [digest] }]) {
    expect(KSeam.physicalReadbackDigest(changed)).not.toBe(KSeam.physicalReadbackDigest(physical));
  }
  expect(spool.digest).toBe(ignored);
  for (const changed of [{ ...readbackGolden, receiptCommitId: 'other' }, { ...readbackGolden, coverageDigest: digest }, { ...readbackGolden, readbackDigest: readbackGolden.coverageDigest }]) {
    expect(KSeam.legacyReadbackMatches(readbackGolden, changed)).toBe(false);
  }
});
test('K-r2 attach rejects missing/reordered/replayed/oversized/cross-pane receipts', () => {
  expect(() => KSeam.attachCoverage(attachManifest, attachReceipts.slice(1))).toThrow();
  expect(() => KSeam.attachCoverage(attachManifest, [...attachReceipts].reverse())).toThrow();
  expect(() => KSeam.attachCoverage({ ...attachManifest, aggregateDigest: digest }, attachReceipts)).toThrow();
  expect(() => KSeam.attachCoverage({ ...attachManifest, terminalCommitId: 'wrong' }, attachReceipts)).toThrow();
  for (const change of [{ rows: 257 }, { payloadBytes: 1048577 }, { ordinal: 1 }, { commitId: attachReceipts[1]!.commitId }]) {
    const entries = attachManifest.entries.map((e, i) => i ? e : { ...e, ...change });
    expect(() => KSeam.attachCoverage({ ...attachManifest, entries, aggregateDigest: KSeam.attachReceiptSetDigest(entries) }, attachReceipts)).toThrow();
  }
  expect(() => KSeam.attachCoverage(attachManifest, attachReceipts.map(r => ({ ...r, generation: 9 })))).toThrow();
  const wrongPane: F.Coverage = [{ kind: 'rows', range: { ...segmentRange, pane: { ...pane, paneId: '%2' } }, digest }];
  expect(() => KSeam.attachCoverage(attachManifest, [{ ...attachReceipts[0]!, coverage: wrongPane }, attachReceipts[1]!])).toThrow();
});
test('K-r2 archive requires bijective inventory and separate seal/bundle checksums', () => {
  for (const members of [inventoryGolden.members.slice(1), [inventoryGolden.members[0]!, inventoryGolden.members[0]!], inventoryGolden.members.map(m => ({ ...m, relativePath: '../escape' })), inventoryGolden.members.map(m => ({ ...m, bytes: 99 }))]) {
    expect(KSeam.archiveInventoryMatches(inventorySeal, mappedBundle, { ...inventoryGolden, members })).toBe(false);
  }
  expect(KSeam.archiveInventoryMatches(inventorySeal, mappedBundle, { ...inventoryGolden, sealGeneration: 2 })).toBe(false);
  expect(KSeam.archiveInventoryMatches(inventorySeal, mappedBundle, { ...inventoryGolden, sealManifestSha256: '1'.repeat(64) })).toBe(false);
  expect(KSeam.archiveInventoryMatches(inventorySeal, mappedBundle, { ...inventoryGolden, bundleManifestSha256: '1'.repeat(64) })).toBe(false);
});
const gapR2: F.GapR2 = { ...unknownGap, repair: { revision: 2, gapId: 'gap-a', sequence: 0, update: 0, state: 'open' } };
test('K-r2 multiple gaps per episode, idempotent identity and ordered close', () => {
  const second: F.GapR2 = { ...gapR2, repair: { ...gapR2.repair, gapId: 'gap-b', sequence: 1 } };
  expect(KSeam.gapIdentity(gapR2)).not.toBe(KSeam.gapIdentity(second));
  expect(KSeam.gapIdentity(gapR2)).not.toBe(KSeam.gapIdentity(unknownGap));
  const closed: F.GapR2 = { ...gapR2, closedAt: 130, quality: 'resolved', repair: { ...gapR2.repair, update: 1, state: 'closed' } };
  expect(KSeam.gapIdentity(gapR2)).toBe(KSeam.gapIdentity(closed));
  expect(KSeam.validGapUpdate(gapR2, closed)).toBe(true);
  expect(KSeam.validGapUpdate(closed, gapR2)).toBe(false);
  expect(KSeam.validGapUpdate(gapR2, { ...closed, leftRowId: null })).toBe(false);
  expect(KSeam.validGapUpdate(gapR2, { ...closed, repair: { ...closed.repair, update: 2 } })).toBe(false);
});

// Compile-only examples: never call, never claim durability from fixture data.
export async function compileRepairPorts(h: F.FlagOnHistoryR2, a: F.ArchiveCatalogR2,
  s: F.SourceTransportR2, w: F.LegacyWriterR2, cache: F.RestoreAuthorityR2,
  input: F.CoalescedInputR2, watermark: F.ReplayWatermarkR2, consumer: F.ConsumerCheckpointR2,
  event: F.OrderedControlR2, replay: F.ReplayDecisionR2, negotiation: F.CollectorNegotiationR2,
  retirement: F.ReadyRetirementR2, switchRequest: F.SamePipeSwitchR2, archive: F.RemoteAuthorizationR2,
  remoteR2: F.RemoteIndexR2) {
  await h.appendVerifiedInput(input);
  await h.stageRows({ ...rowsCommit, repair: { revision: 2, transactionId: attachManifest.transactionId, epoch, decisionId: decision.decisionId, chunkOrdinal: 0, visibility: 'candidate' } });
  await h.sealAttachSet({ ...fence, manifest: attachManifest });
  h.authority.attachSet(attachManifest.transactionId);
  const committed = await a.commitAttach({ ...fence, attachId: epoch.attachId, binding, packet, admission: 'active-degraded', receiptSet: attachManifest });
  if (committed.status === 'ok') await h.publishAttach(committed.value);
  h.authority.generation(pane); h.authority.staged(attachManifest.transactionId, 0); h.authority.receipt(rowsReceipt.commitId);
  h.authority.pin(pin.pinId); h.authority.seal(sealed.sealCommitId); h.authority.head(pane); h.authority.tail(pane, 256, 1048576);
  h.authority.watermark(pane);
  const read: F.BoundedReadR2 = { pane, cursor: null, direction: 'before', maxEntries: 256, maxBytes: 1048576 };
  h.authority.page(read); h.authority.decisions(read); cache.page(read); cache.lookup(segmentRange);
  const pinned = await cache.pin(pin); if (pinned.status === 'ok') await cache.release(pinned.value);
  const rotated = await h.rotateSegment({ ...fence, segmentId: sealed.segmentId, boundary: position });
  if (rotated.status === 'ok') { h.authority.continuity(rotated.value.rotationCommitId); await w.appendContinuous({ ...exactBatch, continuity: [rotated.value] }); }
  await h.sealSegment({ ...fence, segmentId: sealed.segmentId }); h.listSealed(null, 256);
  await h.materializeExport({ ...fence, sealCommitId: sealed.sealCommitId });
  await h.journalControl({ ...fence, event }); await h.commitReplayCheckpoint({ ...fence, checkpoint, watermark });
  await h.commitReplayDecision({ ...fence, decision: replay });
  await s.negotiate(negotiation); await s.acknowledgeConsumer(consumer); await s.trim(consumer);
  await s.replayBounded(binding, position, 256, 1048576); await s.retireReady(retirement);
  await s.rearmReserve({ ...fence, incidentId: 'incident', resolvedCommitId: 'resolution' }); await s.certifyBirth('creation', binding);
  w.readback(legacyReceipt); w.projection(rowsReceipt.commitId);
  await w.freezeInterval({ ...fence, intervalId: 'interval', from: emptyCut, cut, binding: writerBinding, suffix });
  a.authority.switchDecision(switchRequest.switchId);
  a.authority.attach(epoch.attachId); a.authority.remote(remoteR2.commitId);
  await a.recoverPending(pane, { isCancelled: () => false }); await a.switchSamePipe(switchRequest);
  await a.commitHandoffR2({ ...emptyHandoff, readback: readbackGolden });
  await a.resolveLegacyPending({ ...fence, pendingId: 'old', handoff: emptyHandoff, readback: readbackGolden });
  await a.commitRemoteIndex(archive);
  await h.reclaimR2({ ...fence, sealed: inventorySeal, remote: remoteR2, inventory: inventoryGolden });
}
function negativeRepairTypes(h: F.FlagOnHistoryPort, a: F.ArchiveCatalogPort) {
  // @ts-expect-error Old history has no durable authority/staging/retention proof.
  const history: F.FlagOnHistoryR2 = h;
  // @ts-expect-error Old catalog single receipt is not a receipt-set transaction.
  const catalog: F.ArchiveCatalogR2 = a;
  // @ts-expect-error Semantic cell cannot masquerade as a durable SGR cell.
  const cell: F.Cell = { text: 'A', width: 1, style: { attrs: 0, fg: -1, bg: -1 } };
  // @ts-expect-error An arbitrary retired/fault state is not a birth certificate.
  const birth: F.BirthCertificateR2 = true;
  // @ts-expect-error v1 pending lacks the new discriminated no-data/migration states.
  const pending: F.PendingRecoveryR2 = { kind: 'pending', prepared, reason: 'storage' };
  return [history, catalog, cell, birth, pending];
}

test('K-r2 every added digest domain has an independent literal golden', () => {
  const projection: Omit<F.CoverageProjectionR2, 'projectionDigest'> = { revision: 2, sourceCommitId: 'rows-commit', sourceDigest: digest, sourceDomain: 'rows-gaps-v1', coverage, coverageDigest: digest };
  const provenance: Omit<F.CoalescedInputR2, 'provenanceDigest'> = { revision: 2, record: spool, historyDomain: 'spool', source: [{ range: rawRange, firstSequence: 0, lastSequence: 0, previousDigest: null, terminalDigest: digest, sourceDomain: 'spool-record', recordsDigest: digest }] };
  const continuity: Omit<F.SegmentContinuityR2, 'digest'> = { revision: 2, pane, epoch, predecessor: 'segment-fixture', successor: 'segment-next', boundary: position, lastRow: segmentRowId, firstSuccessorOrdinal: 0, sealCommitId: 'seal-commit', rotationCommitId: 'rotation-golden' };
  const control: Omit<F.OrderedControlR2, 'digest'> = { revision: 2, eventId: 'resize-golden', position, order: 1, decoderVersion: 'decoder-golden', payload: { kind: 'geometry', before: geometry, after: { columns: 80, rows: 20 } } };
  expect(KSeam.normalizedGapDigest(unknownGap)).toBe('224874f5de204618dba1247b978be292f24f22fe64f5723d0228fae136482b45');
  expect(KSeam.sourceRecordsDigest([spool])).toBe('f7f21d526214c5a813bc485f8e4dfa0aa0c30b40e14187e11b23dbd2cc10336b');
  expect(KSeam.coverageProjectionDigest(projection)).toBe('8c5b93ec6a654da19bdb0728d448a49333e1d6adb8c848942d71e4dcfa46b9fb');
  expect(KSeam.inputProvenanceDigest(provenance)).toBe('1f27809b8cd73bfbeed111e481f6b4cb66e2a272aa9e89518f608e5f54ce3c51');
  expect(KSeam.segmentContinuityDigest(continuity)).toBe('1b51967f0eb84a105aafc52348a94907fbde248f346b13965affd48649fbbf75');
  expect(KSeam.orderedControlDigest(control)).toBe('e29075054b744e7c94363d4363f76fc689921419b2290376ecd702117acdf9ff');
  expect(KSeam.attachReceiptSetDigest(attachManifest.entries)).toBe('a6f48c9f9cb5ff27198cfa53ef2bb3ac0bd7d365fd088da5af5b8d5dba558283');
  expect(KSeam.archiveInventoryDigest(inventoryGolden)).toBe('6666e82575282acbd93cc0628df39a82de65fe752b7441ce170d17f9018c5a36');
});
test('K-r2 attach covers 4501 rows across 18 bounded receipts and empty positive', () => {
  const receipts: F.RowsAndGapsReceipt[] = Array.from({ length: 18 }, (_, i) => ({ ...rowsReceipt,
    operationId: `bulk-op-${i}`, commitId: `bulk-commit-${i}`,
    coverage: [{ kind: 'rows', range: { ...segmentRange, start: i * 256, end: Math.min((i + 1) * 256, 4501) }, digest }],
  }));
  const entries: F.AttachReceiptEntryR2[] = receipts.map((r, i) => ({ ordinal: i, operationId: r.operationId, commitId: r.commitId, digest: r.digest, rows: Math.min(256, 4501 - i * 256), payloadBytes: 4096 }));
  const set: F.AttachReceiptSetR2 = { ...attachManifest, entries, aggregateDigest: KSeam.attachReceiptSetDigest(entries), terminalCommitId: receipts[17]!.commitId };
  const all = KSeam.attachCoverage(set, receipts);
  expect(all.length).toBe(18);
  expect(all.reduce((n, part) => n + (part.kind === 'rows' ? part.range.end - part.range.start : 0), 0)).toBe(4501);
  const emptyEntry = { ...entries[0]!, rows: 0 };
  expect(KSeam.attachCoverage({ ...set, entries: [emptyEntry], aggregateDigest: KSeam.attachReceiptSetDigest([emptyEntry]), terminalCommitId: emptyEntry.commitId }, [{ ...receipts[0]!, coverage: [] }])).toEqual([]);
});
function negativeRepairContinuation() {
  const pressure = { kind: 'pressure', level: 'emergency', collecting: false, sinceMonoMs: 1 } as const;
  // @ts-expect-error R2 blocked pressure requires positioned persistent incident too.
  const missingIncident: import('../../../core/src/protocol').NewarchHistoryContinuationR2 = { kind: 'blocked', cursor: opaqueCursor, state: pressure };
  return missingIncident;
}

// K-fix2 R12: ordered controls after a replay checkpoint. Literal goldens come
// from orchestrator-runs/.../k-fix2/evidence/r12-goldens.py (Python hashlib).
const controlWatermark: F.ReplayWatermarkR2 = { revision: 2, pane, checkpointId: 'checkpoint-1', through: position, controlOrder: 0, decoderVersion: 'decoder-golden', stateDigest: digest, known: {}, decisionIndexCommitId: 'decision-index', snapshotDependencies: [file], durableCommitId: 'watermark-commit' };
const controlBodies: Omit<F.OrderedControlR2, 'digest'>[] = [
  { revision: 2, eventId: 'resize-golden', position, order: 1, decoderVersion: 'decoder-golden', payload: { kind: 'geometry', before: geometry, after: { columns: 80, rows: 20 } } },
  { revision: 2, eventId: 'altscreen-golden', position, order: 2, decoderVersion: 'decoder-golden', payload: { kind: 'control', name: 'DECSET', data: '?1049' } },
  { revision: 2, eventId: 'resize-2-golden', position: { epoch, byteOffset: 64 }, order: 0, decoderVersion: 'decoder-golden', payload: { kind: 'geometry', before: { columns: 80, rows: 20 }, after: { columns: 100, rows: 30 } } },
];
const controlDigests = ['e29075054b744e7c94363d4363f76fc689921419b2290376ecd702117acdf9ff', 'e7137209a0543d7a6cf22f4ec0ad7e48611119476fac073c820a31dab81bb564', '8bcf802442caa2aa4dde05555c3e763c7ad071d94c7ac2d07e178882ba35f029'];
const controlEntries: F.OrderedControlEntryR2[] = controlBodies.map((b, i) => ({ commitId: `control-commit-${i}`, event: { ...b, digest: controlDigests[i]! } }));
const controlRead: F.OrderedControlReadR2 = { pane, after: controlWatermark, cursor: null, maxEntries: 2, maxBytes: 1048576 };
const controlPage1: F.OrderedControlPageR2 = { revision: 2, pane, checkpointId: 'checkpoint-1', entries: controlEntries.slice(0, 2), payloadBytes: 936, next: opaqueCursor, atDurableHead: false };
const controlPage2: F.OrderedControlPageR2 = { revision: 2, pane, checkpointId: 'checkpoint-1', entries: controlEntries.slice(2), payloadBytes: 489, next: null, atDurableHead: true };
const controlSeed: F.OrderedControlReplayR2 = { last: null, geometry };

test('K-fix2 GOLDEN R12 controls after checkpoint replay resize across two bounded pages', () => {
  controlBodies.forEach((b, i) => expect(KSeam.orderedControlDigest(b)).toBe(controlDigests[i]!));
  const first = KSeam.replayOrderedControls(controlRead, controlPage1, controlSeed);
  expect(first.events.map(e => e.eventId)).toEqual(['resize-golden', 'altscreen-golden']);
  expect(first.geometry).toEqual({ columns: 80, rows: 20 });
  const second = KSeam.replayOrderedControls({ ...controlRead, cursor: opaqueCursor }, controlPage2, first);
  expect(second.events.map(e => e.eventId)).toEqual(['resize-2-golden']);
  expect(second.geometry).toEqual({ columns: 100, rows: 30 });
  expect(second.last?.digest).toBe(controlDigests[2]!);
  const empty = KSeam.replayOrderedControls(controlRead, { ...controlPage2, entries: [], payloadBytes: 2 }, controlSeed);
  expect(empty.events).toEqual([]); expect(empty.geometry).toEqual(geometry); expect(empty.last).toBeNull();
});
test('K-fix2 R12 control reader refuses pre-checkpoint, reordered, forged, foreign and unbounded pages', () => {
  const page = (entries: readonly F.OrderedControlEntryR2[], over: Partial<F.OrderedControlPageR2> = {}): F.OrderedControlPageR2 =>
    ({ ...controlPage1, entries, payloadBytes: Buffer.byteLength(KSeam.streamCanonical(entries)), ...over });
  const run = (p: F.OrderedControlPageR2, r: F.OrderedControlReadR2 = controlRead, c: F.OrderedControlReplayR2 = controlSeed) => () => KSeam.replayOrderedControls(r, p, c);
  const [e0, e1, e2] = controlEntries as [F.OrderedControlEntryR2, F.OrderedControlEntryR2, F.OrderedControlEntryR2];
  const reseal = (e: F.OrderedControlEntryR2, body: Omit<F.OrderedControlR2, 'digest'>): F.OrderedControlEntryR2 => ({ commitId: e.commitId, event: { ...body, digest: KSeam.orderedControlDigest(body) } });
  const { digest: _d, ...b0 } = e0.event;
  expect(run(page([reseal(e0, { ...b0, order: 0 })]))).toThrow('control entry not after watermark/previous');
  expect(run(page([reseal(e0, { ...b0, position: { epoch, byteOffset: 7 }, order: 9 })]))).toThrow('control entry not after watermark/previous');
  expect(run(page([e1, e0]))).toThrow('control entry not after watermark/previous');
  expect(run(page([e0, { ...e1, commitId: e0.commitId }]))).toThrow('control entry identity/digest');
  expect(run(page([{ ...e0, event: { ...e0.event, order: 5 } }]))).toThrow('control entry identity/digest');
  expect(run(page([reseal(e0, { ...b0, decoderVersion: 'decoder-other' })]))).toThrow('control entry decoder version');
  expect(run(page([reseal(e0, { ...b0, position: { epoch: { ...epoch, attachId: 'attach-other' }, byteOffset: 9 } })]))).toThrow('control entry epoch');
  expect(run(page([e2]))).toThrow('control geometry chain');
  expect(KSeam.replayOrderedControls(controlRead, page([e0, e2]), controlSeed).geometry).toEqual({ columns: 100, rows: 30 });
  expect(run(page([e0, e1]), controlRead, { last: null, geometry: { columns: 80, rows: 24 } })).toThrow('control geometry chain');
  expect(run(page([e0, e1, e2]))).toThrow('control page bound');
  expect(run(page([e0], { payloadBytes: 1 }))).toThrow('control page bound');
  expect(run(page([e0]), { ...controlRead, maxEntries: 257 })).toThrow('control read bound');
  expect(run(page([e0]), { ...controlRead, maxBytes: 1048577 })).toThrow('control read bound');
  expect(run(page([e0], { next: null }))).toThrow('control page continuation');
  expect(run(page([], { atDurableHead: false }))).toThrow('control page continuation');
  expect(run(page([e0], { checkpointId: 'checkpoint-other' }))).toThrow('control read identity');
  expect(run(page([e0], { pane: { ...pane, birthGeneration: 2 } }))).toThrow('control read identity');
  expect(run(page([e0]), { ...controlRead, cursor: opaqueCursor })).toThrow('control read cursor/carried mismatch');
  expect(run(page([e2], { next: null, atDurableHead: true }), controlRead, { last: e1.event, geometry: { columns: 80, rows: 20 } })).toThrow('control read cursor/carried mismatch');
});
export function compileControlReader(h: F.FlagOnHistoryR2) {
  const result = h.authority.controls(controlRead);
  if (result.status === 'ok') return KSeam.replayOrderedControls(controlRead, result.value, controlSeed);
  return null;
}
function negativeControlReader(a: F.HistoryAuthorityR2) {
  // @ts-expect-error K-r2 authority without the R12 control reader is not HistoryAuthorityR2.
  const missing: F.HistoryAuthorityR2 = { ...a, controls: undefined };
  return missing;
}

// Q22 golden fixtures: independent of legacy handoff/repair fixtures above.
// Hand-authored IDs/text/policies. These test CONTRACT guards, not H durability,
// OS locking, tmux ACL, decoder conformance or product PSS (other lots own those).
import * as V2 from '../../src/stream-contract';
import * as V2Wire from '../../../core/src/protocol';
const v2Config = V2.NEWARCH_V2_DEFAULT_CONFIG;
const v2Geometry: V2Wire.NewarchV2FixedGeometry = {
  policy: 'fixed-at-birth', columns: 100, rows: 40, configVersion: 'q22-default-1', panesPerWindow: 1,
};
const v2Session = { serverIdentity: 'fixture-server', sessionId: 'session-uuid-1' };
const v2Descriptor: V2Wire.NewarchV2PaneDescriptor = {
  schema: 'newarch-v2', session: v2Session, pane, windowId: '@1', owner: 'capture-engine',
  birthOperationId: 'birth-1', geometry: v2Geometry, state: 'active',
};
const v2Rule: V2.V2RuleStamp = { ruleId: 'ordered-scroll', version: '1', configVersion: 'q22-default-1' };
const v2Incident: V2Wire.NewarchV2Incident = {
  schema: 'newarch-v2', incidentId: 'incident-before-byte0', pane, reason: 'storage-outage',
  frontier: null, affected: { after: null, through: null }, openedAtWallMs: 1700000000000,
  openedAtMonoMs: 100, clockEpoch: 'clock-fixture', collecting: false,
  missing: { countKind: 'unknown', missingCount: null }, ruleVersion: '1', configVersion: 'q22-default-1',
  geometry: v2Geometry, revision: 0, sourceEpoch: null, sourceOffset: null, expectedDigest: null, actualDigest: null,
  action: 'gap-and-stop', evidence: null,
};
const v2State: V2.VtState = {
  ...state, geometry: { columns: 100, rows: 40 }, margins: { top: 0, bottom: 40, left: 0, right: 100 },
};
const v2Checkpoint: V2.V2LiveCheckpoint = {
  schema: 'newarch-v2', checkpointId: 'live-1', pane, geometry: v2Geometry,
  through: position, replayFloor: { epoch, byteOffset: 4 }, revision: 2, frontier: segmentRowId,
  rule: v2Rule, state: v2State, stateDigest: V2.v2Digest('vt-state', v2State),
  pending: { rows: [], bytes: 0, deadlineMonoMs: null },
};
const v2Receipt: V2.V2Receipt = {
  schema: 'newarch-v2', kind: 'ssot-durable', operationId: 'write-1', pane, digest,
  commitId: 'commit-v2-1', generation: 1, revision: 2, frontier: segmentRowId, checkpointId: 'live-1',
};
const v2Fence: V2.V2WriteFence = { operationId: 'write-1', pane, expectedGeneration: 1, expectedRevision: 1, digest };
const v2Watermark: V2.V2AuditWatermark = { pane, through: position, revision: 2, geometry: v2Geometry, checkpointId: 'live-1' };
const v2Audit: V2.V2AuditEvidence = {
  before: v2Watermark, after: v2Watermark, snapshot: v2Watermark, ordering: { kind: 'certified-source-fence', certificateId: 'synthetic-audit-proof', proof: file },
  expectedDigest: digest, actualDigest: digest, captureBytes: 4000, elapsedMs: 20,
};
const v2Cursor: V2Wire.NewarchV2HistoryCursor = {
  schema: 'newarch-v2', pane, storeId: 'store-v2', timelineRevision: 2, token: 'fixture:opaque:position-1',
};
const v2Request: V2Wire.NewarchV2HistoryRequest = {
  schema: 'newarch-v2', pane, cursor: v2Cursor, direction: 'after', maxEntries: 256, maxBytes: 2097152,
};
const v2Trim: V2.V2TrimAuthorization = {
  schema: 'newarch-v2', checkpoint: v2Checkpoint, receipt: v2Receipt, consumerAck: spoolAck,
  trimThrough: { epoch, byteOffset: 4 },
};
export const NEWARCH_V2_GOLDEN = {
  config: v2Config, descriptor: v2Descriptor, incidentBeforeFirstRow: v2Incident,
  checkpoint: v2Checkpoint, receipt: v2Receipt, audit: v2Audit, cursor: v2Cursor, trim: v2Trim,
  text: ['ซ้ำ', 'ซ้ำ', 'ก้ 👩‍💻', 'A\rB', '\u001b[100GX'],
} as const;

test('K-v2 geometry defaults frozen at birth, configuration rejects unsafe bounds', () => {
  // kem 2026-10-04: new sessions are 78 columns x 120 rows (config q22-default-2).
  // v2Geometry above stays the 100x40 fixture the other K cases are built on.
  expect(V2.v2BirthGeometry(v2Config)).toEqual({ policy: 'fixed-at-birth', columns: 78, rows: 120,
    configVersion: 'q22-default-2', panesPerWindow: 1 });
  expect(V2.NEWARCH_V2_LIMITS.maxRows).toBe(120);
  expect(() => V2.validateV2Config({ ...v2Config, geometry: { columns: 78, rows: 120 } })).not.toThrow();
  for (const n of [0, 121, 1.5]) {
    expect(() => V2.validateV2Config({ ...v2Config, geometry: { columns: 78, rows: n } })).toThrow();
  }
  const changed = { ...v2Config, configVersion: 'next', geometry: { columns: 120, rows: 50 } };
  const born = V2.v2BirthGeometry(changed);
  changed.geometry.columns = 80;
  expect(born.columns).toBe(120); expect(v2Geometry.columns).toBe(100);
  expect(Object.isFrozen(born)).toBe(true);
  for (const n of [0, -1, 241, 1.5, NaN, Infinity]) {
    expect(() => V2.validateV2Config({ ...v2Config, geometry: { columns: n, rows: 40 } })).toThrow();
  }
  for (const patch of [{ intervalMs: 1 }, { minGapMs: 0 }, { maxConcurrent: 2 }, { maxRetries: 2 },
    { timeoutMs: 10001 }, { maxCaptureBytes: 262145 }, { jitterFraction: 0.21 }, { jitterFraction: NaN }]) {
    expect(() => V2.validateV2Config({ ...v2Config, audit: { ...v2Config.audit, ...patch } })).toThrow();
  }
  expect(() => V2.validateV2Config({ ...v2Config, audit: { ...v2Config.audit, enabled: false, intervalMs: 0, triggers: [] } })).not.toThrow();
});
test('K-v2 stable identities do not merge names, windows, reused pane ids or servers', () => {
  expect(V2.v2PaneKey(pane)).toBe('["fixture-server","%1",1]');
  const keys = [pane, { ...pane, paneId: '%2' }, { ...pane, birthGeneration: 2 }, { ...pane, serverIdentity: 'restarted' }].map(V2.v2PaneKey);
  expect(new Set(keys).size).toBe(4);
  expect(V2.v2SessionKey(v2Session)).not.toBe(V2.v2SessionKey({ ...v2Session, sessionId: 'reused-display-name-new-uuid' }));
  for (const state of ['reserved', 'active', 'stopped', 'closed', 'unrecorded'] as const) {
    expect(V2.v2LegacyAppendAllowed({ kind: 'capture-engine', pane: { ...v2Descriptor, state } }, v2Session)).toBe(false);
  }
  expect(V2.v2LegacyAppendAllowed({ kind: 'unknown', reason: 'corrupt' }, v2Session)).toBe(false);
  expect(V2.v2LegacyAppendAllowed({ kind: 'legacy', session: v2Session }, v2Session)).toBe(true);
  expect(V2.v2LegacyAppendAllowed({ kind: 'legacy', session: v2Session }, { ...v2Session, sessionId: 'new' })).toBe(false);
  expect(() => V2.v2PaneKey({ ...pane, birthGeneration: 0 })).toThrow();
});
test('K-v2 geometry guard compares pane AND window topology, independent of audit', () => {
  const observed: V2.V2GeometryObservation = { pane, windowId: '@1', window: { columns: 100, rows: 40 }, terminal: { columns: 100, rows: 40 }, panesInWindow: 1 };
  expect(V2.v2GeometryMatches(v2Descriptor, observed)).toBe(true);
  for (const patch of [{ windowId: '@2' }, { panesInWindow: 2 }, { terminal: { columns: 50, rows: 40 } },
    { window: { columns: 120, rows: 40 } }, { pane: { ...pane, birthGeneration: 2 } }]) {
    expect(V2.v2GeometryMatches(v2Descriptor, { ...observed, ...patch })).toBe(false);
  }
});
test('K-v2 generation/revision and lost ACK: original operation receipt, never duplicate', () => {
  expect(V2.v2WriteDisposition(v2Fence, 1, 1, null)).toBe('commit');
  expect(V2.v2WriteDisposition(v2Fence, 1, 2, v2Receipt)).toBe('retry');
  expect(V2.v2WriteDisposition(v2Fence, 2, 2, v2Receipt)).toBe('stale');
  expect(V2.v2WriteDisposition(v2Fence, 1, 2, null)).toBe('stale');
  expect(V2.v2WriteDisposition(v2Fence, 1, 2, { ...v2Receipt, digest: '1'.repeat(64) })).toBe('integrity');
  expect(V2.v2WriteDisposition(v2Fence, 1, 2, { ...v2Receipt, pane: { ...pane, paneId: '%2' } })).toBe('integrity');
});
test('K-v2 incident before first ACK persists as independent command shape', () => {
  expect(() => V2.validateV2Incident(v2Incident)).not.toThrow();
  const command: V2.V2WriteCommand = { kind: 'incident', incident: v2Incident };
  expect('inputAck' in command).toBe(false);
  expect(v2Incident.frontier).toBeNull(); expect(v2Incident.missing.missingCount).toBeNull();
  expect(() => V2.validateV2Incident({ ...v2Incident, collecting: true })).toThrow();
  expect(() => V2.validateV2Incident({ ...v2Incident, frontier: { ...segmentRowId, pane: { ...pane, paneId: '%2' } } })).toThrow();
  expect(() => V2.validateV2Incident({ ...v2Incident, evidence: { digest, bytes: 65537, redacted: true } })).toThrow();
  expect(V2.v2Digest('incident', v2Incident)).toBe(V2.v2Digest('incident', JSON.parse(JSON.stringify(v2Incident))));
});
test('K-v2 live checkpoint keeps partial decoder state and rejects geometry/digest/floor drift', () => {
  expect(() => V2.validateV2Checkpoint(v2Checkpoint)).not.toThrow();
  expect(v2Checkpoint.state.pendingUtf8).toEqual([224]);
  expect(v2Checkpoint.state.pendingEscape).toEqual([27, 91]);
  for (const patch of [{ stateDigest: '1'.repeat(64) }, { geometry: { ...v2Geometry, columns: 120 } },
    { replayFloor: { epoch, byteOffset: 9 } }, { pending: { rows: [row], bytes: 1, deadlineMonoMs: null } }]) {
    expect(() => V2.validateV2Checkpoint({ ...v2Checkpoint, ...patch })).toThrow();
  }
});
test('K-v2 audit: matching evidence only, stale/racing/disabled cannot repair', () => {
  expect(V2.v2AuditComparable(v2Audit, v2Watermark, v2Config.audit)).toBe(true);
  expect(V2.v2AuditComparable(v2Audit, { ...v2Watermark, revision: 3 }, v2Config.audit)).toBe(false);
  expect(V2.v2AuditComparable(v2Audit, v2Watermark, { ...v2Config.audit, enabled: false })).toBe(false);
  for (const patch of [{ ordering: { kind: 'unproven' as const } }, { after: { ...v2Watermark, revision: 3 } },
    { snapshot: { ...v2Watermark, pane: { ...pane, paneId: '%2' } } }, { elapsedMs: 2001 },
    { captureBytes: 262145 }, { captureBytes: -1 }, { elapsedMs: NaN }]) {
    expect(V2.v2AuditComparable({ ...v2Audit, ...patch }, v2Watermark, v2Config.audit)).toBe(false);
  }
});
test('K-v2 trim never passes decoder floor or mismatched receipt/epoch', () => {
  expect(V2.v2TrimWithinCheckpoint(v2Trim)).toBe(true);
  expect(V2.v2TrimWithinCheckpoint({ ...v2Trim, trimThrough: { epoch, byteOffset: 5 } })).toBe(false);
  expect(V2.v2TrimWithinCheckpoint({ ...v2Trim, receipt: { ...v2Receipt, checkpointId: null } })).toBe(false);
  expect(V2.v2TrimWithinCheckpoint({ ...v2Trim, receipt: { ...v2Receipt, revision: 1 } })).toBe(false);
  expect(V2.v2TrimWithinCheckpoint({ ...v2Trim, trimThrough: { epoch: { ...epoch, collectorIncarnation: 'other' }, byteOffset: 4 } })).toBe(false);
  expect(V2.v2TrimWithinCheckpoint({ ...v2Trim, consumerAck: { ...spoolAck, through: { epoch, byteOffset: 7 } } })).toBe(false);
});
test('K-v2 one storage ledger separates reserve without subtracting staging twice', () => {
  const usage: V2.V2StorageUsage = { databaseBytes: 8 * 1048576, rawBytes: 4 * 1048576,
    stagingBytes: 2 * 1048576, diagnosticBytes: 1048576, reservedDataBytes: 1048576, reserveAllocatedBytes: 16 * 1048576 };
  expect(V2.v2StorageAllowance(v2Config, usage)).toEqual({ dataBudgetBytes: 240 * 1048576, dataUsedBytes: 16 * 1048576, availableDataBytes: 224 * 1048576 });
  expect(V2.v2StorageAllowance(v2Config, { ...usage, rawBytes: 256 * 1048576 }).availableDataBytes).toBe(0);
  expect(() => V2.validateV2Config({ ...v2Config, storage: { ...v2Config.storage, rootCapBytes: 49152 } })).toThrow();
  expect(() => V2.validateV2Config({ ...v2Config, storage: { ...v2Config.storage, emergencyReserveBytes: 8 * 1048576 } })).toThrow();
});
test('K-v2 cursor scope survives storage location changes, remote failure is not EOF', () => {
  expect(() => V2.validateV2ReadRequest(v2Request)).not.toThrow();
  expect(JSON.parse(JSON.stringify(v2Cursor))).toEqual(v2Cursor);
  expect(() => V2.validateV2ReadRequest({ ...v2Request, pane: { ...pane, paneId: '%2' } })).toThrow();
  expect(() => V2.validateV2ReadRequest({ ...v2Request, maxEntries: 257 })).toThrow();
  expect(() => V2.validateV2ReadRequest({ ...v2Request, cursor: { ...v2Cursor, token: 'x'.repeat(4097) } })).toThrow();
  const blocked: V2Wire.NewarchV2Continuation = { kind: 'blocked', cursor: v2Cursor,
    state: { kind: 'remote-unavailable', bundleId: 'b1', reason: 'corrupt', retryAfterMs: 1000 } };
  expect(blocked.kind).not.toBe('end'); expect(blocked.cursor).toEqual(v2Cursor);
});
test('K-v2 protocol negotiation cannot confuse repair-r2 or omit fixed ownership', () => {
  const caps: V2Wire.NewarchV2Capabilities = { schema: 'newarch-v2', supported: V2Wire.NEWARCH_V2_CAPABILITIES, required: V2Wire.NEWARCH_V2_CAPABILITIES };
  expect(V2Wire.supportsNewarchV2(caps, caps)).toBe(true);
  expect(V2Wire.supportsNewarchV2(caps, { ...caps, required: [] })).toBe(false);
  expect(V2Wire.supportsNewarchV2(caps, { ...caps, supported: ['same-pipe-return-r2'] })).toBe(false);
  expect(V2Wire.supportsNewarchV2(caps, { ...caps, required: [...caps.required, 'unknown'] })).toBe(false);
});
test('K-v2 Q budget retains 180min gate and pins 60min engineering thresholds', () => {
  const b = V2.NEWARCH_V2_LIMITS;
  expect([b.processTreePssHardBytes, b.plateauMinMs, b.pssWindowMs, b.pssWarmupMs]).toEqual([1610612736, 10800000, 3600000, 600000]);
  expect([b.pssSlopeMiBPerHour, b.pssMeanDeltaMiB, b.pssSampleMs]).toEqual([10, 10, 1000]);
  expect(b.rowRates).toEqual([0.5, 2]); expect(b.maxActivePanes).toBe(21);
});
// Compile consumers without implementing a fake database or faking durability.
export async function compileV2Ports(c: V2.V2CaptureWriteFacade, h: V2.V2HistoryWriter,
  reader: V2.V2HistoryReader, capability: V2.V2WriterCapability, s: V2.V2SourceTransport) {
  const request: V2.V2WriteRequest = { fence: v2Fence, command: { kind: 'incident', incident: v2Incident } };
  await c.submit(request); await h.commit(capability, request); await reader.page(v2Request);
  await s.acknowledgeAndTrim(v2Trim); await c.close();
}
function negativeV2Types(h: V2.V2HistoryWriter, c: V2.V2CaptureWriteFacade) {
  // @ts-expect-error A shape copied from JSON cannot mint a writer capability.
  const forged: V2.V2WriterCapability = { owner: 'capture-engine', rootId: 'r', engineId: 'e', generation: 1 };
  // @ts-expect-error No handoff/lease or return-to-legacy command in v2.
  const handback: V2.V2WriteCommand = { kind: 'toLegacy' };
  // @ts-expect-error A spool ACK cannot authorize SSOT writes or trim.
  const ssot: V2.V2Receipt = spoolAck;
  // @ts-expect-error Runtime port is not available to the reader/auditor facade.
  c.commit(forged, { fence: v2Fence, command: { kind: 'close' } });
  // @ts-expect-error H mutations always require a capability, not just request.
  h.commit({ fence: v2Fence, command: { kind: 'close' } });
  return [forged, handback, ssot];
}

const v2Evidence: V2.V2RuleEvidence = { raw: rawRange, digest, checkpointId: 'live-1', caseId: 'K-v2-repeat', anomalyId: null };
/** Repeated text is two real rows with two origins, not a dedup hint. */
export const NEWARCH_V2_RULE_GOLDEN: readonly V2.V2RuleResult[] = [
  { kind: 'accept', stamp: v2Rule, evidence: v2Evidence,
    rows: [{ ...streamRow, geometry: v2Geometry }, { ...repeatedRow, geometry: v2Geometry }], checkpoint: v2Checkpoint },
  { kind: 'defer', stamp: v2Rule, evidence: v2Evidence, pendingRows: 1, pendingBytes: 3, deadlineMonoMs: 1100 },
  { kind: 'gap', stamp: v2Rule, evidence: v2Evidence, incident: v2Incident },
];
export const NEWARCH_V2_AUDIT_GOLDEN: readonly V2.V2AuditResult[] = [
  { kind: 'match', evidence: v2Audit, rule: v2Rule },
  { kind: 'repair-pending', evidence: v2Audit, rule: v2Rule, expectedRevision: 2,
    checkpoint: { ...v2Checkpoint, revision: 3 }, incident: { ...v2Incident, reason: 'audit-mismatch', action: 'repair-pending', collecting: true } },
  { kind: 'annotate', evidence: v2Audit, rule: v2Rule,
    incident: { ...v2Incident, reason: 'audit-mismatch', action: 'annotate', collecting: true } },
  { kind: 'inconclusive', reason: 'racing', retry: true },
  { kind: 'inconclusive', reason: 'disabled', retry: false },
];
test('K-v2 golden codec domain and action variants are independent of legacy hashes', () => {
  // Expected bytes/hash calculated independently using Python json+hashlib.
  expect(V2.v2Digest('geometry', { columns: 100, rows: 40 })).toBe('df7a6cbd881e9eab0dd0546fc983005c0ad9793df0fc40bd0b085236e466a7de');
  expect(V2.v2Digest('geometry', { rows: 40, columns: 100 })).toBe('df7a6cbd881e9eab0dd0546fc983005c0ad9793df0fc40bd0b085236e466a7de');
  expect(NEWARCH_V2_RULE_GOLDEN.map(r => r.kind)).toEqual(['accept', 'defer', 'gap']);
  expect(NEWARCH_V2_AUDIT_GOLDEN.map(r => r.kind)).toEqual(['match', 'repair-pending', 'annotate', 'inconclusive', 'inconclusive']);
  const accepted = NEWARCH_V2_RULE_GOLDEN[0]!;
  if (accepted.kind !== 'accept') throw Error('golden accept');
  expect(accepted.rows.map(r => r.id.rowOrdinal)).toEqual([0, 1]);
  expect(accepted.rows.map(r => r.cells[0]!.text)).toEqual(['A', 'A']);
});

test('K-v2 stable incident identity excludes clocks and rejects cross-epoch offsets', () => {
  expect(V2.v2IncidentId(pane, 'stop-1')).toBe(V2.v2IncidentId({ ...pane }, 'stop-1'));
  expect(V2.v2IncidentId(pane, 'stop-1')).not.toBe(V2.v2IncidentId({ ...pane, birthGeneration: 2 }, 'stop-1'));
  expect(() => V2.validateV2Incident({ ...v2Incident, sourceOffset: 1 })).toThrow('v2 incident source');
  expect(() => V2.validateV2Incident({ ...v2Incident, sourceOffset: 1, sourceEpoch: { attachId: epoch.attachId, collectorIncarnation: epoch.collectorIncarnation } })).not.toThrow();
});
test('K-v2 audit requires bounded certificate, not just equal claimed watermarks', () => {
  for (const proof of [{ ...file, bytes: 0 }, { ...file, bytes: 65537 }, { ...file, sha256: 'bad' }]) {
    expect(V2.v2AuditComparable({ ...v2Audit, ordering: { kind: 'certified-source-fence', certificateId: 'proof', proof } }, v2Watermark, v2Config.audit)).toBe(false);
  }
});

test('K-v2 restart retry changes concurrency fence without changing semantic digest', () => {
  const body = { fence: v2Fence, command: { kind: 'incident' as const, incident: v2Incident } };
  const hashed = V2.v2WriteDigest(body);
  expect(V2.v2WriteDigest({ ...body, fence: { ...v2Fence, expectedGeneration: 2, expectedRevision: 2 } })).toBe(hashed);
  expect(V2.v2WriteDisposition({ ...v2Fence, expectedGeneration: 2, digest: hashed }, 2, 2, { ...v2Receipt, digest: hashed })).toBe('retry');
  expect(V2.v2WriteDigest({ ...body, command: { kind: 'incident', incident: { ...v2Incident, incidentId: 'different' } } })).not.toBe(hashed);
});

test('K-v2 rule allowlist and finite defer deadline cannot accumulate unlimited tail', () => {
  expect(v2Config.rules).toEqual([{ ruleId: 'ordered-scroll', version: '1' }, { ruleId: 'bounded-tail', version: '1' }, { ruleId: 'explicit-gap', version: '1' }]);
  expect(() => V2.validateV2Config({ ...v2Config, rules: [] })).toThrow();
  expect(() => V2.validateV2Config({ ...v2Config, rules: [v2Config.rules[0]!, v2Config.rules[0]!] })).toThrow();
  const deferred = NEWARCH_V2_RULE_GOLDEN[1]!;
  if (deferred.kind !== 'defer') throw Error('golden defer');
  expect(V2.v2DeferWithinBudget(deferred, 100, 1000)).toBe(true);
  expect(V2.v2DeferWithinBudget(deferred, 100, 1100)).toBe(false);
  expect(V2.v2DeferWithinBudget({ ...deferred, deadlineMonoMs: 1101 }, 100, 1000)).toBe(false);
  expect(V2.v2DeferWithinBudget({ ...deferred, pendingBytes: 1048577 }, 100, 1000)).toBe(false);
  expect(V2.v2DeferWithinBudget({ ...deferred, pendingRows: 257 }, 100, 1000)).toBe(false);
});

// An inconclusive audit can persist bounded status through the SAME writer.
export const V2_INCONCLUSIVE_COMMAND: V2.V2WriteCommand = {
  kind: 'audit', result: { kind: 'inconclusive', reason: 'timeout', retry: true },
};

// Q22 flag-on seams (K, 2026-10-05). Each red case below is a deliberate
// violation of a frozen guard (negative control), not an import failure.
const kWriterGen = V2.v2WriterGeneration(1);
const kContinuityGen = V2.v2ContinuityGeneration(7);
const kRow = (ordinal: number): V2.CommittedStreamRow => ({ ...streamRow, id: { ...segmentRowId, rowOrdinal: ordinal },
  origin: { ...pipeOrigin, ordinal }, cellOrigins: [{ ...pipeOrigin, ordinal }] });
const kRows = [kRow(1), kRow(2)];
const kPrefixCheckpoint: V2.V2LiveCheckpoint = { ...v2Checkpoint, checkpointId: 'live-2',
  through: { epoch, byteOffset: 14 }, revision: 3, frontier: kRows[1]!.id };
const kPrefix: V2.V2DecodePrefix = { schema: 'newarch-v2', pane, offered: { epoch, start: 8, end: 20 },
  consumed: { epoch, start: 8, end: 14 }, rows: kRows, serializedBytes: V2.v2RowsSerializedBytes(kRows),
  checkpoint: kPrefixCheckpoint, stop: 'rows', suffix: { epoch, start: 14, end: 20 } };
const kSourceUnsigned: Omit<V2.V2SourcePrefixReceipt, 'digest'> = { schema: 'newarch-v2', kind: 'source-prefix',
  receiptId: 'source-prefix-1', sourceEpoch: V2.v2SourceEpochOf(epoch), certified: { epoch, start: 8, end: 14 },
  firstSequence: 1, lastSequence: 1, lastRecordDigest: digest, lastRecordEnd: 20 };
const kSource: V2.V2SourcePrefixReceipt = { ...kSourceUnsigned, digest: V2.v2SourcePrefixReceiptDigest(kSourceUnsigned) };
const kPrefixReceipt: V2.V2Receipt = { ...v2Receipt, operationId: 'prefix-1', commitId: 'commit-v2-2', revision: 3,
  frontier: kRows[1]!.id, checkpointId: 'live-2' };
const kAck: V2.V2PrefixAck = { schema: 'newarch-v2', kind: 'prefix-ack', pane, through: kPrefixCheckpoint.through,
  recordComplete: false, source: kSource, receipt: kPrefixReceipt, writerGeneration: kWriterGen,
  continuityGeneration: kContinuityGen, sourceEpoch: V2.v2SourceEpochOf(epoch) };
const kExpected = { writerGeneration: kWriterGen, continuityGeneration: kContinuityGen };
const kSignSource = (patch: Partial<Omit<V2.V2SourcePrefixReceipt, 'digest'>>): V2.V2SourcePrefixReceipt => {
  const unsigned = { ...kSourceUnsigned, ...patch };
  return { ...unsigned, digest: V2.v2SourcePrefixReceiptDigest(unsigned) };
};

test('K-flagon prefix: bounded prefix with uncertified suffix; chained prefixes cover a burst', () => {
  expect(V2.NEWARCH_V2_PREFIX_LIMITS).toEqual({ maxRawBytes: 1048576, maxRows: 256, maxSerializedBytes: 2097152, checkpointBytes: 4194304 });
  expect(V2.v2DecodePrefixValid(kPrefix, v2Checkpoint)).toBe(true);
  const tailRows = [kRow(3)];
  const tail: V2.V2DecodePrefix = { ...kPrefix, offered: { epoch, start: 14, end: 20 }, consumed: { epoch, start: 14, end: 20 },
    rows: tailRows, serializedBytes: V2.v2RowsSerializedBytes(tailRows), stop: 'complete', suffix: null,
    checkpoint: { ...kPrefixCheckpoint, checkpointId: 'live-3', through: { epoch, byteOffset: 20 }, revision: 4, frontier: tailRows[0]!.id } };
  expect(V2.v2DecodePrefixValid(tail, kPrefixCheckpoint)).toBe(true);
  const tooMany = Array.from({ length: 257 }, (_, i) => kRow(i + 1));
  for (const bad of [
    // Zero progress on non-empty input (suffix consistent, so only the progress rule rejects it).
    { ...kPrefix, consumed: { epoch, start: 8, end: 8 }, suffix: { epoch, start: 8, end: 20 }, checkpoint: { ...kPrefixCheckpoint, through: { epoch, byteOffset: 8 } } },
    { ...kPrefix, suffix: null },
    { ...kPrefix, stop: 'complete' as const },
    { ...kPrefix, suffix: { epoch, start: 15, end: 20 } },
    { ...kPrefix, serializedBytes: kPrefix.serializedBytes - 1 },
    { ...kPrefix, rows: tooMany, serializedBytes: V2.v2RowsSerializedBytes(tooMany), checkpoint: { ...kPrefixCheckpoint, frontier: tooMany[256]!.id } },
    { ...kPrefix, offered: { epoch, start: 8, end: 8 + 1048577 }, consumed: { epoch, start: 8, end: 8 + 1048577 }, suffix: null, stop: 'complete' as const,
      checkpoint: { ...kPrefixCheckpoint, through: { epoch, byteOffset: 8 + 1048577 } } },
    { ...kPrefix, checkpoint: { ...kPrefixCheckpoint, through: { epoch, byteOffset: 20 } } },
    { ...kPrefix, checkpoint: { ...kPrefixCheckpoint, revision: 2 } },
    { ...kPrefix, checkpoint: { ...kPrefixCheckpoint, frontier: kRows[0]!.id } },
    { ...kPrefix, offered: { epoch, start: 9, end: 20 }, consumed: { epoch, start: 9, end: 14 } },
    { ...kPrefix, consumed: { epoch: { ...epoch, collectorIncarnation: 'other' }, start: 8, end: 14 } },
    { ...kPrefix, rows: [kRows[0]!, { ...kRows[1]!, id: { ...kRows[1]!.id, pane: { ...pane, paneId: '%2' } } }] },
    // Rows repeated or swapped inside one segment (review K-r1 m1).
    { ...kPrefix, rows: [kRows[1]!, kRows[1]!], serializedBytes: V2.v2RowsSerializedBytes([kRows[1]!, kRows[1]!]) },
    { ...kPrefix, rows: [kRows[1]!, kRows[0]!], serializedBytes: V2.v2RowsSerializedBytes([kRows[1]!, kRows[0]!]),
      checkpoint: { ...kPrefixCheckpoint, frontier: kRows[0]!.id } },
    { ...kPrefix, rows: [kRow(0), kRows[1]!], serializedBytes: V2.v2RowsSerializedBytes([kRow(0), kRows[1]!]) },
  ]) expect(V2.v2DecodePrefixValid(bad, v2Checkpoint)).toBe(false);
});
test('K-flagon ACK never passes the committed checkpoint and never claims a record end it did not commit', () => {
  expect(V2.v2PrefixAckValid(kAck, kPrefixCheckpoint, kExpected)).toBe(true);
  const recordEnd = kSignSource({ certified: { epoch, start: 8, end: 20 } });
  // RED: ACK beyond checkpoint (claims the whole record [8,20) though only [8,14) committed).
  expect(V2.v2PrefixAckValid({ ...kAck, through: { epoch, byteOffset: 20 }, recordComplete: true, source: recordEnd }, kPrefixCheckpoint, kExpected)).toBe(false);
  expect(V2.v2PrefixAckValid({ ...kAck, through: { epoch, byteOffset: 15 } }, kPrefixCheckpoint, kExpected)).toBe(false);
  expect(V2.v2PrefixAckValid({ ...kAck, through: { epoch, byteOffset: 12 } }, kPrefixCheckpoint, kExpected)).toBe(false);
  expect(V2.v2PrefixAckValid({ ...kAck, recordComplete: true }, kPrefixCheckpoint, kExpected)).toBe(false);
  // A prefix that ends exactly on the record end may say so.
  const whole = kSignSource({ lastRecordEnd: 14 });
  expect(V2.v2PrefixAckValid({ ...kAck, source: whole, recordComplete: true }, kPrefixCheckpoint, kExpected)).toBe(true);
  expect(V2.v2PrefixAckValid({ ...kAck, source: whole, recordComplete: false }, kPrefixCheckpoint, kExpected)).toBe(false);
  // Host cannot mint/alter a collector receipt.
  expect(V2.v2PrefixAckValid({ ...kAck, source: { ...kSource, certified: { epoch, start: 8, end: 20 } } }, kPrefixCheckpoint, kExpected)).toBe(false);
  expect(V2.v2PrefixAckValid({ ...kAck, source: kSignSource({ sourceEpoch: { ...V2.v2SourceEpochOf(epoch), collectorIncarnation: 'old' } }) }, kPrefixCheckpoint, kExpected)).toBe(false);
  expect(V2.v2PrefixAckValid({ ...kAck, receipt: { ...kPrefixReceipt, checkpointId: 'live-1' } }, kPrefixCheckpoint, kExpected)).toBe(false);
});
test('K-flagon ACK certifies exactly the committed range, never a longer one', () => {
  // RED (review B2): a receipt certifying [8,20) while only [8,14) committed.
  const longer = kSignSource({ certified: { epoch, start: 8, end: 20 } });
  expect(V2.v2PrefixAckValid({ ...kAck, source: longer }, kPrefixCheckpoint, kExpected)).toBe(false);
  expect(V2.v2PrefixAckValid({ ...kAck, source: kSignSource({ certified: { epoch, start: 8, end: 15 } }) }, kPrefixCheckpoint, kExpected)).toBe(false);
});
test('K-flagon ACK binds the whole receipt certifyPrefix issued; a re-signed receipt is refused', () => {
  expect(V2.v2PrefixAckMatchesIssued(kAck, kSource, kPrefixCheckpoint, kExpected)).toBe(true);
  // RED (review B2): the host re-signs the collector receipt so lastRecordEnd
  // claims the commit ended the record. Structurally valid, not what S issued.
  const forged = kSignSource({ lastRecordEnd: 14 });
  const lie: V2.V2PrefixAck = { ...kAck, source: forged, recordComplete: true };
  expect(V2.v2PrefixAckValid(lie, kPrefixCheckpoint, kExpected)).toBe(true);
  expect(V2.v2PrefixAckMatchesIssued(lie, kSource, kPrefixCheckpoint, kExpected)).toBe(false);
  for (const patch of [{ lastSequence: 2 }, { lastRecordDigest: 'b'.repeat(64) }, { receiptId: 'source-prefix-2' }, { firstSequence: 0 }]) {
    expect(V2.v2PrefixAckMatchesIssued({ ...kAck, source: kSignSource(patch) }, kSource, kPrefixCheckpoint, kExpected)).toBe(false);
  }
  // The issued receipt itself must carry a valid collector digest.
  expect(V2.v2PrefixAckMatchesIssued({ ...kAck, source: { ...kSource, lastRecordEnd: 14 } }, { ...kSource, lastRecordEnd: 14 }, kPrefixCheckpoint, kExpected)).toBe(false);
  // Matching the issued receipt never bypasses the structural guard.
  expect(V2.v2PrefixAckMatchesIssued({ ...kAck, through: { epoch, byteOffset: 20 }, recordComplete: true }, kSource, kPrefixCheckpoint, kExpected)).toBe(false);
});
test('K-flagon writer generation, source epoch and continuity generation are not interchangeable', () => {
  // Same shape, roles swapped: the writer generation used where continuity is expected.
  const swapped = { ...kAck, writerGeneration: V2.v2WriterGeneration(7), continuityGeneration: V2.v2ContinuityGeneration(1),
    receipt: { ...kPrefixReceipt, generation: 7 } };
  expect(V2.v2PrefixAckValid(swapped, kPrefixCheckpoint, kExpected)).toBe(false);
  expect(V2.v2PrefixAckValid({ ...kAck, continuityGeneration: V2.v2ContinuityGeneration(1) }, kPrefixCheckpoint, kExpected)).toBe(false);
  expect(V2.v2PrefixAckValid({ ...kAck, receipt: { ...kPrefixReceipt, generation: 2 } }, kPrefixCheckpoint, kExpected)).toBe(false);
  expect(() => V2.v2WriterGeneration(0)).toThrow(); expect(() => V2.v2ContinuityGeneration(1.5)).toThrow();
});

const kHostProcess: V2.ProcessIdentity = { pid: 4242, startTime: 'tmux-start', bootId: 'synthetic-boot' };
const kCollectorProcess: V2.ProcessIdentity = { pid: 5151, startTime: 'collector-start', bootId: 'synthetic-boot' };
const kWatch: V2.V2EventWatch = { kind: 'tmux-event-journal', journal: file, coverageProof: file,
  covers: V2.V2_CONTINUITY_REQUIRED_EVENTS, fromSeq: 10, throughSeq: 42, watermarkDigest: digest,
  overflow: false, lostEvents: 0, topologyEvents: 0 };
const kWitnessUnsigned: Omit<V2.V2ContinuityWitness, 'digest'> = { schema: 'newarch-v2', witnessId: 'witness-1', pane,
  windowId: '@1', server: { serverIdentity: 'fixture-server', process: kHostProcess },
  collector: { incarnation: epoch.collectorIncarnation, process: kCollectorProcess, unit: 'thumbmux-collector.service' },
  sourceEpoch: V2.v2SourceEpochOf(epoch), raw: { epoch, start: 8, end: 64 },
  records: { firstSequence: 1, lastSequence: 9, chainDigest: digest }, continuityGeneration: kContinuityGen,
  geometry: v2Geometry, watch: kWatch };
const kSignWitness = (patch: Partial<Omit<V2.V2ContinuityWitness, 'digest'>>): V2.V2ContinuityEvidence => {
  const unsigned = { ...kWitnessUnsigned, ...patch };
  return { kind: 'collector-witness', witness: { ...unsigned, digest: V2.v2ContinuityWitnessDigest(unsigned) } };
};
const kResumeCtx: V2.V2ResumeContext = { checkpoint: v2Checkpoint, descriptor: v2Descriptor,
  server: { serverIdentity: 'fixture-server', process: kHostProcess },
  collector: { incarnation: epoch.collectorIncarnation, process: kCollectorProcess },
  sourceEpoch: V2.v2SourceEpochOf(epoch), continuityGeneration: kContinuityGen,
  hostUnit: 'cortex-orchestrator.service', durableRawThrough: { epoch, byteOffset: 64 } };

test('K-flagon continuity: only a collector witness proves resume; images/flags/heartbeats are refused', () => {
  const ok = V2.v2ResumeDecision(kSignWitness({}), kResumeCtx);
  expect(ok).toEqual({ kind: 'continuous', pane, from: v2Checkpoint.through, through: { epoch, byteOffset: 64 }, geometry: v2Geometry, sourceEvidence: file });
  if (ok.kind !== 'continuous') throw Error('fixture continuous');
  const proof: V2.V2ResumeProof = ok; expect(proof.kind).toBe('continuous');
  const observed: V2.V2GeometryObservation = { pane, windowId: '@1', window: { columns: 100, rows: 40 }, terminal: { columns: 100, rows: 40 }, panesInWindow: 1 };
  // RED: a certificate that is only before/after images of the same size.
  expect(V2.v2ResumeDecision({ kind: 'snapshot-pair', before: observed, after: observed }, kResumeCtx)).toEqual({ kind: 'unverified', reason: 'not-a-witness' });
  expect(V2.v2ResumeDecision({ kind: 'pipe-flag', panePipe: 1 }, kResumeCtx)).toEqual({ kind: 'unverified', reason: 'not-a-witness' });
  expect(V2.v2ResumeDecision({ kind: 'heartbeat', lastSeenWallMs: 1 }, kResumeCtx)).toEqual({ kind: 'unverified', reason: 'not-a-witness' });
});
test('K-flagon continuity counterexamples each refuse with their own reason', () => {
  const tampered = kSignWitness({});
  if (tampered.kind !== 'collector-witness') throw Error('fixture');
  const cases: readonly [V2.V2ContinuityEvidence, Partial<V2.V2ResumeContext>, V2.V2ResumeRefusal][] = [
    [{ kind: 'collector-witness', witness: { ...tampered.witness, raw: { epoch, start: 8, end: 65 } } }, {}, 'witness-digest'],
    [kSignWitness({}), { server: { serverIdentity: 'fixture-server', process: { ...kHostProcess, startTime: 'pid-reused' } } }, 'identity'],
    [kSignWitness({}), { server: { serverIdentity: 'recreated-server', process: kHostProcess } }, 'identity'],
    [kSignWitness({ windowId: '@2' }), {}, 'identity'],
    [kSignWitness({}), { collector: { incarnation: 'collector-restarted', process: kCollectorProcess } }, 'collector-epoch'],
    [kSignWitness({}), { sourceEpoch: { attachId: 'pipe-replaced', collectorIncarnation: epoch.collectorIncarnation } }, 'collector-epoch'],
    [kSignWitness({ collector: { ...kWitnessUnsigned.collector, unit: 'cortex-orchestrator.service' } }), {}, 'collector-with-host'],
    [kSignWitness({ raw: { epoch, start: 9, end: 64 } }), {}, 'raw'],
    [kSignWitness({}), { durableRawThrough: { epoch, byteOffset: 80 } }, 'raw'],
    [kSignWitness({ geometry: { ...v2Geometry, columns: 80 } }), {}, 'geometry'],
    [kSignWitness({ watch: { ...kWatch, covers: ['resize', 'layout', 'window', 'pipe', 'server-exit'] } }), {}, 'event-coverage'],
    [kSignWitness({ watch: { ...kWatch, overflow: true } }), {}, 'event-overflow'],
    [kSignWitness({ watch: { ...kWatch, lostEvents: 1 } }), {}, 'event-overflow'],
    // 78 -> 80 -> 78 ends at the original size but is still not exact.
    [kSignWitness({ watch: { ...kWatch, topologyEvents: 2 } }), {}, 'topology-changed'],
    [kSignWitness({ continuityGeneration: V2.v2ContinuityGeneration(8) }), {}, 'topology-changed'],
  ];
  for (const [evidence, ctx, reason] of cases) {
    expect(V2.v2ResumeDecision(evidence, { ...kResumeCtx, ...ctx })).toEqual({ kind: 'unverified', reason });
  }
});

const kResolution: V2.V2IncidentResolution = { schema: 'newarch-v2', pane, incidentId: v2Incident.incidentId,
  state: 'resolved', receipt: v2Receipt, writerGeneration: kWriterGen };
test('K-flagon incident resolution authority: same id, durable, current generation only', () => {
  expect(V2.v2IncidentResolvedBy(kResolution, v2Incident.incidentId, v2Receipt, kWriterGen)).toBe(true);
  const beforeFirstRow = { ...v2Receipt, frontier: null, checkpointId: null };
  expect(V2.v2IncidentResolvedBy({ ...kResolution, receipt: beforeFirstRow }, v2Incident.incidentId, beforeFirstRow, kWriterGen)).toBe(true);
  // RED: resolution for a different incident id.
  expect(V2.v2IncidentResolvedBy({ ...kResolution, incidentId: 'other-incident' }, v2Incident.incidentId, v2Receipt, kWriterGen)).toBe(false);
  expect(V2.v2IncidentResolvedBy({ ...kResolution, state: 'pending', receipt: null }, v2Incident.incidentId, v2Receipt, kWriterGen)).toBe(false);
  expect(V2.v2IncidentResolvedBy(null, v2Incident.incidentId, v2Receipt, kWriterGen)).toBe(false);
  expect(V2.v2IncidentResolvedBy(kResolution, v2Incident.incidentId, { ...v2Receipt, commitId: 'other' }, kWriterGen)).toBe(false);
  expect(V2.v2IncidentResolvedBy(kResolution, v2Incident.incidentId, v2Receipt, V2.v2WriterGeneration(2))).toBe(false);
  expect(V2.v2IncidentResolvedBy({ ...kResolution, pane: { ...pane, paneId: '%2' } }, v2Incident.incidentId, v2Receipt, kWriterGen)).toBe(false);
});
test('K-flagon pending storage incident is shown, then materialized once under the same id+digest', () => {
  const emergency: V2.V2EmergencyIncident = { incident: v2Incident, digest: V2.v2EmergencyIncidentDigest(v2Incident), cause: 'ENOSPC' };
  expect(emergency.digest).toBe(V2.v2Digest('emergency-incident', v2Incident));
  const pending = V2.v2PendingFromEmergency(emergency, file);
  expect(V2.v2PendingReadState(pending, 1000)).toEqual({ kind: 'storage-unavailable', pendingIncidentId: v2Incident.incidentId, retryAfterMs: 1000 });
  expect(V2.v2MaterializesPending(pending, v2Incident)).toBe(true);
  expect(V2.v2MaterializesPending(pending, { ...v2Incident, incidentId: 'other' })).toBe(false);
  expect(V2.v2MaterializesPending(pending, { ...v2Incident, revision: 1 })).toBe(false);
  expect(V2.v2MaterializesPending(pending, { ...v2Incident, reason: 'pipe-eof' })).toBe(false);
  expect(() => V2.v2PendingFromEmergency({ ...emergency, digest: digest }, file)).toThrow();
  expect(() => V2.v2PendingFromEmergency({ ...emergency, incident: { ...v2Incident, reason: 'audit-mismatch' },
    digest: V2.v2EmergencyIncidentDigest({ ...v2Incident, reason: 'audit-mismatch' }) }, file)).toThrow();
});
test('K-flagon raw trim asks raw pins at the checkpoint revision; row pins never block raw trim', () => {
  const census: V2.V2RawPinCensus = { schema: 'newarch-v2', pane, epoch, revision: 2, writerGeneration: kWriterGen, rawPins: [], rowPins: 5 };
  expect(V2.v2RawTrimUnpinned(v2Trim, census, kWriterGen)).toBe(true);
  expect(V2.v2RawTrimUnpinned(v2Trim, { ...census, rawPins: [{ pinId: 'replay-1', holder: 'replay', from: { epoch, byteOffset: 4 } }] }, kWriterGen)).toBe(true);
  expect(V2.v2RawTrimUnpinned(v2Trim, { ...census, rawPins: [{ pinId: 'replay-1', holder: 'replay', from: { epoch, byteOffset: 3 } }] }, kWriterGen)).toBe(false);
  expect(V2.v2RawTrimUnpinned(v2Trim, { ...census, revision: 1 }, kWriterGen)).toBe(false);
  expect(V2.v2RawTrimUnpinned(v2Trim, census, V2.v2WriterGeneration(2))).toBe(false);
  expect(V2.v2RawTrimUnpinned({ ...v2Trim, trimThrough: { epoch, byteOffset: 5 } }, census, kWriterGen)).toBe(false);
});

const kOtherPane = { ...pane, birthGeneration: 2 };
const kExpand: V2Wire.NewarchV2HistoryExpandMessage = { type: 'history_expand_v2', session: 'kem-session', requestId: 'req-1', request: v2Request };
const kWireRow: V2Wire.NewarchV2WireRow = { kind: 'row', id: kRows[0]!.id, cells: kRows[0]!.cells, wrapStatus: 'unwrapped', wrapPad: 0 };
const kReply: V2Wire.NewarchV2HistoryReply = { schema: 'newarch-v2', type: 'history_v2', channel: 'kem-session', requestId: 'req-1',
  status: 'ok', pane, revision: 2, entries: [kWireRow, { kind: 'incident', incident: v2Incident }], payloadBytes: 512,
  states: [{ kind: 'exact', auditedRevision: null }], before: { kind: 'more', cursor: v2Cursor }, after: { kind: 'end' } };
test('K-flagon cursor of another pane is dropped client-side and rejected in replies', () => {
  expect([V2Wire.NEWARCH_V2_WIRE_LIMITS.pageEntries, V2Wire.NEWARCH_V2_WIRE_LIMITS.pageBytes, V2Wire.NEWARCH_V2_WIRE_LIMITS.cursorBytes])
    .toEqual([V2.NEWARCH_V2_LIMITS.pageEntries, V2.NEWARCH_V2_LIMITS.pageBytes, V2.NEWARCH_V2_LIMITS.cursorBytes]);
  expect(V2.v2CursorForPane(pane, v2Cursor)).toEqual(v2Cursor);
  expect(V2.v2CursorForPane(kOtherPane, v2Cursor)).toBeNull();
  expect(V2Wire.newarchV2CursorFor(v2Descriptor, v2Cursor)).toEqual(v2Cursor);
  for (const p of [kOtherPane, { ...pane, paneId: '%2' }, { ...pane, serverIdentity: 'restarted' }]) {
    expect(V2Wire.newarchV2CursorFor({ ...v2Descriptor, pane: p }, v2Cursor)).toBeNull();
  }
  expect(V2Wire.newarchV2ReplyMatches(kExpand, kReply)).toBe(true);
  // RED: cursor / entry / reply of another pane.
  expect(V2Wire.newarchV2ReplyMatches(kExpand, { ...kReply, before: { kind: 'more', cursor: { ...v2Cursor, pane: kOtherPane } } })).toBe(false);
  expect(V2Wire.newarchV2ReplyMatches(kExpand, { ...kReply, entries: [{ ...kWireRow, id: { ...kWireRow.id, pane: kOtherPane } }] })).toBe(false);
  expect(V2Wire.newarchV2ReplyMatches(kExpand, { ...kReply, entries: [{ kind: 'incident', incident: { ...v2Incident, pane: kOtherPane } }] })).toBe(false);
  expect(V2Wire.newarchV2ReplyMatches(kExpand, { ...kReply, pane: kOtherPane })).toBe(false);
  expect(V2Wire.newarchV2ReplyMatches(kExpand, { ...kReply, requestId: 'req-0' })).toBe(false);
  expect(V2Wire.newarchV2ReplyMatches(kExpand, { ...kReply, channel: 'other-session' })).toBe(false);
  expect(V2Wire.newarchV2ReplyMatches(kExpand, { ...kReply, revision: 1 })).toBe(false);
  expect(V2Wire.newarchV2ReplyMatches({ ...kExpand, request: { ...v2Request, maxEntries: 1 } }, kReply)).toBe(false);
  expect(V2Wire.newarchV2ReplyMatches({ ...kExpand, request: { ...v2Request, maxBytes: 511 } }, kReply)).toBe(false);
  const err: V2Wire.NewarchV2HistoryReply = { schema: 'newarch-v2', type: 'history_v2', channel: 'kem-session', requestId: 'req-1',
    status: 'error', pane, code: 'wrong-pane', retryAfterMs: null };
  expect(V2Wire.newarchV2ReplyMatches(kExpand, err)).toBe(true);
  expect(V2Wire.newarchV2ReplyMatches(kExpand, { ...err, pane: kOtherPane })).toBe(false);
  expect(() => V2.validateV2ReadRequest({ ...v2Request, cursor: { ...v2Cursor, pane: kOtherPane } })).toThrow('v2 cursor pane');
});
test('K-flagon reply check enforces the wire caps, cursor token size, and never ends while unavailable', () => {
  // RED (review M1): a request beyond the wire caps is not a valid request, so no reply can match it.
  expect(V2Wire.newarchV2ReplyMatches({ ...kExpand, request: { ...v2Request, maxEntries: 257 } }, kReply)).toBe(false);
  expect(V2Wire.newarchV2ReplyMatches({ ...kExpand, request: { ...v2Request, maxBytes: 2097153 } }, kReply)).toBe(false);
  expect(V2Wire.newarchV2ReplyMatches({ ...kExpand, request: { ...v2Request, maxEntries: 0 } }, kReply)).toBe(false);
  expect(V2Wire.newarchV2ReplyMatches({ ...kExpand, request: { ...v2Request, cursor: { ...v2Cursor, token: 'x'.repeat(4097) } } }, kReply)).toBe(false);
  // RED: reply cursors beyond 4096 UTF-8 bytes (multi-byte counts bytes, not code units).
  const bigCursor = { ...v2Cursor, token: 'x'.repeat(4097) };
  expect(V2Wire.newarchV2ReplyMatches(kExpand, { ...kReply, before: { kind: 'more', cursor: bigCursor } })).toBe(false);
  expect(V2Wire.newarchV2ReplyMatches(kExpand, { ...kReply, before: { kind: 'more', cursor: { ...v2Cursor, token: '\u0e01'.repeat(1366) } } })).toBe(false);
  expect(V2Wire.newarchV2ReplyMatches(kExpand, { ...kReply, before: { kind: 'more', cursor: { ...v2Cursor, token: 'x'.repeat(4096) } } })).toBe(true);
  // RED: storage/remote unavailable in the requested direction is blocked, never end.
  const storage = { kind: 'storage-unavailable', pendingIncidentId: null, retryAfterMs: 1000 } as const;
  const remote = { kind: 'remote-unavailable', bundleId: 'b1', reason: 'offline', retryAfterMs: 1000 } as const;
  for (const state of [storage, remote]) {
    expect(V2Wire.newarchV2ReplyMatches(kExpand, { ...kReply, states: [state], after: { kind: 'end' } })).toBe(false);
    expect(V2Wire.newarchV2ReplyMatches({ ...kExpand, request: { ...v2Request, direction: 'before' } },
      { ...kReply, states: [state], before: { kind: 'end' }, after: { kind: 'end' } })).toBe(false);
    expect(V2Wire.newarchV2ReplyMatches(kExpand, { ...kReply, states: [state], after: { kind: 'blocked', cursor: v2Cursor, state } })).toBe(true);
  }
  // At the live head reading backward, the far side may still be end while the read side is blocked.
  expect(V2Wire.newarchV2ReplyMatches({ ...kExpand, request: { ...v2Request, direction: 'before' } },
    { ...kReply, states: [storage], before: { kind: 'blocked', cursor: v2Cursor, state: storage }, after: { kind: 'end' } })).toBe(true);
});
test('K-flagon geometry and budgets unchanged by the seam contract', () => {
  expect(V2.v2BirthGeometry(v2Config)).toEqual({ policy: 'fixed-at-birth', columns: 78, rows: 120, configVersion: 'q22-default-2', panesPerWindow: 1 });
  expect([V2.NEWARCH_V2_LIMITS.pendingRowsPerPane, V2.NEWARCH_V2_LIMITS.pendingBytesPerPane, V2.NEWARCH_V2_LIMITS.pageBytes,
    V2.NEWARCH_V2_LIMITS.checkpointBytesPerPane, V2.NEWARCH_V2_LIMITS.maxRows]).toEqual([256, 1048576, 2097152, 4194304, 120]);
});

export async function compileFlagonSeamPorts(s: V2.V2PrefixSourcePort, w: V2.V2ContinuityWitnessPort, h: V2.V2HistoryAuthority) {
  const certified = await s.certifyPrefix(binding, kPrefix.consumed);
  if (certified.status === 'ok') await s.acknowledgePrefix({ ...kAck, source: certified.value });
  const evidence = await w.witness(binding, v2Checkpoint.through);
  if (evidence.status === 'ok') V2.v2ResumeDecision(evidence.value, kResumeCtx);
  const gen = h.writerGeneration();
  const resolution = h.incidentResolution(pane, v2Incident.incidentId);
  const census = h.rawPins(pane, epoch);
  if (gen.status === 'ok' && resolution.status === 'ok' && census.status === 'ok') {
    V2.v2IncidentResolvedBy(resolution.value, v2Incident.incidentId, v2Receipt, gen.value);
    V2.v2RawTrimUnpinned(v2Trim, census.value, gen.value);
  }
}
function negativeFlagonSeamTypes() {
  // @ts-expect-error A writer generation is not a continuity generation.
  const continuity: V2.V2ContinuityGeneration = kWriterGen;
  // @ts-expect-error A continuity generation is not a writer generation.
  const writer: V2.V2WriterGeneration = kContinuityGen;
  // @ts-expect-error A bare number (e.g. V2Receipt.generation) is not a branded generation.
  const raw: V2.V2WriterGeneration = v2Receipt.generation;
  // @ts-expect-error A source epoch is an object identity, never a generation number.
  const epochAsGen: V2.V2ContinuityGeneration = V2.v2SourceEpochOf(epoch);
  // @ts-expect-error A prefix ACK must carry the collector-issued source receipt.
  const unsourced: V2.V2PrefixAck = { ...kAck, source: undefined };
  // @ts-expect-error Two same-size images are not a continuity witness.
  const imageWitness: V2.V2ContinuityWitness = { before: kResumeCtx, after: kResumeCtx };
  // @ts-expect-error A spool ACK is not a prefix ACK.
  const spoolAsPrefix: V2.V2PrefixAck = spoolAck;
  // @ts-expect-error The writer constructor refuses a continuity generation (review B1).
  const rebrandedWriter = V2.v2WriterGeneration(kContinuityGen);
  // @ts-expect-error The continuity constructor refuses a writer generation (review B1).
  const rebrandedContinuity = V2.v2ContinuityGeneration(kWriterGen);
  // A bare number (V2Receipt.generation) still goes through the constructor that names its role.
  const fromReceipt: V2.V2WriterGeneration = V2.v2WriterGeneration(v2Receipt.generation);
  return [continuity, writer, raw, epochAsGen, unsourced, imageWitness, spoolAsPrefix, rebrandedWriter, rebrandedContinuity, fromReceipt];
}
/** Review M2: history_expand_v2 is a message the mux gate accepts (additive member). */
function flagonMuxGateTypes() {
  const loose: V2Wire.MuxClientMessage = kExpand;
  const strict: V2Wire.MuxStrictClientMessage = kExpand;
  return [loose, strict];
}
export const K_FLAGON_GOLDEN = { prefix: kPrefix, source: kSource, ack: kAck, witness: kSignWitness({}),
  resolution: kResolution, expand: kExpand, reply: kReply, negativeFlagonSeamTypes, flagonMuxGateTypes } as const;

// Mutation controls (K): each mutant lives ONLY in a temporary copy made inside
// the cage; the repository HEAD and working tree never hold a mutant. The child
// run sets K_FLAGON_MUTANT=1 so this block does not recurse.
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { env as kEnv, execPath as kExecPath, stderr as kStderr } from 'node:process';
const K_MUTATION_FILES = { fixture: 'server/tests/fixtures/newarch-contract-fixture.ts',
  server: 'server/src/stream-contract.ts', core: 'core/src/protocol.ts' } as const;
const K_MUTANTS: readonly { readonly id: string; readonly file: 'server' | 'core'; readonly from: string; readonly to: string; readonly killedBy: string }[] = [
  { id: 'bk-issued-equality', file: 'server', from: 'issued === null || !sameContract(input, issued)', to: 'issued === null',
    killedBy: 'BK issued equality refuses host re-signing' },
  { id: 'bk-offset-equality', file: 'server', from: '\n      && input.certified.start === previous.through.byteOffset\n      && input.certified.end === checkpoint.through.byteOffset', to: '',
    killedBy: 'BK offset equality and epochs' },
  { id: 'bk-rearm-purpose', file: 'server', from: " && observation.purpose === 'reserve-rearm'", to: '',
    killedBy: 'BK rearm purpose and generation' },
  { id: 'bk-rearm-receipt', file: 'server', from: '\n      && sameContract(observation.resolvedReceipt, receipt)', to: '',
    killedBy: 'BK rearm purpose and generation' },
  { id: 'bk-record-full-digest', file: 'server', from: 'if (digest !== sourceSpoolDigest(unsigned)) return false;', to: '',
    killedBy: 'BK containing replay verifies the whole record' },
  { id: 'bk-prefix-as-trim', file: 'server', from: "\n    && a.consumerAck.kind === 'synced-spool' && a.consumerAck.version === 1", to: '',
    killedBy: 'BK batch accepts an issued exact prefix' },
  { id: 'bk-rearm-generation', file: 'server', from: '\n      && observation.authorizedGeneration === current', to: '',
    killedBy: 'BK rearm purpose and generation' },

  // BK debt: each deletes ONE refusal condition; the named sole case must fail.
  { id: 'bk-sole-previous-epoch', file: 'server', from: 'v2SameEpoch(previous.through.epoch, epoch) && ', to: '',
    killedBy: 'BK debt sole: batch previous epoch refuses' },
  { id: 'bk-sole-certified-epoch', file: 'server', from: ' && v2SameEpoch(input.certified.epoch, epoch)', to: '',
    killedBy: 'BK debt sole: batch certified epoch refuses' },
  { id: 'bk-sole-source-epoch', file: 'server', from: '\n      && sameContract(input.sourceEpoch, v2SourceEpochOf(epoch))', to: '',
    killedBy: 'BK debt sole: batch source epoch refuses' },
  { id: 'bk-sole-zero-progress', file: 'server', from: '\n      && input.certified.end > input.certified.start', to: '',
    killedBy: 'BK debt sole: batch zero progress refuses' },
  { id: 'bk-sole-raw-cap', file: 'server', from: '\n      && input.certified.end - input.certified.start <= NEWARCH_V2_PREFIX_LIMITS.maxRawBytes', to: '',
    killedBy: 'BK debt sole: batch raw cap refuses' },
  { id: 'bk-sole-prefix-schema', file: 'server', from: ' || input.schema !== NEWARCH_V2_VERSION) return false;', to: ') return false;',
    killedBy: 'BK debt sole: batch prefix schema refuses' },
  { id: 'bk-sole-last-record-end', file: 'server', from: 'input.lastRecordEnd >= input.certified.end && ', to: '',
    killedBy: 'BK debt sole: batch last record end refuses' },
  { id: 'bk-sole-sequence-order', file: 'server', from: ' && input.firstSequence <= input.lastSequence', to: '',
    killedBy: 'BK debt sole: batch sequence order refuses' },
  { id: 'bk-sole-record-version', file: 'server', from: 'return input.version === 1 && sameContract(input.through, checkpoint.through);',
    to: 'return sameContract(input.through, checkpoint.through);', killedBy: 'BK debt sole: batch record version refuses' },
  { id: 'bk-sole-ack-kind', file: 'server', from: "a.kind !== 'synced-spool' || ", to: '',
    killedBy: 'BK debt sole: replay ack kind refuses' },
  { id: 'bk-sole-ack-version', file: 'server', from: '|| a.version !== 1 ', to: '',
    killedBy: 'BK debt sole: replay ack version refuses' },
  { id: 'bk-sole-ack-commit', file: 'server', from: '|| a.commitId !== r.operationId', to: '',
    killedBy: 'BK debt sole: replay ack commit id refuses' },
  { id: 'bk-sole-ack-record-digest', file: 'server', from: '|| a.recordDigest !== digest ', to: '',
    killedBy: 'BK debt sole: replay ack record digest refuses' },
  { id: 'bk-sole-byte-high', file: 'server', from: ' || b > 255)', to: ')',
    killedBy: 'BK debt sole: replay byte above 255 refuses' },
  { id: 'bk-sole-byte-low', file: 'server', from: ' || b < 0', to: '',
    killedBy: 'BK debt sole: replay byte below 0 refuses' },
  { id: 'bk-sole-byte-integer', file: 'server', from: '!Number.isInteger(b) || ', to: '',
    killedBy: 'BK debt sole: replay byte not integer refuses' },
  { id: 'bk-sole-rearm-schema', file: 'server', from: "&& receipt.schema === NEWARCH_V2_VERSION && receipt.kind === 'ssot-durable'",
    to: "&& receipt.kind === 'ssot-durable'", killedBy: 'BK debt sole: rearm receipt schema refuses' },
  { id: 'bk-sole-rearm-kind', file: 'server', from: "&& receipt.schema === NEWARCH_V2_VERSION && receipt.kind === 'ssot-durable'",
    to: '&& receipt.schema === NEWARCH_V2_VERSION', killedBy: 'BK debt sole: rearm receipt kind refuses' },
  { id: 'ack-past-checkpoint', file: 'server', from: 'if (at !== checkpoint.through.byteOffset || s.certified.start > at', to: 'if (s.certified.start > at',
    killedBy: 'K-flagon ACK never passes the committed checkpoint' },
  { id: 'image-only-accepted', file: 'server', from: "if (e.kind !== 'collector-witness') return no('not-a-witness');",
    to: "if (e.kind === 'snapshot-pair') return { kind: 'continuous', pane: ctx.checkpoint.pane, from: ctx.checkpoint.through, through: ctx.durableRawThrough, geometry: ctx.descriptor.geometry, sourceEvidence: { path: 'image', bytes: 1, sha256: '0'.repeat(64) } };\n  if (e.kind !== 'collector-witness') return no('not-a-witness');",
    killedBy: 'K-flagon continuity: only a collector witness proves resume' },
  { id: 'resize-and-back-exact', file: 'server', from: 'if (watch.topologyEvents > 0 || w.continuityGeneration', to: 'if (w.continuityGeneration',
    killedBy: 'K-flagon continuity counterexamples each refuse' },
  { id: 'foreign-incident-resolution', file: 'server', from: '\n    && r.incidentId === incidentId && v2PaneKey(r.pane)', to: '\n    && v2PaneKey(r.pane)',
    killedBy: 'K-flagon incident resolution authority' },
  { id: 'foreign-pane-entries', file: 'core', from: 'reply.entries.every(e => newarchV2SamePane(newarchV2EntryPane(e), req.pane))', to: 'true',
    killedBy: 'K-flagon cursor of another pane' },
  { id: 'client-keeps-foreign-cursor', file: 'core', from: '&& newarchV2SamePane(cursor.pane, pane.pane) ? cursor : null', to: '? cursor : null',
    killedBy: 'K-flagon cursor of another pane' },
  { id: 'generation-roles-unchecked', file: 'server',
    from: 'if (r.generation !== ack.writerGeneration || ack.writerGeneration !== expected.writerGeneration\n      || ack.continuityGeneration !== expected.continuityGeneration) return false;', to: '',
    killedBy: 'K-flagon writer generation, source epoch and continuity generation' },
  { id: 'raw-pins-ignored', file: 'server',
    from: '\n    && census.rawPins.every(p => v2SameEpoch(p.from.epoch, census.epoch) && p.from.byteOffset >= a.trimThrough.byteOffset)', to: '',
    killedBy: 'K-flagon raw trim asks raw pins' },
  { id: 'materialize-any-digest', file: 'server', from: '\n      && p.incidentDigest === v2EmergencyIncidentDigest(incident);', to: ';',
    killedBy: 'K-flagon pending storage incident' },
  { id: 'issued-receipt-ignored', file: 'server', from: 'return sameContract(ack.source, issued) && v2PrefixAckValid(', to: 'return v2PrefixAckValid(',
    killedBy: 'K-flagon ACK binds the whole receipt certifyPrefix issued' },
  { id: 'certified-past-checkpoint', file: 'server', from: ' || s.certified.end !== at', to: '',
    killedBy: 'K-flagon ACK certifies exactly the committed range' },
  { id: 'prefix-rows-reordered', file: 'server', from: '&& r.id.rowOrdinal <= prev.rowOrdinal) return false;', to: '&& false) return false;',
    killedBy: 'K-flagon prefix: bounded prefix' },
  { id: 'reply-ignores-wire-caps', file: 'core', from: "  if (!newarchV2RequestInBounds(req)) return false;\n", to: '',
    killedBy: 'K-flagon reply check enforces the wire caps' },
  { id: 'reply-cursor-token-unbounded', file: 'core', from: '\n    && newarchV2Utf8Bytes(c.token) <= NEWARCH_V2_WIRE_LIMITS.cursorBytes', to: '',
    killedBy: 'K-flagon reply check enforces the wire caps' },
  { id: 'reply-end-while-unavailable', file: 'core', from: "\n    && !(unavailable && ahead.kind === 'end')", to: '',
    killedBy: 'K-flagon reply check enforces the wire caps' },
  { id: 'zero-progress-prefix', file: 'server', from: 'if (p.offered.end > p.offered.start && p.consumed.end === p.consumed.start) return false;', to: '',
    killedBy: 'K-flagon prefix: bounded prefix' },
  // HS2 storage profile / allocation ledger (PLAN §3.2).
  { id: 'hs2-cap-per-pane', file: 'server', from: 'if (l.used[r.cls] + r.bytes > cap) return', to: 'if (r.bytes > cap) return',
    killedBy: 'HS2 ledger refuses stale versions' },
  { id: 'hs2-sum-forgets-wal', file: 'server', from: 'for (const field of fields) { v2Int(a[field], 1); total += a[field]; }',
    to: "for (const field of fields) { v2Int(a[field], 1); if (field !== 'walBytes') total += a[field]; }",
    killedBy: 'HS2 r-canary-8g manifest sums inside the root' },
  { id: 'hs2-ledger-ignores-version', file: 'server', from: "  if (r.expectedVersion !== l.version) return { ok: false, reason: 'stale-ledger' };\n", to: '',
    killedBy: 'HS2 ledger refuses stale versions' },
  { id: 'hs2-reserve-for-normal-class', file: 'server', from: 'if (used + r.bytes > dataBudget) return', to: 'if (used + r.bytes > s.rootCapBytes) return',
    killedBy: 'HS2 ledger refuses stale versions' },
  { id: 'hs2-digest-storage-only', file: 'server',
    from: '\n    allocation: a && { databaseBytes: a.databaseBytes, walBytes: a.walBytes, rawBytes: a.rawBytes,\n      stagingBytes: a.stagingBytes, diagnosticBytes: a.diagnosticBytes, otherBytes: a.otherBytes } });',
    to: ' });', killedBy: 'HS2 profile digest binds storage and allocation' },
  { id: 'hs2-page-limit-assumes-4096', file: 'server', from: 'return Math.floor(databaseBytes / pageSize);', to: 'return Math.floor(databaseBytes / 4096);',
    killedBy: "HS2 default profile is the 256 MiB config and keeps H's page limit" },
  { id: 'hs2-manifest-staging-unchecked', file: 'server', from: 'a.stagingBytes !== s.stagingCapBytes || ', to: '',
    killedBy: 'HS2 r-canary-8g manifest sums inside the root' },
];
function kRunCopy(mutant: (typeof K_MUTANTS)[number] | null): { readonly status: number | null; readonly out: string } {
  // server/tests/fixtures -> package root in both layouts; copy all three
  // sources under that same relative tree so the child needs no host modules.
  const root = resolve(import.meta.dir, '../../..');
  const dir = mkdtempSync(join(tmpdir(), 'k-flagon-mutant-'));
  try {
    for (const [key, rel] of Object.entries(K_MUTATION_FILES)) {
      let text = readFileSync(join(root, rel), 'utf8');
      if (mutant && mutant.file === key) {
        if (text.split(mutant.from).length !== 2) throw Error(`mutant ${mutant.id} anchor not unique`);
        text = text.replace(mutant.from, mutant.to);
      }
      mkdirSync(dirname(join(dir, rel)), { recursive: true }); writeFileSync(join(dir, rel), text);
    }
    const run = spawnSync(kExecPath, ['test', join(dir, K_MUTATION_FILES.fixture)], {
      cwd: dir, encoding: 'utf8', timeout: 120_000, env: { ...kEnv, K_FLAGON_MUTANT: '1' } });
    return { status: run.status, out: `${run.stdout}${run.stderr}` };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
test.skipIf(kEnv.K_FLAGON_MUTANT === '1')('K-flagon mutation controls: every frozen guard has a killing case', () => {
  const control = kRunCopy(null);
  expect(control.out).toContain(' 0 fail'); expect(control.status).toBe(0);
  for (const mutant of K_MUTANTS) {
    const run = kRunCopy(mutant);
    const killed = run.out.split('\n').filter(l => l.includes('(fail) ')).map(l => l.trim());
    kStderr.write(`K-MUTANT ${mutant.id} exit=${run.status} killed=${JSON.stringify(killed)}\n`);
    expect(run.out).not.toMatch(/SyntaxError|Cannot find module|error: Could not resolve/);
    expect(run.status).toBe(1);
    expect(killed.some(l => l.includes(mutant.killedBy))).toBe(true);
  }
}, 600_000);


test('B1c canonical memo expires per call even with a shallow-frozen checkpoint', () => {
  const cp = structuredClone(v2Checkpoint);
  Object.freeze(cp);
  expect(() => V2.validateV2Checkpoint(cp)).not.toThrow();
  const state = cp.state as unknown as { pendingUtf8: number[] };
  state.pendingUtf8.push(1);
  expect(() => V2.validateV2Checkpoint(cp)).toThrow();
  state.pendingUtf8.pop();
  expect(() => V2.validateV2Checkpoint(cp)).not.toThrow();
  const prefix = structuredClone(kPrefix);
  expect(V2.v2DecodePrefixValid(prefix, v2Checkpoint)).toBe(true);
  (prefix.checkpoint.state.pendingEscape as number[]).push(1);
  expect(V2.v2DecodePrefixValid(prefix, v2Checkpoint)).toBe(false);
  const invalid = structuredClone(cp);
  (invalid.state as unknown as Record<string, unknown>).unexpected = undefined;
  expect(() => V2.validateV2Checkpoint(invalid)).toThrow();
  (invalid.state as unknown as Record<string, unknown>).unexpected = '\ud800';
  expect(() => V2.validateV2Checkpoint(invalid)).toThrow();
});

// BK exact batch input and reserve-rearm are separate from consumer ACK/trim.
const bkInput = (input: V2.V2BatchInput, issued: V2.V2BatchInput | null = kSource,
  previous = v2Checkpoint, checkpoint = kPrefixCheckpoint) =>
  V2.v2BatchInputMatchesIssued(input, issued, previous, checkpoint);

test('BK batch accepts an issued exact prefix without pretending it is a record ACK', () => {
  expect(V2.v2DecodePrefixValid(kPrefix, v2Checkpoint)).toBe(true);
  expect(V2.v2PrefixAckMatchesIssued(kAck, kSource, kPrefixCheckpoint, kExpected)).toBe(true);
  expect(bkInput(kSource)).toBe(true);
  const record = { ...spoolAck, through: kPrefixCheckpoint.through };
  expect(bkInput(record, record)).toBe(true);
  const beyond = { ...record, through: { epoch, byteOffset: 20 } };
  expect(bkInput(beyond, beyond)).toBe(false);
  expect(bkInput(record, null)).toBe(false);
  // Prefix ACK is not a record ACK even if it carries exactly this checkpoint.
  // @ts-expect-error Cross-purpose authority is forbidden even at equal offsets.
  const trim: V2.V2TrimAuthorization = { ...v2Trim, checkpoint: kPrefixCheckpoint, receipt: kPrefixReceipt, consumerAck: kAck };
  expect(V2.v2TrimWithinCheckpoint(trim)).toBe(false);
});
test('BK issued equality refuses host re-signing and missing authority', () => {
  expect(bkInput(kSource, null)).toBe(false);
  for (const patch of [{ lastRecordEnd: 14 }, { receiptId: 'unknown' }, { lastRecordDigest: 'b'.repeat(64) },
    { firstSequence: 0 }, { lastSequence: 2 }]) {
    const forged = kSignSource(patch);
    const { digest: signature, ...unsigned } = forged;
    expect(signature).toBe(V2.v2SourcePrefixReceiptDigest(unsigned));
    expect(bkInput(forged)).toBe(false);
  }
  expect(bkInput({ ...kSource, lastRecordEnd: 14 }, { ...kSource, lastRecordEnd: 14 })).toBe(false);
});
test('BK offset equality and epochs bind exactly the old and new checkpoints', () => {
  for (const [start, end] of [[7, 14], [9, 14], [8, 13], [8, 15], [8, 8], [14, 14]]) {
    const issued = kSignSource({ certified: { epoch, start: start!, end: end! } });
    expect(bkInput(issued, issued)).toBe(false);
  }
  const otherEpoch = { ...epoch, collectorIncarnation: 'other' };
  const issued = kSignSource({ certified: { epoch: otherEpoch, start: 8, end: 14 }, sourceEpoch: V2.v2SourceEpochOf(otherEpoch) });
  expect(bkInput(issued, issued)).toBe(false);
  expect(bkInput(kSource, kSource, { ...v2Checkpoint, pane: kOtherPane })).toBe(false);
  for (const patch of [{ lastRecordEnd: 13 }, { firstSequence: 2 }, { firstSequence: -1 }]) {
    const bad = kSignSource(patch); expect(bkInput(bad, bad)).toBe(false);
  }
});

const bkGeneration = V2.v2WriterGeneration(2);
const bkIncidentDigest = V2.v2EmergencyIncidentDigest(v2Incident);
const bkObservation: V2.V2ReserveRearmObservation = { schema: 'newarch-v2', purpose: 'reserve-rearm', pane,
  incidentId: v2Incident.incidentId, incidentDigest: bkIncidentDigest, resolvedReceipt: v2Receipt,
  authorizedGeneration: bkGeneration };
const bkRearm = (o: V2.V2ReserveRearmObservation | null, receipt = v2Receipt) =>
  V2.v2ReserveRearmAllowed(o, pane, v2Incident.incidentId, bkIncidentDigest, receipt, bkGeneration);

test('BK rearm after reopen keeps the original durable receipt', () => {
  const before = V2.streamCanonical([kResolution, v2Receipt]);
  expect(V2.v2IncidentResolvedBy(kResolution, v2Incident.incidentId, v2Receipt, kWriterGen)).toBe(true);
  expect(V2.v2IncidentResolvedBy(kResolution, v2Incident.incidentId, v2Receipt, bkGeneration)).toBe(false);
  expect(bkRearm(bkObservation)).toBe(true);
  expect(V2.streamCanonical([kResolution, v2Receipt])).toBe(before);
  expect(bkRearm(null)).toBe(false);
  const empty = { ...v2Receipt, checkpointId: null, frontier: null };
  expect(bkRearm({ ...bkObservation, resolvedReceipt: empty }, empty)).toBe(true);
  // Rearm does not refresh old receipt authority for ACK or trim.
  expect(V2.v2PrefixAckValid(kAck, kPrefixCheckpoint, { ...kExpected, writerGeneration: bkGeneration })).toBe(false);
  expect(V2.v2RawTrimUnpinned(v2Trim, { schema: 'newarch-v2', pane, epoch, revision: 2, writerGeneration: bkGeneration, rawPins: [], rowPins: 0 }, bkGeneration)).toBe(false);
});
test('BK rearm purpose and generation cannot be repurposed or cached across reopen', () => {
  // @ts-expect-error The observation's purpose cannot authorize raw deletion.
  expect(bkRearm({ ...bkObservation, purpose: 'trim' })).toBe(false);
  expect(bkRearm({ ...bkObservation, authorizedGeneration: kWriterGen })).toBe(false);
  expect(bkRearm({ ...bkObservation, authorizedGeneration: V2.v2WriterGeneration(3) })).toBe(false);
  for (const generation of [0, -1, 1.5, 3, NaN]) {
    const receipt = { ...v2Receipt, generation };
    expect(bkRearm({ ...bkObservation, resolvedReceipt: receipt }, receipt)).toBe(false);
  }
  for (const patch of [{ pane: kOtherPane }, { incidentId: 'other' }, { incidentDigest: 'a'.repeat(64) },
    { resolvedReceipt: { ...v2Receipt, operationId: 'other' } }, { resolvedReceipt: { ...v2Receipt, generation: 2 } }]) {
    expect(bkRearm({ ...bkObservation, ...patch })).toBe(false);
  }
  const foreign = { ...v2Receipt, pane: kOtherPane };
  expect(bkRearm({ ...bkObservation, resolvedReceipt: foreign }, foreign)).toBe(false);
});

const bkBudget: V2.V2ContainingReplayBudget = { maxRecords: 2, maxRawBytes: 32, maxSerializedBytes: 8192 };
const bkRecordUnsigned: Omit<V2.SpoolRecord, 'digest'> = { version: 1, operationId: 'bk-record',
  range: { epoch, start: 8, end: 20 }, sequence: 1, previousDigest: digest,
  payload: { kind: 'bytes', bytes: [65, 66, 67, 68, 69, 70, 71, 72, 73, 74, 75, 76] } };
const bkRecord: V2.SpoolRecord = { ...bkRecordUnsigned, digest: V2.sourceSpoolDigest(bkRecordUnsigned) };
const bkRecordAck: V2.SpoolAck = { kind: 'synced-spool', version: 1, through: { epoch, byteOffset: 20 },
  recordDigest: bkRecord.digest, commitId: bkRecord.operationId, segmentId: 'bk-segment' };
const bkReplay: Extract<V2.V2ContainingReplay, { kind: 'records' }> = { schema: 'newarch-v2', kind: 'records',
  requested: { epoch, byteOffset: 14 }, records: [{ record: bkRecord, ack: bkRecordAck }],
  next: { epoch, byteOffset: 20 }, atDurableHead: true };
const bkReplayValid = (r: V2.V2ContainingReplay, b = bkBudget) =>
  V2.v2ContainingReplayRecordsValid(r, bkReplay.requested, b);
test('BK containing replay verifies the whole record before slicing and counts it in every budget', () => {
  expect(bkReplayValid(bkReplay)).toBe(true);
  const serializedBytes = Buffer.byteLength(JSON.stringify(bkReplay));
  expect(bkReplayValid(bkReplay, { ...bkBudget, maxSerializedBytes: serializedBytes })).toBe(true);
  expect(bkReplayValid(bkReplay, { ...bkBudget, maxSerializedBytes: serializedBytes - 1 })).toBe(false);
  expect(bkReplayValid(bkReplay, { ...bkBudget, maxRawBytes: 11 })).toBe(false);
  expect(bkReplayValid(bkReplay, { ...bkBudget, maxRawBytes: 12 })).toBe(true);
  for (const offset of [8, 19]) {
    const requested = { epoch, byteOffset: offset };
    expect(V2.v2ContainingReplayRecordsValid({ ...bkReplay, requested }, requested, bkBudget)).toBe(true);
  }
  for (const offset of [7, 20, 21]) {
    const requested = { epoch, byteOffset: offset };
    expect(V2.v2ContainingReplayRecordsValid({ ...bkReplay, requested }, requested, bkBudget)).toBe(false);
  }
  const corrupt: V2.SpoolRecord = { ...bkRecord, payload: { kind: 'bytes', bytes: [0, 66, 67, 68, 69, 70, 71, 72, 73, 74, 75, 76] } };
  expect(bkReplayValid({ ...bkReplay, records: [{ record: corrupt, ack: bkRecordAck }] })).toBe(false);
  const sliced: V2.SpoolRecord = { ...bkRecord, payload: { kind: 'bytes', bytes: [71, 72, 73, 74, 75, 76] } };
  expect(bkReplayValid({ ...bkReplay, records: [{ record: sliced, ack: bkRecordAck }] })).toBe(false);
  expect(bkReplayValid({ ...bkReplay, records: [{ record: bkRecord, ack: { ...bkRecordAck, through: bkReplay.requested } }] })).toBe(false);
  expect(bkReplayValid({ ...bkReplay, requested: { epoch, byteOffset: 13 } })).toBe(false);
  expect(bkReplayValid({ ...bkReplay, next: bkReplay.requested })).toBe(false);
  expect(bkReplayValid({ ...bkReplay, records: [], next: bkReplay.requested, atDurableHead: false })).toBe(false);
  expect(bkReplayValid({ ...bkReplay, records: [], next: bkReplay.requested, atDurableHead: true })).toBe(true);
  expect(bkReplayValid({ schema: 'newarch-v2', kind: 'budget-required', requested: bkReplay.requested, minimum: bkBudget })).toBe(false);
  for (const b of [{ ...bkBudget, maxRecords: 0 }, { ...bkBudget, maxRecords: 17 },
    { ...bkBudget, maxRawBytes: 65537 }, { ...bkBudget, maxSerializedBytes: 262144 },
    { ...bkBudget, maxRawBytes: NaN }]) expect(V2.v2ContainingReplayBudgetValid(b)).toBe(false);
});

test('BK containing replay checks chain, holes, epochs and hard record cap', () => {
  const makeEntry = (patch: Partial<Omit<V2.SpoolRecord, 'digest'>> = {}): V2.V2ContainingRecord => {
    const unsigned: Omit<V2.SpoolRecord, 'digest'> = { ...bkRecordUnsigned, operationId: 'bk-next', sequence: 2,
      range: { epoch, start: 20, end: 32 }, previousDigest: bkRecord.digest, ...patch };
    const record = { ...unsigned, digest: V2.sourceSpoolDigest(unsigned) };
    return { record, ack: { ...bkRecordAck, through: { epoch: record.range.epoch, byteOffset: record.range.end },
      recordDigest: record.digest, commitId: record.operationId } };
  };
  const second = makeEntry();
  const two = { ...bkReplay, records: [...bkReplay.records, second], next: { epoch, byteOffset: 32 } };
  expect(bkReplayValid(two)).toBe(true);
  expect(bkReplayValid(two, { ...bkBudget, maxRecords: 1 })).toBe(false);
  for (const patch of [{ sequence: 3 }, { previousDigest: digest }, { range: { epoch, start: 21, end: 33 } },
    { range: { epoch: { ...epoch, collectorIncarnation: 'foreign' }, start: 20, end: 32 } }]) {
    expect(bkReplayValid({ ...two, records: [...bkReplay.records, makeEntry(patch)] })).toBe(false);
  }
  const giant = makeEntry({ range: { epoch, start: 8, end: 8 + 16385 },
    payload: { kind: 'bytes', bytes: Array(16385).fill(65) } });
  expect(bkReplayValid({ ...bkReplay, records: [giant], next: giant.ack.through },
    { maxRecords: 1, maxRawBytes: 65536, maxSerializedBytes: 258048 })).toBe(false);
});

// BK debt (review MINOR-1/MINOR-3): every case below changes ONE input so that
// exactly one refusal condition decides it. The K mutants named "bk-sole-*"
// delete that condition alone and must turn the matching case green.
const bkSoleEpoch = { ...epoch, collectorIncarnation: 'collector-sole' };
const bkSolePaneEpoch = { ...epoch, pane: kOtherPane };
const bkSoleCap = 8 + V2.NEWARCH_V2_PREFIX_LIMITS.maxRawBytes;
const bkSoleAt = (byteOffset: number): V2.V2LiveCheckpoint => ({ ...kPrefixCheckpoint, through: { epoch, byteOffset } });
const bkSoleRecord = { ...spoolAck, through: kPrefixCheckpoint.through };
const bkSoleBatch: readonly { readonly name: string; readonly input: V2.V2BatchInput;
  readonly previous?: V2.V2LiveCheckpoint; readonly checkpoint?: V2.V2LiveCheckpoint }[] = [
  { name: 'batch previous epoch', input: kSource, previous: { ...v2Checkpoint,
    through: { epoch: bkSoleEpoch, byteOffset: 8 }, replayFloor: { epoch: bkSoleEpoch, byteOffset: 4 } } },
  { name: 'batch certified epoch', input: kSignSource({ certified: { epoch: bkSolePaneEpoch, start: 8, end: 14 } }) },
  { name: 'batch source epoch', input: kSignSource({ sourceEpoch: V2.v2SourceEpochOf(bkSoleEpoch) }) },
  { name: 'batch zero progress', input: kSignSource({ certified: { epoch, start: 14, end: 14 } }),
    previous: kPrefixCheckpoint, checkpoint: kPrefixCheckpoint },
  { name: 'batch raw cap', input: kSignSource({ certified: { epoch, start: 8, end: bkSoleCap + 1 }, lastRecordEnd: bkSoleCap + 1 }),
    checkpoint: bkSoleAt(bkSoleCap + 1) },
  { name: 'batch prefix schema', input: kSignSource({ schema: 'newarch-v1' as 'newarch-v2' }) },
  { name: 'batch last record end', input: kSignSource({ lastRecordEnd: 13 }) },
  { name: 'batch sequence order', input: kSignSource({ firstSequence: 2 }) },
  { name: 'batch record version', input: { ...bkSoleRecord, version: 2 as 1 } },
];
test('BK debt batch sole-condition controls are accepted once the one defect is removed', () => {
  expect(bkInput(kSource)).toBe(true);
  expect(bkInput(bkSoleRecord, bkSoleRecord)).toBe(true);
  // The raw-cap boundary itself is admissible, so the cap case fails only by one byte.
  const atCap = kSignSource({ certified: { epoch, start: 8, end: bkSoleCap }, lastRecordEnd: bkSoleCap });
  expect(bkInput(atCap, atCap, v2Checkpoint, bkSoleAt(bkSoleCap))).toBe(true);
  // Same source epoch, different pane: only certified.epoch can tell them apart.
  expect(V2.v2SourceEpochOf(bkSolePaneEpoch)).toEqual(V2.v2SourceEpochOf(epoch));
});
for (const c of bkSoleBatch) test(`BK debt sole: ${c.name} refuses`, () => {
  expect(bkInput(c.input, c.input, c.previous ?? v2Checkpoint, c.checkpoint ?? kPrefixCheckpoint)).toBe(false);
});

const bkSoleEntry = (bytes: readonly number[], ack: Partial<V2.SpoolAck> = {}): V2.V2ContainingRecord => {
  const unsigned = { ...bkRecordUnsigned, payload: { kind: 'bytes' as const, bytes } };
  const record = { ...unsigned, digest: V2.sourceSpoolDigest(unsigned) };
  return { record, ack: { ...bkRecordAck, recordDigest: record.digest, ...ack } };
};
const bkSoleBytes = (first: number) => [first, 66, 67, 68, 69, 70, 71, 72, 73, 74, 75, 76];
const bkSoleReplay: readonly { readonly name: string; readonly entry: V2.V2ContainingRecord }[] = [
  { name: 'replay ack kind', entry: bkSoleEntry(bkSoleBytes(65), { kind: 'source-prefix' as 'synced-spool' }) },
  { name: 'replay ack version', entry: bkSoleEntry(bkSoleBytes(65), { version: 2 as 1 }) },
  { name: 'replay ack commit id', entry: bkSoleEntry(bkSoleBytes(65), { commitId: 'other-commit' }) },
  { name: 'replay ack record digest', entry: { ...bkSoleEntry(bkSoleBytes(65)), ack: { ...bkRecordAck, recordDigest: 'b'.repeat(64) } } },
  { name: 'replay byte above 255', entry: bkSoleEntry(bkSoleBytes(256)) },
  { name: 'replay byte below 0', entry: bkSoleEntry(bkSoleBytes(-1)) },
  { name: 'replay byte not integer', entry: bkSoleEntry(bkSoleBytes(65.5)) },
];
test('BK debt replay sole-condition controls: the re-signed record itself is accepted', () => {
  const clean = bkSoleEntry(bkSoleBytes(65));
  expect(clean.record).toEqual(bkRecord);
  expect(bkReplayValid({ ...bkReplay, records: [clean] })).toBe(true);
  for (const edge of [0, 255]) expect(bkReplayValid({ ...bkReplay, records: [bkSoleEntry(bkSoleBytes(edge))] })).toBe(true);
});
for (const c of bkSoleReplay) test(`BK debt sole: ${c.name} refuses`, () => {
  expect(bkReplayValid({ ...bkReplay, records: [c.entry] })).toBe(false);
});

const bkSoleRearm: readonly { readonly name: string; readonly receipt: V2.V2Receipt }[] = [
  { name: 'rearm receipt schema', receipt: { ...v2Receipt, schema: 'newarch-v1' as 'newarch-v2' } },
  { name: 'rearm receipt kind', receipt: { ...v2Receipt, kind: 'synced-spool' as 'ssot-durable' } },
];
for (const c of bkSoleRearm) test(`BK debt sole: ${c.name} refuses`, () => {
  expect(bkRearm({ ...bkObservation, resolvedReceipt: c.receipt }, c.receipt)).toBe(false);
});

// MINOR-3: there is no product checker for the budget-required arm. Pin what the
// exported contract decides about it: never a successful records reply, its
// minimum must fit the hard caps, and the hard caps always fit one worst-case
// whole record, so a conforming minimum can never ask for more than exists.
test('BK debt budget-required arm is a refusal whose minimum fits the hard caps', () => {
  const hard: V2.V2ContainingReplayBudget = { maxRecords: V2.V2_CONTAINING_REPLAY_LIMITS.maxRecords,
    maxRawBytes: V2.V2_CONTAINING_REPLAY_LIMITS.maxRawBytes, maxSerializedBytes: V2.V2_CONTAINING_REPLAY_LIMITS.maxSerializedBytes };
  const minimum: V2.V2ContainingReplayBudget = { maxRecords: 1, maxRawBytes: 12, maxSerializedBytes: 4096 };
  const reply: V2.V2ContainingReplay = { schema: 'newarch-v2', kind: 'budget-required', requested: bkReplay.requested, minimum };
  expect(V2.v2ContainingReplayBudgetValid(minimum)).toBe(true);
  expect(V2.v2ContainingReplayBudgetValid(hard)).toBe(true);
  for (const budget of [bkBudget, minimum, hard]) expect(V2.v2ContainingReplayRecordsValid(reply, bkReplay.requested, budget)).toBe(false);
  for (const over of [{ ...minimum, maxRecords: hard.maxRecords + 1 }, { ...minimum, maxRawBytes: hard.maxRawBytes + 1 },
    { ...minimum, maxSerializedBytes: hard.maxSerializedBytes + 1 }, { ...minimum, maxRecords: 0 }])
    expect(V2.v2ContainingReplayBudgetValid(over)).toBe(false);
  const size = V2.V2_CONTAINING_REPLAY_LIMITS.recordBytes;
  const unsigned: Omit<V2.SpoolRecord, 'digest'> = { ...bkRecordUnsigned, range: { epoch, start: 8, end: 8 + size },
    payload: { kind: 'bytes', bytes: Array(size).fill(255) } };
  const record = { ...unsigned, digest: V2.sourceSpoolDigest(unsigned) };
  const worst: V2.V2ContainingReplay = { ...bkReplay, records: [{ record, ack: { ...bkRecordAck,
    through: { epoch, byteOffset: 8 + size }, recordDigest: record.digest } }], next: { epoch, byteOffset: 8 + size } };
  expect(V2.v2ContainingReplayRecordsValid(worst, bkReplay.requested, { ...hard, maxRecords: 1, maxRawBytes: size })).toBe(true);
});

export function compileBKPorts(issued: V2.V2IssuedInputAuthority, replay: V2.V2ContainingReplayPort,
  h: V2.V2HistoryAuthority) {
  const batch: V2.V2Batch = { rows: kRows, decisions: [], incidents: [], checkpoint: kPrefixCheckpoint, input: kSource };
  const input: V2.Result<V2.V2BatchInput | null> = issued.inputReceipt(batch.input);
  const observation: V2.Result<V2.V2ReserveRearmObservation | null> = h.reserveRearm(pane, v2Incident.incidentId, bkGeneration);
  return [input, observation, replay.replayContaining(binding, bkReplay.requested, bkBudget)];
}
export function negativeBKTypes(authority: V2.V2IssuedInputAuthority) {
  // @ts-expect-error Read-only port has no caller-controlled receipt insertion.
  authority.note(kSource);
  // @ts-expect-error Prefix input is not a record ACK.
  const recordAck: V2.SpoolAck = kSource;
  // @ts-expect-error Rearm observation is not a durable receipt.
  const durable: V2.V2Receipt = bkObservation;
  // @ts-expect-error Rearm observation is not trim authorization.
  const trim: V2.V2TrimAuthorization = bkObservation;
  // @ts-expect-error An issued-input port is synchronous, not an RPC.
  const asyncAuthority: V2.V2IssuedInputAuthority = { inputReceipt: async () => ({ status: 'ok', value: kSource }) };
  // @ts-expect-error Full replay records always carry a collector-issued record ACK.
  const noAck: V2.V2ContainingRecord = { record: bkRecord };
  return [recordAck, durable, trim, asyncAuthority, noAck];
}

// HS2 (PLAN §1.2 / §3.1): named storage profiles, allocation manifest, digest,
// page limit and the pure root ledger. H's use of them is in wave4 `HS2 …`.
const hs2MiB = 1048576;
const HS2_R_CANARY_DIGEST = '8da2747fa6d3d4c770facf5c262c47a86a223889d34ef510dc30022ddfd5266c';
const HS2_DEFAULT_DIGEST = '0637051ed4a6837378f1eb4b71e00ce198ff08cf0d56347b0d0f2795d04f752f';
const hs2R = V2.NEWARCH_V2_STORAGE_PROFILES['r-canary-8g'];
const hs2Default = V2.NEWARCH_V2_STORAGE_PROFILES['default-256m'];
const hs2RConfig: V2.V2Config = { ...v2Config, storage: hs2R.storage };
const hs2Ledger = (): V2.V2AllocationLedger => ({ version: 0, reserveUsedBytes: 0,
  used: { database: 0, wal: 0, raw: 0, staging: 0, diagnostic: 0, other: 0 } });
const hs2Reserve = (p: V2.V2StorageProfile, l: V2.V2AllocationLedger, cls: V2.V2AllocationRequest['cls'], bytes: number) =>
  V2.v2AllocationReserve(p, l, { expectedVersion: l.version, cls, bytes });
const hs2Take = (r: ReturnType<typeof V2.v2AllocationReserve>): V2.V2AllocationLedger => {
  if (!r.ok) throw Error('HS2 fixture expected ok, got ' + r.reason); return r.ledger;
};
test("HS2 default profile is the 256 MiB config and keeps H's page limit", () => {
  expect(hs2Default.storage).toBe(v2Config.storage);
  expect(hs2Default.allocation).toBeNull();
  expect([hs2Default.storage.rootCapBytes, hs2Default.storage.emergencyReserveBytes]).toEqual([256 * hs2MiB, 16 * hs2MiB]);
  // The pre-HS2 H formula was floor((rootCap-reserve)/8192) pages, independent of page size.
  expect(V2.v2DatabasePageLimit(hs2Default, 4096)).toBe(30720);
  expect(V2.v2DatabasePageLimit(hs2Default, 4096)).toBe(Math.floor((256 - 16) * hs2MiB / 8192));
  expect(V2.v2DatabasePageLimit(hs2Default, 8192)).toBe(15360);
  expect(V2.v2DatabasePageLimit(hs2Default, 1024)).toBe(122880);
  for (const bad of [0, 256, 3000, 131072, 4096.5]) expect(() => V2.v2DatabasePageLimit(hs2Default, bad)).toThrow();
  V2.validateV2StorageProfile(hs2Default, v2Config);
  const legacy = V2.v2LegacyStorageProfile(v2Config.storage);
  expect(legacy).toEqual({ name: 'legacy', storage: v2Config.storage, allocation: null });
  expect(V2.v2StorageProfileDigest(legacy)).toBe(V2.v2StorageProfileDigest(hs2Default));
});
test('HS2 r-canary-8g manifest sums inside the root and validates', () => {
  const s = hs2R.storage, a = hs2R.allocation!;
  expect(s).toEqual({ rootCapBytes: 8192 * hs2MiB, emergencyReserveBytes: 16 * hs2MiB, reservePerPaneBytes: 256 * 1024,
    reserveSharedBytes: 8 * hs2MiB, diagnosticCapBytes: 64 * hs2MiB, stagingCapBytes: 32 * hs2MiB });
  expect(a).toEqual({ databaseBytes: 4088 * hs2MiB, walBytes: 1024 * hs2MiB, rawBytes: 128 * hs2MiB,
    stagingBytes: 32 * hs2MiB, diagnosticBytes: 64 * hs2MiB, otherBytes: 64 * hs2MiB });
  const sum = Object.values(a).reduce((x, y) => x + y, 0);
  expect([sum, sum + s.emergencyReserveBytes, s.rootCapBytes - s.emergencyReserveBytes - sum]).toEqual([5400 * hs2MiB, 5416 * hs2MiB, 2776 * hs2MiB]);
  expect(V2.v2DatabasePageLimit(hs2R, 4096)).toBe(1046528);
  expect(V2.v2DatabasePageLimit(hs2R, 8192)).toBe(523264);
  V2.validateV2StorageProfile(hs2R, hs2RConfig);
  expect(V2.v2StorageAllowance(hs2RConfig, { databaseBytes: 0, rawBytes: 0, stagingBytes: 0, diagnosticBytes: 0,
    reservedDataBytes: 0, reserveAllocatedBytes: 0 }).dataBudgetBytes).toBe(8176 * hs2MiB);
  const bad = (allocation: Record<string, number>) => () => V2.validateV2StorageProfile({ ...hs2R, allocation: allocation as unknown as V2.V2AllocationManifest }, hs2RConfig);
  // WAL alone pushes the total one byte past the data budget; every other class still fits.
  expect(bad({ ...a, walBytes: (8176 - 5400 + 1024) * hs2MiB + 1 })).toThrow('v2 storage profile');
  expect(bad({ ...a, walBytes: (8176 - 5400 + 1024) * hs2MiB })).not.toThrow();
  expect(bad({ ...a, stagingBytes: 16 * hs2MiB })).toThrow('v2 storage profile');
  expect(bad({ ...a, diagnosticBytes: 32 * hs2MiB })).toThrow('v2 storage profile');
  expect(bad({ ...a, databaseBytes: hs2MiB - 1 })).toThrow('v2 storage profile');
  expect(bad({ ...a, otherBytes: 0 })).toThrow('v2 storage profile');
  expect(bad({ ...a, extraBytes: 1 })).toThrow('v2 storage profile');
  expect(() => V2.validateV2StorageProfile({ ...hs2R, storage: { ...s, emergencyReserveBytes: 4 * hs2MiB } }, hs2RConfig)).toThrow('v2 storage profile');
});
test('HS2 profile digest binds storage and allocation, not geometry', () => {
  const digest = V2.v2StorageProfileDigest(hs2R), defaultDigest = V2.v2StorageProfileDigest(hs2Default);
  // Pinned: R manifests and HS3 startup compare these exact values.
  expect({ digest, defaultDigest }).toEqual({ digest: HS2_R_CANARY_DIGEST, defaultDigest: HS2_DEFAULT_DIGEST });
  expect(V2.v2StorageProfileDigest({ ...hs2R, allocation: { ...hs2R.allocation!, walBytes: 512 * hs2MiB } })).not.toBe(digest);
  expect(V2.v2StorageProfileDigest({ ...hs2R, allocation: null })).not.toBe(digest);
  expect(V2.v2StorageProfileDigest({ ...hs2R, storage: { ...hs2R.storage, stagingCapBytes: 16 * hs2MiB } })).not.toBe(digest);
  expect(V2.v2StorageProfileDigest({ ...hs2R, name: 'renamed' })).toBe(digest);
  // A config differing only in geometry/configVersion/rules yields the same profile digest.
  const edited: V2.V2Config = { ...v2Config, configVersion: 'edited-geometry', geometry: { columns: 100, rows: 40 },
    rules: [{ ruleId: 'ordered-scroll', version: '2' }] };
  V2.validateV2StorageProfile(V2.v2LegacyStorageProfile(edited.storage), edited);
  expect(V2.v2StorageProfileDigest(V2.v2LegacyStorageProfile(edited.storage))).toBe(defaultDigest);
  expect(V2.v2StorageProfileDigest(V2.v2LegacyStorageProfile({ ...v2Config.storage, rootCapBytes: 512 * hs2MiB }))).not.toBe(defaultDigest);
});
test('HS2 ledger refuses stale versions, per-class overflow, data budget and normal use of the reserve', () => {
  // Two writers read version 0; the first reserves, the second must re-read.
  const start = hs2Ledger(), first = hs2Take(hs2Reserve(hs2R, start, 'database', hs2MiB));
  expect(first.version).toBe(1); expect(start.used.database).toBe(0);
  expect(V2.v2AllocationReserve(hs2R, first, { expectedVersion: 0, cls: 'wal', bytes: 1 })).toEqual({ ok: false, reason: 'stale-ledger' });
  // The class cap is per ROOT: 21 panes each asking DB/21+1 bytes overflow it by 7 bytes.
  const share = Math.floor(hs2R.allocation!.databaseBytes / 21) + 1;
  let ledger = hs2Ledger(); const outcomes: string[] = [];
  for (let pane = 0; pane < 21; pane++) {
    const r = hs2Reserve(hs2R, ledger, 'database', share); outcomes.push(r.ok ? 'ok' : r.reason); if (r.ok) ledger = r.ledger;
  }
  expect(outcomes).toEqual([...Array(20).fill('ok'), 'class-cap']);
  expect(ledger.used.database).toBe(20 * share);
  expect(hs2Reserve(hs2R, hs2Ledger(), 'wal', 1024 * hs2MiB + 1)).toEqual({ ok: false, reason: 'class-cap' });
  // Legacy (default): the database gets half, other classes share the data budget, never the reserve.
  expect(hs2Reserve(hs2Default, hs2Ledger(), 'database', 120 * hs2MiB + 1)).toEqual({ ok: false, reason: 'class-cap' });
  let full = hs2Take(hs2Reserve(hs2Default, hs2Ledger(), 'wal', 240 * hs2MiB - 1));
  expect(hs2Reserve(hs2Default, full, 'raw', 2)).toEqual({ ok: false, reason: 'data-budget' });
  full = hs2Take(hs2Reserve(hs2Default, full, 'raw', 1));
  expect(hs2Reserve(hs2Default, full, 'other', 1)).toEqual({ ok: false, reason: 'data-budget' });
  // Only an emergency spends the reserve, up to 16 MiB.
  const emergency = hs2Take(hs2Reserve(hs2Default, full, 'emergency', 16 * hs2MiB));
  expect(emergency.reserveUsedBytes).toBe(16 * hs2MiB); expect(emergency.used).toEqual(full.used);
  expect(hs2Reserve(hs2Default, emergency, 'emergency', 1)).toEqual({ ok: false, reason: 'reserve' });
  expect(() => hs2Reserve(hs2R, hs2Ledger(), 'database', 0)).toThrow();
});

// H-PERF: v2WriteDigest's optional last parameter is the encoder of the
// caller's ONE call. Default callers (host, bridge, offload: one argument) get
// the same bytes as before; an encoder that already canonicalized the command
// gives the same digest, a fresh one too, and a stale memo of another call is
// exactly what H must never pass (it would hash old content).
test('HPERF v2WriteDigest default caller is byte-identical; a call-local encoder reuses its own memo only', () => {
  const body = { fence: v2Fence, command: { kind: 'incident' as const, incident: { ...v2Incident } } };
  const plain = V2.v2WriteDigest(body);
  expect(plain).toBe(V2.v2Digest('write', { pane: v2Fence.pane, operationId: v2Fence.operationId, command: body.command }));
  expect(V2.v2WriteDigest(body, V2.streamCanonicalEncoder())).toBe(plain);
  const encode = V2.streamCanonicalEncoder(); encode(body.command);
  expect(V2.v2WriteDigest(body, encode)).toBe(plain);
  (body.command.incident as { incidentId: string }).incidentId = 'edited-after-encode';
  expect(V2.v2WriteDigest(body)).not.toBe(plain);
  expect(V2.v2WriteDigest(body, encode)).toBe(plain); // the memo is call-local by contract
});
