"""NEWARCH L2-P VT worker: pipe-pane bytes -> scroll rows + dirty cells.

Wraps the vendored pyte 0.8.2 archive (pipe-vt-vendor.zip, SHA-256 pinned
below, licences in pipe-vt-LICENSE.txt) with the PIPETRAY2/3 repairs:
every zero-width mark joins the previous cell, and 1049 keeps the normal
screen apart from the alternate one. Added here: 47/1047, soft-wrap flags,
wide glyph wrap at the last column, reflow on resize, and a scroll hook that
reports each normal-screen row *before* pyte drops it from the buffer.

IPC is stdlib-only, length-prefixed binary on stdin/stdout:
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
    def __init__(self, cols, rows):
        self.on_scroll = None
        self.alt = False
        self.saved_normal = None
        self._drawing = False
        super().__init__(cols, rows)

    # -- scroll hook: report the row before pyte's index() discards it --
    def index(self):
        top, bottom = self.margins or (0, self.lines - 1)
        if (self.cursor.y == bottom and top == 0 and bottom == self.lines - 1
                and not self.alt and self.on_scroll is not None):
            self.on_scroll(self.buffer[top])
        super().index()

    def linefeed(self):
        if self._drawing:
            # draw() only line-feeds for DECAWM auto-wrap: mark a soft wrap.
            self.buffer[self.cursor.y].wrapped = True
        super().linefeed()

    def erase_in_line(self, how=0, private=False):
        if how in (0, 2):
            self.buffer[self.cursor.y].wrapped = False
            self.buffer[self.cursor.y].pad = False
        super().erase_in_line(how, private)

    # -- PIPETRAY repair + wide glyph wrap at the last column --
    def draw(self, data):
        self._drawing = True
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
                self.saved_normal = (self.buffer, cursor, self.margins)
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
                buffer, cursor, margins = self.saved_normal
                self.buffer = buffer
                self.saved_normal = None
                self.alt = False
                self.margins = margins
                if cursor is not None:
                    self.cursor.x, self.cursor.y, self.cursor.attrs, self.cursor.hidden = cursor
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
        current = []
        cursor_at = (0, 0)
        for y in range(last + 1):
            row = self.buffer[y]
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
                    physical.append((chunk, True, len(chunk) < cols))
                    chunk = []
                chunk.extend(cells[i:i + width])
                i += width
            physical.append((chunk, False, False))
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
        for k, (cells, wrapped, pad) in enumerate(physical):
            row = factory()
            for x, c in enumerate(cells[:cols]):
                row[x] = c
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


def encode_row(row, cols, default):
    """Runs of [fg, bg, attrs, graphemes]; '' marks a wide glyph's stub cell."""
    runs = []
    key = None
    run = None
    for x in range(cols):
        c = row[x]
        attrs = (c.bold | (c.italics << 1) | (c.underscore << 2) | (c.strikethrough << 3)
                 | (c.reverse << 4) | (c.blink << 5))
        k = (c.fg, c.bg, attrs)
        if k != key:
            run = [c.fg, c.bg, attrs, []]
            runs.append(run)
            key = k
        run[3].append(c.data)
    return runs


class Worker:
    def __init__(self, cols, rows):
        self.screen = Screen(cols, rows)
        self.stream = pyte.ByteStream(self.screen)
        self.gen = 0
        self.scrolls = []
        self.seq_from = None
        self.seq_to = None
        self.full = True
        self.parse_ns = 0
        self.emitted_seq = None
        self.screen.on_scroll = self._on_scroll

    def _on_scroll(self, row):
        s = self.screen
        self.scrolls.append({
            "row": encode_row(row, s.columns, s.default_char),
            "wrap": row_wrapped(row),
            "pad": row_padded(row, s.columns),
            "gen": self.gen,
            "seq": self.seq_to,
        })

    def feed(self, seq, data):
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

    def emit(self):
        s = self.screen
        t = time.monotonic_ns()
        ys = range(s.lines) if self.full else sorted(y for y in s.dirty if 0 <= y < s.lines)
        dirty = {str(y): encode_row(s.buffer[y], s.columns, s.default_char) for y in ys}
        wraps = {str(y): row_wrapped(s.buffer[y]) for y in ys}
        pads = [y for y in ys if row_padded(s.buffer[y], s.columns)]
        encode_ns = time.monotonic_ns() - t
        send(b"U", {
            "seqFrom": self.seq_from,
            "seqTo": self.seq_to,
            "gen": self.gen,
            "scrolls": self.scrolls,
            "frame": {
                "kind": "alternate" if s.alt else "normal",
                "cols": s.columns,
                "rows": s.lines,
                "full": self.full,
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
        self.emitted_seq = self.seq_to
        self.scrolls = []
        self.seq_from = None
        self.full = False
        self.parse_ns = 0


def main():
    cols = int(sys.argv[1]) if len(sys.argv) > 1 else 80
    rows = int(sys.argv[2]) if len(sys.argv) > 2 else 24
    worker = Worker(cols, rows)
    send(b"R", {"vendorSha256": VENDOR_DIGEST, "cols": cols, "rows": rows, "pid": os.getpid()})
    fd = sys.stdin.buffer.fileno()
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
                worker.feed(seq, payload[8:])
                batch_bytes += len(payload) - 8
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
