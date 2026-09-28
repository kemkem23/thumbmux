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
import { spawnSync } from "node:child_process";
import { assertContractFixturePort } from "../contract/fixtures/runtime-guard";

const roots: string[] = [];
const runner = resolve(import.meta.dir, "contract-fixtures.sh");

// Parse source only; never execute the runner or its tmux lifecycle.
function parseRunnerSource(source: string) {
  const parsed = spawnSync("/usr/bin/python3", ["-B", "-I", "-S", "-c", `
import json, runpy, sys
parser = runpy.run_path(sys.argv[1])
source = sys.stdin.read()
shell = parser["Shell"](source)
statements = list(shell.commands())
def token(word):
    value = "".join(value for kind, value in word) if all(kind == "literal" for kind, _ in word) else None
    return {"value": value, "start": word.start, "end": word.end}
print(json.dumps({
    "commands": list(parser["command_argv"](source)),
    "statements": [[token(word) for word in words] for words in statements],
    "words": [token(word) for _, _, words in shell.recorded_commands for word in words],
}))
`, resolve(import.meta.dir, "shell-command-parser.py")], {
    input: source, encoding: "utf8",
  });
  if (parsed.status !== 0) throw new Error(`shell parser failed: ${parsed.stderr}`);
  return JSON.parse(parsed.stdout) as {
    commands: (string | null)[][];
    statements: { value: string | null; start: number; end: number }[][];
    words: { value: string | null; start: number; end: number }[];
  };
}

function assertPrivateTmuxReadyAfterLock(source: string) {
  const { statements, words } = parseRunnerSource(source);
  const locks = statements.filter((statement) =>
    JSON.stringify(statement.map((word) => word.value)) === JSON.stringify(["if", "!", "flock", "-n", "9"]),
  );
  expect(locks).toHaveLength(1);
  const lockIndex = statements.indexOf(locks[0]);
  // Pin the failure branch through its closing fi: after flock alone is not
  // enough, since setting readiness inside that branch still affects losers.
  expect(statements.slice(lockIndex + 1, lockIndex + 5).map((statement) =>
    statement.map((word) => word.value),
  )).toEqual([
    ["then"],
    ["echo", null],
    ["exit", "1"],
    ["fi"],
  ]);
  const successPosition = statements[lockIndex + 4][0].end;
  const readyAssignments = words.filter((word) => word.value === "PRIVATE_TMUX_READY=1");
  expect(readyAssignments.length).toBeGreaterThan(0);
  for (const assignment of readyAssignments) {
    expect(assignment.start).toBeGreaterThan(successPosition);
  }
}

// svelte-check receives a tsconfig, not a .svelte positional argument: prove
// both copies feed that command, then prove the config selects the copied file.
function assertSemanticProbeInput(source: string, config: string, parentConfig: string) {
  const { commands } = parseRunnerSource(source);
  const inputChain = [
    ["cp", "<SCRIPT_DIR>/contract-app-host-probe.svelte", "src/ContractProbe.svelte"],
    ["cp", "<SCRIPT_DIR>/contract-app-host-tsconfig.json", "contract-app-host-tsconfig.json"],
    ["./node_modules/.bin/svelte-check", "--tsconfig", "./contract-app-host-tsconfig.json", "--fail-on-warnings"],
  ];
  expect(commands.some((_, index) => inputChain.every((argv, offset) =>
    JSON.stringify(commands[index + offset]) === JSON.stringify(argv),
  ))).toBe(true);
  const selected = JSON.parse(config);
  // The frozen parent has a leading license comment; no other JSONC is needed.
  const parent = JSON.parse(parentConfig.replace(/^\s*\/\*[\s\S]*?\*\//, ""));
  expect(selected.extends).toBe("./tsconfig.json");
  expect(parent.extends).toBeUndefined();
  for (const settings of [parent, selected]) {
    expect(settings.exclude ?? []).toEqual([]);
  }
  expect(Array.isArray(selected.include)).toBe(true);
  expect(selected.include.some((pattern: string) =>
    new Bun.Glob(pattern).match("src/ContractProbe.svelte"),
  )).toBe(true);
}

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
    assertSemanticProbeInput(
      source,
      readFileSync(resolve(import.meta.dir, "contract-app-host-tsconfig.json"), "utf8"),
      readFileSync(resolve(import.meta.dir, "../contract/fixtures/app-host/tsconfig.json"), "utf8"),
    );
  });

  test("semantic probe input rejects unrelated checks and excluded probe files", () => {
    const source = readFileSync(runner, "utf8");
    const config = readFileSync(resolve(import.meta.dir, "contract-app-host-tsconfig.json"), "utf8");
    const parent = readFileSync(resolve(import.meta.dir, "../contract/fixtures/app-host/tsconfig.json"), "utf8");
    const unrelated = source.replace(
      /\.\/node_modules\/\.bin\/svelte-check \\\n\s*--tsconfig \.\/contract-app-host-tsconfig\.json \\\n\s*--fail-on-warnings/,
      "./node_modules/.bin/svelte-check unrelated.svelte\n# contract-app-host-probe.svelte is not checked",
    );
    expect(unrelated).not.toBe(source);
    expect(() => assertSemanticProbeInput(unrelated, config, parent)).toThrow();
    const commentedCopy = source.replace(
      '      cp "$SCRIPT_DIR/contract-app-host-probe.svelte" src/ContractProbe.svelte',
      '      # cp "$SCRIPT_DIR/contract-app-host-probe.svelte" src/ContractProbe.svelte',
    );
    expect(commentedCopy).not.toBe(source);
    expect(() => assertSemanticProbeInput(commentedCopy, config, parent)).toThrow();
    expect(() => assertSemanticProbeInput(source,
      JSON.stringify({ ...JSON.parse(config), include: ["type-contract.ts"] }), parent)).toThrow();
    expect(() => assertSemanticProbeInput(source,
      JSON.stringify({ ...JSON.parse(config), exclude: ["src/**/*.svelte"] }), parent)).toThrow();
  });

  test("runner uses an atomic tmux-namespace lock and never sweeps sessions", () => {
    const source = readFileSync(runner, "utf8");
    const cleanup = readFileSync(
      resolve(import.meta.dir, "private-test-tmux-cleanup.sh"),
      "utf8",
    );
    expect(source).toContain("flock -n");
    expect(source).toContain('THUMBMUX_TEST_TMUX_SOCKET="$TMUX_SOCKET"');
    expect(source).toContain('private-test-tmux.sh');
    expect(source).toContain('private-test-tmux-cleanup.sh');
    expect(source).toContain('unset TMUX TMUX_PANE');
    expect(source).toContain(
      'stop_private_tmux_server /usr/bin/tmux "$TMUX_SOCKET" "$TMUX_ROOT"',
    );
    expect(source).toContain("stop_private_tmux_through_attested_shim");
    expect(source).toContain("LC_ALL=C tmux kill-server");
    expect(source).toContain("_cortex_private_tmux_is_no_server");
    expect(source).toContain('/usr/bin/kill -0 "$server_pid"');
    expect(source).toContain('[[ "$tmux_cleanup_safe" == 1 ]]');
    expect(cleanup).toContain("_cortex_private_tmux_quarantine_stale_socket");
    expect(cleanup).toContain("/usr/bin/mv --no-copy -n -T");
    expect(cleanup).toContain("original_socket_identity");
    expect(source).not.toContain("tmux kill-session");
  });

  test("every private tmux readiness assignment follows successful lock acquisition", () => {
    assertPrivateTmuxReadyAfterLock(readFileSync(runner, "utf8"));
  });

  test("lock ordering rejects early, duplicate, and failure-branch readiness", () => {
    const source = readFileSync(runner, "utf8");
    const assignment = "PRIVATE_TMUX_READY=1\n";
    const withoutReady = source.replaceAll(assignment, "");
    const lock = 'exec 9>"$LOCK_FILE"';
    const failure = '  echo "contract fixtures: another runner owns $LOCK_FILE"';
    const mutants = [
      withoutReady.replace(lock, assignment + lock),
      source.replace(lock, assignment + lock),
      withoutReady.replace(failure, "  " + assignment + failure),
      withoutReady,
    ];
    for (const mutant of mutants) {
      expect(mutant).not.toBe(source);
      expect(() => assertPrivateTmuxReadyAfterLock(mutant)).toThrow();
    }
    assertPrivateTmuxReadyAfterLock("# PRIVATE_TMUX_READY=1\n" + source);
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

  test("app consumer uses the exact browser installed by the verify gate", () => {
    const source = readFileSync(runner, "utf8");
    const lock = readFileSync(resolve(import.meta.dir, "../bun.lock"), "utf8");

    expect(source).toContain("'devDependencies.@playwright/test=1.61.1'");
    expect(source).not.toContain("'devDependencies.@playwright/test=^1.61.1'");
    expect(lock).toContain('"@playwright/test": ["@playwright/test@1.61.1"');
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
