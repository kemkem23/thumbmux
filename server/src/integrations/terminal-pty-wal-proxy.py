#!/usr/bin/env python3
"""Direct child-PTY terminal proxy with a synchronous durable output WAL.

The process is intended to be the tmux pane's top-level command.  It owns the
only inner PTY master, journals every child-output byte and fdatasyncs it before
the byte is copied to the outer tmux PTY.  Proxy diagnostics never use the pane.

Linux is deliberate here: PR_SET_PDEATHSIG and /proc PID birth identity are
part of the crash and single-writer contract.
"""

from __future__ import annotations

import ctypes
import errno
import fcntl
import hashlib
import json
import os
import re
import select
import selectors
import signal
import socket
import stat
import struct
import subprocess
import sys
import termios
import time
import tty
import uuid
import zlib
from dataclasses import dataclass
from typing import Any, Optional


CONFIG_ENV = "THUMBMUX_TERMINAL_PTY_WAL_CONFIG"
ASSET_SHA256_ENV = "THUMBMUX_TERMINAL_PROXY_ASSET_SHA256"
WAL_FILE = "output.wal"
SOCKET_FILE = "control.sock"
LOCK_FILE = "writer.lock"
HEALTH_FILE = "pty-proxy-status.json"
DIAGNOSTIC_FILE = "pty-proxy-diagnostics.log"
FINALIZE_LOGICAL_END_FLAG = "--finalize-logical-end"
TEST_BOOT_DIAGNOSTIC_ENV = "THUMBMUX_TEST_TERMINAL_PROXY_BOOT_DIAGNOSTIC"
TEST_BOOT_DIAGNOSTIC_PATH = "/tmp/cortex-browser-terminal-proxy-boot.log"
TEST_BOOT_DIAGNOSTIC_MAX_BYTES = 128 * 1024

MAGIC = b"THMWAL01"
VERSION = 1
HEADER_BYTES = 40
KIND_TO_CODE = {"lifecycle": 1, "output": 2, "resize": 3, "checkpoint": 4}
CODE_TO_KIND = {value: key for key, value in KIND_TO_CODE.items()}
PRIVATE_DIRECTORY_MODE = 0o700
PRIVATE_FILE_MODE = 0o600
MAX_WAL_PAYLOAD = 16 * 1024 * 1024
MAX_CONTROL_FRAME = 64 * 1024
MAX_CONFIG_BYTES = 1024 * 1024
SAFE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
SAFE_SESSION = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
SOURCE_FORMAT = "|".join(
    (
        "#{session_name}",
        "#{session_id}",
        "#{window_id}",
        "#{pane_id}",
        "#{window_index}",
        "#{pane_index}",
        "#{pid}",
        "#{session_created}",
        "#{pane_width}",
        "#{pane_height}",
    )
)


class ProxyError(RuntimeError):
    pass


class WalCorruption(ProxyError):
    pass


def write_browser_sandbox_boot_diagnostic(error: BaseException) -> None:
    """Record pre-config failures only in the exact private browser runtime."""
    # The launch environment itself may be the malformed input under test, so
    # it cannot be the sole authority for this fallback. bwrap owns a private
    # UTS namespace with this one fixed hostname; the exact /run path, owner,
    # mode and byte cap remain independent write boundaries below.
    if os.uname().nodename != "cortex-browser-test":
        return
    flags = os.O_WRONLY | os.O_CREAT | os.O_APPEND | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(TEST_BOOT_DIAGNOSTIC_PATH, flags, PRIVATE_FILE_MODE)
    try:
        info = os.fstat(fd)
        if (
            not stat.S_ISREG(info.st_mode)
            or info.st_uid != os.geteuid()
            or stat.S_IMODE(info.st_mode) != PRIVATE_FILE_MODE
            or info.st_size >= TEST_BOOT_DIAGNOSTIC_MAX_BYTES
        ):
            return
        message = f"{type(error).__name__}: {error}".replace("\0", "").replace("\n", " ")
        payload = (message[:4096] + "\n").encode("utf-8", "replace")
        os.write(fd, payload)
        os.fsync(fd)
    finally:
        os.close(fd)


def now_ms() -> int:
    return time.time_ns() // 1_000_000


def fsync_directory(path: str) -> None:
    fd = os.open(path, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def ensure_durable_directory(path: str) -> None:
    """Create a private directory chain and persist every new directory name."""
    missing: list[str] = []
    cursor = path
    while True:
        try:
            info = os.lstat(cursor)
        except FileNotFoundError:
            missing.append(cursor)
            parent = os.path.dirname(cursor)
            if parent == cursor:
                raise ProxyError(f"terminal WAL has no existing ancestor: {path}")
            cursor = parent
            continue
        if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
            raise ProxyError(f"terminal WAL directory component is not a real directory: {cursor}")
        break

    for directory in reversed(missing):
        parent = os.path.dirname(directory)
        try:
            os.mkdir(directory, PRIVATE_DIRECTORY_MODE)
        except FileExistsError:
            pass
        info = os.lstat(directory)
        if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
            raise ProxyError(f"terminal WAL directory component is not a real directory: {directory}")
        os.chmod(directory, PRIVATE_DIRECTORY_MODE)
        # The child's metadata and the parent's new directory entry must both
        # survive before START, ACTIVATE, or any displayed output is possible.
        fsync_directory(directory)
        fsync_directory(parent)

    info = os.lstat(path)
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
        raise ProxyError("terminal WAL directory must be a real directory")
    os.chmod(path, PRIVATE_DIRECTORY_MODE)
    # Cover a mkdir race in which a peer created the leaf just before us but
    # had not yet synced its parent entry.
    fsync_directory(path)
    fsync_directory(os.path.dirname(path))


def verify_running_proxy_asset() -> str:
    """Fail before WAL access unless this process names the expected bytes."""
    expected = os.environ.get(ASSET_SHA256_ENV, "")
    if not re.fullmatch(r"[a-f0-9]{64}", expected):
        raise ProxyError(f"{ASSET_SHA256_ENV} is missing or invalid")
    path = os.path.realpath(__file__)
    fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    try:
        before = os.fstat(fd)
        if not stat.S_ISREG(before.st_mode) or before.st_size <= 0:
            raise ProxyError("terminal proxy asset is empty or not a regular file")
        digest = hashlib.sha256()
        total = 0
        while True:
            try:
                chunk = os.read(fd, 1024 * 1024)
            except InterruptedError:
                continue
            if not chunk:
                break
            digest.update(chunk)
            total += len(chunk)
        after = os.fstat(fd)
        if (
            total != before.st_size
            or before.st_dev != after.st_dev
            or before.st_ino != after.st_ino
            or before.st_size != after.st_size
            or before.st_mtime_ns != after.st_mtime_ns
            or before.st_ctime_ns != after.st_ctime_ns
        ):
            raise ProxyError("terminal proxy asset changed while it was verified")
        actual = digest.hexdigest()
    finally:
        os.close(fd)
    if actual != expected:
        raise ProxyError("terminal proxy asset does not match its launch fingerprint")
    return actual


def write_all(fd: int, data: bytes | bytearray | memoryview) -> None:
    view = memoryview(data)
    written = 0
    while written < len(view):
        try:
            count = os.write(fd, view[written:])
        except InterruptedError:
            continue
        except BlockingIOError:
            # stdin and stdout normally refer to the same outer PTY open-file
            # description.  Making stdin nonblocking can therefore make the
            # stdout copy nonblocking too.  A full tmux PTY is backpressure,
            # not a failed durable delivery: wait for room and resume at the
            # first byte the kernel has not accepted yet.
            while True:
                try:
                    _readable, writable, _exceptional = select.select([], [fd], [])
                except InterruptedError:
                    continue
                if writable:
                    break
            continue
        if count <= 0:
            raise OSError(errno.EIO, "write made no progress")
        written += count


def read_boot_id() -> str:
    with open("/proc/sys/kernel/random/boot_id", "r", encoding="ascii") as source:
        value = source.read(128).strip()
    if not value:
        raise ProxyError("Linux boot identity is unavailable")
    return value


def process_start_ticks(pid: int) -> str:
    with open(f"/proc/{pid}/stat", "r", encoding="utf-8") as source:
        value = source.read(4096)
    close = value.rfind(")")
    if close < 0:
        raise ProxyError(f"process {pid} stat is malformed")
    fields = value[close + 2 :].split()
    # fields[0] is Linux stat field 3; starttime is field 22.
    if len(fields) <= 19 or not fields[19].isdigit():
        raise ProxyError(f"process {pid} start time is unavailable")
    return fields[19]


def process_command(pid: int) -> str:
    try:
        value = open(f"/proc/{pid}/comm", "r", encoding="utf-8").read().strip()
    except (OSError, UnicodeError):
        return ""
    return value[:255]


def process_matches(pid: int, start_ticks: str, boot_id: str) -> bool:
    try:
        if read_boot_id() != boot_id:
            return False
        if process_start_ticks(pid) != start_ticks:
            return False
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        # Matching /proc start identity is enough when signal permission differs.
        return True
    except FileNotFoundError:
        return False


def assert_regular_or_absent(path: str, label: str) -> None:
    try:
        info = os.lstat(path)
    except FileNotFoundError:
        return
    if not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode):
        raise ProxyError(f"{label} must be a regular file")


class DiagnosticLog:
    def __init__(self, directory: str) -> None:
        self.path = os.path.join(directory, DIAGNOSTIC_FILE)

    def write(self, message: str) -> None:
        sanitized = message.replace("\x00", "?").replace("\r", " ").replace("\n", " ")[:8192]
        line = f"{now_ms()} pid={os.getpid()} {sanitized}\n".encode("utf-8", "replace")
        fd = os.open(
            self.path,
            os.O_CREAT | os.O_APPEND | os.O_WRONLY | getattr(os, "O_DSYNC", 0),
            PRIVATE_FILE_MODE,
        )
        try:
            write_all(fd, line)
            os.fdatasync(fd)
        finally:
            os.close(fd)


class AtomicStatus:
    def __init__(self, directory: str) -> None:
        self.directory = directory
        self.path = os.path.join(directory, HEALTH_FILE)
        self.counter = 0

    def write(self, value: dict[str, Any]) -> None:
        self.counter += 1
        temporary = os.path.join(
            self.directory,
            f".{HEALTH_FILE}.tmp-{os.getpid()}-{self.counter}",
        )
        encoded = (json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True) + "\n").encode("utf-8")
        fd = -1
        try:
            fd = os.open(
                temporary,
                os.O_CREAT | os.O_EXCL | os.O_WRONLY | getattr(os, "O_DSYNC", 0),
                PRIVATE_FILE_MODE,
            )
            write_all(fd, encoded)
            os.fdatasync(fd)
            os.close(fd)
            fd = -1
            os.replace(temporary, self.path)
            os.chmod(self.path, PRIVATE_FILE_MODE)
            fsync_directory(self.directory)
        finally:
            if fd >= 0:
                os.close(fd)
            try:
                os.unlink(temporary)
            except FileNotFoundError:
                pass


class WriterLock:
    def __init__(self, directory: str, instance_id: str, generation: str) -> None:
        self.directory = directory
        self.path = os.path.join(directory, LOCK_FILE)
        self.fd = -1
        self.contents = b""
        self.device = -1
        self.inode = -1
        self.instance_id = instance_id
        self.generation = generation

    def acquire(self) -> None:
        owner = {
            "version": 2,
            "pid": os.getpid(),
            "pidStartTicks": process_start_ticks(os.getpid()),
            "bootId": read_boot_id(),
            "instanceId": self.instance_id,
            "generation": self.generation,
            "createdAt": now_ms(),
        }
        self.contents = (json.dumps(owner, separators=(",", ":"), sort_keys=True) + "\n").encode("utf-8")
        for _attempt in range(8):
            try:
                fd = os.open(
                    self.path,
                    os.O_CREAT | os.O_EXCL | os.O_RDWR | getattr(os, "O_DSYNC", 0) | getattr(os, "O_NOFOLLOW", 0),
                    PRIVATE_FILE_MODE,
                )
            except FileExistsError:
                self._remove_stale()
                continue
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                write_all(fd, self.contents)
                os.fdatasync(fd)
                info = os.fstat(fd)
                self.device, self.inode = info.st_dev, info.st_ino
                fsync_directory(self.directory)
                self.fd = fd
                return
            except BaseException:
                os.close(fd)
                try:
                    os.unlink(self.path)
                    fsync_directory(self.directory)
                except FileNotFoundError:
                    pass
                raise
        raise ProxyError("terminal WAL could not acquire its single-writer lock")

    def _remove_stale(self) -> None:
        try:
            info = os.lstat(self.path)
        except FileNotFoundError:
            return
        if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode):
            raise ProxyError("terminal WAL writer lock is not a regular file")
        fd = os.open(self.path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
        try:
            locked = False
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                locked = True
            except BlockingIOError:
                pass
            raw = os.read(fd, 64 * 1024)
            if os.read(fd, 1):
                raise ProxyError("terminal WAL writer lock is too large")
            try:
                owner = json.loads(raw.decode("utf-8"))
                pid = int(owner["pid"])
                start_ticks = str(owner["pidStartTicks"])
                boot_id = str(owner["bootId"])
            except (KeyError, TypeError, ValueError, UnicodeDecodeError, json.JSONDecodeError) as error:
                raise ProxyError("terminal WAL writer lock is malformed; refusing unsafe takeover") from error
            if process_matches(pid, start_ticks, boot_id):
                raise ProxyError(f"terminal WAL already has live writer process {pid}")
            if not locked:
                raise ProxyError("terminal WAL writer lock is held; refusing unsafe takeover")
            current = os.lstat(self.path)
            descriptor = os.fstat(fd)
            if (current.st_dev, current.st_ino) != (descriptor.st_dev, descriptor.st_ino):
                raise ProxyError("terminal WAL writer lock changed during stale-owner check")
            os.unlink(self.path)
            fsync_directory(self.directory)
        finally:
            os.close(fd)

    def release(self) -> None:
        if self.fd < 0:
            return
        owned_fd = self.fd
        self.fd = -1
        try:
            info = os.lstat(self.path)
            if (info.st_dev, info.st_ino) != (self.device, self.inode):
                raise ProxyError("terminal WAL writer lock inode changed; refusing removal")
            verify_fd = os.open(self.path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
            try:
                current = os.read(verify_fd, len(self.contents) + 1)
            finally:
                os.close(verify_fd)
            if current != self.contents:
                raise ProxyError("terminal WAL writer lock owner changed; refusing removal")
            os.unlink(self.path)
            fsync_directory(self.directory)
        except FileNotFoundError:
            pass
        finally:
            os.close(owned_fd)


@dataclass
class WalRecord:
    sequence: int
    next_offset: int
    kind: str
    payload: bytes
    at: int


@dataclass
class ExistingWal:
    empty: bool
    active: bool
    session: Optional[str]
    instance_id: Optional[str]
    identity: Optional[dict[str, Any]]
    geometry: Optional[dict[str, int]]
    pending_resize: Optional[dict[str, Any]]
    sequence: int
    last_at: int
    valid_bytes: int


def decode_json_payload(payload: bytes, label: str) -> dict[str, Any]:
    try:
        value = json.loads(payload.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise WalCorruption(f"{label} payload is invalid JSON") from error
    if not isinstance(value, dict):
        raise WalCorruption(f"{label} payload must be an object")
    return value


def validate_geometry(value: Any, label: str) -> dict[str, int]:
    if not isinstance(value, dict) or set(value) != {"cols", "rows"}:
        raise WalCorruption(f"{label} is invalid")
    cols, rows = value.get("cols"), value.get("rows")
    if not isinstance(cols, int) or isinstance(cols, bool) or not 1 <= cols <= 65_535:
        raise WalCorruption(f"{label}.cols is invalid")
    if not isinstance(rows, int) or isinstance(rows, bool) or not 1 <= rows <= 65_535:
        raise WalCorruption(f"{label}.rows is invalid")
    return {"cols": cols, "rows": rows}


class WalInspector:
    """Validate one record at a time while retaining only resumable WAL state."""

    def __init__(self) -> None:
        self.active = False
        self.session: Optional[str] = None
        self.instance_id: Optional[str] = None
        self.identity: Optional[dict[str, Any]] = None
        self.geometry: Optional[dict[str, int]] = None
        self.pending: Optional[dict[str, Any]] = None
        self.sequence = 0
        self.last_at = 0

    def consume(self, record: WalRecord) -> None:
        first = self.sequence == 0
        if first and record.kind != "lifecycle":
            raise WalCorruption("terminal WAL first record must be lifecycle start")
        if record.kind == "lifecycle":
            if self.pending is not None:
                raise WalCorruption("terminal WAL lifecycle appears inside pending resize")
            value = decode_json_payload(record.payload, "lifecycle")
            if set(value) != {"event", "identity", "geometry"}:
                raise WalCorruption("terminal WAL lifecycle fields are invalid")
            event = value.get("event")
            next_identity = value.get("identity")
            next_geometry = validate_geometry(value.get("geometry"), "lifecycle.geometry")
            if event not in ("start", "resume", "end") or not isinstance(next_identity, dict):
                raise WalCorruption("terminal WAL lifecycle is invalid")
            next_session, next_instance = next_identity.get("session"), next_identity.get("instanceId")
            if not isinstance(next_session, str) or not isinstance(next_instance, str):
                raise WalCorruption("terminal WAL lifecycle identity is invalid")
            if first:
                if event != "start":
                    raise WalCorruption("terminal WAL first lifecycle event must be start")
                self.session, self.instance_id, self.active = next_session, next_instance, True
            else:
                if event == "start" or next_session != self.session or next_instance != self.instance_id:
                    raise WalCorruption("terminal WAL lifecycle chain changed identity")
                if event == "end":
                    if not self.active:
                        raise WalCorruption("terminal WAL lifecycle ended twice")
                    self.active = False
                elif not self.active:
                    raise WalCorruption("terminal WAL resumed after logical END")
            # Keep only the latest source identity and geometry needed for a
            # RESUME or offline END. Earlier lifecycle payloads are released.
            self.identity = dict(next_identity)
            self.geometry = next_geometry
        else:
            if not self.active:
                raise WalCorruption("terminal WAL contains data outside active lifecycle")
            if record.kind == "resize":
                value = decode_json_payload(record.payload, "resize")
                allowed = {"phase", "changeId", "from", "to", "reason"}
                if not {"phase", "changeId", "from", "to"}.issubset(value) or not set(value).issubset(allowed):
                    raise WalCorruption("terminal WAL resize fields are invalid")
                phase = value.get("phase")
                validate_geometry(value.get("from"), "resize.from")
                next_geometry = validate_geometry(value.get("to"), "resize.to")
                if not isinstance(value.get("changeId"), str) or not SAFE_ID.fullmatch(value["changeId"]):
                    raise WalCorruption("terminal WAL resize changeId is invalid")
                if phase == "prepare":
                    if self.pending is not None:
                        raise WalCorruption("terminal WAL contains nested resize")
                    # The matching completion and crash recovery need this one
                    # record only; completed resize payloads are released.
                    self.pending = value
                elif phase in ("commit", "abort"):
                    if self.pending is None or any(
                        value.get(key) != self.pending.get(key)
                        for key in ("changeId", "from", "to", "reason")
                    ):
                        raise WalCorruption("terminal WAL resize completion has no matching prepare")
                    self.pending = None
                    if phase == "commit":
                        self.geometry = next_geometry
                else:
                    raise WalCorruption("terminal WAL resize phase is invalid")
            elif self.pending is not None:
                raise WalCorruption("terminal WAL record appears inside pending resize")
        self.sequence = record.sequence
        self.last_at = record.at

    def finish(self, valid_bytes: int) -> ExistingWal:
        return ExistingWal(
            self.sequence == 0,
            self.active,
            self.session,
            self.instance_id,
            self.identity,
            self.geometry,
            self.pending,
            self.sequence,
            self.last_at,
            valid_bytes,
        )


def scan_wal(path: str) -> tuple[ExistingWal, Optional[tuple[str, int]]]:
    try:
        fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    except FileNotFoundError:
        return WalInspector().finish(0), None
    inspector = WalInspector()
    offset = 0
    previous_sequence = 0
    previous_at = 0
    problem: Optional[tuple[str, int]] = None
    try:
        size = os.fstat(fd).st_size
        while offset < size:
            header = os.pread(fd, HEADER_BYTES, offset)
            if len(header) < HEADER_BYTES:
                problem = ("torn", offset)
                break
            magic, version, code, reserved, length, sequence, at, checksum, reserved_tail = struct.unpack(
                "<8sBBHIQQII", header
            )
            if magic != MAGIC or version != VERSION or code not in CODE_TO_KIND or reserved != 0 or reserved_tail != 0:
                raise WalCorruption(f"invalid WAL header at byte {offset}")
            if length > MAX_WAL_PAYLOAD:
                raise WalCorruption(f"WAL payload at byte {offset} exceeds format bound")
            if sequence != previous_sequence + 1:
                raise WalCorruption(f"non-contiguous WAL sequence at byte {offset}")
            if at < previous_at:
                raise WalCorruption(f"decreasing WAL timestamp at byte {offset}")
            if size - offset - HEADER_BYTES < length:
                problem = ("torn", offset)
                break
            payload = os.pread(fd, length, offset + HEADER_BYTES)
            if len(payload) != length:
                problem = ("torn", offset)
                break
            actual = zlib.crc32(header[8:32])
            actual = zlib.crc32(payload, actual) & 0xFFFFFFFF
            if actual != checksum:
                raise WalCorruption(f"WAL checksum mismatch at byte {offset}")
            next_offset = offset + HEADER_BYTES + length
            inspector.consume(WalRecord(sequence, next_offset, CODE_TO_KIND[code], payload, at))
            # Drop the current payload before pread allocates the next one, so
            # peak scan memory is bounded by one format-sized record plus the
            # small latest lifecycle/resize state retained by the inspector.
            del payload
            offset = next_offset
            previous_sequence = sequence
            previous_at = at
        return inspector.finish(offset), problem
    finally:
        os.close(fd)


def quarantine_torn_tail(path: str, valid_bytes: int, directory: str) -> None:
    source = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    destination_path = os.path.join(directory, f"{WAL_FILE}.torn-{now_ms()}-{os.getpid()}")
    suffix = 0
    while True:
        try:
            destination = os.open(
                destination_path,
                os.O_CREAT | os.O_EXCL | os.O_WRONLY | getattr(os, "O_DSYNC", 0),
                PRIVATE_FILE_MODE,
            )
            break
        except FileExistsError:
            suffix += 1
            destination_path = os.path.join(directory, f"{WAL_FILE}.torn-{now_ms()}-{os.getpid()}-{suffix}")
    try:
        size = os.fstat(source).st_size
        offset = valid_bytes
        while offset < size:
            chunk = os.pread(source, min(64 * 1024, size - offset), offset)
            if not chunk:
                break
            write_all(destination, chunk)
            offset += len(chunk)
        os.fdatasync(destination)
    finally:
        os.close(destination)
        os.close(source)
    fsync_directory(directory)
    repair = os.open(path, os.O_WRONLY | getattr(os, "O_NOFOLLOW", 0))
    try:
        os.ftruncate(repair, valid_bytes)
        os.fdatasync(repair)
    finally:
        os.close(repair)


class WalWriter:
    def __init__(self, path: str, directory: str) -> None:
        assert_regular_or_absent(path, "terminal WAL")
        existing, problem = scan_wal(path)
        if problem is not None:
            quarantine_torn_tail(path, existing.valid_bytes, directory)
            existing, second_problem = scan_wal(path)
            if second_problem is not None:
                raise WalCorruption("terminal WAL remains torn after repair")
        self.existing = existing
        existed = os.path.exists(path)
        self.fd = os.open(
            path,
            os.O_CREAT | os.O_APPEND | os.O_WRONLY | getattr(os, "O_DSYNC", 0) | getattr(os, "O_NOFOLLOW", 0),
            PRIVATE_FILE_MODE,
        )
        os.chmod(path, PRIVATE_FILE_MODE)
        if not existed:
            fsync_directory(directory)
        self.sequence = self.existing.sequence
        self.last_at = self.existing.last_at
        self.next_offset = self.existing.valid_bytes

    def append(self, kind: str, payload: bytes) -> WalRecord:
        if self.fd < 0:
            raise ProxyError("terminal WAL writer is closed")
        if kind not in KIND_TO_CODE or len(payload) > MAX_WAL_PAYLOAD:
            raise ProxyError("terminal WAL append is outside format bounds")
        sequence = self.sequence + 1
        at = max(self.last_at, now_ms())
        prefix = struct.pack("<BBHIQQ", VERSION, KIND_TO_CODE[kind], 0, len(payload), sequence, at)
        checksum = zlib.crc32(prefix)
        checksum = zlib.crc32(payload, checksum) & 0xFFFFFFFF
        header = MAGIC + prefix + struct.pack("<II", checksum, 0)
        offset = os.fstat(self.fd).st_size
        write_all(self.fd, header + payload)
        os.fdatasync(self.fd)
        self.sequence = sequence
        self.last_at = at
        self.next_offset = offset + len(header) + len(payload)
        return WalRecord(sequence, self.next_offset, kind, bytes(payload), at)

    def append_json(self, kind: str, value: dict[str, Any]) -> WalRecord:
        return self.append(kind, json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))

    def close(self) -> None:
        if self.fd < 0:
            return
        os.fdatasync(self.fd)
        os.close(self.fd)
        self.fd = -1


def finalize_logical_end(config: dict[str, Any]) -> None:
    """Durably close an active logical WAL without touching tmux or a child."""
    directory = config["directory"]
    ensure_durable_directory(directory)
    if os.path.realpath(directory) != directory:
        raise ProxyError("terminal WAL directory must not resolve through a symlink")
    os.chmod(directory, PRIVATE_DIRECTORY_MODE)

    lock = WriterLock(
        directory,
        config["identity"]["instanceId"],
        f"offline-finalize-{uuid.uuid4().hex}",
    )
    writer: Optional[WalWriter] = None
    try:
        # This is the same lifetime lock used by the direct proxy. A live or
        # disconnected-but-resumable proxy must win; only an offline lane may
        # be finalized without its child.
        lock.acquire()
        writer = WalWriter(os.path.join(directory, WAL_FILE), directory)
        existing = writer.existing
        if existing.empty:
            raise ProxyError("terminal WAL has no logical lifecycle to finalize")
        if (
            existing.session != config["identity"]["session"]
            or existing.instance_id != config["identity"]["instanceId"]
        ):
            raise ProxyError("terminal WAL logical identity does not match offline finalizer")
        if existing.identity is None or existing.geometry is None:
            raise WalCorruption("terminal WAL has no final source identity and geometry")
        if not existing.active:
            # END is immutable. Identity was verified above, so a retry after a
            # crash between END and the caller's cascade is already complete.
            return
        if existing.pending_resize is not None:
            writer.append_json(
                "resize",
                {
                    "phase": "abort",
                    **{
                        key: value
                        for key, value in existing.pending_resize.items()
                        if key != "phase"
                    },
                },
            )
        writer.append_json(
            "lifecycle",
            {
                "event": "end",
                "identity": existing.identity,
                "geometry": existing.geometry,
            },
        )
    finally:
        if writer is not None:
            writer.close()
        lock.release()


def positive_integer(value: Any, label: str, maximum: int) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value <= 0 or value > maximum:
        raise ProxyError(f"{label} must be a positive integer no greater than {maximum}")
    return value


def validate_config(raw: Any) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise ProxyError("terminal PTY WAL config must be an object")
    required = {"directory", "identity", "argv"}
    optional = {
        "cwd",
        "env",
        "tmux",
        "pythonExecutable",
        "maxOutputRecordBytes",
        "maxPendingInputBytes",
        "heartbeatMs",
        "terminateGraceMs",
    }
    if not required.issubset(raw) or not set(raw).issubset(required | optional):
        raise ProxyError("terminal PTY WAL config fields are invalid")
    directory = raw.get("directory")
    if not isinstance(directory, str) or not directory or "\x00" in directory or not os.path.isabs(directory):
        raise ProxyError("terminal PTY WAL directory must be absolute")
    if os.path.normpath(directory) != directory or os.path.abspath(directory) != directory:
        raise ProxyError("terminal PTY WAL directory must be normalized")
    if len(os.path.join(directory, SOCKET_FILE).encode("utf-8")) > 100:
        raise ProxyError("terminal PTY WAL control socket path exceeds Linux bound")
    identity = raw.get("identity")
    if not isinstance(identity, dict) or set(identity) != {"session", "instanceId", "paneTarget"}:
        raise ProxyError("terminal PTY WAL identity is invalid")
    session, instance_id, pane_target = identity.get("session"), identity.get("instanceId"), identity.get("paneTarget")
    if not isinstance(session, str) or not SAFE_SESSION.fullmatch(session):
        raise ProxyError("terminal PTY WAL session is invalid")
    if not isinstance(instance_id, str) or not SAFE_ID.fullmatch(instance_id):
        raise ProxyError("terminal PTY WAL instance is invalid")
    if not isinstance(pane_target, str) or not re.fullmatch(rf"={re.escape(session)}:\d+\.\d+", pane_target):
        raise ProxyError("terminal PTY WAL pane target is invalid")
    argv = raw.get("argv")
    if not isinstance(argv, list) or not 1 <= len(argv) <= 4096:
        raise ProxyError("terminal PTY WAL argv is invalid")
    if any(not isinstance(item, str) or not item or "\x00" in item for item in argv):
        raise ProxyError("terminal PTY WAL argv contains an invalid argument")
    cwd = raw.get("cwd")
    if cwd is not None and (
        not isinstance(cwd, str) or not os.path.isabs(cwd) or os.path.normpath(cwd) != cwd or "\x00" in cwd
    ):
        raise ProxyError("terminal PTY WAL cwd is invalid")
    environment = raw.get("env", {})
    if not isinstance(environment, dict):
        raise ProxyError("terminal PTY WAL env is invalid")
    for name, value in environment.items():
        if not isinstance(name, str) or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", name) or name == CONFIG_ENV:
            raise ProxyError("terminal PTY WAL env name is invalid")
        if not isinstance(value, str) or "\x00" in value:
            raise ProxyError("terminal PTY WAL env value is invalid")
    tmux = raw.get("tmux", {})
    if not isinstance(tmux, dict) or not set(tmux).issubset({"executable", "socketName", "socketPath"}):
        raise ProxyError("terminal PTY WAL tmux config is invalid")
    if tmux.get("socketName") is not None and tmux.get("socketPath") is not None:
        raise ProxyError("terminal PTY WAL tmux socket selectors conflict")
    executable = tmux.get("executable", "tmux")
    if not isinstance(executable, str) or not executable or "\x00" in executable:
        raise ProxyError("terminal PTY WAL tmux executable is invalid")
    if "/" in executable:
        if not os.path.isabs(executable) or os.path.abspath(executable) != executable:
            raise ProxyError("terminal PTY WAL tmux executable path is not normalized")
    elif not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}", executable):
        raise ProxyError("terminal PTY WAL tmux command name is invalid")
    if tmux.get("socketName") is not None and (
        not isinstance(tmux["socketName"], str)
        or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}", tmux["socketName"])
    ):
        raise ProxyError("terminal PTY WAL tmux socketName is invalid")
    if tmux.get("socketPath") is not None and (
        not isinstance(tmux["socketPath"], str)
        or not os.path.isabs(tmux["socketPath"])
        or os.path.abspath(tmux["socketPath"]) != tmux["socketPath"]
        or "\x00" in tmux["socketPath"]
    ):
        raise ProxyError("terminal PTY WAL tmux socketPath is invalid")
    max_output = positive_integer(raw.get("maxOutputRecordBytes", 64 * 1024), "maxOutputRecordBytes", MAX_WAL_PAYLOAD)
    max_input = positive_integer(raw.get("maxPendingInputBytes", 1024 * 1024), "maxPendingInputBytes", 64 * 1024 * 1024)
    if max_input < max_output:
        raise ProxyError("maxPendingInputBytes must be at least maxOutputRecordBytes")
    return {
        "directory": directory,
        "identity": {"session": session, "instanceId": instance_id, "paneTarget": pane_target},
        "argv": argv,
        "cwd": cwd,
        "env": environment,
        "tmux": {"executable": executable, **({"socketName": tmux["socketName"]} if tmux.get("socketName") else {}), **({"socketPath": tmux["socketPath"]} if tmux.get("socketPath") else {})},
        "maxOutputRecordBytes": max_output,
        "maxPendingInputBytes": max_input,
        "heartbeatMs": positive_integer(raw.get("heartbeatMs", 1000), "heartbeatMs", 60_000),
        "terminateGraceMs": positive_integer(raw.get("terminateGraceMs", 5000), "terminateGraceMs", 300_000),
    }


def load_config() -> dict[str, Any]:
    encoded = os.environ.pop(CONFIG_ENV, "")
    if not encoded or len(encoded.encode("utf-8")) > MAX_CONFIG_BYTES:
        raise ProxyError(f"{CONFIG_ENV} is missing or too large")
    try:
        return validate_config(json.loads(encoded))
    except json.JSONDecodeError as error:
        raise ProxyError(f"{CONFIG_ENV} is invalid JSON") from error


def tmux_selector(tmux: dict[str, str]) -> list[str]:
    if "socketName" in tmux:
        return ["-L", tmux["socketName"]]
    if "socketPath" in tmux:
        return ["-S", tmux["socketPath"]]
    return []


def query_source(config: dict[str, Any], generation: str) -> tuple[dict[str, Any], dict[str, int]]:
    tmux = config["tmux"]
    command = [
        tmux["executable"],
        *tmux_selector(tmux),
        "display-message",
        "-p",
        "-t",
        config["identity"]["paneTarget"],
        SOURCE_FORMAT,
    ]
    result = subprocess.run(command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)
    if result.returncode != 0:
        detail = result.stderr.decode("utf-8", "replace").strip()[:2048]
        raise ProxyError(f"tmux identity query failed ({result.returncode}): {detail}")
    try:
        text = result.stdout.decode("utf-8", "strict").rstrip("\n")
    except UnicodeDecodeError as error:
        raise ProxyError("tmux identity query returned invalid UTF-8") from error
    if "\n" in text:
        raise ProxyError("tmux identity query returned multiple lines")
    parts = text.split("|")
    if len(parts) != 10:
        raise ProxyError("tmux identity query returned invalid fields")
    session, session_id, window_id, pane_id, window_index, pane_index, server_pid, created, cols, rows = parts
    expected = config["identity"]
    if session != expected["session"] or not re.fullmatch(r"\$\d+", session_id) or not re.fullmatch(r"@\d+", window_id) or not re.fullmatch(r"%\d+", pane_id):
        raise ProxyError("tmux physical source identity does not match configuration")
    if not all(part.isdigit() for part in (window_index, pane_index, server_pid, created, cols, rows)):
        raise ProxyError("tmux identity query returned invalid numeric fields")
    pane_target = f"={session}:{int(window_index)}.{int(pane_index)}"
    if pane_target != expected["paneTarget"]:
        raise ProxyError("tmux pane target changed before proxy startup")
    environment_pane = os.environ.get("TMUX_PANE")
    if environment_pane != pane_id:
        raise ProxyError("tmux identity query target is not this proxy's own pane")
    geometry = validate_geometry({"cols": int(cols), "rows": int(rows)}, "tmux geometry")
    identity = {
        "session": session,
        "instanceId": expected["instanceId"],
        "paneTarget": pane_target,
        "tmuxServerPid": int(server_pid),
        "sessionCreated": int(created),
        "sessionId": session_id,
        "windowId": window_id,
        "paneId": pane_id,
        "generation": generation,
    }
    if identity["tmuxServerPid"] <= 0 or identity["sessionCreated"] < 0:
        raise ProxyError("tmux identity query returned invalid process identity")
    return identity, geometry


def get_geometry(fd: int) -> dict[str, int]:
    packed = fcntl.ioctl(fd, termios.TIOCGWINSZ, b"\0" * 8)
    rows, cols, _xpixel, _ypixel = struct.unpack("HHHH", packed)
    return validate_geometry({"cols": cols, "rows": rows}, "outer geometry")


def set_geometry(fd: int, geometry: dict[str, int]) -> None:
    packed = struct.pack("HHHH", geometry["rows"], geometry["cols"], 0, 0)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, packed)


def set_parent_death_signal(expected_parent: int) -> None:
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(1, signal.SIGKILL, 0, 0, 0) != 0:
        code = ctypes.get_errno()
        raise OSError(code, os.strerror(code))
    if os.getppid() != expected_parent:
        os._exit(125)


def close_child_fds(except_fds: set[int]) -> None:
    try:
        candidates = [int(name) for name in os.listdir("/proc/self/fd") if name.isdigit()]
    except OSError:
        candidates = list(range(3, 1024))
    for fd in candidates:
        if fd in except_fds:
            continue
        try:
            os.close(fd)
        except OSError:
            pass


@dataclass
class ChildPty:
    pid: int
    master_fd: int
    gate_fd: int
    error_fd: int


def fork_child(config: dict[str, Any], geometry: dict[str, int], outer_attributes: list[Any]) -> ChildPty:
    master_fd, slave_fd = os.openpty()
    set_geometry(slave_fd, geometry)
    termios.tcsetattr(slave_fd, termios.TCSANOW, outer_attributes)
    gate_read, gate_write = os.pipe2(os.O_CLOEXEC)
    error_read, error_write = os.pipe2(os.O_CLOEXEC | os.O_NONBLOCK)
    parent_pid = os.getpid()
    try:
        pid = os.fork()
    except BaseException:
        for fd in (master_fd, slave_fd, gate_read, gate_write, error_read, error_write):
            os.close(fd)
        raise
    if pid == 0:
        try:
            os.close(master_fd)
            os.close(gate_write)
            os.close(error_read)
            set_parent_death_signal(parent_pid)
            os.setsid()
            fcntl.ioctl(slave_fd, termios.TIOCSCTTY, 0)
            os.dup2(slave_fd, 0)
            os.dup2(slave_fd, 1)
            os.dup2(slave_fd, 2)
            if slave_fd > 2:
                os.close(slave_fd)
            try:
                os.tcsetpgrp(0, os.getpgrp())
            except OSError:
                pass
            close_child_fds({0, 1, 2, gate_read, error_write})
            while True:
                try:
                    gate = os.read(gate_read, 1)
                    break
                except InterruptedError:
                    continue
            os.close(gate_read)
            if gate != b"1":
                os._exit(125)
            if config["cwd"] is not None:
                os.chdir(config["cwd"])
            environment = os.environ.copy()
            environment.pop(CONFIG_ENV, None)
            environment.update(config["env"])
            os.execvpe(config["argv"][0], config["argv"], environment)
        except BaseException as error:
            try:
                message = f"child exec failed: {type(error).__name__}: {error}".encode("utf-8", "replace")[:4096]
                write_all(error_write, message)
            except BaseException:
                pass
            os._exit(126)
    os.close(slave_fd)
    os.close(gate_read)
    os.close(error_write)
    os.set_blocking(master_fd, False)
    os.set_blocking(error_read, False)
    return ChildPty(pid, master_fd, gate_write, error_read)


class Proxy:
    def __init__(self, config: dict[str, Any], asset_sha256: str = "") -> None:
        self.config = config
        self.directory = config["directory"]
        self.asset_sha256 = asset_sha256
        self.generation = uuid.uuid4().hex
        self.log: Optional[DiagnosticLog] = None
        self.status_writer: Optional[AtomicStatus] = None
        self.lock: Optional[WriterLock] = None
        self.writer: Optional[WalWriter] = None
        self.server: Optional[socket.socket] = None
        self.clients: dict[socket.socket, bytearray] = {}
        self.child: Optional[ChildPty] = None
        self.child_status: Optional[int] = None
        self.child_exit_code: Optional[int] = None
        self.master_eof = False
        self.source: Optional[dict[str, Any]] = None
        self.geometry: Optional[dict[str, int]] = None
        self.state = "starting"
        self.fatal_message: Optional[str] = None
        self.wal_sequence = 0
        self.wal_next_offset = 0
        self.delivered_sequence = 0
        self.delivered_next_offset = 0
        self.last_health_at = 0.0
        self.pending_input = bytearray()
        self.resize_requested = False
        self.termination_signal: Optional[int] = None
        self.logical_end_complete = False
        self.selector = selectors.DefaultSelector()
        self.signal_read = -1
        self.signal_write = -1
        self.original_outer_attributes: Optional[list[Any]] = None
        self.resize_counter = 0
        self.activated = False
        self.activation_record: Optional[WalRecord] = None
        self.disconnected_linger = False

    def setup_directory(self) -> None:
        ensure_durable_directory(self.directory)
        if os.path.realpath(self.directory) != self.directory:
            raise ProxyError("terminal WAL directory must not resolve through a symlink")
        os.chmod(self.directory, PRIVATE_DIRECTORY_MODE)
        self.log = DiagnosticLog(self.directory)

    def health_value(self) -> dict[str, Any]:
        current = now_ms()
        foreground_pid: Optional[int] = None
        foreground_start: Optional[str] = None
        foreground_command: Optional[str] = None
        if self.child is not None and self.child_status is None:
            try:
                selected = os.tcgetpgrp(self.child.master_fd)
                if selected > 0:
                    command = process_command(selected)
                    # Publish this identity atomically.  A disappearing process
                    # can leave an empty /proc command between tcgetpgrp() and
                    # the reads below; partial fields would make the host trust
                    # an unverifiable foreground process.
                    if command:
                        start_ticks = process_start_ticks(selected)
                        foreground_pid = selected
                        foreground_start = start_ticks
                        foreground_command = command
            except (OSError, ProxyError):
                pass
        value: dict[str, Any] = {
            "version": 1,
            "state": self.state,
            "generation": self.generation,
            "assetSha256": self.asset_sha256,
            "pid": os.getpid(),
            "pidStartTicks": process_start_ticks(os.getpid()),
            "childPid": self.child.pid if self.child is not None else None,
            "foregroundPid": foreground_pid,
            "foregroundPidStartTicks": foreground_start,
            "foregroundCommand": foreground_command,
            "source": self.source,
            "geometry": self.geometry,
            "updatedAt": current,
            "heartbeatAt": current,
            "walSequence": str(self.wal_sequence),
            "walNextOffset": self.wal_next_offset,
            "deliveredSequence": str(self.delivered_sequence),
            "deliveredNextOffset": self.delivered_next_offset,
        }
        if self.child_exit_code is not None:
            value["childExitCode"] = self.child_exit_code
        if self.fatal_message is not None:
            value["error"] = self.fatal_message[:2048]
        return value

    def write_health(self, force: bool = False) -> None:
        monotonic = time.monotonic()
        interval = self.config["heartbeatMs"] / 1000
        if not force and monotonic - self.last_health_at < interval:
            return
        if self.status_writer is None:
            return
        self.status_writer.write(self.health_value())
        self.last_health_at = monotonic

    def note_wal(self, record: WalRecord, delivered: bool) -> None:
        self.wal_sequence = record.sequence
        self.wal_next_offset = record.next_offset
        if delivered:
            self.delivered_sequence = record.sequence
            self.delivered_next_offset = record.next_offset

    def append_json(self, kind: str, value: dict[str, Any], delivered: bool = True) -> WalRecord:
        if self.writer is None:
            raise ProxyError("terminal WAL writer is unavailable")
        record = self.writer.append_json(kind, value)
        self.note_wal(record, delivered)
        return record

    def append_output_and_display(self, payload: bytes) -> None:
        if not payload:
            return
        if self.writer is None:
            raise ProxyError("terminal WAL writer is unavailable")
        record = self.writer.append("output", payload)
        self.note_wal(record, False)
        # The stable WAL boundary is deliberately before the only outer write.
        write_all(1, payload)
        self.note_wal(record, True)
        self.write_health(False)

    def prepare_socket(self) -> None:
        path = os.path.join(self.directory, SOCKET_FILE)
        try:
            info = os.lstat(path)
            if stat.S_ISLNK(info.st_mode) or not stat.S_ISSOCK(info.st_mode):
                raise ProxyError("terminal WAL control path is not a Unix socket")
            os.unlink(path)
            fsync_directory(self.directory)
        except FileNotFoundError:
            pass
        server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        server.setblocking(False)
        server.bind(path)
        os.chmod(path, PRIVATE_FILE_MODE)
        server.listen(4)
        fsync_directory(self.directory)
        self.server = server

    def setup_signals(self) -> None:
        self.signal_read, self.signal_write = os.pipe2(os.O_NONBLOCK | os.O_CLOEXEC)
        signal.set_wakeup_fd(self.signal_write)

        def mark_resize(_signum: int, _frame: Any) -> None:
            self.resize_requested = True

        def mark_termination(signum: int, _frame: Any) -> None:
            if self.termination_signal is None:
                self.termination_signal = signum

        signal.signal(signal.SIGWINCH, mark_resize)
        signal.signal(signal.SIGTERM, mark_termination)
        signal.signal(signal.SIGINT, mark_termination)
        signal.signal(signal.SIGHUP, mark_termination)
        signal.signal(signal.SIGCHLD, lambda _signum, _frame: None)
        signal.signal(signal.SIGPIPE, signal.SIG_IGN)

    def register_io(self) -> None:
        assert self.server is not None and self.child is not None
        self.selector.register(self.server, selectors.EVENT_READ, "server")
        self.selector.register(self.child.master_fd, selectors.EVENT_READ, "master")
        self.selector.register(0, selectors.EVENT_READ, "outer")
        self.selector.register(self.signal_read, selectors.EVENT_READ, "signal")
        self.selector.register(self.child.error_fd, selectors.EVENT_READ, "child-error")

    def modify_master_interest(self) -> None:
        if self.child is None or self.master_eof:
            return
        events = selectors.EVENT_READ
        if self.pending_input:
            events |= selectors.EVENT_WRITE
        try:
            self.selector.modify(self.child.master_fd, events, "master")
        except KeyError:
            pass

    def read_master_once(self) -> bool:
        if self.child is None or self.master_eof:
            return False
        try:
            payload = os.read(self.child.master_fd, self.config["maxOutputRecordBytes"])
        except BlockingIOError:
            return False
        except OSError as error:
            if error.errno == errno.EIO:
                self.master_eof = True
                return False
            raise
        if not payload:
            self.master_eof = True
            return False
        self.append_output_and_display(payload)
        return True

    def drain_master(self) -> None:
        while self.read_master_once():
            pass

    def read_outer(self) -> None:
        remaining = self.config["maxPendingInputBytes"] - len(self.pending_input)
        if remaining <= 0:
            try:
                self.selector.unregister(0)
            except KeyError:
                pass
            return
        try:
            data = os.read(0, min(64 * 1024, remaining))
        except BlockingIOError:
            return
        if not data:
            try:
                self.selector.unregister(0)
            except KeyError:
                pass
            return
        self.pending_input.extend(data)
        self.modify_master_interest()

    def write_pending_input(self) -> None:
        if self.child is None or not self.pending_input:
            return
        try:
            count = os.write(self.child.master_fd, self.pending_input[:64 * 1024])
        except BlockingIOError:
            return
        except OSError as error:
            if error.errno == errno.EIO:
                self.pending_input.clear()
                return
            raise
        if count > 0:
            del self.pending_input[:count]
        if len(self.pending_input) < self.config["maxPendingInputBytes"]:
            try:
                self.selector.get_key(0)
            except KeyError:
                self.selector.register(0, selectors.EVENT_READ, "outer")
        self.modify_master_interest()

    def reap_child(self, options: int = os.WNOHANG) -> bool:
        if self.child is None or self.child_status is not None:
            return self.child_status is not None
        try:
            pid, status_value = os.waitpid(self.child.pid, options)
        except ChildProcessError:
            return self.child_status is not None
        if pid == 0:
            return False
        if os.WIFSTOPPED(status_value) or os.WIFCONTINUED(status_value):
            return False
        self.child_status = status_value
        if os.WIFEXITED(status_value):
            self.child_exit_code = os.WEXITSTATUS(status_value)
        elif os.WIFSIGNALED(status_value):
            self.child_exit_code = 128 + os.WTERMSIG(status_value)
        else:
            self.child_exit_code = 125
        return True

    def freeze_child(self) -> bool:
        if self.child is None or self.reap_child():
            return False
        try:
            self.signal_child_groups(signal.SIGSTOP)
        except ProcessLookupError:
            self.reap_child()
            return False
        deadline = time.monotonic() + 2.0
        while time.monotonic() < deadline:
            try:
                pid, status_value = os.waitpid(self.child.pid, os.WNOHANG | os.WUNTRACED)
            except ChildProcessError:
                return False
            if pid == 0:
                time.sleep(0.001)
                continue
            if os.WIFSTOPPED(status_value):
                return True
            self.child_status = status_value
            if os.WIFEXITED(status_value):
                self.child_exit_code = os.WEXITSTATUS(status_value)
            elif os.WIFSIGNALED(status_value):
                self.child_exit_code = 128 + os.WTERMSIG(status_value)
            return False
        raise ProxyError("child process group did not stop for ordered boundary")

    def resume_child(self) -> None:
        if self.child is None or self.child_status is not None:
            return
        try:
            self.signal_child_groups(signal.SIGCONT)
        except ProcessLookupError:
            self.reap_child()

    def signal_child_groups(self, selected_signal: int) -> None:
        if self.child is None:
            return
        groups = {self.child.pid}
        try:
            foreground = os.tcgetpgrp(self.child.master_fd)
            if foreground > 0:
                groups.add(foreground)
        except OSError:
            pass
        delivered = False
        for group in groups:
            try:
                os.killpg(group, selected_signal)
                delivered = True
            except ProcessLookupError:
                pass
        if not delivered:
            raise ProcessLookupError()

    def ordered_barrier(self, request_id: str) -> WalRecord:
        stopped = self.freeze_child()
        self.drain_master()
        record = self.append_json("checkpoint", {"event": "barrier", "requestId": request_id})
        if stopped:
            self.resume_child()
        return record

    def ordered_resize(self) -> None:
        if self.child is None or self.geometry is None:
            return
        # Clear the notification we are servicing up front.  A second
        # SIGWINCH arriving during the frozen transaction remains pending.
        self.resize_requested = False
        target = get_geometry(0)
        if target == self.geometry:
            return
        stopped = self.freeze_child()
        if not stopped:
            return
        self.state = "resizing"
        self.write_health(True)
        self.drain_master()
        source = dict(self.geometry)
        self.resize_counter += 1
        change_id = f"resize:{self.generation}:{self.resize_counter}"
        boundary = {"changeId": change_id, "from": source, "to": target, "reason": "outer-sigwinch"}
        self.append_json("resize", {"phase": "prepare", **boundary})
        try:
            set_geometry(self.child.master_fd, target)
        except BaseException:
            self.append_json("resize", {"phase": "abort", **boundary})
            raise
        self.append_json("resize", {"phase": "commit", **boundary})
        self.geometry = target
        self.state = "ready" if self.activated else "armed"
        self.write_health(True)
        self.resume_child()

    def ordered_activate(self, generation: str) -> WalRecord:
        if generation != self.generation:
            raise ProxyError("ACTIVATE generation does not match direct PTY source")
        if self.activation_record is None or self.child is None:
            raise ProxyError("terminal PTY activation boundary is unavailable")
        if self.activated:
            return self.activation_record
        if self.child_status is not None or self.child.gate_fd < 0:
            raise ProxyError("terminal PTY child cannot be activated")
        # START/RESUME, source identity, geometry and the host T0 are durable
        # before this sole release point allows the child to chdir/exec.
        write_all(self.child.gate_fd, b"1")
        os.close(self.child.gate_fd)
        self.child.gate_fd = -1
        self.activated = True
        self.state = "ready"
        self.write_health(True)
        return self.activation_record

    def terminate_and_drain(self) -> None:
        if self.child is None:
            return
        stopped = self.freeze_child()
        self.drain_master()
        if self.child_status is None:
            try:
                self.signal_child_groups(signal.SIGTERM)
            except ProcessLookupError:
                pass
            if stopped:
                self.resume_child()
        deadline = time.monotonic() + self.config["terminateGraceMs"] / 1000
        while (self.child_status is None or not self.master_eof) and time.monotonic() < deadline:
            readable, _writable, _errors = select.select(
                [] if self.master_eof else [self.child.master_fd], [], [], 0.05
            )
            if readable:
                self.drain_master()
            self.reap_child()
        if self.child_status is None:
            try:
                self.signal_child_groups(signal.SIGKILL)
            except ProcessLookupError:
                pass
        kill_deadline = time.monotonic() + 2.0
        while (self.child_status is None or not self.master_eof) and time.monotonic() < kill_deadline:
            readable, _writable, _errors = select.select(
                [] if self.master_eof else [self.child.master_fd], [], [], 0.05
            )
            if readable:
                self.drain_master()
            self.reap_child()
        self.drain_master()
        self.reap_child()
        if self.child_status is None or not self.master_eof:
            raise ProxyError("child PTY did not reach EOF during synchronous termination")

    def ordered_end(self) -> WalRecord:
        if self.source is None or self.geometry is None:
            raise ProxyError("terminal PTY source is unavailable")
        self.state = "ending"
        self.write_health(True)
        self.terminate_and_drain()
        record = self.append_json(
            "lifecycle",
            {"event": "end", "identity": self.source, "geometry": self.geometry},
        )
        self.logical_end_complete = True
        self.state = "ended"
        self.write_health(True)
        return record

    def send_response(self, client: socket.socket, value: dict[str, Any]) -> None:
        encoded = (json.dumps(value, separators=(",", ":")) + "\n").encode("utf-8")
        client.setblocking(True)
        try:
            client.sendall(encoded)
        finally:
            client.setblocking(False)

    def handle_control_frame(self, client: socket.socket, frame: bytes) -> None:
        request_id = "invalid"
        try:
            text = frame.decode("utf-8", "strict")
            request = json.loads(text)
            if not isinstance(request, dict):
                raise ProxyError("control request fields are invalid")
            request_id = request.get("requestId")
            if not isinstance(request_id, str) or not SAFE_ID.fullmatch(request_id):
                request_id = "invalid"
                raise ProxyError("control request ID is invalid")
            command = request.get("command")
            expected_fields = {"protocol", "requestId", "command", "generation"} if command == "ACTIVATE" else {"protocol", "requestId", "command"}
            if set(request) != expected_fields:
                raise ProxyError("control request fields are invalid")
            if request.get("protocol") != 1 or command not in ("ACTIVATE", "BARRIER", "END"):
                raise ProxyError("control request is unsupported by direct PTY proxy")
            if command == "ACTIVATE" and (not isinstance(request.get("generation"), str) or not SAFE_ID.fullmatch(request["generation"])):
                raise ProxyError("ACTIVATE generation is invalid")
        except BaseException as error:
            try:
                self.send_response(
                    client,
                    {"protocol": 1, "requestId": request_id, "status": "error", "code": "INVALID_REQUEST", "message": str(error).replace("\n", " ")[:2048] or "invalid request"},
                )
            except BaseException:
                self.close_client(client)
            return
        if request["command"] == "ACTIVATE" and request["generation"] != self.generation:
            try:
                self.send_response(
                    client,
                    {"protocol": 1, "requestId": request_id, "status": "error", "code": "GENERATION_MISMATCH", "message": "ACTIVATE generation does not match direct PTY source"},
                )
            except OSError:
                self.close_client(client)
            return
        try:
            if request["command"] == "ACTIVATE":
                record = self.ordered_activate(request["generation"])
            elif request["command"] == "BARRIER":
                record = self.ordered_barrier(request_id)
            else:
                record = self.ordered_end()
        except BaseException:
            # An ordered operation failing can leave the child deliberately
            # frozen or the WAL at a prepared boundary.  It is fatal, never a
            # recoverable protocol error.
            raise
        try:
            self.send_response(
                client,
                {"protocol": 1, "requestId": request_id, "status": "ack", "sequence": str(record.sequence), "nextOffset": record.next_offset, "generation": self.generation},
            )
        except OSError:
            # The ordered operation is already durable. A controller that went
            # away cannot be allowed to turn a healthy terminal into fatal.
            self.close_client(client)

    def accept_control(self) -> None:
        assert self.server is not None
        while True:
            try:
                client, _address = self.server.accept()
            except BlockingIOError:
                return
            client.setblocking(False)
            if self.clients:
                try:
                    self.send_response(client, {"protocol": 1, "requestId": "busy", "status": "error", "code": "BUSY", "message": "another control client is connected"})
                except OSError:
                    pass
                finally:
                    client.close()
                continue
            self.clients[client] = bytearray()
            self.selector.register(client, selectors.EVENT_READ, "client")

    def close_client(self, client: socket.socket) -> None:
        try:
            self.selector.unregister(client)
        except (KeyError, ValueError):
            pass
        self.clients.pop(client, None)
        client.close()

    def read_control(self, client: socket.socket) -> None:
        try:
            chunk = client.recv(16 * 1024)
        except BlockingIOError:
            return
        if not chunk:
            self.close_client(client)
            return
        buffer = self.clients[client]
        buffer.extend(chunk)
        if len(buffer) > MAX_CONTROL_FRAME:
            try:
                self.send_response(client, {"protocol": 1, "requestId": "invalid", "status": "error", "code": "FRAME_TOO_LARGE", "message": "control request exceeds frame limit"})
            except OSError:
                pass
            self.close_client(client)
            return
        newline = buffer.find(b"\n")
        if newline < 0:
            return
        if newline != len(buffer) - 1:
            try:
                self.send_response(client, {"protocol": 1, "requestId": "invalid", "status": "error", "code": "INVALID_REQUEST", "message": "one control request at a time is required"})
            except OSError:
                pass
            self.close_client(client)
            return
        frame = bytes(buffer[:newline])
        buffer.clear()
        self.handle_control_frame(client, frame)

    def read_exec_error(self) -> None:
        if self.child is None:
            return
        try:
            payload = os.read(self.child.error_fd, 4096)
        except BlockingIOError:
            return
        if payload:
            assert self.log is not None
            self.log.write(payload.decode("utf-8", "replace"))
        else:
            try:
                self.selector.unregister(self.child.error_fd)
            except KeyError:
                pass
            os.close(self.child.error_fd)
            self.child.error_fd = -1

    def begin_disconnected_linger(self) -> None:
        if self.disconnected_linger:
            return
        self.disconnected_linger = True
        self.pending_input.clear()
        for fileobj in (0, self.child.master_fd if self.child is not None else -1):
            if fileobj < 0:
                continue
            try:
                self.selector.unregister(fileobj)
            except KeyError:
                pass
        self.state = "disconnected"
        self.write_health(True)

    def run_loop(self) -> int:
        while True:
            if self.resize_requested and self.child_status is None:
                self.ordered_resize()
            if self.termination_signal is not None:
                self.state = "disconnected"
                self.terminate_and_drain()
                self.write_health(True)
                return self.child_exit_code if self.child_exit_code is not None else 128 + self.termination_signal
            self.reap_child()
            if self.child_status is not None:
                self.drain_master()
                if self.master_eof:
                    if self.logical_end_complete:
                        self.state = "ended"
                        self.write_health(True)
                        return self.child_exit_code if self.child_exit_code is not None else 0
                    # Keep the WAL writer and control socket alive after an
                    # ordinary child exit. The host can now distinguish a dead
                    # inner program from a dead recorder, append a synchronous
                    # logical END on delete, or deliberately replace the pane
                    # and RESUME the same lifecycle after a crash/restart.
                    self.begin_disconnected_linger()
            if self.logical_end_complete:
                return self.child_exit_code if self.child_exit_code is not None else 0

            timeout = max(0.0, self.config["heartbeatMs"] / 1000 - (time.monotonic() - self.last_health_at))
            events = self.selector.select(timeout)
            for key, mask in events:
                kind = key.data
                if kind == "server":
                    self.accept_control()
                elif kind == "client":
                    self.read_control(key.fileobj)
                elif kind == "master":
                    if mask & selectors.EVENT_READ:
                        self.drain_master()
                    if mask & selectors.EVENT_WRITE:
                        self.write_pending_input()
                elif kind == "outer":
                    self.read_outer()
                elif kind == "signal":
                    try:
                        while os.read(self.signal_read, 4096):
                            pass
                    except BlockingIOError:
                        pass
                elif kind == "child-error":
                    self.read_exec_error()
            self.write_health(False)

    def start(self) -> int:
        self.setup_directory()
        assert self.log is not None
        # Install SIGWINCH handling before the first geometry sample. A resize
        # anywhere in the birth sequence is either reflected in START geometry
        # or becomes an ordered pre-release resize transaction.
        self.setup_signals()
        self.source, queried_geometry = query_source(self.config, self.generation)
        if not os.isatty(0) or not os.isatty(1):
            raise ProxyError("terminal PTY WAL proxy requires tty stdin and stdout")
        outer_geometry = get_geometry(0)
        if outer_geometry != queried_geometry:
            # The direct outer ioctl is authoritative; a concurrent tmux query
            # can lag one SIGWINCH, but startup still has one exact geometry.
            queried_geometry = outer_geometry
        self.geometry = queried_geometry
        self.lock = WriterLock(self.directory, self.config["identity"]["instanceId"], self.generation)
        self.lock.acquire()
        # Only the process holding the birth-verified lock may publish the
        # canonical health file. A losing contender must not clobber it.
        self.status_writer = AtomicStatus(self.directory)
        self.writer = WalWriter(os.path.join(self.directory, WAL_FILE), self.directory)
        existing = self.writer.existing
        if not existing.empty and (
            existing.session != self.config["identity"]["session"]
            or existing.instance_id != self.config["identity"]["instanceId"]
        ):
            raise ProxyError("terminal WAL logical identity does not match PTY proxy")
        if not existing.empty and not existing.active:
            raise ProxyError("terminal WAL logical lifecycle already ended")
        self.wal_sequence = self.writer.sequence
        self.wal_next_offset = self.writer.next_offset
        self.delivered_sequence = self.writer.sequence
        self.delivered_next_offset = self.writer.next_offset
        if existing.pending_resize is not None:
            self.append_json("resize", {"phase": "abort", **{key: value for key, value in existing.pending_resize.items() if key != "phase"}})

        self.original_outer_attributes = termios.tcgetattr(0)
        self.child = fork_child(self.config, self.geometry, self.original_outer_attributes)
        self.prepare_socket()
        lifecycle = "start" if existing.empty else "resume"
        self.activation_record = self.append_json(
            "lifecycle",
            {"event": lifecycle, "identity": self.source, "geometry": self.geometry},
        )
        tty.setraw(0, termios.TCSANOW)
        os.set_blocking(0, False)
        self.register_io()
        if get_geometry(0) != self.geometry:
            self.resize_requested = True
            self.ordered_resize()
        self.state = "armed"
        self.write_health(True)
        return self.run_loop()

    def fail_closed(self, error: BaseException) -> None:
        message = f"{type(error).__name__}: {error}"
        self.fatal_message = message
        self.state = "fatal"
        if self.child is not None and self.child_status is None:
            try:
                self.signal_child_groups(signal.SIGSTOP)
            except OSError:
                pass
        if self.log is not None:
            try:
                self.log.write(message)
            except BaseException:
                pass
        try:
            self.write_health(True)
        except BaseException:
            pass

    def cleanup(self) -> None:
        signal.set_wakeup_fd(-1)
        if self.child is not None and self.child.gate_fd >= 0:
            try:
                os.close(self.child.gate_fd)
            except OSError:
                pass
        if self.server is not None:
            try:
                self.selector.unregister(self.server)
            except BaseException:
                pass
            self.server.close()
            path = os.path.join(self.directory, SOCKET_FILE)
            try:
                info = os.lstat(path)
                if stat.S_ISSOCK(info.st_mode):
                    os.unlink(path)
                    fsync_directory(self.directory)
            except FileNotFoundError:
                pass
        for client in list(self.clients):
            self.close_client(client)
        if self.child is not None:
            for fd in (self.child.master_fd, self.child.error_fd):
                if fd >= 0:
                    try:
                        os.close(fd)
                    except OSError:
                        pass
        for fd in (self.signal_read, self.signal_write):
            if fd >= 0:
                try:
                    os.close(fd)
                except OSError:
                    pass
        if self.original_outer_attributes is not None and os.isatty(0):
            try:
                termios.tcsetattr(0, termios.TCSANOW, self.original_outer_attributes)
            except OSError:
                pass
        if self.writer is not None:
            try:
                self.writer.close()
            except BaseException:
                pass
        if self.lock is not None:
            try:
                self.lock.release()
            except BaseException as error:
                if self.log is not None:
                    try:
                        self.log.write(f"lock release failed: {error}")
                    except BaseException:
                        pass
        self.selector.close()


def main(arguments: Optional[list[str]] = None) -> int:
    selected_arguments = sys.argv[1:] if arguments is None else arguments
    if selected_arguments not in ([], [FINALIZE_LOGICAL_END_FLAG]):
        return 125
    try:
        asset_sha256 = verify_running_proxy_asset()
        config = load_config()
    except BaseException as error:
        # No trusted private diagnostics path exists yet.  Never leak proxy
        # internals into the pane that is reserved for child terminal bytes.
        # The exact browser hard sandbox is the sole exception: its bounded
        # tmpfs log contains only synthetic state and is destroyed after export.
        try:
            write_browser_sandbox_boot_diagnostic(error)
        except BaseException:
            pass
        return 125
    if selected_arguments == [FINALIZE_LOGICAL_END_FLAG]:
        try:
            finalize_logical_end(config)
            return 0
        except BaseException:
            # Recovery callers use the exit status as the only contract. This
            # mode must never write diagnostics into a terminal or invoke tmux.
            return 125
    proxy = Proxy(config, asset_sha256)
    try:
        return proxy.start()
    except BaseException as error:
        proxy.fail_closed(error)
        return 125
    finally:
        proxy.cleanup()


if __name__ == "__main__":
    os._exit(main())
