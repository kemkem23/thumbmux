export type HistoryFault = { kind: string; at: number; missingCount: null };
/** Host heartbeat must be called from outside the worker event loop. */
export class HistoryWatchdog {
  private heartbeatAt: number;
  private receiveSeq = 0;
  private image: string | undefined;
  private imageSeq = 0;
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
  capture(image: string): void {
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
