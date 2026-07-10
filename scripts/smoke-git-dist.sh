#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
PACKAGE_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"
FIXTURE="$SCRIPT_DIR/git-dist-smoke"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/thumbmux-git-dist-smoke.XXXXXX")"

cleanup() {
  rm -rf "$WORK"
}
trap cleanup EXIT INT TERM

for path in \
  "$PACKAGE_ROOT/git-dist/core/index.js" \
  "$PACKAGE_ROOT/git-dist/core/index.d.ts" \
  "$PACKAGE_ROOT/git-dist/server/index.js" \
  "$PACKAGE_ROOT/git-dist/svelte/index.js"; do
  [[ -f "$path" ]] || { echo "git-dist smoke: missing $path" >&2; exit 1; }
done

mkdir -p "$WORK/package" "$WORK/bun-consumer" "$WORK/npm-consumer"
cp "$PACKAGE_ROOT/package.json" "$PACKAGE_ROOT/README.md" "$PACKAGE_ROOT/LICENSE" "$WORK/package/"
cp -R "$PACKAGE_ROOT/docs" "$PACKAGE_ROOT/git-dist" "$WORK/package/"

(
  cd "$WORK/package"
  npm pkg delete scripts
  npm pkg set exports='{"./core":{"types":"./git-dist/core/index.d.ts","import":"./git-dist/core/index.js"},"./server":{"types":"./git-dist/server/index.d.ts","import":"./git-dist/server/index.js"},"./svelte":{"types":"./git-dist/svelte/index.d.ts","svelte":"./git-dist/svelte/index.js"},"./package.json":"./package.json"}' --json
  npm pkg set files='["git-dist","docs"]' --json
  npm pack --pack-destination "$WORK" --silent >/dev/null
)

PACKAGE_TARBALL="$(find "$WORK" -maxdepth 1 -name 'thumbmux-*.tgz' -print -quit)"
[[ -n "$PACKAGE_TARBALL" ]] || { echo "git-dist smoke: npm pack produced no tarball" >&2; exit 1; }
cp -R "$FIXTURE/." "$WORK/bun-consumer/"
(
  cd "$WORK/bun-consumer"
  npm pkg set "dependencies.thumbmux=file:$PACKAGE_TARBALL"
  bun install
  bun run check
  node runtime-smoke.mjs
)

cp -R "$FIXTURE/." "$WORK/npm-consumer/"
(
  cd "$WORK/npm-consumer"
  npm pkg set "dependencies.thumbmux=file:$PACKAGE_TARBALL"
  npm install --include=dev --ignore-scripts
  npm run check
  node runtime-smoke.mjs
  npm ls --all
)

command -v docker >/dev/null 2>&1 || { echo "git-dist smoke: docker is required for Node 18" >&2; exit 1; }
docker run --rm -v "$PACKAGE_TARBALL:/tmp/thumbmux.tgz:ro" node:18-alpine sh -lc '
  mkdir /app && cd /app
  npm init -y >/dev/null 2>&1
  npm install --ignore-scripts /tmp/thumbmux.tgz >/dev/null 2>&1
  node --input-type=module -e '\''
    import * as core from "thumbmux/core";
    import * as server from "thumbmux/server";
    if (typeof core.applyMuxDelta !== "function" || typeof server.TmuxWsMux !== "function") process.exit(2);
    console.log(JSON.stringify({ node: process.version, core: Object.keys(core).length, server: Object.keys(server).length }));
  '\''
'

echo "git-dist smoke: Bun/npm installs, TypeScript, Vite/Svelte, current Node, and Node 18 passed"
