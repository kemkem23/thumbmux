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
import { assertContractFixturePort } from "../contract/fixtures/runtime-guard";

const roots: string[] = [];
const runner = resolve(import.meta.dir, "contract-fixtures.sh");

function untrustedHostEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env = { ...process.env } as Record<string, string>;
  for (const name of [
    "CI", "GITHUB_ACTIONS", "RUNNER_ENVIRONMENT", "GITHUB_REPOSITORY",
    "GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT", "GITHUB_SHA", "GITHUB_WORKSPACE",
    "RUNNER_TEMP", "THUMBMUX_DEDICATED_DOCKER_ROOT",
    "CORTEX_TEST_DISPOSABLE_CHECKOUT", "CORTEX_TEST_HARD_SANDBOX",
    "CORTEX_TEST_ISOLATED", "CORTEX_TEST_RUNTIME", "CORTEX_TEST_REPO_ROOT",
    "CORTEX_TEST_SANDBOX_ATTESTATION", "DOCKER_HOST", "DOCKER_CONTEXT",
  ]) delete env[name];
  return { ...env, ...extra };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("frozen consumer runner policy", () => {
  test("direct invocation fails before caller-supplied tmux or Docker can run", () => {
    const root = mkdtempSync(join(tmpdir(), "thumbmux-contract-runner-test-"));
    roots.push(root);
    const bin = join(root, "bin");
    const log = join(root, "dangerous-command.log");
    const temp = join(root, "tmp");
    mkdirSync(bin);
    mkdirSync(temp);
    const fakeCommand = [
      "#!/bin/sh",
      'printf "%s %s\\n" "$0" "$*" >> "$THUMBMUX_DANGEROUS_COMMAND_LOG"',
      "exit 0",
      "",
    ].join("\n");
    for (const name of ["bash", "git", "tmux", "docker"]) {
      const executable = join(bin, name);
      writeFileSync(executable, fakeCommand);
      chmodSync(executable, 0o755);
    }

    const bashEnv = join(root, "bash-env.sh");
    writeFileSync(
      bashEnv,
      'printf "BASH_ENV executed\\n" >> "$THUMBMUX_DANGEROUS_COMMAND_LOG"\n',
    );
    const result = Bun.spawnSync({
      cmd: [runner],
      cwd: resolve(import.meta.dir, ".."),
      env: untrustedHostEnv({
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        BASH_ENV: bashEnv,
        TMPDIR: temp,
        THUMBMUX_DANGEROUS_COMMAND_LOG: log,
      }),
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("INCOMPLETE");
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
    expect(source).toContain('THUMBMUX_TEST_TMUX_SOCKET="$TMUX_SOCKET"');
    expect(source).toContain('private-test-tmux.sh');
    expect(source).toContain('unset TMUX TMUX_PANE');
    expect(source).not.toContain("tmux kill-session");
  });

  test("consumer runtime gate binds the exact admitted Bun and Node PATH", () => {
    const runnerSource = readFileSync(runner, "utf8");
    const fixtureGuard = readFileSync(
      resolve(import.meta.dir, "../contract/fixtures/runtime-guard.ts"),
      "utf8",
    );
    const appRuntime = readFileSync(
      resolve(import.meta.dir, "../contract/fixtures/app-host/runtime.ts"),
      "utf8",
    );
    const admissionGuard = readFileSync(
      resolve(import.meta.dir, "test-runtime-guard.sh"),
      "utf8",
    );

    expect(admissionGuard).toContain(
      'PATH="/usr/bin:/bin:$(/usr/bin/dirname -- "$bun_real"):$(/usr/bin/dirname -- "$THUMBMUX_GUARD_NODE_BIN")"',
    );
    expect(runnerSource).toContain('export PATH="$PRIVATE_BIN:$PATH"');
    expect(fixtureGuard).toContain("pathParts.length !== 5");
    expect(fixtureGuard).toContain(
      'pathParts[4] !== "/opt/hostedtoolcache/node/22.23.2/x64/bin"',
    );
    expect(fixtureGuard).not.toContain("pathParts.length !== 4");
    expect(fixtureGuard).toContain(
      "bunBin !== process.env.THUMBMUX_GUARD_BUN_BIN",
    );
    expect(fixtureGuard).toContain(
      "(bunBinStat.uid !== 0 && bunBinStat.uid !== uid)",
    );
    expect(appRuntime).toContain(
      '`exec ${shellQuote(bunBin)} ${shellQuote(probePath)}`',
    );
    expect(appRuntime).not.toContain("`exec bun ");
  });

  test("consumer Bun types stay aligned with the frozen package lock", () => {
    const source = readFileSync(runner, "utf8");
    const lock = readFileSync(resolve(import.meta.dir, "../bun.lock"), "utf8");

    expect(source).toContain("'devDependencies.@types/bun=1.3.14'");
    expect(source).not.toContain("'devDependencies.@types/bun=^1.3.0'");
    expect(lock).toContain('"@types/bun": ["@types/bun@1.3.14"');
  });

  test("consumer port guard rejects an unassigned or production listener", () => {
    expect(() => assertContractFixturePort(undefined)).toThrow(
      "unsafe or reserved loopback port undefined",
    );
    expect(() => assertContractFixturePort(47_779)).toThrow(
      "unsafe or reserved loopback port 47779",
    );
    expect(() => assertContractFixturePort(48_779)).not.toThrow();
  });

  test("forged disposable markers still fail before tmux or Docker", () => {
    const root = mkdtempSync(join(tmpdir(), "thumbmux-contract-lock-test-"));
    roots.push(root);
    const bin = join(root, "bin");
    const log = join(root, "dangerous-command.log");
    mkdirSync(bin);
    const fakeCommand = [
      "#!/bin/sh",
      'printf "%s %s\\n" "$0" "$*" >> "$THUMBMUX_DANGEROUS_COMMAND_LOG"',
      "exit 0",
      "",
    ].join("\n");
    for (const name of ["git", "tmux", "docker"]) {
      const executable = join(bin, name);
      writeFileSync(executable, fakeCommand);
      chmodSync(executable, 0o755);
    }
    const result = Bun.spawnSync({
      cmd: [runner],
      cwd: resolve(import.meta.dir, ".."),
      env: untrustedHostEnv({
        CI: "1",
        CORTEX_TEST_DISPOSABLE_CHECKOUT: "1",
        THUMBMUX_DEDICATED_DOCKER_ROOT: "/tmp/thumbmux-dedicated-docker.forged",
        THUMBMUX_DANGEROUS_COMMAND_LOG: log,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
      }),
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("INCOMPLETE");
    expect(existsSync(log) ? readFileSync(log, "utf8") : "").toBe("");
  });
});
