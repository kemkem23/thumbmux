/**
 * @thumbmux/server — server side of the thumbmux terminal stack (Bun/Node).
 *
 * TmuxWsMux  multiplexed WS engine: shared adaptive polling + pipe-pane dirty
 *            signals + hash dedupe + history expand + session-list pushes.
 *            Bring a TmuxDriver (how to talk to tmux) and optional policy
 *            hooks; the wire format lives in @thumbmux/core (protocol.ts).
 */
export {
  TmuxWsMux,
  type WsLike,
  type TmuxDriver,
  type PipeManagerLike,
  type HistoryArchiveLike,
  type SessionProfile,
  type MuxHooks,
  type TmuxWsMuxOptions,
} from './ws-mux';
