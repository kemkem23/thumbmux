import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, openSync, readSync, closeSync, fstatSync } from 'node:fs';
import { tmpdir, cpus } from 'node:os';
import { join } from 'node:path';

import { HistoryCalibrator, type CalibrationCapture, type CalibrationFrame, type CalibrationPorts, type CaptureMetadata } from '../src/history-calibrator';
import { equalHistoryRows, type HistoryRow, type CapturedRow } from '../src/history-row-matcher';
import { decodeTmuxCaptureRows, TmuxCaptureDecoder } from '../src/tmux-capture-normalize';

// One complete baseline/full/incremental round per cage command.
// Four concurrent private-server configurations, 60s window each mode.
// Every pane is driven by the real HistoryCalibrator: its own deadlines (via
// the schedule port) decide when and what to capture, including screen-only
// captures. The host side here is a deadline queue per server that runs every
// due pane in one timer tick and sends their captures as one tmux client.
// The parser model is fed from a real `pipe-pane` of the same pane, so, as in
// production, it trails tmux and can be AHEAD of a capture when read after it.
// CPU is split: calibrator (decode + matcher + remember + host batching),
// capture children (tmux client rusage), and test-only model/oracle work.
// Same release policy as terminal-wal-worker.test.ts LIVE_TMUX: CPU/load
// measurements belong to dedicated private-tmux runs, not GitHub release gates.
// Preserve all assertions locally and announce every held-out file in CI.
const releaseRunner = process.env.GITHUB_ACTIONS === 'true';
if (releaseRunner) console.warn(`[benchmark held out] ${import.meta.file}: run explicitly in the private-tmux measurement lane; shared runner capture deadlines are not a release criterion`);
describe.skipIf(releaseRunner)('NEWARCH L2-C private tmux CPU measurement', () => {
  const measurements = new Map<string, { server: number; caller: number }>();
  const procTicks = (pid: number) => {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return { own: Number(fields[11]) + Number(fields[12]), children: Number(fields[13]) + Number(fields[14]) };
  };
  const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
  const cpuMicros = () => { const u = process.cpuUsage(); return u.user + u.system; };
  // Sections are timed with the monotonic clock (µs) around synchronous code:
  // getrusage per section was thousands of ptrace stops per second in the cage.
  // For synchronous JS this is an upper bound of its CPU time.
  const spanMicros = () => performance.now() * 1000;
  // The cage runs bun under `strace -f`, which stops every syscall of bun,
  // tmux and the producers (FIX2: 300 -> 85 captures/min). Timing is printed
  // everywhere but only asserted when no tracer is attached.
  const tracerPid = Number(/^TracerPid:\s*(\d+)/m.exec(readFileSync('/proc/self/status', 'utf8'))?.[1] ?? 0);
  const active = false;
  const round = 2;
  for (const mode of ['baseline', 'full', 'incremental'] as const) {
    test(`60s round=${round} active=${active} capture=${mode} 1/21 panes 80x24/120x40`, async () => {
      const root = mkdtempSync(join(tmpdir(), 'newarch-c-cpu-'));
      const privateEnv = { ...process.env };
      delete privateEnv.TMUX; delete privateEnv.TMUX_PANE;
      const modelCache = new Map<string, HistoryRow>();
      // Oracle cells are interned here, apart from the decoder under test.
      const oracleCells = new Map<string, HistoryRow['cells'][number]>();
      const oracleCell = (cell: HistoryRow['cells'][number]) => {
        const key = JSON.stringify(cell);
        const old = oracleCells.get(key); if (old) return old;
        oracleCells.set(key, cell); return cell;
      };
      const modelRow = (id: number, cols: number): HistoryRow => {
        const key = `${cols}/${id}`;
        const old = modelCache.get(key); if (old) return old;
        const raw = id < 0 ? `seed-${String(id + 5000).padStart(6, '0')} ไทย 你 😀`
          : `\x1b[${31 + id % 7}mrow-${String(id).padStart(8, '0')} ไทย 你 😀\x1b[0m`;
        const row = { lineId: id, sourceEpoch: 1, geometryGeneration: 1, softWrap: false, cells: decodeTmuxCaptureRows(raw, cols)[0]!.map(oracleCell) };
        modelCache.set(key, row); return row;
      };
      // Truth for a captured row comes from its own printed label, never from
      // the matcher: row-%08d -> id, seed-%06d -> id-5000, else unknown.
      const labels = new WeakMap<readonly unknown[], number | null>();
      const labelOf = (row: CapturedRow): number | null => {
        const known = labels.get(row.cells); if (known !== undefined) return known;
        let text = ''; for (let x = 0; x < Math.min(15, row.cells.length); x++) text += row.cells[x]!.grapheme;
        const m = /^(row|seed)-(\d{6,8})/.exec(text);
        const id = !m ? null : m[1] === 'row' ? Number(m[2]) : Number(m[2]) - 5000;
        labels.set(row.cells, id); return id;
      };
      type Pane = {
        id: string; cols: number; rows: number; pipe: string; fd: number; offset: number; partial: string;
        count: number; revision: number; ring: HistoryRow[]; ringEnd: number; snapshot: HistoryRow[] | null;
        calibrator: HistoryCalibrator; decoder: TmuxCaptureDecoder; running: Promise<void> | undefined;
        checked: Set<number>; contentShown: Set<number>; start: number; bound: number; falseChecked: number; falseSamples: unknown[]; contentMatches: number; contentFalse: number;
        spanAt: number | null; history: number; historyAt: number[]; screenOnly: number; full: number; partialCaptures: number;
        reasons: Record<string, number>; settledAt: number | null; staleRevision: number; afterSettle: Record<string, number>; polledAt: number;
      };
      type Config = {
        socket: string; panes: Pane[]; sidecars: string[]; producedBefore: number; pid: number; cols: number; rows: number; count: number;
        ticks: number; bytes: number; batches: number; latencies: number[]; calibratorUs: number; childUs: number; oracleUs: number; modelUs: number;
        timer: ReturnType<typeof setTimeout> | undefined; timerAt: number; batch: Array<{ pane: Pane; tail: number; resolve: (c: CalibrationCapture) => void; reject: (e: unknown) => void; requestedAt: number }>;
        flushQueued: boolean; faults: Record<string, number>; captureErrors: number; errorSamples: string[]; clientInFlight: boolean; next: number; msPerRow: number;
      };
      const configs: Config[] = [];
      let stopped = false;
      // Settle start lives in an object: as a captured `let`, the hot calibrate
      // port kept reading Infinity after assignment in some runs (bun 1.3.11),
      // so no pane ever settled although every capture committed.
      const settle = { from: Infinity };
      const tmux = (socket: string, args: string[]) => {
        const result = spawnSync('tmux', ['-S', socket, ...args], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, env: privateEnv });
        if (result.status !== 0) throw new Error(`private tmux exit=${result.status}: ${result.stderr}`);
        return result.stdout;
      };
      // Rolling producer model: ids [end-4500, end). The array handed to the
      // calibrator is a snapshot; the calibrator keeps it across an await.
      const modelRing = (pane: Pane, end: number): HistoryRow[] => {
        if (pane.ringEnd !== end || !pane.snapshot) {
          if (!pane.ring.length || end < pane.ringEnd || end - pane.ringEnd >= 4500) pane.ring = Array.from({ length: 4500 }, (_, x) => modelRow(end - 4500 + x, pane.cols));
          else { for (let id = pane.ringEnd; id < end; id++) pane.ring.push(modelRow(id, pane.cols)); pane.ring.splice(0, pane.ring.length - 4500); }
          pane.ringEnd = end; pane.snapshot = pane.ring.slice();
        }
        if (pane.snapshot.length !== 4500 || pane.snapshot[0]!.lineId !== end - 4500 || pane.snapshot[4499]!.lineId !== end - 1) throw new Error('producer model ring misaligned');
        return pane.snapshot;
      };
      // Parser model: rows the pane's pipe has delivered. tmux writes a chunk
      // to the pipe only after parsing it, so this never leads tmux.
      const buffer = Buffer.alloc(1 << 20);
      const pollPipe = (pane: Pane) => {
        const t0 = spanMicros();
        pane.polledAt = performance.now();
        let text = '';
        for (;;) {
          const n = readSync(pane.fd, buffer, 0, buffer.length, pane.offset);
          if (n <= 0) break;
          pane.offset += n; text += buffer.toString('latin1', 0, n);
          if (n < buffer.length) break;
        }
        if (text) {
          text = pane.partial + text;
          const cut = text.lastIndexOf('\n');
          pane.partial = text.slice(cut + 1);
          const complete = text.slice(0, cut + 1);
          let at = complete.lastIndexOf('row-');
          while (at >= 0 && !/^row-\d{8}/.test(complete.slice(at, at + 12))) at = complete.lastIndexOf('row-', at - 1);
          if (at >= 0) {
            const count = Number(complete.slice(at + 4, at + 12)) + 1;
            if (count > pane.count) {
              const scrolled = count - pane.count; pane.count = count; pane.revision += scrolled;
              if (pane.calibrator && !stopped) pane.calibrator.scroll(scrolled);
            }
          }
        }
        return spanMicros() - t0;
      };
      const config = (pane: Pane) => configs.find(c => c.panes.includes(pane))!;
      const rearm = (c: Config) => {
        if (stopped || c.clientInFlight) return;
        // A pane with a capture in flight re-arms when it completes; counting
        // its (possibly past) deadline here would spin the timer meanwhile.
        const at = Math.min(...c.panes.filter(p => p.calibrator && !p.running).map(p => p.calibrator.dueAt));
        if (at === Infinity) return;
        // Coalesce: fire a little after the earliest deadline so panes that
        // started a few ms apart in the last tick share the next client.
        const fireAt = at + COALESCE_MS;
        if (c.timer && c.timerAt <= fireAt) return;
        if (c.timer) clearTimeout(c.timer);
        c.timerAt = fireAt;
        c.timer = setTimeout(() => { c.timer = undefined; tick(c); }, Math.max(0, fireAt - performance.now()));
      };
      // Host deadline queue, one tmux client in flight per server. Due panes
      // start round-robin until the batch requests ROW_BUDGET history rows;
      // the rest start in the next batch, so a pane's 1s capture deadline
      // never includes time spent queued behind another client.
      // The row budget adapts to measured client latency per requested row so
      // a batch stays near BATCH_TARGET_MS: under the cage's ptrace a 21-pane
      // batch took 1.4s, past the calibrator's 1s capture deadline.
      const ROW_BUDGET_MAX = 20000, BATCH_TARGET_MS = 400, COALESCE_MS = 4;
      const tick = (c: Config) => {
        if (stopped || c.clientInFlight) return;
        const now = performance.now();
        let rows = 0;
        const budget = Math.min(ROW_BUDGET_MAX, BATCH_TARGET_MS / c.msPerRow);
        const first = c.next;
        for (let k = 0; k < c.panes.length && rows < budget; k++) {
          const pane = c.panes[(first + k) % c.panes.length]!;
          if (!pane.calibrator || pane.running || pane.calibrator.dueAt > now) continue;
          const before = c.batch.length;
          pane.running = pane.calibrator.runDue().finally(() => { pane.running = undefined; rearm(c); });
          if (c.batch.length > before) rows += c.batch.at(-1)!.tail + c.rows;
          c.next = (first + k + 1) % c.panes.length;
        }
        flush(c);
        rearm(c);
      };
      // This private workload only appends and never resets its history.
      // Its owner therefore keeps epoch 1 for the whole fixture. Production
      // adapters must observe reset/clear and rotate the epoch independently.
      const meta = (pane: Pane, fields: string): CaptureMetadata => {
        const [w, h, x, y, alt] = fields.split(' ').map(Number);
        return { historyEpoch: 1, sourceEpoch: 1, geometryGeneration: 1, cols: w!, rows: h!, kind: alt ? 'alternate' : 'normal', cursor: { x: x!, y: y!, visible: true } };
      };
      // All captures requested in one tick share a tmux client. One
      // list-panes before and one after bracket every capture of the batch
      // (metadata-before/after per pane); a marker line separates captures.
      const flush = (c: Config) => {
        c.flushQueued = false;
        const batch = c.batch.splice(0);
        if (!batch.length) return;
        c.clientInFlight = true;
        let t0 = spanMicros();
        const args: string[] = [];
        const format = '#{pane_id} #{pane_width} #{pane_height} #{cursor_x} #{cursor_y} #{alternate_on}';
        args.push('list-panes', '-a', '-F', `L2C-B ${format}`);
        batch.forEach((item, k) => {
          args.push(';', 'display-message', '-p', '-t', item.pane.id, `L2C-S-${k}`, ';',
            'capture-pane', '-p', '-e', '-N', '-t', item.pane.id, ...(item.tail > 0 ? ['-S', `-${item.tail}`] : []));
        });
        args.push(';', 'display-message', '-p', '-t', batch[0]!.pane.id, 'L2C-E', ';', 'list-panes', '-a', '-F', `L2C-A ${format}`);
        c.calibratorUs += spanMicros() - t0;
        const at = performance.now();
        const proc = Bun.spawn(['tmux', '-S', c.socket, ...args], { env: privateEnv, stdout: 'pipe', stderr: 'pipe' });
        void (async () => {
          const [raw, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
          c.latencies.push(performance.now() - at); c.batches++;
          const requested = batch.reduce((sum, item) => sum + item.tail + c.rows, 0);
          c.msPerRow = 0.7 * c.msPerRow + 0.3 * ((performance.now() - at) / requested);
          c.childUs += Number(proc.resourceUsage()?.cpuTime.total ?? 0);
          c.bytes += Buffer.byteLength(raw);
          if (code !== 0) { c.clientInFlight = false; c.captureErrors++; if (c.errorSamples.length < 3) c.errorSamples.push(`exit=${code}: ${err.slice(0, 200)}`); for (const item of batch) item.reject(new Error(`private tmux exit=${code}: ${err}`)); rearm(c); return; }
          t0 = spanMicros();
          const before = new Map<string, string>(), after = new Map<string, string>();
          const found = new Map<number, { body: string }>();
          const head = raw.indexOf('L2C-S-0\n'), tailAt = raw.lastIndexOf('L2C-E\n');
          for (const line of raw.slice(0, Math.max(0, head)).split('\n')) if (line.startsWith('L2C-B ')) { const [id, ...rest] = line.slice(6).split(' '); before.set(id!, rest.join(' ')); }
          for (const line of raw.slice(tailAt + 6).split('\n')) if (line.startsWith('L2C-A ')) { const [id, ...rest] = line.slice(6).split(' '); after.set(id!, rest.join(' ')); }
          if (head >= 0 && tailAt > head) {
            const sections = raw.slice(head, tailAt).split(/^L2C-S-(\d+)\n/m);
            for (let i = 1; i + 1 < sections.length; i += 2) found.set(Number(sections[i]), { body: sections[i + 1]! });
          }
          c.calibratorUs += spanMicros() - t0;
          t0 = spanMicros();
          const results: Array<[typeof batch[number], CalibrationCapture | Error]> = [];
          batch.forEach((item, k) => {
            try {
              const entry = found.get(k), b = before.get(item.pane.id), a = after.get(item.pane.id);
              if (!entry || !b || !a) throw new Error('capture batch part missing');
              const metaBefore = meta(item.pane, b), metaAfter = meta(item.pane, a);
              const decoded = item.pane.decoder.decode(entry.body);
              const screen = decoded.slice(Math.max(0, decoded.length - metaAfter.rows));
              const history: CapturedRow[] = decoded.slice(0, decoded.length - screen.length).map(cells => ({ cells, softWrap: false }));
              // Row isolation (A-M3): uncertain rows are split between history and screen.
              const uncertain = item.pane.decoder.uncertainRows;
              const uncertainHistoryRows = uncertain.filter(y => y < history.length);
              const uncertainScreenRows = uncertain.filter(y => y >= history.length).map(y => y - history.length);
              // capture-pane has no byte position: receiveSeq is not read from a capture.
              const frame: CalibrationFrame = { cells: screen, cursor: metaAfter.cursor, kind: metaAfter.kind, geometryGeneration: 1, receiveSeq: -1 };
              results.push([item, { paneKey: { serverIdentity: c.socket, paneId: item.pane.id, birthGeneration: 1 }, captureId: `${c.batches}/${k}`, requestedAt: item.requestedAt, completedAt: performance.now(),
                before: metaBefore, after: metaAfter, frame, history, completeRetainedTail: item.tail > 0 && (item.tail >= 4500 || history.length < item.tail), observedFields: ['cells', 'cursor'], uncertainHistoryRows, uncertainScreenRows }]);
            } catch (error) { results.push([item, error as Error]); }
          });
          c.calibratorUs += spanMicros() - t0;
          c.clientInFlight = false;
          for (const [item, result] of results) result instanceof Error ? item.reject(result) : item.resolve(result);
          rearm(c);
        })();
      };
      const makePorts = (pane: Pane): CalibrationPorts => ({
        now: () => performance.now(),
        schedule: () => {
          if (pane.spanAt !== null) { config(pane).calibratorUs += spanMicros() - pane.spanAt; pane.spanAt = null; }
          rearm(config(pane));
        },
        read: () => {
          const c = config(pane);
          if (performance.now() - pane.polledAt >= 10) c.modelUs += pollPipe(pane);
          const t0 = spanMicros();
          const recentHistory = modelRing(pane, pane.count - pane.rows + 1);
          const snapshot = { revision: pane.revision, sourceEpoch: 1, geometryGeneration: 1, recentHistory,
            parserFrame: { cells: [], cursor: { x: 0, y: pane.rows - 1, visible: true }, kind: 'normal' as const, geometryGeneration: 1, receiveSeq: pane.offset } };
          const t1 = spanMicros(); c.modelUs += t1 - t0;
          pane.spanAt = t1;
          return snapshot;
        },
        capture: (_key, tail, _signal) => new Promise((resolve, reject) => {
          const c = config(pane);
          pane.spanAt = null;
          if (tail > 0) { pane.history++; pane.historyAt.push(performance.now()); if (tail >= 4500) pane.full++; else pane.partialCaptures++; }
          else pane.screenOnly++;
          c.batch.push({ pane, tail, resolve, reject, requestedAt: performance.now() });
          if (!c.flushQueued) { c.flushQueued = true; setImmediate(() => { if (c.flushQueued) flush(c); }); }
        }),
        calibrate: async input => {
          const c = config(pane);
          if (pane.spanAt !== null) { c.calibratorUs += spanMicros() - pane.spanAt; pane.spanAt = null; }
          const t0 = spanMicros();
          if (input.expectedRevision !== pane.revision) {
            pane.staleRevision++; if (settle.from !== Infinity) pane.afterSettle.stale = (pane.afterSettle.stale ?? 0) + 1;
            c.oracleUs += spanMicros() - t0; return null;
          }
          for (const check of input.checks) {
            const captured = input.capture.history[check.capturedRow]!;
            const model = modelRow(check.lineId, pane.cols);
            const truth = labelOf(captured);
            if (truth !== check.lineId || !equalHistoryRows(model, captured)) {
              pane.falseChecked++;
              if (pane.falseSamples.length < 3) pane.falseSamples.push({ lineId: check.lineId, capturedRow: check.capturedRow, truth });
            } else if (check.lineId >= pane.start && check.lineId < pane.bound) pane.checked.add(check.lineId);
          }
          // FIX1-PLAN §2 content-matched rows claim content only.
          for (const match of input.contentMatches) {
            pane.contentMatches++;
            if (!equalHistoryRows(modelRow(match.lineId, pane.cols), input.capture.history[match.capturedRow]!)) pane.contentFalse++;
            else if (match.lineId >= pane.start && match.lineId < pane.bound) pane.contentShown.add(match.lineId);
          }
          const reason = input.capture.history.length === 0 ? 'screen-only' : input.checks.length ? 'checked' : 'unchecked';
          pane.reasons[reason] = (pane.reasons[reason] ?? 0) + 1;
          if (settle.from !== Infinity) {
            const key = `${input.capture.requestedAt >= settle.from ? 'new' : 'old'}:${input.capture.history.length ? 'history' : 'screen'}`;
            pane.afterSettle[key] = (pane.afterSettle[key] ?? 0) + 1;
          }
          if (input.capture.requestedAt >= settle.from && input.capture.history.length) pane.settledAt ??= performance.now();
          pane.revision++;
          c.oracleUs += spanMicros() - t0;
          return { revision: pane.revision, durableRevision: 0, nextLineId: pane.count };
        },
        publish: () => {},
        fault: issue => { const c = config(pane); c.faults[issue.kind] = (c.faults[issue.kind] ?? 0) + 1; },
      });
      try {
        const conf = join(root, 'tmux.conf');
        writeFileSync(conf, 'set -g history-limit 4500\nset -g status off\n');
        const producer = join(root, 'producer.py');
        writeFileSync(producer, [
          'import sys,time,os',
          'for i in range(5000): sys.stdout.write("seed-%06d ไทย 你 😀\\r\\n" % i)',
          'sys.stdout.flush()',
          'i=0',
          'sidecar=sys.argv[1]',
          'with open(sidecar,"w") as f: f.write("0")',
          // Lives past setup + 60s window + settling even under the cage's
          // tracer; kill-server ends it. Rate and content are unchanged.
          'end=time.monotonic()+200',
          'while time.monotonic()<end:',
          active ? ' for n in range(10):\n  sys.stdout.write("\\x1b[%dmrow-%08d ไทย 你 😀\\x1b[0m\\r\\n" % (31+i%7,i)); i+=1' : ' pass',
          active ? ' if i%200==0: sys.stdout.write("\\x1b7\\x1b[Hstatus ไทย 你 😀\\x1b8")' : ' pass',
          ' with open(sidecar+".tmp","w") as f: f.write(str(i))',
          ' os.replace(sidecar+".tmp",sidecar)',
          ' sys.stdout.flush(); time.sleep(.1)',
        ].join('\n'));
        for (const [cols, rows] of [[80, 24], [120, 40]]) for (const count of [1, 21]) {
          const socket = join(root, `${cols}-${count}.sock`);
          // Register the socket before creating it so cleanup also covers a
          // partial setup failure; no default server is ever addressed.
          const c: Config = { socket, panes: [], sidecars: [], producedBefore: 0, pid: 0, cols: cols!, rows: rows!, count, ticks: 0, bytes: 0, batches: 0, latencies: [], calibratorUs: 0, childUs: 0, oracleUs: 0, modelUs: 0, timer: undefined, timerAt: Infinity, batch: [], flushQueued: false, faults: {}, captureErrors: 0, errorSamples: [], clientInFlight: false, next: 0, msPerRow: 0.02 };
          configs.push(c);
          for (let pane = 0; pane < count; pane++) {
            const sidecar = join(root, `${cols}-${count}-${pane}.rows`); c.sidecars.push(sidecar);
            const pipe = join(root, `${cols}-${count}-${pane}.pipe`); writeFileSync(pipe, '');
            // The pipe is attached before the producer starts: new-session
            // runs `sleep` until pipe-pane is in place, then the producer.
            const gate = join(root, `${cols}-${count}-${pane}.go`);
            const id = tmux(socket, ['-f', conf, 'new-session', '-d', '-P', '-F', '#{pane_id}', '-s', `p${pane}`, '-x', String(cols), '-y', String(rows), `while [ ! -e ${quote(gate)} ]; do sleep 0.01; done; exec python3 -u ${quote(producer)} ${quote(sidecar)}`]).trim();
            tmux(socket, ['pipe-pane', '-t', id, `exec cat >> ${quote(pipe)}`]);
            writeFileSync(gate, '');
            c.panes.push({ id, cols: cols!, rows: rows!, pipe, fd: openSync(pipe, 'r'), offset: 0, partial: '', count: 0, revision: 1, ring: [], ringEnd: 0, snapshot: null,
              calibrator: undefined as unknown as HistoryCalibrator, decoder: new TmuxCaptureDecoder(cols!, 5000), running: undefined, checked: new Set(), contentShown: new Set(), start: 0, bound: Infinity,
              falseChecked: 0, falseSamples: [], contentMatches: 0, contentFalse: 0, spanAt: null, history: 0, historyAt: [], screenOnly: 0, full: 0, partialCaptures: 0, reasons: {}, settledAt: null, staleRevision: 0, afterSettle: {}, polledAt: 0 });
          }
          c.pid = Number(tmux(socket, ['display-message', '-p', '-t', c.panes[0]!.id, '#{pid}']).trim());
          expect(c.pid).toBeGreaterThan(0);
        }
        // Seeding 44 panes is asynchronous; begin only after every producer
        // has flushed its seed and written its sidecar.
        const readyBy = performance.now() + 10000;
        while (!configs.every(c => c.sidecars.every(path => existsSync(path)))) {
          if (performance.now() >= readyBy) throw new Error('producer sidecars not ready');
          await new Promise(resolve => setTimeout(resolve, 25));
        }
        await new Promise(resolve => setTimeout(resolve, 500));
        const hz = Number(spawnSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }).stdout.trim());
        expect(hz).toBeGreaterThan(0);
        for (const c of configs) {
          c.ticks = procTicks(c.pid).own;
          for (const pane of c.panes) {
            pollPipe(pane);
            pane.start = pane.count - pane.rows + 1;
            if (mode !== 'baseline') pane.calibrator = new HistoryCalibrator({ serverIdentity: c.socket, paneId: pane.id, birthGeneration: 1 }, makePorts(pane), { incremental: mode === 'incremental' });
          }
          c.producedBefore = c.sidecars.reduce((sum, path) => sum + Number(readFileSync(path, 'utf8')), 0);
        }
        // The pipe reader: in production bytes are pushed; here every 100ms, and
        // a read() port call reads the pipe again first (at most every 10ms).
        const poller = mode === 'baseline' ? undefined : setInterval(() => {
          for (const c of configs) for (const pane of c.panes) c.modelUs += pollPipe(pane);
        }, 100);
        const parent = procTicks(process.pid);
        const cpuStart = cpuMicros();
        const started = performance.now();
        for (const c of configs) if (mode !== 'baseline') rearm(c);
        await new Promise(resolve => setTimeout(resolve, 60000 - (performance.now() - started)));
        while (performance.now() - started < 60000) await new Promise(resolve => setTimeout(resolve, 5));
        const elapsed = performance.now() - started;
        const after = procTicks(process.pid);
        const cpuEnd = cpuMicros();
        const caller = ((after.own + after.children - parent.own - parent.children) / hz) / (elapsed / 1000) * 100;
        // Window boundary: freeze counts, CPU sections and servers. Captures
        // after this point only settle rows that entered history in the window.
        const windowCounts = configs.map(c => c.sidecars.map(path => Number(readFileSync(path, 'utf8'))));
        const windowServer = configs.map(c => procTicks(c.pid).own);
        const windowSections = configs.map(c => ({ calibratorUs: c.calibratorUs, childUs: c.childUs, oracleUs: c.oracleUs, modelUs: c.modelUs, batches: c.batches, latencies: c.latencies.slice(),
          history: c.panes.map(p => p.historyAt.filter(t => t < started + elapsed).length), intervals: c.panes.flatMap(p => { const at = p.historyAt.filter(t => t < started + elapsed); return at.slice(1).map((t, i) => t - at[i]!); }),
          screenOnly: c.panes.reduce((s, p) => s + p.screenOnly, 0), full: c.panes.reduce((s, p) => s + p.full, 0), partial: c.panes.reduce((s, p) => s + p.partialCaptures, 0) }));
        for (const c of configs) for (const pane of c.panes) pane.bound = pane.count - pane.rows + 1;
        const checkedAtWindowEnd = configs.map(c => c.panes.reduce((sum, p) => sum + p.checked.size, 0));
        let finalPass = false;
        if (mode !== 'baseline' && active) {
          // PLAN §6: coverage is counted after a final capture. Wait until every
          // window row is past the screen (plus the producer's unflushed
          // batch), then until every pane commits a history capture requested
          // after that point. The calibrator keeps its own schedule throughout.
          const settleBy = performance.now() + 10000;
          while (!configs.every((c, k) => c.sidecars.every((path, i) => Number(readFileSync(path, 'utf8')) >= windowCounts[k]![i]! + c.rows + 20))) {
            if (performance.now() >= settleBy) throw new Error('producer did not advance past the window');
            await new Promise(resolve => setTimeout(resolve, 25));
          }
          settle.from = performance.now();
          const finalBy = performance.now() + 30000;
          while (!configs.every(c => c.panes.every(p => p.settledAt !== null))) {
            if (performance.now() >= finalBy) break;
            await new Promise(resolve => setTimeout(resolve, 25));
          }
          finalPass = configs.every(c => c.panes.every(p => p.settledAt !== null));
        }
        stopped = true;
        if (poller) clearInterval(poller);
        for (const c of configs) if (c.timer) clearTimeout(c.timer);
        await Promise.all(configs.flatMap(c => c.panes.map(p => p.running)));
        const targets: Array<() => void> = [];
        for (const [k, c] of configs.entries()) {
          const producedRows = windowCounts[k]!.reduce((sum, n) => sum + n, 0) - c.producedBefore;
          expect(active ? producedRows > 0 : producedRows === 0).toBe(true);
          const server = (windowServer[k]! - c.ticks) / hz / (elapsed / 1000) * 100;
          const w = windowSections[k]!;
          const pct = (us: number) => us / 1000 / elapsed * 100;
          const key = `${active}/${round}/${c.cols}/${c.count}`;
          if (mode === 'baseline') measurements.set(key, { server, caller });
          const base = measurements.get(key)!;
          const percentile = (values: number[], p: number) => { const v = values.slice().sort((a, b) => a - b); return v.length ? v[Math.min(v.length - 1, Math.ceil(v.length * p) - 1)]! : null; };
          const delta = server - base.server;
          // Denominator: every row that entered history inside the window.
          const denominator = c.panes.reduce((sum, p) => sum + Math.max(0, p.bound - p.start), 0);
          const checkedRows = c.panes.reduce((sum, p) => sum + p.checked.size, 0);
          // FIX1-PLAN §2.3: a content-matched row is complete history (content
          // proven, identity not claimed). Coverage = rows proven either way;
          // checkedCoverage = rows carrying an identity claim, reported apart.
          const provenRows = c.panes.reduce((sum, p) => { let n = p.checked.size; for (const id of p.contentShown) if (!p.checked.has(id)) n++; return sum + n; }, 0);
          // Unchecked after the final capture, classified: the producer
          // overwrites the top screen row with a status line whenever i%200==0.
          const unchecked = { statusOverwrite: 0, other: 0, oldestOther: null as number | null, contentMatchedOnly: 0 };
          if (finalPass) for (const p of c.panes) for (let id = p.start; id < p.bound; id++) {
            if (p.checked.has(id)) continue;
            if (p.contentShown.has(id)) { unchecked.contentMatchedOnly++; continue; }
            if ((id + c.rows - 1) % 200 === 0 && id + c.rows - 1 > 0) unchecked.statusOverwrite++;
            else { unchecked.other++; unchecked.oldestOther ??= id; }
          }
          const falseChecked = c.panes.reduce((sum, p) => sum + p.falseChecked, 0);
          const contentMatches = c.panes.reduce((sum, p) => sum + p.contentMatches, 0);
          const contentFalse = c.panes.reduce((sum, p) => sum + p.contentFalse, 0);
          // C-F21: capture-fault = a capture past its 1s deadline, aborted. It is
          // a separate counter from captureErrors (tmux client exit != 0) and is
          // reported per configuration; PLAN §6 counts it as a fail.
          const captureFaults = c.faults['capture-fault'] ?? 0;
          const historyPerPane = { min: Math.min(...w.history), max: Math.max(...w.history) };
          const calibratorCpu = pct(w.calibratorUs), childCpu = pct(w.childUs), oracleCpu = pct(w.oracleUs), modelCpu = pct(w.modelUs);
          const reasons: Record<string, number> = {};
          for (const p of c.panes) for (const [r, n] of Object.entries(p.reasons)) reasons[r] = (reasons[r] ?? 0) + n;
          const record = { mode, active, round, cols: c.cols, rows: c.rows, panes: c.count, elapsedMs: elapsed, tracerPid, timingAsserted: tracerPid === 0,
            producedRows, denominator, checkedAtWindowEnd: checkedAtWindowEnd[k], checkedPerDenominatorAtWindowEnd: denominator ? checkedAtWindowEnd[k]! / denominator : null,
            finalPass, checkedRows, provenRows, coverage: denominator && finalPass ? provenRows / denominator : null, checkedCoverage: denominator && finalPass ? checkedRows / denominator : null, unchecked, falseChecked, falseSamples: c.panes.flatMap(p => p.falseSamples).slice(0, 3), contentMatches, contentFalse,
            captureFaults, captureFaultsPerPane: captureFaults / c.count, captureFaultPass: mode === 'baseline' ? null : captureFaults === 0,
            staleRevision: c.panes.reduce((s, p) => s + p.staleRevision, 0),
            unsettled: c.panes.filter(p => p.settledAt === null).slice(0, 3).map(p => ({ pane: p.id, afterSettle: p.afterSettle, captures: p.historyAt.filter(t => t >= settle.from).length })),
            settleMs: c.panes.reduce((m, p) => Math.max(m, p.settledAt === null ? Infinity : p.settledAt - settle.from), 0), faults: c.faults, captureErrors: c.captureErrors, captureErrorSamples: c.errorSamples, msPerRowAtEnd: c.msPerRow, reasons,
            historyCapturesPerPane: historyPerPane, historyIntervalP50: percentile(w.intervals, .5), historyIntervalP95: percentile(w.intervals, .95), historyIntervalMax: percentile(w.intervals, 1),
            fullCaptures: w.full, partialCaptures: w.partial, screenOnlyCaptures: w.screenOnly, batches: w.batches, captureBytes: c.bytes,
            batchP50: percentile(w.latencies, .5), batchP95: percentile(w.latencies, .95), batchP99: percentile(w.latencies, .99), batchMax: percentile(w.latencies, 1),
            producedRowsPerSecondPerPane: producedRows / (elapsed / 1000) / c.count,
            serverCpuPercentOneCore: server, baselineServerCpu: base.server, serverDelta: delta, serverTargetPass: mode === 'baseline' ? null : c.count === 21 && active ? delta <= 10 : null,
            calibratorCpuPercentOneCore: calibratorCpu, captureChildrenCpuPercentOneCore: childCpu, calibratorPlusChildrenCpu: calibratorCpu + childCpu,
            testModelCpuPercentOneCore: modelCpu, testOracleCpuPercentOneCore: oracleCpu,
            allFourConfigsProcessCpuUsage: (cpuEnd - cpuStart) / 1000 / elapsed * 100, allFourConfigsCallerAndCaptureChildrenCpu: caller, allFourConfigsCallerDelta: caller - base.caller,
            decoderHits: c.panes.reduce((sum, p) => sum + p.decoder.hits, 0), decoderMisses: c.panes.reduce((sum, p) => sum + p.decoder.misses, 0), hz, cpu: cpus()[0]?.model, tmuxVersion: tmux(c.socket, ['-V']).trim(),
            scope: '4 private servers; real HistoryCalibrator per pane on its own deadlines; host deadline queue batches due panes per tick into one tmux client; parser model fed by pipe-pane (trails tmux); screen-only captures included; no byte fence: parser model has no cells, so screens are never compared; identity oracle on checks, content oracle on content-matched rows from printed labels; window stats frozen before settling' };
          console.log('NEWARCH_C_CPU', JSON.stringify(record));
          // Emit every configuration before asserting any target.
          targets.push(() => {
            expect(falseChecked).toBe(0);
            expect(contentFalse).toBe(0);
            expect(c.captureErrors).toBe(0);
            // Deadline faults are timing: asserted only without a tracer, like
            // every other timing target; under ptrace they are reported (C-F21).
            if (tracerPid === 0 && mode !== 'baseline') expect(captureFaults).toBe(0);
            expect(Number.isFinite(server)).toBe(true);
            expect(elapsed).toBeGreaterThanOrEqual(60000);
            if (mode !== 'baseline') expect(historyPerPane.min).toBeGreaterThan(0);
            // FIX2 m5: no window row missing without a reason. Every row is
            // checked, content-matched, or overwritten by the status line.
            if (finalPass) expect(unchecked.other).toBe(0);
            // FIX2 m5 floor: coverage counts content-matched rows, so it stays
            // >= .99 if the matcher stops checking. Round 1 measured
            // checkedCoverage 0.98479..0.98542 over 24 active records (full and
            // incremental, 1/21 panes, 80x24/120x40); the gap to coverage is
            // the rows next to each status overwrite (1 per 200 rows), which
            // lose an anchor on one side. 0.98 is below that by ~0.5pp.
            if (finalPass && active) expect(record.checkedCoverage!).toBeGreaterThanOrEqual(.98);
            if (mode === 'incremental' && active) {
              expect(finalPass).toBe(true);
              expect(record.coverage!).toBeGreaterThanOrEqual(.99);
              if (c.count === 21) expect(delta).toBeLessThanOrEqual(10);
              // calibrator+capture children within one core for 21 panes.
              if (c.count === 21) expect(calibratorCpu + childCpu).toBeLessThanOrEqual(100);
              // Timing: >=250 history captures per pane in 60s (200ms cadence).
              if (tracerPid === 0) expect(historyPerPane.min).toBeGreaterThanOrEqual(250);
            }
          });
        }
        for (const target of targets) target();
      } finally {
        stopped = true;
        for (const c of configs) {
          if (c.timer) clearTimeout(c.timer);
          for (const p of c.panes) { try { closeSync(p.fd); } catch {} }
          spawnSync('tmux', ['-S', c.socket, 'kill-server'], { encoding: 'utf8', env: privateEnv });
        }
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
});
