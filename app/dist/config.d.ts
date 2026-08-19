import type { AnsiPalette, LaunchPreset, LaunchSpec, PreferencesAdapter, SessionListItem, SubmitAgent, TerminalSurfaceWithPalette, UploadedFile } from '@thumbmux/core';
import type { FabAction, GridFilterOption, GridOrder, GridSession, LaunchContext, TmuxMux } from '@thumbmux/svelte';
import type { Snippet } from 'svelte';
/** Delivers one composer-submission step through a host-owned transport.
 * A returned promise is settled before the shell starts the next step. */
export type SubmissionTransport = (session: string, keys: string) => void | Promise<void>;
/** Optional presentation choices for the hub's grid and launcher. Omitted
 * members retain the presentation components' stock defaults. Hub launcher
 * color mode remains on `AppAdapters.theme.mode`, alongside the shell's other
 * theme state, instead of creating a second source of truth here. */
export interface HubPresentationOptions {
    filterOptions?: readonly GridFilterOption[];
    groupable?: boolean;
    order?: GridOrder;
    showCommand?: boolean;
    /** Opt into the full-width-mobile / 500px-desktop metadata card layout. */
    cardLayout?: 'default' | 'dense';
}
/** Optional presentation choices for one mounted session. Omitted members
 * retain `SessionView`'s stock controls. */
export interface SessionPresentationOptions {
    /** Opt into the wrapping `name : note : activity : expand` HUD. */
    headerLayout?: 'default' | 'dense';
    /** Compose the complete FAB list after stock actions and legacy
     * `extraActions` have been assembled. Returning the supplied actions by
     * reference preserves their existing behavior; newly created actions are
     * given the same FAB auto-dismiss behavior as legacy extra actions. */
    actions?: (session: string, context: SessionActionContext, defaults: readonly FabAction[]) => readonly FabAction[];
    /** Render the persistent shortcut chips and manage button. Defaults true. */
    showShortcutBar?: boolean;
    /** Put the recent-prompt list behind a disclosure in the HUD panel.
     *
     * Defaults false, which reproduces today's always-open list exactly. A host
     * that adds its own panel content through `extraPanel` runs out of panel
     * height fast — five prompts is most of a phone screen — and the collapsed
     * list is what makes the rest of the stack reachable without scrolling. */
    promptsCollapsible?: boolean;
    /** Start the collapsible prompt list open. When paired with
     * `promptsCollapsible`, SessionView also prefetches the prompt adapter and
     * renders this list first, so the first HUD expansion can show recall
     * immediately. Defaults false (collapsed); has no effect unless
     * `promptsCollapsible` is set. */
    promptsInitiallyOpen?: boolean;
    /** Where `extraPanel` renders inside the HUD panel stack. Defaults
     * `'bottom'`, which is where it has always rendered.
     *
     * `'top'` exists because the stack's order is a priority order, not a
     * layout detail: a host whose extra panel is the summary of what the session
     * is doing wants it above the stock panels. The one explicit exception is a
     * collapsible prompt list with `promptsInitiallyOpen: true`: that opt-in
     * makes recent prompts the first panel, followed by a top-placed extra panel
     * and then the note. */
    extraPanelPlacement?: 'top' | 'bottom';
    /** Text placed before the HUD note. Defaults to `'✎ '`, which is what the
     * HUD has always prefixed; pass `''` to render the host's note verbatim. */
    notePrefix?: string;
    /** `'upper'` (default) uppercases the HUD status text, as it always has;
     * `'none'` renders it exactly as the shell's labels give it. */
    statusCase?: 'upper' | 'none';
    /** Mode the composer opens in for a freshly mounted session. Defaults to
     * `'compose'`, which is what every version through 0.15.1 did.
     *
     * This is **per-mount state**, not a remembered preference: the user's
     * in-session COMPOSE/DIRECT choice wins for the life of the mounted
     * `SessionView`, but a remount (home → terminal, reload) re-seeds from this
     * value. Prefill paths still force COMPOSE because DIRECT has no visible
     * field. `EmbedView` does not read this option. */
    composerMode?: 'compose' | 'direct';
    /**
     * Inclusive lower bound (CSS px) for the stock A+/A− actions and for loading
     * a stored `fontPx` preference. Defaults to **4**.
     *
     * A stored value outside the current bounds is **clamped** into range — not
     * ignored. Through 0.15.2 the shell hard-clamped to 11–18 with bare literals
     * and silently dropped anything outside, so a host that widened its own
     * control saw no effect on the phone surface.
     *
     * Stock step is graduated (1px below 20, 2px to 32, 4px above) so 4→40 is
     * not 36 taps; the sequence is identical going up and coming back down. A
     * host that wants a different step replaces `font-up` / `font-down` via
     * `sessionPresentation.actions`. `EmbedView` does not read these bounds —
     * its explicit `fontPx` prop is the only size it uses.
     */
    fontPxMin?: number;
    /**
     * Inclusive upper bound (CSS px) for stock A+/A− and prefs load. Defaults to
     * **40**. See `fontPxMin` for clamp / step / host-override semantics.
     */
    fontPxMax?: number;
    /**
     * Stage corner for the stock ✛ arrow pad (`DpadSheet`). Defaults to
     * `'bottom-left'`, which is where the pad has always rendered.
     *
     * On a phone the bottom-left is where the newest output is — exactly what
     * the user is reading when they open the pad. Hosts that want the pad off
     * the live tail pass `'top-right'` (or another corner). Every corner
     * respects `env(safe-area-inset-*)` (notch / home indicator); Playwright
     * always reads `env()` as 0, so safe-area clearance is a device check.
     *
     * Values: `'bottom-left' | 'bottom-right' | 'top-left' | 'top-right'`.
     * Unknown values fall back to the stock default.
     */
    dpadPlacement?: 'bottom-left' | 'bottom-right' | 'top-left' | 'top-right';
    /**
     * Pin one-cell non-ASCII clusters (Thai, Devanagari, Greek, …) into a
     * one-cell box so the host font's advance cannot drift the grid. Defaults
     * **true**.
     *
     * Set `false` when `--font-mono` is already fixed-advance for every script
     * the terminal emits: you give up the grid guarantee for those scripts.
     * Dual-width CJK/emoji pins (`.mtv-w2`) stay on. `EmbedView` does not
     * read `sessionPresentation`; a standalone `TermView` always pins.
     */
    pinNarrowCells?: boolean;
}
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
     * after bootstrap. Defaults to the `@thumbmux/svelte` singleton. This seam
     * does not replace `TermView`'s pane output, history, resize, or connection
     * state; it also does not select the default key transport. Those stay on the
     * shared singleton. `EmbedView` has no session list and does not read `mux`. */
    mux?: TmuxMux;
    /** Override raw input independently of the session-list mux. Absent, raw
     * input and the legacy composer-submission fallback use the shared
     * `@thumbmux/svelte` singleton. */
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
    /** Presentation-only hub options. Session metadata remains in `sessionMeta`,
     * and launcher theme mode remains in `theme.mode`. */
    hubPresentation?: HubPresentationOptions;
    /** Presentation-only session controls. Upload policy remains in `upload`,
     * and terminal operations remain on `SessionActionContext`. */
    sessionPresentation?: SessionPresentationOptions;
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
        /** Handle a composer file paste when `endpoint(session)` is null. The
         * shell has no upload destination in that state, so the existing action
         * context lets the host explain or recover through the composer. */
        onUnavailable?: (session: string, files: readonly File[], context: SessionActionContext) => void;
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
    /** Inline slot on the HUD's session-name row — live per-session information
     * that belongs beside the name rather than behind the expand caret.
     *
     * It collapses instead of competing for width: when the name and the slot
     * cannot both be read, the slot leaves and the name keeps the row. A host
     * that wants its content guaranteed on screen at every width should use
     * `extraPanel` instead, which is always given room. */
    titleAdornment?: Snippet<[string]>;
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
    /** Copy the complete terminal buffer, ignoring any native selection.
     * Optional so existing code that constructs this public context type keeps
     * compiling. `SessionView` supplies it to the opt-in session-presentation
     * and unavailable-upload callbacks; legacy `extraActions` receives its
     * original two-member runtime context.
     *
     * Stock FAB copy is **selection-first with whole-buffer fallback**
     * (`copySelection()` then `copyAll()`). Wiring an action that only calls
     * `copyAll()` deliberately gives that up: a user who selected text and
     * taps your button gets the entire screen, not their selection. */
    copyAll?: () => Promise<boolean>;
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
