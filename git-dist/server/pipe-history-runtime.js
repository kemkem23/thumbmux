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
  return JSON.parse(inflateRawSync(data.subarray(1)).toString("utf8"));
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
  const expected = input.readUInt32BE(1), raw = inflateRawSync(input.subarray(37));
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
var INDEX, RGB, units = (g) => g.length === 1 || g.length === 2 && g.codePointAt(0) > 65535, BLOCK_FORMAT = 1, CAPTURE_ARCHIVE_FORMAT = 1;
var init_codec = __esm(() => {
  INDEX = /^index:(0|[1-9]\d*)$/;
  RGB = /^rgb:((?:0|[1-9]\d*),(?:0|[1-9]\d*),(?:0|[1-9]\d*))$/;
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
var FRAME_ROW_V2 = new WeakMap;
var VALID_ROWS = new WeakSet;
var encodeFrameRow = (row) => {
  let stored = FRAME_ROW_V2.get(row);
  if (stored === undefined) {
    const text = row.filter((cell) => !cell.continuation).map((cell) => cell.grapheme).join("");
    const encoded = encodeRow(text, row);
    stored = [encoded.text, encoded.cells];
    FRAME_ROW_V2.set(row, stored);
  }
  return stored;
};
function encodeFrameCells(cells) {
  return JSON.stringify({ fc: 2, rows: cells.map(encodeFrameRow) });
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
  for (const block of prepared(disk, "SELECT first_line_id,line_count,data FROM na_block WHERE pane_no=? AND first_line_id<? AND first_line_id>? ORDER BY first_line_id").all(paneNo, end, start - BLOCK_MAX)) {
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
var DISK_PAGE_SIZE = 2048;
var WAL_LIMIT = 16 * 1024;
var CHECKPOINT_COMMITS = 5;
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
function captureReceipt(disk, paneNo, captureId) {
  const live = prepared(disk, "SELECT * FROM na_capture WHERE pane_no=? AND capture_id=?").get(paneNo, captureId);
  if (live)
    return live;
  for (const block of prepared(disk, "SELECT catalog,data,capture_count FROM na_capture_archive WHERE pane_no=? ORDER BY archive_no DESC").all(paneNo)) {
    const catalog = decodeCaptureArchive(block.catalog);
    if (catalog.length !== Number(block.capture_count))
      throw new Error("capture-archive-corrupt");
    const ordinal = catalog.findIndex((item) => Array.isArray(item) && item[0] === captureId);
    if (ordinal < 0)
      continue;
    const data = decodeCaptureReceipts(block.data);
    if (data.length !== catalog.length)
      throw new Error("capture-archive-corrupt");
    const row = captureRow(paneNo, data[ordinal]);
    if (row.capture_id !== captureId || row.revision !== catalog[ordinal][1] || row.source_epoch !== catalog[ordinal][2] || row.geometry_generation !== catalog[ordinal][3])
      throw new Error("capture-archive-catalog");
    return row;
  }
  throw new Error("capture-receipt-missing");
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
function sealBlocks(disk, panes, force) {
  let attempts = sealAttempts.get(disk);
  if (!attempts) {
    attempts = new Map;
    sealAttempts.set(disk, attempts);
  }
  const now = performance.now();
  for (const p of panes) {
    const next = Number(p.next_line_id);
    if (!force && now - (attempts.get(p.pane_no) ?? -Infinity) < SEAL_RETRY_MS)
      continue;
    attempts.set(p.pane_no, now);
    const groups = prepared(disk, `SELECT line_id/${SEAL_LINES} AS b,count(*) AS n,
      sum(check_state=0 AND check_reason<>1 AND line_id>=?) AS open FROM na_line WHERE pane_no=? GROUP BY b`).all(next - SEAL_UNCHECKED_LAG, p.pane_no);
    for (const g of groups) {
      const from = Number(g.b) * SEAL_LINES;
      if (Number(g.n) !== SEAL_LINES || from + SEAL_LINES > next || Number(g.open) !== 0 && from + SEAL_LINES > next - SEAL_LAG)
        continue;
      const rows = prepared(disk, "SELECT * FROM na_line WHERE pane_no=? AND line_id>=? AND line_id<? ORDER BY line_id").all(p.pane_no, from, from + SEAL_LINES);
      prepared(disk, "INSERT INTO na_block (pane_no,first_line_id,line_count,max_revision,data) VALUES (?,?,?,?,?)").run(p.pane_no, from, SEAL_LINES, Math.max(...rows.map((r) => Number(r.revision))), encodeBlock(rows.map(blockLine)));
      prepared(disk, "DELETE FROM na_line WHERE pane_no=? AND line_id>=? AND line_id<?").run(p.pane_no, from, from + SEAL_LINES);
    }
  }
}
function archiveCaptures(disk, panes, force) {
  for (const pane of panes)
    for (;; ) {
      const rows = prepared(disk, `SELECT c.* FROM na_capture c WHERE c.pane_no=?
      AND NOT EXISTS(SELECT 1 FROM na_line l WHERE l.pane_no=c.pane_no AND l.checked_capture_id=c.capture_id)
      AND c.capture_id NOT IN(SELECT recent.capture_id FROM na_capture recent WHERE recent.pane_no=c.pane_no ORDER BY recent.revision DESC,recent.capture_id DESC LIMIT 8)
      ORDER BY c.revision,c.capture_id LIMIT 256`).all(pane.pane_no);
      if (!rows.length || !force && rows.length < 128)
        break;
      const catalog = rows.map((row) => [row.capture_id, row.revision, row.source_epoch, row.geometry_generation]);
      prepared(disk, "INSERT INTO na_capture_archive (pane_no,first_revision,last_revision,capture_count,catalog,data) VALUES (?,?,?,?,?,?)").run(pane.pane_no, rows[0].revision, rows.at(-1).revision, rows.length, encodeCaptureArchive(catalog), encodeCaptureReceipts(rows.map(captureValues)));
      const remove = prepared(disk, "DELETE FROM na_capture WHERE pane_no=? AND capture_id=?");
      for (const row of rows)
        remove.run(pane.pane_no, row.capture_id);
      if (rows.length < 256)
        break;
    }
}
function commitBatch(disk, fence, batch, before, checkpoint = false, forceSeal = false) {
  const started = performance.now();
  let writeMs = 0;
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
    sealBlocks(disk, batch.panes, forceSeal);
    archiveCaptures(disk, batch.panes, forceSeal);
    before?.();
    writeMs = performance.now() - started;
  }).immediate();
  if (checkpoint)
    disk.exec("PRAGMA wal_checkpoint(PASSIVE)");
  const totalMs = performance.now() - started;
  return { totalMs, writeMs, commitMs: totalMs - writeMs };
}
if (!isMainThread && workerData?.projectionDiskWriter === true) {
  const signal = new Int32Array(workerData.signal);
  const errors = new Uint8Array(workerData.signal, 8);
  const disk = new Database3(workerData.file, { strict: true });
  disk.exec(`PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL; PRAGMA busy_timeout=250; PRAGMA cache_size=-8192; PRAGMA journal_size_limit=${WAL_LIMIT};`);
  let commits = 0;
  const onMessage = (batch) => {
    if (batch === "close") {
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
      const timing = commitBatch(disk, workerData.fence, batch, undefined, ++commits % CHECKPOINT_COMMITS === 0);
      Atomics.store(signal, 2, Math.round(timing.totalMs * 1000));
      Atomics.store(signal, 3, Math.round(timing.writeMs * 1000));
      Atomics.store(signal, 0, 1);
    } catch (error) {
      const bytes = new TextEncoder().encode(String(error)).subarray(0, errors.length);
      errors.set(bytes);
      Atomics.store(signal, 1, bytes.length);
      Atomics.store(signal, 0, 2);
    }
    Atomics.notify(signal, 0);
    parentPort.postMessage(batch.id);
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
  signal = new Int32Array(new SharedArrayBuffer(4104));
  inFlight = false;
  diskTiming = { totalMs: 0, writeMs: 0, commitMs: 0 };
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
        for (const id of new Set(lines.map((l) => l.checked_capture_id).filter((id2) => id2 !== null)))
          upsert(this.ram.db, "na_capture", captureReceipt(this.disk, Number(row.pane_no), String(id)));
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
      const receipt = this.ram.db.transaction(() => {
        this.ram.screen(frame, null, null, [], encoded);
        return this.ram.bump(frame.paneKey);
      })();
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
          for (const row of readDiskLines(this.disk, no, Math.min(...missing), Math.max(...missing) + 1)) {
            if (!wanted.has(Number(row.line_id)))
              continue;
            if (row.checked_capture_id !== null) {
              upsert(this.ram.db, "na_capture", captureReceipt(this.disk, no, String(row.checked_capture_id)));
            }
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
    this.diskTiming = { totalMs, writeMs, commitMs: totalMs - writeMs };
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
      this.disk.transaction(() => {
        const panes = prepared(this.disk, "SELECT * FROM na_pane").all();
        sealBlocks(this.disk, panes, true);
        archiveCaptures(this.disk, panes, true);
      }).immediate();
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
    this.outputTail = this.outputTail.then(() => this.onStdout(chunk)).catch((error) => {
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
  async onStdout(chunk) {
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
        try {
          const receipt = kind === "U" ? this.options.onUpdate(message) : this.options.onHistoryClear?.(message);
          if (receipt && typeof receipt.then === "function")
            await receipt;
          if (this.abandoned)
            return;
        } catch (error) {
          this.notifyFault({ kind: "worker-error", at: (this.options.now ?? Date.now)(), message: `consumer failed: ${String(error)}` });
        }
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
    return this.write([header("D", 16 + bytes.byteLength), prefix, Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)], false);
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
      if (isCapacityPressure(error))
        return { receipt: this.retryPressure(send, dropped), pressured: true };
      if (isOversize(error))
        return { receipt: dropped(), pressured: false };
      throw error;
    }
    if (isReceipt(answer)) {
      const pressured = refusedNow(answer);
      const receipt = Promise.resolve(answer).then((value) => {
        if (isCapacityPressure(value))
          return this.retryPressure(send, dropped);
        if (isOversize(value))
          return dropped();
        if (isRefusal(value))
          throw new Error(`consumer refused: ${JSON.stringify(value)}`);
      }, (error) => {
        if (isCapacityPressure(error))
          return this.retryPressure(send, dropped);
        if (isOversize(error))
          return dropped();
        throw error;
      });
      return { receipt, pressured };
    }
    if (isCapacityPressure(answer))
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
        if (isCapacityPressure(error))
          continue;
        if (isOversize(error))
          return dropped();
        throw error;
      }
      if (isCapacityPressure(value))
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

// src/tmux-capture-normalize.ts
import { charCellWidth, stringCells } from "../core/index.js";
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

class TmuxCaptureDecoder {
  cols;
  maxEntries;
  minEntries;
  cache = new Map;
  generation = 0;
  hits = 0;
  misses = 0;
  uncertainRows = [];
  constructor(cols, maxEntries = 9000, minEntries = 1) {
    this.cols = cols;
    this.maxEntries = maxEntries;
    this.minEntries = minEntries;
    checkedCols(cols);
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1)
      throw new Error("invalid decoder cache size");
    if (!Number.isSafeInteger(minEntries) || minEntries < 1)
      throw new Error("invalid decoder cache size");
  }
  get size() {
    return this.cache.size;
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
      return screen.rows;
    }
    const state = { fg: "default", bg: "default", style: 0 };
    const rows = [];
    for (const line of lines) {
      if (AMBIGUOUS_EMOJI.test(line)) {
        this.uncertainRows.push(rows.length);
        rows.push(decodeUncertainLine(normalizeTmuxCaptureCells(line), this.cols, state));
        continue;
      }
      const key = `${state.fg}\x00${state.bg}\x00${state.style}\x00${line}`;
      let entry = this.cache.get(key);
      if (entry) {
        this.hits++;
        entry.used = this.generation;
      } else {
        this.misses++;
        const cells = decodeLine(normalizeTmuxCaptureCells(line), this.cols, state).map(internCell);
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

// src/pipe-history-runtime.ts
init_schema();
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
function parserRowCells(row, cols) {
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
  const cells = new Array(cols);
  for (let x = 0;x < cols; x++) {
    const cell = row[x];
    cells[x] = cell ? canonicalCell(cell) : BLANK_CELL;
  }
  if (Object.isFrozen(row) || Array.isArray(row))
    canonicalRows.set(row, cells);
  return cells;
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
var blankRow = (cols) => new Array(cols).fill(BLANK_CELL);
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
  ingest(bytes) {
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
    return this.collector.ingest(bytes, at);
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
    this.ring.push(row);
    const limit = this.runtime.options.ringRows ?? RING_ROWS;
    if (this.ring.length > limit + 512)
      this.ring = this.ring.slice(this.ring.length - limit);
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
    }, (error) => {
      this.onRuntimeFault("frame-write-failed", String(error?.message ?? error), null);
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
    if (this.receiveHead > 4096 && this.receiveHead * 2 > this.receiveTimes.length) {
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
    let copy = null;
    return {
      revision: token?.revision ?? 0,
      sourceEpoch: token?.sourceEpoch ?? this.collector.currentSourceEpoch(),
      geometryGeneration: token?.geometryGeneration ?? this.collector.currentGeometryGeneration(),
      recentLastLineId: length ? ring[length - 1].lineId : null,
      get recentHistory() {
        return copy ??= ring.slice(0, length);
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
      this.decoder = new TmuxCaptureDecoder(cols);
    const decoded = this.decoder.decode(raw.body);
    const uncertain = this.decoder.uncertainRows;
    const rows = decoded.map((row) => canonicalCaptureCells(row, cols));
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
      for (const m of [...checks, ...contentMatches, ...input.repairs])
        this.certified.add(m.lineId);
      if (this.certified.size > 20000) {
        const floor = this.ring[0]?.lineId ?? 0;
        for (const id of this.certified)
          if (id < floor)
            this.certified.delete(id);
      }
      if (input.repairs.length) {
        const byId = new Map(input.repairs.map((r) => [r.lineId, r.row.cells]));
        for (const row of this.ring) {
          const cells = byId.get(row.lineId);
          if (cells) {
            row.cells = cells;
            row.ansi = undefined;
          }
        }
        this.ringRepairs++;
      }
      return receipt;
    } catch (error) {
      if (String(error?.message ?? error).includes("stale-revision")) {
        this.stats.captureConflicts++;
        return null;
      }
      throw error;
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
      } catch (error) {
        console.error("[pipe-history-runtime] listener failed:", error);
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
      this.decoder = new TmuxCaptureDecoder(cols);
    const rows = this.decoder.decode(raw.body).map((row) => canonicalCaptureCells(row, cols));
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
      } catch (error) {
        if (!String(error?.message).includes("page-retry"))
          throw error;
      }
    }
    return null;
  }
  async drainReceipt(timeoutMs = 5000) {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    const issues = [];
    const settled = () => {
      const stats2 = this.collector.stats();
      return stats2.ackedSeq >= stats2.receiveSeq && stats2.inflightBytes === 0 && !this.frameWriting && !this.pendingFrame;
    };
    while (!settled() && Date.now() < deadline && !this.closed) {
      if (this.pendingFrame && !this.frameWriting && !this.frameTimer)
        this.writeFrame();
      await new Promise((resolve3) => setTimeout(resolve3, 5));
    }
    const stats = this.collector.stats();
    if (!settled())
      issues.push(`consumer not settled within ${timeoutMs}ms: acked ${stats.ackedSeq} of ${stats.receiveSeq}, ${stats.inflightBytes} inflight bytes${this.pendingFrame || this.frameWriting ? ", newest screen not written" : ""}`);
    const token = this.tokenOrNull();
    let durableRevision = null;
    if (token) {
      const left = Math.max(0, deadline - Date.now());
      let timer = null;
      try {
        const receipt = await Promise.race([
          this.runtime.store.durable(this.paneKey, token.revision),
          new Promise((resolve3) => {
            timer = setTimeout(() => resolve3(null), left);
          })
        ]);
        if (receipt)
          durableRevision = receipt.durableRevision;
        else
          issues.push(`store durable barrier at revision ${token.revision} did not settle within ${timeoutMs}ms`);
      } catch (error) {
        issues.push(`store durable barrier failed: ${String(error?.message ?? error)}`);
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
      await new Promise((resolve3) => setTimeout(resolve3, 5));
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
    } catch (error) {
      this.panesByKey.delete(id);
      await pane.close().catch(() => {});
      throw error;
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
    } catch (error) {
      console.error("[pipe-history-runtime] fault sink failed:", error);
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
      for (let i = from;i < rows.length; i++) {
        const row = rows[i];
        parts.push(row.ansi ??= cellsToAnsi(row.cells));
      }
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
var pipeVtAssets2 = pipeVtAssets;
var verifyPipeVtAssets2 = verifyPipeVtAssets;
export {
  verifyPipeVtAssets2 as verifyPipeVtAssets,
  trimStatsRing,
  toPhysicalRow,
  screenOverlap,
  rowText,
  resizePullback,
  pooledPercentile,
  pipeVtAssets2 as pipeVtAssets,
  parserStyle,
  parserRowCells,
  keyOf,
  createProjectionStore2 as createProjectionStore,
  createPipeHistoryRuntime,
  cellsToAnsi,
  canonicalParserColor,
  canonicalCaptureColor,
  canonicalCaptureCells,
  applyFrameDelta,
  XTERM_256,
  ProjectionLiveWindow,
  PipeHistoryRuntime,
  PipeHistoryPane,
  PIPE_HISTORY_RUNTIME_CAPABILITY,
  OBSERVED_STYLE_MASK,
  FrameBudget,
  FRAME_WRITE_MS,
  FRAME_PRESSURE_RETRY_MS,
  FRAME_BUDGET_SHARE,
  BLANK_CELL
};
