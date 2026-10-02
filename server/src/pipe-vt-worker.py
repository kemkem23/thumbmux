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
    U  JSON update {seqFrom, seqTo, gen, scrolls, frame, parseNs, encodeNs,
       stages, serializeNs}
    E  JSON error {kind, message}
Bytes are fed through one incremental pyte.ByteStream, so UTF-8 sequences
and escape sequences may be split at any byte.

Stage diagnostics (additive U fields, worker monotonic durations only; the
host never subtracts a worker clock from its own):
  parseNs      DCS filter + pyte feed of the D frames in this update
  encodeNs     dirty-row run encoding in emit()
  serializeNs  json.dumps + UTF-8 of this U body, spliced in last
  stages       {inFrames, inBytes, waitNs, maxWaitNs, holdNs, readLagNs,
               readLagMaxNs} since the last acknowledged emit: waitNs is how
               long the oldest D frame sat complete in this process before
               dispatch, maxWaitNs the worst D frame, holdNs oldest-frame
               completion -> emit start. readLagNs/readLagMaxNs bound how long
               the read that completed the oldest frame came after its bytes
               could have been read: lower = sibling channels served first in
               the same select turn, upper = since the previous poll returned
               (kernel buffering while this loop was busy elsewhere).
"""
import hashlib
import json
import os
import pathlib
import re
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
# Shared interpreter fairness (NEWARCH P2OPT): one channel turn spends at most
# MAX_TURN_NS feeding its parser, checked after every slice of at most
# TURN_SLICE_BYTES, so one large D frame can no longer hold every sibling for
# the whole frame. P2 measured ~2 us/byte of pyte, 26-37 ms per noisy turn
# with the old budget checked only between whole frames.
MAX_TURN_NS = 2_000_000
TURN_SLICE_BYTES = 512


output_sink = None  # Set only during one synchronous multiplex channel turn.


def send(kind, obj, timed=False):
    began = time.monotonic_ns() if timed else 0
    body = json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    if timed:
        # The body is a JSON object: splice its own serialization cost last.
        body = body[:-1] + b',"serializeNs":%d}' % (time.monotonic_ns() - began)
    packet = kind + struct.pack(">I", len(body)) + body
    if output_sink is not None:
        output_sink(packet)
        return
    sys.stdout.buffer.write(packet)
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


class RxClock:
    """Monotonic time at which each input byte offset arrived in this process.

    One entry per read; a frame is complete when its last byte arrived, so
    completed(end) is the time of the first read whose range reaches `end`.
    """

    def __init__(self):
        self.marks = []
        self.head = 0
        self.received = 0
        self.consumed = 0

    def arrived(self, n, at, lag_lo=0, lag_hi=0):
        if n:
            self.received += n
            self.marks.append((self.received, at, lag_lo, lag_hi))

    def completed(self, n):
        """(read time, read lag lower bound, upper bound) of the completing read."""
        self.consumed += n
        marks = self.marks
        while marks[self.head][0] < self.consumed:
            self.head += 1
        mark = marks[self.head][1:]
        if self.head > 64:
            del marks[:self.head]
            self.head = 0
        return mark


CSI_FINAL = re.compile(rb"[\x40-\x7e]")
STRING_END = re.compile(rb"\x07|\x1b\\")
NF_FINAL = re.compile(rb"[^\x20-\x2f]")


def slice_end(data, start, limit=TURN_SLICE_BYTES):
    """End of the next parser slice of data[start:], at most `limit` bytes.

    Walks the escape sequences from `start` (a slice boundary) and cuts before
    the first one still open at the window end, otherwise at the window end
    stepped back to the start of a UTF-8 sequence. The parser is incremental,
    so the fallback for a sequence longer than the window (cut at the window
    end) is still correct: the walk only keeps every slice self-contained.
    """
    end = start + limit
    if end >= len(data):
        return len(data)
    pos = start
    while True:
        esc = data.find(b"\x1b", pos, end)
        if esc < 0:
            break
        pos = escape_end(data, esc, end)
        if pos is None:
            end = esc
            break
    while end > start and 0x80 <= data[end] < 0xC0:
        end -= 1
    return end if end > start else start + limit


def escape_end(data, esc, end):
    """Offset after the escape sequence at data[esc], or None if open at `end`."""
    if esc + 1 >= end:
        return None
    intro = data[esc + 1]
    if intro == 0x5B:  # CSI: parameters/intermediates, then a final 0x40-0x7e.
        match = CSI_FINAL.search(data, esc + 2, end)
    elif intro in (0x5D, 0x50, 0x5F, 0x5E, 0x58):  # OSC/DCS/APC/PM/SOS: BEL or ST.
        match = STRING_END.search(data, esc + 2, end)
    elif 0x20 <= intro <= 0x2F:  # nF: intermediates, then a final byte.
        match = NF_FINAL.search(data, esc + 2, end)
    else:
        return esc + 2
    return None if match is None else match.end()


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
        # tmux input_csi_table accepts ED only without a private prefix.
        if kw.get("private") or how not in (0, 1, 2, 3):
            return
        if how == 3:
            # tmux E3 clears the shared history even while alt is active;
            # pyte instead treats it as ED2. A nonzero second arg is ignored.
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
            # tmux treats DECCOLM as home + clear, never a pane resize.
            if 3 in modes:
                self.cursor_position()
                self.erase_in_display(2)
                modes = tuple(m for m in modes if m != 3)
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
            # tmux treats DECCOLM as home + clear, never a pane resize.
            if 3 in modes:
                self.cursor_position()
                self.erase_in_display(2)
                modes = tuple(m for m in modes if m != 3)
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



# Versioned, data-only codec. Never pickle/import executable checkpoint content.
CHECKPOINT_CODEC = "pyte-stream-c1:" + VENDOR_SHA256

def pack_state(v):
    from collections import defaultdict
    from pyte.screens import Cursor, StaticDefaultDict
    if v is None or type(v) in (str, int, bool, float):
        return v
    if isinstance(v, Cursor):
        return ["cursor", [pack_state(getattr(v, k)) for k in v.__slots__]]
    if isinstance(v, tuple):
        return [type(v).__name__, [pack_state(x) for x in v]]
    if isinstance(v, (set, list)):
        return [type(v).__name__, [pack_state(x) for x in (sorted(v) if isinstance(v, set) else v)]]
    if isinstance(v, dict):
        attrs = {k: x for k, x in getattr(v, "__dict__", {}).items() if k != "enc"}
        kind = "buffer" if isinstance(v, defaultdict) else "row" if isinstance(v, StaticDefaultDict) else "dict"
        return [kind, [[pack_state(k), pack_state(x)] for k, x in v.items()], pack_state(attrs) if kind != "dict" else None]
    raise ValueError("unsupported checkpoint field " + type(v).__name__)

def unpack_state(v, screen):
    from collections import defaultdict
    from pyte.screens import Cursor, StaticDefaultDict, Char, Margins, Savepoint
    if not isinstance(v, list):
        return v
    kind, data = v[:2]
    if kind in ("buffer", "row", "dict"):
        out = defaultdict(lambda: StaticDefaultDict(screen.default_char)) if kind == "buffer" else StaticDefaultDict(screen.default_char) if kind == "row" else {}
        out.update((unpack_state(k, screen), unpack_state(x, screen)) for k, x in data)
        if kind != "dict":
            attrs = unpack_state(v[2], screen)
            if attrs: out.__dict__.update(attrs)
        return out
    data = [unpack_state(x, screen) for x in data]
    if kind == "cursor":
        out = Cursor(*data[:3]); out.hidden = data[3]; return out
    factories = {"Char": Char, "Margins": Margins, "Savepoint": Savepoint}
    if kind in factories: return factories[kind](*data)
    if kind == "tuple": return tuple(data)
    if kind == "set": return set(data)
    if kind == "list": return data
    raise ValueError("unknown checkpoint tag")

class CheckpointByteStream(pyte.ByteStream):
    csi = {**pyte.ByteStream.csi, "S": "scroll_up", "T": "scroll_down"}
    events = pyte.ByteStream.events | {"scroll_up", "scroll_down"}

    def __init__(self, screen):
        self.pending_sequence = ""
        super().__init__(screen)

    def _send_to_parser(self, data):
        # Only the unfinished escape prefix survives. Plain text stays on the
        # original fast path. A pathological OSC/CSI fails before unbounded RAM.
        if len(self.pending_sequence.encode("utf-8")) + len(data.encode("utf-8")) > 65536:
            raise ValueError("pending escape exceeds checkpoint budget")
        self.pending_sequence += data
        result = super()._send_to_parser(data)
        if result: self.pending_sequence = ""
        return result


class Worker:
    def __init__(self, cols, rows, epoch=1):
        self.screen = Screen(cols, rows, epoch)
        self.stream = CheckpointByteStream(self.screen)
        self.gen = 0
        self.packet_seq = 0
        self.scroll_ordinal = 0
        self.scrolls = []
        self.transaction_scroll_bytes = None
        self.seq_from = None
        self.seq_to = None
        self.full = True
        self.parse_ns = 0
        self.reset_stages()
        self.emitted_seq = None
        self.dcs_state = "ground"
        self.dcs_sixel = False
        self.dcs_intermediate = False
        self.screen.on_scroll = self._on_scroll
        self.screen.on_history_clear = self._on_history_clear

    def export_checkpoint(self):
        fields = {k: v for k, v in self.screen.__dict__.items()
                  if k not in ("on_scroll", "on_history_clear")}
        pending, flag = self.stream.utf8_decoder.getstate()
        state = {"codecVersion": CHECKPOINT_CODEC,
                 "geometry": {"columns": self.screen.columns, "rows": self.screen.lines},
                 "screen": pack_state(fields), "utf8": [list(pending), flag],
                 "escape": self.stream.pending_sequence, "useUtf8": self.stream.use_utf8,
                 "worker": {k: getattr(self, k) for k in ("gen", "packet_seq", "scroll_ordinal",
                     "dcs_state", "dcs_sixel", "dcs_intermediate")}}
        if len(json.dumps(state).encode()) > 1024 * 1024:
            raise ValueError("VT checkpoint exceeds 2 MiB copy budget")
        return state

    @classmethod
    def from_checkpoint(cls, state):
        if state.get("codecVersion") != CHECKPOINT_CODEC:
            raise ValueError("unsupported VT checkpoint codec")
        if len(json.dumps(state).encode()) > 1024 * 1024:
            raise ValueError("VT checkpoint exceeds budget")
        g = state["geometry"]
        if not (0 < g["columns"] <= 240 and 0 < g["rows"] <= 80):
            raise ValueError("checkpoint geometry")
        w = cls(g["columns"], g["rows"])
        # Replay only the parser continuation on a disposable screen, then
        # restore the full screen. CSI embedded controls are not applied twice.
        w.screen.scroll_on_clear = False
        pyte.Stream.feed(w.stream, state["escape"])
        w.screen.__dict__.update(unpack_state(state["screen"], w.screen))
        if (w.screen.columns, w.screen.lines) != (g["columns"], g["rows"]):
            raise ValueError("checkpoint geometry mismatch")
        w.stream.use_utf8 = state["useUtf8"]
        w.stream.utf8_decoder.setstate((bytes(state["utf8"][0]), state["utf8"][1]))
        for k in ("gen", "packet_seq", "scroll_ordinal", "dcs_state", "dcs_sixel", "dcs_intermediate"):
            setattr(w, k, state["worker"][k])
        w.screen.on_scroll = w._on_scroll
        w.screen.on_history_clear = w._on_history_clear
        w.scrolls = []
        return w

    def contract_state(self):
        s = self.screen
        def cursor(c): return {"x": c.x, "y": c.y, "visible": not c.hidden}
        def buffer(rows, c):
            saved = s.savepoints[-1].cursor if s.savepoints else c
            return {"rows": [contract_row(encode_row(rows[y], s.columns, s.default_char),
                        row_wrapped(rows[y]), row_padded(rows[y], s.columns)) for y in range(s.lines)],
                    "cursor": cursor(c), "savedCursor": cursor(saved),
                    "savedAttributes": contract_style(saved.attrs.fg, saved.attrs.bg,
                        sum(int(getattr(saved.attrs, key)) << i for i, key in enumerate(
                            ("bold", "italics", "underscore", "strikethrough", "reverse", "blink")))),
                    "savedModes": {}, "wrapPending": c.x >= s.columns}
        from collections import defaultdict
        from pyte.screens import StaticDefaultDict, Cursor
        empty = defaultdict(lambda: StaticDefaultDict(s.default_char))
        current = buffer(s.buffer, s.cursor)
        normal_cursor = s.cursor
        if s.alt and s.saved_normal[1] is not None:
            x, y, attrs, hidden = s.saved_normal[1]
            normal_cursor = Cursor(x, y, attrs); normal_cursor.hidden = hidden
        normal = buffer(s.saved_normal[0], normal_cursor) if s.alt else current
        alternate = current if s.alt else buffer(empty, Cursor(0, 0))
        return {"codecVersion": CHECKPOINT_CODEC, "geometry": {"columns": s.columns, "rows": s.lines},
                "normal": normal, "alternate": alternate, "active": "alternate" if s.alt else "normal",
                "modes": {str(m): True for m in sorted(s.mode)},
                "margins": {"top": s.margins.top if s.margins else 0,
                            "bottom": s.margins.bottom if s.margins else s.lines-1, "left": 0, "right": s.columns-1},
                "tabStops": sorted(s.tabstops), "pendingUtf8": list(self.stream.utf8_decoder.getstate()[0]),
                "pendingEscape": list(self.stream.pending_sequence.encode("utf-8")),
                "attributes": contract_style(s.cursor.attrs.fg, s.cursor.attrs.bg,
                    sum(int(getattr(s.cursor.attrs, key)) << i for i, key in enumerate(
                        ("bold", "italics", "underscore", "strikethrough", "reverse", "blink")))),
                "wrapPending": s.cursor.x >= s.columns,
                "extensionState": json.dumps(self.export_checkpoint(), ensure_ascii=False, separators=(",", ":"))}

    def reset_stages(self):
        self.in_frames = 0
        self.in_bytes = 0
        self.batch_ns = None
        self.first_rx_ns = None
        self.wait_ns = 0
        self.max_wait_ns = 0
        self.read_lag_ns = 0
        self.read_lag_max_ns = 0

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
            "packetEpoch": s.epoch,
            "packetSeq": self.packet_seq,
            "scrollOrdinal": self.scroll_ordinal if self.packet_seq is not None else None,
            "row": encode_row(row, s.columns, s.default_char),
            "wrap": row_wrapped(row),
            "pad": row_padded(row, s.columns),
            "gen": self.gen,
            "seq": getattr(row, "origin_seq", self.seq_to),
            "epoch": getattr(row, "epoch", s.epoch),
        })

        self.scroll_ordinal += 1
        if self.transaction_scroll_bytes is not None:
            item = self.scrolls[-1]
            # Charge expanded cells, not compressed runs. Stop while speculative,
            # before any journal ACK or live parser mutation; caller bisects input.
            expanded = contract_row(item["row"], item["wrap"], item["pad"])
            self.transaction_scroll_bytes += len(json.dumps(expanded).encode()) * 4
            if self.transaction_scroll_bytes > 512 * 1024:
                raise CaptureExpansionPressure()

    def feed(self, seq, epoch, data, rx=None, more=False):
        """Feed one D frame, or its first slice when `more` slices follow.

        Returns False when the rest of the frame must be dropped (SIXEL).
        """
        self.packet_seq = seq
        self.scroll_ordinal = 0
        self.screen.epoch = epoch
        self.screen.receive_seq = seq
        if self.seq_from is None:
            self.seq_from = seq
        self.seq_to = seq
        t = time.monotonic_ns()
        if self.batch_ns is None:
            self.batch_ns = t
        waited = 0 if rx is None else max(0, t - rx[0])
        if self.first_rx_ns is None:
            self.first_rx_ns = t if rx is None else rx[0]
            self.wait_ns = waited
            if rx is not None:
                self.read_lag_ns, self.read_lag_max_ns = rx[1], rx[2]
        self.max_wait_ns = max(self.max_wait_ns, waited)
        self.in_frames += 1
        return self.feed_more(data, t)

    def feed_more(self, data, t=None):
        """Continue the D frame begun by feed(); stage counters are per frame."""
        if t is None:
            t = time.monotonic_ns()
        self.in_bytes += len(data)
        data = self.filter_dcs(data)
        if data is not None:
            self.stream.feed(data)
        self.parse_ns += time.monotonic_ns() - t
        return data is not None

    def coalesce_due(self):
        """One 60 Hz frame of parsing (or 256 KiB) since the batch began."""
        return self.batch_ns is not None and (
            time.monotonic_ns() - self.batch_ns >= MAX_COALESCE_NS or self.in_bytes >= MAX_COALESCE_BYTES)

    def filter_dcs(self, data):
        """Consume DCS without exposing its payload to pyte (which lacks DCS).

        tmux 3.4 input.c's enter/parameter/intermediate/handler/escape states
        distinguish queries and passthrough from SIXEL. Keep only constant
        state, including across input packets; an ignored string can be huge.
        ESC inside a payload quotes the next byte unless it is ST (ESC \\).
        """
        out = bytearray()
        for ch in data:
            state = self.dcs_state
            if state == "ground":
                if ch == 0x1b:
                    self.dcs_state = "escape"
                else:
                    out.append(ch)
            elif state == "escape":
                if ch == ord("P"):
                    self.dcs_state = "enter"
                    self.dcs_intermediate = False
                    self.dcs_sixel = False
                else:
                    out.append(0x1b)
                    self.dcs_state = "escape" if ch == 0x1b else "ground"
                    if ch != 0x1b:
                        out.append(ch)
            elif state in ("body", "body-escape"):
                if state == "body-escape":
                    if ch == ord("\\"):
                        self.dcs_state = "ground"
                        if self.dcs_sixel:
                            # Publish pre-DCS text, then require source recovery.
                            self.stream.feed(bytes(out))
                            self.emit(ack=False)
                            send(b"E", {"kind": "unsupported-sixel", "message": "DCS/SIXEL may scroll history; parser does not support it; source recovery required"})
                            return None
                    else:
                        self.dcs_state = "body"
                elif ch == 0x1b:
                    self.dcs_state = "body-escape"
            elif ch in (0x18, 0x1a):  # CAN/SUB cancel a header, not a body.
                self.dcs_state = "ground"
            elif ch == 0x1b:
                self.dcs_state = "escape"
            elif state == "ignore":
                pass
            elif ch < 0x20 or ch >= 0x7f:
                pass
            elif 0x20 <= ch <= 0x2f:
                self.dcs_intermediate = True
                self.dcs_state = "intermediate"
            elif 0x30 <= ch <= 0x3f:
                if state == "intermediate" or ch == 0x3a or (state == "parameter" and ch >= 0x3c):
                    self.dcs_state = "ignore"
                else:
                    if ch >= 0x3c:
                        self.dcs_intermediate = True
                    self.dcs_state = "parameter"
            else:  # Final byte; +q (XTGETTCAP) and $q (DECRQSS) are queries.
                self.dcs_sixel = ch == ord("q") and not self.dcs_intermediate
                self.dcs_state = "body"
        return bytes(out)

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
            "epoch": s.epoch,
            "scrollOnClear": s.scroll_on_clear,
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
            "stages": {
                "inFrames": self.in_frames,
                "inBytes": self.in_bytes,
                "waitNs": self.wait_ns,
                "maxWaitNs": self.max_wait_ns,
                "holdNs": 0 if self.first_rx_ns is None else max(0, t - self.first_rx_ns),
                "readLagNs": self.read_lag_ns,
                "readLagMaxNs": self.read_lag_max_ns,
            },
        }, timed=True)
        s.dirty.clear()
        s.shift = 0
        if ack:
            self.emitted_seq = self.seq_to
            # Partial (ack=False) emits leave the D frames to the next ack.
            self.reset_stages()
        self.scrolls = []
        self.seq_from = None
        self.full = False
        self.parse_ns = 0


def contract_style(fg, bg, attrs):
    result = [0]
    names = ["black", "red", "green", "brown", "blue", "magenta", "cyan", "white"]
    for color, base in ((fg, 30), (bg, 40)):
        if color == "default": continue
        if color in names: result.append(base + names.index(color))
        elif color.startswith("bright") and color[6:] in names: result.append(base + 60 + names.index(color[6:]))
        elif re.fullmatch("[0-9a-fA-F]{6}", color):
            result.extend([base + 8, 2] + [int(color[i:i+2], 16) for i in (0, 2, 4)])
        else: raise ValueError("unsupported checkpoint color")
    for bit, code in enumerate((1, 3, 4, 9, 7, 5)):
        if attrs & (1 << bit): result.append(code)
    return result

def contract_row(runs, wrap, pad):
    cells = []
    for fg, bg, attrs, text in runs:
        style = contract_style(fg, bg, attrs)
        for ch in text:
            cells.append({"text": ch, "width": 0 if ch == "" else 1, "style": style})
    for i in range(len(cells)-1):
        if cells[i]["text"] and cells[i+1]["text"] == "": cells[i]["width"] = 2
    return {"cells": cells, "softWrap": wrap, "wrapPad": int(pad), "uncertainFields": []}

class CaptureExpansionPressure(Exception):
    pass


# A cursor is an ordinal in a deterministic replay of ONE immutable request.
# No suspended Python generator, live worker, history list or token registry is
# retained between RPCs. Replaying skips old rows before encoding them. This
# trades CPU for bounded memory and permits retries after worker replacement.
class CaptureRowPageFull(Exception):
    pass


class CaptureRowPage:
    def __init__(self, worker, options):
        self.worker = worker
        self.start = options["startOrdinal"]
        self.cap = options["maxBytes"]
        if type(self.start) is not int or not 0 <= self.start <= 9007199254740991:
            raise ValueError("row cursor")
        if type(self.cap) is not int or not 8 <= self.cap <= 512 * 1024:
            raise ValueError("row page budget")
        self.ordinal = 0
        self.rows = []
        self.peak = 8
        self.charge = 8  # [] JSON, four copies including encoding/IPC scratch

    def collect(self, row):
        ordinal = self.ordinal
        self.ordinal += 1
        self.worker.scroll_ordinal += 1
        if ordinal < self.start:
            return
        if len(self.rows) >= 256:
            raise CaptureRowPageFull()
        s = self.worker.screen
        # Check text before encode_row/contract_row can copy an oversized cell.
        # Geometry is capped separately; this scan retains no per-cell list.
        row_bound = 256
        for x in range(s.columns):
            text = row[x].data
            if len(text) > self.cap:
                raise CaptureExpansionPressure()
            # JSON escaping is at most six bytes per input byte. SGR/cell
            # fields and runs fit the fixed overhead per column in this codec.
            row_bound += 4 * (len(text.encode("utf-8")) * 6 + 256)
            if row_bound > self.cap - 8:
                raise CaptureExpansionPressure()
        if self.charge + row_bound > self.cap:
            raise CaptureRowPageFull()
        self.peak = max(self.peak, self.charge + row_bound)
        content = contract_row(encode_row(row, s.columns, s.default_char),
                               row_wrapped(row), row_padded(row, s.columns))
        charge = len(json.dumps(content, ensure_ascii=False, separators=(",", ":")).encode()) * 4
        charge += 4 if self.rows else 0  # comma
        if self.charge + charge > self.cap:
            if not self.rows:
                raise CaptureExpansionPressure()  # single row exceeds envelope
            raise CaptureRowPageFull()
        self.rows.append(content)
        self.charge += charge

    def result(self, complete):
        if complete and self.ordinal < self.start:
            raise ValueError("row cursor past end")
        return {"scrolls": self.rows, "startOrdinal": self.start,
                "nextOrdinal": self.start + len(self.rows),
                "chargedBytes": self.charge, "peakBytes": self.peak, "complete": complete}


def checkpoint_transaction(request):
    state = request.get("state")
    identity = request["identity"]
    if state is None:
        g = request["geometry"]
        if not (0 < g["columns"] <= 240 and 0 < g["rows"] <= 80): raise ValueError("geometry budget")
        w = Worker(g["columns"], g["rows"], identity["sourceEpoch"])
        w.gen = identity["geometryGeneration"]
        w.screen.scroll_on_clear = request["scrollOnClear"]
    else:
        if state["codecVersion"] != CHECKPOINT_CODEC: raise ValueError("checkpoint codec")
        w = Worker.from_checkpoint(json.loads(state["extensionState"]))
        if w.contract_state() != state: raise ValueError("checkpoint envelope mismatch")
    w.transaction_scroll_bytes = 0
    page = CaptureRowPage(w, request["rowStream"]) if "rowStream" in request else None
    if page is not None:
        # Replace the hook BEFORE feeding even one byte. The old hook accumulates
        # a packet and cannot pause halfway through erase/reset/scroll/reflow.
        w.screen.on_scroll = page.collect
    event = request.get("event")
    try:
        apply_checkpoint_event(w, event, identity)
    except CaptureRowPageFull:
        return page.result(False)
    state = w.contract_state(); active = state[state["active"]]
    result = {"state": state, "scrolls": [contract_row(r["row"], r["wrap"], r["pad"]) for r in w.scrolls],
            "frame": {"identity": identity, "screenRevision": request["screenRevision"],
                      "buffer": state["active"], "geometry": state["geometry"],
                      "changedRows": [{"y": y, "content": row} for y, row in enumerate(active["rows"])],
                      "cursor": active["cursor"], "overlap": None}}
    if page is not None:
        result.update(page.result(True))
    return result


def apply_checkpoint_event(w, event, identity):
    if event:
        p = event["payload"]; pos = event["position"]
        if p["kind"] == "bytes":
            if len(p["bytes"]) > 16384: raise ValueError("input cap")
            if not w.feed(pos["packetSeq"], pos["sourceEpoch"], bytes(p["bytes"])):
                raise ValueError("unsupported parser input")
        elif p["kind"] == "resize":
            g = p["geometry"]
            if not (0 < g["columns"] <= 240 and 0 < g["rows"] <= 80): raise ValueError("resize budget")
            w.packet_seq = pos["packetSeq"]; w.scroll_ordinal = 0
            w.resize(p["geometry"]["columns"], p["geometry"]["rows"], identity["geometryGeneration"])
        elif p["kind"] == "control" and p["name"] == "scroll-on-clear" and p["data"] in ("true", "false"):
            w.screen.scroll_on_clear = p["data"] == "true"
        else: raise ValueError("unsupported input control")


def dispatch(worker, kind, payload, rx=None):
    """The same ordered command implementation for dedicated and shared parsers."""
    if kind == b"J":
        if len(payload) > 4 * 1024 * 1024: raise ValueError("transaction request cap")
        request = json.loads(payload)
        # Isolate speculative history-clear/update events from live consumers.
        global output_sink
        previous_sink = output_sink
        try:
            output_sink = lambda packet: None
            try:
                result = checkpoint_transaction(request)
            except CaptureExpansionPressure:
                result = {"pressure": True}
        finally:
            output_sink = previous_sink
        send(b"J", result)
    elif kind == b"D":
        seq, epoch = struct.unpack(">QQ", payload[:16])
        worker.feed(seq, epoch, payload[16:], rx)
    elif kind == b"C":
        worker.screen.scroll_on_clear = bool(payload[0])
    elif kind == b"X":
        worker.packet_seq = None
        worker.screen.preserve_on_clear()
        if worker.pending():
            worker.emit()
        old = worker
        worker = Worker(old.screen.columns, old.screen.lines, struct.unpack(">Q", payload)[0])
        worker.gen = old.gen
        worker.screen.scroll_on_clear = old.screen.scroll_on_clear
        worker.seq_to = old.seq_to
        worker.emitted_seq = old.emitted_seq
        worker.emit()
    elif kind == b"V":
        seq, epoch, cols, rows, gen = struct.unpack(">QQHHI", payload)
        if not (0 < seq <= 9007199254740991 and epoch <= 9007199254740991
                and 0 < cols <= 240 and 0 < rows <= 80):
            raise ValueError("stream resize identity/geometry budget")
        worker.packet_seq = seq
        worker.scroll_ordinal = 0
        worker.screen.epoch = epoch
        worker.screen.receive_seq = seq
        if worker.seq_from is None:
            worker.seq_from = seq
        worker.seq_to = seq
        worker.resize(cols, rows, gen)
    elif kind == b"Z":
        worker.packet_seq = None
        worker.resize(*struct.unpack(">HHI", payload[:8]))
    elif kind == b"F":
        worker.full = True
        seq = struct.unpack(">Q", payload[:8])[0]
        worker.seq_to = seq if worker.seq_to is None else worker.seq_to
    elif kind == b"Q":
        return worker, True
    else:
        raise ValueError(f"unknown frame {kind!r}")
    return worker, False


def multiplex(path):
    """Single-threaded fair selector; each connection owns parser and buffers.

    A channel turn feeds at most MAX_TURN_NS of parser work, a D frame in
    slices (slice_end) if need be; the unfinished frame stays in "partial" and
    resumes first on the channel's next turn, so commands keep their order and
    no update acknowledges a frame before all of it was fed. Updates coalesce
    while the channel has more complete input, up to one 60 Hz frame of work.
    Slow consumers only stop reads on their own socket. No shared stdout queue
    can block healthy panes. A parser exception closes just that channel after
    an E marker; interpreter death closes ALL channels (host marks each pane).
    """
    import socket
    global output_sink
    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    server.bind(path)
    os.chmod(path, 0o600)
    server.listen(128)
    server.setblocking(False)
    channels = {}
    control_fd = sys.stdin.buffer.fileno()
    high_water = 1024 * 1024
    max_input = high_water + 65536 + 21
    read_ahead = 65536

    def complete(c):
        b = c["input"]
        return len(b) >= 5 and len(b) >= 5 + struct.unpack(">I", b[1:5])[0]

    def drop(sock):
        channels.pop(sock, None)
        sock.close()

    print("MULTIPLEX_READY", flush=True)
    polled_before = time.monotonic_ns()
    try:
        while True:
            readable = [server, control_fd]
            writable = []
            runnable = False
            for sock, c in channels.items():
                if not c["closing"] and len(c["output"]) < high_water:
                    runnable = runnable or c["partial"] is not None or complete(c)
                    # Read ahead at most one recv of unparsed input (more only to
                    # finish a frame): short turns must not pull the backlog out
                    # of the socket, where the host's data budget bounds it.
                    if len(c["input"]) < read_ahead or not complete(c):
                        readable.append(sock)
                if c["output"]:
                    writable.append(sock)
            called = time.monotonic_ns()
            reads, writes, _ = select.select(readable, writable, [], 0 if runnable else None)
            # If select blocked, any readable channel became readable as it woke
            # (earlier bytes would have woken it earlier). Otherwise the bytes
            # arrived after the previous poll returned, provided the previous
            # read drained the socket: a 64 KiB-capped read can leave older
            # bytes behind, which this bound then understates.
            polled = time.monotonic_ns()
            since = polled if polled - called >= 1_000_000 else polled_before
            polled_before = polled
            if control_fd in reads and not os.read(control_fd, 1024):
                return  # Parent died: close all channels, leave no orphan interpreter.
            if server in reads:
                sock, _ = server.accept()
                sock.setblocking(False)
                channels[sock] = {"input": bytearray(), "output": bytearray(), "worker": None, "closing": False,
                                  "rx": RxClock(), "partial": None}
            for sock, c in list(channels.items()):
                output_sink = c["output"].extend
                try:
                    if sock in writes:
                        n = sock.send(c["output"])
                        del c["output"][:n]
                    if sock in reads:
                        data = sock.recv(read_ahead)
                        if not data:
                            drop(sock)
                            continue
                        c["input"].extend(data)
                        now = time.monotonic_ns()
                        c["rx"].arrived(len(data), now, now - polled, now - since)
                    buf = c["input"]
                    if not c["closing"] and len(buf) >= 5 and struct.unpack(">I", buf[1:5])[0] > max_input:
                        raise ValueError("pane input exceeds frame bound")
                    began = time.monotonic_ns()
                    processed = 0
                    while not c["closing"] and len(c["output"]) < high_water and (
                            c["partial"] is not None or complete(c)):
                        if c["partial"] is None:
                            kind = bytes(buf[:1])
                            length = struct.unpack(">I", buf[1:5])[0]
                            if length > max_input:
                                raise ValueError("pane input exceeds frame bound")
                            payload = bytes(buf[5:5 + length])
                            del buf[:5 + length]
                            rx = c["rx"].completed(5 + length)
                            if c["worker"] is None:
                                if kind != b"A":
                                    raise ValueError("pane must attach before data")
                                cols, rows, epoch = struct.unpack(">HHQ", payload)
                                if not (0 < cols <= 4096 and 0 < rows <= 4096):
                                    raise ValueError("invalid pane geometry")
                                c["worker"] = Worker(cols, rows, epoch)
                                send(b"R", {"vendorSha256": VENDOR_DIGEST, "cols": cols, "rows": rows, "pid": os.getpid()})
                            elif kind == b"D":
                                seq, epoch = struct.unpack(">QQ", payload[:16])
                                end = slice_end(payload, 16)
                                more = end < len(payload)
                                if c["worker"].feed(seq, epoch, payload[16:end], rx, more) and more:
                                    c["partial"] = [payload, end]
                                length = end
                            else:
                                c["worker"], c["closing"] = dispatch(c["worker"], kind, payload, rx)
                            processed += length
                        else:
                            payload, start = c["partial"]
                            end = slice_end(payload, start)
                            if c["worker"].feed_more(payload[start:end]) and end < len(payload):
                                c["partial"][1] = end
                            else:
                                c["partial"] = None
                            processed += end - start
                        if processed >= 65536 or time.monotonic_ns() - began >= MAX_TURN_NS:
                            break
                        if c["partial"] is None and c["worker"] is not None and c["worker"].coalesce_due():
                            break  # Emit at this frame boundary: a 60 Hz frame of work is due.
                    w = c["worker"]
                    if w is not None and c["partial"] is None and w.pending() and (
                            c["closing"] or not complete(c) or w.coalesce_due()):
                        w.emit()
                    if c["closing"] and not c.get("quit_ack"):
                        send(b"B", {"workerEof": True})
                        c["quit_ack"] = True
                    if c["closing"] and not c["output"]:
                        drop(sock)
                except (BrokenPipeError, ConnectionResetError):
                    drop(sock)
                except BlockingIOError:
                    pass
                except Exception as error:
                    # Never falsely acknowledge Q after a parser exception.
                    send(b"E", {"kind": "worker-error", "message": str(error)})
                    c["closing"] = True
                    c["quit_ack"] = True
                    c["worker"] = None
                    c["partial"] = None
                    c["input"].clear()
                finally:
                    output_sink = None
    finally:
        for sock in list(channels):
            drop(sock)
        server.close()


def main():
    cols = int(sys.argv[1]) if len(sys.argv) > 1 else 80
    rows = int(sys.argv[2]) if len(sys.argv) > 2 else 24
    worker = Worker(cols, rows, int(sys.argv[4]) if len(sys.argv) > 4 else 1)
    send(b"R", {"vendorSha256": VENDOR_DIGEST, "cols": cols, "rows": rows, "pid": os.getpid()})
    fd = os.open(sys.argv[3], os.O_RDONLY) if len(sys.argv) > 3 else sys.stdin.buffer.fileno()
    buf = bytearray()
    rx = RxClock()
    batch_started = None
    batch_bytes = 0
    eof = False
    returned = time.monotonic_ns()
    while not eof:
        called = time.monotonic_ns()
        chunk = os.read(fd, 1 << 16)
        if not chunk:
            eof = True
        buf.extend(chunk)
        # A read that blocked returned as its bytes arrived; one that did not
        # block got bytes that waited while the loop was busy since the
        # previous read returned (same 64 KiB-cap caveat as the multiplexer).
        previous, returned = returned, time.monotonic_ns()
        rx.arrived(len(chunk), returned, 0, 0 if returned - called >= 1_000_000 else returned - previous)
        while len(buf) >= 5:
            kind = bytes(buf[0:1])
            length = struct.unpack(">I", buf[1:5])[0]
            if len(buf) < 5 + length:
                break
            payload = bytes(buf[5:5 + length])
            del buf[:5 + length]
            rx_at = rx.completed(5 + length)
            if kind == b"D":
                if batch_started is None:
                    batch_started = time.monotonic_ns()
                batch_bytes += len(payload) - 16
            worker, eof = dispatch(worker, kind, payload, rx_at)
            if kind == b"X":
                batch_started = None
                batch_bytes = 0
            if eof:
                break
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
    # B is the ordered Q acknowledgement: it is emitted only after the final
    # update has been serialized to stdout. Process exit alone is not proof
    # that Q was parsed or that the final frame was preserved.
    send(b"B", {"workerEof": True})


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--multiplex":
        multiplex(sys.argv[2])
    else:
        main()
