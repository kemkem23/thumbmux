#!/usr/bin/bash -p
# Privileged Bash ignores BASH_ENV/exported functions. Keep the caller's tool
# path only as inert data for post-attestation tool discovery.
case "$-" in *p*) ;; *) printf 'thumbmux e2e: privileged interpreter is required\n' >&2; exit 126 ;; esac
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
  || { printf 'thumbmux e2e: entrypoint path is unavailable\n' >&2; exit 126; }
SCRIPT_DIR="$(/usr/bin/dirname -- "$SCRIPT_FILE")"
DEFAULT_PACKAGE_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"
PACKAGE_ROOT="$DEFAULT_PACKAGE_ROOT"
E2E_DIR="$PACKAGE_ROOT/e2e"
. "$PACKAGE_ROOT/scripts/test-runtime-guard.sh"

IMAGE="oven/bun:1"
DEMO_PORT=7681
HOST_PORT=''
READY_TIMEOUT="${THUMBMUX_E2E_READY_TIMEOUT:-90}"
PLAYWRIGHT_BIN="$PACKAGE_ROOT/node_modules/.bin/playwright"
CONTAINER_STARTED=0
CONTAINER_ID=''
CLEANUP_FAILED=0
ARTIFACTS_DIR=''
THUMBMUX_GUARD_RUNTIME=''
CID_FILE=''

fail() {
  echo "thumbmux e2e: $*" >&2
  exit 1
}

redact_token() {
  sed -E 's/([?&]t=)[a-f0-9]+/\1<redacted>/g'
}

redact_demo_log() {
  redact_token | awk '
    /^▄▄▄▄▄▄/ { in_qr = 1; next }
    in_qr && /^[[:space:]]*$/ { in_qr = 0; next }
    !in_qr { print }
  '
}

# shellcheck disable=SC2329  # Invoked indirectly by the EXIT trap below.
cleanup() {
  local rc=$?
  set +e
  if [[ "$CONTAINER_STARTED" == 0 && -n "$CID_FILE" && -s "$CID_FILE" ]]; then
    CONTAINER_ID="$(<"$CID_FILE")"
    if [[ "$CONTAINER_ID" =~ ^[a-f0-9]{64}$ ]]; then
      CONTAINER_STARTED=1
    else
      echo 'thumbmux e2e: invalid Docker cidfile; refusing guessed cleanup' >&2
      CLEANUP_FAILED=1
    fi
  fi
  if [[ "$CONTAINER_STARTED" == 1 ]]; then
    if thumbmux_recheck_docker_attestation && assert_owned_container; then
      docker exec "$CONTAINER_ID" bash -lc 'test -f /tmp/demo.log && cat /tmp/demo.log' 2>/dev/null \
        | redact_demo_log >"$ARTIFACTS_DIR/demo.log"
      if ! docker rm -f "$CONTAINER_ID" >/dev/null 2>&1 \
        || docker inspect "$CONTAINER_ID" >/dev/null 2>&1; then
        echo 'thumbmux e2e: exact owned-container cleanup failed; runtime retained' >&2
        CLEANUP_FAILED=1
      fi
    else
      echo 'thumbmux e2e: container identity/labels changed; refusing cleanup' >&2
      CLEANUP_FAILED=1
    fi
  fi
  if [[ "$CLEANUP_FAILED" == 0 && -n "$THUMBMUX_GUARD_RUNTIME" ]]; then
    thumbmux_remove_test_runtime || CLEANUP_FAILED=1
  elif [[ -n "$THUMBMUX_GUARD_RUNTIME" ]]; then
    echo "thumbmux e2e: retained runtime=$THUMBMUX_GUARD_RUNTIME" >&2
  fi
  (( CLEANUP_FAILED == 0 )) || rc=1
  trap - EXIT
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

for forbidden_override in THUMBMUX_CONTAINER THUMBMUX_PACKAGE_DIR THUMBMUX_E2E_IMAGE \
  THUMBMUX_DEMO_PORT THUMBMUX_HOST_PORT THUMBMUX_PLAYWRIGHT_BIN; do
  [[ -z "${!forbidden_override-}" ]] \
    || fail "$forbidden_override is runner-owned and cannot be overridden"
done

thumbmux_prepare_test_runtime e2e "$PACKAGE_ROOT" \
  || fail 'disposable CI/Docker attestation failed'
RUN_ID="$(thumbmux_make_run_id)" || fail 'run id generation failed'
thumbmux_bind_run_attestation "$RUN_ID" e2e || fail 'run attestation failed'
CID_FILE="$THUMBMUX_GUARD_RUNTIME/container.cid"
CONTAINER="thumbmux-e2e-${RUN_ID}"
CONTAINER_RUNTIME="/run/thumbmux-e2e-${RUN_ID}"
FROZEN_HOST_SOURCE="$THUMBMUX_GUARD_RUNTIME/frozen-host-source"
/usr/bin/install -d -m 0700 "$FROZEN_HOST_SOURCE"
thumbmux_emit_frozen_source_archive \
  | /usr/bin/tar -x -C "$FROZEN_HOST_SOURCE" scripts/private-test-tmux.sh \
  || fail 'could not materialize the attested private tmux shim'
PRIVATE_TMUX_SHIM="$FROZEN_HOST_SOURCE/scripts/private-test-tmux.sh"

command -v curl >/dev/null 2>&1 || fail 'curl is required'
command -v tar >/dev/null 2>&1 || fail 'tar is required'
[[ -f "$PACKAGE_ROOT/package.json" ]] || fail "package root is invalid: $PACKAGE_ROOT"
[[ -f "$E2E_DIR/playwright.config.ts" ]] || fail "e2e config is missing: $E2E_DIR/playwright.config.ts"
[[ -x "$PLAYWRIGHT_BIN" ]] || fail "local Playwright is missing; run bun install --frozen-lockfile"
[[ "$DEMO_PORT" =~ ^[0-9]+$ ]] || fail 'THUMBMUX_DEMO_PORT must be numeric'
[[ "$READY_TIMEOUT" =~ ^[0-9]+$ ]] || fail 'THUMBMUX_E2E_READY_TIMEOUT must be numeric'

[[ -x "$PRIVATE_TMUX_SHIM" && ! -L "$PRIVATE_TMUX_SHIM" ]] \
  || fail 'private tmux shim is missing, non-executable, or symlinked'

if [[ -n "${THUMBMUX_E2E_ARTIFACTS-}" ]]; then
  [[ "$THUMBMUX_E2E_ARTIFACTS" == /* ]] || fail 'artifact path must be absolute'
  mkdir -p "$THUMBMUX_E2E_ARTIFACTS"
  ARTIFACTS_DIR="$(realpath -- "$THUMBMUX_E2E_ARTIFACTS")"
  runner_temp_real="$(realpath -- "$RUNNER_TEMP")"
  [[ "$ARTIFACTS_DIR" == "$runner_temp_real"/* ]] \
    || fail 'GitHub-hosted artifacts must remain under RUNNER_TEMP'
else
  ARTIFACTS_DIR="$(realpath -- "$RUNNER_TEMP")/thumbmux-e2e-artifacts.${RUN_ID}"
  mkdir -m 0700 "$ARTIFACTS_DIR"
fi

mkdir -p "$ARTIFACTS_DIR"
ARTIFACTS_DIR="$(cd -- "$ARTIFACTS_DIR" && pwd -P)"
[[ ! -L "$ARTIFACTS_DIR" \
  && "$(stat -Lc '%u' -- "$ARTIFACTS_DIR" 2>/dev/null || true)" == "$(id -u)" ]] \
  || fail 'artifact directory ownership/type is unsafe'

shopt -s nullglob
SPECS=("$E2E_DIR"/*.spec.ts)
shopt -u nullglob
(( ${#SPECS[@]} > 0 )) || fail 'no e2e/*.spec.ts files found'

assert_owned_container() {
  local identity
  [[ "$CONTAINER_ID" =~ ^[a-f0-9]{64}$ ]] || return 1
  identity="$(docker inspect --format \
    '{{.Id}}|{{.Name}}|{{index .Config.Labels "com.kemcortex.thumbmux.run-id"}}|{{index .Config.Labels "com.kemcortex.thumbmux.scope"}}' \
    "$CONTAINER_ID" 2>/dev/null || true)"
  [[ "$identity" == "$CONTAINER_ID|/$CONTAINER|$RUN_ID|e2e" ]]
}

thumbmux_recheck_docker_attestation \
  || fail 'Docker daemon changed before container creation'
CONTAINER_ID="$(docker run --detach \
  --cidfile "$CID_FILE" \
  --name "$CONTAINER" \
  --hostname "$CONTAINER" \
  --label "com.kemcortex.thumbmux.run-id=$RUN_ID" \
  --label 'com.kemcortex.thumbmux.scope=e2e' \
  --publish "127.0.0.1::${DEMO_PORT}" \
  --mount "type=bind,src=$PRIVATE_TMUX_SHIM,dst=/usr/local/bin/tmux,readonly" \
  --mount "type=bind,src=$THUMBMUX_GUARD_ATTESTATION,dst=/run/thumbmux-host-attestation,readonly" \
  --env "THUMBMUX_TEST_RUNTIME=$CONTAINER_RUNTIME" \
  --env "THUMBMUX_TEST_RUN_ID=$RUN_ID" \
  --env 'THUMBMUX_TEST_SCOPE=e2e' \
  --env "THUMBMUX_TEST_TMUX_SOCKET=$CONTAINER_RUNTIME/tmux/tmux-0/default" \
  "$IMAGE" sleep infinity)" || fail 'Docker refused the unique test container'
[[ "$CONTAINER_ID" =~ ^[a-f0-9]{64}$ ]] || fail 'Docker returned an invalid container id'
[[ -s "$CID_FILE" && "$(<"$CID_FILE")" == "$CONTAINER_ID" ]] \
  || fail 'Docker cidfile does not match the returned container id'
CONTAINER_STARTED=1
assert_owned_container || fail 'new container identity/labels do not match this run'

HOST_PORT="$(docker port "$CONTAINER_ID" "${DEMO_PORT}/tcp" \
  | awk -F: '/127[.]0[.]0[.]1:/ { print $NF; exit }')"
[[ "$HOST_PORT" =~ ^[0-9]+$ ]] || fail 'docker did not publish an ephemeral localhost port'
(( HOST_PORT >= 1024 && HOST_PORT <= 65535 )) \
  || fail "Docker selected invalid host port $HOST_PORT"
case "$HOST_PORT" in
  47779|47780) fail "Docker selected reserved production port $HOST_PORT" ;;
esac

echo "thumbmux e2e: container=$CONTAINER image=$IMAGE specs=${#SPECS[@]}"
echo "thumbmux e2e: artifacts=$ARTIFACTS_DIR"

docker exec "$CONTAINER_ID" bash -lc \
  'apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq tmux procps' >/dev/null
docker exec "$CONTAINER_ID" bash -lc \
  'install -d -m 0700 "$THUMBMUX_TEST_RUNTIME" "$THUMBMUX_TEST_RUNTIME/tmux" "$THUMBMUX_TEST_RUNTIME/tmux/tmux-$(id -u)"; test "$(command -v tmux)" = /usr/local/bin/tmux; tmux -V' \
  >/dev/null

thumbmux_emit_frozen_source_archive \
  | docker exec -i "$CONTAINER_ID" bash -lc 'mkdir -p /app && tar -C /app -xf -'

docker exec "$CONTAINER_ID" bash -lc 'cd /app && bun install --frozen-lockfile' >/dev/null
docker exec --detach "$CONTAINER_ID" bash -lc \
  'cd /app && exec bun run demo -- --host >/tmp/demo.log 2>&1'

TOKEN=''
DEADLINE=$((SECONDS + READY_TIMEOUT))
while (( SECONDS < DEADLINE )); do
  if [[ "$(docker inspect --format '{{.State.Running}}' "$CONTAINER_ID" 2>/dev/null || true)" != true ]]; then
    fail 'container stopped before the demo became ready'
  fi
  TOKEN="$(docker exec "$CONTAINER_ID" bash -lc \
    "grep -oE 't=[a-f0-9]+' /tmp/demo.log 2>/dev/null | head -n 1 | cut -d= -f2" \
    2>/dev/null || true)"
  if [[ -n "$TOKEN" ]]; then
    DEMO_URL="http://127.0.0.1:${HOST_PORT}/?t=${TOKEN}"
    if curl --fail --silent --show-error --max-time 2 "$DEMO_URL" >/dev/null 2>&1; then
      break
    fi
  fi
  sleep 1
done

if [[ -z "$TOKEN" ]] || ! curl --fail --silent --max-time 2 "$DEMO_URL" >/dev/null 2>&1; then
  echo 'thumbmux e2e: demo readiness timed out; recent demo log follows' >&2
  docker exec "$CONTAINER_ID" bash -lc 'tail -n 80 /tmp/demo.log' 2>/dev/null | redact_token >&2 || true
  exit 1
fi

echo "thumbmux e2e: demo ready on 127.0.0.1:${HOST_PORT}"
export DEMO_URL THUMBMUX_CONTAINER="$CONTAINER_ID" THUMBMUX_PACKAGE_DIR="$PACKAGE_ROOT"
export THUMBMUX_TEST_RUN_ID="$RUN_ID" THUMBMUX_TEST_SCOPE=e2e
export THUMBMUX_TEST_ATTESTATION="$THUMBMUX_GUARD_ATTESTATION"

cd "$E2E_DIR"
set +e
"$PLAYWRIGHT_BIN" test \
  --config=playwright.config.ts \
  --forbid-only \
  --output="$ARTIFACTS_DIR/playwright" \
  2>&1 | tee "$ARTIFACTS_DIR/playwright.log"
TEST_RC=${PIPESTATUS[0]}
set -e

exit "$TEST_RC"
