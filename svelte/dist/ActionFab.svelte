<script module lang="ts">
  export type FabActionChoice = {
    id: string;
    label: string;
    testid?: string;
    /** Marks the currently active member of this mutually-exclusive group. */
    selected?: boolean;
    /** Longer accessible name when the visible label is intentionally terse. */
    ariaLabel?: string;
    onTap: () => void;
  };

  export type FabAction = {
    id: string;
    label: string;
    /** accent-bordered (e.g. preset send actions) */
    primary?: boolean;
    testid?: string;
    /** small trailing tag, e.g. "SEND" */
    tag?: string;
    onTap: () => void;
  };

  /** Optional one-level flyout kept separate from `FabAction` so adding this
   * presentation does not widen the frozen action type used by app adapters. */
  export type FabActionFlyout = {
    actionId: string;
    choices: readonly FabActionChoice[];
    ariaLabel?: string;
  };
</script>

<script lang="ts">
  import { tick } from 'svelte';

  /** ActionFab — the single ❯ launcher + its floating action slots. Dumb by
   * design: the host decides what tapping the FAB means while other sheets
   * are open (close-them-first orchestration stays host-side). */
  let {
    open = $bindable(false),
    active = false,
    actions,
    flyouts = [],
    onFab,
    fabAria = 'Actions',
  }: {
    open?: boolean;
    /** rotate the FAB into ✕ posture (any sheet open) */
    active?: boolean;
    actions: FabAction[];
    flyouts?: readonly FabActionFlyout[];
    onFab: (e: MouseEvent) => void;
    fabAria?: string;
  } = $props();

  let expandedActionId = $state<string | null>(null);
  let fabElement = $state<HTMLButtonElement | null>(null);

  function flyoutFor(actionId: string): FabActionFlyout | undefined {
    return flyouts.find((flyout) => flyout.actionId === actionId);
  }

  $effect(() => {
    if (
      expandedActionId !== null
      && (!open || !actions.some((action) => (
        action.id === expandedActionId
        && (flyoutFor(action.id)?.choices.length ?? 0) > 0
      )))
    ) {
      expandedActionId = null;
    }
  });

  function activateAction(action: FabAction): void {
    if (!open) return;
    if ((flyoutFor(action.id)?.choices.length ?? 0) > 0) {
      expandedActionId = expandedActionId === action.id ? null : action.id;
      return;
    }
    action.onTap();
  }

  function activateChoice(choice: FabActionChoice): void {
    if (!open) return;
    expandedActionId = null;
    open = false;
    choice.onTap();
    void tick().then(() => fabElement?.focus());
  }

  function focusRowTrigger(event: KeyboardEvent): void {
    const target = event.currentTarget;
    if (!(target instanceof HTMLElement)) return;
    const trigger = target.closest('.slot-row')?.querySelector<HTMLButtonElement>('.slot');
    void tick().then(() => trigger?.focus());
  }

  function handleSlotEscape(event: KeyboardEvent, action: FabAction): void {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    if (expandedActionId === action.id) {
      expandedActionId = null;
      return;
    }
    open = false;
    void tick().then(() => fabElement?.focus());
  }

  function handleChoiceEscape(event: KeyboardEvent): void {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    expandedActionId = null;
    focusRowTrigger(event);
  }
</script>

<div class="slots" class:open aria-hidden={!open}>
  {#each actions as a (a.id)}
    {@const flyout = flyoutFor(a.id)}
    {@const hasChoices = (flyout?.choices.length ?? 0) > 0}
    {@const choicesOpen = open && expandedActionId === a.id}
    <div class="slot-row" class:has-choices={hasChoices}>
      <!-- A6-12: closed slots stay mounted for the open animation but must not
           be tab stops or activatable via Enter/Space while hidden. -->
      <button
        type="button"
        class="slot"
        class:prim={a.primary}
        lang="th"
        onclick={() => activateAction(a)}
        onkeydown={(event) => handleSlotEscape(event, a)}
        data-testid={a.testid}
        tabindex={open ? 0 : -1}
        disabled={!open}
        aria-hidden={!open}
        aria-expanded={hasChoices ? choicesOpen : undefined}
      >
        {a.label}
        {#if a.tag}<small>{a.tag}</small>{/if}
        {#if hasChoices}
          <span
            class="disclosure"
            class:open={choicesOpen}
            aria-hidden="true"
            data-direction={choicesOpen ? 'right' : 'left'}
            data-testid="fab-disclosure-indicator"
          ></span>
        {/if}
      </button>

      {#if hasChoices}
        <div
          class="choices"
          class:open={choicesOpen}
          role="group"
          aria-label={flyout?.ariaLabel ?? `${a.label} choices`}
          aria-hidden={!choicesOpen}
        >
          {#each flyout?.choices ?? [] as choice (choice.id)}
            <button
              type="button"
              class="choice"
              class:selected={choice.selected}
              onclick={() => activateChoice(choice)}
              onkeydown={handleChoiceEscape}
              data-testid={choice.testid}
              aria-label={choice.ariaLabel}
              aria-pressed={choice.selected ?? false}
              tabindex={choicesOpen ? 0 : -1}
              disabled={!choicesOpen}
              aria-hidden={!choicesOpen}
            >{choice.label}</button>
          {/each}
        </div>
      {/if}
    </div>
  {/each}
</div>
<button
  bind:this={fabElement}
  type="button"
  class="fab"
  class:open={active}
  onclick={onFab}
  aria-label={fabAria}
  aria-expanded={open}
>❯</button>

<style>
  .fab {
    position: absolute; right: 12px; bottom: calc(14px + env(safe-area-inset-bottom)); z-index: 40;
    width: 52px; height: 52px;
    background: var(--hud); color: var(--agent);
    border: 1px solid var(--agent);
    font: 700 20px var(--font-mono);
    display: flex; align-items: center; justify-content: center;
    transition: transform .12s;
    touch-action: manipulation;
  }
  .fab.open { transform: rotate(45deg); color: var(--hud-fg); border-color: var(--hud-line); }

  .slots {
    position: absolute; right: 12px; bottom: calc(76px + env(safe-area-inset-bottom)); z-index: 39;
    display: flex; flex-direction: column; align-items: flex-end; gap: 8px;
    max-width: calc(100vw - 24px);
    /* long action lists must scroll, not walk off the top (issue #1).
       Closed: overflow hidden so a fractional max-height vs content stack
       never paints a hairline scrollbar on every terminal (D7). Open: auto
       only when the list is actually taller than the budget. */
    max-height: calc(100dvh - 150px - env(safe-area-inset-top) - env(safe-area-inset-bottom));
    overflow-x: hidden;
    overflow-y: hidden;
    overscroll-behavior: contain;
    pointer-events: none;
  }
  .slots.open {
    pointer-events: auto;
    overflow-y: auto;
    /* ~half-line slack: font metrics / subpixel layout routinely leave the
       content 8–12px over an exact max-height, which is not a real need to
       scroll — it only manufactures a scrollbar. */
    max-height: calc(100dvh - 138px - env(safe-area-inset-top) - env(safe-area-inset-bottom));
  }
  .slot-row {
    max-width: 100%;
    display: flex;
    flex-direction: row-reverse;
    align-items: center;
    gap: 8px;
    flex: 0 0 auto;
  }
  .slot {
    min-height: 46px; padding: 0 16px;
    background: var(--hud); color: var(--hud-fg);
    border: 1px solid var(--hud-line);
    font: 700 13px var(--font-thai);
    display: flex; align-items: center; gap: 8px;
    opacity: 0; transform: translateY(14px) scale(.92);
    pointer-events: none;
    transition: opacity .10s ease, transform .12s cubic-bezier(.25,1,.5,1);
    touch-action: manipulation;
  }
  .slot small { font: 700 9px var(--font-mono); opacity: .6; letter-spacing: .05em; }
  .disclosure {
    width: 8px;
    flex: 0 0 8px;
    font: 700 17px/1 var(--font-mono);
    color: var(--agent);
    text-align: center;
  }
  .disclosure::before { content: '‹'; }
  .disclosure.open::before { content: '›'; }
  .disclosure.open { color: var(--hud-fg); }
  .slot.prim { border-color: var(--agent); color: var(--agent); }
  .choices {
    display: flex;
    align-items: center;
    gap: 6px;
    max-width: 0;
    opacity: 0;
    overflow: hidden;
    pointer-events: none;
    transform: translateX(10px) scale(.96);
    transition: max-width .14s cubic-bezier(.25,1,.5,1), opacity .10s ease, transform .12s cubic-bezier(.25,1,.5,1);
  }
  .choices.open {
    max-width: min(220px, calc(100vw - 104px));
    opacity: 1;
    pointer-events: auto;
    transform: none;
  }
  .choice {
    min-width: 44px;
    min-height: 46px;
    padding: 0 8px;
    flex: 0 0 auto;
    background: var(--hud);
    color: var(--hud-fg);
    border: 1px solid var(--hud-line);
    font: 700 10px var(--font-mono);
    letter-spacing: .04em;
    touch-action: manipulation;
  }
  .choice.selected { border-color: var(--agent); color: var(--agent); }
  /* No per-slot transition-delay: profiling showed staggered delays were the
     ENTIRE perceived button lag — slots start animating on the tap's frame. */
  .slots.open .slot { opacity: 1; transform: none; pointer-events: auto; }
</style>
