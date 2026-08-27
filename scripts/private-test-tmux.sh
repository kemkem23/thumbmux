#!/usr/bin/bash -p
case "$-" in *p*) ;; *) printf 'private-test-tmux: privileged interpreter is required\n' >&2; exit 126 ;; esac
THUMBMUX_ENTRY_CALLER_PATH="${PATH-}"
PATH=/usr/bin:/bin
export PATH THUMBMUX_ENTRY_CALLER_PATH
unset BASH_ENV ENV CDPATH GLOBIGNORE NODE_OPTIONS BUN_OPTIONS NODE_PATH \
  PYTHONPATH PYTHONHOME PYTHONSTARTUP LD_PRELOAD LD_LIBRARY_PATH \
  GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY \
  GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_CONFIG_GLOBAL GIT_CONFIG_SYSTEM \
  GIT_CONFIG_NOSYSTEM GIT_CONFIG_COUNT 2>/dev/null || :
set -euo pipefail

socket="${THUMBMUX_TEST_TMUX_SOCKET:?private test tmux socket is required}"
runtime="${THUMBMUX_TEST_RUNTIME:?private test runtime is required}"
run_id="${THUMBMUX_TEST_RUN_ID:?private test run id is required}"
scope="${THUMBMUX_TEST_SCOPE:?private test scope is required}"
attestation_identity=''
last_byte=''
receipt_identity() { /usr/bin/stat -Lc '%d:%i:%u' -- "$1" 2>/dev/null || true; }
runtime_identity() { /usr/bin/stat -Lc '%d:%i:%u:%a' -- "$1" 2>/dev/null || true; }

[[ "$run_id" =~ ^[a-f0-9]{32}$ ]] \
  || { printf 'private-test-tmux: invalid run id\n' >&2; exit 2; }
[[ "$scope" =~ ^[a-z][a-z0-9-]*$ ]] \
  || { printf 'private-test-tmux: invalid scope\n' >&2; exit 2; }
[[ "$runtime" =~ ^/home/runner/work/_temp/thumbmux-${scope}\.[A-Za-z0-9]{8}$ \
  || "$runtime" == "/run/thumbmux-${scope}-${run_id}" ]] \
  || { printf 'private-test-tmux: invalid runtime boundary\n' >&2; exit 2; }
[[ -d "$runtime" && ! -L "$runtime" \
  && "$(stat -Lc '%u:%a' -- "$runtime" 2>/dev/null || true)" == "$(id -u):700" ]] \
  || { printf 'private-test-tmux: unsafe runtime ownership/mode\n' >&2; exit 2; }
[[ "$socket" == "$runtime/tmux/tmux-$(id -u)/default" ]] \
  || { printf 'private-test-tmux: socket escaped runtime\n' >&2; exit 2; }
if [[ "$runtime" == /run/* ]]; then
  attestation=/run/thumbmux-host-attestation
else
  attestation="$runtime/runtime-attestation"
fi
attestation_identity="$(receipt_identity "$attestation")"
mapfile -t receipt < "$attestation" 2>/dev/null || true
last_byte="$(/usr/bin/tail -c 1 -- "$attestation" 2>/dev/null \
  | /usr/bin/od -An -tx1 | /usr/bin/tr -d ' \n')"
[[ "$scope" =~ ^[a-z][a-z0-9-]*$ \
  && -f "$attestation" && ! -L "$attestation" \
  && "$(/usr/bin/stat -Lc '%a' -- "$attestation" 2>/dev/null || true)" == 600 \
  && -n "$attestation_identity" \
  && "$attestation_identity" == "$(receipt_identity "$attestation")" \
  && "$last_byte" == 0a \
  && "${#receipt[@]}" == 14 \
  && "${receipt[0]-}" == version=2 \
  && "${receipt[1]-}" =~ ^provider=github-hosted(-frozen-export)?$ \
  && "${receipt[2]-}" == checkout=/* \
  && "${receipt[3]-}" =~ ^git-sha=[a-f0-9]{40}$ \
  && "${receipt[4]-}" =~ ^git-tree=[a-f0-9]{40,64}$ \
  && "${receipt[5]-}" =~ ^checkout-identity=[0-9]+:[0-9]+:[0-9]+:[0-7]{3,4}$ \
  && "${receipt[6]-}" =~ ^runtime-identity=[0-9]+:[0-9]+:[0-9]+:700$ \
  && "${receipt[7]-}" =~ ^receipt-identity=[0-9]+:[0-9]+:[0-9]+$ \
  && "${receipt[8]-}" == docker-host=unix:///var/run/docker.sock \
  && "${receipt[9]-}" =~ ^docker-id=[A-Za-z0-9:._-]{8,128}$ \
  && "${receipt[10]-}" == docker-root=/var/lib/docker \
  && "${receipt[11]-}" =~ ^docker-socket-identity=[0-9]+:[0-9]+:[0-9]+:[0-7]{3,4}$ \
  && "${receipt[12]-}" == "scope=${scope}" \
  && "${receipt[13]-}" == "run-id=${run_id}" ]] \
  || { printf 'private-test-tmux: run attestation does not match\n' >&2; exit 2; }
if [[ "$runtime" == /home/* ]]; then
  [[ "${receipt[6]}" == "runtime-identity=$(runtime_identity "$runtime")" \
    && "${receipt[7]}" == "receipt-identity=$(receipt_identity "$attestation")" \
    && "$(/usr/bin/stat -Lc '%u' -- "$attestation" 2>/dev/null || true)" == "$(id -u)" ]] \
    || { printf 'private-test-tmux: host runtime/receipt inode changed\n' >&2; exit 2; }
else
  [[ "${receipt[7]}" == "receipt-identity=${attestation_identity}" ]] \
    || { printf 'private-test-tmux: mounted receipt inode does not match the host receipt\n' >&2; exit 2; }
fi
[[ -z "${TMUX-}" && -z "${TMUX_PANE-}" && -z "${TMUX_TMPDIR-}" ]] \
  || { printf 'private-test-tmux: inherited tmux context is forbidden\n' >&2; exit 2; }
[[ -x /usr/bin/tmux && ! -L /usr/bin/tmux ]] \
  || { printf 'private-test-tmux: real tmux binary is unavailable or symlinked\n' >&2; exit 2; }

# Inspect only tmux's global-option prefix. This catches attached and clustered
# selectors (-Sfoo, -uSfoo, -Lbar) without confusing command-local flags such
# as `capture-pane -S -100` for a global socket override.
args=("$@")
index=0
while (( index < ${#args[@]} )); do
  token="${args[index]}"
  [[ "$token" != -- ]] || break
  [[ "$token" == -* && "$token" != - ]] || break
  cluster="${token#-}"
  offset=0
  while (( offset < ${#cluster} )); do
    option="${cluster:offset:1}"
    case "$option" in
      S|L)
        printf 'private-test-tmux: caller socket selector -%s is forbidden\n' "$option" >&2
        exit 2
        ;;
      c|f|T)
        if (( offset + 1 == ${#cluster} )); then
          index=$((index + 1))
        fi
        break
        ;;
      *) ;;
    esac
    offset=$((offset + 1))
  done
  index=$((index + 1))
done

exec /usr/bin/env -u TMUX -u TMUX_PANE -u TMUX_TMPDIR /usr/bin/tmux -S "$socket" "$@"
