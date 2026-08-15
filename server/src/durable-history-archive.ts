import { createHash } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { HistoryPage } from "./history-archive";
import { stitchCapture } from "./history-stitch";
import type { HistoryArchiveLike } from "./ws-mux";

/**
 * A durable scrollback archive that two very different readers can use.
 *
 * The viewer needs exact line numbers and fast range reads. A person — or an
 * agent asking what a session was doing before the machine froze — needs to
 * open the file and understand it. So history is stored as plain text, one file
 * line per terminal line, escape sequences intact, in chunks whose filename is
 * their absolute start line:
 *
 *   <root>/<group>/<session>/000000000000.log
 *
 * `cat`, `grep -a` and `sed -n` work on it directly, and `meta.json` /
 * `index.jsonl` are caches — everything in them is recomputable by scanning the
 * directory, so losing one costs a rescan rather than the history.
 *
 * Unlike `FileHistoryArchive`, this one also stores the rows the mux is still
 * serving as live, and reports where that window begins. Those are two
 * different questions — what is durable, and what is already on screen — and
 * conflating them is why a tmux server restart took every session's newest
 * thousand lines with it.
 */

const DEFAULT_CHUNK_LINES = 500;
const DEFAULT_CHUNK_BYTES = 256 * 1024;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const ANCHOR_LINES = 40;
const GAP_MARKER_PREFIX = "⟦thumbmux gap:";

/**
 * A line this system wrote ABOUT the history, not one the terminal produced. It
 * can never appear in a capture, so an anchor containing one can never match —
 * and a failed anchor writes another marker. That loop is not hypothetical.
 */
export function isHistoryMarker(line: string): boolean {
  return line.startsWith(GAP_MARKER_PREFIX);
}

export function historyGapMarker(at: Date): string {
  return `${GAP_MARKER_PREFIX} history before this point could not be joined to what tmux `
    + `still holds · ${at.toISOString()}⟧`;
}

/** The newest contiguous run of real terminal lines in an archived tail. */
export function anchorFromTail(tail: readonly string[], want: number): string[] {
  let end = tail.length;
  while (end > 0 && isHistoryMarker(tail[end - 1]!)) end--;
  let start = end;
  while (start > 0 && !isHistoryMarker(tail[start - 1]!)) start--;
  return tail.slice(Math.max(start, end - want), end);
}

export type ArchiveAppendResult = {
  appended: number;
  /** Absolute archive line where the mux's live window begins. */
  liveStartLine: number;
  totalLines: number;
  gap: boolean;
  deferred: boolean;
};

export type DurableHistoryArchiveOptions = {
  /** Storage root. Every session lives under `<root>/<group>/<session>/`. */
  root: string;
  /** Host label for a session — kemcortex passes the topic. Opaque here. */
  group?: (session: string) => string;
  chunkLines?: number;
  chunkBytes?: number;
};

type Chunk = { file: string; start: number; lines: number; bytes: number };

type SessionState = {
  dir: string;
  chunks: Chunk[];
  totalLines: number;
  liveStart: number;
  disabled: boolean;
};

/**
 * Path-safe and still readable: keep the name unless it had to be changed.
 *
 * `.` and `..` survive character filtering intact — they are made of allowed
 * characters — so they are checked by name. A session called `..` would
 * otherwise resolve one directory up, which is the traversal this guards.
 */
function pathSegment(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
  const reserved = cleaned === "" || cleaned === "." || cleaned === "..";
  if (!reserved && cleaned === value) return cleaned;
  const digest = createHash("sha256").update(value).digest("hex").slice(0, 8);
  return `${reserved ? "session" : cleaned}-${digest}`;
}

function chunkName(startLine: number): string {
  return `${String(startLine).padStart(12, "0")}.log`;
}

function countLines(text: string): number {
  if (text === "") return 0;
  let count = 0;
  for (let index = 0; index < text.length; index++) {
    if (text.charCodeAt(index) === 10) count++;
  }
  return count;
}

export class DurableHistoryArchive implements HistoryArchiveLike {
  private readonly root: string;
  private readonly groupOf: (session: string) => string;
  private readonly chunkLines: number;
  private readonly chunkBytes: number;
  private readonly states = new Map<string, SessionState>();

  constructor(options: DurableHistoryArchiveOptions) {
    this.root = options.root;
    this.groupOf = options.group ?? (() => "_ungrouped");
    this.chunkLines = Math.max(1, Math.floor(options.chunkLines ?? DEFAULT_CHUNK_LINES));
    this.chunkBytes = Math.max(1024, Math.floor(options.chunkBytes ?? DEFAULT_CHUNK_BYTES));
  }

  // ── HistoryArchiveLike ────────────────────────────────────────────────────

  /**
   * Legacy entry point. Without a pane height the only boundary we can trust is
   * the live window, which is far deeper than any pane is tall — so this stores
   * strictly less than `appendAnchored`, never more.
   */
  ingestSnapshot(
    session: string,
    content: string,
    opts: { previousContent: string | null; fullHistory: boolean; liveLineLimit: number; replace?: boolean },
  ): { liveContent: string } {
    const captured = splitCapture(content);
    const liveLimit = Math.max(1, Math.floor(opts.liveLineLimit));
    this.appendAnchored(session, captured, { paneRows: liveLimit, liveLineLimit: liveLimit });
    return { liveContent: captured.slice(-liveLimit).join("\n") };
  }

  readBefore(session: string, beforeLine: number | null, limit = 500): HistoryPage {
    const state = this.stateFor(session);
    if (state.disabled || state.totalLines === 0) return emptyPage();

    const requested = Number.isSafeInteger(beforeLine) ? beforeLine! : state.liveStart;
    const end = Math.max(0, Math.min(requested, state.liveStart, state.totalLines));
    if (end === 0) return emptyPage();
    const pageLimit = Math.max(1, Math.floor(limit));
    const start = Math.max(0, end - pageLimit);
    const lines = this.readRange(state, start, end);
    return { lines, startLine: lines.length === 0 ? null : start, hasMore: start > 0 };
  }

  readAfter(session: string, afterLine: number | null, limit = 500): HistoryPage {
    const state = this.stateFor(session);
    if (state.disabled || state.totalLines === 0) return emptyPage();

    const start = Math.max(0, Math.min(
      Number.isSafeInteger(afterLine) ? afterLine! + 1 : 0,
      state.totalLines,
    ));
    const end = Math.min(start + Math.max(1, Math.floor(limit)), state.liveStart);
    if (end <= start) return emptyPage();
    const lines = this.readRange(state, start, end);
    return { lines, startLine: lines.length === 0 ? null : start, hasMore: end < state.liveStart };
  }

  renameSession(oldSession: string, newSession: string): void {
    if (oldSession === newSession) return;
    const from = this.sessionDir(oldSession);
    const to = this.sessionDir(newSession);
    this.states.delete(oldSession);
    this.states.delete(newSession);
    if (!existsSync(from) || existsSync(to)) return;
    try {
      mkdirSync(dirname(to), { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
      renameSync(from, to);
    } catch {
      // A failed rename leaves both paths readable; the next append re-scans.
    }
  }

  dropSession(session: string): void {
    this.states.delete(session);
    rmSync(this.sessionDir(session), { recursive: true, force: true });
  }

  // ── Durable surface ───────────────────────────────────────────────────────

  /** Absolute archive line where the mux's live window begins. */
  liveStartLine(session: string): number | null {
    const state = this.stateFor(session);
    if (state.disabled || state.totalLines === 0) return null;
    return state.liveStart;
  }

  appendAnchored(
    session: string,
    captured: readonly string[],
    opts: { paneRows: number; liveLineLimit: number },
  ): ArchiveAppendResult {
    const state = this.stateFor(session);
    if (state.disabled) {
      return { appended: 0, liveStartLine: 0, totalLines: 0, gap: false, deferred: false };
    }

    const tail = anchorFromTail(this.tailLines(state, ANCHOR_LINES * 4), ANCHOR_LINES);
    const stitch = stitchCapture({
      archivedTail: tail,
      captured,
      paneRows: opts.paneRows,
      liveLineLimit: opts.liveLineLimit,
    });

    if (stitch.deferred || stitch.tooShort) {
      return {
        appended: 0,
        liveStartLine: state.liveStart,
        totalLines: state.totalLines,
        gap: false,
        deferred: stitch.deferred,
      };
    }

    // A marker earns its place only when fresh content follows it. Otherwise the
    // same miss repeats every capture and writes a marker every capture — which
    // is how a mechanism built to make an alarm trustworthy starts forging it.
    const gap = !stitch.anchored && tail.length > 0 && stitch.appended.length > 0;
    try {
      if (gap) this.append(state, [historyGapMarker(new Date())]);
      if (stitch.appended.length > 0) this.append(state, stitch.appended);
      state.liveStart = Math.max(
        0,
        state.totalLines - Math.min(Math.max(1, opts.liveLineLimit), state.totalLines),
      );
      this.writeMeta(session, state);
    } catch {
      state.disabled = true;
      return { appended: 0, liveStartLine: 0, totalLines: 0, gap: false, deferred: false };
    }

    return {
      appended: stitch.appended.length,
      liveStartLine: state.liveStart,
      totalLines: state.totalLines,
      gap,
      deferred: false,
    };
  }

  /** Directory holding this session's history, for hosts that expose a path. */
  sessionDir(session: string): string {
    return join(this.root, pathSegment(this.groupOf(session)), pathSegment(session));
  }

  // ── storage ───────────────────────────────────────────────────────────────

  private stateFor(session: string): SessionState {
    const cached = this.states.get(session);
    if (cached) return cached;
    const state = this.scan(session);
    this.states.set(session, state);
    return state;
  }

  /**
   * Rebuild everything from the `.log` files. The index and meta are caches, so
   * a missing or stale one costs a directory scan rather than the history — the
   * property the old JSON manifest did not have, where one lost file made half
   * a million lines unreadable.
   */
  private scan(session: string): SessionState {
    const dir = this.sessionDir(session);
    const state: SessionState = { dir, chunks: [], totalLines: 0, liveStart: 0, disabled: false };
    if (!existsSync(dir)) return state;

    try {
      const names = readdirSync(dir).filter((name) => name.endsWith(".log")).sort();
      for (const file of names) {
        const path = join(dir, file);
        let text = readFileSync(path, "utf8");
        // A torn final line means the process died mid-append. A terminal line
        // can never contain a newline, so everything after the last one is the
        // remains of a write that did not finish.
        if (text !== "" && !text.endsWith("\n")) {
          const keep = text.lastIndexOf("\n") + 1;
          truncateSync(path, Buffer.byteLength(text.slice(0, keep)));
          text = text.slice(0, keep);
        }
        const start = Number.parseInt(file.slice(0, file.length - 4), 10);
        if (!Number.isSafeInteger(start)) continue;
        state.chunks.push({ file, start, lines: countLines(text), bytes: Buffer.byteLength(text) });
      }
      state.chunks.sort((left, right) => left.start - right.start);
      const last = state.chunks[state.chunks.length - 1];
      state.totalLines = last ? last.start + last.lines : 0;
      state.liveStart = state.totalLines;

      const metaPath = join(dir, "meta.json");
      if (existsSync(metaPath)) {
        const meta = JSON.parse(readFileSync(metaPath, "utf8")) as { liveStart?: unknown };
        if (Number.isSafeInteger(meta.liveStart)) {
          state.liveStart = Math.max(0, Math.min(meta.liveStart as number, state.totalLines));
        }
      }
    } catch {
      state.disabled = true;
    }
    return state;
  }

  private append(state: SessionState, lines: readonly string[]): void {
    mkdirSync(state.dir, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    let index = 0;
    while (index < lines.length) {
      let chunk = state.chunks[state.chunks.length - 1];
      if (!chunk || chunk.lines >= this.chunkLines || chunk.bytes >= this.chunkBytes) {
        chunk = { file: chunkName(state.totalLines), start: state.totalLines, lines: 0, bytes: 0 };
        state.chunks.push(chunk);
      }
      const room = this.chunkLines - chunk.lines;
      const slice = lines.slice(index, index + room);
      const payload = `${slice.join("\n")}\n`;
      const path = join(state.dir, chunk.file);
      const fresh = !existsSync(path);
      appendFileSync(path, payload);
      if (fresh) chmodSync(path, PRIVATE_FILE_MODE);
      chunk.lines += slice.length;
      chunk.bytes += Buffer.byteLength(payload);
      state.totalLines += slice.length;
      index += slice.length;
      if (chunk.lines >= this.chunkLines || chunk.bytes >= this.chunkBytes) {
        this.appendIndex(state, chunk);
      }
    }
  }

  private appendIndex(state: SessionState, chunk: Chunk): void {
    try {
      const path = join(state.dir, "index.jsonl");
      const fresh = !existsSync(path);
      appendFileSync(path, `${JSON.stringify({ file: chunk.file, start: chunk.start, lines: chunk.lines, bytes: chunk.bytes })}\n`);
      if (fresh) chmodSync(path, PRIVATE_FILE_MODE);
    } catch {
      // The index is a cache. Losing an entry costs a rescan, never a line.
    }
  }

  private writeMeta(session: string, state: SessionState): void {
    const path = join(state.dir, "meta.json");
    const body = JSON.stringify({
      v: 2,
      session,
      group: this.groupOf(session),
      totalLines: state.totalLines,
      liveStart: state.liveStart,
      updatedAt: new Date().toISOString(),
    });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, body, { mode: PRIVATE_FILE_MODE });
    renameSync(tmp, path);
  }

  private readRange(state: SessionState, start: number, end: number): string[] {
    if (end <= start) return [];
    const lines: string[] = [];
    for (const chunk of state.chunks) {
      const chunkEnd = chunk.start + chunk.lines;
      if (chunkEnd <= start || chunk.start >= end) continue;
      const text = readFileSync(join(state.dir, chunk.file), "utf8");
      const chunkLines = text === "" ? [] : text.slice(0, -1).split("\n");
      const from = Math.max(0, start - chunk.start);
      const to = Math.min(chunkLines.length, end - chunk.start);
      for (let index = from; index < to; index++) lines.push(chunkLines[index]!);
    }
    return lines;
  }

  private tailLines(state: SessionState, want: number): string[] {
    if (state.totalLines === 0) return [];
    return this.readRange(state, Math.max(0, state.totalLines - want), state.totalLines);
  }
}

function splitCapture(content: string): string[] {
  const terminated = content.endsWith("\n") ? content.slice(0, -1) : content;
  if (terminated === "") return [];
  const lines = terminated.split("\n");
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") lines.pop();
  return lines;
}

function emptyPage(): HistoryPage {
  return { lines: [], startLine: null, hasMore: false };
}
