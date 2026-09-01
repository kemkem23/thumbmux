#!/usr/bin/bash -p
case "$-" in *p*) ;; *) printf 'ci-parity: privileged interpreter is required\n' >&2; exit 126 ;; esac
THUMBMUX_ENTRY_CALLER_PATH="${PATH-}"
PATH=/usr/bin:/bin
export PATH THUMBMUX_ENTRY_CALLER_PATH
unset BASH_ENV ENV CDPATH GLOBIGNORE NODE_OPTIONS BUN_OPTIONS NODE_PATH \
  PYTHONPATH PYTHONHOME PYTHONSTARTUP LD_PRELOAD LD_LIBRARY_PATH \
  GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY \
  GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_CONFIG_GLOBAL GIT_CONFIG_SYSTEM \
  GIT_CONFIG_NOSYSTEM GIT_CONFIG_COUNT 2>/dev/null || :
# Run the CI unit-test gate against a clean export of the committed tree.
#
# Why this exists: the workflows in .github/ only fire in the public repo, and
# the package is developed inside a private monorepo. Between two releases the
# committed state can therefore go untested by CI entirely — v0.8.0 accumulated
# 51 commits that way and the first thing CI ever said about them was "no".
#
# What it catches that `bun test` in your working tree cannot:
#   - tests that read a build artifact (git-dist) left over from an earlier run
#   - paths that escape the package and resolve against the host repo
#   - anything the lockfile installs differently from your incremental tree
#
# Run before pushing a release tag. Exits non-zero on the first failure.
set -euo pipefail

script_path="$(/usr/bin/realpath -e -- "${BASH_SOURCE[0]}")" \
  || { printf 'ci-parity: entrypoint path is unavailable\n' >&2; exit 126; }
package_dir="$(cd "$(/usr/bin/dirname -- "$script_path")/.." && pwd -P)"
cd "$package_dir"
runtime_guard="$package_dir/scripts/test-runtime-guard.sh"
[[ -f "$runtime_guard" && ! -L "$runtime_guard" ]] \
  || { echo 'ci-parity: INCOMPLETE — runtime admission guard is unavailable' >&2; exit 2; }
# shellcheck source=/dev/null
. "$runtime_guard"
prefix="$(thumbmux_guard_git rev-parse --show-prefix)"     # "" in the public repo, "packages/thumbmux/" in the monorepo
repo_root="$(thumbmux_guard_git rev-parse --show-toplevel)"

# The public repository's GitHub-hosted job is disposable. Inside the monorepo,
# parity includes real tmux/browser/Docker lifecycle, so a direct local call
# must enter the shared hard sandbox. That sandbox deliberately has no Docker
# or outbound network: it attests containment and then reports full parity as
# INCOMPLETE instead of reconnecting either capability.
if [[ -n "$prefix" ]]; then
  if [[ "${CORTEX_TEST_HARD_SANDBOX-}" == command ]]; then
    verifier="$repo_root/ops/testing/assert-hard-test-sandbox.sh"
    [[ -f "$runtime_guard" && ! -L "$runtime_guard" \
      && -f "$verifier" && ! -L "$verifier" \
      && "${CORTEX_TEST_RUNTIME-}" == /run/kemcortex-isolated-command ]] \
      || { echo 'ci-parity: INCOMPLETE — local hard-sandbox attestation is unavailable' >&2; exit 2; }
    # shellcheck source=/dev/null
    . "$runtime_guard"
    thumbmux_assert_command_sandbox_abi_v2 /run/kemcortex-isolated-command \
      || { echo 'ci-parity: INCOMPLETE — command sandbox ABI v2 attestation failed' >&2; exit 2; }
    # shellcheck source=/dev/null
    . "$verifier"
    assert_hard_test_sandbox command "$CORTEX_TEST_RUNTIME" \
      || { echo 'ci-parity: INCOMPLETE — local hard-sandbox attestation failed' >&2; exit 2; }
    echo "ci-parity: INCOMPLETE — full parity requires disposable public CI; host Docker/network stay fenced" >&2
    exit 2
  fi

  case "${CORTEX_TEST_ISOLATED:-}" in
    1)
      echo "ci-parity: INCOMPLETE — isolated marker without hard-sandbox attestation" >&2
      exit 2
      ;;
    ci-disposable)
      echo "ci-parity: INCOMPLETE — monorepo runs may not claim disposable Docker parity" >&2
      exit 2
      ;;
    "")
      runner="${repo_root}/ops/testing/run-isolated-command.sh"
      [[ -x "$runner" ]] \
        || { echo "ci-parity: INCOMPLETE — isolated runner is unavailable: $runner" >&2; exit 2; }
      exec "$runner" -- "$script_path" "$@"
      ;;
    *)
      echo "ci-parity: FAILED — unrecognized CORTEX_TEST_ISOLATED marker" >&2
      exit 2
      ;;
  esac
fi

workspace_real="$(/usr/bin/realpath -e -- "${GITHUB_WORKSPACE-}" 2>/dev/null || true)"
runner_temp_real="$(/usr/bin/realpath -e -- "${RUNNER_TEMP-}" 2>/dev/null || true)"
git_head="$(thumbmux_guard_git rev-parse HEAD 2>/dev/null || true)"
if [[ "${GITHUB_ACTIONS-}" != true \
  || "${CI-}" != true \
  || "${RUNNER_ENVIRONMENT-}" != github-hosted \
  || "${GITHUB_REPOSITORY-}" != kemkem23/thumbmux \
  || ! "${GITHUB_RUN_ID-}" =~ ^[0-9]+$ \
  || ! "${GITHUB_RUN_ATTEMPT-}" =~ ^[0-9]+$ \
  || ! "${GITHUB_SHA-}" =~ ^[a-f0-9]{40}$ \
  || "$git_head" != "$GITHUB_SHA" \
  || "$(id -un)" != runner \
  || "$workspace_real" != "$repo_root" \
  || "$repo_root" != /home/runner/work/*/* \
  || "$runner_temp_real" != /home/runner/work/_temp ]]; then
  echo "ci-parity: INCOMPLETE — standalone full parity is restricted to attested GitHub-hosted CI" >&2
  exit 2
fi

# Container names, paths, images, ports, and binaries are harness-owned in the
# genuinely disposable public-CI lane. Inherited THUMBMUX_* overrides once made
# cleanup capable of targeting an unrelated host container. Reject rather than
# silently sanitize so an unsafe caller cannot receive a misleading green run.
for forbidden_override in THUMBMUX_CONTAINER THUMBMUX_PACKAGE_DIR \
  THUMBMUX_E2E_IMAGE THUMBMUX_DEMO_PORT THUMBMUX_HOST_PORT \
  THUMBMUX_E2E_READY_TIMEOUT THUMBMUX_E2E_ARTIFACTS \
  THUMBMUX_PLAYWRIGHT_BIN DOCKER_HOST DOCKER_CONTEXT DOCKER_CONFIG \
  DOCKER_CERT_PATH DOCKER_TLS_VERIFY DOCKER_API_VERSION; do
  [[ -z "${!forbidden_override-}" ]] \
    || { echo "ci-parity: FAILED — $forbidden_override is harness-owned" >&2; exit 1; }
done

if [[ "${THUMBMUX_SKIP_E2E:-0}" == 1 ]]; then
  echo "ci-parity: INCOMPLETE — THUMBMUX_SKIP_E2E=1 cannot produce a passing parity result" >&2
  exit 1
fi

# Parity means the same toolchain, not just the same commands. setup-bun was
# unpinned once and CI silently moved to bun 1.3.14, where demo/dogfooding.test.ts
# deadlocks — five release attempts burned while this script ran green on 1.3.11.
# A gate that runs a different interpreter than CI is not a parity gate.
#
# Bun pin lives in the shared verify-gate composite (single source of truth for
# both ci.yml and release.yml). Do not re-read it from a workflow file.
THUMBMUX_GUARD_RUNTIME=''
cleanup() {
  local rc=$?
  set +e
  if [[ -n "$THUMBMUX_GUARD_RUNTIME" ]]; then
    thumbmux_remove_test_runtime || rc=1
  fi
  trap - EXIT
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

thumbmux_prepare_test_runtime ci-parity "$package_dir" \
  || { echo 'ci-parity: INCOMPLETE — clean disposable checkout admission failed' >&2; exit 2; }
RUN_ID="$(thumbmux_make_run_id)"
thumbmux_bind_run_attestation "$RUN_ID" ci-parity

pinned_bun="$(/usr/bin/grep -oP 'bun-version:\s*\K[0-9]+\.[0-9]+\.[0-9]+' .github/actions/verify-gate/action.yml | /usr/bin/head -1 || true)"
local_bun="$("$THUMBMUX_GUARD_BUN_BIN" --version)"
if [ -z "$pinned_bun" ]; then
  echo "ci-parity: FAILED — .github/actions/verify-gate/action.yml does not pin bun-version" >&2
  exit 1
fi
if [ "$pinned_bun" != "$local_bun" ]; then
  echo "ci-parity: FAILED — verify-gate pins bun $pinned_bun, this shell runs $local_bun" >&2
  exit 1
fi
echo "ci-parity: bun $local_bun matches the verify-gate pin"

[[ -z "${THUMBMUX_CONTRACT_REMOTE_URL-}" ]] \
  || { echo 'ci-parity: FAILED — contract remote override is forbidden' >&2; exit 1; }
contract_remote_url="$(thumbmux_guard_git -C "$repo_root" remote get-url origin)"

work="$THUMBMUX_GUARD_RUNTIME/export"
/usr/bin/install -d -m 0700 "$work"
thumbmux_emit_frozen_source_archive | /usr/bin/tar -x -C "$work" \
  || { echo 'ci-parity: FAILED — frozen source export failed' >&2; exit 1; }
thumbmux_guard_git -C "$work" init -q
thumbmux_guard_git -C "$work" add -f -A
export_tree="$(thumbmux_guard_git -C "$work" write-tree)"
[[ "$export_tree" == "$THUMBMUX_GUARD_SOURCE_TREE" ]] \
  || { echo 'ci-parity: FAILED — frozen export tree differs from admitted commit' >&2; exit 1; }
export_commit="$(printf 'thumbmux frozen CI parity export\n' \
  | /usr/bin/env -i PATH=/usr/bin:/bin HOME=/nonexistent \
    GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_ATTR_NOSYSTEM=1 \
    GIT_AUTHOR_NAME=thumbmux-ci GIT_AUTHOR_EMAIL=ci@invalid \
    GIT_COMMITTER_NAME=thumbmux-ci GIT_COMMITTER_EMAIL=ci@invalid \
    GIT_AUTHOR_DATE='2000-01-01T00:00:00Z' GIT_COMMITTER_DATE='2000-01-01T00:00:00Z' \
    /usr/bin/git -c core.fsmonitor=false -c core.hooksPath=/dev/null \
      -C "$work" commit-tree "$export_tree")"
thumbmux_guard_git -C "$work" update-ref refs/heads/frozen "$export_commit"
thumbmux_guard_git -C "$work" symbolic-ref HEAD refs/heads/frozen
[[ "$(thumbmux_guard_git -C "$work" rev-list --count HEAD)" == 1 \
  && -z "$(thumbmux_guard_git -C "$work" remote)" \
  && -z "$(thumbmux_guard_git -C "$work" status --porcelain --untracked-files=normal)" ]] \
  || { echo 'ci-parity: FAILED — frozen export repository is not exact and clean' >&2; exit 1; }
export THUMBMUX_PUBLIC_EXPORT_ATTESTATION="$THUMBMUX_GUARD_ATTESTATION"
export THUMBMUX_PUBLIC_EXPORT_ROOT="$work"
export THUMBMUX_PUBLIC_EXPORT_PARENT_IDENTITY="$THUMBMUX_GUARD_RUNTIME_IDENTITY"

# Print the commit hash next to the archive ref. A gate that only says
# "exporting HEAD:…" lets a lane report a green log taken 44s *before* its
# own fix commit and look identical to a real green (v0156 CJK review).
export_head="$THUMBMUX_GUARD_SOURCE_SHA"
export_subj="$(thumbmux_guard_git -C "$repo_root" log -1 --format='%s' "$export_head")"
echo "ci-parity: exporting frozen tree $THUMBMUX_GUARD_SOURCE_TREE @ $export_head ($export_subj) -> $work"
cd "$work"

baseline_root="$THUMBMUX_GUARD_RUNTIME/contract-baseline"
THUMBMUX_CONTRACT_REMOTE_URL="$contract_remote_url" \
  "$THUMBMUX_GUARD_BUN_BIN" scripts/materialize-contract-baseline.ts "$baseline_root"
# The baseline is required by default now; supplying the root is the whole job.
# THUMBMUX_CONTRACT_REQUIRE_BASELINE used to be what made a missing baseline an
# error, which meant a hand-run `bun run contract` was green without ever
# checking the frozen surface. Keeping a dead switch here would suggest it is
# still load-bearing.
export THUMBMUX_CONTRACT_BASELINE_ROOT="$baseline_root"

# Fail loudly rather than run a green suite over an empty directory.
for required in package.json bun.lock core/package.json server/package.json svelte/package.json app/package.json; do
  [ -f "$required" ] || { echo "ci-parity: export is missing $required — refusing to report a result" >&2; exit 1; }
done

echo "ci-parity: bun install --frozen-lockfile"
"$THUMBMUX_GUARD_BUN_BIN" install --frozen-lockfile

# Artifact tests read git-dist; the workflows build it before the suite too.
echo "ci-parity: bun run build:git-dist"
"$THUMBMUX_GUARD_BUN_BIN" run build:git-dist

echo "ci-parity: unit suite (release-parity command)"
"$THUMBMUX_GUARD_BUN_BIN" test ./server/tests/*.test.ts ./core/tests/*.test.ts ./core/src/*.test.ts \
  ./svelte/tests/*.test.ts ./app/tests/*.test.ts ./demo/*.test.ts ./scripts/*.test.ts

echo "ci-parity: demo builds"
(cd demo && "$THUMBMUX_GUARD_BUN_BIN" run build)

echo "ci-parity: packages build & pack (publish readiness)"
(cd core && "$THUMBMUX_GUARD_BUN_BIN" run build && "$THUMBMUX_GUARD_BUN_BIN" pm pack)
(cd server && "$THUMBMUX_GUARD_BUN_BIN" run build && "$THUMBMUX_GUARD_BUN_BIN" pm pack)
(cd svelte && "$THUMBMUX_GUARD_BUN_BIN" run build && "$THUMBMUX_GUARD_BUN_BIN" pm pack)
(cd app && "$THUMBMUX_GUARD_BUN_BIN" run build && "$THUMBMUX_GUARD_BUN_BIN" pm pack)

echo "ci-parity: bun run contract"
"$THUMBMUX_GUARD_BUN_BIN" run contract

echo "ci-parity: bun run smoke:git-dist"
"$THUMBMUX_GUARD_BUN_BIN" run smoke:git-dist

# The canonical disposable-container runner owns Playwright collection and
# --forbid-only together with its Docker/runtime attestation. Running a direct
# preflight here would bypass that attestation and must fail closed.
echo "ci-parity: ./e2e/run-container.sh"
./e2e/run-container.sh

echo "ci-parity: ./scripts/contract-fixtures.sh"
./scripts/contract-fixtures.sh

echo "ci-parity: PASSED against the committed tree"
