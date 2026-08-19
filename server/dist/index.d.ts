/**
 * thumbmux/server — server side of the thumbmux terminal stack (Bun/Node).
 *
 * TmuxWsMux  multiplexed WS engine: shared adaptive polling + pipe-pane dirty
 *            signals + hash dedupe + per-socket tail mode + history expand +
 *            session-list pushes. Bring a TmuxDriver and optional policy
 *            hooks; the wire format lives in thumbmux/core (protocol.ts).
 * bun-driver createBunTmuxDriver() — complete reference driver over the tmux
 *            CLI (Bun-only; the mux itself is runtime-agnostic).
 * frame-journal nonblocking canonical full/delta NDJSON recorder.
 * token-guard   scoped, expiring bearer-token authorization primitive.
 * history-stitch  pure reconciliation of a fresh capture against stored history.
 * durable-history-archive  plain-text scrollback store that also keeps the live
 *            window, for hosts that want history to survive losing tmux.
 * retention-lane  keeps chosen sessions archived with no viewer attached; pair
 *            it with the durable archive when history must outlive the tab.
 */
export * from './ws-mux';
export * from './bun-driver';
export * from './spawn-handler';
export * from './upload-handler';
export * from "./prefs-handler";
export * from './frame-journal';
export * from './token-guard';
export * from './history-archive';
export * from './history-stitch';
export * from './durable-history-archive';
export * from './retention-lane';
export * from './app-routes';
