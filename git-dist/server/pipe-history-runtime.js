import { createRequire } from "node:module";
var __defProp = Object.defineProperty;
var __returnValue = (v) => v;
function __exportSetter(name, newValue) {
  this[name] = __returnValue.bind(null, newValue);
}
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, {
      get: all[name],
      enumerable: true,
      configurable: true,
      set: __exportSetter.bind(all, name)
    });
};
var __esm = (fn, res) => () => (fn && (res = fn(fn = 0)), res);
var __require = /* @__PURE__ */ createRequire(import.meta.url);

// src/sqlite-history/schema.ts
var SCHEMA_VERSION = 1, SCHEMA = `
CREATE TABLE history_session (
  session_id TEXT PRIMARY KEY,
  lifecycle_key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  group_label TEXT NOT NULL,
  active INTEGER NOT NULL CHECK (active IN (0,1)),
  writer_fence INTEGER NOT NULL DEFAULT 0 CHECK (writer_fence >= 0),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  first_line INTEGER NOT NULL DEFAULT 0,
  next_line INTEGER NOT NULL DEFAULT 0,
  live_start INTEGER NOT NULL DEFAULT 0,
  last_probe_at INTEGER,
  last_commit_at INTEGER,
  continuity TEXT NOT NULL DEFAULT 'unknown'
    CHECK (continuity IN ('verified','unknown','gap','failed')),
  CHECK (0 <= first_line AND first_line <= live_start
         AND live_start <= next_line AND next_line <= 9007199254740991)
) STRICT;
CREATE UNIQUE INDEX history_active_name ON history_session(name) WHERE active=1;

CREATE TABLE history_capture (
  session_id TEXT NOT NULL REFERENCES history_session(session_id),
  seq INTEGER NOT NULL CHECK (seq > 0),
  request_id TEXT NOT NULL,
  previous_seq INTEGER NOT NULL CHECK (previous_seq = seq-1),
  at REAL NOT NULL,
  geometry_json TEXT NOT NULL,
  screen_json TEXT NOT NULL,
  row_start INTEGER NOT NULL,
  row_end INTEGER NOT NULL,
  first_line INTEGER NOT NULL,
  live_start INTEGER NOT NULL,
  next_line INTEGER NOT NULL,
  expected_rows INTEGER NOT NULL,
  rows_sha256 TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  unresolved_capture BLOB,
  PRIMARY KEY (session_id,seq),
  UNIQUE (session_id,request_id),
  CHECK (0 <= row_start AND row_start <= row_end),
  CHECK (expected_rows = row_end-row_start),
  CHECK (0 <= first_line AND first_line <= live_start
         AND live_start <= next_line AND row_end <= next_line)
) STRICT, WITHOUT ROWID;

CREATE TABLE history_line (
  session_id TEXT NOT NULL,
  line_no INTEGER NOT NULL CHECK (line_no >= 0 AND line_no <= 9007199254740991),
  kind TEXT NOT NULL CHECK (kind IN ('terminal','gap')),
  text TEXT NOT NULL,
  capture_seq INTEGER NOT NULL,
  capture_row INTEGER NOT NULL CHECK (capture_row >= 0),
  PRIMARY KEY (session_id,line_no),
  UNIQUE (session_id,capture_seq,capture_row),
  FOREIGN KEY (session_id,capture_seq) REFERENCES history_capture(session_id,seq)
) STRICT, WITHOUT ROWID;

CREATE TABLE history_frame (
  session_id TEXT NOT NULL REFERENCES history_session(session_id),
  frame_seq INTEGER NOT NULL CHECK (frame_seq > 0),
  at REAL NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('output','delta')),
  record_json TEXT NOT NULL,
  capture_seq INTEGER,
  PRIMARY KEY (session_id,frame_seq),
  FOREIGN KEY (session_id,capture_seq) REFERENCES history_capture(session_id,seq)
) STRICT, WITHOUT ROWID;
CREATE INDEX history_full_checkpoint
  ON history_frame(session_id,frame_seq) WHERE kind='output';

CREATE TABLE history_issue (
  issue_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES history_session(session_id),
  capture_seq INTEGER,
  kind TEXT NOT NULL,
  detected_at INTEGER NOT NULL,
  boundary_line INTEGER,
  missing_count INTEGER CHECK (missing_count IS NULL OR missing_count >= 0),
  evidence_json TEXT NOT NULL,
  resolved_at INTEGER,
  FOREIGN KEY (session_id,capture_seq) REFERENCES history_capture(session_id,seq)
) STRICT;
CREATE INDEX history_open_issue
  ON history_issue(session_id,detected_at) WHERE resolved_at IS NULL;

CREATE TABLE history_import (
  source_id TEXT PRIMARY KEY,
  session_id TEXT REFERENCES history_session(session_id),
  source_path TEXT NOT NULL,
  format TEXT NOT NULL,
  snapshot_sha256 TEXT NOT NULL,
  snapshot_bytes INTEGER NOT NULL CHECK (snapshot_bytes >= 0),
  byte_cursor INTEGER NOT NULL DEFAULT 0,
  record_cursor INTEGER NOT NULL DEFAULT 0,
  imported_records INTEGER NOT NULL DEFAULT 0,
  imported_sha256 TEXT,
  state TEXT NOT NULL CHECK (state IN ('pending','copying','verified','quarantined')),
  evidence_json TEXT NOT NULL,
  CHECK (0 <= byte_cursor AND byte_cursor <= snapshot_bytes)
) STRICT;
`, GUARDS = `
CREATE TRIGGER line_append BEFORE INSERT ON history_line BEGIN
 SELECT CASE WHEN NEW.line_no != (SELECT next_line FROM history_session WHERE session_id=NEW.session_id)
 THEN RAISE(ABORT,'append-order') END;
 SELECT CASE WHEN NEW.capture_seq != (SELECT revision+1 FROM history_session WHERE session_id=NEW.session_id)
 THEN RAISE(ABORT,'append-revision') END;
END;
CREATE TRIGGER line_advance AFTER INSERT ON history_line BEGIN
 UPDATE history_session SET next_line=next_line+1 WHERE session_id=NEW.session_id;
END;
CREATE TRIGGER line_immutable BEFORE UPDATE ON history_line BEGIN
 SELECT RAISE(ABORT,'immutable-line');
END;
CREATE TRIGGER line_delete BEFORE DELETE ON history_line WHEN OLD.line_no >=
 (SELECT first_line FROM history_session WHERE session_id=OLD.session_id) BEGIN
 SELECT RAISE(ABORT,'retention-disabled');
END;
CREATE TRIGGER floor_immutable BEFORE UPDATE OF first_line ON history_session
 WHEN NEW.first_line != OLD.first_line BEGIN SELECT RAISE(ABORT,'retention-disabled'); END;
CREATE TRIGGER capture_immutable BEFORE UPDATE ON history_capture BEGIN
 SELECT RAISE(ABORT,'immutable-capture'); END;
CREATE TRIGGER capture_append BEFORE INSERT ON history_capture BEGIN
 SELECT CASE WHEN NEW.seq != (SELECT revision+1 FROM history_session WHERE session_id=NEW.session_id)
 OR NEW.row_start != (SELECT next_line FROM history_session WHERE session_id=NEW.session_id)
 THEN RAISE(ABORT,'capture-order') END;
END;
CREATE TRIGGER receipt_commit BEFORE UPDATE OF revision ON history_session
 WHEN NEW.revision != OLD.revision BEGIN
 SELECT CASE WHEN NEW.revision != OLD.revision+1 OR NOT EXISTS (
 SELECT 1 FROM history_capture c WHERE c.session_id=NEW.session_id AND c.seq=NEW.revision
 AND c.previous_seq=OLD.revision AND c.row_end=NEW.next_line
 AND c.first_line=NEW.first_line AND c.live_start=NEW.live_start AND c.next_line=NEW.next_line
 AND c.expected_rows=(SELECT count(*) FROM history_line l WHERE l.session_id=c.session_id AND l.capture_seq=c.seq)
 AND (c.expected_rows=0 OR (
 c.row_start=(SELECT min(line_no) FROM history_line l WHERE l.session_id=c.session_id AND l.capture_seq=c.seq)
 AND c.row_end-1=(SELECT max(line_no) FROM history_line l WHERE l.session_id=c.session_id AND l.capture_seq=c.seq)
 AND 0=(SELECT min(capture_row) FROM history_line l WHERE l.session_id=c.session_id AND l.capture_seq=c.seq)
 AND c.expected_rows-1=(SELECT max(capture_row) FROM history_line l WHERE l.session_id=c.session_id AND l.capture_seq=c.seq))))
 THEN RAISE(ABORT,'receipt-mismatch') END;
END;
CREATE TRIGGER frame_append BEFORE INSERT ON history_frame BEGIN
 SELECT CASE WHEN NEW.frame_seq != coalesce((SELECT max(frame_seq)+1 FROM history_frame WHERE session_id=NEW.session_id),1)
 THEN RAISE(ABORT,'frame-order') END;
END;
CREATE TRIGGER frame_immutable BEFORE UPDATE ON history_frame BEGIN SELECT RAISE(ABORT,'immutable-frame'); END;
`, PROJECTION_SCHEMA_MARKERS, PROJECTION_SCHEMA_VERSION = 5, PROJECTION_MIGRATION = "005-newarch-compact-capture-receipts", PROJECTION_STORE_FILE = "newarch-v5/history.sqlite3", PROJECTION_LEGACY_FILES, CHECK_STATES, CHECK_REASONS, PROJECTION_SCHEMA = `
CREATE TABLE na_pane (
 pane_no INTEGER PRIMARY KEY, pane_key TEXT NOT NULL UNIQUE, session_uuid TEXT NOT NULL, server_identity TEXT NOT NULL,
 pane_id TEXT NOT NULL, birth_generation INTEGER NOT NULL, source_epoch INTEGER NOT NULL,
 geometry_generation INTEGER NOT NULL, cols INTEGER NOT NULL, rows INTEGER NOT NULL,
 screen_kind TEXT NOT NULL CHECK(screen_kind IN ('normal','alternate')),
 next_line_id INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 0,
 durable_revision INTEGER NOT NULL DEFAULT 0, health TEXT NOT NULL DEFAULT 'healthy',
 receive_seq INTEGER NOT NULL DEFAULT -1,
 CHECK(durable_revision<=revision AND next_line_id>=0)
) STRICT;
CREATE TABLE na_capture (
 pane_no INTEGER NOT NULL REFERENCES na_pane(pane_no), capture_id TEXT NOT NULL,
 revision INTEGER NOT NULL, source_epoch INTEGER NOT NULL, requested_at REAL NOT NULL,
 completed_at REAL NOT NULL, geometry_generation INTEGER NOT NULL,
 first_history_row INTEGER NOT NULL, history_count INTEGER NOT NULL,
 screen_hash BLOB NOT NULL, history_hash BLOB NOT NULL,
 observed_fields ANY NOT NULL,
 compared_rows INTEGER NOT NULL, corrected_cells INTEGER NOT NULL, ambiguous_rows INTEGER NOT NULL,
 result TEXT NOT NULL, PRIMARY KEY(pane_no,capture_id),
 UNIQUE(pane_no,capture_id,source_epoch,geometry_generation)
) STRICT, WITHOUT ROWID;
CREATE TABLE na_line (
 pane_no INTEGER NOT NULL REFERENCES na_pane(pane_no), source_epoch INTEGER NOT NULL,
 line_id INTEGER NOT NULL, revision INTEGER NOT NULL, geometry_generation INTEGER NOT NULL,
 text TEXT NOT NULL, cells TEXT NOT NULL, soft_wrap INTEGER NOT NULL CHECK(soft_wrap IN(0,1)),
 check_state INTEGER NOT NULL CHECK(check_state IN(0,1,2)), check_reason INTEGER NOT NULL CHECK(check_reason BETWEEN 0 AND 3),
 checked_capture_id TEXT, checked_row INTEGER,
 PRIMARY KEY(pane_no,line_id),
 FOREIGN KEY(pane_no,checked_capture_id,source_epoch,geometry_generation)
 REFERENCES na_capture(pane_no,capture_id,source_epoch,geometry_generation),
 CHECK((check_state=0 AND checked_capture_id IS NULL AND checked_row IS NULL)
 OR (check_state IN(1,2) AND checked_capture_id IS NOT NULL AND checked_row>=0))
) STRICT, WITHOUT ROWID;
CREATE TABLE na_block (
 block_no INTEGER PRIMARY KEY, pane_no INTEGER NOT NULL REFERENCES na_pane(pane_no),
 first_line_id INTEGER NOT NULL, line_count INTEGER NOT NULL CHECK(line_count BETWEEN 1 AND 4096),
 max_revision INTEGER NOT NULL, data BLOB NOT NULL, UNIQUE(pane_no,first_line_id)
) STRICT;
CREATE TABLE na_capture_archive (
 archive_no INTEGER PRIMARY KEY, pane_no INTEGER NOT NULL REFERENCES na_pane(pane_no),
 first_revision INTEGER NOT NULL, last_revision INTEGER NOT NULL,
 capture_count INTEGER NOT NULL CHECK(capture_count BETWEEN 1 AND 256),
 catalog BLOB NOT NULL, data BLOB NOT NULL,
 UNIQUE(pane_no,first_revision), CHECK(first_revision<=last_revision)
) STRICT;
CREATE TABLE na_issue (
 issue_id TEXT PRIMARY KEY, pane_key TEXT NOT NULL REFERENCES na_pane(pane_key), source_epoch INTEGER NOT NULL,
 revision INTEGER NOT NULL, boundary_line_id INTEGER, kind TEXT NOT NULL, reason TEXT NOT NULL,
 missing_count INTEGER, detected_at REAL NOT NULL, resolved_at REAL
) STRICT;
CREATE TABLE na_commit (
 commit_id TEXT PRIMARY KEY, commit_seq INTEGER NOT NULL, revision INTEGER NOT NULL, committed_at REAL NOT NULL,
 pane_watermarks_json TEXT NOT NULL, digest TEXT NOT NULL
) STRICT;
`, PROJECTION_V3_SCHEMA = `
CREATE TABLE na_pane (
 pane_key TEXT PRIMARY KEY, session_uuid TEXT NOT NULL, server_identity TEXT NOT NULL,
 pane_id TEXT NOT NULL, birth_generation INTEGER NOT NULL, source_epoch INTEGER NOT NULL,
 geometry_generation INTEGER NOT NULL, cols INTEGER NOT NULL, rows INTEGER NOT NULL,
 screen_kind TEXT NOT NULL CHECK(screen_kind IN ('normal','alternate')),
 next_line_id INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 0,
 durable_revision INTEGER NOT NULL DEFAULT 0, health TEXT NOT NULL DEFAULT 'healthy',
 receive_seq INTEGER NOT NULL DEFAULT -1,
 CHECK(durable_revision<=revision AND next_line_id>=0)
) STRICT;
CREATE TABLE na_capture (
 pane_key TEXT NOT NULL REFERENCES na_pane(pane_key), capture_id TEXT NOT NULL,
 revision INTEGER NOT NULL, source_epoch INTEGER NOT NULL, requested_at REAL NOT NULL,
 completed_at REAL NOT NULL, geometry_generation INTEGER NOT NULL,
 first_history_row INTEGER NOT NULL, history_count INTEGER NOT NULL,
 screen_hash TEXT NOT NULL, history_hash TEXT NOT NULL,
 observed_fields_json TEXT NOT NULL,
 compared_rows INTEGER NOT NULL, corrected_cells INTEGER NOT NULL, ambiguous_rows INTEGER NOT NULL,
 result TEXT NOT NULL, PRIMARY KEY(pane_key,capture_id),
 UNIQUE(pane_key,capture_id,source_epoch,geometry_generation)
) STRICT;
CREATE TABLE na_line (
 pane_key TEXT NOT NULL REFERENCES na_pane(pane_key), source_epoch INTEGER NOT NULL,
 line_id INTEGER NOT NULL, revision INTEGER NOT NULL, geometry_generation INTEGER NOT NULL,
 text TEXT NOT NULL, cells_json TEXT NOT NULL, soft_wrap INTEGER NOT NULL CHECK(soft_wrap IN(0,1)),
 check_state TEXT NOT NULL CHECK(check_state IN('unchecked','checked','content-matched')), check_reason TEXT NOT NULL,
 checked_capture_id TEXT, checked_row INTEGER,
 PRIMARY KEY(pane_key,line_id),
 FOREIGN KEY(pane_key,checked_capture_id,source_epoch,geometry_generation)
 REFERENCES na_capture(pane_key,capture_id,source_epoch,geometry_generation),
 CHECK((check_state='unchecked' AND checked_capture_id IS NULL AND checked_row IS NULL)
 OR (check_state IN('checked','content-matched') AND checked_capture_id IS NOT NULL AND checked_row>=0))
) STRICT, WITHOUT ROWID;
CREATE TABLE na_issue (
 issue_id TEXT PRIMARY KEY, pane_key TEXT NOT NULL REFERENCES na_pane(pane_key), source_epoch INTEGER NOT NULL,
 revision INTEGER NOT NULL, boundary_line_id INTEGER, kind TEXT NOT NULL, reason TEXT NOT NULL,
 missing_count INTEGER, detected_at REAL NOT NULL, resolved_at REAL
) STRICT;
CREATE TABLE na_commit (
 commit_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, committed_at REAL NOT NULL,
 pane_watermarks_json TEXT NOT NULL, digest TEXT NOT NULL
) STRICT;
`, PROJECTION_RAM_SCREEN_SCHEMA = `
CREATE INDEX na_line_pending_revision ON na_line(pane_no,revision);
CREATE TABLE na_screen (
 pane_key TEXT NOT NULL REFERENCES na_pane(pane_key), pane_no INTEGER NOT NULL, screen_kind TEXT NOT NULL,
 revision INTEGER NOT NULL, geometry_generation INTEGER NOT NULL, cols INTEGER NOT NULL, rows INTEGER NOT NULL,
 cells_json TEXT NOT NULL, cursor_json TEXT NOT NULL, last_capture_id TEXT, captured_at REAL,
 display_source TEXT NOT NULL CHECK(display_source IN('pipe','tmux-calibrated')), observed_fields_json TEXT NOT NULL,
 uncertain_rows_json TEXT NOT NULL DEFAULT '[]',
 PRIMARY KEY(pane_key,screen_kind), FOREIGN KEY(pane_no,last_capture_id) REFERENCES na_capture(pane_no,capture_id)
) STRICT;
`;
var init_schema = __esm(() => {
  PROJECTION_SCHEMA_MARKERS = ["pane_no INTEGER NOT NULL", "screen_hash BLOB", "history_hash BLOB", "na_block", "na_capture_archive"];
  PROJECTION_LEGACY_FILES = Object.freeze(["newarch-v3/history.sqlite3"]);
  CHECK_STATES = ["unchecked", "checked", "content-matched"];
  CHECK_REASONS = ["awaiting-capture", "evicted-before-check", "exact-capture", "content-capture"];
});

// src/sqlite-history/codec.ts
import { createHash } from "node:crypto";
import { deflateRawSync, inflateRawSync } from "node:zlib";
function safe(value, label = "integer") {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error(`unsafe-${label}`);
  return value;
}
function sha(value) {
  return createHash("sha256").update(value).digest("hex");
}
function rowsDigest(rows) {
  const h = createHash("sha256");
  for (const row of rows) {
    for (const part of [String(row.line_no), row.kind, row.text]) {
      const data = Buffer.from(part, "utf8");
      const length = Buffer.alloc(8);
      length.writeBigUInt64BE(BigInt(data.length));
      h.update(length);
      h.update(data);
    }
  }
  return h.digest("hex");
}
function validateObservation(o) {
  if (!Number.isFinite(o.at))
    throw new Error("invalid-time");
  for (const rows of [o.raw, o.screen]) {
    if (!Array.isArray(rows) || rows.some((r) => typeof r !== "string" || !r.isWellFormed()))
      throw new Error("invalid-rows");
  }
  const g = o.geometry;
  if (!g || !["pane", "legacy-window"].includes(g.kind) || typeof g.alternate !== "boolean")
    throw new Error("invalid-geometry");
  safe(g.rows);
  safe(g.cols);
  safe(g.generation);
  if (g.kind === "pane" && (!g.rows || !g.cols || o.screen.length !== Math.min(g.rows, o.raw.length) || JSON.stringify(o.raw.slice(-o.screen.length || o.raw.length)) !== JSON.stringify(o.screen)))
    throw new Error("screen-seam");
  if (g.cursor !== undefined && g.cursor !== null) {
    safe(g.cursor.row);
    safe(g.cursor.col);
    if (Object.keys(g.cursor).sort().join(",") !== "col,row")
      throw new Error("invalid-cursor");
  }
  if (!o.source || Object.keys(o.source).some((k) => !["ringFull", "activity", "reset"].includes(k) || typeof o.source[k] !== "boolean"))
    throw new Error("invalid-source");
}
function encodeCellRuns(cells) {
  const runs = [];
  for (const c of cells) {
    const last = runs[runs.length - 1];
    if (last && last[0] === c.grapheme && last[1] === c.width && last[2] === c.continuation && last[3] === c.fg && last[4] === c.bg && last[5] === c.style)
      last[6]++;
    else
      runs.push([c.grapheme, c.width, c.continuation, c.fg, c.bg, c.style, 1]);
  }
  return JSON.stringify(runs);
}
function decodeCellRuns(encoded) {
  const runs = typeof encoded === "string" ? JSON.parse(encoded) : encoded;
  return runs.flatMap((run) => {
    if (typeof run[0] === "object")
      return Array.from({ length: run[1] }, () => ({ ...run[0] }));
    const [grapheme, width, continuation, fg, bg, style, n] = run;
    return Array.from({ length: n }, () => ({ grapheme, width, continuation, fg, bg, style }));
  });
}
function colourToken(v) {
  if (v === "default")
    return "";
  if (v === null)
    return "~";
  if (typeof v === "number")
    return Number.isSafeInteger(v) && v >= 0 ? "#" + v : null;
  return INDEX.exec(v)?.[1] ?? RGB.exec(v)?.[1] ?? null;
}
function colourValue(t) {
  if (t === "")
    return "default";
  if (t === "~")
    return null;
  if (t[0] === "#")
    return Number(t.slice(1));
  return t.includes(",") ? "rgb:" + t : "index:" + t;
}
function encodeRow(text, cells) {
  let layout = "", runs = "", pos = 0, token = "", repeat = 0, blank = 0;
  let fg = "default", bg = "default", style = 0, count = 0;
  const flush = () => {
    if (repeat) {
      layout += (repeat > 1 ? repeat : "") + token;
      repeat = 0;
    }
  };
  const run = () => {
    if (count)
      runs += (runs ? " " : "") + runToken(count, fg, bg, style);
  };
  for (let i = 0;i < cells.length; i++) {
    const c = cells[i], g = c.grapheme;
    let t;
    if (c.continuation) {
      if (g !== "")
        return legacy(text, cells);
      t = c.width === 0 ? "c" : `(0,${c.width},1)`;
    } else {
      if (!text.startsWith(g, pos))
        return legacy(text, cells);
      pos += g.length;
      t = units(g) && c.width === 1 ? "a" : units(g) && c.width === 2 ? "w" : `(${g.length},${c.width},0)`;
    }
    if (t === token)
      repeat++;
    else {
      flush();
      token = t;
      repeat = 1;
    }
    blank = t === "a" && g === " " ? blank + 1 : 0;
    if (c.fg !== fg || c.bg !== bg || c.style !== style) {
      if (colourToken(c.fg) === null || colourToken(c.bg) === null || !Number.isSafeInteger(c.style) || c.style < 0)
        return legacy(text, cells);
      run();
      fg = c.fg;
      bg = c.bg;
      style = c.style;
      count = 0;
    }
    count++;
  }
  if (pos !== text.length)
    return legacy(text, cells);
  if (token !== "a")
    flush();
  if (!(fg === "default" && bg === "default" && style === 0))
    run();
  return { text: blank ? text.slice(0, text.length - blank) : text, cells: `${cells.length}|${layout}|${runs}` };
}
function runToken(count, fg, bg, style) {
  return fg === "default" && bg === "default" && style === 0 ? String(count) : `${count}:${colourToken(fg)}:${colourToken(bg)}:${style || ""}`;
}
function legacy(text, cells) {
  return { text, cells: encodeCellRuns(cells) };
}
function decodeRow(stored, encoded) {
  if (encoded[0] === "[")
    return { text: stored, cells: decodeCellRuns(encoded) };
  const bar = encoded.indexOf("|"), bar2 = encoded.indexOf("|", bar + 1);
  const n = Number(encoded.slice(0, bar)), layout = encoded.slice(bar + 1, bar2), runs = encoded.slice(bar2 + 1);
  if (!Number.isSafeInteger(n) || n < 0 || bar2 < 0)
    throw new Error("row-codec-corrupt");
  const cells = new Array(n);
  let at = 0, pos = 0, pad = 0;
  const take = (k) => {
    const g = stored.slice(pos, pos + k);
    if (g.length !== k)
      throw new Error("row-codec-corrupt");
    pos += k;
    return g;
  };
  const point = () => {
    if (pos >= stored.length) {
      pad++;
      return " ";
    }
    return take(stored.codePointAt(pos) > 65535 ? 2 : 1);
  };
  const cell = (grapheme, width, continuation) => {
    if (at >= n)
      throw new Error("row-codec-corrupt");
    cells[at++] = { grapheme, width, continuation, fg: "default", bg: "default", style: 0 };
  };
  for (let i = 0;i < layout.length; ) {
    let k = 0;
    while (layout.charCodeAt(i) >= 48 && layout.charCodeAt(i) <= 57)
      k = k * 10 + layout.charCodeAt(i++) - 48;
    const t = layout[i++];
    let make;
    if (t === "a")
      make = () => cell(point(), 1, false);
    else if (t === "w")
      make = () => cell(point(), 2, false);
    else if (t === "c")
      make = () => cell("", 0, true);
    else if (t === "(") {
      const end = layout.indexOf(")", i);
      const [u, w, c] = layout.slice(i, end).split(",").map(Number);
      i = end + 1;
      if (end < 0 || ![0, 1, 2].includes(w) || c !== 0 && c !== 1)
        throw new Error("row-codec-corrupt");
      make = () => cell(c ? "" : take(u), w, c === 1);
    } else
      throw new Error("row-codec-corrupt");
    for (let r = k || 1;r > 0; r--)
      make();
  }
  while (at < n)
    cell(point(), 1, false);
  if (pos !== stored.length)
    throw new Error("row-codec-corrupt");
  if (runs) {
    let x = 0;
    for (const run of runs.split(" ")) {
      const parts = run.split(":"), count = Number(parts[0]);
      if (!Number.isSafeInteger(count) || count < 1 || x + count > n || parts.length !== 1 && parts.length !== 4)
        throw new Error("row-codec-corrupt");
      if (parts.length === 4) {
        const fg = colourValue(parts[1]), bg = colourValue(parts[2]), style = parts[3] ? Number(parts[3]) : 0;
        for (let j = x;j < x + count; j++) {
          const c = cells[j];
          c.fg = fg;
          c.bg = bg;
          c.style = style;
        }
      }
      x += count;
    }
  }
  return { text: pad ? stored + " ".repeat(pad) : stored, cells };
}
function encodeBlock(lines) {
  const body = deflateRawSync(Buffer.from(JSON.stringify(lines)));
  const out = new Uint8Array(body.length + 1);
  out[0] = BLOCK_FORMAT;
  out.set(body, 1);
  return out;
}
function decodeBlock(data) {
  if (data[0] !== BLOCK_FORMAT)
    throw new Error("block-format-unknown");
  if (data.byteLength > LEGACY_INFLATE_MAX_BYTES)
    throw new Error("legacy-block-scratch-pressure");
  let raw;
  try {
    raw = inflateRawSync(data.subarray(1), { maxOutputLength: LEGACY_INFLATE_MAX_BYTES });
  } catch (error) {
    throw new Error("legacy-block-decode-failed-or-scratch-pressure", { cause: error });
  }
  const rows = JSON.parse(raw.toString("utf8"));
  if (!Array.isArray(rows) || rows.length > 4096 || rows.some((row) => !Array.isArray(row)))
    throw new Error("block-corrupt");
  return rows;
}
function packArchive(raw) {
  const body = deflateRawSync(raw), out = Buffer.alloc(37 + body.length);
  out[0] = CAPTURE_ARCHIVE_FORMAT;
  out.writeUInt32BE(raw.length, 1);
  createHash("sha256").update(raw).digest().copy(out, 5);
  body.copy(out, 37);
  return out;
}
function unpackArchive(data) {
  const input = Buffer.from(data);
  if (input.length < 37 || input[0] !== CAPTURE_ARCHIVE_FORMAT)
    throw new Error("capture-archive-format-unknown");
  const expected = input.readUInt32BE(1);
  if (expected > LEGACY_INFLATE_MAX_BYTES || input.length > LEGACY_INFLATE_MAX_BYTES)
    throw new Error("capture-archive-scratch-pressure");
  const raw = inflateRawSync(input.subarray(37), { maxOutputLength: LEGACY_INFLATE_MAX_BYTES });
  if (raw.length !== expected)
    throw new Error("capture-archive-size");
  const digest = createHash("sha256").update(raw).digest();
  if (!digest.equals(input.subarray(5, 37)))
    throw new Error("capture-archive-checksum");
  return raw;
}
function encodeCaptureArchive(rows) {
  return packArchive(Buffer.from(JSON.stringify(rows)));
}
function decodeCaptureArchive(data) {
  const raw = unpackArchive(data);
  const rows = JSON.parse(raw.toString("utf8"));
  if (!Array.isArray(rows))
    throw new Error("capture-archive-corrupt");
  return rows;
}
function encodeCaptureReceipts(rows) {
  const metadata = rows.map((row) => {
    if (row.length !== 15)
      throw new Error("capture-archive-corrupt");
    for (const at of [8, 9])
      if (!(row[at] instanceof Uint8Array) || row[at].length !== 32)
        throw new Error("capture-archive-hash");
    return [...row.slice(0, 8), ...row.slice(10)];
  });
  const json = Buffer.from(JSON.stringify(metadata)), raw = Buffer.alloc(4 + json.length + rows.length * 64);
  raw.writeUInt32BE(json.length);
  json.copy(raw, 4);
  rows.forEach((row, index) => {
    Buffer.from(row[8]).copy(raw, 4 + json.length + index * 64);
    Buffer.from(row[9]).copy(raw, 36 + json.length + index * 64);
  });
  return packArchive(raw);
}
function decodeCaptureReceipts(data) {
  const raw = unpackArchive(data);
  if (raw.length < 4)
    throw new Error("capture-archive-corrupt");
  const jsonBytes = raw.readUInt32BE(0);
  if (jsonBytes > raw.length - 4)
    throw new Error("capture-archive-size");
  const metadata = JSON.parse(raw.subarray(4, 4 + jsonBytes).toString("utf8"));
  if (!Array.isArray(metadata) || raw.length !== 4 + jsonBytes + metadata.length * 64)
    throw new Error("capture-archive-corrupt");
  return metadata.map((row, index) => {
    if (!Array.isArray(row) || row.length !== 13)
      throw new Error("capture-archive-corrupt");
    const hashes = raw.subarray(4 + jsonBytes + index * 64, 4 + jsonBytes + (index + 1) * 64);
    return [...row.slice(0, 8), hashes.subarray(0, 32), hashes.subarray(32), ...row.slice(8)];
  });
}
var INDEX, RGB, units = (g) => g.length === 1 || g.length === 2 && g.codePointAt(0) > 65535, BLOCK_FORMAT = 1, LEGACY_INFLATE_MAX_BYTES, CAPTURE_ARCHIVE_FORMAT = 1;
var init_codec = __esm(() => {
  INDEX = /^index:(0|[1-9]\d*)$/;
  RGB = /^rgb:((?:0|[1-9]\d*),(?:0|[1-9]\d*),(?:0|[1-9]\d*))$/;
  LEGACY_INFLATE_MAX_BYTES = 8 * 1024 * 1024;
});

// src/history-row-matcher.ts
function cellKey(cell) {
  return JSON.stringify([cell.grapheme, cell.width, cell.continuation, cell.fg, cell.bg, cell.style]);
}
function equalCells(a, b, styleMask = -1) {
  return a.grapheme === b.grapheme && a.width === b.width && a.continuation === b.continuation && a.fg === b.fg && a.bg === b.bg && ((a.style ^ b.style) & styleMask) === 0;
}
var certifiedCache = new Map;
function certifiedRows(rows, styleMask) {
  let cache = certifiedCache.get(styleMask);
  if (!cache) {
    cache = new WeakMap;
    certifiedCache.set(styleMask, cache);
  }
  return rows.map((row) => {
    let cells = cache.get(row.cells);
    if (!cells) {
      cells = row.cells.every((cell) => (cell.style & ~styleMask) === 0) ? row.cells : row.cells.map((cell) => (cell.style & ~styleMask) === 0 ? cell : { ...cell, style: cell.style & styleMask });
      cache.set(row.cells, cells);
    }
    return cells === row.cells ? row : { cells, softWrap: row.softWrap };
  });
}
function rowKey(row) {
  return JSON.stringify([row.softWrap, row.cells.map(cellKey)]);
}
function equalHistoryRows(a, b) {
  if (a.softWrap !== b.softWrap || a.cells.length !== b.cells.length)
    return false;
  if (a.cells === b.cells)
    return true;
  for (let x = 0;x < a.cells.length; x++) {
    const c = a.cells[x], d = b.cells[x];
    if (c.grapheme !== d.grapheme || c.width !== d.width || c.continuation !== d.continuation || c.fg !== d.fg || c.bg !== d.bg || c.style !== d.style)
      return false;
  }
  return true;
}
function equalRowsAround(a, b, probe) {
  if (a.softWrap !== b.softWrap || a.cells.length !== b.cells.length)
    return false;
  if (a.cells === b.cells)
    return true;
  const same = (x) => {
    const c = a.cells[x], d = b.cells[x];
    return c.grapheme === d.grapheme && c.width === d.width && c.continuation === d.continuation && c.fg === d.fg && c.bg === d.bg && c.style === d.style;
  };
  const start = Math.min(probe, a.cells.length - 1);
  for (let x = start;x >= 0; x--)
    if (!same(x))
      return false;
  for (let x = start + 1;x < a.cells.length; x++)
    if (!same(x))
      return false;
  return true;
}
function rowSampleKey(row) {
  const cells = row.cells;
  let key = cells.length ^ (row.softWrap ? 1073741824 : 0);
  const mix = (x) => {
    const glyph = cells[x].grapheme;
    for (let c = 0;c < glyph.length; c++)
      key = Math.imul(key ^ glyph.charCodeAt(c), 16777619);
    key = Math.imul(key ^ 255, 16777619);
  };
  const head = Math.min(16, cells.length);
  for (let x = 0;x < head; x++)
    mix(x);
  for (let x = head + 7;x < cells.length - 1; x += 8)
    mix(x);
  if (cells.length > head)
    mix(cells.length - 1);
  return key;
}
function internRows(rows, uncertain) {
  const buckets = new Map;
  let id = 0;
  return rows.map((part, p) => part.map((row, y) => {
    if (p === 1 && uncertain?.has(y))
      return ++id;
    const key = rowSampleKey(row);
    const bucket = buckets.get(key);
    const found = bucket?.find((entry2) => equalHistoryRows(entry2.row, row));
    if (found)
      return found.id;
    const entry = { row, id: ++id };
    if (bucket)
      bucket.push(entry);
    else
      buckets.set(key, [entry]);
    return entry.id;
  }));
}
function zValues(values) {
  const z = Array(values.length).fill(0);
  let left = 0, right = 0;
  for (let i = 1;i < values.length; i++) {
    if (i <= right)
      z[i] = Math.min(right - i + 1, z[i - left]);
    while (i + z[i] < values.length && values[z[i]] === values[i + z[i]])
      z[i]++;
    if (i + z[i] - 1 > right) {
      left = i;
      right = i + z[i] - 1;
    }
  }
  return z;
}
function occurrences(pattern, values) {
  const z = zValues([...pattern, null, ...values]);
  let count = 0;
  for (let i = pattern.length + 1;i < z.length; i++)
    if (z[i] >= pattern.length)
      count++;
  return count;
}
function tripleCounts(values, base) {
  const counts = new Map;
  for (let i = 0;i + 2 < values.length; i++) {
    if (values[i] === values[i + 1] && values[i] === values[i + 2])
      continue;
    const key = tripleKey(values, i, base);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}
function tripleKey(values, i, base) {
  return base < 200000 ? (values[i] * base + values[i + 1]) * base + values[i + 2] : `${values[i]},${values[i + 1]},${values[i + 2]}`;
}
function classify(from, to, equal, sameAsNext, unique) {
  const covered = new Uint8Array(Math.max(0, to - from));
  const anchor = (i) => !(sameAsNext(i) && sameAsNext(i + 1)) && unique(i);
  for (let start = from;start < to; ) {
    if (!equal(start)) {
      start++;
      continue;
    }
    let end = start;
    while (end < to && equal(end))
      end++;
    let first = start;
    while (first + 2 < end && !anchor(first))
      first++;
    let last = end - 3;
    while (last > first && !anchor(last))
      last--;
    if (first + 2 < end && last > first) {
      for (let x = first + 1;x <= last + 1; x++)
        if (!sameAsNext(x - 1) && !sameAsNext(x))
          covered[x - from] = 1;
    }
    start = end;
  }
  return covered;
}
function certify(recent, a, b, offset, reason) {
  const result = { checks: [], contentMatches: [], repairs: [], reason };
  const from = Math.max(0, -offset), to = Math.min(a.length, b.length - offset);
  if (to <= from)
    return result;
  const base = Math.max(a.length, b.length) * 2 + 2;
  const countA = tripleCounts(a, base), countB = tripleCounts(b, base);
  const covered = classify(from, to, (i) => a[i] === b[i + offset], (i) => a[i] === a[i + 1], (i) => {
    const key = tripleKey(a, i, base);
    return countA.get(key) === 1 && countB.get(key) === 1;
  });
  for (let i = from;i < to; i++) {
    if (a[i] !== b[i + offset])
      continue;
    (covered[i - from] ? result.checks : result.contentMatches).push({ lineId: recent[i].lineId, capturedRow: i + offset });
  }
  return result;
}
function matchHistoryRows(recent, captured, scope) {
  const empty = (reason) => ({ checks: [], contentMatches: [], repairs: [], reason });
  if (!scope.completeRetainedTail)
    return empty("partial-tail");
  if (recent.some((r) => r.sourceEpoch !== scope.sourceEpoch || r.geometryGeneration !== scope.geometryGeneration))
    return empty("generation");
  const uncertain = scope.uncertainCapturedRows;
  if (recent.length >= 3 && recent.length === captured.length) {
    const equal = new Uint8Array(recent.length);
    let differences = 0;
    for (let i = 0;i < recent.length && differences < 2; i++) {
      if (!uncertain?.has(i) && equalHistoryRows(recent[i], captured[i]))
        equal[i] = 1;
      else
        differences++;
    }
    if (differences < 2) {
      const aligned = certifyAligned(recent, captured, 0, 0, equal, "matched");
      if (!aligned.checks.length)
        aligned.reason = "ambiguous";
      return aligned;
    }
  }
  const [a, b] = internRows([recent, captured], uncertain);
  if (a.length < 3 || b.length < 3)
    return empty("no-anchor");
  const reversed = a.slice().reverse();
  const z = zValues([...reversed, null, ...b.slice().reverse()]);
  let length = 0, end = -1, count = 0;
  for (let i = 0;i < b.length; i++) {
    const n = z[a.length + 1 + i];
    if (n > length) {
      length = n;
      end = b.length - i;
      count = 1;
    } else if (n === length)
      count++;
  }
  if (length < 3)
    return empty("no-anchor");
  if (scope.maxTailGap !== undefined && b.length - end > scope.maxTailGap)
    return empty("no-anchor");
  const anchor = a.slice(a.length - length);
  if (count !== 1 || new Set(anchor).size < 2 || occurrences(anchor, a) !== 1 || occurrences(anchor, b) !== 1)
    return empty("ambiguous");
  const result = certify(recent, a, b, end - a.length, "matched");
  if (!result.checks.length)
    result.reason = "ambiguous";
  return result;
}
function locateTriple(rows, pattern) {
  if (equalHistoryRows(pattern[0], pattern[1]) && equalHistoryRows(pattern[0], pattern[2]))
    return -1;
  let probe = 0;
  for (let x = 0;x < pattern[0].cells.length; x++) {
    if (pattern[0].cells[x].grapheme !== pattern[1].cells[x]?.grapheme || pattern[0].cells[x].grapheme !== pattern[2].cells[x]?.grapheme) {
      probe = x;
      break;
    }
  }
  const glyph = pattern[0].cells[probe]?.grapheme;
  let found = -1;
  for (let i = 0;i + 2 < rows.length; i++) {
    if (rows[i].cells[probe]?.grapheme !== glyph)
      continue;
    if (equalRowsAround(rows[i], pattern[0], probe) && equalRowsAround(rows[i + 1], pattern[1], probe) && equalRowsAround(rows[i + 2], pattern[2], probe)) {
      if (found >= 0)
        return -1;
      found = i;
    }
  }
  return found;
}
function tripleIndex(rows) {
  let scans = 0;
  let indexed;
  return (i) => {
    if (!indexed && scans++ < 8)
      return locateTriple(rows, [rows[i], rows[i + 1], rows[i + 2]]) === i;
    return (indexed ??= sampledTripleIndex(rows))(i);
  };
}
function sampledTripleIndex(rows) {
  const keys = new Int32Array(rows.length);
  for (let y = 0;y < rows.length; y++)
    keys[y] = rowSampleKey(rows[y]);
  const key = (i) => Math.imul(Math.imul(keys[i] ^ 2654435769, 16777619) ^ keys[i + 1], 16777619) ^ Math.imul(keys[i + 2], 2246822507);
  const counts = new Map;
  for (let i = 0;i + 2 < rows.length; i++) {
    const k = key(i);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  let groups;
  return (i) => {
    const k = key(i);
    if (counts.get(k) === 1)
      return true;
    if (!groups) {
      groups = new Map;
      for (let j = 0;j + 2 < rows.length; j++) {
        const g = key(j);
        if (counts.get(g) > 1) {
          const list = groups.get(g);
          if (list)
            list.push(j);
          else
            groups.set(g, [j]);
        }
      }
    }
    let same = 0;
    for (const j of groups.get(k)) {
      if (j === i || equalHistoryRows(rows[j], rows[i]) && equalHistoryRows(rows[j + 1], rows[i + 1]) && equalHistoryRows(rows[j + 2], rows[i + 2])) {
        if (++same > 1)
          return false;
      }
    }
    return true;
  };
}
function certifyAligned(recent, captured, offset, from, equal, reason) {
  const result = { checks: [], contentMatches: [], repairs: [], reason };
  const to = from + equal.length;
  let uniqueR, uniqueC;
  const same = new Int8Array(equal.length).fill(-1);
  let probe = 0;
  const sameAsNext = (i) => {
    const k = i - from;
    if (same[k] === -1) {
      const x = recent[i], y = recent[i + 1];
      if (x.cells.length === y.cells.length && probe < x.cells.length && x.cells[probe].grapheme !== y.cells[probe].grapheme)
        same[k] = 0;
      else if (equalHistoryRows(x, y))
        same[k] = 1;
      else {
        same[k] = 0;
        const n = Math.min(x.cells.length, y.cells.length);
        for (let c = 0;c < n; c++)
          if (x.cells[c].grapheme !== y.cells[c].grapheme) {
            probe = c;
            break;
          }
      }
    }
    return same[k] === 1;
  };
  const covered = classify(from, to, (i) => equal[i - from] === 1, sameAsNext, (i) => {
    uniqueR ??= tripleIndex(recent);
    uniqueC ??= tripleIndex(captured);
    return uniqueR(i) && uniqueC(i + offset);
  });
  for (let i = from;i < to; i++) {
    if (!equal[i - from])
      continue;
    (covered[i - from] ? result.checks : result.contentMatches).push({ lineId: recent[i].lineId, capturedRow: i + offset });
  }
  return result;
}

class IncrementalHistoryMatcher {
  checked = new Map;
  generation = "";
  reset() {
    this.checked.clear();
  }
  match(recent, captured, scope) {
    const generation = `${scope.sourceEpoch}/${scope.geometryGeneration}`;
    if (this.generation !== generation) {
      this.reset();
      this.generation = generation;
    }
    if (scope.completeRetainedTail)
      return matchHistoryRows(recent, captured, scope);
    const empty = (reason) => ({ checks: [], contentMatches: [], repairs: [], reason });
    if (recent.some((r) => r.sourceEpoch !== scope.sourceEpoch || r.geometryGeneration !== scope.geometryGeneration))
      return empty("generation");
    const prior = [...this.checked.entries()];
    if (prior.length !== 3)
      return empty("partial-tail");
    const first = recent.findIndex((row) => row.lineId === prior[0][0]);
    if (first < 0 || prior.some(([id, row], n) => recent[first + n]?.lineId !== id || !equalHistoryRows(row, recent[first + n])))
      return empty("partial-tail");
    const uncertain = scope.uncertainCapturedRows;
    const pattern = prior.map(([, row]) => row);
    const at = locateTriple(captured, pattern);
    if (at < 0 || locateTriple(recent, pattern) !== first || [0, 1, 2].some((n) => uncertain?.has(at + n)))
      return empty("ambiguous");
    const offset = at - first;
    const from = Math.max(0, -offset), to = Math.min(recent.length, captured.length - offset);
    const equal = new Uint8Array(Math.max(0, to - from));
    for (let i = from;i < to; i++)
      equal[i - from] = !uncertain?.has(i + offset) && equalHistoryRows(recent[i], captured[i + offset]) ? 1 : 0;
    const result = certifyAligned(recent, captured, offset, from, equal, "matched");
    if (at + 4 < captured.length && !result.checks.some((check) => check.capturedRow >= at + 3))
      result.reason = "ambiguous";
    return result;
  }
  remember(recent, captured, match) {
    this.checked.clear();
    const checks = match.checks.slice();
    if (checks.some((check, k) => k > 0 && checks[k - 1].capturedRow > check.capturedRow))
      checks.sort((a, b) => a.capturedRow - b.capturedRow);
    let index;
    for (let k = checks.length - 1;k >= 2; k--) {
      const triple = [checks[k - 2], checks[k - 1], checks[k]];
      if (triple[1].capturedRow !== triple[0].capturedRow + 1 || triple[2].capturedRow !== triple[1].capturedRow + 1)
        continue;
      let at;
      if (!index) {
        for (let i = recent.length - 1;i >= 0; i--)
          if (recent[i].lineId === triple[0].lineId) {
            at = i;
            break;
          }
        index = new Map;
      } else {
        if (!index.size)
          recent.forEach((row, i) => index.set(row.lineId, i));
        at = index.get(triple[0].lineId);
      }
      if (at === undefined || recent[at + 1]?.lineId !== triple[1].lineId || recent[at + 2]?.lineId !== triple[2].lineId)
        continue;
      for (const check of triple) {
        const row = captured[check.capturedRow];
        this.checked.set(check.lineId, { softWrap: row.softWrap, cells: row.cells.map((cell) => ({ ...cell })) });
      }
      return;
    }
  }
}

// src/sqlite-history/projection-reader.ts
import { Database as Database2, constants } from "bun:sqlite";
import { closeSync, existsSync, lstatSync, openSync, readSync } from "node:fs";
import { basename, resolve } from "node:path";

// src/sqlite-history/ram-store.ts
init_schema();
init_codec();
import { Database } from "bun:sqlite";
import { createHash as createHash2, randomUUID } from "node:crypto";
var EVICT_LINES_SQL = "DELETE FROM na_line WHERE pane_no=? AND line_id<? AND revision<=?";
var paneId = (key) => {
  if (!key.serverIdentity || !key.paneId)
    throw new Error("invalid-pane-key");
  integer(key.birthGeneration);
  return JSON.stringify([key.serverIdentity, key.paneId, key.birthGeneration]);
};
function integer(n) {
  if (!Number.isSafeInteger(n) || n < 0)
    throw new Error("invalid-integer");
  return n;
}
function validateRow(row) {
  if (typeof row.text !== "string" || !row.text.isWellFormed() || !Array.isArray(row.cells))
    throw new Error("invalid-row");
  for (const c of row.cells) {
    if (typeof c.grapheme !== "string" || !c.grapheme.isWellFormed() || ![0, 1, 2].includes(c.width) || typeof c.continuation !== "boolean" || !Number.isSafeInteger(c.style) || ![c.fg, c.bg].every((v) => v === null || typeof v === "string" || typeof v === "number" && Number.isFinite(v)))
      throw new Error("invalid-cell");
  }
}
function encodeCells(cells) {
  return encodeCellRuns(cells);
}
function decodeCells(encoded) {
  return decodeCellRuns(encoded);
}
function lineRow(row) {
  return decodeRow(String(row.text), String(row.cells));
}
var checkState = (code) => {
  const v = CHECK_STATES[Number(code)];
  if (v === undefined)
    throw new Error("check-state-corrupt");
  return v;
};
var checkReason = (code) => {
  const v = CHECK_REASONS[Number(code)];
  if (v === undefined)
    throw new Error("check-reason-corrupt");
  return v;
};
var STATE_CODE = { unchecked: 0, checked: 1, "content-matched": 2 };
var REASON_CODE = { "awaiting-capture": 0, "evicted-before-check": 1, "exact-capture": 2, "content-capture": 3 };
var OBSERVED_CODEBOOK = ["grapheme", "width", "continuation", "fg", "bg", "style", "cursor-position", "cursor-visible"];
function encodeObservedFields(fields) {
  let mask = 0, last = -1;
  for (const f of fields) {
    const i = OBSERVED_CODEBOOK.indexOf(f);
    if (i <= last)
      return JSON.stringify(fields);
    mask |= 1 << i;
    last = i;
  }
  return mask;
}
var frameCodec = { frames: 0, rows: 0, rowMisses: 0, encodedChars: 0 };
var FRAME_ROW_V2 = new WeakMap;
var VALID_ROWS = new WeakSet;
var encodeFrameRow = (row) => {
  let stored = FRAME_ROW_V2.get(row);
  if (stored === undefined) {
    const text = row.filter((cell) => !cell.continuation).map((cell) => cell.grapheme).join("");
    const encoded = encodeRow(text, row);
    stored = [encoded.text, encoded.cells];
    FRAME_ROW_V2.set(row, stored);
    frameCodec.rowMisses++;
  }
  return stored;
};
function frameCodecStats() {
  return { ...frameCodec };
}
function encodeFrameCells(cells) {
  const encoded = JSON.stringify({ fc: 2, rows: cells.map(encodeFrameRow) });
  frameCodec.frames++;
  frameCodec.rows += cells.length;
  frameCodec.encodedChars += encoded.length;
  return encoded;
}
function decodeFrameCells(encoded) {
  const value = JSON.parse(encoded);
  if (Array.isArray(value))
    return value;
  if (value?.rle === 1 && Array.isArray(value.rows))
    return value.rows.map(decodeCellRuns);
  if (value?.fc === 2 && Array.isArray(value.rows))
    return value.rows.map((row) => {
      if (!Array.isArray(row) || row.length !== 2 || typeof row[0] !== "string" || typeof row[1] !== "string")
        throw new Error("frame-codec-corrupt");
      return decodeRow(row[0], row[1]).cells;
    });
  throw new Error("frame-codec-unknown");
}
function validateFrame(frame) {
  integer(frame.cols);
  integer(frame.rows);
  integer(frame.receiveSeq);
  if (!frame.cols || !frame.rows || !["normal", "alternate"].includes(frame.kind) || frame.cells.length !== frame.rows || frame.cells.some((row) => row.length !== frame.cols))
    throw new Error("invalid-frame");
  for (const cells of frame.cells)
    if (!VALID_ROWS.has(cells)) {
      validateRow({ text: "", cells });
      VALID_ROWS.add(cells);
    }
  if (frame.cursor && (!Number.isInteger(frame.cursor.row) || !Number.isInteger(frame.cursor.col) || frame.cursor.row < 0 || frame.cursor.row >= frame.rows || frame.cursor.col < 0 || frame.cursor.col >= frame.cols || typeof frame.cursor.visible !== "boolean"))
    throw new Error("invalid-cursor");
}
var UPSERT_IDENTITIES = {
  na_pane: ["pane_no", "pane_key"],
  na_capture: ["pane_no", "capture_id"],
  na_line: ["pane_no", "line_id"],
  na_screen: ["pane_key", "screen_kind"],
  na_issue: ["issue_id"],
  na_commit: ["commit_id"]
};
var UPSERT_SQL = new Map;
var PREPARED = new WeakMap;
function prepared(db, sql) {
  let cache = PREPARED.get(db);
  if (!cache) {
    cache = new Map;
    PREPARED.set(db, cache);
  }
  let statement = cache.get(sql);
  if (!statement) {
    statement = db.query(sql);
    cache.set(sql, statement);
  }
  return statement;
}
var UPSERT_STATEMENTS = new WeakMap;
function closePrepared(db) {
  const statements = PREPARED.get(db);
  PREPARED.delete(db);
  UPSERT_STATEMENTS.delete(db);
  try {
    if (statements)
      for (const statement of statements.values())
        statement.finalize();
  } finally {
    db.close();
  }
}
function upsert(db, table, row) {
  if (!/^na_(pane|capture|line|screen|issue|commit)$/.test(table))
    throw new Error("invalid-table");
  const columns = Object.keys(row), signature = table + ":" + columns.join(",");
  let sql = UPSERT_SQL.get(signature);
  if (!sql) {
    if (columns.some((c) => !/^[a-z_]+$/.test(c)))
      throw new Error("invalid-column");
    const mutable = columns.filter((c) => !UPSERT_IDENTITIES[table].includes(c));
    sql = `INSERT INTO ${table} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})
      ON CONFLICT DO UPDATE SET ${mutable.map((c) => `${c}=excluded.${c}`).join(",")}`;
    UPSERT_SQL.set(signature, sql);
  }
  let statements = UPSERT_STATEMENTS.get(db);
  if (!statements) {
    statements = new Map;
    UPSERT_STATEMENTS.set(db, statements);
  }
  let statement = statements.get(signature);
  if (!statement) {
    statement = prepared(db, sql);
    statements.set(signature, statement);
  }
  statement.run(...Object.values(row));
}

class ProjectionRam {
  db = new Database(":memory:", { strict: true });
  pageSize;
  constructor() {
    this.db.exec("PRAGMA page_size=8192; PRAGMA foreign_keys=ON; PRAGMA cache_size=-262144;");
    this.db.exec(PROJECTION_SCHEMA);
    this.db.exec(PROJECTION_RAM_SCREEN_SCHEMA);
    this.db.exec("CREATE INDEX na_line_capture ON na_line(pane_no,checked_capture_id)");
    this.pageSize = Number(prepared(this.db, "PRAGMA page_size").get().page_size);
  }
  pane(key) {
    const row = prepared(this.db, "SELECT * FROM na_pane WHERE pane_key=?").get(paneId(key));
    if (!row)
      throw new Error("unknown-pane");
    return row;
  }
  paneNo(key) {
    return Number(this.pane(key).pane_no);
  }
  token(key) {
    const p = this.pane(key);
    return {
      paneKey: { ...key },
      sourceEpoch: Number(p.source_epoch),
      geometryGeneration: Number(p.geometry_generation),
      revision: Number(p.revision),
      durableRevision: Number(p.durable_revision),
      nextLineId: Number(p.next_line_id)
    };
  }
  firstLineId = () => 0;
  ensure(key, epoch, geometry) {
    const id = paneId(key);
    integer(epoch);
    integer(geometry);
    const p = prepared(this.db, "SELECT * FROM na_pane WHERE pane_key=?").get(id);
    if (!p) {
      prepared(this.db, `INSERT INTO na_pane
        (pane_key,session_uuid,server_identity,pane_id,birth_generation,source_epoch,geometry_generation,cols,rows,screen_kind,next_line_id)
        VALUES (?,?,?,?,?,?,?,0,0,'normal',?)`).run(id, randomUUID(), key.serverIdentity, key.paneId, key.birthGeneration, epoch, geometry, integer(this.firstLineId(key)));
      return this.pane(key);
    }
    if (epoch < Number(p.source_epoch) || geometry < Number(p.geometry_generation))
      throw new Error("stale-generation");
    if (epoch === Number(p.source_epoch) && geometry === Number(p.geometry_generation))
      return p;
    if (epoch > Number(p.source_epoch))
      prepared(this.db, "INSERT INTO na_issue VALUES (?,?,?,?,?,?,?,?,?,NULL)").run(randomUUID(), id, epoch, Number(p.revision) + 1, p.next_line_id, "gap", "source-epoch-changed", null, Date.now());
    prepared(this.db, "UPDATE na_pane SET source_epoch=?,geometry_generation=?,receive_seq=? WHERE pane_key=?").run(epoch, geometry, epoch > Number(p.source_epoch) ? -1 : p.receive_seq, id);
    return this.pane(key);
  }
  bump(key) {
    const row = prepared(this.db, "UPDATE na_pane SET revision=revision+1 WHERE pane_key=? AND revision<9007199254740991 RETURNING revision,durable_revision,next_line_id").get(paneId(key));
    if (!row)
      throw new Error("unknown-pane-or-revision-overflow");
    return { revision: Number(row.revision), durableRevision: Number(row.durable_revision), nextLineId: Number(row.next_line_id) };
  }
  append(event, stored) {
    validateRow(event.physicalRow);
    integer(event.receiveSeq);
    if (typeof event.softWrap !== "boolean")
      throw new Error("invalid-soft-wrap");
    const p = this.ensure(event.paneKey, event.sourceEpoch, event.geometryGeneration), id = paneId(event.paneKey);
    integer(Number(p.next_line_id) + 1);
    if (event.sourceEpoch === Number(p.source_epoch) && event.receiveSeq < Number(p.receive_seq))
      throw new Error("stale-receive-seq");
    const row = stored ?? encodeRow(event.physicalRow.text, event.physicalRow.cells);
    prepared(this.db, "INSERT INTO na_line VALUES (?,?,?,?,?,?,?,?,0,0,NULL,NULL)").run(p.pane_no, event.sourceEpoch, p.next_line_id, Number(p.revision) + 1, event.geometryGeneration, row.text, row.cells, +event.softWrap);
    prepared(this.db, "UPDATE na_pane SET next_line_id=next_line_id+1,receive_seq=? WHERE pane_key=?").run(event.receiveSeq, id);
    prepared(this.db, "UPDATE na_line SET check_reason=1,revision=? WHERE pane_no=? AND line_id=? AND check_state=0").run(Number(p.revision) + 1, p.pane_no, Number(p.next_line_id) - 4500);
    return this.bump(event.paneKey);
  }
  screen(frame, captureId = null, at = null, observed = [], preparedCells, uncertain = []) {
    if (preparedCells === undefined)
      validateFrame(frame);
    const p = this.ensure(frame.paneKey, frame.sourceEpoch, frame.geometryGeneration), id = paneId(frame.paneKey);
    prepared(this.db, "INSERT INTO na_screen VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(pane_key,screen_kind) DO UPDATE SET revision=excluded.revision,geometry_generation=excluded.geometry_generation,cols=excluded.cols,rows=excluded.rows,cells_json=excluded.cells_json,cursor_json=excluded.cursor_json,last_capture_id=excluded.last_capture_id,captured_at=excluded.captured_at,display_source=excluded.display_source,observed_fields_json=excluded.observed_fields_json,uncertain_rows_json=excluded.uncertain_rows_json").run(id, p.pane_no, frame.kind, Number(p.revision) + 1, frame.geometryGeneration, frame.cols, frame.rows, preparedCells ?? encodeFrameCells(frame.cells), JSON.stringify(frame.cursor), captureId, at, captureId ? "tmux-calibrated" : "pipe", JSON.stringify(observed), JSON.stringify(uncertain));
    prepared(this.db, "UPDATE na_pane SET cols=?,rows=?,screen_kind=? WHERE pane_key=?").run(frame.cols, frame.rows, frame.kind, id);
  }
  revisionOf(key) {
    const row = prepared(this.db, "SELECT revision FROM na_pane WHERE pane_key=?").get(paneId(key));
    return row ? Number(row.revision) : 0;
  }
  recordIssue(issue, nextEpoch, casAtAdmission = false) {
    const id = paneId(issue.paneKey);
    const p = prepared(this.db, "SELECT * FROM na_pane WHERE pane_key=?").get(id) ?? this.ensure(issue.paneKey, issue.sourceEpoch, issue.geometryGeneration);
    if (!casAtAdmission && p.revision !== issue.expectedRevision)
      throw new Error("stale-revision");
    if (p.source_epoch !== issue.sourceEpoch || p.geometry_generation !== issue.geometryGeneration)
      throw new Error("stale-generation");
    integer(issue.boundaryLineId);
    if (issue.boundaryLineId > Number(p.next_line_id) || !issue.kind || !issue.reason || typeof issue.recoverable !== "boolean")
      throw new Error("invalid-issue");
    if (issue.missingCount !== null)
      integer(issue.missingCount);
    if (nextEpoch !== undefined) {
      integer(nextEpoch);
      if (nextEpoch <= Number(p.source_epoch))
        throw new Error("nonmonotonic-epoch");
      prepared(this.db, "UPDATE na_pane SET source_epoch=?,receive_seq=-1 WHERE pane_key=?").run(nextEpoch, id);
    }
    prepared(this.db, "INSERT INTO na_issue VALUES (?,?,?,?,?,?,?,?,?,NULL)").run(randomUUID(), id, nextEpoch ?? p.source_epoch, Number(p.revision) + 1, issue.boundaryLineId, issue.kind, issue.reason, issue.missingCount, Date.now());
    prepared(this.db, "UPDATE na_pane SET health=? WHERE pane_key=?").run(issue.recoverable ? "degraded" : "unverified", id);
    return this.bump(issue.paneKey);
  }
  calibrate(change, historyOnly = false) {
    const c = change.capture, p = this.pane(c.paneKey), no = p.pane_no;
    if (historyOnly ? change.expectedRevision > Number(p.revision) : p.revision !== change.expectedRevision)
      throw new Error("stale-revision");
    if (p.source_epoch !== c.sourceEpoch || p.geometry_generation !== c.geometryGeneration)
      throw new Error("stale-generation");
    validateFrame(c);
    c.history.forEach(validateRow);
    if (!c.captureId || !Number.isFinite(c.requestedAt) || !Number.isFinite(c.completedAt) || c.completedAt < c.requestedAt)
      throw new Error("invalid-capture");
    integer(c.firstHistoryRow);
    integer(c.ambiguousRows);
    const mapped = new Set, captureRows = new Set;
    const mutations = [
      ...change.repairs.map((r) => ({ ...r, repair: true, state: "checked" })),
      ...change.checks.map((r) => ({ ...r, repair: false, state: "checked" })),
      ...(change.contentMatches ?? []).map((r) => ({ ...r, repair: false, state: "content-matched" }))
    ];
    let correctedCells = 0;
    for (const m of mutations) {
      integer(m.lineId);
      integer(m.captureRow);
      if (mapped.has(m.lineId) || captureRows.has(m.captureRow) || !c.history[m.captureRow])
        throw new Error("duplicate-or-invalid-mapping");
      mapped.add(m.lineId);
      captureRows.add(m.captureRow);
      const row = prepared(this.db, "SELECT * FROM na_line WHERE pane_no=? AND line_id=?").get(no, m.lineId);
      if (!row || row.source_epoch !== c.sourceEpoch || row.geometry_generation !== c.geometryGeneration)
        throw new Error("capture-line-generation");
      const expected = c.history[m.captureRow];
      if (m.repair) {
        const repair = m;
        validateRow(repair.physicalRow);
        if (JSON.stringify(repair.physicalRow) !== JSON.stringify(expected))
          throw new Error("repair-not-capture");
        const previous = lineRow(row).cells;
        correctedCells += expected.cells.filter((cell, i) => JSON.stringify(cell) !== JSON.stringify(previous[i])).length;
      } else {
        const stored = lineRow(row);
        if (stored.text !== expected.text || JSON.stringify(stored.cells) !== JSON.stringify(expected.cells))
          throw new Error("check-not-exact");
      }
      m.keep = m.state === "content-matched" && row.check_state === STATE_CODE.checked;
    }
    const screenHash = createHash2("sha256"), historyHash = createHash2("sha256");
    for (const cells of c.cells)
      screenHash.update(encodeCells(cells)).update(`
`);
    for (const row of c.history)
      historyHash.update(row.text).update("\x00").update(encodeCells(row.cells)).update(`
`);
    prepared(this.db, "INSERT INTO na_capture VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(no, c.captureId, Number(p.revision) + 1, c.sourceEpoch, c.requestedAt, c.completedAt, c.geometryGeneration, c.firstHistoryRow, c.history.length, screenHash.digest(), historyHash.digest(), encodeObservedFields(c.observedFields), mapped.size, correctedCells, c.ambiguousRows, c.result);
    for (const m of mutations) {
      if (m.keep)
        continue;
      const expected = c.history[m.captureRow];
      const stored = encodeRow(expected.text, expected.cells);
      prepared(this.db, "UPDATE na_line SET revision=?,text=?,cells=?,check_state=?,check_reason=?,checked_capture_id=?,checked_row=? WHERE pane_no=? AND line_id=?").run(Number(p.revision) + 1, stored.text, stored.cells, STATE_CODE[m.state], REASON_CODE[m.state === "checked" ? "exact-capture" : "content-capture"], c.captureId, m.captureRow, no, m.lineId);
    }
    const evidence = change.captureEvidence;
    if (evidence?.kind === "quiescent") {
      integer(evidence.receiveSeqBefore);
      integer(evidence.receiveSeqAfter);
      if (evidence.sourceEpoch !== c.sourceEpoch || evidence.geometryGeneration !== c.geometryGeneration || evidence.receiveSeqBefore !== evidence.receiveSeqAfter)
        throw new Error("capture-not-quiescent");
      const uncertain = [...new Set(evidence.uncertainRows ?? [])].sort((a, b) => a - b);
      if (uncertain.some((r) => !Number.isSafeInteger(r) || r < 0 || r >= c.rows))
        throw new Error("invalid-uncertain-rows");
      this.screen(c, c.captureId, c.completedAt, c.observedFields, undefined, uncertain);
    }
    return this.bump(c.paneKey);
  }
  bytes() {
    const pages = prepared(this.db, "PRAGMA page_count").get();
    const free = prepared(this.db, "PRAGMA freelist_count").get();
    return (pages.page_count - free.freelist_count) * this.pageSize;
  }
  evict(panes, keep = 5000) {
    for (const p of panes) {
      prepared(this.db, EVICT_LINES_SQL).run(p.pane_no, Math.max(0, Number(p.next_line_id) - keep), p.revision);
      prepared(this.db, `DELETE FROM na_capture WHERE pane_no=? AND revision<=?
        AND NOT EXISTS(SELECT 1 FROM na_line l WHERE l.pane_no=na_capture.pane_no AND l.checked_capture_id=na_capture.capture_id)
        AND NOT EXISTS(SELECT 1 FROM na_screen s WHERE s.pane_no=na_capture.pane_no AND s.last_capture_id=na_capture.capture_id)`).run(p.pane_no, p.revision);
      prepared(this.db, "DELETE FROM na_issue WHERE pane_key=? AND revision<=?").run(p.pane_key, p.revision);
    }
  }
}

// src/sqlite-history/projection-reader.ts
init_codec();
var BLOCK_COLUMNS = ["source_epoch", "revision", "geometry_generation", "text", "cells", "soft_wrap", "check_state", "check_reason", "checked_capture_id", "checked_row"];
var BLOCK_MAX = 4096;
function readDiskLines(disk, paneNo, start, end) {
  const byId = new Map;
  for (const block of prepared(disk, "SELECT first_line_id,line_count,data FROM na_block WHERE pane_no=? AND first_line_id<? AND first_line_id>? ORDER BY first_line_id").iterate(paneNo, end, start - BLOCK_MAX)) {
    const first = Number(block.first_line_id), lines = decodeBlock(block.data);
    if (lines.length !== Number(block.line_count))
      throw new Error("block-corrupt");
    for (let i = Math.max(0, start - first);i < lines.length && first + i < end; i++) {
      const row = { pane_no: paneNo, line_id: first + i };
      BLOCK_COLUMNS.forEach((column, j) => {
        row[column] = lines[i][j];
      });
      byId.set(first + i, row);
    }
  }
  for (const row of prepared(disk, "SELECT * FROM na_line WHERE pane_no=? AND line_id>=? AND line_id<? ORDER BY line_id").all(paneNo, start, end))
    byId.set(Number(row.line_id), row);
  return [...byId.values()].sort((a, b) => Number(a.line_id) - Number(b.line_id));
}
function projectionLine(r) {
  const row = lineRow(r);
  return {
    lineId: Number(r.line_id),
    sourceEpoch: Number(r.source_epoch),
    geometryGeneration: Number(r.geometry_generation),
    revision: Number(r.revision),
    text: row.text,
    cells: row.cells,
    softWrap: !!r.soft_wrap,
    checkState: checkState(r.check_state),
    checkReason: checkReason(r.check_reason),
    checkedCaptureId: r.checked_capture_id,
    checkedRow: r.checked_row
  };
}
function readProjectionIssues(ram, disk, token) {
  const found = new Map;
  for (const db of [disk, ram.db])
    for (const row of prepared(db, "SELECT * FROM na_issue WHERE pane_key=? AND revision<=?").all(paneId(token.paneKey), token.revision))
      found.set(String(row.issue_id), row);
  return [...found.values()].sort((a, b) => Number(a.revision) - Number(b.revision)).map(projectionIssue);
}
function projectionIssue(r) {
  return {
    issueId: String(r.issue_id),
    sourceEpoch: Number(r.source_epoch),
    revision: Number(r.revision),
    boundaryLineId: r.boundary_line_id === null ? null : Number(r.boundary_line_id),
    kind: String(r.kind),
    reason: String(r.reason),
    missingCount: r.missing_count === null ? null : Number(r.missing_count),
    detectedAt: Number(r.detected_at),
    resolvedAt: r.resolved_at === null ? null : Number(r.resolved_at)
  };
}

class LegacyUnderlay {
  errors = [];
  readers = [];
  floors = new Map;
  constructor(files) {
    for (const file of files) {
      let reader = null;
      try {
        reader = openArchive(file, [], true);
        if (reader.schemaVersion >= 5)
          throw new Error(`schema ${reader.schemaVersion} is not a legacy file`);
        this.readers.push(reader);
      } catch (error) {
        reader?.close();
        this.errors.push(`${file}: ${String(error?.message ?? error)}`);
      }
    }
  }
  get size() {
    return this.readers.length;
  }
  find(key) {
    for (const reader of this.readers) {
      try {
        return { reader, token: reader.token(key) };
      } catch (error) {
        const reason = String(error?.message ?? error);
        if (reason !== "unknown-pane" && !this.errors.includes(`${paneId(key)}: ${reason}`))
          this.errors.push(`${paneId(key)}: ${reason}`);
      }
    }
    return null;
  }
  floor(key, lowest) {
    if (!this.readers.length)
      return null;
    const id = paneId(key);
    if (this.floors.has(id))
      return this.floors.get(id);
    const found = this.find(key), at = found ? lowest() : 0;
    const floor = found && at > 0 && at <= found.token.nextLineId ? { floor: at, ...found } : null;
    this.floors.set(id, floor);
    return floor;
  }
  close() {
    for (const reader of this.readers.splice(0))
      reader.close();
    this.floors.clear();
  }
}
function lowestLine(db, paneNo) {
  const row = prepared(db, "SELECT min(v) AS v FROM (SELECT min(first_line_id) AS v FROM na_block WHERE pane_no=? UNION ALL SELECT min(line_id) FROM na_line WHERE pane_no=?)").get(paneNo, paneNo);
  return row.v === null ? null : Number(row.v);
}
function legacyLines(under, start, end) {
  const lines = [];
  let issues = [];
  for (let at = start;at < end; ) {
    const page = under.reader.readPage(under.token, at, Math.min(2000, end - at));
    lines.push(...page.lines);
    issues = page.issues;
    at = page.nextAnchor;
    if (!page.lines.length)
      break;
  }
  if (lines.length !== end - start)
    throw new Error("page-seam-hole");
  if (start === end)
    issues = under.reader.readPage(under.token, start, 1).issues;
  return { lines, issues };
}
function readProjectionPage(ram, disk, token, anchor, limit, underlay = null) {
  integer(limit);
  if (limit < 1 || limit > 2000)
    throw new Error("page-limit");
  const start = anchor === null ? 0 : integer(anchor), current = ram.token(token.paneKey);
  const matches = () => {
    const now = ram.token(token.paneKey);
    if (now.revision !== token.revision || now.sourceEpoch !== token.sourceEpoch || now.geometryGeneration !== token.geometryGeneration || now.nextLineId !== token.nextLineId)
      throw new Error("page-retry");
  };
  matches();
  const end = Math.min(current.nextLineId, start + limit);
  if (start > current.nextLineId)
    throw new Error("page-anchor");
  const own = underlay && start < underlay.floor ? Math.min(underlay.floor, end) : start;
  const legacy2 = underlay && start <= underlay.floor ? legacyLines(underlay, start, own) : null;
  const no = ram.paneNo(token.paneKey), byId = new Map;
  for (const row of readDiskLines(disk, no, own, end))
    byId.set(Number(row.line_id), row);
  for (const row of prepared(ram.db, "SELECT * FROM na_line WHERE pane_no=? AND line_id>=? AND line_id<? ORDER BY line_id").all(no, own, end))
    byId.set(Number(row.line_id), row);
  const values = [...byId.values()].sort((a, b) => Number(a.line_id) - Number(b.line_id));
  if (values.length !== end - own || values.some((r, i) => r.line_id !== own + i || Number(r.revision) > token.revision))
    throw new Error("page-seam-hole");
  matches();
  return {
    token: { ...current },
    issues: [...legacy2?.issues ?? [], ...readProjectionIssues(ram, disk, current)],
    nextAnchor: end,
    hasMore: end < current.nextLineId,
    lines: [...legacy2?.lines ?? [], ...values.map(projectionLine)]
  };
}
function openProjectionArchive(input, legacyFiles = []) {
  return openArchive(input, legacyFiles, false);
}
function openArchive(input, legacyFiles, sealed) {
  const file = resolve(input), stat = lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1 || /^brain\.db(?:$|[-.])/i.test(basename(file)))
    throw new Error("unsafe-archive-path");
  const fd = openSync(file, "r");
  let version;
  try {
    const head = Buffer.alloc(100), n = readSync(fd, head, 0, 100, 0);
    version = n === 100 && head.subarray(0, 16).toString() === "SQLite format 3\x00" ? head.readUInt32BE(60) : 0;
  } finally {
    closeSync(fd);
  }
  if (version !== 2 && version !== 3 && version !== 4 && version !== 5)
    throw new Error("unsupported-projection-archive");
  const db = sealed && !existsSync(file + "-wal") ? new Database2("file:" + file.split("/").map(encodeURIComponent).join("/") + "?immutable=1", constants.SQLITE_OPEN_READONLY | constants.SQLITE_OPEN_URI) : new Database2(file, { readonly: true, strict: true });
  db.exec("PRAGMA query_only=ON; PRAGMA foreign_keys=ON;");
  let closed = false;
  const legacy2 = version >= 5 && legacyFiles.length ? new LegacyUnderlay(legacyFiles) : null;
  const ensure = () => {
    if (closed)
      throw new Error("archive-closed");
  };
  const own = (key) => {
    ensure();
    const row = prepared(db, "SELECT * FROM na_pane WHERE pane_key=?").get(paneId(key));
    if (!row)
      throw new Error("unknown-pane");
    if (Number(row.revision) !== Number(row.durable_revision))
      throw new Error("archive-watermark-corrupt");
    return {
      paneKey: { ...key },
      sourceEpoch: Number(row.source_epoch),
      geometryGeneration: Number(row.geometry_generation),
      revision: Number(row.revision),
      durableRevision: Number(row.durable_revision),
      nextLineId: Number(row.next_line_id)
    };
  };
  const onlyLegacy = (key) => {
    if (!legacy2)
      return null;
    ensure();
    if (prepared(db, "SELECT 1 FROM na_pane WHERE pane_key=?").get(paneId(key)))
      return null;
    return legacy2.find(key);
  };
  const token = (key) => onlyLegacy(key)?.token ?? own(key);
  return { schemaVersion: version, token, readPage(expected, anchor, limit) {
    ensure();
    integer(limit);
    if (limit < 1 || limit > 2000)
      throw new Error("page-limit");
    const only = onlyLegacy(expected.paneKey);
    if (only)
      return only.reader.readPage(expected, anchor, limit);
    const current = own(expected.paneKey);
    if (current.revision !== expected.revision || current.durableRevision !== expected.durableRevision || current.sourceEpoch !== expected.sourceEpoch || current.geometryGeneration !== expected.geometryGeneration || current.nextLineId !== expected.nextLineId)
      throw new Error("page-retry");
    const start = anchor === null ? 0 : integer(anchor), end = Math.min(current.nextLineId, start + limit);
    if (start > current.nextLineId)
      throw new Error("page-anchor");
    const paneNo = version >= 4 ? Number(prepared(db, "SELECT pane_no FROM na_pane WHERE pane_key=?").get(paneId(expected.paneKey)).pane_no) : -1;
    const under = legacy2?.floor(expected.paneKey, () => lowestLine(db, paneNo) ?? current.nextLineId) ?? null;
    const first = under && start < under.floor ? Math.min(under.floor, end) : start;
    const older = under && start <= under.floor ? legacyLines(under, start, first) : null;
    const rows = version >= 4 ? readDiskLines(db, paneNo, first, end) : prepared(db, "SELECT * FROM na_line WHERE pane_key=? AND line_id>=? AND line_id<? ORDER BY line_id").all(paneId(expected.paneKey), first, end);
    if (rows.length !== end - first || rows.some((row, index) => Number(row.line_id) !== first + index || Number(row.revision) > expected.revision))
      throw new Error("page-seam-hole");
    const issues = [...older?.issues ?? [], ...prepared(db, "SELECT * FROM na_issue WHERE pane_key=? AND revision<=? ORDER BY revision").all(paneId(expected.paneKey), expected.revision).map(projectionIssue)];
    const legacyLine = (row) => ({
      lineId: Number(row.line_id),
      sourceEpoch: Number(row.source_epoch),
      geometryGeneration: Number(row.geometry_generation),
      revision: Number(row.revision),
      text: String(row.text),
      cells: decodeCells(String(row.cells_json)),
      softWrap: !!row.soft_wrap,
      checkState: row.check_state,
      checkReason: String(row.check_reason),
      checkedCaptureId: row.checked_capture_id,
      checkedRow: row.checked_row
    });
    return { token: { ...current }, issues, nextAnchor: end, hasMore: end < current.nextLineId, lines: [...older?.lines ?? [], ...rows.map(version >= 4 ? projectionLine : legacyLine)] };
  }, close() {
    if (!closed) {
      closed = true;
      legacy2?.close();
      closePrepared(db);
    }
  } };
}

// src/sqlite-history/types.ts
var PROJECTION_OVERSIZE = "ingest-oversize";
var isProjectionRefusal = (value) => typeof value === "object" && value !== null && value.accepted === false;

// src/sqlite-history/projection-store.ts
init_schema();
import { Database as Database3 } from "bun:sqlite";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { closeSync as closeSync2, existsSync as existsSync2, fsyncSync, lstatSync as lstatSync2, mkdirSync, openSync as openSync2, readSync as readSync2 } from "node:fs";
import { dirname, join, resolve as resolve2, sep } from "node:path";
import { createHash as createHash3, randomUUID as randomUUID2 } from "node:crypto";
init_codec();
var PENDING_MAX = 16 * 1024 * 1024;
var CACHE_MAX = 256 * 1024 * 1024;
var FLUSH_BYTES = 1024 * 1024;
var DURABLE_BATCH_MS = 20;
var ADMIT_MAX = PENDING_MAX - 64 * 1024;
var CAPACITY_EPISODE_MS = 1e4;
var GUARANTEE_MAX = 768 * 1024;
var ROSTER_MS = 30000;
var SEAL_LINES = 256;
var SEAL_LAG = 128;
var SEAL_UNCHECKED_LAG = 4608;
var SEAL_RETRY_MS = 200;
var SEAL_QUIET_MS = 30000;
var DISK_PAGE_SIZE = 2048;
var WAL_LIMIT = 16 * 1024;
var CHECKPOINT_COMMITS = 5;
var WORKER_GC_COMMITS = 32;
var STORAGE_RETRY_MS = [1000, 2000, 5000];
function isStorageFull(error) {
  const value = error;
  return value?.code === "ENOSPC" || value?.code === "SQLITE_FULL" || /(?:SQLITE_FULL|database or disk is full|\bENOSPC\b|no space left on device)/i.test(String(error));
}
function admitPath(options) {
  const root = resolve2(options.historyRoot), file = resolve2(options.file ?? join(root, PROJECTION_STORE_FILE));
  if (file === root || !file.startsWith(root + sep) || file.split(sep).some((p) => /^brain\.db(?:$|[-.])/i.test(p)))
    throw new Error("forbidden-database-path");
  for (const candidate of [file, file + "-wal", file + "-shm", file + "-journal"]) {
    let current = sep;
    for (const part of candidate.split(sep).filter(Boolean)) {
      current = join(current, part);
      let stat;
      try {
        stat = lstatSync2(current);
      } catch (error) {
        if (error.code === "ENOENT")
          continue;
        throw error;
      }
      if (stat.isSymbolicLink() || !stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1))
        throw new Error("unsafe-database-path");
    }
  }
  if (options.mode === "create" && [file, file + "-wal", file + "-shm", file + "-journal"].some(existsSync2))
    throw new Error("new-file-required");
  if (options.mode === "recover") {
    const fd = openSync2(file, "r");
    try {
      const head = Buffer.alloc(100);
      const n = readSync2(fd, head, 0, 100, 0);
      if (n !== 100 || head.subarray(0, 16).toString() !== "SQLite format 3\x00" || head.readUInt32BE(60) !== PROJECTION_SCHEMA_VERSION)
        throw new Error("not-projection-v5");
    } finally {
      closeSync2(fd);
    }
  } else {
    mkdirSync(dirname(file), { recursive: true, mode: 448 });
    const fd = openSync2(file, "wx", 384);
    closeSync2(fd);
  }
  return file;
}
var blockLine = (row) => BLOCK_COLUMNS.map((column) => row[column]);
var CAPTURE_COLUMNS = ["capture_id", "revision", "source_epoch", "requested_at", "completed_at", "geometry_generation", "first_history_row", "history_count", "screen_hash", "history_hash", "observed_fields", "compared_rows", "corrected_cells", "ambiguous_rows", "result"];
var captureValues = (row) => CAPTURE_COLUMNS.map((column) => row[column]);
var captureRow = (paneNo, values) => {
  if (values.length !== CAPTURE_COLUMNS.length)
    throw new Error("capture-archive-corrupt");
  const row = { pane_no: paneNo };
  CAPTURE_COLUMNS.forEach((column, index) => {
    row[column] = values[index];
  });
  return row;
};
var WORKER_ARCHIVE_SLOTS = ["scans", "scanMs", "countChecks", "chunks", "archived"];
var emptyArchiveStats = () => ({ commits: 0, scans: 0, scanMs: 0, countChecks: 0, chunks: 0, archived: 0, catalogReads: 0, dataReads: 0 });
var archiveStatsByDb = new WeakMap;
function archiveStatsOf(disk) {
  let stats = archiveStatsByDb.get(disk);
  if (!stats) {
    stats = emptyArchiveStats();
    archiveStatsByDb.set(disk, stats);
  }
  return stats;
}
function captureReceipts(disk, paneNo, ids) {
  const found = new Map, wanted = new Set;
  for (const id of ids) {
    if (found.has(id))
      continue;
    const live = prepared(disk, "SELECT * FROM na_capture WHERE pane_no=? AND capture_id=?").get(paneNo, id);
    if (live)
      found.set(id, live);
    else
      wanted.add(id);
  }
  const stats = archiveStatsOf(disk);
  for (let below = Number.MAX_SAFE_INTEGER;wanted.size; ) {
    const page = prepared(disk, "SELECT archive_no,catalog,capture_count FROM na_capture_archive WHERE pane_no=? AND archive_no<? ORDER BY archive_no DESC LIMIT 32").all(paneNo, below);
    if (!page.length)
      break;
    for (const block of page) {
      below = Number(block.archive_no);
      const catalog = decodeCaptureArchive(block.catalog);
      stats.catalogReads++;
      if (catalog.length !== Number(block.capture_count))
        throw new Error("capture-archive-corrupt");
      const hits = [];
      catalog.forEach((item, ordinal) => {
        if (Array.isArray(item) && wanted.has(item[0]))
          hits.push(ordinal);
      });
      if (!hits.length)
        continue;
      const stored = prepared(disk, "SELECT data FROM na_capture_archive WHERE archive_no=?").get(below);
      stats.dataReads++;
      const data = decodeCaptureReceipts(stored.data);
      if (data.length !== catalog.length)
        throw new Error("capture-archive-corrupt");
      for (const ordinal of hits) {
        const row = captureRow(paneNo, data[ordinal]), id = catalog[ordinal][0];
        if (row.capture_id !== id || row.revision !== catalog[ordinal][1] || row.source_epoch !== catalog[ordinal][2] || row.geometry_generation !== catalog[ordinal][3])
          throw new Error("capture-archive-catalog");
        if (wanted.delete(id))
          found.set(id, row);
      }
      if (!wanted.size)
        break;
    }
  }
  if (wanted.size)
    throw new Error("capture-receipt-missing");
  return found;
}
function writeLines(disk, rows) {
  const patches = new Map;
  for (const row of rows) {
    const block = prepared(disk, "SELECT block_no,first_line_id,line_count FROM na_block WHERE pane_no=? AND first_line_id<=? ORDER BY first_line_id DESC LIMIT 1").get(row.pane_no, row.line_id);
    if (!block || Number(row.line_id) >= Number(block.first_line_id) + Number(block.line_count)) {
      upsert(disk, "na_line", row);
      continue;
    }
    const list = patches.get(String(block.block_no)) ?? [];
    list.push(row);
    patches.set(String(block.block_no), list);
  }
  for (const [blockNo, list] of patches) {
    const block = prepared(disk, "SELECT * FROM na_block WHERE block_no=?").get(Number(blockNo));
    const lines = decodeBlock(block.data), first = Number(block.first_line_id);
    let top = Number(block.max_revision);
    for (const row of list) {
      const i = Number(row.line_id) - first;
      if (i < 0 || i >= lines.length)
        throw new Error("block-missing");
      lines[i] = blockLine(row);
      top = Math.max(top, Number(row.revision));
    }
    prepared(disk, "UPDATE na_block SET data=?,max_revision=? WHERE block_no=?").run(encodeBlock(lines), top, Number(blockNo));
  }
}
var sealAttempts = new WeakMap;
var paneHeads = new WeakMap;
function sealBlocks(disk, panes, force, aged) {
  const sealed = new Set;
  let attempts = sealAttempts.get(disk);
  if (!attempts) {
    attempts = new Map;
    sealAttempts.set(disk, attempts);
  }
  let heads = paneHeads.get(disk);
  if (!heads) {
    heads = new Map;
    paneHeads.set(disk, heads);
  }
  const now = performance.now(), clock = archiveClock();
  for (const p of panes) {
    const next = Number(p.next_line_id);
    let head = heads.get(p.pane_no);
    if (!head || head.next !== next) {
      head = { next, since: clock, swept: false };
      heads.set(p.pane_no, head);
    }
    const quiet = clock - head.since >= SEAL_QUIET_MS, tail = force || quiet;
    if (!tail && now - (attempts.get(p.pane_no) ?? -Infinity) < SEAL_RETRY_MS)
      continue;
    attempts.set(p.pane_no, now);
    const groups = prepared(disk, `SELECT line_id/${SEAL_LINES} AS b,count(*) AS n,
      sum(check_state=0 AND check_reason<>1 AND line_id>=?) AS open FROM na_line WHERE pane_no=? GROUP BY b`).all(next - SEAL_UNCHECKED_LAG, p.pane_no);
    let tailSealed = false;
    for (const g of groups) {
      const from = Number(g.b) * SEAL_LINES, n = Number(g.n);
      const part = n < SEAL_LINES ? prepared(disk, "SELECT * FROM na_block WHERE pane_no=? AND first_line_id>=? AND first_line_id<?").get(p.pane_no, from, from + SEAL_LINES) : null;
      const full = n + Number(part?.line_count ?? 0) === SEAL_LINES;
      if (full && from + SEAL_LINES <= next && (Number(g.open) === 0 || from + SEAL_LINES <= next - SEAL_LAG)) {} else if (!tail || Number(g.open) !== 0)
        continue;
      const rows = prepared(disk, "SELECT * FROM na_line WHERE pane_no=? AND line_id>=? AND line_id<? ORDER BY line_id").all(p.pane_no, from, from + SEAL_LINES);
      const byId = new Map;
      let top = Math.max(...rows.map((r) => Number(r.revision)));
      if (part) {
        const first = Number(part.first_line_id);
        decodeBlock(part.data).forEach((line, i) => byId.set(first + i, line));
        top = Math.max(top, Number(part.max_revision));
      }
      for (const row of rows)
        byId.set(Number(row.line_id), blockLine(row));
      const ids = [...byId.keys()].sort((a, b) => a - b), start = ids[0];
      if (ids.at(-1) - start + 1 !== ids.length)
        continue;
      if (part)
        prepared(disk, "DELETE FROM na_block WHERE block_no=?").run(Number(part.block_no));
      prepared(disk, "INSERT INTO na_block (pane_no,first_line_id,line_count,max_revision,data) VALUES (?,?,?,?,?)").run(p.pane_no, start, ids.length, top, encodeBlock(ids.map((id) => byId.get(id))));
      prepared(disk, "DELETE FROM na_line WHERE pane_no=? AND line_id>=? AND line_id<?").run(p.pane_no, from, from + SEAL_LINES);
      sealed.add(Number(p.pane_no));
      if (!full)
        tailSealed = true;
    }
    if (quiet && tailSealed)
      aged?.add(Number(p.pane_no));
  }
  return sealed;
}
var ARCHIVE_MIN = 128;
var ARCHIVE_MAX = 256;
var ARCHIVE_KEEP = 8;
var ARCHIVE_RETRY_MS = 1000;
var ARCHIVE_SCANS_PER_COMMIT = 4;
var ARCHIVE_CHUNKS_PER_COMMIT = 4;
var ARCHIVE_IDLE_MS = 20;
var ARCHIVE_SCAN_SQL = `SELECT c.* FROM na_capture c WHERE c.pane_no=?
      AND c.capture_id NOT IN(SELECT l.checked_capture_id FROM na_line l WHERE l.pane_no=? AND l.checked_capture_id IS NOT NULL)
      AND c.capture_id NOT IN(SELECT recent.capture_id FROM na_capture recent WHERE recent.pane_no=? ORDER BY recent.revision DESC,recent.capture_id DESC LIMIT ${ARCHIVE_KEEP})
      ORDER BY c.revision,c.capture_id LIMIT ${ARCHIVE_MAX}`;
var archiveQueues = new WeakMap;
var archiveClock = () => performance.now();
function archiveQueue(disk) {
  let queue = archiveQueues.get(disk);
  if (!queue) {
    queue = new Map;
    archiveQueues.set(disk, queue);
  }
  return queue;
}
function archiveDueAt(entry) {
  if (entry.released || entry.scannedAt === -Infinity)
    return -Infinity;
  return entry.touched ? entry.scannedAt + ARCHIVE_RETRY_MS : null;
}
function mergeArchiveMarks(queue, marks, touched) {
  for (const paneNo of touched) {
    const entry = queue.get(paneNo);
    if (entry)
      entry.touched = true;
  }
  for (const [paneNo, released] of marks) {
    const entry = queue.get(paneNo);
    if (entry) {
      entry.released ||= released;
      entry.touched = true;
    } else
      queue.set(paneNo, { scannedAt: -Infinity, released, touched: true });
  }
}
function archivePane(disk, paneNo, force, chunkBudget) {
  const stats = archiveStatsOf(disk);
  let chunks = 0;
  for (;; ) {
    const started = performance.now();
    const rows = prepared(disk, ARCHIVE_SCAN_SQL).all(paneNo, paneNo, paneNo);
    stats.scans++;
    stats.scanMs += performance.now() - started;
    if (!rows.length || !force && rows.length < ARCHIVE_MIN)
      return { chunks, more: false };
    const catalog = rows.map((row) => [row.capture_id, row.revision, row.source_epoch, row.geometry_generation]);
    prepared(disk, "INSERT INTO na_capture_archive (pane_no,first_revision,last_revision,capture_count,catalog,data) VALUES (?,?,?,?,?,?)").run(paneNo, rows[0].revision, rows.at(-1).revision, rows.length, encodeCaptureArchive(catalog), encodeCaptureReceipts(rows.map(captureValues)));
    const remove = prepared(disk, "DELETE FROM na_capture WHERE pane_no=? AND capture_id=?");
    for (const row of rows)
      remove.run(paneNo, row.capture_id);
    chunks++;
    stats.chunks++;
    stats.archived += rows.length;
    if (rows.length < ARCHIVE_MAX)
      return { chunks, more: false };
    if (!force && chunks >= chunkBudget)
      return { chunks, more: true };
  }
}
function liveReceipts(disk, paneNo) {
  archiveStatsOf(disk).countChecks++;
  return Number(prepared(disk, "SELECT count(*) AS n FROM na_capture WHERE pane_no=?").get(paneNo).n);
}
function archiveCaptures(disk, marks, force, panes = [], touched = new Set, aged = new Set) {
  const plan = { marks, touched, updates: new Map };
  if (force) {
    for (const paneNo of panes) {
      if (liveReceipts(disk, paneNo) > ARCHIVE_KEEP)
        archivePane(disk, paneNo, true, Infinity);
      plan.updates.set(paneNo, null);
    }
    return plan;
  }
  for (const paneNo of aged) {
    if (liveReceipts(disk, paneNo) > ARCHIVE_KEEP)
      archivePane(disk, paneNo, true, Infinity);
    plan.updates.set(paneNo, null);
  }
  const now = archiveClock(), view = new Map;
  for (const [paneNo, entry] of archiveQueue(disk))
    if (!aged.has(paneNo))
      view.set(paneNo, { ...entry });
  mergeArchiveMarks(view, marks, touched);
  let scans = 0, chunks = 0;
  for (const [paneNo, entry] of view) {
    if (scans >= ARCHIVE_SCANS_PER_COMMIT || chunks >= ARCHIVE_CHUNKS_PER_COMMIT)
      break;
    const due = archiveDueAt(entry);
    if (due === null || now < due)
      continue;
    if (liveReceipts(disk, paneNo) < ARCHIVE_MIN + ARCHIVE_KEEP) {
      plan.updates.set(paneNo, null);
      continue;
    }
    scans++;
    const done = archivePane(disk, paneNo, false, ARCHIVE_CHUNKS_PER_COMMIT - chunks);
    chunks += done.chunks;
    plan.updates.set(paneNo, { scannedAt: now, released: done.more, touched: false });
  }
  return plan;
}
function archiveNextDue(disk) {
  let next = null;
  for (const entry of archiveQueue(disk).values()) {
    const due = archiveDueAt(entry);
    if (due !== null && (next === null || due < next))
      next = due;
  }
  return next;
}
function quietNextDue(disk) {
  let next = null;
  for (const head of paneHeads.get(disk)?.values() ?? [])
    if (!head.swept && (next === null || head.since + SEAL_QUIET_MS < next))
      next = head.since + SEAL_QUIET_MS;
  return next;
}
function archiveBacklog(disk) {
  const next = archiveNextDue(disk);
  return next !== null && next <= archiveClock();
}
function drainArchives(disk, fence) {
  let plan = null;
  disk.transaction(() => {
    if (Number(Object.values(prepared(disk, "PRAGMA application_id").get())[0]) !== fence)
      throw new Error("stale-writer");
    const heads = paneHeads.get(disk), now = archiveClock(), aged = new Set, marks = new Map;
    const quiet = [...heads?.entries() ?? []].filter(([, head]) => !head.swept && now - head.since >= SEAL_QUIET_MS).map(([paneNo]) => paneNo);
    for (const paneNo of quiet)
      heads.get(paneNo).swept = true;
    const panes = quiet.map((paneNo) => prepared(disk, "SELECT * FROM na_pane WHERE pane_no=?").get(paneNo)).filter((p) => !!p);
    for (const paneNo of sealBlocks(disk, panes, false, aged))
      marks.set(paneNo, true);
    plan = archiveCaptures(disk, marks, false, [], new Set, aged);
  }).immediate();
  const done = plan;
  if (!done)
    return;
  applyArchivePlan(disk, done);
  if (done.updates.size)
    disk.exec("PRAGMA wal_checkpoint(PASSIVE)");
}
function applyArchivePlan(disk, plan) {
  const queue = archiveQueue(disk);
  mergeArchiveMarks(queue, plan.marks, plan.touched);
  for (const [paneNo, update] of plan.updates) {
    queue.delete(paneNo);
    if (update)
      queue.set(paneNo, update);
  }
  archiveStatsOf(disk).commits++;
}
function commitBatch(disk, fence, batch, before, checkpoint = false, forceSeal = false) {
  const started = performance.now();
  let writeMs = 0, archiveMs = 0, plan = null;
  const marks = new Map;
  disk.transaction(() => {
    if (Number(Object.values(prepared(disk, "PRAGMA application_id").get())[0]) !== fence)
      throw new Error("stale-writer");
    const existing = prepared(disk, "SELECT digest FROM na_commit WHERE commit_id=?").get(batch.id);
    if (existing) {
      if (existing.digest !== batch.digest)
        throw new Error("commit-id-conflict");
      writeMs = performance.now() - started;
      return;
    }
    for (const p of batch.panes)
      upsert(disk, "na_pane", { ...p, durable_revision: p.revision });
    for (const [table, rows] of batch.tables) {
      if (table === "na_line")
        writeLines(disk, rows);
      else
        for (const row of rows)
          upsert(disk, table, row);
    }
    prepared(disk, "INSERT INTO na_commit VALUES (?,coalesce((SELECT max(commit_seq) FROM na_commit),0)+1,?,?,?,?)").run(batch.id, Math.max(...batch.panes.map((p) => Number(p.revision))), Date.now(), JSON.stringify(batch.panes.map((p) => ({ paneKey: p.pane_key, revision: p.revision, nextLineId: p.next_line_id }))), batch.digest);
    prepared(disk, "DELETE FROM na_commit WHERE commit_id<>?").run(batch.id);
    const aged = new Set, sealed = sealBlocks(disk, batch.panes, forceSeal, aged);
    for (const row of batch.tables.get("na_capture") ?? [])
      marks.set(Number(row.pane_no), false);
    for (const paneNo of sealed)
      marks.set(paneNo, true);
    const archiveStarted = performance.now();
    plan = archiveCaptures(disk, marks, forceSeal, forceSeal ? batch.panes.map((p) => Number(p.pane_no)) : [], new Set(batch.panes.map((p) => Number(p.pane_no))), aged);
    archiveMs = performance.now() - archiveStarted;
    before?.();
    writeMs = performance.now() - started;
  }).immediate();
  if (plan)
    applyArchivePlan(disk, plan);
  if (checkpoint)
    disk.exec("PRAGMA wal_checkpoint(PASSIVE)");
  const totalMs = performance.now() - started;
  return { totalMs, writeMs, commitMs: totalMs - writeMs, archiveMs };
}
if (!isMainThread && workerData?.projectionDiskWriter === true) {
  const signal = new Int32Array(workerData.signal);
  const errors = new Uint8Array(workerData.signal, 8);
  const disk = new Database3(workerData.file, { strict: true });
  disk.exec(`PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL; PRAGMA busy_timeout=250; PRAGMA cache_size=-8192; PRAGMA journal_size_limit=${WAL_LIMIT};`);
  let commits = 0;
  let sinceCollect = 0;
  const collect = () => {
    if (++sinceCollect >= WORKER_GC_COMMITS) {
      sinceCollect = 0;
      Bun.gc(true);
    }
  };
  const stats = archiveStatsOf(disk);
  let reported = { ...stats };
  let drainTimer = null;
  const drain = () => {
    drainTimer = null;
    try {
      drainArchives(disk, workerData.fence);
    } catch (error) {
      console.error("[newarch] archive drain failed", String(error));
      return;
    }
    collect();
    scheduleDrain();
  };
  const scheduleDrain = () => {
    const due = [archiveNextDue(disk), quietNextDue(disk)].filter((t) => t !== null), next = due.length ? Math.min(...due) : null;
    if (!drainTimer && next !== null)
      drainTimer = setTimeout(drain, Math.max(ARCHIVE_IDLE_MS, next - archiveClock()));
  };
  const onMessage = (batch) => {
    if (batch === "heap") {
      parentPort.postMessage({ heap: process.memoryUsage().heapUsed, commits });
      return;
    }
    if (batch === "close") {
      if (drainTimer) {
        clearTimeout(drainTimer);
        drainTimer = null;
      }
      try {
        closePrepared(disk);
      } catch (error) {
        console.error("[newarch] disk worker close failed", String(error));
      }
      parentPort.off("message", onMessage);
      parentPort.close();
      return;
    }
    try {
      if (drainTimer) {
        clearTimeout(drainTimer);
        drainTimer = null;
      }
      const timing = commitBatch(disk, workerData.fence, batch, undefined, ++commits % CHECKPOINT_COMMITS === 0);
      Atomics.store(signal, 2, Math.round(timing.totalMs * 1000));
      Atomics.store(signal, 3, Math.round(timing.writeMs * 1000));
      Atomics.store(signal, 4, Math.round(timing.archiveMs * 1000));
      WORKER_ARCHIVE_SLOTS.forEach((field, i) => Atomics.store(signal, 5 + i, field === "scanMs" ? Math.round((stats.scanMs - reported.scanMs) * 1000) : stats[field] - reported[field]));
      reported = { ...stats };
      Atomics.store(signal, 0, 1);
      scheduleDrain();
    } catch (error) {
      const bytes = new TextEncoder().encode(String(error)).subarray(0, errors.length);
      errors.set(bytes);
      Atomics.store(signal, 1, bytes.length);
      Atomics.store(signal, 0, 2);
    }
    Atomics.notify(signal, 0);
    parentPort.postMessage(batch.id);
    collect();
  };
  parentPort.on("message", onMessage);
}
var settle = (job, ok, value) => {
  for (const w of [job, ...job.waiters ?? []])
    ok ? w.resolve(value) : w.reject(value);
};

class ProjectionStore {
  options;
  ram = new ProjectionRam;
  disk;
  file;
  legacy;
  fence = 0;
  queues = new Map;
  queuedBytes = 0;
  pendingByPane = new Map;
  dirtyByPane = new Map;
  capacityLosses = new Map;
  dirtyBytes = 0;
  dirtySince = null;
  pumping = false;
  pumpTurnAt = performance.now();
  closed = false;
  degraded = false;
  stopped = false;
  pressureBytes = 0;
  timer;
  retry = null;
  storageStatus = "healthy";
  storageEventId = null;
  storageReason = null;
  storageAttempt = 0;
  storageRetryAt = null;
  storageResult = null;
  storageBatchId = null;
  closeReceipt = null;
  worker = null;
  heapWaiters = [];
  signal = new Int32Array(new SharedArrayBuffer(4104));
  inFlight = false;
  diskTiming = { totalMs: 0, writeMs: 0, commitMs: 0, archiveMs: 0 };
  workerArchive = emptyArchiveStats();
  frameWrites = { count: 0, totalMs: 0, maxMs: 0 };
  closing = false;
  rejectedRows = 0;
  screenBytes = new Map;
  dirtyFaults = new Set;
  faultEmitted = new Map;
  faults = new Map;
  lastCommitAt = null;
  lastFlushAgeMs = 0;
  cacheMax;
  roster = new Map;
  rosterSize = 0;
  rosterAt = 0;
  pressureRefusals = 0;
  ramBatches = 0;
  ramBatchOperations = 0;
  ramBytesCache = -1;
  refusedBytes = new Map;
  lastOversize = new Map;
  drainWaiters = [];
  durableWaiters = [];
  constructor(options) {
    this.options = options;
    this.cacheMax = options.cacheBytes ?? CACHE_MAX;
    this.file = admitPath(options);
    options.beforeOpen?.(this.file);
    this.disk = new Database3(this.file, { strict: true });
    try {
      this.disk.exec(`PRAGMA page_size=${DISK_PAGE_SIZE}; PRAGMA auto_vacuum=INCREMENTAL; PRAGMA busy_timeout=250; PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA cache_size=-8192; PRAGMA journal_size_limit=${WAL_LIMIT};`);
      this.disk.transaction(() => {
        const version = Number(Object.values(prepared(this.disk, "PRAGMA user_version").get())[0]);
        if (options.mode === "create") {
          if (version !== 0 || prepared(this.disk, "SELECT name FROM sqlite_master WHERE type='table'").all().length)
            throw new Error("new-file-required");
          this.disk.exec(PROJECTION_SCHEMA);
          this.disk.exec(`PRAGMA user_version=${PROJECTION_SCHEMA_VERSION}`);
        } else if (version !== PROJECTION_SCHEMA_VERSION)
          throw new Error("not-projection-v5");
        else {
          const sql = prepared(this.disk, "SELECT group_concat(sql,' ') AS s FROM sqlite_master WHERE name IN ('na_line','na_capture','na_block','na_capture_archive')").get().s;
          if (PROJECTION_SCHEMA_MARKERS.some((m) => !String(sql).includes(m)))
            throw new Error("projection-schema-outdated");
        }
        const epoch = Number(Object.values(prepared(this.disk, "PRAGMA application_id").get())[0]);
        if (epoch < 0 || epoch >= 2147483647)
          throw new Error("writer-fence-exhausted");
        this.fence = epoch + 1;
        this.disk.exec(`PRAGMA application_id=${this.fence}`);
      }).immediate();
      this.disk.exec("PRAGMA wal_checkpoint(FULL)");
      const fd = openSync2(dirname(this.file), "r");
      try {
        fsyncSync(fd);
      } finally {
        closeSync2(fd);
      }
      this.recover();
    } catch (error) {
      closePrepared(this.disk);
      closePrepared(this.ram.db);
      throw error;
    }
    const root = resolve2(options.historyRoot);
    this.legacy = new LegacyUnderlay((options.legacyArchives ?? (options.file === undefined ? PROJECTION_LEGACY_FILES.map((f) => join(root, f)).filter((f) => existsSync2(f)) : [])).map((f) => resolve2(root, f)).filter((f) => f !== this.file));
    for (const reason of this.legacy.errors)
      this.reportLegacy(reason);
    this.ram.firstLineId = (key) => this.legacy.find(key)?.token.nextLineId ?? 0;
    try {
      this.ensureWorker();
    } catch (error) {
      this.legacy.close();
      closePrepared(this.ram.db);
      closePrepared(this.disk);
      throw error;
    }
    this.timer = setInterval(() => {
      try {
        if (this.stopped)
          this.relievePressure();
        if (this.inFlight && Atomics.load(this.signal, 0) !== 0)
          this.finishWorker();
        const retryDue = !this.retry || this.storageRetryAt === null || Date.now() >= this.storageRetryAt;
        if (!this.inFlight && retryDue && (this.retry || this.dirtyBytes >= FLUSH_BYTES || this.dirtySince !== null && Date.now() - this.dirtySince >= DURABLE_BATCH_MS))
          this.flushAsync();
      } catch (error) {
        this.handleFlushFailure(error);
      }
      if (this.storageStatus === "healthy" && this.pendingAge() > 1000)
        this.fault("flush-overdue", "pending age exceeded 1s");
    }, 5);
    this.timer.unref();
  }
  reportLegacy(reason) {
    try {
      this.options.onFault?.({ kind: "legacy-archive-unavailable", reason, at: Date.now(), pendingBytes: 0 });
    } catch {
      console.error("[newarch] fault sink failed");
    }
  }
  underlay(key) {
    if (!this.legacy.size)
      return null;
    const seen = this.legacy.errors.length;
    const floor = this.legacy.floor(key, () => {
      const no = this.ram.paneNo(key);
      const found = [lowestLine(this.disk, no), lowestLine(this.ram.db, no)].filter((v) => v !== null);
      return found.length ? Math.min(...found) : this.ram.token(key).nextLineId;
    });
    for (const reason of this.legacy.errors.slice(seen))
      this.reportLegacy(reason);
    return floor;
  }
  legacyArchives() {
    return { opened: this.legacy.size, errors: [...this.legacy.errors] };
  }
  owner() {
    if (this.closed)
      throw new Error("store-closed");
    if (Number(Object.values(prepared(this.disk, "PRAGMA application_id").get())[0]) !== this.fence)
      throw new Error("stale-writer");
  }
  recover() {
    this.ram.db.transaction(() => {
      for (const row of prepared(this.disk, "SELECT * FROM na_pane").all()) {
        if (row.revision !== row.durable_revision)
          throw new Error("durable-watermark-corrupt");
        upsert(this.ram.db, "na_pane", row);
        const floor = Math.max(0, Number(row.next_line_id) - 5000);
        const lines = readDiskLines(this.disk, Number(row.pane_no), floor, Number(row.next_line_id));
        const ids = new Set(lines.map((l) => l.checked_capture_id).filter((id) => id !== null).map(String));
        for (const receipt of captureReceipts(this.disk, Number(row.pane_no), ids).values())
          upsert(this.ram.db, "na_capture", receipt);
        for (const line of lines)
          upsert(this.ram.db, "na_line", line);
      }
    })();
    this.relievePressure();
    if (this.ram.bytes() > this.cacheMax)
      throw new Error("recovery-cache-limit");
    this.rejectedRows = Number(prepared(this.disk, "SELECT coalesce(sum(missing_count),0) AS n FROM na_issue WHERE kind IN (?,'ingest-capacity')").get(PROJECTION_OVERSIZE).n);
    this.degraded = !!prepared(this.ram.db, "SELECT 1 FROM na_pane WHERE health!='healthy' LIMIT 1").get();
    const last = prepared(this.disk, "SELECT committed_at FROM na_commit ORDER BY committed_at DESC LIMIT 1").get();
    this.lastCommitAt = last ? Number(last.committed_at) : null;
  }
  pendingAge() {
    const times = [...this.retry ? [this.retry.since] : [], ...this.dirtySince === null ? [] : [this.dirtySince], ...[...this.queues.values()].map((q) => q[0]?.at).filter((v) => v !== undefined)];
    return times.length ? Math.max(0, Date.now() - Math.min(...times)) : 0;
  }
  pendingBytes() {
    return this.dirtyBytes + this.queuedBytes + (this.retry?.bytes ?? 0);
  }
  storageSnapshot(status = this.storageStatus, result = this.storageResult) {
    const panes = prepared(this.ram.db, "SELECT * FROM na_pane").all().map((p) => ({
      paneKey: { serverIdentity: String(p.server_identity), paneId: String(p.pane_id), birthGeneration: Number(p.birth_generation) },
      sourceEpoch: Number(p.source_epoch),
      revision: Number(p.revision),
      durableRevision: Number(p.durable_revision),
      nextLineId: Number(p.next_line_id)
    }));
    return {
      status,
      eventId: this.storageEventId,
      at: Date.now(),
      reason: this.storageReason,
      pendingBytes: this.pendingBytes(),
      unknownTail: status !== "healthy",
      retry: { batchId: this.retry?.id ?? this.storageBatchId, attempt: this.storageAttempt, nextAt: this.storageRetryAt, result },
      panes
    };
  }
  emitStorage(status = this.storageStatus, result = this.storageResult) {
    try {
      this.options.onStorageState?.(this.storageSnapshot(status, result));
    } catch {
      console.error("[newarch] storage-state sink failed");
    }
  }
  handleFlushFailure(error) {
    if (isStorageFull(error)) {
      this.storageEventId ??= randomUUID2();
      this.storageStatus = "storage-paused";
      this.storageReason = String(error);
      this.storageBatchId = this.retry?.id ?? this.storageBatchId;
      this.storageAttempt++;
      this.storageResult = "failed";
      this.storageRetryAt = Date.now() + STORAGE_RETRY_MS[Math.min(this.storageAttempt - 1, STORAGE_RETRY_MS.length - 1)];
      this.stopped = true;
      this.emitStorage();
    }
    this.fault("flush-failed", String(error));
  }
  fault(kind, reason, key, lostRows = 1) {
    this.degraded = true;
    const now = Date.now();
    const panes = key ? [this.ram.pane(key)] : prepared(this.ram.db, "SELECT * FROM na_pane").all();
    let emit = false;
    this.ram.db.transaction(() => {
      for (const p of panes) {
        const tag = String(p.pane_key) + ":" + kind, capacity = kind === PROJECTION_OVERSIZE;
        let previous = this.faults.get(tag);
        if (previous && capacity && now - previous.seen > CAPACITY_EPISODE_MS)
          previous = undefined;
        const count = (previous?.count ?? 0) + (capacity ? lostRows : 0);
        if (previous && kind !== PROJECTION_OVERSIZE && now - previous.last < 1000)
          continue;
        if (!this.dirtyFaults.has(tag) && this.pendingBytes() + 1024 > PENDING_MAX)
          continue;
        if (!previous || now - previous.last >= 1000)
          emit = true;
        const id = previous?.id ?? randomUUID2();
        prepared(this.ram.db, "UPDATE na_pane SET health=?,revision=revision+1 WHERE pane_key=?").run(p.health === "unverified" ? "unverified" : "degraded", p.pane_key);
        prepared(this.ram.db, `INSERT INTO na_issue VALUES (?,?,?,?,?,?,?,?,?,NULL)
          ON CONFLICT(issue_id) DO UPDATE SET revision=excluded.revision,missing_count=excluded.missing_count,reason=excluded.reason`).run(id, p.pane_key, p.source_epoch, Number(p.revision) + 1, p.next_line_id, kind, reason, capacity ? count : null, previous?.detected ?? now);
        this.faults.set(tag, { id, pane: String(p.pane_key), last: emit ? now : previous.last, seen: now, detected: previous?.detected ?? now, count, revision: Number(p.revision) + 1 });
        if (!this.dirtyFaults.has(tag)) {
          this.dirtyBytes += 1024;
          this.dirtyFaults.add(tag);
        }
        this.dirtySince ??= now;
      }
    })();
    if (!emit && panes.length)
      return;
    if (now - (this.faultEmitted.get(kind) ?? 0) < 1000)
      return;
    this.faultEmitted.set(kind, now);
    const fault = { kind, reason, at: now, pendingBytes: this.pendingBytes(), panes: panes.map((p) => ({
      paneKey: { serverIdentity: String(p.server_identity), paneId: String(p.pane_id), birthGeneration: Number(p.birth_generation) },
      sourceEpoch: Number(p.source_epoch),
      boundaryLineId: Number(p.next_line_id),
      missingCount: kind === PROJECTION_OVERSIZE ? lostRows : null
    })) };
    try {
      this.options.onFault?.(fault);
    } catch {
      console.error("[newarch] fault sink failed");
    }
    console.error("[newarch]", JSON.stringify(fault));
  }
  liveRam() {
    if (this.ramBytesCache < 0)
      this.ramBytesCache = this.ram.bytes();
    return this.ramBytesCache;
  }
  rosterCount(id, now) {
    const seen = this.roster.get(id);
    this.roster.set(id, now);
    if (seen === undefined || now - seen > ROSTER_MS)
      this.rosterSize++;
    if (now - this.rosterAt >= 250) {
      this.rosterAt = now;
      for (const [pane, at] of this.roster)
        if (now - at > ROSTER_MS)
          this.roster.delete(pane);
      this.rosterSize = this.roster.size;
    }
    return Math.max(1, this.rosterSize);
  }
  quota(roster) {
    const half = Math.floor(ADMIT_MAX / 2);
    return { guarantee: Math.min(GUARANTEE_MAX, Math.floor(half / (roster + 1))), pool: ADMIT_MAX - half };
  }
  maxEvent() {
    const q = this.quota(1);
    return q.guarantee + Math.floor(q.pool / 2);
  }
  capacity(key, bytes, frame = false) {
    if (this.pendingBytes() + bytes > ADMIT_MAX)
      return "store";
    if (frame)
      return "ok";
    const id = paneId(key), mine = this.pendingByPane.get(id) ?? 0;
    const { guarantee, pool } = this.quota(this.rosterCount(id, Date.now()));
    if (mine + bytes <= guarantee)
      return "ok";
    let borrowed = 0, borrowers = 1;
    for (const [pane, used] of this.pendingByPane)
      if (pane !== id && used > guarantee) {
        borrowed += used - guarantee;
        borrowers++;
      }
    const mineBorrow = mine + bytes - guarantee;
    return mineBorrow <= Math.floor(pool / Math.max(2, borrowers)) && borrowed + mineBorrow <= pool ? "ok" : "pane";
  }
  pressure(key, bytes, scope, isScroll) {
    if (scope === "store") {
      this.stopped = true;
      this.pressureBytes = Math.max(this.pressureBytes, bytes);
    }
    this.pressureRefusals++;
    if (isScroll)
      this.refusedBytes.set(paneId(key), bytes);
    this.kickFlush();
    return { accepted: false, reason: "capacity-pressure", scope };
  }
  rejectOversize(key, value, isScroll, identity = null) {
    const id = paneId(key);
    if (identity === null || this.lastOversize.get(id) !== identity) {
      if (identity !== null)
        this.lastOversize.set(id, identity);
      this.degraded = true;
      if (isScroll)
        this.rejectedRows++;
      const pending = this.capacityLosses.get(id);
      if (pending) {
        if (isScroll)
          pending.count++;
      } else {
        if (!prepared(this.ram.db, "SELECT 1 FROM na_pane WHERE pane_key=?").get(id)) {
          const first = this.queues.get(id)?.[0] ?? value;
          this.ram.ensure(key, first.sourceEpoch, first.geometryGeneration);
        }
        this.capacityLosses.set(id, { key: { ...key }, count: isScroll ? 1 : 0 });
        this.fault(PROJECTION_OVERSIZE, "incoming event larger than an idle store admits; accepted rows retained", key, 0);
      }
    }
    throw new Error(PROJECTION_OVERSIZE);
  }
  drained(key) {
    try {
      this.owner();
      if (this.closing)
        throw new Error("store-closing");
      const id = paneId(key);
      if (this.admissible(id, key))
        return Promise.resolve();
      this.kickFlush();
      return new Promise((resolve3, reject) => this.drainWaiters.push({ id, key, resolve: resolve3, reject }));
    } catch (error) {
      return Promise.reject(error);
    }
  }
  admissible(id, key) {
    const bytes = this.refusedBytes.get(id) ?? 512;
    return !this.stopped && this.liveRam() + bytes <= this.cacheMax && this.capacity(key, bytes) === "ok";
  }
  settleDrains() {
    if (!this.drainWaiters.length)
      return;
    const waiting = this.drainWaiters;
    this.drainWaiters = [];
    for (const w of waiting) {
      if (this.admissible(w.id, w.key))
        w.resolve();
      else
        this.drainWaiters.push(w);
    }
  }
  durable(key, revision) {
    try {
      this.owner();
      const t = this.ram.token(key);
      if (!Number.isSafeInteger(revision) || revision < 0 || revision > t.revision)
        throw new Error("invalid-revision");
      if (t.durableRevision >= revision)
        return Promise.resolve({ revision: t.revision, durableRevision: t.durableRevision, nextLineId: t.nextLineId });
      const result = new Promise((resolve3, reject) => this.durableWaiters.push({ key: { ...key }, revision, resolve: resolve3, reject }));
      this.kickFlush();
      return result;
    } catch (error) {
      return Promise.reject(error);
    }
  }
  settleDurable(final = false) {
    if (!this.durableWaiters.length)
      return;
    const waiting = this.durableWaiters;
    this.durableWaiters = [];
    for (const w of waiting) {
      const t = this.ram.token(w.key);
      if (t.durableRevision >= w.revision)
        w.resolve({ revision: t.revision, durableRevision: t.durableRevision, nextLineId: t.nextLineId });
      else if (final)
        w.reject(new Error("store-closed"));
      else
        this.durableWaiters.push(w);
    }
  }
  relievePressure() {
    const reserve = Math.max(512, this.pressureBytes, ...this.refusedBytes.values());
    if (this.liveRam() + reserve > this.cacheMax) {
      const panes = prepared(this.ram.db, "SELECT * FROM na_pane").all().map((p) => ({ ...p, revision: p.durable_revision }));
      for (let keep = 2500;this.liveRam() + reserve > this.cacheMax; keep = Math.floor(keep / 2)) {
        this.ram.db.transaction(() => this.ram.evict(panes, keep))();
        this.ramBytesCache = -1;
        if (keep === 0)
          break;
      }
    }
    if (this.storageStatus === "healthy" && this.liveRam() + reserve <= this.cacheMax && this.pendingBytes() < PENDING_MAX / 2) {
      this.stopped = false;
      this.pressureBytes = 0;
    }
    this.settleDrains();
  }
  kickFlush() {
    if (this.inFlight || this.closed || this.closing)
      return;
    if (this.retry && this.storageRetryAt !== null && Date.now() < this.storageRetryAt)
      return;
    try {
      this.flushAsync();
    } catch (error) {
      this.handleFlushFailure(error);
    }
  }
  drainLosses() {
    for (const [id, loss] of this.capacityLosses) {
      const tag = id + ":" + PROJECTION_OVERSIZE;
      if (!this.dirtyFaults.has(tag) && this.pendingBytes() + 1024 > PENDING_MAX)
        continue;
      this.fault(PROJECTION_OVERSIZE, "incoming history event rejected; accepted rows retained", loss.key, loss.count);
      this.capacityLosses.delete(id);
    }
  }
  reserve(id, bytes, dirty = false) {
    const next = (this.pendingByPane.get(id) ?? 0) + bytes;
    if (next === 0)
      this.pendingByPane.delete(id);
    else
      this.pendingByPane.set(id, next);
    if (dirty)
      this.dirtyByPane.set(id, (this.dirtyByPane.get(id) ?? 0) + bytes);
  }
  enqueue(key, input, operation, kind, preparedBytes) {
    try {
      if (this.closed)
        throw new Error("store-closed");
      if (this.closing)
        throw new Error("store-closing");
      const value = input.capture ?? input;
      const id = paneId(key), isScroll = kind === "scroll", storeOnly = kind !== "scroll";
      const bytes = preparedBytes ?? Buffer.byteLength(JSON.stringify(input)) + 512;
      if (bytes > this.maxEvent())
        this.rejectOversize(key, value, isScroll);
      const scope = this.liveRam() + bytes > this.cacheMax ? "store" : this.capacity(key, bytes, storeOnly);
      if (scope !== "ok") {
        if (kind === "barrier") {
          this.pressure(key, bytes, scope, false);
          throw new Error("capacity-pressure");
        }
        return Promise.resolve(this.pressure(key, bytes, scope, isScroll));
      }
      if (isScroll)
        this.refusedBytes.delete(id);
      const frozen = preparedBytes === undefined ? structuredClone(input) : input;
      this.reserve(id, bytes);
      this.queuedBytes += bytes;
      const screenKey = kind === "frame" ? id + ":" + input.kind : undefined;
      const result = new Promise((resolve3, reject) => {
        const q = this.queues.get(id) ?? [];
        q.push({ liveFrame: kind === "frame", barrier: kind === "barrier", screenKey, sourceEpoch: value.sourceEpoch, geometryGeneration: value.geometryGeneration, bytes, at: Date.now(), run: () => operation(frozen), resolve: resolve3, reject });
        this.queues.set(id, q);
      });
      if (!this.pumping) {
        this.pumping = true;
        if (performance.now() - this.pumpTurnAt >= 2)
          setTimeout(() => {
            this.pumpTurnAt = performance.now();
            this.pump();
          }, 0);
        else
          queueMicrotask(() => this.pump());
      }
      return result;
    } catch (error) {
      return Promise.reject(error);
    }
  }
  pump() {
    try {
      this.owner();
    } catch (error) {
      for (const [id, q] of this.queues)
        for (const job of q) {
          this.reserve(id, -job.bytes);
          settle(job, false, error);
        }
      this.queues.clear();
      this.queuedBytes = 0;
      this.pumping = false;
      return;
    }
    let processed = 0;
    const started = performance.now(), work = [];
    while (this.queues.size && processed < 128 && (processed === 0 || performance.now() - started < 4)) {
      const [id, q] = this.queues.entries().next().value;
      if (q[0].barrier && work.length)
        break;
      this.queues.delete(id);
      const job = q.shift();
      if (q.length)
        this.queues.set(id, q);
      this.queuedBytes -= job.bytes;
      work.push({ id, job });
      processed++;
      if (job.barrier)
        break;
    }
    const results = [];
    try {
      this.ram.db.transaction(() => {
        for (const { id, job } of work)
          try {
            const receipt = this.ram.db.transaction(() => job.run())();
            results.push({ id, job, receipt });
          } catch (error) {
            results.push({ id, job, error });
          }
      })();
      this.ramBatches++;
      this.ramBatchOperations += work.length;
      for (const { id, job, receipt, error } of results)
        if (error === undefined) {
          const replaced = job.screenKey ? this.screenBytes.get(job.screenKey) ?? 0 : 0;
          if (job.screenKey) {
            this.screenBytes.set(job.screenKey, job.bytes);
            this.reserve(id, -replaced);
          }
          this.dirtyByPane.set(id, (this.dirtyByPane.get(id) ?? 0) + job.bytes - replaced);
          this.dirtyBytes += job.bytes - replaced;
          this.dirtySince ??= job.at;
          settle(job, true, receipt);
        } else {
          this.reserve(id, -job.bytes);
          settle(job, false, error);
        }
    } catch (error) {
      for (const { id, job } of work) {
        this.reserve(id, -job.bytes);
        settle(job, false, error);
      }
    }
    this.ramBytesCache = -1;
    if (this.queues.size)
      setTimeout(() => {
        this.pumpTurnAt = performance.now();
        this.pump();
      }, 0);
    else
      this.pumping = false;
  }
  appendScroll(event) {
    try {
      if (this.closed)
        throw new Error("store-closed");
      if (this.closing)
        throw new Error("store-closing");
      if (this.storageStatus !== "healthy")
        return Promise.resolve(this.pressure(event.paneKey, 512, "store", true));
      const id = paneId(event.paneKey), text = event.physicalRow.text, estimate = text.length + 512;
      if (estimate > this.maxEvent())
        this.rejectOversize(event.paneKey, event, true, `${event.sourceEpoch}:${event.receiveSeq}:${text.length}:${text.slice(0, 32)}:${text.slice(-32)}`);
      const paused = this.refusedBytes.get(id);
      if (paused !== undefined && !this.admissible(id, event.paneKey))
        return Promise.resolve(this.pressure(event.paneKey, Math.max(paused, estimate), "pane", true));
      const scope = this.liveRam() + estimate > this.cacheMax ? "store" : this.capacity(event.paneKey, estimate);
      if (scope !== "ok")
        return Promise.resolve(this.pressure(event.paneKey, estimate, scope, true));
      const cells = event.physicalRow.cells;
      validateRow({ text, cells });
      const stored = encodeRow(text, cells);
      const frozen = {
        paneKey: { ...event.paneKey },
        sourceEpoch: event.sourceEpoch,
        geometryGeneration: event.geometryGeneration,
        receiveSeq: event.receiveSeq,
        softWrap: event.softWrap,
        physicalRow: { text, cells: [] },
        stored
      };
      const bytes = Buffer.byteLength(stored.text) + Buffer.byteLength(stored.cells) + Buffer.byteLength(id) + 512;
      return this.enqueue(frozen.paneKey, frozen, (e) => this.ram.append(e, e.stored), "scroll", bytes);
    } catch (error) {
      return Promise.reject(error);
    }
  }
  replaceScreen(frame) {
    try {
      this.owner();
      if (this.closing)
        throw new Error("store-closing");
      if (this.storageStatus !== "healthy")
        return Promise.resolve(this.pressure(frame.paneKey, 512, "store", false));
      const pane = paneId(frame.paneKey), id = pane + ":" + frame.kind;
      const same = (job) => job.sourceEpoch === frame.sourceEpoch && job.geometryGeneration === frame.geometryGeneration && !job.barrier;
      const queued = this.queues.get(pane) ?? [];
      let fence = -1;
      queued.forEach((job, i) => {
        if (!same(job))
          fence = i;
      });
      if (fence >= 0) {
        const prior = queued.findIndex((job, i) => i > fence && job.screenKey === id);
        if (prior >= 0) {
          const job = queued[prior];
          const result = this.coalesce(job, frame);
          queued.splice(prior, 1);
          queued.push(job);
          return result;
        }
        validateFrame(frame);
        const encoded2 = encodeFrameCells(frame.cells), frozen = { ...structuredClone({ ...frame, cells: [] }), encodedCells: encoded2 };
        return this.enqueue(frame.paneKey, frozen, (f) => {
          this.ram.screen(f, null, null, [], f.encodedCells);
          return this.ram.bump(f.paneKey);
        }, "frame", Buffer.byteLength(encoded2) + Buffer.byteLength(pane) + 512);
      }
      const previous = this.screenBytes.get(id) ?? 0;
      validateFrame(frame);
      const encoded = encodeFrameCells(frame.cells);
      const bytes = Buffer.byteLength(encoded) + Buffer.byteLength(pane) + 512, delta = bytes - previous;
      if (bytes > this.maxEvent())
        this.rejectOversize(frame.paneKey, frame, false, `frame:${frame.sourceEpoch}:${frame.receiveSeq}:${bytes}`);
      const scope = this.liveRam() + Math.max(0, delta) > this.cacheMax ? "store" : this.capacity(frame.paneKey, delta, true);
      if (scope !== "ok")
        return Promise.resolve(this.pressure(frame.paneKey, bytes, scope, false));
      const written = performance.now();
      const receipt = this.ram.db.transaction(() => {
        this.ram.screen(frame, null, null, [], encoded);
        return this.ram.bump(frame.paneKey);
      })();
      const writeMs = performance.now() - written;
      this.frameWrites.count++;
      this.frameWrites.totalMs += writeMs;
      this.frameWrites.maxMs = Math.max(this.frameWrites.maxMs, writeMs);
      if (delta > 0)
        this.ramBytesCache = -1;
      this.reserve(pane, delta, true);
      this.dirtyBytes += delta;
      this.screenBytes.set(id, bytes);
      this.dirtySince ??= Date.now();
      for (let i = queued.length - 1;i >= 0; i--)
        if (queued[i].screenKey === id) {
          const [old] = queued.splice(i, 1);
          this.reserve(pane, -old.bytes);
          this.queuedBytes -= old.bytes;
          settle(old, true, receipt);
        }
      if (!queued.length)
        this.queues.delete(pane);
      return Promise.resolve(receipt);
    } catch (error) {
      return Promise.reject(error);
    }
  }
  coalesce(tail, frame) {
    validateFrame(frame);
    const id = paneId(frame.paneKey), encoded = encodeFrameCells(frame.cells), bytes = Buffer.byteLength(encoded) + Buffer.byteLength(id) + 512 + 128 * ((tail.waiters?.length ?? 0) + 1), delta = bytes - tail.bytes;
    if (bytes > this.maxEvent())
      this.rejectOversize(frame.paneKey, frame, false, `frame:${frame.sourceEpoch}:${frame.receiveSeq}:${bytes}`);
    const scope = this.liveRam() + Math.max(0, delta) > this.cacheMax ? "store" : this.capacity(frame.paneKey, delta, true);
    if (scope !== "ok")
      return Promise.resolve(this.pressure(frame.paneKey, bytes, scope, false));
    const frozen = structuredClone({ ...frame, cells: [] });
    tail.run = () => {
      this.ram.screen(frozen, null, null, [], encoded);
      return this.ram.bump(frozen.paneKey);
    };
    this.reserve(id, delta);
    this.queuedBytes += delta;
    tail.bytes = bytes;
    return new Promise((resolve3, reject) => {
      (tail.waiters ??= []).push({ resolve: resolve3, reject });
    });
  }
  admitCas(issue) {
    if (this.closed)
      throw new Error("store-closed");
    if (this.ram.revisionOf(issue.paneKey) !== issue.expectedRevision)
      throw new Error("stale-revision");
  }
  recordIssue(issue) {
    try {
      this.admitCas(issue);
    } catch (error) {
      this.externalFault(issue, error);
      return Promise.reject(error);
    }
    return this.enqueue(issue.paneKey, issue, (value) => {
      const receipt = this.ram.recordIssue(value, undefined, true);
      this.degraded = true;
      return receipt;
    }, "barrier").catch((error) => {
      this.externalFault(issue, error);
      throw error;
    });
  }
  transitionEpoch(change) {
    try {
      this.admitCas(change);
    } catch (error) {
      this.externalFault(change, error);
      return Promise.reject(error);
    }
    return this.enqueue(change.paneKey, change, (value) => {
      const receipt = this.ram.recordIssue(value, value.nextEpoch, true);
      this.degraded = true;
      return receipt;
    }, "barrier").then((receipt) => {
      this.kickFlush();
      return receipt;
    }, (error) => {
      this.externalFault(change, error);
      throw error;
    });
  }
  externalFault(issue, error) {
    try {
      this.options.onFault?.({ kind: issue.kind, reason: issue.reason + "; journal rejected: " + String(error), at: Date.now(), pendingBytes: this.pendingBytes(), panes: [{ paneKey: { ...issue.paneKey }, sourceEpoch: issue.sourceEpoch, boundaryLineId: issue.boundaryLineId, missingCount: issue.missingCount }] });
    } catch {
      console.error("[newarch] fault sink failed");
    }
  }
  calibrate(change) {
    const historyOnly = change.captureEvidence?.kind !== "quiescent";
    try {
      if (this.closed)
        throw new Error("store-closed");
      const pane = paneId(change.capture.paneKey), revision = this.ram.revisionOf(change.capture.paneKey);
      if (historyOnly ? change.expectedRevision > revision : this.queues.get(pane)?.length || revision !== change.expectedRevision)
        throw new Error("stale-revision");
    } catch (error) {
      return Promise.reject(error);
    }
    try {
      const c = change.capture;
      validateFrame(c);
      const seenLines = new Set, seenRows = new Set;
      for (const m of [...change.checks, ...change.repairs, ...change.contentMatches ?? []]) {
        if (!Number.isSafeInteger(m.lineId) || m.lineId < 0 || !Number.isSafeInteger(m.captureRow) || m.captureRow < 0 || !c.history[m.captureRow] || seenLines.has(m.lineId) || seenRows.has(m.captureRow))
          throw new Error("duplicate-or-invalid-mapping");
        seenLines.add(m.lineId);
        seenRows.add(m.captureRow);
      }
      const history = c.history.map((row) => {
        validateRow(row);
        return { text: row.text, encoded: encodeCells(row.cells) };
      });
      const encodedScreen = encodeFrameCells(c.cells);
      const metadata = structuredClone({ ...change, capture: { ...c, cells: [], history: [] }, checks: [], repairs: [], contentMatches: [] });
      const repairs = change.repairs.map((r) => {
        validateRow(r.physicalRow);
        return { ...r, physicalRow: { text: r.physicalRow.text, encoded: encodeCells(r.physicalRow.cells) } };
      });
      const checks = change.checks.map((r) => ({ ...r })), matches = (change.contentMatches ?? []).map((r) => ({ ...r }));
      const chunkSize = 256, count = Math.max(1, Math.ceil(history.length / chunkSize)), batchId = randomUUID2();
      const chunks = Array.from({ length: count }, (_, i) => {
        const start = i * chunkSize, end = start + chunkSize;
        const mapped = (rows) => rows.filter((r) => r.captureRow >= start && r.captureRow < end).map((r) => ({ ...r, captureRow: r.captureRow - start }));
        const chunk = {
          ...metadata,
          expectedRevision: change.expectedRevision + i,
          captureEvidence: i === count - 1 ? metadata.captureEvidence : null,
          capture: {
            ...metadata.capture,
            encodedScreen,
            history: history.slice(start, end),
            captureId: count === 1 ? c.captureId : `${c.captureId}:${batchId}:${i}`,
            firstHistoryRow: c.firstHistoryRow + start
          },
          checks: mapped(checks),
          contentMatches: mapped(matches),
          repairs: mapped(repairs)
        };
        return { chunk, bytes: Buffer.byteLength(JSON.stringify(chunk)) + 512 };
      });
      const jobs = chunks.map(({ chunk, bytes }) => this.enqueue(c.paneKey, chunk, (f) => {
        const physical = (row) => ({ text: row.text, cells: decodeCells(row.encoded) });
        const thawed = {
          ...f,
          capture: { ...f.capture, cells: decodeFrameCells(f.capture.encodedScreen), history: f.capture.history.map(physical) },
          repairs: f.repairs.map((r) => ({ ...r, physicalRow: physical(r.physicalRow) }))
        };
        const no = this.ram.paneNo(f.capture.paneKey);
        const missing = [...f.checks, ...f.repairs, ...f.contentMatches].map((m) => m.lineId).filter((lineId) => !prepared(this.ram.db, "SELECT 1 FROM na_line WHERE pane_no=? AND line_id=?").get(no, lineId));
        if (missing.length) {
          const wanted = new Set(missing);
          const rows = readDiskLines(this.disk, no, Math.min(...missing), Math.max(...missing) + 1).filter((row) => wanted.has(Number(row.line_id)));
          const receipts = captureReceipts(this.disk, no, rows.filter((row) => row.checked_capture_id !== null).map((row) => String(row.checked_capture_id)));
          for (const row of rows) {
            if (row.checked_capture_id !== null)
              upsert(this.ram.db, "na_capture", receipts.get(String(row.checked_capture_id)));
            upsert(this.ram.db, "na_line", row);
          }
        }
        return this.ram.calibrate(thawed, historyOnly);
      }, "barrier", bytes));
      return Promise.allSettled(jobs).then((results) => {
        const failed = results.find((r) => r.status === "rejected");
        if (failed?.status === "rejected")
          throw failed.reason;
        return results[results.length - 1].value;
      });
    } catch (error) {
      return Promise.reject(error);
    }
  }
  token(key) {
    this.owner();
    return this.ram.token(key);
  }
  screen(key, kind = "normal") {
    this.owner();
    const row = prepared(this.ram.db, "SELECT * FROM na_screen WHERE pane_key=? AND screen_kind=?").get(paneId(key), kind);
    return row ? { ...row, cells_json: JSON.stringify(decodeFrameCells(String(row.cells_json))) } : null;
  }
  readPage(token, anchor, limit) {
    this.owner();
    return readProjectionPage(this.ram, this.disk, token, anchor, limit, this.underlay(token.paneKey));
  }
  snapshot() {
    if (this.retry)
      return this.retry;
    this.drainLosses();
    if (!this.dirtyBytes && this.dirtySince === null)
      return null;
    const panes = prepared(this.ram.db, "SELECT * FROM na_pane WHERE revision>durable_revision").all();
    const tables = new Map;
    for (const table of ["na_capture", "na_line", "na_issue"]) {
      const rows = [];
      const column = table === "na_issue" ? "pane_key" : "pane_no";
      for (const p of panes)
        rows.push(...prepared(this.ram.db, `SELECT * FROM ${table} WHERE ${column}=? AND revision>?`).all(p[column], p.durable_revision));
      tables.set(table, rows);
    }
    const digest = createHash3("sha256").update(JSON.stringify([panes, [...tables]])).digest("hex");
    this.retry = { id: randomUUID2(), digest, panes, tables, bytes: this.dirtyBytes, since: this.dirtySince ?? Date.now(), byPane: this.dirtyByPane };
    this.dirtyBytes = 0;
    this.dirtyByPane = new Map;
    this.dirtySince = null;
    this.screenBytes.clear();
    this.dirtyFaults.clear();
    return this.retry;
  }
  acknowledge() {
    const batch = this.retry;
    this.options.checkpoint?.("after-disk-commit", batch.id);
    this.options.checkpoint?.("before-watermark", batch.id);
    this.ram.db.transaction(() => {
      for (const p of batch.panes)
        prepared(this.ram.db, "UPDATE na_pane SET durable_revision=? WHERE pane_key=?").run(p.revision, p.pane_key);
      this.ram.evict(batch.panes);
    })();
    this.lastCommitAt = Date.now();
    this.lastFlushAgeMs = this.lastCommitAt - batch.since;
    for (const [id, bytes] of batch.byPane)
      this.reserve(id, -bytes);
    if (this.storageStatus !== "healthy")
      this.storageBatchId = batch.id;
    this.retry = null;
    if (this.storageStatus === "storage-paused") {
      this.storageStatus = "recovering";
      this.storageRetryAt = null;
      this.storageResult = "succeeded";
      this.emitStorage("recovering", "succeeded");
    }
    this.drainLosses();
    this.ramBytesCache = -1;
    this.relievePressure();
    if (!this.stopped && this.pendingBytes() < PENDING_MAX / 2 && this.liveRam() + 512 <= this.cacheMax) {
      for (const p of batch.panes) {
        if (p.health === "degraded" && this.ram.pane({ serverIdentity: String(p.server_identity), paneId: String(p.pane_id), birthGeneration: Number(p.birth_generation) }).health === "degraded" && this.pendingBytes() + 512 <= PENDING_MAX && !this.capacityLosses.has(String(p.pane_key)) && ![...this.faults.values()].some((f) => f.pane === p.pane_key && f.revision > Number(p.revision))) {
          prepared(this.ram.db, "UPDATE na_pane SET health='healthy',revision=revision+1 WHERE pane_key=?").run(p.pane_key);
          for (const [tag, f] of this.faults)
            if (f.pane === p.pane_key && !tag.endsWith(":" + PROJECTION_OVERSIZE))
              this.faults.delete(tag);
          this.dirtyBytes += 512;
          this.dirtySince ??= Date.now();
        }
      }
      this.degraded = !!prepared(this.ram.db, "SELECT 1 FROM na_pane WHERE health!='healthy' LIMIT 1").get();
    }
    const now = Date.now();
    for (const [tag, f] of this.faults)
      if (tag.endsWith(":" + PROJECTION_OVERSIZE) && now - f.seen > CAPACITY_EPISODE_MS && !this.capacityLosses.has(f.pane))
        this.faults.delete(tag);
    this.settleDurable();
    this.settleDrains();
    if (this.storageStatus === "recovering" && this.retry === null && this.dirtyBytes === 0 && this.dirtySince === null) {
      this.storageStatus = "healthy";
      this.stopped = false;
      this.storageReason = null;
      this.storageRetryAt = null;
      this.emitStorage("healthy", "succeeded");
      this.storageEventId = null;
      this.storageAttempt = 0;
      this.storageResult = null;
      this.storageBatchId = null;
      this.settleDrains();
    }
  }
  finishWorker() {
    const state = Atomics.load(this.signal, 0);
    if (!state)
      return;
    this.inFlight = false;
    if (state === 2)
      throw new Error(new TextDecoder().decode(new Uint8Array(this.signal.buffer, 8, Atomics.load(this.signal, 1))));
    const totalMs = Atomics.load(this.signal, 2) / 1000, writeMs = Atomics.load(this.signal, 3) / 1000;
    this.diskTiming = { totalMs, writeMs, commitMs: totalMs - writeMs, archiveMs: Atomics.load(this.signal, 4) / 1000 };
    WORKER_ARCHIVE_SLOTS.forEach((field, i) => {
      const v = Atomics.load(this.signal, 5 + i);
      this.workerArchive[field] += field === "scanMs" ? v / 1000 : v;
    });
    this.workerArchive.commits++;
    this.acknowledge();
  }
  ensureWorker() {
    if (this.worker)
      return;
    this.worker = new Worker(new URL(import.meta.url), { workerData: { projectionDiskWriter: true, file: this.file, fence: this.fence, signal: this.signal.buffer } });
    const failed = (error) => {
      if (this.closed)
        return;
      const bytes = new TextEncoder().encode(String(error)).subarray(0, 4096);
      new Uint8Array(this.signal.buffer, 8).set(bytes);
      Atomics.store(this.signal, 1, bytes.length);
      Atomics.store(this.signal, 0, 2);
      Atomics.notify(this.signal, 0);
    };
    this.worker.on("message", (id) => {
      if (typeof id !== "string") {
        for (const resolve3 of this.heapWaiters.splice(0))
          resolve3(id);
        return;
      }
      if (this.closed || !this.inFlight || this.retry?.id !== id)
        return;
      try {
        this.finishWorker();
        if (!this.closing && (this.dirtyBytes || this.dirtySince !== null))
          this.flushAsync();
      } catch (error) {
        this.handleFlushFailure(error);
      }
    });
    this.worker.on("error", failed);
    this.worker.on("exit", (code) => {
      this.worker = null;
      for (const resolve3 of this.heapWaiters.splice(0))
        resolve3(null);
      if (!this.closed)
        failed(new Error(`disk-worker-exited:${code}`));
    });
    this.worker.unref();
  }
  flushAsync() {
    this.owner();
    const batch = this.snapshot();
    if (!batch)
      return;
    this.ensureWorker();
    this.options.checkpoint?.("before-disk-commit", batch.id);
    Atomics.store(this.signal, 0, 0);
    this.inFlight = true;
    this.worker.postMessage(batch);
  }
  flush() {
    this.owner();
    try {
      if (this.inFlight) {
        if (Atomics.wait(this.signal, 0, 0, 5000) === "timed-out")
          throw new Error("disk-worker-timeout");
        this.finishWorker();
      }
      let batch;
      while (batch = this.snapshot()) {
        const current = batch;
        this.diskTiming = commitBatch(this.disk, this.fence, current, () => this.options.checkpoint?.("before-disk-commit", current.id), false, true);
        this.acknowledge();
      }
      let plan = null;
      this.disk.transaction(() => {
        const panes = prepared(this.disk, "SELECT * FROM na_pane").all();
        sealBlocks(this.disk, panes, true);
        plan = archiveCaptures(this.disk, new Map, true, panes.map((p) => Number(p.pane_no)));
      }).immediate();
      if (plan)
        applyArchivePlan(this.disk, plan);
      this.disk.exec("PRAGMA incremental_vacuum");
      this.disk.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch (error) {
      this.handleFlushFailure(error);
      throw error;
    }
  }
  paneHealth(key) {
    this.owner();
    const id = paneId(key), p = prepared(this.ram.db, "SELECT health,revision FROM na_pane WHERE pane_key=?").get(id);
    if (!p)
      return null;
    const issues = new Map;
    for (const db of [this.disk, this.ram.db])
      for (const issue of prepared(db, "SELECT * FROM na_issue WHERE pane_key=?").all(id))
        if (Number(issue.revision) <= Number(p.revision))
          issues.set(String(issue.issue_id), issue);
    return {
      status: p.health === "healthy" ? "healthy" : "degraded",
      issues: [...issues.values()].sort((a, b) => Number(a.revision) - Number(b.revision)).map(projectionIssue)
    };
  }
  diskWorkerHeap() {
    const worker = this.worker;
    if (!worker)
      return Promise.resolve(null);
    return new Promise((resolve3) => {
      this.heapWaiters.push(resolve3);
      worker.postMessage("heap");
    });
  }
  archiveStats() {
    const own = archiveStatsOf(this.disk), sum = emptyArchiveStats();
    for (const key of Object.keys(sum))
      sum[key] = own[key] + this.workerArchive[key];
    return sum;
  }
  frameStats() {
    return { codec: frameCodecStats(), writes: { ...this.frameWrites } };
  }
  health() {
    this.owner();
    if (this.storageStatus === "healthy" && this.pendingAge() > 1000 && !this.degraded)
      this.fault("flush-overdue", "pending age exceeded 1s");
    const rows = prepared(this.ram.db, "SELECT * FROM na_pane").all();
    const revisions = new Map(rows.map((p) => [String(p.pane_key), Number(p.revision)]));
    const byPane = new Map;
    for (const db of [this.disk, this.ram.db])
      for (const issue of prepared(db, "SELECT * FROM na_issue").all()) {
        const id = String(issue.pane_key);
        if (Number(issue.revision) > (revisions.get(id) ?? -1))
          continue;
        let issues = byPane.get(id);
        if (!issues) {
          issues = new Map;
          byPane.set(id, issues);
        }
        issues.set(String(issue.issue_id), issue);
      }
    const panes = rows.map((p) => ({
      paneKey: { serverIdentity: String(p.server_identity), paneId: String(p.pane_id), birthGeneration: Number(p.birth_generation) },
      sourceEpoch: Number(p.source_epoch),
      geometryGeneration: Number(p.geometry_generation),
      revision: Number(p.revision),
      durableRevision: Number(p.durable_revision),
      nextLineId: Number(p.next_line_id),
      status: p.health === "healthy" ? "healthy" : "degraded",
      recovery: p.health === "unverified" ? "external" : "automatic",
      issues: [...byPane.get(String(p.pane_key))?.values() ?? []].sort((a, b) => Number(a.revision) - Number(b.revision)).map(projectionIssue)
    }));
    return {
      pressure: this.stopped || this.refusedBytes.size ? "recoverable" : "none",
      pressureRefusals: this.pressureRefusals,
      status: this.stopped ? "stopped" : this.degraded ? "degraded" : "healthy",
      pendingBytes: this.pendingBytes(),
      rejectedRows: this.rejectedRows,
      pendingAgeMs: this.pendingAge(),
      ramBytes: this.ram.bytes(),
      rssBytes: process.memoryUsage().rss,
      lastFlushAgeMs: this.lastFlushAgeMs,
      lastCommitAt: this.lastCommitAt,
      ramBatches: this.ramBatches,
      ramBatchOperations: this.ramBatchOperations,
      averageRamOperationsPerBatch: this.ramBatches ? this.ramBatchOperations / this.ramBatches : 0,
      storage: this.storageSnapshot(),
      panes
    };
  }
  async close() {
    if (this.closed)
      return this.closeReceipt;
    this.closing = true;
    clearInterval(this.timer);
    try {
      while (this.pumping)
        await new Promise((resolve3) => setTimeout(resolve3, 1));
      try {
        this.flush();
      } catch (error) {
        if (!isStorageFull(error))
          throw error;
        this.storageStatus = "closed-incomplete";
        this.storageReason = String(error);
        this.storageResult = "failed";
        this.storageRetryAt = null;
        this.emitStorage();
      }
      const storage = this.storageSnapshot();
      this.closeReceipt = {
        drained: storage.status === "healthy" && storage.pendingBytes === 0,
        unknownTail: storage.status !== "healthy",
        pendingBytes: storage.pendingBytes,
        storage
      };
    } finally {
      if (this.closeReceipt === null) {
        const storage = this.storageSnapshot();
        this.closeReceipt = { drained: false, unknownTail: storage.status !== "healthy", pendingBytes: storage.pendingBytes, storage };
      }
      try {
        this.settleDurable(true);
      } catch {
        for (const w of this.durableWaiters.splice(0))
          w.reject(new Error("store-closed"));
      }
      for (const w of this.drainWaiters.splice(0))
        w.reject(new Error("store-closed"));
      this.closed = true;
      try {
        await this.stopWorker();
      } finally {
        this.legacy.close();
        closePrepared(this.ram.db);
        closePrepared(this.disk);
      }
    }
    return this.closeReceipt;
  }
  async stopWorker() {
    const worker = this.worker;
    if (!worker)
      return;
    const exited = await new Promise((resolve3) => {
      const timer = setTimeout(() => resolve3(false), 5000);
      worker.once("exit", () => {
        clearTimeout(timer);
        resolve3(true);
      });
      worker.postMessage("close");
    });
    if (!exited) {
      console.error("[newarch] disk worker did not exit after close; terminating");
      try {
        this.options.onFault?.({ kind: "shutdown-timeout", reason: "disk worker did not acknowledge close; emergency termination", at: Date.now(), pendingBytes: this.pendingBytes() });
      } catch {
        console.error("[newarch] fault sink failed");
      }
      await worker.terminate().catch(() => {});
    }
  }
}
function createProjectionStore(options) {
  return new ProjectionStore(options);
}
var projectionArchiveInternals = {
  commitBatch,
  drainArchives,
  captureReceipts,
  archiveStatsOf,
  archiveQueue,
  archiveBacklog,
  archiveNextDue,
  quietNextDue,
  ARCHIVE_SCAN_SQL,
  limits: { ARCHIVE_MIN, ARCHIVE_MAX, ARCHIVE_KEEP, ARCHIVE_RETRY_MS, ARCHIVE_SCANS_PER_COMMIT, ARCHIVE_CHUNKS_PER_COMMIT, ARCHIVE_IDLE_MS, SEAL_LINES, SEAL_QUIET_MS },
  setClock(clock) {
    archiveClock = clock ?? (() => performance.now());
  }
};

// src/pipe-vt-worker.ts
import { spawn, spawnSync } from "node:child_process";
import { createHash as createHash4 } from "node:crypto";
import { closeSync as closeSync3, constants as constants2, mkdtempSync, openSync as openSync3, readFileSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as join2 } from "node:path";
import { createConnection } from "node:net";

// src/pipe-vt-assets.ts
var PIPE_VT_VENDOR_SHA256 = "626c68240ce421066a4c915fca0ca0b44576a274fc14d89cae85e6105a79940d";
var PIPE_VT_WORKER_FILE = "pipe-vt-worker.py";
var PIPE_VT_VENDOR_FILE = "pipe-vt-vendor.zip";
var PIPE_VT_LICENSE_FILE = "pipe-vt-LICENSE.txt";

// src/pipe-vt-worker.ts
function pipeVtRunCells(run) {
  return typeof run[3] === "string" ? run[3].split("") : run[3];
}
function pipeVtAssets(directory = import.meta.dir) {
  return {
    worker: join2(directory, PIPE_VT_WORKER_FILE),
    vendor: join2(directory, PIPE_VT_VENDOR_FILE),
    license: join2(directory, PIPE_VT_LICENSE_FILE)
  };
}
function verifyPipeVtAssets(assets) {
  const sha2 = createHash4("sha256").update(readFileSync(assets.vendor)).digest("hex");
  if (sha2 !== PIPE_VT_VENDOR_SHA256) {
    throw new Error(`pipe-vt vendor hash mismatch: expected ${PIPE_VT_VENDOR_SHA256}, got ${sha2}`);
  }
  const license = readFileSync(assets.license, "utf8");
  if (!license.includes("GNU LESSER GENERAL PUBLIC LICENSE") || !license.includes(PIPE_VT_VENDOR_SHA256)) {
    throw new Error("pipe-vt licence file does not cover the pinned vendor archive");
  }
  readFileSync(assets.worker);
  return sha2;
}
var PIPE_VT_TRACE_PENDING_MAX = 8192;
var PIPE_VT_DATA_QUEUE_BYTES = 1024 * 1024;
var PIPE_VT_CONTROL_RESERVE_BYTES = 64 * 1024;
var OUTPUT_HIGH_WATERMARK = 1024 * 1024;
var OUTPUT_LOW_WATERMARK = 256 * 1024;
function header(kind, length) {
  const out = Buffer.allocUnsafe(5);
  out.write(kind, 0, "latin1");
  out.writeUInt32BE(length, 1);
  return out;
}

class PipeVtPool {
  options;
  current = null;
  generations = new Set;
  closed = false;
  constructor(options = {}) {
    this.options = options;
  }
  launch() {
    const assets = this.options.assets ?? pipeVtAssets();
    verifyPipeVtAssets(assets);
    const directory = mkdtempSync(join2(tmpdir(), "pipe-vt-pool-"));
    const path = join2(directory, "worker.sock");
    const child = spawn(this.options.python ?? "python3", ["-B", assets.worker, "--multiplex", path], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", PYTHONDONTWRITEBYTECODE: "1", LANG: "C.UTF-8" }
    });
    let resolveReady, rejectReady, resolveDone;
    const ready = new Promise((resolve3, reject) => {
      resolveReady = resolve3;
      rejectReady = reject;
    });
    ready.catch(() => {});
    const done = new Promise((resolve3) => {
      resolveDone = resolve3;
    });
    const generation = { child, directory, path, ready, done, users: 0, dead: false, sockets: new Set };
    this.generations.add(generation);
    let stderr = "", output = "";
    const timer = setTimeout(() => {
      rejectReady(new Error("shared parser startup timed out"));
      child.kill("SIGKILL");
    }, 5000);
    child.stderr?.on("data", (data) => {
      stderr = (stderr + data.toString()).slice(-2000);
    });
    child.stdout?.on("data", (data) => {
      output = (output + data.toString()).slice(-4096);
      if (output.includes(`MULTIPLEX_READY
`)) {
        clearTimeout(timer);
        resolveReady();
      }
    });
    child.on("error", rejectReady);
    child.on("exit", () => {
      generation.dead = true;
      for (const socket of generation.sockets)
        socket.destroy();
    });
    child.on("close", () => {
      generation.dead = true;
      clearTimeout(timer);
      rejectReady(new Error(`shared parser exited: ${stderr}`));
      if (this.current === generation)
        this.current = null;
      rmSync(directory, { recursive: true, force: true });
      this.generations.delete(generation);
      resolveDone();
    });
    return generation;
  }
  async acquire() {
    if (this.closed)
      throw new Error("parser pool closed");
    const gen = this.current && !this.current.dead ? this.current : this.current = this.launch();
    gen.users++;
    let released = false;
    const release = async () => {
      if (released)
        return;
      released = true;
      if (--gen.users === 0) {
        if (this.current === gen)
          this.current = null;
        gen.dead = true;
        gen.child.kill("SIGKILL");
        await gen.done;
      }
    };
    try {
      await gen.ready;
      if (gen.dead || this.closed)
        throw new Error("shared parser exited during attach");
      const socket = createConnection({ path: gen.path });
      gen.sockets.add(socket);
      socket.once("close", () => gen.sockets.delete(socket));
      return { socket, pid: gen.child.pid, done: gen.done, release, kill: (signal) => {
        gen.dead = true;
        if (this.current === gen)
          this.current = null;
        gen.child.kill(signal);
      } };
    } catch (error) {
      await release();
      throw error;
    }
  }
  async close() {
    this.closed = true;
    for (const gen of this.generations) {
      gen.dead = true;
      gen.child.kill("SIGKILL");
    }
    await Promise.all([...this.generations].map((gen) => gen.done));
  }
}

class PipeVtWorker {
  options;
  lease = null;
  socket = null;
  quitAck = false;
  leaseDone = Promise.resolve();
  child = null;
  pending = Buffer.alloc(0);
  closing = false;
  exited = false;
  readyResolve = null;
  readyReject = null;
  exitWaiters = [];
  inputDir = null;
  inputFd = null;
  queue = [];
  queuedBytes = 0;
  outputTail = Promise.resolve();
  outputPendingBytes = 0;
  outputPaused = false;
  abandoned = false;
  closePromise = null;
  flushTimer = null;
  traceSeqs = [];
  traceTimes = [];
  traceEpochs = [];
  traceEpochCensored = 0;
  traceHead = 0;
  traceDropped = 0;
  ready;
  pid = null;
  constructor(options) {
    this.options = options;
    this.ready = new Promise((resolve3, reject) => {
      this.readyResolve = resolve3;
      this.readyReject = reject;
    });
    this.ready.catch(() => {});
  }
  notifyFault(event) {
    try {
      this.options.onFault(event);
    } catch (error) {
      console.error("[pipe-vt] onFault callback failed:", error);
    }
  }
  async startShared() {
    try {
      const lease = await this.options.pool.acquire();
      this.lease = lease;
      this.pid = lease.pid;
      const socket = this.socket = lease.socket;
      socket.on("data", (chunk) => this.receiveOutput(chunk));
      let channelError;
      socket.on("error", (error) => {
        channelError = error;
      });
      socket.on("close", () => {
        this.exited = true;
        this.leaseDone = lease.release();
        for (const waiter of this.exitWaiters.splice(0))
          waiter();
        (async () => {
          let timer;
          try {
            await Promise.race([lease.done, new Promise((resolve3) => {
              timer = setTimeout(resolve3, 100);
            })]);
          } finally {
            if (timer)
              clearTimeout(timer);
          }
          const message = channelError?.message ?? "shared parser channel closed unexpectedly; unacknowledged tail is unknown";
          this.readyReject?.(new Error(message));
          if (!this.closing) {
            this.notifyFault({ kind: "worker-exit", at: (this.options.now ?? Date.now)(), message });
          }
        })();
      });
      const attach = Buffer.alloc(12);
      attach.writeUInt16BE(this.options.cols);
      attach.writeUInt16BE(this.options.rows, 2);
      attach.writeBigUInt64BE(BigInt(this.options.sourceEpoch ?? 1), 4);
      socket.write(Buffer.concat([header("A", attach.length), attach]));
    } catch (error) {
      this.socket?.destroy();
      await this.lease?.release();
      this.readyReject?.(error);
      this.notifyFault({ kind: "spawn", at: (this.options.now ?? Date.now)(), message: String(error) });
    }
  }
  start() {
    const assets = this.options.assets ?? pipeVtAssets();
    const now = this.options.now ?? Date.now;
    try {
      verifyPipeVtAssets(assets);
    } catch (error) {
      const message = error.message;
      this.notifyFault({ kind: "vendor-hash", at: now(), message });
      this.readyReject?.(new Error(message));
      return this.ready;
    }
    if (this.options.pool) {
      this.startShared();
      return this.ready;
    }
    this.inputDir = mkdtempSync(join2(tmpdir(), "pipe-vt-"));
    const fifo = join2(this.inputDir, "in.fifo");
    if (spawnSync("mkfifo", ["-m", "600", fifo]).status !== 0) {
      const message = `mkfifo failed for ${fifo}`;
      this.notifyFault({ kind: "spawn", at: now(), message });
      this.readyReject?.(new Error(message));
      this.releaseInput();
      return this.ready;
    }
    this.inputFd = openSync3(fifo, constants2.O_RDWR | constants2.O_NONBLOCK);
    const child = spawn(this.options.python ?? "python3", ["-B", assets.worker, String(this.options.cols), String(this.options.rows), fifo, String(this.options.sourceEpoch ?? 1)], { stdio: ["ignore", "pipe", "pipe"], env: { PATH: process.env.PATH ?? "/usr/bin:/bin", PYTHONDONTWRITEBYTECODE: "1", LANG: "C.UTF-8" } });
    this.child = child;
    this.pid = child.pid ?? null;
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      if (stderr.length < 64 * 1024)
        stderr += chunk.toString("utf8");
    });
    child.stdout?.on("data", (chunk) => this.receiveOutput(chunk));
    child.on("error", (error) => {
      this.notifyFault({ kind: "spawn", at: now(), message: error.message });
      this.readyReject?.(error);
    });
    child.on("close", (code, signal) => {
      this.exited = true;
      this.releaseInput();
      if (!this.closing) {
        const message = `worker exited code=${code} signal=${signal} ${stderr.slice(-2000)}`.trim();
        this.notifyFault({ kind: "worker-exit", at: now(), message });
        this.readyReject?.(new Error(message));
      }
      for (const waiter of this.exitWaiters.splice(0))
        waiter();
    });
    return this.ready;
  }
  receiveOutput(chunk) {
    if (this.abandoned)
      return;
    this.outputPendingBytes += chunk.byteLength;
    if (!this.outputPaused && this.outputPendingBytes > OUTPUT_HIGH_WATERMARK) {
      this.outputPaused = true;
      (this.socket ?? this.child?.stdout)?.pause();
    }
    const arrivedAt = this.options.onStageTrace ? this.traceClock() : 0;
    this.outputTail = this.outputTail.then(() => this.onStdout(chunk, arrivedAt)).catch((error) => {
      this.notifyFault({ kind: "protocol", at: (this.options.now ?? Date.now)(), message: String(error) });
    }).then(() => this.releaseOutput(chunk.byteLength));
  }
  terminateChannel() {
    if (this.socket)
      this.socket.destroy();
    else
      this.child?.kill("SIGKILL");
  }
  releaseOutput(bytes) {
    this.outputPendingBytes -= bytes;
    if (this.outputPaused && this.outputPendingBytes <= OUTPUT_LOW_WATERMARK) {
      this.outputPaused = false;
      (this.socket ?? this.child?.stdout)?.resume();
    }
  }
  inputBacklogBytes() {
    return this.socket?.writableLength ?? this.queuedBytes;
  }
  outputBacklogBytes() {
    return this.outputPendingBytes;
  }
  traceBacklog() {
    return { pending: this.traceSeqs.length - this.traceHead, dropped: this.traceDropped, retained: this.traceSeqs.length, epochCensored: this.traceEpochCensored };
  }
  traceClock() {
    return (this.options.traceNow ?? performance.now.bind(performance))();
  }
  traceFeed(seq, fedAt, epoch) {
    if (this.traceSeqs.length - this.traceHead >= PIPE_VT_TRACE_PENDING_MAX) {
      this.traceHead++;
      this.traceDropped++;
    }
    this.traceSeqs.push(seq);
    this.traceTimes.push(fedAt);
    this.traceEpochs.push(epoch);
    this.compactTrace();
  }
  compactTrace() {
    if (this.traceHead > 1024 && this.traceHead * 2 > this.traceSeqs.length) {
      this.traceSeqs = this.traceSeqs.slice(this.traceHead);
      this.traceTimes = this.traceTimes.slice(this.traceHead);
      this.traceEpochs = this.traceEpochs.slice(this.traceHead);
      this.traceHead = 0;
    }
  }
  traceAck(seqTo, epoch) {
    let n = 0, first = null, last = null;
    let seqFrom = null, matchedTo = null;
    while (this.traceHead < this.traceSeqs.length) {
      const e = this.traceEpochs[this.traceHead];
      if (e < epoch) {
        this.traceHead++;
        this.traceEpochCensored++;
        continue;
      }
      if (e !== epoch || seqTo === null || this.traceSeqs[this.traceHead] > seqTo)
        break;
      const seq = this.traceSeqs[this.traceHead];
      const t = this.traceTimes[this.traceHead++];
      first ??= t;
      last = t;
      seqFrom ??= seq;
      matchedTo = seq;
      n++;
    }
    this.compactTrace();
    return [n, first, last, seqFrom, matchedTo];
  }
  emitTrace(update, bodyBytes, arrivedAt, startedAt, decodedAt, consumedAt, consumerSucceeded) {
    const [matchedFeeds, first, last, matchedSeqFrom, matchedSeqTo] = this.traceAck(update.seqTo, update.epoch);
    const stages = update.stages;
    const worker = stages ? { ...stages, parseNs: update.parseNs, encodeNs: update.encodeNs, serializeNs: update.serializeNs ?? 0 } : null;
    const feedToArrivalMs = first === null ? null : arrivedAt - first;
    const trace = {
      seqFrom: update.seqFrom,
      seqTo: update.seqTo,
      epoch: update.epoch,
      matchedFeeds,
      bodyBytes,
      matchedSeqFrom,
      matchedSeqTo,
      clockDomain: "host-performance-ms",
      host: { firstFeedAt: first, arrivedAt, decodeStartedAt: startedAt, decodedAt, consumedAt },
      consumerSucceeded,
      traceDropped: this.traceDropped,
      traceEpochCensored: this.traceEpochCensored,
      feedToArrivalMs,
      lastFeedToArrivalMs: last === null ? null : arrivedAt - last,
      mainQueueMs: startedAt - arrivedAt,
      decodeMs: decodedAt - startedAt,
      consumerMs: consumedAt - decodedAt,
      feedToConsumedMs: first === null ? null : consumedAt - first,
      transportMs: feedToArrivalMs === null || worker === null ? null : feedToArrivalMs - (worker.holdNs + worker.encodeNs + worker.serializeNs) / 1e6,
      worker
    };
    try {
      this.options.onStageTrace(trace);
    } catch (error) {
      console.error("[pipe-vt] onStageTrace callback failed:", error);
    }
  }
  async onStdout(chunk, arrivedAt = 0) {
    if (this.abandoned)
      return;
    this.pending = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
    let offset = 0;
    while (this.pending.length - offset >= 5) {
      const kind = String.fromCharCode(this.pending[offset]);
      const length = this.pending.readUInt32BE(offset + 1);
      if (length > 16 * 1024 * 1024) {
        this.pending = Buffer.alloc(0);
        this.terminateChannel();
        throw new Error("worker output exceeds 16 MiB frame bound");
      }
      if (this.pending.length - offset < 5 + length)
        break;
      const tracing = kind === "U" && this.options.onStageTrace !== undefined;
      const startedAt = tracing ? this.traceClock() : 0;
      const body = this.pending.subarray(offset + 5, offset + 5 + length).toString("utf8");
      offset += 5 + length;
      let message;
      try {
        message = JSON.parse(body);
      } catch (error) {
        this.notifyFault({ kind: "protocol", at: (this.options.now ?? Date.now)(), message: error.message });
        continue;
      }
      if (kind === "U" || kind === "H") {
        const decodedAt = tracing ? this.traceClock() : 0;
        let consumerSucceeded = true;
        try {
          const receipt = kind === "U" ? this.options.onUpdate(message) : this.options.onHistoryClear?.(message);
          if (receipt && typeof receipt.then === "function")
            await receipt;
          if (this.abandoned)
            return;
        } catch (error) {
          consumerSucceeded = false;
          this.notifyFault({ kind: "worker-error", at: (this.options.now ?? Date.now)(), message: `consumer failed: ${String(error)}` });
        }
        if (tracing)
          this.emitTrace(message, length, arrivedAt, startedAt, decodedAt, this.traceClock(), consumerSucceeded);
      } else if (kind === "B") {
        this.quitAck = message.workerEof === true;
      } else if (kind === "R") {
        this.readyResolve?.(message);
        this.readyResolve = null;
      } else if (kind === "E") {
        const error = message;
        this.notifyFault({
          kind: error.kind === "vendor-hash" ? "vendor-hash" : error.kind === "clear-policy-unknown" ? "clear-policy-unknown" : "worker-error",
          at: (this.options.now ?? Date.now)(),
          message: String(error.message ?? "")
        });
      } else {
        this.notifyFault({ kind: "protocol", at: (this.options.now ?? Date.now)(), message: `unknown frame ${kind}` });
      }
    }
    this.pending = offset === this.pending.length ? Buffer.alloc(0) : this.pending.subarray(offset);
  }
  write(parts, control = true) {
    if (this.socket) {
      if (this.exited || this.socket.destroyed || !this.socket.writable)
        return false;
      const packet = Buffer.concat(parts);
      const limit2 = PIPE_VT_DATA_QUEUE_BYTES + (control ? PIPE_VT_CONTROL_RESERVE_BYTES : 0);
      if (this.socket.writableLength + packet.length > limit2)
        return false;
      this.socket.write(packet);
      return true;
    }
    if (this.inputFd === null || this.exited)
      return false;
    const bytes = parts.reduce((sum, part) => sum + part.byteLength, 0);
    const limit = PIPE_VT_DATA_QUEUE_BYTES + (control ? PIPE_VT_CONTROL_RESERVE_BYTES : 0);
    if (this.queuedBytes + bytes > limit)
      return false;
    this.queue.push(parts.length === 1 ? parts[0] : Buffer.concat(parts));
    this.queuedBytes += bytes;
    this.flush();
    return this.inputFd !== null;
  }
  flush() {
    if (this.flushTimer)
      clearTimeout(this.flushTimer);
    this.flushTimer = null;
    while (this.queue.length && this.inputFd !== null) {
      const head = this.queue[0];
      let written = 0;
      try {
        written = writeSync(this.inputFd, head);
      } catch (error) {
        if (error.code !== "EAGAIN") {
          this.releaseInput();
          this.notifyFault({ kind: "worker-error", at: (this.options.now ?? Date.now)(), message: `worker input failed: ${error.message}` });
          this.terminateChannel();
          return;
        }
      }
      if (written === head.length) {
        this.queuedBytes -= written;
        this.queue.shift();
        continue;
      }
      if (written > 0) {
        this.queuedBytes -= written;
        this.queue[0] = head.subarray(written);
      }
      this.flushTimer ??= setTimeout(() => this.flush(), 1);
      return;
    }
  }
  releaseInput() {
    if (this.flushTimer)
      clearTimeout(this.flushTimer);
    this.flushTimer = null;
    this.queue = [];
    this.queuedBytes = 0;
    if (this.inputFd !== null) {
      try {
        closeSync3(this.inputFd);
      } catch {}
      this.inputFd = null;
    }
    if (this.inputDir) {
      rmSync(this.inputDir, { recursive: true, force: true });
      this.inputDir = null;
    }
  }
  canAccept(bytes) {
    return !this.exited && (this.socket?.writableLength ?? this.queuedBytes) + bytes + 21 <= PIPE_VT_DATA_QUEUE_BYTES;
  }
  feed(seq, bytes, epoch = 1) {
    const prefix = Buffer.allocUnsafe(16);
    prefix.writeBigUInt64BE(BigInt(seq));
    prefix.writeBigUInt64BE(BigInt(epoch), 8);
    const fedAt = this.options.onStageTrace ? this.traceClock() : 0;
    const accepted = this.write([header("D", 16 + bytes.byteLength), prefix, Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)], false);
    if (accepted && this.options.onStageTrace)
      this.traceFeed(seq, fedAt, epoch);
    return accepted;
  }
  setScrollOnClear(enabled) {
    return this.write([header("C", 1), Buffer.from([Number(enabled)])]);
  }
  reset(epoch) {
    const payload = Buffer.allocUnsafe(8);
    payload.writeBigUInt64BE(BigInt(epoch));
    return this.write([header("X", 8), payload]);
  }
  resize(cols, rows, geometryGeneration) {
    const payload = Buffer.allocUnsafe(8);
    payload.writeUInt16BE(cols, 0);
    payload.writeUInt16BE(rows, 2);
    payload.writeUInt32BE(geometryGeneration >>> 0, 4);
    return this.write([header("Z", 8), payload]);
  }
  resizePacket(seq, epoch, cols, rows, generation) {
    if (![seq, epoch, generation, cols, rows].every((n) => Number.isSafeInteger(n) && n >= 0) || seq < 1 || cols < 1 || rows < 1 || cols > 240 || rows > 80 || generation > 4294967295)
      return false;
    const payload = Buffer.allocUnsafe(24);
    payload.writeBigUInt64BE(BigInt(seq), 0);
    payload.writeBigUInt64BE(BigInt(epoch), 8);
    payload.writeUInt16BE(cols, 16);
    payload.writeUInt16BE(rows, 18);
    payload.writeUInt32BE(generation, 20);
    return this.write([header("V", payload.length), payload]);
  }
  requestFull(seq) {
    const payload = Buffer.allocUnsafe(8);
    payload.writeBigUInt64BE(BigInt(seq));
    return this.write([header("F", 8), payload]);
  }
  close(timeoutMs = 5000) {
    if (this.closePromise)
      return this.closePromise;
    if (!this.child && !this.lease)
      return Promise.resolve({
        workerEof: false,
        outputDrained: false,
        issues: ["worker was never started"],
        unknownTail: true
      });
    this.closing = true;
    if (this.exited)
      return this.closePromise = this.settleOutput(timeoutMs, false, ["worker exited before orderly shutdown"]);
    const exited = new Promise((resolve3) => this.exitWaiters.push(resolve3));
    const quitQueued = this.write([header("Q", 0)]);
    let forced = !quitQueued;
    if (!quitQueued)
      this.terminateChannel();
    const timer = setTimeout(() => {
      forced = true;
      this.terminateChannel();
      this.outputPaused = false;
      (this.socket ?? this.child?.stdout)?.resume();
    }, timeoutMs);
    return this.closePromise = exited.finally(() => clearTimeout(timer)).then(() => this.settleOutput(timeoutMs, quitQueued && !forced, forced ? [`worker did not exit after quit within ${timeoutMs}ms`] : []));
  }
  settleOutput(timeoutMs, workerEof, issues) {
    let timer = null;
    const deadline = new Promise((resolve3) => {
      timer = setTimeout(() => resolve3("timeout"), timeoutMs);
    });
    return Promise.race([this.outputTail.then(() => "done"), deadline]).then(async (result) => {
      if (timer)
        clearTimeout(timer);
      const outputDrained = result === "done";
      if (!this.quitAck) {
        workerEof = false;
        issues.push("parser did not acknowledge Q after its final update");
      }
      if (!outputDrained) {
        this.abandoned = true;
        this.terminateChannel();
        issues.push(`worker output consumer did not settle within ${timeoutMs}ms; remaining updates dropped`);
        this.notifyFault({ kind: "shutdown-timeout", at: (this.options.now ?? Date.now)(), message: issues.at(-1) });
      }
      await this.leaseDone;
      return { workerEof, outputDrained, issues, unknownTail: !workerEof || !outputDrained || issues.length > 0 };
    });
  }
  kill(signal = "SIGKILL") {
    if (this.lease)
      this.lease.kill(signal);
    else
      this.child?.kill(signal);
  }
}

class CheckpointCaptureVt {
  rpc;
  scrollOnClear;
  state;
  frame;
  generation = 0;
  constructor(rpc, state, frame, scrollOnClear) {
    this.rpc = rpc;
    this.scrollOnClear = scrollOnClear;
    this.state = structuredClone(state);
    this.frame = structuredClone(frame);
  }
  static async create(rpc, identity, geometry, scrollOnClear) {
    const r = await rpc.transaction({ state: null, identity, geometry, scrollOnClear, screenRevision: 0 });
    if (r.status !== "ok")
      return r;
    if ("pressure" in r.value)
      return { status: "busy", reason: "pressure", retryAfterMs: 10 };
    if ("complete" in r.value && !r.value.complete)
      return { status: "error", code: "integrity", message: "unexpected VT continuation" };
    if (Buffer.byteLength(JSON.stringify(r.value)) * 2 > 2 * 1024 * 1024)
      return { status: "busy", reason: "pressure", retryAfterMs: 10 };
    return { status: "ok", value: new CheckpointCaptureVt(rpc, r.value.state, r.value.frame, scrollOnClear) };
  }
  async* prepareStream(event, maxBytes = 512 * 1024) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 8 || maxBytes > 512 * 1024) {
      yield { status: "error", code: "integrity", message: "VT row page budget" };
      return;
    }
    if (event.payload.kind === "bytes" && event.payload.bytes.length > 16384 || Buffer.byteLength(JSON.stringify(event)) * 2 > 256 * 1024) {
      yield { status: "busy", reason: "pressure", retryAfterMs: 10 };
      return;
    }
    const generation = this.generation;
    const request = {
      state: structuredClone(this.state),
      event: structuredClone(event),
      identity: structuredClone(event.identity),
      geometry: this.state.geometry,
      scrollOnClear: this.scrollOnClear,
      screenRevision: this.frame.screenRevision + 1
    };
    let ordinal = 0;
    let live = true;
    try {
      while (live) {
        if (generation !== this.generation) {
          yield { status: "stale", reason: "identity" };
          return;
        }
        const reply = await this.rpc.transaction({ ...request, rowStream: { startOrdinal: ordinal, maxBytes } });
        if (reply.status !== "ok") {
          yield reply;
          return;
        }
        if (generation !== this.generation) {
          yield { status: "stale", reason: "identity" };
          return;
        }
        const page = reply.value;
        if ("pressure" in page) {
          yield { status: "error", code: "unsupported", message: "VT single row budget" };
          return;
        }
        if (!("complete" in page) || page.scrolls.length > 256 || page.startOrdinal !== ordinal || !Number.isSafeInteger(page.nextOrdinal) || page.nextOrdinal !== ordinal + page.scrolls.length || !page.complete && !page.scrolls.length || !Number.isSafeInteger(page.chargedBytes) || page.chargedBytes < Buffer.byteLength(JSON.stringify(page.scrolls)) * 4 || page.chargedBytes > maxBytes || page.scrolls.some((row) => row.uncertainFields.length)) {
          yield { status: "error", code: "integrity", message: "VT row continuation fence" };
          return;
        }
        const freeze = (value) => {
          if (value && typeof value === "object") {
            for (const child of Object.values(value))
              freeze(child);
            Object.freeze(value);
          }
        };
        freeze(page);
        ordinal = page.nextOrdinal;
        const step = { startOrdinal: page.startOrdinal, nextOrdinal: ordinal, chargedBytes: page.chargedBytes, scrolls: page.scrolls };
        if (!page.complete) {
          yield { status: "ok", value: step };
          continue;
        }
        if (Buffer.byteLength(JSON.stringify([page.state, page.frame])) * 2 > 2 * 1024 * 1024) {
          yield { status: "error", code: "unsupported", message: "VT state budget" };
          return;
        }
        if (JSON.stringify(page.frame.identity) !== JSON.stringify(request.identity)) {
          yield { status: "error", code: "integrity", message: "VT stream identity" };
          return;
        }
        let finished = false;
        const candidate = {
          frame: page.frame,
          scrolls: [],
          snapshot: async () => ({ status: "ok", value: structuredClone(page.state) }),
          install: () => {
            if (!live || finished || generation !== this.generation)
              throw new Error("stale VT stream");
            finished = true;
            this.generation++;
            this.state = structuredClone(page.state);
            this.frame = structuredClone(page.frame);
          },
          discard: () => {
            finished = true;
          }
        };
        yield { status: "ok", value: { ...step, candidate } };
        return;
      }
    } finally {
      live = false;
    }
  }
  screen() {
    return structuredClone(this.frame);
  }
  async snapshot() {
    return { status: "ok", value: structuredClone(this.state) };
  }
  async prepare(event) {
    return this.stage(this.state, event);
  }
  async restore(state, identity) {
    return this.stage(state, undefined, identity);
  }
  async stage(state, event, identity) {
    const generation = this.generation;
    const r = await this.rpc.transaction({
      state: structuredClone(state),
      identity: event?.identity ?? identity ?? this.frame.identity,
      geometry: state.geometry,
      scrollOnClear: this.scrollOnClear,
      screenRevision: this.frame.screenRevision + (event ? 1 : 0),
      ...event ? { event } : {}
    });
    if (r.status !== "ok")
      return r;
    if ("pressure" in r.value)
      return { status: "error", code: "unsupported", message: "VT expansion budget" };
    if ("complete" in r.value && !r.value.complete)
      return { status: "error", code: "integrity", message: "unexpected VT continuation" };
    const candidate = structuredClone(r.value);
    if (Buffer.byteLength(JSON.stringify(candidate)) * 2 > 2 * 1024 * 1024)
      return { status: "error", code: "unsupported", message: "VT expansion budget" };
    const freeze = (v) => {
      if (v && typeof v === "object") {
        for (const child of Object.values(v))
          freeze(child);
        Object.freeze(v);
      }
    };
    freeze(candidate);
    let finished = false;
    return { status: "ok", value: {
      frame: candidate.frame,
      scrolls: candidate.scrolls,
      snapshot: async () => ({ status: "ok", value: structuredClone(candidate.state) }),
      install: () => {
        if (finished || generation !== this.generation)
          throw new Error("stale VT transaction");
        finished = true;
        this.generation++;
        this.state = candidate.state;
        this.frame = candidate.frame;
      },
      discard: () => {
        finished = true;
      }
    } };
  }
}

// src/pipe-history-collector.ts
function isCapacityPressure(value) {
  if (value === null || typeof value !== "object")
    return false;
  const answer = value;
  if (answer.reason === "capacity-pressure")
    return true;
  return value instanceof Error && /\bcapacity-pressure\b/.test(String(answer.message));
}
function isOversize(value) {
  if (value === null || typeof value !== "object" || isCapacityPressure(value))
    return false;
  const answer = value;
  if (answer.reason === "ingest-oversize" || answer.reason === "ingest-capacity")
    return true;
  return value instanceof Error && /\b(?:ingest-oversize|ingest-capacity)\b/.test(String(answer.message));
}
function isRefusal(value) {
  return value !== null && typeof value === "object" && value.accepted === false && !isCapacityPressure(value) && !isOversize(value);
}
var DROPPED = Symbol("pipe-history-dropped");
function refusedNow(receipt) {
  const peek = globalThis.Bun?.peek;
  const status = peek?.status?.(receipt);
  if (status === "rejected")
    return true;
  return status === "fulfilled" && isCapacityPressure(peek(receipt));
}
function isReceipt(value) {
  return value !== null && (typeof value === "object" || typeof value === "function") && typeof value.then === "function";
}
function percentile(sorted, p) {
  if (sorted.length === 0)
    return null;
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))];
}

class PipeHistoryCollector {
  options;
  paneKey;
  sourceEpoch;
  upstreamEpoch;
  geometryGeneration = 0;
  receiveSeq = 0;
  ackedSeq = 0;
  inflight = [];
  inflightBytes = 0;
  ring = [];
  ringStart = 0;
  ringRows;
  queueLimit;
  worker;
  recovering = null;
  recoveryAttempts = 0;
  closing = false;
  cols;
  rows;
  scrollOnClear;
  nowNs;
  now;
  drainWaiters = [];
  latencyMs = [];
  latencyLimit;
  healthState = "starting";
  scrollCount = 0;
  frameCount = 0;
  workerParseNs = 0;
  workerEncodeNs = 0;
  hostHandleNs = 0n;
  policyUnverified = false;
  acceptedBytes = 0;
  refusedBytes = 0;
  held = [];
  pressureEpisode = false;
  pressureRetries = 0;
  oversizeDrops = 0;
  closePromise = null;
  constructor(options) {
    this.options = options;
    this.paneKey = options.paneKey;
    this.sourceEpoch = options.sourceEpoch;
    this.upstreamEpoch = options.sourceEpoch;
    this.ringRows = options.ringRows ?? 500;
    this.queueLimit = options.queueLimitBytes ?? 1024 * 1024;
    this.nowNs = options.nowNs ?? (() => process.hrtime.bigint());
    this.now = options.now ?? Date.now;
    this.latencyLimit = options.latencySampleLimit ?? 1e6;
    this.cols = options.cols;
    this.rows = options.rows;
    this.scrollOnClear = options.scrollOnClear;
    this.worker = this.makeWorker();
  }
  makeWorker() {
    const worker = new PipeVtWorker({
      pool: this.options.pool,
      sourceEpoch: this.sourceEpoch,
      onHistoryClear: ({ seq, epoch }) => {
        if (worker !== this.worker)
          return;
        this.ring.length = 0;
        this.ringStart = 0;
        this.notifyFault({
          kind: "history-cleared",
          at: this.now(),
          message: `CSI 3J cleared history in source epoch ${epoch}; visible screen retained`,
          receiveSeqFrom: seq,
          receiveSeqTo: seq
        });
      },
      cols: this.cols,
      rows: this.rows,
      assets: this.options.assets,
      python: this.options.python,
      now: this.now,
      onUpdate: (update) => worker === this.worker ? this.onUpdate(update) : undefined,
      onFault: (fault) => {
        if (fault.kind === "shutdown-timeout") {
          this.notifyFault({ kind: fault.kind, at: this.now(), message: fault.message, lostRows: "unknown" });
          return;
        }
        if (worker !== this.worker)
          return;
        if (fault.kind === "clear-policy-unknown") {
          this.policyUnverified = true;
          this.fault(fault.kind, fault.message, "degraded");
        } else
          this.fault(fault.kind, fault.message, "broken");
      }
    });
    return worker;
  }
  async start() {
    await this.worker.start();
    if (this.scrollOnClear !== undefined)
      this.worker.setScrollOnClear(this.scrollOnClear);
    if (this.healthState === "starting")
      this.healthState = "ok";
  }
  get workerPid() {
    return this.worker.pid;
  }
  health() {
    return this.healthState;
  }
  ingest(bytes, receivedAtNs = this.nowNs()) {
    if (this.healthState === "closed") {
      this.refusedBytes += bytes.byteLength;
      const seq2 = ++this.receiveSeq;
      this.notifyFault({
        kind: "closed",
        at: this.now(),
        unacknowledgedBytes: bytes.byteLength,
        receiveSeqFrom: seq2,
        receiveSeqTo: seq2,
        lostRows: "unknown"
      });
      return false;
    }
    if (this.healthState === "broken" && this.recovering && !this.closing) {
      if (this.inflightBytes + bytes.byteLength <= this.queueLimit + 64 * 1024) {
        const seq2 = ++this.receiveSeq;
        this.inflight.push({ seq: seq2, bytes: bytes.byteLength, at: receivedAtNs });
        this.inflightBytes += bytes.byteLength;
        this.held.push({ seq: seq2, bytes: bytes.slice() });
        return false;
      }
    }
    if (this.healthState === "broken") {
      this.refusedBytes += bytes.byteLength;
      const seq2 = ++this.receiveSeq;
      this.notifyFault({ kind: "worker-exit", at: this.now(), message: "bytes rejected by dead parser", unacknowledgedBytes: bytes.byteLength, receiveSeqFrom: seq2, receiveSeqTo: seq2, lostRows: "unknown" });
      return false;
    }
    if (this.inflightBytes > this.queueLimit || bytes.byteLength > this.queueLimit + 64 * 1024 || !this.worker.canAccept(bytes.byteLength)) {
      this.refusedBytes += bytes.byteLength;
      const seq2 = ++this.receiveSeq;
      this.healthState = "degraded";
      this.notifyFault({
        kind: "parser-backlog",
        at: this.now(),
        message: "input rejected at bounded parser admission; drain before retrying new bytes",
        unacknowledgedBytes: bytes.byteLength,
        receiveSeqFrom: seq2,
        receiveSeqTo: seq2,
        lostRows: "unknown"
      });
      return false;
    }
    const seq = ++this.receiveSeq;
    this.inflight.push({ seq, bytes: bytes.byteLength, at: receivedAtNs });
    this.inflightBytes += bytes.byteLength;
    if (!this.worker.feed(seq, bytes, this.sourceEpoch)) {
      this.refusedBytes += bytes.byteLength;
      this.fault("worker-exit", "parser rejected input", "broken");
      return false;
    }
    this.acceptedBytes += bytes.byteLength;
    if (!this.readyForDelivery()) {
      if (this.inflightBytes > this.queueLimit && this.healthState === "ok") {
        this.fault("parser-backlog", `parser pressure: ${this.inflightBytes} inflight bytes; next delivery must wait for IPC and parser capacity`, "degraded");
      }
      return false;
    }
    return true;
  }
  drained() {
    if (this.healthState === "closed")
      return Promise.resolve();
    if (this.recovering)
      return this.recovering.then(() => this.drained());
    if (this.healthState === "broken" || this.readyForDelivery())
      return Promise.resolve();
    return new Promise((resolve3) => this.drainWaiters.push(resolve3));
  }
  readyForDelivery() {
    return this.inflightBytes <= this.queueLimit && this.worker.canAccept(64 * 1024);
  }
  resize(cols, rows) {
    this.cols = cols;
    this.rows = rows;
    this.geometryGeneration += 1;
    if (this.parserLive() && !this.worker.resize(cols, rows, this.geometryGeneration)) {
      this.fault("worker-error", "resize admission failed", "broken");
    }
    return this.geometryGeneration;
  }
  parserLive() {
    return this.healthState !== "broken" && this.healthState !== "closed" && !this.recovering;
  }
  beginSourceEpoch(epoch) {
    if (epoch <= this.upstreamEpoch)
      throw new Error(`upstream epoch must increase (${this.upstreamEpoch} -> ${epoch})`);
    this.upstreamEpoch = epoch;
    const previousEpoch = this.sourceEpoch;
    this.sourceEpoch = Math.max(this.sourceEpoch + 1, epoch);
    this.notifyFault({
      kind: "source-reset",
      at: this.now(),
      message: "owner requested parser reset; external reset ordering remains unverified",
      sourceEpoch: previousEpoch,
      receiveSeqFrom: this.ackedSeq + 1,
      receiveSeqTo: this.receiveSeq,
      lostRows: "unknown"
    });
    if (this.parserLive() && !this.worker.reset(this.sourceEpoch))
      this.fault("worker-error", "parser reset admission failed", "broken");
  }
  setScrollOnClear(enabled) {
    this.scrollOnClear = enabled;
    if (this.parserLive() && !this.worker.setScrollOnClear(enabled))
      this.fault("worker-error", "clear policy admission failed", "broken");
  }
  currentSourceEpoch() {
    return this.sourceEpoch;
  }
  currentGeometryGeneration() {
    return this.geometryGeneration;
  }
  requestFullFrame() {
    if (!this.parserLive())
      return false;
    if (this.worker.requestFull(this.receiveSeq))
      return true;
    this.fault("worker-error", "full-frame request admission failed", "broken");
    return false;
  }
  ringSnapshot() {
    return this.ring.slice(this.ringStart);
  }
  stats() {
    const sorted = [...this.latencyMs].sort((a, b) => a - b);
    const latency = {
      samples: sorted.length,
      p50Ms: percentile(sorted, 0.5),
      p95Ms: percentile(sorted, 0.95),
      p99Ms: percentile(sorted, 0.99),
      maxMs: sorted.length ? sorted[sorted.length - 1] : null
    };
    return {
      restartCount: this.recoveryAttempts,
      receiveSeq: this.receiveSeq,
      ackedSeq: this.ackedSeq,
      inflightBytes: this.inflightBytes,
      acceptedBytes: this.acceptedBytes,
      refusedBytes: this.refusedBytes,
      pressureRetries: this.pressureRetries,
      oversizeDrops: this.oversizeDrops,
      scrolls: this.scrollCount,
      frames: this.frameCount,
      workerParseMs: this.workerParseNs / 1e6,
      workerEncodeMs: this.workerEncodeNs / 1e6,
      hostHandleMs: Number(this.hostHandleNs) / 1e6,
      latency
    };
  }
  latencySamples() {
    return this.latencyMs;
  }
  resetLatency() {
    this.latencyMs = [];
    this.workerParseNs = 0;
    this.workerEncodeNs = 0;
    this.hostHandleNs = 0n;
  }
  close() {
    if (this.closePromise)
      return this.closePromise;
    this.closing = true;
    return this.closePromise = (async () => {
      await this.recovering;
      const worker = await this.worker.close(this.options.closeTimeoutMs);
      this.healthState = "closed";
      for (const waiter of this.drainWaiters.splice(0))
        waiter();
      return this.shutdownReceipt(worker.issues, worker.unknownTail);
    })();
  }
  shutdownReceipt(issues, workerUnknown = false) {
    const receiptIssues = [...issues];
    if (this.ackedSeq !== this.receiveSeq) {
      receiptIssues.push(`collector acknowledged ${this.ackedSeq} of ${this.receiveSeq} admitted sequences`);
    }
    if (this.inflightBytes !== 0)
      receiptIssues.push(`collector retained ${this.inflightBytes} unacknowledged bytes`);
    if (this.held.length !== 0)
      receiptIssues.push(`collector retained ${this.held.length} recovery deliveries`);
    return {
      lastAdmittedSequence: this.receiveSeq,
      lastAckedSequence: this.ackedSeq,
      ramRevision: null,
      durableRevision: null,
      issues: receiptIssues,
      unknownTail: workerUnknown || receiptIssues.length > 0
    };
  }
  killWorker() {
    this.worker.kill("SIGKILL");
  }
  notifyFault(event) {
    const contextual = {
      paneKey: this.paneKey,
      sourceEpoch: this.sourceEpoch,
      ...event.lostRows === "unknown" ? { missingCount: null } : {},
      ...event
    };
    try {
      Promise.resolve(this.options.ports.onFault(contextual)).catch((error) => console.error("[pipe-history] onFault callback failed:", error));
    } catch (error) {
      console.error("[pipe-history] onFault callback failed:", error);
    }
  }
  fault(kind, message, health) {
    if (this.healthState === "closed")
      return;
    if (health === "broken" || this.healthState !== "broken")
      this.healthState = health;
    const loss = health === "broken" || kind === "clear-policy-unknown" ? {
      unacknowledgedBytes: this.inflightBytes,
      receiveSeqFrom: Math.min(this.ackedSeq + 1, this.receiveSeq),
      receiveSeqTo: this.receiveSeq,
      lostRows: "unknown"
    } : {};
    if (health === "broken") {
      this.inflight = [];
      this.inflightBytes = 0;
      this.held = [];
    }
    this.notifyFault({ kind, at: this.now(), message, ...loss });
    if (health === "broken" && !this.closing && !this.recovering && kind !== "vendor-hash" && this.recoveryAttempts < 3) {
      this.recoveryAttempts++;
      this.recovering = Promise.resolve().then(async () => {
        await this.worker.close(this.options.closeTimeoutMs);
        if (this.closing)
          return;
        this.sourceEpoch++;
        this.worker = this.makeWorker();
        await this.worker.start();
        if (this.scrollOnClear !== undefined)
          this.worker.setScrollOnClear(this.scrollOnClear);
        this.worker.resize(this.cols, this.rows, this.geometryGeneration);
        for (const entry of this.held.splice(0)) {
          if (!this.worker.feed(entry.seq, entry.bytes, this.sourceEpoch))
            throw new Error("replacement parser refused held bytes");
          this.acceptedBytes += entry.bytes.byteLength;
        }
        this.healthState = this.policyUnverified ? "degraded" : "ok";
        this.notifyFault({ kind: "worker-restarted", at: this.now(), message: `parser respawned; source epoch ${this.sourceEpoch}; calibration required` });
      }).catch((error) => {
        this.healthState = "broken";
        const lost = this.held.splice(0);
        this.inflight = [];
        this.inflightBytes = 0;
        this.notifyFault({
          kind: "spawn",
          at: this.now(),
          message: String(error),
          lostRows: "unknown",
          ...lost.length ? {
            receiveSeqFrom: lost[0].seq,
            receiveSeqTo: lost.at(-1).seq,
            unacknowledgedBytes: lost.reduce((sum, entry) => sum + entry.bytes.byteLength, 0)
          } : {}
        });
      }).finally(() => {
        this.recovering = null;
        for (const waiter of this.drainWaiters.splice(0))
          waiter();
      });
    } else if (health === "broken") {
      for (const waiter of this.drainWaiters.splice(0))
        waiter();
    }
  }
  deliver(send, drop) {
    const dropped = () => {
      drop();
      return DROPPED;
    };
    let answer;
    try {
      answer = send();
    } catch (error) {
      if (isCapacityPressure(error) || this.options.retainOversize && isOversize(error))
        return { receipt: this.retryPressure(send, dropped), pressured: true };
      if (isOversize(error))
        return { receipt: dropped(), pressured: false };
      throw error;
    }
    if (isReceipt(answer)) {
      const pressured = refusedNow(answer);
      const receipt = Promise.resolve(answer).then((value) => {
        if (isCapacityPressure(value) || this.options.retainOversize && isOversize(value))
          return this.retryPressure(send, dropped);
        if (isOversize(value))
          return dropped();
        if (isRefusal(value))
          throw new Error(`consumer refused: ${JSON.stringify(value)}`);
      }, (error) => {
        if (isCapacityPressure(error) || this.options.retainOversize && isOversize(error))
          return this.retryPressure(send, dropped);
        if (isOversize(error))
          return dropped();
        throw error;
      });
      return { receipt, pressured };
    }
    if (isCapacityPressure(answer) || this.options.retainOversize && isOversize(answer))
      return { receipt: this.retryPressure(send, dropped), pressured: true };
    if (isOversize(answer))
      return { receipt: dropped(), pressured: false };
    if (isRefusal(answer))
      throw new Error(`consumer refused: ${JSON.stringify(answer)}`);
    return { receipt: undefined, pressured: false };
  }
  declareOversize(droppedEvent, receiveSeq, full = false) {
    this.oversizeDrops += 1;
    this.notifyFault({
      kind: "consumer-oversize",
      at: this.now(),
      droppedEvent,
      receiveSeqFrom: receiveSeq,
      receiveSeqTo: receiveSeq,
      ...droppedEvent === "scroll" ? { lostRows: 1, missingCount: 1 } : {},
      message: droppedEvent === "scroll" ? "consumer can never admit this scrolled row (oversize); dropped once, not retried" : `consumer can never admit this ${full ? "full " : ""}frame (oversize); screen stale until a later frame is accepted`
    });
    if (droppedEvent === "frame" && !full)
      this.requestFullFrame();
  }
  async retryPressure(send, dropped) {
    if (!this.pressureEpisode) {
      this.pressureEpisode = true;
      if (this.healthState === "ok")
        this.healthState = "degraded";
      this.notifyFault({
        kind: "consumer-pressure",
        at: this.now(),
        message: "consumer at capacity; parser output held and pipe reads paused until it accepts"
      });
    }
    let delay = this.options.pressureRetryMs ?? 2;
    for (;; ) {
      if (this.closing || this.healthState === "closed")
        throw new Error("collector closed while the consumer was under capacity pressure");
      if (this.healthState === "broken")
        throw new Error("parser broke while the consumer was under capacity pressure");
      await new Promise((resolve3) => setTimeout(resolve3, delay));
      delay = Math.min(delay * 2, 100);
      this.pressureRetries += 1;
      let value;
      try {
        value = await send();
      } catch (error) {
        if (isCapacityPressure(error) || this.options.retainOversize && isOversize(error))
          continue;
        if (isOversize(error))
          return dropped();
        throw error;
      }
      if (isCapacityPressure(value) || this.options.retainOversize && isOversize(value))
        continue;
      if (isOversize(value))
        return dropped();
      if (isRefusal(value))
        throw new Error(`consumer refused: ${JSON.stringify(value)}`);
      return;
    }
  }
  endPressure() {
    if (!this.pressureEpisode)
      return;
    this.pressureEpisode = false;
    this.notifyFault({ kind: "consumer-pressure-cleared", at: this.now(), message: "consumer accepts again" });
  }
  remember(event) {
    this.scrollCount += 1;
    this.ring.push(event);
    while (this.ring.length - this.ringStart > this.ringRows) {
      const evicted = this.ring[this.ringStart];
      this.ring[this.ringStart] = undefined;
      this.ringStart += 1;
      this.options.onEvict?.(evicted);
    }
    if (this.ringStart > 4096 && this.ringStart * 2 > this.ring.length) {
      this.ring.splice(0, this.ringStart);
      this.ringStart = 0;
    }
  }
  offerScrolls(events, index) {
    const pending = [];
    let accepted = index;
    let stop = events.length;
    for (let i = index;i < events.length; i++) {
      const event = events[i];
      const { receipt, pressured } = this.deliver(() => this.options.ports.onScroll(event), () => this.declareOversize("scroll", event.receiveSeq));
      if ((receipt === undefined || receipt === DROPPED) && pending.length === 0) {
        if (receipt === undefined)
          this.remember(event);
        accepted = i + 1;
        continue;
      }
      pending.push(receipt);
      if (pressured) {
        stop = i + 1;
        break;
      }
    }
    if (pending.length === 0)
      return;
    return Promise.all(pending).then((answers) => {
      for (let i = accepted;i < stop; i++)
        if (answers[i - accepted] !== DROPPED)
          this.remember(events[i]);
      if (stop < events.length)
        return this.offerScrolls(events, stop);
    });
  }
  onUpdate(update) {
    if (this.healthState === "broken" || this.healthState === "closed")
      return;
    const began = this.nowNs();
    this.workerParseNs += update.parseNs;
    this.workerEncodeNs += update.encodeNs;
    const seqTo = update.seqTo ?? this.ackedSeq;
    const complete = () => {
      this.frameCount += 1;
      this.endPressure();
      const published = this.nowNs();
      while (this.inflight.length && this.inflight[0].seq <= seqTo) {
        const entry = this.inflight.shift();
        this.inflightBytes -= entry.bytes;
        if (this.latencyMs.length < this.latencyLimit)
          this.latencyMs.push(Number(published - entry.at) / 1e6);
      }
      if (seqTo > this.ackedSeq) {
        this.ackedSeq = seqTo;
        this.recoveryAttempts = 0;
      }
      this.hostHandleNs += published - began;
      if (this.readyForDelivery()) {
        if (this.scrollOnClear !== undefined && update.scrollOnClear === this.scrollOnClear)
          this.policyUnverified = false;
        if (this.healthState === "degraded" && !this.policyUnverified)
          this.healthState = "ok";
        for (const waiter of this.drainWaiters.splice(0))
          waiter();
      }
    };
    const publish = () => {
      if (this.healthState === "broken" || this.healthState === "closed")
        return;
      const dirty = {};
      const softWrap = {};
      for (const [y, row] of Object.entries(update.frame.dirty))
        dirty[Number(y)] = row;
      for (const [y, wrap] of Object.entries(update.frame.wraps))
        softWrap[Number(y)] = wrap;
      const frame = {
        paneKey: this.paneKey,
        sourceEpoch: update.epoch,
        cells: {
          full: update.frame.full,
          shift: update.frame.shift,
          cols: update.frame.cols,
          rows: update.frame.rows,
          dirty,
          softWrap,
          wrapPad: update.frame.pads
        },
        cursor: update.frame.cursor,
        kind: update.frame.kind,
        geometryGeneration: update.gen,
        receiveSeq: seqTo
      };
      const { receipt } = this.deliver(() => this.options.ports.onFrame(frame), () => this.declareOversize("frame", seqTo, frame.cells.full));
      if (isReceipt(receipt))
        return receipt.then(complete);
      complete();
    };
    const rejected = (error) => {
      this.fault("consumer-rejected", `scroll/frame receipt rejected: ${String(error)}`, "broken");
    };
    try {
      const scrolls = update.scrolls.map((scroll) => ({
        paneKey: this.paneKey,
        sourceEpoch: scroll.epoch,
        geometryGeneration: scroll.gen,
        physicalRow: scroll.row,
        packetEpoch: scroll.packetEpoch,
        packetSeq: scroll.packetSeq,
        scrollOrdinal: scroll.scrollOrdinal,
        softWrap: scroll.wrap,
        wrapPad: scroll.pad,
        receiveSeq: scroll.seq ?? this.ackedSeq
      }));
      const receipt = this.offerScrolls(scrolls, 0);
      if (isReceipt(receipt))
        return Promise.resolve(receipt).then(publish).catch(rejected);
      const published = publish();
      if (isReceipt(published))
        return Promise.resolve(published).catch(rejected);
    } catch (error) {
      rejected(error);
    }
  }
}

// src/history-calibrator.ts
function equalCalibrationFrames(a, b, styleMask = -1) {
  return a.kind === b.kind && a.geometryGeneration === b.geometryGeneration && JSON.stringify(a.cursor) === JSON.stringify(b.cursor) && a.cells.length === b.cells.length && a.cells.every((row, y) => row.length === b.cells[y].length && row.every((cell, x) => equalCells(cell, b.cells[y][x], styleMask)));
}
function uncertifiedRows(rows, mask) {
  const out = [];
  rows.forEach((row, y) => {
    if (row.cells.some((cell) => (cell.style & ~mask) !== 0))
      out.push(y);
  });
  return out;
}
function samePane(a, b) {
  return a.serverIdentity === b.serverIdentity && a.paneId === b.paneId && a.birthGeneration === b.birthGeneration;
}
var TAIL_GAP_SLACK = 256;
function fencedHistory(recent, before) {
  const last = before.recentLastLineId !== undefined ? before.recentLastLineId ?? undefined : before.recentHistory.at(-1)?.lineId;
  if (last === undefined)
    return [];
  for (let i = recent.length - 1;i >= 0; i--)
    if (recent[i].lineId === last)
      return i === recent.length - 1 ? recent : recent.slice(0, i + 1);
  return [];
}
var CAPTURE_CADENCE = { eventMs: 50, activeMs: 200, idleMs: 1000, unviewedMs: 5000, deadlineMs: 1000 };

class HistoryCalibrator {
  paneKey;
  ports;
  options;
  matcher = new IncrementalHistoryMatcher;
  mode = "PIPE";
  deadline = Infinity;
  lastCaptureAt = -Infinity;
  lastHistoryAt = -Infinity;
  outputAt = -Infinity;
  forceFull = true;
  eventGeneration = 0;
  scrolls = 0;
  inFlight = false;
  latchAt;
  degraded = false;
  nextPipePublish = Infinity;
  pendingPipe;
  viewers;
  closed = false;
  abortInFlight;
  constructor(paneKey, ports, options = {}) {
    this.paneKey = paneKey;
    this.ports = ports;
    this.options = options;
    if (options.historyLimit !== undefined && (!Number.isInteger(options.historyLimit) || options.historyLimit < 0 || options.historyLimit > 4500))
      throw new Error("invalid history limit");
    if (options.certifiedStyleMask !== undefined && !Number.isSafeInteger(options.certifiedStyleMask))
      throw new Error("invalid style mask");
    if (options.viewers !== undefined)
      this.checkViewers(options.viewers);
    this.viewers = options.viewers;
    this.request(this.ports.now());
  }
  get dueAt() {
    return this.closed ? Infinity : Math.min(this.deadline, this.nextPipePublish);
  }
  get acceptsPipeFrame() {
    return this.mode === "PIPE";
  }
  get capturing() {
    return this.inFlight;
  }
  get viewed() {
    return this.viewers === undefined || this.viewers > 0;
  }
  checkViewers(count) {
    if (!Number.isSafeInteger(count) || count < 0)
      throw new Error("invalid viewer count");
  }
  setViewers(count) {
    this.checkViewers(count);
    if (this.closed)
      return;
    const was = this.viewed;
    this.viewers = count;
    if (!was && this.viewed) {
      this.lastHistoryAt = -Infinity;
      this.request(Math.max(this.ports.now(), this.lastCaptureAt + CAPTURE_CADENCE.eventMs));
    }
  }
  close() {
    if (this.closed)
      return;
    this.closed = true;
    this.deadline = Infinity;
    this.nextPipePublish = Infinity;
    this.pendingPipe = undefined;
    this.abortInFlight?.();
  }
  output(publishPipe) {
    if (this.closed)
      return;
    const now = this.ports.now();
    this.outputAt = now;
    if (publishPipe && this.mode === "PIPE") {
      this.pendingPipe = publishPipe;
      this.nextPipePublish = Math.min(this.nextPipePublish, now + 16);
      this.ports.schedule(this.dueAt);
    }
    this.request(Math.max(now, this.lastCaptureAt + (this.viewed ? CAPTURE_CADENCE.activeMs : CAPTURE_CADENCE.unviewedMs)));
  }
  scroll(count = 1) {
    if (!Number.isSafeInteger(count) || count < 0)
      throw new Error("invalid scroll count");
    this.scrolls = Math.min(4500, this.scrolls + count);
    this.output();
  }
  event(_kind) {
    if (this.closed)
      return;
    this.eventGeneration++;
    this.forceFull = true;
    this.matcher.reset();
    this.enterCapture();
    this.request(Math.max(this.ports.now(), this.lastCaptureAt + CAPTURE_CADENCE.eventMs));
  }
  request(at) {
    if (this.closed)
      return;
    if (at < this.deadline) {
      this.deadline = at;
      this.ports.schedule(this.dueAt);
    }
  }
  enterCapture() {
    this.mode = "CAPTURE";
    this.latchAt ??= this.ports.now();
    this.pendingPipe = undefined;
    this.nextPipePublish = Infinity;
  }
  async runDue() {
    if (this.closed)
      return;
    const now = this.ports.now();
    if (this.latchAt !== undefined && now - this.latchAt >= 1000) {
      if (!this.degraded)
        this.ports.fault({ kind: "capture-latch-degraded", at: now, missingCount: null });
      this.degraded = true;
      this.mode = "PIPE";
      this.latchAt = undefined;
    }
    if (now >= this.nextPipePublish) {
      const publish = this.pendingPipe;
      this.nextPipePublish = Infinity;
      this.pendingPipe = undefined;
      if (this.mode === "PIPE")
        publish?.();
    }
    if (this.inFlight)
      return;
    if (now < this.deadline) {
      this.ports.schedule(this.dueAt);
      return;
    }
    const planned = this.deadline;
    const anchor = now - planned < 200 ? planned : now;
    this.inFlight = true;
    this.deadline = Infinity;
    this.lastCaptureAt = anchor;
    const startedGeneration = this.eventGeneration;
    const historyDue = this.forceFull || anchor - this.lastHistoryAt >= 200;
    const requestedScrolls = this.scrolls;
    const limit = this.options.historyLimit ?? 4500;
    const tailLimit = !historyDue ? 0 : this.forceFull || !this.options.incremental ? limit : Math.min(limit, requestedScrolls + 128);
    let successful = false;
    let diverged = false;
    try {
      const fence = this.ports.read();
      const controller = new AbortController;
      let cancelTimeout;
      const capture = await Promise.race([
        this.ports.capture(this.paneKey, tailLimit, controller.signal),
        new Promise((_, reject) => {
          const expire = (reason) => {
            controller.abort();
            reject(new Error(reason));
          };
          this.abortInFlight = () => expire("calibrator closed");
          if (this.ports.timeout)
            cancelTimeout = this.ports.timeout(() => expire("capture deadline exceeded"), CAPTURE_CADENCE.deadlineMs);
          else {
            const timer = setTimeout(() => expire("capture deadline exceeded"), CAPTURE_CADENCE.deadlineMs);
            cancelTimeout = () => clearTimeout(timer);
          }
        })
      ]).finally(() => {
        cancelTimeout?.();
        this.abortInFlight = undefined;
      });
      const read = this.ports.read();
      const meta = capture.after;
      const stable = samePane(capture.paneKey, this.paneKey) && JSON.stringify(capture.before) === JSON.stringify(meta) && Number.isSafeInteger(meta.historyEpoch) && meta.historyEpoch >= 0 && meta.historyEpoch === fence.sourceEpoch && meta.sourceEpoch === read.sourceEpoch && meta.geometryGeneration === read.geometryGeneration && capture.frame.geometryGeneration === meta.geometryGeneration && capture.frame.kind === meta.kind && JSON.stringify(capture.frame.cursor) === JSON.stringify(meta.cursor) && capture.frame.cursor !== null && capture.frame.cells.length === meta.rows && capture.frame.cells.every((row) => row.length === meta.cols) && fence.sourceEpoch === read.sourceEpoch && fence.geometryGeneration === read.geometryGeneration && startedGeneration === this.eventGeneration;
      if (!stable) {
        this.matcher.reset();
        this.forceFull = true;
        this.mode = "PIPE";
        this.latchAt = undefined;
        return;
      }
      const matched = historyDue && meta.kind === "normal";
      const recent = matched ? fencedHistory(read.recentHistory, fence) : [];
      const mask = this.options.certifiedStyleMask;
      const certified = mask === undefined ? capture.history : certifiedRows(capture.history, mask);
      const match = !matched ? { checks: [], contentMatches: [], repairs: [], reason: "partial-tail" } : this.matcher.match(recent, certified, {
        sourceEpoch: read.sourceEpoch,
        geometryGeneration: read.geometryGeneration,
        completeRetainedTail: capture.completeRetainedTail,
        maxTailGap: read.recentHistory.length - recent.length + TAIL_GAP_SLACK,
        uncertainCapturedRows: capture.uncertainHistoryRows?.length ? new Set(capture.uncertainHistoryRows) : undefined
      });
      const receiveSeqBefore = fence.parserFrame.receiveSeq, receiveSeq = read.parserFrame.receiveSeq;
      const captureEvidence = receiveSeqBefore !== receiveSeq ? { kind: "unfenced", reason: "received-during-capture" } : {
        kind: "quiescent",
        sourceEpoch: meta.sourceEpoch,
        geometryGeneration: meta.geometryGeneration,
        receiveSeqBefore,
        receiveSeqAfter: receiveSeq,
        uncertainRows: capture.uncertainScreenRows ?? []
      };
      const uncertifiedStyle = mask === undefined ? undefined : {
        mask,
        historyRows: uncertifiedRows(capture.history, mask),
        screenRows: uncertifiedRows(capture.frame.cells.map((cells) => ({ cells, softWrap: false })), mask)
      };
      if (this.closed)
        return;
      const committed = await this.ports.calibrate({ capture, checks: match.checks, contentMatches: match.contentMatches, repairs: match.repairs, expectedRevision: read.revision, captureEvidence, ...uncertifiedStyle ? { uncertifiedStyle } : {} });
      if (this.closed)
        return;
      if (!committed) {
        this.forceFull = true;
        this.mode = "PIPE";
        this.latchAt = undefined;
        return;
      }
      if (startedGeneration !== this.eventGeneration) {
        this.enterCapture();
        return;
      }
      const latest = this.ports.read();
      if (matched)
        this.matcher.remember(recent, certified, match);
      this.mode = "PIPE";
      this.latchAt = undefined;
      this.degraded = false;
      if (captureEvidence.kind === "quiescent" && latest.revision === committed.revision && latest.parserFrame.receiveSeq === receiveSeq) {
        this.pendingPipe = undefined;
        this.nextPipePublish = Infinity;
        this.ports.publish(committed, capture.frame);
        diverged = latest.parserFrame.cells.length === capture.frame.cells.length && !equalCalibrationFrames(latest.parserFrame, capture.frame, mask);
      }
      successful = true;
      this.forceFull = historyDue && match.reason !== "matched" && match.reason !== "generation";
      if (historyDue) {
        this.lastHistoryAt = anchor;
        this.scrolls = Math.max(0, this.scrolls - requestedScrolls);
      }
    } catch (error) {
      this.mode = "PIPE";
      this.latchAt = undefined;
      if (!this.closed)
        this.ports.fault({ kind: "capture-fault", at: this.ports.now(), missingCount: null });
    } finally {
      this.inFlight = false;
      this.lastCaptureAt = anchor;
      if (this.closed)
        return;
      const at = this.ports.now();
      if (this.latchAt !== undefined && at - this.latchAt > 1000 && !this.degraded) {
        this.degraded = true;
        this.ports.fault({ kind: "capture-latch-degraded", at, missingCount: null });
      }
      const interval = !successful || this.mode === "CAPTURE" || diverged && this.viewed ? CAPTURE_CADENCE.eventMs : !this.viewed ? CAPTURE_CADENCE.unviewedMs : at - this.outputAt <= CAPTURE_CADENCE.activeMs ? CAPTURE_CADENCE.activeMs : CAPTURE_CADENCE.idleMs;
      this.deadline = Math.max(now + 50, Math.min(this.deadline, Math.max(at, anchor + interval)));
      this.ports.schedule(this.dueAt);
    }
  }
}

// src/history-watchdog.ts
class HistoryWatchdog {
  now;
  fault;
  heartbeatAt;
  receiveSeq = 0;
  image;
  imageSeq = 0;
  contextKey;
  movementWithoutReceiveAt;
  emitted = new Set;
  constructor(now, fault) {
    this.now = now;
    this.fault = fault;
    this.heartbeatAt = now();
  }
  heartbeat() {
    this.heartbeatAt = this.now();
    this.emitted.delete("heartbeat-timeout");
  }
  receive(seq) {
    if (seq > this.receiveSeq) {
      this.receiveSeq = seq;
      this.movementWithoutReceiveAt = undefined;
      this.emitted.delete("reader-stalled");
    }
  }
  capture(image, context) {
    const key = context === undefined ? this.contextKey : `${context.sourceEpoch}/${context.geometryGeneration}/${context.kind}`;
    if (key !== this.contextKey) {
      this.contextKey = key;
      this.image = undefined;
      this.movementWithoutReceiveAt = undefined;
      this.emitted.delete("reader-stalled");
    }
    if (this.image !== undefined && image !== this.image && this.imageSeq === this.receiveSeq)
      this.movementWithoutReceiveAt ??= this.now();
    this.image = image;
    this.imageSeq = this.receiveSeq;
  }
  dead(kind) {
    this.emit(kind);
  }
  tick() {
    if (this.now() - this.heartbeatAt >= 3000)
      this.emit("heartbeat-timeout");
    if (this.movementWithoutReceiveAt !== undefined && this.now() - this.movementWithoutReceiveAt >= 1000)
      this.emit("reader-stalled");
  }
  emit(kind) {
    if (this.emitted.has(kind))
      return;
    this.emitted.add(kind);
    this.fault({ kind, at: this.now(), missingCount: null });
  }
}

class StreamCaptureWatchdog {
  clock;
  notify;
  ackPendingAt = null;
  movementAt = null;
  received = 0;
  source = null;
  sent = 0;
  acked = 0;
  emitted = new Set;
  constructor(clock, notify) {
    this.clock = clock;
    this.notify = notify;
  }
  reset() {
    this.ackPendingAt = this.movementAt = this.source = null;
    this.received = this.sent = this.acked = 0;
    this.emitted.clear();
  }
  receive(totalBytes) {
    if (!Number.isSafeInteger(totalBytes) || totalBytes < this.received)
      throw new Error("receive counter");
    if (totalBytes > this.received) {
      this.movementAt = null;
      this.emitted.delete("stalled-input");
    }
    this.received = totalBytes;
  }
  sourceProgress(total) {
    if (!Number.isSafeInteger(total) || total < 0)
      throw new Error("source counter");
    if (this.source !== null && total < this.source) {
      this.emit("sequence");
      return;
    }
    if (this.source !== null && total > this.source)
      this.movementAt ??= this.clock();
    this.source = total;
  }
  submitted(seq) {
    if (!Number.isSafeInteger(seq) || seq !== this.sent + 1) {
      this.emit("sequence");
      return;
    }
    this.sent = seq;
    this.ackPendingAt ??= this.clock();
  }
  ack(seq) {
    if (!Number.isSafeInteger(seq) || seq < this.acked || seq > this.sent) {
      this.emit("sequence");
      return;
    }
    if (seq > this.acked) {
      this.acked = seq;
      this.ackPendingAt = this.acked === this.sent ? null : this.clock();
      this.emitted.delete("ack-timeout");
    }
  }
  tick() {
    const now = this.clock();
    if (this.ackPendingAt !== null && now - this.ackPendingAt >= 500)
      this.emit("ack-timeout");
    if (this.movementAt !== null && now - this.movementAt >= 500)
      this.emit("stalled-input");
  }
  emit(reason) {
    if (this.emitted.has(reason))
      return;
    this.emitted.add(reason);
    this.notify(reason);
  }
}

// src/tmux-capture-normalize.ts
import { charCellWidth, stringCells } from "../core/index.js";

// src/stream-contract.ts
import { createHash as createHash5 } from "node:crypto";
var STREAM_CONTRACT_VERSION = 1;
var MiB = 1024 * 1024;
var STREAM_BUDGET = Object.freeze({
  processTreePssHardBytes: 1536 * MiB,
  memoryDebtTargetBytes: 512 * MiB,
  plateauMinMs: 180 * 60000,
  plateauMaxDeltaBytes: 10 * MiB,
  panes: 21,
  maxColumns: 240,
  maxRows: 80,
  vtBytesPerPane: 2 * MiB,
  tailRowsPerPane: 256,
  tailBytesPerPane: MiB,
  rawBytesPerPane: 256 * 1024,
  metadataBytesPerPane: MiB / 4,
  pendingBytes: 16 * MiB,
  scratchBytes: 32 * MiB,
  diskCacheBytes: 12 * MiB,
  pagePoolBytes: 16 * MiB,
  pageBytesPerViewer: 2 * MiB,
  wsPendingBytes: 8 * MiB,
  unattributedReserveBytes: 96 * MiB,
  blockRows: 256,
  blockPayloadBytes: 256 * 1024,
  decodeRows: 256,
  decodeBytes: MiB,
  pageBytes: 2 * MiB,
  defaultPageRows: 500,
  maxPageRows: 2000,
  repairHorizonRows: 5012,
  activeReadsGlobal: 2,
  activeReadsPerPane: 1,
  queuedReads: 21,
  readDeadlineMs: 1000,
  releasePinMs: 1000,
  maxReadRetries: 2,
  checkpointMs: 1000,
  checkpointRows: 256,
  fsyncBatchTargetMs: 20,
  watchdogMs: 250,
  stalledInputMs: 500,
  recoveryMs: 1e4,
  visibleActiveMs: 200,
  visibleIdleMs: 1000,
  visibleNoViewerMs: 5000,
  visibleEventMs: 50,
  visibleDeadlineMs: 1000,
  latencyP95Ms: 45,
  latencyP99Ms: 80,
  pairedUpperCi95Ms: 3,
  quietP95Ms: 50,
  stressLatencyRatio: 1.25,
  stressDrainMs: 25000,
  normalMissingRows: 0,
  plannedMissingRows: 0,
  spikeFaultMissingRows: 0,
  unexpectedMarkedRowsPerPane: 5,
  unexpectedFaultRowsPerSecond: 2
});
function canonicalOperation() {
  const objects = new WeakMap;
  const strings = new Map;
  const encode = (value) => {
    if (value === null || typeof value === "boolean")
      return JSON.stringify(value);
    if (typeof value === "string") {
      const prior2 = strings.get(value);
      if (prior2 !== undefined)
        return prior2;
      if (!value.isWellFormed())
        throw Error("invalid Unicode");
      const encoded2 = JSON.stringify(value);
      strings.set(value, encoded2);
      return encoded2;
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value))
        throw Error("nonfinite number");
      return JSON.stringify(value);
    }
    if (typeof value !== "object")
      throw Error("non-JSON value");
    const prior = objects.get(value);
    if (prior !== undefined)
      return prior;
    let encoded;
    if (Array.isArray(value))
      encoded = "[" + value.map(encode).join(",") + "]";
    else {
      if (Object.getPrototypeOf(value) !== Object.prototype)
        throw Error("non-JSON value");
      const object = value;
      encoded = "{" + Object.keys(object).sort().map((k) => JSON.stringify(k) + ":" + encode(object[k])).join(",") + "}";
    }
    objects.set(value, encoded);
    return encoded;
  };
  return encode;
}
function streamCanonicalEncoder() {
  return canonicalOperation();
}
function streamCanonical(value, encode) {
  return (typeof encode === "function" ? encode : canonicalOperation())(value);
}
function streamDigest(kind, payload) {
  return createHash5("sha256").update(streamCanonical({ version: STREAM_CONTRACT_VERSION, kind, payload })).digest("hex");
}
function eventKey(id) {
  return JSON.stringify([id.pane.serverIdentity, id.pane.paneId, id.pane.birthGeneration, id.sourceEpoch, id.packetSeq, id.scrollOrdinal]);
}
function validReadOpen(ack) {
  const v = ack.view;
  return [v.durableAtGrant, ack.diskSnapshotRevision, v.grantRevision, v.headAtGrant, v.range.start, v.range.end].every((n) => Number.isSafeInteger(n) && n >= 0) && v.durableAtGrant <= ack.diskSnapshotRevision && ack.diskSnapshotRevision <= v.grantRevision && v.range.start <= v.range.end && v.range.end <= v.headAtGrant;
}
var FLAGON_VERSIONS = Object.freeze({ stitch: 1, capture: 1, spool: 1, receipt: 1, bundle: 1, catalog: 3, history: 1 });
var FLAGON_BUDGET = Object.freeze({
  processTreePssHardBytes: 1536 * MiB,
  plateauMinMs: 180 * 60000,
  plateauMaxDeltaBytes: 10 * MiB,
  normalMissingRows: 0,
  plannedMissingRows: 0,
  faultMissingRowsLimit: null,
  tailSearchRows: 512,
  searchChunkRows: 256,
  retainedHistoryRows: 4500,
  minAnchorRows: 8,
  minDistinctKeys: 4,
  minNonblankRows: 2,
  maxCandidates: 4096,
  stitchDeadlineMs: 100,
  captureCountPerEpisode: 1,
  rawBytesPerPane: 256 * 1024,
  stagingBytesGlobal: 16 * MiB,
  scratchBytes: 32 * MiB,
  restoreCacheBytes: 32 * MiB,
  archiveChunkBytes: 16 * MiB,
  canaryRootCapBytes: 256 * MiB,
  reserveBytes: 16 * MiB,
  reservePerPaneBytes: 256 * 1024,
  reserveSharedBytes: 8 * MiB,
  archiveConcurrency: 1,
  archivePollMs: 30000,
  archiveStartFsPercent: 75,
  archiveStartRootPercent: 75,
  archiveStartTimeToFullMs: 30 * 60000,
  archiveStopFsPercent: 70,
  archiveStopRootPercent: 65,
  archiveStopReserveMultiple: 2,
  archiveStopTimeToFullMs: 60 * 60000,
  criticalFsPercent: 90,
  criticalRootPercent: 90,
  criticalRateHorizonMs: 10 * 60000,
  healthPollMs: 1000,
  incidentDeadlineMs: 2000,
  recoveryMs: 1e4,
  reconnectBackoffMs: Object.freeze([100, 500, 1000, 2000])
});
var FLAGON_REPAIR_LIMITS = Object.freeze({
  receiptSetEntries: 256,
  chunkRows: 256,
  chunkBytes: MiB,
  receiptSetBytes: MiB,
  readEntries: 256,
  readBytes: MiB
});
var sameContract = (a, b) => streamCanonical(a) === streamCanonical(b);
function contractUint(n) {
  if (!Number.isSafeInteger(n) || n < 0)
    throw Error("contract unsafe counter");
}
function contractHash(hash) {
  if (!/^[a-f0-9]{64}$/.test(hash))
    throw Error("contract invalid SHA-256");
}
function semanticStyleToSgr(style) {
  contractUint(style.attrs);
  if (style.attrs > 1023)
    throw Error("unsupported semantic attributes");
  const sgr = [];
  for (let n = 1;n <= 9; n++)
    if (style.attrs & 1 << n - 1)
      sgr.push(n);
  if (style.attrs & 512)
    sgr.push(21);
  const color = (c, base, bright, extended) => {
    if (!Number.isSafeInteger(c) || c < -1 || c > 16777215 + 256)
      throw Error("unsupported semantic color");
    if (c === -1)
      return;
    if (c < 8)
      sgr.push(base + c);
    else if (c < 16)
      sgr.push(bright + c - 8);
    else if (c < 256)
      sgr.push(extended, 5, c);
    else {
      const rgb = c - 256;
      sgr.push(extended, 2, rgb >>> 16, rgb >>> 8 & 255, rgb & 255);
    }
  };
  color(style.fg, 30, 90, 38);
  color(style.bg, 40, 100, 48);
  return sgr;
}
function sgrToSemanticStyle(sgr) {
  let attrs = 0, fg = -1, bg = -1;
  for (let i = 0;i < sgr.length; i++) {
    const n = sgr[i];
    contractUint(n);
    if (n >= 1 && n <= 9)
      attrs |= 1 << n - 1;
    else if (n === 21)
      attrs |= 512;
    else if (n >= 30 && n <= 37)
      fg = n - 30;
    else if (n >= 90 && n <= 97)
      fg = n - 90 + 8;
    else if (n >= 40 && n <= 47)
      bg = n - 40;
    else if (n >= 100 && n <= 107)
      bg = n - 100 + 8;
    else if (n === 38 || n === 48) {
      const mode = sgr[++i];
      const byte = () => {
        const v = sgr[++i];
        contractUint(v);
        if (v > 255)
          throw Error("SGR color byte");
        return v;
      };
      let c;
      if (mode === 5)
        c = byte();
      else if (mode === 2)
        c = 256 + byte() * 65536 + byte() * 256 + byte();
      else
        throw Error("unsupported SGR color mode");
      if (n === 38)
        fg = c;
      else
        bg = c;
    } else
      throw Error("noncanonical SGR");
  }
  const style = { attrs, fg, bg };
  if (!sameContract(semanticStyleToSgr(style), sgr))
    throw Error("noncanonical SGR order/alias");
  return style;
}
function cellToSemanticCell(cell) {
  if (![0, 1, 2].includes(cell.width) || !cell.text.isWellFormed())
    throw Error("invalid cell");
  return { text: cell.text, width: cell.width, style: sgrToSemanticStyle(cell.style) };
}
function normalizedRowsDigest(range, rows) {
  return streamDigest("newarch-legacy-coverage-rows", { range, rows: rows.map((row) => ({
    id: row.id,
    cells: row.cells,
    wrapStatus: row.wrapStatus,
    wrapPad: row.wrapPad,
    buffer: row.buffer
  })) });
}
function normalizedGapDigest(gap) {
  return streamDigest("newarch-legacy-coverage-gap", gap);
}
function normalizedCoverageDigest(coverage) {
  return streamDigest("newarch-legacy-receipt-coverage", coverage);
}
function coverageProjectionDigest(proof) {
  return streamDigest("coverage-projection-r2", proof);
}
function sourceSpoolDigest(record) {
  return streamDigest("spool-record", record);
}
function inputProvenanceDigest(input) {
  return streamDigest("input-provenance-r2", input);
}
function attachReceiptSetDigest(entries) {
  return streamDigest("attach-receipt-set-r2", entries);
}
function attachCoverage(set, receipts) {
  if (set.revision !== 2 || !set.transactionId || !set.decisionId || !sameContract(set.pane, set.epoch.pane) || set.entries.length === 0 || set.entries.length > FLAGON_REPAIR_LIMITS.receiptSetEntries || receipts.length !== set.entries.length || Buffer.byteLength(streamCanonical(set)) > MiB || Buffer.byteLength(streamCanonical(receipts)) > MiB)
    throw Error("attach manifest bound/identity");
  contractUint(set.expectedGeneration);
  if (set.aggregateDigest !== attachReceiptSetDigest(set.entries))
    throw Error("attach aggregate digest");
  const ids = new Set, ops = new Set;
  const coverage = [];
  for (const [i, entry] of set.entries.entries()) {
    const receipt = receipts[i];
    contractUint(entry.rows);
    contractUint(entry.payloadBytes);
    contractHash(entry.digest);
    if (entry.ordinal !== i || entry.rows > 256 || entry.payloadBytes > MiB || !entry.commitId || !entry.operationId || ids.has(entry.commitId) || ops.has(entry.operationId) || receipt.kind !== "rows-gaps-durable" || receipt.commitId !== entry.commitId || receipt.operationId !== entry.operationId || receipt.digest !== entry.digest || receipt.generation !== set.expectedGeneration)
      throw Error("attach receipt order/identity");
    ids.add(entry.commitId);
    ops.add(entry.operationId);
    let rows = 0;
    for (const part of receipt.coverage) {
      const pane = part.kind === "rows" ? part.range.pane : part.gap.pane;
      if (!sameContract(pane, set.pane))
        throw Error("attach cross-pane coverage");
      if (part.kind === "rows") {
        contractUint(part.range.start);
        contractUint(part.range.end);
        if (part.range.end < part.range.start)
          throw Error("attach inverted coverage");
        rows += part.range.end - part.range.start;
      }
      coverage.push(part);
    }
    if (rows !== entry.rows)
      throw Error("attach row coverage");
  }
  if (set.terminalCommitId !== set.entries[set.entries.length - 1].commitId)
    throw Error("attach terminal receipt");
  return coverage;
}
function archiveInventoryMatches(seal, bundle, inventory) {
  const sources = [...seal.files, seal.manifest];
  if (inventory.revision !== 2 || inventory.sealGeneration !== seal.generation || inventory.sealCommitId !== seal.sealCommitId || inventory.sealManifestSha256 !== seal.manifest.sha256 || inventory.bundleManifestSha256 !== bundle.manifest.sha256 || bundle.storeUUID !== seal.storeUUID || bundle.segmentId !== seal.segmentId || !sameContract(bundle.pane, seal.pane) || !sameContract(bundle.coverage, seal.coverage) || sources.length !== inventory.members.length || bundle.members.length !== sources.length || sources.length > 256)
    return false;
  const usedSource = new Set, usedRelative = new Set;
  for (const m of inventory.members) {
    if (!m.relativePath || m.relativePath.includes("\\") || m.relativePath.split("/").some((p) => !p || p === "." || p === "..") || /[\x00-\x1f\x7f:]/.test(m.relativePath) || usedSource.has(m.sourcePath) || usedRelative.has(m.relativePath) || !Number.isSafeInteger(m.bytes) || m.bytes < 0 || !/^[a-f0-9]{64}$/.test(m.sha256))
      return false;
    usedSource.add(m.sourcePath);
    usedRelative.add(m.relativePath);
    const source = sources.find((f) => f.path === m.sourcePath), member = bundle.members.find((f) => f.path === m.relativePath);
    if (!source || !member || source.bytes !== m.bytes || member.bytes !== m.bytes || source.sha256 !== m.sha256 || member.sha256 !== m.sha256)
      return false;
  }
  return true;
}
function segmentContinuityDigest(value) {
  return streamDigest("segment-continuity-r2", value);
}
function orderedControlDigest(value) {
  return streamDigest("ordered-control-r2", value);
}
function gapIdentity(gap) {
  if ("repair" in gap) {
    if (gap.repair.revision !== 2 || !gap.repair.gapId)
      throw Error("unsupported gap identity");
    contractUint(gap.repair.sequence);
    contractUint(gap.repair.update);
    return streamCanonical(["gap-r2", gap.pane, gap.episodeId, gap.repair.gapId, gap.repair.sequence]);
  }
  return streamCanonical(["gap-v1", gap.pane, gap.episodeId]);
}
function validGapUpdate(previous, next) {
  return gapIdentity(previous) === gapIdentity(next) && previous.repair.state === "open" && next.repair.update === previous.repair.update + 1 && sameContract(previous.leftRowId, next.leftRowId) && previous.openedAt === next.openedAt && previous.clockEpoch === next.clockEpoch && next.withheldRows >= previous.withheldRows && (next.countKind !== "unknown" || next.missingCount === null) && (next.repair.state === "closed" ? next.closedAt !== null : next.closedAt === null);
}
function archiveInventoryDigest(inventory) {
  return streamDigest("archive-inventory-r2", inventory);
}
function sourceRecordsDigest(records) {
  return streamDigest("source-records-r2", records);
}
var NEWARCH_V2_VERSION = "newarch-v2";
var NEWARCH_V2_LIMITS = Object.freeze({
  maxColumns: 240,
  maxRows: 120,
  maxActivePanes: 21,
  maxIdentityBytes: 256,
  pendingRowsPerPane: 256,
  pendingBytesPerPane: MiB,
  pendingDeadlineMs: 1000,
  vtBytesPerPane: 2 * MiB,
  checkpointBytesPerPane: 4 * MiB,
  auditQueueEntries: 21,
  diagnosticEventBytes: 64 * 1024,
  diagnosticTotalBytes: 64 * MiB,
  pageEntries: 256,
  pageBytes: 2 * MiB,
  cursorBytes: 4096,
  processTreePssHardBytes: 1536 * MiB,
  plateauMinMs: 180 * 60000,
  pssWindowMs: 60 * 60000,
  pssWarmupMs: 10 * 60000,
  pssSampleMs: 1000,
  pssTransientSampleMs: 100,
  pssSlopeMiBPerHour: 10,
  pssMeanDeltaMiB: 10,
  pssMeanWindowsMinutes: Object.freeze([Object.freeze([10, 20]), Object.freeze([30, 40]), Object.freeze([50, 60])]),
  rowRates: Object.freeze([0.5, 2]),
  normalMissingRows: 0
});
var NEWARCH_V2_AUDIT_TRIGGERS = Object.freeze([
  "uncertain-rule",
  "decoder-anomaly",
  "checkpoint-mismatch",
  "resume"
]);
var NEWARCH_V2_DEFAULT_CONFIG = Object.freeze({
  schema: NEWARCH_V2_VERSION,
  configVersion: "q22-default-2",
  geometry: Object.freeze({ columns: 78, rows: 120 }),
  maxActivePanes: 21,
  rules: Object.freeze([
    Object.freeze({ ruleId: "ordered-scroll", version: "1" }),
    Object.freeze({ ruleId: "bounded-tail", version: "1" }),
    Object.freeze({ ruleId: "explicit-gap", version: "1" })
  ]),
  audit: Object.freeze({
    enabled: true,
    intervalMs: 300000,
    jitterFraction: 0.2,
    triggers: NEWARCH_V2_AUDIT_TRIGGERS,
    minGapMs: 30000,
    maxConcurrent: 1,
    timeoutMs: 2000,
    maxCaptureBytes: 262144,
    maxRetries: 1
  }),
  storage: Object.freeze({
    rootCapBytes: 256 * MiB,
    emergencyReserveBytes: 16 * MiB,
    reservePerPaneBytes: 256 * 1024,
    reserveSharedBytes: 8 * MiB,
    diagnosticCapBytes: 64 * MiB,
    stagingCapBytes: 32 * MiB
  })
});
function v2Int(n, min = 0, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(n) || n < min || n > max)
    throw Error("v2 integer bound");
}
function v2Text(text, max = NEWARCH_V2_LIMITS.maxIdentityBytes) {
  if (typeof text !== "string" || !text || !text.isWellFormed() || Buffer.byteLength(text) > max)
    throw Error("v2 text bound");
}
function v2PaneKey(p) {
  v2Text(p.serverIdentity);
  v2Text(p.paneId);
  v2Int(p.birthGeneration, 1);
  return streamCanonical([p.serverIdentity, p.paneId, p.birthGeneration]);
}
function v2SessionKey(s) {
  v2Text(s.serverIdentity);
  v2Text(s.sessionId);
  return streamCanonical([s.serverIdentity, s.sessionId]);
}
function v2Digest(kind, payload, encode) {
  const canonical = typeof encode === "function" ? encode : canonicalOperation();
  return createHash5("sha256").update(canonical({ schema: NEWARCH_V2_VERSION, kind, payload })).digest("hex");
}
var V2_ALLOCATION_FIELDS = Object.freeze({
  database: "databaseBytes",
  wal: "walBytes",
  raw: "rawBytes",
  staging: "stagingBytes",
  diagnostic: "diagnosticBytes",
  other: "otherBytes"
});
var NEWARCH_V2_STORAGE_PROFILES = Object.freeze({
  "default-256m": Object.freeze({ name: "default-256m", storage: NEWARCH_V2_DEFAULT_CONFIG.storage, allocation: null }),
  "r-canary-8g": Object.freeze({
    name: "r-canary-8g",
    storage: Object.freeze({
      rootCapBytes: 8192 * MiB,
      emergencyReserveBytes: 16 * MiB,
      reservePerPaneBytes: 256 * 1024,
      reserveSharedBytes: 8 * MiB,
      diagnosticCapBytes: 64 * MiB,
      stagingCapBytes: 32 * MiB
    }),
    allocation: Object.freeze({
      databaseBytes: 4088 * MiB,
      walBytes: 1024 * MiB,
      rawBytes: 128 * MiB,
      stagingBytes: 32 * MiB,
      diagnosticBytes: 64 * MiB,
      otherBytes: 64 * MiB
    })
  })
});
function v2LegacyStorageProfile(storage) {
  return Object.freeze({ name: "legacy", storage, allocation: null });
}
function v2StorageProfileDigest(p) {
  const { storage: s, allocation: a } = p;
  return v2Digest("storage-profile", {
    storage: {
      rootCapBytes: s.rootCapBytes,
      emergencyReserveBytes: s.emergencyReserveBytes,
      reservePerPaneBytes: s.reservePerPaneBytes,
      reserveSharedBytes: s.reserveSharedBytes,
      diagnosticCapBytes: s.diagnosticCapBytes,
      stagingCapBytes: s.stagingCapBytes
    },
    allocation: a && {
      databaseBytes: a.databaseBytes,
      walBytes: a.walBytes,
      rawBytes: a.rawBytes,
      stagingBytes: a.stagingBytes,
      diagnosticBytes: a.diagnosticBytes,
      otherBytes: a.otherBytes
    }
  });
}
function v2DatabasePageLimit(p, pageSize) {
  v2Int(pageSize, 512, 65536);
  if ((pageSize & pageSize - 1) !== 0)
    throw Error("v2 page size");
  const s = p.storage;
  const databaseBytes = p.allocation ? p.allocation.databaseBytes : Math.floor((s.rootCapBytes - s.emergencyReserveBytes) / 2);
  return Math.floor(databaseBytes / pageSize);
}
function v2WriteDisposition(f, generation, revision, previous) {
  v2Int(f.expectedGeneration, 1);
  v2Int(f.expectedRevision);
  v2Int(generation, 1);
  v2Int(revision);
  v2Text(f.operationId);
  contractHash(f.digest);
  v2PaneKey(f.pane);
  if (f.expectedGeneration !== generation)
    return "stale";
  if (previous)
    return previous.operationId === f.operationId && previous.digest === f.digest && v2PaneKey(previous.pane) === v2PaneKey(f.pane) ? "retry" : "integrity";
  return f.expectedRevision === revision ? "commit" : "stale";
}
function v2AuditComparable(e, current, c) {
  if (!c.enabled || e.ordering.kind !== "certified-source-fence" || !e.ordering.certificateId || !e.ordering.proof.path || !/^[a-f0-9]{64}$/.test(e.ordering.proof.sha256) || !Number.isSafeInteger(e.ordering.proof.bytes) || e.ordering.proof.bytes < 1 || e.ordering.proof.bytes > NEWARCH_V2_LIMITS.diagnosticEventBytes || !Number.isSafeInteger(e.captureBytes) || e.captureBytes < 0 || e.captureBytes > c.maxCaptureBytes || !Number.isFinite(e.elapsedMs) || e.elapsedMs < 0 || e.elapsedMs > c.timeoutMs)
    return false;
  return sameContract(e.before, e.after) && sameContract(e.after, e.snapshot) && sameContract(e.snapshot, current);
}
function v2WriteDigest(request, encode) {
  return v2Digest("write", { pane: request.fence.pane, operationId: request.fence.operationId, command: request.command }, encode);
}
function validateV2Checkpoint(c, encode) {
  validateCheckpointCanonical(c, typeof encode === "function" ? encode : canonicalOperation());
}
function validateCheckpointCanonical(c, canonical) {
  if (c.schema !== NEWARCH_V2_VERSION || c.geometry.policy !== "fixed-at-birth" || c.geometry.panesPerWindow !== 1)
    throw Error("v2 checkpoint schema");
  v2PaneKey(c.pane);
  v2Text(c.checkpointId);
  v2Int(c.revision);
  v2Int(c.geometry.columns, 1, NEWARCH_V2_LIMITS.maxColumns);
  v2Int(c.geometry.rows, 1, NEWARCH_V2_LIMITS.maxRows);
  v2Text(c.geometry.configVersion);
  v2Text(c.rule.ruleId);
  v2Text(c.rule.version);
  v2Text(c.rule.configVersion);
  if (c.frontier && v2PaneKey(c.frontier.pane) !== v2PaneKey(c.pane))
    throw Error("v2 checkpoint frontier");
  v2Int(c.through.byteOffset);
  v2Int(c.replayFloor.byteOffset);
  if (!sameContract(c.through.epoch, c.replayFloor.epoch) || v2PaneKey(c.through.epoch.pane) !== v2PaneKey(c.pane) || c.replayFloor.byteOffset > c.through.byteOffset)
    throw Error("v2 checkpoint raw");
  if (c.state.geometry.columns !== c.geometry.columns || c.state.geometry.rows !== c.geometry.rows || createHash5("sha256").update(canonical({ schema: NEWARCH_V2_VERSION, kind: "vt-state", payload: c.state })).digest("hex") !== c.stateDigest)
    throw Error("v2 checkpoint state");
  v2Int(c.pending.bytes, 0, NEWARCH_V2_LIMITS.pendingBytesPerPane);
  if (c.pending.rows.length > NEWARCH_V2_LIMITS.pendingRowsPerPane || (c.pending.rows.length > 0 || c.pending.bytes > 0) && c.pending.deadlineMonoMs === null)
    throw Error("v2 checkpoint pending");
  if (c.pending.deadlineMonoMs !== null)
    v2Int(c.pending.deadlineMonoMs);
  if (Buffer.byteLength(canonical(c.state)) > NEWARCH_V2_LIMITS.vtBytesPerPane || Buffer.byteLength(canonical(c)) > NEWARCH_V2_LIMITS.checkpointBytesPerPane)
    throw Error("v2 checkpoint bytes");
}
function validateV2Incident(i) {
  if (i.schema !== NEWARCH_V2_VERSION)
    throw Error("v2 incident schema");
  v2Text(i.incidentId);
  v2PaneKey(i.pane);
  v2Text(i.clockEpoch);
  for (const n of [i.openedAtWallMs, i.openedAtMonoMs, i.revision])
    v2Int(n);
  if (i.sourceOffset === null !== (i.sourceEpoch === null))
    throw Error("v2 incident source");
  if (i.sourceOffset !== null)
    v2Int(i.sourceOffset);
  if (i.sourceEpoch) {
    v2Text(i.sourceEpoch.attachId);
    v2Text(i.sourceEpoch.collectorIncarnation);
  }
  for (const row of [i.frontier, i.affected.after, i.affected.through]) {
    if (row) {
      v2Text(row.segmentId);
      v2Int(row.rowOrdinal);
      if (v2PaneKey(row.pane) !== v2PaneKey(i.pane))
        throw Error("v2 incident pane");
    }
  }
  if (i.missing.countKind === "unknown") {
    if (i.missing.missingCount !== null)
      throw Error("v2 unknown count");
  } else
    v2Int(i.missing.missingCount);
  if (i.action === "gap-and-stop" && i.collecting)
    throw Error("v2 stopped incident");
  for (const hash of [i.expectedDigest, i.actualDigest])
    if (hash !== null)
      contractHash(hash);
  if (i.evidence) {
    v2Int(i.evidence.bytes, 0, NEWARCH_V2_LIMITS.diagnosticEventBytes);
    contractHash(i.evidence.digest);
    if (i.evidence.redacted !== true)
      throw Error("v2 diagnostic redaction");
  }
}
function validateV2ReadRequest(r) {
  if (r.schema !== NEWARCH_V2_VERSION || !["before", "after"].includes(r.direction))
    throw Error("v2 read schema");
  v2PaneKey(r.pane);
  v2Int(r.maxEntries, 1, NEWARCH_V2_LIMITS.pageEntries);
  v2Int(r.maxBytes, 1, NEWARCH_V2_LIMITS.pageBytes);
  if (r.cursor) {
    if (r.cursor.schema !== NEWARCH_V2_VERSION || v2PaneKey(r.cursor.pane) !== v2PaneKey(r.pane))
      throw Error("v2 cursor pane");
    v2Text(r.cursor.storeId);
    v2Text(r.cursor.token, NEWARCH_V2_LIMITS.cursorBytes);
    v2Int(r.cursor.timelineRevision);
  }
}
function v2WriterGeneration(n) {
  v2Int(n, 1);
  return n;
}
function v2SourceEpochOf(epoch) {
  return { attachId: epoch.attachId, collectorIncarnation: epoch.collectorIncarnation };
}
function v2SameEpoch(a, b) {
  return sameContract(a, b) && v2PaneKey(a.pane) === v2PaneKey(b.pane);
}
function v2Guard(check) {
  try {
    return check();
  } catch {
    return false;
  }
}
var NEWARCH_V2_PREFIX_LIMITS = Object.freeze({
  maxRawBytes: NEWARCH_V2_LIMITS.pendingBytesPerPane,
  maxRows: NEWARCH_V2_LIMITS.pendingRowsPerPane,
  maxSerializedBytes: NEWARCH_V2_LIMITS.pageBytes,
  checkpointBytes: NEWARCH_V2_LIMITS.checkpointBytesPerPane
});
function v2SourcePrefixReceiptDigest(r) {
  return v2Digest("source-prefix-receipt", r);
}
function v2BatchInputMatchesIssued(input, issued, previous, checkpoint) {
  return v2Guard(() => {
    if (issued === null || !sameContract(input, issued))
      return false;
    const epoch = checkpoint.through.epoch;
    if (input.kind === "synced-spool") {
      return input.version === 1 && sameContract(input.through, checkpoint.through);
    }
    if (input.kind !== "source-prefix" || input.schema !== NEWARCH_V2_VERSION)
      return false;
    validateV2Checkpoint(previous);
    validateV2Checkpoint(checkpoint);
    const { digest, ...unsigned } = input;
    if (digest !== v2SourcePrefixReceiptDigest(unsigned))
      return false;
    v2Text(input.receiptId);
    contractHash(input.lastRecordDigest);
    for (const n of [
      input.certified.start,
      input.certified.end,
      input.firstSequence,
      input.lastSequence,
      input.lastRecordEnd
    ])
      v2Int(n);
    return v2PaneKey(previous.pane) === v2PaneKey(checkpoint.pane) && v2SameEpoch(previous.through.epoch, epoch) && v2SameEpoch(input.certified.epoch, epoch) && sameContract(input.sourceEpoch, v2SourceEpochOf(epoch)) && input.certified.start === previous.through.byteOffset && input.certified.end === checkpoint.through.byteOffset && input.certified.end > input.certified.start && input.certified.end - input.certified.start <= NEWARCH_V2_PREFIX_LIMITS.maxRawBytes && input.lastRecordEnd >= input.certified.end && input.firstSequence <= input.lastSequence;
  });
}
var V2_CONTAINING_REPLAY_LIMITS = Object.freeze({
  recordBytes: 16 * 1024,
  maxRecords: 16,
  maxRawBytes: 64 * 1024,
  maxSerializedBytes: 256 * 1024 - 4096
});
var V2_CONTINUITY_REQUIRED_EVENTS = Object.freeze([
  "resize",
  "layout",
  "split",
  "window",
  "pipe",
  "server-exit"
]);
function v2EmergencyIncidentDigest(incident) {
  return v2Digest("emergency-incident", incident);
}

// src/tmux-capture-normalize.ts
var ESC = 27;
var BEL = 7;
var SO = 14;
var SI = 15;
var VS16 = 65039;
function escapeEnd(text, start) {
  const introducer = text.charCodeAt(start + 1);
  if (introducer === 91) {
    for (let index = start + 2;index < text.length; index += 1) {
      const code = text.charCodeAt(index);
      if (code >= 64 && code <= 126)
        return index + 1;
    }
    return text.length;
  }
  if (introducer === 93) {
    for (let index = start + 2;index < text.length; index += 1) {
      const code = text.charCodeAt(index);
      if (code === BEL)
        return index + 1;
      if (code === ESC && text.charCodeAt(index + 1) === 92)
        return index + 2;
    }
    return text.length;
  }
  return Math.min(text.length, start + 2);
}
function normalizeTmuxCaptureCells(text) {
  let normalized = "";
  let index = 0;
  let previousVisibleWidth = 0;
  let promotedPaddingPending = false;
  while (index < text.length) {
    const codePoint = text.codePointAt(index);
    const unitLength = codePoint > 65535 ? 2 : 1;
    if (codePoint === ESC) {
      const end = escapeEnd(text, index);
      normalized += text.slice(index, end);
      index = end;
      continue;
    }
    if (codePoint === 10) {
      normalized += `
`;
      index += 1;
      previousVisibleWidth = 0;
      promotedPaddingPending = false;
      continue;
    }
    if (codePoint === SO || codePoint === SI) {
      normalized += text.slice(index, index + unitLength);
      index += unitLength;
      continue;
    }
    const width = codePoint >= 32 && codePoint < 127 ? 1 : charCellWidth(codePoint);
    if (promotedPaddingPending && codePoint === 32) {
      promotedPaddingPending = false;
      index += 1;
      continue;
    }
    if (promotedPaddingPending && width > 0)
      promotedPaddingPending = false;
    normalized += text.slice(index, index + unitLength);
    index += unitLength;
    if (codePoint === VS16 && previousVisibleWidth === 1) {
      previousVisibleWidth = 2;
      promotedPaddingPending = true;
    } else if (width > 0) {
      previousVisibleWidth = width;
    }
  }
  return normalized;
}
var TMUX_OBSERVED_FIELDS = ["grapheme", "width", "continuation", "fg", "bg", "style", "cursor-position", "cursor-visible"];
var SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });
var SGR_AT = /\x1b\[([0-9;:]*)m/y;
function applySgr(state, body) {
  if (body.includes(":"))
    body = body.replace(/(38|48|58):2::?(\d+):(\d+):(\d+)/g, "$1;2;$2;$3;$4").replace(/(38|48|58):5:(\d+)/g, "$1;5;$2").replace(/\b(4|5):[0-9]+/g, (_, kind) => kind === "4" ? "4" : "53");
  if (!/^[0-9;]*$/.test(body))
    throw new Error("unsupported capture SGR");
  const codes = body === "" ? [0] : body.split(";").map((x) => x === "" ? 0 : Number(x));
  for (let i = 0;i < codes.length; i++) {
    const n = codes[i];
    if (n === 0) {
      state.fg = state.bg = "default";
      state.style = 0;
    } else if (n >= 1 && n <= 9)
      state.style |= 1 << n - 1;
    else if (n === 21)
      state.style = state.style & ~8 | 512;
    else if (n === 22)
      state.style &= ~3;
    else if (n === 23)
      state.style &= ~4;
    else if (n === 24)
      state.style &= ~(8 | 512);
    else if (n === 25)
      state.style &= ~(16 | 32);
    else if (n === 27)
      state.style &= ~64;
    else if (n === 28)
      state.style &= ~128;
    else if (n === 29)
      state.style &= ~256;
    else if (n === 39)
      state.fg = "default";
    else if (n === 49)
      state.bg = "default";
    else if (n >= 30 && n <= 37)
      state.fg = `index:${n - 30}`;
    else if (n >= 40 && n <= 47)
      state.bg = `index:${n - 40}`;
    else if (n >= 90 && n <= 97)
      state.fg = `index:${n - 90 + 8}`;
    else if (n >= 100 && n <= 107)
      state.bg = `index:${n - 100 + 8}`;
    else if (n === 53 || n === 55 || n === 59) {} else if (n === 38 || n === 48 || n === 58) {
      const mode = codes[++i];
      const count = mode === 5 ? 1 : mode === 2 ? 3 : 0;
      if (!count)
        throw new Error("unsupported capture color");
      const values = codes.slice(i + 1, i + count + 1);
      if (values.length !== count || values.some((v) => !Number.isInteger(v) || v < 0 || v > 255))
        throw new Error("invalid capture color");
      i += count;
      const color = mode === 5 ? `index:${values[0]}` : `rgb:${values.join(",")}`;
      if (n === 38)
        state.fg = color;
      else if (n === 48)
        state.bg = color;
    } else
      throw new Error(`unobserved capture SGR ${n}`);
  }
}
var printableAscii = (code) => code >= 32 && code < 127;
var CLUSTER_PIECES = new Map;
function clusterPieces(cluster) {
  const cached = CLUSTER_PIECES.get(cluster);
  if (cached)
    return cached;
  const pieces = /[\u0e00-\u0e7f]/u.test(cluster) ? cluster.match(/[^\p{Mark}][\p{Mark}]*/gu) ?? [cluster] : [cluster];
  const result = pieces.map((segment) => {
    if (/[\x00-\x1f\x7f]/.test(segment))
      throw new Error("control byte in capture cells");
    let width = segment.length === 1 && printableAscii(segment.charCodeAt(0)) ? 1 : Math.min(2, stringCells(segment));
    if (segment.includes("️") && width === 1)
      width = 2;
    return [segment, width];
  });
  if (CLUSTER_PIECES.size >= 4096)
    CLUSTER_PIECES.clear();
  CLUSTER_PIECES.set(cluster, result);
  return result;
}
function pushClusters(cells, text, state) {
  for (const { segment: cluster } of SEGMENTER.segment(text)) {
    for (const [segment, width] of clusterPieces(cluster)) {
      if (width === 0) {
        const previous = cells.findLast((c) => !c.continuation);
        if (!previous)
          throw new Error("orphan combining capture cell");
        previous.grapheme += segment;
        continue;
      }
      cells.push({ grapheme: segment, width, continuation: false, fg: state.fg, bg: state.bg, style: state.style });
      if (width === 2)
        cells.push({ grapheme: "", width: 0, continuation: true, fg: state.fg, bg: state.bg, style: state.style });
    }
  }
}
function pushText(cells, text, state) {
  let at = 0;
  while (at < text.length) {
    const code = text.charCodeAt(at);
    if (printableAscii(code) && (at + 1 >= text.length || printableAscii(text.charCodeAt(at + 1)))) {
      cells.push({ grapheme: text[at], width: 1, continuation: false, fg: state.fg, bg: state.bg, style: state.style });
      at++;
      continue;
    }
    let end = at + 1;
    while (end < text.length && !(printableAscii(text.charCodeAt(end - 1)) && printableAscii(text.charCodeAt(end)) && (end + 1 >= text.length || printableAscii(text.charCodeAt(end + 1)))))
      end++;
    pushClusters(cells, text.slice(at, end), state);
    at = end;
  }
}
function decodeLine(line, cols, state, clip = false) {
  const cells = [];
  let at = 0;
  while (at < line.length) {
    if (line.charCodeAt(at) === ESC) {
      if (line.startsWith("\x1B]8;", at)) {
        at = escapeEnd(line, at);
        continue;
      }
      SGR_AT.lastIndex = at;
      const match = SGR_AT.exec(line);
      if (!match)
        throw new Error("unsupported capture escape");
      applySgr(state, match[1]);
      at += match[0].length;
      continue;
    }
    const next = line.indexOf("\x1B", at);
    const text = line.slice(at, next < 0 ? line.length : next);
    pushText(cells, text, state);
    at += text.length;
  }
  if (cells.length > cols) {
    if (!clip)
      throw new Error("capture row exceeds geometry");
    cells.length = cols;
    const last = cells[cols - 1];
    if (last.width === 2)
      cells[cols - 1] = { grapheme: " ", width: 1, continuation: false, fg: last.fg, bg: last.bg, style: last.style };
  }
  while (cells.length < cols)
    cells.push({ grapheme: " ", width: 1, continuation: false, fg: "default", bg: "default", style: 0 });
  return cells;
}
function checkedCols(cols) {
  if (!Number.isSafeInteger(cols) || cols < 1)
    throw new Error("invalid capture width");
}
var AMBIGUOUS_EMOJI = /[\u{1f3fb}-\u{1f3ff}](?:\u2764|\u200d)|\u200d\p{Extended_Pictographic}\ufe0f?[\u{1f3fb}-\u{1f3ff}]|[\u{1f1e6}-\u{1f1ff}]{3}|[\u{1f3f3}\u{1f3f4}]\ufe0f? ?\u200d/u;
function decodeUncertainLine(line, cols, state) {
  return decodeLine(line, cols, state, true);
}
function decodeTmuxCaptureScreen(raw, cols) {
  checkedCols(cols);
  const rawLines = raw.split(`
`);
  if (rawLines.at(-1) === "")
    rawLines.pop();
  const uncertain = rawLines.map((line) => AMBIGUOUS_EMOJI.test(line));
  if (!uncertain.some(Boolean))
    return { rows: decodeTmuxCaptureRows(raw, cols), uncertainRows: [] };
  const lines = normalizeTmuxCaptureCells(raw).split(`
`);
  if (lines.at(-1) === "")
    lines.pop();
  if (lines.length !== rawLines.length || !rawLines.every(escapesCloseInLine))
    throw new Error("ambiguous tmux emoji cell boundary");
  const state = { fg: "default", bg: "default", style: 0 };
  const uncertainRows = [];
  const rows = lines.map((line, y) => {
    if (!uncertain[y])
      return decodeLine(line, cols, state);
    uncertainRows.push(y);
    return decodeUncertainLine(line, cols, state);
  });
  return { rows, uncertainRows };
}
function decodeTmuxCaptureRows(raw, cols) {
  checkedCols(cols);
  if (AMBIGUOUS_EMOJI.test(raw))
    throw new Error("ambiguous tmux emoji cell boundary");
  const lines = normalizeTmuxCaptureCells(raw).split(`
`);
  if (lines.at(-1) === "")
    lines.pop();
  const state = { fg: "default", bg: "default", style: 0 };
  return lines.map((line) => decodeLine(line, cols, state));
}
function escapesCloseInLine(line) {
  for (let at = line.indexOf("\x1B");at >= 0; at = line.indexOf("\x1B", at + 1)) {
    const introducer = line.charCodeAt(at + 1);
    if (introducer === 91 || introducer === 93) {
      const end = escapeEnd(line, at);
      const last = line.charCodeAt(end - 1);
      if (introducer === 91 ? !(last >= 64 && last <= 126) || end - 1 < at + 2 : !(last === BEL || last === 92 && line.charCodeAt(end - 2) === ESC && end - 2 > at))
        return false;
    } else if (at + 1 >= line.length)
      return false;
  }
  return true;
}
var CELL_INTERN_LIMIT = 65536;
var internedCells = new Map;
var internedCount = 0;
var lastFg = "";
var lastBg = "";
var lastStyle = -1;
var lastBucket;
function internCell(cell) {
  if (!lastBucket || cell.fg !== lastFg || cell.bg !== lastBg || cell.style !== lastStyle) {
    const style = `${cell.fg}\x00${cell.bg}\x00${cell.style}`;
    lastBucket = internedCells.get(style);
    if (!lastBucket) {
      lastBucket = [new Map, new Map, new Map, new Map, new Map, new Map];
      internedCells.set(style, lastBucket);
    }
    lastFg = cell.fg;
    lastBg = cell.bg;
    lastStyle = cell.style;
  }
  const slot = lastBucket[cell.width * 2 + (cell.continuation ? 1 : 0)];
  let shared = slot.get(cell.grapheme);
  if (!shared) {
    if (internedCount >= CELL_INTERN_LIMIT) {
      internedCells.clear();
      internedCount = 0;
      for (const map of lastBucket)
        map.clear();
      internedCells.set(`${cell.fg}\x00${cell.bg}\x00${cell.style}`, lastBucket);
    }
    shared = Object.freeze(cell);
    slot.set(cell.grapheme, shared);
    internedCount++;
  }
  return shared;
}
var CACHE_BYTE_MODEL = Object.freeze({ slot: 8, arrayHeader: 16, object: 48, stringHeader: 16, char: 2, mapEntry: 32, setEntry: 16 });

class TmuxCaptureDecoder {
  cols;
  maxEntries;
  minEntries;
  mapCell;
  cache = new Map;
  generation = 0;
  hits = 0;
  misses = 0;
  uncertainRows = [];
  constructor(cols, maxEntries = 9000, minEntries = 1, mapCell) {
    this.cols = cols;
    this.maxEntries = maxEntries;
    this.minEntries = minEntries;
    this.mapCell = mapCell;
    checkedCols(cols);
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1)
      throw new Error("invalid decoder cache size");
    if (!Number.isSafeInteger(minEntries) || minEntries < 1)
      throw new Error("invalid decoder cache size");
  }
  get size() {
    return this.cache.size;
  }
  get mapsCells() {
    return this.mapCell !== undefined;
  }
  stats() {
    let cellSlots = 0, keyChars = 0;
    for (const [key, entry] of this.cache) {
      cellSlots += entry.cells.length;
      keyChars += key.length;
    }
    const m = CACHE_BYTE_MODEL, entries = this.cache.size;
    return {
      entries,
      cellSlots,
      keyChars,
      generation: this.generation,
      hits: this.hits,
      misses: this.misses,
      bytes: entries * (m.mapEntry + m.object + m.arrayHeader + m.stringHeader) + cellSlots * m.slot + keyChars * m.char
    };
  }
  trim() {
    const keep = this.minEntries;
    if (this.cache.size <= keep)
      return;
    const stale = this.generation - 1;
    let excess = this.cache.size - keep;
    for (const [key, entry] of this.cache) {
      if (excess <= 0)
        break;
      if (entry.used < stale) {
        this.cache.delete(key);
        excess--;
      }
    }
  }
  decode(raw) {
    this.uncertainRows = [];
    this.generation++;
    const lines = raw.split(`
`);
    if (lines.at(-1) === "")
      lines.pop();
    try {
      return this.decodeLines(raw, lines);
    } finally {
      this.trim();
    }
  }
  decodeLines(raw, lines) {
    if (!lines.every(escapesCloseInLine)) {
      const screen = decodeTmuxCaptureScreen(raw, this.cols);
      this.uncertainRows = screen.uncertainRows;
      const map = this.mapCell;
      return map ? screen.rows.map((row) => row.map(map)) : screen.rows;
    }
    const state = { fg: "default", bg: "default", style: 0 };
    const rows = [];
    for (const line of lines) {
      if (AMBIGUOUS_EMOJI.test(line)) {
        this.uncertainRows.push(rows.length);
        const cells = decodeUncertainLine(normalizeTmuxCaptureCells(line), this.cols, state);
        rows.push(this.mapCell ? cells.map(this.mapCell) : cells);
        continue;
      }
      const key = `${state.fg}\x00${state.bg}\x00${state.style}\x00${line}`;
      let entry = this.cache.get(key);
      if (entry) {
        this.hits++;
        entry.used = this.generation;
      } else {
        this.misses++;
        const map = this.mapCell;
        const cells = decodeLine(normalizeTmuxCaptureCells(line), this.cols, state).map(map ? (cell) => map(internCell(cell)) : internCell);
        entry = { cells, fg: state.fg, bg: state.bg, style: state.style, used: this.generation };
        this.cache.set(key, entry);
        if (this.cache.size > this.maxEntries)
          this.cache.delete(this.cache.keys().next().value);
      }
      state.fg = entry.fg;
      state.bg = entry.bg;
      state.style = entry.style;
      rows.push(entry.cells);
    }
    return rows;
  }
}
class StreamCaptureChunkDecoder {
  cols;
  maxRowBytes;
  charge;
  utf8 = new TextDecoder("utf-8", { fatal: true });
  rawLine = "";
  line = "";
  state = { fg: "default", bg: "default", style: 0 };
  previousWidth = 0;
  promotion = false;
  escape = "none";
  oscEsc = false;
  openEscapeRow = false;
  anyUncertain = false;
  done = false;
  row = 0;
  chunk = [];
  charged = 0;
  maxRows = 256;
  constructor(cols, maxRowBytes = 65536, charge = () => {}) {
    this.cols = cols;
    this.maxRowBytes = maxRowBytes;
    this.charge = charge;
    checkedCols(cols);
    if (cols > 240 || !Number.isSafeInteger(maxRowBytes) || maxRowBytes < 1 || maxRowBytes > 65536)
      throw new Error("stream capture geometry/row budget");
  }
  decode() {
    if (Buffer.byteLength(this.rawLine) > this.maxRowBytes)
      throw new Error("stream capture row byte budget exceeded");
    const uncertain = AMBIGUOUS_EMOJI.test(this.rawLine);
    this.anyUncertain ||= uncertain;
    this.openEscapeRow ||= !escapesCloseInLine(this.rawLine);
    if (this.anyUncertain && this.openEscapeRow)
      throw new Error("ambiguous tmux emoji cell boundary");
    const cells = (uncertain ? decodeUncertainLine(this.line, this.cols, this.state) : decodeLine(this.line, this.cols, this.state)).map((cell) => Object.freeze(cell));
    this.rawLine = "";
    this.line = "";
    const result = { index: this.row++, cells, uncertain, softWrap: null, uncertainFields: ["softWrap", "wrapPad"] };
    return result;
  }
  normalize(unit) {
    const cp = unit.codePointAt(0);
    if (this.escape !== "none") {
      if (this.escape === "intro")
        this.escape = cp === 91 ? "csi" : cp === 93 ? "osc" : "none";
      else if (this.escape === "csi" && cp >= 64 && cp <= 126)
        this.escape = "none";
      else if (this.escape === "osc") {
        if (cp === BEL || this.oscEsc && cp === 92)
          this.escape = "none";
        this.oscEsc = cp === ESC;
      }
      return unit;
    }
    if (cp === ESC) {
      this.escape = "intro";
      this.oscEsc = false;
      return unit;
    }
    if (cp === 10) {
      this.previousWidth = 0;
      this.promotion = false;
      return unit;
    }
    if (cp === SO || cp === SI)
      return unit;
    const width = cp >= 32 && cp < 127 ? 1 : charCellWidth(cp);
    if (this.promotion && cp === 32) {
      this.promotion = false;
      return "";
    }
    if (this.promotion && width > 0)
      this.promotion = false;
    if (cp === VS16 && this.previousWidth === 1) {
      this.previousWidth = 2;
      this.promotion = true;
    } else if (width > 0)
      this.previousWidth = width;
    return unit;
  }
  *text(text) {
    for (const unit of text) {
      const normalized = this.normalize(unit);
      if (unit === `
`) {
        yield* this.admit(this.decode());
      } else {
        this.rawLine += unit;
        this.line += normalized;
      }
      if (this.rawLine.length * 3 > this.maxRowBytes && Buffer.byteLength(this.rawLine) > this.maxRowBytes)
        throw new Error("stream capture row byte budget exceeded");
    }
  }
  *admit(row) {
    const bytes = 256 + row.cells.reduce((n, c) => n + 256 + 8 * (c.grapheme.length + c.fg.length + c.bg.length), 0);
    if (bytes > 1024 * 1024)
      throw new Error("capture row exceeds decode budget");
    if (this.chunk.length && (this.chunk.length >= 256 || this.charged + bytes > 1024 * 1024)) {
      const out = this.chunk;
      this.chunk = [];
      yield out;
      this.charged = 0;
      this.charge(0);
    }
    this.chunk.push(row);
    this.charged += bytes;
    this.charge(this.charged);
  }
  *write(bytes) {
    if (this.done)
      throw new Error("stream capture decoder already ended");
    if (bytes.byteLength > 65536)
      throw new Error("stream capture input chunk exceeds 64 KiB");
    yield* this.text(this.utf8.decode(bytes, { stream: true }));
  }
  *end() {
    if (this.done)
      throw new Error("stream capture decoder already ended");
    this.done = true;
    yield* this.text(this.utf8.decode());
    if (this.escape !== "none")
      throw new Error("incomplete capture escape");
    if (this.rawLine.length)
      yield* this.admit(this.decode());
    if (this.chunk.length) {
      const out = this.chunk;
      this.chunk = [];
      yield out;
      this.charged = 0;
      this.charge(0);
    }
  }
}
var V2_AUDIT_CAPTURE_FLAGS = Object.freeze(["capture-pane", "-p", "-e", "-N"]);

// src/display-engine.ts
import {
  NEWARCH_FLAGON_CAPABILITIES,
  NEWARCH_REPAIR_CAPABILITIES,
  NEWARCH_V2_SCHEMA
} from "../core/index.js";
var ok = (value) => ({ status: "ok", value });
var staleRoute = () => ({ status: "stale", reason: "route" });
var cancelled = () => ({ status: "cancelled", reason: "cancelled" });
var deadline = () => ({ status: "error", code: "deadline", message: "display page deadline exceeded" });
function samePane2(a, b) {
  return !!a && a.serverIdentity === b.serverIdentity && a.paneId === b.paneId && a.birthGeneration === b.birthGeneration;
}
function sameIdentity(a, b) {
  return samePane2(a.pane, b.pane) && a.sourceEpoch === b.sourceEpoch && a.geometryGeneration === b.geometryGeneration;
}
function sameRoute(a, b) {
  return a.viewerId === b.viewerId && a.routeGeneration === b.routeGeneration && sameIdentity(a.identity, b.identity);
}
function validCounter(value) {
  return Number.isSafeInteger(value) && value >= 0;
}
function cloneIdentity(identity) {
  return {
    pane: {
      serverIdentity: identity.pane.serverIdentity,
      paneId: identity.pane.paneId,
      birthGeneration: identity.pane.birthGeneration
    },
    sourceEpoch: identity.sourceEpoch,
    geometryGeneration: identity.geometryGeneration
  };
}
function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value))
    return value;
  for (const child of Object.values(value))
    deepFreeze(child);
  return Object.freeze(value);
}
function immutableFrame(frame) {
  return deepFreeze({
    identity: cloneIdentity(frame.identity),
    screenRevision: frame.screenRevision,
    buffer: frame.buffer,
    geometry: { ...frame.geometry },
    changedRows: frame.changedRows.map((changed) => ({
      y: changed.y,
      content: {
        cells: changed.content.cells.map((cell) => ({ text: cell.text, width: cell.width, style: [...cell.style] })),
        softWrap: changed.content.softWrap,
        wrapPad: changed.content.wrapPad,
        uncertainFields: [...changed.content.uncertainFields]
      }
    })),
    cursor: { ...frame.cursor },
    overlap: frame.overlap ? { ...frame.overlap } : null,
    revision: frame.revision,
    durableRevision: frame.durableRevision,
    head: frame.head
  });
}
function immutableView(view) {
  return deepFreeze({
    requestId: view.requestId,
    identity: cloneIdentity(view.identity),
    routeGeneration: view.routeGeneration,
    range: { ...view.range },
    deadlineMonoMs: view.deadlineMonoMs,
    grantRevision: view.grantRevision,
    durableAtGrant: view.durableAtGrant,
    headAtGrant: view.headAtGrant,
    overlayHandle: view.overlayHandle,
    ...view.flagOn ? { flagOn: structuredClone(view.flagOn) } : {}
  });
}
function immutablePage(page) {
  const view = immutableView(page.view);
  return deepFreeze({
    view,
    fragments: page.fragments.map((fragment) => ({
      row: {
        id: { pane: { ...fragment.row.id.pane }, lineId: fragment.row.id.lineId },
        revision: fragment.row.revision,
        source: {
          pane: { ...fragment.row.source.pane },
          sourceEpoch: fragment.row.source.sourceEpoch,
          packetSeq: fragment.row.source.packetSeq,
          scrollOrdinal: fragment.row.source.scrollOrdinal
        },
        geometryGeneration: fragment.row.geometryGeneration,
        geometry: { ...fragment.row.geometry },
        cells: fragment.row.cells.map((cell) => ({ text: cell.text, width: cell.width, style: [...cell.style] })),
        softWrap: fragment.row.softWrap,
        wrapPad: fragment.row.wrapPad,
        uncertainFields: [...fragment.row.uncertainFields]
      },
      startCell: fragment.startCell,
      endCell: fragment.endCell,
      complete: fragment.complete
    })),
    payloadBytes: page.payloadBytes,
    nextBefore: page.nextBefore ? { ...page.nextBefore } : null,
    nextAfter: page.nextAfter ? { ...page.nextAfter } : null,
    hasMoreBefore: page.hasMoreBefore,
    hasMoreAfter: page.hasMoreAfter,
    ...page.flagOn ? { flagOn: structuredClone(page.flagOn) } : {}
  });
}
function encodedBytes(value) {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}
var KNOWN_CAPABILITIES = new Set(NEWARCH_FLAGON_CAPABILITIES);
var REPAIR_CAPABILITIES = new Set(NEWARCH_REPAIR_CAPABILITIES);
var INCIDENT_REASONS = new Set([
  "storage-outage",
  "collector-stalled",
  "collector-exit",
  "io"
]);
var GAP_REASONS = new Set([
  "pipe-eof",
  "collector-exit",
  "ambiguous-overlap",
  "unproven-overlap",
  "unknown-vt-state",
  "interrupted-capture",
  "storage-outage",
  "corruption",
  "identity-change",
  "geometry-change",
  "ownership-lost",
  "visible-divergence"
]);
function validText(value) {
  return typeof value === "string" && value.length > 0;
}
function validCapabilities(value) {
  if (value?.extensionVersion !== 1 || !Array.isArray(value.supported) || !Array.isArray(value.required))
    return null;
  const all = [...value.supported, ...value.required];
  if (!all.every((cap) => typeof cap === "string" && KNOWN_CAPABILITIES.has(cap)))
    return null;
  if (!value.supported.includes("history-states-v1") || !value.required.every((cap) => value.supported.includes(cap)))
    return null;
  return value;
}
function validRange(range, pane) {
  return samePane2(range?.pane, pane) && typeof range.segmentId === "string" && validCounter(range.start) && validCounter(range.end) && range.start <= range.end;
}
function validGap(gap, pane) {
  if (gap?.version !== 1 || !validText(gap.episodeId) || !samePane2(gap.pane, pane) || !GAP_REASONS.has(gap.reason))
    return false;
  if (gap.parentEpisodeId !== null && !validText(gap.parentEpisodeId))
    return false;
  if (gap.rightSegmentId !== null && typeof gap.rightSegmentId !== "string")
    return false;
  if (gap.leftRowId !== null && (!samePane2(gap.leftRowId.pane, pane) || typeof gap.leftRowId.segmentId !== "string" || !validCounter(gap.leftRowId.rowOrdinal)))
    return false;
  if (gap.countKind === "unknown") {
    if (gap.missingCount !== null)
      return false;
  } else if (gap.countKind === "exact" || gap.countKind === "estimate") {
    if (!validCounter(gap.missingCount))
      return false;
  } else
    return false;
  return validCounter(gap.withheldRows) && validCounter(gap.lowerBound) && Number.isFinite(gap.openedAt) && (gap.closedAt === null || Number.isFinite(gap.closedAt)) && typeof gap.clockEpoch === "string" && (gap.quality === "degraded" || gap.quality === "resolved");
}
function validHistoryState(state, pane) {
  switch (state?.kind) {
    case "exact":
      return true;
    case "gap":
      return validGap(state.gap, pane);
    case "pending":
      return validText(state.operationId) && validCounter(state.retryAfterMs);
    case "remote-required":
      return validRange(state.range, pane) && validText(state.bundleId);
    case "remote-unavailable":
      return validRange(state.range, pane) && validText(state.bundleId) && validCounter(state.retryAfterMs) && (state.reason === "offline" || state.reason === "missing" || state.reason === "corrupt");
    case "degraded":
      return validText(state.episodeId) && Array.isArray(state.uncertainFields) && state.uncertainFields.every((field) => typeof field === "string");
    case "pressure":
      return (state.level === "archive" || state.level === "critical" || state.level === "emergency") && typeof state.collecting === "boolean" && Number.isFinite(state.sinceMonoMs) && state.sinceMonoMs >= 0;
    default:
      return false;
  }
}
function validRepairCapabilities(value) {
  if (!value || typeof value !== "object")
    return false;
  const repair = value;
  if (repair.revision !== 2 || !Array.isArray(repair.supported) || !Array.isArray(repair.required))
    return false;
  const names = [...repair.supported, ...repair.required];
  if (!names.every((cap) => typeof cap === "string" && REPAIR_CAPABILITIES.has(cap)))
    return false;
  return repair.required.every((cap) => repair.supported.includes(cap));
}
function validIncident(value, collecting, pane) {
  if (!value || typeof value !== "object")
    return false;
  const incident = value;
  if (incident.revision !== 2 || !validText(incident.incidentId) || !samePane2(incident.pane, pane))
    return false;
  if (!("leftRowId" in incident))
    return false;
  if (incident.leftRowId !== null) {
    const left = incident.leftRowId;
    if (!samePane2(left?.pane, pane) || !validText(left?.segmentId) || !validCounter(left?.rowOrdinal))
      return false;
  }
  if (!validCounter(incident.openedAtWallMs) || !validCounter(incident.openedAtMonoMs))
    return false;
  if (!validText(incident.clockEpoch))
    return false;
  if (incident.collecting !== collecting)
    return false;
  if (typeof incident.reason !== "string" || !INCIDENT_REASONS.has(incident.reason))
    return false;
  if (incident.quality !== "degraded" && incident.quality !== "resolved")
    return false;
  if (!("resolvedAtWallMs" in incident))
    return false;
  return incident.resolvedAtWallMs === null || validCounter(incident.resolvedAtWallMs);
}
function validPressureStop(state, pane, repairClaimed) {
  if (state.kind !== "pressure")
    return true;
  const incident = state.repair;
  if (!repairClaimed)
    return incident === undefined;
  return validIncident(incident, state.collecting, pane);
}
function validContinuation(continuation, pane) {
  if (continuation?.kind === "end")
    return true;
  if (continuation?.kind !== "more" && continuation?.kind !== "blocked")
    return false;
  if (continuation.cursor?.version !== 1 || !validText(continuation.cursor.token))
    return false;
  return continuation.kind === "more" || continuation.state?.kind !== "exact" && validHistoryState(continuation.state, pane);
}

class StreamDisplayEngine {
  capture;
  retryUntilDeadline;
  history;
  observer;
  now;
  flagOn;
  attachments = new Map;
  pages = new Map;
  pageBytes = new Map;
  pagePoolBytes = 0;
  wsBytes = new Map;
  wsEpoch = new Map;
  wsPendingBytes = 0;
  constructor(options) {
    this.retryUntilDeadline = options.retryUntilDeadline ?? false;
    this.capture = options.capture;
    this.history = options.history;
    this.observer = options.observer;
    this.now = options.now ?? (() => performance.now());
    this.flagOn = options.flagOn ? deepFreeze({ supported: [...options.flagOn.supported], required: options.flagOn.required }) : undefined;
  }
  async attach(route, onFrame) {
    if (!route.viewerId || !validCounter(route.routeGeneration) || !validCounter(route.identity.sourceEpoch) || !validCounter(route.identity.geometryGeneration) || !validCounter(route.identity.pane.birthGeneration)) {
      return { status: "error", code: "integrity", message: "invalid display route" };
    }
    const previous = this.attachments.get(route.viewerId);
    if (previous) {
      this.removeAttachment(previous, staleRoute());
      this.clearViewerPages(route.viewerId);
      this.clearViewerWs(route.viewerId);
    }
    return await new Promise((resolve3) => {
      const attachment = {
        route: deepFreeze({ ...route, identity: cloneIdentity(route.identity) }),
        onFrame,
        unsubscribe: () => {},
        settleInitial: resolve3
      };
      this.attachments.set(route.viewerId, attachment);
      attachment.unsubscribe = this.capture.subscribe(route.identity.pane, (frame) => {
        if (this.attachments.get(route.viewerId) !== attachment || !sameIdentity(frame.identity, route.identity))
          return;
        const frozen = immutableFrame(frame);
        const settle2 = attachment.settleInitial;
        attachment.settleInitial = null;
        if (settle2)
          settle2(ok(frozen));
        try {
          attachment.onFrame(frozen);
        } catch (error) {
          this.observer?.record({
            kind: "lifecycle",
            identity: route.identity,
            atMonoMs: this.now(),
            reason: "display-listener-error",
            errorStack: error instanceof Error ? error.stack ?? error.message : String(error)
          });
        }
      });
    });
  }
  async page(route, request, cursor, limit, cancel) {
    if (!this.routeIsCurrent(route) || !sameIdentity(route.identity, request.identity) || route.routeGeneration !== request.routeGeneration)
      return staleRoute();
    if (!this.validRequest(request, cursor, limit)) {
      return { status: "error", code: "integrity", message: "invalid display read request" };
    }
    if (cancel.isCancelled())
      return cancelled();
    if (this.now() >= request.deadlineMonoMs)
      return deadline();
    this.recordRequest(request, "pending", null);
    let view = null;
    let releaseReason = "page-complete";
    try {
      const granted = await this.callWithRetry(() => this.history.grantReadView(request), request.deadlineMonoMs, cancel, route);
      if (granted.status !== "ok") {
        releaseReason = this.failureReason(granted);
        this.recordRequest(request, this.metricOutcome(granted), this.now());
        return granted;
      }
      view = granted.value;
      if (!sameIdentity(view.identity, route.identity) || view.routeGeneration !== route.routeGeneration || view.requestId !== request.requestId) {
        releaseReason = "invalid-grant";
        const failure = { status: "error", code: "integrity", message: "history granted a mismatched view" };
        this.recordRequest(request, "error", this.now());
        return failure;
      }
      const opened = await this.callWithRetry(() => this.history.openReadView(view), request.deadlineMonoMs, cancel, route);
      if (opened.status !== "ok") {
        releaseReason = this.failureReason(opened);
        this.recordRequest(request, this.metricOutcome(opened), this.now());
        return opened;
      }
      if (!validReadOpen(opened.value) || !this.sameView(opened.value.view, view)) {
        releaseReason = "invalid-open-fence";
        const failure = { status: "error", code: "integrity", message: "history opened an invalid read fence" };
        this.recordRequest(request, "error", this.now());
        return failure;
      }
      const read = await this.callWithRetry(() => this.history.readPage(opened.value, cursor, limit, this.combinedCancel(cancel, route, request.deadlineMonoMs)), request.deadlineMonoMs, cancel, route);
      if (read.status !== "ok") {
        releaseReason = this.failureReason(read);
        this.recordRequest(request, this.metricOutcome(read), this.now());
        return read;
      }
      if (!this.sameView(read.value.view, view)) {
        releaseReason = "page-view-mismatch";
        const failure = { status: "error", code: "integrity", message: "history returned a page from another view" };
        this.recordRequest(request, "error", this.now());
        return failure;
      }
      if (!this.validPage(read.value, view)) {
        releaseReason = "invalid-page";
        const failure = { status: "error", code: "integrity", message: "history returned an invalid page" };
        this.recordRequest(request, "error", this.now());
        return failure;
      }
      const flagOnFailure = this.flagOnFailure(read.value, view);
      if (flagOnFailure) {
        releaseReason = flagOnFailure.code === "unsupported" ? "flag-on-unsupported" : "invalid-flag-on";
        this.recordRequest(request, "error", this.now());
        return flagOnFailure;
      }
      const frozen = immutablePage(read.value);
      const charge = Math.max(frozen.payloadBytes, encodedBytes(frozen.flagOn ? [frozen.fragments, frozen.flagOn] : frozen.fragments));
      if (charge > STREAM_BUDGET.pageBytesPerViewer) {
        releaseReason = "page-byte-cap";
        const failure = { status: "error", code: "unsupported", message: "history page exceeds the display byte cap" };
        this.recordRequest(request, "error", this.now());
        return failure;
      }
      this.rememberPage(route.viewerId, this.pageKey(opened.value, cursor, limit), frozen, charge);
      this.recordRequest(request, "ok", this.now());
      return ok(frozen);
    } catch {
      releaseReason = "history-exception";
      this.recordRequest(request, "error", this.now());
      return { status: "error", code: "io", message: "display history read failed" };
    } finally {
      if (view)
        await this.history.releaseReadView(view, releaseReason);
    }
  }
  async detach(route, reason) {
    const attachment = this.attachments.get(route.viewerId);
    if (!attachment || !sameRoute(attachment.route, route))
      return;
    this.removeAttachment(attachment, { status: "cancelled", reason });
    this.clearViewerPages(route.viewerId);
    this.clearViewerWs(route.viewerId);
  }
  reserveEncodedBytes(viewerId, bytes) {
    if (!viewerId || !validCounter(bytes) || bytes > STREAM_BUDGET.wsPendingBytes || this.wsPendingBytes + bytes > STREAM_BUDGET.wsPendingBytes)
      return null;
    if (bytes === 0)
      return () => {};
    this.wsPendingBytes += bytes;
    this.wsBytes.set(viewerId, (this.wsBytes.get(viewerId) ?? 0) + bytes);
    const epoch = this.wsEpoch.get(viewerId) ?? {};
    this.wsEpoch.set(viewerId, epoch);
    let released = false;
    return () => {
      if (released)
        return;
      released = true;
      if (this.wsEpoch.get(viewerId) !== epoch)
        return;
      this.wsPendingBytes -= bytes;
      const remaining = (this.wsBytes.get(viewerId) ?? 0) - bytes;
      if (remaining > 0)
        this.wsBytes.set(viewerId, remaining);
      else {
        this.wsBytes.delete(viewerId);
        this.wsEpoch.delete(viewerId);
      }
    };
  }
  stats() {
    return deepFreeze({
      attachedViewers: this.attachments.size,
      pagePoolBytes: this.pagePoolBytes,
      pageBytesByViewer: Object.fromEntries(this.pageBytes),
      wsPendingBytes: this.wsPendingBytes,
      wsPendingBytesByViewer: Object.fromEntries(this.wsBytes)
    });
  }
  routeIsCurrent(route) {
    const current = this.attachments.get(route.viewerId);
    return current !== undefined && sameRoute(current.route, route);
  }
  removeAttachment(attachment, unsettled) {
    if (this.attachments.get(attachment.route.viewerId) === attachment)
      this.attachments.delete(attachment.route.viewerId);
    attachment.unsubscribe();
    const settle2 = attachment.settleInitial;
    attachment.settleInitial = null;
    if (settle2)
      settle2(unsettled);
  }
  validRequest(request, cursor, limit) {
    const numbers = [request.routeGeneration, request.range.start, request.range.end, limit];
    if (!Number.isFinite(request.deadlineMonoMs) || request.deadlineMonoMs < 0 || !numbers.every(validCounter) || request.range.start > request.range.end || limit < 1 || limit > STREAM_BUDGET.maxPageRows)
      return false;
    return cursor === null || cursor.requestId === request.requestId && validCounter(cursor.lineId) && validCounter(cursor.cellOffset) && (cursor.direction === "before" || cursor.direction === "after");
  }
  combinedCancel(cancel, route, deadlineMonoMs) {
    return { isCancelled: () => cancel.isCancelled() || !this.routeIsCurrent(route) || this.now() >= deadlineMonoMs };
  }
  async callWithRetry(call, deadlineMonoMs, cancel, route) {
    for (let attempt = 0;this.retryUntilDeadline || attempt <= STREAM_BUDGET.maxReadRetries; attempt++) {
      if (!this.routeIsCurrent(route))
        return staleRoute();
      if (cancel.isCancelled())
        return cancelled();
      if (this.now() >= deadlineMonoMs)
        return deadline();
      const waited = await this.waitFor(call(), deadlineMonoMs, cancel, route);
      if (waited.kind === "failure")
        return waited.failure;
      if (waited.kind === "throw")
        return { status: "error", code: "io", message: "display history read failed" };
      const result = waited.value;
      if (result.status !== "busy" || !this.retryUntilDeadline && attempt === STREAM_BUDGET.maxReadRetries)
        return result;
      const pause = Math.min(Math.max(1, result.retryAfterMs), deadlineMonoMs - this.now());
      if (pause > 0) {
        const delayed = await this.waitFor(new Promise((resolve3) => setTimeout(resolve3, pause)), deadlineMonoMs, cancel, route);
        if (delayed.kind === "failure")
          return delayed.failure;
        if (delayed.kind === "throw")
          return { status: "error", code: "io", message: "display retry wait failed" };
      }
    }
    return { status: "busy", retryAfterMs: 0, reason: "queue" };
  }
  async waitFor(promise, deadlineMonoMs, cancel, route) {
    return await new Promise((resolve3) => {
      let finished = false;
      const finish = (result) => {
        if (finished)
          return;
        finished = true;
        clearTimeout(deadlineTimer);
        clearInterval(cancelTimer);
        resolve3(result);
      };
      const remaining = Math.max(0, deadlineMonoMs - this.now());
      const deadlineTimer = setTimeout(() => finish({ kind: "failure", failure: deadline() }), remaining);
      const cancelTimer = setInterval(() => {
        if (!this.routeIsCurrent(route))
          finish({ kind: "failure", failure: staleRoute() });
        else if (cancel.isCancelled())
          finish({ kind: "failure", failure: cancelled() });
      }, Math.min(10, Math.max(1, remaining)));
      promise.then((value) => finish({ kind: "value", value }), () => finish({ kind: "throw" }));
    });
  }
  sameView(a, b) {
    return a.requestId === b.requestId && a.routeGeneration === b.routeGeneration && sameIdentity(a.identity, b.identity) && a.grantRevision === b.grantRevision && a.durableAtGrant === b.durableAtGrant && a.headAtGrant === b.headAtGrant && a.range.start === b.range.start && a.range.end === b.range.end && a.overlayHandle === b.overlayHandle;
  }
  validPage(page, view) {
    if (!validCounter(page.payloadBytes) || page.fragments.length > STREAM_BUDGET.decodeRows)
      return false;
    for (const fragment of page.fragments) {
      const row = fragment.row;
      if (!samePane2(row.id.pane, view.identity.pane) || !samePane2(row.source.pane, view.identity.pane) || !validCounter(row.id.lineId) || row.id.lineId < view.range.start || row.id.lineId >= view.range.end || !validCounter(row.revision) || row.revision > view.grantRevision || !validCounter(fragment.startCell) || !validCounter(fragment.endCell) || fragment.startCell > fragment.endCell || fragment.endCell - fragment.startCell !== row.cells.length)
        return false;
    }
    for (const cursor of [page.nextBefore, page.nextAfter]) {
      if (cursor && (cursor.requestId !== view.requestId || !validCounter(cursor.lineId) || !validCounter(cursor.cellOffset)))
        return false;
    }
    return true;
  }
  flagOnFailure(page, view) {
    const extension = page.flagOn;
    const integrity = (message) => ({ status: "error", code: "integrity", message });
    if (!extension) {
      return this.flagOn?.required ? integrity("flag-on page arrived without history states") : null;
    }
    if (!this.flagOn)
      return { status: "error", code: "unsupported", message: "display was not negotiated for flag-on history states" };
    const capabilities = validCapabilities(extension.capabilities);
    if (capabilities === null)
      return integrity("flag-on page has invalid capabilities");
    if (!capabilities.required.every((cap) => this.flagOn.supported.includes(cap))) {
      return { status: "error", code: "unsupported", message: "flag-on page requires an unsupported capability" };
    }
    const repair = extension.repair;
    if (repair !== undefined && !validRepairCapabilities(repair))
      return integrity("flag-on repair envelope is unreadable");
    const repairClaimed = repair !== undefined;
    const pane = view.identity.pane;
    const pressureOk = (state) => validPressureStop(state, pane, repairClaimed);
    if (extension.version !== 1 || !Array.isArray(extension.states) || !extension.states.every((state) => validHistoryState(state, pane) && pressureOk(state))) {
      return integrity("flag-on page has invalid history states");
    }
    if (!validContinuation(extension.before, pane) || !validContinuation(extension.after, pane)) {
      return integrity("flag-on page has an invalid continuation");
    }
    if (extension.before.kind === "blocked" && !pressureOk(extension.before.state)) {
      return integrity("flag-on page has invalid history states");
    }
    if (extension.after.kind === "blocked" && !pressureOk(extension.after.state)) {
      return integrity("flag-on page has invalid history states");
    }
    if (extension.before.kind === "end" === page.hasMoreBefore || extension.after.kind === "end" === page.hasMoreAfter) {
      return integrity("flag-on continuation disagrees with hasMore");
    }
    return null;
  }
  pageKey(ack, cursor, limit) {
    return JSON.stringify([ack.view.requestId, ack.view.grantRevision, ack.diskSnapshotRevision, cursor, limit]);
  }
  rememberPage(viewerId, key, page, bytes) {
    const entries = this.pages.get(viewerId) ?? [];
    const old = entries.find((entry) => entry.key === key);
    if (old) {
      old.usedAt = this.now();
      return;
    }
    entries.push({ key, page, bytes, usedAt: this.now() });
    this.pages.set(viewerId, entries);
    this.pageBytes.set(viewerId, (this.pageBytes.get(viewerId) ?? 0) + bytes);
    this.pagePoolBytes += bytes;
    while ((this.pageBytes.get(viewerId) ?? 0) > STREAM_BUDGET.pageBytesPerViewer)
      this.evictOldest(viewerId);
    while (this.pagePoolBytes > STREAM_BUDGET.pagePoolBytes) {
      let oldestViewer = null;
      let oldestAt = Infinity;
      for (const [candidate, candidateEntries] of this.pages) {
        const at = candidateEntries[0]?.usedAt ?? Infinity;
        if (at < oldestAt) {
          oldestAt = at;
          oldestViewer = candidate;
        }
      }
      if (oldestViewer === null)
        break;
      this.evictOldest(oldestViewer);
    }
    this.recordMemory();
  }
  evictOldest(viewerId) {
    const entries = this.pages.get(viewerId);
    if (!entries?.length)
      return;
    entries.sort((a, b) => a.usedAt - b.usedAt);
    const entry = entries.shift();
    this.pagePoolBytes -= entry.bytes;
    const remaining = (this.pageBytes.get(viewerId) ?? 0) - entry.bytes;
    if (remaining > 0)
      this.pageBytes.set(viewerId, remaining);
    else {
      this.pageBytes.delete(viewerId);
      this.pages.delete(viewerId);
    }
  }
  clearViewerPages(viewerId) {
    for (const entry of this.pages.get(viewerId) ?? [])
      this.pagePoolBytes -= entry.bytes;
    this.pages.delete(viewerId);
    this.pageBytes.delete(viewerId);
    this.recordMemory();
  }
  clearViewerWs(viewerId) {
    const bytes = this.wsBytes.get(viewerId) ?? 0;
    this.wsPendingBytes -= bytes;
    this.wsBytes.delete(viewerId);
    this.wsEpoch.delete(viewerId);
  }
  recordMemory() {
    this.observer?.record({
      kind: "memory",
      atMonoMs: this.now(),
      owner: "display-pages",
      pane: null,
      heldBytes: this.pagePoolBytes,
      capacityBytes: STREAM_BUDGET.pagePoolBytes
    });
  }
  recordRequest(request, outcome, completedAtMonoMs) {
    this.observer?.record({
      kind: "request",
      requestId: request.requestId,
      pane: request.identity.pane,
      operation: "page",
      eligibleAtMonoMs: this.now(),
      deadlineMonoMs: request.deadlineMonoMs,
      completedAtMonoMs,
      outcome
    });
  }
  metricOutcome(failure) {
    if (failure.status === "busy")
      return "busy";
    if (failure.status === "cancelled")
      return "cancelled";
    return "error";
  }
  failureReason(failure) {
    if (failure.status === "error" && failure.code === "deadline")
      return "deadline";
    return failure.status;
  }
}
var V2_OWNER_RETRY_MS = 1000;
var V2_SPAN_PAGE_CAP = 64;
function v2PaneEqual(a, b) {
  return a.serverIdentity === b.serverIdentity && a.paneId === b.paneId && a.birthGeneration === b.birthGeneration;
}
function v2Integrity(message) {
  return { status: "error", code: "integrity", message };
}
function selectNewarchV2Panes(panes, next) {
  if (panes.length === 0 && next === null)
    return { kind: "missing" };
  if (panes.length === 1 && next === null)
    return { kind: "selected", pane: panes[0] };
  return { kind: "ambiguous", panes: [...panes], next };
}

class V2PageOrder {
  at = null;
  birth = false;
  left = new Set;
  accepts(entry) {
    if (entry.kind === "incident") {
      const frontier = entry.incident.frontier;
      if (!frontier) {
        this.birth = true;
        return this.at === null;
      }
      if (!this.at) {
        if (this.birth)
          return false;
        this.at = { segmentId: frontier.segmentId, rowOrdinal: frontier.rowOrdinal };
        return true;
      }
      return frontier.segmentId === this.at.segmentId && frontier.rowOrdinal === this.at.rowOrdinal;
    }
    const { segmentId, rowOrdinal } = entry.row.id;
    if (this.at?.segmentId === segmentId) {
      if (rowOrdinal <= this.at.rowOrdinal)
        return false;
    } else {
      if (this.left.has(segmentId))
        return false;
      if (this.at)
        this.left.add(this.at.segmentId);
    }
    this.at = { segmentId, rowOrdinal };
    return true;
  }
}
function v2Blocking(state) {
  return state.kind === "storage-unavailable" || state.kind === "remote-unavailable";
}
function v2RowKey(row) {
  return `${row.id.pane.serverIdentity}\x00${row.id.pane.paneId}\x00${row.id.pane.birthGeneration}\x00${row.id.segmentId}\x00${row.id.rowOrdinal}`;
}

class NewarchV2Display {
  reader;
  pins;
  pinSerial = 0;
  constructor(reader, pins = null) {
    this.reader = reader;
    this.pins = pins;
  }
  select(session) {
    const owner = this.reader.sessionOwner(session);
    if (owner.status !== "ok")
      return ok({ kind: "owner-unavailable", retryAfterMs: V2_OWNER_RETRY_MS });
    if (owner.value === null)
      return ok({ kind: "missing" });
    const listed = this.reader.panes(session, null);
    if (listed.status !== "ok")
      return ok({ kind: "owner-unavailable", retryAfterMs: V2_OWNER_RETRY_MS });
    return ok(selectNewarchV2Panes(listed.value.panes, listed.value.next));
  }
  geometry(pane, _intent) {
    const geometry = pane.geometry;
    return {
      reply: { schema: NEWARCH_V2_SCHEMA, pane: pane.pane, status: "fixed", geometry },
      resize: null
    };
  }
  async page(request, pinSegmentId = null) {
    try {
      validateV2ReadRequest(request);
    } catch (error) {
      return v2Integrity(error instanceof Error ? error.message : "invalid v2 read");
    }
    const pinId = pinSegmentId && this.pins ? `display-pin-${++this.pinSerial}` : null;
    if (pinId && pinSegmentId && this.pins) {
      const pinned = await this.pins.submit({ kind: "pin", pinId, segmentId: pinSegmentId });
      if (pinned.status !== "ok")
        return pinned;
    }
    try {
      const read = await this.reader.page(request);
      if (read.status !== "ok")
        return read;
      const failure = this.pageFailure(request, read.value);
      if (failure)
        return failure;
      return ok(deepFreeze(structuredClone(read.value)));
    } catch {
      return { status: "error", code: "io", message: "v2 display read failed" };
    } finally {
      if (pinId && this.pins)
        await this.pins.submit({ kind: "release-pin", pinId });
    }
  }
  async readSpan(request, maxPages, pinSegmentId = null) {
    if (!Number.isSafeInteger(maxPages) || maxPages < 1)
      return v2Integrity("v2 span page cap");
    const cap = Math.min(maxPages, V2_SPAN_PAGE_CAP);
    const seen = new Set;
    const entries = [];
    let cursor = request.cursor;
    let blocked = null;
    let ended = false;
    for (let index = 0;index < cap; index++) {
      const read = await this.page({ ...request, cursor }, pinSegmentId);
      if (read.status !== "ok")
        return read;
      const page = read.value;
      for (const entry of page.entries) {
        if (entry.kind !== "row") {
          entries.push(entry);
          continue;
        }
        const key = v2RowKey(entry.row);
        if (seen.has(key))
          return v2Integrity("duplicate v2 row in span");
        seen.add(key);
        entries.push(entry);
      }
      const continuation = request.direction === "before" ? page.before : page.after;
      if (continuation.kind === "blocked") {
        blocked = continuation.state;
        ended = false;
        break;
      }
      if (continuation.kind === "end") {
        ended = blocked === null;
        break;
      }
      cursor = continuation.cursor;
    }
    return ok(deepFreeze({ entries, blocked, ended }));
  }
  pageFailure(request, page) {
    if (page.schema !== NEWARCH_V2_VERSION || !v2PaneEqual(page.pane, request.pane)) {
      return v2Integrity("v2 page pane");
    }
    if (!validCounter(page.revision) || !validCounter(page.payloadBytes) || page.payloadBytes > request.maxBytes || page.entries.length > request.maxEntries) {
      return v2Integrity("v2 page bound");
    }
    const order = new V2PageOrder;
    const seen = new Set;
    const incidents = new Set;
    for (const entry of page.entries) {
      if (entry.kind === "row") {
        if (!entry.row.finalized)
          return v2Integrity("v2 candidate row is not durable history");
        if (!v2PaneEqual(entry.row.id.pane, request.pane))
          return v2Integrity("v2 row pane");
        const key = v2RowKey(entry.row);
        if (seen.has(key))
          return v2Integrity("duplicate v2 row");
        seen.add(key);
      } else {
        try {
          validateV2Incident(entry.incident);
        } catch (error) {
          return v2Integrity(error instanceof Error ? error.message : "invalid v2 incident");
        }
        if (!v2PaneEqual(entry.incident.pane, request.pane))
          return v2Integrity("v2 incident pane");
        if (incidents.has(entry.incident.incidentId))
          return v2Integrity("duplicate v2 incident");
        incidents.add(entry.incident.incidentId);
      }
      if (!order.accepts(entry))
        return v2Integrity("v2 page order");
    }
    for (const continuation of [page.before, page.after]) {
      if (continuation.kind === "end")
        continue;
      if (!v2PaneEqual(continuation.cursor.pane, request.pane) || continuation.cursor.schema !== NEWARCH_V2_SCHEMA) {
        return v2Integrity("v2 continuation cursor");
      }
      if (continuation.kind === "blocked" && !v2Blocking(continuation.state))
        return v2Integrity("v2 blocked state");
    }
    const blocking = page.states.some(v2Blocking);
    const blockedContinuation = page.before.kind === "blocked" || page.after.kind === "blocked";
    if (blocking && !blockedContinuation)
      return v2Integrity("v2 blocking state was reported as the end of history");
    return null;
  }
}

// src/pipe-history-runtime.ts
init_schema();

// src/capture-engine.ts
import { charCellWidth as charCellWidth2 } from "../core/index.js";
var ok2 = (value) => ({ status: "ok", value });
var busy = () => ({ status: "busy", reason: "pressure", retryAfterMs: 10 });
var error = (code, message) => ({ status: "error", code, message });
var counter = (n) => Number.isSafeInteger(n) && n >= 0;
var paneKey = (p) => JSON.stringify([p.serverIdentity, p.paneId, p.birthGeneration]);
var samePane3 = (a, b) => paneKey(a) === paneKey(b);
var sameIdentity2 = (a, b) => samePane3(a.pane, b.pane) && a.sourceEpoch === b.sourceEpoch && a.geometryGeneration === b.geometryGeneration;
var size = (value) => Buffer.byteLength(JSON.stringify(value));
function immutable(value) {
  const copy = structuredClone(value);
  const seen = new WeakSet;
  function freeze(v) {
    if (v && typeof v === "object" && !seen.has(v)) {
      seen.add(v);
      for (const child of Object.values(v))
        freeze(child);
      Object.freeze(v);
    }
  }
  freeze(copy);
  return copy;
}
class CaptureAdmission {
  cap;
  held = 0;
  constructor(cap = STREAM_BUDGET.pendingBytes) {
    this.cap = cap;
    if (!counter(cap))
      throw new Error("invalid cap");
  }
  get heldBytes() {
    return this.held;
  }
  reserve(bytes) {
    if (!counter(bytes))
      throw new Error("invalid reservation");
    if (bytes > this.cap - this.held)
      return null;
    this.held += bytes;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        this.held -= bytes;
      }
    };
  }
}

class CaptureTaskScope {
  signal;
  cancel;
  pending = new Set;
  release = null;
  retired = false;
  closed = false;
  aborted = new Error("capture operation cancelled");
  onAbort = () => {
    if (!this.cancel || this.pending.size === 0)
      return;
    try {
      this.cancel().then(() => {
        this.retired = true;
        this.flush();
      }, () => {});
    } catch {}
  };
  constructor(signal, cancel) {
    this.signal = signal;
    this.cancel = cancel;
    signal.addEventListener("abort", this.onAbort, { once: true });
    if (signal.aborted)
      this.onAbort();
  }
  async wait(operation) {
    if (this.closed)
      throw new Error("closed capture scope");
    this.pending.add(operation);
    const settled = () => {
      this.pending.delete(operation);
      this.flush();
    };
    operation.then(settled, settled);
    if (this.signal.aborted)
      throw this.aborted;
    return new Promise((resolve3, reject) => {
      const abort = () => {
        reject(this.aborted);
      };
      this.signal.addEventListener("abort", abort, { once: true });
      operation.then((value) => {
        this.signal.removeEventListener("abort", abort);
        if (this.signal.aborted)
          reject(this.aborted);
        else
          resolve3(value);
      }, (cause) => {
        this.signal.removeEventListener("abort", abort);
        reject(cause);
      });
    });
  }
  finish(release) {
    this.closed = true;
    this.release = release;
    this.flush();
  }
  flush() {
    if (this.closed && this.release && (this.retired || this.pending.size === 0)) {
      const release = this.release;
      this.release = null;
      this.signal.removeEventListener("abort", this.onAbort);
      release();
    }
  }
}

class CaptureTail {
  entries = [];
  bytes = 0;
  durableRevision = 0;
  get rows() {
    return Object.freeze([...this.entries]);
  }
  get heldBytes() {
    return this.bytes;
  }
  durable(revision) {
    if (!counter(revision) || revision < this.durableRevision)
      throw new Error("invalid durable watermark");
    this.durableRevision = revision;
  }
  plan(rows) {
    let bytes = this.bytes;
    const result = [...this.entries];
    for (const row of rows) {
      const n = size(row) * 2 + 256 + row.cells.length * 64;
      if (n > STREAM_BUDGET.tailBytesPerPane) {
        if (row.revision > this.durableRevision || result.some((r) => r.revision > this.durableRevision))
          return null;
        result.length = 0;
        bytes = 0;
        continue;
      }
      while (result.length && (result.length >= STREAM_BUDGET.tailRowsPerPane || bytes + n > STREAM_BUDGET.tailBytesPerPane)) {
        const first = result[0];
        if (first.revision > this.durableRevision)
          return null;
        bytes -= size(first) * 2 + 256 + first.cells.length * 64;
        result.shift();
      }
      result.push(row);
      bytes += n;
    }
    return { rows: result, bytes };
  }
  reconcile(rows) {
    const byId = new Map(this.entries.map((row) => [row.id.lineId, row]));
    for (const row of rows)
      byId.set(row.id.lineId, row);
    const replacement = new CaptureTail;
    replacement.durable(this.durableRevision);
    if (!replacement.append([...byId.values()].sort((a, b) => a.id.lineId - b.id.lineId)))
      return false;
    this.entries = replacement.entries;
    this.bytes = replacement.bytes;
    return true;
  }
  canAppend(rows) {
    return this.plan(rows) !== null;
  }
  append(rows) {
    const plan = this.plan(rows);
    if (!plan)
      return false;
    this.entries = immutable(plan.rows);
    this.bytes = plan.bytes;
    return true;
  }
}
function exactVisibleVerdict(a, b, before, after) {
  if (!counter(before) || before !== after || !sameIdentity2(a.identity, b.identity) || a.geometry.columns !== b.geometry.columns || a.geometry.rows !== b.geometry.rows || [...a.changedRows, ...b.changedRows].some((r) => r.content.uncertainFields.length))
    return "unfenced";
  const left = [...a.changedRows].sort((x, y) => x.y - y.y);
  const right = [...b.changedRows].sort((x, y) => x.y - y.y);
  const equal = a.buffer === b.buffer && a.cursor.x === b.cursor.x && a.cursor.y === b.cursor.y && a.cursor.visible === b.cursor.visible && left.length === right.length && left.every((row, i) => {
    const other = right[i];
    return row.y === other.y && row.content.softWrap === other.content.softWrap && row.content.wrapPad === other.content.wrapPad && row.content.cells.length === other.content.cells.length && row.content.cells.every((cell, x) => {
      const c = other.content.cells[x];
      return cell.text === c.text && cell.width === c.width && cell.style.length === c.style.length && cell.style.every((value, j) => value === c.style[j]);
    });
  });
  return equal ? "equal" : "different";
}
class StreamCaptureEngine {
  ports;
  identity;
  frame;
  tail = new CaptureTail;
  listeners = new Set;
  locked = false;
  visibleLocked = false;
  pending = null;
  lastInput = null;
  lastCheckpoint = null;
  durable = null;
  episode = null;
  checkpointAt;
  checkpointHead;
  serial = 0;
  restoring = false;
  constructor(ports) {
    this.ports = ports;
    if (!sameIdentity2(ports.identity, ports.initial.identity) || !counter(ports.initial.head) || !counter(ports.initial.revision) || !counter(ports.initial.durableRevision) || ports.initial.durableRevision > ports.initial.revision)
      throw new Error("invalid initial capture fence");
    this.identity = immutable(ports.identity);
    this.frame = immutable(ports.initial);
    this.checkpointAt = ports.now();
    this.checkpointHead = this.frame.head;
  }
  activeGap() {
    return this.episode;
  }
  digest(kind, value) {
    return (this.ports.digest ?? streamDigest)(kind, value);
  }
  matches(pane) {
    return samePane3(this.identity.pane, pane);
  }
  record(metric) {
    try {
      this.ports.observer?.record(metric);
    } catch {}
  }
  publish(frame) {
    this.frame = immutable(frame);
    for (const listener of this.listeners) {
      try {
        listener(this.frame);
      } catch {}
    }
  }
  fault(reason) {
    if (this.episode)
      return this.episode;
    this.episode = immutable({
      episodeId: `${paneKey(this.identity.pane)}:${++this.serial}`,
      pane: this.identity.pane,
      epochBefore: this.identity.sourceEpoch,
      epochAfter: null,
      lastDurableInput: this.lastInput?.through ?? null,
      lastAdmittedRow: this.frame.head ? this.frame.head - 1 : null,
      firstObservedAtMonoMs: this.ports.now(),
      reason,
      status: reason === "late-gap" ? "unresolved" : "suspected",
      missingCount: null
    });
    const fenced = this.ports.history.beginGap(this.episode);
    if (fenced.status !== "ok")
      this.episode = immutable({
        ...this.episode,
        status: "unresolved",
        ...fenced.status === "stale" && fenced.reason === "late-gap" ? { reason: "late-gap" } : {}
      });
    this.record({ kind: "gap", episode: this.episode });
    return this.episode;
  }
  get checkpointDue() {
    if (this.frame.head - this.checkpointHead >= STREAM_BUDGET.checkpointRows)
      return "row-limit";
    return this.ports.now() - this.checkpointAt >= STREAM_BUDGET.checkpointMs ? "periodic" : null;
  }
  validate(event) {
    if (!samePane3(event.identity.pane, this.identity.pane))
      return { status: "stale", reason: "identity" };
    if (event.identity.sourceEpoch !== this.identity.sourceEpoch || event.position.sourceEpoch !== event.identity.sourceEpoch)
      return { status: "stale", reason: "epoch" };
    if (!counter(event.position.packetSeq) || !event.position.packetSeq || !counter(event.identity.geometryGeneration) || !Number.isFinite(event.receivedAtMonoMs) || event.receivedAtMonoMs < 0)
      return error("integrity", "invalid input counters");
    const resize = event.payload.kind === "resize";
    const retry = event.position.packetSeq <= (this.lastInput?.through.packetSeq ?? 0);
    if (!retry && event.identity.geometryGeneration !== this.identity.geometryGeneration + (resize ? 1 : 0))
      return { status: "stale", reason: "geometry" };
    if (resize && (!counter(event.payload.geometry.columns) || !counter(event.payload.geometry.rows) || event.payload.geometry.columns < 1 || event.payload.geometry.rows < 1 || event.payload.geometry.columns > STREAM_BUDGET.maxColumns || event.payload.geometry.rows > STREAM_BUDGET.maxRows))
      return error("unsupported", "geometry budget");
    if (event.payload.kind === "bytes" && !event.payload.bytes.every((n) => Number.isInteger(n) && n >= 0 && n <= 255))
      return error("integrity", "invalid byte");
    const { digest: _, ...payload } = event;
    if (event.digest !== this.digest("input", payload))
      return error("integrity", "input checksum");
    return null;
  }
  async acceptSourceBytes(bytes, packetSeq, receivedAtMonoMs) {
    if (!bytes.length)
      return error("integrity", "empty source read");
    if (packetSeq !== (this.lastInput?.through.packetSeq ?? 0) + 1)
      return error("integrity", "source cursor must follow durable packet fence");
    if (this.locked || this.restoring)
      return busy();
    if (this.pending) {
      const retry = await this.acceptInput(this.pending.event);
      if (retry.status !== "ok")
        return retry;
      if (this.pending)
        return busy();
    }
    for (let count = Math.min(512, bytes.length);count >= 1; count = Math.floor(count / 2)) {
      const body = {
        identity: this.identity,
        position: { sourceEpoch: this.identity.sourceEpoch, packetSeq },
        receivedAtMonoMs,
        payload: { kind: "bytes", bytes: Array.from(bytes.subarray(0, count)) }
      };
      const result = await this.acceptInput({ ...body, digest: this.digest("input", body) });
      if (result.status === "ok")
        return ok2({ consumed: count, receipt: result.value });
      const expansion = result.status === "error" && result.code === "unsupported" && result.message === "VT expansion budget";
      if (expansion && count === 1)
        return result;
      if (!expansion && result.status !== "busy" || this.pending)
        return result;
    }
    return busy();
  }
  async acceptInput(input) {
    if (this.locked || this.restoring)
      return busy();
    return this.acceptOrdered(input);
  }
  async acceptOrdered(input) {
    if (this.locked)
      return busy();
    if (input.payload.kind === "bytes" && input.payload.bytes.length > STREAM_BUDGET.rawBytesPerPane / 16)
      return busy();
    if (size(input) * 2 + (input.payload.kind === "bytes" ? input.payload.bytes.length * 16 : 0) > STREAM_BUDGET.rawBytesPerPane)
      return busy();
    this.locked = true;
    let release = null;
    let preflight = null;
    let staging = null;
    try {
      const invalid = this.validate(input);
      if (invalid)
        return invalid;
      if (this.episode)
        return this.episode.reason === "late-gap" ? { status: "stale", reason: "late-gap" } : error("unresolved-gap", this.episode.episodeId);
      const event = immutable(input);
      if (this.pending) {
        if (event.position.packetSeq !== this.pending.event.position.packetSeq)
          return busy();
        if (event.digest !== this.pending.event.digest)
          return error("integrity", "pending event collision");
        const receipt2 = this.pending.receipt;
        await this.flushPending();
        return ok2(receipt2);
      }
      const after = this.lastInput?.through.packetSeq ?? 0;
      if (event.position.packetSeq <= after)
        return await this.ports.history.journalInput(event);
      if (event.position.packetSeq !== after + 1) {
        this.fault("sequence");
        return error("unresolved-gap", "input sequence gap");
      }
      release = this.ports.admission.reserve(STREAM_BUDGET.rawBytesPerPane);
      if (!release)
        return busy();
      staging = this.ports.scratch.reserve(STREAM_BUDGET.vtBytesPerPane);
      if (!staging)
        return busy();
      const prepared2 = this.ports.vt.prepareStream ? null : await this.ports.vt.prepare(event);
      if (prepared2 && prepared2.status !== "ok")
        return prepared2;
      preflight = prepared2?.value ?? null;
      if (preflight && size(preflight.scrolls) * 4 > STREAM_BUDGET.vtBytesPerPane)
        return error("unsupported", "VT expansion budget");
      if (preflight && (!sameIdentity2(preflight.frame.identity, event.identity) || preflight.scrolls.some((row) => row.uncertainFields.length)))
        return error("integrity", "VT preflight");
      const receipt = await this.ports.history.journalInput(event);
      if (receipt.status !== "ok")
        return receipt;
      if (!samePane3(receipt.value.pane, event.identity.pane) || receipt.value.through.packetSeq !== event.position.packetSeq || receipt.value.through.sourceEpoch !== event.position.sourceEpoch || receipt.value.digest !== event.digest) {
        this.fault("checksum");
        return error("integrity", "journal receipt fence");
      }
      this.lastInput = immutable(receipt.value);
      this.pending = { event, receipt: this.lastInput, release };
      release = null;
      const candidate = preflight;
      preflight = null;
      const flushed = await this.flushPending(candidate);
      if (flushed.status === "error" || flushed.status === "stale")
        this.fault("worker-exit");
      return ok2(this.lastInput);
    } catch (cause) {
      this.fault("reader-error");
      return error("io", String(cause));
    } finally {
      preflight?.discard();
      staging?.();
      release?.();
      this.locked = false;
    }
  }
  async flushPending(candidate = null) {
    const p = this.pending;
    if (!p) {
      candidate?.discard();
      return ok2(undefined);
    }
    if (this.ports.vt.prepareStream)
      return this.flushStreaming(p);
    if (this.episode) {
      candidate?.discard();
      return error("unresolved-gap", this.episode.episodeId);
    }
    const release = this.ports.scratch.reserve(STREAM_BUDGET.vtBytesPerPane);
    if (!release) {
      candidate?.discard();
      return busy();
    }
    let tx = candidate;
    try {
      const prepared2 = candidate ? ok2(candidate) : await this.ports.vt.prepare(p.event);
      if (prepared2.status !== "ok")
        return prepared2;
      tx = prepared2.value;
      const prepareGap = this.activeGap();
      if (prepareGap)
        return error("unresolved-gap", prepareGap.episodeId);
      if (!sameIdentity2(tx.frame.identity, p.event.identity) || tx.scrolls.some((row) => row.uncertainFields.length))
        return error("integrity", "VT identity or uncertain scroll");
      if (!counter(this.frame.head + tx.scrolls.length) || !counter(this.frame.revision + 1))
        return error("integrity", "counter exhausted");
      const rows = [];
      let offset = 0, revision = this.frame.revision, head = this.frame.head;
      let request;
      let receipt;
      do {
        const chunk = [];
        while (offset + chunk.length < tx.scrolls.length && chunk.length < STREAM_BUDGET.decodeRows) {
          const ordinal = offset + chunk.length;
          const row = {
            ...tx.scrolls[ordinal],
            id: { pane: this.identity.pane, lineId: head + chunk.length },
            revision: revision + 1,
            source: { pane: this.identity.pane, ...p.event.position, scrollOrdinal: ordinal },
            geometryGeneration: p.event.identity.geometryGeneration,
            geometry: tx.frame.geometry
          };
          if (size([...chunk, row]) > STREAM_BUDGET.decodeBytes)
            break;
          chunk.push(row);
        }
        if (!chunk.length && offset < tx.scrolls.length)
          return error("unsupported", "single row decode budget");
        const body = {
          identity: p.event.identity,
          eventId: { pane: this.identity.pane, ...p.event.position, scrollOrdinal: offset },
          expectedRevision: revision,
          rows: chunk,
          frameDelta: tx.frame,
          receivedAtMonoMs: p.event.receivedAtMonoMs
        };
        request = immutable({ ...body, digest: this.digest("append", body) });
        const appended = await this.ports.history.appendFinalized(request);
        if (appended.status !== "ok")
          return appended;
        receipt = appended;
        if (receipt.value.head !== head + chunk.length || receipt.value.revision !== revision + 1 || receipt.value.digest !== request.digest || streamCanonical(receipt.value.eventId) !== streamCanonical(request.eventId)) {
          this.fault("checksum");
          return error("integrity", "append receipt fence");
        }
        rows.push(...chunk);
        offset += chunk.length;
        head = receipt.value.head;
        revision = receipt.value.revision;
      } while (offset < tx.scrolls.length);
      const needsDurable = !this.tail.canAppend(rows);
      if (needsDurable && !tx.snapshot)
        return error("unsupported", "large packet requires candidate checkpoint");
      const commitGap = this.activeGap();
      if (commitGap) {
        const late = immutable({ ...commitGap, reason: "late-gap", status: "unresolved" });
        this.episode = late;
        this.record({ kind: "gap", episode: late });
        return { status: "stale", reason: "late-gap" };
      }
      let durableRevision = this.frame.durableRevision;
      if (needsDurable) {
        const state = await tx.snapshot();
        if (state.status !== "ok")
          return state;
        if (size(state.value) * 2 > STREAM_BUDGET.vtBytesPerPane)
          return busy();
        const body = {
          kind: "vt-recovery",
          previousCheckpointId: this.lastCheckpoint?.checkpointId ?? null,
          identity: p.event.identity,
          inputFence: p.receipt,
          revision: receipt.value.revision,
          head: receipt.value.head,
          state: state.value,
          stateDigest: this.digest("vt-state", { identity: p.event.identity, state: state.value })
        };
        const checkpoint = immutable({ ...body, checkpointId: this.digest("checkpoint-id", body) });
        const commit = { checkpoint, expectedRevision: receipt.value.revision, commitId: checkpoint.checkpointId };
        const durable = await this.ports.history.commitCheckpoint({ ...commit, digest: this.digest("checkpoint", commit) });
        if (durable.status !== "ok")
          return durable;
        if (!samePane3(durable.value.pane, this.identity.pane) || durable.value.durableRevision !== receipt.value.revision || durable.value.checkpointId !== checkpoint.checkpointId)
          return error("integrity", "batch checkpoint fence");
        if (this.activeGap())
          return error("unresolved-gap", "fault during batch commit");
        this.lastCheckpoint = checkpoint;
        this.durable = immutable(durable.value);
        durableRevision = durable.value.durableRevision;
        this.tail.durable(durableRevision);
        this.checkpointAt = this.ports.now();
        this.checkpointHead = receipt.value.head;
      }
      tx.install();
      tx = null;
      if (!this.tail.append(rows))
        throw new Error("admitted tail cannot install");
      this.identity = immutable(p.event.identity);
      this.publish({
        ...request.frameDelta,
        revision: receipt.value.revision,
        durableRevision,
        head: receipt.value.head
      });
      this.record({
        kind: "publish",
        eventId: request.eventId,
        receivedAtMonoMs: p.event.receivedAtMonoMs,
        ramPublishedAtMonoMs: this.ports.now(),
        durableAtMonoMs: null
      });
      this.lastCheckpointInput = p.receipt;
      this.pending = null;
      p.release();
      return ok2(undefined);
    } finally {
      tx?.discard();
      release();
    }
  }
  async flushStreaming(p) {
    const release = this.ports.scratch.reserve(2 * STREAM_BUDGET.vtBytesPerPane);
    if (!release)
      return busy();
    const first = this.ports.vt.prepareStream(p.event);
    let tx;
    try {
      while (true) {
        const next = await first.next();
        if (next.done)
          break;
        if (next.value.status !== "ok")
          return next.value;
        if (next.value.value.candidate) {
          tx = next.value.value.candidate;
          break;
        }
      }
      if (!tx?.snapshot || !sameIdentity2(tx.frame.identity, p.event.identity))
        return error("integrity", "stream final candidate missing");
      const state = await tx.snapshot();
      if (state.status !== "ok")
        return state;
      if (size(state.value) * 2 > STREAM_BUDGET.vtBytesPerPane)
        return busy();
      let head = this.frame.head, revision = this.frame.revision;
      let lastEvent = null;
      for await (const page of this.ports.vt.prepareStream(p.event)) {
        if (page.status !== "ok")
          return page;
        const step = page.value;
        if (this.activeGap())
          return error("unresolved-gap", "fault during stream append");
        if (!step.scrolls.length && step.startOrdinal > 0)
          continue;
        const rows = step.scrolls.map((row, j) => ({
          ...row,
          id: { pane: this.identity.pane, lineId: head + j },
          revision: revision + 1,
          source: { pane: this.identity.pane, ...p.event.position, scrollOrdinal: step.startOrdinal + j },
          geometryGeneration: p.event.identity.geometryGeneration,
          geometry: tx.frame.geometry
        }));
        const body2 = {
          identity: p.event.identity,
          eventId: { pane: this.identity.pane, ...p.event.position, scrollOrdinal: step.startOrdinal },
          expectedRevision: revision,
          rows,
          frameDelta: tx.frame,
          receivedAtMonoMs: p.event.receivedAtMonoMs
        };
        const request = { ...body2, digest: this.digest("append", body2) };
        const result2 = await this.ports.history.appendFinalized(request);
        if (result2.status !== "ok")
          return result2;
        if (result2.value.head !== head + rows.length || result2.value.revision !== revision + 1 || result2.value.digest !== request.digest || streamCanonical(result2.value.eventId) !== streamCanonical(request.eventId))
          return error("integrity", "stream append fence");
        head = result2.value.head;
        revision = result2.value.revision;
        lastEvent = body2.eventId;
      }
      if (!lastEvent)
        return error("integrity", "stream omitted empty packet");
      const body = {
        kind: "vt-recovery",
        previousCheckpointId: this.lastCheckpoint?.checkpointId ?? null,
        identity: p.event.identity,
        inputFence: p.receipt,
        revision,
        head,
        state: state.value,
        stateDigest: this.digest("vt-state", { identity: p.event.identity, state: state.value })
      };
      const checkpoint = immutable({ ...body, checkpointId: this.digest("checkpoint-id", body) });
      const commit = { checkpoint, expectedRevision: revision, commitId: checkpoint.checkpointId };
      const result = await this.ports.history.commitCheckpoint({ ...commit, digest: this.digest("checkpoint", commit) });
      if (result.status !== "ok")
        return result;
      if (!samePane3(result.value.pane, this.identity.pane) || result.value.durableRevision !== revision || result.value.checkpointId !== checkpoint.checkpointId)
        return error("integrity", "stream checkpoint fence");
      if (this.activeGap())
        return error("unresolved-gap", "fault during stream checkpoint");
      tx.install();
      this.identity = immutable(p.event.identity);
      this.lastCheckpoint = checkpoint;
      this.durable = immutable(result.value);
      this.lastCheckpointInput = p.receipt;
      this.checkpointAt = this.ports.now();
      this.checkpointHead = head;
      this.tail.durable(revision);
      this.publish({ ...tx.frame, head, revision, durableRevision: revision });
      this.record({
        kind: "publish",
        eventId: lastEvent,
        receivedAtMonoMs: p.event.receivedAtMonoMs,
        ramPublishedAtMonoMs: this.ports.now(),
        durableAtMonoMs: this.ports.now()
      });
      this.pending = null;
      p.release();
      return ok2(undefined);
    } finally {
      tx?.discard();
      await first.return();
      release();
    }
  }
  subscribe(pane, listener) {
    if (!this.matches(pane))
      throw new Error("capture subscription identity");
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  async checkpoint(pane, _reason) {
    if (!this.matches(pane))
      return { status: "stale", reason: "identity" };
    if (this.locked)
      return busy();
    this.locked = true;
    const release = this.ports.scratch.reserve(STREAM_BUDGET.vtBytesPerPane);
    if (!release) {
      this.locked = false;
      return busy();
    }
    try {
      if (this.episode)
        return error("unresolved-gap", this.episode.episodeId);
      const fence = this.pending ? this.lastCheckpointInput : this.lastInput;
      if (!fence)
        return error("unsupported", "no admitted durable input fence");
      const state = await this.ports.vt.snapshot();
      if (state.status !== "ok")
        return state;
      if (size(state.value) * 2 > STREAM_BUDGET.vtBytesPerPane)
        return busy();
      const stateDigest = this.digest("vt-state", { identity: this.identity, state: state.value });
      const body = {
        kind: "vt-recovery",
        previousCheckpointId: this.lastCheckpoint?.checkpointId ?? null,
        identity: this.identity,
        inputFence: fence,
        revision: this.frame.revision,
        head: this.frame.head,
        state: state.value,
        stateDigest
      };
      const checkpoint = immutable({ ...body, checkpointId: this.digest("checkpoint-id", body) });
      const commit = { checkpoint, expectedRevision: this.frame.revision, commitId: checkpoint.checkpointId };
      const result = await this.ports.history.commitCheckpoint({ ...commit, digest: this.digest("checkpoint", commit) });
      if (result.status !== "ok")
        return result;
      if (!samePane3(result.value.pane, pane) || result.value.durableRevision !== this.frame.revision || result.value.checkpointId !== checkpoint.checkpointId)
        return error("integrity", "checkpoint receipt fence");
      this.lastCheckpoint = checkpoint;
      this.durable = immutable(result.value);
      this.tail.durable(result.value.durableRevision);
      this.checkpointAt = this.ports.now();
      this.checkpointHead = this.frame.head;
      this.publish({ ...this.frame, durableRevision: result.value.durableRevision });
      return ok2(checkpoint);
    } catch (cause) {
      this.fault("worker-exit");
      return error("io", String(cause));
    } finally {
      release();
      this.locked = false;
    }
  }
  lastCheckpointInput = null;
  async restore(checkpoint, input) {
    if (this.locked || this.pending || this.restoring || this.episode)
      return busy();
    if (!sameIdentity2(checkpoint.identity, this.identity))
      return { status: "stale", reason: "identity" };
    if (checkpoint.stateDigest !== this.digest("vt-state", { identity: checkpoint.identity, state: checkpoint.state }))
      return error("integrity", "VT checkpoint checksum");
    if (this.frame.head > checkpoint.head || this.frame.revision > checkpoint.revision)
      return { status: "stale", reason: "late-gap" };
    if (size(checkpoint.state) * 2 > STREAM_BUDGET.vtBytesPerPane)
      return busy();
    const release = this.ports.scratch.reserve(STREAM_BUDGET.vtBytesPerPane);
    if (!release)
      return busy();
    this.locked = true;
    try {
      const result = await this.ports.vt.restore(immutable(checkpoint.state), checkpoint.identity);
      if (result.status !== "ok")
        return result;
      const tx = result.value;
      if (!sameIdentity2(tx.frame.identity, checkpoint.identity) || tx.scrolls.length) {
        tx.discard();
        return error("integrity", "restore must not invent scrolls");
      }
      tx.install();
      this.lastInput = immutable(checkpoint.inputFence);
      this.lastCheckpointInput = this.lastInput;
      this.lastCheckpoint = immutable(checkpoint);
      this.publish({ ...tx.frame, revision: checkpoint.revision, head: checkpoint.head, durableRevision: checkpoint.revision });
    } catch (cause) {
      this.fault("worker-exit");
      return error("io", String(cause));
    } finally {
      release();
      this.locked = false;
    }
    this.restoring = true;
    try {
      for await (const event of input) {
        const result = await this.acceptOrdered(event);
        if (result.status !== "ok")
          return result;
        if (this.pending)
          return busy();
      }
      return ok2(this.frame);
    } catch (cause) {
      this.fault("reader-error");
      return error("io", String(cause));
    } finally {
      this.restoring = false;
    }
  }
  async checkVisible(identity) {
    if (!sameIdentity2(identity, this.identity))
      return { status: "stale", reason: "identity" };
    if (this.visibleLocked)
      return busy();
    const release = this.ports.scratch.reserve(STREAM_BUDGET.decodeBytes);
    if (!release)
      return busy();
    this.visibleLocked = true;
    const eligible = this.ports.now(), before = this.lastInput?.through.packetSeq ?? 0;
    const controller = new AbortController;
    const timer = setTimeout(() => controller.abort(), STREAM_BUDGET.visibleDeadlineMs);
    const scope = new CaptureTaskScope(controller.signal, this.ports.cancelOperation ? () => this.ports.cancelOperation(controller.signal) : undefined);
    let outcome = "error";
    try {
      const snapshot = immutable(this.ports.vt.screen());
      const capture = await scope.wait(this.ports.visible(identity, 0, controller.signal));
      if (controller.signal.aborted || this.ports.now() - eligible > STREAM_BUDGET.visibleDeadlineMs)
        return error("deadline", "visible deadline");
      if (capture.status !== "ok")
        return capture;
      const after = this.lastInput?.through.packetSeq ?? 0;
      const complete = (frame) => frame.changedRows.length === frame.geometry.rows && new Set(frame.changedRows.map((r) => r.y)).size === frame.geometry.rows && frame.changedRows.every((r) => counter(r.y) && r.y < frame.geometry.rows && r.content.cells.length === frame.geometry.columns);
      const verdict = this.pending || this.locked || !complete(snapshot) || !complete(capture.value) ? "unfenced" : exactVisibleVerdict(snapshot, capture.value, before, after);
      outcome = verdict === "unfenced" ? "unfenced" : "ok";
      if (verdict === "different")
        this.fault("visible-divergence");
      return ok2({ verdict });
    } catch (cause) {
      return controller.signal.aborted ? error("deadline", "visible deadline") : error("io", String(cause));
    } finally {
      clearTimeout(timer);
      controller.abort();
      scope.finish(() => {
        release();
        this.visibleLocked = false;
      });
      this.record({
        kind: "request",
        requestId: `visible:${++this.serial}`,
        pane: this.identity.pane,
        operation: "visible",
        eligibleAtMonoMs: eligible,
        deadlineMonoMs: eligible + STREAM_BUDGET.visibleDeadlineMs,
        completedAtMonoMs: this.ports.now(),
        outcome
      });
    }
  }
  async* repair(episode, cancel) {
    if (this.locked) {
      yield busy();
      return;
    }
    if (!this.episode || episode.episodeId !== this.episode.episodeId || !samePane3(episode.pane, this.identity.pane)) {
      yield error("unresolved-gap", "episode not active");
      return;
    }
    if (this.episode.reason === "late-gap") {
      yield { status: "stale", reason: "late-gap" };
      return;
    }
    this.locked = true;
    const controller = new AbortController;
    const deadline2 = episode.firstObservedAtMonoMs + STREAM_BUDGET.recoveryMs;
    const timer = setTimeout(() => controller.abort(), Math.max(0, deadline2 - this.ports.now()));
    const polling = setInterval(() => {
      if (cancel.isCancelled())
        controller.abort();
    }, 10);
    const scope = new CaptureTaskScope(controller.signal, this.ports.cancelOperation ? () => this.ports.cancelOperation(controller.signal) : undefined);
    const leases = [];
    let iterator = null;
    let committed = null;
    try {
      if (cancel.isCancelled() || this.ports.now() >= deadline2)
        controller.abort();
      if (controller.signal.aborted) {
        yield cancel.isCancelled() ? { status: "cancelled", reason: "repair cancelled" } : error("deadline", "repair exceeded 10000ms");
        return;
      }
      const fenced = this.ports.history.beginGap(this.episode);
      if (fenced.status !== "ok") {
        yield fenced;
        return;
      }
      iterator = this.ports.repairChunks(this.episode, controller.signal)[Symbol.asyncIterator]();
      while (true) {
        if (controller.signal.aborted)
          throw new Error("capture operation cancelled");
        const next = await scope.wait(iterator.next());
        if (next.done)
          break;
        const result = next.value;
        if (cancel.isCancelled()) {
          yield { status: "cancelled", reason: "repair cancelled" };
          return;
        }
        if (controller.signal.aborted || this.ports.now() > deadline2) {
          yield error("deadline", "repair exceeded 10000ms");
          return;
        }
        if (result.status !== "ok") {
          yield result;
          return;
        }
        const chunk = result.value;
        if (chunk.rows.length > STREAM_BUDGET.decodeRows || size(chunk) > STREAM_BUDGET.decodeBytes || chunk.episode.episodeId !== episode.episodeId) {
          yield error("integrity", "repair chunk bounds/fence");
          return;
        }
        const release = this.ports.scratch.reserve(STREAM_BUDGET.decodeBytes);
        if (!release) {
          yield busy();
          return;
        }
        let receipt;
        try {
          receipt = await scope.wait(this.ports.history.commitRepair(chunk));
          if (receipt.status === "ok") {
            const ids = receipt.value.committedIds;
            if (ids.length !== chunk.rows.length || !ids.every((id, i) => samePane3(id.pane, this.identity.pane) && id.lineId === chunk.rows[i].id.lineId) || receipt.value.committedRevision !== chunk.expectedRevision + 1 || receipt.value.durable.durableRevision !== receipt.value.committedRevision) {
              yield error("integrity", "repair receipt fence");
              return;
            }
            committed = receipt;
            try {
              const synced = await scope.wait(this.ports.syncRepair(chunk, receipt.value, controller.signal));
              if (!sameIdentity2(synced.identity, this.identity) || synced.revision !== receipt.value.committedRevision || synced.durableRevision !== receipt.value.durable.durableRevision || synced.head < this.frame.head)
                throw new Error("repair sync fence");
              this.tail.durable(receipt.value.durable.durableRevision);
              if (!this.tail.reconcile(chunk.rows))
                throw new Error("repair tail capacity");
              this.durable = immutable(receipt.value.durable);
              this.publish(synced);
            } catch (cause) {
              yield receipt;
              yield error("unresolved-gap", `committed prefix requires sync: ${String(cause)}`);
              return;
            }
            if (chunk.final) {
              if (!chunk.final || cancel.isCancelled() || controller.signal.aborted || !await scope.wait(this.ports.verifyRepair(episode, controller.signal))) {
                yield receipt;
                yield error("unresolved-gap", "durable repair lacks exact live seam proof");
                return;
              }
              const recovered = await scope.wait(this.ports.repairedCheckpoint(episode, controller.signal));
              if (recovered.status !== "ok") {
                yield receipt;
                yield recovered;
                return;
              }
              const cp = recovered.value;
              if (controller.signal.aborted || this.ports.now() > deadline2) {
                yield receipt;
                yield error("deadline", "repair exceeded 10000ms");
                return;
              }
              if (!samePane3(cp.identity.pane, this.identity.pane) || cp.head !== this.frame.head || cp.revision !== this.frame.revision || cp.stateDigest !== this.digest("vt-state", { identity: cp.identity, state: cp.state }) || !samePane3(cp.inputFence.pane, this.identity.pane) || cp.inputFence.through.sourceEpoch !== cp.identity.sourceEpoch || this.pending && cp.identity.sourceEpoch === this.pending.event.identity.sourceEpoch && cp.inputFence.through.packetSeq < this.pending.event.position.packetSeq) {
                yield receipt;
                yield error("integrity", "repair checkpoint fence");
                return;
              }
              const restored = await scope.wait(this.ports.vt.restore(cp.state, cp.identity).then((result2) => {
                if (controller.signal.aborted && result2.status === "ok")
                  result2.value.discard();
                return result2;
              }));
              if (restored.status !== "ok") {
                yield receipt;
                yield restored;
                return;
              }
              if (restored.value.scrolls.length || !sameIdentity2(restored.value.frame.identity, cp.identity)) {
                restored.value.discard();
                yield receipt;
                yield error("integrity", "repair VT restore fence");
                return;
              }
              const commit = { checkpoint: cp, expectedRevision: cp.revision, commitId: cp.checkpointId, closeGap: episode.episodeId };
              const closed = await scope.wait(this.ports.history.commitCheckpoint({ ...commit, digest: this.digest("checkpoint", commit) }));
              if (closed.status !== "ok") {
                restored.value.discard();
                yield receipt;
                yield closed;
                return;
              }
              receipt = ok2({ ...receipt.value, durable: closed.value, complete: true });
              this.durable = immutable(closed.value);
              restored.value.install();
              this.pending?.release();
              this.pending = null;
              this.identity = immutable(cp.identity);
              this.lastInput = immutable(cp.inputFence);
              this.lastCheckpointInput = this.lastInput;
              this.lastCheckpoint = immutable(cp);
              this.checkpointAt = this.ports.now();
              this.checkpointHead = cp.head;
              this.publish({ ...restored.value.frame, head: cp.head, revision: cp.revision, durableRevision: cp.revision });
              this.episode = immutable({ ...this.episode, status: "repaired", missingCount: this.episode.missingCount });
              this.record({ kind: "gap", episode: this.episode });
              this.episode = null;
            }
          }
        } finally {
          if (controller.signal.aborted)
            leases.push(release);
          else
            release();
        }
        committed = null;
        yield receipt;
        if (receipt.status !== "ok" || receipt.value.complete)
          return;
      }
      yield error("unresolved-gap", "repair ended without completion");
    } catch (cause) {
      if (committed)
        yield committed;
      yield controller.signal.aborted ? cancel.isCancelled() ? { status: "cancelled", reason: "repair cancelled" } : error("deadline", "repair exceeded 10000ms") : error("io", String(cause));
    } finally {
      clearTimeout(timer);
      clearInterval(polling);
      if (iterator?.return) {
        try {
          scope.wait(iterator.return()).catch(() => {});
        } catch {}
      }
      controller.abort();
      scope.finish(() => {
        for (const release of leases)
          release();
        this.locked = false;
      });
    }
  }
  async drain(pane, deadlineMonoMs) {
    if (!this.matches(pane))
      return { status: "stale", reason: "identity" };
    if (this.ports.now() >= deadlineMonoMs)
      return error("deadline", "drain deadline");
    if (this.locked)
      return busy();
    if (this.pending) {
      this.locked = true;
      try {
        const flushed = await this.flushPending();
        if (flushed.status !== "ok")
          return flushed;
      } finally {
        this.locked = false;
      }
    }
    const result = await this.checkpoint(pane, "handoff");
    if (result.status !== "ok")
      return result;
    return this.ports.now() > deadlineMonoMs ? error("deadline", "drain deadline") : ok2(this.durable);
  }
}
class CaptureCadence {
  engine;
  identity;
  now;
  nextVisible;
  eventAt = Infinity;
  viewers = 0;
  active = false;
  visibleRunning = false;
  checkpointRunning = false;
  constructor(engine, identity, now) {
    this.engine = engine;
    this.identity = identity;
    this.now = now;
    this.nextVisible = now();
  }
  activity(viewers, active) {
    if (!counter(viewers))
      throw new Error("viewer count");
    const changed = this.viewers !== viewers || this.active !== active;
    this.viewers = viewers;
    this.active = active;
    if (changed)
      this.event();
  }
  event() {
    this.eventAt = Math.min(this.eventAt, this.now() + STREAM_BUDGET.visibleEventMs);
  }
  async tick() {
    const tasks = [];
    if (!this.visibleRunning && this.now() >= Math.min(this.nextVisible, this.eventAt)) {
      this.visibleRunning = true;
      this.eventAt = Infinity;
      this.nextVisible = this.now() + (this.viewers === 0 ? STREAM_BUDGET.visibleNoViewerMs : this.active ? STREAM_BUDGET.visibleActiveMs : STREAM_BUDGET.visibleIdleMs);
      tasks.push(this.engine.checkVisible(this.identity()).finally(() => {
        this.visibleRunning = false;
      }));
    }
    if (!this.checkpointRunning && this.engine.checkpointDue) {
      this.checkpointRunning = true;
      tasks.push(this.engine.checkpoint(this.identity().pane, this.engine.checkpointDue).finally(() => {
        this.checkpointRunning = false;
      }));
    }
    await Promise.all(tasks);
  }
}
var ownedImmutable = new WeakSet;

// src/history-engine.ts
import { Database as Database4 } from "bun:sqlite";
import { randomUUID as randomUUID3, createHmac, timingSafeEqual } from "node:crypto";
import { resolve as resolve3, dirname as dirname2, join as join3, sep as sep2 } from "node:path";
import { closeSync as closeSync4, existsSync as existsSync3, readdirSync, fsyncSync as fsyncSync2, lstatSync as lstatSync3, mkdirSync as mkdirSync2, openSync as openSync4, readSync as readSync3, renameSync, statfsSync, statSync, unlinkSync, writeSync as writeSync2, chmodSync } from "node:fs";
import { createHash as createHash6 } from "node:crypto";
import { deflateSync as zlibDeflateSync, inflateSync } from "node:zlib";
var v2Probe = null;
function v2Enter(bucket) {
  const p = v2Probe, top = p?.stack.at(-1);
  if (!p || top === "decode")
    return false;
  const now = performance.now();
  if (top)
    p.ms[top] += now - p.at;
  p.at = now;
  p.stack.push(bucket);
  return true;
}
function v2Leave(bucket) {
  const p = v2Probe;
  if (!p || p.stack.at(-1) !== bucket)
    return;
  const now = performance.now();
  p.ms[bucket] += now - p.at;
  p.at = now;
  p.stack.pop();
}
function v2Span(bucket, f) {
  if (!v2Enter(bucket))
    return f();
  try {
    return f();
  } finally {
    v2Leave(bucket);
  }
}
function streamCanonical2(value, encode) {
  return v2Probe ? v2Span("canonical", () => streamCanonical(value, encode)) : streamCanonical(value, encode);
}
function deflateSync(data, options) {
  return v2Probe ? v2Span("pack", () => zlibDeflateSync(data, options)) : zlibDeflateSync(data, options);
}
function frozen(value) {
  if (value && typeof value === "object") {
    for (const item of Object.values(value))
      frozen(item);
    Object.freeze(value);
  }
  return value;
}
function copy(value) {
  return frozen(JSON.parse(streamCanonical2(value)));
}
function bytes(value) {
  return Buffer.byteLength(streamCanonical2(value));
}
function safe2(n) {
  if (!Number.isSafeInteger(n) || n < 0)
    throw Error("unsafe counter");
}
function nonempty(s) {
  if (typeof s !== "string" || !s.length || s.length > 4096)
    throw Error("invalid key");
}
function paneKey2(p) {
  nonempty(p.serverIdentity);
  nonempty(p.paneId);
  safe2(p.birthGeneration);
  return streamCanonical2(p);
}
function identity(i) {
  paneKey2(i.pane);
  safe2(i.sourceEpoch);
  safe2(i.geometryGeneration);
}
function equal(a, b) {
  return streamCanonical2(a) === streamCanonical2(b);
}
function digest(kind, r) {
  const { digest: d, ...payload } = r;
  if (!/^[a-f0-9]{64}$/.test(d) || streamDigest(kind, payload) !== d)
    throw Error("digest mismatch");
}
function geometry(g) {
  safe2(g.columns);
  safe2(g.rows);
  if (!g.columns || !g.rows || g.columns > Math.max(STREAM_BUDGET.maxColumns, NEWARCH_V2_LIMITS.maxColumns) || g.rows > Math.max(STREAM_BUDGET.maxRows, NEWARCH_V2_LIMITS.maxRows))
    throw Error("geometry outside admitted envelope");
}
function content(row) {
  if (!Array.isArray(row.cells) || typeof row.softWrap !== "boolean")
    throw Error("invalid row");
  safe2(row.wrapPad);
  if (!Array.isArray(row.uncertainFields) || row.uncertainFields.some((x) => typeof x !== "string"))
    throw Error("invalid uncertain fields");
  const checked = new Set;
  for (const c of row.cells) {
    if (checked.has(c))
      continue;
    if (typeof c.text !== "string" || !c.text.isWellFormed() || ![0, 1, 2].includes(c.width) || !Array.isArray(c.style))
      throw Error("invalid cell");
    c.style.forEach(safe2);
    if (bytes(c) > STREAM_BUDGET.blockPayloadBytes / 2)
      throw Error("single cell exceeds block");
    checked.add(c);
  }
}
function fail(error2) {
  const message = String(error2);
  if (/SQLITE_(BUSY|LOCKED)/.test(message))
    return { status: "busy", reason: "snapshot-gate", retryAfterMs: 20 };
  return { status: "error", code: /SQLITE_|closed/.test(message) ? "io" : "integrity", message };
}
var busy2 = () => ({ status: "busy", reason: "pressure", retryAfterMs: 20 });
var stale = (reason = "identity") => ({ status: "stale", reason });
var ok3 = (value) => ({ status: "ok", value: copy(value) });
var pool = { pending: 0, overlays: 0, readers: 0, cache: 0, panes: new Set, paths: new Set };
var WRITER_CACHE = 4 * 1024 * 1024;
var READER_CACHE = 2 * 1024 * 1024;
var SCHEMA2 = `
CREATE TABLE IF NOT EXISTS sh_format(version INTEGER PRIMARY KEY CHECK(version=1));
INSERT OR IGNORE INTO sh_format VALUES(1);
CREATE TABLE IF NOT EXISTS sh_pane(pane TEXT PRIMARY KEY, identity TEXT NOT NULL, revision INTEGER NOT NULL,
 durable INTEGER NOT NULL, head INTEGER NOT NULL, checkpoint TEXT, gap TEXT);
CREATE TABLE IF NOT EXISTS sh_input(pane TEXT NOT NULL, epoch INTEGER NOT NULL, seq INTEGER NOT NULL,
 digest TEXT NOT NULL, payload TEXT NOT NULL, receipt TEXT NOT NULL, PRIMARY KEY(pane,epoch,seq)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS sh_event(pane TEXT NOT NULL, event TEXT NOT NULL, digest TEXT NOT NULL,
 receipt TEXT NOT NULL, PRIMARY KEY(pane,event)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS sh_checkpoint(pane TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL,
 revision INTEGER NOT NULL, checksum TEXT NOT NULL, PRIMARY KEY(pane,id)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS sh_commit(pane TEXT NOT NULL, id TEXT NOT NULL, digest TEXT NOT NULL,
 receipt TEXT NOT NULL, revision INTEGER NOT NULL, PRIMARY KEY(pane,id)) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS sh_commit_revision ON sh_commit(pane,revision);
CREATE TABLE IF NOT EXISTS sh_repair(pane TEXT NOT NULL, episode TEXT NOT NULL, chunk TEXT NOT NULL,
 digest TEXT NOT NULL, receipt TEXT NOT NULL, PRIMARY KEY(pane,episode,chunk)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS sh_row(pane TEXT NOT NULL, line INTEGER NOT NULL, revision INTEGER NOT NULL,
 cell_count INTEGER NOT NULL, metadata TEXT NOT NULL, digest TEXT NOT NULL,
 PRIMARY KEY(pane,line)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS sh_fragment(pane TEXT NOT NULL, line INTEGER NOT NULL, start_cell INTEGER NOT NULL,
 end_cell INTEGER NOT NULL, payload TEXT NOT NULL, digest TEXT NOT NULL, checkpoint TEXT NOT NULL,
 PRIMARY KEY(pane,line,start_cell)) WITHOUT ROWID;
`;
function readStoredRow(db, pane, line) {
  const key = paneKey2(pane);
  const meta = db.query("SELECT * FROM sh_row WHERE pane=? AND line=?").get(key, line);
  if (!meta)
    throw Error("missing durable row");
  const count = Number(meta.cell_count), cells = [];
  safe2(count);
  let start = 0, totalBytes = Buffer.byteLength(String(meta.metadata));
  do {
    const block = db.query("SELECT * FROM sh_fragment WHERE pane=? AND line=? AND start_cell=?").get(key, line, start);
    if (!block)
      throw Error("missing row continuation");
    const payload = String(block.payload), end = Number(block.end_cell);
    if (Buffer.byteLength(payload) > STREAM_BUDGET.blockPayloadBytes || end > count || count && end <= start)
      throw Error("invalid fragment bounds");
    totalBytes += Buffer.byteLength(payload);
    if (totalBytes > STREAM_BUDGET.decodeBytes)
      throw Error("row exceeds decode cap");
    if (block.digest !== streamDigest("fragment", { pane, lineId: line, start, end, payload }))
      throw Error("fragment checksum");
    const pageCheckpoint = JSON.parse(String(block.checkpoint));
    if (pageCheckpoint.kind !== "history-page" || !equal(pageCheckpoint.pane, pane) || pageCheckpoint.first.lineId !== line || pageCheckpoint.first.cellOffset !== start || pageCheckpoint.payloadBytes !== Buffer.byteLength(payload) || pageCheckpoint.rowCount !== 1 || pageCheckpoint.checksum !== block.digest)
      throw Error("page checkpoint integrity");
    const part = JSON.parse(payload);
    if (!Array.isArray(part) || part.length !== end - start)
      throw Error("fragment length");
    for (const cell of part)
      cells.push(cell);
    start = end;
  } while (start < count);
  const row = { ...JSON.parse(String(meta.metadata)), cells };
  if (streamDigest("row", row) !== meta.digest || row.id.lineId !== line || !equal(row.id.pane, pane))
    throw Error("row checksum/identity");
  return row;
}

class StreamHistoryEngine {
  options;
  db;
  pending = new Map;
  pins = new Map;
  closed = false;
  readers = new Map;
  ownPending = 0;
  constructor(options) {
    this.options = options;
    this.options = options = { ...options, path: options.path === ":memory:" ? options.path : resolve3(options.path), codecVersions: [...options.codecVersions] };
    if (options.path === ":memory:" || !options.path || pool.paths.has(options.path))
      throw Error("dedicated disk path with one writer required");
    if (!options.codecVersions.length)
      throw Error("explicit supported VT codecs required");
    if (pool.cache + WRITER_CACHE > STREAM_BUDGET.diskCacheBytes)
      throw Error("disk cache pressure");
    const db = new Database4(options.path, { create: true, strict: true });
    try {
      const tables = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
      if (tables.some((t) => !t.name.startsWith("sh_")))
        throw Error("not a dedicated stream database");
      db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA cache_size=-4096; PRAGMA mmap_size=0; PRAGMA busy_timeout=0; PRAGMA temp_store=FILE;");
      db.transaction(() => db.exec(SCHEMA2)).immediate();
      if (Number(db.query("SELECT version FROM sh_format").get().version) !== 1)
        throw Error("unsupported stream storage version");
      this.db = db;
      pool.cache += WRITER_CACHE;
      pool.paths.add(options.path);
    } catch (e) {
      db.close();
      throw e;
    }
  }
  live() {
    if (this.closed)
      throw Error("engine closed");
    for (const p of this.pending.values())
      this.reconcilePending(p.state.identity.pane);
  }
  state(p, db = this.db, includePending = true) {
    const key = paneKey2(p);
    if (includePending && db === this.db && this.pending.has(key))
      return this.pending.get(key).state;
    const r = db.query("SELECT * FROM sh_pane WHERE pane=?").get(key);
    return r ? {
      identity: JSON.parse(String(r.identity)),
      revision: Number(r.revision),
      durable: Number(r.durable),
      head: Number(r.head),
      checkpoint: r.checkpoint === null ? null : String(r.checkpoint),
      gap: r.gap === null ? null : JSON.parse(String(r.gap))
    } : null;
  }
  putState(s) {
    this.db.query("INSERT OR REPLACE INTO sh_pane VALUES(?,?,?,?,?,?,?)").run(paneKey2(s.identity.pane), streamCanonical2(s.identity), s.revision, s.durable, s.head, s.checkpoint, s.gap ? streamCanonical2(s.gap) : null);
  }
  match(s, i) {
    if (!equal(s.identity.pane, i.pane))
      return stale();
    if (s.identity.sourceEpoch !== i.sourceEpoch)
      return stale("epoch");
    if (s.identity.geometryGeneration !== i.geometryGeneration)
      return stale("geometry");
    return null;
  }
  dropPending(key) {
    const pending = this.pending.get(key);
    if (pending) {
      pool.pending -= pending.charge;
      this.ownPending -= pending.charge;
      this.pending.delete(key);
    }
  }
  transaction(kind, fn) {
    this.options.boundary?.(`${kind}-before-write`);
    this.db.transaction(() => {
      fn();
      this.options.boundary?.(`${kind}-before-commit`);
    }).immediate();
    this.options.boundary?.(`${kind}-after-commit`);
  }
  async journalInput(event) {
    try {
      this.live();
      identity(event.identity);
      safe2(event.position.packetSeq);
      safe2(event.position.sourceEpoch);
      if (!event.position.packetSeq || event.position.sourceEpoch !== event.identity.sourceEpoch || !Number.isFinite(event.receivedAtMonoMs) || event.receivedAtMonoMs < 0)
        throw Error("input identity/time");
      const n = bytes(event);
      if (n > STREAM_BUDGET.rawBytesPerPane || pool.pending + n * 4 > STREAM_BUDGET.pendingBytes)
        return busy2();
      digest("input", event);
      if (event.payload.kind === "bytes") {
        if (!Array.isArray(event.payload.bytes) || event.payload.bytes.some((b) => !Number.isInteger(b) || b < 0 || b > 255))
          throw Error("invalid byte");
      } else if (event.payload.kind === "resize")
        geometry(event.payload.geometry);
      else if (event.payload.kind === "control") {
        nonempty(event.payload.name);
        if (typeof event.payload.data !== "string")
          throw Error("invalid control");
      } else
        throw Error("unknown input kind");
      const key = paneKey2(event.identity.pane), { sourceEpoch, packetSeq } = event.position;
      const old = this.db.query("SELECT digest,receipt FROM sh_input WHERE pane=? AND epoch=? AND seq=?").get(key, sourceEpoch, packetSeq);
      if (old) {
        if (old.digest !== event.digest)
          throw Error("input identity collision");
        return ok3(JSON.parse(String(old.receipt)));
      }
      const state = this.state(event.identity.pane);
      if (state && (sourceEpoch < state.identity.sourceEpoch || event.identity.geometryGeneration < state.identity.geometryGeneration))
        return stale("epoch");
      if (state && !equal(state.identity, event.identity) && this.pending.has(key))
        return { status: "busy", reason: "snapshot-gate", retryAfterMs: 20 };
      const last = this.db.query("SELECT seq FROM sh_input WHERE pane=? AND epoch=? ORDER BY seq DESC LIMIT 1").get(key, sourceEpoch);
      if (packetSeq !== (last ? Number(last.seq) : 0) + 1)
        throw Error("noncontiguous durable input");
      const receipt = {
        kind: "durable-input",
        pane: event.identity.pane,
        through: event.position,
        digest: event.digest,
        segmentId: streamDigest("segment", { pane: event.identity.pane, position: event.position })
      };
      pool.pending += n * 4;
      try {
        this.transaction("input", () => {
          this.db.query("INSERT INTO sh_input VALUES(?,?,?,?,?,?)").run(key, sourceEpoch, packetSeq, event.digest, streamCanonical2(event), streamCanonical2(receipt));
          const diskState = this.state(event.identity.pane, this.db, false);
          this.putState(diskState ? { ...diskState, identity: event.identity } : { identity: event.identity, revision: 0, durable: 0, head: 0, checkpoint: null, gap: null });
        });
      } finally {
        pool.pending -= n * 4;
      }
      return ok3(receipt);
    } catch (e) {
      return fail(e);
    }
  }
  validateRows(rows, s, revision) {
    if (rows.length > STREAM_BUDGET.decodeRows || bytes(rows) > STREAM_BUDGET.decodeBytes)
      throw Error("row chunk exceeds decode budget");
    safe2(revision);
    safe2(s.head + rows.length);
    for (let j = 0;j < rows.length; j++) {
      const row = rows[j];
      safe2(row.id.lineId);
      safe2(row.revision);
      safe2(row.source.sourceEpoch);
      safe2(row.source.packetSeq);
      safe2(row.source.scrollOrdinal);
      if (!equal(row.id.pane, s.identity.pane) || !equal(row.source.pane, s.identity.pane) || row.id.lineId !== s.head + j || row.revision !== revision || row.geometryGeneration !== s.identity.geometryGeneration || !row.source.packetSeq)
        throw Error("row identity/revision/order");
      geometry(row.geometry);
      content(row);
    }
  }
  async appendFinalized(request) {
    try {
      this.live();
      identity(request.identity);
      safe2(request.expectedRevision);
      digest("append", request);
      safe2(request.eventId.sourceEpoch);
      safe2(request.eventId.packetSeq);
      safe2(request.eventId.scrollOrdinal);
      if (!Number.isFinite(request.receivedAtMonoMs) || request.receivedAtMonoMs < 0 || !request.eventId.packetSeq || !equal(request.eventId.pane, request.identity.pane) || request.eventId.sourceEpoch !== request.identity.sourceEpoch)
        throw Error("event identity/time");
      const key = paneKey2(request.identity.pane), ek = eventKey(request.eventId);
      const prior = this.pending.get(key)?.events.get(ek);
      if (prior) {
        if (prior.request.digest !== request.digest)
          throw Error("event identity collision");
        return ok3(prior.receipt);
      }
      const durable = this.db.query("SELECT digest,receipt FROM sh_event WHERE pane=? AND event=?").get(key, ek);
      if (durable) {
        if (durable.digest !== request.digest)
          throw Error("event identity collision");
        return ok3(JSON.parse(String(durable.receipt)));
      }
      const state = this.state(request.identity.pane);
      if (!state)
        return stale();
      const mismatch = this.match(state, request.identity);
      if (mismatch)
        return mismatch;
      if (state.gap)
        return stale("late-gap");
      if (request.expectedRevision !== state.revision)
        return stale();
      const input = this.db.query("SELECT 1 FROM sh_input WHERE pane=? AND epoch=? AND seq=?").get(key, request.eventId.sourceEpoch, request.eventId.packetSeq);
      if (!input)
        throw Error("append input is not durable");
      const revision = state.revision + 1;
      safe2(revision);
      this.validateRows(request.rows, state, revision);
      const frame = request.frameDelta;
      if (!equal(frame.identity, request.identity) || frame.buffer !== "normal" && frame.buffer !== "alternate" || frame.buffer === "alternate" && request.rows.length)
        throw Error("frame identity/alternate scroll");
      geometry(frame.geometry);
      safe2(frame.screenRevision);
      safe2(frame.cursor.x);
      safe2(frame.cursor.y);
      if (frame.cursor.x >= frame.geometry.columns || frame.cursor.y >= frame.geometry.rows || typeof frame.cursor.visible !== "boolean")
        throw Error("invalid frame cursor");
      if (frame.overlap) {
        safe2(frame.overlap.start);
        safe2(frame.overlap.end);
        if (frame.overlap.start > frame.overlap.end || frame.overlap.end > state.head + request.rows.length)
          throw Error("invalid overlap");
      }
      const ys = new Set;
      for (const changed of frame.changedRows) {
        safe2(changed.y);
        if (changed.y >= frame.geometry.rows || ys.has(changed.y))
          throw Error("invalid changed row");
        ys.add(changed.y);
        content(changed.content);
      }
      for (const [j, row] of request.rows.entries())
        if (!equal(row.source, { ...request.eventId, scrollOrdinal: request.eventId.scrollOrdinal + j }) || !equal(row.geometry, frame.geometry))
          throw Error("row source/frame mismatch");
      const charge = bytes(request) * 4;
      if (pool.pending + charge > STREAM_BUDGET.pendingBytes)
        return busy2();
      const owned = copy(request);
      const receipt = copy({ kind: "ram", eventId: owned.eventId, digest: owned.digest, revision, head: state.head + request.rows.length });
      if (this.options.stagePrefixesOnDisk) {
        this.db.transaction(() => {
          this.writeRows(owned.rows);
          this.db.query("INSERT INTO sh_event VALUES(?,?,?,?)").run(key, ek, owned.digest, streamCanonical2(receipt));
          this.putState({ ...state, revision, head: receipt.head });
        }).immediate();
        return ok3(receipt);
      }
      const pending = this.pending.get(key) ?? { state: { ...state }, events: new Map, charge: 0 };
      pending.state = { ...state, revision, head: receipt.head };
      pending.events.set(ek, { request: owned, receipt });
      pending.charge += charge;
      this.pending.set(key, pending);
      pool.pending += charge;
      this.ownPending += charge;
      return ok3(receipt);
    } catch (e) {
      return fail(e);
    }
  }
  writeRows(rows) {
    for (const row of rows) {
      const key = paneKey2(row.id.pane), { cells, ...meta } = row;
      this.db.query("INSERT INTO sh_row VALUES(?,?,?,?,?,?)").run(key, row.id.lineId, row.revision, cells.length, streamCanonical2(meta), streamDigest("row", row));
      let start = 0;
      while (start < cells.length || start === 0 && !cells.length) {
        let end = start, size2 = 2;
        while (end < cells.length && size2 + bytes(cells[end]) + 1 <= STREAM_BUDGET.blockPayloadBytes) {
          size2 += bytes(cells[end]) + 1;
          end++;
        }
        if (end === start && cells.length)
          throw Error("cell cannot fit block");
        const payload = streamCanonical2(cells.slice(start, end));
        const checksum = streamDigest("fragment", { pane: row.id.pane, lineId: row.id.lineId, start, end, payload });
        const prior = this.db.query("SELECT line,start_cell FROM sh_fragment WHERE pane=? ORDER BY line DESC,start_cell DESC LIMIT 1").get(key);
        const blockId = (lineId, cellOffset) => streamDigest("block-id", { pane: row.id.pane, lineId, cellOffset });
        const checkpoint = {
          kind: "history-page",
          blockId: blockId(row.id.lineId, start),
          pane: row.id.pane,
          previousBlockId: prior ? blockId(Number(prior.line), Number(prior.start_cell)) : null,
          first: { lineId: row.id.lineId, cellOffset: start },
          end: end === cells.length ? { lineId: row.id.lineId + 1, cellOffset: 0 } : { lineId: row.id.lineId, cellOffset: end },
          minRevision: row.revision,
          maxRevision: row.revision,
          checksum,
          rowCount: 1,
          payloadBytes: Buffer.byteLength(payload),
          geometryAndWrap: [{ lineId: row.id.lineId, geometryGeneration: row.geometryGeneration, geometry: row.geometry, softWrap: row.softWrap, wrapPad: row.wrapPad }]
        };
        this.db.query("INSERT INTO sh_fragment VALUES(?,?,?,?,?,?,?)").run(key, row.id.lineId, start, end, payload, checksum, streamCanonical2(checkpoint));
        if (!cells.length)
          break;
        start = end;
      }
    }
  }
  flushRows(key) {
    const pending = this.pending.get(key);
    if (!pending)
      return;
    for (const [event, value] of pending.events) {
      this.writeRows(value.request.rows);
      this.db.query("INSERT INTO sh_event VALUES(?,?,?,?)").run(key, event, value.request.digest, streamCanonical2(value.receipt));
    }
  }
  async commitCheckpoint(request) {
    try {
      this.live();
      digest("checkpoint", request);
      nonempty(request.commitId);
      safe2(request.expectedRevision);
      const cp = request.checkpoint;
      identity(cp.identity);
      nonempty(cp.checkpointId);
      safe2(cp.revision);
      safe2(cp.head);
      const key = paneKey2(cp.identity.pane);
      const prior = this.db.query("SELECT digest,receipt FROM sh_commit WHERE pane=? AND id=?").get(key, request.commitId);
      if (prior) {
        if (prior.digest !== request.digest)
          throw Error("commit identity collision");
        this.reconcilePending(cp.identity.pane);
        return ok3(JSON.parse(String(prior.receipt)));
      }
      if (bytes(cp) > STREAM_BUDGET.vtBytesPerPane)
        return busy2();
      if (!this.options.codecVersions.includes(cp.state.codecVersion))
        return { status: "error", code: "unsupported", message: "VT codec is not admitted" };
      if (cp.kind !== "vt-recovery" || streamDigest("vt-state", { identity: cp.identity, state: cp.state }) !== cp.stateDigest)
        throw Error("VT state digest");
      geometry(cp.state.geometry);
      if (!["normal", "alternate"].includes(cp.state.active) || typeof cp.state.extensionState !== "string" || typeof cp.state.wrapPending !== "boolean")
        throw Error("invalid VT state");
      const numericArray = (a) => {
        if (!Array.isArray(a))
          throw Error("invalid VT array");
        a.forEach(safe2);
      };
      const modes = (m2) => {
        if (!m2 || typeof m2 !== "object" || Array.isArray(m2))
          throw Error("invalid VT modes");
        for (const value of Object.values(m2))
          if (typeof value !== "boolean" && !Number.isFinite(value))
            throw Error("invalid VT mode");
      };
      modes(cp.state.modes);
      numericArray(cp.state.attributes);
      numericArray(cp.state.tabStops);
      for (const a of [cp.state.pendingUtf8, cp.state.pendingEscape]) {
        numericArray(a);
        if (a.some((n) => n > 255))
          throw Error("invalid pending byte");
      }
      const m = cp.state.margins;
      [m.top, m.bottom, m.left, m.right].forEach(safe2);
      if (m.top > m.bottom || m.bottom >= cp.state.geometry.rows || m.left > m.right || m.right >= cp.state.geometry.columns)
        throw Error("invalid margins");
      for (const buffer of [cp.state.normal, cp.state.alternate]) {
        if (!Array.isArray(buffer.rows) || buffer.rows.length > cp.state.geometry.rows || typeof buffer.wrapPending !== "boolean")
          throw Error("invalid VT buffer");
        for (const row of buffer.rows)
          content(row);
        numericArray(buffer.savedAttributes);
        modes(buffer.savedModes);
        for (const cursor of [buffer.cursor, buffer.savedCursor]) {
          safe2(cursor.x);
          safe2(cursor.y);
          if (cursor.x >= cp.state.geometry.columns || cursor.y >= cp.state.geometry.rows || typeof cursor.visible !== "boolean")
            throw Error("invalid VT cursor");
        }
      }
      const state = this.state(cp.identity.pane);
      if (!state)
        return stale();
      const mismatch = this.match(state, cp.identity);
      if (mismatch)
        return mismatch;
      if (state.gap) {
        if (request.closeGap !== state.gap.episodeId || state.gap.reason === "late-gap")
          return { status: "error", code: "unresolved-gap", message: "checkpoint behind unresolved gap" };
        const final = this.db.query("SELECT 1 FROM sh_repair WHERE pane=? AND episode=? AND json_extract(receipt,'$.finalChunk')=1 LIMIT 1").get(key, request.closeGap);
        if (!final)
          throw Error("repair rows not sealed");
      } else if (request.closeGap)
        throw Error("repair episode is not active");
      if (request.expectedRevision !== state.revision || cp.revision !== state.revision || cp.head !== state.head)
        return stale();
      if (cp.previousCheckpointId !== state.checkpoint)
        throw Error("checkpoint chain");
      if (this.db.query("SELECT 1 FROM sh_checkpoint WHERE pane=? AND id=?").get(key, cp.checkpointId))
        throw Error("checkpoint ID reused");
      const fence = cp.inputFence;
      if (!equal(fence.pane, cp.identity.pane) || fence.through.sourceEpoch !== cp.identity.sourceEpoch)
        throw Error("checkpoint input identity");
      const input = this.db.query("SELECT receipt FROM sh_input WHERE pane=? AND epoch=? AND seq=?").get(key, fence.through.sourceEpoch, fence.through.packetSeq);
      if (!input || !equal(JSON.parse(String(input.receipt)), fence))
        throw Error("checkpoint input is not durable");
      for (const event of this.pending.get(key)?.events.values() ?? []) {
        if (event.request.eventId.sourceEpoch !== fence.through.sourceEpoch || event.request.eventId.packetSeq > fence.through.packetSeq)
          throw Error("checkpoint fence before pending rows");
      }
      const previous = state.checkpoint ? this.db.query("SELECT payload FROM sh_checkpoint WHERE pane=? AND id=?").get(key, state.checkpoint) : null;
      if (previous) {
        const old = JSON.parse(String(previous.payload));
        if (fence.through.sourceEpoch < old.inputFence.through.sourceEpoch || fence.through.sourceEpoch === old.inputFence.through.sourceEpoch && fence.through.packetSeq < old.inputFence.through.packetSeq)
          throw Error("checkpoint fence regression");
      }
      const receipt = {
        kind: "durable",
        pane: cp.identity.pane,
        commitId: request.commitId,
        digest: request.digest,
        durableRevision: state.revision,
        checkpointId: cp.checkpointId
      };
      this.transaction("checkpoint", () => {
        this.flushRows(key);
        this.db.query("INSERT INTO sh_checkpoint VALUES(?,?,?,?,?)").run(key, cp.checkpointId, streamCanonical2(cp), cp.revision, streamDigest("vt-checkpoint", cp));
        this.db.query("INSERT INTO sh_commit VALUES(?,?,?,?,?)").run(key, request.commitId, request.digest, streamCanonical2(receipt), receipt.durableRevision);
        this.putState({ ...state, durable: state.revision, checkpoint: cp.checkpointId, gap: null });
      });
      this.dropPending(key);
      return ok3(receipt);
    } catch (e) {
      return fail(e);
    }
  }
  reconcilePending(pane) {
    const key = paneKey2(pane), p = this.pending.get(key);
    if (!p)
      return;
    const disk = this.state(pane, this.db, false);
    if (disk.durable >= p.state.revision) {
      this.dropPending(key);
      return;
    }
    for (const [event, value] of p.events)
      if (value.receipt.revision <= disk.durable) {
        const charge = bytes(value.request) * 4;
        p.events.delete(event);
        p.charge -= charge;
        pool.pending -= charge;
        this.ownPending -= charge;
      }
    p.state = { ...p.state, durable: disk.durable, checkpoint: disk.checkpoint, gap: disk.gap };
  }
  discardStaged(pane) {
    try {
      this.live();
      const key = paneKey2(pane);
      if (!this.options.stagePrefixesOnDisk || this.pending.has(key))
        return ok3({ discardedRows: 0 });
      const state = this.state(pane, this.db, false);
      if (!state || state.revision === state.durable)
        return ok3({ discardedRows: 0 });
      if (state.gap)
        return { status: "error", code: "unresolved-gap", message: "staged rows behind a gap episode" };
      let discardedRows = 0;
      this.db.transaction(() => {
        const low = this.db.query("SELECT MIN(line) AS line, COUNT(*) AS n FROM sh_row WHERE pane=? AND revision>?").get(key, state.durable);
        discardedRows = Number(low.n);
        const head = discardedRows ? Number(low.line) : state.head;
        if (this.db.query("SELECT 1 FROM sh_row WHERE pane=? AND line>=? AND revision<=? LIMIT 1").get(key, head, state.durable))
          throw Error("durable row above staged prefix");
        this.db.query("DELETE FROM sh_fragment WHERE pane=? AND line>=?").run(key, head);
        this.db.query("DELETE FROM sh_row WHERE pane=? AND line>=?").run(key, head);
        this.db.query("DELETE FROM sh_event WHERE pane=? AND json_extract(receipt,'$.revision')>?").run(key, state.durable);
        this.putState({ ...state, revision: state.durable, head });
      }).immediate();
      return ok3({ discardedRows });
    } catch (e) {
      return fail(e);
    }
  }
  beginGap(episode) {
    try {
      this.live();
      nonempty(episode.episodeId);
      paneKey2(episode.pane);
      safe2(episode.epochBefore);
      if (episode.epochAfter !== null) {
        safe2(episode.epochAfter);
        if (episode.epochAfter < episode.epochBefore)
          throw Error("gap epoch regression");
      }
      if (episode.missingCount !== null)
        safe2(episode.missingCount);
      if (!Number.isFinite(episode.firstObservedAtMonoMs) || episode.firstObservedAtMonoMs < 0 || !["suspected", "repairing", "unresolved"].includes(episode.status))
        throw Error("invalid gap state");
      if (episode.lastDurableInput) {
        safe2(episode.lastDurableInput.sourceEpoch);
        safe2(episode.lastDurableInput.packetSeq);
      }
      const state = this.state(episode.pane);
      if (!state)
        return stale();
      if (episode.lastAdmittedRow !== null)
        safe2(episode.lastAdmittedRow);
      if (state.gap)
        return state.gap.episodeId === episode.episodeId && state.gap.epochBefore === episode.epochBefore && state.gap.lastAdmittedRow === episode.lastAdmittedRow ? ok3(null) : stale("late-gap");
      if (episode.reason === "late-gap" || episode.lastAdmittedRow !== (state.head ? state.head - 1 : null)) {
        const gap = copy({ ...episode, reason: "late-gap", status: "unresolved" });
        const disk = this.state(episode.pane, this.db, false);
        this.db.transaction(() => this.putState({ ...disk, gap })).immediate();
        const pending = this.pending.get(paneKey2(episode.pane));
        if (pending)
          pending.state = { ...pending.state, gap };
        for (const [id, pin] of this.pins)
          if (equal(pin.view.identity.pane, episode.pane))
            this.releasePin(id);
        return stale("late-gap");
      }
      const key = paneKey2(episode.pane);
      this.db.transaction(() => {
        this.flushRows(key);
        this.putState({ ...state, durable: state.revision, gap: copy(episode) });
      }).immediate();
      this.dropPending(key);
      return ok3(null);
    } catch (e) {
      return fail(e);
    }
  }
  async commitRepair(chunk) {
    try {
      this.live();
      digest("repair", chunk);
      nonempty(chunk.chunkId);
      nonempty(chunk.episode.episodeId);
      safe2(chunk.expectedRevision);
      const key = paneKey2(chunk.episode.pane);
      const old = this.db.query("SELECT digest,receipt FROM sh_repair WHERE pane=? AND episode=? AND chunk=?").get(key, chunk.episode.episodeId, chunk.chunkId);
      if (old) {
        if (old.digest !== chunk.digest)
          throw Error("repair identity collision");
        return ok3(JSON.parse(String(old.receipt)));
      }
      const state = this.state(chunk.episode.pane);
      if (!state)
        return stale();
      if (state.revision !== chunk.expectedRevision || this.pending.has(key))
        return stale();
      if (!state.gap || state.gap.episodeId !== chunk.episode.episodeId || !state.checkpoint)
        return { status: "error", code: "unresolved-gap", message: "repair requires fenced episode and VT recovery checkpoint" };
      if (state.gap.reason === "late-gap" || chunk.episode.reason === "late-gap")
        return stale("late-gap");
      if (chunk.episode.epochBefore !== state.gap.epochBefore || chunk.episode.epochAfter !== state.gap.epochAfter || chunk.episode.lastAdmittedRow !== state.gap.lastAdmittedRow || typeof chunk.final !== "boolean")
        throw Error("repair episode mismatch");
      if (this.db.query("SELECT 1 FROM sh_repair WHERE pane=? AND episode=? AND json_extract(receipt,'$.finalChunk')=1 LIMIT 1").get(key, chunk.episode.episodeId))
        throw Error("repair rows already sealed");
      const revision = state.revision + 1;
      this.validateRows(chunk.rows, state, revision);
      const n = bytes(chunk) * 4;
      if (pool.pending + n > STREAM_BUDGET.pendingBytes)
        return busy2();
      const durable = {
        kind: "durable",
        pane: chunk.episode.pane,
        commitId: streamDigest("repair-id", { pane: chunk.episode.pane, episode: chunk.episode.episodeId, chunk: chunk.chunkId }),
        digest: chunk.digest,
        durableRevision: revision,
        checkpointId: state.checkpoint
      };
      const receipt = { committedIds: chunk.rows.map((r) => r.id), committedRevision: revision, durable, complete: false, finalChunk: chunk.final };
      pool.pending += n;
      try {
        this.transaction("repair", () => {
          this.writeRows(chunk.rows);
          this.db.query("INSERT INTO sh_repair VALUES(?,?,?,?,?)").run(key, chunk.episode.episodeId, chunk.chunkId, chunk.digest, streamCanonical2(receipt));
          this.db.query("INSERT INTO sh_commit VALUES(?,?,?,?,?)").run(key, durable.commitId, durable.digest, streamCanonical2(durable), durable.durableRevision);
          this.putState({ ...state, revision, durable: revision, head: state.head + chunk.rows.length, gap: state.gap });
        });
      } finally {
        pool.pending -= n;
      }
      return ok3(receipt);
    } catch (e) {
      return fail(e);
    }
  }
  readRow(db, pane, line) {
    return readStoredRow(db, pane, line);
  }
  readSlot(pane) {
    return paneKey2(pane);
  }
  reader(pane) {
    const slot = this.readSlot(pane);
    if (pool.readers >= STREAM_BUDGET.activeReadsGlobal || pool.panes.has(slot) || pool.cache + READER_CACHE > STREAM_BUDGET.diskCacheBytes)
      return null;
    const db = new Database4(this.options.path, { readonly: true, strict: true });
    try {
      db.exec("PRAGMA cache_size=-2048; PRAGMA mmap_size=0; PRAGMA busy_timeout=0; PRAGMA query_only=ON; BEGIN;");
    } catch (e) {
      db.close();
      throw e;
    }
    pool.readers++;
    pool.cache += READER_CACHE;
    pool.panes.add(slot);
    this.readers.set(db, pane);
    return db;
  }
  closeReader(db, pane) {
    if (!this.readers.delete(db))
      return;
    try {
      db.exec("ROLLBACK");
    } finally {
      try {
        db.close();
      } finally {
        pool.readers--;
        pool.cache -= READER_CACHE;
        pool.panes.delete(this.readSlot(pane));
      }
    }
  }
  async grantReadView(request) {
    let db = null;
    try {
      this.live();
      identity(request.identity);
      nonempty(request.requestId);
      safe2(request.routeGeneration);
      safe2(request.range.start);
      safe2(request.range.end);
      if (!Number.isFinite(request.deadlineMonoMs) || request.deadlineMonoMs <= performance.now())
        return { status: "error", code: "deadline", message: "read deadline expired" };
      const state = this.state(request.identity.pane);
      if (!state)
        return stale();
      const mismatch = this.match(state, request.identity);
      if (mismatch)
        return mismatch;
      if (state.gap?.reason === "late-gap")
        return stale("late-gap");
      if (this.options.stagePrefixesOnDisk && state.revision !== state.durable)
        return busy2();
      if (request.range.start > request.range.end || request.range.end > state.head)
        throw Error("range outside frozen head");
      if (this.pins.has(request.requestId))
        return stale("route");
      const overlay = new Map;
      let charge = 0;
      for (const event of this.pending.get(paneKey2(request.identity.pane))?.events.values() ?? []) {
        for (const row of event.request.rows)
          if (row.id.lineId >= request.range.start && row.id.lineId < request.range.end) {
            charge += bytes(row) * 4;
            if (charge > STREAM_BUDGET.pageBytesPerViewer || pool.overlays + charge > STREAM_BUDGET.pagePoolBytes)
              return busy2();
            overlay.set(row.id.lineId, row);
          }
      }
      db = this.reader(request.identity.pane);
      if (!db)
        return { status: "busy", reason: "queue", retryAfterMs: 20 };
      const disk = this.state(request.identity.pane, db);
      if (!disk)
        throw Error("missing snapshot pane");
      const view = copy({
        ...request,
        grantRevision: state.revision,
        durableAtGrant: state.durable,
        headAtGrant: state.head,
        overlayHandle: randomUUID3()
      });
      const ack = copy({ view, diskSnapshotRevision: disk.durable, snapshotHandle: randomUUID3() });
      if (!validReadOpen(ack))
        throw Error("read fence violation");
      const timer = setTimeout(() => {
        this.releasePin(view.requestId);
      }, Math.min(STREAM_BUDGET.readDeadlineMs, request.deadlineMonoMs - performance.now()));
      this.recoveryTimers.add(timer);
      timer.unref?.();
      this.pins.set(view.requestId, { view, db, overlay, charge, ack, opened: false, timer });
      pool.overlays += charge;
      db = null;
      return ok3(view);
    } catch (e) {
      return fail(e);
    } finally {
      if (db)
        this.closeReader(db, request.identity.pane);
    }
  }
  releasePin(requestId) {
    const pin = this.pins.get(requestId);
    if (!pin)
      return;
    this.pins.delete(requestId);
    clearTimeout(pin.timer);
    pool.overlays -= pin.charge;
    this.closeReader(pin.db, pin.view.identity.pane);
  }
  async openReadView(view) {
    try {
      this.live();
      const pin = this.pins.get(view.requestId);
      if (!pin || !equal(pin.view, view))
        return stale("route");
      if (performance.now() >= view.deadlineMonoMs) {
        this.releasePin(view.requestId);
        return { status: "error", code: "deadline", message: "read deadline expired" };
      }
      const state = this.state(view.identity.pane);
      const mismatch = state ? this.match(state, view.identity) : stale();
      if (mismatch) {
        this.releasePin(view.requestId);
        return mismatch;
      }
      pin.opened = true;
      return ok3(pin.ack);
    } catch (e) {
      this.releasePin(view.requestId);
      return fail(e);
    }
  }
  async readPage(ack, cursor, limit, cancel) {
    const id = ack.view.requestId;
    try {
      this.live();
      const pin = this.pins.get(id);
      if (!pin || !pin.opened || !equal(ack, pin.ack))
        return stale("route");
      if (cancel.isCancelled()) {
        this.releasePin(id);
        return { status: "cancelled", reason: "reader cancelled" };
      }
      if (performance.now() >= pin.view.deadlineMonoMs) {
        this.releasePin(id);
        return { status: "error", code: "deadline", message: "read deadline expired" };
      }
      const state = this.state(pin.view.identity.pane);
      const mismatch = state ? this.match(state, pin.view.identity) : stale();
      if (mismatch) {
        this.releasePin(id);
        return mismatch;
      }
      safe2(limit);
      if (!limit || limit > STREAM_BUDGET.maxPageRows)
        throw Error("page row limit");
      const view = pin.view, { start, end } = view.range;
      if (cursor && (cursor.requestId !== id || !["before", "after"].includes(cursor.direction)))
        throw Error("cursor identity");
      let line = cursor?.lineId ?? start, offset = cursor?.cellOffset ?? 0;
      safe2(line);
      safe2(offset);
      if (line < start || line > end || line === end && offset)
        throw Error("cursor outside view");
      const before = cursor?.direction === "before";
      if (before && offset === 0) {
        line--;
        offset = -1;
      }
      const fragments = [];
      let payloadBytes = 0;
      while (line >= start && line < end && fragments.length < Math.min(limit, STREAM_BUDGET.decodeRows)) {
        if (cancel.isCancelled()) {
          this.releasePin(id);
          return { status: "cancelled", reason: "reader cancelled" };
        }
        if (performance.now() >= view.deadlineMonoMs) {
          this.releasePin(id);
          return { status: "error", code: "deadline", message: "page deadline expired" };
        }
        const overlay = pin.overlay.get(line);
        let row;
        if (overlay) {
          const diskMeta = pin.db.query("SELECT revision,digest FROM sh_row WHERE pane=? AND line=?").get(paneKey2(view.identity.pane), line);
          if (diskMeta && Number(diskMeta.revision) === overlay.revision && diskMeta.digest !== streamDigest("row", overlay))
            throw Error("equal revision with divergent bytes");
          row = !diskMeta || Number(diskMeta.revision) <= overlay.revision ? overlay : this.readRow(pin.db, view.identity.pane, line);
        } else
          row = this.readRow(pin.db, view.identity.pane, line);
        if (row.revision > view.grantRevision)
          throw Error("row newer than frozen view");
        if (offset > row.cells.length)
          throw Error("cursor cell offset outside row");
        if (!before && offset === row.cells.length && row.cells.length) {
          line++;
          offset = 0;
          continue;
        }
        let lo = before ? offset === -1 ? row.cells.length : offset : offset;
        let hi = lo;
        const { cells, ...meta } = row;
        let used = bytes(meta) + 128;
        if (before) {
          while (lo > 0 && payloadBytes + used + bytes(cells[lo - 1]) + 1 <= STREAM_BUDGET.decodeBytes) {
            used += bytes(cells[--lo]) + 1;
          }
        } else {
          while (hi < cells.length && payloadBytes + used + bytes(cells[hi]) + 1 <= STREAM_BUDGET.decodeBytes) {
            used += bytes(cells[hi++]) + 1;
          }
        }
        if (hi === lo && cells.length || payloadBytes + used > STREAM_BUDGET.decodeBytes)
          break;
        const fragment = { row: { ...meta, cells: cells.slice(lo, hi) }, startCell: lo, endCell: hi, complete: lo === 0 && hi === cells.length };
        const encoded = bytes(fragment);
        if (payloadBytes + encoded > STREAM_BUDGET.decodeBytes)
          break;
        payloadBytes += encoded;
        if (before)
          fragments.unshift(fragment);
        else
          fragments.push(fragment);
        if (before) {
          if (lo > 0)
            break;
          line--;
          offset = -1;
        } else {
          if (hi < cells.length)
            break;
          line++;
          offset = 0;
        }
      }
      if (!fragments.length && line >= start && line < end)
        throw Error("no progress within page byte budget");
      const first = fragments[0], last = fragments.at(-1);
      const left = first ? { lineId: first.row.id.lineId, cellOffset: first.startCell } : { lineId: cursor?.lineId ?? start, cellOffset: cursor?.cellOffset ?? 0 };
      let right = last ? { lineId: last.row.id.lineId, cellOffset: last.endCell } : left;
      if (last) {
        const total = pin.overlay.get(last.row.id.lineId)?.cells.length ?? Number(pin.db.query("SELECT cell_count FROM sh_row WHERE pane=? AND line=?").get(paneKey2(view.identity.pane), last.row.id.lineId).cell_count);
        if (last.endCell === total)
          right = { lineId: last.row.id.lineId + 1, cellOffset: 0 };
      }
      const hasMoreBefore = left.lineId > start || left.cellOffset > 0;
      const hasMoreAfter = right.lineId < end;
      return ok3({
        view,
        fragments,
        payloadBytes,
        hasMoreBefore,
        hasMoreAfter,
        nextBefore: hasMoreBefore ? { ...left, requestId: id, direction: "before" } : null,
        nextAfter: hasMoreAfter ? { ...right, requestId: id, direction: "after" } : null
      });
    } catch (e) {
      this.releasePin(id);
      return fail(e);
    }
  }
  async releaseReadView(view, _reason) {
    const pin = this.pins.get(view.requestId);
    if (pin && equal(pin.view, view))
      this.releasePin(view.requestId);
  }
  recoveryTimers = new Set;
  async* recover(pane, checkpointId, cancel) {
    let db = null, timer = null;
    let expired = false, cancelled2 = false;
    try {
      this.live();
      paneKey2(pane);
      db = this.reader(pane);
      if (!db) {
        yield { status: "busy", reason: "queue", retryAfterMs: 20 };
        return;
      }
      const reader = db;
      const deadline2 = performance.now() + STREAM_BUDGET.recoveryMs;
      timer = setInterval(() => {
        cancelled2 = cancel.isCancelled();
        expired = performance.now() >= deadline2;
        if (cancelled2 || expired || this.closed) {
          if (db) {
            this.closeReader(db, pane);
            db = null;
          }
          if (timer) {
            clearInterval(timer);
            this.recoveryTimers.delete(timer);
            timer = null;
          }
        }
      }, 50);
      this.recoveryTimers.add(timer);
      timer.unref?.();
      const state = this.state(pane, reader);
      if (!state) {
        yield stale();
        return;
      }
      const key = paneKey2(pane), cpId = checkpointId ?? state.checkpoint;
      let epoch = 0, seq = 0, head = 0;
      if (cpId) {
        const stored = reader.query("SELECT payload,checksum FROM sh_checkpoint WHERE pane=? AND id=?").get(key, cpId);
        if (!stored)
          throw Error("checkpoint not found");
        if (Buffer.byteLength(String(stored.payload)) > STREAM_BUDGET.vtBytesPerPane)
          throw Error("checkpoint exceeds budget");
        const cp = JSON.parse(String(stored.payload));
        if (stored.checksum !== streamDigest("vt-checkpoint", cp) || cp.head > state.head || cp.revision > state.durable)
          throw Error("checkpoint envelope integrity");
        const fence = reader.query("SELECT receipt FROM sh_input WHERE pane=? AND epoch=? AND seq=?").get(key, cp.inputFence.through.sourceEpoch, cp.inputFence.through.packetSeq);
        if (!fence || !equal(JSON.parse(String(fence.receipt)), cp.inputFence))
          throw Error("recovery input fence integrity");
        if (!this.options.codecVersions.includes(cp.state.codecVersion)) {
          yield { status: "error", code: "unsupported", message: "VT codec is not admitted" };
          return;
        }
        if (!equal(cp.identity.pane, pane) || cp.stateDigest !== streamDigest("vt-state", { identity: cp.identity, state: cp.state }))
          throw Error("checkpoint integrity");
        epoch = cp.inputFence.through.sourceEpoch;
        seq = cp.inputFence.through.packetSeq;
        head = cp.head;
        if (cancelled2 || cancel.isCancelled()) {
          yield { status: "cancelled", reason: "recovery cancelled" };
          return;
        }
        yield ok3({ kind: "checkpoint", checkpoint: cp });
      }
      while (head < state.head) {
        if (expired) {
          yield { status: "error", code: "deadline", message: "recovery deadline" };
          return;
        }
        if (cancelled2 || cancel.isCancelled()) {
          yield { status: "cancelled", reason: "recovery cancelled" };
          return;
        }
        const row = this.readRow(reader, pane, head++);
        const receiptRow = reader.query("SELECT receipt FROM sh_commit WHERE pane=? AND revision>=? ORDER BY revision LIMIT 1").get(key, row.revision);
        if (!receiptRow)
          throw Error("row without durable receipt");
        yield ok3({ kind: "rows", rows: [row], receipt: JSON.parse(String(receiptRow.receipt)) });
      }
      while (true) {
        if (expired) {
          yield { status: "error", code: "deadline", message: "recovery deadline" };
          return;
        }
        if (cancelled2 || cancel.isCancelled()) {
          yield { status: "cancelled", reason: "recovery cancelled" };
          return;
        }
        const stored = reader.query("SELECT * FROM sh_input WHERE pane=? AND (epoch>? OR (epoch=? AND seq>?)) ORDER BY epoch,seq LIMIT 1").get(key, epoch, epoch, seq);
        if (!stored)
          break;
        if (Buffer.byteLength(String(stored.payload)) > STREAM_BUDGET.rawBytesPerPane)
          throw Error("journal record exceeds budget");
        const event = JSON.parse(String(stored.payload));
        digest("input", event);
        if (stored.digest !== event.digest || !equal(event.identity.pane, pane) || Number(stored.epoch) !== event.position.sourceEpoch || Number(stored.seq) !== event.position.packetSeq)
          throw Error("journal integrity");
        const newEpoch = Number(stored.epoch), newSeq = Number(stored.seq);
        if (newSeq !== (newEpoch === epoch ? seq + 1 : 1))
          throw Error("journal sequence hole");
        epoch = newEpoch;
        seq = newSeq;
        yield ok3({ kind: "input", event });
      }
    } catch (e) {
      yield fail(e);
    } finally {
      if (timer) {
        clearInterval(timer);
        this.recoveryTimers.delete(timer);
      }
      if (db)
        this.closeReader(db, pane);
    }
  }
  stats() {
    return {
      recoveryTimers: this.recoveryTimers.size,
      pendingBytes: pool.pending,
      ownedPendingBytes: this.ownPending,
      overlayBytes: pool.overlays,
      activeReads: pool.readers,
      pins: this.readers.size,
      diskCacheConfigBytes: pool.cache
    };
  }
  close() {
    if (this.closed)
      return { undurableBytes: 0 };
    if (this.options.stagePrefixesOnDisk && this.db.query("SELECT 1 FROM sh_pane WHERE revision != durable LIMIT 1").get())
      throw Error("stream close refused: staged packet lacks final checkpoint");
    const undurableBytes = this.ownPending;
    for (const timer of this.recoveryTimers)
      clearInterval(timer);
    this.recoveryTimers.clear();
    for (const id of [...this.pins.keys()])
      this.releasePin(id);
    for (const [db, pane] of this.readers)
      this.closeReader(db, pane);
    this.db.close();
    this.closed = true;
    pool.cache -= WRITER_CACHE;
    pool.paths.delete(this.options.path);
    for (const key of [...this.pending.keys()])
      this.dropPending(key);
    return { undurableBytes };
  }
}
var FLAGON_HISTORY_SCHEMA = `
CREATE TABLE fh_meta(version INTEGER NOT NULL CHECK(version=1), uuid TEXT NOT NULL);
CREATE TABLE fh_pane(pane TEXT PRIMARY KEY, generation INTEGER NOT NULL, active_epoch TEXT) STRICT;
CREATE TABLE fh_segment(id TEXT PRIMARY KEY, pane TEXT NOT NULL, state TEXT NOT NULL,
 bytes INTEGER NOT NULL DEFAULT 0, next_row INTEGER NOT NULL DEFAULT 0, sealed TEXT, remote TEXT) STRICT;
CREATE TABLE fh_epoch(epoch TEXT PRIMARY KEY, pane TEXT NOT NULL, offset INTEGER NOT NULL,
 sequence INTEGER NOT NULL, digest TEXT NOT NULL, segment TEXT NOT NULL) STRICT;
CREATE TABLE fh_event(seq INTEGER PRIMARY KEY AUTOINCREMENT, pane TEXT NOT NULL, segment TEXT NOT NULL,
 kind TEXT NOT NULL, op TEXT NOT NULL UNIQUE, digest TEXT NOT NULL, payload TEXT NOT NULL,
 receipt TEXT NOT NULL, checksum TEXT NOT NULL) STRICT;
CREATE INDEX fh_event_pane ON fh_event(pane,seq);
CREATE INDEX fh_event_segment ON fh_event(segment,seq);
CREATE INDEX fh_input_cursor ON fh_event(pane,kind,json_extract(payload,'$.range.epoch.attachId'),
 json_extract(payload,'$.range.epoch.collectorIncarnation'),json_extract(payload,'$.range.end'));
CREATE TABLE fh_row_id(pane TEXT NOT NULL, segment TEXT NOT NULL, ordinal INTEGER NOT NULL,
 PRIMARY KEY(pane,segment,ordinal)) WITHOUT ROWID;
CREATE TABLE fh_pin(id TEXT PRIMARY KEY, operation TEXT NOT NULL UNIQUE, segment TEXT NOT NULL,
 payload TEXT NOT NULL, released INTEGER NOT NULL DEFAULT 0) STRICT;
CREATE TABLE fh_checkpoint(id TEXT PRIMARY KEY, pane TEXT NOT NULL, segment TEXT NOT NULL,
 ack TEXT NOT NULL, payload TEXT NOT NULL, checksum TEXT NOT NULL) STRICT;
`;
var V2_STORE = Symbol("capture-engine-only");
var V2_PROFILE_FENCE = Symbol("v2-storage-profile-fence");
var FH_RECORD_MAX = STREAM_BUDGET.decodeBytes;
var FH_SEGMENT_MAX = FLAGON_BUDGET.archiveChunkBytes / 2;
var fhPaths = new Set;
var fhReaders = new Set;
function fhAssert(test, message) {
  if (!test)
    throw Error(message);
}
function* fhRows(db, sql, ...params) {
  const statement = db.prepare(sql);
  try {
    yield* statement.iterate(...params);
  } finally {
    statement.finalize();
  }
}
function fhSafePath(path) {
  let current = sep2;
  for (const part of resolve3(path).split(sep2).filter(Boolean)) {
    fhAssert(!/^brain\.db(?:$|[-.])/i.test(part), "forbidden database path");
    current = join3(current, part);
    if (!existsSync3(current)) {
      try {
        fhAssert(!lstatSync3(current).isSymbolicLink(), "unsafe symlink");
      } catch (e) {
        if (e.code !== "ENOENT")
          throw e;
      }
      continue;
    }
    const st = lstatSync3(current);
    fhAssert(!st.isSymbolicLink() && (st.isDirectory() || st.isFile() && st.nlink === 1), "unsafe history path");
  }
}
function fhSyncDir(path) {
  const fd = openSync4(path, "r");
  try {
    fsyncSync2(fd);
  } finally {
    closeSync4(fd);
  }
}
function fhEvidence(path) {
  fhSafePath(path);
  const fd = openSync4(path, "r"), hash = createHash6("sha256"), buffer = Buffer.alloc(64 * 1024);
  let total = 0;
  try {
    for (;; ) {
      const n = readSync3(fd, buffer, 0, buffer.length, null);
      if (!n)
        break;
      hash.update(buffer.subarray(0, n));
      total += n;
    }
  } finally {
    closeSync4(fd);
  }
  return { path, bytes: total, sha256: hash.digest("hex") };
}
function fhWrite(fd, text) {
  const buffer = Buffer.from(text);
  let offset = 0;
  while (offset < buffer.length) {
    const n = writeSync2(fd, buffer, offset);
    fhAssert(n > 0, "short write");
    offset += n;
  }
}

class FlagOnHistoryStore {
  options;
  db;
  writerLock;
  root;
  storeUUID;
  closed = false;
  replayReleases = new Set;
  constructor(options) {
    this.options = options;
    this.root = resolve3(options.root);
    fhSafePath(this.root);
    fhAssert(!fhPaths.has(this.root), "one flag-on writer per root");
    fhAssert((fhPaths.size + 1) * (2 * 1024 * 1024 + 64 * 1024) <= STREAM_BUDGET.diskCacheBytes, "flag-on SQLite cache pool pressure");
    const path = join3(this.root, "flag-on-v1.sqlite");
    for (const p of [path, path + "-wal", path + "-shm", path + "-journal"])
      fhSafePath(p);
    fhAssert(options.mode === "create" ? !existsSync3(path) : existsSync3(path), "explicit create/recover required");
    mkdirSync2(this.root, { recursive: true, mode: 448 });
    const lockPath = join3(this.root, "flag-on-writer.sqlite");
    for (const p of [lockPath, lockPath + "-journal", lockPath + "-wal", lockPath + "-shm"])
      fhSafePath(p);
    const writerLock = new Database4(lockPath, { create: true, strict: true });
    let db;
    try {
      writerLock.exec("PRAGMA busy_timeout=0; PRAGMA cache_size=-64; PRAGMA mmap_size=0; PRAGMA journal_mode=DELETE; PRAGMA locking_mode=EXCLUSIVE; CREATE TABLE IF NOT EXISTS fh_lock(id INTEGER PRIMARY KEY); BEGIN EXCLUSIVE; COMMIT;");
      chmodSync(lockPath, 384);
      db = new Database4(path, { create: options.mode === "create", strict: true });
      if (options.mode === "create") {
        db.exec("PRAGMA auto_vacuum=INCREMENTAL;");
        db.transaction(() => {
          db.exec(FLAGON_HISTORY_SCHEMA);
          if (options[V2_STORE]) {
            db.exec(V2_SCHEMA);
            db.query("INSERT INTO fh_v2_meta VALUES(1,0,?,?)").run(randomUUID3(), "newarch-v2");
          }
          db.query("INSERT INTO fh_meta VALUES(1,?)").run(randomUUID3());
        }).immediate();
      }
      const hasV2 = !!db.query("SELECT 1 FROM sqlite_master WHERE name='fh_v2_meta'").get();
      fhAssert(options[V2_STORE] ? options.mode === "create" || hasV2 : !hasV2, "v2 owner excludes legacy storage API");
      if (hasV2)
        for (const table of ["fh_v2_meta", "fh_v2_object", "fh_v2_pane", "fh_v2_timeline"])
          fhAssert(db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table), "v2 incomplete owner/schema store");
      const meta = db.query("SELECT * FROM fh_meta").get();
      fhAssert(meta?.version === 1 && typeof meta.uuid === "string", "unsupported flag-on format");
      fhAssert(db.query("PRAGMA quick_check").get().quick_check === "ok", "corrupt history database");
      options[V2_PROFILE_FENCE]?.(db);
      db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA cache_size=-2048; PRAGMA mmap_size=0; PRAGMA temp_store=FILE; PRAGMA busy_timeout=0; PRAGMA journal_size_limit=0;");
      db.exec(`PRAGMA max_page_count=${Math.floor((FLAGON_BUDGET.canaryRootCapBytes - FLAGON_BUDGET.reserveBytes - FLAGON_BUDGET.scratchBytes) / 4096)};`);
      db.query("DELETE FROM fh_pin WHERE payload='replay'").run();
      db.exec(`CREATE TABLE IF NOT EXISTS fh_r2(kind TEXT NOT NULL,id TEXT NOT NULL,pane TEXT NOT NULL,payload TEXT NOT NULL,checksum TEXT NOT NULL,PRIMARY KEY(kind,id)) WITHOUT ROWID;
        CREATE INDEX IF NOT EXISTS fh_r2_pane ON fh_r2(kind,pane);
        CREATE TABLE IF NOT EXISTS fh_timeline(pane TEXT NOT NULL,n INTEGER NOT NULL,segment TEXT NOT NULL,op TEXT NOT NULL,item INTEGER NOT NULL,kind TEXT NOT NULL,ordinal INTEGER,PRIMARY KEY(pane,n),UNIQUE(op,item)) WITHOUT ROWID;
        CREATE INDEX IF NOT EXISTS fh_timeline_segment ON fh_timeline(segment);
        CREATE INDEX IF NOT EXISTS fh_timeline_op ON fh_timeline(op);`);
      this.db = db;
      this.writerLock = writerLock;
      this.storeUUID = meta.uuid;
      this.migrateIndex();
      chmodSync(path, 384);
      fhSyncDir(this.root);
      fhSyncDir(dirname2(this.root));
      fhPaths.add(this.root);
    } catch (error2) {
      db?.close();
      writerLock.close();
      throw error2;
    }
  }
  close() {
    if (!this.closed) {
      for (const release of this.replayReleases)
        release();
      this.db.close();
      this.writerLock.close();
      this.closed = true;
      fhPaths.delete(this.root);
    }
  }
  live() {
    fhAssert(!this.closed, "flag-on store closed");
    fhAssert(!this.options[V2_STORE], "v2 requires capture capability");
  }
  openV2(key, request, hooks) {
    fhAssert(key === V2_STORE && this.options[V2_STORE] && !this.closed, "v2 factory only");
    return new V2Storage(this.db, this.root, this.storeUUID, request, hooks, () => this.close()).ports();
  }
  tx(kind, fn) {
    this.live();
    this.options.boundary?.(kind + "-before-write");
    const result = this.db.transaction(() => {
      const value = fn();
      this.options.boundary?.(kind + "-before-commit");
      return value;
    }).immediate();
    this.options.boundary?.(kind + "-after-commit");
    return result;
  }
  setGeneration(pane, expected, next) {
    const key = paneKey2(pane);
    safe2(next);
    if (expected !== null)
      safe2(expected);
    this.tx("generation", () => {
      const old = this.db.query("SELECT generation FROM fh_pane WHERE pane=?").get(key);
      fhAssert(!this.db.query("SELECT 1 FROM fh_segment WHERE pane=? AND state='reclaiming'").get(key), "reclaim in progress");
      fhAssert(old ? old.generation === expected && next > Number(old.generation) : expected === null, "owner generation CAS");
      if (old)
        this.db.query("UPDATE fh_pane SET generation=? WHERE pane=?").run(next, key);
      else
        this.db.query("INSERT INTO fh_pane VALUES(?,?,NULL)").run(key, next);
    });
  }
  fence(r) {
    nonempty(r.operationId);
    safe2(r.expectedGeneration);
    const key = paneKey2(r.pane);
    const state = this.db.query("SELECT generation FROM fh_pane WHERE pane=?").get(key);
    fhAssert(state?.generation === r.expectedGeneration, "owner generation mismatch");
    return key;
  }
  segment(id, pane) {
    nonempty(id);
    const s = this.db.query("SELECT * FROM fh_segment WHERE id=?").get(id);
    fhAssert(s && s.pane === paneKey2(pane), "segment identity mismatch");
    return s;
  }
  event(op) {
    return this.db.query("SELECT * FROM fh_event WHERE op=?").get(op);
  }
  checkEvent(e) {
    fhAssert(e.checksum === streamDigest("flag-on-event", { kind: e.kind, op: e.op, digest: e.digest, payload: e.payload, receipt: e.receipt, segment: e.segment, pane: e.pane }), "corrupt durable event");
  }
  putEvent(pane, segment, kind, op, hash, payload, receipt, encoded) {
    const p = encoded ?? streamCanonical2(payload), r = streamCanonical2(receipt);
    const size2 = Buffer.byteLength(p) + Buffer.byteLength(r);
    fhAssert(size2 <= FH_RECORD_MAX * 2, "record exceeds bounded decode");
    const s = this.db.query("SELECT bytes,state FROM fh_segment WHERE id=?").get(segment);
    fhAssert(s.state === "open" && Number(s.bytes) + size2 <= FH_SEGMENT_MAX, "segment full or sealed; seal and rotate");
    const checksum = streamDigest("flag-on-event", { kind, op, digest: hash, payload: p, receipt: r, segment, pane });
    this.db.query("INSERT INTO fh_event(pane,segment,kind,op,digest,payload,receipt,checksum) VALUES(?,?,?,?,?,?,?,?)").run(pane, segment, kind, op, hash, p, r, checksum);
    this.db.query("UPDATE fh_segment SET bytes=bytes+? WHERE id=?").run(size2, segment);
  }
  acknowledged(ack, pane) {
    fhAssert(ack.kind === "synced-spool" && ack.version === 1 && equal(ack.through.epoch.pane, pane), "ACK identity");
    const event = this.db.query("SELECT * FROM fh_event WHERE op=? AND kind='input'").get(ack.commitId);
    if (event)
      this.checkEvent(event);
    const durable = event ? JSON.parse(String(event.receipt)) : this.load("ack", ack.commitId);
    fhAssert(durable, "ACK not durable in this store");
    fhAssert(equal(durable, ack), "forged ACK");
  }
  async appendInput(record) {
    return this.appendRecord(record);
  }
  appendRecord(record) {
    try {
      this.live();
      nonempty(record.operationId);
      fhAssert(record.version === 1, "unsupported spool version");
      const range = record.range, key = paneKey2(range.epoch.pane), epoch = streamCanonical2(range.epoch);
      nonempty(range.epoch.attachId);
      nonempty(range.epoch.collectorIncarnation);
      [range.start, range.end, record.sequence].forEach(safe2);
      fhAssert(range.end >= range.start, "raw range order");
      if (record.payload.kind === "bytes") {
        fhAssert(record.payload.bytes.length <= FLAGON_BUDGET.rawBytesPerPane && range.end - range.start === record.payload.bytes.length, "raw payload bound");
        fhAssert(record.payload.bytes.every((n) => Number.isInteger(n) && n >= 0 && n <= 255), "invalid byte");
      } else {
        fhAssert(range.start === range.end, "control consumes no raw bytes");
        if (record.payload.kind === "resize")
          geometry(record.payload.geometry);
        else
          fhAssert(record.payload.kind === "control" && typeof record.payload.data === "string", "invalid control");
      }
      const encoded = streamCanonical2(record), recordBytes = Buffer.byteLength(encoded);
      fhAssert(recordBytes <= FH_RECORD_MAX, "raw encoded record bound");
      digest("spool", record);
      return ok3(this.tx("input", () => {
        const prior = this.event(record.operationId);
        if (prior) {
          this.checkEvent(prior);
          fhAssert(prior.kind === "input" && prior.digest === record.digest, "operation collision");
          return JSON.parse(String(prior.receipt));
        }
        const retained = this.load("ack", record.operationId);
        if (retained) {
          fhAssert(retained.recordDigest === record.digest, "operation collision after reclaim");
          return retained;
        }
        const pane = this.db.query("SELECT * FROM fh_pane WHERE pane=?").get(key);
        fhAssert(pane, "pane generation not registered");
        const last = this.db.query("SELECT * FROM fh_epoch WHERE epoch=?").get(epoch);
        fhAssert(!last || pane.active_epoch === epoch, "stale pipe epoch");
        fhAssert(last ? last.offset === range.start && Number(last.sequence) + 1 === record.sequence && last.digest === record.previousDigest : range.start === 0 && record.sequence === 0 && record.previousDigest === null, "raw sequence/offset/digest discontinuity");
        let segmentId = last ? String(last.segment) : streamDigest("flag-on-segment", { epoch, first: record.operationId });
        if (last && this.segment(segmentId, range.epoch.pane).state !== "open")
          segmentId = this.rotate({ operationId: "resume-rotate:" + record.operationId, pane: range.epoch.pane, expectedGeneration: Number(pane.generation), segmentId, boundary: { epoch: range.epoch, byteOffset: range.start } }).successor;
        this.db.query("INSERT OR IGNORE INTO fh_segment(id,pane,state) VALUES(?,?,'open')").run(segmentId, key);
        const current = this.segment(segmentId, range.epoch.pane);
        if (Number(current.bytes) + recordBytes + 2048 > FH_SEGMENT_MAX && last) {
          segmentId = this.rotate({ operationId: "auto-rotate:" + record.operationId, pane: range.epoch.pane, expectedGeneration: Number(pane.generation), segmentId, boundary: { epoch: range.epoch, byteOffset: range.start } }).successor;
        }
        const ack = { kind: "synced-spool", version: 1, through: { epoch: range.epoch, byteOffset: range.end }, recordDigest: record.digest, commitId: record.operationId, segmentId };
        this.putEvent(key, segmentId, "input", record.operationId, record.digest, record, ack, encoded);
        this.save("ack", record.operationId, key, ack);
        this.db.query("INSERT OR REPLACE INTO fh_epoch VALUES(?,?,?,?,?,?)").run(epoch, key, range.end, record.sequence, record.digest, segmentId);
        this.db.query("UPDATE fh_pane SET active_epoch=? WHERE pane=?").run(epoch, key);
        return ack;
      }));
    } catch (e) {
      return fail(e);
    }
  }
  async commitRowsAndGaps(r) {
    return this.commitRows(r);
  }
  commitRows(r, staged) {
    try {
      fhAssert(r.rows.length <= STREAM_BUDGET.decodeRows && bytes(r) <= FH_RECORD_MAX, "rows batch bound");
      digest("rows-gaps", r);
      return ok3(this.tx("rows", () => {
        const key = this.fence(r), old = this.event(r.operationId);
        if (old) {
          this.checkEvent(old);
          fhAssert(old.kind === (staged ? "candidate" : "committed") && old.digest === r.digest, "operation collision");
          return JSON.parse(String(old.receipt));
        }
        const retained = this.load("receipt", r.operationId);
        if (retained) {
          fhAssert(retained.digest === r.digest, "operation collision after reclaim");
          return retained;
        }
        this.acknowledged(r.inputAck, r.pane);
        const target = r.rows[0]?.id.segmentId ?? r.coverage.find((c) => c.kind === "rows")?.range.segmentId ?? this.db.query("SELECT segment FROM fh_epoch WHERE epoch=?").get(streamCanonical2(r.inputAck.through.epoch))?.segment;
        const segment = this.segment(String(target ?? r.inputAck.segmentId), r.pane);
        if (segment.id !== r.inputAck.segmentId) {
          let id = String(segment.id), hops = 0;
          while (id !== r.inputAck.segmentId) {
            fhAssert(++hops <= 4096, "continuity metadata bound");
            const link = this.load("successor", id);
            fhAssert(link && equal(link.epoch, r.inputAck.through.epoch) && link.boundary.byteOffset >= r.inputAck.through.byteOffset, "row successor has no continuity");
            id = link.predecessor;
          }
        }
        fhAssert(segment.state === "open", "sealed segment is immutable");
        if (r.checkpointId !== null) {
          const cp = this.db.query("SELECT * FROM fh_checkpoint WHERE id=?").get(r.checkpointId);
          fhAssert(cp && cp.pane === key, "checkpoint missing or outside segment");
          const cpAck = JSON.parse(String(cp.ack));
          fhAssert(equal(cpAck.through.epoch, r.inputAck.through.epoch) && cpAck.through.byteOffset <= r.inputAck.through.byteOffset && cp.checksum === streamDigest("checkpoint-payload", JSON.parse(String(cp.payload))), "checkpoint reference integrity");
        }
        let ordinal = Number(segment.next_row);
        for (const row of r.rows) {
          fhAssert(equal(row.id.pane, r.pane) && row.id.segmentId === segment.id && row.id.rowOrdinal === ordinal++, "row identity/order");
          row.cells.forEach(cellToSemanticCell);
          geometry(row.geometry);
          content({ cells: row.cells, softWrap: row.wrapStatus === "wrapped", wrapPad: row.wrapPad, uncertainFields: row.uncertainFields });
          fhAssert(row.finalized && row.uncertainFields.length === 0, "unverified row");
          if (row.origin.kind === "pipe") {
            [row.origin.range.start, row.origin.range.end, row.origin.ordinal].forEach(safe2);
            fhAssert(equal(row.origin.range.epoch, r.inputAck.through.epoch) && row.origin.range.end >= row.origin.range.start && row.origin.range.end <= r.inputAck.through.byteOffset, "row outside acknowledged input");
          }
        }
        let covered = 0;
        const gaps = [];
        for (const c of r.coverage) {
          if (c.kind === "rows") {
            const range = c.range;
            safe2(range.start);
            safe2(range.end);
            fhAssert(equal(range.pane, r.pane) && range.segmentId === segment.id && range.start === Number(segment.next_row) + covered && range.end > range.start, "coverage order");
            const rows = r.rows.slice(covered, covered + range.end - range.start);
            fhAssert(rows.length === range.end - range.start && c.digest === streamDigest("rows", rows), "row coverage digest");
            covered += rows.length;
          } else {
            const g = c.gap;
            safe2(g.withheldRows);
            safe2(g.lowerBound);
            nonempty(g.episodeId);
            nonempty(g.clockEpoch);
            fhAssert(Number.isFinite(g.openedAt) && g.openedAt >= 0 && (g.closedAt === null || Number.isFinite(g.closedAt) && g.closedAt >= g.openedAt), "gap time range");
            fhAssert(g.leftRowId === null || equal(g.leftRowId.pane, r.pane), "gap left pane");
            if (g.leftRowId)
              fhAssert(this.visibleRow(g.leftRowId, staged?.transactionId) || r.rows.slice(0, covered).some((row) => equal(row.id, g.leftRowId)), "gap left row not durable or earlier in transaction");
            fhAssert(g.version === 1 && equal(g.pane, r.pane) && (g.rightSegmentId === null || g.rightSegmentId === segment.id), "gap identity");
            fhAssert(g.countKind === "unknown" ? g.missingCount === null : (g.countKind === "exact" || g.countKind === "estimate") && Number.isSafeInteger(g.missingCount) && g.missingCount >= 0, "unknown is not zero");
            fhAssert(c.digest === streamDigest("gap", g), "gap digest");
            const priorGap = this.load("gap-state", gapIdentity(g));
            if (priorGap)
              fhAssert(equal(priorGap.gap, g) || "repair" in priorGap.gap && "repair" in g && validGapUpdate(priorGap.gap, g), "gap identity/update collision");
            else if ("repair" in g)
              fhAssert(g.repair.update === 0, "gap initial update");
            gaps.push(g);
          }
        }
        fhAssert(covered === r.rows.length && equal(gaps, r.decision.gaps), "rows/gaps coverage incomplete");
        fhAssert(r.decision.acceptedRowMap.length === r.rows.length && r.rows.every((row, i) => equal(r.decision.acceptedRowMap[i], { source: row.origin, target: row.id })), "decision row mapping");
        const receipt = { kind: "rows-gaps-durable", operationId: r.operationId, commitId: r.operationId, generation: r.expectedGeneration, coverage: r.coverage, digest: r.digest };
        this.putEvent(key, String(segment.id), staged ? "candidate" : "committed", r.operationId, r.digest, r, receipt);
        this.save("receipt", r.operationId, key, receipt);
        if (staged)
          this.save("staged", staged.transactionId + ":" + staged.chunkOrdinal, key, { request: staged, receipt, projection: this.projection(r) });
        else
          this.indexRows(r);
        for (const row of r.rows)
          this.db.query("INSERT INTO fh_row_id VALUES(?,?,?)").run(key, String(segment.id), row.id.rowOrdinal);
        this.db.query("UPDATE fh_segment SET next_row=? WHERE id=?").run(ordinal, String(segment.id));
        return receipt;
      }));
    } catch (e) {
      return fail(e);
    }
  }
  persistCheckpoint(r) {
    try {
      this.tx("checkpoint", () => {
        const key = this.fence(r), cp = r.checkpoint;
        this.acknowledged(r.inputAck, r.pane);
        fhAssert(equal(cp.identity.pane, r.pane) && cp.kind === "vt-recovery" && this.options.codecVersions.includes(cp.state.codecVersion), "checkpoint identity/codec");
        fhAssert(cp.stateDigest === streamDigest("vt-state", { identity: cp.identity, state: cp.state }) && bytes(cp) <= STREAM_BUDGET.vtBytesPerPane, "checkpoint digest/bound");
        const old = this.db.query("SELECT * FROM fh_checkpoint WHERE id=?").get(cp.checkpointId);
        if (old) {
          fhAssert(old.payload === streamCanonical2(cp) && old.ack === streamCanonical2(r.inputAck), "checkpoint collision");
          return;
        }
        if (cp.previousCheckpointId !== null)
          fhAssert(this.db.query("SELECT 1 FROM fh_checkpoint WHERE id=? AND pane=?").get(cp.previousCheckpointId, key), "checkpoint chain missing");
        this.putEvent(key, r.inputAck.segmentId, "checkpoint", r.operationId, streamDigest("checkpoint", r), cp, null);
        this.db.query("INSERT INTO fh_checkpoint VALUES(?,?,?,?,?,?)").run(cp.checkpointId, key, r.inputAck.segmentId, streamCanonical2(r.inputAck), streamCanonical2(cp), streamDigest("checkpoint-payload", cp));
        const pin = { pane: r.pane, expectedGeneration: r.expectedGeneration, operationId: "checkpoint:" + key, segmentId: r.inputAck.segmentId, reason: "checkpoint", pinId: "checkpoint:" + key, durableCommitId: r.operationId };
        this.db.query("DELETE FROM fh_pin WHERE id=?").run(pin.pinId);
        this.db.query("INSERT INTO fh_pin VALUES(?,?,?,?,0)").run(pin.pinId, pin.operationId, pin.segmentId, streamCanonical2(pin));
      });
      return ok3(null);
    } catch (e) {
      return fail(e);
    }
  }
  async* recover(pane, after, cancel) {
    let pinIds = [];
    let release;
    try {
      this.live();
      const key = paneKey2(pane), readerKey = this.root + "|" + key;
      fhAssert(this.db.query("SELECT 1 FROM fh_pane WHERE pane=?").get(key), "unknown replay pane");
      if (fhReaders.size >= STREAM_BUDGET.activeReadsGlobal || fhReaders.has(readerKey)) {
        yield busy2();
        return;
      }
      fhReaders.add(readerKey);
      let released = false;
      release = () => {
        if (released)
          return;
        this.db.transaction(() => {
          for (const id of pinIds)
            this.db.query("DELETE FROM fh_pin WHERE id=?").run(id);
        }).immediate();
        released = true;
        fhReaders.delete(readerKey);
        this.replayReleases.delete(release);
        pinIds = [];
      };
      this.replayReleases.add(release);
      let segmentFloor = 0;
      if (after) {
        fhAssert(equal(after.epoch.pane, pane), "replay cursor pane");
        safe2(after.byteOffset);
        const cursor2 = this.db.query("SELECT segment FROM fh_event WHERE pane=? AND kind='input' AND json_extract(payload,'$.range.epoch.attachId')=? AND json_extract(payload,'$.range.epoch.collectorIncarnation')=? AND json_extract(payload,'$.range.end')=? ORDER BY seq DESC LIMIT 1").get(key, after.epoch.attachId, after.epoch.collectorIncarnation, after.byteOffset);
        fhAssert(cursor2, "remote-required or unknown durable replay cursor");
        segmentFloor = Number(this.db.query("SELECT rowid AS n FROM fh_segment WHERE id=?").get(String(cursor2.segment)).n);
      }
      const snapshot = this.tx("replay-pin", () => {
        const segments = this.db.query("SELECT id,state FROM fh_segment WHERE pane=? AND rowid>=? LIMIT 4097").all(key, segmentFloor);
        fhAssert(segments.length <= 4096, "replay metadata bound");
        for (const s of segments)
          fhAssert(s.state !== "reclaiming" && s.state !== "remote", "remote-required: restore segment before replay");
        for (const s of segments) {
          const id = randomUUID3();
          pinIds.push(id);
          this.db.query("INSERT INTO fh_pin VALUES(?,?,?,?,0)").run(id, id, String(s.id), "replay");
        }
        return Number(this.db.query("SELECT COALESCE(MAX(seq),0) AS n FROM fh_event WHERE pane=?").get(key).n);
      });
      let cursor = 0, firstEpochSeq = 0;
      if (after) {
        fhAssert(equal(after.epoch.pane, pane), "replay cursor pane");
        safe2(after.byteOffset);
        const epoch = this.db.query("SELECT * FROM fh_epoch WHERE epoch=?").get(streamCanonical2(after.epoch));
        fhAssert(epoch && Number(epoch.offset) >= after.byteOffset, "unknown replay cursor");
        const first = this.db.query("SELECT MIN(seq) AS n FROM fh_event WHERE pane=? AND kind='input' AND json_extract(payload,'$.range.epoch.attachId')=? AND json_extract(payload,'$.range.epoch.collectorIncarnation')=?").get(key, after.epoch.attachId, after.epoch.collectorIncarnation);
        fhAssert(first.n !== null, "replay cursor no longer local");
        firstEpochSeq = Number(first.n);
      }
      for (;; ) {
        this.live();
        if (cancel.isCancelled()) {
          yield { status: "cancelled", reason: "replay cancelled" };
          return;
        }
        const e = this.db.query("SELECT * FROM fh_event WHERE pane=? AND seq>? AND seq<=? AND segment IN (SELECT id FROM fh_segment WHERE pane=? AND rowid>=?) ORDER BY seq LIMIT 1").get(key, cursor, snapshot, key, segmentFloor);
        if (!e)
          break;
        cursor = Number(e.seq);
        this.checkEvent(e);
        const payload = JSON.parse(String(e.payload));
        if (e.kind === "input") {
          const record = payload;
          digest("spool", record);
          if (after && (cursor < firstEpochSeq || equal(record.range.epoch, after.epoch) && (record.range.end < after.byteOffset || record.payload.kind === "bytes" && record.range.end === after.byteOffset)))
            continue;
          yield ok3({ kind: "input", record, ack: JSON.parse(String(e.receipt)) });
        } else if (e.kind === "committed") {
          const r = payload;
          digest("rows-gaps", r);
          yield ok3({ kind: "committed", rows: r.rows, gaps: r.decision.gaps, receipt: JSON.parse(String(e.receipt)) });
        } else if (e.kind === "candidate")
          continue;
        else if (e.kind === "checkpoint")
          yield ok3({ kind: "checkpoint", checkpoint: payload });
        else
          throw Error("unknown durable event");
      }
    } catch (e) {
      yield fail(e);
    } finally {
      release?.();
    }
  }
  async pinSegment(r) {
    try {
      return ok3(this.tx("pin", () => {
        this.fence(r);
        const s = this.segment(r.segmentId, r.pane);
        fhAssert(s.state !== "remote" && s.state !== "reclaiming", "segment no longer local");
        const old = this.db.query("SELECT * FROM fh_pin WHERE operation=?").get(r.operationId);
        if (old) {
          const pin2 = JSON.parse(String(old.payload));
          const { pinId, durableCommitId, ...request } = pin2;
          fhAssert(equal(request, r) && old.released === 0, "pin operation collision/released");
          return pin2;
        }
        const pin = { ...r, pinId: randomUUID3(), durableCommitId: randomUUID3() };
        this.db.query("INSERT INTO fh_pin VALUES(?,?,?,?,0)").run(pin.pinId, r.operationId, r.segmentId, streamCanonical2(pin));
        return pin;
      }));
    } catch (e) {
      return fail(e);
    }
  }
  async releasePin(pin) {
    try {
      this.tx("release", () => {
        const p = this.db.query("SELECT * FROM fh_pin WHERE id=?").get(pin.pinId);
        fhAssert(p && p.payload === streamCanonical2(pin), "pin token mismatch");
        this.db.query("UPDATE fh_pin SET released=1 WHERE id=?").run(pin.pinId);
        const group = this.load("pin-group", pin.pinId);
        for (const segment of group ?? [])
          this.db.query("UPDATE fh_pin SET released=1 WHERE id=?").run(pin.pinId + ":" + segment);
      });
      return ok3(null);
    } catch (e) {
      return fail(e);
    }
  }
  unpinned(segment) {
    fhAssert(!this.db.query("SELECT 1 FROM fh_pin WHERE segment=? AND released=0 LIMIT 1").get(segment), "segment pinned");
  }
  async sealExport(r) {
    try {
      const result = this.tx("seal", () => {
        this.fence(r);
        const s = this.segment(r.segmentId, r.pane);
        if (s.sealed)
          return JSON.parse(String(s.sealed));
        fhAssert(s.state === "open" || s.state === "sealed-local", "segment not sealable");
        this.unpinned(r.segmentId);
        fhAssert(!this.db.query("SELECT 1 FROM fh_event WHERE segment=? AND kind='candidate'").get(r.segmentId), "attach candidate not published");
        const unfinished = this.db.query("SELECT id FROM fh_segment WHERE sealed IS NULL LIMIT 4097").all();
        fhAssert(unfinished.length <= 4096, "seal metadata bound");
        for (const entry of unfinished) {
          const id = String(entry.id);
          fhAssert(/^[a-f0-9]{64}$/.test(id), "unsafe segment ID");
          for (const suffix of [".jsonl", ".jsonl.tmp", ".timeline.jsonl", ".timeline.jsonl.tmp", ".replay.jsonl", ".replay.jsonl.tmp", ".manifest.json", ".manifest.json.tmp"]) {
            const path2 = join3(this.root, id + suffix);
            fhSafePath(path2);
            if (existsSync3(path2))
              unlinkSync(path2);
          }
        }
        fhSyncDir(this.root);
        fhAssert(!this.db.query("SELECT 1 FROM fh_segment WHERE state='sealed' OR state='reclaiming' LIMIT 1").get(), "export staging pressure");
        const path = join3(this.root, r.segmentId + ".jsonl"), temp = path + ".tmp";
        fhSafePath(temp);
        fhSafePath(path);
        const fd = openSync4(temp, "w", 384), coverage = [];
        let size2 = 0, cursor = 0;
        try {
          for (;; ) {
            const e = this.db.query("SELECT * FROM fh_event WHERE segment=? AND seq>? ORDER BY seq LIMIT 1").get(r.segmentId, cursor);
            if (!e)
              break;
            cursor = Number(e.seq);
            this.checkEvent(e);
            const line = streamCanonical2(e) + `
`;
            size2 += Buffer.byteLength(line);
            fhAssert(size2 <= FLAGON_BUDGET.archiveChunkBytes && bytes(coverage) <= STREAM_BUDGET.decodeBytes, "export bound");
            fhWrite(fd, line);
            if (e.kind === "committed")
              coverage.push(...JSON.parse(String(e.payload)).coverage);
          }
          this.options.boundary?.("seal-before-fsync");
          fsyncSync2(fd);
        } finally {
          closeSync4(fd);
        }
        this.options.boundary?.("seal-before-rename");
        renameSync(temp, path);
        chmodSync(path, 256);
        fhSyncDir(this.root);
        const file = fhEvidence(path), files = [file], manifestPath = join3(this.root, r.segmentId + ".manifest.json");
        const logical = this.load("logical", r.segmentId);
        if (logical) {
          files.push(this.writeIndex(r.segmentId, "timeline", fhRows(this.db, "SELECT * FROM fh_timeline WHERE segment=? ORDER BY n", r.segmentId), FLAGON_BUDGET.archiveChunkBytes - files.reduce((sum, f) => sum + f.bytes, 0)));
          files.push(this.writeIndex(r.segmentId, "replay", this.replayIndex(r.pane, logical), FLAGON_BUDGET.archiveChunkBytes - files.reduce((sum, f) => sum + f.bytes, 0)));
          fhAssert(files.reduce((sum, f) => sum + f.bytes, 0) <= FLAGON_BUDGET.archiveChunkBytes, "export total payload bound");
        }
        const manifestText = streamCanonical2({ version: 1, storeUUID: this.storeUUID, pane: r.pane, segmentId: r.segmentId, schemaVersions: { history: 1, spool: 1 }, coverage, files, ...logical ? { repair: logical } : {} });
        fhAssert(Buffer.byteLength(manifestText) <= STREAM_BUDGET.decodeBytes, "manifest bound");
        fhSafePath(manifestPath + ".tmp");
        fhSafePath(manifestPath);
        const mf = openSync4(manifestPath + ".tmp", "w", 384);
        try {
          fhWrite(mf, manifestText);
          fsyncSync2(mf);
        } finally {
          closeSync4(mf);
        }
        renameSync(manifestPath + ".tmp", manifestPath);
        chmodSync(manifestPath, 256);
        fhSyncDir(this.root);
        const sealed = { kind: "sealed-export", operationId: r.operationId, storeUUID: this.storeUUID, pane: r.pane, segmentId: r.segmentId, generation: this.load("logical", r.segmentId)?.sealGeneration ?? r.expectedGeneration, coverage, files, manifest: fhEvidence(manifestPath), sealCommitId: this.load("logical", r.segmentId)?.sealCommitId ?? randomUUID3() };
        this.db.query("UPDATE fh_segment SET state='sealed',sealed=? WHERE id=?").run(streamCanonical2(sealed), r.segmentId);
        return sealed;
      });
      return ok3(result);
    } catch (e) {
      return fail(e);
    }
  }
  async reclaimVerified(r) {
    try {
      this.live();
      const { sealed, remote } = r;
      const before = this.physical();
      this.tx("reclaim", () => {
        this.fence(r);
        const s = this.segment(sealed.segmentId, r.pane);
        fhAssert(s.sealed === streamCanonical2(sealed) && equal(sealed.pane, r.pane) && sealed.storeUUID === this.storeUUID, "seal mismatch");
        this.unpinned(sealed.segmentId);
        fhAssert(remote.kind === "remote-index-committed" && remote.catalogVersion === 3 && remote.generation === r.expectedGeneration && equal(remote.coverage, sealed.coverage), "remote index coverage/generation");
        const v = remote.verified, b = v.bundle;
        fhAssert(v.kind === "verified-remote" && v.exitCode === 0 && (v.method === "download-sha256" || v.method === "rclone-check-download") && v.evidence.length > 0, "upload is not verification");
        const inventory = this.load("remote-inventory", remote.commitId);
        if (inventory) {
          fhAssert(archiveInventoryMatches(sealed, b, inventory), "verified inventory mismatch");
          const logical = this.load("logical", sealed.segmentId);
          fhAssert(logical && equal(b.rawRanges, logical.rawRanges) && equal(b.checkpointIds, logical.checkpointIds), "remote recovery inventory mismatch");
          const repair = b.repair;
          fhAssert(repair?.revision === 2 && equal(repair.inventory, inventory) && [repair.timelineIndex, repair.replayIndex].every((file) => file && b.members.some((member) => equal(member, file))), "remote index payload missing");
          fhAssert(this.options.catalogAuthority, "remote catalog authority unavailable");
          const durable = this.value(this.options.catalogAuthority.remote(remote.commitId));
          fhAssert(durable && equal(durable, remote), "remote catalog receipt absent/mismatch");
        } else {
          fhAssert(b.version === 1 && b.storeUUID === this.storeUUID && b.segmentId === sealed.segmentId && equal(b.pane, r.pane) && equal(b.coverage, sealed.coverage) && equal(b.members, [...sealed.files, sealed.manifest]), "verified inventory mismatch");
          fhAssert(this.options.validateRemoteIndex?.(remote, sealed) === true, "remote catalog authority not validated");
        }
        if (s.remote)
          fhAssert(s.remote === streamCanonical2(remote), "remote receipt changed during reclaim");
        this.db.query("UPDATE fh_segment SET state='reclaiming',remote=? WHERE id=?").run(streamCanonical2(remote), sealed.segmentId);
      });
      for (const file of [...sealed.files, sealed.manifest]) {
        fhAssert(dirname2(file.path) === this.root && [sealed.segmentId + ".jsonl", sealed.segmentId + ".manifest.json", sealed.segmentId + ".timeline.jsonl", sealed.segmentId + ".replay.jsonl"].includes(file.path.slice(this.root.length + 1)), "unsafe reclaim path");
        if (existsSync3(file.path)) {
          fhAssert(equal(fhEvidence(file.path), file), "sealed file changed");
          this.options.boundary?.("reclaim-before-unlink");
          unlinkSync(file.path);
          this.options.boundary?.("reclaim-after-unlink");
        }
      }
      fhSyncDir(this.root);
      this.tx("reclaim-rows", () => {
        this.fence(r);
        this.unpinned(sealed.segmentId);
        this.db.query("DELETE FROM fh_event WHERE segment=?").run(sealed.segmentId);
        for (const cp of this.db.query("SELECT id FROM fh_checkpoint WHERE segment=?").all(sealed.segmentId))
          this.db.query("DELETE FROM fh_r2 WHERE kind='replay-checkpoint' AND id=?").run(String(cp.id));
        this.db.query("DELETE FROM fh_checkpoint WHERE segment=?").run(sealed.segmentId);
        this.db.query("UPDATE fh_segment SET state='remote',bytes=0 WHERE id=?").run(sealed.segmentId);
      });
      this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      for (;; ) {
        const n = Number(this.db.query("PRAGMA freelist_count").get().freelist_count);
        if (!n)
          break;
        this.db.exec("PRAGMA incremental_vacuum(256)");
        const left = Number(this.db.query("PRAGMA freelist_count").get().freelist_count);
        if (left >= n)
          break;
      }
      this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      const after = this.physical();
      return ok3({ kind: "local-reclaimed", remote, removed: [...sealed.files, sealed.manifest], allocatedBytesBefore: before.allocated, allocatedBytesAfter: after.allocated, freeBlocksBefore: before.free, freeBlocksAfter: after.free, blockBytes: after.block });
    } catch (e) {
      return fail(e);
    }
  }
  writeIndex(segment, kind, records, cap) {
    const path = join3(this.root, segment + "." + kind + ".jsonl"), temp = path + ".tmp";
    fhSafePath(path);
    fhSafePath(temp);
    const fd = openSync4(temp, "w", 384);
    let size2 = 0;
    try {
      for (const record of records) {
        const text = streamCanonical2(record) + `
`;
        size2 += Buffer.byteLength(text);
        fhAssert(size2 <= cap, "export index bound");
        fhWrite(fd, text);
      }
      fsyncSync2(fd);
    } finally {
      closeSync4(fd);
    }
    renameSync(temp, path);
    chmodSync(path, 256);
    fhSyncDir(this.root);
    return fhEvidence(path);
  }
  *replayIndex(pane, seal) {
    yield { kind: "logical-seal", value: seal };
    let id = "";
    for (const kind of ["replay-checkpoint", "control", "decision"]) {
      id = "";
      for (;; ) {
        const row = this.db.query("SELECT id FROM fh_r2 WHERE kind=? AND pane=? AND id>? ORDER BY id LIMIT 1").get(kind, paneKey2(pane), id);
        if (!row)
          break;
        id = String(row.id);
        const value = this.load(kind, id);
        const include = kind === "replay-checkpoint" ? seal.checkpointIds.includes(id) : kind === "decision" ? value.coverage.some((c) => c.kind === "rows" && c.range.segmentId === seal.segmentId) : seal.rawRanges.some((range) => equal(range.epoch, value.position.epoch) && value.position.byteOffset >= range.start && value.position.byteOffset <= range.end);
        if (include)
          yield { kind, id, value };
      }
    }
  }
  read(fn) {
    try {
      this.live();
      return ok3(fn());
    } catch (e) {
      return fail(e);
    }
  }
  value(r) {
    fhAssert(r.status === "ok", streamCanonical2(r));
    return r.value;
  }
  load(kind, id) {
    const row = this.db.query("SELECT payload,checksum FROM fh_r2 WHERE kind=? AND id=?").get(kind, id);
    if (!row)
      return null;
    fhAssert(row.checksum === streamDigest("history-r2-metadata", { kind, id, payload: row.payload }), "corrupt r2 metadata");
    return JSON.parse(String(row.payload));
  }
  save(kind, id, pane, value) {
    const payload = streamCanonical2(value);
    fhAssert(Buffer.byteLength(payload) <= (kind === "replay-checkpoint" ? STREAM_BUDGET.vtBytesPerPane : STREAM_BUDGET.decodeBytes), "r2 metadata bound");
    this.db.query("INSERT OR REPLACE INTO fh_r2 VALUES(?,?,?,?,?)").run(kind, id, pane, payload, streamDigest("history-r2-metadata", { kind, id, payload }));
  }
  migrateIndex() {
    if (this.load("migration", "timeline-v2"))
      return;
    this.db.transaction(() => {
      let segmentCursor = 0;
      for (;; ) {
        const segment = this.db.query("SELECT rowid AS cursor,* FROM fh_segment WHERE rowid>? ORDER BY rowid LIMIT 1").get(segmentCursor);
        if (!segment)
          break;
        segmentCursor = Number(segment.cursor);
        let seq = 0, events = 0;
        for (;; ) {
          const row = this.db.query("SELECT * FROM fh_event WHERE segment=? AND seq>? ORDER BY seq LIMIT 1").get(String(segment.id), seq);
          if (!row)
            break;
          seq = Number(row.seq);
          events++;
          this.checkEvent(row);
          if (row.kind === "committed") {
            const r = JSON.parse(String(row.payload));
            this.indexRows(r);
            this.save("receipt", r.operationId, String(row.pane), JSON.parse(String(row.receipt)));
          } else if (row.kind === "input")
            this.save("ack", String(row.op), String(row.pane), JSON.parse(String(row.receipt)));
        }
        if (!events && segment.state === "remote") {
          const seal = JSON.parse(String(segment.sealed)), remote = JSON.parse(String(segment.remote)), key = String(segment.pane);
          fhAssert(seal.storeUUID === this.storeUUID && paneKey2(seal.pane) === key && seal.segmentId === segment.id && equal(seal.coverage, remote.coverage), "remote migration identity");
          const operation = "remote-migration:" + seal.sealCommitId;
          let n = Number(this.db.query("SELECT COALESCE(MAX(n),-1)+1 AS n FROM fh_timeline WHERE pane=?").get(key).n), item = 0;
          for (const c of seal.coverage) {
            if (c.kind === "rows") {
              safe2(c.range.start);
              safe2(c.range.end);
              fhAssert(c.range.end >= c.range.start && c.range.segmentId === segment.id && paneKey2(c.range.pane) === key, "remote migration row range");
              for (let ordinal = c.range.start;ordinal < c.range.end; ordinal++) {
                this.db.query("INSERT INTO fh_timeline VALUES(?,?,?,?,?,?,?)").run(key, n++, String(segment.id), operation, item++, "row", ordinal);
                this.db.query("INSERT OR IGNORE INTO fh_row_id VALUES(?,?,?)").run(key, String(segment.id), ordinal);
              }
            } else {
              fhAssert(paneKey2(c.gap.pane) === key, "remote migration gap pane");
              this.db.query("INSERT INTO fh_timeline VALUES(?,?,?,?,?,?,NULL)").run(key, n++, String(segment.id), operation, item++, "gap");
            }
          }
          this.save("index-head", key, key, operation);
        }
      }
      this.save("migration", "timeline-v2", "", true);
    }).immediate();
  }
  visibleRow(id, transactionId) {
    if (this.db.query("SELECT 1 FROM fh_timeline WHERE pane=? AND segment=? AND ordinal=? AND kind='row'").get(paneKey2(id.pane), id.segmentId, id.rowOrdinal))
      return true;
    if (!transactionId)
      return false;
    return !!this.db.query(`SELECT 1 FROM fh_r2,json_each(json_extract(fh_r2.payload,'$.receipt.coverage')) AS c
      WHERE fh_r2.kind='staged' AND fh_r2.pane=? AND json_extract(fh_r2.payload,'$.request.transactionId')=?
      AND json_extract(c.value,'$.kind')='rows' AND json_extract(c.value,'$.range.segmentId')=?
      AND json_extract(c.value,'$.range.start')<=? AND json_extract(c.value,'$.range.end')>? LIMIT 1`).get(paneKey2(id.pane), transactionId, id.segmentId, id.rowOrdinal, id.rowOrdinal);
  }
  indexRows(r) {
    const pane = paneKey2(r.pane);
    if (this.load("indexed", r.operationId))
      return;
    let n = Number(this.db.query("SELECT COALESCE(MAX(n),-1)+1 AS n FROM fh_timeline WHERE pane=?").get(pane).n), item = 0;
    for (const c of r.coverage) {
      if (c.kind === "rows")
        for (const row of r.rows.filter((row2) => row2.id.segmentId === c.range.segmentId && row2.id.rowOrdinal >= c.range.start && row2.id.rowOrdinal < c.range.end))
          this.db.query("INSERT INTO fh_timeline VALUES(?,?,?,?,?,?,?)").run(pane, n++, row.id.segmentId, r.operationId, item++, "row", row.id.rowOrdinal);
      else {
        const id = gapIdentity(c.gap), prior = this.load("gap-state", id);
        if (prior) {
          fhAssert(equal(prior.gap, c.gap) || "repair" in prior.gap && "repair" in c.gap && validGapUpdate(prior.gap, c.gap), "gap publish conflict");
          this.db.query("UPDATE fh_timeline SET op=?,item=?,segment=? WHERE pane=? AND n=?").run(r.operationId, item++, r.rows[0]?.id.segmentId ?? c.gap.rightSegmentId ?? r.inputAck.segmentId, pane, prior.n);
          this.save("gap-state", id, pane, { gap: c.gap, n: prior.n });
        } else {
          const position = n++;
          this.db.query("INSERT INTO fh_timeline VALUES(?,?,?,?,?,?,NULL)").run(pane, position, r.rows[0]?.id.segmentId ?? c.gap.rightSegmentId ?? r.inputAck.segmentId, r.operationId, item++, "gap");
          this.save("gap-state", id, pane, { gap: c.gap, n: position });
        }
      }
    }
    this.save("indexed", r.operationId, pane, true);
    this.save("index-head", pane, pane, r.operationId);
  }
  projection(r) {
    const coverage = r.coverage.map((c) => c.kind === "gap" ? { ...c, digest: normalizedGapDigest(c.gap) } : { ...c, digest: normalizedRowsDigest(c.range, r.rows.filter((row) => row.id.segmentId === c.range.segmentId && row.id.rowOrdinal >= c.range.start && row.id.rowOrdinal < c.range.end)) });
    const body = { revision: 2, sourceCommitId: r.operationId, sourceDigest: r.digest, sourceDomain: "rows-gaps-v1", coverage, coverageDigest: normalizedCoverageDigest(coverage) };
    return { ...body, projectionDigest: coverageProjectionDigest(body) };
  }
  cursor(pane, n) {
    const body = { store: this.storeUUID, pane, n };
    return { version: 1, token: Buffer.from(streamCanonical2({ ...body, hash: streamDigest("history-cursor-r2", body) })).toString("base64url") };
  }
  position(pane, cursor, fallback) {
    if (!cursor)
      return fallback;
    fhAssert(cursor.version === 1 && cursor.token.length <= 4096, "cursor bound/version");
    const { hash, ...body } = JSON.parse(Buffer.from(cursor.token, "base64url").toString());
    fhAssert(body.store === this.storeUUID && equal(body.pane, pane) && hash === streamDigest("history-cursor-r2", body), "cursor identity");
    safe2(body.n);
    return body.n;
  }
  head(pane) {
    const key = paneKey2(pane), generation = this.generation(pane);
    const count = this.db.query("SELECT COUNT(*) AS entries,COALESCE(SUM(kind='row'),0) AS rows FROM fh_timeline WHERE pane=?").get(key);
    const last = this.db.query("SELECT segment,ordinal FROM fh_timeline WHERE pane=? AND kind='row' ORDER BY n DESC LIMIT 1").get(key);
    return { pane, generation, indexCommitId: this.load("index-head", key) ?? "empty:" + this.storeUUID, entryCount: Number(count.entries), rowCount: Number(count.rows), lastRow: last ? { pane, segmentId: String(last.segment), rowOrdinal: Number(last.ordinal) } : null, cursor: this.cursor(pane, Number(count.entries)) };
  }
  generation(pane) {
    const row = this.db.query("SELECT generation FROM fh_pane WHERE pane=?").get(paneKey2(pane));
    fhAssert(row, "unknown pane");
    return Number(row.generation);
  }
  bounded(request) {
    safe2(request.maxEntries);
    safe2(request.maxBytes);
    fhAssert(request.maxEntries > 0 && request.maxEntries <= 256 && request.maxBytes > 0 && request.maxBytes <= STREAM_BUDGET.decodeBytes, "read bound");
    fhAssert(request.direction === "before" || request.direction === "after", "read direction");
  }
  entries(r) {
    return r.coverage.flatMap((c) => c.kind === "gap" ? [c.gap] : r.rows.filter((row) => row.id.segmentId === c.range.segmentId && row.id.rowOrdinal >= c.range.start && row.id.rowOrdinal < c.range.end));
  }
  page(r) {
    this.bounded(r);
    this.reconcile(r.pane);
    const head = this.head(r.pane), key = paneKey2(r.pane), back = r.direction === "before";
    const start = this.position(r.pane, r.cursor, back ? head.entryCount : 0);
    fhAssert(start <= head.entryCount, "cursor outside timeline");
    const slots = this.db.query(`SELECT * FROM fh_timeline WHERE pane=? AND n${back ? "<" : ">="}? ORDER BY n ${back ? "DESC" : "ASC"} LIMIT ?`).all(key, start, r.maxEntries);
    const entries = [];
    let payloadBytes = 0, lo = start, hi = start, blocked = null;
    let cachedOp = "", cachedEntries = [];
    for (const slot of slots) {
      const s = this.segment(String(slot.segment), r.pane);
      if (s.state === "remote" || s.state === "reclaiming") {
        const remote = JSON.parse(String(s.remote));
        const at = back ? Number(slot.n) + 1 : Number(slot.n);
        blocked = { kind: "blocked", cursor: this.cursor(r.pane, at), state: { kind: "remote-required", range: { pane: r.pane, segmentId: String(s.id), start: 0, end: Number(s.next_row) }, bundleId: remote.verified.bundle.bundleId } };
        break;
      }
      if (cachedOp !== slot.op) {
        const event = this.event(String(slot.op));
        fhAssert(event, "timeline payload missing");
        this.checkEvent(event);
        fhAssert(event.kind === "committed", "unpublished timeline");
        cachedOp = String(slot.op);
        cachedEntries = this.entries(JSON.parse(String(event.payload)));
      }
      const entry = cachedEntries[Number(slot.item)];
      fhAssert(entry, "timeline entry missing");
      const size2 = bytes(entry);
      fhAssert(size2 <= r.maxBytes || entries.length > 0, "single entry exceeds read budget");
      if (payloadBytes + size2 > r.maxBytes)
        break;
      payloadBytes += size2;
      entries.push(entry);
      lo = Math.min(lo, Number(slot.n));
      hi = Math.max(hi, Number(slot.n) + 1);
    }
    if (back)
      entries.reverse();
    const before = back && blocked ? blocked : lo === 0 ? { kind: "end" } : { kind: "more", cursor: this.cursor(r.pane, lo) };
    const after = !back && blocked ? blocked : hi === head.entryCount ? { kind: "end" } : { kind: "more", cursor: this.cursor(r.pane, hi) };
    return { head, entries, payloadBytes, before, after };
  }
  tail(pane, maxRows, maxBytes) {
    safe2(maxRows);
    safe2(maxBytes);
    fhAssert(maxRows > 0 && maxRows <= 512 && maxBytes > 0 && maxBytes <= STREAM_BUDGET.decodeBytes, "tail bound");
    this.reconcile(pane);
    const head = this.head(pane), rows = [];
    let used = 0, cursor = null;
    for (let i = 0;i < 2 && rows.length < maxRows; i++) {
      const page = this.page({ pane, cursor, direction: "before", maxEntries: Math.min(256, maxRows - rows.length), maxBytes: maxBytes - used });
      rows.unshift(...page.entries.filter((e) => ("cells" in e)));
      used += page.payloadBytes;
      if (page.before.kind === "blocked")
        return { kind: "blocked", head, state: page.before.state };
      if (page.before.kind === "end" || used === maxBytes)
        break;
      cursor = page.before.cursor;
    }
    if (!rows.length)
      return { kind: "blocked", head, state: { kind: "pending", operationId: "tail-anchor:" + paneKey2(pane), retryAfterMs: 20 } };
    const segments = new Set(rows.map((row) => row.id.segmentId));
    fhAssert(segments.size <= 512, "tail segment bound");
    const request = { pane, expectedGeneration: head.generation, operationId: randomUUID3(), segmentId: rows[0].id.segmentId, reason: "reader" };
    const pin = { ...request, pinId: randomUUID3(), durableCommitId: randomUUID3() };
    this.tx("tail-pin", () => {
      for (const segment of segments) {
        this.unreclaimed(segment, pane);
        const id = segment === pin.segmentId ? pin.pinId : pin.pinId + ":" + segment;
        this.db.query("INSERT INTO fh_pin VALUES(?,?,?,?,0)").run(id, id, segment, streamCanonical2(pin));
      }
      this.save("pin-group", pin.pinId, paneKey2(pane), [...segments]);
    });
    return { kind: "local", head, rows, pin };
  }
  unreclaimed(segment, pane) {
    const s = this.segment(segment, pane);
    fhAssert(s.state !== "remote" && s.state !== "reclaiming", "segment not local");
  }
  authority = {
    generation: (pane) => this.read(() => this.generation(pane)),
    staged: (id, n) => this.read(() => {
      safe2(n);
      return this.load("staged", id + ":" + n);
    }),
    attachSet: (id) => this.read(() => this.load("attach-set", id)),
    receipt: (id) => this.read(() => this.event(id)?.kind === "candidate" ? null : this.load("receipt", id)),
    pin: (id) => this.read(() => {
      const row = this.db.query("SELECT payload,released FROM fh_pin WHERE id=?").get(id);
      return row && row.released === 0 && row.payload !== "replay" ? JSON.parse(String(row.payload)) : null;
    }),
    seal: (id) => this.read(() => {
      const row = this.db.query("SELECT sealed FROM fh_segment WHERE json_extract(sealed,'$.sealCommitId')=?").get(id);
      return row ? JSON.parse(String(row.sealed)) : null;
    }),
    continuity: (id) => this.read(() => this.load("rotation", id)),
    head: (pane) => this.read(() => {
      this.reconcile(pane);
      return this.head(pane);
    }),
    tail: (pane, n, b) => this.read(() => this.tail(pane, n, b)),
    page: (r) => this.read(() => this.page(r)),
    watermark: (pane) => this.read(() => this.load("watermark", paneKey2(pane))),
    decisions: (r) => this.read(() => this.readDecisions(r)),
    controls: (r) => this.read(() => this.readControls(r))
  };
  readDecisions(r) {
    this.bounded(r);
    const pane = paneKey2(r.pane), all = Number(this.db.query("SELECT COUNT(*) AS n FROM fh_r2 WHERE kind='decision' AND pane=?").get(pane).n);
    const n = this.position(r.pane, r.cursor, r.direction === "before" ? all : 0);
    fhAssert(n <= all, "decision cursor outside index");
    const from = r.direction === "before" ? Math.max(0, n - r.maxEntries) : n;
    const ids = this.db.query("SELECT id FROM fh_r2 WHERE kind='decision' AND pane=? ORDER BY json_extract(payload,'$.raw.start'),json_extract(payload,'$.controlStart'),id LIMIT ? OFFSET ?").all(pane, Math.min(r.maxEntries, r.direction === "before" ? n : all - n), from);
    const entries = [];
    let size2 = 0;
    for (const id of ids) {
      const d = this.load("decision", String(id.id));
      if (size2 + bytes(d) > r.maxBytes) {
        fhAssert(entries.length, "decision exceeds page budget");
        break;
      }
      size2 += bytes(d);
      entries.push(d);
    }
    const next = r.direction === "before" ? from : from + entries.length;
    return { entries, next: (r.direction === "before" ? next > 0 : next < all) ? this.cursor(r.pane, next) : null };
  }
  controlCursor(pane, w, last) {
    const body = { store: this.storeUUID, pane, checkpointId: w.checkpointId, through: w.through, controlOrder: w.controlOrder, last };
    return { version: 1, token: Buffer.from(streamCanonical2({ ...body, hash: streamDigest("history-control-cursor-r2", body) })).toString("base64url") };
  }
  controlAt(pane, w, cursor) {
    if (!cursor)
      return { off: w.through.byteOffset, order: w.controlOrder, id: null };
    fhAssert(cursor.version === 1 && cursor.token.length > 0 && cursor.token.length <= 4096, "cursor bound/version");
    const { hash, ...body } = JSON.parse(Buffer.from(cursor.token, "base64url").toString());
    fhAssert(hash === streamDigest("history-control-cursor-r2", body), "control cursor identity");
    const last = body.last;
    fhAssert(last && typeof last === "object", "control cursor identity");
    fhAssert(equal(body, { store: this.storeUUID, pane, checkpointId: w.checkpointId, through: w.through, controlOrder: w.controlOrder, last }), "control cursor identity");
    safe2(last.byteOffset);
    safe2(last.order);
    nonempty(last.eventId);
    fhAssert(last.byteOffset > w.through.byteOffset || last.byteOffset === w.through.byteOffset && last.order > w.controlOrder, "control cursor before watermark");
    return { off: last.byteOffset, order: last.order, id: last.eventId };
  }
  readControls(r) {
    safe2(r.maxEntries);
    safe2(r.maxBytes);
    fhAssert(r.maxEntries >= 1 && r.maxEntries <= 256 && r.maxBytes >= 1 && r.maxBytes <= STREAM_BUDGET.decodeBytes, "control read bound");
    const w = r.after;
    fhAssert(w.revision === 2 && equal(w.pane, r.pane) && equal(w.through.epoch.pane, r.pane), "control read identity");
    safe2(w.through.byteOffset);
    safe2(w.controlOrder);
    nonempty(w.checkpointId);
    nonempty(w.decoderVersion);
    const stored = this.load("watermark", paneKey2(r.pane));
    fhAssert(stored && equal(stored, w), "control watermark mismatch");
    const key = paneKey2(r.pane), epochKey = streamCanonical2(w.through.epoch);
    let { off, order, id } = this.controlAt(r.pane, w, r.cursor), examined = 0;
    const matches = [];
    while (matches.length <= r.maxEntries) {
      const row = this.db.query(`SELECT id FROM fh_r2 WHERE kind='control' AND pane=? AND json_extract(payload,'$.position.epoch.attachId')=? AND (
        json_extract(payload,'$.position.byteOffset')>?
        OR (json_extract(payload,'$.position.byteOffset')=? AND json_extract(payload,'$.order')>?)
        OR (json_extract(payload,'$.position.byteOffset')=? AND json_extract(payload,'$.order')=? AND ? IS NOT NULL AND id>?)
      ) ORDER BY json_extract(payload,'$.position.byteOffset'), json_extract(payload,'$.order'), id LIMIT 1`).get(key, w.through.epoch.attachId, off, off, order, off, order, id, id);
      if (!row)
        break;
      examined++;
      fhAssert(examined <= 1024, "control journal bound");
      const nextId = String(row.id), event = this.load("control", nextId);
      fhAssert(event, "control payload missing");
      const { digest: d, ...body } = event;
      fhAssert(event.revision === 2 && event.eventId === nextId && orderedControlDigest(body) === d, "control digest");
      safe2(event.position.byteOffset);
      safe2(event.order);
      fhAssert(event.position.byteOffset > off || event.position.byteOffset === off && (event.order > order || event.order === order && id !== null && nextId > id), "control scan stalled");
      off = event.position.byteOffset;
      order = event.order;
      id = nextId;
      if (streamCanonical2(event.position.epoch) !== epochKey)
        continue;
      matches.push({ commitId: nextId, event });
    }
    const entries = [];
    for (const entry of matches) {
      if (entries.length === r.maxEntries)
        break;
      const candidate = [...entries, entry];
      if (bytes(candidate) > r.maxBytes) {
        fhAssert(entries.length > 0, "control entry exceeds page budget");
        break;
      }
      entries.push(entry);
    }
    const atDurableHead = matches.length === entries.length, last = entries.at(-1)?.event;
    const next = atDurableHead || !last ? null : this.controlCursor(r.pane, w, { byteOffset: last.position.byteOffset, order: last.order, eventId: last.eventId });
    return { revision: 2, pane: r.pane, checkpointId: w.checkpointId, entries, payloadBytes: bytes(entries), next, atDurableHead };
  }
  logical(r) {
    const key = this.fence(r), s = this.segment(r.segmentId, r.pane), old = this.load("logical", r.segmentId);
    if (old)
      return old;
    fhAssert(s.state === "open" || s.state === "sealed" || s.state === "remote" && s.sealed, "segment not sealable");
    const coverage = [], rawRanges = [], checkpointIds = [];
    let seq = 0;
    for (;; ) {
      const e = this.db.query("SELECT * FROM fh_event WHERE segment=? AND seq>? ORDER BY seq LIMIT 1").get(r.segmentId, seq);
      if (!e)
        break;
      this.checkEvent(e);
      seq = Number(e.seq);
      const p = JSON.parse(String(e.payload));
      if (e.kind === "committed" || e.kind === "candidate")
        coverage.push(...p.coverage);
      else if (e.kind === "input") {
        const range = p.range, last = rawRanges.at(-1);
        if (last && equal(last.epoch, range.epoch) && last.end === range.start)
          rawRanges[rawRanges.length - 1] = { ...last, end: range.end };
        else
          rawRanges.push(range);
      } else if (e.kind === "checkpoint")
        checkpointIds.push(p.checkpointId);
      fhAssert(bytes({ coverage, rawRanges, checkpointIds }) <= STREAM_BUDGET.decodeBytes, "logical seal bound");
    }
    for (const cp of this.db.query("SELECT id FROM fh_r2 WHERE kind='replay-checkpoint' AND pane=? AND json_extract(payload,'$.inputFence.segmentId')=? LIMIT 257").all(key, r.segmentId))
      if (!checkpointIds.includes(String(cp.id)))
        checkpointIds.push(String(cp.id));
    fhAssert(checkpointIds.length <= 256, "checkpoint seal bound");
    const existing = s.sealed ? JSON.parse(String(s.sealed)) : null;
    if (existing && s.state === "remote")
      coverage.push(...existing.coverage);
    const seal = { revision: 2, sealCommitId: existing?.sealCommitId ?? r.operationId, sealGeneration: existing?.generation ?? r.expectedGeneration, pane: r.pane, segmentId: r.segmentId, coverage, rawRanges, checkpointIds, timelineIndexCommitId: this.head(r.pane).indexCommitId, replayIndexCommitId: this.load("decision-head", key) ?? "empty:" + this.storeUUID };
    this.save("logical", r.segmentId, key, seal);
    if (s.state === "open")
      this.db.query("UPDATE fh_segment SET state='sealed-local' WHERE id=?").run(r.segmentId);
    return seal;
  }
  async sealSegment(r) {
    return this.read(() => this.tx("logical-seal", () => this.logical(r)));
  }
  rotate(r) {
    const key = this.fence(r), prior = this.load("rotation", r.operationId);
    if (prior) {
      fhAssert(prior.predecessor === r.segmentId && equal(prior.boundary, r.boundary), "rotation collision");
      return prior;
    }
    const epoch = this.db.query("SELECT * FROM fh_epoch WHERE epoch=?").get(streamCanonical2(r.boundary.epoch));
    fhAssert(epoch && epoch.pane === key && epoch.segment === r.segmentId && epoch.offset === r.boundary.byteOffset, "rotation boundary is not durable head");
    const seal = this.logical(r), successor = streamDigest("history-successor-r2", { predecessor: r.segmentId, operation: r.operationId });
    const body = { revision: 2, pane: r.pane, epoch: r.boundary.epoch, predecessor: r.segmentId, successor, boundary: r.boundary, lastRow: this.head(r.pane).lastRow, firstSuccessorOrdinal: 0, sealCommitId: seal.sealCommitId, rotationCommitId: r.operationId };
    const receipt = { ...body, digest: segmentContinuityDigest(body) };
    this.db.query("INSERT INTO fh_segment(id,pane,state) VALUES(?,?,'open')").run(successor, key);
    this.db.query("UPDATE fh_epoch SET segment=? WHERE epoch=?").run(successor, streamCanonical2(r.boundary.epoch));
    this.save("rotation", r.operationId, key, receipt);
    this.save("successor", successor, key, receipt);
    return receipt;
  }
  async rotateSegment(r) {
    return this.read(() => this.tx("rotate", () => this.rotate(r)));
  }
  listSealed(cursor, limit) {
    return this.read(() => {
      safe2(limit);
      fhAssert(limit > 0 && limit <= 256, "sealed page bound");
      const rows = this.db.query("SELECT id FROM fh_r2 WHERE kind='logical' AND id>? AND id IN (SELECT id FROM fh_segment WHERE state!='remote') ORDER BY id LIMIT ?").all(cursor ?? "", limit + 1);
      return { seals: rows.slice(0, limit).map((row) => this.load("logical", String(row.id))), next: rows.length > limit ? String(rows[limit - 1].id) : null };
    });
  }
  async materializeExport(r) {
    try {
      this.fence(r);
      const row = this.db.query("SELECT id FROM fh_r2 WHERE kind='logical' AND json_extract(payload,'$.sealCommitId')=? AND pane=?").get(r.sealCommitId, paneKey2(r.pane));
      fhAssert(row, "unknown logical seal");
      return this.sealExport({ ...r, segmentId: String(row.id) });
    } catch (e) {
      return fail(e);
    }
  }
  async stageRows(r) {
    try {
      const { repair, ...body } = r;
      fhAssert(repair.revision === 2 && repair.visibility === "candidate" && equal(repair.epoch, r.inputAck.through.epoch) && repair.decisionId === r.decision.decisionId, "candidate identity");
      nonempty(repair.transactionId);
      safe2(repair.chunkOrdinal);
      fhAssert(repair.chunkOrdinal < 256, "candidate count bound");
      const key = paneKey2(r.pane), id = repair.transactionId + ":" + repair.chunkOrdinal;
      return ok3(this.tx("stage", () => {
        this.fence(r);
        const previous = this.load("staged", id);
        if (previous) {
          fhAssert(equal(previous.request, repair) && previous.receipt.digest === body.digest, "candidate collision");
          return previous;
        }
        fhAssert(!this.load("attach-set", repair.transactionId) && !this.load("attach-done", repair.transactionId), "attach already sealed/decided");
        const count = Number(this.db.query("SELECT COUNT(*) AS n FROM fh_r2 WHERE kind='staged' AND json_extract(payload,'$.request.transactionId')=?").get(repair.transactionId).n);
        fhAssert(count === repair.chunkOrdinal, "candidate chunk order");
        if (count) {
          const first = this.load("staged", repair.transactionId + ":0");
          fhAssert(equal(first.request.epoch, repair.epoch) && first.request.decisionId === repair.decisionId && first.receipt.generation === r.expectedGeneration, "candidate transaction changed");
        }
        this.value(this.commitRows(body, repair));
        return this.load("staged", id);
      }));
    } catch (e) {
      return fail(e);
    }
  }
  async sealAttachSet(r) {
    return this.read(() => this.tx("attach-set", () => {
      const key = this.fence(r), m = r.manifest, old = this.load("attach-set", m.transactionId);
      if (old) {
        fhAssert(equal(old, m), "attach set collision");
        return old;
      }
      fhAssert(equal(m.pane, r.pane) && m.expectedGeneration === r.expectedGeneration, "attach set fence");
      const count = Number(this.db.query("SELECT COUNT(*) AS n FROM fh_r2 WHERE kind='staged' AND json_extract(payload,'$.request.transactionId')=?").get(m.transactionId).n);
      fhAssert(count === m.entries.length, "attach omitted chunks");
      const receipts = m.entries.map((entry) => {
        const staged = this.load("staged", m.transactionId + ":" + entry.ordinal);
        fhAssert(staged, "missing staged receipt");
        const e = this.event(staged.receipt.operationId);
        fhAssert(e && e.kind === "candidate", "missing candidate payload");
        this.checkEvent(e);
        const body = JSON.parse(String(e.payload));
        fhAssert(equal(staged.request.epoch, m.epoch) && staged.request.decisionId === m.decisionId && entry.rows === body.rows.length && entry.payloadBytes === bytes(body), "attach chunk readback mismatch");
        return staged.receipt;
      });
      attachCoverage(m, receipts);
      this.save("attach-set", m.transactionId, key, m);
      return m;
    }));
  }
  attachDecision(d) {
    fhAssert(d.revision === 2 && this.options.catalogAuthority, "catalog attach authority unavailable");
    const authority = this.value(this.options.catalogAuthority.attach(d.attachId));
    fhAssert(authority && equal(authority, d), "catalog attach decision mismatch");
    const m = this.load("attach-set", d.transactionId);
    fhAssert(m && m.epoch.attachId === d.attachId && m.aggregateDigest === d.receiptSetDigest, "attach decision manifest mismatch");
    fhAssert(d.generation === m.expectedGeneration + (d.state === "COMMITTED" ? 1 : 0), "attach generation mismatch");
    return m;
  }
  publish(d) {
    const m = this.attachDecision(d);
    fhAssert(d.state === "COMMITTED", "attach not committed");
    const done = this.load("attach-done", d.transactionId);
    if (done) {
      fhAssert(equal(done, d), "attach finalization changed");
      return this.head(m.pane);
    }
    const current = this.generation(m.pane);
    fhAssert(current === m.expectedGeneration || current === d.generation, "attach stale owner");
    for (const entry of m.entries) {
      const e = this.event(entry.operationId);
      fhAssert(e && e.kind === "candidate", "missing candidate at publish");
      this.checkEvent(e);
      const r = JSON.parse(String(e.payload));
      const checksum = streamDigest("flag-on-event", { kind: "committed", op: e.op, digest: e.digest, payload: e.payload, receipt: e.receipt, segment: e.segment, pane: e.pane });
      this.db.query("UPDATE fh_event SET kind='committed',checksum=? WHERE op=?").run(checksum, entry.operationId);
      this.indexRows(r);
    }
    this.db.query("UPDATE fh_pane SET generation=? WHERE pane=?").run(d.generation, paneKey2(m.pane));
    this.save("attach-done", d.transactionId, paneKey2(m.pane), d);
    return this.head(m.pane);
  }
  reconcile(pane) {
    const pending = this.db.query("SELECT id FROM fh_r2 WHERE kind='attach-set' AND pane=? AND id NOT IN (SELECT id FROM fh_r2 WHERE kind='attach-done') LIMIT 257").all(paneKey2(pane));
    fhAssert(pending.length <= 256, "pending attach metadata bound");
    for (const row of pending) {
      const m = this.load("attach-set", String(row.id));
      fhAssert(this.options.catalogAuthority, "catalog attach authority unavailable");
      const d = this.value(this.options.catalogAuthority.attach(m.epoch.attachId));
      if (d?.state === "COMMITTED")
        this.tx("reconcile", () => this.publish(d));
    }
  }
  async publishAttach(d) {
    return this.read(() => this.tx("publish", () => this.publish(d)));
  }
  async discardAttach(d) {
    return this.read(() => this.tx("discard", () => {
      const m = this.attachDecision(d);
      fhAssert(d.state === "ABORTED", "only aborted attach may discard");
      fhAssert(!this.load("attach-done", d.transactionId), "attach already finalized");
      for (const entry of m.entries) {
        const e = this.event(entry.operationId);
        fhAssert(e?.kind === "candidate", "cannot discard published payload");
        this.db.query("DELETE FROM fh_event WHERE op=?").run(entry.operationId);
      }
      this.save("attach-done", d.transactionId, paneKey2(m.pane), d);
      return null;
    }));
  }
  async appendVerifiedInput(input) {
    try {
      const { provenanceDigest, ...body } = input;
      fhAssert(input.revision === 2 && input.historyDomain === "spool" && input.source.length > 0 && input.source.length <= 256 && bytes(input) <= STREAM_BUDGET.decodeBytes, "input provenance bound");
      fhAssert(inputProvenanceDigest(body) === provenanceDigest && this.options.readSourceRecords, "source read authority required");
      const record = input.record;
      let offset = record.range.start, previous = null;
      const raw = [];
      for (const slice of input.source) {
        fhAssert(slice.sourceDomain === "spool-record" && equal(slice.range.epoch, record.range.epoch) && slice.range.start === offset, "source slice discontinuity");
        const records = this.value(this.options.readSourceRecords(slice));
        fhAssert(records.length > 0 && records.length <= 4096 && bytes(records) <= STREAM_BUDGET.decodeBytes, "source read bound");
        fhAssert(sourceRecordsDigest(records) === slice.recordsDigest && records[0].sequence === slice.firstSequence && records.at(-1).sequence === slice.lastSequence && records[0].previousDigest === slice.previousDigest && records.at(-1).digest === slice.terminalDigest, "source readback digest");
        for (const source of records) {
          [source.range.start, source.range.end, source.sequence].forEach(safe2);
          const { digest: d, ...p } = source;
          fhAssert(sourceSpoolDigest(p) === d && equal(source.range.epoch, record.range.epoch) && source.range.start === offset, "source bytes/range digest");
          if (previous)
            fhAssert(source.sequence === previous.sequence + 1 && source.previousDigest === previous.digest, "source chain");
          if (source.payload.kind === "bytes") {
            fhAssert(source.range.end - source.range.start === source.payload.bytes.length, "source range size");
            raw.push(...source.payload.bytes);
            fhAssert(raw.length <= FLAGON_BUDGET.rawBytesPerPane, "source aggregate bound");
          } else
            fhAssert(records.length === 1 && input.source.length === 1 && equal(source.payload, record.payload) && source.range.end === source.range.start, "coalesced control mismatch");
          offset = source.range.end;
          previous = source;
        }
        fhAssert(offset === slice.range.end, "source slice end");
      }
      fhAssert(offset === record.range.end && (record.payload.kind !== "bytes" || equal(raw, record.payload.bytes)), "coalesced byte mismatch");
      const proof = { revision: input.revision, recordDigest: record.digest, range: record.range, historyDomain: input.historyDomain, source: input.source, provenanceDigest };
      return ok3(this.tx("verified-input", () => {
        const old = this.load("provenance", record.operationId);
        fhAssert(!old || equal(old, proof), "provenance collision");
        const receipt = this.value(this.appendRecord(record));
        this.save("provenance", record.operationId, paneKey2(record.range.epoch.pane), proof);
        return receipt;
      }));
    } catch (e) {
      return fail(e);
    }
  }
  async journalControl(r) {
    return this.read(() => this.tx("control", () => {
      const key = this.fence(r), event = r.event, { digest: d, ...body } = event;
      fhAssert(event.revision === 2 && equal(event.position.epoch.pane, r.pane) && orderedControlDigest(body) === d && this.options.codecVersions.includes(event.decoderVersion), "control identity/digest/codec");
      safe2(event.order);
      safe2(event.position.byteOffset);
      const old = this.load("control", event.eventId);
      if (old) {
        fhAssert(equal(old, event), "control collision");
        return { commitId: r.operationId, event: old };
      }
      const epoch = this.db.query("SELECT * FROM fh_epoch WHERE epoch=?").get(streamCanonical2(event.position.epoch));
      fhAssert(epoch && epoch.offset === event.position.byteOffset, "control not at durable raw head");
      const last = this.db.query("SELECT payload FROM fh_r2 WHERE kind='control' AND pane=? AND json_extract(payload,'$.position.epoch.attachId')=? ORDER BY json_extract(payload,'$.position.byteOffset') DESC,json_extract(payload,'$.order') DESC LIMIT 1").get(key, event.position.epoch.attachId);
      if (last) {
        const p = JSON.parse(String(last.payload));
        fhAssert(event.position.byteOffset > p.position.byteOffset || event.position.byteOffset === p.position.byteOffset && event.order > p.order, "control order");
      }
      if (event.payload.kind === "geometry") {
        geometry(event.payload.before);
        geometry(event.payload.after);
      } else {
        nonempty(event.payload.name);
        fhAssert(typeof event.payload.data === "string", "control data");
      }
      this.save("control", event.eventId, key, event);
      return { commitId: r.operationId, event };
    }));
  }
  async commitReplayCheckpoint(r) {
    return this.read(() => this.tx("replay-checkpoint", () => {
      const key = this.fence(r), cp = r.checkpoint, w = r.watermark;
      fhAssert(w.revision === 2 && equal(w.pane, r.pane) && equal(w.through.epoch.pane, r.pane) && equal(cp.identity.pane, r.pane) && w.checkpointId === cp.checkpointId && w.stateDigest === cp.stateDigest && w.decoderVersion === cp.state.codecVersion && this.options.codecVersions.includes(w.decoderVersion), "replay checkpoint identity");
      fhAssert(cp.stateDigest === streamDigest("vt-state", { identity: cp.identity, state: cp.state }) && bytes(cp) <= STREAM_BUDGET.vtBytesPerPane, "checkpoint digest/bound");
      safe2(w.controlOrder);
      fhAssert(w.durableCommitId === r.operationId, "checkpoint durable operation identity");
      fhAssert(Object.keys(w.known).length > 0 && Object.values(w.known).every((x) => typeof x === "boolean"), "checkpoint known state");
      const epoch = this.db.query("SELECT * FROM fh_epoch WHERE epoch=?").get(streamCanonical2(w.through.epoch));
      fhAssert(epoch && epoch.offset === w.through.byteOffset, "checkpoint raw head");
      const index = this.load("decision-head", key) ?? "empty:" + this.storeUUID;
      fhAssert(w.decisionIndexCommitId === index, "checkpoint decision watermark");
      for (const dependency of w.snapshotDependencies) {
        fhAssert(resolve3(dependency.path).startsWith(this.root + sep2), "checkpoint dependency outside root");
        fhAssert(equal(fhEvidence(dependency.path), dependency), "checkpoint dependency changed");
      }
      const old = this.load("watermark", key);
      if (old?.checkpointId === w.checkpointId) {
        fhAssert(equal(old, w), "checkpoint retry changed");
        return old;
      }
      if (old) {
        fhAssert(cp.previousCheckpointId === old.checkpointId && equal(old.through.epoch, w.through.epoch) && old.through.byteOffset <= w.through.byteOffset, "checkpoint regression");
      } else if (cp.previousCheckpointId !== null)
        fhAssert(this.db.query("SELECT 1 FROM fh_checkpoint WHERE id=? AND pane=?").get(cp.previousCheckpointId, key), "checkpoint predecessor absent");
      const prior = this.load("replay-checkpoint", cp.checkpointId);
      fhAssert(!prior || equal(prior, cp), "checkpoint id collision");
      const durable = this.db.query("SELECT id FROM fh_r2 WHERE kind='ack' AND pane=? AND json_extract(payload,'$.recordDigest')=? LIMIT 1").get(key, String(epoch.digest));
      fhAssert(durable, "checkpoint raw ACK missing");
      const ack = this.load("ack", String(durable.id));
      this.acknowledged(ack, r.pane);
      fhAssert(cp.inputFence.digest === ack.recordDigest, "checkpoint input fence mismatch");
      this.putEvent(key, String(epoch.segment), "checkpoint", r.operationId, streamDigest("checkpoint", r), cp, null);
      this.db.query("INSERT INTO fh_checkpoint VALUES(?,?,?,?,?,?)").run(cp.checkpointId, key, String(epoch.segment), streamCanonical2(ack), streamCanonical2(cp), streamDigest("checkpoint-payload", cp));
      this.save("replay-checkpoint", cp.checkpointId, key, cp);
      this.save("watermark", key, key, w);
      this.db.query("DELETE FROM fh_pin WHERE operation=?").run("checkpoint:" + key);
      const pin = { pane: r.pane, expectedGeneration: r.expectedGeneration, operationId: "checkpoint:" + key, segmentId: String(epoch.segment), reason: "replay", pinId: "checkpoint:" + key, durableCommitId: r.operationId };
      this.db.query("INSERT INTO fh_pin VALUES(?,?,?,?,0)").run(pin.pinId, pin.operationId, pin.segmentId, streamCanonical2(pin));
      return w;
    }));
  }
  async commitReplayDecision(r) {
    return this.read(() => this.tx("replay-decision", () => {
      const key = this.fence(r), d = r.decision;
      fhAssert(equal(d.raw.epoch.pane, r.pane) && this.options.codecVersions.includes(d.decoderVersion) && ["consumed", "withheld"].includes(d.disposition), "decision identity");
      [d.raw.start, d.raw.end, d.controlStart, d.controlEnd].forEach(safe2);
      fhAssert(d.raw.end >= d.raw.start && d.controlEnd >= d.controlStart, "decision interval");
      const old = this.load("decision", d.decisionId);
      if (old) {
        fhAssert(equal(old, d), "decision collision");
        return { commitId: this.load("decision-commit", d.decisionId) };
      }
      fhAssert(this.load("replay-checkpoint", d.checkpointId), "decision checkpoint missing");
      const epoch = this.db.query("SELECT offset FROM fh_epoch WHERE epoch=?").get(streamCanonical2(d.raw.epoch));
      fhAssert(epoch && Number(epoch.offset) >= d.raw.end, "decision exceeds durable raw");
      for (const c of d.coverage) {
        fhAssert(this.db.query(`SELECT 1 FROM fh_r2,json_each(json_extract(fh_r2.payload,'$.coverage')) AS c
          WHERE fh_r2.kind='receipt' AND fh_r2.pane=? AND c.value=?
          AND NOT EXISTS(SELECT 1 FROM fh_event WHERE op=fh_r2.id AND kind='candidate') LIMIT 1`).get(key, streamCanonical2(c)), "decision coverage receipt mismatch");
        if (c.kind === "rows") {
          fhAssert(equal(c.range.pane, r.pane), "decision coverage pane");
          const count = Number(this.db.query("SELECT COUNT(*) AS n FROM fh_row_id WHERE pane=? AND segment=? AND ordinal>=? AND ordinal<?").get(key, c.range.segmentId, c.range.start, c.range.end).n);
          fhAssert(count === c.range.end - c.range.start, "decision coverage not durable");
        } else
          fhAssert(equal(c.gap.pane, r.pane), "decision gap pane");
      }
      this.save("decision", d.decisionId, key, d);
      this.save("decision-commit", d.decisionId, key, r.operationId);
      this.save("decision-head", key, key, r.operationId);
      return { commitId: r.operationId };
    }));
  }
  async reclaimR2(r) {
    try {
      this.tx("remote-authority", () => {
        this.fence(r);
        this.unpinned(r.sealed.segmentId);
        fhAssert(archiveInventoryMatches(r.sealed, r.remote.verified.bundle, r.inventory), "archive inventory mismatch");
        fhAssert(r.remote.repair.revision === 2 && r.remote.repair.sealCommitId === r.sealed.sealCommitId && r.remote.repair.sealGeneration === r.sealed.generation && r.remote.repair.authorizationGeneration === r.expectedGeneration && r.remote.repair.inventoryDigest === archiveInventoryDigest(r.inventory), "remote repair identity");
        fhAssert(this.options.catalogAuthority, "remote catalog authority required");
        const durable = this.value(this.options.catalogAuthority.remote(r.remote.commitId));
        fhAssert(durable && equal(durable, r.remote), "remote catalog receipt absent/mismatch");
        this.save("remote-inventory", r.remote.commitId, paneKey2(r.pane), r.inventory);
      });
      return this.reclaimVerified({ ...r, remote: r.remote });
    } catch (e) {
      return fail(e);
    }
  }
  physical() {
    let allocated = 0;
    for (const suffix of ["", "-wal", "-shm"]) {
      const p = join3(this.root, "flag-on-v1.sqlite" + suffix);
      if (existsSync3(p))
        allocated += statSync(p).blocks * 512;
    }
    const list = this.db.query("SELECT sealed FROM fh_segment WHERE sealed IS NOT NULL AND state!='remote'").all();
    for (const s of list) {
      const seal = JSON.parse(String(s.sealed));
      for (const f of [...seal.files, seal.manifest])
        if (existsSync3(f.path))
          allocated += statSync(f.path).blocks * 512;
    }
    const lockPath = join3(this.root, "flag-on-writer.sqlite");
    if (existsSync3(lockPath))
      allocated += statSync(lockPath).blocks * 512;
    const fs = statfsSync(this.root);
    return { allocated, free: fs.bfree, block: fs.bsize };
  }
}
var v2Digest2 = (kind, payload, encode) => v2Probe ? v2Span("canonical", () => v2Digest(kind, payload, encode)) : v2Digest(kind, payload, encode);
var v2WriteDigest2 = (request, encode) => v2Probe ? v2Span("canonical", () => v2WriteDigest(request, encode)) : v2WriteDigest(request, encode);
var validateV2Checkpoint2 = (c, encode) => v2Probe ? v2Span("canonical", () => validateV2Checkpoint(c, encode)) : validateV2Checkpoint(c, encode);
function v2BatchRows(command) {
  const c = command;
  return c?.kind === "batch" && Array.isArray(c.batch?.rows) ? c.batch.rows.length : 0;
}
function v2Failure(error2) {
  const code = typeof error2 === "object" && error2 ? String(error2.code ?? "") : "";
  if (/^SQLITE_(BUSY|LOCKED)/.test(code) || /database is locked/i.test(String(error2)))
    return { status: "busy", reason: "snapshot-gate", retryAfterMs: 20 };
  if (/^(ENOSPC|EDQUOT|EIO|EROFS|SQLITE_(FULL|IOERR|CANTOPEN|READONLY))/.test(code) || /database or disk is full|disk I\/O error/i.test(String(error2)))
    return { status: "error", code: "io", message: String(error2) };
  return fail(error2);
}
function v2ProfileFence(db, digest2) {
  if (!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='fh_v2_object'").get())
    return false;
  const kind = "storage-profile", pane = "*", id = "root";
  const r = db.query("SELECT payload,checksum FROM fh_v2_object WHERE kind=? AND pane=? AND id=?").get(kind, pane, id);
  if (!r)
    return false;
  const payload = v2Unpack(r.payload, NEWARCH_V2_LIMITS.checkpointBytesPerPane + NEWARCH_V2_LIMITS.pageBytes);
  fhAssert(r.checksum === v2Digest2("stored-object", { kind, pane, id, payload }), "v2 corrupt object");
  const stored = v2CanonicalValue(payload);
  fhAssert(stored.digest === digest2, "v2 storage profile mismatch");
  return true;
}
function v2RequestProfile(request) {
  return request.storageProfile ?? v2LegacyStorageProfile(request.config.storage);
}
var V2_SCHEMA = `
CREATE TABLE IF NOT EXISTS fh_v2_meta(id INTEGER PRIMARY KEY CHECK(id=1),generation INTEGER NOT NULL,secret TEXT NOT NULL,version TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS fh_v2_object(kind TEXT NOT NULL,pane TEXT NOT NULL,id TEXT NOT NULL,payload TEXT NOT NULL,checksum TEXT NOT NULL,PRIMARY KEY(kind,pane,id)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS fh_v2_pane(pane TEXT PRIMARY KEY,session TEXT NOT NULL,payload TEXT NOT NULL,checksum TEXT NOT NULL) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS fh_v2_session ON fh_v2_pane(session,pane);
CREATE TABLE IF NOT EXISTS fh_v2_timeline(pane TEXT NOT NULL,n INTEGER NOT NULL,revision INTEGER NOT NULL,kind TEXT NOT NULL,id TEXT NOT NULL,segment TEXT NOT NULL,payload TEXT,checksum TEXT NOT NULL,PRIMARY KEY(pane,n),UNIQUE(pane,kind,id)) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS fh_v2_segment ON fh_v2_timeline(pane,segment,n);
`;
var V2_STORAGE_FORMAT = "newarch-v2/HS01";
var V2_PACKED_KINDS = new Set(["receipt", "checkpoint", "sealed-checkpoint"]);
function v2Pack(payload) {
  const packed = Buffer.concat([Buffer.from("HS01"), deflateSync(Buffer.from(payload), { level: 6 })]);
  return packed.byteLength < Buffer.byteLength(payload) ? packed : payload;
}
function v2Unpack(stored, limit) {
  if (typeof stored === "string") {
    fhAssert(Buffer.byteLength(stored) <= limit, "v2 storage logical bound");
    return stored;
  }
  fhAssert(stored instanceof Uint8Array && stored.byteLength > 4 && stored.byteLength <= limit && Buffer.from(stored.subarray(0, 4)).toString("latin1") === "HS01", "v2 storage format tag");
  const compressed = stored.subarray(4);
  const decoded = inflateSync(compressed, { maxOutputLength: limit, info: true });
  fhAssert(decoded.engine.bytesWritten === compressed.byteLength, "v2 storage trailing data");
  return new TextDecoder("utf-8", { fatal: true }).decode(decoded.buffer);
}
function v2RowShape(row) {
  try {
    const key = (text) => {
      nonempty(text);
      fhAssert(text.isWellFormed() && Buffer.byteLength(text) <= NEWARCH_V2_LIMITS.maxIdentityBytes, "identity bound");
    };
    const pane = (p) => {
      const k = paneKey2(p);
      key(p.serverIdentity);
      key(p.paneId);
      return k;
    };
    const rowPane = paneKey2(row.id.pane);
    const rowId = (id) => {
      const k = pane(id.pane);
      key(id.segmentId);
      safe2(id.rowOrdinal);
      fhAssert(k === rowPane, "origin pane");
    };
    rowId(row.id);
    geometry(row.geometry);
    fhAssert(row.geometry.columns <= NEWARCH_V2_LIMITS.maxColumns && row.geometry.rows <= NEWARCH_V2_LIMITS.maxRows, "geometry");
    content({ ...row, softWrap: row.wrapStatus === "wrapped" });
    fhAssert(row.cells.length === row.geometry.columns, "cell count");
    fhAssert(row.finalized === true && ["normal", "alternate"].includes(row.buffer) && ["wrapped", "unwrapped", "unknown"].includes(row.wrapStatus), "row metadata");
    fhAssert(row.wrapPad <= 1 && (row.wrapPad === 0 || row.wrapStatus === "wrapped"), "wrap pad");
    for (let i = 0;i < row.cells.length; i++) {
      const cell = row.cells[i];
      fhAssert(cell.width !== 2 || row.cells[i + 1]?.width === 0, "wide cell continuation");
      fhAssert(cell.width !== 0 || i > 0 && row.cells[i - 1].width === 2 && cell.text === "", "orphan continuation");
    }
    const checked = new Set;
    const origin = (o) => {
      if (checked.has(o))
        return;
      switch (o.kind) {
        case "durable":
          rowId(o.rowId);
          break;
        case "capture":
          key(o.snapshotId);
          safe2(o.rowIndex);
          break;
        case "pipe": {
          const k = pane(o.range.epoch.pane);
          key(o.range.epoch.attachId);
          key(o.range.epoch.collectorIncarnation);
          safe2(o.range.start);
          safe2(o.range.end);
          safe2(o.ordinal);
          fhAssert(o.range.start <= o.range.end && k === rowPane, "origin range/pane");
          break;
        }
        default:
          throw Error("origin kind");
      }
      checked.add(o);
    };
    origin(row.origin);
    fhAssert(Array.isArray(row.cellOrigins) && row.cellOrigins.length === row.cells.length, "origin count");
    row.cellOrigins.forEach(origin);
  } catch (error2) {
    throw Error("v2 row shape: " + String(error2));
  }
}
function v2CanonicalValue(payload) {
  const value = JSON.parse(payload);
  fhAssert(streamCanonical2(value) === payload, "v2 storage canonical equality");
  v2Leave("decode");
  return value;
}

class V2Storage {
  root;
  storeId;
  hooks;
  release;
  #db;
  #cap;
  #config;
  #profile;
  #secret;
  #closed = false;
  constructor(db, root, storeId, request, hooks, release) {
    this.root = root;
    this.storeId = storeId;
    this.hooks = hooks;
    this.release = release;
    this.#db = db;
    this.#config = copy(request.config);
    this.#profile = copy(v2RequestProfile(request));
    const generation = db.transaction(() => {
      db.exec(V2_SCHEMA);
      db.query("INSERT OR IGNORE INTO fh_v2_meta VALUES(1,0,?,?)").run(randomUUID3(), "newarch-v2");
      const meta = db.query("SELECT * FROM fh_v2_meta WHERE id=1").get();
      fhAssert(meta.version === "newarch-v2" || meta.version === V2_STORAGE_FORMAT, "unsupported v2 storage");
      this.bindStorageProfile();
      const next = Number(meta.generation) + 1;
      safe2(next);
      db.query("UPDATE fh_v2_meta SET generation=?,version=? WHERE id=1").run(next, V2_STORAGE_FORMAT);
      return next;
    }).immediate();
    this.#secret = String(db.query("SELECT secret FROM fh_v2_meta WHERE id=1").get().secret);
    this.#cap = Object.freeze({ owner: "capture-engine", rootId: root, engineId: request.engineId, generation });
    const pageSize = Number(db.query("PRAGMA page_size").get().page_size);
    db.exec(`PRAGMA max_page_count=${v2DatabasePageLimit(this.#profile, pageSize)};`);
  }
  bindStorageProfile() {
    const digest2 = v2StorageProfileDigest(this.#profile);
    if (!v2ProfileFence(this.#db, digest2))
      this.put("storage-profile", "*", "root", {
        schema: "newarch-v2",
        digest: digest2,
        name: this.#profile.name,
        storage: this.#profile.storage,
        allocation: this.#profile.allocation
      });
  }
  walOverBudget() {
    const allocation = this.#profile.allocation;
    if (!allocation)
      return false;
    const wal = join3(this.root, "flag-on-v1.sqlite-wal"), size2 = () => existsSync3(wal) ? statSync(wal).size : 0;
    if (size2() <= allocation.walBytes)
      return false;
    try {
      this.#db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch {}
    return size2() > allocation.walBytes;
  }
  ports() {
    const writer = Object.freeze({
      commit: (c, r) => this.profiled(() => this.commit(c, r)),
      reserveBirth: (c, r) => this.reserve(c, r),
      cancelBirth: (c, r) => this.cancel(c, r),
      close: async (c) => {
        try {
          this.authorize(c);
          this.#closed = true;
          this.release();
          return ok3(null);
        } catch (e) {
          return v2Failure(e);
        }
      }
    });
    const reader = Object.freeze({
      owner: (p) => this.read(() => this.owner(p)),
      sessionOwner: (s) => this.read(() => this.get("session", "", v2SessionKey(s))),
      receipt: (p, id) => this.read(() => this.get("receipt", v2PaneKey(p), id)),
      checkpoint: (p) => this.read(() => this.get("checkpoint", v2PaneKey(p), "live")),
      lastAudit: (p) => this.read(() => this.get("audit", v2PaneKey(p), "latest")),
      sealed: (p, id) => this.read(() => this.get("seal", v2PaneKey(p), id)),
      export: (p, id) => this.read(() => this.get("export", v2PaneKey(p), id)),
      locator: (p, id) => this.read(() => this.get("locator", v2PaneKey(p), id)),
      panes: (s, cursor) => this.read(() => this.panes(s, cursor)),
      page: async (r) => this.read(() => this.page(r))
    });
    const authority = Object.freeze({
      writerGeneration: () => this.authorityRead(() => this.currentGeneration()),
      incidentResolution: (pane, incidentId) => this.authorityRead(() => this.incidentResolution(pane, incidentId)),
      rawPins: (pane, epoch) => this.authorityRead(() => this.rawPins(pane, epoch)),
      reserveRearm: (pane, incidentId, expectedGeneration) => this.authorityRead(() => this.reserveRearm(pane, incidentId, expectedGeneration))
    });
    return { capability: this.#cap, writer, reader, authority };
  }
  live() {
    fhAssert(!this.#closed, "v2 store closed");
  }
  observeRows(rows) {
    if (rows > 0)
      this.hooks.observe?.({ kind: "row-encode", rows });
  }
  encoder() {
    const inner = streamCanonicalEncoder();
    return (value, rows = 0) => {
      this.observeRows(rows);
      return v2Probe ? v2Span("canonical", () => inner(value)) : inner(value);
    };
  }
  profiled(f) {
    const observe = this.hooks.observe;
    if (!observe)
      return f();
    const probe = v2Probe = { at: performance.now(), stack: [], ms: { canonical: 0, decode: 0, pack: 0, commit: 0 } };
    try {
      return f();
    } finally {
      const ms = probe.ms;
      v2Probe = null;
      observe({ kind: "commit-profile", canonicalMs: ms.canonical, decodeMs: ms.decode, packMs: ms.pack, commitMs: ms.commit });
    }
  }
  authorize(c) {
    this.live();
    fhAssert(c === this.#cap, "v2 forged capability");
    const row = this.#db.query("SELECT generation FROM fh_v2_meta WHERE id=1").get();
    fhAssert(row.generation === c.generation, "v2 stale generation");
  }
  read(f) {
    try {
      this.live();
      return ok3(f());
    } catch (e) {
      return v2Failure(e);
    }
  }
  authorityRead(f) {
    try {
      this.live();
      return ok3(this.#db.transaction(f)());
    } catch (e) {
      return v2Failure(e);
    }
  }
  currentGeneration() {
    const row = this.#db.query("SELECT generation FROM fh_v2_meta WHERE id=1").get();
    return v2WriterGeneration(Number(row.generation));
  }
  incidentResolution(pane, incidentId) {
    nonempty(incidentId);
    const key = v2PaneKey(pane);
    const resolved = this.get("incident-resolution", key, incidentId);
    if (resolved)
      return resolved;
    const incident = this.get("incident", key, incidentId);
    if (!incident)
      return null;
    return {
      schema: "newarch-v2",
      pane,
      incidentId,
      state: "pending",
      receipt: null,
      writerGeneration: this.currentGeneration()
    };
  }
  reserveRearm(pane, incidentId, expectedGeneration) {
    nonempty(incidentId);
    const key = v2PaneKey(pane);
    this.authorize(this.#cap);
    fhAssert(expectedGeneration === this.#cap.generation, "v2 rearm generation");
    const resolution = this.get("incident-resolution", key, incidentId);
    if (!resolution)
      return null;
    fhAssert(resolution.schema === "newarch-v2" && resolution.state === "resolved" && resolution.receipt && resolution.incidentId === incidentId && v2PaneKey(resolution.pane) === key, "v2 rearm resolution");
    const incident = this.get("incident", key, incidentId);
    const receipt = this.get("receipt", key, resolution.receipt.operationId);
    fhAssert(incident && incident.incidentId === incidentId && receipt && equal(receipt, resolution.receipt), "v2 rearm receipt readback");
    fhAssert(receipt.kind === "ssot-durable" && v2PaneKey(receipt.pane) === key && incident.revision === receipt.revision, "v2 rearm revision");
    fhAssert(resolution.writerGeneration === receipt.generation && receipt.generation <= this.#cap.generation, "v2 rearm stored generation");
    const observation = {
      schema: "newarch-v2",
      purpose: "reserve-rearm",
      pane: resolution.pane,
      incidentId,
      incidentDigest: v2EmergencyIncidentDigest(incident),
      resolvedReceipt: receipt,
      authorizedGeneration: v2WriterGeneration(this.#cap.generation)
    };
    return observation;
  }
  rawPins(pane, epoch) {
    const key = v2PaneKey(pane), checkpoint = this.get("checkpoint", key, "live");
    fhAssert(checkpoint && equal(checkpoint.through.epoch, epoch), "v2 raw pin epoch/checkpoint");
    let rowPins = 0;
    for (const row of fhRows(this.#db, "SELECT id FROM fh_v2_object WHERE kind='pin' AND pane=?", key)) {
      const pin = this.get("pin", key, String(row.id));
      if (pin && !pin.released)
        rowPins++;
    }
    return {
      schema: "newarch-v2",
      pane,
      epoch: checkpoint.through.epoch,
      revision: checkpoint.revision,
      writerGeneration: this.currentGeneration(),
      rawPins: [{
        pinId: `checkpoint:${checkpoint.checkpointId}`,
        holder: "decoder-checkpoint",
        from: checkpoint.replayFloor
      }],
      rowPins
    };
  }
  tx(cap, phase, f) {
    try {
      this.live();
      fhAssert(!this.walOverBudget(), "v2 storage wal budget");
      const result = this.#db.transaction(() => {
        this.authorize(cap);
        this.hooks.boundary?.(phase + "-before-write");
        const value = f();
        this.hooks.boundary?.(phase + "-before-commit");
        v2Enter("commit");
        return value;
      }).immediate();
      v2Leave("commit");
      try {
        this.walOverBudget();
      } catch {}
      this.hooks.boundary?.(phase + "-after-commit");
      return ok3(result);
    } catch (e) {
      return v2Failure(e);
    }
  }
  get(kind, pane, id) {
    const r = this.#db.query("SELECT payload,checksum FROM fh_v2_object WHERE kind=? AND pane=? AND id=?").get(kind, pane, id);
    if (!r)
      return null;
    if (kind === "checkpoint")
      v2Enter("decode");
    const payload = v2Unpack(r.payload, NEWARCH_V2_LIMITS.checkpointBytesPerPane + NEWARCH_V2_LIMITS.pageBytes);
    if (kind === "checkpoint")
      this.hooks.observe?.({ kind: "checkpoint-decode" });
    fhAssert(r.checksum === v2Digest2("stored-object", { kind, pane, id, payload }), "v2 corrupt object");
    return v2CanonicalValue(payload);
  }
  put(kind, pane, id, value) {
    nonempty(id);
    const payload = streamCanonical2(value);
    fhAssert(Buffer.byteLength(payload) <= NEWARCH_V2_LIMITS.checkpointBytesPerPane + NEWARCH_V2_LIMITS.pageBytes, "v2 object bound");
    this.#db.query("INSERT OR REPLACE INTO fh_v2_object VALUES(?,?,?,?,?)").run(kind, pane, id, V2_PACKED_KINDS.has(kind) ? v2Pack(payload) : payload, v2Digest2("stored-object", { kind, pane, id, payload }));
  }
  owner(p) {
    const key = v2PaneKey(p), r = this.#db.query("SELECT * FROM fh_v2_pane WHERE pane=?").get(key);
    if (!r)
      return null;
    fhAssert(r.checksum === v2Digest2("stored-owner", { pane: key, session: r.session, payload: r.payload }), "v2 corrupt owner");
    return { ...JSON.parse(String(r.payload)), generation: this.#cap.generation };
  }
  putOwner(owner) {
    const pane = v2PaneKey(owner.pane.pane), session = v2SessionKey(owner.pane.session), payload = streamCanonical2(owner);
    this.#db.query("INSERT OR REPLACE INTO fh_v2_pane VALUES(?,?,?,?)").run(pane, session, payload, v2Digest2("stored-owner", { pane, session, payload }));
  }
  async reserve(cap, r) {
    return this.tx(cap, "v2-reserve", () => {
      fhAssert(r.expectedGeneration === cap.generation, "v2 reservation generation");
      const { digest: digest2, expectedGeneration, ...body } = r;
      fhAssert(digest2 === v2Digest2("birth-reservation", body), "v2 reservation digest");
      const intent = r.intent, session = v2SessionKey(intent.session);
      nonempty(intent.operationId);
      fhAssert(intent.schema === "newarch-v2" && intent.owner === "capture-engine" && ["new-session", "new-window"].includes(intent.command), "v2 reservation schema");
      this.checkGeometry(intent.geometry);
      const old = this.get("reservation", session, intent.operationId);
      if (old) {
        fhAssert(old.digest === digest2, "v2 reservation collision");
        return old;
      }
      const account = this.get("session", "", session);
      fhAssert(intent.command === "new-session" ? !account : account && account.state !== "closed", "v2 session already reserved or missing");
      const receipt = {
        schema: "newarch-v2",
        session: intent.session,
        operationId: intent.operationId,
        commitId: randomUUID3(),
        digest: digest2,
        generation: cap.generation,
        owner: "capture-engine"
      };
      if (!account)
        this.put("session", "", session, {
          schema: "newarch-v2",
          session: intent.session,
          owner: "capture-engine",
          birthOperationId: intent.operationId,
          state: "reserved",
          generation: cap.generation
        });
      this.put("birth-intent", session, intent.operationId, intent);
      this.put("reservation", session, intent.operationId, receipt);
      return receipt;
    });
  }
  async cancel(cap, r) {
    return this.tx(cap, "v2-cancel", () => {
      const { digest: digest2, expectedGeneration, ...body } = r, key = v2SessionKey(r.session);
      fhAssert(expectedGeneration === cap.generation && digest2 === v2Digest2("birth-cancel", body), "v2 cancellation fence");
      const previous = this.get("cancel", key, r.operationId);
      if (previous) {
        fhAssert(previous.digest === digest2, "v2 cancellation collision");
        return previous;
      }
      fhAssert(this.get("reservation", key, r.birthOperationId), "v2 unknown birth");
      fhAssert(!this.get("activated", key, r.birthOperationId), "v2 cannot cancel active birth");
      const receipt = {
        schema: "newarch-v2",
        session: r.session,
        operationId: r.operationId,
        digest: digest2,
        commitId: randomUUID3(),
        generation: cap.generation,
        owner: "capture-engine"
      };
      this.put("cancelled-birth", key, r.birthOperationId, receipt);
      this.put("cancel", key, r.operationId, receipt);
      return receipt;
    });
  }
  checkGeometry(g) {
    geometry(g);
    fhAssert(g.policy === "fixed-at-birth" && g.panesPerWindow === 1 && g.columns <= NEWARCH_V2_LIMITS.maxColumns && g.rows <= NEWARCH_V2_LIMITS.maxRows, "v2 fixed geometry");
    nonempty(g.configVersion);
  }
  descriptor(d, pane) {
    fhAssert(d.schema === "newarch-v2" && d.owner === "capture-engine" && equal(d.pane, pane) && d.session.serverIdentity === pane.serverIdentity, "v2 owner identity");
    v2SessionKey(d.session);
    v2PaneKey(pane);
    nonempty(d.windowId);
    nonempty(d.birthOperationId);
    this.checkGeometry(d.geometry);
  }
  async commit(cap, r) {
    const result = this.tx(cap, "v2-" + r.command.kind, () => {
      const key = v2PaneKey(r.fence.pane), caller = r.command, encode = this.encoder();
      const prepared2 = encode(caller, v2BatchRows(caller));
      fhAssert(Buffer.byteLength(prepared2) <= NEWARCH_V2_LIMITS.checkpointBytesPerPane + NEWARCH_V2_LIMITS.pageBytes, "v2 command bound");
      fhAssert(v2WriteDigest2({ fence: r.fence, command: caller }, encode) === r.fence.digest, "v2 write digest");
      const command = structuredClone(caller), snapshot = this.encoder();
      fhAssert(snapshot(command, v2BatchRows(command)) === prepared2, "v2 write snapshot");
      let live;
      const durableCheckpoint = () => live === undefined ? live = this.get("checkpoint", key, "live") : live;
      let owner = this.owner(r.fence.pane);
      const previous = this.get("receipt", key, r.fence.operationId);
      const disposition = v2WriteDisposition(r.fence, cap.generation, owner?.durableRevision ?? 0, previous);
      if (disposition === "retry")
        return previous;
      fhAssert(disposition === "commit", "v2 " + disposition + " fence");
      const revision = (owner?.durableRevision ?? 0) + 1, commitId = randomUUID3();
      if (command.kind === "activate" || command.kind === "unrecorded-birth") {
        fhAssert(!owner, "v2 pane cannot be adopted/reactivated");
        const d = command.kind === "activate" ? command.ready.pane : command.pane;
        this.descriptor(d, r.fence.pane);
        const session = v2SessionKey(d.session), account = this.get("session", "", session);
        fhAssert(account && account.state !== "closed", "v2 session must be reserved before birth");
        let binding = null;
        if (command.kind === "activate") {
          const ready = command.ready;
          fhAssert(equal(this.get("birth-intent", session, d.birthOperationId), ready.intent) && !this.get("cancelled-birth", session, d.birthOperationId) && !this.get("activated", session, d.birthOperationId), "v2 birth intent absent/cancelled/used");
          fhAssert(equal(ready.intent.session, d.session) && equal(ready.intent.geometry, d.geometry) && ready.programHeld === true && ready.paneCountInWindow === 1 && ready.byte0.byteOffset === 0 && equal(ready.byte0.epoch.pane, d.pane) && equal(ready.binding.epoch, ready.byte0.epoch) && ready.geometryReadback.columns === d.geometry.columns && ready.geometryReadback.rows === d.geometry.rows, "v2 birth geometry/binding/byte0");
          fhAssert(ready.journal.bytes > 0 && /^[a-f0-9]{64}$/.test(ready.journal.sha256) && !!ready.journal.path, "v2 birth journal");
          const active = Number(this.#db.query("SELECT COUNT(*) AS n FROM fh_v2_pane WHERE json_extract(payload,'$.pane.state')='active'").get().n);
          fhAssert(active < this.#config.maxActivePanes, "v2 active pane capacity");
          const occupied = this.#db.query("SELECT 1 FROM fh_v2_pane WHERE session=? AND json_extract(payload,'$.pane.windowId')=? AND json_extract(payload,'$.pane.state')='active' LIMIT 1").get(session, d.windowId);
          fhAssert(!occupied, "v2 one pane per window");
          binding = ready.binding;
          this.put("activated", session, d.birthOperationId, { pane: d.pane, commitId });
        } else
          fhAssert(["unrecorded-birth", "birth-failed", "storage-outage"].includes(command.incident.reason), "v2 unrecorded incident");
        owner = {
          pane: { ...d, state: command.kind === "activate" ? "active" : "unrecorded" },
          generation: cap.generation,
          durableRevision: 0,
          frontier: null,
          incidentId: null,
          binding
        };
        this.put("session", "", session, { ...account, state: "active", generation: cap.generation });
      }
      fhAssert(owner, "v2 owner required");
      const receipt = {
        schema: "newarch-v2",
        kind: "ssot-durable",
        operationId: r.fence.operationId,
        pane: r.fence.pane,
        digest: r.fence.digest,
        commitId,
        generation: cap.generation,
        revision,
        frontier: owner.frontier,
        checkpointId: durableCheckpoint()?.checkpointId ?? null
      };
      let next = { ...owner, durableRevision: revision, generation: cap.generation };
      const resolvedIncidents = [];
      const addIncident = (incident) => {
        validateV2Incident(incident);
        fhAssert(equal(incident.pane, r.fence.pane) && equal(incident.geometry, owner.pane.geometry) && incident.revision === revision && equal(incident.frontier, next.frontier), "v2 incident fence");
        const positions = [incident.affected.after, incident.affected.through].map((id) => {
          if (!id)
            return null;
          const row = this.#db.query("SELECT n FROM fh_v2_timeline WHERE pane=? AND kind='row' AND id=?").get(key, streamCanonical2(id));
          fhAssert(row, "v2 incident affected row absent");
          return Number(row.n);
        });
        fhAssert(positions[0] === null || positions[1] === null || positions[0] <= positions[1], "v2 incident reversed interval");
        const old = this.get("incident", key, incident.incidentId);
        fhAssert(!old, old && equal(old, incident) ? "v2 incident already materialized" : "v2 incident collision");
        this.put("incident", key, incident.incidentId, incident);
        this.append(key, revision, "incident", incident.incidentId, "", incident);
        resolvedIncidents.push(incident.incidentId);
        next = {
          ...next,
          incidentId: incident.incidentId,
          pane: { ...next.pane, state: incident.action === "gap-and-stop" && next.pane.state !== "unrecorded" ? "stopped" : next.pane.state }
        };
      };
      const setCheckpoint = (cp) => {
        validateV2Checkpoint2(cp, snapshot);
        fhAssert(equal(cp.pane, r.fence.pane) && cp.revision === revision && equal(cp.geometry, owner.pane.geometry) && equal(cp.frontier, next.frontier), "v2 checkpoint fence");
        const old = durableCheckpoint();
        fhAssert(!old || equal(old.through.epoch, cp.through.epoch) && cp.through.byteOffset >= old.through.byteOffset && cp.replayFloor.byteOffset >= old.replayFloor.byteOffset && cp.checkpointId !== old.checkpointId, "v2 checkpoint monotonicity");
        this.put("checkpoint", key, "live", cp);
        live = undefined;
        receipt.checkpointId = cp.checkpointId;
      };
      switch (command.kind) {
        case "activate":
          fhAssert(equal(command.checkpoint.through, command.ready.byte0) && equal(command.checkpoint.replayFloor, command.ready.byte0) && command.checkpoint.frontier === null, "v2 activation checkpoint");
          setCheckpoint(command.checkpoint);
          break;
        case "unrecorded-birth":
          addIncident(command.incident);
          break;
        case "incident":
          addIncident(command.incident);
          break;
        case "stop":
          fhAssert(command.incident.action === "gap-and-stop", "v2 stop requires durable incident");
          addIncident(command.incident);
          break;
        case "close":
          next = { ...next, pane: { ...next.pane, state: "closed" } };
          break;
        case "checkpoint": {
          fhAssert(next.pane.state === "active", "v2 stopped capture");
          const durable = this.get("checkpoint", key, "live");
          fhAssert(durable && equal(command.checkpoint.through, durable.through) && equal(command.checkpoint.replayFloor, durable.replayFloor), "v2 checkpoint requires unchanged raw positions");
          setCheckpoint(command.checkpoint);
          break;
        }
        case "batch": {
          fhAssert(next.pane.state === "active", "v2 stopped capture");
          const b = command.batch;
          const rowText = b.rows.map((row) => snapshot(row));
          const rowsBytes = rowText.reduce((n, text) => n + Buffer.byteLength(text), 2 + Math.max(0, rowText.length - 1));
          fhAssert(b.rows.length <= NEWARCH_V2_LIMITS.pendingRowsPerPane && b.decisions.length <= NEWARCH_V2_LIMITS.pendingRowsPerPane && b.incidents.length <= NEWARCH_V2_LIMITS.pageEntries && rowsBytes <= NEWARCH_V2_LIMITS.pageBytes, "v2 batch bound");
          const durable = durableCheckpoint();
          const issued = this.hooks.inputReceipt?.(caller.batch.input);
          fhAssert(durable && issued?.status === "ok" && v2BatchInputMatchesIssued(b.input, issued.value, durable, b.checkpoint), "v2 durable input authority");
          for (const [i, row] of b.rows.entries()) {
            v2RowShape(row);
            fhAssert(row.finalized && equal(row.id.pane, r.fence.pane) && equal(row.geometry, { columns: next.pane.geometry.columns, rows: next.pane.geometry.rows }), "v2 row identity/geometry");
            nonempty(row.id.segmentId);
            safe2(row.id.rowOrdinal);
            fhAssert(!this.get("segment-seal", key, row.id.segmentId), "v2 sealed segment");
            const metrics = this.get("segment-stats", key, row.id.segmentId) ?? this.segmentMetrics(key, row.id.segmentId);
            const rowBytes = metrics.bytes + Buffer.byteLength(rowText[i]) + 1;
            fhAssert(rowBytes <= FLAGON_BUDGET.archiveChunkBytes / 2 && metrics.rows < 65536, "v2 segment full; seal and rotate");
            fhAssert(row.id.rowOrdinal === metrics.rows, "v2 row order");
            this.append(key, revision, "row", streamCanonical2(row.id), row.id.segmentId, row, rowText[i]);
            this.put("segment-stats", key, row.id.segmentId, { bytes: rowBytes, rows: metrics.rows + 1 });
            next = { ...next, frontier: row.id };
          }
          for (const incident of b.incidents)
            addIncident(incident);
          this.put("decisions", key, r.fence.operationId, b.decisions.map((d) => ({
            kind: d.kind,
            stamp: d.stamp,
            evidence: d.evidence,
            ...d.kind === "accept" ? { checkpointId: d.checkpoint.checkpointId, rowIds: d.rows.map((row) => row.id) } : d.kind === "gap" ? { incidentId: d.incident.incidentId } : { deadlineMonoMs: d.deadlineMonoMs }
          })));
          this.#db.query("DELETE FROM fh_v2_object WHERE kind='stage' AND pane=? AND id='pending'").run(key);
          setCheckpoint(b.checkpoint);
          break;
        }
        case "stage": {
          fhAssert(next.pane.state === "active", "v2 stopped capture");
          safe2(command.ordinal);
          nonempty(command.transactionId);
          fhAssert(command.rows.length <= NEWARCH_V2_LIMITS.pendingRowsPerPane && bytes(command.rows) <= NEWARCH_V2_LIMITS.pendingBytesPerPane, "v2 staging bound");
          for (const row of command.rows) {
            content({ ...row, softWrap: row.wrapStatus === "wrapped" });
            fhAssert(row.finalized && equal(row.id.pane, r.fence.pane), "v2 staged pane");
          }
          this.put("stage", key, "pending", command);
          break;
        }
        case "audit": {
          const a = command.result;
          fhAssert(bytes(a) <= NEWARCH_V2_LIMITS.checkpointBytesPerPane + NEWARCH_V2_LIMITS.diagnosticEventBytes, "v2 audit bound");
          if (a.kind !== "inconclusive") {
            const cp = durableCheckpoint();
            fhAssert(cp && next.pane.state === "active" && v2AuditComparable(a.evidence, { pane: cp.pane, through: cp.through, revision: owner.durableRevision, geometry: cp.geometry, checkpointId: cp.checkpointId }, this.#config.audit), "v2 stale/unordered audit");
            if (a.kind === "repair-pending") {
              fhAssert(a.expectedRevision === owner.durableRevision && equal(a.checkpoint.through, cp.through) && equal(a.checkpoint.replayFloor, cp.replayFloor), "v2 audit revision/source");
              setCheckpoint(a.checkpoint);
              addIncident(a.incident);
            } else if (a.kind === "annotate")
              addIncident(a.incident);
            else {
              fhAssert(a.evidence.expectedDigest === a.evidence.actualDigest, "v2 audit match digest");
              this.put("audited", key, "latest", owner.durableRevision);
            }
          }
          this.put("audit", key, "latest", a);
          break;
        }
        case "seal":
          this.seal(r.fence.pane, command.segmentId, receipt);
          break;
        case "materialize-export":
          this.materialize(r.fence.pane, command.sealCommitId, r.fence.operationId);
          break;
        case "locator":
          this.locate(r.fence.pane, frozen(command.locator), commitId);
          break;
        case "pin":
          nonempty(command.pinId);
          fhAssert(!this.get("remote-segment", key, command.segmentId), "v2 segment already remote");
          fhAssert(this.#db.query("SELECT 1 FROM fh_v2_timeline WHERE pane=? AND segment=? LIMIT 1").get(key, command.segmentId), "v2 unknown segment");
          fhAssert(!this.get("pin", key, command.pinId), "v2 pin id reused");
          this.put("pin", key, command.pinId, { segmentId: command.segmentId, released: false });
          break;
        case "release-pin": {
          const pin = this.get("pin", key, command.pinId);
          fhAssert(pin, "v2 unknown pin");
          this.put("pin", key, command.pinId, { ...pin, released: true });
          break;
        }
        case "reclaim":
          this.reclaim(r.fence.pane, command.locatorCommitId, command.segmentId);
          break;
        default:
          throw Error("v2 unsupported command");
      }
      this.putOwner(next);
      const completed = { ...receipt, frontier: next.frontier };
      this.put("receipt", key, r.fence.operationId, completed);
      for (const incidentId of resolvedIncidents)
        this.put("incident-resolution", key, incidentId, {
          schema: "newarch-v2",
          pane: r.fence.pane,
          incidentId,
          state: "resolved",
          receipt: completed,
          writerGeneration: v2WriterGeneration(cap.generation)
        });
      return completed;
    });
    if (result.status === "ok" && r.command.kind === "reclaim") {
      try {
        this.cleanupReclaim(cap, r.fence.pane, r.command.segmentId);
      } catch (e) {
        return v2Failure(e);
      }
    }
    return result;
  }
  append(pane, revision, kind, id, segment, value, text) {
    const n = Number(this.#db.query("SELECT COALESCE(MAX(n),0)+1 AS n FROM fh_v2_timeline WHERE pane=?").get(pane).n);
    if (text === undefined && kind === "row")
      this.observeRows(1);
    const payload = text ?? streamCanonical2(value);
    fhAssert(Buffer.byteLength(payload) <= NEWARCH_V2_LIMITS.pageBytes - 64, "v2 timeline entry bound");
    this.#db.query("INSERT INTO fh_v2_timeline VALUES(?,?,?,?,?,?,?,?)").run(pane, n, revision, kind, id, segment, kind === "row" ? v2Pack(payload) : payload, v2Digest2("timeline", { pane, n, revision, kind, id, segment, payload }));
  }
  logicalTimeline(r) {
    const payload = v2Unpack(r.payload, NEWARCH_V2_LIMITS.pageBytes - 64);
    fhAssert(r.checksum === v2Digest2("timeline", {
      pane: r.pane,
      n: r.n,
      revision: r.revision,
      kind: r.kind,
      id: r.id,
      segment: r.segment,
      payload
    }), "v2 corrupt timeline");
    const value = v2CanonicalValue(payload);
    if (r.kind === "row") {
      const row = value;
      v2RowShape(row);
      fhAssert(v2PaneKey(row.id.pane) === r.pane && streamCanonical2(row.id) === r.id && row.id.segmentId === r.segment, "v2 row storage identity");
    }
    return { ...r, payload };
  }
  timeline(r) {
    const value = JSON.parse(this.logicalTimeline(r).payload);
    return r.kind === "row" ? { kind: "row", row: value } : { kind: "incident", incident: value };
  }
  segmentMetrics(pane, segment) {
    const metrics = { bytes: 0, rows: 0 };
    for (const row of fhRows(this.#db, "SELECT * FROM fh_v2_timeline WHERE pane=? AND segment=? AND kind='row' ORDER BY n", pane, segment)) {
      metrics.bytes += Buffer.byteLength(this.logicalTimeline(row).payload) + 1;
      metrics.rows++;
    }
    return metrics;
  }
  *exportRecords(pane, segment) {
    for (const row of fhRows(this.#db, "SELECT * FROM fh_v2_timeline WHERE pane=? AND segment=? ORDER BY n", pane, segment))
      yield this.logicalTimeline(row);
  }
  token(payload) {
    const data = Buffer.from(streamCanonical2(payload)).toString("base64url");
    return data + "." + createHmac("sha256", this.#secret).update(data).digest("hex");
  }
  untoken(token) {
    fhAssert(token.length <= NEWARCH_V2_LIMITS.cursorBytes, "v2 cursor bound");
    const [data, mac, extra] = token.split(".");
    fhAssert(data && mac && /^[a-f0-9]{64}$/.test(mac) && !extra, "v2 cursor format");
    const expected = createHmac("sha256", this.#secret).update(data).digest();
    const actual = Buffer.from(mac, "hex");
    fhAssert(actual.length === expected.length && timingSafeEqual(actual, expected), "v2 cursor authentication");
    return JSON.parse(Buffer.from(data, "base64url").toString());
  }
  cursor(pane, revision, n) {
    return {
      schema: "newarch-v2",
      pane,
      storeId: this.storeId,
      timelineRevision: revision,
      token: this.token({ kind: "page", pane: v2PaneKey(pane), store: this.storeId, revision, n })
    };
  }
  page(r) {
    validateV2ReadRequest(r);
    fhAssert(r.maxBytes >= 2, "v2 bounded-read envelope");
    const owner = this.owner(r.pane);
    fhAssert(owner, "v2 pane missing");
    const key = v2PaneKey(r.pane), revision = r.cursor?.timelineRevision ?? owner.durableRevision;
    fhAssert(revision <= owner.durableRevision, "v2 future cursor");
    const max = Number(this.#db.query("SELECT COALESCE(MAX(n),0) AS n FROM fh_v2_timeline WHERE pane=? AND revision<=?").get(key, revision).n);
    let boundary = r.direction === "after" ? 0 : max;
    if (r.cursor) {
      const c = this.untoken(r.cursor.token);
      fhAssert(r.cursor.storeId === this.storeId && c.kind === "page" && c.store === this.storeId && c.pane === key && c.revision === revision, "v2 cursor scope");
      safe2(c.n);
      fhAssert(c.n <= max, "v2 cursor position");
      boundary = c.n;
    }
    const back = r.direction === "before", entries = [];
    let encoded = 0;
    const measure = (v) => {
      encoded += Array.isArray(v) ? v.length : 1;
      return bytes(v);
    };
    let lo = boundary, hi = boundary, blocked = null;
    const query = `SELECT * FROM fh_v2_timeline WHERE pane=? AND revision<=? AND n${back ? "<=" : ">"}? ORDER BY n ${back ? "DESC" : "ASC"} LIMIT 1`;
    let scan = boundary;
    let running = 2;
    for (let count = 0;count < r.maxEntries; count++) {
      const item = this.#db.query(query).get(key, revision, scan);
      if (!item)
        break;
      scan = back ? Number(item.n) - 1 : Number(item.n);
      let decoded = null;
      if (item.payload === null) {
        const locator = this.get("remote-segment", key, String(item.segment));
        fhAssert(locator, "v2 missing remote locator");
        let reason = "offline";
        try {
          const restored = this.hooks.remoteRow?.(locator, JSON.parse(String(item.id)));
          if (restored?.status === "ok") {
            if (restored.value) {
              fhAssert(bytes(restored.value) <= NEWARCH_V2_LIMITS.pageBytes, "v2 restore row bound");
              decoded = this.timeline({ ...item, payload: streamCanonical2(restored.value) });
            } else
              reason = "missing";
          } else if (restored?.status === "error" && restored.code === "integrity")
            reason = "corrupt";
        } catch {
          reason = "corrupt";
        }
        if (!decoded) {
          blocked = {
            kind: "blocked",
            cursor: this.cursor(r.pane, revision, back ? lo : hi),
            state: { kind: "remote-unavailable", bundleId: locator.verified.bundle.bundleId, reason, retryAfterMs: 1000 }
          };
          break;
        }
      }
      const entry = decoded ?? this.timeline(item), eb = measure(entry), size2 = running + eb + (entries.length ? 1 : 0);
      if (size2 > r.maxBytes) {
        fhAssert(entries.length > 0, "v2 bounded-read entry exceeds maxBytes");
        break;
      }
      entries.push(entry);
      running = size2;
      if (back)
        lo = Number(item.n) - 1;
      else
        hi = Number(item.n);
    }
    if (back)
      entries.reverse();
    const before = back && blocked ? blocked : lo === 0 ? { kind: "end" } : { kind: "more", cursor: this.cursor(r.pane, revision, lo) };
    const after = !back && blocked ? blocked : hi === max ? { kind: "end" } : { kind: "more", cursor: this.cursor(r.pane, revision, hi) };
    const states = entries.flatMap((e) => e.kind === "incident" ? [{ kind: "incident", incident: e.incident }] : []);
    const ids = new Set(states.flatMap((s) => s.kind === "incident" ? [s.incident.incidentId] : []));
    const rowPositions = entries.flatMap((e) => e.kind === "row" ? [Number(this.#db.query("SELECT n FROM fh_v2_timeline WHERE pane=? AND kind='row' AND id=?").get(key, streamCanonical2(e.row.id)).n)] : []);
    for (const row of fhRows(this.#db, "SELECT * FROM fh_v2_timeline WHERE pane=? AND kind='incident' ORDER BY n DESC", key)) {
      const e = this.timeline(row);
      if (e.kind !== "incident" || ids.has(e.incident.incidentId))
        continue;
      const i = e.incident;
      const position = (id, fallback) => {
        if (!id)
          return fallback;
        const found = this.#db.query("SELECT n FROM fh_v2_timeline WHERE pane=? AND kind='row' AND id=?").get(key, streamCanonical2(id));
        fhAssert(found, "v2 annotation row missing");
        return Number(found.n);
      };
      const start = position(i.affected.after, 0), end = position(i.affected.through, Infinity);
      if (rowPositions.some((n) => n > start && n <= end) || i.incidentId === owner.incidentId) {
        states.push({ kind: "incident", incident: i });
        ids.add(i.incidentId);
        fhAssert(states.length <= NEWARCH_V2_LIMITS.pageEntries && bytes(states) <= NEWARCH_V2_LIMITS.pageBytes, "v2 annotation page bound");
      }
    }
    if (blocked?.kind === "blocked")
      states.push(blocked.state);
    if (!states.length)
      states.push({ kind: "exact", auditedRevision: this.get("audited", key, "latest") });
    if (encoded)
      this.hooks.observe?.({ kind: "page-encode", entries: encoded });
    return { schema: "newarch-v2", pane: r.pane, revision, entries, payloadBytes: running, states, before, after };
  }
  panes(session, cursor) {
    const key = v2SessionKey(session);
    let after = "";
    if (cursor) {
      const c = this.untoken(cursor);
      fhAssert(c.kind === "panes" && c.session === key && c.store === this.storeId, "v2 pane cursor");
      after = c.after;
    }
    const panes = [];
    let last = after;
    for (const row of fhRows(this.#db, "SELECT pane FROM fh_v2_pane WHERE session=? AND pane>? ORDER BY pane LIMIT 257", key, after)) {
      if (panes.length === 256)
        return { panes, next: this.token({ kind: "panes", session: key, store: this.storeId, after: last }) };
      const parts = JSON.parse(String(row.pane));
      const owner = this.owner({ serverIdentity: parts[0], paneId: parts[1], birthGeneration: parts[2] });
      fhAssert(owner, "v2 missing indexed owner");
      fhAssert(bytes(panes) + bytes(owner.pane) < NEWARCH_V2_LIMITS.pageBytes, "v2 pane page bound");
      panes.push(owner.pane);
      last = String(row.pane);
    }
    return { panes, next: null };
  }
  seal(pane, segment, receipt) {
    const key = v2PaneKey(pane);
    nonempty(segment);
    fhAssert(!this.get("segment-seal", key, segment), "v2 segment already sealed");
    const rows = [];
    let rowBytes = 2;
    for (const row of fhRows(this.#db, "SELECT * FROM fh_v2_timeline WHERE pane=? AND segment=? AND kind='row' ORDER BY n", key, segment)) {
      const entry = this.timeline(row);
      if (entry.kind === "row") {
        rows.push(entry.row);
        rowBytes += bytes(entry.row) + 1;
      }
      fhAssert(rowBytes <= FLAGON_BUDGET.archiveChunkBytes / 2 + 2 && rows.length <= 65536, "v2 segment seal bound");
    }
    fhAssert(rows.length > 0, "v2 empty segment");
    const range = { pane, segmentId: segment, start: rows[0].id.rowOrdinal, end: rows[rows.length - 1].id.rowOrdinal + 1 };
    const coverage = [{ kind: "rows", range, digest: normalizedRowsDigest(range, rows) }];
    const cp = this.get("checkpoint", key, "live");
    const seal = {
      revision: 2,
      sealCommitId: receipt.commitId,
      sealGeneration: receipt.generation,
      pane,
      segmentId: segment,
      coverage,
      rawRanges: [],
      checkpointIds: cp ? [cp.checkpointId] : [],
      timelineIndexCommitId: receipt.commitId,
      replayIndexCommitId: receipt.commitId
    };
    this.put("seal", key, receipt.commitId, seal);
    this.put("segment-seal", key, segment, seal);
    if (cp)
      this.put("sealed-checkpoint", key, receipt.commitId, cp);
  }
  cleanupUncommittedExports() {
    for (const row of fhRows(this.#db, "SELECT pane,id FROM fh_v2_object WHERE kind='seal'")) {
      const seal = this.get("seal", String(row.pane), String(row.id));
      fhAssert(seal, "v2 missing seal");
      if (this.get("segment-export", String(row.pane), seal.segmentId))
        continue;
      const stem = v2Digest2("export-path", { pane: seal.pane, sealId: seal.sealCommitId });
      for (const suffix of [".v2.jsonl", ".v2.jsonl.tmp", ".v2.manifest.json", ".v2.manifest.json.tmp"]) {
        const path = join3(this.root, stem + suffix);
        fhSafePath(path);
        if (existsSync3(path))
          unlinkSync(path);
      }
    }
    fhSyncDir(this.root);
  }
  materialize(pane, sealId, operationId) {
    const key = v2PaneKey(pane), seal = this.get("seal", key, sealId);
    fhAssert(seal, "v2 unknown seal");
    fhAssert(!this.get("remote-segment", key, seal.segmentId), "v2 export already reclaimed");
    const previous = this.get("segment-export", key, seal.segmentId);
    if (previous) {
      for (const f of [...previous.files, previous.manifest])
        fhAssert(equal(fhEvidence(f.path), f), "v2 export changed");
      this.put("export", key, operationId, { ...previous, operationId });
      return;
    }
    this.cleanupUncommittedExports();
    fhAssert(!this.#db.query("SELECT 1 FROM fh_v2_object e WHERE e.kind='segment-export' AND NOT EXISTS(SELECT 1 FROM fh_v2_object r WHERE r.kind='remote-segment' AND r.pane=e.pane AND r.id=e.id) LIMIT 1").get(), "v2 export staging pressure");
    const name = v2Digest2("export-path", { pane, sealId }), path = join3(this.root, name + ".v2.jsonl"), manifest = join3(this.root, name + ".v2.manifest.json");
    const write = (file, records, cap) => {
      fhSafePath(file);
      fhSafePath(file + ".tmp");
      const fd = openSync4(file + ".tmp", "w", 384);
      let count = 0;
      try {
        for (const record of records) {
          const line = streamCanonical2(record) + `
`;
          count += Buffer.byteLength(line);
          fhAssert(count <= cap, "v2 export bound");
          fhWrite(fd, line);
        }
        fsyncSync2(fd);
      } finally {
        closeSync4(fd);
      }
      renameSync(file + ".tmp", file);
      fhSyncDir(this.root);
      return fhEvidence(file);
    };
    const data = write(path, this.exportRecords(key, seal.segmentId), Math.min(FLAGON_BUDGET.archiveChunkBytes, this.#config.storage.stagingCapBytes));
    const cp = this.get("sealed-checkpoint", key, sealId);
    const meta = write(manifest, [{ schema: "newarch-v2", storeId: this.storeId, seal, checkpoint: cp, files: [data] }], Math.min(NEWARCH_V2_LIMITS.checkpointBytesPerPane + NEWARCH_V2_LIMITS.pageBytes, this.#config.storage.stagingCapBytes - data.bytes));
    const exported = {
      kind: "sealed-export",
      operationId,
      storeUUID: this.storeId,
      pane,
      segmentId: seal.segmentId,
      generation: seal.sealGeneration,
      coverage: seal.coverage,
      files: [data],
      manifest: meta,
      sealCommitId: sealId
    };
    this.put("export", key, operationId, exported);
    this.put("segment-export", key, seal.segmentId, exported);
  }
  locate(pane, locator, commitId) {
    const key = v2PaneKey(pane), seal = this.get("segment-seal", key, locator.segmentId);
    const exported = this.get("segment-export", key, locator.segmentId);
    fhAssert(equal(locator.pane, pane) && seal && equal(seal, locator.sealed) && exported, "v2 locator local seal");
    const v = locator.verified;
    fhAssert(v.kind === "verified-remote" && v.exitCode === 0 && v.evidence.length > 0 && ["download-sha256", "rclone-check-download"].includes(v.method) && archiveInventoryMatches(exported, v.bundle, locator.inventory) && v.inventoryDigest === archiveInventoryDigest(locator.inventory), "v2 locator inventory/readback");
    fhAssert(/^[a-f0-9]{64}$/.test(locator.readerProof.digest) && Number.isSafeInteger(locator.readerProof.verifiedAtWallMs) && locator.readerProof.verifiedAtWallMs >= 0 && this.hooks.remoteReadback?.(locator, exported) === true, "v2 public reader proof required");
    this.put("locator", key, commitId, locator);
  }
  cleanupReclaim(cap, pane, segment) {
    this.authorize(cap);
    const key = v2PaneKey(pane);
    const locator = this.get("remote-segment", key, segment);
    const exported = this.get("segment-export", key, segment);
    fhAssert(locator && exported, "v2 reclaim not committed");
    for (const file of [...exported.files, exported.manifest]) {
      fhAssert(dirname2(file.path) === this.root && /[a-f0-9]{64}\.v2\.(jsonl|manifest\.json)$/.test(file.path), "v2 reclaim path");
      fhSafePath(file.path);
      if (existsSync3(file.path)) {
        fhAssert(equal(fhEvidence(file.path), file), "v2 changed export");
        this.hooks.boundary?.("v2-reclaim-before-unlink");
        unlinkSync(file.path);
        this.hooks.boundary?.("v2-reclaim-after-unlink");
      }
    }
    fhSyncDir(this.root);
    this.#db.exec("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA incremental_vacuum(256);");
  }
  reclaim(pane, locatorId, segment) {
    const key = v2PaneKey(pane), locator = this.get("locator", key, locatorId);
    fhAssert(locator && locator.segmentId === segment, "v2 reclaim locator");
    const exported = this.get("segment-export", key, segment);
    fhAssert(exported, "v2 reclaim export");
    fhAssert(this.hooks.remoteReadback?.(locator, exported) === true, "v2 reclaim readback unavailable");
    for (const row of fhRows(this.#db, "SELECT id FROM fh_v2_object WHERE kind='pin' AND pane=?", key)) {
      const pin = this.get("pin", key, String(row.id));
      fhAssert(pin?.segmentId !== segment || pin.released, "v2 segment pinned");
    }
    this.put("remote-segment", key, segment, locator);
    this.#db.query("UPDATE fh_v2_timeline SET payload=NULL WHERE pane=? AND segment=? AND kind='row'").run(key, segment);
  }
}

// src/stream-runtime.ts
var paneKey3 = (pane) => JSON.stringify([pane.serverIdentity, pane.paneId, pane.birthGeneration]);
var unwrap = (r) => {
  if (r.status !== "ok")
    throw Error(JSON.stringify(r));
  return r.value;
};
var wire = (kind, body) => {
  const header2 = Buffer.alloc(5);
  header2.write(kind);
  header2.writeUInt32BE(body.length, 1);
  return Buffer.concat([header2, body]);
};

class StreamVtTransport {
  lease = null;
  pending = null;
  buffer = Buffer.alloc(0);
  closed = false;
  retirement = null;
  resetting = null;
  starting = null;
  pool = null;
  geometry = null;
  epoch = 0;
  transactionActive = false;
  get pid() {
    return this.lease?.pid ?? null;
  }
  start(pool2, geometry2, epoch) {
    if (this.starting)
      return Promise.reject(Error("stream RPC already starting"));
    const work = this.openChannel(pool2, geometry2, epoch);
    this.starting = work;
    const settled = () => {
      if (this.starting === work)
        this.starting = null;
    };
    work.then(settled, settled);
    return work;
  }
  async openChannel(pool2, geometry2, epoch) {
    if (this.closed)
      throw Error("stream RPC retired");
    this.pool = pool2;
    this.geometry = geometry2;
    this.epoch = epoch;
    const lease = await pool2.acquire();
    if (this.closed) {
      lease.socket.destroy();
      await lease.release();
      throw Error("stream RPC retired");
    }
    this.lease = lease;
    const socket = lease.socket;
    socket.on("error", (error2) => {
      if (this.lease === lease)
        this.fail(error2);
    });
    socket.on("close", () => {
      if (this.lease === lease)
        this.fail(Error("stream VT channel closed"));
    });
    socket.on("data", (chunk) => {
      if (this.closed || this.lease !== lease)
        return;
      this.buffer = Buffer.concat([this.buffer, chunk]);
      if (this.buffer.length > 4 * STREAM_BUDGET.vtBytesPerPane) {
        this.resetGeneration();
        return;
      }
      while (this.buffer.length >= 5) {
        const length = this.buffer.readUInt32BE(1);
        if (length > 4 * STREAM_BUDGET.vtBytesPerPane) {
          this.resetGeneration();
          return;
        }
        if (this.buffer.length < length + 5)
          return;
        const kind = this.buffer.toString("ascii", 0, 1);
        const body = this.buffer.subarray(5, length + 5);
        this.buffer = this.buffer.subarray(length + 5);
        if (kind === "U" || kind === "H")
          continue;
        const pending = this.pending;
        if (!pending || pending.kind !== kind) {
          this.fail(Error("unexpected stream RPC reply"));
          this.resetGeneration();
          return;
        }
        this.pending = null;
        try {
          pending.resolve(JSON.parse(body.toString("utf8")));
        } catch (error2) {
          pending.reject(error2);
        }
      }
    });
    const attach = Buffer.alloc(12);
    attach.writeUInt16BE(geometry2.columns);
    attach.writeUInt16BE(geometry2.rows, 2);
    attach.writeBigUInt64BE(BigInt(epoch), 4);
    await this.call("A", "R", attach);
  }
  fail(error2) {
    this.pending?.reject(error2);
    this.pending = null;
  }
  async call(kind, reply, body) {
    if (this.closed || !this.lease || this.lease.socket.destroyed || this.pending)
      throw Error("stream RPC unavailable");
    if (body.length > 1024 * 1024)
      throw Error("stream RPC input budget");
    let timer;
    try {
      return await new Promise((resolve4, reject) => {
        this.pending = { kind: reply, resolve: resolve4, reject };
        timer = setTimeout(() => {
          this.resetGeneration();
        }, STREAM_BUDGET.recoveryMs);
        const lease = this.lease, pending = this.pending;
        lease.socket.write(wire(kind, body), (error2) => {
          if (error2 && this.lease === lease && this.pending === pending)
            this.fail(error2);
        });
      });
    } finally {
      if (timer)
        clearTimeout(timer);
    }
  }
  async transaction(request) {
    if (this.transactionActive || this.closed)
      return { status: "error", code: "io", message: "stream RPC unavailable" };
    this.transactionActive = true;
    try {
      for (let attempt = 0;; attempt++) {
        try {
          return { status: "ok", value: await this.call("J", "J", Buffer.from(JSON.stringify(request))) };
        } catch (error2) {
          if (attempt || this.closed || !this.pool || !this.geometry)
            throw error2;
          await this.resetGeneration();
          if (this.closed)
            throw error2;
          await this.start(this.pool, this.geometry, this.epoch);
        }
      }
    } catch (error2) {
      return { status: "error", code: "io", message: String(error2) };
    } finally {
      this.transactionActive = false;
    }
  }
  resetGeneration() {
    if (this.resetting)
      return this.resetting;
    const lease = this.lease;
    this.lease = null;
    this.fail(Error("stream RPC generation retired"));
    this.buffer = Buffer.alloc(0);
    const work = (async () => {
      if (lease) {
        lease.kill("SIGKILL");
        await lease.done;
        lease.socket.destroy();
        await lease.release();
      }
    })();
    this.resetting = work;
    work.then(() => {
      if (this.resetting === work)
        this.resetting = null;
    }, () => {});
    return work;
  }
  retire() {
    this.closed = true;
    return this.retirement ??= (async () => {
      await this.resetGeneration();
      await this.starting?.catch(() => {});
      await this.resetGeneration();
    })();
  }
  async close() {
    if (this.pending || this.transactionActive || this.resetting)
      return this.retire();
    this.closed = true;
    this.lease?.socket.destroy();
    await this.lease?.release();
    this.buffer = Buffer.alloc(0);
  }
}

class StreamRuntime {
  options;
  pool;
  admission = new CaptureAdmission;
  scratch = new CaptureAdmission(STREAM_BUDGET.scratchBytes);
  history = null;
  panes = new Map;
  closing = false;
  sharedDisplay = null;
  timer;
  ticks = new Map;
  viewerSlots = new Map;
  constructor(options) {
    this.options = options;
    this.pool = options.pool ?? new PipeVtPool({ python: options.python });
    this.timer = setInterval(() => {
      for (const pane of this.panes.values()) {
        if (this.ticks.has(pane))
          continue;
        const task = pane.tick();
        this.ticks.set(pane, task);
        const settled = () => {
          if (this.ticks.get(pane) === task)
            this.ticks.delete(pane);
        };
        task.then(settled, settled);
      }
    }, 25);
    this.timer.unref?.();
  }
  displayEngine() {
    if (!this.sharedDisplay) {
      const lookup = (key) => {
        const pane = this.panes.get(paneKey3(key));
        if (!pane)
          throw Error("stream pane no longer attached");
        return pane;
      };
      const capture = {
        acceptInput: (event) => lookup(event.identity.pane).capture.acceptInput(event),
        checkpoint: (pane, reason) => lookup(pane).capture.checkpoint(pane, reason),
        restore: (checkpoint, input) => lookup(checkpoint.identity.pane).capture.restore(checkpoint, input),
        checkVisible: (identity2) => lookup(identity2.pane).capture.checkVisible(identity2),
        repair: (episode, cancel) => lookup(episode.pane).capture.repair(episode, cancel),
        drain: (pane, deadline2) => lookup(pane).capture.drain(pane, deadline2),
        subscribe: (key, listener) => {
          const pane = lookup(key), off = pane.capture.subscribe(key, listener);
          listener(pane.frame);
          return off;
        }
      };
      this.sharedDisplay = new StreamDisplayEngine({ capture, history: this.history, observer: this.options.observer, retryUntilDeadline: true });
    }
    return this.sharedDisplay;
  }
  reserveViewer(id, owner) {
    if (this.viewerSlots.has(id))
      return this.viewerSlots.get(id) === owner;
    if (this.viewerSlots.size >= STREAM_BUDGET.panes)
      return false;
    this.viewerSlots.set(id, owner);
    return true;
  }
  releaseViewer(id) {
    this.viewerSlots.delete(id);
  }
  async add(identity2, geometry2, ports, scrollOnClear = false, options = {}) {
    const key = paneKey3(identity2.pane);
    if (this.closing || this.panes.has(key) || this.panes.size >= STREAM_BUDGET.panes)
      throw Error("stream pane admission");
    const rpc = new StreamVtTransport;
    try {
      await rpc.start(this.pool, geometry2, identity2.sourceEpoch);
      const vt = unwrap(await CheckpointCaptureVt.create(rpc, identity2, geometry2, scrollOnClear));
      const state = unwrap(await vt.snapshot());
      this.history ??= new StreamHistoryEngine({ path: this.options.path, codecVersions: [state.codecVersion], stagePrefixesOnDisk: true });
      const pane = new StreamRuntimePane(this, rpc, vt, identity2, ports);
      this.panes.set(key, pane);
      try {
        await pane.recover();
        if (!options.adoptRecoveredGeometry && (pane.frame.geometry.columns !== geometry2.columns || pane.frame.geometry.rows !== geometry2.rows))
          await pane.resize(geometry2);
      } catch (error2) {
        this.panes.delete(key);
        throw error2;
      }
      pane.startCadence();
      return pane;
    } catch (error2) {
      await rpc.close();
      throw error2;
    }
  }
  async retire(pane) {
    pane.stopCadence();
    await this.ticks.get(pane);
    await pane.retire();
    this.panes.delete(paneKey3(pane.identity.pane));
  }
  async remove(pane) {
    pane.stopCadence();
    await this.ticks.get(pane);
    await pane.close();
    this.panes.delete(paneKey3(pane.identity.pane));
  }
  async close() {
    this.closing = true;
    clearInterval(this.timer);
    await Promise.allSettled(this.ticks.values());
    for (const pane of this.panes.values())
      await pane.close();
    if (this.history?.stats().ownedPendingBytes || this.scratch.heldBytes || this.admission.heldBytes)
      throw Error("stream close refused: undurable pending or quarantined operation");
    const receipt = this.history?.close();
    if (receipt?.undurableBytes)
      throw Error("stream close lost undurable state");
    this.panes.clear();
    await this.pool.close();
  }
}

class StreamRuntimePane {
  runtime;
  rpc;
  vt;
  ports;
  capture;
  display;
  frame;
  identity;
  sequence = 0;
  accepting = true;
  chain = Promise.resolve();
  inputBytes = 0;
  viewers = new Map;
  closed = false;
  cadence;
  cadenceReady = false;
  receivedAt = -Infinity;
  liveViewers = 0;
  setLiveViewers(count) {
    if (!Number.isSafeInteger(count) || count < 0 || count > STREAM_BUDGET.panes)
      throw Error("stream viewer count");
    this.liveViewers = count;
  }
  constructor(runtime, rpc, vt, identity2, ports) {
    this.runtime = runtime;
    this.rpc = rpc;
    this.vt = vt;
    this.ports = ports;
    this.identity = structuredClone(identity2);
    this.frame = { ...vt.screen(), head: 0, revision: 0, durableRevision: 0 };
    this.makeCapture();
  }
  makeCapture() {
    this.capture = new StreamCaptureEngine({
      ...this.ports,
      identity: this.identity,
      history: this.runtime.history,
      vt: this.vt,
      initial: this.frame,
      admission: this.runtime.admission,
      scratch: this.runtime.scratch,
      now: () => performance.now(),
      observer: this.runtime.options.observer,
      cancelOperation: (signal) => this.ports.cancelOperation(signal)
    });
    this.capture.subscribe(this.identity.pane, (frame) => {
      this.frame = frame;
      this.identity = frame.identity;
    });
    this.display = this.runtime.displayEngine();
    this.cadence = new CaptureCadence(this.capture, () => this.identity, () => performance.now());
  }
  startCadence() {
    this.cadenceReady = true;
  }
  stopCadence() {
    this.cadenceReady = false;
  }
  async tick() {
    if (!this.cadenceReady || this.closed)
      return;
    this.cadence.activity(this.viewers.size + this.liveViewers, performance.now() - this.receivedAt < STREAM_BUDGET.visibleIdleMs);
    await this.cadence.tick();
  }
  async recover() {
    unwrap(this.runtime.history.discardStaged(this.identity.pane));
    const recovery = this.runtime.history.recover(this.identity.pane, null, { isCancelled: () => false })[Symbol.asyncIterator]();
    try {
      const first = await recovery.next();
      if (first.done || first.value.status === "stale")
        return;
      const chunk = unwrap(first.value);
      if (chunk.kind !== "checkpoint") {
        let item = chunk;
        for (;; ) {
          if (item.kind === "input") {
            unwrap(await this.capture.acceptInput(item.event));
            unwrap(await this.capture.drain(this.identity.pane, performance.now() + STREAM_BUDGET.recoveryMs));
            this.sequence = item.event.position.packetSeq;
          }
          const next = await recovery.next();
          if (next.done)
            return;
          item = unwrap(next.value);
        }
      }
      const cp = chunk.checkpoint;
      this.identity = cp.identity;
      this.frame = { ...this.vt.screen(), identity: cp.identity, head: 0, revision: 0, durableRevision: 0 };
      this.makeCapture();
      this.sequence = cp.inputFence.through.packetSeq;
      async function* none() {}
      this.frame = unwrap(await this.capture.restore(cp, none()));
      for (;; ) {
        const next = await recovery.next();
        if (next.done)
          break;
        const item = unwrap(next.value);
        if (item.kind !== "input")
          continue;
        unwrap(await this.capture.acceptInput(item.event));
        unwrap(await this.capture.drain(this.identity.pane, performance.now() + STREAM_BUDGET.recoveryMs));
        this.sequence = item.event.position.packetSeq;
      }
    } finally {
      await recovery.return?.();
    }
  }
  ingest(bytes2) {
    if (!this.accepting || bytes2.length > 64 * 1024 || this.inputBytes)
      return Promise.reject(Error("stream input admission"));
    this.inputBytes = bytes2.length;
    this.receivedAt = performance.now();
    const owned = Uint8Array.from(bytes2);
    const work = this.chain.then(async () => {
      for (let offset = 0;offset < owned.length; offset += 512) {
        await this.event({ kind: "bytes", bytes: Array.from(owned.subarray(offset, offset + 512)) });
      }
    });
    this.chain = work;
    return work.finally(() => {
      this.inputBytes = 0;
    });
  }
  async event(payload) {
    const identity2 = payload.kind === "resize" ? { ...this.identity, geometryGeneration: this.identity.geometryGeneration + 1 } : this.identity;
    const body = {
      identity: identity2,
      position: { sourceEpoch: identity2.sourceEpoch, packetSeq: this.sequence + 1 },
      receivedAtMonoMs: performance.now(),
      payload
    };
    const input = { ...body, digest: streamDigest("input", body) };
    const deadline2 = performance.now() + STREAM_BUDGET.recoveryMs;
    for (;; ) {
      const result = await this.capture.acceptInput(input);
      if (result.status === "ok") {
        this.sequence++;
        break;
      }
      if (result.status !== "busy" || performance.now() >= deadline2)
        throw Error(JSON.stringify(result));
      await new Promise((resolve4) => setTimeout(resolve4, Math.max(1, result.retryAfterMs)));
    }
    unwrap(await this.capture.drain(this.identity.pane, deadline2));
  }
  async resize(geometry2) {
    if (!this.accepting)
      throw Error("stream closed");
    this.cadence.event();
    this.chain = this.chain.then(() => this.event({ kind: "resize", geometry: geometry2 }));
    await this.chain;
    for (const route of this.viewers.values())
      await this.display.detach(route, "geometry changed");
    for (const id of this.viewers.keys())
      this.runtime.releaseViewer(id);
    this.viewers.clear();
  }
  async attach(route, onFrame) {
    if (!this.runtime.reserveViewer(route.viewerId, this))
      return { status: "busy", reason: "pressure", retryAfterMs: 20 };
    const previous = this.viewers.get(route.viewerId);
    const owned = structuredClone(route);
    this.viewers.set(route.viewerId, owned);
    let result;
    try {
      result = await this.display.attach(owned, (frame) => {
        try {
          onFrame(frame);
        } catch (error2) {
          if (this.viewers.get(owned.viewerId) === owned)
            this.detach(owned.viewerId);
          throw error2;
        }
      });
    } catch (error2) {
      result = { status: "error", code: "io", message: String(error2) };
    }
    if (this.viewers.get(owned.viewerId) !== owned)
      return { status: "stale", reason: "route" };
    if (result.status !== "ok") {
      await this.display.detach(owned, "attach failed");
      if (previous)
        await this.display.detach(previous, "invalid replacement");
      this.viewers.delete(owned.viewerId);
      this.runtime.releaseViewer(owned.viewerId);
    }
    return result;
  }
  page(route, request, cursor, limit, cancel) {
    return this.display.page(route, request, cursor, limit, cancel);
  }
  async detach(viewerId) {
    const route = this.viewers.get(viewerId);
    if (!route)
      return;
    await this.display.detach(route, "disconnect");
    this.viewers.delete(viewerId);
    this.runtime.releaseViewer(viewerId);
  }
  async drain() {
    await this.chain;
    if (!this.sequence)
      return null;
    unwrap(await this.capture.drain(this.identity.pane, performance.now() + STREAM_BUDGET.recoveryMs));
    return unwrap(await this.capture.checkpoint(this.identity.pane, "handoff"));
  }
  async settle() {
    await this.chain.catch(() => {});
  }
  async retire() {
    if (this.closed)
      return;
    this.accepting = false;
    this.cadenceReady = false;
    await this.settle();
    for (const id of [...this.viewers.keys()])
      await this.detach(id);
    await this.rpc.close();
    this.closed = true;
  }
  async close() {
    if (this.closed)
      return;
    this.accepting = false;
    this.cadenceReady = false;
    await this.drain();
    for (const id of [...this.viewers.keys()])
      await this.detach(id);
    await this.rpc.close();
    this.closed = true;
  }
  stats() {
    return {
      inputBytes: this.inputBytes,
      packetSeq: this.sequence,
      frame: this.frame,
      workerPid: this.rpc.pid,
      display: this.display.stats(),
      history: this.runtime.history.stats()
    };
  }
}
var FLAGON_STATE_FIELDS = ["sgr", "cursor", "savedCursor", "margins", "charset", "pendingUtf8", "pendingEscape", "wrap"];
var DEFAULT_PEN = { style: 0, fg: -1, bg: -1 };
var sgrCode = (n) => n;
var PRINT_DEPS = ["sgr", "charset", "cursor", "pendingUtf8", "pendingEscape", "wrap", "unsupported-sequence", "geometry"];

class FlagOnVtDecoder {
  epoch;
  geometry;
  normal;
  alt = null;
  pen = { ...DEFAULT_PEN };
  unknown = new Set;
  top = 0;
  bottom;
  autowrap = true;
  pendingWrap = false;
  utf8 = [];
  utf8Need = 0;
  utf8Start = 0;
  esc = null;
  ordinal = 0;
  offset = 0;
  halted = false;
  scrollOnClear;
  out = [];
  target = null;
  proven = [];
  replayProven(offsets) {
    this.proven = [...offsets].filter((o) => o >= this.offset).sort((a, b) => a - b);
  }
  constructor(options) {
    this.epoch = options.epoch;
    this.geometry = options.geometry;
    this.scrollOnClear = options.scrollOnClear;
    this.bottom = options.geometry.rows - 1;
    this.normal = this.blankScreen();
    const seed = options.seed;
    if (seed) {
      for (const field of FLAGON_STATE_FIELDS)
        if (!this.known(seed.stateKnown, field))
          this.unknown.add(field);
      const screen = seed.alternate ? this.alt = this.blankScreen() : this.normal;
      if (seed.alternate)
        this.unknown.add("margins");
      seed.screen.slice(0, options.geometry.rows).forEach((row, y) => {
        const line = screen.lines[y];
        line.cells = row.cells.slice(0, options.geometry.columns).map((cell, x) => ({
          text: cell.text,
          width: cell.width,
          style: (() => {
            const s = sgrToSemanticStyle(cell.style);
            return [s.attrs, s.fg, s.bg];
          })(),
          origin: row.cellOrigins[x] ?? row.cellOrigins[0] ?? row.origin
        }));
        if (!line.cells.length && row.origin.kind === "capture")
          line.cells = [];
        line.baseline = row.origin;
        for (const f of row.uncertainFields)
          line.uncertain.add(f);
      });
      screen.cursor = { x: Math.min(seed.cursor.x, options.geometry.columns - 1), y: Math.min(seed.cursor.y, options.geometry.rows - 1) };
    }
  }
  known(state, field) {
    if (state[field] === true)
      return true;
    if (field === "sgr")
      return state.attributes === true;
    if (field === "charset")
      return state.modes === true;
    return false;
  }
  blankLine() {
    return { cells: [], wrapped: false, uncertain: new Set, touched: false };
  }
  blankScreen() {
    return { lines: Array.from({ length: this.geometry.rows }, () => this.blankLine()), cursor: { x: 0, y: 0 }, saved: null };
  }
  get screen() {
    return this.alt ?? this.normal;
  }
  unknownFields() {
    return [...this.unknown];
  }
  get position() {
    return this.offset;
  }
  get alternateActive() {
    return this.alt !== null;
  }
  cursor() {
    return { ...this.screen.cursor };
  }
  feed(bytes2, start) {
    if (start !== this.offset)
      throw Error(`decoder offset ${this.offset} fed ${start}`);
    if (this.halted) {
      this.offset = start + bytes2.length;
      return;
    }
    if (this.proven[0] === start) {
      this.proven.shift();
      this.clearProven();
    }
    for (let i = 0;i < bytes2.length; i++) {
      this.byte(bytes2[i], start + i);
      if (this.proven.length && this.proven[0] === start + i + 1) {
        this.proven.shift();
        this.clearProven();
      }
      if (this.target && bytes2[i] === 10)
        this.tryTarget(start + i + 1);
    }
    this.offset = start + bytes2.length;
    if (this.target)
      this.tryTarget(this.offset);
  }
  verifyLater(visible, withinBytes) {
    this.target?.done({ verified: false, reason: "superseded", at: this.offset });
    return new Promise((done) => {
      this.target = { visible, until: this.offset + withinBytes, done };
      this.tryTarget(this.offset);
    });
  }
  tryTarget(at) {
    const t = this.target;
    const r = this.verifyVisible(t.visible);
    if (r.verified || at >= t.until) {
      this.target = null;
      t.done(r.verified ? { ...r, at } : { verified: false, reason: r.reason ?? "expired", at });
    }
  }
  take() {
    const rows = this.out;
    this.out = [];
    return rows;
  }
  pipeOrigin(at) {
    return { kind: "pipe", range: { epoch: this.epoch, start: at, end: at + 1 }, ordinal: 0 };
  }
  cellAt(line, x) {
    return line.cells[x];
  }
  markLine(line, deps) {
    line.touched = true;
    for (const d of deps)
      if (this.unknown.has(d))
        line.uncertain.add(d);
  }
  markAll(field) {
    this.unknown.add(field);
    for (const line of this.screen.lines)
      line.uncertain.add(field);
  }
  blank(at) {
    return { text: " ", width: 1, style: [this.pen.style & 0, -1, this.pen.bg], origin: this.pipeOrigin(at) };
  }
  padTo(line, x, at) {
    while (line.cells.length < x)
      line.cells.push(this.blank(at));
  }
  byte(b, at) {
    if (this.esc) {
      this.escByte(b, at);
      return;
    }
    if (this.utf8Need > 0) {
      if ((b & 192) === 128) {
        this.utf8.push(b);
        if (this.utf8.length === this.utf8Need)
          this.flushUtf8();
        return;
      }
      this.utf8 = [];
      this.utf8Need = 0;
      this.markLine(this.screen.lines[this.screen.cursor.y], ["pendingUtf8"]);
      this.unknown.add("pendingUtf8");
    }
    if (this.unknown.has("pendingEscape") && (b === 27 || b === 10 || b === 13))
      this.unknown.delete("pendingEscape");
    if (this.unknown.has("pendingUtf8") && (b < 128 || b >= 192))
      this.unknown.delete("pendingUtf8");
    if (b >= 192 && b < 248) {
      this.utf8 = [b];
      this.utf8Need = b >= 240 ? 4 : b >= 224 ? 3 : 2;
      this.utf8Start = at;
      return;
    }
    if (b >= 128 && b < 192)
      return;
    switch (b) {
      case 27:
        this.esc = { kind: "esc", buf: [], start: at };
        return;
      case 13:
        this.screen.cursor.x = 0;
        this.pendingWrap = false;
        return;
      case 10:
      case 11:
      case 12:
        this.lineFeed(at);
        return;
      case 8:
        if (this.screen.cursor.x > 0)
          this.screen.cursor.x--;
        this.pendingWrap = false;
        return;
      case 9: {
        const x = this.screen.cursor.x;
        this.screen.cursor.x = Math.min(this.geometry.columns - 1, (Math.floor(x / 8) + 1) * 8);
        this.padTo(this.screen.lines[this.screen.cursor.y], this.screen.cursor.x, at);
        return;
      }
      case 14:
      case 15:
        this.unknown.delete("charset");
        return;
      case 7:
      case 0:
        return;
    }
    if (b < 32 || b === 127)
      return;
    this.print(String.fromCharCode(b), at, at);
  }
  flushUtf8() {
    const text = Buffer.from(this.utf8).toString("utf8");
    const start = this.utf8Start;
    this.utf8 = [];
    this.utf8Need = 0;
    this.print(text, start, start + Buffer.byteLength(text) - 1);
  }
  print(text, at, _end) {
    const cp = text.codePointAt(0);
    let width = cp < 127 ? 1 : Math.max(0, Math.min(2, Bun.stringWidth(text)));
    if (text.includes("️") && width === 1)
      width = 2;
    const s = this.screen, cols = this.geometry.columns;
    if (width === 0) {
      const line2 = s.lines[s.cursor.y];
      const x = this.pendingWrap ? cols - 1 : s.cursor.x - 1;
      let prev = x >= 0 ? line2.cells[x] : undefined;
      if (prev && prev.width === 0 && x > 0)
        prev = line2.cells[x - 1];
      if (prev) {
        prev.text += text;
        this.markLine(line2, PRINT_DEPS);
      }
      return;
    }
    if (this.pendingWrap && this.autowrap) {
      s.lines[s.cursor.y].wrapped = true;
      s.cursor.x = 0;
      this.lineFeed(at);
    }
    this.pendingWrap = false;
    if (width === 2 && s.cursor.x === cols - 1) {
      if (this.autowrap) {
        const l = s.lines[s.cursor.y];
        this.padTo(l, cols, at);
        l.wrapped = true;
        s.cursor.x = 0;
        this.lineFeed(at);
      } else
        return;
    }
    const line = s.lines[s.cursor.y];
    this.padTo(line, s.cursor.x, at);
    const style = [this.pen.style, sgrCode(this.pen.fg), sgrCode(this.pen.bg)];
    const origin = this.pipeOrigin(at);
    const old = line.cells[s.cursor.x];
    if (old && old.width === 0 && s.cursor.x > 0)
      line.cells[s.cursor.x - 1] = this.blank(at);
    if (old && old.width === 2 && line.cells[s.cursor.x + 1]?.width === 0)
      line.cells[s.cursor.x + 1] = this.blank(at);
    line.cells[s.cursor.x] = { text, width, style, origin };
    if (width === 2)
      line.cells[s.cursor.x + 1] = { text: "", width: 0, style, origin };
    this.markLine(line, PRINT_DEPS);
    const next = s.cursor.x + width;
    if (next >= cols) {
      s.cursor.x = cols - 1;
      this.pendingWrap = true;
    } else
      s.cursor.x = next;
    if (this.unknown.has("wrap") && next < cols)
      this.unknown.delete("wrap");
  }
  lineFeed(at) {
    const s = this.screen;
    this.pendingWrap = false;
    if (s.cursor.y === this.bottom)
      this.scrollUp(1, at);
    else if (s.cursor.y < this.geometry.rows - 1)
      s.cursor.y++;
  }
  scrollUp(n, at) {
    const s = this.screen;
    for (let i = 0;i < n; i++) {
      const [gone] = s.lines.splice(this.top, 1);
      s.lines.splice(this.bottom, 0, this.blankLine());
      if (!this.alt && gone)
        this.emit(gone, at, this.unknown.has("margins") ? ["margins"] : []);
    }
  }
  scrollDown(n) {
    const s = this.screen;
    for (let i = 0;i < n; i++) {
      s.lines.splice(this.bottom, 1);
      s.lines.splice(this.top, 0, this.blankLine());
    }
  }
  emit(line, at, extra) {
    const cols = this.geometry.columns;
    const cells = line.cells.slice(0, cols);
    const baseline = line.baseline;
    while (cells.length < cols)
      cells.push({ text: " ", width: 1, style: [0, -1, -1], origin: baseline ?? this.pipeOrigin(at) });
    if (cells[cols - 1]?.width === 2)
      cells[cols - 1] = { text: " ", width: 1, style: cells[cols - 1].style, origin: cells[cols - 1].origin };
    const origins = cells.map((c) => c.origin);
    const pipes = origins.filter((o) => o.kind === "pipe");
    const start = pipes.length ? Math.min(...pipes.map((o) => o.range.start)) : at;
    const uncertain = new Set([...line.uncertain, ...extra]);
    this.out.push({
      origin: { kind: "pipe", range: { epoch: this.epoch, start: Math.min(start, at), end: at + 1 }, ordinal: this.ordinal++ },
      cells: cells.filter((c) => c.width !== 0).map((c) => ({ text: c.text, width: c.width, style: semanticStyleToSgr({ attrs: c.style[0], fg: c.style[1], bg: c.style[2] }) })),
      geometry: this.geometry,
      buffer: "normal",
      wrapStatus: line.wrapped ? "wrapped" : "unwrapped",
      wrapPad: 0,
      finalized: true,
      uncertainFields: [...uncertain].sort(),
      cellOrigins: cells.filter((c) => c.width !== 0).map((c) => c.origin)
    });
  }
  eraseInLine(line, from, to, at) {
    this.padTo(line, to, at);
    for (let x = from;x < to; x++)
      line.cells[x] = this.blank(at);
    while (line.cells.length && line.cells.at(-1).text === " " && line.cells.at(-1).style[0] === 0 && line.cells.at(-1).style[2] === -1 && line.cells.at(-1).origin.kind === "pipe")
      line.cells.pop();
    this.markLine(line, ["cursor", "unsupported-sequence", "geometry"]);
  }
  escByte(b, at) {
    const e = this.esc;
    if (e.kind === "esc") {
      this.esc = null;
      switch (b) {
        case 91:
          this.esc = { kind: "csi", buf: [], start: e.start };
          return;
        case 93:
          this.esc = { kind: "osc", buf: [], start: e.start };
          return;
        case 80:
        case 95:
        case 94:
        case 88:
        case 107:
          this.esc = { kind: "str", buf: [], start: e.start };
          return;
        case 40:
        case 41:
        case 42:
        case 43:
          this.esc = { kind: "charset", buf: [], start: e.start };
          return;
        case 55:
          this.save();
          return;
        case 56:
          this.restore();
          return;
        case 68:
          this.lineFeed(at);
          return;
        case 69:
          this.screen.cursor.x = 0;
          this.lineFeed(at);
          return;
        case 77: {
          const s = this.screen;
          this.pendingWrap = false;
          if (s.cursor.y === this.top)
            this.scrollDown(1);
          else if (s.cursor.y > 0)
            s.cursor.y--;
          return;
        }
        case 99:
          this.reset();
          return;
        case 61:
        case 62:
        case 92:
          return;
        default:
          this.markAll("unsupported-sequence");
          return;
      }
    }
    if (e.kind === "charset") {
      this.esc = null;
      this.unknown.delete("charset");
      return;
    }
    if (e.kind === "osc" || e.kind === "str") {
      if (b === 7 && e.kind === "osc") {
        this.esc = null;
        return;
      }
      if (b === 92 && e.buf.at(-1) === 27) {
        this.esc = null;
        return;
      }
      if (e.buf.length > 4096) {
        this.esc = null;
        this.markAll("unsupported-sequence");
        return;
      }
      e.buf.push(b);
      return;
    }
    if (b >= 32 && b < 64) {
      if (e.buf.length > 64) {
        this.esc = null;
        this.markAll("unsupported-sequence");
        return;
      }
      e.buf.push(b);
      return;
    }
    this.esc = null;
    if (b < 64 || b > 126) {
      this.markAll("unsupported-sequence");
      return;
    }
    this.csi(String.fromCharCode(...e.buf), b, at);
  }
  csi(raw, final, at) {
    const s = this.screen, cols = this.geometry.columns, rows = this.geometry.rows;
    const priv = /^[?<=>]/.test(raw) ? raw[0] : "";
    const body = priv ? raw.slice(1) : raw;
    if (/[^0-9;:]/.test(body)) {
      this.markAll("unsupported-sequence");
      return;
    }
    const p = body === "" ? [] : body.split(";").map((x) => x === "" ? 0 : Number(x.split(":")[0]));
    const n = (i, d = 1) => (p[i] ?? 0) || d;
    const clampY = (y) => Math.max(0, Math.min(rows - 1, y));
    const clampX = (x) => Math.max(0, Math.min(cols - 1, x));
    const f = String.fromCharCode(final);
    if (priv === "?") {
      if (f === "h" || f === "l") {
        const on = f === "h";
        for (const mode of p) {
          if (mode === 1049 || mode === 1047 || mode === 47)
            this.switchBuffer(on, mode === 1049);
          else if (mode === 7)
            this.autowrap = on;
        }
      }
      return;
    }
    if (priv)
      return;
    this.pendingWrap = f === "m" ? this.pendingWrap : false;
    switch (f) {
      case "A":
        s.cursor.y = Math.max(s.cursor.y >= this.top ? this.top : 0, s.cursor.y - n(0));
        return;
      case "B":
      case "e":
        s.cursor.y = Math.min(s.cursor.y <= this.bottom ? this.bottom : rows - 1, s.cursor.y + n(0));
        return;
      case "C":
      case "a":
        s.cursor.x = clampX(s.cursor.x + n(0));
        return;
      case "D":
        s.cursor.x = clampX(s.cursor.x - n(0));
        return;
      case "E":
        s.cursor.x = 0;
        s.cursor.y = clampY(s.cursor.y + n(0));
        return;
      case "F":
        s.cursor.x = 0;
        s.cursor.y = clampY(s.cursor.y - n(0));
        return;
      case "G":
      case "`":
        s.cursor.x = clampX(n(0) - 1);
        return;
      case "d":
        s.cursor.y = clampY(n(0) - 1);
        this.unknown.delete("cursor");
        return;
      case "H":
      case "f":
        s.cursor.y = clampY(n(0) - 1);
        s.cursor.x = clampX(n(1) - 1);
        this.unknown.delete("cursor");
        return;
      case "J":
        return this.eraseDisplay(p[0] ?? 0, at);
      case "K": {
        const line = s.lines[s.cursor.y];
        const mode = p[0] ?? 0;
        if (mode === 0)
          this.eraseInLine(line, s.cursor.x, cols, at);
        else if (mode === 1)
          this.eraseInLine(line, 0, s.cursor.x + 1, at);
        else
          this.eraseInLine(line, 0, cols, at);
        return;
      }
      case "X":
        this.eraseInLine(s.lines[s.cursor.y], s.cursor.x, Math.min(cols, s.cursor.x + n(0)), at);
        return;
      case "P": {
        const line = s.lines[s.cursor.y];
        line.cells.splice(s.cursor.x, n(0));
        this.markLine(line, ["cursor", "unsupported-sequence"]);
        return;
      }
      case "@": {
        const line = s.lines[s.cursor.y];
        this.padTo(line, s.cursor.x, at);
        line.cells.splice(s.cursor.x, 0, ...Array.from({ length: n(0) }, () => this.blank(at)));
        line.cells.length = Math.min(line.cells.length, cols);
        this.markLine(line, ["cursor", "unsupported-sequence"]);
        return;
      }
      case "L":
        if (s.cursor.y >= this.top && s.cursor.y <= this.bottom)
          for (let i = 0;i < n(0); i++) {
            s.lines.splice(this.bottom, 1);
            s.lines.splice(s.cursor.y, 0, this.blankLine());
          }
        return;
      case "M":
        if (s.cursor.y >= this.top && s.cursor.y <= this.bottom)
          for (let i = 0;i < n(0); i++) {
            s.lines.splice(s.cursor.y, 1);
            s.lines.splice(this.bottom, 0, this.blankLine());
          }
        return;
      case "S":
        this.scrollUp(n(0), at);
        return;
      case "T":
        this.scrollDown(n(0));
        return;
      case "m":
        return this.sgr(p, body);
      case "r": {
        const t = n(0) - 1, bt = p[1] ?? 0 ? p[1] - 1 : rows - 1;
        if (t < bt && bt < rows) {
          this.top = t;
          this.bottom = bt;
          this.unknown.delete("margins");
          this.unknown.delete("cursor");
          s.cursor = { x: 0, y: 0 };
        }
        return;
      }
      case "s":
        if (body === "")
          this.save();
        return;
      case "u":
        if (body === "")
          this.restore();
        return;
      case "b":
        this.markAll("unsupported-sequence");
        return;
      default:
        return;
    }
  }
  sgr(p, body) {
    if (p.length === 0 || p.length === 1 && p[0] === 0 && !body.includes(":")) {
      this.pen = { ...DEFAULT_PEN };
      this.unknown.delete("sgr");
      return;
    }
    for (let i = 0;i < p.length; i++) {
      const v = p[i];
      if (v === 0) {
        this.pen = { ...DEFAULT_PEN };
        this.unknown.delete("sgr");
      } else if (v >= 1 && v <= 9)
        this.pen.style |= 1 << v - 1;
      else if (v === 21)
        this.pen.style = this.pen.style & ~8 | 512;
      else if (v === 22)
        this.pen.style &= ~3;
      else if (v === 23)
        this.pen.style &= ~4;
      else if (v === 24)
        this.pen.style &= ~(8 | 512);
      else if (v === 25)
        this.pen.style &= ~(16 | 32);
      else if (v === 27)
        this.pen.style &= ~64;
      else if (v === 28)
        this.pen.style &= ~128;
      else if (v === 29)
        this.pen.style &= ~256;
      else if (v === 39)
        this.pen.fg = -1;
      else if (v === 49)
        this.pen.bg = -1;
      else if (v >= 30 && v <= 37)
        this.pen.fg = v - 30;
      else if (v >= 40 && v <= 47)
        this.pen.bg = v - 40;
      else if (v >= 90 && v <= 97)
        this.pen.fg = v - 90 + 8;
      else if (v >= 100 && v <= 107)
        this.pen.bg = v - 100 + 8;
      else if (v === 38 || v === 48 || v === 58) {
        const mode = p[i + 1];
        if (mode === 5) {
          const c = p[i + 2] ?? 0;
          if (v === 38)
            this.pen.fg = c;
          else if (v === 48)
            this.pen.bg = c;
          i += 2;
        } else if (mode === 2) {
          const [r, g, bl] = [p[i + 2] ?? 0, p[i + 3] ?? 0, p[i + 4] ?? 0];
          const c = 256 + (r << 16 | g << 8 | bl);
          if (v === 38)
            this.pen.fg = c;
          else if (v === 48)
            this.pen.bg = c;
          i += 4;
        } else {
          this.markAll("unsupported-sequence");
          return;
        }
      }
    }
  }
  eraseDisplay(mode, at) {
    const s = this.screen, cols = this.geometry.columns;
    if (mode === 3)
      return;
    if (mode === 2) {
      if (!this.alt && this.scrollOnClear) {
        let last = 0;
        s.lines.forEach((line, y2) => {
          if (line.cells.length)
            last = y2 + 1;
        });
        for (let i = 0;i < last; i++) {
          const [gone] = s.lines.splice(0, 1);
          s.lines.push(this.blankLine());
          this.emit(gone, at, []);
        }
      }
      s.lines = s.lines.map(() => this.blankLine());
      return;
    }
    const y = s.cursor.y;
    if (mode === 0) {
      this.eraseInLine(s.lines[y], s.cursor.x, cols, at);
      for (let i = y + 1;i < s.lines.length; i++)
        s.lines[i] = this.blankLine();
    } else if (mode === 1) {
      this.eraseInLine(s.lines[y], 0, s.cursor.x + 1, at);
      for (let i = 0;i < y; i++)
        s.lines[i] = this.blankLine();
    }
  }
  save() {
    this.screen.saved = { ...this.screen.cursor, pen: { ...this.pen }, unknown: this.unknown.has("cursor") };
    if (this.unknown.has("cursor"))
      this.unknown.add("savedCursor");
    else
      this.unknown.delete("savedCursor");
  }
  restore() {
    const saved = this.screen.saved;
    if (!saved || this.unknown.has("savedCursor")) {
      this.unknown.add("cursor");
      return;
    }
    this.screen.cursor = { x: saved.x, y: saved.y };
    this.pen = { ...saved.pen };
    if (saved.unknown)
      this.unknown.add("cursor");
    else
      this.unknown.delete("cursor");
  }
  switchBuffer(on, saveCursor) {
    if (on && !this.alt) {
      if (saveCursor)
        this.save();
      this.alt = this.blankScreen();
      this.alt.cursor = { ...this.normal.cursor };
    } else if (!on && this.alt) {
      this.alt = null;
      if (saveCursor)
        this.restore();
    }
  }
  reset() {
    this.alt = null;
    this.normal = this.blankScreen();
    this.pen = { ...DEFAULT_PEN };
    this.top = 0;
    this.bottom = this.geometry.rows - 1;
    this.autowrap = true;
    this.pendingWrap = false;
    this.unknown.clear();
  }
  screenRows() {
    return this.screen.lines.map((line, y) => ({
      origin: { kind: "pipe", range: { epoch: this.epoch, start: this.offset, end: this.offset }, ordinal: -1 - y },
      cells: line.cells.filter((c) => c.width !== 0).map((c) => ({ text: c.text, width: c.width, style: semanticStyleToSgr({ attrs: c.style[0], fg: c.style[1], bg: c.style[2] }) })),
      geometry: this.geometry,
      buffer: this.alt ? "alternate" : "normal",
      wrapStatus: line.wrapped ? "wrapped" : "unwrapped",
      wrapPad: 0,
      finalized: false,
      uncertainFields: [...line.uncertain].sort(),
      cellOrigins: line.cells.filter((c) => c.width !== 0).map((c) => c.origin)
    }));
  }
  verifyVisible(visible) {
    if (visible.geometry.columns !== this.geometry.columns || visible.geometry.rows !== this.geometry.rows)
      return { verified: false, reason: "geometry" };
    if (visible.alternate !== !!this.alt)
      return { verified: false, reason: "buffer" };
    if (this.pendingWrap ? false : visible.cursor.x !== this.screen.cursor.x || visible.cursor.y !== this.screen.cursor.y)
      return { verified: false, reason: "cursor" };
    if (visible.regionTop !== this.top || visible.regionBottom !== this.bottom)
      return { verified: false, reason: "margins" };
    const mine = this.screen.lines;
    for (let y = 0;y < this.geometry.rows; y++) {
      const want = (visible.rows[y] ?? []).map((c2) => {
        const s = sgrToSemanticStyle(c2.style);
        return { ...c2, style: [s.attrs, s.fg, s.bg] };
      });
      const have = (mine[y]?.cells ?? []).filter((c2) => c2.width !== 0);
      const trim = (cells) => {
        const out = [...cells];
        while (out.length && out.at(-1).text === " " && out.at(-1).style[0] === 0 && (out.at(-1).style[2] ?? -1) === -1)
          out.pop();
        return out;
      };
      const a = trim(have), c = trim(want);
      if (a.length !== c.length)
        return { verified: false, reason: `row ${y}` };
      for (let x = 0;x < a.length; x++) {
        const p = a[x], q = c[x];
        if (p.text !== q.text || (p.style[0] ?? 0) !== (q.style[0] ?? 0) || (p.style[1] ?? -1) !== (q.style[1] ?? -1) || (p.style[2] ?? -1) !== (q.style[2] ?? -1))
          return { verified: false, reason: `row ${y} cell ${x}` };
      }
    }
    this.clearProven();
    return { verified: true, reason: null };
  }
  clearProven() {
    for (const field of ["cursor", "margins", "charset", "pendingUtf8", "pendingEscape", "wrap", "unsupported-sequence", "geometry", "sgr"])
      this.unknown.delete(field);
    for (const line of this.screen.lines)
      line.uncertain.clear();
  }
  resize(geometry2) {
    this.halted = true;
    this.geometry = geometry2;
    this.unknown.add("geometry");
    this.unknown.add("cursor");
  }
}

// src/pipe-history-runtime.ts
var PIPE_HISTORY_RUNTIME_CAPABILITY = Object.freeze({
  wire: "newarch-frame-v1",
  projectionSchema: PROJECTION_SCHEMA_VERSION,
  metadataRevision: true,
  archiveReadVersions: Object.freeze([2, 3, 4, 5])
});
var BASE16 = [
  "000000",
  "cd0000",
  "00cd00",
  "cdcd00",
  "0000ee",
  "cd00cd",
  "00cdcd",
  "e5e5e5",
  "7f7f7f",
  "ff0000",
  "00ff00",
  "ffff00",
  "5c5cff",
  "ff00ff",
  "00ffff",
  "ffffff"
];
var XTERM_256 = (() => {
  const table = [...BASE16];
  const steps = [0, 95, 135, 175, 215, 255];
  for (let i = 0;i < 216; i++) {
    table.push([steps[Math.floor(i / 36) % 6], steps[Math.floor(i / 6) % 6], steps[i % 6]].map((v) => v.toString(16).padStart(2, "0")).join(""));
  }
  for (let i = 0;i < 24; i++) {
    const v = (8 + i * 10).toString(16).padStart(2, "0");
    table.push(v + v + v);
  }
  return table;
})();
var NAMED = ["black", "red", "green", "brown", "blue", "magenta", "cyan", "white"];
var rgbOf = (hex) => `rgb:${parseInt(hex.slice(0, 2), 16)},${parseInt(hex.slice(2, 4), 16)},${parseInt(hex.slice(4, 6), 16)}`;
function canonicalParserColor(value) {
  if (value === "default")
    return "default";
  const bright = value.startsWith("bright");
  const named = NAMED.indexOf(bright ? value.slice(6) : value);
  if (named >= 0)
    return `index:${named + (bright ? 8 : 0)}`;
  if (/^[0-9a-fA-F]{6}$/.test(value)) {
    const hex = value.toLowerCase();
    const base = BASE16.indexOf(hex);
    return base >= 0 ? `index:${base}` : rgbOf(hex);
  }
  return value;
}
function canonicalCaptureColor(value) {
  const match = /^index:(\d+)$/.exec(value);
  if (match && Number(match[1]) >= 16 && Number(match[1]) <= 255)
    return rgbOf(XTERM_256[Number(match[1])]);
  return value;
}
var OBSERVED_STYLE_MASK = 1 | 4 | 8 | 16 | 64 | 256;
function parserStyle(attrs) {
  return (attrs & 1 ? 1 : 0) | (attrs & 2 ? 4 : 0) | (attrs & 4 ? 8 : 0) | (attrs & 8 ? 256 : 0) | (attrs & 16 ? 64 : 0) | (attrs & 32 ? 16 : 0);
}
var allocations = {
  parserRowArrays: 0,
  blankRowsShared: 0,
  canonicalRowArrays: 0,
  canonicalRowsShared: 0,
  ringArrayCopies: 0
};
function pipeHistoryAllocations() {
  return { ...allocations, blankRowWidths: blankRows.size };
}
var interned = new Map;
var internedCells2 = 0;
function internTable(width, continuation, fg, bg, style) {
  const key = `${width}${continuation ? 1 : 0}\x00${fg}\x00${bg}\x00${style}`;
  let table = interned.get(key);
  if (!table) {
    table = new Map;
    interned.set(key, table);
  }
  return table;
}
function internIn(table, grapheme, width, continuation, fg, bg, style) {
  let cell = table.get(grapheme);
  if (!cell) {
    if (internedCells2 >= 65536) {
      interned.clear();
      internedCells2 = 0;
      internTable(1, false, "default", "default", 0).set(" ", BLANK_CELL);
      internedCells2++;
    }
    cell = Object.freeze({ grapheme, width, continuation, fg, bg, style });
    table.set(grapheme, cell);
    internedCells2++;
  }
  return cell;
}
function internCell2(grapheme, width, continuation, fg, bg, style) {
  return internIn(internTable(width, continuation, fg, bg, style), grapheme, width, continuation, fg, bg, style);
}
var BLANK_CELL = internCell2(" ", 1, false, "default", "default", 0);
var blankRows = new Map;
function sharedBlankRow(cols) {
  let row = blankRows.get(cols);
  if (!row) {
    if (blankRows.size >= 64)
      blankRows.clear();
    row = Object.freeze(new Array(cols).fill(BLANK_CELL));
    blankRows.set(cols, row);
  }
  allocations.blankRowsShared++;
  return row;
}
var isBlankRun = (run) => run[0] === "default" && run[1] === "default" && run[2] === 0 && (typeof run[3] === "string" ? /^ *$/.test(run[3]) : run[3].every((glyph) => glyph === " "));
function parserRowCells(row, cols) {
  if (row.every(isBlankRun)) {
    let width2 = cols;
    if (width2 === undefined) {
      width2 = 0;
      for (const run of row)
        width2 += run[3].length;
    }
    return sharedBlankRow(width2);
  }
  allocations.parserRowArrays++;
  const glyphs = [];
  const styles = [];
  for (const run of row) {
    const style = { fg: canonicalParserColor(run[0]), bg: canonicalParserColor(run[1]), style: parserStyle(run[2]) };
    for (const glyph of pipeVtRunCells(run)) {
      glyphs.push(glyph);
      styles.push(style);
    }
  }
  const width = cols ?? glyphs.length;
  const cells = new Array(width);
  for (let x = 0;x < width; x++) {
    const glyph = glyphs[x];
    if (glyph === undefined) {
      cells[x] = BLANK_CELL;
      continue;
    }
    const s = styles[x];
    if (glyph === "")
      cells[x] = internIn(s.cont ??= internTable(0, true, s.fg, s.bg, s.style), "", 0, true, s.fg, s.bg, s.style);
    else if (glyphs[x + 1] === "")
      cells[x] = internIn(s.wide ??= internTable(2, false, s.fg, s.bg, s.style), glyph, 2, false, s.fg, s.bg, s.style);
    else
      cells[x] = internIn(s.narrow ??= internTable(1, false, s.fg, s.bg, s.style), glyph, 1, false, s.fg, s.bg, s.style);
  }
  return cells;
}
var canonicalRows = new WeakMap;
var canonicalCells = new WeakMap;
function canonicalCell(cell) {
  let mapped = canonicalCells.get(cell);
  if (!mapped) {
    mapped = internCell2(cell.grapheme, cell.width, cell.continuation, canonicalCaptureColor(cell.fg), canonicalCaptureColor(cell.bg), cell.style);
    if (Object.isFrozen(cell))
      canonicalCells.set(cell, mapped);
  }
  return mapped;
}
function canonicalCaptureCells(row, cols) {
  const cached = canonicalRows.get(row);
  if (cached && cached.length === cols)
    return cached;
  allocations.canonicalRowArrays++;
  const cells = new Array(cols);
  for (let x = 0;x < cols; x++) {
    const cell = row[x];
    cells[x] = cell ? canonicalCell(cell) : BLANK_CELL;
  }
  if (Object.isFrozen(row) || Array.isArray(row))
    canonicalRows.set(row, cells);
  return cells;
}
function canonicalCaptureDecoder(cols) {
  return new TmuxCaptureDecoder(cols, undefined, undefined, canonicalCell);
}
function decodeCanonicalCapture(decoder, body) {
  const { cols, mapsCells: shared } = decoder;
  return decoder.decode(body).map((row) => {
    if (shared && row.length === cols) {
      allocations.canonicalRowsShared++;
      return row;
    }
    return canonicalCaptureCells(row, cols);
  });
}
function rowText(cells) {
  let text = "";
  for (const cell of cells)
    if (!cell.continuation)
      text += cell.grapheme;
  return text;
}
function toPhysicalRow(cells) {
  return { text: rowText(cells), cells };
}
function colorSgr(value, background) {
  if (value === "default")
    return "";
  const index = /^index:(\d+)$/.exec(value);
  if (index) {
    const n = Number(index[1]);
    if (n < 8)
      return `;${(background ? 40 : 30) + n}`;
    if (n < 16)
      return `;${(background ? 100 : 90) + n - 8}`;
    return `;${background ? 48 : 38};5;${n}`;
  }
  const rgb = /^rgb:(\d+),(\d+),(\d+)$/.exec(value);
  return rgb ? `;${background ? 48 : 38};2;${rgb[1]};${rgb[2]};${rgb[3]}` : "";
}
var STYLE_SGR = [[1, 1], [2, 2], [4, 3], [8, 4], [16, 5], [32, 6], [64, 7], [128, 8], [256, 9]];
function cellSgr(cell) {
  let codes = "0";
  for (const [bit, code] of STYLE_SGR)
    if (cell.style & bit)
      codes += `;${code}`;
  return `\x1B[${codes}${colorSgr(cell.fg, false)}${colorSgr(cell.bg, true)}m`;
}
var isDefaultBlank = (cell) => cell.grapheme === " " && cell.fg === "default" && cell.bg === "default" && cell.style === 0;
function cellsToAnsi(cells) {
  let end = cells.length;
  while (end > 0 && (isDefaultBlank(cells[end - 1]) || cells[end - 1].continuation && end === cells.length))
    end--;
  let out = "";
  let current = "default\x00default\x000";
  for (let x = 0;x < end; x++) {
    const cell = cells[x];
    if (cell.continuation)
      continue;
    const key = `${cell.fg}\x00${cell.bg}\x00${cell.style}`;
    if (key !== current) {
      out += cellSgr(cell);
      current = key;
    }
    out += cell.grapheme;
  }
  if (current !== "default\x00default\x000")
    out += "\x1B[0m";
  return out;
}
var ANSI_ROWS = new WeakMap;
function rowAnsi(cells) {
  let ansi = ANSI_ROWS.get(cells);
  if (ansi === undefined) {
    ansi = cellsToAnsi(cells);
    ANSI_ROWS.set(cells, ansi);
  }
  return ansi;
}
var RING_ROWS = 4500;
var FRAME_WRITE_MS = 16;
var FRAME_PRESSURE_RETRY_MS = 50;
var FRAME_BUDGET_SHARE = 0.3;
var FRAME_BUDGET_WINDOW_MS = 250;
var STATS_MAX_SAMPLES = 32768;
var STATS_MAX_AGE_MS = 5 * 60000;
var RECEIVE_MAX_PENDING = 65536;
var RECEIVE_MAX_AGE_NS = 120000000000n;
var FRAME_MARKERS_MAX = 256;

class FrameBudget {
  clock;
  load = 0;
  at;
  constructor(clock = () => performance.now()) {
    this.clock = clock;
    this.at = clock();
  }
  decay() {
    const now = this.clock();
    if (now > this.at) {
      this.load *= Math.exp((this.at - now) / FRAME_BUDGET_WINDOW_MS);
      this.at = now;
    }
  }
  spend(ms) {
    this.decay();
    this.load += Math.max(0, ms);
  }
  share() {
    this.decay();
    return this.load / FRAME_BUDGET_WINDOW_MS;
  }
  busy() {
    return this.share() > FRAME_BUDGET_SHARE;
  }
}
function trimStatsRing(values, times, limit, floor) {
  let drop = values.length > limit + (limit >> 2) ? values.length - limit : 0;
  if ((values.length & 1023) === 0 || drop > 0)
    while (drop < times.length && times[drop] < floor)
      drop++;
  if (drop > 0) {
    values.splice(0, drop);
    if (times !== values)
      times.splice(0, drop);
  }
}
var blankRow = (cols) => sharedBlankRow(cols);
function applyFrameDelta(screen, cells) {
  const { cols, rows } = cells;
  const sameGeometry = screen !== undefined && screen.cols === cols && screen.rows === rows;
  let next;
  if (cells.full || !sameGeometry)
    next = Array.from({ length: rows }, () => blankRow(cols));
  else {
    const shift = Math.max(0, Math.min(rows, cells.shift));
    next = [...screen.cells.slice(shift), ...Array.from({ length: shift }, () => blankRow(cols))];
  }
  let complete = cells.full || sameGeometry;
  for (const [y, row] of Object.entries(cells.dirty)) {
    const index = Number(y);
    if (index >= 0 && index < rows)
      next[index] = parserRowCells(row, cols);
  }
  if (!cells.full && !sameGeometry)
    complete = Object.keys(cells.dirty).length >= rows;
  return { screen: { cols, rows, cells: next }, complete };
}
function sameScreen(a, b, ca, cb) {
  if (a.length !== b.length || JSON.stringify(ca) !== JSON.stringify(cb))
    return false;
  for (let y = 0;y < a.length; y++) {
    const ra = a[y], rb = b[y];
    if (ra.length !== rb.length)
      return false;
    for (let x = 0;x < ra.length; x++)
      if (ra[x] !== rb[x])
        return false;
  }
  return true;
}
var clampCursor = (cursor, cols, rows) => ({
  x: Math.max(0, Math.min(cols - 1, cursor.x)),
  y: Math.max(0, Math.min(rows - 1, cursor.y)),
  visible: cursor.visible
});
function refusedAlready(answer) {
  const peek = globalThis.Bun?.peek;
  return peek?.status?.(answer) === "fulfilled" && isProjectionRefusal(peek(answer));
}
function seedBytes(raw, meta) {
  const lines = raw.split(`
`);
  if (lines.at(-1) === "")
    lines.pop();
  const screen = lines.slice(Math.max(0, lines.length - meta.rows));
  const cursor = clampCursor(meta.cursor, meta.cols, meta.rows);
  let text = meta.alternate ? "\x1B[?1049h" : "";
  screen.forEach((line, y) => {
    text += `\x1B[${y + 1};1H\x1B[0m${line}`;
  });
  text += `\x1B[0m\x1B[${cursor.y + 1};${cursor.x + 1}H${cursor.visible ? "\x1B[?25h" : "\x1B[?25l"}`;
  return new TextEncoder().encode(text);
}

class PipeHistoryPane {
  runtime;
  options;
  paneKey;
  session;
  collector;
  calibrator;
  watchdog;
  screens = {};
  parserKind = "normal";
  parserCursor = { x: 0, y: 0, visible: true };
  displayed = null;
  pulled = { rows: 0, endLine: 0 };
  capturedPull = null;
  historySizeUnknown = false;
  ring = [];
  ringRepairs = 0;
  scrollSeq = 0;
  scrollSeqEpoch = -1;
  received = 0;
  receiveTimes = [];
  receiveHead = 0;
  latencyAt = [];
  latencyRef = null;
  listeners = new Set;
  meta;
  decoder = null;
  closed = false;
  lastCaptureAt = null;
  lastStoreCommitAt = -Infinity;
  skippedCommit = false;
  certified = new Set;
  pendingPublish = null;
  pendingFrame = null;
  frameTimer = null;
  frameWriting = false;
  lastFrameWriteAt = -Infinity;
  frameBackoffUntil = 0;
  pendingIssues = [];
  overlay = null;
  seedGap = null;
  stats = {
    received: 0,
    published: 0,
    latencyMs: [],
    captures: 0,
    captureFaults: 0,
    captureConflicts: 0,
    screenCalibrations: 0,
    storeCommits: 0,
    skippedCommits: 0,
    notReady: 0,
    captureIntervalMaxMs: 0,
    captureAt: [],
    faults: {}
  };
  constructor(runtime, options) {
    this.runtime = runtime;
    this.options = options;
    this.paneKey = { ...options.paneKey };
    this.session = options.session;
    this.meta = options.meta;
    const now = runtime.now;
    this.watchdog = new HistoryWatchdog(now, (fault) => this.onRuntimeFault(fault.kind, "watchdog", null));
    this.collector = new PipeHistoryCollector({
      paneKey: this.paneKey,
      sourceEpoch: options.sourceEpoch ?? 1,
      scrollOnClear: options.scrollOnClear,
      cols: options.meta.cols,
      rows: options.meta.rows,
      assets: runtime.options.assets,
      python: runtime.options.python,
      pool: runtime.parserPool,
      nowNs: runtime.nowNs,
      now,
      latencySampleLimit: 0,
      ports: {
        onScroll: (event) => this.onScroll(event),
        onFrame: (event) => this.onFrame(event),
        onFault: (event) => this.onCollectorFault(event)
      }
    });
    this.calibrator = options.calibrate === false ? null : new HistoryCalibrator(this.paneKey, {
      now,
      schedule: () => runtime.arm(),
      capture: (_key, tail, signal) => this.capture(tail ?? 0, signal ?? new AbortController().signal),
      read: () => this.read(),
      calibrate: (input) => this.commitCalibration(input),
      publish: (commit, frame) => this.publishCapture(commit, frame),
      fault: (issue) => this.onRuntimeFault(issue.kind, "calibrator", null)
    }, {
      incremental: options.incremental ?? true,
      historyLimit: options.historyLimit,
      certifiedStyleMask: OBSERVED_STYLE_MASK
    });
  }
  async start() {
    await this.collector.start();
  }
  ingest(bytes2) {
    const at = this.runtime.nowNs();
    const seq = ++this.received;
    this.stats.received = seq;
    const head = this.receiveTimes[this.receiveHead];
    if (head && at - head.at > RECEIVE_MAX_AGE_NS)
      this.expireReceipts(at);
    if (this.receiveTimes.length - this.receiveHead < RECEIVE_MAX_PENDING)
      this.receiveTimes.push({ seq, at });
    else
      this.bump("receipt-ring-full");
    this.watchdog.receive(seq);
    return this.collector.ingest(bytes2, at);
  }
  drained() {
    return this.collector.drained();
  }
  receiveCounter() {
    return this.received;
  }
  seed(raw, meta) {
    if (this.received > 0)
      throw new Error("seed after pipe bytes");
    this.armSeedGap(meta);
    this.ingest(seedBytes(raw, meta));
  }
  reseed(raw, meta) {
    this.armSeedGap(meta);
    this.ingest(seedBytes(raw, meta));
  }
  armSeedGap(meta) {
    const rows = meta.alternate ? 0 : clampCursor(meta.cursor, meta.cols, meta.rows).y;
    this.seedGap = rows > 0 ? { base: this.tokenOrNull()?.nextLineId ?? 0, rows, seen: 0 } : null;
  }
  recordSeedGap(gap, event) {
    const reason = "output between the seed capture and the pipe start is not journaled";
    this.runtime.emit({ paneKey: this.paneKey, session: this.session, kind: "seed-gap", at: this.runtime.now(), message: reason, missingCount: null });
    const token = this.tokenOrNull();
    if (!token)
      return;
    this.runtime.store.recordIssue({
      paneKey: this.paneKey,
      sourceEpoch: event.sourceEpoch,
      geometryGeneration: event.geometryGeneration,
      expectedRevision: token.revision,
      kind: "seed-gap",
      reason,
      missingCount: null,
      boundaryLineId: gap.base + gap.rows,
      recoverable: true
    }).then((receipt) => this.notify({ source: "issue", revision: receipt.revision }), () => {
      this.bump("seed-gap-unrecorded");
    });
  }
  onScroll(event) {
    const cells = parserRowCells(event.physicalRow);
    if (event.sourceEpoch !== this.scrollSeqEpoch) {
      this.scrollSeqEpoch = event.sourceEpoch;
      this.scrollSeq = 0;
    }
    const receiveSeq = Math.max(this.scrollSeq, event.receiveSeq);
    this.scrollSeq = receiveSeq;
    const gap = this.seedGap;
    if (gap && gap.seen >= gap.rows) {
      this.seedGap = null;
      this.recordSeedGap(gap, event);
    }
    const answer = this.runtime.store.appendScroll({
      paneKey: this.paneKey,
      sourceEpoch: event.sourceEpoch,
      geometryGeneration: event.geometryGeneration,
      physicalRow: toPhysicalRow(cells),
      softWrap: event.softWrap,
      receiveSeq
    });
    if (this.seedGap && !refusedAlready(answer))
      this.seedGap.seen++;
    answer.then((receipt) => {
      if (isProjectionRefusal(receipt))
        return;
      this.remember({ lineId: receipt.nextLineId - 1, sourceEpoch: event.sourceEpoch, geometryGeneration: event.geometryGeneration, cells, softWrap: false });
      this.calibrator?.scroll(1);
    }, () => {});
    return answer;
  }
  remember(row) {
    this.ring.push(Object.freeze({ ...row, ansiCache: {} }));
    const limit = this.runtime.options.ringRows ?? RING_ROWS;
    if (this.ring.length > limit + 512) {
      this.ring = this.ring.slice(this.ring.length - limit);
      allocations.ringArrayCopies++;
      this.pruneCertified();
    }
  }
  pruneCertified() {
    const floor = this.ring[0]?.lineId;
    if (floor === undefined)
      return;
    for (const id of this.certified)
      if (id < floor)
        this.certified.delete(id);
  }
  onFrame(event) {
    const previous = this.screens[event.kind];
    const { screen, complete } = applyFrameDelta(previous, event.cells);
    const cursor = clampCursor(event.cursor, screen.cols, screen.rows);
    this.screens[event.kind] = screen;
    this.parserKind = event.kind;
    this.parserCursor = cursor;
    if (!complete)
      this.collector.requestFullFrame();
    this.pendingFrame = {
      paneKey: this.paneKey,
      sourceEpoch: event.sourceEpoch,
      geometryGeneration: event.geometryGeneration,
      receiveSeq: event.receiveSeq,
      cells: screen.cells,
      kind: event.kind,
      cols: screen.cols,
      rows: screen.rows,
      cursor: { row: cursor.y, col: cursor.x, visible: cursor.visible }
    };
    this.calibrator?.output();
    this.scheduleFrameWrite();
    return;
  }
  scheduleFrameWrite() {
    if (this.frameTimer || this.frameWriting || !this.pendingFrame || this.closed)
      return;
    const spacing = this.runtime.frameBudget.busy() ? FRAME_WRITE_MS : 0;
    const wait = Math.max(this.lastFrameWriteAt + spacing, this.frameBackoffUntil) - this.runtime.now();
    if (wait <= 0) {
      this.writeFrame();
      return;
    }
    this.frameTimer = setTimeout(() => {
      this.frameTimer = null;
      this.writeFrame();
    }, wait);
  }
  writeFrame() {
    const frame = this.pendingFrame;
    if (!frame || this.closed)
      return;
    this.pendingFrame = null;
    this.frameWriting = true;
    this.lastFrameWriteAt = this.runtime.now();
    const budget = this.runtime.frameBudget;
    const started = performance.now();
    const written = this.runtime.store.replaceScreen(frame);
    budget.spend(performance.now() - started);
    written.then((receipt) => {
      if (isProjectionRefusal(receipt)) {
        this.pendingFrame ??= frame;
        this.frameBackoffUntil = this.runtime.now() + FRAME_PRESSURE_RETRY_MS;
        this.bump("frame-pressure");
        return;
      }
      this.frameBackoffUntil = 0;
      if (this.pendingIssues.length) {
        for (const issue of this.pendingIssues.splice(0))
          this.recordIssue(issue.kind, issue.reason, issue.missingCount, issue.recoverable);
      }
      if (!this.calibrator || this.calibrator.acceptsPipeFrame) {
        const published = performance.now();
        this.publishPipe(frame, receipt);
        budget.spend(performance.now() - published);
      } else
        this.pendingPublish = { frame, receipt };
    }, (error2) => {
      this.onRuntimeFault("frame-write-failed", String(error2?.message ?? error2), null);
    }).finally(() => {
      this.frameWriting = false;
      this.scheduleFrameWrite();
    });
  }
  publishPipe(frame, receipt) {
    this.pendingPublish = null;
    this.displayed = {
      cells: frame.cells,
      kind: frame.kind,
      cols: frame.cols,
      rows: frame.rows,
      source: "pipe",
      cursor: frame.cursor ? { x: frame.cursor.col, y: frame.cursor.row, visible: frame.cursor.visible } : null,
      pulledBack: null
    };
    this.settleReceipts(frame.receiveSeq);
    this.notify({ source: "pipe", revision: receipt.revision });
  }
  settleReceipts(receiveSeq) {
    const now = this.runtime.nowNs();
    while (this.receiveHead < this.receiveTimes.length && this.receiveTimes[this.receiveHead].seq <= receiveSeq) {
      const entry = this.receiveTimes[this.receiveHead++];
      this.sampleLatency(Number(now - entry.at) / 1e6);
    }
    this.compactReceipts();
  }
  expireReceipts(now) {
    while (this.receiveHead < this.receiveTimes.length && now - this.receiveTimes[this.receiveHead].at > RECEIVE_MAX_AGE_NS) {
      const entry = this.receiveTimes[this.receiveHead++];
      this.sampleLatency(Number(now - entry.at) / 1e6);
      this.bump("receipt-expired");
    }
    this.compactReceipts();
  }
  compactReceipts() {
    if (this.receiveHead > 64 && this.receiveHead * 2 > this.receiveTimes.length) {
      this.receiveTimes.splice(0, this.receiveHead);
      this.receiveHead = 0;
    }
  }
  sampleLatency(ms) {
    const limit = this.runtime.options.latencySampleLimit ?? STATS_MAX_SAMPLES;
    if (limit <= 0)
      return;
    const samples = this.stats.latencyMs, at = this.runtime.now();
    if (samples !== this.latencyRef) {
      this.latencyRef = samples;
      this.latencyAt = samples.map(() => at);
    }
    samples.push(ms);
    this.latencyAt.push(at);
    trimStatsRing(samples, this.latencyAt, limit, at - STATS_MAX_AGE_MS);
  }
  pendingReceipts() {
    return this.receiveTimes.length - this.receiveHead;
  }
  onCollectorFault(event) {
    const count = event.lostRows === "unknown" ? null : typeof event.lostRows === "number" ? event.lostRows : null;
    switch (event.kind) {
      case "consumer-pressure":
      case "consumer-pressure-cleared":
        this.bump(event.kind);
        return;
      case "consumer-oversize":
        this.bump(event.kind);
        this.runtime.emit({ paneKey: this.paneKey, session: this.session, kind: event.kind, at: event.at, message: event.message, missingCount: count });
        return;
      case "worker-restarted":
      case "source-reset":
        this.bump(event.kind);
        this.screens = {};
        if (event.kind === "worker-restarted")
          this.seedGap = null;
        this.runtime.emit({ paneKey: this.paneKey, session: this.session, kind: event.kind, at: event.at, message: event.message, missingCount: null, receiveSeqFrom: event.receiveSeqFrom, receiveSeqTo: event.receiveSeqTo });
        this.calibrator?.event("fault");
        return;
      case "history-cleared":
        this.calibrator?.event("clear");
        break;
      default:
        break;
    }
    if (event.kind === "worker-exit" || event.kind === "spawn")
      this.watchdog.dead("worker-dead");
    this.onRuntimeFault(event.kind, event.message ?? "collector fault", count, event.receiveSeqFrom, event.receiveSeqTo);
  }
  onRuntimeFault(kind, message, missingCount, receiveSeqFrom, receiveSeqTo) {
    this.bump(kind);
    if (kind === "capture-fault")
      this.stats.captureFaults++;
    this.runtime.emit({ paneKey: this.paneKey, session: this.session, kind, at: this.runtime.now(), message, missingCount, receiveSeqFrom, receiveSeqTo });
    if (kind === "capture-fault")
      return;
    this.recordIssue(kind, message, missingCount);
  }
  recordIssue(kind, reason, missingCount, recoverable = true) {
    const token = this.tokenOrNull();
    if (!token) {
      if (this.pendingIssues.length < 64)
        this.pendingIssues.push({ kind, reason, missingCount, recoverable });
      return;
    }
    this.runtime.store.recordIssue({
      paneKey: this.paneKey,
      sourceEpoch: token.sourceEpoch,
      geometryGeneration: token.geometryGeneration,
      expectedRevision: token.revision,
      kind,
      reason,
      missingCount,
      boundaryLineId: token.nextLineId,
      recoverable
    }).then((receipt) => this.notify({ source: "issue", revision: receipt.revision }), () => {});
  }
  bump(kind) {
    this.stats.faults[kind] = (this.stats.faults[kind] ?? 0) + 1;
  }
  observe(meta) {
    if (this.closed)
      return;
    const previous = this.meta;
    this.meta = meta;
    if (meta.panePid !== previous.panePid && previous.panePid > 0) {
      this.collector.beginSourceEpoch(this.collector.currentSourceEpoch() + 1);
      this.recordIssue("respawn-observed", `pane process ${previous.panePid} -> ${meta.panePid}; parser reset, rows in flight unknown`, null);
    }
    if (meta.cols !== previous.cols || meta.rows !== previous.rows) {
      this.collector.resize(meta.cols, meta.rows);
      this.calibrator?.event("resize");
    }
    if (!historySizeReadable(meta)) {
      this.pulled = { rows: 0, endLine: 0 };
      if (!this.historySizeUnknown) {
        this.historySizeUnknown = true;
        this.recordIssue("history-size-unknown", "tmux history_size unreadable; rows tmux pulled back on resize cannot be told apart and may show twice", null);
      }
      return;
    }
    this.historySizeUnknown = false;
    if (!historySizeReadable(previous))
      return;
    const pull = resizePullback(previous, meta);
    if (pull > 0) {
      if (this.pulled.rows === 0)
        this.pulled = { rows: 0, endLine: this.tokenOrNull()?.nextLineId ?? 0 };
      this.pulled = { rows: Math.min(meta.rows, this.pulled.rows + pull), endLine: this.pulled.endLine };
    } else if (meta.historySize > previous.historySize && this.pulled.rows > 0) {
      this.pulled = { rows: Math.max(0, this.pulled.rows - (meta.historySize - previous.historySize)), endLine: this.pulled.endLine };
    }
    if (this.pulled.rows > meta.rows)
      this.pulled = { rows: meta.rows, endLine: this.pulled.endLine };
    const trimmed = previous.historySize >= previous.historyLimit * 0.9 && meta.historySize >= previous.historyLimit * 0.8;
    if (meta.historySize + pull < previous.historySize && !trimmed) {
      this.recordIssue("history-cleared-external", `tmux history ${previous.historySize} -> ${meta.historySize} rows; older rows stay in the journal, tmux can no longer certify them`, null);
      this.calibrator?.event("clear");
    }
  }
  currentMeta() {
    return this.meta;
  }
  tokenOrNull() {
    try {
      return this.runtime.store.token(this.paneKey);
    } catch {
      return null;
    }
  }
  read() {
    const token = this.tokenOrNull();
    const screen = this.screens[this.parserKind];
    const parserFrame = {
      cells: screen?.cells ?? [],
      cursor: screen ? this.parserCursor : null,
      kind: this.parserKind,
      geometryGeneration: token?.geometryGeneration ?? this.collector.currentGeometryGeneration(),
      receiveSeq: this.received
    };
    const ring = this.ring, length = ring.length;
    let copy2 = null;
    return {
      revision: token?.revision ?? 0,
      sourceEpoch: token?.sourceEpoch ?? this.collector.currentSourceEpoch(),
      geometryGeneration: token?.geometryGeneration ?? this.collector.currentGeometryGeneration(),
      recentLastLineId: length ? ring[length - 1].lineId : null,
      get recentHistory() {
        return copy2 ??= ring.slice(0, length);
      },
      parserFrame
    };
  }
  metadata(meta, epoch) {
    return {
      historyEpoch: epoch.sourceEpoch,
      sourceEpoch: epoch.sourceEpoch,
      geometryGeneration: epoch.geometryGeneration,
      cols: meta.cols,
      rows: meta.rows,
      kind: meta.alternate ? "alternate" : "normal",
      cursor: clampCursor(meta.cursor, meta.cols, meta.rows)
    };
  }
  async capture(tail, signal) {
    const epochOf = () => {
      const r = this.read();
      return { sourceEpoch: r.sourceEpoch, geometryGeneration: r.geometryGeneration };
    };
    const before = epochOf();
    const raw = await this.options.capture(tail, signal);
    const after = epochOf();
    this.observe(raw.after);
    this.capturedPull = !raw.after.alternate && this.pulled.rows > 0 ? { ...this.pulled } : null;
    const cols = raw.after.cols;
    if (!this.decoder || this.decoder.cols !== cols)
      this.decoder = canonicalCaptureDecoder(cols);
    const rows = decodeCanonicalCapture(this.decoder, raw.body);
    const uncertain = this.decoder.uncertainRows;
    const screenRows = rows.slice(Math.max(0, rows.length - raw.after.rows));
    const history = rows.slice(0, rows.length - screenRows.length).map((cells) => ({ cells, softWrap: false }));
    const metaAfter = this.metadata(raw.after, after);
    return {
      paneKey: this.paneKey,
      captureId: raw.captureId,
      requestedAt: raw.requestedAt,
      completedAt: raw.completedAt,
      before: this.metadata(raw.before, before),
      after: metaAfter,
      frame: { cells: screenRows, cursor: metaAfter.cursor, kind: metaAfter.kind, geometryGeneration: after.geometryGeneration, receiveSeq: -1 },
      history,
      completeRetainedTail: tail > 0 && (history.length < tail || tail >= 4500),
      observedFields: [...TMUX_OBSERVED_FIELDS],
      uncertainHistoryRows: uncertain.filter((y) => y < history.length),
      uncertainScreenRows: uncertain.filter((y) => y >= history.length).map((y) => y - history.length)
    };
  }
  async commitCalibration(input) {
    const c = input.capture;
    const meta = c.after;
    if (this.overlay) {
      this.stats.notReady++;
      return null;
    }
    if (!this.tokenOrNull()) {
      this.stats.notReady++;
      return null;
    }
    const fresh = [...input.checks, ...input.contentMatches].filter((m) => !this.certified.has(m.lineId));
    const screenChanged = input.captureEvidence.kind === "quiescent" && (this.displayed?.source !== "tmux-calibrated" || !sameScreen(this.displayed.cells, c.frame.cells, this.displayed.cursor, c.frame.cursor));
    const due = this.runtime.now() - this.lastStoreCommitAt >= (this.options.commitIntervalMs ?? 1000);
    if (!input.repairs.length && !screenChanged && (fresh.length === 0 || !due && fresh.length < 64)) {
      const token = this.tokenOrNull();
      if (token) {
        this.stats.skippedCommits++;
        this.countCapture();
        this.skippedCommit = true;
        return { revision: token.revision, durableRevision: token.durableRevision, nextLineId: token.nextLineId };
      }
    }
    this.skippedCommit = false;
    const checks = input.checks.filter((m) => !this.certified.has(m.lineId));
    const contentMatches = input.contentMatches.filter((m) => !this.certified.has(m.lineId));
    const used = [...new Set([...checks, ...contentMatches, ...input.repairs].map((m) => m.capturedRow))].sort((a, b) => a - b);
    const index = new Map(used.map((row, i) => [row, i]));
    const mapRow = (row) => index.get(row);
    const projected = {
      paneKey: this.paneKey,
      sourceEpoch: meta.sourceEpoch,
      geometryGeneration: meta.geometryGeneration,
      receiveSeq: 0,
      cells: c.frame.cells,
      kind: meta.kind,
      cols: meta.cols,
      rows: meta.rows,
      cursor: meta.cursor ? { row: meta.cursor.y, col: meta.cursor.x, visible: meta.cursor.visible } : null,
      captureId: c.captureId,
      requestedAt: c.requestedAt,
      completedAt: c.completedAt,
      firstHistoryRow: used[0] ?? 0,
      history: used.map((row) => toPhysicalRow(c.history[row].cells)),
      observedFields: [...c.observedFields],
      ambiguousRows: (c.uncertainHistoryRows?.length ?? 0) + (c.uncertainScreenRows?.length ?? 0),
      result: input.captureEvidence.kind
    };
    try {
      const receipt = await this.runtime.store.calibrate({
        capture: projected,
        expectedRevision: input.expectedRevision,
        captureEvidence: input.captureEvidence,
        checks: checks.map((m) => ({ lineId: m.lineId, captureRow: mapRow(m.capturedRow) })),
        contentMatches: contentMatches.map((m) => ({ lineId: m.lineId, captureRow: mapRow(m.capturedRow) })),
        repairs: input.repairs.map((m) => ({ lineId: m.lineId, captureRow: mapRow(m.capturedRow), physicalRow: toPhysicalRow(m.row.cells) }))
      });
      this.countCapture();
      this.lastStoreCommitAt = this.runtime.now();
      this.stats.storeCommits++;
      const floor = this.ring[0]?.lineId ?? 0;
      for (const m of [...checks, ...contentMatches, ...input.repairs])
        if (m.lineId >= floor)
          this.certified.add(m.lineId);
      if (input.repairs.length) {
        const byId = new Map(input.repairs.map((r) => [r.lineId, r.row.cells]));
        this.ring = this.ring.map((row) => {
          const cells = byId.get(row.lineId);
          return cells ? Object.freeze({ ...row, cells, ansiCache: {} }) : row;
        });
        allocations.ringArrayCopies++;
        this.ringRepairs++;
      }
      return receipt;
    } catch (error2) {
      if (String(error2?.message ?? error2).includes("stale-revision")) {
        this.stats.captureConflicts++;
        return null;
      }
      throw error2;
    }
  }
  countCapture() {
    const at = this.runtime.now();
    if (this.lastCaptureAt !== null)
      this.stats.captureIntervalMaxMs = Math.max(this.stats.captureIntervalMaxMs, at - this.lastCaptureAt);
    this.lastCaptureAt = at;
    this.stats.captures++;
    this.stats.captureAt.push(at);
    trimStatsRing(this.stats.captureAt, this.stats.captureAt, STATS_MAX_SAMPLES, at - STATS_MAX_AGE_MS);
  }
  publishCapture(commit, frame) {
    const cells = frame.cells;
    this.settleReceipts(this.received);
    if (this.skippedCommit) {
      this.skippedCommit = false;
      return;
    }
    this.displayed = {
      cells,
      cursor: frame.cursor,
      kind: frame.kind,
      cols: cells[0]?.length ?? this.meta.cols,
      rows: cells.length,
      source: "tmux-calibrated",
      pulledBack: frame.kind === "normal" ? this.capturedPull : null
    };
    this.pendingPublish = null;
    this.stats.screenCalibrations++;
    this.watchdog.capture(cells.map(rowText).join(`
`), { sourceEpoch: this.read().sourceEpoch, geometryGeneration: frame.geometryGeneration, kind: frame.kind });
    this.notify({ source: "tmux-calibrated", revision: commit.revision });
  }
  tick() {
    if (this.pendingPublish && this.calibrator?.acceptsPipeFrame) {
      const { frame, receipt } = this.pendingPublish;
      this.publishPipe(frame, receipt);
    }
    this.watchdog.tick();
  }
  setViewers(count) {
    this.calibrator?.setViewers(count);
  }
  subscribe(listener) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  notify(update) {
    this.stats.published++;
    for (const listener of [...this.listeners]) {
      try {
        listener(update);
      } catch (error2) {
        console.error("[pipe-history-runtime] listener failed:", error2);
      }
    }
  }
  health(health) {
    if (!health && this.runtime.store.paneHealth) {
      const own = this.runtime.store.paneHealth(this.paneKey);
      return { degraded: own?.status === "degraded", issues: own?.issues ?? [] };
    }
    const state = (health ?? this.runtime.store.health()).panes.find((p) => p.paneKey.serverIdentity === this.paneKey.serverIdentity && p.paneKey.paneId === this.paneKey.paneId && p.paneKey.birthGeneration === this.paneKey.birthGeneration);
    return { degraded: state?.status === "degraded", issues: state?.issues ?? [] };
  }
  setStorageOverlay(marker) {
    if (!marker) {
      if (!this.overlay)
        return;
      this.overlay = null;
    } else {
      const token = this.tokenOrNull();
      this.overlay = {
        issueId: `storage-overlay:${marker.eventId}`,
        sourceEpoch: token?.sourceEpoch ?? this.collector.currentSourceEpoch(),
        revision: token?.revision ?? 0,
        boundaryLineId: marker.boundaryLineId,
        kind: marker.kind,
        reason: marker.reason,
        missingCount: null,
        detectedAt: marker.detectedAt,
        resolvedAt: null
      };
    }
    this.notify({ source: "issue", revision: this.tokenOrNull()?.revision ?? 0 });
  }
  storageOverlay() {
    return this.overlay;
  }
  showUnstored(raw) {
    if (this.closed || !this.overlay)
      return;
    const cols = raw.after.cols;
    if (!this.decoder || this.decoder.cols !== cols)
      this.decoder = canonicalCaptureDecoder(cols);
    const rows = decodeCanonicalCapture(this.decoder, raw.body);
    const cells = rows.slice(Math.max(0, rows.length - raw.after.rows));
    const cursor = clampCursor(raw.after.cursor, cols, raw.after.rows);
    this.observe(raw.after);
    this.displayed = { cells, cursor, kind: raw.after.alternate ? "alternate" : "normal", cols, rows: cells.length, source: "tmux-calibrated", pulledBack: null };
    this.notify({ source: "tmux-calibrated", revision: this.tokenOrNull()?.revision ?? 0 });
  }
  view(health) {
    const token = this.tokenOrNull();
    const shown = this.displayed;
    const own = token ? this.health(health) : { degraded: false, issues: [] };
    const degraded = own.degraded || this.overlay !== null;
    const issues = this.overlay ? [...own.issues, this.overlay] : own.issues;
    return {
      paneKey: this.paneKey,
      session: this.session,
      cells: shown?.cells ?? [],
      cursor: shown?.cursor ?? null,
      kind: shown?.kind ?? "normal",
      cols: shown?.cols ?? this.meta.cols,
      rows: shown?.rows ?? this.meta.rows,
      displaySource: shown?.source ?? "none",
      token,
      sourceEpoch: token?.sourceEpoch ?? this.collector.currentSourceEpoch(),
      geometryGeneration: token?.geometryGeneration ?? this.collector.currentGeometryGeneration(),
      mouseSgr: this.meta.mouseSgr,
      mouseAny: this.meta.mouseAny,
      degraded,
      issues,
      pulledBack: shown?.pulledBack ?? null
    };
  }
  recentRows() {
    return this.ring;
  }
  memoryStats() {
    const m = CACHE_BYTE_MODEL;
    const arrays = new Set;
    let cellSlots = 0, sharedRows = 0, ansiChars = 0, ansiRows = 0;
    for (const row of this.ring) {
      const ansi = row.ansiCache.text;
      if (ansi !== undefined) {
        ansiRows++;
        ansiChars += ansi.length;
      }
      if (arrays.has(row.cells)) {
        sharedRows++;
        continue;
      }
      arrays.add(row.cells);
      cellSlots += row.cells.length;
    }
    const rows = this.ring.length;
    const ring = {
      rows,
      rowArrays: arrays.size,
      sharedRows,
      cellSlots,
      ansiRows,
      ansiChars,
      floor: this.ring[0]?.lineId ?? null,
      bytes: m.arrayHeader + rows * (2 * m.slot + 2 * m.object) + arrays.size * m.arrayHeader + cellSlots * m.slot + ansiRows * m.stringHeader + ansiChars * m.char
    };
    const certified = { ids: this.certified.size, bytes: this.certified.size * m.setEntry };
    const decoder = this.decoder ? this.decoder.stats() : null;
    return { ring, certified, decoder, bytes: ring.bytes + certified.bytes + (decoder?.bytes ?? 0) };
  }
  readRange(start, end) {
    for (let attempt = 0;attempt < 5; attempt++) {
      const token = this.tokenOrNull();
      if (!token)
        return null;
      const stop = Math.min(end, token.nextLineId);
      const from = Math.max(0, Math.min(start, stop));
      const lines = [];
      let issues = [];
      try {
        for (let at = from;at < stop; ) {
          const page = this.runtime.store.readPage(token, at, Math.min(2000, stop - at));
          for (const line of page.lines)
            lines.push(cellsToAnsi(line.cells));
          issues = page.issues;
          at = page.nextAnchor;
          if (page.lines.length === 0)
            break;
        }
        if (this.overlay)
          issues = [...issues, this.overlay];
        return { lines, startLine: from, token, issues: issues.filter((i) => i.boundaryLineId !== null && i.boundaryLineId >= from && i.boundaryLineId <= stop) };
      } catch (error2) {
        if (!String(error2?.message).includes("page-retry"))
          throw error2;
      }
    }
    return null;
  }
  async drainReceipt(timeoutMs = 5000) {
    const deadline2 = Date.now() + Math.max(0, timeoutMs);
    const issues = [];
    const settled = () => {
      const stats2 = this.collector.stats();
      return stats2.ackedSeq >= stats2.receiveSeq && stats2.inflightBytes === 0 && !this.frameWriting && !this.pendingFrame;
    };
    while (!settled() && Date.now() < deadline2 && !this.closed) {
      if (this.pendingFrame && !this.frameWriting && !this.frameTimer)
        this.writeFrame();
      await new Promise((resolve4) => setTimeout(resolve4, 5));
    }
    const stats = this.collector.stats();
    if (!settled())
      issues.push(`consumer not settled within ${timeoutMs}ms: acked ${stats.ackedSeq} of ${stats.receiveSeq}, ${stats.inflightBytes} inflight bytes${this.pendingFrame || this.frameWriting ? ", newest screen not written" : ""}`);
    const token = this.tokenOrNull();
    let durableRevision = null;
    if (token) {
      const left = Math.max(0, deadline2 - Date.now());
      let timer = null;
      try {
        const receipt = await Promise.race([
          this.runtime.store.durable(this.paneKey, token.revision),
          new Promise((resolve4) => {
            timer = setTimeout(() => resolve4(null), left);
          })
        ]);
        if (receipt)
          durableRevision = receipt.durableRevision;
        else
          issues.push(`store durable barrier at revision ${token.revision} did not settle within ${timeoutMs}ms`);
      } catch (error2) {
        issues.push(`store durable barrier failed: ${String(error2?.message ?? error2)}`);
      } finally {
        if (timer)
          clearTimeout(timer);
      }
    } else if (stats.receiveSeq > 0)
      issues.push("store holds no token for this pane");
    return {
      lastAdmittedSequence: stats.receiveSeq,
      lastAckedSequence: stats.ackedSeq,
      ramRevision: token?.revision ?? null,
      durableRevision,
      issues,
      unknownTail: issues.length > 0
    };
  }
  async close() {
    if (this.closed)
      return;
    await this.collector.close();
    if (this.frameTimer) {
      clearTimeout(this.frameTimer);
      this.frameTimer = null;
    }
    if (this.pendingFrame && !this.frameWriting)
      this.writeFrame();
    for (let i = 0;i < 100 && this.frameWriting; i++)
      await new Promise((resolve4) => setTimeout(resolve4, 5));
    this.closed = true;
    this.listeners.clear();
  }
}

class PipeHistoryRuntime {
  options;
  parserPool;
  store;
  now;
  nowNs;
  frameBudget = new FrameBudget;
  panesByKey = new Map;
  timer = null;
  heartbeat;
  armedAt = Infinity;
  closed = false;
  constructor(options) {
    this.options = options;
    this.parserPool = options.sharedParser === false ? undefined : new PipeVtPool({ assets: options.assets, python: options.python });
    this.store = options.store;
    this.now = options.now ?? Date.now;
    this.nowNs = options.nowNs ?? (() => process.hrtime.bigint());
    this.heartbeat = setInterval(() => {
      for (const pane of this.panesByKey.values()) {
        pane.watchdog.heartbeat();
        pane.tick();
      }
    }, 250);
    this.heartbeat.unref?.();
  }
  async addPane(options) {
    if (this.closed)
      throw new Error("runtime closed");
    const id = keyOf(options.paneKey);
    if (this.panesByKey.has(id))
      throw new Error(`pane already owned: ${id}`);
    const pane = new PipeHistoryPane(this, options);
    this.panesByKey.set(id, pane);
    try {
      await pane.start();
    } catch (error2) {
      this.panesByKey.delete(id);
      await pane.close().catch(() => {});
      throw error2;
    }
    this.arm();
    return pane;
  }
  pane(key) {
    return this.panesByKey.get(keyOf(key));
  }
  panes() {
    return [...this.panesByKey.values()];
  }
  async removePane(key) {
    const pane = this.panesByKey.get(keyOf(key));
    if (!pane)
      return;
    this.panesByKey.delete(keyOf(key));
    await pane.close();
  }
  emit(fault) {
    try {
      this.options.onFault?.(fault);
    } catch (error2) {
      console.error("[pipe-history-runtime] fault sink failed:", error2);
    }
  }
  arm() {
    if (this.closed)
      return;
    let due = Infinity;
    for (const pane of this.panesByKey.values())
      if (pane.calibrator)
        due = Math.min(due, pane.calibrator.dueAt);
    if (due === Infinity || due >= this.armedAt)
      return;
    if (this.timer)
      clearTimeout(this.timer);
    this.armedAt = due;
    this.timer = setTimeout(() => this.runDue(), Math.max(0, due - this.now()));
  }
  runDue() {
    this.timer = null;
    this.armedAt = Infinity;
    if (this.closed)
      return;
    const now = this.now();
    for (const pane of this.panesByKey.values()) {
      if (pane.calibrator && pane.calibrator.dueAt <= now)
        pane.calibrator.runDue();
    }
    this.arm();
  }
  async close() {
    if (this.closed)
      return;
    this.closed = true;
    if (this.timer)
      clearTimeout(this.timer);
    clearInterval(this.heartbeat);
    try {
      await Promise.all([...this.panesByKey.values()].map((pane) => pane.close()));
    } finally {
      this.panesByKey.clear();
      await this.parserPool?.close();
    }
  }
}
var keyOf = (key) => JSON.stringify([key.serverIdentity, key.paneId, key.birthGeneration]);
function createPipeHistoryRuntime(options) {
  return new PipeHistoryRuntime(options);
}
function pooledPercentile(samples, p) {
  if (!samples.length)
    return null;
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))];
}
var historySizeReadable = (meta) => Number.isSafeInteger(meta.historySize) && meta.historySize >= 0;
function resizePullback(before, after) {
  if (!historySizeReadable(before) || !historySizeReadable(after))
    return 0;
  if (before.alternate || after.alternate)
    return 0;
  const added = after.rows - before.rows;
  if (added <= 0)
    return 0;
  return Math.max(0, Math.min(added, before.historySize - after.historySize));
}
function screenOverlap(view) {
  if (view.displaySource !== "tmux-calibrated" || view.kind !== "normal" || !view.pulledBack)
    return 0;
  return Math.max(0, view.pulledBack.rows);
}
function fnv(value) {
  let hash = 2166136261;
  for (let i = 0;i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

class ProjectionLiveWindow {
  windowRows;
  starts = new Map;
  texts = new Map;
  constructor(windowRows = 1000) {
    this.windowRows = windowRows;
  }
  snapshot(pane, routeGeneration) {
    const view = pane.view();
    if (view.displaySource === "none" || !view.token || view.cells.length === 0)
      return null;
    const token = view.token;
    const ring = pane.recentRows();
    const id = keyOf(pane.paneKey);
    const alternate = view.kind === "alternate";
    let firstContiguous = token.nextLineId;
    for (let i = ring.length - 1;i >= 0 && ring[i].lineId === firstContiguous - 1; i--)
      firstContiguous = ring[i].lineId;
    let start = this.starts.get(id) ?? Math.max(firstContiguous, token.nextLineId - this.windowRows);
    if (alternate)
      start = token.nextLineId;
    else {
      if (start < firstContiguous)
        start = firstContiguous;
      if (token.nextLineId - start > 2 * this.windowRows)
        start = token.nextLineId - this.windowRows;
      if (start > token.nextLineId)
        start = token.nextLineId;
    }
    this.starts.set(id, start);
    const rows = [];
    const overlap = alternate ? 0 : screenOverlap(view);
    if (!alternate) {
      const hideEnd = view.pulledBack?.endLine ?? 0, hideStart = hideEnd - overlap;
      const offset = ring.length - (token.nextLineId - start);
      for (let i = Math.max(0, offset);i < ring.length; i++) {
        const row = ring[i];
        if (row.lineId >= hideStart && row.lineId < hideEnd)
          continue;
        rows.push(row);
      }
    }
    const history = this.historyText(id, rows, pane.ringRepairs, alternate ? "" : `${view.pulledBack?.endLine ?? 0}:${overlap}`);
    const screenLines = view.cells.map(rowAnsi);
    let trailing = 0;
    for (let i = screenLines.length - 1;i >= 0 && screenLines[i] === ""; i--)
      trailing++;
    const screenText = screenLines.join(`
`);
    const cursor = view.cursor && view.cursor.visible ? { row: view.rows - 1 - trailing - view.cursor.y, col: Math.max(0, view.cursor.x) } : null;
    const recentFrom = view.issues.length - 16;
    const markers = view.issues.filter((issue, i) => i >= recentFrom || issue.boundaryLineId !== null && issue.boundaryLineId >= start).slice(-FRAME_MARKERS_MAX).map((issue) => ({ lineId: issue.boundaryLineId, kind: issue.kind.slice(0, 64), missingCount: issue.missingCount }));
    const metadataRevision = view.issues.reduce((revision, issue) => Math.max(revision, issue.revision), 0);
    return {
      content: rows.length ? [history, screenText].join(`
`) : screenText,
      cursor,
      screen: { alt: alternate, mouseSgr: view.mouseSgr, mouseAny: view.mouseAny },
      boundary: {
        generation: `newarch:${fnv(pane.paneKey.serverIdentity)}:${pane.paneKey.paneId}:${pane.paneKey.birthGeneration}:r${routeGeneration}`,
        liveStartLine: start,
        walSequence: String(token.revision),
        walOffset: token.revision
      },
      newarch: {
        v: "newarch-frame-v1",
        paneKey: { ...pane.paneKey },
        sourceEpoch: view.sourceEpoch,
        geometryGeneration: view.geometryGeneration,
        routeGeneration,
        metadataRevision,
        cols: view.cols,
        rows: view.rows,
        revision: token.revision,
        durableRevision: token.durableRevision,
        nextLineId: token.nextLineId,
        liveStartLine: start,
        displaySource: view.displaySource,
        degraded: view.degraded,
        markers
      }
    };
  }
  historyText(id, rows, repairs, hide) {
    if (!rows.length) {
      this.texts.delete(id);
      return "";
    }
    const cached = this.texts.get(id);
    let text, from;
    if (cached && cached.repairs === repairs && cached.hide === hide && cached.firstId === rows[0].lineId && cached.count <= rows.length && rows[cached.count - 1].lineId === cached.lastId) {
      text = cached.text;
      from = cached.count;
    } else {
      text = "";
      from = 0;
    }
    if (from < rows.length) {
      const parts = from ? [text] : [];
      for (let i = from;i < rows.length; i++)
        parts.push(rows[i].ansiCache.text ??= cellsToAnsi(rows[i].cells));
      text = parts.join(`
`);
    }
    this.texts.set(id, { firstId: rows[0].lineId, lastId: rows[rows.length - 1].lineId, count: rows.length, repairs, hide, text });
    return text;
  }
  readBefore(pane, beforeLine, limit = 500) {
    const end = beforeLine ?? this.starts.get(keyOf(pane.paneKey)) ?? pane.view().token?.nextLineId ?? 0;
    const start = Math.max(0, end - Math.max(1, Math.min(2000, limit)));
    return this.page(pane, start, end);
  }
  readAfter(pane, afterLine, limit = 500) {
    const live = this.starts.get(keyOf(pane.paneKey)) ?? pane.view().token?.nextLineId ?? 0;
    const start = afterLine === null ? 0 : afterLine + 1;
    return this.page(pane, start, Math.min(live, start + Math.max(1, Math.min(2000, limit))));
  }
  page(pane, start, end) {
    if (end <= start)
      return { lines: [], startLine: null, hasMore: false, markers: [] };
    const range = pane.readRange(start, end);
    if (!range || range.lines.length === 0)
      return { lines: [], startLine: null, hasMore: false, markers: [] };
    return {
      lines: range.lines,
      startLine: range.startLine,
      hasMore: range.startLine > 0,
      markers: range.issues.map((issue) => ({ lineId: issue.boundaryLineId, kind: issue.kind, reason: issue.reason, missingCount: issue.missingCount }))
    };
  }
  forget(pane) {
    this.starts.delete(keyOf(pane));
    this.texts.delete(keyOf(pane));
  }
}
var createProjectionStore2 = createProjectionStore;
var NewarchV2Display2 = NewarchV2Display;
var pipeVtAssets2 = pipeVtAssets;
var verifyPipeVtAssets2 = verifyPipeVtAssets;
export {
  verifyPipeVtAssets2 as verifyPipeVtAssets,
  trimStatsRing,
  toPhysicalRow,
  sharedBlankRow,
  screenOverlap,
  rowText,
  resizePullback,
  pooledPercentile,
  pipeVtAssets2 as pipeVtAssets,
  pipeHistoryAllocations,
  parserStyle,
  parserRowCells,
  keyOf,
  decodeCanonicalCapture,
  createProjectionStore2 as createProjectionStore,
  createPipeHistoryRuntime,
  cellsToAnsi,
  canonicalParserColor,
  canonicalCaptureDecoder,
  canonicalCaptureColor,
  canonicalCaptureCells,
  applyFrameDelta,
  XTERM_256,
  StreamVtTransport,
  StreamRuntimePane,
  StreamRuntime,
  ProjectionLiveWindow,
  PipeHistoryRuntime,
  PipeHistoryPane,
  PIPE_HISTORY_RUNTIME_CAPABILITY,
  OBSERVED_STYLE_MASK,
  NewarchV2Display2 as NewarchV2Display,
  FrameBudget,
  FRAME_WRITE_MS,
  FRAME_PRESSURE_RETRY_MS,
  FRAME_BUDGET_SHARE,
  BLANK_CELL
};
