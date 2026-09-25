"""NEWARCH L2-P VT worker: pipe-pane bytes -> scroll rows + dirty cells.

Wraps the vendored pyte 0.8.2 archive (pipe-vt-vendor.zip, SHA-256 pinned
below, licences in pipe-vt-LICENSE.txt) with the PIPETRAY2/3 repairs:
every zero-width mark joins the previous cell, and 1049 keeps the normal
screen apart from the alternate one. Added here: 47/1047, soft-wrap flags,
wide glyph wrap at the last column, reflow on resize, and a scroll hook that
reports each normal-screen row *before* pyte drops it from the buffer.

IPC is stdlib-only, length-prefixed binary; input comes from the FIFO path
in argv[3] (stdin when absent), output goes to stdout:
  frame  = type:1 byte, length:uint32 BE, payload
  host -> worker
    D  seq:uint64 BE + raw pipe bytes (never decoded by the host)
    Z  cols:uint16, rows:uint16, geometryGeneration:uint32
    F  seq:uint64 (request a full frame)
    Q  (quit after flushing)
  worker -> host
    R  JSON ready {vendorSha256, cols, rows}
    U  JSON update {seqFrom, seqTo, gen, scrolls, frame, parseNs, encodeNs}
    E  JSON error {kind, message}
Bytes are fed through one incremental pyte.ByteStream, so UTF-8 sequences
and escape sequences may be split at any byte.
"""
import hashlib
import json
import os
import pathlib
import select
import struct
import sys
import time
from itertools import groupby
from operator import itemgetter

sys.dont_write_bytecode = True

VENDOR_SHA256 = "626c68240ce421066a4c915fca0ca0b44576a274fc14d89cae85e6105a79940d"
HERE = pathlib.Path(__file__).resolve().parent
VENDOR = HERE / "pipe-vt-vendor.zip"

# Emit at least this often while input keeps arriving (one 60 Hz frame).
MAX_COALESCE_NS = 16_000_000
MAX_COALESCE_BYTES = 256 * 1024


def send(kind, obj):
    body = json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    sys.stdout.buffer.write(kind + struct.pack(">I", len(body)) + body)
    sys.stdout.buffer.flush()


def verify_vendor():
    digest = hashlib.sha256(VENDOR.read_bytes()).hexdigest()
    if digest != VENDOR_SHA256:
        send(b"E", {"kind": "vendor-hash", "message": f"expected {VENDOR_SHA256} got {digest}"})
        sys.exit(3)
    return digest


VENDOR_DIGEST = verify_vendor()
sys.path.insert(0, str(VENDOR))
import pyte  # noqa: E402
from pyte import modes as mo  # noqa: E402
from wcwidth import wcwidth  # noqa: E402

ALT_MODES = (47, 1047, 1049)


def row_wrapped(row):
    return getattr(row, "wrapped", False)


def row_padded(row, cols):
    """A soft-wrapped row whose last cell is blank wrap padding (wide glyph)."""
    return row_wrapped(row) and getattr(row, "pad", False) and row[cols - 1].data == " "


class Screen(pyte.Screen):
    def __init__(self, cols, rows, epoch=1):
        self.epoch = epoch
        self.receive_seq = 0
        self.scroll_on_clear = None
        self.on_scroll = None
        self.on_history_clear = None
        self.shift = 0
        self.alt = False
        self.saved_normal = None
        self._drawing = False
        super().__init__(cols, rows)

    def stamp(self):
        row = self.buffer[self.cursor.y]
        if not hasattr(row, "epoch") or getattr(row, "origin_seq", 0) == 0:
            row.epoch = self.epoch
            row.origin_seq = self.receive_seq

    def preserve_on_clear(self):
        if self.alt or self.on_scroll is None:
            return
        if self.scroll_on_clear is None:
            send(b"E", {"kind": "clear-policy-unknown", "message": "scroll-on-clear was not read from the pane; clear may discard normal rows"})
        elif self.scroll_on_clear:
            last = max((y for y, row in self.buffer.items()
                        if any(c.data != " " for c in row.values())), default=-1)
            for y in range(last + 1):
                self.on_scroll(self.buffer[y])

    def reset(self):
        # pyte also calls reset during construction, before a hook exists.
        self.preserve_on_clear()
        super().reset()
        self.shift = 0

    def erase_in_display(self, how=0, *args, **kw):
        if how == 3:
            # tmux E3 clears scrollback only; pyte treats it as ED2.
            if (not args or args[0] == 0) and self.on_history_clear is not None:
                self.on_history_clear()
            return
        whole = how == 2 or (how == 0 and self.cursor.x == 0 and self.cursor.y == 0)
        if whole:
            self.preserve_on_clear()
        super().erase_in_display(how, *args, **kw)
        if whole:
            for row in self.buffer.values():
                row.wrapped = row.pad = False
                row.epoch = self.epoch
                row.origin_seq = self.receive_seq

    def scroll_up(self, count=1):
        y = self.cursor.y
        self.cursor.y = (self.margins or (0, self.lines - 1))[1]
        for _ in range(min(count or 1, (self.margins or (0, self.lines - 1))[1] - (self.margins or (0, self.lines - 1))[0] + 1)):
            self.index()
        self.cursor.y = y

    def scroll_down(self, count=1):
        y = self.cursor.y
        self.cursor.y = (self.margins or (0, self.lines - 1))[0]
        for _ in range(min(count or 1, (self.margins or (0, self.lines - 1))[1] - (self.margins or (0, self.lines - 1))[0] + 1)):
            self.reverse_index()
        self.cursor.y = y

    # -- scroll hook: report the row before pyte's index() discards it --
    def index(self):
        top, bottom = self.margins or (0, self.lines - 1)
        full = self.cursor.y == bottom and top == 0 and bottom == self.lines - 1
        if self.cursor.y == bottom and not self.alt and self.on_scroll is not None:
            self.on_scroll(self.buffer[top])
        if not full:
            super().index()
            return
        # pyte marks every row dirty on a scroll. Record a shift instead and
        # keep only rows that really changed, moved up with the content.
        before = self.dirty
        self.dirty = set()
        super().index()
        self.dirty = {y - 1 for y in before if y > 0}
        self.dirty.add(bottom)
        self.shift += 1

    def linefeed(self):
        if self._drawing:
            # draw() only line-feeds for DECAWM auto-wrap: mark a soft wrap.
            self.buffer[self.cursor.y].wrapped = True
        super().linefeed()
        if self._drawing:
            self.stamp()

    def erase_in_line(self, how=0, private=False):
        if how in (0, 2):
            self.buffer[self.cursor.y].wrapped = False
            self.buffer[self.cursor.y].pad = False
        super().erase_in_line(how, private)
        if how == 2:
            row = self.buffer[self.cursor.y]
            row.epoch, row.origin_seq = self.epoch, self.receive_seq

    # -- PIPETRAY repair + wide glyph wrap at the last column --
    def draw(self, data):
        self._drawing = True
        self.stamp()
        try:
            if data.isascii():
                super().draw(data)
                return
            start = 0
            for i, ch in enumerate(data):
                w = wcwidth(ch)
                if w == 2 and mo.DECAWM in self.mode:
                    if i > start:
                        super().draw(data[start:i])
                        start = i
                    if self.cursor.x == self.columns - 1:
                        # tmux never splits a wide glyph: leave the last cell
                        # blank as wrap padding and wrap before drawing it.
                        row = self.buffer[self.cursor.y]
                        row[self.cursor.x] = self.cursor.attrs._replace(data=" ")
                        row.pad = True
                        self.cursor.x = self.columns
                    continue
                if w > 0:
                    continue
                if i > start:
                    super().draw(data[start:i])
                start = i + 1
                if w < 0:
                    continue  # unprintable: pyte would abort the whole run
                y = self.cursor.y
                x = self.cursor.x - 1
                if x < 0:
                    prev = self.buffer[y - 1] if y else None
                    if prev is not None and row_wrapped(prev):
                        y -= 1
                        x = self.columns - (2 if row_padded(prev, self.columns) else 1)
                    else:
                        # Nothing to combine with in this logical line: keep
                        # the mark as its own cell instead of losing it.
                        self.buffer[y][0] = self.cursor.attrs._replace(data=ch)
                        self.cursor.x = 1
                        self.dirty.add(y)
                        continue
                if x >= 0:
                    while x > 0 and self.buffer[y][x].data == "":
                        x -= 1
                    old = self.buffer[y][x]
                    self.buffer[y][x] = old._replace(data=old.data + ch)
                    self.dirty.add(y)
            if start < len(data):
                super().draw(data[start:])
        finally:
            self._drawing = False

    # -- alternate screen: 47 / 1047 / 1049 --
    def _fresh_buffer(self):
        return type(self.buffer)(self.buffer.default_factory)

    def set_mode(self, *modes, **kw):
        if kw.get("private"):
            alt = [m for m in modes if m in ALT_MODES]
            if alt and not self.alt:
                cursor = None
                if 1049 in alt:
                    cursor = (self.cursor.x, self.cursor.y, self.cursor.attrs, self.cursor.hidden)
                self.saved_normal = (self.buffer, cursor, self.margins, self.columns, self.lines)
                self.buffer = self._fresh_buffer()
                self.alt = True
                self.dirty.update(range(self.lines))
                if cursor is not None:
                    self.cursor_position()
            modes = tuple(m for m in modes if m not in ALT_MODES)
            if not modes:
                return
        super().set_mode(*modes, **kw)

    def reset_mode(self, *modes, **kw):
        if kw.get("private"):
            alt = [m for m in modes if m in ALT_MODES]
            if alt and self.alt:
                buffer, cursor, margins, old_cols, old_rows = self.saved_normal
                cols, rows = self.columns, self.lines
                self.buffer = buffer
                self.saved_normal = None
                self.alt = False
                self.margins = margins
                if cursor is not None:
                    self.cursor.x, self.cursor.y, self.cursor.attrs, self.cursor.hidden = cursor
                self.columns, self.lines = old_cols, old_rows
                if (cols, rows) != (old_cols, old_rows):
                    self.reflow(cols, rows)
                self.dirty.update(range(self.lines))
            modes = tuple(m for m in modes if m not in ALT_MODES)
            if not modes:
                return
        super().reset_mode(*modes, **kw)

    # -- resize: reflow the normal screen by soft-wrap, like tmux --
    def reflow(self, cols, rows):
        """Rewrap logical lines at the new width; rows pushed off the top
        leave through on_scroll (as tmux moves them into history). Growing
        does not pull history back in: that is the calibrator's job."""
        if self.alt:
            # tmux does not reflow the alternate screen; the saved normal
            # grid is rewrapped when the application leaves it.
            self.resize(rows, cols)
            self.set_margins()
            return
        default = self.default_char
        last = self.cursor.y
        for y, row in self.buffer.items():
            if y > last and y < self.lines and any(c != default for c in row.values()):
                last = y
        logical = []
        origins = []
        origin = None
        current = []
        cursor_at = (0, 0)
        for y in range(last + 1):
            row = self.buffer[y]
            if origin is None:
                origin = (getattr(row, "epoch", self.epoch), getattr(row, "origin_seq", self.receive_seq))
            if y == self.cursor.y:
                cursor_at = (len(logical), len(current) + min(self.cursor.x, self.columns))
            cells = [row[x] for x in range(self.columns)]
            if row_wrapped(row) and y < last:
                current.extend(cells[:-1] if row_padded(row, self.columns) else cells)
                continue
            while cells and cells[-1] == default:
                cells.pop()
            current.extend(cells)
            logical.append(current)
            origins.append(origin)
            origin = None
            current = []
        physical = []  # (cells, wrapped)
        cursor_row, cursor_col = 0, 0
        for li, cells in enumerate(logical):
            first = len(physical)
            chunk = []
            i = 0
            while i < len(cells):
                width = 2 if (i + 1 < len(cells) and cells[i + 1].data == "" and cells[i].data != "") else 1
                if len(chunk) + width > cols:
                    physical.append((chunk, True, len(chunk) < cols, origins[li]))
                    chunk = []
                chunk.extend(cells[i:i + width])
                i += width
            physical.append((chunk, False, False, origins[li]))
            if li == cursor_at[0]:
                offset = cursor_at[1]
                used = 0
                cursor_row, cursor_col = len(physical) - 1, 0
                for k in range(first, len(physical)):
                    n = len(physical[k][0])
                    is_last = k == len(physical) - 1
                    if offset < used + n or is_last:
                        cursor_row, cursor_col = k, min(offset - used, cols)
                        break
                    used += n
        overflow = max(0, len(physical) - rows)
        self.lines, self.columns = rows, cols
        factory = self.buffer.default_factory
        fresh = self._fresh_buffer()
        for k, (cells, wrapped, pad, origin) in enumerate(physical):
            row = factory()
            for x, c in enumerate(cells[:cols]):
                row[x] = c
            row.epoch, row.origin_seq = origin
            row.wrapped = wrapped
            row.pad = pad
            if k < overflow:
                if self.on_scroll is not None:
                    self.on_scroll(row)
            else:
                fresh[k - overflow] = row
        self.buffer = fresh
        self.cursor.y = max(0, min(rows - 1, cursor_row - overflow))
        self.cursor.x = max(0, min(cols, cursor_col))
        self.set_margins()
        self.dirty.update(range(rows))


_STYLE = itemgetter(1, 2, 3, 4, 5, 6, 7, 8)


def encode_row(row, cols, default):
    """Runs of [fg, bg, attrs, cells]. `cells` is a string when every cell is
    one BMP code unit of width 1 (one character per cell); otherwise a list
    of graphemes where "" marks the stub cell of a wide glyph."""
    get = row.get
    runs = []
    for style, group in groupby([get(x, default) for x in range(cols)], _STYLE):
        data = [c[0] for c in group]
        joined = "".join(data)
        if len(joined) == len(data) and "" not in data and max(joined) < "\ud800":
            payload = joined
        else:
            payload = data
        fg, bg, bold, italics, underscore, strike, reverse, blink = style
        runs.append([fg, bg, bold | (italics << 1) | (underscore << 2) | (strike << 3)
                     | (reverse << 4) | (blink << 5), payload])
    return runs


def encode_cached(row, cols, default):
    """Reuse the runs of a row that has not changed since it was last sent.
    Every pyte mutation marks its row dirty, and emit() refreshes the cache
    of each dirty row, so a clean row's cache is its current content."""
    cached = getattr(row, "enc", None)
    if cached is not None and cached[0] == cols:
        return cached[1]
    return encode_row(row, cols, default)


class Worker:
    def __init__(self, cols, rows, epoch=1):
        self.screen = Screen(cols, rows, epoch)
        stream_type = type("TmuxByteStream", (pyte.ByteStream,), {"csi": {**pyte.ByteStream.csi, "S": "scroll_up", "T": "scroll_down"}, "events": pyte.ByteStream.events | {"scroll_up", "scroll_down"}})
        self.stream = stream_type(self.screen)
        self.gen = 0
        self.scrolls = []
        self.seq_from = None
        self.seq_to = None
        self.full = True
        self.parse_ns = 0
        self.emitted_seq = None
        self.screen.on_scroll = self._on_scroll
        self.screen.on_history_clear = self._on_history_clear

    def _on_history_clear(self):
        # Publish earlier rows before the clear marker, even within one D.
        self.emit(ack=False)
        send(b"H", {"seq": self.seq_to, "epoch": self.screen.epoch})

    def _on_scroll(self, row):
        s = self.screen
        # The row leaving is at the top (y=0); if it is not dirty its cache
        # from the last emitted frame is exactly its content.
        clean = 0 not in s.dirty and not self.full
        self.scrolls.append({
            "row": encode_row(row, s.columns, s.default_char),
            "wrap": row_wrapped(row),
            "pad": row_padded(row, s.columns),
            "gen": self.gen,
            "seq": getattr(row, "origin_seq", self.seq_to),
            "epoch": getattr(row, "epoch", s.epoch),
        })

    def feed(self, seq, epoch, data):
        self.screen.epoch = epoch
        self.screen.receive_seq = seq
        if self.seq_from is None:
            self.seq_from = seq
        self.seq_to = seq
        t = time.monotonic_ns()
        self.stream.feed(data)
        self.parse_ns += time.monotonic_ns() - t

    def resize(self, cols, rows, gen):
        self.gen = gen
        self.screen.reflow(cols, rows)
        self.full = True

    def pending(self):
        # A chunk that changed nothing (half an escape sequence) still gets
        # acknowledged, so the host can account for every received byte.
        return bool(self.scrolls or self.screen.dirty or self.full
                    or (self.seq_to is not None and self.seq_to != self.emitted_seq))

    def emit(self, ack=True):
        s = self.screen
        t = time.monotonic_ns()
        shift = 0 if self.full else min(s.shift, s.lines)
        ys = range(s.lines) if self.full else sorted(y for y in s.dirty if 0 <= y < s.lines)
        dirty = {}
        for y in ys:
            row = s.buffer[y]
            runs = encode_row(row, s.columns, s.default_char)
            row.enc = (s.columns, runs)
            dirty[str(y)] = runs
        wraps = {str(y): row_wrapped(s.buffer[y]) for y in ys}
        pads = [y for y in ys if row_padded(s.buffer[y], s.columns)]
        encode_ns = time.monotonic_ns() - t
        send(b"U", {
            "seqFrom": self.seq_from,
            "seqTo": self.seq_to if ack else self.emitted_seq,
            "gen": self.gen,
            "scrolls": self.scrolls,
            "frame": {
                "kind": "alternate" if s.alt else "normal",
                "cols": s.columns,
                "rows": s.lines,
                "full": self.full,
                "shift": shift,
                "dirty": dirty,
                "wraps": wraps,
                "pads": pads,
                "cursor": {"x": min(s.cursor.x, s.columns - 1), "y": s.cursor.y,
                           "visible": not s.cursor.hidden},
            },
            "parseNs": self.parse_ns,
            "encodeNs": encode_ns,
        })
        s.dirty.clear()
        s.shift = 0
        if ack:
            self.emitted_seq = self.seq_to
        self.scrolls = []
        self.seq_from = None
        self.full = False
        self.parse_ns = 0


def main():
    cols = int(sys.argv[1]) if len(sys.argv) > 1 else 80
    rows = int(sys.argv[2]) if len(sys.argv) > 2 else 24
    worker = Worker(cols, rows, int(sys.argv[4]) if len(sys.argv) > 4 else 1)
    send(b"R", {"vendorSha256": VENDOR_DIGEST, "cols": cols, "rows": rows, "pid": os.getpid()})
    fd = os.open(sys.argv[3], os.O_RDONLY) if len(sys.argv) > 3 else sys.stdin.buffer.fileno()
    buf = bytearray()
    batch_started = None
    batch_bytes = 0
    eof = False
    while not eof:
        chunk = os.read(fd, 1 << 16)
        if not chunk:
            eof = True
        buf.extend(chunk)
        while len(buf) >= 5:
            kind = bytes(buf[0:1])
            length = struct.unpack(">I", buf[1:5])[0]
            if len(buf) < 5 + length:
                break
            payload = bytes(buf[5:5 + length])
            del buf[:5 + length]
            if kind == b"D":
                seq = struct.unpack(">Q", payload[:8])[0]
                if batch_started is None:
                    batch_started = time.monotonic_ns()
                epoch = struct.unpack(">Q", payload[8:16])[0]
                worker.feed(seq, epoch, payload[16:])
                batch_bytes += len(payload) - 16
            elif kind == b"C":
                worker.screen.scroll_on_clear = bool(payload[0])
            elif kind == b"Z":
                c, r, g = struct.unpack(">HHI", payload[:8])
                worker.resize(c, r, g)
            elif kind == b"F":
                worker.full = True
                seq = struct.unpack(">Q", payload[:8])[0]
                worker.seq_to = seq if worker.seq_to is None else worker.seq_to
            elif kind == b"Q":
                eof = True
                break
            else:
                send(b"E", {"kind": "protocol", "message": f"unknown frame {kind!r}"})
        # Coalesce while more input is already waiting, but never past one
        # frame interval or 256 KiB, so scroll events are never starved.
        more = bool(select.select([fd], [], [], 0)[0]) and not eof
        overdue = batch_started is not None and (
            time.monotonic_ns() - batch_started >= MAX_COALESCE_NS or batch_bytes >= MAX_COALESCE_BYTES)
        if worker.pending() and (not more or overdue or eof):
            worker.emit()
            batch_started = None
            batch_bytes = 0
    if worker.pending():
        worker.emit()


if __name__ == "__main__":
    main()
