export interface WatchdogContext {
    sourceEpoch: number;
    geometryGeneration: number;
    kind: 'normal' | 'alternate';
}
export type HistoryFault = {
    kind: string;
    at: number;
    missingCount: null;
};
/** Host heartbeat must be called from outside the worker event loop. */
export declare class HistoryWatchdog {
    private now;
    private fault;
    private heartbeatAt;
    private receiveSeq;
    private image;
    private imageSeq;
    private contextKey;
    private movementWithoutReceiveAt;
    private emitted;
    constructor(now: () => number, fault: (fault: HistoryFault) => void);
    heartbeat(): void;
    receive(seq: number): void;
    capture(image: string, context?: WatchdogContext): void;
    dead(kind: 'reader-eof' | 'reader-dead' | 'worker-dead' | 'pipe-replaced'): void;
    tick(): void;
    private emit;
}
/** Stream-first watchdog. The host calls tick every 250ms independently of
 * parser work. Silence alone is healthy; only an outstanding ACK or observed
 * source progress without received bytes starts the 500ms suspicion clock.
 * Source progress must come from the source owner, never a receive counter. */
export declare class StreamCaptureWatchdog {
    private readonly clock;
    private readonly notify;
    private ackPendingAt;
    private movementAt;
    private received;
    private source;
    private sent;
    private acked;
    private readonly emitted;
    constructor(clock: () => number, notify: (reason: 'ack-timeout' | 'stalled-input' | 'sequence') => void);
    reset(): void;
    receive(totalBytes: number): void;
    sourceProgress(total: number): void;
    submitted(seq: number): void;
    ack(seq: number): void;
    tick(): void;
    private emit;
}
