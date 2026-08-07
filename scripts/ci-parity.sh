#!/usr/bin/env bash
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

if [ "${THUMBMUX_SKIP_E2E:-0}" = "1" ]; then
  echo "ci-parity: INCOMPLETE — THUMBMUX_SKIP_E2E=1 cannot produce a passing parity result" >&2
  exit 1
fi

package_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$package_dir"

# Parity means the same toolchain, not just the same commands. setup-bun was
# unpinned once and CI silently moved to bun 1.3.14, where demo/dogfooding.test.ts
# deadlocks — five release attempts burned while this script ran green on 1.3.11.
# A gate that runs a different interpreter than CI is not a parity gate.
#
# Bun pin lives in the shared verify-gate composite (single source of truth for
# both ci.yml and release.yml). Do not re-read it from a workflow file.
pinned_bun="$(grep -oP 'bun-version:\s*\K[0-9]+\.[0-9]+\.[0-9]+' .github/actions/verify-gate/action.yml | head -1 || true)"
local_bun="$(bun --version)"
if [ -z "$pinned_bun" ]; then
  echo "ci-parity: FAILED — .github/actions/verify-gate/action.yml does not pin bun-version" >&2
  exit 1
fi
if [ "$pinned_bun" != "$local_bun" ]; then
  echo "ci-parity: FAILED — verify-gate pins bun $pinned_bun, this shell runs $local_bun" >&2
  exit 1
fi
echo "ci-parity: bun $local_bun matches the verify-gate pin"

# `git archive HEAD:<path>` resolves <path> against the CURRENT directory, not
# the repo root — running it from inside the package yields an empty archive
# and exit 0, so the whole gate silently tests nothing. Archive from the top.
prefix="$(git rev-parse --show-prefix)"     # "" in the public repo, "packages/thumbmux/" in the monorepo
repo_root="$(git rev-parse --show-toplevel)"
if [ -n "$prefix" ]; then
  archive_ref="HEAD:${prefix%/}"
else
  archive_ref="HEAD"
fi

work="$(mktemp -d -t thumbmux-ci-parity-XXXXXX)"
cleanup() { rm -rf "$work"; }
trap cleanup EXIT

if [ -n "${THUMBMUX_CONTRACT_REMOTE_URL:-}" ]; then
  contract_remote_url="$THUMBMUX_CONTRACT_REMOTE_URL"
elif git -C "$repo_root" remote get-url thumbmux-public >/dev/null 2>&1; then
  contract_remote_url="$(git -C "$repo_root" remote get-url thumbmux-public)"
else
  contract_remote_url="$(git -C "$repo_root" remote get-url origin)"
fi

echo "ci-parity: exporting $archive_ref -> $work"
git -C "$repo_root" archive "$archive_ref" | tar -x -C "$work"
cd "$work"

baseline_root="$work/.contract-baseline"
THUMBMUX_CONTRACT_REMOTE_URL="$contract_remote_url" \
  bun scripts/materialize-contract-baseline.ts "$baseline_root"
export THUMBMUX_CONTRACT_BASELINE_ROOT="$baseline_root"
export THUMBMUX_CONTRACT_REQUIRE_BASELINE=1

# Fail loudly rather than run a green suite over an empty directory.
for required in package.json bun.lock core/package.json server/package.json svelte/package.json app/package.json; do
  [ -f "$required" ] || { echo "ci-parity: export is missing $required — refusing to report a result" >&2; exit 1; }
done

echo "ci-parity: bun install --frozen-lockfile"
bun install --frozen-lockfile

# Artifact tests read git-dist; the workflows build it before the suite too.
echo "ci-parity: bun run build:git-dist"
bun run build:git-dist

echo "ci-parity: unit suite (release-parity command)"
bun test ./server/tests/*.test.ts ./core/tests/*.test.ts ./core/src/*.test.ts \
  ./svelte/tests/*.test.ts ./app/tests/*.test.ts ./demo/*.test.ts ./scripts/*.test.ts

echo "ci-parity: demo builds"
(cd demo && bun run build)

echo "ci-parity: packages build & pack (publish readiness)"
(cd core && bun run build && bun pm pack)
(cd server && bun run build && bun pm pack)
(cd svelte && bun run build && bun pm pack)
(cd app && bun run build && bun pm pack)

echo "ci-parity: bun run contract"
bun run contract

echo "ci-parity: bun run smoke:git-dist"
bun run smoke:git-dist

# The unit suite runs in happy-dom; this is the only gate that drives a real
# browser against a real tmux. v0.8.1 shipped a one-line fix that the unit
# suite proved and this caught: unblocking an early tap made a composer button
# appear, which turned an unscoped role query in one spec into a strict-mode
# violation. Skipping this step is why that reached CI instead of stopping here.
# A committed test.only must fail before the container can report a partial suite.
echo "ci-parity: reject focused Playwright tests"
DEMO_URL="${DEMO_URL:-http://127.0.0.1:1}" \
  ./node_modules/.bin/playwright test --config=e2e/playwright.config.ts --list --forbid-only

echo "ci-parity: ./e2e/run-container.sh"
./e2e/run-container.sh

echo "ci-parity: bash scripts/contract-fixtures.sh"
bash scripts/contract-fixtures.sh

echo "ci-parity: PASSED against the committed tree"
