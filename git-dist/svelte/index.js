/**
 * thumbmux/svelte — Svelte 5 pieces of the thumbmux terminal stack.
 *
 * TermView                 compositor-only 120Hz terminal viewer (virtualized, translate3d)
 * DesktopKeys              desktop keyboard/IME/paste wrapper (focusable, keys → pane bytes)
 * ComposerDock             docked input sheet (COMPOSE/DIRECT + OS-keyboard-aware insets)
 * TermHud                  pinned top bar with host-supplied expandable panel
 * DpadSheet                arrow/enter/escape pad for TUI menus
 * ThemeSheet               dark/light + background swatch picker (host owns the store)
 * ActionFab                single-launcher floating action slots
 * ws-mux                   multiplexed WebSocket client (subscribe/keys/resize/history)
 * RecordingPlayer          recorded-session playback UI (speed/seek/frame cache)
 * recording-player         pure playback controller + frame HTML cache helpers
 * NotificationPermission   browser notification opt-in + SW registration UI
 * notifications            browser Notification/SW permission + local-show helpers
 * service-worker           push/click handlers for the notification service worker
 * TermSearch               in-terminal search bar (query / next / previous / close)
 * term-search              host-facing search key intents + active-index helpers
 */
export { default as TermView } from './TermView.svelte';
export { default as DesktopKeys, } from './DesktopKeys.svelte';
export { default as ComposerDock } from './ComposerDock.svelte';
export { default as TermHud } from './TermHud.svelte';
export { default as DpadSheet } from './DpadSheet.svelte';
export { default as ThemeSheet } from './ThemeSheet.svelte';
export { default as ActionFab } from './ActionFab.svelte';
export { tmuxMux, configureTmuxMux, TmuxMux } from './ws-mux.svelte';
export { default as NewTerminalSheet } from './NewTerminalSheet.svelte';
export { default as SessionThumb } from './SessionThumb.svelte';
export { default as SessionGrid } from './SessionGrid.svelte';
export { displayStateLabel, splitSessionName, buildSessionGridModel, contrastRatio, readableColorOn, deriveThumbnailPalette, } from './session-grid';
export { default as LaunchSheet } from './LaunchSheet.svelte';
export { default as UploadAction } from './UploadAction.svelte';
export { default as ShortcutBar } from './ShortcutBar.svelte';
export { default as ShortcutsSheet } from './ShortcutsSheet.svelte';
export { default as NotePanel } from './NotePanel.svelte';
export { default as PromptsPanel } from './PromptsPanel.svelte';
export { createLocalPrefs, createServerPrefs } from './prefs.svelte';
export { default as RecordingPlayer } from './RecordingPlayer.svelte';
export { PLAYBACK_SPEEDS, RECORDING_PLAYER_TEST_IDS, FRAME_HTML_CACHE_LIMIT, clampPlaybackElapsed, lookupReplayFrame, resolveReplayFrame, createPlaybackController, createFrameHtmlCache, } from './recording-player';
export { default as NotificationPermission, } from './NotificationPermission.svelte';
export { resolveNotificationEnvironment, resolveNotificationPermissionState, requestNotificationPermission, registerServiceWorker, showLocalNotification, } from './notifications';
export { parseNotificationPayload, handlePushNotificationEvent, handleNotificationClickEvent, registerNotificationServiceWorkerHandlers, } from './service-worker';
export { default as TermSearch } from './TermSearch.svelte';
export { searchKeyIntent, moveActiveIndex, } from './term-search';
