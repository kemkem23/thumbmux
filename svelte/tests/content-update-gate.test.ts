import { describe, expect, test } from 'bun:test';
import {
  createContentUpdateGate,
  flushContentUpdate,
  receiveContentUpdate,
  type ContentUpdate,
} from '../src/content-update-gate';

function delivery(
  data: string,
  opts: { cursor?: { row: number; col: number } | null; replace?: boolean; source?: 'full' | 'delta' } = {},
): ContentUpdate {
  return {
    data,
    cursor: opts.cursor,
    meta: {
      source: opts.source ?? 'full',
      replace: opts.replace ?? false,
    },
  };
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

  test('coalesces the newest complete delivery while a selection owns rows', () => {
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

    expect(gate.pending).toEqual(newest);
    expect(gate.pending).not.toBe(newest);
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
