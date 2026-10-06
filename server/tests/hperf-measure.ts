/**
 * H-PERF lot A: paired timing of H's V2 batch commit, base (A) versus HEAD (B).
 *
 * Not a gate and not a `*.test.ts`: no suite discovers it. Run it alone in the
 * cage: `bun test ./packages/thumbmux/server/tests/hperf-measure.ts`.
 *
 * Protocol (fixed in commit C1, before any change to H or SC):
 * - two scratch copies of server/src + core/src under tmpdir(); A overwrites H
 *   and SC with the byte copies of the base in tests/hperf-baseline/, B keeps
 *   HEAD. Both load the same way and differ only in the bytes of H and SC.
 * - 5 blocks in the order AB, BA, AB, BA, AB; each (block, variant) is one
 *   child process on a fresh synthetic root: 8 warm-up + 24 measured full
 *   pages of the real decoder (77 rows, ~2 MiB rows, ~653 KB live checkpoint).
 *   Children run one at a time, never in parallel.
 * - the H timer covers only `writer.commit`; the decoder, the S stub and the
 *   host's write digest run outside it (the digest has its own timer, for the
 *   host-equivalent digest+H number).
 * - every sample is printed raw (`HPERF_SAMPLE`); nothing is dropped. The
 *   verdict (`HPERF_VERDICT`) is printed, never asserted: the REPORT decides.
 * - after the blocks: one fixed-cost round per variant (1 row, 0 rows, one
 *   checkpoint command) and one profile run of B with H's observer on
 *   (exclusive spans), kept apart from the acceptance samples.
 * Assertions here are structural only: identity of the base copies, child
 * exits, sample counts and an equal logical oracle (rows, live checkpoint,
 * receipts without their random commitId) for A and B in every block.
 */
import { test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { inflateSync } from 'node:zlib';
import { createV2HistoryFactory } from '../src/history-engine';
import { evaluateV2Prefix, v2BirthCheckpoint } from '../src/capture-engine';
import * as HS from '../src/stream-contract';

const BASE = Object.freeze({ commit: '7cfde7f991dc2d215f8eb8b6a92db911b64a7fad',
  h: '984a5a92ec197dc2228872976ada765d15f43af5ac94b1f1e1e2d3f24a9285ad',
  sc: '9552839b0f8a8c012031966181e99532dab6d9f964840feb9b60de3358d7b51a' });
const ORDER = ['AB', 'BA', 'AB', 'BA', 'AB'] as const;
const WARM = 8, MEASURED = 24, MiB = 1024 * 1024;
// 34-character identity suffix: the real decoder then cuts a page at 77 rows,
// ~2.09 MB of row canonical and a ~653 KB live checkpoint (the B2 burst shape).
const ID = '0123456789abcdef0123456789abcdef01';
const sha = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2; };
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
// Nearest-rank p95 of all pooled samples.
const p95 = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil(0.95 * s.length) - 1)]!; };
const round = (x: number) => Math.round(x * 1000) / 1000;

type Sample = { variant: string; block: number; page: number; rows: number; rowsBytes: number; cpBytes: number; hMs: number; digestMs: number };
type Profile = { page: number; hMs: number; canonicalMs: number; decodeMs: number; packMs: number; commitMs: number; otherMs: number;
  rowEncodes: number; checkpointDecodes: number; profiled: boolean };

/** One variant on one fresh root. Prints HPERF_* lines; throws on any refusal. */
async function bench(variant: string, block: number, mode: string): Promise<void> {
  const value = <T>(r: HS.Result<T>): T => { if (r.status !== 'ok') throw Error(JSON.stringify(r).slice(0, 2000)); return r.value; };
  const here = resolve(import.meta.dir, '../src');
  console.log('HPERF_LOADED ' + JSON.stringify({ variant, block, mode, bun: Bun.version,
    h: sha(readFileSync(join(here, 'history-engine.ts'))), sc: sha(readFileSync(join(here, 'stream-contract.ts'))) }));
  const root = mkdtempSync(join(tmpdir(), `hperf-${variant}-${block}-${mode}-`));
  const config = HS.NEWARCH_V2_DEFAULT_CONFIG, geometry = HS.v2BirthGeometry(config);
  const pane = { serverIdentity: 'hperf-server-' + ID, paneId: '%1', birthGeneration: 1 };
  const session = { serverIdentity: pane.serverIdentity, sessionId: 'hperf' };
  const descriptor = { schema: 'newarch-v2' as const, session, pane, windowId: '@1', owner: 'capture-engine' as const, birthOperationId: 'hperf-birth', geometry, state: 'active' as const };
  const epoch = { pane, attachId: 'attach-' + ID, collectorIncarnation: 'collector-' + ID };
  // S-issued input stub, separate from the caller: H reads back what S issued.
  const issued = new Map<string, HS.V2BatchInput>();
  // Observer events of one commit (profile mode only; A's H has no observer).
  let events: { kind: string; rows?: number; canonicalMs?: number; decodeMs?: number; packMs?: number; commitMs?: number }[] = [];
  const hooks = { inputReceipt: (input: HS.V2BatchInput) => ({ status: 'ok' as const, value: issued.get(HS.streamCanonical(input)) ?? null }),
    ...(mode === 'profile' ? { observe: (event: { kind: string }) => { events.push(event); } } : {}) };
  const factory = createV2HistoryFactory(hooks as Parameters<typeof createV2HistoryFactory>[0]);
  const port = value(await factory.openForCapture({ rootId: root, engineId: 'hperf', config }));
  let durable = 0, operation = 0;
  const commit = async (command: HS.V2WriteCommand) => {
    const fence = { pane, operationId: 'hperf-op-' + operation++, expectedGeneration: port.capability.generation, expectedRevision: durable };
    const d0 = performance.now(); const digest = HS.v2WriteDigest({ fence, command }); const digestMs = performance.now() - d0;
    events = [];
    const h0 = performance.now(); const result = await port.writer.commit(port.capability, { fence: { ...fence, digest }, command });
    const hMs = performance.now() - h0;
    const receipt = value(result); durable = receipt.revision;
    return { hMs, digestMs, receipt };
  };
  const intent: HS.V2BirthIntent = { schema: 'newarch-v2', operationId: 'hperf-birth', session, geometry, command: 'new-session', owner: 'capture-engine' };
  let cp = v2BirthCheckpoint(descriptor, { epoch, byteOffset: 0 });
  let pending: number[] = [], line = 0, segment = 0, segmentBytes = 0, inputs = 0;
  /** The next decoder prefix as a batch command (outside every timer). */
  const plan = (bytes: number[] | null) => {
    if (bytes === null) {
      if (segmentBytes + 2 * MiB + 4096 > 8 * MiB) { segment++; segmentBytes = 0; }
      while (pending.reduce((n, b) => n + (b === 10 ? 1 : 0), 0) < 256) {
        let chunk = ''; for (let j = 0; j < 256; j++) chunk += `B${String(line++).padStart(5, '0')}\r\n`;
        pending = [...pending, ...Buffer.from(chunk)];
      }
    }
    const raw = bytes ?? pending, segmentId = 'hperf-seg-' + segment, start = cp.through.byteOffset;
    const r = evaluateV2Prefix({ pane: descriptor, checkpoint: cp, raw: { epoch, start, end: start + raw.length }, bytes: raw,
      observedAtMonoMs: 1, pendingSinceMonoMs: null }, config, { wallMs: 0, clockEpoch: 'replay', durableRevision: durable,
      rowTarget: { segmentId, nextRowOrdinal: cp.frontier?.segmentId === segmentId ? cp.frontier.rowOrdinal + 1 : 0 } });
    if ('kind' in r) throw Error('decoder gap ' + JSON.stringify(r).slice(0, 400));
    const input: HS.V2BatchInput = { kind: 'synced-spool', version: 1, through: r.checkpoint.through, recordDigest: 'b'.repeat(64),
      commitId: 'hperf-in-' + inputs++, segmentId: 'raw-1' };
    issued.set(HS.streamCanonical(input), input);
    const rowsBytes = Buffer.byteLength(HS.streamCanonical(r.rows)), cpBytes = Buffer.byteLength(HS.streamCanonical(r.checkpoint));
    const command: HS.V2WriteCommand = { kind: 'batch', batch: { rows: r.rows, decisions: [], incidents: [], checkpoint: r.checkpoint, input } };
    return { command, rows: r.rows.length, rowsBytes, cpBytes, apply: () => {
      cp = r.checkpoint; if (bytes === null) pending = pending.slice(r.consumed.end - r.consumed.start);
      segmentBytes += rowsBytes;
    } };
  };
  const disk = () => {
    const size = (name: string) => existsSync(join(root, name)) ? statSync(join(root, name)).size : 0;
    return { dbBytes: size('flag-on-v1.sqlite'), walBytes: size('flag-on-v1.sqlite-wal') };
  };
  try {
    value(await port.writer.reserveBirth(port.capability, { intent, expectedGeneration: port.capability.generation, digest: HS.v2Digest('birth-reservation', { intent }) }));
    const ready: HS.V2BirthReady = { intent, pane: descriptor, binding: { kind: 'collector-binding', epoch, attachId: epoch.attachId, rootUUID: 'hperf-root',
      bootNonce: 'boot', ownerGeneration: 1, process: { pid: 123, startTime: '1', bootId: 'synthetic' }, peerUid: 1000, fifoId: 'fifo', handshakeId: 'h',
      artifactSha256: 'a'.repeat(64) }, byte0: { epoch, byteOffset: 0 }, journal: { path: '/synthetic/birth', bytes: 1, sha256: 'a'.repeat(64) },
      geometryReadback: { columns: geometry.columns, rows: geometry.rows }, paneCountInWindow: 1, programHeld: true };
    await commit({ kind: 'activate', ready, checkpoint: cp });
    const pages = mode === 'fixed' ? WARM : WARM + MEASURED;
    for (let k = 0; k < pages; k++) {
      const p = plan(null);
      const { hMs, digestMs } = await commit(p.command); p.apply();
      if (k < WARM) continue;
      const sample: Sample = { variant, block, page: k - WARM, rows: p.rows, rowsBytes: p.rowsBytes, cpBytes: p.cpBytes, hMs: round(hMs), digestMs: round(digestMs) };
      if (mode === 'acceptance') console.log('HPERF_SAMPLE ' + JSON.stringify(sample));
      if (mode === 'profile') {
        const at = events.find(e => e.kind === 'commit-profile');
        const spans = { canonicalMs: at?.canonicalMs ?? 0, decodeMs: at?.decodeMs ?? 0, packMs: at?.packMs ?? 0, commitMs: at?.commitMs ?? 0 };
        const profile: Profile = { page: k - WARM, hMs: round(hMs), ...spans,
          otherMs: round(hMs - spans.canonicalMs - spans.decodeMs - spans.packMs - spans.commitMs),
          rowEncodes: events.reduce((n, e) => n + (e.kind === 'row-encode' ? e.rows ?? 0 : 0), 0),
          checkpointDecodes: events.filter(e => e.kind === 'checkpoint-decode').length, profiled: !!at };
        console.log('HPERF_PROFILE ' + JSON.stringify({ variant, rows: p.rows, ...profile }));
      }
    }
    if (mode === 'fixed') {
      // Fixed cost of one commit: 1 row, 0 rows (a lone SGR finalizes nothing),
      // then a checkpoint command at unchanged raw positions; each with the full checkpoint.
      const nl = pending.indexOf(10), one = plan(pending.slice(0, nl + 1));
      const r1 = await commit(one.command); one.apply(); pending = pending.slice(nl + 1);
      const zero = plan([...Buffer.from('\x1b[0m')]);
      const r0 = await commit(zero.command); zero.apply();
      const r2 = await commit({ kind: 'checkpoint', checkpoint: { ...cp, checkpointId: cp.checkpointId + '-hperf-fixed', revision: durable + 1 } });
      for (const [kind, rows, r] of [['one-row', one.rows, r1], ['zero-row', zero.rows, r0], ['checkpoint', 0, r2]] as const)
        console.log('HPERF_FIXED ' + JSON.stringify({ variant, kind, rows, cpBytes: one.cpBytes, hMs: round(r.hMs), digestMs: round(r.digestMs) }));
    }
    const live = disk();
    value(await port.writer.close(port.capability));
    // Logical oracle over what H stored: every timeline record decoded to its
    // canonical payload, the live checkpoint and every receipt minus commitId.
    const db = new Database(join(root, 'flag-on-v1.sqlite'), { readonly: true });
    try {
      const text = (payload: string | Uint8Array) => typeof payload === 'string' ? payload : inflateSync(payload.subarray(4)).toString('utf8');
      const timeline = createHash('sha256');
      for (const r of db.query('SELECT n,revision,kind,id,segment,payload FROM fh_v2_timeline ORDER BY pane,n').all() as { n: number; revision: number; kind: string; id: string; segment: string; payload: string | Uint8Array }[])
        timeline.update(JSON.stringify([r.n, r.revision, r.kind, r.id, r.segment, text(r.payload)]) + '\n');
      const objects = db.query("SELECT kind,id,payload FROM fh_v2_object WHERE kind IN ('checkpoint','receipt','segment-stats') ORDER BY kind,pane,id").all() as { kind: string; id: string; payload: string | Uint8Array }[];
      const object = createHash('sha256');
      for (const r of objects) {
        const value = JSON.parse(text(r.payload)) as Record<string, unknown>;
        object.update(JSON.stringify([r.kind, r.id, HS.streamCanonical(r.kind === 'receipt' ? { ...value, commitId: null } : value)]) + '\n');
      }
      const pragma = (name: string) => Object.values(db.query(`PRAGMA ${name}`).get() as Record<string, unknown>)[0];
      console.log('HPERF_ORACLE ' + JSON.stringify({ variant, block, mode, revision: durable, timeline: timeline.digest('hex'), objects: object.digest('hex') }));
      console.log('HPERF_DISK ' + JSON.stringify({ variant, block, mode, live, closed: disk(), journal: pragma('journal_mode'), pageSize: pragma('page_size'),
        pageCount: pragma('page_count'), walAutocheckpoint: pragma('wal_autocheckpoint'), synchronousOfThisReader: pragma('synchronous') }));
    } finally { db.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
}

if (process.env.HPERF_CHILD === '1') {
  test('HPERF bench child', async () => {
    await bench(process.env.HPERF_VARIANT!, Number(process.env.HPERF_BLOCK), process.env.HPERF_MODE!);
  }, 600_000);
} else {
  const pkg = resolve(import.meta.dir, '../..'), baseline = join(import.meta.dir, 'hperf-baseline');
  test('HPERF baseline identity', () => {
    expect(sha(readFileSync(join(baseline, 'history-engine.ts.txt'))), 'HPERF baseline identity H').toBe(BASE.h);
    expect(sha(readFileSync(join(baseline, 'stream-contract.ts.txt'))), 'HPERF baseline identity SC').toBe(BASE.sc);
  });

  test('HPERF paired protocol: 5 AB/BA blocks of 24 full pages, fixed cost and one profile run of B', async () => {
    expect(sha(readFileSync(join(baseline, 'history-engine.ts.txt')))).toBe(BASE.h);
    expect(sha(readFileSync(join(baseline, 'stream-contract.ts.txt')))).toBe(BASE.sc);
    const head = { h: sha(readFileSync(join(pkg, 'server/src/history-engine.ts'))), sc: sha(readFileSync(join(pkg, 'server/src/stream-contract.ts'))) };
    console.log('HPERF_RUN ' + JSON.stringify({ bun: Bun.version, bunSha256: sha(readFileSync(process.execPath)), base: BASE, head, order: ORDER, warm: WARM, measured: MEASURED }));
    const scratch: Record<string, string> = {};
    try {
      for (const variant of ['A', 'B']) {
        const root = mkdtempSync(join(tmpdir(), 'hperf-scratch-' + variant + '-'));
        cpSync(join(pkg, 'server/src'), join(root, 'server/src'), { recursive: true });
        mkdirSync(join(root, 'server/tests'), { recursive: true });
        cpSync(join(import.meta.dir, 'hperf-measure.ts'), join(root, 'server/tests/hperf-measure.ts'));
        const core = join(root, 'node_modules/@thumbmux/core'); mkdirSync(core, { recursive: true });
        cpSync(join(pkg, 'core/src'), join(core, 'src'), { recursive: true });
        writeFileSync(join(core, 'package.json'), '{"name":"@thumbmux/core","type":"module","exports":"./src/index.ts"}');
        writeFileSync(join(root, 'package.json'), '{"type":"module"}');
        if (variant === 'A') {
          writeFileSync(join(root, 'server/src/history-engine.ts'), readFileSync(join(baseline, 'history-engine.ts.txt')));
          writeFileSync(join(root, 'server/src/stream-contract.ts'), readFileSync(join(baseline, 'stream-contract.ts.txt')));
        }
        scratch[variant] = root;
      }
      const expected: Record<string, { h: string; sc: string }> = { A: { h: BASE.h, sc: BASE.sc }, B: head };
      const child = async (variant: string, block: number, mode: string) => {
        const proc = Bun.spawn([process.execPath, 'test', './server/tests/hperf-measure.ts', '--test-name-pattern', '^HPERF bench child$'], {
          cwd: scratch[variant]!, stdout: 'pipe', stderr: 'pipe',
          env: { ...process.env, HPERF_CHILD: '1', HPERF_VARIANT: variant, HPERF_BLOCK: String(block), HPERF_MODE: mode } });
        const [exit, out, err] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
        const lines = out.split('\n').filter(l => l.startsWith('HPERF_'));
        for (const l of lines) console.log(l);
        expect({ variant, block, mode, exit, tail: exit === 0 ? '' : (out + err).slice(-3000) }).toEqual({ variant, block, mode, exit: 0, tail: '' });
        expect(err + out).toMatch(/\b1 pass\b/);
        const parse = (tag: string) => lines.filter(l => l.startsWith(tag + ' ')).map(l => JSON.parse(l.slice(tag.length + 1)));
        const loaded = parse('HPERF_LOADED')[0];
        expect({ h: loaded.h, sc: loaded.sc }).toEqual(expected[variant]!);
        return { samples: parse('HPERF_SAMPLE') as Sample[], oracle: parse('HPERF_ORACLE')[0], disk: parse('HPERF_DISK')[0],
          fixed: parse('HPERF_FIXED'), profile: parse('HPERF_PROFILE') as (Profile & { rows: number })[] };
      };
      const blocks: { block: number; order: string; A: Sample[]; B: Sample[] }[] = [];
      for (let block = 0; block < ORDER.length; block++) {
        const got: Record<string, Awaited<ReturnType<typeof child>>> = {};
        for (const variant of ORDER[block]!) got[variant] = await child(variant, block, 'acceptance');
        expect(got.A!.samples.length).toBe(MEASURED); expect(got.B!.samples.length).toBe(MEASURED);
        // Same logical result from both variants, every block.
        expect({ timeline: got.B!.oracle.timeline, objects: got.B!.oracle.objects, revision: got.B!.oracle.revision })
          .toEqual({ timeline: got.A!.oracle.timeline, objects: got.A!.oracle.objects, revision: got.A!.oracle.revision });
        blocks.push({ block, order: ORDER[block]!, A: got.A!.samples, B: got.B!.samples });
        for (const variant of ['A', 'B'] as const) {
          const s = got[variant]!.samples;
          console.log('HPERF_BLOCK ' + JSON.stringify({ block, order: ORDER[block], variant, n: s.length, meanH: round(mean(s.map(x => x.hMs))),
            meanDigest: round(mean(s.map(x => x.digestMs))), meanHostEquivalent: round(mean(s.map(x => x.hMs + x.digestMs))),
            p95H: round(p95(s.map(x => x.hMs))), minH: Math.min(...s.map(x => x.hMs)), maxH: Math.max(...s.map(x => x.hMs)),
            rows: [...new Set(s.map(x => x.rows))], disk: got[variant]!.disk }));
        }
      }
      for (const variant of ['A', 'B']) await child(variant, ORDER.length, 'fixed');
      const profile = await child('B', ORDER.length, 'profile');
      const p = profile.profile;
      const sum = (k: keyof Profile) => round(p.reduce((n, x) => n + (x[k] as number), 0));
      console.log('HPERF_DECOMPOSITION ' + JSON.stringify({ variant: 'B', pages: p.length, profiled: p.every(x => x.profiled), meanH: round(sum('hMs') / p.length),
        canonicalMs: round(sum('canonicalMs') / p.length), checkpointDecodeMs: round(sum('decodeMs') / p.length), packMs: round(sum('packMs') / p.length),
        sqlAndOtherMs: round(sum('otherMs') / p.length), commitMs: round(sum('commitMs') / p.length),
        rowEncodesPerRow: round(sum('rowEncodes') / p.reduce((n, x) => n + x.rows, 0)), checkpointDecodesPerPage: round(sum('checkpointDecodes') / p.length) }));
      // Verdict over raw samples (printed, decided in the REPORT).
      const means = (v: 'A' | 'B') => blocks.map(b => mean(b[v].map(x => x.hMs)));
      const noise = (v: 'A' | 'B') => Math.max(...means(v)) / Math.min(...means(v));
      const pooledB = blocks.flatMap(b => b.B.map(x => x.hMs));
      const ratios = blocks.map(b => mean(b.B.map(x => x.hMs)) / mean(b.A.map(x => x.hMs)));
      const hostB = blocks.map(b => mean(b.B.map(x => x.hMs + x.digestMs)));
      const verdict = { samples: blocks.length * MEASURED * 2, medianBlockMeanB: round(median(means('B'))), pooledP95B: round(p95(pooledB)),
        maxBlockMeanB: round(Math.max(...means('B'))), medianRatio: round(median(ratios)), ratios: ratios.map(round),
        maxHostEquivalentB: round(Math.max(...hostB)), noiseA: round(noise('A')), noiseB: round(noise('B')),
        blockMeansA: means('A').map(round), blockMeansB: means('B').map(round) };
      const valid = verdict.noiseA <= 1.2 && verdict.noiseB <= 1.2;
      const criteria = { medianBlockMean: verdict.medianBlockMeanB <= 125, pooledP95: verdict.pooledP95B <= 150, everyBlockMean: verdict.maxBlockMeanB <= 150,
        pairedRatio: verdict.medianRatio <= 0.5, hostEquivalent: verdict.maxHostEquivalentB <= 150 };
      console.log('HPERF_VERDICT ' + JSON.stringify({ ...verdict, valid, criteria, result: !valid ? 'INCONCLUSIVE' : Object.values(criteria).every(Boolean) ? 'PASS' : 'FAIL' }));
      expect(verdict.samples).toBe(240);
    } finally { for (const root of Object.values(scratch)) rmSync(root, { recursive: true, force: true }); }
  }, 1_500_000);
}
