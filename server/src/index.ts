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
import { TerminalWalController as TerminalWalControllerValue } from './integrations/terminal-wal';
import {
  createTerminalPtyWalProxyLaunchSpec as createTerminalPtyWalProxyLaunchSpecValue,
  readTerminalPtyWalProxyHealth as readTerminalPtyWalProxyHealthValue,
  TERMINAL_PTY_WAL_CONFIG_ENV as TERMINAL_PTY_WAL_CONFIG_ENV_VALUE,
} from './integrations/terminal-pty-wal-proxy';
import {
  createTerminalReplayWorkerClient as createTerminalReplayWorkerClientValue,
  resolveTerminalReplayWorkerPath as resolveTerminalReplayWorkerPathValue,
} from './integrations/terminal-replay-worker';

// Bun 1.3.11 can leave dangling symbols when these values are expressed as
// direct named re-exports from the barrel. Const aliases preserve the exact
// runtime objects while forcing their implementation modules into the bundle.
export const createTerminalPtyWalProxyLaunchSpec = createTerminalPtyWalProxyLaunchSpecValue;
export const createTerminalReplayWorkerClient = createTerminalReplayWorkerClientValue;
export const readTerminalPtyWalProxyHealth = readTerminalPtyWalProxyHealthValue;
export const resolveTerminalReplayWorkerPath = resolveTerminalReplayWorkerPathValue;
export const TerminalWalController = TerminalWalControllerValue;
export type TerminalWalController = TerminalWalControllerValue;
export const TERMINAL_PTY_WAL_CONFIG_ENV = TERMINAL_PTY_WAL_CONFIG_ENV_VALUE;
export type { TerminalPtyWalProxyHealth } from './integrations/terminal-pty-wal-proxy';

export * from './ws-mux';
export * from './bun-driver';
export * from './tmux-capture-normalize';
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
