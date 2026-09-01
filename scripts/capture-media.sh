#!/usr/bin/bash -p
case "$-" in *p*) ;; *) printf 'thumbmux media: privileged interpreter is required\n' >&2; exit 126 ;; esac
THUMBMUX_ENTRY_CALLER_PATH="${PATH-}"
PATH=/usr/bin:/bin
export PATH THUMBMUX_ENTRY_CALLER_PATH
unset BASH_ENV ENV CDPATH GLOBIGNORE NODE_OPTIONS BUN_OPTIONS NODE_PATH \
  PYTHONPATH PYTHONHOME PYTHONSTARTUP LD_PRELOAD LD_LIBRARY_PATH \
  GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY \
  GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_CONFIG_GLOBAL GIT_CONFIG_SYSTEM \
  GIT_CONFIG_NOSYSTEM GIT_CONFIG_COUNT 2>/dev/null || :
# Regenerate packages/thumbmux/docs/media/*.png from the package demo.
#
# The demo talks only to an attested private tmux socket inside an exactly
# labelled disposable container. The host tmux server is never opened, listed,
# started, or killed by this script.
set -euo pipefail

SCRIPT_FILE="$(/usr/bin/realpath -e -- "${BASH_SOURCE[0]}")" \
  || { printf 'thumbmux media: entrypoint path is unavailable\n' >&2; exit 126; }
SCRIPT_DIR="$(/usr/bin/dirname -- "$SCRIPT_FILE")"
PACKAGE_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"
LIVE_MEDIA_DIR="$PACKAGE_ROOT/docs/media"
REPO_README=''
MEDIA_DIR=''
PLAYWRIGHT_BIN="$PACKAGE_ROOT/node_modules/.bin/playwright"
. "$SCRIPT_DIR/test-runtime-guard.sh"

IMAGE="oven/bun:1"
DEMO_PORT=7681
HOST_PORT=''
READY_TIMEOUT="${THUMBMUX_E2E_READY_TIMEOUT:-180}"

ALLOWED_NAMES=(agent build htop server-logs)
MEDIA_FILES=(composer.png desktop-agent.png desktop-htop.png hero.png hub.png \
  launcher.png shortcuts.png term-agent.png term-cream.png theme.png)
PHONE_W=780
PHONE_H=1328
DESKTOP_W=2880
DESKTOP_H=1720
HERO_W=2396
HERO_H=1328
MIN_BYTES=40000
MAX_BYTES=700000

CONTAINER_STARTED=0
CONTAINER_ID=''
CLEANUP_FAILED=0
ARTIFACTS_DIR=''
THUMBMUX_GUARD_RUNTIME=''
CID_FILE=''

fail() {
  echo "thumbmux media: $*" >&2
  exit 1
}

redact_token() {
  sed -E 's/([?&]t=)[a-f0-9]+/\1<redacted>/g'
}

assert_owned_container() {
  local identity
  [[ "$CONTAINER_ID" =~ ^[a-f0-9]{64}$ ]] || return 1
  identity="$(docker inspect --format \
    '{{.Id}}|{{.Name}}|{{index .Config.Labels "com.kemcortex.thumbmux.run-id"}}|{{index .Config.Labels "com.kemcortex.thumbmux.scope"}}' \
    "$CONTAINER_ID" 2>/dev/null || true)"
  [[ "$identity" == "$CONTAINER_ID|/$CONTAINER|$RUN_ID|media" ]]
}

cleanup() {
  local rc=$?
  set +e
  if [[ "$CONTAINER_STARTED" == 0 && -n "$CID_FILE" && -s "$CID_FILE" ]]; then
    CONTAINER_ID="$(<"$CID_FILE")"
    if [[ "$CONTAINER_ID" =~ ^[a-f0-9]{64}$ ]]; then
      CONTAINER_STARTED=1
    else
      echo 'thumbmux media: invalid Docker cidfile; refusing guessed cleanup' >&2
      CLEANUP_FAILED=1
    fi
  fi
  if [[ "$CONTAINER_STARTED" == 1 ]]; then
    if thumbmux_recheck_docker_attestation && assert_owned_container; then
      docker exec "$CONTAINER_ID" bash -lc 'test -f /tmp/demo.log && cat /tmp/demo.log' 2>/dev/null \
      | redact_token >"$ARTIFACTS_DIR/demo.log"
      if ! docker rm -f "$CONTAINER_ID" >/dev/null 2>&1 \
        || docker inspect "$CONTAINER_ID" >/dev/null 2>&1; then
        echo 'thumbmux media: exact owned-container cleanup failed; runtime retained' >&2
        CLEANUP_FAILED=1
      fi
    else
      echo 'thumbmux media: container identity/labels changed; refusing cleanup' >&2
      CLEANUP_FAILED=1
    fi
  fi
  if [[ "$CLEANUP_FAILED" == 0 && -n "$THUMBMUX_GUARD_RUNTIME" ]]; then
    thumbmux_remove_test_runtime || CLEANUP_FAILED=1
  fi
  (( CLEANUP_FAILED == 0 )) || rc=1
  trap - EXIT
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

for forbidden_override in THUMBMUX_MEDIA_CONTAINER THUMBMUX_E2E_IMAGE \
  THUMBMUX_DEMO_PORT THUMBMUX_HOST_PORT THUMBMUX_MEDIA_ARTIFACTS \
  THUMBMUX_MEDIA_BASELINE THUMBMUX_PLAYWRIGHT_BIN; do
  [[ -z "${!forbidden_override-}" ]] \
    || fail "$forbidden_override is runner-owned and cannot be overridden"
done

thumbmux_prepare_test_runtime media "$PACKAGE_ROOT" \
  || fail 'disposable CI/Docker attestation failed'
RUN_ID="$(thumbmux_make_run_id)" || fail 'run id generation failed'
thumbmux_bind_run_attestation "$RUN_ID" media || fail 'run attestation failed'
CID_FILE="$THUMBMUX_GUARD_RUNTIME/container.cid"
CONTAINER="thumbmux-media-${RUN_ID}"
CONTAINER_RUNTIME="/run/thumbmux-media-${RUN_ID}"
FROZEN_HOST_SOURCE="$THUMBMUX_GUARD_RUNTIME/frozen-host-source"
/usr/bin/install -d -m 0700 "$FROZEN_HOST_SOURCE"
thumbmux_emit_frozen_source_archive \
  | /usr/bin/tar -x -C "$FROZEN_HOST_SOURCE" README.md scripts/private-test-tmux.sh \
  || fail 'could not materialize the attested private tmux shim'
PRIVATE_TMUX_SHIM="$FROZEN_HOST_SOURCE/scripts/private-test-tmux.sh"
REPO_README="$FROZEN_HOST_SOURCE/README.md"
MEDIA_DIR="$THUMBMUX_GUARD_RUNTIME/generated-media"

command -v curl >/dev/null 2>&1 || fail 'curl is required'
command -v tar >/dev/null 2>&1 || fail 'tar is required'
command -v python3 >/dev/null 2>&1 || fail 'python3 is required'
[[ -f "$PACKAGE_ROOT/package.json" ]] || fail "package root is invalid: $PACKAGE_ROOT"
[[ -x "$PLAYWRIGHT_BIN" ]] || fail "local Playwright is missing; run bun install --frozen-lockfile && ./node_modules/.bin/playwright install chromium"
[[ "$READY_TIMEOUT" =~ ^[0-9]+$ ]] || fail 'THUMBMUX_E2E_READY_TIMEOUT must be numeric'

[[ -x "$PRIVATE_TMUX_SHIM" && ! -L "$PRIVATE_TMUX_SHIM" ]] \
  || fail 'private tmux shim is missing, non-executable, or symlinked'
ARTIFACTS_DIR="$THUMBMUX_GUARD_RUNTIME/artifacts"

mkdir -p "$ARTIFACTS_DIR" "$MEDIA_DIR"
ARTIFACTS_DIR="$(cd -- "$ARTIFACTS_DIR" && pwd -P)"

thumbmux_recheck_docker_attestation \
  || fail 'Docker daemon changed before container creation'
CONTAINER_ID="$(docker run --detach \
  --cidfile "$CID_FILE" \
  --name "$CONTAINER" \
  --hostname "$CONTAINER" \
  --label "com.kemcortex.thumbmux.run-id=$RUN_ID" \
  --label 'com.kemcortex.thumbmux.scope=media' \
  --publish "127.0.0.1::${DEMO_PORT}" \
  --mount "type=bind,src=$PRIVATE_TMUX_SHIM,dst=/usr/local/bin/tmux,readonly" \
  --mount "type=bind,src=$THUMBMUX_GUARD_ATTESTATION,dst=/run/thumbmux-host-attestation,readonly" \
  --env "THUMBMUX_TEST_RUNTIME=$CONTAINER_RUNTIME" \
  --env "THUMBMUX_TEST_RUN_ID=$RUN_ID" \
  --env 'THUMBMUX_TEST_SCOPE=media' \
  --env 'THUMBMUX_TEST_CONTAINER_SCOPE=media' \
  --env "THUMBMUX_TEST_TMUX_SOCKET=$CONTAINER_RUNTIME/tmux/tmux-0/default" \
  "$IMAGE" sleep infinity)" || fail 'Docker refused the unique media container'
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

echo "thumbmux media: container=$CONTAINER image=$IMAGE host=127.0.0.1:${HOST_PORT}"
echo "thumbmux media: artifacts=$ARTIFACTS_DIR"

docker exec "$CONTAINER_ID" bash -lc \
  'apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq tmux procps htop locales >/dev/null && (locale-gen C.UTF-8 >/dev/null 2>&1 || true)'
docker exec "$CONTAINER_ID" bash -lc \
  'install -d -m 0700 "$THUMBMUX_TEST_RUNTIME" "$THUMBMUX_TEST_RUNTIME/tmux" "$THUMBMUX_TEST_RUNTIME/tmux/tmux-$(id -u)"; test "$(command -v tmux)" = /usr/local/bin/tmux; tmux -V' \
  >/dev/null

thumbmux_emit_frozen_source_archive \
  | docker exec -i "$CONTAINER_ID" bash -lc 'mkdir -p /app && tar -C /app -xf -'

docker exec "$CONTAINER_ID" bash -lc 'cd /app && bun install --frozen-lockfile' >/dev/null

# Stage the four sessions BEFORE the demo starts so the first hub frame is clean.
docker exec "$CONTAINER_ID" bash -lc \
  'export LANG=C.UTF-8 LC_ALL=C.UTF-8; chmod +x /app/scripts/media-scenes/stage.sh && /app/scripts/media-scenes/stage.sh'

# Hard isolation: container tmux must be exactly the four staged names.
CONTAINER_SESSIONS="$(docker exec "$CONTAINER_ID" bash -lc "tmux list-sessions -F '#{session_name}' | sort")"
EXPECTED_SESSIONS="$(printf '%s\n' "${ALLOWED_NAMES[@]}" | sort)"
[[ "$CONTAINER_SESSIONS" == "$EXPECTED_SESSIONS" ]] || fail "container tmux is not the four staged sessions:
expected:
$EXPECTED_SESSIONS
got:
$CONTAINER_SESSIONS"

if printf '%s\n' "$CONTAINER_SESSIONS" | grep -Eq '^(cc|claude|codex|grok)-'; then
  fail "container tmux contains a host-agent prefix — aborting before capture"
fi

docker exec --detach "$CONTAINER_ID" bash -lc \
  'export LANG=C.UTF-8 LC_ALL=C.UTF-8; cd /app && exec bun run demo -- --host >/tmp/demo.log 2>&1'

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
  echo 'thumbmux media: demo readiness timed out; recent demo log follows' >&2
  docker exec "$CONTAINER_ID" bash -lc 'tail -n 80 /tmp/demo.log' 2>/dev/null | redact_token >&2 || true
  exit 1
fi

echo "thumbmux media: demo ready on 127.0.0.1:${HOST_PORT}"

export DEMO_URL
export THUMBMUX_MEDIA_OUT="$MEDIA_DIR"
export THUMBMUX_MEDIA_ARTIFACTS="$ARTIFACTS_DIR"
export THUMBMUX_README="$REPO_README"
export THUMBMUX_CONTAINER="$CONTAINER_ID"
export THUMBMUX_TEST_RUN_ID="$RUN_ID" THUMBMUX_TEST_SCOPE=media
export THUMBMUX_TEST_ATTESTATION="$THUMBMUX_GUARD_ATTESTATION"

cd "$PACKAGE_ROOT"
"$THUMBMUX_GUARD_BUN_BIN" "$SCRIPT_DIR/capture-media.ts"

python3 - <<'PY'
from pathlib import Path
import json, os, sys

try:
    from PIL import Image
except ImportError:
    import subprocess
    subprocess.check_call([sys.executable, "-m", "pip", "install", "-q", "Pillow"])
    from PIL import Image

media = Path(os.environ["THUMBMUX_MEDIA_OUT"])
artifacts = Path(os.environ["THUMBMUX_MEDIA_ARTIFACTS"])
panels = json.loads((artifacts / "hero-panels.json").read_text())
imgs = [Image.open(p).convert("RGB") for p in panels]
if len(imgs) != 3:
    raise SystemExit(f"expected 3 hero panels, got {len(imgs)}")
gap = 28
bg = (245, 242, 236)
out = Image.new("RGB", (sum(i.width for i in imgs) + gap * 2, imgs[0].height), bg)
x = 0
for i, im in enumerate(imgs):
    out.paste(im, (x, 0))
    x += im.width + (gap if i < 2 else 0)
dest = media / "hero.png"
out.save(dest, optimize=True)
print(f"thumbmux media: stitched {dest} {out.size[0]}x{out.size[1]}")
for p in panels:
    Path(p).unlink(missing_ok=True)
PY

# Dimension + size + README-path gates.
python3 - <<'PY'
from pathlib import Path
import os, sys

try:
    from PIL import Image
except ImportError:
    import subprocess
    subprocess.check_call([sys.executable, "-m", "pip", "install", "-q", "Pillow"])
    from PIL import Image

media = Path(os.environ["THUMBMUX_MEDIA_OUT"])
readme = Path(os.environ.get("THUMBMUX_README", "")) 
# filled below via env
readme = Path(os.environ["THUMBMUX_README"])
expected = {
    "composer.png": (780, 1328),
    "desktop-agent.png": (2880, 1720),
    "desktop-htop.png": (2880, 1720),
    "hero.png": (2396, 1328),
    "hub.png": (780, 1328),
    "launcher.png": (780, 1328),
    "shortcuts.png": (780, 1328),
    "term-agent.png": (780, 1328),
    "term-cream.png": (780, 1328),
    "theme.png": (780, 1328),
}
errors = []
for name, size in expected.items():
    path = media / name
    if not path.is_file():
        errors.append(f"missing {name}")
        continue
    im = Image.open(path)
    if im.size != size:
        errors.append(f"{name} is {im.size[0]}x{im.size[1]}, expected {size[0]}x{size[1]}")
    n = path.stat().st_size
    if n < 40_000 or n > 700_000:
        errors.append(f"{name} is {n} bytes — outside the 40–700 KB neighbourhood")
    print(f"  {name:22} {im.size[0]:4}x{im.size[1]:<4} {n:7} bytes")

import re
refs = sorted(set(re.findall(r"docs/media/[a-z-]+\.png", readme.read_text())))
for ref in refs:
    if not (media.parent.parent / ref).is_file() and not (media / Path(ref).name).is_file():
        errors.append(f"README references {ref} but the file is missing")
print(f"README image refs: {', '.join(refs)}")
if errors:
    print("thumbmux media: verification failed:", file=sys.stderr)
    for err in errors:
        print(f"  - {err}", file=sys.stderr)
    sys.exit(1)
PY

# Re-assert container tmux still has only the four names after capture.
CONTAINER_SESSIONS="$(docker exec "$CONTAINER_ID" bash -lc "tmux list-sessions -F '#{session_name}' | sort")"
[[ "$CONTAINER_SESSIONS" == "$EXPECTED_SESSIONS" ]] || fail "container tmux drifted during capture:
$CONTAINER_SESSIONS"

echo "thumbmux media: ten files written under $MEDIA_DIR"

# Drop exactly the labelled container ID created by this run.
thumbmux_recheck_docker_attestation \
  || fail 'Docker daemon changed before exact container cleanup'
assert_owned_container || fail 'container identity/labels changed before cleanup'
docker rm -f "$CONTAINER_ID" >/dev/null
if docker inspect "$CONTAINER_ID" >/dev/null 2>&1; then
  fail 'owned media container survived cleanup'
fi
CONTAINER_STARTED=0

# Only after every Docker/tmux/browser lifecycle has ended do the validated
# images cross from the private runtime into the tracked documentation tree.
[[ -d "$LIVE_MEDIA_DIR" && ! -L "$LIVE_MEDIA_DIR" \
  && "$(/usr/bin/realpath -e -- "$LIVE_MEDIA_DIR")" == "$PACKAGE_ROOT/docs/media" ]] \
  || fail 'tracked media destination is missing, symlinked, or non-canonical'
for media_file in "${MEDIA_FILES[@]}"; do
  source_file="$MEDIA_DIR/$media_file"
  staged_file="$LIVE_MEDIA_DIR/.${media_file}.thumbmux-${RUN_ID}.tmp"
  [[ -f "$source_file" && ! -L "$source_file" ]] \
    || fail "validated media output disappeared: $media_file"
  /usr/bin/install -m 0644 -- "$source_file" "$staged_file"
  /usr/bin/mv -f -- "$staged_file" "$LIVE_MEDIA_DIR/$media_file"
done
thumbmux_remove_test_runtime
THUMBMUX_GUARD_RUNTIME=''
echo "thumbmux media: owned container removed; validated files installed under $LIVE_MEDIA_DIR; host tmux was never opened"
