#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
PACKAGE_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"
FIXTURE="$SCRIPT_DIR/git-dist-smoke"
EXPORT_GUARD="$SCRIPT_DIR/rewrite-git-dist-imports.ts"
RELEASE_MANIFEST="$SCRIPT_DIR/prepare-release-package.ts"
EXPECTED_SOURCE_ROOT="${THUMBMUX_EXPORT_SOURCE_ROOT:-$PACKAGE_ROOT}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/thumbmux-git-dist-smoke.XXXXXX")"

cleanup() {
  rm -rf "$WORK"
}
trap cleanup EXIT INT TERM

for path in \
  "$PACKAGE_ROOT/git-dist/core/index.js" \
  "$PACKAGE_ROOT/git-dist/core/index.d.ts" \
  "$PACKAGE_ROOT/git-dist/server/index.js" \
  "$PACKAGE_ROOT/git-dist/server/index.d.ts" \
  "$PACKAGE_ROOT/git-dist/server/terminal-replay-worker-entry.js" \
  "$PACKAGE_ROOT/git-dist/server/terminal-pty-wal-proxy.py" \
  "$PACKAGE_ROOT/git-dist/svelte/index.js" \
  "$PACKAGE_ROOT/git-dist/svelte/index.d.ts" \
  "$PACKAGE_ROOT/git-dist/app/index.js" \
  "$PACKAGE_ROOT/git-dist/app/index.d.ts" \
  "$PACKAGE_ROOT/CONTRACT.md" \
  "$PACKAGE_ROOT/contract/manifest/core.json" \
  "$PACKAGE_ROOT/contract/manifest/server.json" \
  "$PACKAGE_ROOT/contract/manifest/svelte.json" \
  "$PACKAGE_ROOT/contract/manifest/app.json"; do
  [[ -f "$path" ]] || { echo "git-dist smoke: missing $path" >&2; exit 1; }
done

[[ -x "$PACKAGE_ROOT/git-dist/server/terminal-pty-wal-proxy.py" ]] || {
  echo "git-dist smoke: terminal PTY WAL proxy helper is not executable" >&2
  exit 1
}
cmp -s \
  "$PACKAGE_ROOT/server/src/integrations/terminal-pty-wal-proxy.py" \
  "$PACKAGE_ROOT/git-dist/server/terminal-pty-wal-proxy.py" || {
  echo "git-dist smoke: terminal PTY WAL proxy helper differs from source" >&2
  exit 1
}

bun "$EXPORT_GUARD" check-exports "$PACKAGE_ROOT" "$EXPECTED_SOURCE_ROOT"

mkdir -p "$WORK/package" "$WORK/bun-consumer" "$WORK/npm-consumer"
cp "$PACKAGE_ROOT/package.json" "$PACKAGE_ROOT/README.md" "$PACKAGE_ROOT/LICENSE" "$WORK/package/"
cp -R "$PACKAGE_ROOT/docs" "$PACKAGE_ROOT/git-dist" "$WORK/package/"
cp "$PACKAGE_ROOT/CONTRACT.md" "$WORK/package/"
mkdir -p "$WORK/package/contract"
cp -R "$PACKAGE_ROOT/contract/manifest" "$WORK/package/contract/"

(
  cd "$WORK/package"
  bun "$RELEASE_MANIFEST" .
  npm pack --pack-destination "$WORK" --silent >/dev/null
)

PACKAGE_TARBALL="$(find "$WORK" -maxdepth 1 -name 'thumbmux-*.tgz' -print -quit)"
[[ -n "$PACKAGE_TARBALL" ]] || { echo "git-dist smoke: npm pack produced no tarball" >&2; exit 1; }
PACKAGE_CONTENTS="$(tar -tzf "$PACKAGE_TARBALL")"
for asset in \
  package/CONTRACT.md \
  package/contract/manifest/core.json \
  package/contract/manifest/server.json \
  package/contract/manifest/svelte.json \
  package/contract/manifest/app.json \
  package/git-dist/server/terminal-replay-worker-entry.js \
  package/git-dist/server/terminal-pty-wal-proxy.py; do
  grep -Fxq "$asset" <<<"$PACKAGE_CONTENTS" || {
    echo "git-dist smoke: packed artifact is missing $asset" >&2
    exit 1
  }
done
cp -R "$FIXTURE/." "$WORK/bun-consumer/"
bun "$EXPORT_GUARD" write-consumer-guards "$WORK/bun-consumer" "$EXPECTED_SOURCE_ROOT"
(
  cd "$WORK/bun-consumer"
  npm pkg set "dependencies.thumbmux=file:$PACKAGE_TARBALL"
  bun install
  test -f node_modules/thumbmux/CONTRACT.md
  test -f node_modules/thumbmux/contract/manifest/core.json
  test -f node_modules/thumbmux/contract/manifest/server.json
  test -f node_modules/thumbmux/contract/manifest/svelte.json
  test -f node_modules/thumbmux/contract/manifest/app.json
  test -x node_modules/thumbmux/git-dist/server/terminal-pty-wal-proxy.py
  bun run check
  ./node_modules/.bin/tsc -p tsconfig.nodenext.json
  node runtime-smoke.mjs
  bun run runtime-export-guard.mjs
  bun run runtime-svelte-export-guard.mjs
)

cp -R "$FIXTURE/." "$WORK/npm-consumer/"
bun "$EXPORT_GUARD" write-consumer-guards "$WORK/npm-consumer" "$EXPECTED_SOURCE_ROOT"
(
  cd "$WORK/npm-consumer"
  npm pkg set "dependencies.thumbmux=file:$PACKAGE_TARBALL"
  npm install --include=dev --ignore-scripts
  test -f node_modules/thumbmux/CONTRACT.md
  test -f node_modules/thumbmux/contract/manifest/core.json
  test -f node_modules/thumbmux/contract/manifest/server.json
  test -f node_modules/thumbmux/contract/manifest/svelte.json
  test -f node_modules/thumbmux/contract/manifest/app.json
  test -x node_modules/thumbmux/git-dist/server/terminal-pty-wal-proxy.py
  npm run check
  ./node_modules/.bin/tsc -p tsconfig.nodenext.json
  node runtime-smoke.mjs
  node runtime-export-guard.mjs
  node runtime-svelte-export-guard.mjs
  npm ls --all
)

command -v docker >/dev/null 2>&1 || { echo "git-dist smoke: docker is required for Node 18" >&2; exit 1; }
timeout 240 docker run --rm \
  -v "$PACKAGE_TARBALL:/tmp/thumbmux.tgz:ro" \
  -v "$WORK/bun-consumer/runtime-export-guard.mjs:/tmp/runtime-export-guard.mjs:ro" \
  -v "$FIXTURE/node18-replay-lock-smoke.mjs:/tmp/node18-replay-lock-smoke.mjs:ro" \
  node:18-alpine sh -lc '
  timeout 120 apk add --no-cache python3 tmux >/dev/null
  mkdir /app && cd /app
  npm init -y >/dev/null 2>&1
  npm install --ignore-scripts /tmp/thumbmux.tgz >/dev/null 2>&1
  cp /tmp/runtime-export-guard.mjs /app/runtime-export-guard.mjs
  cp /tmp/node18-replay-lock-smoke.mjs /app/node18-replay-lock-smoke.mjs
  node runtime-export-guard.mjs
  node node18-replay-lock-smoke.mjs
'

echo "git-dist smoke: Bun/npm installs, TypeScript, Vite/Svelte, current Node, and Node 18 replay lock passed"
