// bunfig.toml [test] preload for this package. Runs before any test module
// body, so a bare `bun test` invoked directly inside packages/thumbmux (or a
// subdirectory of it) aborts before a single test that spawns real tmux can
// reach the host's production server.
//
// server/tests/*.test.ts (bun-driver-targeting.test.ts and several siblings)
// spawn tmux with no `-S` at all — see the file-level comment there. That is
// safe only inside the private mount namespace
// ops/testing/run-isolated-command.sh creates for ops/testing/run-thumbmux-suite.sh:
// there, the default tmux socket path itself is namespace-isolated from the
// host, so bare tmux cannot reach the real server even without an explicit
// `-S`. Nothing in this package enforced that path before this guard — the
// monorepo root has an equivalent guard (tests/tmux-isolation-guard.ts, wired
// through the root bunfig.toml's `[test] preload`), but Bun resolves
// bunfig.toml from the current working directory upward and stops at the
// first one found, so `cd packages/thumbmux && bun test` (or any subdirectory
// of it) never reaches the root file — it uses this package's own
// bunfig.toml instead, which had no such guard.
//
// This package is also distributed standalone (github:kemkem23/thumbmux) and
// built in GitHub Actions without any of the monorepo's sandbox machinery, so
// admission here has two independent paths: the monorepo's local hard
// sandbox, or GitHub-hosted CI. Neither is cryptographic proof of isolation —
// it is the same environment-variable/receipt-file trust level the rest of
// this codebase's other test-isolation guards already use (see
// packages/thumbmux/scripts/test-runtime-guard.sh's own admission checks) —
// but it closes the gap where nothing was checked at all.

import { existsSync, readFileSync, statSync } from "node:fs";

const EXIT_CODE = 97;

function fail(reason: string): never {
  console.error(`thumbmux tmux isolation guard: REFUSED: ${reason}`);
  console.error(
    "thumbmux tmux isolation guard: run through ops/testing/run-thumbmux-suite.sh " +
      "(from the monorepo root) or the GitHub Actions workflow — not a bare " +
      "`bun test` invoked directly inside packages/thumbmux.",
  );
  process.exit(EXIT_CODE);
}

type OwnershipCheck =
  | { owned: true }
  | { owned: false; reason: string };

function octalMode(mode: number): string {
  return `0${mode.toString(8)}`;
}

function ownedDirectory(path: string, mode: number): OwnershipCheck {
  try {
    const st = statSync(path);
    if (!st.isDirectory()) {
      return {
        owned: false,
        reason: `runtime path=${path} type=not-directory expected=directory`,
      };
    }
    const expectedUid = process.getuid?.();
    if (st.uid !== expectedUid) {
      return {
        owned: false,
        reason: `runtime path=${path} owner uid=${st.uid} expected uid=${String(expectedUid)}`,
      };
    }
    const actualMode = st.mode & 0o777;
    if (actualMode !== mode) {
      return {
        owned: false,
        reason: `runtime path=${path} mode=${octalMode(actualMode)} expected mode=${octalMode(mode)}`,
      };
    }
    return { owned: true };
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String(error.code)
        : "unknown";
    return {
      owned: false,
      reason: `runtime path=${path} stat=failed error=${code} expected=directory`,
    };
  }
}

function ownedFile(path: string, mode: number): boolean {
  try {
    const st = statSync(path);
    return st.isFile() && st.uid === process.getuid?.() && (st.mode & 0o777) === mode;
  } catch {
    return false;
  }
}

/**
 * The local monorepo hard sandbox: ops/testing/run-isolated-command-namespace.sh
 * sets CORTEX_TEST_HARD_SANDBOX=command and writes a version=2/kind=command
 * receipt at /run/kemcortex-isolated-command/sandbox-attestation before this
 * process ever starts — the same receipt
 * packages/thumbmux/scripts/test-runtime-guard.sh's
 * thumbmux_assert_command_sandbox_abi_v2 checks.
 */
function localSandboxAdmitted(): boolean {
  if (process.env.CORTEX_TEST_HARD_SANDBOX !== "command") return false;
  const runtime = process.env.CORTEX_TEST_RUNTIME ?? "";
  const attestation = process.env.CORTEX_TEST_SANDBOX_ATTESTATION ?? "";
  if (runtime !== "/run/kemcortex-isolated-command") return false;
  if (attestation !== `${runtime}/sandbox-attestation`) return false;
  const runtimeOwnership = ownedDirectory(runtime, 0o700);
  if (!runtimeOwnership.owned) {
    localSandboxRefusalReason = runtimeOwnership.reason;
    return false;
  }
  if (!ownedFile(attestation, 0o600)) return false;
  if (!existsSync(attestation)) return false;
  const lines = readFileSync(attestation, "utf8").split("\n");
  return lines[0] === "version=2" && lines[1] === "kind=command";
}

let localSandboxRefusalReason: string | undefined;

/** GitHub-hosted CI, mirroring test-runtime-guard.sh's thumbmux_assert_public_markers. */
function publicCiAdmitted(): boolean {
  return (
    process.env.CI === "true" &&
    process.env.GITHUB_ACTIONS === "true" &&
    process.env.RUNNER_ENVIRONMENT === "github-hosted" &&
    process.env.GITHUB_REPOSITORY === "kemkem23/thumbmux" &&
    /^[0-9]+$/.test(process.env.GITHUB_RUN_ID ?? "") &&
    /^[0-9]+$/.test(process.env.GITHUB_RUN_ATTEMPT ?? "") &&
    /^[a-f0-9]{40}$/.test(process.env.GITHUB_SHA ?? "") &&
    process.env.RUNNER_TEMP !== undefined &&
    process.env.RUNNER_TEMP !== ""
  );
}

if (!localSandboxAdmitted() && !publicCiAdmitted()) {
  fail(
    (localSandboxRefusalReason === undefined
      ? ""
      : `${localSandboxRefusalReason}; `) +
      "neither the local hard-sandbox receipt (CORTEX_TEST_HARD_SANDBOX=command, " +
      "/run/kemcortex-isolated-command/sandbox-attestation) nor GitHub-hosted CI " +
      "markers are present; several files under server/tests/ spawn real tmux " +
      "with no -S, which would reach the host's production socket outside one " +
      "of those two contexts",
  );
}
