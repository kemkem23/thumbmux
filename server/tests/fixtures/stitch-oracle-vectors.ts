// Copied from docs/tasks/newarch-stream/contract-fixture.ts so the public package
// suite does not import host docs. Keep in sync with that source when it changes.
// Independent expected vectors for C/T. IDs denote separate producer events,
// even where cells repeat. Expected decisions are literals, never matcher output.
export const STITCH_ORACLE_VECTORS = [
  { id: 'ST-short-7', tail: ['a','b','c','d','e','f','g'], capture: ['a','b','c','d','e','f','g'], proof: 'none', expected: 'unproven' },
  { id: 'ST-unique-reprinted-8', tail: ['a','b','c','d','e','f','g','h'], capture: ['a','b','c','d','e','f','g','h'], proof: 'none-after-clear', expected: 'unproven' },
  { id: 'ST-multiple', tail: ['a','b','a','b','a','b','a','b'], capture: ['a','b','a','b','a','b','a','b','a','b'], proof: 'none', expected: 'ambiguous' },
  { id: 'ST-blank', tail: ['','','','','','','',''], capture: ['','','','','','','',''], proof: 'none', expected: 'unproven' },
  { id: 'ST-proven-8', tail: ['a','b','c','d','e','f','g','h'], capture: ['a','b','c','d','e','f','g','h','i'], proof: 'recorded-mapping-and-boundary', expected: 'matched' },
  { id: 'ST-zero-birth', tail: [], capture: [], proof: 'genesis-byte-zero', expected: 'matched' },
] as const;
