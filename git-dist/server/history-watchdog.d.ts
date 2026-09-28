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
