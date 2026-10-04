/** Logical scratch admission, not a claim about allocator capacity/PSS.
 * Disjoint slots have one writer each; the worker shares the same ledger.
 * Caps sum to 32 MiB. Copies are charged, persisted spools are separate. */
export const SCRATCH_CAPS = [2, 8, 8, 8, 6].map(n => n * 1024 * 1024);
export class ScratchLedger {
  readonly shared: SharedArrayBuffer;
  private words: Int32Array;
  constructor(shared = new SharedArrayBuffer(12 * 4)) { this.shared = shared; this.words = new Int32Array(shared); }
  set(slot: number, bytes: number) {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || !Number.isInteger(slot) || slot<0 || slot>=5 || bytes > SCRATCH_CAPS[slot]!) {
      Atomics.add(this.words, 11, 1); throw new Error(`scratch-budget slot=${slot} bytes=${bytes}`);
    }
    Atomics.store(this.words, slot, bytes);
    Atomics.store(this.words, slot + 5, Math.max(bytes, Atomics.load(this.words, slot + 5)));
    const total = SCRATCH_CAPS.reduce((n, _, i) => n + Atomics.load(this.words, i), 0);
    let previous=Atomics.load(this.words,10);
    while(total>previous){const found=Atomics.compareExchange(this.words,10,previous,total);if(found===previous)break;previous=found;}
  }
  get stats() { return { cap: 32 * 1024 * 1024, charged: SCRATCH_CAPS.map((_, i) => Atomics.load(this.words, i)),
    high: SCRATCH_CAPS.map((_, i) => Atomics.load(this.words, i+5)), highTotal: Atomics.load(this.words,10), refusals: Atomics.load(this.words,11) }; }
}
// Deliberately conservative logical charge for cells + two live copies + strings.
export function rowCharge(row: any) {
  return 256 + row.cells.reduce((n: number, c: any) => n + 256 + 8 * (c.grapheme.length + c.fg.length + c.bg.length), 0);
}
