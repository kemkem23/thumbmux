/**
 * @thumbmux/svelte — Svelte 5 pieces of the thumbmux terminal stack.
 *
 * TermView     compositor-only 120Hz terminal viewer (virtualized, translate3d)
 * DesktopKeys  desktop keyboard/IME/paste wrapper (focusable, keys → pane bytes)
 * ComposerDock docked input sheet (COMPOSE/DIRECT + OS-keyboard-aware insets)
 * TermHud      pinned top bar with host-supplied expandable panel
 * DpadSheet    arrow/enter/escape pad for TUI menus
 * ThemeSheet   dark/light + background swatch picker (host owns the store)
 * ActionFab    single-launcher floating action slots
 * ws-mux       multiplexed WebSocket client (subscribe/keys/resize/history)
 */
export { default as TermView } from './TermView.svelte';
export {
  default as DesktopKeys,
  type DesktopKeysProps,
  type DesktopPasteInfo,
} from './DesktopKeys.svelte';
export { default as ComposerDock, type ComposerLabels } from './ComposerDock.svelte';
export { default as TermHud } from './TermHud.svelte';
export { default as DpadSheet } from './DpadSheet.svelte';
export { default as ThemeSheet } from './ThemeSheet.svelte';
export { default as ActionFab, type FabAction } from './ActionFab.svelte';
export { tmuxMux, configureTmuxMux, TmuxMux, type TmuxMuxOptions } from './ws-mux.svelte';
export { default as NewTerminalSheet, type SpawnAgent } from './NewTerminalSheet.svelte';
export { default as SessionThumb } from './SessionThumb.svelte';
export { default as SessionGrid, type GridSession } from './SessionGrid.svelte';
export { default as LaunchSheet, type LaunchContext } from './LaunchSheet.svelte';
export { default as UploadAction } from './UploadAction.svelte';
export { default as ShortcutBar } from './ShortcutBar.svelte';
export { default as ShortcutsSheet } from './ShortcutsSheet.svelte';
export { default as NotePanel } from './NotePanel.svelte';
export { default as PromptsPanel } from './PromptsPanel.svelte';
export { createLocalPrefs, createServerPrefs } from './prefs.svelte';
