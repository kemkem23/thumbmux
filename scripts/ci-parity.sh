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

package_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$package_dir"

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

echo "ci-parity: exporting $archive_ref -> $work"
git -C "$repo_root" archive "$archive_ref" | tar -x -C "$work"
cd "$work"

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

echo "ci-parity: bun run contract"
bun run contract

echo "ci-parity: bun run smoke:git-dist"
bun run smoke:git-dist

echo "ci-parity: PASSED against the committed tree"
