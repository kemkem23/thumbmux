/**
 * ONEPATH S1 P01 – immutable oracle fixture.
 *
 * These constants define what the store MUST return.  They were written before
 * the test was run and are not derived from the factory, store, reader, or any
 * other module being tested.  The oracle algorithm (oracleRowsDigest) reproduces
 * the sha-256 framing from codec.ts§rowsDigest using only node:crypto so that a
 * bug that silently rewrites every row still causes a digest mismatch.
 *
 * Rules enforced here:
 * - NEVER import from ../src/sqlite-history/** (that is the code under test).
 * - ALL expected values are concrete literals, not generated from the SUT.
 * - Row text covers: Thai, blank, ANSI escape, duplicate, geometry change.
 */
import { createHash } from 'node:crypto';
import type { HistoryRow } from '../../src/sqlite-history/types';

// ---------------------------------------------------------------------------
// Oracle hash  (independent re-implementation of codec.ts§rowsDigest)
// ---------------------------------------------------------------------------

/**
 * Computes the same sha-256 digest as codec.ts§rowsDigest, but is authored
 * here independently so a regression in codec.ts would surface as a mismatch.
 */
export function oracleRowsDigest(rows: ReadonlyArray<{ line_no: number; kind: string; text: string }>): string {
  const h = createHash('sha256');
  for (const row of rows) {
    for (const part of [String(row.line_no), row.kind, row.text]) {
      const data = Buffer.from(part, 'utf8');
      const length = Buffer.alloc(8);
      length.writeBigUInt64BE(BigInt(data.length));
      h.update(length);
      h.update(data);
    }
  }
  return h.digest('hex');
}

// ---------------------------------------------------------------------------
// Fixture rows (oracle-defined, immutable)
// ---------------------------------------------------------------------------

/**
 * Batch 1: 6 rows appended, geometry gen=1 (pane 1×80).
 * Contains: Thai, blank, Thai+ANSI red, duplicate, Thai+ANSI bold-green, ASCII.
 */
export const BATCH1_ROWS: readonly HistoryRow[] = [
  { line_no: 0, kind: 'terminal', text: 'สวัสดี ชาวโลก' },
  { line_no: 1, kind: 'terminal', text: '' },
  { line_no: 2, kind: 'terminal', text: '\x1b[31mสีแดง\x1b[0m' },
  { line_no: 3, kind: 'terminal', text: 'สวัสดี ชาวโลก' },   // duplicate of row 0
  { line_no: 4, kind: 'terminal', text: '\x1b[1;32mบรรทัดที่ห้า\x1b[0m' },
  { line_no: 5, kind: 'terminal', text: 'ASCII line' },
];

/** The single screen line committed with batch 1 (geometry gen=1). */
export const BATCH1_SCREEN = ['screen-gen1'] as const;

/** Geometry for batch 1: pane, 1 row, 80 cols, generation=1. */
export const BATCH1_GEOMETRY = { kind: 'pane' as const, rows: 1, cols: 80, generation: 1, alternate: false, cursor: null };

/**
 * Batch 2: 4 rows appended, geometry gen=2 (geometry change from gen=1).
 * Contains: Thai, blank, Thai+ANSI magenta, plain ASCII.
 */
export const BATCH2_ROWS: readonly HistoryRow[] = [
  { line_no: 6, kind: 'terminal', text: 'ภาษาไทย หก' },
  { line_no: 7, kind: 'terminal', text: '' },
  { line_no: 8, kind: 'terminal', text: '\x1b[0;35mม่วง\x1b[0m' },
  { line_no: 9, kind: 'terminal', text: 'end row' },
];

/** The single screen line committed with batch 2 (geometry gen=2). */
export const BATCH2_SCREEN = ['screen-gen2'] as const;

/** Geometry for batch 2: pane, 1 row, 80 cols, generation=2 (geometry changed). */
export const BATCH2_GEOMETRY = { kind: 'pane' as const, rows: 1, cols: 80, generation: 2, alternate: false, cursor: null };

/** All 10 rows combined in line_no order. */
export const ALL_ROWS: readonly HistoryRow[] = [...BATCH1_ROWS, ...BATCH2_ROWS];

// ---------------------------------------------------------------------------
// Precomputed digests (oracle-computed, not SUT-computed)
// ---------------------------------------------------------------------------

/** Expected oracle digest of ALL_ROWS, computed at module-load time. */
export const ORACLE_ALL_DIGEST = oracleRowsDigest(ALL_ROWS);

/** Oracle digest of batch 1 rows only. */
export const ORACLE_BATCH1_DIGEST = oracleRowsDigest([...BATCH1_ROWS]);

/** Oracle digest of batch 2 rows only. */
export const ORACLE_BATCH2_DIGEST = oracleRowsDigest([...BATCH2_ROWS]);

// ---------------------------------------------------------------------------
// Session identity
// ---------------------------------------------------------------------------

export const SESSION_NAME = 'onepath-s1-thai-ansi';
export const SESSION_LIFECYCLE_KEY = 's1-p01-offline-lk';

/**
 * How many rows the fixture contains in total.  If the store returns a
 * different count the test MUST fail — never treat a count check as trivially
 * satisfied by zero.
 */
export const EXPECTED_ROW_COUNT = 10;

/**
 * Expected next_line / liveStart after both batches are committed.
 * Every batch uses liveLineLimit = screen.length (1), so:
 *   b = end - max(0, 1 - 1) = end
 * → live window is empty, everything is in archive.
 */
export const EXPECTED_LIVE_START = 10;
export const EXPECTED_NEXT_LINE = 10;
