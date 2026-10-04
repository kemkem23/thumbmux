export interface WatchdogContext {
  sourceEpoch: number;
  geometryGeneration: number;
  kind: 'normal' | 'alternate';
}
export type HistoryFault = { kind: string; at: number; missingCount: null };
/** Host heartbeat must be called from outside the worker event loop. */
export class HistoryWatchdog {
  private heartbeatAt: number;
  private receiveSeq = 0;
  private image: string | undefined;
  private imageSeq = 0;
  private contextKey: string | undefined;
  private movementWithoutReceiveAt: number | undefined;
  private emitted = new Set<string>();
  constructor(private now: () => number, private fault: (fault: HistoryFault) => void) {
    this.heartbeatAt = now();
  }
  heartbeat(): void { this.heartbeatAt = this.now(); this.emitted.delete('heartbeat-timeout'); }
  receive(seq: number): void {
    if (seq > this.receiveSeq) {
      this.receiveSeq = seq;
      this.movementWithoutReceiveAt = undefined;
      this.emitted.delete('reader-stalled');
    }
  }
  capture(image: string, context?: WatchdogContext): void {
    // An omitted context is "unchanged", not a context of its own: callers
    // that pass it only sometimes must not reset the comparison each time.
    const key = context === undefined ? this.contextKey
      : `${context.sourceEpoch}/${context.geometryGeneration}/${context.kind}`;
    if (key !== this.contextKey) {
      this.contextKey = key;
      this.image = undefined;
      this.movementWithoutReceiveAt = undefined;
      this.emitted.delete('reader-stalled');
    }
    if (this.image !== undefined && image !== this.image && this.imageSeq === this.receiveSeq)
      this.movementWithoutReceiveAt ??= this.now();
    this.image = image; this.imageSeq = this.receiveSeq;
  }
  dead(kind: 'reader-eof' | 'reader-dead' | 'worker-dead' | 'pipe-replaced'): void { this.emit(kind); }
  tick(): void {
    if (this.now() - this.heartbeatAt >= 3000) this.emit('heartbeat-timeout');
    if (this.movementWithoutReceiveAt !== undefined && this.now() - this.movementWithoutReceiveAt >= 1000)
      this.emit('reader-stalled');
  }
  private emit(kind: string): void {
    if (this.emitted.has(kind)) return;
    this.emitted.add(kind);
    this.fault({ kind, at: this.now(), missingCount: null });
  }
}

/** Stream-first watchdog. The host calls tick every 250ms independently of
 * parser work. Silence alone is healthy; only an outstanding ACK or observed
 * source progress without received bytes starts the 500ms suspicion clock.
 * Source progress must come from the source owner, never a receive counter. */
export class StreamCaptureWatchdog {
  private ackPendingAt: number | null = null;
  private movementAt: number | null = null;
  private received = 0;
  private source: number | null = null;
  private sent = 0;
  private acked = 0;
  private readonly emitted = new Set<string>();
  constructor(private readonly clock: () => number,
    private readonly notify: (reason: 'ack-timeout' | 'stalled-input' | 'sequence') => void) {}
  reset(): void {
    this.ackPendingAt = this.movementAt = this.source = null;
    this.received = this.sent = this.acked = 0; this.emitted.clear();
  }
  receive(totalBytes: number): void {
    if (!Number.isSafeInteger(totalBytes) || totalBytes < this.received) throw new Error('receive counter');
    if (totalBytes > this.received) { this.movementAt = null; this.emitted.delete('stalled-input'); }
    this.received = totalBytes;
  }
  sourceProgress(total: number): void {
    if (!Number.isSafeInteger(total) || total < 0) throw new Error('source counter');
    if (this.source !== null && total < this.source) { this.emit('sequence'); return; }
    if (this.source !== null && total > this.source) this.movementAt ??= this.clock();
    this.source = total;
  }
  submitted(seq: number): void {
    if (!Number.isSafeInteger(seq) || seq !== this.sent + 1) { this.emit('sequence'); return; }
    this.sent = seq; this.ackPendingAt ??= this.clock();
  }
  ack(seq: number): void {
    if (!Number.isSafeInteger(seq) || seq < this.acked || seq > this.sent) { this.emit('sequence'); return; }
    if (seq > this.acked) {
      this.acked = seq;
      // Progress restarts the stall interval; fully drained clears it.
      this.ackPendingAt = this.acked === this.sent ? null : this.clock();
      this.emitted.delete('ack-timeout');
    }
  }
  tick(): void {
    const now = this.clock();
    if (this.ackPendingAt !== null && now - this.ackPendingAt >= 500) this.emit('ack-timeout');
    if (this.movementAt !== null && now - this.movementAt >= 500) this.emit('stalled-input');
  }
  private emit(reason: 'ack-timeout' | 'stalled-input' | 'sequence'): void {
    if (this.emitted.has(reason)) return;
    this.emitted.add(reason); this.notify(reason);
  }
}
