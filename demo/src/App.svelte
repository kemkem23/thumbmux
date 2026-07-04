<script lang="ts">
  /** thumbmux demo — hub of your local tmux sessions + a full terminal view.
   * One Bun process serves this page, the WebSocket mux, and the spawn API. */
  import {
    SessionGrid, LaunchSheet, TermView, TermHud, ComposerDock, DpadSheet, ActionFab, UploadAction,
    tmuxMux, type GridSession, type FabAction,
  } from '@thumbmux/svelte';
  import { DEFAULT_LAUNCH_PRESETS, type LaunchSpec, type AnsiPalette } from '@thumbmux/core';
  import { onMount, onDestroy } from 'svelte';

  const PALETTE: AnsiPalette = {
    base: ['#101014', '#ff7a7a', '#7dffa0', '#ffef9e', '#c8b4ff', '#ff9ad5', '#9be9ff', '#e8e8e8',
           '#8a8a92', '#ff9d9d', '#a0ffbe', '#fff5bd', '#dcCEff', '#ffbde4', '#c2f1ff', '#ffffff'],
    defaultFg: '#e6e6e6',
    defaultBg: '#101014',
  };
  // The demo skips the worktree presets (a generic host may not be a git repo).
  const PRESETS = DEFAULT_LAUNCH_PRESETS.filter((p) => !p.worktree);

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
        body: JSON.stringify({ command: spec.command }),
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
  ]);

  onMount(() => {
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
  >
    <div class="host">
      <TermView {session} palette={PALETTE} bottomInsetPx={dockInset + kbInset} onTap={() => composerRef?.openDock()} />
    </div>
    <TermHud
      chip="TMUX"
      title={session}
      status="live"
      onBack={() => { composerRef?.closeDock(); view = { kind: 'hub' }; }}
    />
    <ActionFab bind:open={slotsOpen} active={slotsOpen || composerOpen} {actions} onFab={(e) => { e.stopPropagation(); if (composerOpen) composerRef?.closeDock(); else slotsOpen = !slotsOpen; }} />
    <DpadSheet bind:open={dpadOpen} onKey={(seq) => tmuxMux.sendKeys(session, seq)} />
    <UploadAction
      bind:this={uploadRef}
      bind:busy={uploading}
      onUploaded={(message) => { composeText = message; composerRef?.openDock(); }}
      onError={(m) => { composeText = `Upload failed: ${m}`; composerRef?.openDock(); }}
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
    position: absolute; top: 0; left: 0; right: 0;
    bottom: calc(var(--dock-inset, 0px) + var(--kb-inset, 0px) + env(safe-area-inset-bottom, 0px));
    padding-top: calc(46px + env(safe-area-inset-top));
    background: var(--tbg);
  }
</style>
