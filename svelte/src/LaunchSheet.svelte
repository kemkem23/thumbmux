<script module lang="ts">
  export type LaunchContext = { id: string; label: string };
</script>

<script lang="ts">
  /** LaunchSheet — the "+ terminal" picker. Preset rows (agents ± worktree +
   * a blank shell), each expanding into permission/model dropdowns and an
   * optional live command preview showing exactly what will be injected.
   * The host runs the command (or maps the spec onto its own spawn API). */
  import {
    DEFAULT_LAUNCH_PRESETS, buildLaunchCommand, buildLaunchSpec,
    type LaunchPreset, type LaunchSpec,
  } from '@thumbmux/core';

  let {
    open = false,
    dark = false,
    presets = DEFAULT_LAUNCH_PRESETS,
    contexts = [],
    showCommand = true,
    busy = false,
    error = null,
    onLaunch,
    onClose,
    title = 'New terminal',
    hint = 'Pick an agent — permissions and model are injected into the launch command.',
    contextLabel = 'Workspace',
    permissionLabel = 'Permissions',
    modelLabel = 'Model',
    launchLabel = 'Launch',
    busyLabel = '⏳ Opening session…',
    closeAria = 'Close',
  }: {
    open?: boolean;
    dark?: boolean;
    presets?: LaunchPreset[];
    /** optional workspace/topic picker (host-defined) */
    contexts?: LaunchContext[];
    /** show the injected command preview (hosts that build commands
     * server-side can hide it) */
    showCommand?: boolean;
    busy?: boolean;
    error?: string | null;
    onLaunch: (spec: LaunchSpec, contextId: string | null) => void;
    onClose: () => void;
    title?: string;
    hint?: string;
    contextLabel?: string;
    permissionLabel?: string;
    modelLabel?: string;
    launchLabel?: string;
    busyLabel?: string;
    closeAria?: string;
  } = $props();

  let selectedId = $state<string | null>(null);
  let permission = $state<string>('');
  let model = $state<string>('');
  let contextId = $state<string>('');

  let selected = $derived(presets.find((p) => p.id === selectedId) ?? null);
  let command = $derived(selected ? buildLaunchCommand(selected, permission, model) : '');

  function pick(p: LaunchPreset) {
    selectedId = p.id;
    permission = p.permissionOptions[0]?.value ?? '';
    model = p.modelOptions[0]?.value ?? '';
    if (!contextId && contexts.length > 0) contextId = contexts[0].id;
  }

  function launch() {
    if (!selected || busy) return;
    onLaunch(buildLaunchSpec(selected, permission, model), contextId || null);
  }
</script>

{#if open}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="backdrop" onclick={() => { if (!busy) onClose(); }}></div>
  <div class="sheet" class:dark data-testid="launch-sheet">
    <div class="head">
      <span class="title">{title}</span>
      <button class="close" onclick={() => { if (!busy) onClose(); }} aria-label={closeAria}>✕</button>
    </div>
    <div class="hint">{hint}</div>

    <div class="presets">
      {#each presets as p (p.id)}
        <button
          class="preset"
          class:on={selectedId === p.id}
          style:--accent={p.color}
          disabled={busy}
          onclick={() => pick(p)}
          data-testid="launch-preset"
          data-preset={p.id}
        >
          <span class="dot" style:background={p.color}></span>
          {p.label}
        </button>
      {/each}
    </div>

    {#if selected}
      <div class="config" data-testid="launch-config">
        {#if contexts.length > 0}
          <label class="field">
            <span>{contextLabel}</span>
            <select bind:value={contextId} disabled={busy} data-testid="launch-context">
              {#each contexts as c (c.id)}
                <option value={c.id}>{c.label}</option>
              {/each}
            </select>
          </label>
        {/if}
        {#if selected.baseCommand}
          <label class="field">
            <span>{permissionLabel}</span>
            <select bind:value={permission} disabled={busy} data-testid="launch-permission">
              {#each selected.permissionOptions as o (o.value)}
                <option value={o.value}>{o.label}</option>
              {/each}
            </select>
          </label>
          <label class="field">
            <span>{modelLabel}</span>
            <select bind:value={model} disabled={busy} data-testid="launch-model">
              {#each selected.modelOptions as o (o.value)}
                <option value={o.value}>{o.label}</option>
              {/each}
            </select>
          </label>
          {#if showCommand}
            <div class="cmd" data-testid="launch-command"><span class="ps1">$</span> {command}</div>
            {#if selected.worktree}
              <div class="wtnote" data-testid="launch-worktree-note">⎇ runs in a fresh git worktree the host creates before launch</div>
            {/if}
          {/if}
        {/if}
        <button class="go" style:--accent={selected.color} disabled={busy} onclick={launch} data-testid="launch-go">
          {busy ? busyLabel : launchLabel}
        </button>
      </div>
    {/if}

    {#if error}
      <div class="err">{error}</div>
    {/if}
  </div>
{/if}

<style>
  .backdrop {
    position: fixed; inset: 0; z-index: 60; background: rgba(0,0,0,.45);
  }
  .sheet {
    --l-bg: #ffffff; --l-bg2: #f5f2ec; --l-ink: #1a1a1a; --l-ink2: #6b6560;
    --l-line: #d8d2c8; --l-err: #b3261e;
    position: fixed; left: 0; right: 0; bottom: 0; z-index: 61;
    background: var(--l-bg); border-top: 1px solid var(--l-ink);
    color: var(--l-ink);
    padding: 12px 12px calc(16px + env(safe-area-inset-bottom));
    font-family: var(--font-mono, ui-monospace, monospace);
    max-height: 82dvh; overflow-y: auto;
  }
  .sheet.dark {
    --l-bg: #17171a; --l-bg2: #202024; --l-ink: #e8e4dc; --l-ink2: #9b9590;
    --l-line: #3a3a40; --l-err: #ff8a7e;
  }
  .head { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
  .title { font: 700 13px var(--font-mono, ui-monospace, monospace); }
  .wtnote { font: 600 10px var(--font-mono, ui-monospace, monospace); color: var(--l-ink2); margin-top: 4px; }
  .close { margin-left: auto; min-width: 44px; min-height: 44px; background: none; border: 1px solid var(--l-ink); color: var(--l-ink); font: 700 13px inherit; touch-action: manipulation; flex: 0 0 auto; }
  .hint { font: 400 11.5px var(--font-thai, sans-serif); line-height: 1.6; color: var(--l-ink2); margin-bottom: 10px; }
  .presets { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
  .preset {
    display: flex; align-items: center; gap: 7px;
    min-height: 46px; padding: 0 10px;
    background: var(--l-bg2); border: 1px solid var(--l-line); color: var(--l-ink);
    font: 700 11px var(--font-mono, ui-monospace, monospace); text-align: left;
    touch-action: manipulation;
  }
  .preset.on { border-color: var(--accent); outline: 1px solid var(--accent); }
  .preset:disabled { opacity: .5; }
  .dot { width: 9px; height: 9px; border-radius: 50%; flex: 0 0 auto; }
  .config { margin-top: 12px; display: flex; flex-direction: column; gap: 8px; }
  .field { display: flex; align-items: center; gap: 10px; }
  .field span { font: 700 9.5px var(--font-mono, ui-monospace, monospace); letter-spacing: .06em; color: var(--l-ink2); min-width: 92px; text-transform: uppercase; }
  .field select {
    flex: 1; min-height: 44px; padding: 0 8px;
    border: 1px solid var(--l-line); background: var(--l-bg2); color: var(--l-ink);
    font: 600 13px var(--font-mono, ui-monospace, monospace);
    -webkit-appearance: none; appearance: none;
  }
  .cmd {
    font: 500 11.5px var(--font-mono, ui-monospace, monospace);
    line-height: 1.6;
    background: var(--l-bg2); border: 1px dashed var(--l-line);
    color: var(--l-ink);
    padding: 8px 10px;
    word-break: break-all;
  }
  .ps1 { color: var(--l-ink2); margin-right: 4px; }
  .go {
    min-height: 48px;
    background: var(--accent); color: #fff;
    border: none;
    font: 700 12px var(--font-mono, ui-monospace, monospace); letter-spacing: .05em;
    touch-action: manipulation;
  }
  .go:disabled { opacity: .6; }
  .err { margin-top: 10px; font: 600 12px var(--font-thai, sans-serif); color: var(--l-err); }
</style>
