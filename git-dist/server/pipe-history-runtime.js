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
    scheduleDrain();
  };
  const scheduleDrain = () => {
    const due = [archiveNextDue(disk), quietNextDue(disk)].filter((t) => t !== null), next = due.length ? Math.min(...due) : null;
    if (!drainTimer && next !== null)
      drainTimer = setTimeout(drain, Math.max(ARCHIVE_IDLE_MS, next - archiveClock()));
  };
  const onMessage = (batch) => {
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

// src/pipe-history-runtime.ts
init_schema();

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
function streamCanonical(value) {
  if (value === null || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "string") {
    if (!value.isWellFormed())
      throw Error("invalid Unicode");
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw Error("nonfinite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value))
    return "[" + value.map(streamCanonical).join(",") + "]";
  if (typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype)
    throw Error("non-JSON value");
  const object = value;
  return "{" + Object.keys(object).sort().map((k) => JSON.stringify(k) + ":" + streamCanonical(object[k])).join(",") + "}";
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

// src/capture-engine.ts
var ok = (value) => ({ status: "ok", value });
var busy = () => ({ status: "busy", reason: "pressure", retryAfterMs: 10 });
var error = (code, message) => ({ status: "error", code, message });
var counter = (n) => Number.isSafeInteger(n) && n >= 0;
var paneKey = (p) => JSON.stringify([p.serverIdentity, p.paneId, p.birthGeneration]);
var samePane2 = (a, b) => paneKey(a) === paneKey(b);
var sameIdentity = (a, b) => samePane2(a.pane, b.pane) && a.sourceEpoch === b.sourceEpoch && a.geometryGeneration === b.geometryGeneration;
var size = (value) => Buffer.byteLength(JSON.stringify(value));
function immutable(value) {
  const copy = structuredClone(value);
  function freeze(v) {
    if (v && typeof v === "object") {
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
  if (!counter(before) || before !== after || !sameIdentity(a.identity, b.identity) || a.geometry.columns !== b.geometry.columns || a.geometry.rows !== b.geometry.rows || [...a.changedRows, ...b.changedRows].some((r) => r.content.uncertainFields.length))
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
    if (!sameIdentity(ports.identity, ports.initial.identity) || !counter(ports.initial.head) || !counter(ports.initial.revision) || !counter(ports.initial.durableRevision) || ports.initial.durableRevision > ports.initial.revision)
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
    return samePane2(this.identity.pane, pane);
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
    if (!samePane2(event.identity.pane, this.identity.pane))
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
        return ok({ consumed: count, receipt: result.value });
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
        return ok(receipt2);
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
      if (preflight && (!sameIdentity(preflight.frame.identity, event.identity) || preflight.scrolls.some((row) => row.uncertainFields.length)))
        return error("integrity", "VT preflight");
      const receipt = await this.ports.history.journalInput(event);
      if (receipt.status !== "ok")
        return receipt;
      if (!samePane2(receipt.value.pane, event.identity.pane) || receipt.value.through.packetSeq !== event.position.packetSeq || receipt.value.through.sourceEpoch !== event.position.sourceEpoch || receipt.value.digest !== event.digest) {
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
      return ok(this.lastInput);
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
      return ok(undefined);
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
      const prepared2 = candidate ? ok(candidate) : await this.ports.vt.prepare(p.event);
      if (prepared2.status !== "ok")
        return prepared2;
      tx = prepared2.value;
      const prepareGap = this.activeGap();
      if (prepareGap)
        return error("unresolved-gap", prepareGap.episodeId);
      if (!sameIdentity(tx.frame.identity, p.event.identity) || tx.scrolls.some((row) => row.uncertainFields.length))
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
        if (!samePane2(durable.value.pane, this.identity.pane) || durable.value.durableRevision !== receipt.value.revision || durable.value.checkpointId !== checkpoint.checkpointId)
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
      return ok(undefined);
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
      if (!tx?.snapshot || !sameIdentity(tx.frame.identity, p.event.identity))
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
      if (!samePane2(result.value.pane, this.identity.pane) || result.value.durableRevision !== revision || result.value.checkpointId !== checkpoint.checkpointId)
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
      return ok(undefined);
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
      if (!samePane2(result.value.pane, pane) || result.value.durableRevision !== this.frame.revision || result.value.checkpointId !== checkpoint.checkpointId)
        return error("integrity", "checkpoint receipt fence");
      this.lastCheckpoint = checkpoint;
      this.durable = immutable(result.value);
      this.tail.durable(result.value.durableRevision);
      this.checkpointAt = this.ports.now();
      this.checkpointHead = this.frame.head;
      this.publish({ ...this.frame, durableRevision: result.value.durableRevision });
      return ok(checkpoint);
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
    if (!sameIdentity(checkpoint.identity, this.identity))
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
      if (!sameIdentity(tx.frame.identity, checkpoint.identity) || tx.scrolls.length) {
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
      return ok(this.frame);
    } catch (cause) {
      this.fault("reader-error");
      return error("io", String(cause));
    } finally {
      this.restoring = false;
    }
  }
  async checkVisible(identity) {
    if (!sameIdentity(identity, this.identity))
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
      return ok({ verdict });
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
    if (!this.episode || episode.episodeId !== this.episode.episodeId || !samePane2(episode.pane, this.identity.pane)) {
      yield error("unresolved-gap", "episode not active");
      return;
    }
    if (this.episode.reason === "late-gap") {
      yield { status: "stale", reason: "late-gap" };
      return;
    }
    this.locked = true;
    const controller = new AbortController;
    const deadline = episode.firstObservedAtMonoMs + STREAM_BUDGET.recoveryMs;
    const timer = setTimeout(() => controller.abort(), Math.max(0, deadline - this.ports.now()));
    const polling = setInterval(() => {
      if (cancel.isCancelled())
        controller.abort();
    }, 10);
    const scope = new CaptureTaskScope(controller.signal, this.ports.cancelOperation ? () => this.ports.cancelOperation(controller.signal) : undefined);
    const leases = [];
    let iterator = null;
    let committed = null;
    try {
      if (cancel.isCancelled() || this.ports.now() >= deadline)
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
        if (controller.signal.aborted || this.ports.now() > deadline) {
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
            if (ids.length !== chunk.rows.length || !ids.every((id, i) => samePane2(id.pane, this.identity.pane) && id.lineId === chunk.rows[i].id.lineId) || receipt.value.committedRevision !== chunk.expectedRevision + 1 || receipt.value.durable.durableRevision !== receipt.value.committedRevision) {
              yield error("integrity", "repair receipt fence");
              return;
            }
            committed = receipt;
            try {
              const synced = await scope.wait(this.ports.syncRepair(chunk, receipt.value, controller.signal));
              if (!sameIdentity(synced.identity, this.identity) || synced.revision !== receipt.value.committedRevision || synced.durableRevision !== receipt.value.durable.durableRevision || synced.head < this.frame.head)
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
              if (controller.signal.aborted || this.ports.now() > deadline) {
                yield receipt;
                yield error("deadline", "repair exceeded 10000ms");
                return;
              }
              if (!samePane2(cp.identity.pane, this.identity.pane) || cp.head !== this.frame.head || cp.revision !== this.frame.revision || cp.stateDigest !== this.digest("vt-state", { identity: cp.identity, state: cp.state }) || !samePane2(cp.inputFence.pane, this.identity.pane) || cp.inputFence.through.sourceEpoch !== cp.identity.sourceEpoch || this.pending && cp.identity.sourceEpoch === this.pending.event.identity.sourceEpoch && cp.inputFence.through.packetSeq < this.pending.event.position.packetSeq) {
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
              if (restored.value.scrolls.length || !sameIdentity(restored.value.frame.identity, cp.identity)) {
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
              receipt = ok({ ...receipt.value, durable: closed.value, complete: true });
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
    return this.ports.now() > deadlineMonoMs ? error("deadline", "drain deadline") : ok(this.durable);
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

// src/history-engine.ts
import { Database as Database4 } from "bun:sqlite";
import { randomUUID as randomUUID3 } from "node:crypto";
import { resolve as resolve3 } from "node:path";
function frozen(value) {
  if (value && typeof value === "object") {
    for (const item of Object.values(value))
      frozen(item);
    Object.freeze(value);
  }
  return value;
}
function copy(value) {
  return frozen(JSON.parse(streamCanonical(value)));
}
function bytes(value) {
  return Buffer.byteLength(streamCanonical(value));
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
  return streamCanonical(p);
}
function identity(i) {
  paneKey2(i.pane);
  safe2(i.sourceEpoch);
  safe2(i.geometryGeneration);
}
function equal(a, b) {
  return streamCanonical(a) === streamCanonical(b);
}
function digest(kind, r) {
  const { digest: d, ...payload } = r;
  if (!/^[a-f0-9]{64}$/.test(d) || streamDigest(kind, payload) !== d)
    throw Error("digest mismatch");
}
function geometry(g) {
  safe2(g.columns);
  safe2(g.rows);
  if (!g.columns || !g.rows || g.columns > STREAM_BUDGET.maxColumns || g.rows > STREAM_BUDGET.maxRows)
    throw Error("geometry outside admitted envelope");
}
function content(row) {
  if (!Array.isArray(row.cells) || typeof row.softWrap !== "boolean")
    throw Error("invalid row");
  safe2(row.wrapPad);
  if (!Array.isArray(row.uncertainFields) || row.uncertainFields.some((x) => typeof x !== "string"))
    throw Error("invalid uncertain fields");
  for (const c of row.cells) {
    if (typeof c.text !== "string" || !c.text.isWellFormed() || ![0, 1, 2].includes(c.width) || !Array.isArray(c.style))
      throw Error("invalid cell");
    c.style.forEach(safe2);
    if (bytes(c) > STREAM_BUDGET.blockPayloadBytes / 2)
      throw Error("single cell exceeds block");
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
var ok2 = (value) => ({ status: "ok", value: copy(value) });
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
    this.db.query("INSERT OR REPLACE INTO sh_pane VALUES(?,?,?,?,?,?,?)").run(paneKey2(s.identity.pane), streamCanonical(s.identity), s.revision, s.durable, s.head, s.checkpoint, s.gap ? streamCanonical(s.gap) : null);
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
        return ok2(JSON.parse(String(old.receipt)));
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
          this.db.query("INSERT INTO sh_input VALUES(?,?,?,?,?,?)").run(key, sourceEpoch, packetSeq, event.digest, streamCanonical(event), streamCanonical(receipt));
          const diskState = this.state(event.identity.pane, this.db, false);
          this.putState(diskState ? { ...diskState, identity: event.identity } : { identity: event.identity, revision: 0, durable: 0, head: 0, checkpoint: null, gap: null });
        });
      } finally {
        pool.pending -= n * 4;
      }
      return ok2(receipt);
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
        return ok2(prior.receipt);
      }
      const durable = this.db.query("SELECT digest,receipt FROM sh_event WHERE pane=? AND event=?").get(key, ek);
      if (durable) {
        if (durable.digest !== request.digest)
          throw Error("event identity collision");
        return ok2(JSON.parse(String(durable.receipt)));
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
          this.db.query("INSERT INTO sh_event VALUES(?,?,?,?)").run(key, ek, owned.digest, streamCanonical(receipt));
          this.putState({ ...state, revision, head: receipt.head });
        }).immediate();
        return ok2(receipt);
      }
      const pending = this.pending.get(key) ?? { state: { ...state }, events: new Map, charge: 0 };
      pending.state = { ...state, revision, head: receipt.head };
      pending.events.set(ek, { request: owned, receipt });
      pending.charge += charge;
      this.pending.set(key, pending);
      pool.pending += charge;
      this.ownPending += charge;
      return ok2(receipt);
    } catch (e) {
      return fail(e);
    }
  }
  writeRows(rows) {
    for (const row of rows) {
      const key = paneKey2(row.id.pane), { cells, ...meta } = row;
      this.db.query("INSERT INTO sh_row VALUES(?,?,?,?,?,?)").run(key, row.id.lineId, row.revision, cells.length, streamCanonical(meta), streamDigest("row", row));
      let start = 0;
      while (start < cells.length || start === 0 && !cells.length) {
        let end = start, size2 = 2;
        while (end < cells.length && size2 + bytes(cells[end]) + 1 <= STREAM_BUDGET.blockPayloadBytes) {
          size2 += bytes(cells[end]) + 1;
          end++;
        }
        if (end === start && cells.length)
          throw Error("cell cannot fit block");
        const payload = streamCanonical(cells.slice(start, end));
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
        this.db.query("INSERT INTO sh_fragment VALUES(?,?,?,?,?,?,?)").run(key, row.id.lineId, start, end, payload, checksum, streamCanonical(checkpoint));
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
      this.db.query("INSERT INTO sh_event VALUES(?,?,?,?)").run(key, event, value.request.digest, streamCanonical(value.receipt));
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
        return ok2(JSON.parse(String(prior.receipt)));
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
        this.db.query("INSERT INTO sh_checkpoint VALUES(?,?,?,?,?)").run(key, cp.checkpointId, streamCanonical(cp), cp.revision, streamDigest("vt-checkpoint", cp));
        this.db.query("INSERT INTO sh_commit VALUES(?,?,?,?,?)").run(key, request.commitId, request.digest, streamCanonical(receipt), receipt.durableRevision);
        this.putState({ ...state, durable: state.revision, checkpoint: cp.checkpointId, gap: null });
      });
      this.dropPending(key);
      return ok2(receipt);
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
        return ok2({ discardedRows: 0 });
      const state = this.state(pane, this.db, false);
      if (!state || state.revision === state.durable)
        return ok2({ discardedRows: 0 });
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
      return ok2({ discardedRows });
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
        return state.gap.episodeId === episode.episodeId && state.gap.epochBefore === episode.epochBefore && state.gap.lastAdmittedRow === episode.lastAdmittedRow ? ok2(null) : stale("late-gap");
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
      return ok2(null);
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
        return ok2(JSON.parse(String(old.receipt)));
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
          this.db.query("INSERT INTO sh_repair VALUES(?,?,?,?,?)").run(key, chunk.episode.episodeId, chunk.chunkId, chunk.digest, streamCanonical(receipt));
          this.db.query("INSERT INTO sh_commit VALUES(?,?,?,?,?)").run(key, durable.commitId, durable.digest, streamCanonical(durable), durable.durableRevision);
          this.putState({ ...state, revision, durable: revision, head: state.head + chunk.rows.length, gap: state.gap });
        });
      } finally {
        pool.pending -= n;
      }
      return ok2(receipt);
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
      return ok2(view);
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
      return ok2(pin.ack);
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
      return ok2({
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
    let expired = false, cancelled = false;
    try {
      this.live();
      paneKey2(pane);
      db = this.reader(pane);
      if (!db) {
        yield { status: "busy", reason: "queue", retryAfterMs: 20 };
        return;
      }
      const reader = db;
      const deadline = performance.now() + STREAM_BUDGET.recoveryMs;
      timer = setInterval(() => {
        cancelled = cancel.isCancelled();
        expired = performance.now() >= deadline;
        if (cancelled || expired || this.closed) {
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
        if (cancelled || cancel.isCancelled()) {
          yield { status: "cancelled", reason: "recovery cancelled" };
          return;
        }
        yield ok2({ kind: "checkpoint", checkpoint: cp });
      }
      while (head < state.head) {
        if (expired) {
          yield { status: "error", code: "deadline", message: "recovery deadline" };
          return;
        }
        if (cancelled || cancel.isCancelled()) {
          yield { status: "cancelled", reason: "recovery cancelled" };
          return;
        }
        const row = this.readRow(reader, pane, head++);
        const receiptRow = reader.query("SELECT receipt FROM sh_commit WHERE pane=? AND revision>=? ORDER BY revision LIMIT 1").get(key, row.revision);
        if (!receiptRow)
          throw Error("row without durable receipt");
        yield ok2({ kind: "rows", rows: [row], receipt: JSON.parse(String(receiptRow.receipt)) });
      }
      while (true) {
        if (expired) {
          yield { status: "error", code: "deadline", message: "recovery deadline" };
          return;
        }
        if (cancelled || cancel.isCancelled()) {
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
        yield ok2({ kind: "input", event });
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

// src/display-engine.ts
var ok3 = (value) => ({ status: "ok", value });
var staleRoute = () => ({ status: "stale", reason: "route" });
var cancelled = () => ({ status: "cancelled", reason: "cancelled" });
var deadline = () => ({ status: "error", code: "deadline", message: "display page deadline exceeded" });
function samePane3(a, b) {
  return a.serverIdentity === b.serverIdentity && a.paneId === b.paneId && a.birthGeneration === b.birthGeneration;
}
function sameIdentity2(a, b) {
  return samePane3(a.pane, b.pane) && a.sourceEpoch === b.sourceEpoch && a.geometryGeneration === b.geometryGeneration;
}
function sameRoute(a, b) {
  return a.viewerId === b.viewerId && a.routeGeneration === b.routeGeneration && sameIdentity2(a.identity, b.identity);
}
function validCounter(value) {
  return Number.isSafeInteger(value) && value >= 0;
}
function cloneIdentity(identity2) {
  return {
    pane: {
      serverIdentity: identity2.pane.serverIdentity,
      paneId: identity2.pane.paneId,
      birthGeneration: identity2.pane.birthGeneration
    },
    sourceEpoch: identity2.sourceEpoch,
    geometryGeneration: identity2.geometryGeneration
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
    overlayHandle: view.overlayHandle
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
    hasMoreAfter: page.hasMoreAfter
  });
}
function encodedBytes(value) {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

class StreamDisplayEngine {
  capture;
  retryUntilDeadline;
  history;
  observer;
  now;
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
    return await new Promise((resolve4) => {
      const attachment = {
        route: deepFreeze({ ...route, identity: cloneIdentity(route.identity) }),
        onFrame,
        unsubscribe: () => {},
        settleInitial: resolve4
      };
      this.attachments.set(route.viewerId, attachment);
      attachment.unsubscribe = this.capture.subscribe(route.identity.pane, (frame) => {
        if (this.attachments.get(route.viewerId) !== attachment || !sameIdentity2(frame.identity, route.identity))
          return;
        const frozen2 = immutableFrame(frame);
        const settle2 = attachment.settleInitial;
        attachment.settleInitial = null;
        if (settle2)
          settle2(ok3(frozen2));
        try {
          attachment.onFrame(frozen2);
        } catch (error2) {
          this.observer?.record({
            kind: "lifecycle",
            identity: route.identity,
            atMonoMs: this.now(),
            reason: "display-listener-error",
            errorStack: error2 instanceof Error ? error2.stack ?? error2.message : String(error2)
          });
        }
      });
    });
  }
  async page(route, request, cursor, limit, cancel) {
    if (!this.routeIsCurrent(route) || !sameIdentity2(route.identity, request.identity) || route.routeGeneration !== request.routeGeneration)
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
      if (!sameIdentity2(view.identity, route.identity) || view.routeGeneration !== route.routeGeneration || view.requestId !== request.requestId) {
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
      const frozen2 = immutablePage(read.value);
      const charge = Math.max(frozen2.payloadBytes, encodedBytes(frozen2.fragments));
      if (charge > STREAM_BUDGET.pageBytesPerViewer) {
        releaseReason = "page-byte-cap";
        const failure = { status: "error", code: "unsupported", message: "history page exceeds the display byte cap" };
        this.recordRequest(request, "error", this.now());
        return failure;
      }
      this.rememberPage(route.viewerId, this.pageKey(opened.value, cursor, limit), frozen2, charge);
      this.recordRequest(request, "ok", this.now());
      return ok3(frozen2);
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
  reserveEncodedBytes(viewerId, bytes2) {
    if (!viewerId || !validCounter(bytes2) || bytes2 > STREAM_BUDGET.wsPendingBytes || this.wsPendingBytes + bytes2 > STREAM_BUDGET.wsPendingBytes)
      return null;
    if (bytes2 === 0)
      return () => {};
    this.wsPendingBytes += bytes2;
    this.wsBytes.set(viewerId, (this.wsBytes.get(viewerId) ?? 0) + bytes2);
    const epoch = this.wsEpoch.get(viewerId) ?? {};
    this.wsEpoch.set(viewerId, epoch);
    let released = false;
    return () => {
      if (released)
        return;
      released = true;
      if (this.wsEpoch.get(viewerId) !== epoch)
        return;
      this.wsPendingBytes -= bytes2;
      const remaining = (this.wsBytes.get(viewerId) ?? 0) - bytes2;
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
        const delayed = await this.waitFor(new Promise((resolve4) => setTimeout(resolve4, pause)), deadlineMonoMs, cancel, route);
        if (delayed.kind === "failure")
          return delayed.failure;
        if (delayed.kind === "throw")
          return { status: "error", code: "io", message: "display retry wait failed" };
      }
    }
    return { status: "busy", retryAfterMs: 0, reason: "queue" };
  }
  async waitFor(promise, deadlineMonoMs, cancel, route) {
    return await new Promise((resolve4) => {
      let finished = false;
      const finish = (result) => {
        if (finished)
          return;
        finished = true;
        clearTimeout(deadlineTimer);
        clearInterval(cancelTimer);
        resolve4(result);
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
    return a.requestId === b.requestId && a.routeGeneration === b.routeGeneration && sameIdentity2(a.identity, b.identity) && a.grantRevision === b.grantRevision && a.durableAtGrant === b.durableAtGrant && a.headAtGrant === b.headAtGrant && a.range.start === b.range.start && a.range.end === b.range.end && a.overlayHandle === b.overlayHandle;
  }
  validPage(page, view) {
    if (!validCounter(page.payloadBytes) || page.fragments.length > STREAM_BUDGET.decodeRows)
      return false;
    for (const fragment of page.fragments) {
      const row = fragment.row;
      if (!samePane3(row.id.pane, view.identity.pane) || !samePane3(row.source.pane, view.identity.pane) || !validCounter(row.id.lineId) || row.id.lineId < view.range.start || row.id.lineId >= view.range.end || !validCounter(row.revision) || row.revision > view.grantRevision || !validCounter(fragment.startCell) || !validCounter(fragment.endCell) || fragment.startCell > fragment.endCell || fragment.endCell - fragment.startCell !== row.cells.length)
        return false;
    }
    for (const cursor of [page.nextBefore, page.nextAfter]) {
      if (cursor && (cursor.requestId !== view.requestId || !validCounter(cursor.lineId) || !validCounter(cursor.cellOffset)))
        return false;
    }
    return true;
  }
  pageKey(ack, cursor, limit) {
    return JSON.stringify([ack.view.requestId, ack.view.grantRevision, ack.diskSnapshotRevision, cursor, limit]);
  }
  rememberPage(viewerId, key, page, bytes2) {
    const entries = this.pages.get(viewerId) ?? [];
    const old = entries.find((entry) => entry.key === key);
    if (old) {
      old.usedAt = this.now();
      return;
    }
    entries.push({ key, page, bytes: bytes2, usedAt: this.now() });
    this.pages.set(viewerId, entries);
    this.pageBytes.set(viewerId, (this.pageBytes.get(viewerId) ?? 0) + bytes2);
    this.pagePoolBytes += bytes2;
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
    const bytes2 = this.wsBytes.get(viewerId) ?? 0;
    this.wsPendingBytes -= bytes2;
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
  FrameBudget,
  FRAME_WRITE_MS,
  FRAME_PRESSURE_RETRY_MS,
  FRAME_BUDGET_SHARE,
  BLANK_CELL
};
