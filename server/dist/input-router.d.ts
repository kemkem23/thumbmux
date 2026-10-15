/**
 * Additive input boundary for NEWARCH L5.  Wiring it into the websocket mux is
 * deliberately left to L6: legacy input remains live until cutover is approved.
 * Payload bytes are handed only to `sendExactPane`; metadata never contains
 * the payload or a hash derived from it.
 */
export type PaneInputLease = {
    sessionId: string;
    paneId: string;
    generation: string;
};
export type InputKind = 'text' | 'control' | 'paste' | 'submit';
export type PaneInputOperation = {
    eventId: string;
    clientSequence: number;
    lease: PaneInputLease;
    kind: InputKind;
    data: string;
};
export type InputDeliveryStatus = 'received' | 'sent_to_tmux' | 'delivery_unknown' | 'rejected_stale_lease' | 'duplicate';
export type InputMetadata = {
    eventId: string;
    clientSequence: number;
    sessionId: string;
    paneId: string;
    generation: string;
    kind: InputKind;
    byteLength: number;
    status: InputDeliveryStatus;
};
export type InputReceiptStore = {
    /** Atomic first-writer claim. false means this event was already seen. */
    claim(metadata: InputMetadata): boolean;
    update(metadata: InputMetadata): void;
    auditGap?(metadata: InputMetadata, error: unknown): void;
};
export type InputRouterDependencies = {
    currentLease(paneId: string): PaneInputLease | null;
    sendExactPane(paneId: string, data: string): void;
    receipts: InputReceiptStore;
};
export declare function createInputRouter(deps: InputRouterDependencies): {
    route(operation: PaneInputOperation): InputMetadata;
};
