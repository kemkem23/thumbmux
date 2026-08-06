import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const roots: string[] = [];
const runner = resolve(import.meta.dir, "contract-fixtures.sh");

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("frozen consumer runner policy", () => {
  test("refusal preserves a pre-existing ctrfix session", () => {
    const root = mkdtempSync(join(tmpdir(), "thumbmux-contract-runner-test-"));
    roots.push(root);
    const bin = join(root, "bin");
    const log = join(root, "tmux.log");
    const temp = join(root, "tmp");
    mkdirSync(bin);
    mkdirSync(temp);
    const fakeTmux = join(bin, "tmux");
    writeFileSync(fakeTmux, [
      "#!/bin/sh",
      'if [ "$1" = "list-sessions" ]; then',
      "  echo ctrfix-existing",
      "  exit 0",
      "fi",
      'if [ "$1" = "kill-session" ]; then',
      '  printf "%s\\n" "$*" >> "$THUMBMUX_FAKE_TMUX_LOG"',
      "  exit 0",
      "fi",
      "exit 0",
      "",
    ].join("\n"));
    chmodSync(fakeTmux, 0o755);

    const result = Bun.spawnSync({
      cmd: ["bash", runner],
      cwd: resolve(import.meta.dir, ".."),
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        TMPDIR: temp,
        THUMBMUX_FAKE_TMUX_LOG: log,
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain(
      "refusing to start while ctrfix-* sessions already exist",
    );
    expect(existsSync(log) ? readFileSync(log, "utf8") : "").toBe("");
  });

  test("app fixture runs a semantic Svelte component consumer", () => {
    const source = readFileSync(runner, "utf8");
    const probe = resolve(import.meta.dir, "contract-app-host-probe.svelte");

    expect(existsSync(probe)).toBe(true);
    expect(source).toContain("svelte-check");
    expect(source).toContain("contract-app-host-probe.svelte");
    expect(readFileSync(probe, "utf8")).toContain("<ThumbmuxApp {adapters} />");
  });

  test("runner uses an atomic tmux-namespace lock and never sweeps sessions", () => {
    const source = readFileSync(runner, "utf8");
    expect(source).toContain("flock -n");
    expect(source).toContain('TMUX_TMPDIR:-/tmp');
    expect(source).toContain('TMUX%%,*');
    expect(source).not.toContain("tmux kill-session");
  });

  test("two runners on one TMUX socket cannot split locks with temp overrides", async () => {
    const root = mkdtempSync(join(tmpdir(), "thumbmux-contract-lock-test-"));
    roots.push(root);
    const bin = join(root, "bin");
    const tempA = join(root, "tmp-a");
    const tempB = join(root, "tmp-b");
    const tmuxTempA = join(root, "tmux-a");
    const tmuxTempB = join(root, "tmux-b");
    const tmuxSocket = join(root, "shared.sock");
    const marker = join(root, "first-entered");
    for (const path of [bin, tempA, tempB, tmuxTempA, tmuxTempB]) mkdirSync(path);
    const fakeTmux = join(bin, "tmux");
    writeFileSync(fakeTmux, [
      "#!/bin/sh",
      'if [ "$1" = "list-sessions" ]; then',
      '  : > "$THUMBMUX_LOCK_TEST_MARKER"',
      "  sleep 5",
      "  exit 1",
      "fi",
      "exit 0",
      "",
    ].join("\n"));
    chmodSync(fakeTmux, 0o755);
    const commonEnv = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      TMUX: `${tmuxSocket},123,0`,
      THUMBMUX_LOCK_TEST_MARKER: marker,
    };
    const first = Bun.spawn(["bash", runner], {
      cwd: resolve(import.meta.dir, ".."),
      env: { ...commonEnv, TMPDIR: tempA, TMUX_TMPDIR: tmuxTempA },
      stdout: "ignore",
      stderr: "ignore",
    });
    try {
      for (let attempt = 0; attempt < 100 && !existsSync(marker); attempt++) {
        await Bun.sleep(10);
      }
      expect(existsSync(marker)).toBe(true);
      // A bounded wait, because this is the assertion that hangs when it is
      // wrong. The second runner is supposed to lose the lock race and exit
      // immediately; if it instead blocks — a lock that waits rather than
      // failing, a first runner whose grandchildren still hold it — an
      // unbounded spawnSync waits forever, and a test that hangs reports
      // nothing at all. On CI that ran to the job ceiling with no culprit
      // named. Two minutes is far past "immediately".
      const second = Bun.spawnSync({
        cmd: ["bash", runner],
        cwd: resolve(import.meta.dir, ".."),
        env: { ...commonEnv, TMPDIR: tempB, TMUX_TMPDIR: tmuxTempB },
        stdout: "pipe",
        stderr: "pipe",
        timeout: 120_000,
      });
      expect(second.exitCode).not.toBe(0);
      expect(second.stderr.toString()).toContain("another runner owns");
    } finally {
      // `first` is bash; the work it started is its children. Killing only bash
      // leaves them holding the lock the second runner is racing for, which is
      // the shape that turns a failed assertion into a hung job. Signal the
      // group, then bound the wait so cleanup cannot become the hang either.
      try { process.kill(-first.pid, "SIGTERM"); } catch { first.kill(); }
      await Promise.race([first.exited, Bun.sleep(30_000)]);
    }
  });
});
