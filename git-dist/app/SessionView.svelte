<script lang="ts">
  import {
    DEFAULT_SHORTCUTS,
    defaultSurface,
    luminance,
    submitPlan,
    type SessionListItem,
    type Shortcut,
    type ThumbmuxPrefs,
  } from '../core/index.js';
  import {
    ActionFab,
    ComposerDock,
    DesktopKeys,
    DpadSheet,
    NotePanel,
    PromptsPanel,
    ShortcutBar,
    ShortcutsSheet,
    TermHud,
    TermView,
    ThemeSheet,
    UploadAction,
    createLocalPrefs,
    tmuxMux,
    type FabAction,
  } from '../svelte/index.js';
  import { onMount } from 'svelte';
  import {
    DEFAULT_APP_LABELS,
    type AppAdapters,
    type AppLabels,
    type SessionActionContext,
    type SubmissionTransport,
  } from './config';
  import {
    nextStageOverlay,
    prefillOnError,
    type OverlayTransition,
    type OverlayState,
  } from './overlay';
  import { normalizeSessionRows } from './sessions-store';

  let {
    session,
    adapters,
  }: {
    session: string;
    adapters: AppAdapters;
  } = $props();

  const LOCAL_PREFS_KEY = 'thumbmux-app-prefs';
  const DARK_BG = '#101014';
  const LIGHT_BG = '#f5f0e8';
  const STOCK_SWATCHES = [DARK_BG, '#000000', '#0b1c3d', '#b34700', LIGHT_BG, '#e6e6e6'];
  const hostOwnsThemeState = !!adapters.theme;
  const prefs = adapters.prefs ?? createLocalPrefs(adapters.theme?.storageKey ?? LOCAL_PREFS_KEY);

  const liveSessionsMux = adapters.mux ?? tmuxMux;
  let labels = $derived<AppLabels>({ ...DEFAULT_APP_LABELS, ...adapters.labels });
  let localBg = $state(adapters.theme?.defaultBg ?? DARK_BG);
  let storedFontPx = $state(13);
  let shortcuts = $state<Shortcut[]>(DEFAULT_SHORTCUTS.map((shortcut) => ({ ...shortcut })));
  let customBg = $state(localBg);

  let configuredTermProps = $derived(adapters.termProps?.(session) ?? {});
  let hostSurface = $derived(adapters.theme?.surfaceFor?.(session) ?? null);
  let configuredBg = $derived(adapters.theme?.bgFor?.(session) ?? localBg);
  let fallbackSurface = $derived(defaultSurface(configuredBg));
  let surface = $derived(hostSurface ?? fallbackSurface);
  // Spread last would let an explicit `undefined` from the adapter overwrite the
  // default beside it — object spread copies a key whose value is undefined, unlike
  // a key that is simply absent. `termProps` returns a Partial, so
  // `() => ({ palette: maybePalette })` is type-correct and reaches a required
  // TermView prop as undefined. Resolve each known key with ?? instead, which is
  // what EmbedView has always done; the spread stays first so unknown keys a host
  // passes through still arrive.
  let resolvedTermProps = $derived({
    ...configuredTermProps,
    claimGeometry: configuredTermProps.claimGeometry ?? true,
    altScreenMouse: configuredTermProps.altScreenMouse ?? false,
    palette: hostSurface?.palette ?? configuredTermProps.palette ?? fallbackSurface.palette,
    fontPx: configuredTermProps.fontPx ?? storedFontPx,
  });
  let themeMode = $derived(
    adapters.theme?.mode?.() ?? (luminance(surface.tbg) > 0.55 ? 'light' : 'dark'),
  );
  let themeDefaultBg = $derived(adapters.theme?.defaultBg ?? DARK_BG);
  let themeSwatches = $derived(adapters.theme?.swatches ?? STOCK_SWATCHES);
  let sessionAgent = $derived(adapters.submitAgent?.(session) ?? 'generic');

  let termRef = $state<ReturnType<typeof TermView> | null>(null);
  let composerRef = $state<ReturnType<typeof ComposerDock> | null>(null);
  let uploadRef = $state<ReturnType<typeof UploadAction> | null>(null);
  let desktopKeysFocused = $state(false);
  let isDesktop = $state(false);
  let hudHeight = $state(0);
  let hudExpanded = $state(false);
  let note = $state('');
  let noteSaving = $state(false);
  let recentPrompts = $state<string[]>([]);
  let promptsLoading = $state(false);
  let dpadOpen = $state(false);
  let shortcutsOpen = $state(false);
  let uploading = $state(false);
  let dockInset = $state(0);
  let dockFull = $state(0);
  let kbInset = $state(0);
  let shortcutBarHeight = $state(0);
  let scrollControlsHeight = $state(0);
  let termScrollState = $state({ bottomOffset: 0, scrolledUp: false });
  let hasNewContent = $state(false);
  let sessionRows = $state<SessionListItem[]>([]);

  let overlay = $state<OverlayState>({
    composerOpen: false,
    themeOpen: false,
    fabOpen: false,
  });
  let composer = $state({
    text: '',
    mode: 'compose' as 'compose' | 'direct',
    openCompose: () => {
      overlay.composerOpen = true;
      composerRef?.openCompose();
    },
  });

  let showShortcutBar = $derived(adapters.sessionPresentation?.showShortcutBar ?? true);
  let promptsCollapsible = $derived(adapters.sessionPresentation?.promptsCollapsible ?? false);
  let promptsInitiallyOpen = $derived(adapters.sessionPresentation?.promptsInitiallyOpen ?? false);
  let extraPanelOnTop = $derived(adapters.sessionPresentation?.extraPanelPlacement === 'top');
  let controlInset = $derived(Math.max(
    showShortcutBar ? shortcutBarHeight : 0,
    scrollControlsHeight,
  ));
  let terminalDockInset = $derived(
    dockInset + (controlInset > 0 ? controlInset + 8 : 0),
  );
  let terminalBottomInset = $derived(
    terminalDockInset + kbInset,
  );
  let mappedSessions = $derived(adapters.sessionMeta?.(sessionRows) ?? []);
  let currentMeta = $derived(mappedSessions.find((row) => row.name === session));
  let hudChip = $derived(currentMeta?.chip ?? labels.hudChip);
  let hudStatus = $derived(
    currentMeta?.stateLabel
      ?? currentMeta?.state
      ?? (tmuxMux.connected ? labels.hudConnected : labels.hudOffline),
  );
  let hasHudPanel = $derived(!!(adapters.notes || adapters.prompts || adapters.extraPanel));
  let uploadEndpoint = $derived(adapters.upload?.endpoint(session) ?? null);
  let uploadDir = $derived(adapters.upload?.dir ?? 'uploads');

  function applyPrefs(snapshot: ThumbmuxPrefs): void {
    if (!hostOwnsThemeState) {
      const bg = snapshot.theme?.bg;
      if (typeof bg === 'string') {
        localBg = bg;
        customBg = bg;
      }
    }
    const font = Number(snapshot.fontPx);
    if (font >= 11 && font <= 18) storedFontPx = font;
    if (Array.isArray(snapshot.shortcuts)) {
      shortcuts = snapshot.shortcuts.map((shortcut) => ({ ...shortcut }));
    }
  }

  function savePrefs(patch: Partial<ThumbmuxPrefs>): void {
    void prefs.save(patch).catch(() => {});
  }

  function setLocalBg(bg: string): void {
    localBg = bg;
    customBg = bg;
    savePrefs({ theme: { bg } });
  }

  function setFont(next: number): void {
    storedFontPx = Math.max(11, Math.min(18, next));
    savePrefs({ fontPx: storedFontPx });
  }

  function setShortcuts(next: Shortcut[]): void {
    shortcuts = next;
    savePrefs({ shortcuts: next });
  }

  function sendKeysTo(targetSession: string, data: string): void {
    if (adapters.sendKeys) adapters.sendKeys(targetSession, data);
    else tmuxMux.sendKeys(targetSession, data);
  }

  function sendKeys(data: string): void {
    sendKeysTo(session, data);
  }

  async function wait(delayMs: number): Promise<void> {
    if (delayMs <= 0) return;
    await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
  }

  async function deliverLegacySubmission(
    targetSession: string,
    transport: (name: string, keys: string) => void,
    steps: ReturnType<typeof submitPlan>,
  ): Promise<boolean> {
    for (const step of steps) {
      if (step.delayBeforeMs > 0) await wait(step.delayBeforeMs);
      try {
        transport(targetSession, step.keys);
      } catch {
        return false;
      }
    }
    return true;
  }

  async function deliverHostSubmission(
    targetSession: string,
    transport: SubmissionTransport,
    steps: ReturnType<typeof submitPlan>,
  ): Promise<boolean> {
    let previousStepAcknowledged = false;
    for (const step of steps) {
      if (!previousStepAcknowledged && step.delayBeforeMs > 0) {
        await wait(step.delayBeforeMs);
      }
      try {
        const acknowledgement = transport(targetSession, step.keys);
        previousStepAcknowledged = acknowledgement !== undefined;
        if (acknowledgement !== undefined) await acknowledgement;
      } catch {
        return false;
      }
    }
    return true;
  }

  function sendSubmission(text: string): Promise<boolean> {
    if (!text) return Promise.resolve(true);
    const targetSession = session;
    const targetAgent = sessionAgent;
    const steps = submitPlan(text, { agent: targetAgent });
    const submissionTransport = adapters.sendSubmissionKeys;
    if (submissionTransport) {
      return deliverHostSubmission(targetSession, submissionTransport, steps);
    }
    const transport = adapters.sendKeys
      ?? ((name: string, keys: string) => tmuxMux.sendKeys(name, keys));
    return deliverLegacySubmission(targetSession, transport, steps);
  }

  function recoverTransportFailure(sent: boolean, text: string): void {
    if (!sent) prefillOnError(composer, text);
  }

  function submitDraft(text: string): void {
    void sendSubmission(text).then((sent) => recoverTransportFailure(sent, text));
  }

  function prefillComposer(text: string): void {
    composer.text = text;
    composer.mode = 'compose';
    overlay.composerOpen = true;
    composerRef?.openCompose();
  }

  const legacyActionContext: SessionActionContext = {
    submit: submitDraft,
    prefill: prefillComposer,
  };
  const actionContext: SessionActionContext = {
    ...legacyActionContext,
    copyAll: copyAllTerminal,
  };

  function openComposer(): void {
    overlay.fabOpen = false;
    overlay.themeOpen = false;
    overlay.composerOpen = true;
    composerRef?.openDock();
  }

  function closeComposer(): void {
    overlay.composerOpen = false;
    composerRef?.closeDock();
  }

  function transitionForCurrentLayers(): OverlayTransition {
    const local = nextStageOverlay(overlay, false);
    if (local.action === 'close-composer' || local.action === 'close-theme') return local;
    const hostDismissed = adapters.extraDismissables?.() ?? false;
    return nextStageOverlay(overlay, hostDismissed);
  }

  function applyOverlayTransition(transition: OverlayTransition): void {
    overlay = transition.state;
    if (transition.action === 'close-composer') composerRef?.closeDock();
    if (transition.action === 'open-composer') composerRef?.openDock();
  }

  function onTerminalTap(): void {
    if (hudExpanded) {
      hudExpanded = false;
      return;
    }
    applyOverlayTransition(transitionForCurrentLayers());
  }

  function onFab(event: MouseEvent): void {
    event.stopPropagation();
    const transition = transitionForCurrentLayers();
    if (transition.action === 'open-composer') {
      overlay = { ...overlay, fabOpen: true };
      return;
    }
    applyOverlayTransition(transition);
  }

  function openTheme(): void {
    overlay.fabOpen = false;
    closeComposer();
    customBg = surface.tbg;
    overlay.themeOpen = true;
  }

  function toggleTheme(mode: 'dark' | 'light'): void {
    if (hostOwnsThemeState) {
      adapters.theme?.onToggleMode?.(mode);
      return;
    }
    setLocalBg(mode === 'light' ? LIGHT_BG : themeDefaultBg);
  }

  function pickTheme(hex: string): void {
    if (hostOwnsThemeState) {
      adapters.theme?.onPick?.(session, hex);
      return;
    }
    setLocalBg(hex);
  }

  function resetTheme(): void {
    if (hostOwnsThemeState) {
      adapters.theme?.onReset?.(session);
      return;
    }
    setLocalBg(themeDefaultBg);
  }

  async function copyAllTerminal(): Promise<boolean> {
    return (await termRef?.copyAll()) ?? false;
  }

  async function copyTerminal(): Promise<void> {
    const copiedSelection = await termRef?.copySelection();
    if (copiedSelection === false) await copyAllTerminal();
  }

  function onTermScrollStateChange(state: { bottomOffset: number; scrolledUp: boolean }): void {
    termScrollState = state;
    if (!state.scrolledUp) {
      hasNewContent = false;
      scrollControlsHeight = 0;
    }
  }

  function onTermLinesChange(
    _lines: string[],
    meta: { source: 'live' | 'prepend' | 'replace' },
  ): void {
    if (meta.source === 'live' && termScrollState.scrolledUp) hasNewContent = true;
  }

  function scrollToTerminalBottom(): void {
    const moved = termRef?.scrollToBottom() ?? false;
    if (moved && termRef && !termRef.isScrolledUp()) hasNewContent = false;
  }

  // Shared generation for note load and note save so a late load cannot
  // overwrite a save that began (or finished) after that load started.
  // Session-change invalidates both by bumping the same counter.
  let noteSaveRequest = 0;
  async function saveNote(text: string): Promise<void> {
    const noteAdapter = adapters.notes;
    if (!noteAdapter) return;
    const targetSession = session;
    const request = ++noteSaveRequest;
    noteSaving = true;
    try {
      await noteAdapter.save(targetSession, text);
      if (request === noteSaveRequest && targetSession === session) note = text;
    } catch {
      // Keep the last successfully loaded/saved note visible.
    } finally {
      if (request === noteSaveRequest && targetSession === session) noteSaving = false;
    }
  }

  // Upload completion is fenced the same way: epoch advances on session
  // change; arming records the epoch at the moment UploadAction goes busy
  // (upload start). A completion whose arm does not match is from a prior
  // session and must not prefill the current composer.
  let uploadEpoch = 0;
  let armedUploadEpoch = -1;
  $effect(() => {
    session;
    uploadEpoch += 1;
  });
  $effect(() => {
    if (uploading) armedUploadEpoch = uploadEpoch;
  });

  let promptRequest = 0;
  async function loadPrompts(): Promise<void> {
    if (!hudExpanded || !adapters.prompts) return;
    const request = ++promptRequest;
    const requestedSession = session;
    promptsLoading = true;
    try {
      const loaded = await adapters.prompts(requestedSession);
      if (request === promptRequest && requestedSession === session) recentPrompts = loaded;
    } catch {
      // Keep the last successful snapshot available while the source recovers.
    } finally {
      if (request === promptRequest) promptsLoading = false;
    }
  }

  function showHub(): void {
    closeComposer();
    if (adapters.routes) {
      adapters.routes.showHub();
      return;
    }
    if (typeof window === 'undefined') return;
    const url = new URL(window.location.href);
    url.searchParams.delete('session');
    history.replaceState(null, '', url);
  }

  function blurDesktopKeys(): void {
    desktopKeysFocused = false;
    const active = document.activeElement;
    if (!(active instanceof HTMLElement)) return;
    const root = active.closest('.desktop-keys');
    if (root instanceof HTMLElement) root.blur();
  }

  function setDesktopGate(next: boolean): void {
    if (isDesktop && !next) blurDesktopKeys();
    isDesktop = next;
  }

  function dismissingHostAction(action: FabAction): FabAction {
    return {
      ...action,
      onTap: () => {
        overlay.fabOpen = false;
        action.onTap();
      },
    };
  }

  let actions = $derived.by((): FabAction[] => {
    const stock: FabAction[] = [
      { id: 'type', label: labels.actionType, onTap: openComposer },
    ];
    if (uploadEndpoint) {
      stock.push({
        id: 'upload',
        label: uploading ? labels.actionUploading : labels.actionUpload,
        testid: 'demo-upload',
        onTap: () => { overlay.fabOpen = false; uploadRef?.open(); },
      });
    }
    stock.push(
      {
        id: 'dpad',
        label: labels.actionDpad,
        onTap: () => { dpadOpen = !dpadOpen; overlay.fabOpen = false; },
      },
      {
        id: 'copy',
        label: labels.actionCopy,
        testid: 'demo-copy',
        onTap: () => { overlay.fabOpen = false; void copyTerminal(); },
      },
      {
        id: 'shortcuts',
        label: labels.actionShortcuts,
        testid: 'demo-shortcuts',
        onTap: () => { shortcutsOpen = true; overlay.fabOpen = false; },
      },
      {
        id: 'theme',
        label: labels.actionTheme,
        testid: 'demo-theme',
        onTap: openTheme,
      },
      {
        id: 'font-up',
        label: labels.actionFontUp,
        onTap: () => setFont(storedFontPx + 1),
      },
      {
        id: 'font-down',
        label: labels.actionFontDown,
        onTap: () => setFont(storedFontPx - 1),
      },
    );
    const extras = (adapters.extraActions?.(session, legacyActionContext) ?? [])
      .map(dismissingHostAction);
    const defaults = [...stock, ...extras];
    const compose = adapters.sessionPresentation?.actions;
    if (!compose) return defaults;

    const defaultActions = new Set(defaults);
    return compose(session, actionContext, defaults).map((action) => (
      defaultActions.has(action) ? action : dismissingHostAction(action)
    ));
  });

  let noteRequest = 0;
  $effect(() => {
    const noteAdapter = adapters.notes;
    const requestedSession = session;
    const request = ++noteRequest;
    // Capture the save generation at load start. saveNote and a later session
    // switch both bump noteSaveRequest, so a stale load cannot land after them.
    const loadGeneration = ++noteSaveRequest;
    note = '';
    noteSaving = false;
    if (!noteAdapter) return;
    void noteAdapter.load(requestedSession).then((loaded) => {
      if (
        request === noteRequest
        && requestedSession === session
        && loadGeneration === noteSaveRequest
      ) {
        note = loaded;
      }
    }).catch(() => {});
    return () => { noteRequest += 1; };
  });

  $effect(() => {
    session;
    promptRequest += 1;
    recentPrompts = [];
    promptsLoading = false;
  });

  onMount(() => {
    let destroyed = false;
    let prefsGeneration = 0;
    const unsubscribePrefs = prefs.subscribe?.((snapshot) => {
      prefsGeneration += 1;
      applyPrefs(snapshot);
    });
    const loadGeneration = prefsGeneration;
    void prefs.load().then((snapshot) => {
      if (!destroyed && loadGeneration === prefsGeneration) applyPrefs(snapshot);
    }).catch(() => {});

    const unsubscribeSessions = liveSessionsMux.onSessions((rows) => {
      sessionRows = normalizeSessionRows(rows as SessionListItem[]);
    });
    const query = window.matchMedia('(min-width: 1024px)');
    setDesktopGate(query.matches);
    const onChange = (event: MediaQueryListEvent) => setDesktopGate(event.matches);
    query.addEventListener('change', onChange);

    return () => {
      destroyed = true;
      promptRequest += 1;
      noteRequest += 1;
      noteSaveRequest += 1;
      unsubscribePrefs?.();
      unsubscribeSessions();
      query.removeEventListener('change', onChange);
    };
  });
</script>

{#snippet hudTitleAdornment()}
  {#if adapters.titleAdornment}
    {@const adorn = adapters.titleAdornment}
    {@render adorn(session)}
  {/if}
{/snippet}

{#snippet hudPanel()}
  <div class="hud-panel-stack">
    {#if adapters.extraPanel && extraPanelOnTop}
      {@const extraPanelTop = adapters.extraPanel}
      {@render extraPanelTop(session)}
    {/if}
    {#if adapters.notes}
      <NotePanel
        {note}
        placeholder={labels.noteEmpty}
        saving={noteSaving}
        onSave={(text) => { void saveNote(text); }}
        labels={{ edit: labels.noteEdit, save: labels.noteSave, cancel: labels.noteCancel }}
      />
    {/if}
    {#if adapters.prompts}
      <PromptsPanel
        prompts={recentPrompts}
        loading={promptsLoading}
        collapsible={promptsCollapsible}
        initiallyOpen={promptsInitiallyOpen}
        onPick={(prompt) => {
          hudExpanded = false;
          prefillComposer(prompt);
        }}
        labels={{
          title: labels.promptsTitle,
          loading: labels.promptsLoading,
          none: labels.promptsEmpty,
        }}
      />
    {/if}
    {#if adapters.extraPanel && !extraPanelOnTop}
      {@const extraPanel = adapters.extraPanel}
      {@render extraPanel(session)}
    {/if}
  </div>
{/snippet}

<div
  class="stage"
  data-testid="session-view"
  data-state={currentMeta?.state}
  style:--agent={surface.agent}
  style:--tbg={surface.tbg}
  style:--tstage={surface.tstage}
  style:--tfg={surface.tfg}
  style:--hud={surface.hud}
  style:--hud-fg={surface.hudFg}
  style:--hud-line={surface.hudLine}
  style:--dock-inset={terminalDockInset > 0 ? `${terminalDockInset}px` : null}
  style:--dock-full={dockFull > 0 ? `${dockFull}px` : null}
  style:--kb-inset={kbInset > 0 ? `${kbInset}px` : null}
>
  <div class="mtv-host" style:top={`${hudHeight}px`}>
    {#key `${session}|${surface.tbg}|${resolvedTermProps.fontPx}`}
      {#if isDesktop}
        <DesktopKeys
          bind:focused={desktopKeysFocused}
          onKeys={sendKeys}
          ariaLabel={labels.terminalAria(session)}
        >
          <TermView
            bind:this={termRef}
            {session}
            {...resolvedTermProps}
            bottomInsetPx={terminalBottomInset}
            onKeys={sendKeys}
            onTap={onTerminalTap}
            onLinesChange={onTermLinesChange}
            onScrollStateChange={onTermScrollStateChange}
          />
        </DesktopKeys>
      {:else}
        <TermView
          bind:this={termRef}
          {session}
          {...resolvedTermProps}
          bottomInsetPx={terminalBottomInset}
          onKeys={sendKeys}
          onTap={onTerminalTap}
          onLinesChange={onTermLinesChange}
          onScrollStateChange={onTermScrollStateChange}
        />
      {/if}
    {/key}
  </div>

  <TermHud
    chip={hudChip}
    title={session}
    {note}
    status={hudStatus}
    working={currentMeta?.state === 'working'}
    bind:barHeight={hudHeight}
    bind:expanded={hudExpanded}
    onBack={showHub}
    onToggleExpand={() => { void loadPrompts(); }}
    backAria={labels.hudBack}
    panel={hasHudPanel ? hudPanel : undefined}
    titleAdornment={adapters.titleAdornment ? hudTitleAdornment : undefined}
    notePrefix={adapters.sessionPresentation?.notePrefix ?? '✎ '}
    statusCase={adapters.sessionPresentation?.statusCase ?? 'upper'}
  />

  {#if showShortcutBar}
    <ShortcutBar
      bind:barHeight={shortcutBarHeight}
      {shortcuts}
      agent={sessionAgent}
      visible={!overlay.fabOpen && !overlay.themeOpen && !shortcutsOpen && !dpadOpen && !termScrollState.scrolledUp}
      onSend={(shortcut) => {
        if (shortcut.submit === false) sendKeys(shortcut.send);
        else submitDraft(shortcut.send);
      }}
      onManage={() => { shortcutsOpen = true; }}
    />
  {/if}

  {#if termScrollState.scrolledUp}
    <div class="scroll-controls" bind:offsetHeight={scrollControlsHeight}>
      {#if hasNewContent}
        <button data-testid="demo-new-content" onclick={scrollToTerminalBottom}>{labels.scrollNewContent}</button>
      {:else}
        <button data-testid="demo-scroll-bottom" onclick={scrollToTerminalBottom}>{labels.scrollBottom}</button>
      {/if}
    </div>
  {/if}

  <ShortcutsSheet
    bind:open={shortcutsOpen}
    {shortcuts}
    onChange={setShortcuts}
    title={labels.shortcutsTitle}
    labels={{
      add: labels.shortcutAdd,
      label: labels.shortcutLabel,
      send: labels.shortcutSend,
      close: labels.close,
      del: labels.shortcutDelete,
      up: labels.shortcutUp,
      down: labels.shortcutDown,
    }}
  />
  <ActionFab
    bind:open={overlay.fabOpen}
    active={
      overlay.fabOpen
        || overlay.composerOpen
        || overlay.themeOpen
        || (adapters.extraOverlayOpen?.() ?? false)
    }
    {actions}
    {onFab}
    fabAria={labels.fabAria}
  />
  <DpadSheet bind:open={dpadOpen} onKey={sendKeys} />
  <ThemeSheet
    bind:open={overlay.themeOpen}
    bind:customBg
    title={labels.themeTitle}
    mode={themeMode}
    onToggleMode={toggleTheme}
    swatchLabel={labels.themeBackground}
    swatches={themeSwatches}
    currentBg={surface.tbg}
    defaultBg={themeDefaultBg}
    onPick={pickTheme}
    onReset={resetTheme}
    labels={{
      dark: labels.themeDark,
      light: labels.themeLight,
      def: labels.themeDefault,
      custom: labels.themeCustom,
      close: labels.close,
    }}
  />

  {#if uploadEndpoint}
    <UploadAction
      bind:this={uploadRef}
      bind:busy={uploading}
      endpoint={uploadEndpoint}
      dir={uploadDir}
      onUploaded={(message, files) => {
        if (armedUploadEpoch !== uploadEpoch) return;
        prefillComposer(adapters.upload?.formatPrefill?.(files, uploadDir) ?? message);
      }}
      onError={(message) => {
        if (armedUploadEpoch !== uploadEpoch) return;
        prefillOnError(composer, labels.uploadFailed(message));
      }}
    />
  {/if}

  <ComposerDock
    bind:this={composerRef}
    bind:open={overlay.composerOpen}
    bind:mode={composer.mode}
    bind:text={composer.text}
    bind:dockInset
    bind:dockFull
    bind:kbInset
    onSend={submitDraft}
    onDirectText={sendKeys}
    onDirectKey={sendKeys}
    onPasteFiles={
      uploadEndpoint
        ? (files) => { void uploadRef?.uploadFiles(files); }
        : adapters.upload?.onUnavailable
          ? (files) => { adapters.upload?.onUnavailable?.(session, files, actionContext); }
          : undefined
    }
    labels={{
      compose: labels.composerCompose,
      direct: labels.composerDirect,
      hintCompose: labels.composerHintCompose,
      hintDirect: labels.composerHintDirect,
      placeholder: labels.composerPlaceholder,
      send: labels.composerSend,
      close: labels.close,
      directAria: labels.composerDirectAria,
    }}
  />

  {#if adapters.extraSheets}
    {@const extraSheets = adapters.extraSheets}
    {@render extraSheets(session)}
  {/if}
</div>

<style>
  .stage {
    --agent: #7dffa0;
    --tbg: #101014;
    --tstage: #0a0a0d;
    --tfg: #e6e6e6;
    --hud: rgba(16, 16, 20, .95);
    --hud-fg: #e6e6e6;
    --hud-line: #34343a;
    /* 100dvh = the truly visible viewport — inset:0 extends behind Safari's
       bottom URL bar (our app never scrolls the document, so the bar never
       collapses and was permanently covering the last rows). */
    position: fixed; top: 0; left: 0; right: 0;
    height: 100dvh;
    z-index: 200;
    background: var(--tstage);
    /* clip, not hidden — parked sheets extend the scrollable overflow and a
       focus/caret move can scroll a hidden-overflow fixed stage (thumbmux
       fleet finding); clip makes the stage truly unscrollable */
    overflow: clip;
    font-family: var(--font-mono);
  }
  .mtv-host {
    position: absolute;
    /* top comes inline from TermHud's measured barHeight — the HUD is opaque
       now, so the terminal starts below it instead of hiding its top rows */
    top: 0; left: 0; right: 0;
    /* Sheet open → the host ends exactly at the sheet's top edge: safe area
       (the closed-state baseline) + the sheet's height ABOVE the safe area
       (--dock-inset) + the OS keyboard (--kb-inset). Keeping the safe area in
       both states makes open/closed heights differ by exactly the amount
       TermView adds back (bottomInsetPx), so tmux rows never flap. Snap, no
       transition: an animated height would stream mid-transition sizes into
       pushGeometry; the sheet's slide covers the gap visually. */
    bottom: calc(env(safe-area-inset-bottom, 0px) + var(--dock-inset, 0px) + var(--kb-inset, 0px));
    padding-top: calc(46px + env(safe-area-inset-top));
    background: var(--tbg);
  }

  .mtv-host :global(.desktop-keys) {
    position: absolute;
    inset: 0;
    color: var(--tfg);
  }

  .hud-panel-stack {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .scroll-controls {
    position: absolute;
    right: 76px;
    bottom: calc(var(--dock-full, 0px) + var(--kb-inset, 0px) + env(safe-area-inset-bottom) + 8px);
    z-index: 31;
  }

  .scroll-controls button {
    min-height: 44px;
    padding: 0 14px;
    border: 1px solid var(--agent);
    background: var(--hud);
    color: var(--hud-fg);
    font: 700 11px var(--font-mono);
    letter-spacing: .04em;
    touch-action: manipulation;
  }
</style>
