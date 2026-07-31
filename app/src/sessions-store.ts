import type { SessionListItem } from '@thumbmux/core';
import { tmuxMux, type TmuxMux } from '@thumbmux/svelte';

const EPOCH_MILLISECONDS_FLOOR = 1_000_000_000_000;

export type SessionsSnapshot = Readonly<{
  rows: SessionListItem[];
  loaded: boolean;
  connected: boolean;
}>;

export type SessionsStore = {
  subscribe(run: (snapshot: SessionsSnapshot) => void): () => void;
  readonly rows: SessionListItem[];
  readonly loaded: boolean;
  readonly connected: boolean;
  dispose(): void;
};

export type CreateSessionsStoreOptions = {
  fetchSessions?: () => Promise<SessionListItem[]>;
  mux?: TmuxMux;
};

function normalizeActivityAt(row: SessionListItem): SessionListItem {
  const activityAt = row.activityAt;
  if (
    typeof activityAt === 'number'
    && Number.isFinite(activityAt)
    && activityAt > 0
    && activityAt < EPOCH_MILLISECONDS_FLOOR
  ) {
    return { ...row, activityAt: activityAt * 1_000 };
  }
  return { ...row };
}

/** Protocol rows carry `activityAt` in seconds on some servers and milliseconds
 * on others. Every view that hands rows to `sessionMeta` must apply this, or one
 * host callback receives two different units depending on which view called it. */
export function normalizeSessionRows(rows: SessionListItem[]): SessionListItem[] {
  return rows.map(normalizeActivityAt);
}

function normalizeRows(rows: SessionListItem[]): SessionListItem[] {
  return rows.map(normalizeActivityAt);
}

/**
 * Reconcile the optional REST snapshot with the authoritative mux stream.
 * Once the first push arrives, an older bootstrap response can never replace it.
 */
export function createSessionsStore(
  opts: CreateSessionsStoreOptions = {},
): SessionsStore {
  const mux = opts.mux ?? tmuxMux;
  const subscribers = new Set<(snapshot: SessionsSnapshot) => void>();
  let rows: SessionListItem[] = [];
  let loaded = false;
  let pushSeen = false;
  let disposed = false;

  const snapshot = (): SessionsSnapshot => {
    const snapshotRows = rows;
    const snapshotLoaded = loaded;
    return {
      rows: snapshotRows,
      loaded: snapshotLoaded,
      // TmuxMux exposes connected as a rune but has no connection-event API.
      // Keep this accessor live so a Svelte read tracks that public rune.
      get connected() {
        return !disposed && mux.connected;
      },
    };
  };

  const publish = (): void => {
    const next = snapshot();
    for (const subscriber of [...subscribers]) subscriber(next);
  };

  const applyRows = (nextRows: SessionListItem[]): void => {
    if (disposed) return;
    rows = normalizeRows(nextRows);
    loaded = true;
    publish();
  };

  const unsubscribeSessions = mux.onSessions((nextRows) => {
    if (disposed) return;
    pushSeen = true;
    applyRows(nextRows as SessionListItem[]);
  });

  if (opts.fetchSessions) {
    let bootstrap: Promise<SessionListItem[]>;
    try {
      bootstrap = opts.fetchSessions();
    } catch (error) {
      bootstrap = Promise.reject(error);
    }
    void bootstrap.then(
      (nextRows) => {
        if (disposed || pushSeen) return;
        applyRows(nextRows);
      },
      () => {
        if (disposed || pushSeen) return;
        loaded = true;
        publish();
      },
    );
  }

  return {
    subscribe(run) {
      if (disposed) {
        run(snapshot());
        return () => {};
      }
      subscribers.add(run);
      run(snapshot());
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        subscribers.delete(run);
      };
    },
    get rows() {
      return rows;
    },
    get loaded() {
      return loaded;
    },
    get connected() {
      return !disposed && mux.connected;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribeSessions();
      subscribers.clear();
    },
  };
}
