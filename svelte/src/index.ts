/**
 * @thumbmux/svelte — Svelte 5 pieces of the thumbmux terminal stack.
 *
 * TermView   compositor-only 120Hz terminal viewer (virtualized, translate3d)
 * ws-mux     multiplexed WebSocket client (subscribe/keys/resize/history)
 */
export { default as TermView } from './TermView.svelte';
export { tmuxMux, configureTmuxMux, TmuxMux, type TmuxMuxOptions } from './ws-mux.svelte';
