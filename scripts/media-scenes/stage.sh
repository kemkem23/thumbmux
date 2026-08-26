#!/usr/bin/bash -p
case "$-" in *p*) ;; *) printf 'media-scenes: privileged interpreter is required\n' >&2; exit 126 ;; esac
THUMBMUX_ENTRY_CALLER_PATH="${PATH-}"
PATH=/usr/bin:/bin
export PATH THUMBMUX_ENTRY_CALLER_PATH
unset BASH_ENV ENV CDPATH GLOBIGNORE NODE_OPTIONS BUN_OPTIONS NODE_PATH \
  PYTHONPATH PYTHONHOME PYTHONSTARTUP LD_PRELOAD LD_LIBRARY_PATH \
  GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY \
  GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_CONFIG_GLOBAL GIT_CONFIG_SYSTEM \
  GIT_CONFIG_NOSYSTEM GIT_CONFIG_COUNT 2>/dev/null || :
# Stage the four README sessions inside the capture container.
# Must run IN the container. Session names are the public names in hub.png.
set -euo pipefail

# docker exec defaults TERM=dumb; tmux then refuses to keep a server up.
export LANG=C.UTF-8
export LC_ALL=C.UTF-8
export TERM=xterm-256color

SCRIPT_FILE="$(/usr/bin/realpath -e -- "${BASH_SOURCE[0]}")" \
  || { printf 'media-scenes: entrypoint path is unavailable\n' >&2; exit 126; }
SCENE_DIR="$(/usr/bin/dirname -- "$SCRIPT_FILE")"
ALLOWED=(agent build htop server-logs)

fail() { echo "media-scenes: $*" >&2; exit 1; }

RUN_ID="${THUMBMUX_TEST_RUN_ID-}"
RUNTIME="${THUMBMUX_TEST_RUNTIME-}"
SOCKET="${THUMBMUX_TEST_TMUX_SOCKET-}"
ATTESTATION=/run/thumbmux-host-attestation
[[ -f /.dockerenv \
  && "${THUMBMUX_TEST_CONTAINER_SCOPE-}" == media \
  && "$RUN_ID" =~ ^[a-f0-9]{32}$ \
  && "$RUNTIME" == "/run/thumbmux-media-${RUN_ID}" \
  && -d "$RUNTIME" && ! -L "$RUNTIME" \
  && "$(stat -Lc '%u:%a' -- "$RUNTIME" 2>/dev/null || true)" == "$(id -u):700" \
  && "$SOCKET" == "$RUNTIME/tmux/tmux-$(id -u)/default" ]] \
  || fail 'disposable container/private-tmux boundary is not attested'
[[ "$(hostname)" == "thumbmux-media-${RUN_ID}" ]] \
  || fail 'container hostname does not match the generated run id'
mapfile -t RECEIPT < "$ATTESTATION" 2>/dev/null || true
[[ -f "$ATTESTATION" && ! -L "$ATTESTATION" \
  && "$(/usr/bin/stat -Lc '%a' -- "$ATTESTATION" 2>/dev/null || true)" == 600 \
  && "${#RECEIPT[@]}" == 14 \
  && "${RECEIPT[0]-}" == version=2 \
  && "${RECEIPT[1]-}" =~ ^provider=github-hosted(-frozen-export)?$ \
  && "${RECEIPT[2]-}" == checkout=/* \
  && "${RECEIPT[3]-}" =~ ^git-sha=[a-f0-9]{40}$ \
  && "${RECEIPT[4]-}" =~ ^git-tree=[a-f0-9]{40,64}$ \
  && "${RECEIPT[5]-}" =~ ^checkout-identity=[0-9]+:[0-9]+:[0-9]+:[0-7]{3,4}$ \
  && "${RECEIPT[6]-}" =~ ^runtime-identity=[0-9]+:[0-9]+:[0-9]+:700$ \
  && "${RECEIPT[7]-}" =~ ^receipt-identity=[0-9]+:[0-9]+:[0-9]+$ \
  && "${RECEIPT[8]-}" == docker-host=unix:///var/run/docker.sock \
  && "${RECEIPT[9]-}" =~ ^docker-id=[A-Za-z0-9:._-]{8,128}$ \
  && "${RECEIPT[10]-}" == docker-root=/var/lib/docker \
  && "${RECEIPT[11]-}" =~ ^docker-socket-identity=[0-9]+:[0-9]+:[0-9]+:[0-7]{3,4}$ \
  && "${RECEIPT[12]-}" == scope=media \
  && "${RECEIPT[13]-}" == "run-id=${RUN_ID}" ]] \
  || fail 'host runtime attestation is missing or does not match this run'
PATH=/usr/local/bin:/usr/bin:/bin
export PATH
[[ -z "${TMUX-}" && -z "${TMUX_PANE-}" \
  && "$(command -v tmux 2>/dev/null || true)" == /usr/local/bin/tmux \
  && -x /usr/local/bin/tmux && ! -L /usr/local/bin/tmux ]] \
  || fail 'private tmux shim is not the only tmux entry point'
command -v htop >/dev/null 2>&1 || fail 'htop is required'
[[ -f "$SCENE_DIR/agent.sh" ]] || fail "missing $SCENE_DIR/agent.sh"
[[ -f "$SCENE_DIR/build.sh" ]] || fail "missing $SCENE_DIR/build.sh"
[[ -f "$SCENE_DIR/server-logs.sh" ]] || fail "missing $SCENE_DIR/server-logs.sh"

# start-server with no sessions + default exit-empty=on = the server vanishes
# before the next command. Create the first session, then configure.
tmux new-session -d -s agent -x 120 -y 40 \
  "env LANG=C.UTF-8 LC_ALL=C.UTF-8 TERM=xterm-256color bash --noprofile --norc -c 'source $(printf %q "$SCENE_DIR/agent.sh"); exec env PS1=\"> \" TERM=xterm-256color bash --noprofile --norc'"
tmux set-option -g default-terminal 'xterm-256color'
tmux set-option -g history-limit 5000
tmux set-option -g status off
tmux set-option -g exit-empty off

tmux new-session -d -s build -x 120 -y 40 \
  "env LANG=C.UTF-8 LC_ALL=C.UTF-8 TERM=xterm-256color bash --noprofile --norc -c 'source $(printf %q "$SCENE_DIR/build.sh"); exec env PS1=\"> \" TERM=xterm-256color bash --noprofile --norc'"

tmux new-session -d -s server-logs -x 120 -y 40 \
  "env LANG=C.UTF-8 LC_ALL=C.UTF-8 TERM=xterm-256color bash --noprofile --norc -c 'source $(printf %q "$SCENE_DIR/server-logs.sh"); exec env PS1=\"> \" TERM=xterm-256color bash --noprofile --norc'"

# htop is the one real TUI: alt-screen + SGR mouse is why this image exists.
tmux new-session -d -s htop -x 160 -y 48 \
  'env LANG=C.UTF-8 LC_ALL=C.UTF-8 TERM=xterm-256color htop -d 20'

mapfile -t live < <(tmux list-sessions -F '#{session_name}' | sort)
expected=$(printf '%s\n' "${ALLOWED[@]}" | sort)
got=$(printf '%s\n' "${live[@]}")
[[ "$got" == "$expected" ]] || fail "unexpected sessions in container tmux:
expected:
$expected
got:
$got"

echo "media-scenes: staged ${live[*]}"
