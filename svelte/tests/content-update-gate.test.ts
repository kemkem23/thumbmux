import { describe, expect, test } from 'bun:test';
import {
  contentLinesChangeSource,
  createContentUpdateGate,
  flushContentUpdate,
  receiveContentUpdate,
  updatePendingContentCursor,
  type ContentUpdate,
} from '../src/content-update-gate';

function delivery(
  data: string,
  opts: {
    cursor?: { row: number; col: number } | null;
    replace?: boolean;
    source?: 'full' | 'delta';
    linesChangeSource?: 'live' | 'replace';
  } = {},
): ContentUpdate {
  const update: ContentUpdate = {
    data,
    cursor: opts.cursor,
    meta: {
      source: opts.source ?? 'full',
      replace: opts.replace ?? false,
    },
  };
  if (opts.linesChangeSource !== undefined) {
    update.linesChangeSource = opts.linesChangeSource;
  }
  return update;
}

describe('content update gate', () => {
  test('delivers immediately while the view is idle', () => {
    const update = delivery('first', { cursor: { row: 2, col: 3 } });
    const result = receiveContentUpdate(createContentUpdateGate(), update, {
      busy: false,
      selectionActive: false,
    });

    expect(result.delivery).toEqual(update);
    expect(result.gate.pending).toBeNull();
  });

  test('coalesces the newest complete delivery while keeping reset semantics sticky', () => {
    let gate = createContentUpdateGate();
    const blocked = { busy: false, selectionActive: true };
    gate = receiveContentUpdate(gate, delivery('older', {
      cursor: { row: 1, col: 1 },
      replace: true,
    }), blocked).gate;
    const newest = delivery('newest', {
      cursor: { row: 4, col: 5 },
      source: 'delta',
      replace: false,
    });
    gate = receiveContentUpdate(gate, newest, blocked).gate;

    expect(gate.pending).toEqual(delivery('newest', {
      cursor: { row: 4, col: 5 },
      source: 'delta',
      replace: true,
      linesChangeSource: 'live',
    }));
    expect(gate.pending).not.toBe(newest);
  });

  test('keeps a pending reset sticky when the superseding delta arrives after the block clears', () => {
    const reset = receiveContentUpdate(createContentUpdateGate(), delivery('reset', {
      replace: true,
    }), { busy: true, selectionActive: false }).gate;

    const delivered = receiveContentUpdate(reset, delivery('latest delta', {
      source: 'delta',
    }), { busy: false, selectionActive: false });

    expect(delivered.gate.pending).toBeNull();
    expect(delivered.delivery).toEqual(delivery('latest delta', {
      source: 'delta',
      replace: true,
      linesChangeSource: 'live',
    }));
    expect(contentLinesChangeSource(delivered.delivery!)).toBe('live');
  });

  test('reports a superseding ordinary full as live while keeping reset application sticky', () => {
    const reset = receiveContentUpdate(createContentUpdateGate(), delivery('reset', {
      replace: true,
    }), { busy: false, selectionActive: true }).gate;

    const delivered = receiveContentUpdate(reset, delivery('latest full'), {
      busy: false,
      selectionActive: false,
    });

    expect(delivered.delivery).toEqual(delivery('latest full', {
      replace: true,
      linesChangeSource: 'live',
    }));
    expect(contentLinesChangeSource(delivered.delivery!)).toBe('live');
  });

  test('keeps unseen live output sticky when a later reset supersedes it', () => {
    const live = receiveContentUpdate(createContentUpdateGate(), delivery('unseen live', {
      source: 'delta',
    }), { busy: true, selectionActive: false }).gate;

    const delivered = receiveContentUpdate(live, delivery('reflowed with unseen live', {
      replace: true,
    }), { busy: false, selectionActive: false });

    expect(delivered.delivery).toEqual(delivery('reflowed with unseen live', {
      replace: true,
      linesChangeSource: 'live',
    }));
    expect(contentLinesChangeSource(delivered.delivery!)).toBe('live');
  });

  test('keeps an all-reset coalesced interval classified as replacement', () => {
    const first = receiveContentUpdate(createContentUpdateGate(), delivery('first reset', {
      replace: true,
    }), { busy: false, selectionActive: true }).gate;
    const delivered = receiveContentUpdate(first, delivery('second reset', {
      replace: true,
    }), { busy: false, selectionActive: false });

    expect(contentLinesChangeSource(delivered.delivery!)).toBe('replace');
  });

  test('distinguishes replacement application from the newest content cause', () => {
    expect(contentLinesChangeSource(delivery('reset', { replace: true }))).toBe('replace');
    expect(contentLinesChangeSource(delivery('normal full'))).toBe('live');
    expect(contentLinesChangeSource(delivery('post-reset delta', {
      source: 'delta',
      replace: true,
    }))).toBe('live');
  });

  test('cursor-only delivery updates the pending caret before flush', () => {
    let gate = receiveContentUpdate(createContentUpdateGate(), delivery('snapshot', {
      cursor: { row: 1, col: 2 },
    }), { busy: false, selectionActive: true }).gate;
    const cursor = { row: 8, col: 13 };

    gate = updatePendingContentCursor(gate, cursor);
    cursor.row = 99;

    const flushed = flushContentUpdate(gate, { busy: false, selectionActive: false });
    expect(flushed.delivery?.cursor).toEqual({ row: 8, col: 13 });
  });

  test('cursor-only null clears the caret bundled with pending content', () => {
    const pending = receiveContentUpdate(createContentUpdateGate(), delivery('snapshot', {
      cursor: { row: 1, col: 2 },
    }), { busy: true, selectionActive: false }).gate;

    expect(updatePendingContentCursor(pending, null).pending?.cursor).toBeNull();
  });

  test('keeps a reset delivery intact across a busy gesture and flushes it once', () => {
    let gate = createContentUpdateGate();
    const reset = delivery('reflowed', {
      cursor: { row: 0, col: 9 },
      replace: true,
    });
    gate = receiveContentUpdate(gate, reset, { busy: true, selectionActive: false }).gate;

    const stillBusy = flushContentUpdate(gate, { busy: true, selectionActive: false });
    expect(stillBusy.delivery).toBeNull();
    expect(stillBusy.gate.pending).toEqual(reset);

    const flushed = flushContentUpdate(stillBusy.gate, { busy: false, selectionActive: false });
    expect(flushed.delivery).toEqual(reset);
    expect(flushed.gate.pending).toBeNull();

    const repeated = flushContentUpdate(flushed.gate, { busy: false, selectionActive: false });
    expect(repeated.delivery).toBeNull();
  });

  test('does not retain caller-owned cursor or reset metadata', () => {
    const update = delivery('snapshot', { cursor: { row: 3, col: 7 }, replace: true });
    const result = receiveContentUpdate(createContentUpdateGate(), update, {
      busy: false,
      selectionActive: true,
    });
    update.cursor!.row = 99;
    update.meta.replace = false;

    expect(result.gate.pending).toEqual(delivery('snapshot', {
      cursor: { row: 3, col: 7 },
      replace: true,
    }));
  });
});
