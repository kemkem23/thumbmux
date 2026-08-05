<script lang="ts">
  /** The demo is a thin host: policy lives here, while the UI lives in app. */
  import { ThumbmuxApp, type AppAdapters } from '@thumbmux/app';
  import {
    DEFAULT_LAUNCH_PRESETS, defaultSurface, extractRecentPrompts, luminance,
    type LaunchPreset, type LaunchSpec, type SessionListItem, type SubmitAgent, type ThumbmuxPrefs,
  } from '@thumbmux/core';
  import { createLocalPrefs, tmuxMux } from '@thumbmux/svelte';
  import { onMount } from 'svelte';
  import {
    createDemoSessionsMux, demoSessionMetadataFromName, demoSpawnPayload,
    demoSubmitAgent, sessionMetadataFromRows,
  } from '../policy';

  const PREFS_KEY = 'thumbmux-demo-prefs';
  const DARK_BG = '#101014';
  const LIGHT_BG = '#f5f0e8';
  const THEME_SWATCHES = [DARK_BG, '#000000', '#0b1c3d', '#b34700', LIGHT_BG, '#e6e6e6'];
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
  const prefs = createLocalPrefs(PREFS_KEY);
  const gridDelayMs = (() => {
    const value = Number(new URL(window.location.href).searchParams.get('gridDelayMs') ?? 0);
    return Number.isFinite(value) ? Math.max(0, Math.min(2_000, value)) : 0;
  })();

  let bg = $state(DARK_BG);
  let altScreenSessions = $state<Record<string, boolean>>({});
  let launchedAgents = $state<Record<string, SubmitAgent>>({});
  let liveSessionsSeen = false;

  function hydrateSessionMetadata(rows: readonly unknown[]): void {
    const metadata = sessionMetadataFromRows(rows);
    // A session-list row is authoritative. Replacing the maps also drops
    // metadata for dead sessions instead of retaining it for a recycled name.
    launchedAgents = metadata.agents;
    altScreenSessions = metadata.altScreens;
  }

  const demoMux = createDemoSessionsMux(tmuxMux, {
    delayMs: gridDelayMs,
    hydrate(rows) {
      liveSessionsSeen = true;
      hydrateSessionMetadata(rows);
    },
  });

  async function fetchSessions(): Promise<SessionListItem[]> {
    const response = await fetch('/api/sessions');
    const data: unknown = await response.json().catch(() => null);
    if (gridDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, gridDelayMs));
    if (!response.ok || !Array.isArray(data)) throw new Error(`HTTP ${response.status}`);
    // Once a live push exists it outranks a potentially older REST bootstrap.
    if (!liveSessionsSeen) hydrateSessionMetadata(data);
    return data as SessionListItem[];
  }

  function noteMap(snapshot: ThumbmuxPrefs): Record<string, string> {
    const notes = snapshot.demoNotes;
    return notes && typeof notes === 'object' && !Array.isArray(notes)
      ? notes as Record<string, string> : {};
  }
  const notes = {
    async load(session: string) { return noteMap(await prefs.load())[session] ?? ''; },
    async save(session: string, text: string) {
      await prefs.save({ demoNotes: { ...noteMap(await prefs.load()), [session]: text } });
    },
  };

  async function launch(spec: LaunchSpec): Promise<{ name: string }> {
    const response = await fetch('/api/spawn', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(demoSpawnPayload(spec)),
    });
    const data: any = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data?.error ?? `HTTP ${response.status}`);
    const name = String(data?.name ?? '').trim();
    if (!name) throw new Error('spawn response did not include a session name');
    altScreenSessions = { ...altScreenSessions, [name]: spec.presetId === ALT_SCREEN_PRESET_ID };
    launchedAgents = { ...launchedAgents, [name]: demoSubmitAgent(spec.agent) };
    return { name };
  }

  async function loadPrompts(session: string): Promise<string[]> {
    const response = await fetch(`/api/prompts?session=${encodeURIComponent(session)}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return extractRecentPrompts((await response.text()).split('\n'), { targetCount: 5 });
  }
  function setBg(next: string) { bg = next; void prefs.save({ theme: { bg: next } }); }

  onMount(() => {
    let active = true;
    void prefs.load().then((snapshot) => {
      const stored = snapshot.theme?.bg;
      if (active && typeof stored === 'string') bg = stored;
    });
    const markHost = () => document.querySelector('.mtv-host')?.classList.add('host');
    markHost();
    const observer = new MutationObserver(markHost);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => { active = false; observer.disconnect(); };
  });

  let adapters = $derived.by((): AppAdapters => {
    const altScreens = altScreenSessions;
    const agents = launchedAgents;
    const surface = defaultSurface(bg);
    return {
      fetchSessions, mux: demoMux, prefs, notes, prompts: loadPrompts,
      spawn: { presets: PRESETS, launch },
      upload: { endpoint: () => '/api/upload', dir: 'uploads' },
      submitAgent: (session) => (
        agents[session] ?? demoSessionMetadataFromName(session)?.submitAgent ?? 'generic'
      ),
      // These two answer different questions and neither is the other's inverse.
      // claimGeometry asks who owns the pane size; altScreenMouse asks where
      // pointer input goes. termProps configures SessionView, the primary
      // interactive terminal, so it claims geometry for every session — an
      // alt-screen TUI needs a correctly sized pty exactly as much as any other.
      // The surfaces that must not claim (EmbedView, thumbnails) force it off
      // themselves rather than trusting a host to remember.
      termProps: (session) => ({
        claimGeometry: true,
        altScreenMouse: altScreens[session]
          ?? demoSessionMetadataFromName(session)?.altScreenMouse
          ?? false,
      }),
      theme: {
        defaultBg: DARK_BG, swatches: THEME_SWATCHES, storageKey: PREFS_KEY,
        surfaceFor: () => surface,
        mode: () => luminance(surface.tbg) > 0.55 ? 'light' : 'dark',
        onToggleMode: (mode) => setBg(mode === 'light' ? LIGHT_BG : DARK_BG),
        onPick: (_session, color) => setBg(color),
        onReset: () => setBg(DARK_BG),
      },
      labels: {
        hubTitle: 'THUMBMUX · DEMO', hubCount: String,
        gridEmpty: 'No tmux sessions yet — tap + terminal',
        launchHint: 'Pick an agent — the exact launch command is shown before you run it.',
        launchFailed: String,
        noteEmpty: 'no note yet',
      },
    };
  });
</script>

<ThumbmuxApp {adapters} />
