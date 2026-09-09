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

// src/sqlite-history/codec.ts
import { createHash } from "node:crypto";
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
var init_codec = () => {};

// src/sqlite-history/detectors.ts
import { randomUUID } from "node:crypto";
function shadowFault(sessionId, detector, expected, observed, timestamp) {
  const body = { sessionId, detector, expected, observed, timestamp };
  return { issue_id: `shadow-${sha(JSON.stringify(body)).slice(0, 24)}`, ...body, missing_count: null };
}
function coordinates(left, right, bytes) {
  const a = new Map(left.map((value) => [value.ordinal, value])), b = new Map(right.map((value) => [value.ordinal, value]));
  const shared = [...a.keys()].filter((key) => b.has(key)).sort((x, y) => x - y);
  return {
    matched: shared.length,
    mismatches: shared.filter((key) => Buffer.compare(Buffer.from(bytes(a.get(key))), Buffer.from(bytes(b.get(key)))) !== 0),
    leftOnly: [...a.keys()].filter((key) => !b.has(key)).sort((x, y) => x - y),
    rightOnly: [...b.keys()].filter((key) => !a.has(key)).sort((x, y) => x - y)
  };
}
function sourceDiff(observed, oracle) {
  const actual = new Map(observed.map((row) => [row.line_no, row])), expected = new Map(oracle.map((row) => [row.line_no, row]));
  const shared = [...expected.keys()].filter((key) => actual.has(key));
  return {
    missingCoordinates: [...expected.keys()].filter((key) => !actual.has(key)).sort((a, b) => a - b),
    extraCoordinates: [...actual.keys()].filter((key) => !expected.has(key)).sort((a, b) => a - b),
    byteMismatches: shared.filter((key) => actual.get(key).kind !== expected.get(key).kind || Buffer.compare(Buffer.from(actual.get(key).text), Buffer.from(expected.get(key).text)) !== 0).sort((a, b) => a - b)
  };
}
function compareShadowBatch(sessionId, legacy, sqlite, oracle, comparedAt) {
  const legacyRows = new Map(legacy.rows.map((row) => [row.line_no, row])), sqliteRows = new Map(sqlite.rows.map((row) => [row.line_no, row]));
  const shared = [...legacyRows.keys()].filter((key) => sqliteRows.has(key)).sort((a, b) => a - b);
  const lineBytes = shared.filter((key) => Buffer.compare(Buffer.from(legacyRows.get(key).text), Buffer.from(sqliteRows.get(key).text)) !== 0);
  const lineKinds = shared.filter((key) => legacyRows.get(key).kind !== sqliteRows.get(key).kind);
  const frames = coordinates(legacy.frames, sqlite.frames, (value) => value.bytes);
  const unresolved = coordinates(legacy.unresolved, sqlite.unresolved, (value) => value.sha256);
  const lines = {
    matchedCoordinates: shared.length,
    byteMismatches: lineBytes,
    kindMismatches: lineKinds,
    legacyOnly: [...legacyRows.keys()].filter((key) => !sqliteRows.has(key)).sort((a, b) => a - b),
    sqliteOnly: [...sqliteRows.keys()].filter((key) => !legacyRows.has(key)).sort((a, b) => a - b)
  };
  const receipts = { legacyRequestId: legacy.requestId, sqliteRequestId: sqlite.requestId, match: legacy.requestId === sqlite.requestId };
  let source = { status: "unknown", legacy: null, sqlite: null };
  if (oracle) {
    const left = sourceDiff(legacy.rows, oracle.rows), right = sourceDiff(sqlite.rows, oracle.rows);
    const bad = !oracle.rows.length || oracle.requestId !== legacy.requestId || oracle.requestId !== sqlite.requestId || [...Object.values(left), ...Object.values(right)].some((values) => values.length > 0);
    source = { status: bad ? "mismatch" : "verified", legacy: left, sqlite: right };
  }
  const faults = [];
  if (!receipts.match)
    faults.push(shadowFault(sessionId, "shadow-receipt-mismatch", legacy.requestId, sqlite.requestId, comparedAt));
  if (lineBytes.length || lineKinds.length || lines.legacyOnly.length || lines.sqliteOnly.length)
    faults.push(shadowFault(sessionId, "shadow-line-mismatch", { byteMismatches: [], kindMismatches: [], legacyOnly: [], sqliteOnly: [] }, { byteMismatches: lineBytes, kindMismatches: lineKinds, legacyOnly: lines.legacyOnly, sqliteOnly: lines.sqliteOnly }, comparedAt));
  if (frames.mismatches.length || frames.leftOnly.length || frames.rightOnly.length)
    faults.push(shadowFault(sessionId, "shadow-frame-mismatch", { byteMismatches: [], legacyOnly: [], sqliteOnly: [] }, { byteMismatches: frames.mismatches, legacyOnly: frames.leftOnly, sqliteOnly: frames.rightOnly }, comparedAt));
  if (unresolved.mismatches.length || unresolved.leftOnly.length || unresolved.rightOnly.length)
    faults.push(shadowFault(sessionId, "shadow-unresolved-mismatch", { digestMismatches: [], legacyOnly: [], sqliteOnly: [] }, { digestMismatches: unresolved.mismatches, legacyOnly: unresolved.leftOnly, sqliteOnly: unresolved.rightOnly }, comparedAt));
  if (source.status === "mismatch")
    faults.push(shadowFault(sessionId, "shadow-source-mismatch", "both projections match a non-empty independent oracle", source, comparedAt));
  return {
    sessionId,
    requestId: sqlite.requestId,
    comparedAt,
    receipts,
    lines,
    frames: { matchedOrdinals: frames.matched, byteMismatches: frames.mismatches, legacyOnly: frames.leftOnly, sqliteOnly: frames.rightOnly },
    unresolved: { matchedOrdinals: unresolved.matched, digestMismatches: unresolved.mismatches, legacyOnly: unresolved.leftOnly, sqliteOnly: unresolved.rightOnly },
    source,
    faults
  };
}
function inspectShadowRuntime(state, now, staleAfterMs = 30000) {
  const findings = [];
  const last = state.lastProbeAt ?? state.startedAt;
  if (now - last > staleAfterMs || state.inFlightSince !== null && now - state.inFlightSince > staleAfterMs)
    findings.push(shadowFault(state.sessionId, "shadow-collector-stale", `probe/in-flight age <=${staleAfterMs}ms`, { probeAge: now - last, inFlightAge: state.inFlightSince === null ? null : now - state.inFlightSince }, now));
  if (state.targetRevision > state.exportedRevision && state.exportLagSince !== null && now - state.exportLagSince > staleAfterMs)
    findings.push(shadowFault(state.sessionId, "shadow-export-lag", { revision: state.targetRevision, age: `<=${staleAfterMs}ms` }, { revision: state.exportedRevision, age: now - state.exportLagSince }, now));
  if (state.lastWriteFailure)
    findings.push(shadowFault(state.sessionId, "shadow-write-failure", "both shadow destinations acknowledged the batch", state.lastWriteFailure, now));
  return findings;
}
function inspectHistoryHealth(health, now = Date.now()) {
  const findings = [];
  const fault = (detector, expected, observed) => findings.push({
    issue_id: randomUUID(),
    sessionId: health.sessionId,
    detector,
    expected,
    observed,
    timestamp: now,
    missing_count: null
  });
  if (now - (health.lastProbeAt ?? health.startedAt) > 30000)
    fault("probe-stale", "probe age <=30000ms", now - (health.lastProbeAt ?? health.startedAt));
  if (now - (health.lastCommitAt ?? health.startedAt) > 30000)
    fault("commit-stale", "commit age <=30000ms", now - (health.lastCommitAt ?? health.startedAt));
  if (health.continuity === "unknown")
    fault("source-unknown", "independent source interval evidence", "unknown");
  if (health.continuity === "failed" || health.fault && health.fault.detector !== "source-unknown")
    fault("collector-failed", "no collector failure", health.fault);
  return findings;
}
function validateHistoryPage(context, page) {
  if (JSON.stringify(context) !== JSON.stringify(page.context))
    throw new Error("viewer-context-mismatch");
  if (page.rows.length !== page.endLine - page.startLine || page.rows.some((r, i) => r.line_no !== page.startLine + i || r.line_no < context.firstLine || r.line_no >= context.liveStart))
    throw new Error("viewer-range-mismatch");
}
function verifyHistoryOracle(expected, observed) {
  if (!expected.length)
    throw new Error("oracle-empty");
  if (expected.length !== observed.length || expected.some((r, i) => r.line_no !== observed[i]?.line_no || r.kind !== observed[i]?.kind || r.text !== observed[i]?.text))
    throw new Error("source-oracle-mismatch");
}
function inspectHistoryMirror(sessionId, targetRevision, exportedRevision, lagSince, now = Date.now()) {
  return exportedRevision < targetRevision && now - lagSince > 30000 ? { issue_id: randomUUID(), sessionId, detector: "mirror-stale", expected: targetRevision, observed: exportedRevision, timestamp: now, missing_count: null } : null;
}
function verifyDualWriteAcknowledgement(projection, acknowledgement) {
  const digest = sha(JSON.stringify(projection));
  if (acknowledgement.requestId !== projection.requestId || acknowledgement.digest !== digest)
    throw new Error("legacy-projection-mismatch");
}
function inspectImportProgress(progress, now = Date.now()) {
  if (progress.state === "verified" || progress.state === "quarantined" || now - progress.checkpointAt <= 30000)
    return null;
  return {
    issue_id: randomUUID(),
    sessionId: progress.sessionId ?? "",
    detector: "import-progress-stale",
    expected: "checkpoint age <=30000ms",
    observed: now - progress.checkpointAt,
    timestamp: now,
    missing_count: null
  };
}
var init_detectors = __esm(() => {
  init_codec();
});

// src/sqlite-history/transfer.ts
var exports_transfer = {};
__export(exports_transfer, {
  sealHistorySnapshot: () => sealHistorySnapshot,
  restoreHistoryBundle: () => restoreHistoryBundle,
  readSeal: () => readSeal,
  readImportProgress: () => readImportProgress,
  importHistorySnapshot: () => importHistorySnapshot,
  exportHistoryBundle: () => exportHistoryBundle
});
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, writeFileSync, chmodSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { randomUUID as randomUUID2 } from "node:crypto";
import { parseReplayJournal } from "../core/index.js";
function syncDir(dir) {
  const fd = openSync(dir, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
function durableFile(path, data) {
  const fd = openSync(path, "wx", 384);
  try {
    writeFileSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
function names(dir) {
  return readdirSync(dir).sort().map((name) => {
    if (name !== basename(name) || !lstatSync(join(dir, name)).isFile() || lstatSync(join(dir, name)).isSymbolicLink())
      throw new Error("unsafe-snapshot-entry");
    return name;
  });
}
function sealHistorySnapshot(source, destination) {
  mkdirSync(destination, { mode: 448 });
  const files = [];
  for (const name of names(source)) {
    if (name === "seal.json")
      throw new Error("reserved-seal-name");
    const bytes = readFileSync(join(source, name));
    durableFile(join(destination, name), bytes);
    chmodSync(join(destination, name), 256);
    files.push({ path: name, bytes: bytes.length, sha256: sha(bytes) });
  }
  if (!files.length)
    throw new Error("empty-snapshot");
  durableFile(join(destination, "seal.pending"), JSON.stringify({ version: 1, files }));
  renameSync(join(destination, "seal.pending"), join(destination, "seal.json"));
  syncDir(destination);
  syncDir(dirname(destination));
}
function readSeal(directory) {
  const raw = readFileSync(join(directory, "seal.json"));
  const seal = JSON.parse(raw.toString());
  if (seal.version !== 1 || !Array.isArray(seal.files) || !seal.files.length)
    throw new Error("unsealed-source");
  const files = new Map;
  let bytes = 0;
  for (const entry of seal.files) {
    if (typeof entry.path !== "string" || entry.path !== basename(entry.path) || entry.path === "seal.json" || files.has(entry.path))
      throw new Error("invalid-inventory");
    const st = lstatSync(join(directory, entry.path));
    if (!st.isFile() || st.isSymbolicLink())
      throw new Error("unsafe-snapshot-entry");
    const data = readFileSync(join(directory, entry.path));
    if (data.length !== entry.bytes || sha(data) !== entry.sha256)
      throw new Error("snapshot-digest");
    files.set(entry.path, data);
    bytes += data.length;
  }
  if (names(directory).filter((n) => n !== "seal.json").length !== files.size)
    throw new Error("orphan-snapshot-file");
  return { seal, files, digest: sha(raw), bytes };
}
function decode(data) {
  return new TextDecoder("utf-8", { fatal: true }).decode(data);
}
function parseSource(input, files) {
  const result = { rows: [], frames: [], screen: [], error: null, consumedBytes: 0, offsets: [] };
  const required = (name) => {
    const data = files.get(name);
    if (!data)
      throw new Error(`missing-${name}`);
    return data;
  };
  const add = (line_no, text) => {
    safe(line_no);
    if (typeof text !== "string" || !text.isWellFormed())
      throw new Error("invalid-text");
    const last = result.rows.at(-1);
    if (last && line_no !== last.line_no + 1)
      throw new Error("source-coordinate-hole-or-conflict");
    result.rows.push({ line_no, kind: "terminal", text });
  };
  try {
    if (input.format === "file-jsonl") {
      const candidates = [...files.keys()].filter((n) => /^history-[a-f0-9]+\.jsonl$/.test(n));
      const dataName = files.has("history.jsonl") ? "history.jsonl" : candidates.length === 1 ? candidates[0] : "history.jsonl";
      const meta = JSON.parse(decode(required(dataName === "history.jsonl" ? "meta.json" : dataName.slice(0, -1))));
      if (!Array.isArray(meta.live) || meta.live.some((s) => typeof s !== "string"))
        throw new Error("invalid-meta-live");
      safe(meta.liveStart);
      safe(meta.nextLine);
      if (meta.nextLine < meta.liveStart)
        throw new Error("invalid-meta-boundary");
      result.screen = meta.live;
      result.legacy = { liveStart: meta.liveStart, nextLine: meta.nextLine };
      const bytes = required(dataName);
      let from = 0;
      for (let i = 0;i < bytes.length; i++)
        if (bytes[i] === 10) {
          const r = JSON.parse(decode(bytes.subarray(from, i)));
          add(r.line, r.text);
          from = i + 1;
          result.consumedBytes = from;
          result.offsets.push(from);
        }
      if (from !== bytes.length)
        throw new Error("partial-jsonl-tail");
      if (result.rows.length && result.rows.at(-1).line_no + 1 !== meta.liveStart)
        throw new Error("metadata-seam");
    } else if (input.format === "durable-log") {
      const chunks = [...files.keys()].filter((n) => /^\d+\.log$/.test(n)).sort((a, b) => Number(a.slice(0, -4)) - Number(b.slice(0, -4)));
      if (!chunks.length)
        throw new Error("no-log-chunks");
      for (const name of chunks) {
        const bytes = files.get(name);
        const start = Number(name.slice(0, -4));
        let from = 0, index = 0;
        for (let i = 0;i < bytes.length; i++)
          if (bytes[i] === 10) {
            const line = start + index++, text = decode(bytes.subarray(from, i));
            const existing = result.rows.find((r) => r.line_no === line);
            if (existing) {
              throw new Error(existing.text !== text ? "conflicting-chunks" : "overlap-needs-physical-record-mapping");
            } else
              add(line, text);
            result.consumedBytes += i + 1 - from;
            from = i + 1;
            result.offsets.push(result.consumedBytes);
          }
        if (from !== bytes.length)
          throw new Error("partial-log-tail");
      }
      result.consumedBytes = chunks.reduce((n, name) => n + files.get(name).length, 0);
    } else if (input.format === "host-chunks") {
      const manifest = JSON.parse(decode(required("manifest.json")));
      if (manifest.version !== 1 || !Array.isArray(manifest.chunks))
        throw new Error("invalid-manifest");
      const listed = new Set;
      for (const chunk of manifest.chunks) {
        if (typeof chunk.file !== "string" || chunk.file !== basename(chunk.file) || listed.has(chunk.file))
          throw new Error("invalid-chunk-file");
        listed.add(chunk.file);
        const bytes = required(chunk.file), rows = JSON.parse(decode(bytes));
        if (!Array.isArray(rows) || rows.length !== chunk.lineCount)
          throw new Error("chunk-count");
        rows.forEach((text, i) => {
          add(chunk.startLine + i, text);
          result.offsets.push(result.consumedBytes);
        });
        result.consumedBytes += bytes.length;
        result.offsets[result.offsets.length - 1] = result.consumedBytes;
      }
      if ([...files.keys()].some((n) => n.endsWith(".json") && n !== "manifest.json" && !listed.has(n)))
        throw new Error("orphan-chunk");
      if (result.rows.length !== manifest.totalLines)
        throw new Error("manifest-count");
    } else {
      const journals = [...files.keys()].filter((n) => n.endsWith(".ndjson"));
      const bytes = required(files.has("journal.ndjson") ? "journal.ndjson" : journals.length === 1 ? journals[0] : "journal.ndjson");
      let from = 0;
      for (let i = 0;i < bytes.length; i++)
        if (bytes[i] === 10) {
          result.frames.push(JSON.parse(decode(bytes.subarray(from, i))));
          from = i + 1;
          result.consumedBytes = from;
          result.offsets.push(from);
        }
      if (from !== bytes.length)
        throw new Error("partial-ndjson-tail");
    }
    if (!result.rows.length && !result.frames.length && !result.screen.length)
      throw new Error("no-readable-records");
  } catch (error) {
    result.error = String(error);
  }
  return result;
}
function readImportProgress(store, sourceId) {
  const row = store.db.query("SELECT * FROM history_import WHERE source_id=?").get(sourceId);
  if (!row)
    throw new Error("unknown-import");
  const evidence = JSON.parse(row.evidence_json);
  return {
    sourceId: row.source_id,
    sessionId: row.session_id,
    state: row.state,
    snapshotBytes: row.snapshot_bytes,
    byteCursor: row.byte_cursor,
    totalRecords: safe(evidence.totalRecords ?? row.record_cursor),
    recordCursor: row.record_cursor,
    checkpointAt: safe(evidence.checkpointAt ?? 0)
  };
}
async function importHistorySnapshot(store, input) {
  const sealed = readSeal(input.snapshotDirectory);
  const sid = input.sessionId ?? null;
  const parsed = parseSource(input, sealed.files);
  const total = parsed.rows.length + parsed.frames.length;
  const evidenceJson = (error) => JSON.stringify({ seal: sealed.seal, error, oracleRequired: true, totalRecords: total, checkpointAt: Date.now() });
  const notify = () => {
    try {
      input.onProgress?.(readImportProgress(store, input.sourceId));
    } catch (error) {
      store.report(sid ?? "", "import-progress-delivery-failed", "progress callback accepted", String(error));
    }
  };
  await store.write(sid ?? "", () => {
    const old = store.db.query("SELECT * FROM history_import WHERE source_id=?").get(input.sourceId);
    if (old) {
      if (old.snapshot_sha256 !== sealed.digest || old.session_id !== sid || old.format !== input.format)
        throw new Error("import-identity-conflict");
      return;
    }
    if (sid) {
      const s = store.session(sid);
      if (s.revision !== 0 || parsed.rows.length && s.next_line !== parsed.rows[0].line_no)
        throw new Error("import-requires-empty-mapped-session-at-source-floor");
    }
    store.db.query("INSERT INTO history_import VALUES (?,?,?,?,?,?,0,0,0,NULL,?,?)").run(input.sourceId, sid, input.snapshotDirectory, input.format, sealed.digest, sealed.bytes, "pending", evidenceJson(parsed.error));
  });
  notify();
  const current = () => store.db.query("SELECT * FROM history_import WHERE source_id=?").get(input.sourceId);
  if (!sid) {
    await store.write("", () => {
      store.db.query("UPDATE history_import SET state='quarantined',evidence_json=? WHERE source_id=?").run(evidenceJson("unmapped-session"), input.sourceId);
    });
    notify();
    return { state: "quarantined", records: 0 };
  }
  let cursor = current().record_cursor;
  try {
    while (cursor < total || !total && parsed.screen.length && current().state === "pending") {
      const from = cursor;
      let to = from, bytes = 0;
      while (to < total && to - from < 500) {
        const size = Buffer.byteLength(JSON.stringify(parsed.rows[to] ?? parsed.frames[to]));
        if (size > 1048576)
          throw new Error("oversized-import-record");
        if (bytes + size > 1048576)
          break;
        bytes += size;
        to++;
      }
      if (input.format === "frame-ndjson") {
        await store.write(sid, () => {
          for (let i = from;i < to; i++)
            store.insertFrame(sid, parsed.frames[i], null);
          store.db.query("UPDATE history_import SET record_cursor=?,imported_records=?,byte_cursor=?,state='copying',evidence_json=? WHERE source_id=?").run(to, to, parsed.offsets[to - 1] ?? 0, evidenceJson(null), input.sourceId);
        });
      } else {
        const rows = parsed.rows.slice(from, to), screen = to === total ? parsed.screen : [];
        const geometry = { kind: "legacy-window", rows: screen.length, cols: 0, generation: 0, alternate: false };
        await store.commit({
          ticket: store.ticket(sid, `import:${input.sourceId}:${from}`),
          observation: { raw: screen, screen, geometry, at: 0, source: {} },
          appended: rows.map(({ kind, text }) => ({ kind, text })),
          liveLineLimit: 0,
          evidence: {
            classification: "import",
            depth: "import",
            source: {},
            rawSha256: sealed.digest,
            importSpan: { source_id: input.sourceId, physicalRecordStart: from, count: rows.length },
            legacy: parsed.legacy
          }
        }, () => {
          store.db.query("UPDATE history_import SET record_cursor=?,imported_records=?,byte_cursor=?,state='copying',evidence_json=? WHERE source_id=?").run(to, to, parsed.offsets[to - 1] ?? 0, evidenceJson(null), input.sourceId);
        });
      }
      cursor = to;
      notify();
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (!total)
        break;
    }
  } catch (error) {
    parsed.error = String(error);
  }
  const state = parsed.error ? "quarantined" : "verified";
  await store.write(sid, () => {
    store.db.query("UPDATE history_import SET state=?,byte_cursor=?,imported_sha256=?,evidence_json=? WHERE source_id=?").run(state, state === "verified" ? sealed.bytes : Math.min(sealed.bytes, parsed.offsets[cursor - 1] ?? 0), sha(JSON.stringify({ rows: parsed.rows.slice(0, cursor), frames: parsed.frames.slice(0, cursor) })), evidenceJson(parsed.error), input.sourceId);
  });
  notify();
  if (parsed.error)
    store.persistFault(sid, "import-quarantined", "all sealed physical records mapped", parsed.error);
  return { state, records: cursor };
}
function exportHistoryBundle(store, sid, destination) {
  try {
    mkdirSync(destination, { mode: 448 });
    const recovery = store.db.transaction(() => {
      store.audit(sid);
      const session = store.session(sid);
      const captures2 = store.db.query("SELECT * FROM history_capture WHERE session_id=? ORDER BY seq").all(sid).map((c) => ({ ...c, unresolved_capture: c.unresolved_capture ? Buffer.from(c.unresolved_capture).toString("base64") : null }));
      return {
        version: 1,
        session,
        captures: captures2,
        lines: store.db.query("SELECT * FROM history_line WHERE session_id=? ORDER BY line_no").all(sid),
        frames: store.db.query("SELECT * FROM history_frame WHERE session_id=? ORDER BY frame_seq").all(sid),
        issues: store.db.query("SELECT * FROM history_issue WHERE session_id=? ORDER BY detected_at,issue_id").all(sid),
        imports: store.db.query("SELECT * FROM history_import WHERE session_id=?").all(sid)
      };
    })();
    const { lines: rows, captures } = recovery, last = captures.at(-1);
    const files = new Map;
    files.set("recovery.json", JSON.stringify(recovery));
    files.set("history.jsonl", rows.map((r) => JSON.stringify({ line: r.line_no, text: r.text })).join(`
`) + (rows.length ? `
` : ""));
    files.set("meta.json", JSON.stringify({ liveStart: recovery.session.next_line, nextLine: recovery.session.next_line + (last ? JSON.parse(last.screen_json).length : 0), live: last ? JSON.parse(last.screen_json) : [] }));
    files.set("journal.ndjson", recovery.frames.map((r) => r.record_json).join(`
`) + (recovery.frames.length ? `
` : ""));
    for (let i = 0;i < rows.length; i += 500)
      files.set(`${String(rows[i].line_no).padStart(12, "0")}.log`, rows.slice(i, i + 500).map((r) => r.text + `
`).join(""));
    for (const imp of recovery.imports) {
      const source = readSeal(imp.source_path);
      files.set(`source-${sha(imp.source_id)}.json`, JSON.stringify({ sourceId: imp.source_id, seal: source.seal, sealBytes: readFileSync(join(imp.source_path, "seal.json")).toString("base64"), files: [...source.files].map(([path, bytes]) => ({ path, base64: bytes.toString("base64") })) }));
    }
    const seal = { version: 1, files: [] };
    for (const [path, data] of files) {
      durableFile(join(destination, path), data);
      seal.files.push({ path, bytes: Buffer.byteLength(data), sha256: sha(data) });
    }
    durableFile(join(destination, "seal.pending"), JSON.stringify(seal));
    renameSync(join(destination, "seal.pending"), join(destination, "seal.json"));
    syncDir(destination);
    syncDir(dirname(destination));
    return { revision: recovery.session.revision, directory: destination };
  } catch (error) {
    store.persistFault(sid, "export-failed", "sealed bundle at committed revision", String(error));
    throw error;
  }
}
async function restoreHistoryBundle(store, directory) {
  const sealed = readSeal(directory), data = sealed.files.get("recovery.json");
  if (!data)
    throw new Error("missing-recovery");
  const r = JSON.parse(decode(data));
  if (r.version !== 1)
    throw new Error("future-recovery");
  const s = r.session, sid = s.session_id;
  const importedSources = new Map;
  for (const imp of r.imports) {
    const encoded = sealed.files.get(`source-${sha(imp.source_id)}.json`);
    if (!encoded)
      throw new Error("missing-recovery-source");
    const source = JSON.parse(decode(encoded));
    if (source.sourceId !== imp.source_id)
      throw new Error("recovery-source-identity");
    const destination = join(dirname(store.file), `restored-source-${randomUUID2()}`);
    mkdirSync(destination, { mode: 448 });
    for (const entry of source.files) {
      if (entry.path !== basename(entry.path) || entry.path === "seal.json")
        throw new Error("unsafe-recovery-path");
      durableFile(join(destination, entry.path), Buffer.from(entry.base64, "base64"));
    }
    durableFile(join(destination, "seal.json"), Buffer.from(source.sealBytes, "base64"));
    syncDir(destination);
    syncDir(dirname(destination));
    if (readSeal(destination).digest !== imp.snapshot_sha256)
      throw new Error("recovery-source-digest");
    importedSources.set(imp.source_id, destination);
  }
  await store.write(sid, () => {
    const currentFence = store.pragma("application_id");
    store.db.query(`INSERT INTO history_session(session_id,lifecycle_key,name,group_label,active,writer_fence,first_line,next_line,live_start)
      VALUES (?,?,?,?,0,?,?,?,?)`).run(sid, s.lifecycle_key, s.name, s.group_label, currentFence, s.first_line, s.first_line, s.first_line);
    for (const c of r.captures) {
      store.db.query("INSERT INTO history_capture VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(sid, c.seq, c.request_id, c.previous_seq, c.at, c.geometry_json, c.screen_json, c.row_start, c.row_end, c.first_line, c.live_start, c.next_line, c.expected_rows, c.rows_sha256, c.evidence_json, c.unresolved_capture ? Buffer.from(c.unresolved_capture, "base64") : null);
      for (const row of r.lines.filter((l) => l.capture_seq === c.seq))
        store.db.query("INSERT INTO history_line VALUES (?,?,?,?,?,?)").run(sid, row.line_no, row.kind, row.text, row.capture_seq, row.capture_row);
      store.db.query("UPDATE history_session SET revision=?,live_start=? WHERE session_id=?").run(c.seq, c.live_start, sid);
    }
    for (const f of r.frames)
      store.db.query("INSERT INTO history_frame VALUES (?,?,?,?,?,?)").run(sid, f.frame_seq, f.at, f.kind, f.record_json, f.capture_seq);
    for (const i of r.issues)
      store.db.query("INSERT INTO history_issue VALUES (?,?,?,?,?,?,?,?,?)").run(i.issue_id, sid, i.capture_seq, i.kind, i.detected_at, i.boundary_line, i.missing_count, i.evidence_json, i.resolved_at);
    for (const imp of r.imports)
      store.db.query("INSERT INTO history_import VALUES (?,?,?,?,?,?,?,?,?,?,?,?)").run(imp.source_id, sid, importedSources.get(imp.source_id), imp.format, imp.snapshot_sha256, imp.snapshot_bytes, imp.byte_cursor, imp.record_cursor, imp.imported_records, imp.imported_sha256, imp.state, imp.evidence_json);
    if (store.session(sid).next_line !== s.next_line || store.session(sid).revision !== s.revision)
      throw new Error("recovery-boundary");
    if (r.frames.length)
      parseReplayJournal(r.frames.map((f) => f.record_json).join(`
`) + `
`);
    store.audit(sid);
  });
  return sid;
}
var init_transfer = __esm(() => {
  init_codec();
});

// src/sqlite-history/rehearsal.ts
var exports_rehearsal = {};
__export(exports_rehearsal, {
  verifyImportedSnapshot: () => verifyImportedSnapshot,
  readSealedHistoryOracle: () => readSealedHistoryOracle,
  inspectImportedSnapshot: () => inspectImportedSnapshot,
  importClosedHistorySession: () => importClosedHistorySession,
  assertMigrationReady: () => assertMigrationReady
});
import { basename as basename2 } from "node:path";
import { TextDecoder as TextDecoder2 } from "node:util";
import { parseReplayJournal as parseReplayJournal2 } from "../core/index.js";
function decode2(bytes) {
  return new TextDecoder2("utf-8", { fatal: true }).decode(bytes);
}
function jsonLines(bytes) {
  const values = [];
  let start = 0;
  for (let index = 0;index < bytes.length; index++)
    if (bytes[index] === 10) {
      values.push(JSON.parse(decode2(bytes.subarray(start, index))));
      start = index + 1;
    }
  if (start !== bytes.length)
    throw new Error("oracle-partial-record");
  return values;
}
function textLines(bytes) {
  const values = [];
  let start = 0;
  for (let index = 0;index < bytes.length; index++)
    if (bytes[index] === 10) {
      values.push(decode2(bytes.subarray(start, index)));
      start = index + 1;
    }
  if (start !== bytes.length)
    throw new Error("oracle-partial-record");
  return values;
}
function readSealedHistoryOracle(directory, format) {
  const { files } = readSeal(directory);
  const required = (name) => {
    const value = files.get(name);
    if (!value)
      throw new Error(`oracle-missing-${name}`);
    return value;
  };
  const rows = [], frames = [];
  let screen = [];
  const add = (line_no, text) => {
    safe(line_no);
    if (typeof text !== "string" || !text.isWellFormed())
      throw new Error("oracle-invalid-text");
    if (rows.length && line_no !== rows.at(-1).line_no + 1)
      throw new Error("oracle-coordinate-hole");
    rows.push({ line_no, kind: "terminal", text });
  };
  if (format === "file-jsonl") {
    const candidates = [...files.keys()].filter((name) => /^history-[a-f0-9]+\.jsonl$/.test(name));
    const dataName = files.has("history.jsonl") ? "history.jsonl" : candidates.length === 1 ? candidates[0] : "history.jsonl";
    const metaName = dataName === "history.jsonl" ? "meta.json" : dataName.slice(0, -1);
    const meta = JSON.parse(decode2(required(metaName)));
    if (!Array.isArray(meta.live) || meta.live.some((value) => typeof value !== "string"))
      throw new Error("oracle-invalid-screen");
    screen = meta.live;
    for (const value of jsonLines(required(dataName)))
      add(value.line, value.text);
  } else if (format === "durable-log") {
    const chunks = [...files.keys()].filter((name) => /^\d+\.log$/.test(name)).sort((a, b) => Number(a.slice(0, -4)) - Number(b.slice(0, -4)));
    if (!chunks.length)
      throw new Error("oracle-no-log-chunks");
    for (const name of chunks) {
      const start = safe(Number(name.slice(0, -4)));
      textLines(required(name)).forEach((text, index) => add(start + index, text));
    }
  } else if (format === "host-chunks") {
    const manifest = JSON.parse(decode2(required("manifest.json")));
    if (manifest.version !== 1 || !Array.isArray(manifest.chunks))
      throw new Error("oracle-invalid-manifest");
    const listed = new Set;
    for (const chunk of manifest.chunks) {
      if (typeof chunk.file !== "string" || chunk.file !== basename2(chunk.file) || listed.has(chunk.file))
        throw new Error("oracle-invalid-chunk");
      listed.add(chunk.file);
      const values = JSON.parse(decode2(required(chunk.file)));
      if (!Array.isArray(values) || values.length !== chunk.lineCount)
        throw new Error("oracle-chunk-count");
      values.forEach((text, index) => add(chunk.startLine + index, text));
    }
    if ([...files.keys()].some((name) => name.endsWith(".json") && name !== "manifest.json" && !listed.has(name)))
      throw new Error("oracle-orphan-chunk");
  } else {
    const journals = [...files.keys()].filter((name2) => name2.endsWith(".ndjson"));
    const name = files.has("journal.ndjson") ? "journal.ndjson" : journals.length === 1 ? journals[0] : "journal.ndjson";
    frames.push(...jsonLines(required(name)));
    parseReplayJournal2(frames.map((frame) => JSON.stringify(frame)).join(`
`) + `
`);
  }
  return { rows, frames, screen };
}
function digestFrames(frames) {
  return sha(JSON.stringify(frames));
}
function digestScreen(screen) {
  return sha(JSON.stringify(screen));
}
function inspectImportedSnapshot(store, input) {
  const source = readSeal(input.snapshotDirectory), oracle = readSealedHistoryOracle(input.snapshotDirectory, input.format);
  const imp = store.db.query("SELECT * FROM history_import WHERE source_id=?").get(input.sourceId);
  if (!imp?.session_id)
    throw new Error("verification-unmapped-import");
  if (imp.snapshot_sha256 !== source.digest || imp.snapshot_bytes !== source.bytes)
    throw new Error("verification-source-identity");
  const observedRows = store.db.query("SELECT line_no,kind,text FROM history_line WHERE session_id=? ORDER BY line_no").all(imp.session_id);
  const observedFrames = store.db.query("SELECT record_json FROM history_frame WHERE session_id=? ORDER BY frame_seq").all(imp.session_id).map((row) => JSON.parse(row.record_json));
  const latest = store.db.query("SELECT screen_json FROM history_capture WHERE session_id=? ORDER BY seq DESC LIMIT 1").get(imp.session_id);
  const observedScreen = latest ? JSON.parse(latest.screen_json) : [];
  const evidence = JSON.parse(imp.evidence_json);
  const expectedRecords = oracle.rows.length + oracle.frames.length;
  const unresolved = [];
  if (imp.state !== "verified")
    unresolved.push({ kind: "import-state", expected: "verified", observed: imp.state });
  if (imp.byte_cursor !== source.bytes)
    unresolved.push({ kind: "byte-cursor", expected: source.bytes, observed: imp.byte_cursor });
  if (imp.record_cursor !== expectedRecords || evidence.totalRecords !== expectedRecords)
    unresolved.push({ kind: "record-cursor", expected: expectedRecords, observed: imp.record_cursor });
  if (evidence.error)
    unresolved.push({ kind: "source-error", expected: "none", observed: "present" });
  if (rowsDigest(oracle.rows) !== rowsDigest(observedRows))
    unresolved.push({ kind: "row-diff", expected: oracle.rows.length, observed: observedRows.length });
  if (digestFrames(oracle.frames) !== digestFrames(observedFrames))
    unresolved.push({ kind: "frame-diff", expected: oracle.frames.length, observed: observedFrames.length });
  if (digestScreen(oracle.screen) !== digestScreen(observedScreen))
    unresolved.push({ kind: "screen-diff", expected: oracle.screen.length, observed: observedScreen.length });
  const raw = store.db.query("SELECT count(*) AS count FROM history_capture WHERE session_id=? AND unresolved_capture IS NOT NULL").get(imp.session_id);
  if (raw.count)
    unresolved.push({ kind: "unresolved-capture", expected: 0, observed: raw.count });
  return {
    sourceId: input.sourceId,
    sessionId: imp.session_id,
    manifest: { files: source.seal.files.length, bytes: source.bytes, sha256: source.digest },
    rows: { expected: oracle.rows.length, observed: observedRows.length, sha256: rowsDigest(observedRows) },
    frames: { expected: oracle.frames.length, observed: observedFrames.length, sha256: digestFrames(observedFrames) },
    screen: { expected: oracle.screen.length, observed: observedScreen.length, sha256: digestScreen(observedScreen) },
    unresolved,
    ready: unresolved.length === 0
  };
}
function assertMigrationReady(report) {
  if (!report.manifest.files)
    throw new Error("migration-empty-manifest");
  if (report.unresolved.length || !report.ready)
    throw new Error(`migration-unresolved:${report.unresolved.map((item) => item.kind).join(",")}`);
}
function verifyImportedSnapshot(store, input) {
  const report = inspectImportedSnapshot(store, input);
  try {
    assertMigrationReady(report);
    return report;
  } catch (error) {
    store.persistFault(report.sessionId, "migration-rehearsal", "full row/frame/screen diff and zero unresolved entries", String(error));
    throw error;
  }
}
async function importClosedHistorySession(store, input) {
  const old = store.db.query("SELECT session_id FROM history_import WHERE source_id=?").get(input.sourceId);
  const oracle = readSealedHistoryOracle(input.snapshotDirectory, input.format);
  if (old?.session_id) {
    const existing = store.session(old.session_id);
    if (existing.lifecycle_key !== input.lifecycleKey || existing.name !== input.name || existing.group_label !== (input.group ?? "_ungrouped")) {
      throw new Error("closed-import-identity-conflict");
    }
  }
  const sessionId = old?.session_id ?? await store.register({
    name: input.name,
    lifecycleKey: input.lifecycleKey,
    group: input.group,
    firstLine: oracle.rows[0]?.line_no ?? 0
  });
  if (!sessionId)
    throw new Error("closed-import-unmapped");
  const options = { sourceId: input.sourceId, sessionId, snapshotDirectory: input.snapshotDirectory, format: input.format, onProgress: input.onProgress };
  const imported = await importHistorySnapshot(store, options);
  if (imported.state !== "verified")
    return { sessionId, state: imported.state, records: imported.records, verification: null };
  const verification = verifyImportedSnapshot(store, options);
  if (store.session(sessionId).active)
    await store.closeSession(sessionId);
  return { sessionId, state: imported.state, records: imported.records, verification };
}
var init_rehearsal = __esm(() => {
  init_codec();
  init_transfer();
});

// src/history-stitch.ts
function locateAnchor(hay, needle) {
  if (needle.length === 0 || hay.length < needle.length)
    return "missing";
  let found = -1;
  for (let start = 0;start <= hay.length - needle.length; start++) {
    let matches = true;
    for (let index = 0;index < needle.length; index++) {
      if (hay[start + index] !== needle[index]) {
        matches = false;
        break;
      }
    }
    if (!matches)
      continue;
    if (found !== -1)
      return "ambiguous";
    found = start;
  }
  return found === -1 ? "missing" : { index: found };
}
function stitchCapture(input) {
  const cut = Math.max(0, input.captured.length - Math.max(1, input.paneRows));
  if (cut === 0)
    return { ...EMPTY, tooShort: true };
  if (input.archivedTail.length === 0) {
    return { ...EMPTY, appended: input.captured.slice(0, cut) };
  }
  const match = locateAnchor(input.captured, input.archivedTail);
  if (match === "ambiguous")
    return { ...EMPTY, deferred: true };
  if (match === "missing") {
    return { ...EMPTY, appended: input.captured.slice(0, cut) };
  }
  const from = match.index + input.archivedTail.length;
  return {
    ...EMPTY,
    anchored: true,
    appended: from >= cut ? [] : input.captured.slice(from, cut)
  };
}
var EMPTY;
var init_history_stitch = __esm(() => {
  EMPTY = { appended: [], anchored: false, deferred: false, tooShort: false };
});

// src/sqlite-history/coordinator.ts
var exports_coordinator = {};
__export(exports_coordinator, {
  HistoryCoordinator: () => HistoryCoordinator
});
import { randomUUID as randomUUID3 } from "node:crypto";

class HistoryCoordinator {
  store;
  options;
  commitBatch;
  running = new Map;
  pending = new Map;
  timer = null;
  stopped = false;
  constructor(store, options, commitBatch = (batch) => store.commit(batch)) {
    this.store = store;
    this.options = options;
    this.commitBatch = commitBatch;
    safe(options.recordingSessionBytes ?? 64 * 1024 * 1024);
    safe(options.recordingRootBytes ?? 256 * 1024 * 1024);
    safe(options.intervalMs ?? 1e4);
    safe(options.deadlineMs ?? 5000);
    safe(options.liveLineLimit ?? 1000);
    if ((options.intervalMs ?? 1e4) < 1 || (options.deadlineMs ?? 5000) < 1)
      throw new Error("invalid-deadline");
    store.addDrain(() => this.stopAndDrain());
  }
  start() {
    if (this.timer)
      return;
    this.stopped = false;
    const tick = () => {
      for (const sid of this.options.sessions())
        this.probe(sid).catch(() => {});
    };
    tick();
    this.timer = setInterval(tick, this.options.intervalMs ?? 1e4);
  }
  probe(sid) {
    if (this.stopped)
      return Promise.reject(new Error("coordinator-stopped"));
    const existing = this.running.get(sid);
    if (existing)
      return existing;
    const task = this.collect(sid).finally(() => this.running.delete(sid));
    this.running.set(sid, task);
    return task;
  }
  async collect(sid) {
    try {
      const retry = this.pending.get(sid);
      if (retry) {
        const receipt2 = await this.commitBatch(retry);
        this.pending.delete(sid);
        await this.publish(receipt2);
        return receipt2;
      }
      const ticket = this.store.ticket(sid, randomUUID3());
      const generation = this.options.driver.geometryGeneration(sid);
      const abort = new AbortController;
      let timer;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
          abort.abort();
          reject(new Error("capture-deadline"));
        }, this.options.deadlineMs ?? 5000);
      });
      const run = async () => {
        let o2 = await this.options.driver.capture(sid, "shallow", abort.signal);
        validateObservation(o2);
        const tail2 = this.store.tail(sid).map((r) => r.text);
        const classify = (v) => {
          if (v.geometry.alternate || v.source.reset)
            return "geometry";
          if (v.geometry.generation !== generation || this.options.driver.geometryGeneration(sid) !== generation)
            return "geometry";
          if (!v.raw.length || v.raw.length <= v.screen.length)
            return "empty";
          if (!tail2.length)
            return "initial";
          const match = locateAnchor(v.raw.slice(0, v.raw.length - v.screen.length), tail2);
          return typeof match === "string" ? match : "overlap";
        };
        let classification2 = classify(o2), depth2 = "shallow";
        if (["missing", "ambiguous", "empty"].includes(classification2)) {
          depth2 = "deep";
          o2 = await this.options.driver.capture(sid, "deep", abort.signal);
          validateObservation(o2);
          classification2 = classify(o2);
        }
        return { o: o2, tail: tail2, classification: classification2, depth: depth2 };
      };
      const { o, tail, classification, depth } = await Promise.race([run(), timeout]).finally(() => clearTimeout(timer));
      const stable = o.raw.slice(0, o.raw.length - o.screen.length);
      let appended = [];
      const unresolved = classification !== "initial" && classification !== "overlap";
      if (classification === "geometry") {
        appended = [];
      } else if (classification === "overlap") {
        const match = locateAnchor(stable, tail);
        if (typeof match !== "string")
          appended = stable.slice(match.index + tail.length).map((text) => ({ kind: "terminal", text }));
      } else if (classification === "initial")
        appended = stable.map((text) => ({ kind: "terminal", text }));
      else if (stable.length)
        appended = [{ kind: "gap", text: "[history continuity unknown]" }, ...stable.map((text) => ({ kind: "terminal", text }))];
      const raw = Buffer.from(JSON.stringify(o), "utf8");
      const batch = {
        ticket,
        observation: o,
        appended,
        recordFrames: this.options.recordFrames ?? false,
        recordingSessionBytes: this.options.recordingSessionBytes,
        recordingRootBytes: this.options.recordingRootBytes,
        liveLineLimit: this.options.liveLineLimit ?? 1000,
        evidence: { classification, depth, source: o.source, rawSha256: sha(raw) },
        unresolved: unresolved ? raw : undefined
      };
      this.pending.set(sid, batch);
      const receipt = await this.commitBatch(batch);
      this.pending.delete(sid);
      await this.publish(receipt);
      return receipt;
    } catch (error) {
      this.store.persistFault(sid, "capture-failed", "completed probe within deadline", String(error));
      throw error;
    }
  }
  async publish(receipt) {
    try {
      await this.options.publish?.(receipt);
    } catch (error) {
      this.store.persistFault(receipt.context.sessionId, "delivery-failed", receipt.context.revision, String(error));
      throw error;
    }
  }
  async stopAndDrain() {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await Promise.allSettled(this.running.values());
    for (const [sid, batch] of this.pending) {
      await this.commitBatch(batch);
      this.pending.delete(sid);
    }
  }
}
var init_coordinator = __esm(() => {
  init_history_stitch();
  init_codec();
});

// src/sqlite-history/authoritative.ts
var exports_authoritative = {};
__export(exports_authoritative, {
  verifyRollbackBundle: () => verifyRollbackBundle,
  readMirror: () => readMirror,
  AuthoritativeHistoryBridge: () => AuthoritativeHistoryBridge
});
import {
  chmodSync as chmodSync2,
  closeSync as closeSync2,
  existsSync,
  fsyncSync as fsyncSync2,
  lstatSync as lstatSync2,
  mkdirSync as mkdirSync2,
  openSync as openSync2,
  readFileSync as readFileSync2,
  readdirSync as readdirSync2,
  renameSync as renameSync2,
  writeFileSync as writeFileSync2
} from "node:fs";
import { basename as basename3, join as join2, resolve } from "node:path";
import { randomUUID as randomUUID4 } from "node:crypto";
function syncDirectory(path) {
  const fd = openSync2(path, "r");
  try {
    fsyncSync2(fd);
  } finally {
    closeSync2(fd);
  }
}
function privateDirectory(path) {
  const directory = resolve(path);
  if (!existsSync(directory))
    mkdirSync2(directory, { recursive: true, mode: 448 });
  const stat = lstatSync2(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 63) !== 0) {
    throw new Error("mirror-directory-must-be-private");
  }
  return directory;
}
function durableReplace(directory, name, data, afterTemp) {
  const temporary = join2(directory, `.${name}-${randomUUID4()}.pending`);
  const fd = openSync2(temporary, "wx", 384);
  try {
    writeFileSync2(fd, data);
    fsyncSync2(fd);
  } finally {
    closeSync2(fd);
  }
  afterTemp?.();
  renameSync2(temporary, join2(directory, name));
  chmodSync2(join2(directory, name), 384);
  syncDirectory(directory);
}

class AuthoritativeHistoryBridge {
  store;
  options;
  coordinator;
  lagSince = new Map;
  barrier = false;
  constructor(store, options) {
    this.store = store;
    this.options = options;
    privateDirectory(options.mirrorDirectory);
    this.coordinator = new HistoryCoordinator(store, options, (batch) => this.commitBatch(batch));
  }
  now() {
    return (this.options.now ?? Date.now)();
  }
  sessionDirectory(sessionId) {
    return privateDirectory(join2(this.options.mirrorDirectory, sha(sessionId)));
  }
  readWatermark(sessionId) {
    const path = join2(this.sessionDirectory(sessionId), "watermark.json");
    if (!existsSync(path))
      return 0;
    const record = JSON.parse(readFileSync2(path, "utf8"));
    if (record.version !== 1 || record.sessionId !== sessionId)
      throw new Error("mirror-watermark-identity");
    return safe(record.exportedRevision);
  }
  committedRecord(sessionId, seq) {
    return this.store.db.transaction(() => {
      const capture = this.store.capture(sessionId, seq);
      const rows = this.store.rows(sessionId, capture.row_start, capture.row_end);
      if (rows.length !== capture.expected_rows || rowsDigest(rows) !== capture.rows_sha256) {
        throw new Error("mirror-source-digest");
      }
      return {
        version: 1,
        sessionId,
        seq,
        requestId: capture.request_id,
        rowStart: capture.row_start,
        rowEnd: capture.row_end,
        firstLine: capture.first_line,
        liveStart: capture.live_start,
        nextLine: capture.next_line,
        rowsSha256: capture.rows_sha256,
        rows,
        screen: JSON.parse(capture.screen_json),
        geometryJson: capture.geometry_json
      };
    })();
  }
  exportSeq(sessionId, seq) {
    const record = this.committedRecord(sessionId, seq);
    const directory = this.sessionDirectory(sessionId);
    const data = JSON.stringify(record);
    const path = join2(directory, seqName(seq));
    if (existsSync(path)) {
      if (sha(readFileSync2(path)) !== sha(data))
        throw new Error("mirror-conflict");
      return;
    }
    durableReplace(directory, seqName(seq), data, () => this.options.stage?.("mirror-temp"));
    this.options.stage?.("mirror-seq");
  }
  advanceWatermark(sessionId) {
    const directory = this.sessionDirectory(sessionId);
    const revision = this.store.session(sessionId).revision;
    let exported = this.readWatermark(sessionId);
    while (exported < revision && existsSync(join2(directory, seqName(exported + 1))))
      exported++;
    durableReplace(directory, "watermark.json", JSON.stringify({ version: 1, sessionId, exportedRevision: exported }));
    this.options.stage?.("mirror-watermark");
    if (exported >= revision)
      this.lagSince.delete(sessionId);
    return exported;
  }
  async commitBatch(batch) {
    if (this.barrier)
      throw new Error("authoritative-barrier-held");
    const sessionId = batch.ticket.sessionId;
    const receipt = await this.store.commit(batch);
    this.options.stage?.("sqlite-committed");
    try {
      this.exportSeq(sessionId, receipt.context.revision);
      this.advanceWatermark(sessionId);
    } catch (error) {
      if (!this.lagSince.has(sessionId))
        this.lagSince.set(sessionId, this.now());
      this.store.persistFault(sessionId, "export-failed", "mirror export at committed revision", { revision: receipt.context.revision, error: String(error) });
    }
    return receipt;
  }
  start() {
    this.coordinator.start();
  }
  probe(sessionId) {
    return this.coordinator.probe(sessionId);
  }
  resumeMirror(sessionId) {
    const revision = this.store.session(sessionId).revision;
    for (let seq = this.readWatermark(sessionId) + 1;seq <= revision; seq++)
      this.exportSeq(sessionId, seq);
    this.advanceWatermark(sessionId);
    return this.mirrorStatus(sessionId);
  }
  mirrorStatus(sessionId) {
    const targetRevision = this.store.session(sessionId).revision;
    const exportedRevision = this.readWatermark(sessionId);
    if (exportedRevision > targetRevision)
      throw new Error("mirror-ahead-of-authoritative-writer");
    if (exportedRevision < targetRevision) {
      if (!this.lagSince.has(sessionId))
        this.lagSince.set(sessionId, this.now());
    } else
      this.lagSince.delete(sessionId);
    return { sessionId, targetRevision, exportedRevision, lagSince: this.lagSince.get(sessionId) ?? null };
  }
  async rollbackToLegacy(sessionId, destination) {
    this.barrier = true;
    await this.coordinator.stopAndDrain();
    const status = this.resumeMirror(sessionId);
    if (status.exportedRevision !== status.targetRevision)
      throw new Error("rollback-mirror-lag");
    const c2Revision = status.targetRevision;
    exportHistoryBundle(this.store, sessionId, destination);
    const verified = verifyRollbackBundle(this.store, sessionId, destination);
    if (this.store.session(sessionId).revision !== c2Revision)
      throw new Error("rollback-moved-past-barrier");
    return { sessionId, c2Revision, directory: destination, ...verified };
  }
  stopAndDrain() {
    return this.coordinator.stopAndDrain();
  }
}
function verifyRollbackBundle(store, sessionId, directory) {
  try {
    const session = store.session(sessionId);
    const committed = store.rows(sessionId, session.first_line, session.next_line);
    store.checkRange(sessionId, committed, session.first_line, session.next_line);
    const sealed = readSeal(directory);
    const recovery = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(sealed.files.get("recovery.json") ?? new Uint8Array));
    if (recovery.session.session_id !== sessionId || recovery.session.revision !== session.revision || recovery.session.first_line !== session.first_line || recovery.session.next_line !== session.next_line) {
      throw new Error("rollback-recovery-boundary");
    }
    if (rowsDigest(recovery.lines) !== rowsDigest(committed))
      throw new Error("rollback-recovery-rows");
    const compareText = (oracle, label) => {
      if (oracle.length !== committed.length)
        throw new Error(`rollback-${label}-count`);
      for (let index = 0;index < committed.length; index++) {
        if (oracle[index].line_no !== committed[index].line_no || Buffer.compare(Buffer.from(oracle[index].text, "utf8"), Buffer.from(committed[index].text, "utf8")) !== 0) {
          throw new Error(`rollback-${label}-bytes`);
        }
      }
    };
    compareText(readSealedHistoryOracle(directory, "file-jsonl").rows, "jsonl");
    if (committed.length)
      compareText(readSealedHistoryOracle(directory, "durable-log").rows, "log");
    const journal = recovery.frames.map((frame) => frame.record_json);
    if (journal.length) {
      const oracleFrames = readSealedHistoryOracle(directory, "frame-ndjson").frames;
      if (oracleFrames.length !== journal.length || oracleFrames.some((frame, index) => JSON.stringify(frame) !== journal[index])) {
        throw new Error("rollback-frame-bytes");
      }
    }
    return { rows: committed.length, frames: journal.length, rowsSha256: rowsDigest(committed) };
  } catch (error) {
    store.persistFault(sessionId, "rollback-not-ready", "exported legacy projection byte-identical to committed history", String(error));
    throw error;
  }
}
function readMirror(directory, sessionId) {
  const sessionDirectory = join2(resolve(directory), sha(sessionId));
  if (!existsSync(sessionDirectory))
    return { exportedRevision: 0, records: [] };
  const names2 = readdirSync2(sessionDirectory).filter((name) => !name.endsWith(".pending")).sort();
  let exportedRevision = 0;
  const records = [];
  for (const name of names2) {
    if (name !== basename3(name) || lstatSync2(join2(sessionDirectory, name)).isSymbolicLink())
      throw new Error("unsafe-mirror-entry");
    const data = readFileSync2(join2(sessionDirectory, name), "utf8");
    if (name === "watermark.json") {
      const watermark = JSON.parse(data);
      if (watermark.version !== 1 || watermark.sessionId !== sessionId)
        throw new Error("mirror-watermark-identity");
      exportedRevision = safe(watermark.exportedRevision);
      continue;
    }
    if (!/^seq-\d{12}\.json$/.test(name))
      throw new Error("unexpected-mirror-entry");
    const record = JSON.parse(data);
    if (record.version !== 1 || record.sessionId !== sessionId || seqName(record.seq) !== name)
      throw new Error("mirror-record-identity");
    if (rowsDigest(record.rows) !== record.rowsSha256)
      throw new Error("mirror-record-digest");
    records.push(record);
  }
  records.sort((a, b) => a.seq - b.seq);
  if (records.some((record, index) => record.seq !== index + 1))
    throw new Error("mirror-sequence-hole");
  if (exportedRevision > records.length)
    throw new Error("mirror-watermark-past-records");
  return { exportedRevision, records };
}
var seqName = (seq) => `seq-${String(safe(seq)).padStart(12, "0")}.json`;
var init_authoritative = __esm(() => {
  init_codec();
  init_coordinator();
  init_transfer();
  init_rehearsal();
});

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
`;

// src/sqlite-history/store.ts
var exports_store = {};
__export(exports_store, {
  prepareFile: () => prepareFile,
  HistoryStore: () => HistoryStore
});
import { chmodSync as chmodSync3, existsSync as existsSync2, lstatSync as lstatSync3, mkdirSync as mkdirSync3, openSync as openSync3, closeSync as closeSync3, fsyncSync as fsyncSync3 } from "node:fs";
import { dirname as dirname2, resolve as resolve2 } from "node:path";
import { randomUUID as randomUUID5 } from "node:crypto";
import { parseReplayJournal as parseReplayJournal3 } from "../core/index.js";

class HistoryStore {
  db;
  options;
  closed = false;
  fence = 0;
  chain = Promise.resolve();
  faults = new Map;
  startedAt = Date.now();
  listeners = new Set;
  constructor(db, options) {
    this.db = db;
    this.options = options;
    db.exec("PRAGMA busy_timeout=250; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL;");
    const mode = db.query("PRAGMA journal_mode=WAL").get();
    if (mode.journal_mode !== "wal" || this.pragma("synchronous") !== 2 || this.pragma("foreign_keys") !== 1 || this.pragma("busy_timeout") !== 250)
      throw new Error("pragma-verification");
    db.transaction(() => {
      const version = this.pragma("user_version");
      if (version > SCHEMA_VERSION)
        throw new Error("future-schema");
      if (version === 0) {
        if (db.query("SELECT name FROM sqlite_master WHERE type='table'").all().length)
          throw new Error("foreign-database");
        db.exec(SCHEMA);
        db.exec(GUARDS);
        db.exec(`PRAGMA user_version=${SCHEMA_VERSION}`);
      }
      const epoch = this.pragma("application_id");
      if (epoch < 0 || epoch >= 2147483647)
        throw new Error("writer-fence-exhausted");
      this.fence = epoch + 1;
      db.exec(`PRAGMA application_id=${this.fence}`);
      db.query("UPDATE history_session SET writer_fence=?").run(this.fence);
    }).immediate();
  }
  get file() {
    return this.options.file;
  }
  pragma(name) {
    return Object.values(this.db.query(`PRAGMA ${name}`).get())[0];
  }
  checkOwner() {
    if (this.closed)
      throw new Error("store-closed");
    if (this.pragma("application_id") !== this.fence)
      throw new Error("stale-fence");
  }
  session(sid) {
    const s = this.db.query("SELECT * FROM history_session WHERE session_id=?").get(sid);
    if (!s)
      throw new Error("unknown-session");
    for (const n of [s.revision, s.writer_fence, s.first_line, s.next_line, s.live_start])
      safe(n);
    return s;
  }
  context(s) {
    return { sessionId: s.session_id, revision: s.revision, firstLine: s.first_line, liveStart: s.live_start, nextLine: s.next_line, continuity: s.continuity };
  }
  report(sid, detector, expected, observed, missing = null) {
    const fault = { issue_id: randomUUID5(), sessionId: sid, detector, expected, observed, timestamp: Date.now(), missing_count: missing };
    this.faults.set(sid, fault);
    try {
      this.options.onFault?.(fault);
    } catch (error) {
      console.error("[thumbmux/sqlite] fault-sink-failed", String(error));
    }
    console.error("[thumbmux/sqlite]", JSON.stringify(fault));
    return fault;
  }
  issue(fault, seq = null) {
    this.db.query(`INSERT INTO history_issue VALUES (?,?,?,?,?,?,?,?,NULL)`).run(fault.issue_id, fault.sessionId, seq, fault.detector, fault.timestamp, null, fault.missing_count, JSON.stringify(fault));
  }
  persistFault(sid, detector, expected, observed) {
    const fault = this.report(sid, detector, expected, observed);
    try {
      this.db.transaction(() => {
        this.checkOwner();
        this.issue(fault);
      }).immediate();
    } catch {}
    return fault;
  }
  async write(sid, operation) {
    const work = this.chain.then(async () => {
      for (let attempt = 0;; attempt++) {
        try {
          return this.db.transaction(() => {
            this.checkOwner();
            return operation();
          }).immediate();
        } catch (error) {
          if (error.code === "SQLITE_BUSY" && attempt < 2) {
            await new Promise((r) => setTimeout(r, 10 * (attempt + 1)));
            continue;
          }
          this.report(sid, "write-failed", "committed transaction", String(error));
          throw error;
        }
      }
    });
    this.chain = work.catch(() => {});
    return work;
  }
  async register(input) {
    return this.write("", () => {
      if (!input.name || !input.lifecycleKey)
        throw new Error("invalid-session-identity");
      const old = this.db.query("SELECT * FROM history_session WHERE lifecycle_key=?").get(input.lifecycleKey);
      if (old) {
        if (!old.active)
          throw new Error("retired-lifecycle");
        return old.session_id;
      }
      const sid = randomUUID5(), floor = safe(input.firstLine ?? 0);
      this.db.query(`INSERT INTO history_session(session_id,lifecycle_key,name,group_label,active,writer_fence,first_line,next_line,live_start)
        VALUES (?,?,?,?,1,?,?,?,?)`).run(sid, input.lifecycleKey, input.name, input.group ?? "_ungrouped", this.fence, floor, floor, floor);
      return sid;
    });
  }
  ticket(sid, requestId = randomUUID5()) {
    this.checkOwner();
    const s = this.session(sid);
    if (!s.active)
      throw new Error("session-closed");
    return { sessionId: sid, lifecycleKey: s.lifecycle_key, fence: this.fence, revision: s.revision, requestId };
  }
  capture(sid, seq) {
    const c = this.db.query("SELECT * FROM history_capture WHERE session_id=? AND seq=?").get(sid, seq);
    if (!c)
      throw new Error("missing-receipt");
    return c;
  }
  receipt(sid, c) {
    return { context: {
      sessionId: sid,
      revision: c.seq,
      firstLine: c.first_line,
      liveStart: c.live_start,
      nextLine: c.next_line,
      continuity: "unknown"
    }, requestId: c.request_id, screen: JSON.parse(c.screen_json), geometry: JSON.parse(c.geometry_json), rowsSha256: c.rows_sha256 };
  }
  rows(sid, start, end) {
    return this.db.query("SELECT line_no,kind,text FROM history_line WHERE session_id=? AND line_no>=? AND line_no<? ORDER BY line_no").all(sid, start, end);
  }
  shadowSnapshot(sid, requestId) {
    return this.db.transaction(() => {
      const c = this.db.query("SELECT * FROM history_capture WHERE session_id=? AND request_id=?").get(sid, requestId);
      if (!c)
        throw new Error("shadow-sqlite-receipt-missing");
      const frames = this.db.query("SELECT record_json FROM history_frame WHERE session_id=? AND capture_seq=? ORDER BY frame_seq").all(sid, c.seq);
      return {
        requestId: c.request_id,
        revision: c.seq,
        rows: this.rows(sid, c.row_start, c.row_end),
        frames: frames.map((frame, ordinal) => ({ ordinal, bytes: frame.record_json })),
        unresolved: c.unresolved_capture ? [{ ordinal: 0, sha256: sha(c.unresolved_capture) }] : []
      };
    })();
  }
  tail(sid, count = 40) {
    const s = this.session(sid);
    return this.rows(sid, Math.max(s.first_line, s.next_line - count), s.next_line);
  }
  async commit(batch, checkpoint) {
    validateObservation(batch.observation);
    safe(batch.liveLineLimit);
    const frozen = structuredClone(batch);
    const requestDigest = sha(JSON.stringify({ ...frozen, ticket: { ...frozen.ticket, revision: 0, fence: 0 } }));
    const sid = frozen.ticket.sessionId;
    return this.write(sid, () => {
      const s = this.session(sid), t = frozen.ticket;
      if (t.fence !== this.fence || t.lifecycleKey !== s.lifecycle_key || !s.active)
        throw new Error("stale-fence-or-incarnation");
      const previous = this.db.query("SELECT * FROM history_capture WHERE session_id=? AND request_id=?").get(sid, t.requestId);
      if (previous) {
        if (JSON.parse(previous.evidence_json).requestDigest !== requestDigest)
          throw new Error("retry-conflict");
        checkpoint?.();
        return this.receipt(sid, previous);
      }
      if (s.revision !== t.revision)
        throw new Error("stale-revision");
      const seq = safe(s.revision + 1), start = s.next_line, end = safe(start + frozen.appended.length);
      const rows = frozen.appended.map((r, i) => ({ ...r, line_no: start + i }));
      if (rows.some((r) => !["terminal", "gap"].includes(r.kind) || typeof r.text !== "string" || !r.text.isWellFormed()))
        throw new Error("invalid-row");
      const screen = frozen.observation.screen;
      const b = frozen.observation.geometry.kind === "legacy-window" ? end : Math.max(s.first_line, end - Math.max(0, frozen.liveLineLimit - screen.length));
      const digest = rowsDigest(rows);
      const evidence = { ...frozen.evidence, requestDigest };
      this.db.query(`INSERT INTO history_capture VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(sid, seq, t.requestId, s.revision, frozen.observation.at, JSON.stringify(frozen.observation.geometry), JSON.stringify(screen), start, end, s.first_line, b, end, rows.length, digest, JSON.stringify(evidence), frozen.unresolved ?? null);
      const insert = this.db.query("INSERT INTO history_line VALUES (?,?,?,?,?,?)");
      rows.forEach((r, i) => insert.run(sid, r.line_no, r.kind, r.text, seq, i));
      if (rowsDigest(this.rows(sid, start, end)) !== digest)
        throw new Error("batch-hash");
      if (frozen.frame)
        this.insertFrame(sid, frozen.frame, seq);
      else if (frozen.recordFrames) {
        const first = this.db.query("SELECT record_json FROM history_frame WHERE session_id=? ORDER BY frame_seq LIMIT 1").get(sid);
        const channel = first ? JSON.parse(first.record_json).session : s.name;
        const frame = { channel, type: "output", data: this.rows(sid, b, end).map((r) => r.text).concat(screen).join(`
`) };
        if (Object.hasOwn(frozen.observation.geometry, "cursor"))
          frame.cursor = frozen.observation.geometry.cursor;
        const record = { v: 1, session: channel, at: frozen.observation.at, frame };
        const size = Buffer.byteLength(JSON.stringify(record)) + 1;
        const sessionBytes = this.db.query("SELECT coalesce(sum(length(CAST(record_json AS BLOB))+1),0) AS bytes FROM history_frame WHERE session_id=?").get(sid);
        const rootBytes = this.db.query("SELECT coalesce(sum(length(CAST(record_json AS BLOB))+1),0) AS bytes FROM history_frame").get();
        if (sessionBytes.bytes + size > (frozen.recordingSessionBytes ?? 64 * 1024 * 1024) || rootBytes.bytes + size > (frozen.recordingRootBytes ?? 256 * 1024 * 1024)) {
          this.issue(this.report(sid, "recording-limit", "v1 bytes within session/root admission cap", { session: sessionBytes.bytes + size, root: rootBytes.bytes + size }), seq);
        } else
          this.insertFrame(sid, record, seq);
      }
      const f = this.report(sid, "source-unknown", "source evidence covering the observation interval", evidence.classification);
      this.issue(f, seq);
      this.db.query(`UPDATE history_session SET revision=?,live_start=?,last_probe_at=?,last_commit_at=?,continuity='unknown'
        WHERE session_id=?`).run(seq, b, Date.now(), Date.now(), sid);
      checkpoint?.();
      return this.receipt(sid, this.capture(sid, seq));
    });
  }
  insertFrame(sid, input, captureSeq) {
    const s = this.session(sid);
    const last = this.db.query("SELECT frame_seq,at FROM history_frame WHERE session_id=? ORDER BY frame_seq DESC LIMIT 1").get(sid);
    if (!Number.isFinite(input.at))
      throw new Error("invalid-frame-time");
    const record = { ...structuredClone(input), at: Math.max(last?.at ?? -Infinity, input.at) };
    const first = this.db.query("SELECT record_json FROM history_frame WHERE session_id=? ORDER BY frame_seq LIMIT 1").get(sid);
    const channel = first ? JSON.parse(first.record_json).session : s.name;
    if (record.session !== channel || record.frame.channel !== channel)
      throw new Error("frame-session");
    const full = this.db.query("SELECT frame_seq FROM history_frame WHERE session_id=? AND kind='output' ORDER BY frame_seq DESC LIMIT 1").get(sid);
    const preceding = full && record.frame.type === "delta" ? this.db.query("SELECT record_json FROM history_frame WHERE session_id=? AND frame_seq>=? ORDER BY frame_seq").all(sid, full.frame_seq) : [];
    if (record.frame.type === "delta" && preceding.length > 64)
      throw new Error("frame-cadence");
    const line = JSON.stringify(record);
    parseReplayJournal3([...preceding.map((r) => r.record_json), line].join(`
`) + `
`);
    this.db.query("INSERT INTO history_frame VALUES (?,?,?,?,?,?)").run(sid, safe((last?.frame_seq ?? 0) + 1), record.at, record.frame.type, line, captureSeq);
  }
  async rename(sid, name, group) {
    await this.write(sid, () => {
      if (!name)
        throw new Error("invalid-name");
      this.db.query("UPDATE history_session SET name=?,group_label=? WHERE session_id=?").run(name, group ?? this.session(sid).group_label, sid);
    });
  }
  async closeSession(sid) {
    await this.write(sid, () => {
      this.db.query("UPDATE history_session SET active=0 WHERE session_id=?").run(sid);
    });
  }
  snapshot(sid) {
    return this.db.transaction(() => {
      const s = this.session(sid), c = this.capture(sid, s.revision);
      const live = this.rows(sid, s.live_start, s.next_line);
      this.checkRange(sid, live, s.live_start, s.next_line);
      return { ...this.receipt(sid, c), live };
    })();
  }
  checkRange(sid, rows, start, end) {
    if (rows.length !== end - start || rows.some((r, i) => r.line_no !== start + i)) {
      this.persistFault(sid, "storage-hole", { start, end, count: end - start }, { count: rows.length, ids: rows.slice(0, 5).map((r) => r.line_no) });
      throw new Error("history-unavailable:storage-hole");
    }
  }
  page(sid, direction, anchor, limit, context) {
    safe(limit);
    if (!limit || limit > 2000)
      throw new Error("invalid-page-limit");
    if (anchor !== null)
      safe(anchor);
    try {
      return this.db.transaction(() => {
        const s = this.session(sid);
        const ctx = context ?? this.context(s);
        if (ctx.sessionId !== sid || ctx.revision > s.revision)
          throw new Error("context-mismatch");
        if (!ctx.revision && (ctx.firstLine !== s.first_line || ctx.liveStart !== s.first_line || ctx.nextLine !== s.first_line || ctx.continuity !== "unknown"))
          throw new Error("context-mismatch");
        if (ctx.revision) {
          const c = this.capture(sid, ctx.revision);
          if (c.first_line !== ctx.firstLine || c.live_start !== ctx.liveStart || c.next_line !== ctx.nextLine)
            throw new Error("context-mismatch");
        }
        const end = direction === "before" ? Math.max(s.first_line, Math.min(anchor ?? ctx.liveStart, ctx.liveStart, ctx.nextLine)) : Math.min(ctx.liveStart, Math.max(s.first_line, anchor === null ? s.first_line : safe(anchor + 1)) + limit);
        const start = direction === "before" ? Math.max(s.first_line, end - limit) : Math.min(end, Math.max(s.first_line, anchor === null ? s.first_line : safe(anchor + 1)));
        const rows = direction === "before" ? this.db.query("SELECT line_no,kind,text FROM history_line WHERE session_id=? AND line_no>=? AND line_no<? ORDER BY line_no DESC LIMIT ?").all(sid, s.first_line, end, limit).reverse() : this.rows(sid, start, end);
        this.checkRange(sid, rows, start, end);
        return { context: ctx, rows, startLine: start, endLine: end, hasMore: direction === "before" ? start > s.first_line : end < ctx.liveStart };
      })();
    } catch (error) {
      this.persistFault(sid, "read-unavailable", "consistent revision/range", String(error));
      throw error;
    }
  }
  audit(sid, afterSeq = 0) {
    let captures = 0, rows = 0;
    try {
      return this.db.transaction(() => {
        const s = this.session(sid);
        if (s.revision) {
          const last = this.capture(sid, s.revision);
          if (last.first_line !== s.first_line || last.live_start !== s.live_start || last.next_line !== s.next_line)
            throw new Error("receipt-boundary");
        }
        for (let seq = afterSeq + 1;seq <= s.revision; seq++) {
          const c = this.capture(sid, seq), batch = this.rows(sid, c.row_start, c.row_end);
          this.checkRange(sid, batch, c.row_start, c.row_end);
          if (batch.length !== c.expected_rows || rowsDigest(batch) !== c.rows_sha256)
            throw new Error("batch-hash");
          captures++;
          rows += batch.length;
        }
        return { captures, rows };
      })();
    } catch (error) {
      this.persistFault(sid, "integrity-audit", "receipt counts and byte digests", String(error));
      throw error;
    }
  }
  health(sid) {
    const s = this.session(sid);
    return {
      sessionId: sid,
      startedAt: this.startedAt,
      lastProbeAt: s.last_probe_at,
      lastCommitAt: s.last_commit_at,
      continuity: s.continuity,
      revision: s.revision,
      fault: this.faults.get(sid) ?? null
    };
  }
  addDrain(drain) {
    this.listeners.add(drain);
  }
  async close() {
    for (const drain of this.listeners)
      await drain();
    await this.chain;
    this.closed = true;
    this.db.close();
  }
}
function prepareFile(file) {
  const path = resolve2(file), dir = dirname2(path);
  if (!existsSync2(dir))
    mkdirSync3(dir, { recursive: true, mode: 448 });
  const d = lstatSync3(dir);
  if (!d.isDirectory() || (d.mode & 63) !== 0 || d.uid !== process.getuid?.())
    throw new Error("history-directory-must-be-private");
  for (const p of [path, path + "-wal", path + "-shm"]) {
    if (existsSync2(p)) {
      const st = lstatSync3(p);
      if (!st.isFile() || st.nlink !== 1 || st.uid !== process.getuid?.())
        throw new Error("unsafe-history-file");
      chmodSync3(p, 384);
    }
  }
  if (!existsSync2(path)) {
    const fd = openSync3(path, "wx", 384);
    try {
      fsyncSync3(fd);
    } finally {
      closeSync3(fd);
    }
    const parent = openSync3(dir, "r");
    try {
      fsyncSync3(parent);
    } finally {
      closeSync3(parent);
    }
  }
  return path;
}
var init_store = __esm(() => {
  init_codec();
});

// src/sqlite-history/rollout.ts
var exports_rollout = {};
__export(exports_rollout, {
  runRestoreDrill: () => runRestoreDrill,
  auditBackupCoverage: () => auditBackupCoverage,
  assessGroupReadiness: () => assessGroupReadiness,
  HistoryRolloutAllowlist: () => HistoryRolloutAllowlist
});
import {
  chmodSync as chmodSync4,
  closeSync as closeSync4,
  existsSync as existsSync3,
  fsyncSync as fsyncSync4,
  lstatSync as lstatSync4,
  mkdirSync as mkdirSync4,
  openSync as openSync4,
  readFileSync as readFileSync3,
  readdirSync as readdirSync3,
  renameSync as renameSync3,
  rmSync,
  writeFileSync as writeFileSync3
} from "node:fs";
import { basename as basename4, join as join3, resolve as resolve3 } from "node:path";
import { randomUUID as randomUUID6 } from "node:crypto";
function syncDirectory2(path) {
  const fd = openSync4(path, "r");
  try {
    fsyncSync4(fd);
  } finally {
    closeSync4(fd);
  }
}
function privateDirectory2(path) {
  const directory = resolve3(path);
  if (!existsSync3(directory))
    mkdirSync4(directory, { recursive: true, mode: 448 });
  const stat = lstatSync4(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 63) !== 0) {
    throw new Error("rollout-directory-must-be-private");
  }
  return directory;
}
function durableReplace2(directory, name, data) {
  const temporary = join3(directory, `.${name}-${randomUUID6()}.pending`);
  const fd = openSync4(temporary, "wx", 384);
  try {
    writeFileSync3(fd, data);
    fsyncSync4(fd);
  } finally {
    closeSync4(fd);
  }
  renameSync3(temporary, join3(directory, name));
  chmodSync4(join3(directory, name), 384);
  syncDirectory2(directory);
}
function digestFile(path) {
  const stat = lstatSync4(path);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error("unsafe-legacy-artifact");
  const bytes = readFileSync3(path);
  return { path: resolve3(path), bytes: bytes.length, sha256: sha(bytes) };
}
async function assessGroupReadiness(store, group, mirrorDirectory) {
  const sessions = store.db.query("SELECT session_id FROM history_session WHERE group_label=? ORDER BY session_id").all(group).map((row) => row.session_id);
  const sourcePaths = [];
  let sourceCount = 0;
  const faultProbeIds = [];
  const watermarks = [];
  for (const sessionId of sessions) {
    const imports = store.db.query("SELECT * FROM history_import WHERE session_id=? ORDER BY source_id").all(sessionId);
    for (const row of imports) {
      if (row.state !== "verified")
        continue;
      readSeal(row.source_path);
      sourcePaths.push(row.source_path);
      sourceCount += safe(row.imported_records);
    }
    const probe = store.persistFault(sessionId, "rollout-fault-probe", "fault probe persisted and read back from history_issue", { group, at: Date.now() });
    const landed = store.db.query("SELECT issue_id FROM history_issue WHERE issue_id=?").get(probe.issue_id);
    if (!landed)
      throw new Error("rollout-fault-probe-not-persisted");
    faultProbeIds.push(landed.issue_id);
    const mirror = readMirror(mirrorDirectory, sessionId);
    watermarks.push({ sessionId, exportedRevision: mirror.exportedRevision, targetRevision: store.session(sessionId).revision });
  }
  return { group, sourceCount, expectedSessions: sessions, sourcePaths, faultProbeIds, watermarks, assessedAt: Date.now() };
}

class HistoryRolloutAllowlist {
  store;
  directory;
  mirrorDirectory;
  declared;
  states = new Map;
  retirements = new Map;
  constructor(store, options) {
    this.store = store;
    this.directory = privateDirectory2(options.directory);
    this.mirrorDirectory = resolve3(options.mirrorDirectory);
    this.declared = new Set(options.declaredGroups);
    if (!this.declared.size)
      throw new Error("rollout-empty-roster");
    for (const name of readdirSync3(this.directory).sort()) {
      if (name.endsWith(".pending"))
        continue;
      if (name !== basename4(name) || lstatSync4(join3(this.directory, name)).isSymbolicLink())
        throw new Error("unsafe-rollout-entry");
      const record = JSON.parse(readFileSync3(join3(this.directory, name), "utf8"));
      if (record.version !== 1)
        throw new Error("future-rollout-record");
      if (name === `group-${sha(record.group)}.json` && "state" in record)
        this.states.set(record.group, record);
      else if (name === `retire-${sha(record.group)}.json` && "artifacts" in record)
        this.retirements.set(record.group, record);
      else
        throw new Error("unexpected-rollout-entry");
    }
  }
  route(group) {
    if (!this.declared.has(group))
      return "legacy";
    return this.states.get(group)?.state === "enabled" ? "sqlite-authoritative" : "legacy";
  }
  routeSession(sessionId) {
    const group = this.store.session(sessionId).group_label;
    if (this.route(group) !== "sqlite-authoritative")
      return "legacy";
    const enrolled = this.states.get(group)?.evidence?.expectedSessions ?? [];
    return enrolled.includes(sessionId) ? "sqlite-authoritative" : "legacy";
  }
  refuse(group, reason, observed) {
    this.store.persistFault("", "rollout-refused", reason, { group, observed });
    throw new Error(`rollout-refused:${reason}`);
  }
  observeMirror(group, sessionId) {
    const sessionMirror = join3(this.mirrorDirectory, sha(sessionId));
    if (!existsSync3(sessionMirror))
      this.refuse(group, "mirror-missing", { sessionId, directory: sessionMirror });
    try {
      return readMirror(this.mirrorDirectory, sessionId);
    } catch (error) {
      this.refuse(group, "mirror-unreadable", { sessionId, error: String(error) });
    }
  }
  rosterOf(group, evidence) {
    const members = this.store.db.query("SELECT session_id FROM history_session WHERE group_label=? ORDER BY session_id").all(group).map((row) => row.session_id);
    if (!members.length)
      this.refuse(group, "no-expected-sessions", 0);
    return [...new Set([...members, ...evidence.expectedSessions])].sort();
  }
  enableGroup(evidence) {
    const group = evidence.group;
    if (!this.declared.has(group))
      this.refuse(group, "group-not-declared", group);
    if (!evidence.expectedSessions.length)
      this.refuse(group, "no-expected-sessions", 0);
    if (!evidence.sourcePaths.length)
      this.refuse(group, "no-source-paths", 0);
    if (!evidence.faultProbeIds.length)
      this.refuse(group, "no-fault-probes", 0);
    const roster = this.rosterOf(group, evidence);
    let recount = 0;
    for (const sessionId of roster) {
      const session = this.store.session(sessionId);
      if (session.group_label !== group)
        this.refuse(group, "session-outside-group", { sessionId, group_label: session.group_label });
      if (!(session.revision > 0))
        this.refuse(group, "session-without-receipts", { sessionId, revision: session.revision });
      const imports = this.store.db.query("SELECT * FROM history_import WHERE session_id=?").all(sessionId);
      if (imports.some((row) => row.state === "quarantined"))
        this.refuse(group, "quarantined-source", sessionId);
      recount += imports.filter((row) => row.state === "verified").reduce((total, row) => total + safe(row.imported_records), 0);
    }
    if (!(recount > 0) || recount !== evidence.sourceCount)
      this.refuse(group, "empty-or-stale-source-count", { claimed: evidence.sourceCount, stored: recount });
    for (const path of evidence.sourcePaths)
      readSeal(path);
    for (const issueId of evidence.faultProbeIds) {
      const landed = this.store.db.query("SELECT issue_id FROM history_issue WHERE issue_id=?").get(issueId);
      if (!landed)
        this.refuse(group, "fault-probe-unknown", issueId);
    }
    for (const sessionId of roster) {
      const claimed = evidence.watermarks.find((mark) => mark.sessionId === sessionId);
      if (!claimed)
        this.refuse(group, "watermark-missing", sessionId);
      const revision = this.store.session(sessionId).revision;
      const observed = this.observeMirror(group, sessionId);
      if (observed.exportedRevision !== revision) {
        this.refuse(group, "watermark-behind-writer", { sessionId, observed: observed.exportedRevision, revision });
      }
      if (claimed.exportedRevision !== observed.exportedRevision || claimed.targetRevision !== revision) {
        this.refuse(group, "watermark-behind-writer", { sessionId, claimed, revision });
      }
    }
    const state = {
      version: 1,
      group,
      state: "enabled",
      evidence: { ...evidence, expectedSessions: roster },
      changedAt: Date.now()
    };
    durableReplace2(this.directory, `group-${sha(group)}.json`, JSON.stringify(state));
    this.states.set(group, state);
    return state;
  }
  disableGroup(group) {
    const state = { version: 1, group, state: "disabled", evidence: this.states.get(group)?.evidence ?? null, changedAt: Date.now() };
    durableReplace2(this.directory, `group-${sha(group)}.json`, JSON.stringify(state));
    this.states.set(group, state);
    return state;
  }
  retireLegacyWriter(group, legacyArtifacts) {
    if (this.route(group) !== "sqlite-authoritative")
      this.refuse(group, "retire-requires-enabled-group", this.route(group));
    if (!legacyArtifacts.length)
      this.refuse(group, "retire-without-artifact-ledger", 0);
    const receipt = {
      version: 1,
      group,
      retiredAt: Date.now(),
      artifacts: legacyArtifacts.map((path) => digestFile(path))
    };
    durableReplace2(this.directory, `retire-${sha(group)}.json`, JSON.stringify(receipt));
    this.retirements.set(group, receipt);
    return receipt;
  }
  retirement(group) {
    return this.retirements.get(group) ?? null;
  }
  wrapLegacyWriter(writer) {
    return {
      write: async (projection) => {
        const group = this.store.session(projection.sessionId).group_label;
        if (this.retirements.has(group)) {
          this.store.persistFault(projection.sessionId, "legacy-writer-retired", "no legacy capture writes after retirement", { group, requestId: projection.requestId });
          throw new Error("legacy-writer-retired");
        }
        return writer.write(projection);
      }
    };
  }
  verifyLegacyWriterSilence(group) {
    const receipt = this.retirements.get(group);
    if (!receipt)
      throw new Error("rollout-not-retired");
    for (const recorded of receipt.artifacts) {
      let observed;
      try {
        observed = digestFile(recorded.path);
      } catch (error) {
        this.store.persistFault("", "legacy-writer-overwrite", recorded, { group, error: String(error) });
        throw new Error("legacy-artifact-missing");
      }
      if (observed.bytes !== recorded.bytes || observed.sha256 !== recorded.sha256) {
        this.store.persistFault("", "legacy-writer-overwrite", recorded, { group, observed });
        throw new Error("legacy-writer-overwrite");
      }
    }
    return { group, artifacts: receipt.artifacts.length, verifiedAt: Date.now() };
  }
}
async function runRestoreDrill(bundleDirectory, scratchDirectory) {
  const startedAt = Date.now();
  const { Database } = await import("bun:sqlite");
  const { HistoryStore: HistoryStore2, prepareFile: prepareFile2 } = await Promise.resolve().then(() => (init_store(), exports_store));
  const scratch = privateDirectory2(scratchDirectory);
  const workspace = join3(scratch, `drill-${randomUUID6()}`);
  mkdirSync4(workspace, { mode: 448 });
  const file = prepareFile2(join3(workspace, "restore-drill.db"));
  const store = new HistoryStore2(new Database(file, { strict: true }), { file });
  try {
    const sessionId = await restoreHistoryBundle(store, bundleDirectory);
    store.audit(sessionId);
    const session = store.session(sessionId);
    const restored = store.rows(sessionId, session.first_line, session.next_line);
    store.checkRange(sessionId, restored, session.first_line, session.next_line);
    const compare = (oracle, label) => {
      if (oracle.length !== restored.length)
        throw new Error(`drill-${label}-count`);
      for (let index = 0;index < restored.length; index++) {
        if (oracle[index].line_no !== restored[index].line_no || Buffer.compare(Buffer.from(oracle[index].text, "utf8"), Buffer.from(restored[index].text, "utf8")) !== 0) {
          throw new Error(`drill-${label}-bytes`);
        }
      }
    };
    compare(readSealedHistoryOracle(bundleDirectory, "file-jsonl").rows, "jsonl");
    if (restored.length)
      compare(readSealedHistoryOracle(bundleDirectory, "durable-log").rows, "log");
    const frames = store.db.query("SELECT record_json FROM history_frame WHERE session_id=? ORDER BY frame_seq").all(sessionId);
    if (frames.length) {
      const oracleFrames = readSealedHistoryOracle(bundleDirectory, "frame-ndjson").frames;
      if (oracleFrames.length !== frames.length || oracleFrames.some((frame, index) => JSON.stringify(frame) !== frames[index].record_json)) {
        throw new Error("drill-frame-bytes");
      }
    }
    return { sessionId, rows: restored.length, frames: frames.length, rowsSha256: rowsDigest(restored), startedAt, completedAt: Date.now() };
  } finally {
    await store.close();
    rmSync(workspace, { recursive: true, force: true });
  }
}
function auditBackupCoverage(store, mirrorDirectory) {
  const startedAt = Date.now();
  const sessions = store.db.query("SELECT session_id,group_label,revision,continuity FROM history_session ORDER BY session_id").all();
  const entries = [];
  for (const row of sessions) {
    let storage = "verified";
    try {
      store.audit(row.session_id);
    } catch {
      storage = "failed";
    }
    let mirror = { targetRevision: row.revision, exportedRevision: 0, caughtUp: false };
    try {
      const observed = readMirror(mirrorDirectory, row.session_id);
      mirror = { targetRevision: row.revision, exportedRevision: observed.exportedRevision, caughtUp: observed.exportedRevision === row.revision };
    } catch {
      storage = "failed";
    }
    const importRows = store.db.query("SELECT state FROM history_import WHERE session_id=?").all(row.session_id);
    const imports = !importRows.length ? "none" : importRows.some((value) => value.state === "quarantined") ? "quarantined" : importRows.every((value) => value.state === "verified") ? "verified" : "incomplete";
    const coverage = storage === "failed" || row.continuity === "gap" || row.continuity === "failed" || imports === "quarantined" ? "failed" : row.continuity === "verified" && mirror.caughtUp && imports !== "incomplete" ? "preserved" : "unknown";
    entries.push({ sessionId: row.session_id, group: row.group_label, storage, mirror, imports, source: row.continuity, coverage });
  }
  const totals = { preserved: 0, unknown: 0, failed: 0 };
  for (const entry of entries)
    totals[entry.coverage]++;
  return { startedAt, completedAt: Date.now(), sessions: entries, totals };
}
var init_rollout = __esm(() => {
  init_codec();
  init_authoritative();
  init_transfer();
  init_rehearsal();
});

// src/sqlite-history/bridge.ts
var exports_bridge = {};
__export(exports_bridge, {
  legacyProjectionDigest: () => legacyProjectionDigest,
  OptInHistoryBridge: () => OptInHistoryBridge
});
import {
  chmodSync as chmodSync5,
  closeSync as closeSync5,
  existsSync as existsSync4,
  fsyncSync as fsyncSync5,
  lstatSync as lstatSync5,
  mkdirSync as mkdirSync5,
  openSync as openSync5,
  readFileSync as readFileSync4,
  readdirSync as readdirSync4,
  renameSync as renameSync4,
  writeFileSync as writeFileSync4
} from "node:fs";
import { basename as basename5, join as join4, resolve as resolve4 } from "node:path";
import { randomUUID as randomUUID7 } from "node:crypto";
function syncDirectory3(path) {
  const fd = openSync5(path, "r");
  try {
    fsyncSync5(fd);
  } finally {
    closeSync5(fd);
  }
}
function privateDirectory3(path) {
  const directory = resolve4(path);
  if (!existsSync4(directory))
    mkdirSync5(directory, { recursive: true, mode: 448 });
  const stat = lstatSync5(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 63) !== 0) {
    throw new Error("bridge-spool-must-be-private");
  }
  return directory;
}
function projection(batch) {
  return {
    requestId: batch.ticket.requestId,
    sessionId: batch.ticket.sessionId,
    rows: structuredClone(batch.appended),
    screen: structuredClone(batch.observation.screen),
    raw: structuredClone(batch.observation.raw),
    geometry: structuredClone(batch.observation.geometry),
    source: structuredClone(batch.observation.source),
    at: batch.observation.at,
    ...batch.frame ? { frame: structuredClone(batch.frame) } : {}
  };
}
function legacyProjectionDigest(value) {
  return sha(JSON.stringify(value));
}
function encodeBatch(batch) {
  const { unresolved, ...rest } = structuredClone(batch);
  return { ...rest, ...unresolved ? { unresolved: Buffer.from(unresolved).toString("base64") } : {} };
}
function decodeBatch(batch) {
  const { unresolved, ...rest } = structuredClone(batch);
  return { ...rest, ...unresolved ? { unresolved: Buffer.from(unresolved, "base64") } : {} };
}

class BridgeSpool {
  directory;
  constructor(directory) {
    this.directory = privateDirectory3(directory);
  }
  path(requestId) {
    return join4(this.directory, `${sha(requestId)}.json`);
  }
  readPath(path) {
    const stat = lstatSync5(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid?.())
      throw new Error("unsafe-bridge-spool-entry");
    const entry = JSON.parse(readFileSync4(path, "utf8"));
    if (entry.version !== 1 || !entry.requestId || basename5(path) !== `${sha(entry.requestId)}.json`)
      throw new Error("invalid-bridge-spool-entry");
    if (entry.digest !== legacyProjectionDigest(projection(decodeBatch(entry.batch))))
      throw new Error("bridge-spool-digest");
    return entry;
  }
  list() {
    return readdirSync4(this.directory).sort().map((name) => {
      if (!/^[a-f0-9]{64}\.json$/.test(name))
        throw new Error("unexpected-bridge-spool-entry");
      return this.readPath(join4(this.directory, name));
    });
  }
  accept(batch) {
    const path = this.path(batch.ticket.requestId), digest = legacyProjectionDigest(projection(batch));
    if (existsSync4(path)) {
      const old = this.readPath(path);
      if (old.sessionId !== batch.ticket.sessionId || old.digest !== digest)
        throw new Error("bridge-request-conflict");
      return old;
    }
    const entry = {
      version: 1,
      requestId: batch.ticket.requestId,
      sessionId: batch.ticket.sessionId,
      digest,
      legacyCommitted: false,
      sqliteCommitted: false,
      sqliteRevision: null,
      batch: encodeBatch(batch)
    };
    this.write(entry, false);
    return entry;
  }
  update(entry) {
    this.write(entry, true);
  }
  write(entry, replace) {
    const target = this.path(entry.requestId), temporary = join4(this.directory, `.${sha(entry.requestId)}-${randomUUID7()}.pending`);
    const fd = openSync5(temporary, "wx", 384);
    try {
      writeFileSync4(fd, JSON.stringify(entry));
      fsyncSync5(fd);
    } finally {
      closeSync5(fd);
    }
    if (!replace && existsSync4(target))
      throw new Error("bridge-spool-race");
    renameSync4(temporary, target);
    chmodSync5(target, 384);
    syncDirectory3(this.directory);
  }
}

class OptInHistoryBridge {
  store;
  options;
  spool;
  coordinator;
  constructor(store, options) {
    this.store = store;
    this.options = options;
    this.spool = new BridgeSpool(options.spoolDirectory);
    this.coordinator = new HistoryCoordinator(store, options, (batch) => this.commit(batch));
  }
  shadow() {
    return "shadow" in this.options ? this.options.shadow : null;
  }
  needsResume(entry) {
    return !entry.legacyCommitted || !entry.sqliteCommitted || !!this.shadow() && !entry.shadowDelivered;
  }
  async commit(input) {
    let entry = this.spool.accept(input);
    const batch = decodeBatch(entry.batch);
    if (!entry.legacyCommitted) {
      const value = projection(batch), acknowledgement = await this.options.legacyProjection.write(structuredClone(value));
      verifyDualWriteAcknowledgement(value, acknowledgement);
      entry = { ...entry, legacyCommitted: true, ...acknowledgement.shadow ? { legacyShadow: structuredClone(acknowledgement.shadow) } : {} };
      this.spool.update(entry);
    }
    const fresh = { ...batch, ticket: this.store.ticket(entry.sessionId, entry.requestId) };
    const receipt = await this.store.commit(fresh);
    if (receipt.requestId !== entry.requestId)
      throw new Error("bridge-sqlite-request-mismatch");
    if (!entry.sqliteCommitted || entry.sqliteRevision !== receipt.context.revision) {
      entry = { ...entry, sqliteCommitted: true, sqliteRevision: receipt.context.revision };
      this.spool.update(entry);
    }
    const shadow = this.shadow();
    if (shadow) {
      if (!entry.legacyShadow)
        throw new Error("shadow-legacy-snapshot-missing");
      if (!entry.shadowCompared) {
        const sqlite = this.store.shadowSnapshot(entry.sessionId, entry.requestId);
        const oracle = shadow.sourceOracle(projection(batch));
        entry = {
          ...entry,
          shadowCompared: true,
          shadowDelivered: entry.shadowDelivered ?? false,
          shadowReport: compareShadowBatch(entry.sessionId, entry.legacyShadow, sqlite, oracle, (shadow.now ?? Date.now)())
        };
        this.spool.update(entry);
      }
      if (!entry.shadowDelivered) {
        await shadow.onComparison(structuredClone(entry.shadowReport));
        entry = { ...entry, shadowDelivered: true };
        this.spool.update(entry);
      }
    }
    return receipt;
  }
  start() {
    if (this.spool.list().some((entry) => this.needsResume(entry)))
      throw new Error("bridge-pending-requires-resume");
    this.coordinator.start();
  }
  async probe(sessionId) {
    const sqlite = await this.coordinator.probe(sessionId);
    const entry = this.spool.list().find((item) => item.requestId === sqlite.requestId);
    if (!entry?.legacyCommitted || !entry.sqliteCommitted)
      throw new Error("bridge-incomplete-receipt");
    return { sqlite, requestId: entry.requestId, digest: entry.digest, legacyCommitted: true, sqliteCommitted: true };
  }
  async resumePending() {
    for (const entry of this.spool.list())
      if (this.needsResume(entry))
        await this.commit(decodeBatch(entry.batch));
    return this.ledger();
  }
  ledger() {
    return this.spool.list().map(({ batch: _batch, version: _version, legacyShadow: _legacyShadow, shadowReport: _shadowReport, ...entry }) => entry);
  }
  stopAndDrain() {
    return this.coordinator.stopAndDrain();
  }
}
var init_bridge = __esm(() => {
  init_codec();
  init_coordinator();
  init_detectors();
});

// src/sqlite-history/reader.ts
var exports_reader = {};
__export(exports_reader, {
  historyReaderRequest: () => historyReaderRequest,
  HistoryReaderCanary: () => HistoryReaderCanary
});

class HistoryReaderCanary {
  store;
  constructor(store) {
    this.store = store;
  }
  coverAt(sid, revision, line) {
    return this.store.db.query("SELECT seq,row_start,row_end,expected_rows,rows_sha256 FROM history_capture WHERE session_id=? AND seq<=? AND row_start<=? ORDER BY seq DESC LIMIT 1").get(sid, revision, line);
  }
  coverFrom(sid, revision, seq) {
    return this.store.db.query("SELECT seq,row_start,row_end,expected_rows,rows_sha256 FROM history_capture WHERE session_id=? AND seq>=? AND seq<=? ORDER BY seq").all(sid, seq, revision);
  }
  verify(sid, revision, rows, start, end) {
    if (start === end)
      throw new Error("verify-empty-range");
    const head = this.coverAt(sid, revision, start);
    if (!head || head.row_end <= start) {
      return {
        status: "unverifiable",
        reason: "range-below-verified-floor",
        coveringCaptures: [],
        detail: { start, end, oldestReceiptRowStart: head ? head.row_start : -1 }
      };
    }
    const covering = [];
    const verified = [];
    let cursor = head.row_start;
    for (const cover of this.coverFrom(sid, revision, head.seq)) {
      if (cover.row_start !== cursor) {
        return {
          status: "unverifiable",
          reason: "covering-receipt-gap",
          coveringCaptures: covering,
          detail: { start, end, expectedRowStart: cursor, observedRowStart: cover.row_start }
        };
      }
      cursor = cover.row_end;
      if (cover.row_end === cover.row_start)
        continue;
      const batch = this.store.rows(sid, cover.row_start, cover.row_end);
      this.store.checkRange(sid, batch, cover.row_start, cover.row_end);
      if (batch.length !== cover.expected_rows || rowsDigest(batch) !== cover.rows_sha256) {
        this.store.persistFault(sid, "reader-batch-digest", { seq: cover.seq, expected_rows: cover.expected_rows, rows_sha256: cover.rows_sha256 }, { rows: batch.length, rows_sha256: rowsDigest(batch) });
        throw new Error("history-unavailable:reader-batch-digest");
      }
      covering.push(cover.seq);
      verified.push(...batch);
      if (cursor >= end)
        break;
    }
    if (cursor < end) {
      return {
        status: "unverifiable",
        reason: "range-above-verified-receipt",
        coveringCaptures: covering,
        detail: { start, end, verifiedThrough: cursor }
      };
    }
    const offset = start - head.row_start;
    const slice = verified.slice(offset, offset + (end - start));
    const rangeMatches = slice.length === rows.length && slice.every((r, i) => r.line_no === rows[i]?.line_no && r.kind === rows[i]?.kind && r.text === rows[i]?.text);
    if (!rangeMatches) {
      this.store.persistFault(sid, "reader-range-digest", { start, end, rows: slice.length, digest: rowsDigest(slice) }, { rows: rows.length, digest: rowsDigest(rows) });
      throw new Error("history-unavailable:reader-range-digest");
    }
    return { status: "verified", coveringCaptures: covering, verifiedRows: verified.length, digests: covering.length };
  }
  page(sid, direction, anchor, limit, context) {
    return this.store.db.transaction(() => {
      const page = this.store.page(sid, direction, anchor, limit, context);
      if (!page.rows.length) {
        return { page, verification: {
          status: "empty",
          reason: direction === "before" ? "at-floor" : "at-live-start",
          coveringCaptures: []
        } };
      }
      return { page, verification: this.verify(sid, page.context.revision, page.rows, page.startLine, page.endLine) };
    })();
  }
  snapshot(sid) {
    return this.store.db.transaction(() => {
      const snapshot = this.store.snapshot(sid);
      const { live, ...receipt } = snapshot;
      const { liveStart, nextLine, revision } = receipt.context;
      const verification = live.length ? this.verify(sid, revision, live, liveStart, nextLine) : { status: "empty", reason: "at-live-start", coveringCaptures: [] };
      return { receipt, live, verification };
    })();
  }
}
async function historyReaderRequest(reader, request) {
  const url = new URL(request.url);
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  if (request.method !== "GET")
    return json(405, { error: "method-not-allowed" });
  const sid = url.searchParams.get("session");
  if (!sid)
    return json(400, { error: "session-required" });
  try {
    if (url.pathname === "/history/snapshot")
      return json(200, reader.snapshot(sid));
    if (url.pathname === "/history/page") {
      const direction = url.searchParams.get("direction");
      if (direction !== "before" && direction !== "after")
        return json(400, { error: "direction-required" });
      const rawAnchor = url.searchParams.get("anchor");
      const anchor = rawAnchor === null || rawAnchor === "" ? null : Number(rawAnchor);
      if (anchor !== null && !Number.isSafeInteger(anchor))
        return json(400, { error: "anchor-invalid" });
      const limit = Number(url.searchParams.get("limit"));
      const rawContext = url.searchParams.get("context");
      let context;
      if (rawContext) {
        try {
          context = JSON.parse(rawContext);
        } catch {
          return json(400, { error: "context-invalid" });
        }
      }
      return json(200, reader.page(sid, direction, anchor, limit, context));
    }
    return json(404, { error: "not-found" });
  } catch (error) {
    const message = String(error instanceof Error ? error.message : error);
    return json(message.includes("context-mismatch") ? 409 : 503, { error: message });
  }
}
var init_reader = __esm(() => {
  init_codec();
});

// src/sqlite-history.ts
init_detectors();
init_transfer();
init_rehearsal();
init_rollout();
async function createSqliteHistoryStore(options) {
  const [{ Database }, { HistoryStore: HistoryStore2, prepareFile: prepareFile2 }, { HistoryCoordinator: HistoryCoordinator2 }, { OptInHistoryBridge: OptInHistoryBridge2 }, transfer, rehearsal, reader, authoritative, rollout] = await Promise.all([
    import("bun:sqlite"),
    Promise.resolve().then(() => (init_store(), exports_store)),
    Promise.resolve().then(() => (init_coordinator(), exports_coordinator)),
    Promise.resolve().then(() => (init_bridge(), exports_bridge)),
    Promise.resolve().then(() => (init_transfer(), exports_transfer)),
    Promise.resolve().then(() => (init_rehearsal(), exports_rehearsal)),
    Promise.resolve().then(() => (init_reader(), exports_reader)),
    Promise.resolve().then(() => (init_authoritative(), exports_authoritative)),
    Promise.resolve().then(() => (init_rollout(), exports_rollout))
  ]);
  const file = prepareFile2(options.file);
  const db = new Database(file, { strict: true, safeIntegers: false });
  let store;
  try {
    store = new HistoryStore2(db, options);
    prepareFile2(file);
  } catch (error) {
    db.close();
    throw error;
  }
  return {
    registerSession: store.register.bind(store),
    renameSession: store.rename.bind(store),
    closeSession: store.closeSession.bind(store),
    createCaptureCoordinator: (o) => new HistoryCoordinator2(store, o),
    createCaptureBridge: (o) => new OptInHistoryBridge2(store, o),
    createShadowBridge: (o) => new OptInHistoryBridge2(store, o),
    createReaderCanary: () => new reader.HistoryReaderCanary(store),
    createAuthoritativeBridge: (o) => new authoritative.AuthoritativeHistoryBridge(store, o),
    createRolloutAllowlist: (o) => new rollout.HistoryRolloutAllowlist(store, o),
    assessGroupReadiness: (group, mirrorDirectory) => rollout.assessGroupReadiness(store, group, mirrorDirectory),
    auditBackupCoverage: (mirrorDirectory) => rollout.auditBackupCoverage(store, mirrorDirectory),
    restoreDrill: (bundleDirectory, scratchDirectory) => rollout.runRestoreDrill(bundleDirectory, scratchDirectory),
    readerRequest: (canary, request) => reader.historyReaderRequest(canary, request),
    snapshot: store.snapshot.bind(store),
    readBefore: (sid, anchor, limit, context) => store.page(sid, "before", anchor, limit, context),
    readAfter: (sid, anchor, limit, context) => store.page(sid, "after", anchor, limit, context),
    audit: store.audit.bind(store),
    health: store.health.bind(store),
    importSnapshot: (input) => transfer.importHistorySnapshot(store, input),
    importProgress: (sourceId) => transfer.readImportProgress(store, sourceId),
    importClosedSession: (input) => rehearsal.importClosedHistorySession(store, input),
    inspectImportedSnapshot: (input) => rehearsal.inspectImportedSnapshot(store, input),
    verifyImportedSnapshot: (input) => rehearsal.verifyImportedSnapshot(store, input),
    exportBundle: (sid, directory) => transfer.exportHistoryBundle(store, sid, directory),
    restoreBundle: (directory) => transfer.restoreHistoryBundle(store, directory),
    close: store.close.bind(store)
  };
}
export {
  verifyHistoryOracle,
  validateHistoryPage,
  sealHistorySnapshot,
  runRestoreDrill,
  readSealedHistoryOracle,
  inspectShadowRuntime,
  inspectImportProgress,
  inspectHistoryMirror,
  inspectHistoryHealth,
  createSqliteHistoryStore,
  compareShadowBatch,
  assertMigrationReady
};
