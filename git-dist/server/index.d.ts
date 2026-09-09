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
 * output-wal    lossless, checksummed raw-output WAL for history materializers.
 * terminal-control-wal-recorder  ordered read-only tmux control-mode WAL capture.
 * terminal-replay-materializer  private-tmux raw-WAL renderer with atomic checkpoints.
 * terminal-replay-worker  supervised out-of-process incremental replay client.
 * token-guard   scoped, expiring bearer-token authorization primitive.
 * history-stitch  pure reconciliation of a fresh capture against stored history.
 * durable-history-archive  plain-text scrollback store that also keeps the live
 *            window, for hosts that want history to survive losing tmux.
 * retention-lane  keeps chosen sessions archived with no viewer attached; pair
 *            it with the durable archive when history must outlive the tab.
 */
import { TerminalWalController as TerminalWalControllerValue } from './integrations/terminal-wal.js';
import { createTerminalPtyWalProxyLaunchSpec as createTerminalPtyWalProxyLaunchSpecValue, readTerminalPtyWalProxyHealth as readTerminalPtyWalProxyHealthValue } from './integrations/terminal-pty-wal-proxy.js';
import { createTerminalReplayWorkerClient as createTerminalReplayWorkerClientValue, resolveTerminalReplayWorkerPath as resolveTerminalReplayWorkerPathValue } from './integrations/terminal-replay-worker.js';
export declare const createTerminalPtyWalProxyLaunchSpec: typeof createTerminalPtyWalProxyLaunchSpecValue;
export declare const createTerminalReplayWorkerClient: typeof createTerminalReplayWorkerClientValue;
export declare const readTerminalPtyWalProxyHealth: typeof readTerminalPtyWalProxyHealthValue;
export declare const resolveTerminalReplayWorkerPath: typeof resolveTerminalReplayWorkerPathValue;
export declare const TerminalWalController: typeof TerminalWalControllerValue;
export type TerminalWalController = TerminalWalControllerValue;
export declare const TERMINAL_PTY_WAL_CONFIG_ENV = "THUMBMUX_TERMINAL_PTY_WAL_CONFIG";
export type { TerminalPtyWalProxyHealth } from './integrations/terminal-pty-wal-proxy.js';
export * from './ws-mux.js';
export * from './bun-driver.js';
export * from './spawn-handler.js';
export * from './upload-handler.js';
export * from "./prefs-handler.js";
export * from './frame-journal.js';
export * from './token-guard.js';
export * from './history-archive.js';
export * from './history-stitch.js';
export * from './durable-history-archive.js';
export * from './retention-lane.js';
export * from './app-routes.js';
