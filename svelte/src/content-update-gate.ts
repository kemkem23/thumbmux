export type ContentUpdateMeta = {
  source: 'full' | 'delta';
  replace: boolean;
};

export type ContentLinesChangeSource = 'live' | 'replace';

export type ContentUpdate = {
  data: string;
  cursor?: { row: number; col: number } | null;
  meta: ContentUpdateMeta;
  /** Preserves the newest frame's cause when reset application stays sticky. */
  linesChangeSource?: ContentLinesChangeSource;
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
  const cloned: ContentUpdate = {
    data: delivery.data,
    cursor: delivery.cursor ? { ...delivery.cursor } : delivery.cursor,
    meta: { ...delivery.meta },
  };
  if (delivery.linesChangeSource !== undefined) {
    cloned.linesChangeSource = delivery.linesChangeSource;
  }
  return cloned;
}

function coalesceDelivery(
  pending: ContentUpdate | null,
  delivery: ContentUpdate,
): ContentUpdate {
  const next = cloneDelivery(delivery);
  const pendingSource = pending === null ? null : contentLinesChangeSource(pending);
  const incomingSource = contentLinesChangeSource(next);
  if (pendingSource !== null) {
    // The delivered snapshot subsumes everything received while blocked. If
    // any frame in that coalesced interval carried unseen live output, keep
    // that host-UI cause even when a later reset is the newest snapshot.
    next.linesChangeSource = pendingSource === 'live' || incomingSource === 'live'
      ? 'live'
      : 'replace';
  }
  // A reset describes how the local view must consume the next complete
  // snapshot, not just the individual wire frame that carried it. Keep that
  // requirement until a delivery is actually applied.
  if (pending?.meta.replace) {
    next.meta.replace = true;
  }
  return next;
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
  const next = coalesceDelivery(gate.pending, delivery);
  if (isBlocked(block)) {
    return { gate: { pending: next }, delivery: null };
  }
  return { gate: { pending: null }, delivery: next };
}

/**
 * Cursor-only frames are newer than the cursor bundled with a pending
 * content snapshot. Mirror them into that snapshot so a later flush cannot
 * replay the older caret position over the live cursor.
 */
export function updatePendingContentCursor(
  gate: ContentUpdateGate,
  cursor: { row: number; col: number } | null,
): ContentUpdateGate {
  if (gate.pending === null) return gate;
  const pending = cloneDelivery(gate.pending);
  pending.cursor = cursor ? { ...cursor } : cursor;
  return { pending };
}

/**
 * Replacement is an application instruction, while this source is the cause
 * of the newest content. Any newer ordinary delivery coalesced after a reset
 * must still replace the local window, but represents unseen live output to
 * host UI.
 */
export function contentLinesChangeSource(update: ContentUpdate): ContentLinesChangeSource {
  if (update.linesChangeSource !== undefined) return update.linesChangeSource;
  if (update.meta.source === 'delta') return 'live';
  return update.meta.replace ? 'replace' : 'live';
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
