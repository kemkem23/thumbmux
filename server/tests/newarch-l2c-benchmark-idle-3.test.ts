import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir, cpus } from 'node:os';
import { join } from 'node:path';

// One complete baseline/full/incremental round per cage command.
// Preserve all four concurrent private-server configurations and 60s samples.
describe('NEWARCH L2-C private tmux CPU measurement', () => {
  const measurements = new Map<string, { server: number; caller: number }>();
  const procTicks = (pid: number) => {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return { own: Number(fields[11]) + Number(fields[12]), children: Number(fields[13]) + Number(fields[14]) };
  };
  const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
  const active = false;
  const round = 3;
  for (const mode of ['baseline', 'full', 'incremental'] as const) {
    test(`60s round=${round} active=${active} capture=${mode} 1/21 panes 80x24/120x40`, async () => {
      const root = mkdtempSync(join(tmpdir(), 'newarch-c-cpu-'));
      const privateEnv = { ...process.env };
      delete privateEnv.TMUX; delete privateEnv.TMUX_PANE;
      const configs: Array<{ socket: string; panes: string[]; sidecars: string[]; producedBefore: number; pid: number; cols: number; rows: number; count: number; ticks: number; bytes: number; samples: number; latencies: number[] }> = [];
      const tmux = (socket: string, args: string[]) => {
        const result = spawnSync('tmux', ['-S', socket, ...args], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, env: privateEnv });
        if (result.status !== 0) throw new Error(`private tmux exit=${result.status}: ${result.stderr}`);
        return result.stdout;
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
          const c = { socket, panes, sidecars: [] as string[], producedBefore: 0, pid: 0, cols: cols!, rows: rows!, count, ticks: 0, bytes: 0, samples: 0, latencies: [] as number[] };
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
        for (const c of configs) {
          c.ticks = procTicks(c.pid).own;
          c.producedBefore = c.sidecars.reduce((sum, path) => sum + Number(readFileSync(path, 'utf8')), 0);
        }
        const parent = procTicks(process.pid);
        const started = performance.now();
        let next = started;
        while (performance.now() - started < 60000) {
          if (mode === 'baseline') { await new Promise(resolve => setTimeout(resolve, 100)); continue; }
          for (const c of configs) {
            const tail = mode === 'full' ? 4500 : active ? 23 : 3;
            const args: string[] = [];
            for (const pane of c.panes) {
              if (args.length) args.push(';');
              args.push('capture-pane', '-p', '-e', '-N', '-t', pane, '-S', `-${tail}`);
            }
            const at = performance.now();
            c.bytes += Buffer.byteLength(tmux(c.socket, args));
            c.latencies.push(performance.now() - at); c.samples++;
          }
          next += active ? 200 : 1000;
          await new Promise(resolve => setTimeout(resolve, Math.max(0, next - performance.now())));
        }
        const elapsed = performance.now() - started;
        const after = procTicks(process.pid);
        const caller = ((after.own + after.children - parent.own - parent.children) / hz) / (elapsed / 1000) * 100;
        for (const c of configs) {
          const producedRows = c.sidecars.reduce((sum, path) => sum + Number(readFileSync(path, 'utf8')), 0) - c.producedBefore;
          expect(active ? producedRows > 0 : producedRows === 0).toBe(true);
          const server = (procTicks(c.pid).own - c.ticks) / hz / (elapsed / 1000) * 100;
          const key = `${active}/${round}/${c.cols}/${c.count}`;
          if (mode === 'baseline') measurements.set(key, { server, caller });
          const base = measurements.get(key)!;
          c.latencies.sort((a, b) => a - b);
          const percentile = (p: number) => c.latencies.length ? c.latencies[Math.min(c.latencies.length - 1, Math.ceil(c.latencies.length * p) - 1)] : null;
          const delta = server - base.server;
          console.log('NEWARCH_C_CPU', JSON.stringify({ mode, active, round, cols: c.cols, rows: c.rows, panes: c.count, elapsedMs: elapsed, producedRows, producedRowsPerSecondPerPane: producedRows / (elapsed / 1000) / c.count, samples: c.samples, captureBytes: c.bytes, serverCpuPercentOneCore: server, baselineServerCpu: base.server, serverDelta: delta, serverTargetPass: mode === 'baseline' ? null : c.count === 21 && active ? delta <= 10 : null, captureBatchP50: percentile(.5), captureBatchP95: percentile(.95), captureBatchP99: percentile(.99), captureBatchMax: c.latencies.at(-1) ?? null, allFourConfigsCallerAndCaptureChildrenCpu: caller, allFourConfigsCallerDelta: caller - base.caller, hz, cpu: cpus()[0]?.model, tmuxVersion: tmux(c.socket, ['-V']).trim(), scope: '4 servers measured concurrently, capture-only; no worker/writer; fixed incremental 20 new rows + 3 anchor at 100 rows/s' }));
          expect(Number.isFinite(server)).toBe(true);
          expect(elapsed).toBeGreaterThanOrEqual(60000);
          if (mode !== 'baseline') expect(c.samples).toBeGreaterThan(0);
        }
      } finally {
        for (const c of configs) spawnSync('tmux', ['-S', c.socket, 'kill-server'], { encoding: 'utf8', env: privateEnv });
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
});
