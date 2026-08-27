#!/usr/bin/bash -p
# shellcheck shell=bash

case "$-" in
  *p*) ;;
  *)
    printf 'thumbmux test isolation: privileged interpreter is required\n' >&2
    return 126 2>/dev/null || exit 126
    ;;
esac
: "${THUMBMUX_ENTRY_CALLER_PATH:=${PATH-}}"
PATH=/usr/bin:/bin
export PATH THUMBMUX_ENTRY_CALLER_PATH
unset BASH_ENV ENV CDPATH GLOBIGNORE NODE_OPTIONS BUN_OPTIONS NODE_PATH \
  PYTHONPATH PYTHONHOME PYTHONSTARTUP LD_PRELOAD LD_LIBRARY_PATH \
  GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY \
  GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_CONFIG_GLOBAL GIT_CONFIG_SYSTEM \
  GIT_CONFIG_NOSYSTEM GIT_CONFIG_COUNT 2>/dev/null || :

# Shared fail-closed admission gate for package checks that need Docker,
# network installs, a real browser, or a real tmux. This is a fail-closed
# disposable-runner heuristic plus exact filesystem/daemon receipts; it is not
# cryptographic GitHub provenance. Docker lifecycle is admitted only on the
# public repository's GitHub-hosted disposable VM. A local monorepo run must already be inside the
# canonical hard sandbox; that sandbox deliberately has no Docker/network, so
# the dangerous lane reports INCOMPLETE without opening either capability.

thumbmux_guard_error() {
  printf 'thumbmux test isolation: %s\n' "$*" >&2
  return 1
}

thumbmux_stat_identity() {
  /usr/bin/stat -Lc '%d:%i:%u:%a' -- "$1" 2>/dev/null || true
}

thumbmux_receipt_identity() {
  /usr/bin/stat -Lc '%d:%i:%u' -- "$1" 2>/dev/null || true
}

thumbmux_guard_git() {
  /usr/bin/env -i PATH=/usr/bin:/bin HOME=/nonexistent \
    GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null \
    GIT_TERMINAL_PROMPT=0 GIT_ATTR_NOSYSTEM=1 \
    /usr/bin/git -c core.fsmonitor=false -c core.hooksPath=/dev/null "$@"
}

thumbmux_assert_clean_checkout() {
  local checkout="${1:?checkout is required}"
  local expected_sha="${2:?expected sha is required}"
  local head tree untracked
  head="$(thumbmux_guard_git -C "$checkout" rev-parse HEAD 2>/dev/null || true)"
  tree="$(thumbmux_guard_git -C "$checkout" rev-parse HEAD^{tree} 2>/dev/null || true)"
  untracked="$(thumbmux_guard_git -C "$checkout" ls-files --others --exclude-standard 2>/dev/null || true)"
  [[ "$head" == "$expected_sha" && "$tree" =~ ^[0-9a-f]{40,64}$ \
    && -z "$untracked" ]] \
    || { thumbmux_guard_error 'public checkout is not the clean exact requested commit'; return 1; }
  thumbmux_guard_git -C "$checkout" diff --quiet --no-ext-diff -- \
    && thumbmux_guard_git -C "$checkout" diff --cached --quiet --no-ext-diff -- \
    || { thumbmux_guard_error 'public checkout has tracked or staged changes'; return 1; }
  THUMBMUX_GUARD_SOURCE_SHA="$head"
  THUMBMUX_GUARD_SOURCE_TREE="$tree"
}

thumbmux_mount_inventory() {
  local runtime="${1:?runtime is required}"
  /usr/bin/awk -v root="$runtime" '$5 == root || index($5, root "/") == 1 { print }' \
    /proc/self/mountinfo
}

thumbmux_assert_final_receipt_file() {
  local receipt="${1:?receipt is required}"
  local expected_scope="${2-}"
  local expected_run_id="${3-}"
  local last_byte observed_identity
  local -a lines=()
  [[ -f "$receipt" && ! -L "$receipt" \
    && "$(/usr/bin/stat -Lc '%u:%a' -- "$receipt" 2>/dev/null || true)" == "$(id -u):600" ]] \
    || return 1
  observed_identity="$(thumbmux_receipt_identity "$receipt")"
  mapfile -t lines < "$receipt"
  last_byte="$(/usr/bin/tail -c 1 -- "$receipt" 2>/dev/null \
    | /usr/bin/od -An -tx1 | /usr/bin/tr -d ' \n')"
  [[ "${#lines[@]}" == 14 \
    && "$last_byte" == 0a \
    && "${lines[0]}" == version=2 \
    && "${lines[1]}" =~ ^provider=github-hosted(-frozen-export)?$ \
    && "${lines[2]}" == checkout=/* \
    && "${lines[3]}" =~ ^git-sha=[0-9a-f]{40}$ \
    && "${lines[4]}" =~ ^git-tree=[0-9a-f]{40,64}$ \
    && "${lines[5]}" =~ ^checkout-identity=[0-9]+:[0-9]+:[0-9]+:[0-7]{3,4}$ \
    && "${lines[6]}" =~ ^runtime-identity=[0-9]+:[0-9]+:[0-9]+:700$ \
    && "${lines[7]}" =~ ^receipt-identity=[0-9]+:[0-9]+:[0-9]+$ \
    && "${lines[8]}" == docker-host=unix:///var/run/docker.sock \
    && "${lines[9]}" =~ ^docker-id=[A-Za-z0-9:._-]{8,128}$ \
    && "${lines[10]}" == docker-root=/var/lib/docker \
    && "${lines[11]}" =~ ^docker-socket-identity=[0-9]+:[0-9]+:[0-9]+:[0-7]{3,4}$ \
    && "${lines[12]}" =~ ^scope=[a-z][a-z0-9-]*$ \
    && "${lines[13]}" =~ ^run-id=[a-f0-9]{32}$ ]] || return 1
  [[ -z "$expected_scope" || "${lines[12]}" == "scope=${expected_scope}" ]] || return 1
  [[ -z "$expected_run_id" || "${lines[13]}" == "run-id=${expected_run_id}" ]] || return 1
  [[ -f "$receipt" && ! -L "$receipt" \
    && "$observed_identity" == "$(thumbmux_receipt_identity "$receipt")" \
    && "${lines[6]}" == "runtime-identity=$(thumbmux_stat_identity "$(dirname -- "$receipt")")" \
    && "${lines[7]}" == "receipt-identity=${observed_identity}" ]] || return 1
}

thumbmux_restore_attested_tool_path() {
  local candidate real owner
  [[ "${THUMBMUX_GUARD_PROVIDER-}" == github-hosted \
    || "${THUMBMUX_GUARD_PROVIDER-}" == github-hosted-frozen-export ]] \
    || { thumbmux_guard_error 'runner tool path cannot be restored before public admission'; return 1; }
  PATH="${THUMBMUX_ENTRY_CALLER_PATH-}"
  candidate="$(command -v bun 2>/dev/null || true)"
  real="$(/usr/bin/realpath -e -- "$candidate" 2>/dev/null || true)"
  case "$real" in
    /opt/hostedtoolcache/bun/*/x64/bun|/home/runner/setup-bun/bin/bun|/home/runner/.bun/bin/bun) ;;
    *) PATH=/usr/bin:/bin; export PATH; thumbmux_guard_error 'attested GitHub Bun binary path is unavailable'; return 1 ;;
  esac
  owner="$(/usr/bin/stat -Lc '%u:%a:%F' -- "$real" 2>/dev/null || true)"
  [[ "$owner" =~ ^(0|$(id -u)):[0-7]{3,4}:regular\ file$ && -x "$real" && ! -L "$real" ]] \
    || { PATH=/usr/bin:/bin; export PATH; thumbmux_guard_error 'attested GitHub Bun binary identity is unsafe'; return 1; }
  THUMBMUX_GUARD_BUN_BIN="$real"
  # Keep fixed host utilities ahead of the one admitted runner tool. Callers
  # execute Bun through THUMBMUX_GUARD_BUN_BIN when its exact identity matters.
  PATH="/usr/bin:/bin:$(/usr/bin/dirname -- "$real")"
  export PATH THUMBMUX_GUARD_BUN_BIN
}

thumbmux_make_run_id() {
  local run_id
  run_id="$(/usr/bin/od -An -N16 -tx1 /dev/urandom | /usr/bin/tr -d ' \n')"
  [[ "$run_id" =~ ^[a-f0-9]{32}$ ]] \
    || { thumbmux_guard_error 'could not create a strong random run id'; return 1; }
  printf '%s\n' "$run_id"
}

thumbmux_assert_command_sandbox_abi_v2() {
  local expected_runtime="${1:?expected command runtime is required}"
  local runtime="${CORTEX_TEST_RUNTIME-}"
  local attestation="${CORTEX_TEST_SANDBOX_ATTESTATION-}"
  local identity=""
  local -a lines=()

  [[ "${CORTEX_TEST_HARD_SANDBOX-}" == command \
    && "$expected_runtime" == /run/kemcortex-isolated-command \
    && "$runtime" == "$expected_runtime" \
    && "$attestation" == "$runtime/sandbox-attestation" \
    && -f "$attestation" && ! -L "$attestation" ]] \
    || { thumbmux_guard_error 'INCOMPLETE — command sandbox ABI v2 runtime/attestation path is missing'; return 1; }
  identity="$(/usr/bin/stat -Lc '%u:%a' -- "$attestation" 2>/dev/null || true)"
  [[ "$identity" == "$(id -u):600" ]] \
    || { thumbmux_guard_error 'INCOMPLETE — command sandbox ABI v2 attestation ownership/mode is unsafe'; return 1; }

  mapfile -t lines < "$attestation"
  [[ "${#lines[@]}" == 8 ]] \
    || { thumbmux_guard_error 'INCOMPLETE — command sandbox attestation is not exact ordered ABI v2'; return 1; }
  [[ "${lines[0]}" == 'version=2' \
    && "${lines[1]}" == 'kind=command' \
    && "${lines[2]}" =~ ^host-netns=net:\[[0-9]+\]$ \
    && "${lines[3]}" =~ ^host-mntns=mnt:\[[0-9]+\]$ \
    && "${lines[4]}" =~ ^host-pidns=pid:\[[0-9]+\]$ \
    && "${lines[5]}" =~ ^host-ipcns=ipc:\[[0-9]+\]$ \
    && "${lines[6]}" =~ ^source-head=[0-9a-f]{40,64}$ \
    && "${lines[7]}" =~ ^source-tree=[0-9a-f]{40,64}$ ]] \
    || { thumbmux_guard_error 'INCOMPLETE — command sandbox attestation is not exact ordered ABI v2'; return 1; }
}

thumbmux_refuse_local_dangerous_lane() {
  local package_real="${1:?package root is required}"
  local repo_root verifier runtime

  if [[ "${CORTEX_TEST_HARD_SANDBOX-}" == command ]]; then
    thumbmux_assert_command_sandbox_abi_v2 /run/kemcortex-isolated-command \
      || return 1
    repo_root="$(thumbmux_guard_git -C "$package_real" rev-parse --show-toplevel 2>/dev/null || true)"
    verifier="$repo_root/ops/testing/assert-hard-test-sandbox.sh"
    runtime="${CORTEX_TEST_RUNTIME-}"
    [[ -n "$repo_root" && -f "$verifier" && ! -L "$verifier" \
      && "$runtime" == /run/kemcortex-isolated-command ]] \
      || { thumbmux_guard_error 'INCOMPLETE — local hard-sandbox attestation is unavailable'; return 1; }
    # shellcheck source=/dev/null
    . "$verifier"
    assert_hard_test_sandbox command "$runtime" \
      || { thumbmux_guard_error 'INCOMPLETE — local hard-sandbox attestation failed'; return 1; }
    thumbmux_guard_error \
      'INCOMPLETE — Docker/network lifecycle stays disabled inside ops/testing/run-isolated-command.sh; use the attested public GitHub-hosted CI lane'
    return 1
  fi

  thumbmux_guard_error \
    'INCOMPLETE — local dangerous tests must enter ops/testing/run-isolated-command.sh; Docker lifecycle is restricted to attested public GitHub-hosted CI'
}

thumbmux_assert_public_markers() {
  local workspace_real runner_temp_real
  [[ "${CI-}" == true \
    && "${GITHUB_ACTIONS-}" == true \
    && "${RUNNER_ENVIRONMENT-}" == github-hosted \
    && "${GITHUB_REPOSITORY-}" == kemkem23/thumbmux \
    && "${GITHUB_RUN_ID-}" =~ ^[0-9]+$ \
    && "${GITHUB_RUN_ATTEMPT-}" =~ ^[0-9]+$ \
    && "${GITHUB_SHA-}" =~ ^[a-f0-9]{40}$ \
    && "$(id -un)" == runner \
    && "$(id -u)" != 0 ]] || return 1
  workspace_real="$(/usr/bin/realpath -e -- "${GITHUB_WORKSPACE-}" 2>/dev/null || true)"
  runner_temp_real="$(/usr/bin/realpath -e -- "${RUNNER_TEMP-}" 2>/dev/null || true)"
  [[ "$workspace_real" == /home/runner/work/*/* \
    && "$runner_temp_real" == /home/runner/work/_temp \
    && "$(/usr/bin/stat -Lc '%u' -- "$workspace_real" 2>/dev/null || true)" == "$(id -u)" \
    && "$(/usr/bin/stat -Lc '%u' -- "$runner_temp_real" 2>/dev/null || true)" == "$(id -u)" ]]
}

thumbmux_assert_frozen_public_export() {
  local package_real="${1:?package root is required}"
  local parent_receipt parent_runtime export_real workspace_real
  local -a lines=()
  parent_receipt="$(/usr/bin/realpath -e -- "${THUMBMUX_PUBLIC_EXPORT_ATTESTATION-}" 2>/dev/null || true)"
  parent_runtime="$(dirname -- "$parent_receipt")"
  export_real="$(/usr/bin/realpath -e -- "${THUMBMUX_PUBLIC_EXPORT_ROOT-}" 2>/dev/null || true)"
  workspace_real="$(/usr/bin/realpath -e -- "${GITHUB_WORKSPACE-}" 2>/dev/null || true)"
  [[ "$package_real" == "$export_real" \
    && "$export_real" == "$parent_runtime/export" \
    && "$parent_receipt" =~ ^/home/runner/work/_temp/thumbmux-ci-parity\.[A-Za-z0-9]{8}/runtime-attestation$ \
    && "${THUMBMUX_PUBLIC_EXPORT_PARENT_IDENTITY-}" == "$(thumbmux_stat_identity "$parent_runtime")" ]] \
    || return 1
  thumbmux_assert_final_receipt_file "$parent_receipt" ci-parity || return 1
  mapfile -t lines < "$parent_receipt"
  [[ "${lines[1]}" == provider=github-hosted \
    && "${lines[2]}" == "checkout=${workspace_real}" \
    && "${lines[3]}" == "git-sha=${GITHUB_SHA}" \
    && "${lines[5]}" == "checkout-identity=$(thumbmux_stat_identity "$workspace_real")" ]] \
    || return 1
  [[ "$(thumbmux_guard_git -C "$export_real" rev-list --count HEAD 2>/dev/null || true)" == 1 \
    && -z "$(thumbmux_guard_git -C "$export_real" remote 2>/dev/null || true)" \
    && "$(thumbmux_guard_git -C "$export_real" rev-parse HEAD^{tree} 2>/dev/null || true)" == "${lines[4]#git-tree=}" \
    && -z "$(thumbmux_guard_git -C "$export_real" ls-files --others --exclude-standard 2>/dev/null || true)" ]] \
    || return 1
  thumbmux_guard_git -C "$export_real" diff --quiet --no-ext-diff -- \
    && thumbmux_guard_git -C "$export_real" diff --cached --quiet --no-ext-diff -- \
    || return 1
  THUMBMUX_GUARD_SOURCE_SHA="$GITHUB_SHA"
  THUMBMUX_GUARD_SOURCE_TREE="${lines[4]#git-tree=}"
}

thumbmux_prepare_test_runtime() {
  local scope="${1:?scope is required}"
  local package_root="${2:?package root is required}"
  local package_real workspace_real runner_temp_real git_head git_tree
  local docker_host_value docker_root docker_id docker_endpoint
  local runtime_parent

  [[ "$scope" =~ ^[a-z][a-z0-9-]*$ ]] \
    || { thumbmux_guard_error 'invalid test scope'; return 1; }
  package_real="$(/usr/bin/realpath -e -- "$package_root" 2>/dev/null || true)"
  [[ -n "$package_real" && -d "$package_real" && ! -L "$package_root" ]] \
    || { thumbmux_guard_error 'package checkout is unavailable or symlinked'; return 1; }
  [[ -x /usr/bin/git && ! -L /usr/bin/git ]] \
    || { thumbmux_guard_error 'fixed Git binary is required to attest the checkout'; return 1; }

  THUMBMUX_GUARD_PROVIDER=''
  THUMBMUX_GUARD_DOCKER_HOST=''
  THUMBMUX_GUARD_DOCKER_ID=''
  THUMBMUX_GUARD_DOCKER_ROOT=''
  THUMBMUX_GUARD_DOCKER_SOCKET_IDENTITY=''
  THUMBMUX_GUARD_RUNTIME_IDENTITY=''
  THUMBMUX_GUARD_ATTESTATION_IDENTITY=''
  THUMBMUX_GUARD_CHECKOUT_IDENTITY=''
  THUMBMUX_GUARD_CHECKOUT=''
  THUMBMUX_GUARD_RUNTIME_PARENT_IDENTITY=''
  THUMBMUX_GUARD_MOUNT_INVENTORY=''
  THUMBMUX_GUARD_SCOPE=''
  THUMBMUX_GUARD_RUN_ID=''
  THUMBMUX_GUARD_RUNTIME_SCOPE="$scope"

  if thumbmux_assert_public_markers; then
    workspace_real="$(/usr/bin/realpath -e -- "${GITHUB_WORKSPACE-}")"
    runner_temp_real="$(/usr/bin/realpath -e -- "${RUNNER_TEMP-}")"
    if [[ "$package_real" == "$workspace_real" ]]; then
      thumbmux_assert_clean_checkout "$package_real" "$GITHUB_SHA" || return 1
      THUMBMUX_GUARD_PROVIDER=github-hosted
    elif thumbmux_assert_frozen_public_export "$package_real"; then
      THUMBMUX_GUARD_PROVIDER=github-hosted-frozen-export
    else
      thumbmux_guard_error 'GitHub checkout is neither the clean primary commit nor its attested frozen export'
      return 1
    fi
    git_head="$THUMBMUX_GUARD_SOURCE_SHA"
    git_tree="$THUMBMUX_GUARD_SOURCE_TREE"
    [[ "$(command -v docker 2>/dev/null || true)" == /usr/bin/docker \
      && -x /usr/bin/docker && ! -L /usr/bin/docker ]] \
      || { thumbmux_guard_error 'fixed Docker CLI is required after disposable admission'; return 1; }
    [[ -z "${DOCKER_HOST-}" || "${DOCKER_HOST}" == unix:///var/run/docker.sock ]] \
      || { thumbmux_guard_error 'GitHub-hosted Docker endpoint override is forbidden'; return 1; }
    [[ -z "${DOCKER_CONTEXT-}" || "${DOCKER_CONTEXT}" == default ]] \
      || { thumbmux_guard_error 'GitHub-hosted Docker context override is forbidden'; return 1; }
    [[ -z "${DOCKER_CONFIG-}" && -z "${DOCKER_CERT_PATH-}" \
      && -z "${DOCKER_TLS_VERIFY-}" && -z "${DOCKER_API_VERSION-}" ]] \
      || { thumbmux_guard_error 'GitHub-hosted Docker configuration overrides are forbidden'; return 1; }
    [[ -S /var/run/docker.sock && ! -L /var/run/docker.sock ]] \
      || { thumbmux_guard_error 'GitHub-hosted disposable Docker socket is missing or unsafe'; return 1; }
    docker_endpoint="$(/usr/bin/docker context inspect default \
      --format '{{ (index .Endpoints "docker").Host }}' 2>/dev/null || true)"
    [[ "$docker_endpoint" == unix:///var/run/docker.sock ]] \
      || { thumbmux_guard_error 'GitHub-hosted Docker context is not the default local socket'; return 1; }
    docker_root="$(/usr/bin/docker info --format '{{.DockerRootDir}}' 2>/dev/null || true)"
    docker_id="$(/usr/bin/docker info --format '{{.ID}}' 2>/dev/null || true)"
    [[ "$docker_root" == /var/lib/docker \
      && "$docker_id" =~ ^[A-Za-z0-9:._-]{8,128}$ ]] \
      || { thumbmux_guard_error 'GitHub-hosted Docker daemon identity/root is unexpected'; return 1; }
    runtime_parent="$runner_temp_real"
    docker_host_value=unix:///var/run/docker.sock
  else
    thumbmux_refuse_local_dangerous_lane "$package_real"
    return 1
  fi

  THUMBMUX_GUARD_RUNTIME="$(/usr/bin/mktemp -d "${runtime_parent%/}/thumbmux-${scope}.XXXXXXXX")" \
    || { thumbmux_guard_error 'could not create the private test runtime'; return 1; }
  THUMBMUX_GUARD_RUNTIME_IDENTITY="$(thumbmux_stat_identity "$THUMBMUX_GUARD_RUNTIME")"
  /usr/bin/chmod 0700 "$THUMBMUX_GUARD_RUNTIME"
  THUMBMUX_GUARD_RUNTIME_IDENTITY="$(thumbmux_stat_identity "$THUMBMUX_GUARD_RUNTIME")"
  THUMBMUX_GUARD_RUNTIME_PARENT_IDENTITY="$(thumbmux_stat_identity "$runtime_parent")"
  THUMBMUX_GUARD_MOUNT_INVENTORY="$(thumbmux_mount_inventory "$THUMBMUX_GUARD_RUNTIME")"
  [[ ! -L "$THUMBMUX_GUARD_RUNTIME" \
    && "$THUMBMUX_GUARD_RUNTIME_IDENTITY" =~ ^[0-9]+:[0-9]+:$(id -u):700$ \
    && -n "$THUMBMUX_GUARD_RUNTIME_PARENT_IDENTITY" \
    && -z "$THUMBMUX_GUARD_MOUNT_INVENTORY" ]] \
    || { thumbmux_remove_test_runtime >/dev/null 2>&1 || true; thumbmux_guard_error 'test runtime ownership/mode/mount inventory is unsafe'; return 1; }
  THUMBMUX_GUARD_ATTESTATION="$THUMBMUX_GUARD_RUNTIME/runtime-attestation"
  : > "$THUMBMUX_GUARD_ATTESTATION"
  /usr/bin/chmod 0600 "$THUMBMUX_GUARD_ATTESTATION"
  THUMBMUX_GUARD_ATTESTATION_IDENTITY="$(thumbmux_receipt_identity "$THUMBMUX_GUARD_ATTESTATION")"
  THUMBMUX_GUARD_CHECKOUT_IDENTITY="$(thumbmux_stat_identity "$package_real")"
  THUMBMUX_GUARD_CHECKOUT="$package_real"
  THUMBMUX_GUARD_DOCKER_SOCKET_IDENTITY="$(thumbmux_stat_identity /var/run/docker.sock)"
  [[ "$THUMBMUX_GUARD_ATTESTATION_IDENTITY" =~ ^[0-9]+:[0-9]+:$(id -u)$ \
    && "$THUMBMUX_GUARD_CHECKOUT_IDENTITY" =~ ^[0-9]+:[0-9]+:$(id -u):[0-7]{3,4}$ \
    && "$THUMBMUX_GUARD_DOCKER_SOCKET_IDENTITY" =~ ^[0-9]+:[0-9]+:[0-9]+:[0-7]{3,4}$ ]] \
    || { thumbmux_remove_test_runtime >/dev/null 2>&1 || true; thumbmux_guard_error 'runtime receipt identities are unsafe'; return 1; }
  {
    printf 'version=2\n'
    printf 'provider=%s\n' "$THUMBMUX_GUARD_PROVIDER"
    printf 'checkout=%s\n' "$package_real"
    printf 'git-sha=%s\n' "$git_head"
    printf 'git-tree=%s\n' "$git_tree"
    printf 'checkout-identity=%s\n' "$THUMBMUX_GUARD_CHECKOUT_IDENTITY"
    printf 'runtime-identity=%s\n' "$THUMBMUX_GUARD_RUNTIME_IDENTITY"
    printf 'receipt-identity=%s\n' "$THUMBMUX_GUARD_ATTESTATION_IDENTITY"
    printf 'docker-host=%s\n' "$docker_host_value"
    printf 'docker-id=%s\n' "$docker_id"
    printf 'docker-root=%s\n' "$docker_root"
    printf 'docker-socket-identity=%s\n' "$THUMBMUX_GUARD_DOCKER_SOCKET_IDENTITY"
  } > "$THUMBMUX_GUARD_ATTESTATION"
  /usr/bin/chmod 0600 "$THUMBMUX_GUARD_ATTESTATION"
  THUMBMUX_GUARD_DOCKER_HOST="$docker_host_value"
  THUMBMUX_GUARD_DOCKER_ID="$docker_id"
  THUMBMUX_GUARD_DOCKER_ROOT="$docker_root"
  export THUMBMUX_GUARD_PROVIDER THUMBMUX_GUARD_RUNTIME \
    THUMBMUX_GUARD_ATTESTATION THUMBMUX_GUARD_DOCKER_HOST \
    THUMBMUX_GUARD_DOCKER_ID THUMBMUX_GUARD_DOCKER_ROOT \
    THUMBMUX_GUARD_DOCKER_SOCKET_IDENTITY THUMBMUX_GUARD_RUNTIME_IDENTITY \
    THUMBMUX_GUARD_ATTESTATION_IDENTITY THUMBMUX_GUARD_CHECKOUT_IDENTITY \
    THUMBMUX_GUARD_CHECKOUT THUMBMUX_GUARD_RUNTIME_PARENT_IDENTITY \
    THUMBMUX_GUARD_MOUNT_INVENTORY THUMBMUX_GUARD_RUNTIME_SCOPE \
    THUMBMUX_GUARD_SOURCE_SHA THUMBMUX_GUARD_SOURCE_TREE
  thumbmux_restore_attested_tool_path \
    || { thumbmux_remove_test_runtime >/dev/null 2>&1 || true; return 1; }
}

thumbmux_recheck_docker_attestation() {
  local socket_path current_socket current_id current_root runtime_parent
  [[ -n "${THUMBMUX_GUARD_DOCKER_ID-}" \
    && -n "${THUMBMUX_GUARD_DOCKER_ROOT-}" \
    && -n "${THUMBMUX_GUARD_DOCKER_SOCKET_IDENTITY-}" ]] \
    || { thumbmux_guard_error 'Docker attestation was not initialized'; return 1; }
  socket_path="${THUMBMUX_GUARD_DOCKER_HOST#unix://}"
  [[ "$THUMBMUX_GUARD_DOCKER_HOST" == unix:///* \
    && -S "$socket_path" && ! -L "$socket_path" ]] \
    || { thumbmux_guard_error 'attested Docker socket disappeared or became unsafe'; return 1; }
  runtime_parent="$(dirname -- "$THUMBMUX_GUARD_RUNTIME")"
  [[ "$(/usr/bin/realpath -e -- "$THUMBMUX_GUARD_RUNTIME" 2>/dev/null || true)" == "$THUMBMUX_GUARD_RUNTIME" \
    && "$(thumbmux_stat_identity "$THUMBMUX_GUARD_RUNTIME")" == "$THUMBMUX_GUARD_RUNTIME_IDENTITY" \
    && "$(thumbmux_stat_identity "$runtime_parent")" == "$THUMBMUX_GUARD_RUNTIME_PARENT_IDENTITY" \
    && "$(thumbmux_receipt_identity "$THUMBMUX_GUARD_ATTESTATION")" == "$THUMBMUX_GUARD_ATTESTATION_IDENTITY" \
    && "$(thumbmux_stat_identity "${THUMBMUX_GUARD_ATTESTATION%/*}")" == "$THUMBMUX_GUARD_RUNTIME_IDENTITY" \
    && "$(thumbmux_mount_inventory "$THUMBMUX_GUARD_RUNTIME")" == "$THUMBMUX_GUARD_MOUNT_INVENTORY" ]] \
    || { thumbmux_guard_error 'runtime/receipt inode identity changed during the run'; return 1; }
  thumbmux_assert_final_receipt_file "$THUMBMUX_GUARD_ATTESTATION" \
    "$THUMBMUX_GUARD_SCOPE" "$THUMBMUX_GUARD_RUN_ID" \
    || { thumbmux_guard_error 'runtime receipt schema changed during the run'; return 1; }
  [[ "$(thumbmux_stat_identity "${THUMBMUX_GUARD_CHECKOUT-}")" == "$THUMBMUX_GUARD_CHECKOUT_IDENTITY" ]] \
    || { thumbmux_guard_error 'attested checkout inode changed during the run'; return 1; }
  case "$THUMBMUX_GUARD_PROVIDER" in
    github-hosted)
      thumbmux_assert_clean_checkout "$THUMBMUX_GUARD_CHECKOUT" "$THUMBMUX_GUARD_SOURCE_SHA" \
        || return 1
      ;;
    github-hosted-frozen-export)
      thumbmux_assert_frozen_public_export "$THUMBMUX_GUARD_CHECKOUT" \
        || { thumbmux_guard_error 'frozen export changed during the run'; return 1; }
      ;;
    *)
      thumbmux_guard_error 'runtime provider changed during the run'
      return 1
      ;;
  esac
  current_socket="$(thumbmux_stat_identity "$socket_path")"
  [[ "$current_socket" == "$THUMBMUX_GUARD_DOCKER_SOCKET_IDENTITY" ]] \
    || { thumbmux_guard_error 'Docker socket identity changed during the run'; return 1; }
  current_id="$(/usr/bin/docker info --format '{{.ID}}' 2>/dev/null || true)"
  current_root="$(/usr/bin/docker info --format '{{.DockerRootDir}}' 2>/dev/null || true)"
  [[ "$current_id" == "$THUMBMUX_GUARD_DOCKER_ID" \
    && "$current_root" == "$THUMBMUX_GUARD_DOCKER_ROOT" ]] \
    || { thumbmux_guard_error 'Docker daemon identity/data root changed during the run'; return 1; }
}

thumbmux_emit_frozen_source_archive() {
  local archive_ref current_head current_tree
  [[ -n "${THUMBMUX_GUARD_CHECKOUT-}" \
    && "$(thumbmux_stat_identity "$THUMBMUX_GUARD_CHECKOUT")" == "$THUMBMUX_GUARD_CHECKOUT_IDENTITY" ]] \
    || { thumbmux_guard_error 'attested checkout identity changed before source export'; return 1; }
  current_head="$(thumbmux_guard_git -C "$THUMBMUX_GUARD_CHECKOUT" rev-parse HEAD 2>/dev/null || true)"
  current_tree="$(thumbmux_guard_git -C "$THUMBMUX_GUARD_CHECKOUT" rev-parse HEAD^{tree} 2>/dev/null || true)"
  [[ "$current_tree" == "$THUMBMUX_GUARD_SOURCE_TREE" ]] \
    || { thumbmux_guard_error 'attested source tree changed before source export'; return 1; }
  case "$THUMBMUX_GUARD_PROVIDER" in
    github-hosted)
      [[ "$current_head" == "$THUMBMUX_GUARD_SOURCE_SHA" ]] \
        || { thumbmux_guard_error 'primary checkout commit changed before source export'; return 1; }
      thumbmux_assert_clean_checkout "$THUMBMUX_GUARD_CHECKOUT" "$THUMBMUX_GUARD_SOURCE_SHA" \
        || return 1
      archive_ref="$THUMBMUX_GUARD_SOURCE_SHA"
      ;;
    github-hosted-frozen-export)
      thumbmux_assert_frozen_public_export "$THUMBMUX_GUARD_CHECKOUT" \
        || { thumbmux_guard_error 'frozen export attestation changed before source export'; return 1; }
      archive_ref=HEAD
      ;;
    *)
      thumbmux_guard_error 'source archive is unavailable outside an admitted disposable lane'
      return 1
      ;;
  esac
  thumbmux_guard_git -C "$THUMBMUX_GUARD_CHECKOUT" archive --format=tar "$archive_ref"
}

thumbmux_bind_run_attestation() {
  local run_id="${1:?run id is required}"
  local scope="${2:?scope is required}"
  local receipt_identity_before
  local -a lines=()
  [[ "$run_id" =~ ^[a-f0-9]{32}$ && "$scope" =~ ^[a-z][a-z0-9-]*$ \
    && -f "${THUMBMUX_GUARD_ATTESTATION-}" \
    && ! -L "${THUMBMUX_GUARD_ATTESTATION-}" \
    && "$(/usr/bin/stat -Lc '%u:%a' -- "$THUMBMUX_GUARD_ATTESTATION" 2>/dev/null || true)" == "$(id -u):600" \
    && "$(thumbmux_receipt_identity "$THUMBMUX_GUARD_ATTESTATION")" == "$THUMBMUX_GUARD_ATTESTATION_IDENTITY" ]] \
    || { thumbmux_guard_error 'cannot bind an unsafe run attestation'; return 1; }
  receipt_identity_before="$(thumbmux_receipt_identity "$THUMBMUX_GUARD_ATTESTATION")"
  mapfile -t lines < "$THUMBMUX_GUARD_ATTESTATION"
  [[ "${#lines[@]}" == 12 \
    && "${lines[0]}" == version=2 \
    && "${lines[1]}" == "provider=${THUMBMUX_GUARD_PROVIDER}" \
    && "${lines[2]}" == "checkout=${THUMBMUX_GUARD_CHECKOUT}" \
    && "${lines[3]}" == "git-sha=${THUMBMUX_GUARD_SOURCE_SHA}" \
    && "${lines[4]}" == "git-tree=${THUMBMUX_GUARD_SOURCE_TREE}" \
    && "${lines[5]}" == "checkout-identity=${THUMBMUX_GUARD_CHECKOUT_IDENTITY}" \
    && "${lines[6]}" == "runtime-identity=${THUMBMUX_GUARD_RUNTIME_IDENTITY}" \
    && "${lines[7]}" == "receipt-identity=${THUMBMUX_GUARD_ATTESTATION_IDENTITY}" \
    && "${lines[8]}" == "docker-host=${THUMBMUX_GUARD_DOCKER_HOST}" \
    && "${lines[9]}" == "docker-id=${THUMBMUX_GUARD_DOCKER_ID}" \
    && "${lines[10]}" == "docker-root=${THUMBMUX_GUARD_DOCKER_ROOT}" \
    && "${lines[11]}" == "docker-socket-identity=${THUMBMUX_GUARD_DOCKER_SOCKET_IDENTITY}" ]] \
    || { thumbmux_guard_error 'cannot bind a non-exact base receipt'; return 1; }
  printf 'scope=%s\nrun-id=%s\n' "$scope" "$run_id" >> "$THUMBMUX_GUARD_ATTESTATION"
  [[ -f "$THUMBMUX_GUARD_ATTESTATION" && ! -L "$THUMBMUX_GUARD_ATTESTATION" \
    && "$receipt_identity_before" == "$(thumbmux_receipt_identity "$THUMBMUX_GUARD_ATTESTATION")" ]] \
    || { thumbmux_guard_error 'runtime receipt inode changed while binding the run'; return 1; }
  THUMBMUX_GUARD_SCOPE="$scope"
  THUMBMUX_GUARD_RUN_ID="$run_id"
  export THUMBMUX_GUARD_SCOPE THUMBMUX_GUARD_RUN_ID
  thumbmux_assert_final_receipt_file "$THUMBMUX_GUARD_ATTESTATION" "$scope" "$run_id" \
    || { thumbmux_guard_error 'bound runtime receipt failed exact-schema validation'; return 1; }
}

thumbmux_remove_test_runtime() {
  local runtime="${THUMBMUX_GUARD_RUNTIME-}"
  local runtime_real runtime_parent mount_inventory
  [[ "${THUMBMUX_GUARD_RUNTIME_SCOPE-}" =~ ^[a-z][a-z0-9-]*$ \
    && "$runtime" =~ ^/home/runner/work/_temp/thumbmux-${THUMBMUX_GUARD_RUNTIME_SCOPE}\.[A-Za-z0-9]{8}$ ]] \
    || { thumbmux_guard_error 'refusing to remove an unexpected runtime path'; return 1; }
  runtime_real="$(/usr/bin/realpath -e -- "$runtime" 2>/dev/null || true)"
  runtime_parent="$(dirname -- "$runtime")"
  [[ -d "$runtime" && ! -L "$runtime" && "$runtime_real" == "$runtime" \
    && -n "${THUMBMUX_GUARD_RUNTIME_IDENTITY-}" \
    && "$(thumbmux_stat_identity "$runtime")" == "$THUMBMUX_GUARD_RUNTIME_IDENTITY" \
    && "$(thumbmux_stat_identity "$runtime_parent")" == "${THUMBMUX_GUARD_RUNTIME_PARENT_IDENTITY-}" \
    && "$THUMBMUX_GUARD_RUNTIME_IDENTITY" =~ ^[0-9]+:[0-9]+:$(id -u):700$ ]] \
    || { thumbmux_guard_error 'refusing to remove a changed runtime directory'; return 1; }
  mount_inventory="$(thumbmux_mount_inventory "$runtime")"
  [[ "$mount_inventory" == "${THUMBMUX_GUARD_MOUNT_INVENTORY-}" && -z "$mount_inventory" ]] \
    || { thumbmux_guard_error 'refusing to remove a runtime whose mount inventory changed'; return 1; }
  /usr/bin/rm -rf --one-file-system -- "$runtime"
  [[ ! -e "$runtime" && ! -L "$runtime" ]] \
    || { thumbmux_guard_error 'runtime survived exact cleanup'; return 1; }
}
