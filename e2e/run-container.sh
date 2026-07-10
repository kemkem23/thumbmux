#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
DEFAULT_PACKAGE_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"
PACKAGE_ROOT="${THUMBMUX_PACKAGE_DIR:-$DEFAULT_PACKAGE_ROOT}"
E2E_DIR="$PACKAGE_ROOT/e2e"

CONTAINER="${THUMBMUX_CONTAINER:-thumbmux-e2e-${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-0}-$$}"
IMAGE="${THUMBMUX_E2E_IMAGE:-oven/bun:1}"
DEMO_PORT="${THUMBMUX_DEMO_PORT:-7681}"
HOST_PORT="${THUMBMUX_HOST_PORT:-}"
READY_TIMEOUT="${THUMBMUX_E2E_READY_TIMEOUT:-90}"
ARTIFACTS_DIR="${THUMBMUX_E2E_ARTIFACTS:-${TMPDIR:-/tmp}/${CONTAINER}-artifacts}"
PLAYWRIGHT_BIN="${THUMBMUX_PLAYWRIGHT_BIN:-$PACKAGE_ROOT/node_modules/.bin/playwright}"
CONTAINER_STARTED=0

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
  if [[ "$CONTAINER_STARTED" == 1 ]]; then
    docker exec "$CONTAINER" bash -lc 'test -f /tmp/demo.log && cat /tmp/demo.log' 2>/dev/null \
      | redact_demo_log >"$ARTIFACTS_DIR/demo.log"
    docker rm -f "$CONTAINER" >/dev/null 2>&1
  fi
  trap - EXIT
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

command -v docker >/dev/null 2>&1 || fail 'docker is required'
command -v curl >/dev/null 2>&1 || fail 'curl is required'
command -v tar >/dev/null 2>&1 || fail 'tar is required'
[[ -f "$PACKAGE_ROOT/package.json" ]] || fail "package root is invalid: $PACKAGE_ROOT"
[[ -f "$E2E_DIR/playwright.config.ts" ]] || fail "e2e config is missing: $E2E_DIR/playwright.config.ts"
[[ -x "$PLAYWRIGHT_BIN" ]] || fail "local Playwright is missing; run bun install --frozen-lockfile"
[[ "$DEMO_PORT" =~ ^[0-9]+$ ]] || fail 'THUMBMUX_DEMO_PORT must be numeric'
[[ -z "$HOST_PORT" || "$HOST_PORT" =~ ^[0-9]+$ ]] || fail 'THUMBMUX_HOST_PORT must be numeric'
[[ "$READY_TIMEOUT" =~ ^[0-9]+$ ]] || fail 'THUMBMUX_E2E_READY_TIMEOUT must be numeric'

mkdir -p "$ARTIFACTS_DIR"
ARTIFACTS_DIR="$(cd -- "$ARTIFACTS_DIR" && pwd -P)"

shopt -s nullglob
SPECS=("$E2E_DIR"/*.spec.ts)
shopt -u nullglob
(( ${#SPECS[@]} > 0 )) || fail 'no e2e/*.spec.ts files found'

# The default name is unique. An explicit override is runner-owned too, so a
# stale container with that exact name is removed before launch.
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true

if [[ -n "$HOST_PORT" ]]; then
  PUBLISH=(--publish "127.0.0.1:${HOST_PORT}:${DEMO_PORT}")
else
  PUBLISH=(--publish "127.0.0.1::${DEMO_PORT}")
fi

docker run --detach --name "$CONTAINER" "${PUBLISH[@]}" "$IMAGE" sleep infinity >/dev/null
CONTAINER_STARTED=1

if [[ -z "$HOST_PORT" ]]; then
  HOST_PORT="$(docker port "$CONTAINER" "${DEMO_PORT}/tcp" \
    | awk -F: '/127[.]0[.]0[.]1:/ { print $NF; exit }')"
fi
[[ "$HOST_PORT" =~ ^[0-9]+$ ]] || fail 'docker did not publish an ephemeral localhost port'

echo "thumbmux e2e: container=$CONTAINER image=$IMAGE specs=${#SPECS[@]}"
echo "thumbmux e2e: artifacts=$ARTIFACTS_DIR"

docker exec "$CONTAINER" bash -lc \
  'apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq tmux procps' >/dev/null

tar -C "$PACKAGE_ROOT" \
  --exclude=.git \
  --exclude=node_modules \
  --exclude='*/node_modules' \
  --exclude=dist \
  --exclude='*/dist' \
  --exclude=git-dist \
  --exclude='*/git-dist' \
  -cf - . \
  | docker exec -i "$CONTAINER" bash -lc 'mkdir -p /app && tar -C /app -xf -'

docker exec "$CONTAINER" bash -lc 'cd /app && bun install --frozen-lockfile' >/dev/null
docker exec --detach "$CONTAINER" bash -lc \
  'cd /app && exec bun run demo -- --host >/tmp/demo.log 2>&1'

TOKEN=''
DEADLINE=$((SECONDS + READY_TIMEOUT))
while (( SECONDS < DEADLINE )); do
  if [[ "$(docker inspect --format '{{.State.Running}}' "$CONTAINER" 2>/dev/null || true)" != true ]]; then
    fail 'container stopped before the demo became ready'
  fi
  TOKEN="$(docker exec "$CONTAINER" bash -lc \
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
  docker exec "$CONTAINER" bash -lc 'tail -n 80 /tmp/demo.log' 2>/dev/null | redact_token >&2 || true
  exit 1
fi

echo "thumbmux e2e: demo ready on 127.0.0.1:${HOST_PORT}"
export DEMO_URL THUMBMUX_CONTAINER="$CONTAINER" THUMBMUX_PACKAGE_DIR="$PACKAGE_ROOT"

cd "$E2E_DIR"
set +e
"$PLAYWRIGHT_BIN" test \
  --config=playwright.config.ts \
  --output="$ARTIFACTS_DIR/playwright" \
  2>&1 | tee "$ARTIFACTS_DIR/playwright.log"
TEST_RC=${PIPESTATUS[0]}
set -e

exit "$TEST_RC"
