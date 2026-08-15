#!/usr/bin/env bash
# Regenerate packages/thumbmux/docs/media/*.png from the package demo.
#
# The demo talks to whatever tmux it can see. On this host that is kem's live
# agent fleet. Capture therefore runs inside a blank container whose tmux
# contains only the four staged README sessions. The host tmux server is never
# started, listed, or killed by this script.
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
PACKAGE_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"
REPO_README="$PACKAGE_ROOT/README.md"
MEDIA_DIR="$PACKAGE_ROOT/docs/media"
PLAYWRIGHT_BIN="${THUMBMUX_PLAYWRIGHT_BIN:-$PACKAGE_ROOT/node_modules/.bin/playwright}"

CONTAINER="${THUMBMUX_MEDIA_CONTAINER:-thumbmux-media-$$}"
IMAGE="${THUMBMUX_E2E_IMAGE:-oven/bun:1}"
DEMO_PORT="${THUMBMUX_DEMO_PORT:-7681}"
HOST_PORT="${THUMBMUX_HOST_PORT:-}"
READY_TIMEOUT="${THUMBMUX_E2E_READY_TIMEOUT:-180}"
ARTIFACTS_DIR="${THUMBMUX_MEDIA_ARTIFACTS:-${TMPDIR:-/tmp}/${CONTAINER}-artifacts}"
BASELINE_DIR="${THUMBMUX_MEDIA_BASELINE:-${TMPDIR:-/tmp}/${CONTAINER}-baseline}"

ALLOWED_NAMES=(agent build htop server-logs)
PHONE_W=780
PHONE_H=1328
DESKTOP_W=2880
DESKTOP_H=1720
HERO_W=2396
HERO_H=1328
MIN_BYTES=40000
MAX_BYTES=700000

CONTAINER_STARTED=0

fail() {
  echo "thumbmux media: $*" >&2
  exit 1
}

redact_token() {
  sed -E 's/([?&]t=)[a-f0-9]+/\1<redacted>/g'
}

snapshot_host() {
  mkdir -p "$BASELINE_DIR"
  docker ps -a --format '{{.ID}} {{.Names}}' | sort >"$BASELINE_DIR/docker.txt"
  if command -v tmux >/dev/null 2>&1; then
    tmux ls -F '#S' 2>/dev/null | sort >"$BASELINE_DIR/tmux.txt" || : >"$BASELINE_DIR/tmux.txt"
  else
    : >"$BASELINE_DIR/tmux.txt"
  fi
}

assert_host_untouched() {
  local now_docker now_tmux
  now_docker="$(mktemp)"
  now_tmux="$(mktemp)"
  docker ps -a --format '{{.ID}} {{.Names}}' | sort >"$now_docker"
  if command -v tmux >/dev/null 2>&1; then
    tmux ls -F '#S' 2>/dev/null | sort >"$now_tmux" || : >"$now_tmux"
  else
    : >"$now_tmux"
  fi
  if ! cmp -s "$BASELINE_DIR/docker.txt" "$now_docker"; then
    echo "thumbmux media: docker ps -a changed from the pre-run snapshot:" >&2
    diff -u "$BASELINE_DIR/docker.txt" "$now_docker" >&2 || true
    rm -f "$now_docker" "$now_tmux"
    fail "host docker inventory must match the pre-run snapshot"
  fi
  if ! cmp -s "$BASELINE_DIR/tmux.txt" "$now_tmux"; then
    echo "thumbmux media: host tmux ls changed from the pre-run snapshot:" >&2
    diff -u "$BASELINE_DIR/tmux.txt" "$now_tmux" >&2 || true
    rm -f "$now_docker" "$now_tmux"
    fail "host tmux must be identical — this script must never create or kill host sessions"
  fi
  rm -f "$now_docker" "$now_tmux"
}

cleanup() {
  local rc=$?
  set +e
  if [[ "$CONTAINER_STARTED" == 1 ]]; then
    docker exec "$CONTAINER" bash -lc 'test -f /tmp/demo.log && cat /tmp/demo.log' 2>/dev/null \
      | redact_token >"$ARTIFACTS_DIR/demo.log"
    docker rm -f "$CONTAINER" >/dev/null 2>&1
  fi
  rm -rf "$BASELINE_DIR" "$ARTIFACTS_DIR"
  trap - EXIT
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

command -v docker >/dev/null 2>&1 || fail 'docker is required'
command -v curl >/dev/null 2>&1 || fail 'curl is required'
command -v tar >/dev/null 2>&1 || fail 'tar is required'
command -v python3 >/dev/null 2>&1 || fail 'python3 is required'
[[ -f "$PACKAGE_ROOT/package.json" ]] || fail "package root is invalid: $PACKAGE_ROOT"
[[ -x "$PLAYWRIGHT_BIN" ]] || fail "local Playwright is missing; run bun install --frozen-lockfile && ./node_modules/.bin/playwright install chromium"
[[ "$DEMO_PORT" =~ ^[0-9]+$ ]] || fail 'THUMBMUX_DEMO_PORT must be numeric'
[[ -z "$HOST_PORT" || "$HOST_PORT" =~ ^[0-9]+$ ]] || fail 'THUMBMUX_HOST_PORT must be numeric'

mkdir -p "$ARTIFACTS_DIR" "$MEDIA_DIR"
ARTIFACTS_DIR="$(cd -- "$ARTIFACTS_DIR" && pwd -P)"

snapshot_host
echo "thumbmux media: host baseline docker=$(wc -l <"$BASELINE_DIR/docker.txt") tmux=$(wc -l <"$BASELINE_DIR/tmux.txt")"

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

echo "thumbmux media: container=$CONTAINER image=$IMAGE host=127.0.0.1:${HOST_PORT}"
echo "thumbmux media: artifacts=$ARTIFACTS_DIR"

docker exec "$CONTAINER" bash -lc \
  'apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq tmux procps htop locales >/dev/null && (locale-gen C.UTF-8 >/dev/null 2>&1 || true)'

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

# Stage the four sessions BEFORE the demo starts so the first hub frame is clean.
docker exec "$CONTAINER" bash -lc \
  'export LANG=C.UTF-8 LC_ALL=C.UTF-8; chmod +x /app/scripts/media-scenes/stage.sh && /app/scripts/media-scenes/stage.sh'

# Hard isolation: container tmux must be exactly the four staged names.
CONTAINER_SESSIONS="$(docker exec "$CONTAINER" bash -lc "tmux list-sessions -F '#{session_name}' | sort")"
EXPECTED_SESSIONS="$(printf '%s\n' "${ALLOWED_NAMES[@]}" | sort)"
[[ "$CONTAINER_SESSIONS" == "$EXPECTED_SESSIONS" ]] || fail "container tmux is not the four staged sessions:
expected:
$EXPECTED_SESSIONS
got:
$CONTAINER_SESSIONS"

if printf '%s\n' "$CONTAINER_SESSIONS" | grep -Eq '^(cc|claude|codex|grok)-'; then
  fail "container tmux contains a host-agent prefix — aborting before capture"
fi

docker exec --detach "$CONTAINER" bash -lc \
  'export LANG=C.UTF-8 LC_ALL=C.UTF-8; cd /app && exec bun run demo -- --host >/tmp/demo.log 2>&1'

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
  echo 'thumbmux media: demo readiness timed out; recent demo log follows' >&2
  docker exec "$CONTAINER" bash -lc 'tail -n 80 /tmp/demo.log' 2>/dev/null | redact_token >&2 || true
  exit 1
fi

echo "thumbmux media: demo ready on 127.0.0.1:${HOST_PORT}"

export DEMO_URL
export THUMBMUX_MEDIA_OUT="$MEDIA_DIR"
export THUMBMUX_MEDIA_ARTIFACTS="$ARTIFACTS_DIR"
export THUMBMUX_README="$REPO_README"

cd "$PACKAGE_ROOT"
bun "$SCRIPT_DIR/capture-media.ts"

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
CONTAINER_SESSIONS="$(docker exec "$CONTAINER" bash -lc "tmux list-sessions -F '#{session_name}' | sort")"
[[ "$CONTAINER_SESSIONS" == "$EXPECTED_SESSIONS" ]] || fail "container tmux drifted during capture:
$CONTAINER_SESSIONS"

echo "thumbmux media: ten files written under $MEDIA_DIR"

# Drop the container now so the host-inventory compare sees a clean slate.
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
CONTAINER_STARTED=0
rm -rf "$ARTIFACTS_DIR"
assert_host_untouched
echo "thumbmux media: container removed, scratch gone, host docker/tmux match the pre-run snapshot"
