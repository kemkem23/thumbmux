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

export type InputDeliveryStatus =
  | 'received'
  | 'sent_to_tmux'
  | 'delivery_unknown'
  | 'rejected_stale_lease'
  | 'duplicate';

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

function sameLease(a: PaneInputLease, b: PaneInputLease): boolean {
  return a.sessionId === b.sessionId && a.paneId === b.paneId && a.generation === b.generation;
}

function assertOperation(operation: PaneInputOperation): void {
  if (!operation.eventId) throw new Error('input eventId is required');
  if (!Number.isSafeInteger(operation.clientSequence) || operation.clientSequence < 0) {
    throw new Error('input clientSequence must be a non-negative safe integer');
  }
  if (!/^%\d+$/.test(operation.lease.paneId)) {
    throw new Error('input lease paneId must be an exact tmux pane ID');
  }
}

function metadataOf(operation: PaneInputOperation, status: InputDeliveryStatus): InputMetadata {
  return {
    eventId: operation.eventId,
    clientSequence: operation.clientSequence,
    sessionId: operation.lease.sessionId,
    paneId: operation.lease.paneId,
    generation: operation.lease.generation,
    kind: operation.kind,
    byteLength: new TextEncoder().encode(operation.data).byteLength,
    status,
  };
}

export function createInputRouter(deps: InputRouterDependencies) {
  return {
    route(operation: PaneInputOperation): InputMetadata {
      assertOperation(operation);
      const current = deps.currentLease(operation.lease.paneId);
      if (!current || !sameLease(current, operation.lease)) {
        return metadataOf(operation, 'rejected_stale_lease');
      }

      const received = metadataOf(operation, 'received');
      if (!deps.receipts.claim(received)) return metadataOf(operation, 'duplicate');

      try {
        // Exact pane ID only: never resolve a session prefix or ambient pane.
        deps.sendExactPane(operation.lease.paneId, operation.data);
      } catch (error) {
        const unknown = metadataOf(operation, 'delivery_unknown');
        try { deps.receipts.update(unknown); } catch (receiptError) {
          deps.receipts.auditGap?.(unknown, receiptError);
        }
        return unknown;
      }

      const sent = metadataOf(operation, 'sent_to_tmux');
      try { deps.receipts.update(sent); } catch (error) {
        // Delivery already happened. Never replay a key to repair metadata.
        deps.receipts.auditGap?.(sent, error);
      }
      return sent;
    },
  };
}
