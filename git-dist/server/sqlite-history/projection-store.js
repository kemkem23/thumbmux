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
export {
  createProjectionStore,
  ProjectionStore,
  PROJECTION_MIGRATION
};
