#!/usr/bin/env bash
# Stage the four README sessions inside the capture container.
# Must run IN the container. Session names are the public names in hub.png.
set -euo pipefail

export LANG="${LANG:-C.UTF-8}"
export LC_ALL="${LC_ALL:-C.UTF-8}"
export TERM="${TERM:-xterm-256color}"

SCENE_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
ALLOWED=(agent build htop server-logs)

fail() { echo "media-scenes: $*" >&2; exit 1; }

command -v tmux >/dev/null 2>&1 || fail 'tmux is required'
command -v htop >/dev/null 2>&1 || fail 'htop is required'
[[ -f "$SCENE_DIR/agent.sh" ]] || fail "missing $SCENE_DIR/agent.sh"
[[ -f "$SCENE_DIR/build.sh" ]] || fail "missing $SCENE_DIR/build.sh"
[[ -f "$SCENE_DIR/server-logs.sh" ]] || fail "missing $SCENE_DIR/server-logs.sh"

tmux start-server
tmux set-option -g default-terminal 'xterm-256color'
tmux set-option -g history-limit 5000
tmux set-option -g status off

# Kill only the four staged names if a previous attempt left them.
for name in "${ALLOWED[@]}"; do
  tmux kill-session -t "=$name" 2>/dev/null || true
done

# agent · build · server-logs: printf scenes, then a held bash.
for name in agent build server-logs; do
  tmux new-session -d -s "$name" -x 120 -y 40 \
    "env LANG=C.UTF-8 LC_ALL=C.UTF-8 TERM=xterm-256color bash --noprofile --norc -c 'source $(printf %q "$SCENE_DIR/$name.sh"); exec env PS1=\"> \" bash --noprofile --norc'"
done

# htop is the one real TUI: alt-screen + SGR mouse is why this image exists.
tmux new-session -d -s htop -x 160 -y 48 \
  'env LANG=C.UTF-8 LC_ALL=C.UTF-8 TERM=xterm-256color htop -d 20'

# Fail closed if anything else is in this tmux server.
mapfile -t live < <(tmux list-sessions -F '#{session_name}' | sort)
expected=$(printf '%s\n' "${ALLOWED[@]}" | sort)
got=$(printf '%s\n' "${live[@]}")
[[ "$got" == "$expected" ]] || fail "unexpected sessions in container tmux:
expected:
$expected
got:
$got"

echo "media-scenes: staged ${live[*]}"
