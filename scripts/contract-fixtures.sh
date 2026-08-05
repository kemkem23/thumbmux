#!/usr/bin/env bash
set -euo pipefail

# Frozen consumer fixtures are intentionally installed like outside packages.
# Override roots only for mutation proofs against disposable copies in /tmp.
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
PACKAGE_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"
PACKAGE_SOURCE="${THUMBMUX_CONTRACT_PACKAGE_ROOT:-$PACKAGE_ROOT}"
FIXTURES_ROOT="${THUMBMUX_CONTRACT_FIXTURES_ROOT:-$PACKAGE_ROOT/contract/fixtures}"
ONLY_FIXTURE="${THUMBMUX_CONTRACT_ONLY:-}"
if [[ -n "${TMUX:-}" ]]; then
  tmux_socket="${TMUX%%,*}"
  LOCK_FILE="$(dirname -- "$tmux_socket")/.thumbmux-contract-fixtures-$(basename -- "$tmux_socket").lock"
else
  LOCK_FILE="${TMUX_TMPDIR:-/tmp}/thumbmux-contract-fixtures-${UID}.lock"
fi

exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "contract fixtures: another runner owns $LOCK_FILE" >&2
  exit 1
fi

fixture_sessions() {
  tmux list-sessions -F '#S' 2>/dev/null | awk '/^ctrfix-/' || true
}

cleanup() {
  [[ -z "${WORK:-}" ]] || rm -rf "$WORK"
}

if [[ -n "$(fixture_sessions)" ]]; then
  echo "contract fixtures: refusing to start while ctrfix-* sessions already exist" >&2
  fixture_sessions >&2
  exit 1
fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/thumbmux-contract-fixtures.XXXXXX")"
trap cleanup EXIT INT TERM

case "$ONLY_FIXTURE" in
  ""|minimal-host|guarded-host|app-host) ;;
  *)
    echo "contract fixtures: unknown THUMBMUX_CONTRACT_ONLY=$ONLY_FIXTURE" >&2
    exit 1
    ;;
esac

for path in \
  "$PACKAGE_SOURCE/package.json" \
  "$PACKAGE_SOURCE/README.md" \
  "$PACKAGE_SOURCE/LICENSE" \
  "$PACKAGE_SOURCE/docs" \
  "$PACKAGE_SOURCE/git-dist/core/index.js" \
  "$PACKAGE_SOURCE/git-dist/server/index.js" \
  "$PACKAGE_SOURCE/git-dist/svelte/index.js" \
  "$PACKAGE_SOURCE/git-dist/app/index.js"; do
  [[ -e "$path" ]] || { echo "contract fixtures: missing package input $path" >&2; exit 1; }
done

mkdir -p "$WORK/package"
cp "$PACKAGE_SOURCE/package.json" "$PACKAGE_SOURCE/README.md" "$PACKAGE_SOURCE/LICENSE" "$WORK/package/"
cp -R "$PACKAGE_SOURCE/docs" "$PACKAGE_SOURCE/git-dist" "$WORK/package/"

(
  cd "$WORK/package"
  npm pkg delete scripts workspaces
  npm pkg set exports='{"./core":{"types":"./git-dist/core/index.d.ts","import":"./git-dist/core/index.js"},"./server":{"types":"./git-dist/server/index.d.ts","import":"./git-dist/server/index.js"},"./svelte":{"types":"./git-dist/svelte/index.d.ts","svelte":"./git-dist/svelte/index.js"},"./app":{"types":"./git-dist/app/index.d.ts","svelte":"./git-dist/app/index.js"},"./package.json":"./package.json"}' --json
  npm pkg set files='["git-dist","docs"]' --json
  npm pack --pack-destination "$WORK" --silent >/dev/null
)

PACKAGE_TARBALL="$(find "$WORK" -maxdepth 1 -name 'thumbmux-*.tgz' -print -quit)"
[[ -n "$PACKAGE_TARBALL" ]] || { echo "contract fixtures: npm pack produced no tarball" >&2; exit 1; }

install_consumer() {
  local fixture="$1"
  local consumer="$WORK/$fixture"

  [[ -d "$FIXTURES_ROOT/$fixture" ]] || {
    echo "contract fixtures: missing $FIXTURES_ROOT/$fixture" >&2
    exit 1
  }
  mkdir -p "$consumer"
  cp -R "$FIXTURES_ROOT/$fixture/." "$consumer/"

  (
    cd "$consumer"
    npm init -y --silent >/dev/null
    npm pkg set "name=thumbmux-contract-$fixture" "type=module"
    npm pkg set "private=true" --json
    npm pkg set "dependencies.thumbmux=file:$PACKAGE_TARBALL"
    npm pkg set 'devDependencies.typescript=^5.9.3' 'devDependencies.@types/bun=^1.3.0'

    if [[ "$fixture" == "app-host" ]]; then
      npm pkg set 'dependencies.svelte=^5.51.0'
      npm pkg set \
        'devDependencies.@playwright/test=^1.61.1' \
        'devDependencies.@sveltejs/vite-plugin-svelte=^6.2.1' \
        'devDependencies.svelte-check=^4.3.4' \
        'devDependencies.vite=^7.3.1'
    fi

    env NODE_ENV=development bun install --ignore-scripts

    local installed
    installed="$(realpath node_modules/thumbmux)"
    case "$installed" in
      "$consumer"/node_modules/*) ;;
      *)
        echo "contract fixtures: $fixture did not install thumbmux inside its consumer" >&2
        exit 1
        ;;
    esac
    [[ -f "$installed/git-dist/server/index.js" ]] || {
      echo "contract fixtures: $fixture did not receive the git-dist tarball" >&2
      exit 1
    }
    echo "contract fixtures: $fixture installed $(basename "$PACKAGE_TARBALL") from git-dist tarball"

    if [[ -f tsconfig.json ]]; then
      ./node_modules/.bin/tsc -p tsconfig.json
    fi

    if [[ "$fixture" == "app-host" ]]; then
      cp "$SCRIPT_DIR/contract-app-host-probe.svelte" src/ContractProbe.svelte
      cp "$SCRIPT_DIR/contract-app-host-tsconfig.json" contract-app-host-tsconfig.json
      ./node_modules/.bin/svelte-check \
        --tsconfig ./contract-app-host-tsconfig.json \
        --fail-on-warnings
      ./node_modules/.bin/vite build
      if [[ -z "${CHROMIUM_PATH:-}" ]]; then
        for browser_command in google-chrome-stable google-chrome chromium chromium-browser; do
          if command -v "$browser_command" >/dev/null 2>&1; then
            CHROMIUM_PATH="$(command -v "$browser_command")"
            export CHROMIUM_PATH
            break
          fi
        done
      fi
      bun run runtime.ts
    elif [[ -f index.ts ]]; then
      bun run index.ts
    else
      bun run run.ts
    fi
  )
}

fixtures=(minimal-host guarded-host app-host)
for fixture in "${fixtures[@]}"; do
  if [[ -n "$ONLY_FIXTURE" && "$fixture" != "$ONLY_FIXTURE" ]]; then
    continue
  fi
  install_consumer "$fixture"
done

remaining_sessions="$(fixture_sessions)"
if [[ -n "$remaining_sessions" ]]; then
  echo "contract fixtures cleanup: tmux sessions remain" >&2
  echo "$remaining_sessions" >&2
  exit 1
fi

remaining_processes="$(pgrep -af "$WORK" 2>/dev/null || true)"
if [[ -n "$remaining_processes" ]]; then
  echo "contract fixtures cleanup: fixture processes remain" >&2
  echo "$remaining_processes" >&2
  exit 1
fi

echo "contract fixtures cleanup: ctrfix sessions=0, fixture listener processes=0"
echo "contract fixtures: all selected frozen consumers passed"
