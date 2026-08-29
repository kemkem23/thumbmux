<script lang="ts">
  import {
    DEFAULT_LAUNCH_PRESETS,
    defaultSurface,
    type LaunchSpec,
    type SessionListItem,
  } from '../core/index.js';
  import {
    LaunchSheet,
    SessionGrid,
    tmuxMux,
    type GridSession,
    type LaunchContext,
  } from '../svelte/index.js';
  import { onMount } from 'svelte';
  import { DEFAULT_APP_LABELS, type AppAdapters } from './config';
  import { createSessionsStore } from './sessions-store';

  let {
    adapters,
    onOpen,
  }: {
    adapters: AppAdapters;
    /** Internal navigation event used when the host did not supply routes. */
    onOpen?: (name: string) => void;
  } = $props();

  let rows = $state<SessionListItem[]>([]);
  let sessionsLoaded = $state(false);
  let launchOpen = $state(false);
  let launching = $state(false);
  let launchError = $state<string | null>(null);
  let contexts = $state<LaunchContext[]>([]);
  // True only while a host-supplied contexts() promise is in flight. Distinct
  // from "contexts is empty" — empty after settle means the host has no
  // workspaces (null is correct); empty while loading must not launch yet.
  let contextsLoading = $state(false);
  let viewActive = false;

  let labels = $derived({ ...DEFAULT_APP_LABELS, ...adapters.labels });
  let basePath = $derived(normalizeBasePath(adapters.basePath));
  let palette = $derived(defaultSurface(adapters.theme?.defaultBg ?? '#101014').palette);
  let hubPresentation = $derived(adapters.hubPresentation);
  let launcherDark = $derived(adapters.theme?.mode?.() === 'dark');
  let presets = $derived([...(adapters.spawn?.presets ?? DEFAULT_LAUNCH_PRESETS)]);
  let gridSessions = $derived.by((): GridSession[] => {
    const sessions = adapters.sessionMeta
      ? adapters.sessionMeta(rows)
      : rows.map((row) => ({ name: row.name }));
    const surfaceFor = adapters.theme?.surfaceFor;
    if (!surfaceFor) return sessions;
    return sessions.map((session) => {
      const surface = surfaceFor(session.name);
      return surface ? { ...session, palette: surface.palette } : session;
    });
  });

  function normalizeBasePath(value: string | undefined): string {
    const path = (value ?? '/api').trim();
    if (!path || path === '/') return '';
    const rooted = path.startsWith('/') ? path : `/${path}`;
    return rooted.replace(/\/+$/, '');
  }

  function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  function responseError(value: unknown, fallback: string): string {
    if (value && typeof value === 'object') {
      const record = value as { error?: unknown; message?: unknown };
      for (const candidate of [record.error, record.message]) {
        if (typeof candidate === 'string' && candidate.trim()) return candidate;
      }
    }
    return fallback;
  }

  async function fetchDefaultSessions(path: string): Promise<SessionListItem[]> {
    const response = await fetch(`${path}/sessions`);
    const data: unknown = await response.json().catch(() => null);
    if (!response.ok) throw new Error(responseError(data, `HTTP ${response.status}`));
    if (!Array.isArray(data)) throw new Error('session response must be an array');
    return data as SessionListItem[];
  }

  async function launchDefault(path: string, spec: LaunchSpec): Promise<{ name: string }> {
    const response = await fetch(`${path}/spawn`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(spec),
    });
    const data: unknown = await response.json().catch(() => null);
    if (!response.ok) throw new Error(responseError(data, `HTTP ${response.status}`));
    // Reject non-string names instead of coercing via String(...) — a malformed
    // payload like { name: { malformed: true } } must not become "[object Object]".
    const rawName = data && typeof data === 'object' && 'name' in data
      ? (data as { name?: unknown }).name
      : undefined;
    const name = typeof rawName === 'string' ? rawName.trim() : '';
    if (!name) throw new Error('spawn response did not include a session name');
    return { name };
  }

  function openSession(name: string): void {
    if (adapters.routes) {
      adapters.routes.openSession(name);
      return;
    }
    onOpen?.(name);
  }

  function openLauncher(): void {
    launchError = null;
    launchOpen = true;
  }

  function closeLauncher(): void {
    if (!launching) launchOpen = false;
  }

  async function launch(spec: LaunchSpec, contextId: string | null): Promise<void> {
    if (launching) return;
    // Host supplied contexts() but it has not settled — null would mean
    // "no contexts" per the contract, which is wrong while still loading.
    if (adapters.spawn?.contexts && adapters.spawn.launch && contextsLoading) return;
    launching = true;
    launchError = null;
    try {
      const result = adapters.spawn?.launch
        ? await adapters.spawn.launch(spec, contextId)
        : await launchDefault(basePath, spec);
      if (!viewActive) return;
      const name = typeof result.name === 'string' ? result.name.trim() : '';
      if (!name) throw new Error('launcher did not return a session name');
      launchOpen = false;
      openSession(name);
    } catch (error) {
      if (viewActive) launchError = labels.launchFailed(errorMessage(error));
    } finally {
      if (viewActive) launching = false;
    }
  }

  onMount(() => {
    let active = true;
    viewActive = true;
    const sessions = createSessionsStore({
      mux: adapters.mux ?? tmuxMux,
      fetchSessions: adapters.fetchSessions ?? (() => fetchDefaultSessions(basePath)),
    });
    const unsubscribe = sessions.subscribe((snapshot) => {
      rows = snapshot.rows;
      sessionsLoaded = snapshot.loaded;
    });

    if (adapters.spawn?.contexts && adapters.spawn.launch) {
      contextsLoading = true;
      void adapters.spawn.contexts().then(
        (nextContexts) => {
          if (active) {
            contexts = nextContexts;
            contextsLoading = false;
          }
        },
        () => {
          if (active) {
            contexts = [];
            contextsLoading = false;
          }
        },
      );
    }

    return () => {
      active = false;
      viewActive = false;
      unsubscribe();
      sessions.dispose();
    };
  });
</script>

<div class="hub" data-testid="hub-view">
  <div class="bar">
    <span class="title" data-testid="hub-title">{labels.hubTitle}</span>
    <span class="count" data-testid="hub-count">{labels.hubCount(rows.length)}</span>
  </div>

  <SessionGrid
    sessions={gridSessions}
    {palette}
    onOpen={openSession}
    onNew={openLauncher}
    newLabel={labels.gridNew}
    emptyLabel={labels.gridEmpty}
    loading={!sessionsLoaded}
    loadingLabel={labels.gridLoading}
    allFilterLabel={labels.gridAll}
    searchable
    searchLabel={labels.gridSearchLabel}
    searchPlaceholder={labels.gridSearchPlaceholder}
    groupToggleLabel={labels.gridGroup}
    ungroupedLabel={labels.gridUngrouped}
    filterOptions={hubPresentation?.filterOptions}
    groupable={hubPresentation?.groupable}
    order={hubPresentation?.order}
    cardLayout={hubPresentation?.cardLayout}
  />

  <LaunchSheet
    open={launchOpen}
    dark={launcherDark}
    {presets}
    {contexts}
    showCommand={hubPresentation?.showCommand}
    busy={launching || contextsLoading}
    error={launchError}
    onLaunch={launch}
    onClose={closeLauncher}
    title={labels.launchTitle}
    hint={labels.launchHint}
    contextLabel={labels.launchContext}
    permissionLabel={labels.launchPermission}
    modelLabel={labels.launchModel}
    launchLabel={labels.launchAction}
    busyLabel={labels.launchBusy}
    closeAria={labels.close}
  />
</div>

<style>
  .hub {
    --hub-card: #ffffff;
    --hub-line: #d8d2c8;
    --hub-ink: #1a1a1a;
    --hub-ink2: #6b6560;
    --hub-accent: #1a1a1a;
    position: fixed;
    inset: 0;
    overflow-y: auto;
    background: #f5f2ec;
    color: var(--hub-ink);
    font-family: var(--font-mono, ui-monospace, monospace);
    padding-bottom: env(safe-area-inset-bottom);
  }

  .bar {
    position: sticky;
    top: 0;
    z-index: 5;
    display: flex;
    align-items: center;
    gap: 10px;
    min-height: calc(56px + env(safe-area-inset-top));
    box-sizing: border-box;
    padding: calc(6px + env(safe-area-inset-top)) 12px 6px;
    border-bottom: 1px solid var(--hub-line);
    background: var(--hub-card);
  }

  .title {
    font-size: 12px;
    font-weight: 700;
    letter-spacing: .12em;
  }

  .count {
    margin-left: auto;
    color: var(--hub-ink2);
    font-size: 11px;
    font-weight: 700;
  }
</style>
