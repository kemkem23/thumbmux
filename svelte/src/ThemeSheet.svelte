<script lang="ts">
  /** ThemeSheet — dark/light toggle + background swatches + custom color.
   * The host owns the actual theme store; this is pure presentation. */
  let {
    open = $bindable(false),
    title,
    mode,
    onToggleMode,
    swatchLabel,
    swatches,
    currentBg,
    defaultBg,
    onPick,
    onReset,
    customBg = $bindable('#000000'),
    labels = { dark: '☾ Dark', light: '☀ Light', def: 'Default', custom: 'Pick', close: 'Close' },
  }: {
    open?: boolean;
    title: string;
    mode: 'dark' | 'light';
    onToggleMode: (mode: 'dark' | 'light') => void;
    swatchLabel: string;
    swatches: string[];
    currentBg: string;
    defaultBg: string;
    onPick: (hex: string) => void;
    onReset: () => void;
    customBg?: string;
    labels?: { dark: string; light: string; def: string; custom: string; close: string };
  } = $props();
</script>

<div class="sheet theme-sheet" class:open>
  <div class="modes">
    <span class="sheet-title" lang="th">{title}</span>
    <button class="close" onclick={() => (open = false)} aria-label={labels.close}>✕</button>
  </div>
  <div class="theme-row">
    <button class="mode-btn" class:on={mode === 'dark'} onclick={() => onToggleMode('dark')} lang="th">{labels.dark}</button>
    <button class="mode-btn" class:on={mode === 'light'} onclick={() => onToggleMode('light')} lang="th">{labels.light}</button>
  </div>
  <div class="swatch-label" lang="th">{swatchLabel}</div>
  <div class="swatches">
    <button
      class="swatch"
      class:on={currentBg.toLowerCase() === defaultBg.toLowerCase()}
      style:background={defaultBg}
      onclick={onReset}
      aria-label={labels.def}
    ><span lang="th">{labels.def}</span></button>
    {#each swatches as c (c)}
      <button
        class="swatch"
        class:on={currentBg.toLowerCase() === c.toLowerCase()}
        style:background={c}
        onclick={() => onPick(c)}
        aria-label={c}
      ></button>
    {/each}
    <label class="swatch custom" style:background={customBg}>
      <input type="color" bind:value={customBg} onchange={() => onPick(customBg)} />
      <span lang="th">{labels.custom}</span>
    </label>
  </div>
</div>

<style>
  .sheet {
    position: absolute; left: 0; right: 0; bottom: 0; z-index: 55;
    background: var(--hud); border-top: 1px solid var(--hud-line);
    padding: 10px 10px calc(10px + env(safe-area-inset-bottom));
    transform: translateY(105%);
    transition: transform .28s cubic-bezier(.25,1,.5,1);
    font-family: var(--font-mono);
  }
  .sheet.open { transform: translateY(0); }
  .modes { display: flex; align-items: center; gap: 0; margin-bottom: 8px; }
  .sheet-title { font: 700 12px var(--font-thai); color: var(--hud-fg); letter-spacing: .04em; }
  .mode-btn {
    min-height: 44px; padding: 0 14px;
    border: 1px solid var(--hud-line); background: transparent; color: var(--hud-fg);
    opacity: .65; font: 700 10px var(--font-mono); letter-spacing: .06em; touch-action: manipulation;
  }
  .mode-btn + .mode-btn { border-left: none; }
  .mode-btn.on { background: var(--agent); color: var(--tstage); border-color: var(--agent); opacity: 1; }
  .close { margin-left: auto; min-width: 44px; min-height: 44px; background: none; border: 1px solid var(--hud-line); color: var(--hud-fg); font: 700 13px var(--font-mono); touch-action: manipulation; }
  .theme-row { display: flex; margin-bottom: 10px; }
  .swatch-label { font: 600 10.5px var(--font-thai); color: var(--hud-fg); opacity: .7; margin-bottom: 6px; }
  .swatches { display: flex; flex-wrap: wrap; gap: 8px; }
  .swatch {
    width: 52px; height: 44px; border: 1px solid var(--hud-line);
    display: flex; align-items: center; justify-content: center;
    font: 700 9px var(--font-thai); color: rgba(255,255,255,.85);
    text-shadow: 0 0 3px rgba(0,0,0,.6);
    touch-action: manipulation; position: relative; cursor: pointer;
  }
  .swatch.on { border: 2px solid var(--agent); }
  .swatch.custom input[type="color"] {
    position: absolute; inset: 0; opacity: 0; width: 100%; height: 100%; cursor: pointer;
  }
</style>
