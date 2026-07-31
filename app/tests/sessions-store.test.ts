import { describe, expect, test } from 'bun:test';
import type { SessionListItem } from '@thumbmux/core';
import type { TmuxMux } from '@thumbmux/svelte';
import { createSessionsStore, type SessionsSnapshot } from '../src/sessions-store';

type SessionsCallback = (rows: SessionListItem[]) => void;

class FakeMux {
  connected = true;
  readonly callbacks = new Set<SessionsCallback>();
  unsubscribeCalls = 0;

  onSessions(callback: SessionsCallback): () => void {
    this.callbacks.add(callback);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.unsubscribeCalls += 1;
      this.callbacks.delete(callback);
    };
  }

  push(rows: SessionListItem[]): void {
    for (const callback of [...this.callbacks]) callback(rows);
  }
}

function session(name: string, activityAt = 1_700_000_000_000): SessionListItem {
  return {
    name,
    created: '1700000000',
    windows: 1,
    attached: false,
    activityAt,
  };
}

function asTmuxMux(mux: FakeMux): TmuxMux {
  return mux as unknown as TmuxMux;
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('createSessionsStore', () => {
  test('a later mux push replaces the completed REST bootstrap', async () => {
    const mux = new FakeMux();
    const snapshots: SessionsSnapshot[] = [];
    const store = createSessionsStore({
      mux: asTmuxMux(mux),
      fetchSessions: async () => [session('rest-row')],
    });
    const unsubscribe = store.subscribe((snapshot) => snapshots.push(snapshot));

    await settle();
    expect(store.rows.map((row) => row.name)).toEqual(['rest-row']);
    expect(store.loaded).toBe(true);

    mux.push([session('pushed-row')]);
    expect(store.rows.map((row) => row.name)).toEqual(['pushed-row']);
    expect(snapshots.at(-1)?.rows.map((row) => row.name)).toEqual(['pushed-row']);

    unsubscribe();
    store.dispose();
  });

  test('a late REST bootstrap cannot overwrite the first mux push', async () => {
    const mux = new FakeMux();
    let resolveBootstrap!: (rows: SessionListItem[]) => void;
    const bootstrap = new Promise<SessionListItem[]>((resolve) => {
      resolveBootstrap = resolve;
    });
    const store = createSessionsStore({
      mux: asTmuxMux(mux),
      fetchSessions: () => bootstrap,
    });

    mux.push([session('newer-push')]);
    resolveBootstrap([session('stale-rest')]);
    await settle();

    expect(store.rows.map((row) => row.name)).toEqual(['newer-push']);
    expect(store.loaded).toBe(true);
    store.dispose();
  });

  test('dispose removes the mux subscription and ignores later pushes', () => {
    const mux = new FakeMux();
    const store = createSessionsStore({ mux: asTmuxMux(mux) });
    mux.push([session('before-dispose')]);
    const rowsAtDispose = store.rows;

    store.dispose();
    expect(mux.callbacks.size).toBe(0);
    expect(mux.unsubscribeCalls).toBe(1);
    expect(store.connected).toBe(false);

    mux.push([session('after-dispose')]);
    expect(store.rows).toBe(rowsAtDispose);
    expect(store.rows.map((row) => row.name)).toEqual(['before-dispose']);

    store.dispose();
    expect(mux.unsubscribeCalls).toBe(1);
  });

  test('normalizes epoch seconds to milliseconds without changing millisecond values', async () => {
    const mux = new FakeMux();
    const secondsRow = session('seconds', 1_700_000_123);
    const millisecondsRow = session('milliseconds', 1_700_000_456_000);
    const zeroRow = session('unknown', 0);
    const store = createSessionsStore({
      mux: asTmuxMux(mux),
      fetchSessions: async () => [secondsRow, millisecondsRow, zeroRow],
    });

    await settle();
    expect(store.rows.map((row) => row.activityAt)).toEqual([
      1_700_000_123_000,
      1_700_000_456_000,
      0,
    ]);
    expect(secondsRow.activityAt).toBe(1_700_000_123);

    mux.push([session('pushed-seconds', 1_700_000_789)]);
    expect(store.rows[0]?.activityAt).toBe(1_700_000_789_000);
    store.dispose();
  });

  test('without REST, loading stays pending until the first push', () => {
    const mux = new FakeMux();
    const store = createSessionsStore({ mux: asTmuxMux(mux) });
    expect(store.loaded).toBe(false);
    expect(store.rows).toEqual([]);

    mux.push([]);
    expect(store.loaded).toBe(true);
    store.dispose();
  });

  test('exposes current mux connectivity through subscribed state', () => {
    const mux = new FakeMux();
    mux.connected = false;
    const store = createSessionsStore({ mux: asTmuxMux(mux) });
    let subscribed!: SessionsSnapshot;
    store.subscribe((snapshot) => {
      subscribed = snapshot;
    });
    expect(subscribed.connected).toBe(false);

    mux.connected = true;
    expect(subscribed.connected).toBe(true);
    expect(store.connected).toBe(true);
    store.dispose();
    expect(subscribed.connected).toBe(false);
  });

  test('dispose fences a bootstrap that resolves later', async () => {
    const mux = new FakeMux();
    let resolveBootstrap!: (rows: SessionListItem[]) => void;
    const bootstrap = new Promise<SessionListItem[]>((resolve) => {
      resolveBootstrap = resolve;
    });
    const snapshots: SessionsSnapshot[] = [];
    const store = createSessionsStore({
      mux: asTmuxMux(mux),
      fetchSessions: () => bootstrap,
    });
    store.subscribe((snapshot) => snapshots.push(snapshot));
    store.dispose();

    resolveBootstrap([session('too-late')]);
    await settle();
    expect(store.rows).toEqual([]);
    expect(store.loaded).toBe(false);
    expect(snapshots).toHaveLength(1);
  });
});
