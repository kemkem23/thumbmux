<script lang="ts">
  /** ShortcutsSheet — manage the ShortcutBar chips: add, edit-in-place,
   * reorder, delete. Pure presentation; the host persists via onChange
   * (usually straight into its PreferencesAdapter). */
  import type { Shortcut } from '../core/index.js';

  let {
    open = $bindable(false),
    shortcuts = [],
    onChange,
    title = 'SHORTCUTS',
    labels = { add: '+ add', label: 'label', send: 'sends', close: 'Close', del: '✕', up: '↑', down: '↓' },
  }: {
    open?: boolean;
    shortcuts?: Shortcut[];
    onChange: (next: Shortcut[]) => void;
    title?: string;
    labels?: { add: string; label: string; send: string; close: string; del: string; up: string; down: string };
  } = $props();

  let newLabel = $state('');
  let newSend = $state('');
  // OS keyboard overlaps an absolute bottom sheet; ride the visualViewport
  // while open so the row being edited stays reachable (same trick as the
  // composer dock, self-contained here).
  let kbOffset = $state(0);
  $effect(() => {
    if (!open || typeof window === 'undefined' || !window.visualViewport) { kbOffset = 0; return; }
    const vv = window.visualViewport;
    const measure = () => { kbOffset = Math.max(0, window.innerHeight - vv.height - vv.offsetTop); };
    measure();
    vv.addEventListener('resize', measure);
    vv.addEventListener('scroll', measure);
    return () => { vv.removeEventListener('resize', measure); vv.removeEventListener('scroll', measure); kbOffset = 0; };
  });

  function commit(next: Shortcut[]) { onChange(next); }
  function add() {
    const label = newLabel.trim();
    const send = newSend.trim() || label;
    if (!label) return;
    commit([...shortcuts, { id: `sc-${Date.now().toString(36)}`, label, send }]);
    newLabel = ''; newSend = '';
  }
  function remove(id: string) { commit(shortcuts.filter((s) => s.id !== id)); }
  function move(id: string, dir: -1 | 1) {
    const i = shortcuts.findIndex((s) => s.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= shortcuts.length) return;
    const next = [...shortcuts];
    [next[i], next[j]] = [next[j], next[i]];
    commit(next);
  }
  function edit(id: string, field: 'label' | 'send', value: string) {
    commit(shortcuts.map((s) => (s.id === id ? { ...s, [field]: value } : s)));
  }
</script>

<div class="sheet sc-sheet" class:open style:bottom={kbOffset > 0 ? `${kbOffset}px` : null} data-testid="shortcuts-sheet">
  <div class="modes">
    <span class="sheet-title">{title}</span>
    <button class="close" onclick={() => (open = false)} aria-label={labels.close}>✕</button>
  </div>

  {#each shortcuts as s (s.id)}
    <div class="row" data-testid="shortcut-row">
      <input class="f label" value={s.label} onchange={(e) => edit(s.id, 'label', (e.target as HTMLInputElement).value)} aria-label={labels.label} />
      <input class="f send" value={s.send} onchange={(e) => edit(s.id, 'send', (e.target as HTMLInputElement).value)} aria-label={labels.send} />
      <button class="op" onclick={() => move(s.id, -1)} aria-label={labels.up}>{labels.up}</button>
      <button class="op" onclick={() => move(s.id, 1)} aria-label={labels.down}>{labels.down}</button>
      <button class="op del" onclick={() => remove(s.id)} aria-label={labels.del}>{labels.del}</button>
    </div>
  {/each}

  <div class="row addrow">
    <input class="f label" placeholder={labels.label} bind:value={newLabel} data-testid="shortcut-new-label" />
    <input class="f send" placeholder={labels.send} bind:value={newSend} data-testid="shortcut-new-send" />
    <button class="op add" onclick={add} data-testid="shortcut-add">{labels.add}</button>
  </div>
</div>

<style>
  .sheet {
    position: absolute; left: 0; right: 0; bottom: 0; z-index: 55; /* above the FAB (40) and dock (50), same tier as ThemeSheet */
    background: var(--hud); border-top: 1px solid var(--hud-line);
    padding: 10px 10px calc(10px + env(safe-area-inset-bottom));
    transform: translateY(105%);
    visibility: hidden;
    transition: transform .28s cubic-bezier(.25,1,.5,1), visibility 0s .28s;
    font-family: var(--font-mono);
    max-height: 60dvh; overflow-y: auto; overscroll-behavior: contain;
  }
  .sheet.open { transform: translateY(0); visibility: visible; transition: transform .28s cubic-bezier(.25,1,.5,1); }
  .modes { display: flex; align-items: center; margin-bottom: 8px; }
  .sheet-title { font: 700 12px var(--font-mono); color: var(--hud-fg); letter-spacing: .06em; }
  .close { margin-left: auto; min-width: 44px; min-height: 44px; background: none; border: 1px solid var(--hud-line); color: var(--hud-fg); font: 700 13px var(--font-mono); touch-action: manipulation; }
  .row { display: flex; gap: 6px; margin-bottom: 8px; align-items: stretch; }
  .f {
    min-height: 44px; padding: 0 10px; min-width: 0;
    background: var(--tbg); color: var(--tfg);
    border: 1px solid var(--hud-line);
    font: 600 16px var(--font-thai, var(--font-mono)); /* <16px makes iOS zoom on focus */
  }
  .f.label { flex: 2; }
  .f.send { flex: 3; }
  .op {
    min-width: 44px; min-height: 44px; flex: 0 0 auto;
    background: none; border: 1px solid var(--hud-line); color: var(--hud-fg);
    font: 700 13px var(--font-mono); touch-action: manipulation;
  }
  .op.del { color: var(--agent); border-color: var(--agent); }
  .op.add { border-color: var(--agent); color: var(--agent); padding: 0 14px; }
</style>
