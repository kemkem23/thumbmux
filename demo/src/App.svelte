<script lang="ts">
  /** thumbmux demo — hub of your local tmux sessions + a full terminal view.
   * One Bun process serves this page, the WebSocket mux, and the spawn API. */
  import {
    SessionGrid, LaunchSheet, TermView, TermHud, ComposerDock, DpadSheet, ActionFab, ThemeSheet, UploadAction,
    tmuxMux, type GridSession, type FabAction,
  } from '@thumbmux/svelte';
  import { DEFAULT_LAUNCH_PRESETS, deriveSurface, luminance, type TerminalSurface, type LaunchSpec, type AnsiPalette } from '@thumbmux/core';
  import { onMount, onDestroy } from 'svelte';

  const PALETTE: AnsiPalette = {
    base: ['#101014', '#ff7a7a', '#7dffa0', '#ffef9e', '#c8b4ff', '#ff9ad5', '#9be9ff', '#e8e8e8',
           '#8a8a92', '#ff9d9d', '#a0ffbe', '#fff5bd', '#dcCEff', '#ffbde4', '#c2f1ff', '#ffffff'],
    defaultFg: '#e6e6e6',
    defaultBg: '#101014',
  };
  // All seven stock presets, worktree ones included — if the demo's cwd is
  // not a git repo, git prints its own self-explanatory error in the pane.
  const PRESETS = DEFAULT_LAUNCH_PRESETS;

  // --- theme + font (persisted; ThemeSheet is pure presentation) ---
  const BASE_SURFACE: TerminalSurface = {
    agent: '#7dffa0', tbg: '#101014', tstage: '#0a0a0d', tfg: '#e6e6e6',
    hud: 'rgba(16,16,20,.95)', hudFg: '#e6e6e6', hudLine: '#34343a',
    badge: '#1a1a1a', badgeFg: '#e6e6e6', xterm: {},
  };
  const THEME_SWATCHES = ['#101014', '#000000', '#0b1c3d', '#b34700', '#f5f0e8', '#e6e6e6'];
  let bg = $state('#101014');
  let fontPx = $state(13);
  let themeOpen = $state(false);
  let customBg = $state('#101014');
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
    try { localStorage.setItem('thumbmux-bg', hex); } catch {}
  }
  function setFont(next: number) {
    fontPx = Math.max(11, Math.min(18, next));
    try { localStorage.setItem('thumbmux-font', String(fontPx)); } catch {}
  }

  let view = $state<{ kind: 'hub' } | { kind: 'term'; name: string }>({ kind: 'hub' });
  let names = $state<string[]>([]);
  let launchOpen = $state(false);
  let launching = $state(false);
  let launchError = $state<string | null>(null);

  let gridSessions = $derived<GridSession[]>(names.map((name) => ({
    name, chip: 'TMUX', color: '#1a1a1a', palette: PALETTE,
  })));

  // Terminal view state
  let composerRef = $state<ReturnType<typeof ComposerDock> | null>(null);
  let composerOpen = $state(false);
  let composerMode = $state<'compose' | 'direct'>('compose');
  let dockInset = $state(0);
  let dockFull = $state(0);
  let kbInset = $state(0);
  let slotsOpen = $state(false);
  let dpadOpen = $state(false);
  let uploadRef = $state<ReturnType<typeof UploadAction> | null>(null);
  let hudHeight = $state(0);
  let uploading = $state(false);
  let composeText = $state('');

  let unsubSessions: (() => void) | null = null;

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
      launchOpen = false;
      view = { kind: 'term', name: data.name };
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
    { id: 'theme', label: '🎨 Theme', testid: 'demo-theme', onTap: () => { themeOpen = true; slotsOpen = false; } },
    { id: 'font-up', label: 'A+ Bigger text', onTap: () => setFont(fontPx + 1) },
    { id: 'font-down', label: 'A− Smaller text', onTap: () => setFont(fontPx - 1) },
  ]);

  onMount(() => {
    try {
      const b = localStorage.getItem('thumbmux-bg'); if (b) { bg = b; customBg = b; }
      const f = Number(localStorage.getItem('thumbmux-font')); if (f >= 11 && f <= 18) fontPx = f;
    } catch {}
    unsubSessions = tmuxMux.onSessions((rows: any[]) => {
      names = rows.map((r) => String(r?.name ?? '')).filter(Boolean);
    });
  });

  onDestroy(() => unsubSessions?.());
</script>

{#if view.kind === 'hub'}
  <div class="hub">
    <div class="bar"><span class="ttl">THUMBMUX · DEMO</span><span class="count">{names.length}</span></div>
    <SessionGrid
      sessions={gridSessions}
      palette={PALETTE}
      onOpen={(name) => (view = { kind: 'term', name })}
      onNew={() => { launchError = null; launchOpen = true; }}
      emptyLabel="No tmux sessions yet — tap + terminal"
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
  <div
    class="stage"
    style:--dock-inset={dockInset > 0 ? `${dockInset}px` : null}
    style:--kb-inset={kbInset > 0 ? `${kbInset}px` : null}
    style:--agent={surface.agent} style:--tbg={surface.tbg} style:--tstage={surface.tstage}
    style:--tfg={surface.tfg} style:--hud={surface.hud} style:--hud-fg={surface.hudFg}
    style:--hud-line={surface.hudLine}
  >
    <div class="host" style:top={`${hudHeight}px`}>
      {#key `${bg}|${fontPx}`}
        <TermView {session} palette={termPalette} {fontPx} bottomInsetPx={dockInset + kbInset} onTap={() => composerRef?.openDock()} />
      {/key}
    </div>
    <TermHud
      chip="TMUX"
      title={session}
      status="live"
      bind:barHeight={hudHeight}
      onBack={() => { composerRef?.closeDock(); view = { kind: 'hub' }; }}
    />
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
    position: fixed; inset: 0; height: 100dvh; overflow: hidden;
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
</style>
