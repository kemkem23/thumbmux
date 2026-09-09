<script lang="ts">
  /** ThemeSourceChoice (B03) — the two-state picker for "keep the session's
   * own colours" vs "tint the screen after the agent".
   *
   * It renders the pair of buttons and the selected state; it does NOT compute
   * a palette, does not know what an agent or a provider is, and never reads
   * or writes a preference. `enabled` is fully controlled by the host: the
   * component does not move its own selection on click, it only reports the
   * value the host would be switching to. That keeps persistence, the `kx-*`
   * storage keys and the per-mode policy entirely on the host side.
   *
   * `onChange` fires only when the value actually changes — pressing the
   * already-selected button is a no-op, so a host that persists on every
   * callback does not write the same value back on a stray tap. */

  let {
    enabled = false,
    offLabel,
    onLabel,
    onChange,
    disabled = false,
    hint = undefined,
    testid = 'theme-source-choice',
    offTestid = 'agent-theme-off',
    onTestid = 'agent-theme-on',
    hintTestid = 'theme-source-hint',
    lang = undefined,
    extraClass = undefined,
  }: {
    /** current value, owned by the host */
    enabled?: boolean;
    /** label for the `false` side (host's wording and language) */
    offLabel: string;
    /** label for the `true` side */
    onLabel: string;
    /** called with the new value only when it differs from `enabled` */
    onChange: (next: boolean) => void;
    disabled?: boolean;
    /** explanation for the state currently shown — the host picks which text,
     * so provider names and policy prose stay out of the package */
    hint?: string;
    testid?: string;
    offTestid?: string;
    onTestid?: string;
    hintTestid?: string;
    /** BCP-47 tag applied to the labels/hint so host typography rules apply */
    lang?: string;
    extraClass?: string;
  } = $props();

  function choose(next: boolean): void {
    if (disabled) return;
    if (next === enabled) return;
    onChange(next);
  }
</script>

<div class="theme-source {extraClass ?? ''}" data-testid={testid}>
  <div class="choice-row" role="group">
    <button
      type="button"
      class="choice"
      class:on={!enabled}
      data-testid={offTestid}
      aria-pressed={!enabled}
      {disabled}
      {lang}
      onclick={() => choose(false)}>{offLabel}</button>
    <button
      type="button"
      class="choice"
      class:on={enabled}
      data-testid={onTestid}
      aria-pressed={enabled}
      {disabled}
      {lang}
      onclick={() => choose(true)}>{onLabel}</button>
  </div>
  {#if hint}
    <div class="choice-hint" data-testid={hintTestid} {lang}>{hint}</div>
  {/if}
</div>

<style>
  .theme-source {
    display: block;
    min-width: 0;
  }
  .choice-row {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
  }
  .choice {
    flex: 1 1 auto;
    min-width: 64px;
    min-height: 44px;
    padding: 0 10px;
    border: 1px solid var(--hud-line);
    background: transparent;
    color: var(--hud-fg);
    font: 700 11px var(--font-thai, var(--font-mono));
    letter-spacing: 0.03em;
    touch-action: manipulation;
  }
  .choice.on {
    background: var(--agent);
    color: var(--tstage);
    border-color: var(--agent);
  }
  .choice:disabled {
    opacity: 0.5;
  }
  .choice-hint {
    margin-top: 6px;
    font: 400 10.5px var(--font-thai, var(--font-mono));
    line-height: 1.6;
    color: var(--hud-fg);
    opacity: 0.6;
  }
</style>
