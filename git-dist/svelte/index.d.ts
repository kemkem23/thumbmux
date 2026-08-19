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
export { default as DesktopKeys, type DesktopKeysProps, type DesktopPasteInfo, } from './DesktopKeys.svelte';
export { default as ComposerDock, type ComposerLabels } from './ComposerDock.svelte';
export { default as TermHud } from './TermHud.svelte';
export { default as DpadSheet } from './DpadSheet.svelte';
export { DEFAULT_DPAD_PLACEMENT, resolveDpadPlacement, type DpadPlacement, } from './dpad.js';
export { default as ThemeSheet } from './ThemeSheet.svelte';
export { default as ActionFab, type FabAction } from './ActionFab.svelte';
export { tmuxMux, configureTmuxMux, TmuxMux, type TmuxMuxOptions } from './ws-mux.svelte';
export { default as NewTerminalSheet, type SpawnAgent } from './NewTerminalSheet.svelte';
export { default as SessionThumb } from './SessionThumb.svelte';
export { default as SessionGrid } from './SessionGrid.svelte';
export type { GridFilterOption, GridOrder, GridSession, GridSessionState, SessionGridProps, } from './session-grid.js';
export { displayStateLabel, splitSessionName, buildSessionGridModel, contrastRatio, readableColorOn, deriveThumbnailPalette, } from './session-grid.js';
export { default as LaunchSheet, type LaunchContext } from './LaunchSheet.svelte';
export { default as UploadAction } from './UploadAction.svelte';
export { default as ShortcutBar } from './ShortcutBar.svelte';
export { default as ShortcutsSheet } from './ShortcutsSheet.svelte';
export { default as NotePanel } from './NotePanel.svelte';
export { default as PromptsPanel } from './PromptsPanel.svelte';
export { createLocalPrefs, createServerPrefs } from './prefs.svelte';
export { default as RecordingPlayer } from './RecordingPlayer.svelte';
export { PLAYBACK_SPEEDS, RECORDING_PLAYER_TEST_IDS, FRAME_HTML_CACHE_LIMIT, clampPlaybackElapsed, lookupReplayFrame, resolveReplayFrame, createPlaybackController, createFrameHtmlCache, type PlaybackSpeed, type ReplayJournalLike, type ResolveReplayFrameCode, type ResolveReplayFrameSuccess, type ResolveReplayFrameFailure, type ResolveReplayFrameResult, type PlaybackNow, type PlaybackScheduler, type PlaybackCanceller, type PlaybackChangeObserver, type PlaybackSnapshot, type PlaybackControllerOptions, type RecordingPlaybackController, type FrameHtmlLineToHtml, type FrameHtmlCacheInput, type FrameHtmlCache, type CreateFrameHtmlCacheOptions, } from './recording-player.js';
export { default as NotificationPermission, type NotificationPermissionErrorPhase, type NotificationPermissionError, type NotificationPermissionProps, } from './NotificationPermission.svelte';
export { resolveNotificationEnvironment, resolveNotificationPermissionState, requestNotificationPermission, registerServiceWorker, showLocalNotification, type NotificationPermissionState, type BrowserLocationLike, type BrowserNotificationApiLike, type BrowserNavigatorLike, type BrowserServiceWorkerContainerLike, type BrowserServiceWorkerRegistrationLike, type BrowserServiceWorkerRegistrationOptions, type BrowserServiceWorkerShowOptions, type BrowserNotificationEnvironment, type ResolvedBrowserNotificationEnvironment, type NotificationResultSuccess, type NotificationResultError, type NotificationResult, type PermissionRequestResult, type ServiceWorkerRegistrationResult, type LocalNotificationResult, type RegisterServiceWorkerInput, type ShowLocalNotificationInput, } from './notifications.js';
export { parseNotificationPayload, handlePushNotificationEvent, handleNotificationClickEvent, registerNotificationServiceWorkerHandlers, type ServiceWorkerListenerHost, type PushPayloadDataLike, type PushEventLike, type RegistrationForPush, type NotificationLike, type NotificationClickEventLike, type ClientHost, type ServiceWorkerResultSuccess, type ServiceWorkerResultError, type ServiceWorkerResult, type ParsePayloadOptions, type ParsePayloadErrorCode, type ParsePayloadResult, type PushContext, type PushErrorCode, type PushResult, type ClickContext, type ClickErrorCode, type ClickResult, type ListenerContext, type NotificationListeners, type RegistrationErrorCode, type RegistrationResult, } from './service-worker.js';
export { default as TermSearch } from './TermSearch.svelte';
export { searchKeyIntent, moveActiveIndex, type SearchDirection, type SearchKeyScope, type SearchKeyIntent, } from './term-search.js';
export { contentLinesChangeSource, createContentUpdateGate, flushContentUpdate, receiveContentUpdate, updatePendingContentCursor, type ContentLinesChangeSource, type ContentUpdate, type ContentUpdateBlock, type ContentUpdateGate, type ContentUpdateGateResult, type ContentUpdateMeta, } from './content-update-gate.js';
