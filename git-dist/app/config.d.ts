import type { AnsiPalette, LaunchPreset, LaunchSpec, PreferencesAdapter, SessionListItem, SubmitAgent, TerminalSurfaceWithPalette, UploadedFile } from '../core/index.js';
import type { FabAction, GridSession, LaunchContext, TmuxMux } from '../svelte/index.js';
import type { Snippet } from 'svelte';
/** Delivers one composer-submission step through a host-owned transport.
 * A returned promise is settled before the shell starts the next step. */
export type SubmissionTransport = (session: string, keys: string) => void | Promise<void>;
/** Host-owned behavior and policy seams for the mountable application shell. */
export interface AppAdapters {
    /** REST prefix the shell calls, the client half of
     * `createAppRoutes({ basePath })`. Defaults to `/api`, the same default the
     * server normalizes to. Hardcoding it on either side would mean the two
     * halves of one package could be configured into disagreement. The websocket
     * path is fixed at `/ws/tmux` and is deliberately not derived from this. */
    basePath?: string;
    /** Replace the session-list bootstrap outright. Absent, the shell calls
     * `GET {basePath}/sessions`. This exists because a host is not required to
     * serve its sessions through `createAppRoutes` at all — the reference
     * consumer keeps its own server and mounts only the client shell — so the
     * path shape is not something the package gets to assume. */
    fetchSessions?: () => Promise<SessionListItem[]>;
    /** Override the live session-list stream used by `HubView` and `SessionView`
     * after bootstrap. Defaults to the `../svelte/index.js` singleton. This seam
     * does not replace `TermView`'s pane output, history, resize, or connection
     * state; it also does not select the default key transport. Those stay on the
     * shared singleton. `EmbedView` has no session list and does not read `mux`. */
    mux?: TmuxMux;
    /** Override raw input independently of the session-list mux. Absent, raw
     * input and the legacy composer-submission fallback use the shared
     * `../svelte/index.js` singleton. */
    sendKeys?: (session: string, keys: string) => void;
    /** Override composer submissions without moving raw input off `sendKeys`.
     * The shell invokes this once for each `submitPlan` step and awaits a returned
     * promise before invoking the next one. A promise acknowledgement satisfies
     * the following step's planned delay; a synchronous transport keeps that
     * delay. Absent, submissions retain the existing `sendKeys` transport and
     * timer sequence. */
    sendSubmissionKeys?: SubmissionTransport;
    submitAgent?: (session: string) => SubmitAgent;
    routes?: {
        openSession(name: string): void;
        showHub(): void;
    };
    spawn?: {
        presets?: readonly LaunchPreset[];
        contexts?: () => Promise<LaunchContext[]>;
        /** `contextId` is the workspace the viewer picked, or null when the host
         * supplied no `contexts`. It is a separate argument rather than a field on
         * `LaunchSpec` because the spec describes the command to run and the
         * context describes where to run it — `buildLaunchSpec` has no business
         * knowing about workspaces. Dropping it would leave the picker visible and
         * inert. */
        launch?: (spec: LaunchSpec, contextId: string | null) => Promise<{
            name: string;
        }>;
    };
    sessionMeta?: (rows: SessionListItem[]) => GridSession[];
    notes?: {
        load(session: string): Promise<string>;
        save(session: string, text: string): Promise<void>;
    };
    prompts?: (session: string) => Promise<string[]>;
    upload?: {
        endpoint(session: string): string | null;
        dir?: string;
        /** Replace the composer prefill written after a successful upload. Mirrors
         * `formatUploadMessage(files, dir)` from core, so a host that only wants to
         * decorate the default can call that itself. Without this, extraction would
         * silently replace a host's own wording — including its language. */
        formatPrefill?: (files: UploadedFile[], dir: string) => string;
    };
    prefs?: PreferencesAdapter;
    termProps?: (session: string) => Partial<{
        claimGeometry: boolean;
        altScreenMouse: boolean;
        palette: AnsiPalette;
        fontPx: number;
    }>;
    /** The host owns theme state; the shell only reads it and reports intent.
     * `ThemeSheet` is pure presentation — it has no store of its own — so a
     * read-only seam leaves its dark/light toggle and its swatches wired to
     * nothing. Omit the whole block and the shell falls back to its own local
     * state; supply it and every mutation goes to the host. */
    theme?: {
        defaultBg?: string;
        swatches?: string[];
        storageKey?: string;
        bgFor?: (session: string) => string | null;
        /** Current mode, read on each render. */
        mode?: () => 'dark' | 'light';
        /** Full surface for one session. When present this wins over
         * `termProps.palette`, because the stage, HUD and terminal have to agree —
         * a host that derives all of them together should not have to hand them
         * over through two seams that could disagree. */
        surfaceFor?: (session: string) => TerminalSurfaceWithPalette | null;
        onToggleMode?: (mode: 'dark' | 'light') => void;
        /** `session` is passed so a host that themes per agent can derive the
         * target from the name; a host with one global theme ignores it. */
        onPick?: (session: string, hex: string) => void;
        onReset?: (session: string) => void;
    };
    labels?: Partial<AppLabels>;
    /** `FabAction.onTap` takes no arguments, so a host action had no way to reach
     * the composer — a `/clear` that must go through the shell's agent-aware
     * submit, or a failed action that wants to hand the text back to the user,
     * could only be built by copying the shell's own glue. The context is the
     * shell lending its composer rather than the host rebuilding one. */
    extraActions?: (session: string, context: SessionActionContext) => FabAction[];
    extraPanel?: Snippet<[string]>;
    extraSheets?: Snippet<[string]>;
    /** Dismiss any open host overlay; returns whether one was dismissed. This is
     * a command — calling it closes things. */
    extraDismissables?: () => boolean;
    /** Ask whether a host overlay is open, without closing it. Needed because
     * `extraDismissables` cannot answer the question: it dismisses as a side
     * effect of being called, so using it as a query would close the very sheet
     * the shell was checking for. */
    extraOverlayOpen?: () => boolean;
}
/** What the shell lends to a host-supplied action. */
export interface SessionActionContext {
    /** Send through the shell's own submit path, so agent-specific submit
     * quirks stay in one place. */
    submit(text: string): void;
    /** Put text in the composer and open it, without sending. */
    prefill(text: string): void;
}
/** English-by-default copy used by the stock hub and session shells. */
export interface AppLabels {
    hubTitle: string;
    hubCount: (count: number) => string;
    gridNew: string;
    gridEmpty: string;
    gridLoading: string;
    gridAll: string;
    gridSearchLabel: string;
    gridSearchPlaceholder: string;
    gridGroup: string;
    gridUngrouped: string;
    launchTitle: string;
    launchHint: string;
    launchContext: string;
    launchPermission: string;
    launchModel: string;
    launchAction: string;
    launchBusy: string;
    /** Takes the message so a host can replace the whole line, not just a
     * prefix. Mirrors `uploadFailed`, which already worked this way. */
    launchFailed: (message: string) => string;
    hudBack: string;
    hudChip: string;
    hudConnected: string;
    hudOffline: string;
    terminalAria: (session: string) => string;
    fabAria: string;
    actionType: string;
    actionUpload: string;
    actionUploading: string;
    actionDpad: string;
    actionCopy: string;
    actionShortcuts: string;
    actionTheme: string;
    actionFontUp: string;
    actionFontDown: string;
    scrollNewContent: string;
    scrollBottom: string;
    uploadFailed: (message: string) => string;
    noteEmpty: string;
    noteEdit: string;
    noteSave: string;
    noteCancel: string;
    promptsTitle: string;
    promptsLoading: string;
    promptsEmpty: string;
    shortcutsTitle: string;
    shortcutAdd: string;
    shortcutLabel: string;
    shortcutSend: string;
    shortcutDelete: string;
    shortcutUp: string;
    shortcutDown: string;
    themeTitle: string;
    themeBackground: string;
    themeDark: string;
    themeLight: string;
    themeDefault: string;
    themeCustom: string;
    composerCompose: string;
    composerDirect: string;
    composerHintCompose: string;
    composerHintDirect: string;
    composerPlaceholder: string;
    composerSend: string;
    composerDirectAria: string;
    close: string;
}
export declare const DEFAULT_APP_LABELS: Readonly<{
    hubTitle: string;
    hubCount: (count: number) => string;
    gridNew: string;
    gridEmpty: string;
    gridLoading: string;
    gridAll: string;
    gridSearchLabel: string;
    gridSearchPlaceholder: string;
    gridGroup: string;
    gridUngrouped: string;
    launchTitle: string;
    launchHint: string;
    launchContext: string;
    launchPermission: string;
    launchModel: string;
    launchAction: string;
    launchBusy: string;
    launchFailed: (message: string) => string;
    hudBack: string;
    hudChip: string;
    hudConnected: string;
    hudOffline: string;
    terminalAria: (session: string) => string;
    fabAria: string;
    actionType: string;
    actionUpload: string;
    actionUploading: string;
    actionDpad: string;
    actionCopy: string;
    actionShortcuts: string;
    actionTheme: string;
    actionFontUp: string;
    actionFontDown: string;
    scrollNewContent: string;
    scrollBottom: string;
    uploadFailed: (message: string) => string;
    noteEmpty: string;
    noteEdit: string;
    noteSave: string;
    noteCancel: string;
    promptsTitle: string;
    promptsLoading: string;
    promptsEmpty: string;
    shortcutsTitle: string;
    shortcutAdd: string;
    shortcutLabel: string;
    shortcutSend: string;
    shortcutDelete: string;
    shortcutUp: string;
    shortcutDown: string;
    themeTitle: string;
    themeBackground: string;
    themeDark: string;
    themeLight: string;
    themeDefault: string;
    themeCustom: string;
    composerCompose: string;
    composerDirect: string;
    composerHintCompose: string;
    composerHintDirect: string;
    composerPlaceholder: string;
    composerSend: string;
    composerDirectAria: string;
    close: string;
}>;
