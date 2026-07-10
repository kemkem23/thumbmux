<script lang="ts">
  /** thumbmux demo — hub of your local tmux sessions + a full terminal view.
   * One Bun process serves this page, the WebSocket mux, and the spawn API. */
  import {
    SessionGrid, LaunchSheet, TermView, DesktopKeys, TermHud, ComposerDock, DpadSheet, ActionFab, ThemeSheet, UploadAction,
    ShortcutBar, ShortcutsSheet, NotePanel, PromptsPanel, createLocalPrefs,
    tmuxMux, type GridSession, type FabAction,
  } from '@thumbmux/svelte';
  import {
    DEFAULT_LAUNCH_PRESETS, DEFAULT_SHORTCUTS, deriveSurface, luminance, extractRecentPrompts,
    type TerminalSurface, type LaunchPreset, type LaunchSpec, type AnsiPalette, type Shortcut,
  } from '@thumbmux/core';
  import { onMount, onDestroy } from 'svelte';

  const PALETTE: AnsiPalette = {
    base: ['#101014', '#ff7a7a', '#7dffa0', '#ffef9e', '#c8b4ff', '#ff9ad5', '#9be9ff', '#e8e8e8',
           '#8a8a92', '#ff9d9d', '#a0ffbe', '#fff5bd', '#dcCEff', '#ffbde4', '#c2f1ff', '#ffffff'],
    defaultFg: '#e6e6e6',
    defaultBg: '#101014',
  };
  type DemoKind = 'cc' | 'codex' | 'grok' | 'sh';
  const DEMO_FILTERS = [
    { value: 'cc', label: 'CC' },
    { value: 'codex', label: 'CDX' },
    { value: 'grok', label: 'GROK' },
    { value: 'sh', label: 'SH' },
  ] as const;
  const DEMO_GROUPS = [
    { key: 'design', label: 'Design' },
    { key: 'build', label: 'Build' },
    { key: 'review', label: 'Review' },
    { key: 'ops', label: 'Ops' },
  ] as const;
  const DEMO_SURFACES: Record<DemoKind, { chip: string; color: string; palette: AnsiPalette }> = {
    cc: {
      chip: 'CC',
      color: '#b45309',
      palette: PALETTE,
    },
    codex: {
      chip: 'CDX',
      color: '#2563eb',
      palette: {
        ...PALETTE,
        defaultFg: '#eef4ff',
        defaultBg: '#08162f',
      },
    },
    grok: {
      chip: 'GROK',
      color: '#047857',
      palette: {
        ...PALETTE,
        defaultFg: '#e9fff3',
        defaultBg: '#06231a',
      },
    },
    sh: {
      chip: 'SH',
      color: '#475569',
      palette: {
        ...PALETTE,
        defaultFg: '#f8fafc',
        defaultBg: '#111827',
      },
    },
  };
  // Stock presets, worktree ones included — if the demo's cwd is not a git
  // repo, git prints its own self-explanatory error in the pane.
  const ALT_SCREEN_PRESET_ID = 'alt-screen-mouse';
  const ALT_SCREEN_PRESET: LaunchPreset = {
    id: ALT_SCREEN_PRESET_ID,
    label: 'Alt-screen mouse test',
    color: '#2f7d68',
    agent: 'alt-screen',
    baseCommand: "printf '\\e[?1006h\\e[?1000h'; exec cat -v",
    permissionOptions: [{ value: 'none', label: 'No options', flag: '' }],
    modelOptions: [{ value: 'none', label: 'No options', flag: '' }],
  };
  const PRESETS = [...DEFAULT_LAUNCH_PRESETS, ALT_SCREEN_PRESET];

  // --- theme + font (persisted; ThemeSheet is pure presentation) ---
  const BASE_SURFACE: TerminalSurface = {
    agent: '#7dffa0', tbg: '#101014', tstage: '#0a0a0d', tfg: '#e6e6e6',
    hud: 'rgba(16,16,20,.95)', hudFg: '#e6e6e6', hudLine: '#34343a',
    badge: '#1a1a1a', badgeFg: '#e6e6e6', xterm: {},
  };
  const THEME_SWATCHES = ['#101014', '#000000', '#0b1c3d', '#b34700', '#f5f0e8', '#e6e6e6'];
  const prefs = createLocalPrefs('thumbmux-demo-prefs');
  let bg = $state('#101014');
  let fontPx = $state(13);
  let themeOpen = $state(false);
  let customBg = $state('#101014');
  let shortcuts = $state<Shortcut[]>(DEFAULT_SHORTCUTS);
  let shortcutsOpen = $state(false);
  let notes = $state<Record<string, string>>({});
  let hudExpanded = $state(false);
  let recentPrompts = $state<string[]>([]);
  let termRef = $state<ReturnType<typeof TermView> | null>(null);
  let surface = $derived(deriveSurface(bg, BASE_SURFACE));
  let termPalette = $derived<AnsiPalette>((() => {
    const x = surface.xterm;
    const b = [...PALETTE.base];
    b[0] = x.black ?? b[0]; b[7] = x.white ?? b[7];
    const idx = { red: 1, green: 2, yellow: 3, blue: 4, magenta: 5, cyan: 6 } as const;
    for (const [k, i] of Object.entries(idx)) {
      if (x[k]) { b[i] = x[k]; b[i + 8] = x[('bright' + k[0].toUpperCase() + k.slice(1))] ?? x[k]; }
    }
    if (x.brightBlack) b[8] = x.brightBlack;
    return { base: b, defaultFg: surface.tfg, defaultBg: surface.tbg };
  })());
  function setBg(hex: string) {
    bg = hex; customBg = hex;
    prefs.save({ theme: { bg: hex } });
  }
  function setFont(next: number) {
    fontPx = Math.max(11, Math.min(18, next));
    prefs.save({ fontPx });
  }
  function setShortcuts(next: Shortcut[]) {
    shortcuts = next;
    prefs.save({ shortcuts: next });
  }
  function saveNote(session: string, text: string) {
    notes = { ...notes, [session]: text };
    prefs.save({ demoNotes: notes });
  }

  let view = $state<{ kind: 'hub' } | { kind: 'term'; name: string }>({ kind: 'hub' });
  let names = $state<string[]>([]);
  let sessionsLoaded = $state(false);
  let launchOpen = $state(false);
  let launching = $state(false);
  let launchError = $state<string | null>(null);
  let altScreenSessions = $state<Record<string, boolean>>({});

  function hashName(name: string): number {
    let hash = 0;
    for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
    return hash;
  }

  function demoKind(name: string): DemoKind {
    const lower = name.toLowerCase();
    if (lower.startsWith('cc-') || lower.startsWith('claude-') || lower.includes('-cc-')) return 'cc';
    if (lower.startsWith('codex-') || lower.includes('-codex-')) return 'codex';
    if (lower.startsWith('grok-') || lower.includes('-grok-')) return 'grok';
    return 'sh';
  }

  function activityLabel(minutesAgo: number): string {
    if (minutesAgo <= 0) return 'just now';
    if (minutesAgo === 1) return '1 min ago';
    if (minutesAgo < 60) return `${minutesAgo} mins ago`;
    const hours = Math.floor(minutesAgo / 60);
    return hours === 1 ? '1 hour ago' : `${hours} hours ago`;
  }

  let gridSessions = $derived<GridSession[]>(names.map((name, index) => {
    const kind = demoKind(name);
    const hash = hashName(name);
    const group = DEMO_GROUPS[hash % DEMO_GROUPS.length];
    const minutesAgo = (hash % 180) + index;
    const state = hash % 3 === 0 ? 'idle' : 'working';
    return {
      name,
      chip: DEMO_SURFACES[kind].chip,
      color: DEMO_SURFACES[kind].color,
      palette: DEMO_SURFACES[kind].palette,
      filterValue: kind,
      groupKey: group.key,
      groupLabel: group.label,
      state,
      stateLabel: state === 'working' ? 'WORKING' : 'IDLE',
      lastActivityAt: Date.now() - minutesAgo * 60_000,
      lastActivityLabel: activityLabel(minutesAgo),
    };
  }));

  // Terminal view state
  let composerRef = $state<ReturnType<typeof ComposerDock> | null>(null);
  let composerOpen = $state(false);
  let composerMode = $state<'compose' | 'direct'>('compose');
  let dockInset = $state(0);
  let dockFull = $state(0);
  let kbInset = $state(0);
  let scrollControlsHeight = $state(0);
  let termScrollState = $state({ bottomOffset: 0, scrolledUp: false });
  let hasNewContent = $state(false);
  let slotsOpen = $state(false);
  let dpadOpen = $state(false);
  let uploadRef = $state<ReturnType<typeof UploadAction> | null>(null);
  let hudHeight = $state(0);
  let shortcutBarH = $state(0);
  let uploading = $state(false);
  let composeText = $state('');
  let isDesktop = $state(false);
  let desktopKeysFocused = $state(false);

  let unsubSessions: (() => void) | null = null;
  let unsubDesktopGate: (() => void) | null = null;
  let unsubSessionUrl: (() => void) | null = null;
  let pendingSessionTimer: ReturnType<typeof setTimeout> | null = null;

  function sendKeysTo(session: string) {
    return (data: string) => tmuxMux.sendKeys(session, data);
  }

  function onTermScrollStateChange(state: { bottomOffset: number; scrolledUp: boolean }) {
    termScrollState = state;
    if (!state.scrolledUp) {
      hasNewContent = false;
      scrollControlsHeight = 0;
    }
  }

  function onTermLinesChange(
    lines: string[],
    meta: { source: 'live' | 'prepend' | 'replace' },
  ) {
    recentPrompts = extractRecentPrompts(lines, { targetCount: 5 });
    if (meta.source === 'live' && termScrollState.scrolledUp) hasNewContent = true;
  }

  function scrollToTerminalBottom() {
    const moved = termRef?.scrollToBottom() ?? false;
    if (moved && termRef && !termRef.isScrolledUp()) hasNewContent = false;
  }

  async function copyTerminal() {
    const copiedSelection = await termRef?.copySelection();
    if (copiedSelection === false) await termRef?.copyAll();
  }

  function sessionFromUrl(): string | null {
    const url = new URL(window.location.href);
    const value = url.searchParams.get('session');
    return value && value.trim() ? value.trim() : null;
  }

  function setSessionUrl(name: string | null) {
    const url = new URL(window.location.href);
    if (name) url.searchParams.set('session', name);
    else url.searchParams.delete('session');
    history.replaceState(null, '', url);
  }

  function gridDelayMs(): number {
    const value = Number(new URL(window.location.href).searchParams.get('gridDelayMs') ?? 0);
    return Number.isFinite(value) ? Math.max(0, Math.min(2_000, value)) : 0;
  }

  function openSession(name: string) {
    view = { kind: 'term', name };
    setSessionUrl(name);
  }

  function showHub() {
    composerRef?.closeDock();
    view = { kind: 'hub' };
    setSessionUrl(null);
  }

  function blurDesktopKeys() {
    desktopKeysFocused = false;
    const active = document.activeElement;
    if (!(active instanceof HTMLElement)) return;
    const root = active.closest('.desktop-keys');
    if (root instanceof HTMLElement) root.blur();
  }

  function setDesktopGate(next: boolean) {
    if (isDesktop && !next) blurDesktopKeys();
    isDesktop = next;
  }

  async function launch(spec: LaunchSpec) {
    launching = true;
    launchError = null;
    try {
      const res = await fetch('/api/spawn', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: spec.command, worktree: spec.worktree }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
      const name = String(data.name);
      altScreenSessions = { ...altScreenSessions, [name]: spec.presetId === ALT_SCREEN_PRESET_ID };
      launchOpen = false;
      openSession(name);
    } catch (e: any) {
      launchError = String(e?.message ?? e);
    } finally {
      launching = false;
    }
  }

  let actions = $derived<FabAction[]>([
    { id: 'type', label: '⌨ Type', onTap: () => { slotsOpen = false; composerRef?.openDock(); } },
    { id: 'upload', label: uploading ? '⏳ Uploading…' : '📎 Attach files', testid: 'demo-upload', onTap: () => { slotsOpen = false; uploadRef?.open(); } },
    { id: 'dpad', label: '✛ Arrows', onTap: () => { dpadOpen = !dpadOpen; slotsOpen = false; } },
    { id: 'copy', label: '⧉ Copy screen', testid: 'demo-copy', onTap: async () => { slotsOpen = false; await copyTerminal(); } },
    { id: 'shortcuts', label: '⚡ Shortcuts…', testid: 'demo-shortcuts', onTap: () => { shortcutsOpen = true; slotsOpen = false; } },
    { id: 'theme', label: '🎨 Theme', testid: 'demo-theme', onTap: () => { themeOpen = true; slotsOpen = false; } },
    { id: 'font-up', label: 'A+ Bigger text', onTap: () => setFont(fontPx + 1) },
    { id: 'font-down', label: 'A− Smaller text', onTap: () => setFont(fontPx - 1) },
  ]);

  onMount(() => {
    prefs.load().then((p) => {
      const b = p.theme?.bg; if (typeof b === 'string') { bg = b; customBg = b; }
      const f = Number(p.fontPx); if (f >= 11 && f <= 18) fontPx = f;
      if (Array.isArray(p.shortcuts)) shortcuts = p.shortcuts as Shortcut[];
      if (p.demoNotes && typeof p.demoNotes === 'object') notes = p.demoNotes as Record<string, string>;
    });
    const initialSession = sessionFromUrl();
    if (initialSession) view = { kind: 'term', name: initialSession };
    const onPopState = () => {
      const session = sessionFromUrl();
      view = session ? { kind: 'term', name: session } : { kind: 'hub' };
    };
    window.addEventListener('popstate', onPopState);
    unsubSessionUrl = () => window.removeEventListener('popstate', onPopState);
    const initialGridDelay = gridDelayMs();
    unsubSessions = tmuxMux.onSessions((rows: any[]) => {
      const nextNames = rows.map((r) => String(r?.name ?? '')).filter(Boolean);
      if (pendingSessionTimer) {
        clearTimeout(pendingSessionTimer);
        pendingSessionTimer = null;
      }
      if (!sessionsLoaded && initialGridDelay > 0) {
        names = [];
        pendingSessionTimer = setTimeout(() => {
          names = nextNames;
          sessionsLoaded = true;
          pendingSessionTimer = null;
        }, initialGridDelay);
        return;
      }
      names = nextNames;
      sessionsLoaded = true;
    });
    const query = window.matchMedia('(min-width: 1024px)');
    setDesktopGate(query.matches);
    const onChange = (event: MediaQueryListEvent) => setDesktopGate(event.matches);
    query.addEventListener('change', onChange);
    unsubDesktopGate = () => query.removeEventListener('change', onChange);
  });

  onDestroy(() => {
    if (pendingSessionTimer) clearTimeout(pendingSessionTimer);
    unsubSessions?.();
    unsubDesktopGate?.();
    unsubSessionUrl?.();
  });
</script>

{#if view.kind === 'hub'}
  <div class="hub">
    <div class="bar"><span class="ttl">THUMBMUX · DEMO</span><span class="count">{names.length}</span></div>
    <SessionGrid
      sessions={gridSessions}
      palette={PALETTE}
      onOpen={openSession}
      onNew={() => { launchError = null; launchOpen = true; }}
      emptyLabel="No tmux sessions yet — tap + terminal"
      loading={!sessionsLoaded}
      searchable
      searchLabel="Search sessions"
      searchPlaceholder="Search sessions"
      filterOptions={DEMO_FILTERS}
      allFilterLabel="ALL"
      groupable
      groupToggleLabel="Group"
      ungroupedLabel="Ungrouped"
      order="recent"
    />
    <LaunchSheet
      open={launchOpen}
      presets={PRESETS}
      showCommand={true}
      busy={launching}
      error={launchError}
      onLaunch={launch}
      onClose={() => { if (!launching) launchOpen = false; }}
      hint="Pick an agent — the exact launch command is shown before you run it."
    />
  </div>
{:else}
  {@const session = view.name}
  {@const sendKeys = sendKeysTo(session)}
  {@const termUsesAltScreenMouse = !!altScreenSessions[session]}
  <div
    class="stage"
    style:--dock-inset={dockInset > 0 ? `${dockInset}px` : null}
    style:--dock-full={dockFull > 0 ? `${dockFull}px` : null}
    style:--kb-inset={kbInset > 0 ? `${kbInset}px` : null}
    style:--agent={surface.agent} style:--tbg={surface.tbg} style:--tstage={surface.tstage}
    style:--tfg={surface.tfg} style:--hud={surface.hud} style:--hud-fg={surface.hudFg}
    style:--hud-line={surface.hudLine}
  >
    <div class="host" style:top={`${hudHeight}px`}>
      {#key `${bg}|${fontPx}`}
        {#if isDesktop}
          <DesktopKeys bind:focused={desktopKeysFocused} onKeys={sendKeys} ariaLabel={`Terminal ${session}`}>
            <TermView
              bind:this={termRef}
              {session} palette={termPalette} {fontPx}
              bottomInsetPx={dockInset + kbInset + (shortcutBarH > 0 ? shortcutBarH + 8 : 0) + (scrollControlsHeight > 0 ? scrollControlsHeight + 8 : 0)}
              claimGeometry={!termUsesAltScreenMouse}
              altScreenMouse={termUsesAltScreenMouse}
              onKeys={sendKeys}
              onTap={() => composerRef?.openDock()}
              onLinesChange={onTermLinesChange}
              onScrollStateChange={onTermScrollStateChange}
            />
          </DesktopKeys>
        {:else}
          <TermView
            bind:this={termRef}
            {session} palette={termPalette} {fontPx}
            bottomInsetPx={dockInset + kbInset + (shortcutBarH > 0 ? shortcutBarH + 8 : 0) + (scrollControlsHeight > 0 ? scrollControlsHeight + 8 : 0)}
            claimGeometry={!termUsesAltScreenMouse}
            altScreenMouse={termUsesAltScreenMouse}
            onKeys={sendKeys}
            onTap={() => composerRef?.openDock()}
            onLinesChange={onTermLinesChange}
            onScrollStateChange={onTermScrollStateChange}
          />
        {/if}
      {/key}
    </div>
    {#snippet hudPanel()}
      <NotePanel
        note={notes[session] ?? ''}
        onSave={(t) => saveNote(session, t)}
      />
      <div style="height:10px"></div>
      <PromptsPanel
        prompts={recentPrompts}
        onPick={(pr) => { composeText = pr; hudExpanded = false; composerRef?.openCompose(); }}
      />
    {/snippet}
    <TermHud
      chip="TMUX"
      title={session}
      status="live"
      bind:barHeight={hudHeight}
      bind:expanded={hudExpanded}
      panel={hudPanel}
      onBack={showHub}
    />
    <ShortcutBar
      bind:barHeight={shortcutBarH}
      {shortcuts}
      visible={!slotsOpen && !themeOpen && !shortcutsOpen && !dpadOpen && !termScrollState.scrolledUp}
      onSend={(sc) => { tmuxMux.sendKeys(session, sc.send); if (sc.submit !== false) setTimeout(() => tmuxMux.sendKeys(session, '\r'), 120); }}
      onManage={() => (shortcutsOpen = true)}
    />
    {#if termScrollState.scrolledUp}
      <div class="scroll-controls" bind:offsetHeight={scrollControlsHeight}>
        {#if hasNewContent}
          <button data-testid="demo-new-content" onclick={scrollToTerminalBottom}>New content</button>
        {:else}
          <button data-testid="demo-scroll-bottom" onclick={scrollToTerminalBottom}>Scroll to bottom</button>
        {/if}
      </div>
    {/if}
    <ShortcutsSheet bind:open={shortcutsOpen} {shortcuts} onChange={setShortcuts} />
    <ActionFab bind:open={slotsOpen} active={slotsOpen || composerOpen} {actions} onFab={(e) => { e.stopPropagation(); if (composerOpen) composerRef?.closeDock(); else slotsOpen = !slotsOpen; }} />
    <DpadSheet bind:open={dpadOpen} onKey={(seq) => tmuxMux.sendKeys(session, seq)} />
    <ThemeSheet
      bind:open={themeOpen}
      bind:customBg
      title="THEME"
      mode={luminance(bg) > 0.55 ? 'light' : 'dark'}
      onToggleMode={(m) => setBg(m === 'light' ? '#f5f0e8' : '#101014')}
      swatchLabel="Background"
      swatches={THEME_SWATCHES}
      currentBg={bg}
      defaultBg="#101014"
      onPick={setBg}
      onReset={() => setBg('#101014')}
    />
    <UploadAction
      bind:this={uploadRef}
      bind:busy={uploading}
      onUploaded={(message) => { composeText = message; composerRef?.openCompose(); }}
      onError={(m) => { composeText = `Upload failed: ${m}`; composerRef?.openCompose(); }}
    />
    <ComposerDock
      bind:this={composerRef}
      bind:open={composerOpen}
      bind:mode={composerMode}
      bind:text={composeText}
      bind:dockInset bind:dockFull bind:kbInset
      onSend={(text) => { tmuxMux.sendKeys(session, text); setTimeout(() => tmuxMux.sendKeys(session, '\r'), 120); }}
      onDirectText={(d) => tmuxMux.sendKeys(session, d)}
      onDirectKey={(seq) => tmuxMux.sendKeys(session, seq)}
      onPasteFiles={(files) => uploadRef?.uploadFiles(files)}
    />
  </div>
{/if}

<style>
  .hub {
    --hub-card: #ffffff; --hub-line: #d8d2c8; --hub-ink: #1a1a1a; --hub-ink2: #6b6560;
    position: fixed; inset: 0; overflow-y: auto; background: #f5f2ec;
    font-family: var(--font-mono);
  }
  .bar {
    position: sticky; top: 0; z-index: 5;
    display: flex; align-items: center; gap: 10px;
    background: #ffffff; color: #1a1a1a; border-bottom: 1px solid #d8d2c8;
    padding: calc(8px + env(safe-area-inset-top)) 12px 8px;
    font: 700 12px var(--font-mono); letter-spacing: .12em;
  }
  .count { margin-left: auto; color: #6b6560; }
  .stage {
    --agent: #7dffa0; --tbg: #101014; --tstage: #0a0a0d; --tfg: #e6e6e6;
    --hud: rgba(16,16,20,.95); --hud-fg: #e6e6e6; --hud-line: #34343a;
    /* clip, NOT hidden: sheets parked at translateY(105%) make the stage's
       scrollable-overflow region taller than the viewport, and focus/caret
       moves can then SCROLL the "unscrollable" fixed stage (hud measured at
       top:-177 in fleet round 5). overflow:clip forbids all scrolling. */
    position: fixed; inset: 0; height: 100dvh; overflow: clip;
    background: var(--tstage); font-family: var(--font-mono);
  }
  .host {
    /* top is set inline from TermHud's measured barHeight: the HUD is opaque,
       so the terminal must START below it (absolute children ignore parent
       padding — the old padding-top approach never worked). */
    position: absolute; top: 0; left: 0; right: 0;
    bottom: calc(var(--dock-inset, 0px) + var(--kb-inset, 0px) + env(safe-area-inset-bottom, 0px));
    background: var(--tbg);
  }
  .host :global(.desktop-keys) {
    position: absolute;
    inset: 0;
    color: var(--tfg);
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
