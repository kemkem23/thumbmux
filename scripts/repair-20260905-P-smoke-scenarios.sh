#!/usr/bin/bash -p
case "$-" in *p*) ;; *) printf 'repair P smoke scenarios: privileged interpreter is required\n' >&2; exit 126 ;; esac
PATH=/usr/bin:/bin
export PATH
unset BASH_ENV ENV CDPATH GLOBIGNORE NODE_OPTIONS BUN_OPTIONS NODE_PATH \
  PYTHONPATH PYTHONHOME PYTHONSTARTUP LD_PRELOAD LD_LIBRARY_PATH \
  TMUX TMUX_PANE TMUX_TMPDIR CORTEX_INSTANCE_ID
set -euo pipefail

SCRIPT_FILE="$(/usr/bin/realpath -e -- "${BASH_SOURCE[0]}")"
SCRIPT_DIR="$(/usr/bin/dirname -- "$SCRIPT_FILE")"
PACKAGE_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"
SMOKE="$SCRIPT_DIR/smoke-git-dist.sh"
ARTIFACT_ROOT="${RUNNER_TEMP-}/repair-20260905-P-smoke"

[[ "${GITHUB_ACTIONS-}" == true && "${CI-}" == true \
  && "${RUNNER_ENVIRONMENT-}" == github-hosted \
  && "${GITHUB_REPOSITORY-}" == kemkem23/thumbmux \
  && "${RUNNER_TEMP-}" == /home/runner/work/_temp \
  && "$PACKAGE_ROOT" == /home/runner/work/*/* ]] \
  || { echo 'repair P smoke scenarios: INCOMPLETE — requires attested public GitHub CI' >&2; exit 2; }
/usr/bin/install -d -m 0700 "$ARTIFACT_ROOT"

assert_cleanup() {
  local run_id="$1"
  local containers images
  containers="$(/usr/bin/docker ps -aq \
    --filter "label=com.kemcortex.thumbmux.run-id=$run_id")"
  images="$(/usr/bin/docker images -q "thumbmux-node18-prereqs-$run_id")"
  [[ -z "$containers" && -z "$images" ]] || {
    echo "repair P smoke scenarios: cleanup failed run-id=$run_id containers=${containers:-0} images=${images:-0}" >&2
    return 1
  }
  echo "repair P smoke scenarios: cleanup run-id=$run_id containers=0 images=0"
}

run_failure() {
  local log="$ARTIFACT_ROOT/failure.log"
  local rc run_id
  set +e
  THUMBMUX_SMOKE_TEST_MODE=fail-after-prereq "$SMOKE" >"$log" 2>&1
  rc=$?
  set -e
  /usr/bin/cat "$log"
  [[ "$rc" == 86 ]] || { echo "repair P smoke scenarios: failure rc=$rc expected=86" >&2; return 1; }
  /usr/bin/grep -Fq 'fault-ready phase=after-prereq action=fail rc=86' "$log"
  run_id="$(/usr/bin/sed -n 's/.*run-id=\([^ ]*\).*/\1/p' "$log" | /usr/bin/head -1)"
  [[ "$run_id" =~ ^[a-z0-9-]+$ ]]
  assert_cleanup "$run_id"
  echo 'repair P smoke scenarios: scenario=failure phase=after-prereq rc=86 cleanup=PASS'
}

run_term() {
  local log="$ARTIFACT_ROOT/term.log"
  local pid rc run_id attempt
  THUMBMUX_SMOKE_TEST_MODE=term-after-prereq "$SMOKE" >"$log" 2>&1 &
  pid=$!
  for ((attempt = 0; attempt < 1200; attempt++)); do
    /usr/bin/grep -Fq 'fault-ready phase=after-prereq action=wait-for-TERM' "$log" 2>/dev/null && break
    /usr/bin/kill -0 "$pid" 2>/dev/null || break
    /usr/bin/sleep 0.1
  done
  if ! /usr/bin/grep -Fq 'fault-ready phase=after-prereq action=wait-for-TERM' "$log"; then
    /usr/bin/cat "$log"
    echo 'repair P smoke scenarios: TERM case never reached the intended phase' >&2
    return 1
  fi
  /usr/bin/kill -TERM "$pid"
  set +e
  wait "$pid"
  rc=$?
  set -e
  /usr/bin/cat "$log"
  [[ "$rc" == 143 ]] || { echo "repair P smoke scenarios: TERM rc=$rc expected=143" >&2; return 1; }
  run_id="$(/usr/bin/sed -n 's/.*run-id=\([^ ]*\).*/\1/p' "$log" | /usr/bin/head -1)"
  [[ "$run_id" =~ ^[a-z0-9-]+$ ]]
  assert_cleanup "$run_id"
  echo 'repair P smoke scenarios: scenario=TERM phase=after-prereq rc=143 cleanup=PASS'
}

run_failure
run_term
echo "repair P smoke scenarios: scenarios=2/2 cleanup=2/2 artifact-root=$ARTIFACT_ROOT"
