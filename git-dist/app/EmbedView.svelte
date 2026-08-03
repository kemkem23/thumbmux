<script lang="ts">
  import { defaultSurface, submitPlan } from '../core/index.js';
  import {
    ComposerDock,
    DesktopKeys,
    TermView,
    tmuxMux,
  } from '../svelte/index.js';
  import {
    DEFAULT_APP_LABELS,
    type AppAdapters,
    type AppLabels,
    type SubmissionTransport,
  } from './config';
  import { prefillOnError } from './overlay';

  let {
    session,
    adapters,
    fontPx = undefined,
    minRows = 14,
  }: {
    session: string;
    adapters: AppAdapters;
    fontPx?: number;
    minRows?: number;
  } = $props();

  let labels = $derived<AppLabels>({ ...DEFAULT_APP_LABELS, ...adapters.labels });
  let configuredTermProps = $derived(adapters.termProps?.(session) ?? {});
  let configuredBg = $derived(
    adapters.theme?.bgFor?.(session) ?? adapters.theme?.defaultBg ?? '#101014',
  );
  let fallbackSurface = $derived(defaultSurface(configuredBg));
  let hostSurface = $derived(adapters.theme?.surfaceFor?.(session) ?? null);
  let surface = $derived(hostSurface ?? fallbackSurface);
  let palette = $derived(
    hostSurface?.palette ?? configuredTermProps.palette ?? fallbackSurface.palette,
  );
  let effectiveFontPx = $derived(fontPx ?? configuredTermProps.fontPx ?? 13);
  let terminalMinHeight = $derived(Math.round(minRows * effectiveFontPx * 1.4 + 32));

  let composerRef = $state<ReturnType<typeof ComposerDock> | null>(null);
  let composerOpen = $state(false);
  let dockFull = $state(0);
  let kbInset = $state(0);
  let desktopKeysFocused = $state(false);
  let composer = $state({
    text: '',
    mode: 'compose' as 'compose' | 'direct',
    openCompose: () => {
      composerOpen = true;
      composerRef?.openCompose();
    },
  });

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

  async function deliverHostSubmission(
    targetSession: string,
    transport: SubmissionTransport,
    steps: ReturnType<typeof submitPlan>,
  ): Promise<void> {
    let previousStepAcknowledged = false;
    for (const step of steps) {
      if (!previousStepAcknowledged && step.delayBeforeMs > 0) {
        await wait(step.delayBeforeMs);
      }
      const acknowledgement = transport(targetSession, step.keys);
      previousStepAcknowledged = acknowledgement !== undefined;
      if (acknowledgement !== undefined) await acknowledgement;
    }
  }

  async function sendSubmission(text: string): Promise<void> {
    if (!text) return;
    const targetSession = session;
    const agent = adapters.submitAgent?.(targetSession) ?? 'generic';
    const steps = submitPlan(text, { agent });
    const submissionTransport = adapters.sendSubmissionKeys;
    if (submissionTransport) {
      await deliverHostSubmission(targetSession, submissionTransport, steps);
      return;
    }
    const transport = adapters.sendKeys
      ?? ((name: string, keys: string) => tmuxMux.sendKeys(name, keys));
    for (const step of steps) {
      if (step.delayBeforeMs > 0) await wait(step.delayBeforeMs);
      transport(targetSession, step.keys);
    }
  }

  function submitDraft(text: string): void {
    void sendSubmission(text).catch(() => prefillOnError(composer, text));
  }

  function openComposer(): void {
    composerOpen = true;
    composerRef?.openDock();
  }
</script>

<div
  class="embed-view"
  data-testid="embed-view"
  style:min-height={`${terminalMinHeight}px`}
  style:--agent={surface.agent}
  style:--tbg={surface.tbg}
  style:--tstage={surface.tstage}
  style:--tfg={surface.tfg}
  style:--hud={surface.hud}
  style:--hud-fg={surface.hudFg}
  style:--hud-line={surface.hudLine}
  style:--dock-full={dockFull > 0 ? `${dockFull}px` : null}
  style:--kb-inset={kbInset > 0 ? `${kbInset}px` : null}
>
  <div class="embed-terminal">
    {#key `${session}|${surface.tbg}|${effectiveFontPx}|${minRows}`}
      <DesktopKeys
        bind:focused={desktopKeysFocused}
        onKeys={sendKeys}
        ariaLabel={labels.terminalAria(session)}
      >
        <TermView
          {session}
          {palette}
          fontPx={effectiveFontPx}
          {minRows}
          claimGeometry={false}
          altScreenMouse={configuredTermProps.altScreenMouse ?? false}
          bottomInsetPx={dockFull + kbInset}
          onKeys={sendKeys}
          onTap={openComposer}
        />
      </DesktopKeys>
    {/key}
  </div>

  <ComposerDock
    bind:this={composerRef}
    bind:open={composerOpen}
    bind:mode={composer.mode}
    bind:text={composer.text}
    bind:dockFull
    bind:kbInset
    onSend={submitDraft}
    onDirectText={sendKeys}
    onDirectKey={sendKeys}
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
</div>

<style>
  .embed-view {
    position: relative;
    width: 100%;
    height: 100%;
    min-height: 220px;
    overflow: clip;
    background: var(--tstage);
    color: var(--tfg);
    font-family: var(--font-mono);
  }

  .embed-terminal {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    bottom: calc(var(--dock-full, 0px) + var(--kb-inset, 0px));
    background: var(--tbg);
  }

  .embed-terminal :global(.desktop-keys) {
    position: absolute;
    inset: 0;
    color: var(--tfg);
  }
</style>
