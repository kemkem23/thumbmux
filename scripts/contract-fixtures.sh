#!/usr/bin/bash -p
case "$-" in *p*) ;; *) printf 'contract fixtures: privileged interpreter is required\n' >&2; exit 126 ;; esac
THUMBMUX_ENTRY_CALLER_PATH="${PATH-}"
PATH=/usr/bin:/bin
export PATH THUMBMUX_ENTRY_CALLER_PATH
unset BASH_ENV ENV CDPATH GLOBIGNORE NODE_OPTIONS BUN_OPTIONS NODE_PATH \
  PYTHONPATH PYTHONHOME PYTHONSTARTUP LD_PRELOAD LD_LIBRARY_PATH \
  GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY \
  GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_CONFIG_GLOBAL GIT_CONFIG_SYSTEM \
  GIT_CONFIG_NOSYSTEM GIT_CONFIG_COUNT 2>/dev/null || :
set -euo pipefail

# Frozen consumer fixtures are intentionally installed like outside packages.
# Package/fixture roots are harness-owned; the only admitted host is the public
# GitHub-hosted disposable CI job.
SCRIPT_FILE="$(/usr/bin/realpath -e -- "${BASH_SOURCE[0]}")" \
  || { printf 'contract fixtures: entrypoint path is unavailable\n' >&2; exit 126; }
SCRIPT_DIR="$(/usr/bin/dirname -- "$SCRIPT_FILE")"
PACKAGE_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"
ONLY_FIXTURE="${THUMBMUX_CONTRACT_ONLY:-}"
. "$SCRIPT_DIR/test-runtime-guard.sh"

THUMBMUX_GUARD_RUNTIME=''
RUN_COMPLETE=0
PRIVATE_TMUX_READY=0
TMUX_SOCKET=''

fixture_sessions() {
  [[ "$PRIVATE_TMUX_READY" == 1 ]] || return 0
  tmux list-sessions -F '#S' 2>/dev/null || true
}

cleanup() {
  local rc=$?
  local remaining=''
  set +e
  if [[ -n "$THUMBMUX_GUARD_RUNTIME" && "$PRIVATE_TMUX_READY" == 1 ]]; then
    remaining="$(fixture_sessions)"
    if [[ -n "$remaining" ]]; then
      echo 'contract fixtures: private tmux sessions survived fixture cleanup' >&2
      printf '%s\n' "$remaining" >&2
      rc=1
    fi
    if [[ -S "$TMUX_SOCKET" && ! -L "$TMUX_SOCKET" ]]; then
      # The shim inserts the one attested -S path. This can only stop the
      # server rooted inside this run's exact private runtime.
      tmux kill-server >/dev/null 2>&1 || true
    elif [[ -e "$TMUX_SOCKET" || -L "$TMUX_SOCKET" ]]; then
      echo 'contract fixtures: private tmux socket changed type; refusing kill-server' >&2
      rc=1
    fi
    if [[ -S "$TMUX_SOCKET" || -L "$TMUX_SOCKET" ]]; then
      echo 'contract fixtures: exact private tmux server survived cleanup' >&2
      rc=1
    fi
  fi
  if [[ -n "$THUMBMUX_GUARD_RUNTIME" ]]; then
    thumbmux_remove_test_runtime || rc=1
  fi
  [[ "$RUN_COMPLETE" == 1 || "$PRIVATE_TMUX_READY" == 0 ]] || rc=1
  trap - EXIT
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

[[ -z "${THUMBMUX_CONTRACT_PACKAGE_ROOT-}" \
  && -z "${THUMBMUX_CONTRACT_FIXTURES_ROOT-}" \
  && -z "${CHROMIUM_PATH-}" ]] \
  || { echo 'contract fixtures: package/fixture/browser overrides are forbidden' >&2; exit 2; }
thumbmux_prepare_test_runtime contract-fixtures "$PACKAGE_ROOT" \
  || { echo 'contract fixtures: public disposable-CI attestation failed' >&2; exit 2; }
RUN_ID="$(thumbmux_make_run_id)"
thumbmux_bind_run_attestation "$RUN_ID" contract-fixtures
PACKAGE_SOURCE="$THUMBMUX_GUARD_RUNTIME/source"
/usr/bin/install -d -m 0700 "$PACKAGE_SOURCE"
thumbmux_emit_frozen_source_archive \
  | /usr/bin/tar -x -C "$PACKAGE_SOURCE" \
  || { echo 'contract fixtures: frozen source export failed' >&2; exit 2; }
[[ -d "$PACKAGE_ROOT/git-dist" && ! -L "$PACKAGE_ROOT/git-dist" \
  && -z "$(/usr/bin/find "$PACKAGE_ROOT/git-dist" -type l -print -quit)" ]] \
  || { echo 'contract fixtures: generated git-dist is missing or symlinked' >&2; exit 2; }
/usr/bin/install -d -m 0700 "$PACKAGE_SOURCE/git-dist"
/usr/bin/cp -a -- "$PACKAGE_ROOT/git-dist/." "$PACKAGE_SOURCE/git-dist/"
/usr/bin/diff -qr -- "$PACKAGE_ROOT/git-dist" "$PACKAGE_SOURCE/git-dist" >/dev/null \
  || { echo 'contract fixtures: generated git-dist changed while freezing' >&2; exit 2; }
FIXTURES_ROOT="$PACKAGE_SOURCE/contract/fixtures"
PRIVATE_BIN="$THUMBMUX_GUARD_RUNTIME/bin"
TMUX_ROOT="$THUMBMUX_GUARD_RUNTIME/tmux"
TMUX_SOCKET="$TMUX_ROOT/tmux-$(id -u)/default"
mkdir -p "$PRIVATE_BIN" "$TMUX_ROOT" "${TMUX_SOCKET%/*}"
chmod 0700 "$PRIVATE_BIN" "$TMUX_ROOT" "${TMUX_SOCKET%/*}"
/usr/bin/ln -s "$PACKAGE_SOURCE/scripts/private-test-tmux.sh" "$PRIVATE_BIN/tmux"
unset TMUX TMUX_PANE TMUX_TMPDIR
export THUMBMUX_TEST_RUNTIME="$THUMBMUX_GUARD_RUNTIME"
export THUMBMUX_TEST_RUN_ID="$RUN_ID"
export THUMBMUX_TEST_SCOPE=contract-fixtures
export THUMBMUX_TEST_TMUX_SOCKET="$TMUX_SOCKET"
export PATH="$PRIVATE_BIN:$PATH"
PRIVATE_TMUX_READY=1
LOCK_FILE="$THUMBMUX_GUARD_RUNTIME/contract-fixtures.lock"

exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "contract fixtures: another runner owns $LOCK_FILE" >&2
  exit 1
fi

if [[ -n "$(fixture_sessions)" ]]; then
  echo "contract fixtures: refusing an unexpectedly non-empty private tmux server" >&2
  fixture_sessions >&2
  exit 1
fi

WORK="$THUMBMUX_GUARD_RUNTIME/work"
mkdir -p "$WORK"

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
  cp "$FIXTURES_ROOT/runtime-guard.ts" "$consumer/runtime-guard.ts"

  (
    cd "$consumer"
    npm init -y --silent >/dev/null
    npm pkg set "name=thumbmux-contract-$fixture" "type=module"
    npm pkg set "private=true" --json
    npm pkg set "dependencies.thumbmux=file:$PACKAGE_TARBALL"
    npm pkg set 'devDependencies.typescript=^5.9.3' 'devDependencies.@types/bun=1.3.14'

    if [[ "$fixture" == "app-host" ]]; then
      npm pkg set 'dependencies.svelte=^5.51.0'
      npm pkg set \
        'devDependencies.@playwright/test=^1.61.1' \
        'devDependencies.@sveltejs/vite-plugin-svelte=^6.2.1' \
        'devDependencies.svelte-check=^4.3.4' \
        'devDependencies.vite=^7.3.1'
    fi

    env NODE_ENV=development "$THUMBMUX_GUARD_BUN_BIN" install --ignore-scripts

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
      "$THUMBMUX_GUARD_BUN_BIN" runtime.ts
    elif [[ -f index.ts ]]; then
      "$THUMBMUX_GUARD_BUN_BIN" index.ts
    else
      "$THUMBMUX_GUARD_BUN_BIN" run.ts
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
  echo "contract fixtures cleanup: private tmux sessions remain" >&2
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
RUN_COMPLETE=1
