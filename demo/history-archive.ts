import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { HistoryArchiveLike } from "@thumbmux/server";

export type HistoryPage = {
  lines: string[];
  startLine: number | null;
  hasMore: boolean;
};

export type FileHistoryArchiveOptions = {
  /** Storage directory. Defaults to a neutral directory beneath the OS temp root. */
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
 * A bounded per-session archive. Session names are never used as filenames:
 * each pair of data/meta files uses a SHA-256 key, so traversal input remains
 * inside the configured storage root.
 */
export class FileHistoryArchive implements HistoryArchiveLike {
  private readonly root: string;
  private readonly maxLines: number;
  private readonly states = new Map<string, ArchiveState>();

  constructor(options: FileHistoryArchiveOptions = {}) {
    this.root = options.root || join(tmpdir(), "thumbmux-history");
    this.maxLines = archiveCap(options.maxLines);
    try {
      mkdirSync(this.root, { recursive: true });
    } catch {
      // Individual sessions become fail-closed when they are accessed.
    }
  }

  ingestSnapshot(
    session: string,
    content: string,
    opts: { previousContent: string | null; fullHistory: boolean; liveLineLimit: number },
  ): { liveContent: string } {
    const liveLimit = limitAtLeastOne(opts.liveLineLimit, 1);
    const captured = content.split("\n");
    const nextLive = captured.slice(-liveLimit);
    const state = this.stateFor(session);

    if (state.disabled) return { liveContent: nextLive.join("\n") };

    try {
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
      } else {
        const overlap = stableOverlap(state.live, nextLive);
        const leavingCount = state.live.length - overlap;
        for (let i = 0; i < leavingCount; i++) {
          state.entries.push({ line: state.liveStart + i, text: state.live[i]! });
        }
        state.liveStart += leavingCount;
        state.live = nextLive;
        state.nextLine = state.liveStart + nextLive.length;
      }

      this.evict(state);
      this.persist(session, state);
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
    const paths = this.paths(session);
    const hasData = existsSync(paths.data);
    const hasMeta = existsSync(paths.meta);
    if (!hasData && !hasMeta) return emptyState();
    if (!hasData || !hasMeta) return { ...emptyState(), disabled: true };

    try {
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
      this.evict(state);
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

  private evict(state: ArchiveState): void {
    if (state.entries.length > this.maxLines) {
      state.entries.splice(0, state.entries.length - this.maxLines);
    }
  }

  private persist(session: string, state: ArchiveState): void {
    const paths = this.paths(session);
    mkdirSync(this.root, { recursive: true });
    const data = state.entries.map((entry) => JSON.stringify(entry)).join("\n");
    const meta: PersistedMeta = {
      v: 1,
      live: state.live,
      liveStart: state.liveStart,
      nextLine: state.nextLine,
    };
    this.writeAtomically(paths.data, data === "" ? "" : `${data}\n`);
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
      writeFileSync(temporary, data, "utf8");
      renameSync(temporary, path);
    } finally {
      if (existsSync(temporary)) unlinkSync(temporary);
    }
  }

  private moveIfPresent(source: string, destination: string): void {
    if (existsSync(source)) renameSync(source, destination);
  }

  private removeFiles(paths: { data: string; meta: string }): void {
    rmSync(paths.data, { force: true });
    rmSync(paths.meta, { force: true });
  }
}
