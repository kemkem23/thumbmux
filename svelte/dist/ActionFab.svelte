<script module lang="ts">
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
</script>

<script lang="ts">
  /** ActionFab — the single ❯ launcher + its floating action slots. Dumb by
   * design: the host decides what tapping the FAB means while other sheets
   * are open (close-them-first orchestration stays host-side). */
  let {
    open = $bindable(false),
    active = false,
    actions,
    onFab,
    fabAria = 'Actions',
  }: {
    open?: boolean;
    /** rotate the FAB into ✕ posture (any sheet open) */
    active?: boolean;
    actions: FabAction[];
    onFab: (e: MouseEvent) => void;
    fabAria?: string;
  } = $props();
</script>

<div class="slots" class:open aria-hidden={!open}>
  {#each actions as a (a.id)}
    <!-- A6-12: closed slots stay mounted for the open animation but must not
         be tab stops or activatable via Enter/Space while hidden. -->
    <button
      class="slot"
      class:prim={a.primary}
      lang="th"
      onclick={() => { if (open) a.onTap(); }}
      data-testid={a.testid}
      tabindex={open ? 0 : -1}
      disabled={!open}
      aria-hidden={!open}
    >
      {a.label}
      {#if a.tag}<small>{a.tag}</small>{/if}
    </button>
  {/each}
</div>
<button class="fab" class:open={active} onclick={onFab} aria-label={fabAria}>❯</button>

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
  .slot.prim { border-color: var(--agent); color: var(--agent); }
  /* No per-slot transition-delay: profiling showed staggered delays were the
     ENTIRE perceived button lag — slots start animating on the tap's frame. */
  .slots.open .slot { opacity: 1; transform: none; pointer-events: auto; }
</style>
