import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir, cpus } from 'node:os';
import { join } from 'node:path';

import { IncrementalHistoryMatcher, equalHistoryRows, type HistoryRow, type CapturedRow } from '../src/history-row-matcher';
import { decodeTmuxCaptureRows, TmuxCaptureDecoder } from '../src/tmux-capture-normalize';

// One complete baseline/full/incremental round per cage command.
// Preserve all four concurrent private-server configurations and 60s samples.
// CPU is split three ways: calibrator (split+decode+match+remember), capture
// children (each tmux client's own rusage), and the test's producer model and
// false-check oracle. The oracle never feeds the calibrator's CPU figure.
describe('NEWARCH L2-C private tmux CPU measurement', () => {
  const measurements = new Map<string, { server: number; caller: number }>();
  const procTicks = (pid: number) => {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return { own: Number(fields[11]) + Number(fields[12]), children: Number(fields[13]) + Number(fields[14]) };
  };
  const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
  const cpuMicros = () => { const u = process.cpuUsage(); return u.user + u.system; };
  const active = true;
  const round = 2;
  for (const mode of ['baseline', 'full', 'incremental'] as const) {
    test(`60s round=${round} active=${active} capture=${mode} 1/21 panes 80x24/120x40`, async () => {
      const root = mkdtempSync(join(tmpdir(), 'newarch-c-cpu-'));
      const privateEnv = { ...process.env };
      delete privateEnv.TMUX; delete privateEnv.TMUX_PANE;
      const modelCache = new Map<string, HistoryRow>();
      // Oracle cells are interned here, apart from the decoder under test: one
      // object per cell for ~11k rows x 2 widths was ~2.2M live objects and,
      // with the 3 GB cage also holding the repo snapshot, stalled full mode.
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
      const states = new Map<string, { matcher: IncrementalHistoryMatcher; decoder: TmuxCaptureDecoder; ring: HistoryRow[]; ringEnd: number; checked: Set<number>; start: number; last: number; capturedEnd: number; full: boolean }>();
      // Rolling producer model: ids [end-4500, end) exactly as a fresh
      // Array.from would build, without re-reading 4500 cached rows per tick.
      const modelRing = (state: { ring: HistoryRow[]; ringEnd: number }, end: number, cols: number): HistoryRow[] => {
        if (state.ringEnd !== end) {
          if (!state.ring.length || end < state.ringEnd || end - state.ringEnd >= 4500) state.ring = Array.from({ length: 4500 }, (_, x) => modelRow(end - 4500 + x, cols));
          else { for (let id = state.ringEnd; id < end; id++) state.ring.push(modelRow(id, cols)); state.ring.splice(0, state.ring.length - 4500); }
          state.ringEnd = end;
        }
        if (state.ring.length !== 4500 || state.ring[0]!.lineId !== end - 4500 || state.ring[4499]!.lineId !== end - 1) throw new Error('producer model ring misaligned');
        return state.ring;
      };
      let falseChecked = 0;
      const targets: Array<{ coverage: number; delta: number; panes: number; samples: number; calibratorPlusChildren: number }> = [];
      const reasons: Record<string, number> = {};
      let fullCaptures = 0, partialCaptures = 0;
      const configs: Array<{ socket: string; panes: string[]; sidecars: string[]; producedBefore: number; pid: number; cols: number; rows: number; count: number; ticks: number; bytes: number; samples: number; latencies: number[]; calibratorUs: number; childUs: number; oracleUs: number }> = [];
      const tmux = (socket: string, args: string[]) => {
        const result = spawnSync('tmux', ['-S', socket, ...args], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, env: privateEnv });
        if (result.status !== 0) throw new Error(`private tmux exit=${result.status}: ${result.stderr}`);
        return result.stdout;
      };
      // Capture spawns report the child's own rusage so it is attributed to
      // its configuration; /proc children ticks only give the four-config sum.
      const capture = (socket: string, args: string[]) => {
        const result = Bun.spawnSync(['tmux', '-S', socket, ...args], { env: privateEnv, stdout: 'pipe', stderr: 'pipe' });
        if (result.exitCode !== 0) throw new Error(`private tmux exit=${result.exitCode}: ${result.stderr.toString()}`);
        return { stdout: result.stdout.toString(), childUs: Number(result.resourceUsage.cpuTime.total) };
      };
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
          'end=time.monotonic()+100',
          'while time.monotonic()<end:',
          active ? ' for n in range(10):\n  sys.stdout.write("\\x1b[%dmrow-%08d ไทย 你 😀\\x1b[0m\\r\\n" % (31+i%7,i)); i+=1' : ' pass',
          active ? ' if i%200==0: sys.stdout.write("\\x1b7\\x1b[Hstatus ไทย 你 😀\\x1b8")' : ' pass',
          ' with open(sidecar+".tmp","w") as f: f.write(str(i))',
          ' os.replace(sidecar+".tmp",sidecar)',
          ' sys.stdout.flush(); time.sleep(.1)',
        ].join('\n'));
        for (const [cols, rows] of [[80, 24], [120, 40]]) for (const count of [1, 21]) {
          const socket = join(root, `${cols}-${count}.sock`);
          const panes: string[] = [];
          // Register the socket before creating it so cleanup also covers a
          // partial setup failure; no default server is ever addressed.
          const c = { socket, panes, sidecars: [] as string[], producedBefore: 0, pid: 0, cols: cols!, rows: rows!, count, ticks: 0, bytes: 0, samples: 0, latencies: [] as number[], calibratorUs: 0, childUs: 0, oracleUs: 0 };
          configs.push(c);
          for (let pane = 0; pane < count; pane++) {
            const sidecar = join(root, `${cols}-${count}-${pane}.rows`); c.sidecars.push(sidecar);
            panes.push(tmux(socket, ['-f', conf, 'new-session', '-d', '-P', '-F', '#{pane_id}', '-s', `p${pane}`, '-x', String(cols), '-y', String(rows), `python3 -u ${quote(producer)} ${quote(sidecar)}`]).trim());
          }
          c.pid = Number(tmux(socket, ['display-message', '-p', '-t', panes[0]!, '#{pid}']).trim());
          expect(c.pid).toBeGreaterThan(0);
        }
        // Seeding 44 panes is asynchronous; a fixed sleep can precede the
        // final producer's first sidecar. Begin measurement only after all are ready.
        const readyBy = performance.now() + 10000;
        while (!configs.every(c => c.sidecars.every(path => existsSync(path)))) {
          if (performance.now() >= readyBy) throw new Error('producer sidecars not ready');
          await new Promise(resolve => setTimeout(resolve, 25));
        }
        await new Promise(resolve => setTimeout(resolve, 500));
        const hz = Number(spawnSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }).stdout.trim());
        expect(hz).toBeGreaterThan(0);
        // Decoder memo sized to history-limit 4500 plus one pass of new rows;
        // the 9000 default kept rows that had already left tmux history.
        for (const c of configs) {
          c.ticks = procTicks(c.pid).own;
          for (let i = 0; i < c.panes.length; i++) {
            const count = Number(readFileSync(c.sidecars[i]!, 'utf8'));
            states.set(`${c.socket}/${i}`, { matcher: new IncrementalHistoryMatcher(), decoder: new TmuxCaptureDecoder(c.cols, 5000), ring: [], ringEnd: 0, checked: new Set(), start: count - c.rows + 1, last: count, capturedEnd: count - c.rows + 1, full: true });
          }
          c.producedBefore = c.sidecars.reduce((sum, path) => sum + Number(readFileSync(path, 'utf8')), 0);
        }
        // One capture pass over a configuration. `bounds[i]` is the exclusive id
        // bound per pane; the final pass may only settle rows of the window.
        const pass = (c: typeof configs[number], bounds?: number[]) => {
            let t0 = cpuMicros();
            const counts = c.sidecars.map(path => Number(readFileSync(path, 'utf8')));
            const args: string[] = [];
            const tails: number[] = [];
            for (let i = 0; i < c.panes.length; i++) {
              const state = states.get(`${c.socket}/${i}`)!;
              // Extra overlap covers output arriving while the capture executes.
              const tail = mode === 'full' || state.full ? 4500 : Math.min(4500, Math.max(3, counts[i]! - state.last + 128));
              tails.push(tail);
              if (tail === 4500) fullCaptures++; else partialCaptures++;
              if (args.length) args.push(';');
              args.push('display-message', '-p', `L2C-PANE-${i}`, ';', 'capture-pane', '-p', '-e', '-N', '-t', c.panes[i]!, '-S', `-${tail}`);
            }
            c.oracleUs += cpuMicros() - t0;
            const at = performance.now();
            const spawned = capture(c.socket, args);
            const raw = spawned.stdout;
            c.childUs += spawned.childUs;
            c.bytes += Buffer.byteLength(raw);
            t0 = cpuMicros();
            const blocks = raw.split(/L2C-PANE-\d+\n/).slice(1);
            c.calibratorUs += cpuMicros() - t0;
            expect(blocks.length).toBe(c.count);
            for (let i = 0; i < c.panes.length; i++) {
              const state = states.get(`${c.socket}/${i}`)!;
              // Independent producer model sampled BEFORE capture, never inferred
              // from captured row labels. Cursor starts at row zero after seeding.
              t0 = cpuMicros();
              const end = counts[i]! - c.rows + 1;
              const recent = modelRing(state, end, c.cols);
              const t1 = cpuMicros(); c.oracleUs += t1 - t0;
              const lines = blocks[i]!.split('\n');
              if (lines.at(-1) === '') lines.pop();
              const historyText = lines.slice(0, Math.max(0, lines.length - c.rows)).join('\n') + '\n';
              const captured: CapturedRow[] = state.decoder.decode(historyText).map(cells => ({ cells, softWrap: false }));
              const result = state.matcher.match(recent, captured, { sourceEpoch: 1, geometryGeneration: 1, completeRetainedTail: tails[i] === 4500 });
              state.matcher.remember(recent, captured, result);
              t0 = cpuMicros(); c.calibratorUs += t0 - t1;
              reasons[result.reason] = (reasons[result.reason] ?? 0) + 1;
              for (const check of result.checks) {
                if (!equalHistoryRows(modelRow(check.lineId, c.cols), captured[check.capturedRow]!)) falseChecked++;
                if (check.lineId >= state.start && check.lineId < (bounds?.[i] ?? Infinity)) state.checked.add(check.lineId);
              }
              state.full = result.reason !== 'matched'; state.last = counts[i]!; state.capturedEnd = end;
              c.oracleUs += cpuMicros() - t0;
            }
            c.latencies.push(performance.now() - at); c.samples++;
        };
        const parent = procTicks(process.pid);
        const cpuStart = cpuMicros();
        const started = performance.now();
        let next = started;
        while (performance.now() - started < 60000) {
          if (mode === 'baseline') { await new Promise(resolve => setTimeout(resolve, 100)); continue; }
          for (const c of configs) pass(c);
          next += active ? 200 : 1000;
          await new Promise(resolve => setTimeout(resolve, Math.max(0, next - performance.now())));
        }
        const elapsed = performance.now() - started;
        const after = procTicks(process.pid);
        const cpuEnd = cpuMicros();
        const caller = ((after.own + after.children - parent.own - parent.children) / hz) / (elapsed / 1000) * 100;
        // Window boundary: freeze counts, CPU sections and servers before the
        // final settling pass so none of that pass is billed to the window.
        const windowCounts = configs.map(c => c.sidecars.map(path => Number(readFileSync(path, 'utf8'))));
        const windowServer = configs.map(c => procTicks(c.pid).own);
        const windowSections = configs.map(c => ({ calibratorUs: c.calibratorUs, childUs: c.childUs, oracleUs: c.oracleUs, samples: c.samples, latencies: c.latencies.slice() }));
        // Pending = window rows whose history slot was newer than the pane's
        // last capture model; they cannot have been checked yet.
        const pendingAtWindowEnd = configs.map((c, k) => c.panes.reduce((sum, _, i) => {
          const state = states.get(`${c.socket}/${i}`)!;
          let pending = 0;
          for (let id = Math.max(state.start, state.capturedEnd); id < windowCounts[k]![i]! - c.rows + 1; id++) if (!state.checked.has(id)) pending++;
          return sum + pending;
        }, 0));
        const checkedAtWindowEnd = configs.map(c => c.panes.reduce((sum, _, i) => sum + states.get(`${c.socket}/${i}`)!.checked.size, 0));
        let finalPass = false;
        if (mode !== 'baseline' && active) {
          // PLAN §6: coverage is counted after a final capture. Wait until every
          // window row is past the screen (plus the producer's unflushed
          // 10-row batch), then run one more ordinary pass per configuration.
          const settleBy = performance.now() + 10000;
          while (!configs.every((c, k) => c.sidecars.every((path, i) => Number(readFileSync(path, 'utf8')) >= windowCounts[k]![i]! + c.rows + 20))) {
            if (performance.now() >= settleBy) throw new Error('producer did not advance past the window');
            await new Promise(resolve => setTimeout(resolve, 25));
          }
          // Only ids that entered history inside the window may be settled.
          for (const [k, c] of configs.entries()) pass(c, windowCounts[k]!.map(n => n - c.rows + 1));
          finalPass = true;
        }
        for (const [k, c] of configs.entries()) {
          const producedRows = windowCounts[k]!.reduce((sum, n) => sum + n, 0) - c.producedBefore;
          expect(active ? producedRows > 0 : producedRows === 0).toBe(true);
          const server = (windowServer[k]! - c.ticks) / hz / (elapsed / 1000) * 100;
          const w = windowSections[k]!;
          const pct = (us: number) => us / 1000 / elapsed * 100;
          const key = `${active}/${round}/${c.cols}/${c.count}`;
          if (mode === 'baseline') measurements.set(key, { server, caller });
          const base = measurements.get(key)!;
          const latencies = w.latencies.sort((a, b) => a - b);
          const percentile = (p: number) => latencies.length ? latencies[Math.min(latencies.length - 1, Math.ceil(latencies.length * p) - 1)] : null;
          const delta = server - base.server;
          const checkedRows = c.panes.reduce((sum, _, i) => sum + states.get(`${c.socket}/${i}`)!.checked.size, 0);
          // Unchecked after the final pass, classified: the producer overwrites
          // the top screen row with a status line whenever i%200==0, so tmux
          // legitimately differs from the model at id+rows-1 ≡ 0 (mod 200).
          const unchecked = { statusOverwrite: 0, other: 0, oldestOther: null as number | null };
          if (finalPass) c.panes.forEach((_, i) => {
            const state = states.get(`${c.socket}/${i}`)!;
            for (let id = state.start; id < windowCounts[k]![i]! - c.rows + 1; id++) {
              if (state.checked.has(id)) continue;
              if ((id + c.rows - 1) % 200 === 0 && id + c.rows - 1 > 0) unchecked.statusOverwrite++;
              else { unchecked.other++; unchecked.oldestOther ??= id; }
            }
          });
          const calibratorCpu = pct(w.calibratorUs), childCpu = pct(w.childUs), oracleCpu = pct(w.oracleUs);
          console.log('NEWARCH_C_CPU' , JSON.stringify({ mode, active, round, cols: c.cols, rows: c.rows, panes: c.count, elapsedMs: elapsed, producedRows, checkedAtWindowEnd: checkedAtWindowEnd[k], checkedPerScrolledAtWindowEnd: producedRows > 0 ? checkedAtWindowEnd[k]! / producedRows : null, pendingAtWindowEnd: pendingAtWindowEnd[k], finalPass, checkedRows, checkedPerScrolled: producedRows > 0 && finalPass ? checkedRows / producedRows : null, unchecked, falseChecked, fullCaptures, partialCaptures, reasons, producedRowsPerSecondPerPane: producedRows / (elapsed / 1000) / c.count, samples: w.samples, capturesPerMinute: w.samples / (elapsed / 60000), captureBytes: c.bytes, serverCpuPercentOneCore: server, baselineServerCpu: base.server, serverDelta: delta, serverTargetPass: mode === 'baseline' ? null : c.count === 21 && active ? delta <= 10 : null, captureBatchP50: percentile(.5), captureBatchP95: percentile(.95), captureBatchP99: percentile(.99), captureBatchMax: c.latencies.at(-1) ?? null, calibratorCpuPercentOneCore: calibratorCpu, captureChildrenCpuPercentOneCore: childCpu, calibratorPlusChildrenCpu: calibratorCpu + childCpu, testOracleCpuPercentOneCore: oracleCpu, allFourConfigsProcessCpuUsage: (cpuEnd - cpuStart) / 1000 / elapsed * 100, allFourConfigsCallerAndCaptureChildrenCpu: caller, allFourConfigsCallerDelta: caller - base.caller, decoderHits: c.panes.reduce((sum, _, i) => sum + states.get(`${c.socket}/${i}`)!.decoder.hits, 0), decoderMisses: c.panes.reduce((sum, _, i) => sum + states.get(`${c.socket}/${i}`)!.decoder.misses, 0), hz, cpu: cpus()[0]?.model, tmuxVersion: tmux(c.socket, ['-V']).trim(), scope: '4 private servers; real capture+memo decode+matcher; independent producer row model; no worker/writer; adaptive incremental overlap; calibrator/children/oracle CPU split; window stats frozen before one final settling pass' }));
          expect(falseChecked).toBe(0);
          if (mode === 'incremental' && active) targets.push({ coverage: checkedRows / producedRows, delta, panes: c.count, samples: w.samples, calibratorPlusChildren: calibratorCpu + childCpu });
          expect(Number.isFinite(server)).toBe(true);
          expect(elapsed).toBeGreaterThanOrEqual(60000);
          if (mode !== 'baseline') expect(c.samples).toBeGreaterThan(0);
        }
        // Emit every configuration before asserting any target.
        for (const target of targets) {
          expect(target.coverage).toBeGreaterThanOrEqual(.99);
          if (target.panes === 21) expect(target.delta).toBeLessThanOrEqual(10);
          // FIX2 targets: >=250 captures per configuration in the 60s window,
          // and calibrator+capture children within one core for 21 panes.
          expect(target.samples).toBeGreaterThanOrEqual(250);
          if (target.panes === 21) expect(target.calibratorPlusChildren).toBeLessThanOrEqual(100);
        }
      } finally {
        for (const c of configs) spawnSync('tmux', ['-S', c.socket, 'kill-server'], { encoding: 'utf8', env: privateEnv });
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
});
