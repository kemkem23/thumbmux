#!/usr/bin/bash -p
case "$-" in *p*) ;; *) printf 'git-dist smoke: privileged interpreter is required\n' >&2; exit 126 ;; esac
THUMBMUX_ENTRY_CALLER_PATH="${PATH-}"
PATH=/usr/bin:/bin
export PATH THUMBMUX_ENTRY_CALLER_PATH
unset BASH_ENV ENV CDPATH GLOBIGNORE NODE_OPTIONS BUN_OPTIONS NODE_PATH \
  PYTHONPATH PYTHONHOME PYTHONSTARTUP LD_PRELOAD LD_LIBRARY_PATH \
  GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY \
  GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_CONFIG_GLOBAL GIT_CONFIG_SYSTEM \
  GIT_CONFIG_NOSYSTEM GIT_CONFIG_COUNT 2>/dev/null || :
set -euo pipefail

SCRIPT_FILE="$(/usr/bin/realpath -e -- "${BASH_SOURCE[0]}")" \
  || { printf 'git-dist smoke: entrypoint path is unavailable\n' >&2; exit 126; }
SCRIPT_DIR="$(/usr/bin/dirname -- "$SCRIPT_FILE")"
PACKAGE_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"
. "$SCRIPT_DIR/test-runtime-guard.sh"

[[ -z "${THUMBMUX_EXPORT_SOURCE_ROOT-}" ]] \
  || { echo 'git-dist smoke: source-root override is forbidden' >&2; exit 2; }
THUMBMUX_GUARD_RUNTIME=''
CONTAINER=''
CONTAINER_ID=''
PREREQ_IMAGE=''
CID_FILE=''
CONTAINER_STARTED=0
CLEANUP_FAILED=0
RUN_COMPLETE=0
SMOKE_TEST_MODE="${THUMBMUX_SMOKE_TEST_MODE-}"
ARTIFACT_OUT="${THUMBMUX_SMOKE_ARTIFACT_OUT-}"

now_ms() {
  /usr/bin/date +%s%3N
}

assert_owned_container() {
  local identity
  [[ "$CONTAINER_ID" =~ ^[a-f0-9]{64}$ ]] || return 1
  identity="$(/usr/bin/docker inspect --format \
    '{{.Id}}|{{.Name}}|{{index .Config.Labels "com.kemcortex.thumbmux.run-id"}}|{{index .Config.Labels "com.kemcortex.thumbmux.scope"}}' \
    "$CONTAINER_ID" 2>/dev/null || true)"
  [[ "$identity" == "$CONTAINER_ID|/$CONTAINER|$RUN_ID|git-dist-smoke" ]]
}

cleanup() {
  local rc=$?
  set +e
  if [[ -n "${PREREQ_IMAGE-}" ]]; then
    /usr/bin/docker rmi -f "$PREREQ_IMAGE" >/dev/null 2>&1 || true
  fi
  if [[ "$CONTAINER_STARTED" == 0 && -n "$CID_FILE" && -s "$CID_FILE" ]]; then
    CONTAINER_ID="$(<"$CID_FILE")"
    if [[ "$CONTAINER_ID" =~ ^[a-f0-9]{64}$ ]]; then
      CONTAINER_STARTED=1
    else
      echo 'git-dist smoke: invalid Docker cidfile; refusing guessed cleanup' >&2
      CLEANUP_FAILED=1
    fi
  fi
  if [[ "$CONTAINER_STARTED" == 1 ]]; then
    if thumbmux_recheck_docker_attestation && assert_owned_container; then
      if ! /usr/bin/docker rm -f "$CONTAINER_ID" >/dev/null 2>&1 \
        || /usr/bin/docker inspect "$CONTAINER_ID" >/dev/null 2>&1; then
        echo 'git-dist smoke: exact owned-container cleanup failed' >&2
        CLEANUP_FAILED=1
      fi
    else
      echo 'git-dist smoke: container identity/labels changed; refusing cleanup' >&2
      CLEANUP_FAILED=1
    fi
  fi
  if [[ "$CLEANUP_FAILED" == 0 && -n "$THUMBMUX_GUARD_RUNTIME" ]]; then
    thumbmux_remove_test_runtime || CLEANUP_FAILED=1
  elif [[ -n "$THUMBMUX_GUARD_RUNTIME" ]]; then
    echo "git-dist smoke: retained attested runtime=$THUMBMUX_GUARD_RUNTIME" >&2
  fi
  (( CLEANUP_FAILED == 0 )) || rc=1
  trap - EXIT
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

thumbmux_prepare_test_runtime git-dist-smoke "$PACKAGE_ROOT" \
  || { echo 'git-dist smoke: public disposable-CI attestation failed' >&2; exit 2; }
RUN_ID="$(thumbmux_make_run_id)"
thumbmux_bind_run_attestation "$RUN_ID" git-dist-smoke
case "$SMOKE_TEST_MODE" in
  ""|fail-after-prereq|term-after-prereq) ;;
  *) echo "git-dist smoke: unknown attested test mode: $SMOKE_TEST_MODE" >&2; exit 2 ;;
esac
echo "git-dist smoke: run-id=$RUN_ID test-mode=${SMOKE_TEST_MODE:-success}"
if [[ -n "$ARTIFACT_OUT" ]]; then
  expected_artifact="${RUNNER_TEMP-}/thumbmux-candidate-${GITHUB_SHA-}.tgz"
  [[ "$ARTIFACT_OUT" == "$expected_artifact" \
    && "${RUNNER_TEMP-}" == /home/runner/work/_temp \
    && ! -e "$ARTIFACT_OUT" && ! -L "$ARTIFACT_OUT" ]] \
    || { echo 'git-dist smoke: attested artifact output path is invalid or already exists' >&2; exit 2; }
fi
PACKAGE_SOURCE="$THUMBMUX_GUARD_RUNTIME/source"
/usr/bin/install -d -m 0700 "$PACKAGE_SOURCE"
thumbmux_emit_frozen_source_archive \
  | /usr/bin/tar -x -C "$PACKAGE_SOURCE" \
  || { echo 'git-dist smoke: frozen source export failed' >&2; exit 2; }
[[ -d "$PACKAGE_ROOT/git-dist" && ! -L "$PACKAGE_ROOT/git-dist" \
  && -z "$(/usr/bin/find "$PACKAGE_ROOT/git-dist" -type l -print -quit)" ]] \
  || { echo 'git-dist smoke: generated git-dist is missing or symlinked' >&2; exit 2; }
/usr/bin/install -d -m 0700 "$PACKAGE_SOURCE/git-dist"
/usr/bin/cp -a -- "$PACKAGE_ROOT/git-dist/." "$PACKAGE_SOURCE/git-dist/"
/usr/bin/diff -qr -- "$PACKAGE_ROOT/git-dist" "$PACKAGE_SOURCE/git-dist" >/dev/null \
  || { echo 'git-dist smoke: generated git-dist changed while freezing' >&2; exit 2; }
(
  cd "$PACKAGE_SOURCE"
  "$THUMBMUX_GUARD_BUN_BIN" install --frozen-lockfile --ignore-scripts
)
FIXTURE="$PACKAGE_SOURCE/scripts/git-dist-smoke"
EXPORT_GUARD="$PACKAGE_SOURCE/scripts/rewrite-git-dist-imports.ts"
RELEASE_MANIFEST="$PACKAGE_SOURCE/scripts/prepare-release-package.ts"
EXPECTED_SOURCE_ROOT="$PACKAGE_SOURCE"
WORK="$THUMBMUX_GUARD_RUNTIME/work"
mkdir -p "$WORK"
CONTAINER="thumbmux-node18-${RUN_ID}"
CID_FILE="$THUMBMUX_GUARD_RUNTIME/node18.cid"

for path in \
  "$PACKAGE_SOURCE/git-dist/core/index.js" \
  "$PACKAGE_SOURCE/git-dist/core/index.d.ts" \
  "$PACKAGE_SOURCE/git-dist/server/index.js" \
  "$PACKAGE_SOURCE/git-dist/server/index.d.ts" \
  "$PACKAGE_SOURCE/git-dist/server/terminal-replay-worker-entry.js" \
  "$PACKAGE_SOURCE/git-dist/server/terminal-pty-wal-proxy.py" \
  "$PACKAGE_SOURCE/git-dist/svelte/index.js" \
  "$PACKAGE_SOURCE/git-dist/svelte/index.d.ts" \
  "$PACKAGE_SOURCE/git-dist/app/index.js" \
  "$PACKAGE_SOURCE/git-dist/app/index.d.ts" \
  "$PACKAGE_SOURCE/CONTRACT.md" \
  "$PACKAGE_SOURCE/contract/manifest/core.json" \
  "$PACKAGE_SOURCE/contract/manifest/server.json" \
  "$PACKAGE_SOURCE/contract/manifest/svelte.json" \
  "$PACKAGE_SOURCE/contract/manifest/app.json"; do
  [[ -f "$path" ]] || { echo "git-dist smoke: missing $path" >&2; exit 1; }
done

[[ -x "$PACKAGE_SOURCE/git-dist/server/terminal-pty-wal-proxy.py" ]] || {
  echo "git-dist smoke: terminal PTY WAL proxy helper is not executable" >&2
  exit 1
}
cmp -s \
  "$PACKAGE_SOURCE/server/src/integrations/terminal-pty-wal-proxy.py" \
  "$PACKAGE_SOURCE/git-dist/server/terminal-pty-wal-proxy.py" || {
  echo "git-dist smoke: terminal PTY WAL proxy helper differs from source" >&2
  exit 1
}

"$THUMBMUX_GUARD_BUN_BIN" --no-install "$EXPORT_GUARD" check-exports "$PACKAGE_SOURCE" "$EXPECTED_SOURCE_ROOT"

mkdir -p "$WORK/package" "$WORK/bun-consumer" "$WORK/npm-consumer"
cp "$PACKAGE_SOURCE/package.json" "$PACKAGE_SOURCE/README.md" "$PACKAGE_SOURCE/LICENSE" "$WORK/package/"
cp -R "$PACKAGE_SOURCE/docs" "$PACKAGE_SOURCE/git-dist" "$WORK/package/"
cp "$PACKAGE_SOURCE/CONTRACT.md" "$WORK/package/"
mkdir -p "$WORK/package/contract"
cp -R "$PACKAGE_SOURCE/contract/manifest" "$WORK/package/contract/"

(
  cd "$WORK/package"
  "$THUMBMUX_GUARD_BUN_BIN" --no-install "$RELEASE_MANIFEST" .
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
if [[ -n "$ARTIFACT_OUT" ]]; then
  /usr/bin/install -m 0600 -- "$PACKAGE_TARBALL" "$ARTIFACT_OUT"
  [[ ! -L "$ARTIFACT_OUT" && -f "$ARTIFACT_OUT" ]] \
    || { echo 'git-dist smoke: exported candidate artifact is not a regular file' >&2; exit 1; }
  echo "git-dist smoke: artifact=$ARTIFACT_OUT sha256=$(/usr/bin/sha256sum "$ARTIFACT_OUT" | /usr/bin/cut -d' ' -f1)"
fi
cp -R "$FIXTURE/." "$WORK/bun-consumer/"
"$THUMBMUX_GUARD_BUN_BIN" --no-install "$EXPORT_GUARD" write-consumer-guards "$WORK/bun-consumer" "$EXPECTED_SOURCE_ROOT"
(
  cd "$WORK/bun-consumer"
  npm pkg set "dependencies.thumbmux=file:$PACKAGE_TARBALL"
  "$THUMBMUX_GUARD_BUN_BIN" install
  test -f node_modules/thumbmux/CONTRACT.md
  test -f node_modules/thumbmux/contract/manifest/core.json
  test -f node_modules/thumbmux/contract/manifest/server.json
  test -f node_modules/thumbmux/contract/manifest/svelte.json
  test -f node_modules/thumbmux/contract/manifest/app.json
  test -x node_modules/thumbmux/git-dist/server/terminal-pty-wal-proxy.py
  "$THUMBMUX_GUARD_BUN_BIN" run check
  ./node_modules/.bin/tsc -p tsconfig.nodenext.json
  node runtime-smoke.mjs
  "$THUMBMUX_GUARD_BUN_BIN" run runtime-export-guard.mjs
  "$THUMBMUX_GUARD_BUN_BIN" run runtime-svelte-export-guard.mjs
)

cp -R "$FIXTURE/." "$WORK/npm-consumer/"
"$THUMBMUX_GUARD_BUN_BIN" --no-install "$EXPORT_GUARD" write-consumer-guards "$WORK/npm-consumer" "$EXPECTED_SOURCE_ROOT"
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

set +e
thumbmux_recheck_docker_attestation \
  || { echo 'git-dist smoke: Docker daemon changed before Node 18 container creation' >&2; exit 1; }
PREREQ_IMAGE="thumbmux-node18-prereqs-${RUN_ID}"
DOWNLOAD_STARTED="$(now_ms)"
/usr/bin/docker pull node:18-alpine >/dev/null
DOWNLOAD_RC=$?
DOWNLOAD_MS=$(( $(now_ms) - DOWNLOAD_STARTED ))
echo "git-dist smoke: timing download_ms=$DOWNLOAD_MS rc=$DOWNLOAD_RC"
(( DOWNLOAD_RC == 0 )) \
  || { echo "git-dist smoke: base image download exited $DOWNLOAD_RC" >&2; exit "$DOWNLOAD_RC"; }
BUILD_STARTED="$(now_ms)"
/usr/bin/docker build -t "$PREREQ_IMAGE" - <<'EOF' >/dev/null
FROM node:18-alpine
RUN timeout 120 apk add --no-cache python3 tmux
EOF
BUILD_RC=$?
BUILD_MS=$(( $(now_ms) - BUILD_STARTED ))
echo "git-dist smoke: timing build_ms=$BUILD_MS rc=$BUILD_RC"
(( BUILD_RC == 0 )) \
  || { echo "git-dist smoke: prerequisite image build exited $BUILD_RC" >&2; exit "$BUILD_RC"; }
if [[ "$SMOKE_TEST_MODE" == fail-after-prereq ]]; then
  echo 'git-dist smoke: fault-ready phase=after-prereq action=fail rc=86'
  exit 86
fi
if [[ "$SMOKE_TEST_MODE" == term-after-prereq ]]; then
  echo 'git-dist smoke: fault-ready phase=after-prereq action=wait-for-TERM'
  while :; do /usr/bin/sleep 0.1; done
fi
/usr/bin/timeout 240 /usr/bin/docker run \
  --cidfile "$CID_FILE" \
  --name "$CONTAINER" \
  --label "com.kemcortex.thumbmux.run-id=$RUN_ID" \
  --label 'com.kemcortex.thumbmux.scope=git-dist-smoke' \
  -v "$PACKAGE_TARBALL:/tmp/thumbmux.tgz:ro" \
  -v "$WORK/bun-consumer/runtime-export-guard.mjs:/tmp/runtime-export-guard.mjs:ro" \
  -v "$FIXTURE/node18-replay-lock-smoke.mjs:/tmp/node18-replay-lock-smoke.mjs:ro" \
  "$PREREQ_IMAGE" sh -lc '
  mkdir /app && cd /app
  npm init -y >/dev/null 2>&1
  install_started=$(node -e "process.stdout.write(String(Date.now()))")
  npm install --ignore-scripts /tmp/thumbmux.tgz >/dev/null 2>&1
  install_ms=$(( $(node -e "process.stdout.write(String(Date.now()))") - install_started ))
  echo "git-dist smoke: timing install_ms=$install_ms rc=0"
  cp /tmp/runtime-export-guard.mjs /app/runtime-export-guard.mjs
  cp /tmp/node18-replay-lock-smoke.mjs /app/node18-replay-lock-smoke.mjs
  code_started=$(node -e "process.stdout.write(String(Date.now()))")
  node runtime-export-guard.mjs
  node node18-replay-lock-smoke.mjs
  code_ms=$(( $(node -e "process.stdout.write(String(Date.now()))") - code_started ))
  echo "git-dist smoke: timing code_ms=$code_ms rc=0"
'
DOCKER_RC=$?
set -e
if [[ -s "$CID_FILE" ]]; then
  CONTAINER_ID="$(<"$CID_FILE")"
  [[ "$CONTAINER_ID" =~ ^[a-f0-9]{64}$ ]] \
    || { echo 'git-dist smoke: Docker wrote an invalid container id' >&2; exit 1; }
  CONTAINER_STARTED=1
  assert_owned_container \
    || { echo 'git-dist smoke: Node 18 container identity/labels do not match this run' >&2; exit 1; }
fi
(( DOCKER_RC == 0 )) \
  || { echo "git-dist smoke: Node 18 container exited $DOCKER_RC" >&2; exit "$DOCKER_RC"; }
[[ "$CONTAINER_STARTED" == 1 ]] \
  || { echo 'git-dist smoke: Docker did not attest the Node 18 container id' >&2; exit 1; }

assert_owned_container \
  || { echo 'git-dist smoke: container identity changed before cleanup' >&2; exit 1; }
thumbmux_recheck_docker_attestation \
  || { echo 'git-dist smoke: Docker daemon changed before exact cleanup' >&2; exit 1; }
/usr/bin/docker rm "$CONTAINER_ID" >/dev/null
if /usr/bin/docker inspect "$CONTAINER_ID" >/dev/null 2>&1; then
  echo 'git-dist smoke: owned Node 18 container survived cleanup' >&2
  exit 1
fi
CONTAINER_STARTED=0
rm -f -- "$CID_FILE"

if [[ -n "${PREREQ_IMAGE-}" ]]; then
  /usr/bin/docker rmi -f "$PREREQ_IMAGE" >/dev/null 2>&1 || true
  PREREQ_IMAGE=''
fi

echo "git-dist smoke: Bun/npm installs, TypeScript, Vite/Svelte, current Node, and Node 18 replay lock passed"
RUN_COMPLETE=1
