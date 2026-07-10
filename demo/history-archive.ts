import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { HistoryArchiveLike } from "@thumbmux/server";

export type HistoryPage = {
  lines: string[];
  startLine: number | null;
  hasMore: boolean;
};

export type FileHistoryArchiveOptions = {
  /**
   * Storage directory. An explicit root is persistent across archive
   * instances. The default is private and unique to this user/process run.
   */
  root?: string;
  /** Maximum archived lines retained for each session. */
  maxLines?: number;
};

type ArchiveEntry = { line: number; text: string };

type ArchiveState = {
  entries: ArchiveEntry[];
  initialized: boolean;
  live: string[];
  liveStart: number;
  nextLine: number;
  disabled: boolean;
};

type PersistedMeta = {
  v: 1;
  live: string[];
  liveStart: number;
  nextLine: number;
};

const DEFAULT_MAX_LINES = 20_000;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

function sessionKey(session: string): string {
  return createHash("sha256").update(session).digest("hex");
}

function limitAtLeastOne(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.floor(value!));
}

function archiveCap(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_MAX_LINES;
  return Math.max(0, Math.floor(value!));
}

function defaultArchiveRoot(): string {
  const user = typeof process.getuid === "function"
    ? String(process.getuid())
    : sessionKey(process.env.USER || process.env.USERNAME || "unknown-user").slice(0, 12);
  return join(tmpdir(), `thumbmux-history-u${user}-run-${process.pid}-${randomUUID()}`);
}

/**
 * tmux capture-pane emits one record terminator after the final row. Remove
 * that terminator before splitting, then discard blank rows below the last
 * content row. This mirrors the driver's trailing-blank accounting and keeps
 * a real newline-terminated capture from manufacturing an archive line.
 */
function captureLines(content: string): string[] {
  const terminated = content.endsWith("\n") ? content.slice(0, -1) : content;
  if (terminated === "") return [];

  const lines = terminated.split("\n");
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") lines.pop();
  return lines;
}

function sameLines(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((line, index) => line === right[index]);
}

function commonPrefixLength(left: readonly string[], right: readonly string[]): number {
  const shortest = Math.min(left.length, right.length);
  let common = 0;
  while (common < shortest && left[common] === right[common]) common++;
  return common;
}

function looksLikeTailRepaint(previous: readonly string[], next: readonly string[]): boolean {
  const shortest = Math.min(previous.length, next.length);
  if (shortest === 0) return true;
  // Captures frequently rewrite the prompt and one adjacent tail row. A
  // stable prefix through that tail is stronger evidence of an in-place
  // repaint than any coincidental suffix→prefix match in repeated output.
  return commonPrefixLength(previous, next) >= Math.max(1, shortest - 2);
}

function minimumReliableOverlap(previous: readonly string[], next: readonly string[]): number {
  const shortest = Math.min(previous.length, next.length);
  if (shortest <= 1) return 2;
  // Require at least half of a tiny window and up to eight rows for a normal
  // terminal window. One repeated separator/status row is not proof of scroll.
  return Math.min(shortest, Math.max(2, Math.min(8, Math.ceil(shortest / 2))));
}

function emptyState(): ArchiveState {
  return {
    entries: [],
    initialized: false,
    live: [],
    liveStart: 0,
    nextLine: 0,
    disabled: false,
  };
}

function stableOverlap(previous: readonly string[], next: readonly string[]): number {
  const longest = Math.min(previous.length, next.length);
  for (let size = longest; size > 0; size--) {
    let matches = true;
    for (let i = 0; i < size; i++) {
      if (previous[previous.length - size + i] !== next[i]) {
        matches = false;
        break;
      }
    }
    if (matches) return size;
  }
  return 0;
}

/**
 * Locate one unambiguous occurrence of `needle` across the whole capture.
 * Repeated terminal rows are common, so two matches are no stronger than no
 * match for archive reconciliation.
 */
function uniqueWindowStart(
  lines: readonly string[],
  needle: readonly string[],
): number | null {
  if (needle.length === 0 || lines.length < needle.length) return null;
  const latestStart = lines.length - needle.length;
  let found: number | null = null;
  for (let start = 0; start <= latestStart; start++) {
    let matches = true;
    for (let i = 0; i < needle.length; i++) {
      if (lines[start + i] !== needle[i]) {
        matches = false;
        break;
      }
    }
    if (!matches) continue;
    if (found !== null) return null;
    found = start;
  }
  return found;
}

/**
 * A bounded per-session archive. Session names are never used as filenames:
 * each pair of data/meta files uses a SHA-256 key, so traversal input remains
 * inside the configured storage root.
 */
export class FileHistoryArchive implements HistoryArchiveLike {
  private readonly root: string;
  private readonly maxLines: number;
  private readonly storageReady: boolean;
  private readonly states = new Map<string, ArchiveState>();

  constructor(options: FileHistoryArchiveOptions = {}) {
    this.root = options.root || defaultArchiveRoot();
    this.maxLines = archiveCap(options.maxLines);
    try {
      this.secureRoot();
      this.storageReady = true;
    } catch {
      this.storageReady = false;
    }
  }

  ingestSnapshot(
    session: string,
    content: string,
    opts: { previousContent: string | null; fullHistory: boolean; liveLineLimit: number; replace?: boolean },
  ): { liveContent: string } {
    const liveLimit = limitAtLeastOne(opts.liveLineLimit, 1);
    const captured = captureLines(content);
    const nextLive = captured.slice(-liveLimit);
    const state = this.stateFor(session);

    if (state.disabled) return { liveContent: nextLive.join("\n") };

    try {
      let entriesChanged = false;
      if (!state.initialized) {
        const splitAt = opts.fullHistory ? Math.max(0, captured.length - liveLimit) : 0;
        const initialLive = opts.fullHistory ? nextLive : captured.slice(-liveLimit);
        state.entries = opts.fullHistory
          ? captured.slice(0, splitAt).map((text, line) => ({ line, text }))
          : [];
        state.live = initialLive;
        state.liveStart = splitAt;
        state.nextLine = splitAt + initialLive.length;
        state.initialized = true;
        entriesChanged = true;
      } else {
        if (sameLines(state.live, nextLive)) {
          return { liveContent: state.live.join("\n") };
        }

        let reconciledFullHistory = false;
        if (opts.fullHistory) {
          const splitAt = Math.max(0, captured.length - nextLive.length);
          const matchStart = uniqueWindowStart(captured, state.live);
          if (matchStart !== null && matchStart < splitAt) {
            // A restart can capture rows that arrived while the archive was
            // offline. The unique whole-live match is stronger than a shorter
            // suffix match at the new live boundary, and remains valid when a
            // reconnect also requested a geometry replacement.
            const departed = captured.slice(matchStart, splitAt);
            for (let i = 0; i < departed.length; i++) {
              state.entries.push({ line: state.liveStart + i, text: departed[i]! });
            }
            state.liveStart += departed.length;
            entriesChanged = departed.length > 0;
            reconciledFullHistory = true;
          }
        }

        if (!reconciledFullHistory && !opts.replace) {
          const overlap = looksLikeTailRepaint(state.live, nextLive)
            ? 0
            : stableOverlap(state.live, nextLive);
          // No reliable suffix→prefix overlap means a repaint, an in-place
          // edit, or an ambiguous repeated row — not proof that prior live
          // rows scrolled out. Fail safe by replacing the live view without
          // manufacturing history or advancing its logical origin.
          if (overlap >= minimumReliableOverlap(state.live, nextLive)) {
            const leavingCount = state.live.length - overlap;
            for (let i = 0; i < leavingCount; i++) {
              state.entries.push({ line: state.liveStart + i, text: state.live[i]! });
            }
            state.liveStart += leavingCount;
            entriesChanged = leavingCount > 0;
          }
        }
        // Without a full-history proof, replace means an in-place resize
        // reflow: update only live metadata and never infer departed rows.
        state.live = nextLive;
        state.nextLine = state.liveStart + nextLive.length;
      }

      entriesChanged = this.evict(state) || entriesChanged;
      this.persist(session, state, entriesChanged);
      return { liveContent: state.live.join("\n") };
    } catch {
      state.disabled = true;
      return { liveContent: nextLive.join("\n") };
    }
  }

  readBefore(session: string, beforeLine: number | null, limit = 500): HistoryPage {
    const state = this.stateFor(session);
    if (state.disabled || state.entries.length === 0) {
      return { lines: [], startLine: null, hasMore: false };
    }

    const upperBound = Number.isSafeInteger(beforeLine)
      ? Math.min(beforeLine!, state.liveStart)
      : state.liveStart;
    const available = state.entries.filter((entry) => entry.line < upperBound);
    if (available.length === 0) return { lines: [], startLine: null, hasMore: false };

    const pageLimit = limitAtLeastOne(limit, 500);
    const page = available.slice(-pageLimit);
    return {
      lines: page.map((entry) => entry.text),
      startLine: page[0]!.line,
      hasMore: available.length > page.length,
    };
  }

  renameSession(oldSession: string, newSession: string): void {
    if (oldSession === newSession) return;

    const oldState = this.states.get(oldSession);
    this.states.delete(newSession);
    if (oldState) this.states.set(newSession, oldState);
    this.states.delete(oldSession);

    const oldPaths = this.paths(oldSession);
    const newPaths = this.paths(newSession);
    try {
      this.removeFiles(newPaths);
      this.moveIfPresent(oldPaths.data, newPaths.data);
      this.moveIfPresent(oldPaths.meta, newPaths.meta);
    } catch {
      if (oldState) oldState.disabled = true;
    }
  }

  private stateFor(session: string): ArchiveState {
    const cached = this.states.get(session);
    if (cached) return cached;

    const state = this.load(session);
    this.states.set(session, state);
    return state;
  }

  private load(session: string): ArchiveState {
    if (!this.storageReady) return { ...emptyState(), disabled: true };

    const paths = this.paths(session);
    const hasData = existsSync(paths.data);
    const hasMeta = existsSync(paths.meta);
    if (!hasData && !hasMeta) return emptyState();
    if (!hasData || !hasMeta) return { ...emptyState(), disabled: true };

    try {
      this.secureRoot();
      this.secureFile(paths.data);
      this.secureFile(paths.meta);
      const rawData = readFileSync(paths.data, "utf8");
      if (rawData !== "" && !rawData.endsWith("\n")) throw new Error("partial archive record");
      const entries = rawData === ""
        ? []
        : rawData.slice(0, -1).split("\n").map((record) => this.parseEntry(record));
      const meta = JSON.parse(readFileSync(paths.meta, "utf8")) as PersistedMeta;
      if (!this.validMeta(meta) || !this.validEntries(entries, meta.liveStart)) throw new Error("invalid archive state");
      const state: ArchiveState = {
        entries,
        initialized: true,
        live: meta.live,
        liveStart: meta.liveStart,
        nextLine: meta.nextLine,
        disabled: false,
      };
      if (this.evict(state)) this.persist(session, state, true);
      return state;
    } catch {
      return { ...emptyState(), disabled: true };
    }
  }

  private parseEntry(record: string): ArchiveEntry {
    const value = JSON.parse(record) as { line?: unknown; text?: unknown };
    if (!Number.isSafeInteger(value.line) || (value.line as number) < 0 || typeof value.text !== "string") {
      throw new Error("invalid archive record");
    }
    return { line: value.line as number, text: value.text };
  }

  private validMeta(meta: PersistedMeta): boolean {
    return meta?.v === 1
      && Array.isArray(meta.live)
      && meta.live.every((line) => typeof line === "string")
      && Number.isSafeInteger(meta.liveStart)
      && meta.liveStart >= 0
      && Number.isSafeInteger(meta.nextLine)
      && meta.nextLine === meta.liveStart + meta.live.length;
  }

  private validEntries(entries: ArchiveEntry[], liveStart: number): boolean {
    return entries.every((entry, index) => {
      const previous = entries[index - 1];
      return entry.line < liveStart && (!previous || previous.line + 1 === entry.line);
    });
  }

  private evict(state: ArchiveState): boolean {
    if (state.entries.length > this.maxLines) {
      state.entries.splice(0, state.entries.length - this.maxLines);
      return true;
    }
    return false;
  }

  private persist(session: string, state: ArchiveState, entriesChanged: boolean): void {
    const paths = this.paths(session);
    this.secureRoot();
    const meta: PersistedMeta = {
      v: 1,
      live: state.live,
      liveStart: state.liveStart,
      nextLine: state.nextLine,
    };
    if (entriesChanged || !existsSync(paths.data)) {
      const data = state.entries.map((entry) => JSON.stringify(entry)).join("\n");
      this.writeAtomically(paths.data, data === "" ? "" : `${data}\n`);
    }
    this.writeAtomically(paths.meta, JSON.stringify(meta));
  }

  private paths(session: string): { data: string; meta: string } {
    const key = sessionKey(session);
    return {
      data: join(this.root, `history-${key}.jsonl`),
      meta: join(this.root, `history-${key}.json`),
    };
  }

  private writeAtomically(path: string, data: string): void {
    const temporary = join(this.root, `.${basename(path)}.${randomUUID()}.tmp`);
    try {
      writeFileSync(temporary, data, {
        encoding: "utf8",
        flag: "wx",
        mode: PRIVATE_FILE_MODE,
      });
      chmodSync(temporary, PRIVATE_FILE_MODE);
      renameSync(temporary, path);
      chmodSync(path, PRIVATE_FILE_MODE);
    } finally {
      if (existsSync(temporary)) unlinkSync(temporary);
    }
  }

  private moveIfPresent(source: string, destination: string): void {
    if (existsSync(source)) {
      renameSync(source, destination);
      this.secureFile(destination);
    }
  }

  private removeFiles(paths: { data: string; meta: string }): void {
    rmSync(paths.data, { force: true });
    rmSync(paths.meta, { force: true });
  }

  private secureRoot(): void {
    mkdirSync(this.root, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    chmodSync(this.root, PRIVATE_DIRECTORY_MODE);
  }

  private secureFile(path: string): void {
    chmodSync(path, PRIVATE_FILE_MODE);
  }
}
