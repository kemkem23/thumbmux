export type ContentUpdateMeta = {
  source: 'full' | 'delta';
  replace: boolean;
};

export type ContentUpdate = {
  data: string;
  cursor?: { row: number; col: number } | null;
  meta: ContentUpdateMeta;
};

export type ContentUpdateGate = {
  pending: ContentUpdate | null;
};

export type ContentUpdateBlock = {
  busy: boolean;
  selectionActive: boolean;
};

export type ContentUpdateGateResult = {
  gate: ContentUpdateGate;
  delivery: ContentUpdate | null;
};

export function createContentUpdateGate(): ContentUpdateGate {
  return { pending: null };
}

function cloneDelivery(delivery: ContentUpdate): ContentUpdate {
  return {
    data: delivery.data,
    cursor: delivery.cursor ? { ...delivery.cursor } : delivery.cursor,
    meta: { ...delivery.meta },
  };
}

function isBlocked(block: ContentUpdateBlock): boolean {
  return block.busy || block.selectionActive;
}

/**
 * Route a reconstructed content delivery around an active selection or
 * gesture. A blocked view retains only the newest whole capture, so a later
 * flush can never replay stale content, cursor data, or reset semantics.
 */
export function receiveContentUpdate(
  gate: ContentUpdateGate,
  delivery: ContentUpdate,
  block: ContentUpdateBlock,
): ContentUpdateGateResult {
  const next = cloneDelivery(delivery);
  if (isBlocked(block)) {
    return { gate: { pending: next }, delivery: null };
  }
  return { gate: { pending: null }, delivery: next };
}

/** Flushes one coalesced delivery only when selection and gestures are idle. */
export function flushContentUpdate(
  gate: ContentUpdateGate,
  block: ContentUpdateBlock,
): ContentUpdateGateResult {
  if (isBlocked(block) || gate.pending === null) {
    return { gate, delivery: null };
  }
  return { gate: { pending: null }, delivery: cloneDelivery(gate.pending) };
}
