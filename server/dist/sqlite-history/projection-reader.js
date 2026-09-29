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
export {
  readProjectionPage,
  readProjectionIssues,
  readDiskLines,
  projectionLine,
  projectionIssue,
  openProjectionArchive,
  lowestLine,
  LegacyUnderlay,
  BLOCK_COLUMNS
};
