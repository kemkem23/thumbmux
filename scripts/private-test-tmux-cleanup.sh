#!/usr/bin/env bash

# Shared fail-closed cleanup for the root and browser isolation runners.
# This file is sourced; it intentionally does not change the caller's shell
# options or install traps.

_cortex_private_tmux_is_no_server() {
  local message="${1-}"
  local socket="${2-}"
  [[ "$message" == "no server running on ${socket}" \
    || "$message" == "error connecting to ${socket} (No such file or directory)" \
    || "$message" == "error connecting to ${socket} (Connection refused)" ]]
}

_CORTEX_PRIVATE_TMUX_PROBE_OUTPUT=""
_CORTEX_PRIVATE_TMUX_PROBE_PID=""

_cortex_private_tmux_probe() {
  local tmux_bin="$1"
  local socket="$2"
  local tmux_root="$3"
  local output=""

  _CORTEX_PRIVATE_TMUX_PROBE_OUTPUT=""
  _CORTEX_PRIVATE_TMUX_PROBE_PID=""
  if output="$(env -u TMUX -u TMUX_PANE \
    TMUX_TMPDIR="$tmux_root" LC_ALL=C \
    "$tmux_bin" -S "$socket" display-message -p '#{pid}' 2>&1)"; then
    if [[ ! "$output" =~ ^[1-9][0-9]{0,9}$ ]] || (( 10#$output <= 1 )); then
      _CORTEX_PRIVATE_TMUX_PROBE_OUTPUT="$output"
      return 1
    fi
    _CORTEX_PRIVATE_TMUX_PROBE_PID="$output"
    return 0
  fi

  _CORTEX_PRIVATE_TMUX_PROBE_OUTPUT="$output"
  if _cortex_private_tmux_is_no_server "$output" "$socket"; then
    return 3
  fi
  return 1
}

_cortex_private_tmux_directory_matches() {
  local path="$1"
  local expected_identity="$2"

  [[ -d "$path" && ! -L "$path" ]] \
    && [[ "$(stat -Lc '%d:%i:%u:%a' -- "$path" 2>/dev/null || true)" \
      == "$expected_identity" ]]
}

_cortex_private_tmux_socket_matches() {
  local path="$1"
  local expected_identity="$2"

  [[ -S "$path" && ! -L "$path" ]] \
    && [[ "$(stat -Lc '%d:%i:%u' -- "$path" 2>/dev/null || true)" \
      == "$expected_identity" ]]
}

# A same-UID process can replace a pathname between stat(2) and rename(2);
# Linux has no rename-if-source-inode primitive. If that residual private-root
# race is detected after quarantine, put the unexpected socket back at the
# public name with no-copy/no-clobber semantics. This recovery path does not
# intentionally stop/remove that lifecycle and returns failure to its caller.
_cortex_private_tmux_restore_unexpected_socket() {
  local socket="$1"
  local tmux_root="$2"
  local socket_parent="$3"
  local current_uid="$4"
  local root_identity="$5"
  local parent_identity="$6"
  local quarantine_dir="$7"
  local quarantine_identity="$8"
  local quarantine_socket="$9"
  local unexpected_identity="${10}"

  if [[ ! "$unexpected_identity" =~ ^[0-9]+:[0-9]+:[0-9]+$ ]] \
    || [[ "${unexpected_identity##*:}" != "$current_uid" ]] \
    || [[ -e "$socket" || -L "$socket" ]] \
    || ! _cortex_private_tmux_directory_matches "$tmux_root" "$root_identity" \
    || ! _cortex_private_tmux_directory_matches "$socket_parent" "$parent_identity" \
    || ! _cortex_private_tmux_directory_matches "$quarantine_dir" "$quarantine_identity" \
    || ! _cortex_private_tmux_socket_matches \
      "$quarantine_socket" "$unexpected_identity"; then
    printf 'private-tmux-cleanup: cannot safely restore unexpected quarantined socket: %s\n' \
      "$quarantine_socket" >&2
    return 1
  fi

  if ! /usr/bin/mv --no-copy -n -T -- \
    "$quarantine_socket" "$socket"; then
    printf 'private-tmux-cleanup: exact unexpected-socket restore failed: %s\n' \
      "$quarantine_socket" >&2
    return 1
  fi
  if [[ -e "$quarantine_socket" || -L "$quarantine_socket" ]] \
    || ! _cortex_private_tmux_socket_matches "$socket" "$unexpected_identity" \
    || ! _cortex_private_tmux_directory_matches "$tmux_root" "$root_identity" \
    || ! _cortex_private_tmux_directory_matches "$socket_parent" "$parent_identity" \
    || ! _cortex_private_tmux_directory_matches "$quarantine_dir" "$quarantine_identity"; then
    printf 'private-tmux-cleanup: unexpected socket was not restored exactly; preserving root: %s\n' \
      "$socket" >&2
    return 1
  fi
  if ! /usr/bin/rmdir -- "$quarantine_dir"; then
    printf 'private-tmux-cleanup: restored unexpected socket but quarantine stayed nonempty: %s\n' \
      "$quarantine_dir" >&2
    return 1
  fi
  printf 'private-tmux-cleanup: restored unexpected same-path socket and refused cleanup: %s identity=%s\n' \
    "$socket" "$unexpected_identity" >&2
  return 1
}

# Remove a protocol-proven stale socket without ever unlinking through the
# reusable public pathname. The exact inode is first atomically renamed into a
# newly-created owner-only directory on the same filesystem. Both the public
# and quarantined names are then probed before and after unlink. Within the
# cooperative runner boundary below, a replacement at the public pathname is
# detected and cleanup fails without intentionally stopping/removing it.
#
# Threat boundary: each runner allocates this owner-0700 root for one case and
# invokes cleanup only after that case process exits, so no legitimate producer
# remains. Linux has no rename-if-source-inode operation; an uncooperative
# process running as the same UID can still race pathname syscalls. Exact
# post-rename proof plus restoration below contains that residual race without
# granting cleanup authority over the unexpected lifecycle.
_cortex_private_tmux_quarantine_stale_socket() {
  local tmux_bin="$1"
  local socket="$2"
  local tmux_root="$3"
  local socket_parent="$4"
  local current_uid="$5"
  local original_socket_identity="$6"
  local root_identity="$7"
  local parent_identity="$8"
  local quarantine_dir=""
  local quarantine_identity=""
  local quarantine_owner=""
  local quarantine_socket=""
  local moved_socket_identity=""
  local probe_rc=0
  local attempt=0

  if ! _cortex_private_tmux_directory_matches "$tmux_root" "$root_identity" \
    || ! _cortex_private_tmux_directory_matches "$socket_parent" "$parent_identity" \
    || ! _cortex_private_tmux_socket_matches "$socket" "$original_socket_identity"; then
    printf 'private-tmux-cleanup: stale cleanup boundary changed before quarantine: %s\n' \
      "$socket" >&2
    return 1
  fi

  # The short path also keeps the quarantined Unix socket below the path length
  # of the original .../tmux-UID/default socket. mktemp creates the directory
  # atomically; its 0700 mode and unpredictable name make the empty target name
  # private until the rename.
  if ! quarantine_dir="$(/usr/bin/mktemp -d -- "${tmux_root}/.q.XXXXXX")"; then
    printf 'private-tmux-cleanup: cannot allocate stale-socket quarantine under %s\n' \
      "$tmux_root" >&2
    return 1
  fi
  quarantine_socket="${quarantine_dir}/s"
  quarantine_identity="$(stat -Lc '%d:%i:%u:%a' -- "$quarantine_dir" 2>/dev/null || true)"
  quarantine_owner="${quarantine_identity%:*}"
  quarantine_owner="${quarantine_owner##*:}"
  if [[ -e "$quarantine_socket" || -L "$quarantine_socket" ]] \
    || [[ ! "$quarantine_identity" =~ ^[0-9]+:[0-9]+:[0-9]+:700$ ]] \
    || [[ "$quarantine_owner" != "$current_uid" ]] \
    || [[ "${quarantine_identity%%:*}" != "${original_socket_identity%%:*}" ]] \
    || ! _cortex_private_tmux_directory_matches "$tmux_root" "$root_identity" \
    || ! _cortex_private_tmux_directory_matches "$socket_parent" "$parent_identity" \
    || ! _cortex_private_tmux_socket_matches "$socket" "$original_socket_identity"; then
    printf 'private-tmux-cleanup: cannot attest same-filesystem stale quarantine: %s\n' \
      "$quarantine_dir" >&2
    return 1
  fi

  # Source and destination are on the attested same device, and the destination
  # is absent inside the freshly-created directory. --no-copy prohibits an
  # EXDEV fallback; --no-clobber prevents a raced destination from being
  # overwritten. Post-rename identity proof below detects the residual Linux
  # stat-to-rename source race.
  if ! /usr/bin/mv --no-copy -n -T -- \
    "$socket" "$quarantine_socket"; then
    printf 'private-tmux-cleanup: atomic stale-socket quarantine failed: %s\n' \
      "$socket" >&2
    return 1
  fi
  moved_socket_identity="$(stat -Lc '%d:%i:%u' -- "$quarantine_socket" 2>/dev/null || true)"
  if _cortex_private_tmux_directory_matches "$tmux_root" "$root_identity" \
    && _cortex_private_tmux_directory_matches "$socket_parent" "$parent_identity" \
    && _cortex_private_tmux_directory_matches "$quarantine_dir" "$quarantine_identity" \
    && [[ -S "$quarantine_socket" && ! -L "$quarantine_socket" ]] \
    && [[ "$moved_socket_identity" != "$original_socket_identity" ]]; then
    _cortex_private_tmux_restore_unexpected_socket \
      "$socket" "$tmux_root" "$socket_parent" "$current_uid" \
      "$root_identity" "$parent_identity" "$quarantine_dir" \
      "$quarantine_identity" "$quarantine_socket" "$moved_socket_identity"
    return 1
  fi
  if ! _cortex_private_tmux_directory_matches "$tmux_root" "$root_identity" \
    || ! _cortex_private_tmux_directory_matches "$socket_parent" "$parent_identity" \
    || ! _cortex_private_tmux_directory_matches "$quarantine_dir" "$quarantine_identity" \
    || ! _cortex_private_tmux_socket_matches \
      "$quarantine_socket" "$original_socket_identity"; then
    printf 'private-tmux-cleanup: quarantined socket is not the attested stale inode: %s\n' \
      "$quarantine_socket" >&2
    return 1
  fi

  # Sample both names twice. A live listener remains reachable through a moved
  # Unix socket, so probing the quarantine proves that the moved inode itself is
  # stale. Requiring the public path to remain absent prevents authority over a
  # server which binds the same path after the rename.
  for attempt in 1 2; do
    if _cortex_private_tmux_probe "$tmux_bin" "$quarantine_socket" "$tmux_root"; then
      printf 'private-tmux-cleanup: quarantined inode still has a live server: pid=%s socket=%s\n' \
        "$_CORTEX_PRIVATE_TMUX_PROBE_PID" "$quarantine_socket" >&2
      return 1
    else
      probe_rc=$?
    fi
    if (( probe_rc != 3 )); then
      printf 'private-tmux-cleanup: quarantine probe failed: %s\n' \
        "$_CORTEX_PRIVATE_TMUX_PROBE_OUTPUT" >&2
      return 1
    fi
    if ! _cortex_private_tmux_socket_matches \
      "$quarantine_socket" "$original_socket_identity"; then
      printf 'private-tmux-cleanup: quarantined socket identity changed after probe: %s\n' \
        "$quarantine_socket" >&2
      return 1
    fi
    if [[ -e "$socket" || -L "$socket" ]]; then
      printf 'private-tmux-cleanup: public socket was replaced during quarantine: %s\n' \
        "$socket" >&2
      return 1
    fi
    if _cortex_private_tmux_probe "$tmux_bin" "$socket" "$tmux_root"; then
      printf 'private-tmux-cleanup: replacement server acquired public socket: pid=%s socket=%s\n' \
        "$_CORTEX_PRIVATE_TMUX_PROBE_PID" "$socket" >&2
      return 1
    else
      probe_rc=$?
    fi
    if (( probe_rc != 3 )); then
      printf 'private-tmux-cleanup: public-path quarantine probe failed: %s\n' \
        "$_CORTEX_PRIVATE_TMUX_PROBE_OUTPUT" >&2
      return 1
    fi
    if [[ -e "$socket" || -L "$socket" ]] \
      || ! _cortex_private_tmux_directory_matches "$tmux_root" "$root_identity" \
      || ! _cortex_private_tmux_directory_matches "$socket_parent" "$parent_identity" \
      || ! _cortex_private_tmux_directory_matches "$quarantine_dir" "$quarantine_identity"; then
      printf 'private-tmux-cleanup: cleanup boundary changed during quarantine: %s\n' \
        "$socket" >&2
      return 1
    fi
    (( attempt == 2 )) || sleep 0.05
  done

  if [[ -e "$socket" || -L "$socket" ]] \
    || ! _cortex_private_tmux_socket_matches \
      "$quarantine_socket" "$original_socket_identity" \
    || ! _cortex_private_tmux_directory_matches "$tmux_root" "$root_identity" \
    || ! _cortex_private_tmux_directory_matches "$socket_parent" "$parent_identity" \
    || ! _cortex_private_tmux_directory_matches "$quarantine_dir" "$quarantine_identity"; then
    printf 'private-tmux-cleanup: stale inode changed immediately before quarantine unlink: %s\n' \
      "$quarantine_socket" >&2
    return 1
  fi
  if ! /usr/bin/unlink -- "$quarantine_socket"; then
    printf 'private-tmux-cleanup: exact quarantined-inode unlink failed: %s\n' \
      "$quarantine_socket" >&2
    return 1
  fi
  if [[ -e "$quarantine_socket" || -L "$quarantine_socket" ]]; then
    printf 'private-tmux-cleanup: quarantined socket survived unlink: %s\n' \
      "$quarantine_socket" >&2
    return 1
  fi

  # Re-probe both names after deletion. No path that reappears is removed: the
  # function fails and leaves the private root for inspection instead.
  for attempt in 1 2; do
    if _cortex_private_tmux_probe "$tmux_bin" "$quarantine_socket" "$tmux_root"; then
      printf 'private-tmux-cleanup: server appeared at deleted quarantine path: pid=%s socket=%s\n' \
        "$_CORTEX_PRIVATE_TMUX_PROBE_PID" "$quarantine_socket" >&2
      return 1
    else
      probe_rc=$?
    fi
    if (( probe_rc != 3 )); then
      printf 'private-tmux-cleanup: post-unlink quarantine probe failed: %s\n' \
        "$_CORTEX_PRIVATE_TMUX_PROBE_OUTPUT" >&2
      return 1
    fi
    if [[ -e "$quarantine_socket" || -L "$quarantine_socket" ]]; then
      printf 'private-tmux-cleanup: quarantine path reappeared after unlink: %s\n' \
        "$quarantine_socket" >&2
      return 1
    fi
    if _cortex_private_tmux_probe "$tmux_bin" "$socket" "$tmux_root"; then
      printf 'private-tmux-cleanup: replacement appeared after quarantine unlink: pid=%s socket=%s\n' \
        "$_CORTEX_PRIVATE_TMUX_PROBE_PID" "$socket" >&2
      return 1
    else
      probe_rc=$?
    fi
    if (( probe_rc != 3 )); then
      printf 'private-tmux-cleanup: post-unlink public-path probe failed: %s\n' \
        "$_CORTEX_PRIVATE_TMUX_PROBE_OUTPUT" >&2
      return 1
    fi
    if [[ -e "$socket" || -L "$socket" ]] \
      || ! _cortex_private_tmux_directory_matches "$tmux_root" "$root_identity" \
      || ! _cortex_private_tmux_directory_matches "$socket_parent" "$parent_identity" \
      || ! _cortex_private_tmux_directory_matches "$quarantine_dir" "$quarantine_identity"; then
      printf 'private-tmux-cleanup: path changed after quarantine unlink: %s\n' \
        "$socket" >&2
      return 1
    fi
    (( attempt == 2 )) || sleep 0.05
  done

  if ! /usr/bin/rmdir -- "$quarantine_dir"; then
    printf 'private-tmux-cleanup: stale quarantine is not empty after cleanup: %s\n' \
      "$quarantine_dir" >&2
    return 1
  fi
  if [[ -e "$quarantine_dir" || -L "$quarantine_dir" ]] \
    || [[ -e "$socket" || -L "$socket" ]] \
    || ! _cortex_private_tmux_directory_matches "$tmux_root" "$root_identity" \
    || ! _cortex_private_tmux_directory_matches "$socket_parent" "$parent_identity"; then
    printf 'private-tmux-cleanup: cleanup boundary changed after quarantine removal: %s\n' \
      "$socket" >&2
    return 1
  fi
}

stop_private_tmux_server() {
  local tmux_bin="${1-}"
  local socket="${2-}"
  local tmux_root="${3-}"
  local expected_socket=""
  local socket_parent=""
  local canonical_root=""
  local current_uid=""
  local server_pid=""
  local original_socket_identity=""
  local root_identity=""
  local parent_identity=""
  local root_owner=""
  local parent_owner=""
  local probe_rc=0
  local attempt=0

  if [[ "$tmux_bin" != /* || ! -x "$tmux_bin" \
    || "$tmux_root" != /* || "$tmux_root" == "/" ]]; then
    printf 'private-tmux-cleanup: invalid executable/root\n' >&2
    return 2
  fi
  expected_socket="${tmux_root}/tmux-$(id -u)/default"
  socket_parent="${expected_socket%/*}"
  if [[ "$socket" != "$expected_socket" ]]; then
    printf 'private-tmux-cleanup: refusing unexpected socket: %s\n' "$socket" >&2
    return 2
  fi
  current_uid="$(id -u)"
  if [[ ! -d "$tmux_root" || -L "$tmux_root" \
    || ! -d "$socket_parent" || -L "$socket_parent" ]] \
    || ! canonical_root="$(realpath -e -- "$tmux_root" 2>/dev/null)" \
    || [[ "$canonical_root" != "$tmux_root" ]] \
    || [[ "$(stat -Lc '%u:%a' -- "$tmux_root" 2>/dev/null || true)" != "${current_uid}:700" ]] \
    || [[ "$(stat -Lc '%u:%a' -- "$socket_parent" 2>/dev/null || true)" != "${current_uid}:700" ]]; then
    printf 'private-tmux-cleanup: private tmux root ownership/mode is unsafe: %s\n' \
      "$tmux_root" >&2
    return 2
  fi
  if ! root_identity="$(stat -Lc '%d:%i:%u:%a' -- "$tmux_root" 2>/dev/null)" \
    || ! parent_identity="$(stat -Lc '%d:%i:%u:%a' -- "$socket_parent" 2>/dev/null)" \
    || [[ ! "$root_identity" =~ ^[0-9]+:[0-9]+:[0-9]+:700$ ]] \
    || [[ ! "$parent_identity" =~ ^[0-9]+:[0-9]+:[0-9]+:700$ ]]; then
    printf 'private-tmux-cleanup: cannot pin private tmux directory identities: %s\n' \
      "$tmux_root" >&2
    return 2
  fi
  root_owner="${root_identity%:*}"
  root_owner="${root_owner##*:}"
  parent_owner="${parent_identity%:*}"
  parent_owner="${parent_owner##*:}"
  if [[ "$root_owner" != "$current_uid" || "$parent_owner" != "$current_uid" ]]; then
    printf 'private-tmux-cleanup: private tmux directory owner changed while pinning: %s\n' \
      "$tmux_root" >&2
    return 2
  fi
  if [[ -e "$socket" || -L "$socket" ]]; then
    if [[ -L "$socket" || ! -S "$socket" ]]; then
      printf 'private-tmux-cleanup: socket path is not a real socket: %s\n' "$socket" >&2
      return 1
    fi
    if ! original_socket_identity="$(stat -Lc '%d:%i:%u' -- "$socket" 2>/dev/null)" \
      || [[ ! "$original_socket_identity" =~ ^[0-9]+:[0-9]+:[0-9]+$ ]] \
      || [[ "${original_socket_identity##*:}" != "$current_uid" ]]; then
      printf 'private-tmux-cleanup: cannot attest socket inode: %s\n' "$socket" >&2
      return 1
    fi
  fi

  # Two stable absent probes are required before treating a missing/stale
  # socket as an already-stopped server. A server that appears between probes
  # is instead captured by PID and killed normally.
  for attempt in 1 2; do
    if _cortex_private_tmux_probe "$tmux_bin" "$socket" "$tmux_root"; then
      server_pid="$_CORTEX_PRIVATE_TMUX_PROBE_PID"
      break
    else
      probe_rc=$?
      if (( probe_rc != 3 )); then
        printf 'private-tmux-cleanup: initial probe failed: %s\n' \
          "$_CORTEX_PRIVATE_TMUX_PROBE_OUTPUT" >&2
        return 1
      fi
    fi
    (( attempt == 2 )) || sleep 0.05
  done

  if [[ -z "$server_pid" ]]; then
    if [[ -e "$socket" || -L "$socket" ]]; then
      _cortex_private_tmux_quarantine_stale_socket \
        "$tmux_bin" "$socket" "$tmux_root" "$socket_parent" "$current_uid" \
        "$original_socket_identity" "$root_identity" "$parent_identity"
      return $?
    fi
    return 0
  fi
  if [[ -z "$original_socket_identity" || ! -S "$socket" \
    || "$(stat -Lc '%d:%i:%u' -- "$socket" 2>/dev/null || true)" != "$original_socket_identity" ]]; then
    printf 'private-tmux-cleanup: socket identity changed during initial server proof: %s\n' \
      "$socket" >&2
    return 1
  fi

  local kill_output=""
  local kill_rc=0
  if kill_output="$(env -u TMUX -u TMUX_PANE \
    TMUX_TMPDIR="$tmux_root" LC_ALL=C \
    "$tmux_bin" -S "$socket" kill-server 2>&1)"; then
    kill_rc=0
  else
    kill_rc=$?
  fi
  if (( kill_rc != 0 )) \
    && ! _cortex_private_tmux_is_no_server "$kill_output" "$socket"; then
    printf 'private-tmux-cleanup: kill-server failed (%d): %s\n' \
      "$kill_rc" "$kill_output" >&2
    return 1
  fi

  local server_unreachable=0
  for ((attempt = 0; attempt < 40; attempt += 1)); do
    if _cortex_private_tmux_probe "$tmux_bin" "$socket" "$tmux_root"; then
      if [[ "$_CORTEX_PRIVATE_TMUX_PROBE_PID" != "$server_pid" ]]; then
        printf 'private-tmux-cleanup: same socket acquired a replacement server PID: %s -> %s\n' \
          "$server_pid" "$_CORTEX_PRIVATE_TMUX_PROBE_PID" >&2
        return 1
      fi
    else
      probe_rc=$?
      if (( probe_rc == 3 )); then
        server_unreachable=1
        break
      fi
      printf 'private-tmux-cleanup: post-kill probe failed: %s\n' \
        "$_CORTEX_PRIVATE_TMUX_PROBE_OUTPUT" >&2
      return 1
    fi
    sleep 0.05
  done
  if (( server_unreachable == 0 )); then
    printf 'private-tmux-cleanup: server still answers after kill-server: pid=%s socket=%s\n' \
      "$server_pid" "$socket" >&2
    return 1
  fi

  local pid_gone=0
  for ((attempt = 0; attempt < 40; attempt += 1)); do
    if ! kill -0 "$server_pid" 2>/dev/null; then
      pid_gone=1
      break
    fi
    sleep 0.05
  done
  if (( pid_gone == 0 )); then
    printf 'private-tmux-cleanup: original server PID survived cleanup: %s\n' "$server_pid" >&2
    return 1
  fi

  # Re-attest immediately before the caller removes the private root. A new
  # server may have appeared while the original PID was draining; reject the
  # observed replacement instead of reusing authority to stop the old PID.
  if _cortex_private_tmux_probe "$tmux_bin" "$socket" "$tmux_root"; then
    printf 'private-tmux-cleanup: server appeared at final identity check: pid=%s socket=%s\n' \
      "$_CORTEX_PRIVATE_TMUX_PROBE_PID" "$socket" >&2
    return 1
  else
    probe_rc=$?
  fi
  if (( probe_rc != 3 )); then
    printf 'private-tmux-cleanup: final probe failed: %s\n' \
      "$_CORTEX_PRIVATE_TMUX_PROBE_OUTPUT" >&2
    return 1
  fi

  # An explicit -S tmux server leaves its socket inode behind on this host. Move
  # only the exact pre-kill inode behind the private quarantine boundary. The
  # helper protocol-probes both names and fails on an observed replacement.
  if [[ -e "$socket" || -L "$socket" ]]; then
    if ! _cortex_private_tmux_socket_matches "$socket" "$original_socket_identity"; then
      printf 'private-tmux-cleanup: final socket inode is not the killed server inode: %s\n' \
        "$socket" >&2
      return 1
    fi
    _cortex_private_tmux_quarantine_stale_socket \
      "$tmux_bin" "$socket" "$tmux_root" "$socket_parent" "$current_uid" \
      "$original_socket_identity" "$root_identity" "$parent_identity" \
      || return 1
  fi
  if [[ -e "$socket" || -L "$socket" ]]; then
    printf 'private-tmux-cleanup: socket survived exact-inode unlink: %s\n' "$socket" >&2
    return 1
  fi

  # The pathname is gone; sample twice more so a replacement that starts at
  # the boundary is detected before the caller removes the surrounding root.
  for attempt in 1 2; do
    if _cortex_private_tmux_probe "$tmux_bin" "$socket" "$tmux_root"; then
      printf 'private-tmux-cleanup: replacement appeared after unlink: pid=%s socket=%s\n' \
        "$_CORTEX_PRIVATE_TMUX_PROBE_PID" "$socket" >&2
      return 1
    else
      probe_rc=$?
    fi
    if (( probe_rc != 3 )); then
      printf 'private-tmux-cleanup: post-unlink probe failed: %s\n' \
        "$_CORTEX_PRIVATE_TMUX_PROBE_OUTPUT" >&2
      return 1
    fi
    if [[ -e "$socket" || -L "$socket" ]]; then
      printf 'private-tmux-cleanup: socket reappeared after unlink: %s\n' "$socket" >&2
      return 1
    fi
    (( attempt == 2 )) || sleep 0.05
  done
}
