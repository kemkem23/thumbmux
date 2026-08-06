<script module lang="ts">
  export type ComposerLabels = {
    compose: string;
    direct: string;
    hintCompose: string;
    hintDirect: string;
    placeholder: string;
    send: string;
    close: string;
    directAria: string;
  };
</script>

<script lang="ts">
  /**
   * ComposerDock — the mobile input sheet. COMPOSE (batch + SEND) / DIRECT
   * (invisible ghost input: the OS keyboard IS the input, every key relayed).
   *
   * Docking contract: the sheet never overlays the terminal. It exposes three
   * bindable insets the host applies to its viewport CSS:
   *   dockInset  height ABOVE the safe area (hosts whose closed-state bottom
   *              is env(safe-area-inset-bottom) — also the exact amount a
   *              viewer must add back to keep its pane geometry stable)
   *   dockFull   full sheet height (hosts whose closed-state bottom is 0)
   *   kbInset    OS keyboard height over the layout viewport (VisualViewport)
   *
   * iOS gesture rules (learned on device 2026-07-02):
   * - focus() raises the keyboard ONLY inside the tap's synchronous call
   *   stack — deferred focus sets activeElement with the keyboard down.
   *   openDock()/mode switches must be called from the tap handler.
   * - The ghost input stays mounted in every mode so it can be focused
   *   synchronously; opacity (never display:none) keeps it focusable.
   */
  import { flushSync } from 'svelte';
  import { keyboardEventToSequence } from '@thumbmux/core';

  let {
    open = $bindable(false),
    mode = $bindable<'compose' | 'direct'>('compose'),
    text = $bindable(''),
    dockInset = $bindable(0),
    dockFull = $bindable(0),
    kbInset = $bindable(0),
    onSend,
    onDirectText,
    onDirectKey,
    onPasteFiles,
    labels = {
      compose: 'COMPOSE',
      direct: 'DIRECT',
      hintCompose: 'Draft first, then hit SEND',
      hintDirect: 'Keyboard goes straight to the terminal',
      placeholder: 'Type a prompt… (the box grows with your text)',
      send: 'SEND',
      close: 'Close',
      directAria: 'Send keys directly to the terminal',
    } as ComposerLabels,
  }: {
    open?: boolean;
    mode?: 'compose' | 'direct';
    text?: string;
    dockInset?: number;
    dockFull?: number;
    kbInset?: number;
    onSend: (text: string) => void;
    onDirectText: (data: string) => void;
    onDirectKey: (seq: string) => void;
    /** clipboard paste carrying FILES (screenshots, photos) — wire it to
     * UploadAction.uploadFiles() for paste-a-picture → upload → prefill.
     * Text pastes are untouched. */
    onPasteFiles?: (files: File[]) => void;
    labels?: ComposerLabels;
  } = $props();

  let sheetH = $state(0);
  let safeBottom = $state(0);

  function handlePaste(e: ClipboardEvent) {
    const files = Array.from(e.clipboardData?.files ?? []);
    if (files.length === 0 || !onPasteFiles) return; // plain text paste — default behavior
    e.preventDefault();
    onPasteFiles(files);
  }
  let directInputEl = $state<HTMLInputElement | null>(null);
  let composeEl = $state<HTMLTextAreaElement | null>(null);

  // Composer dock: while open the host's terminal viewport is inset by the
  // sheet's LIVE height. Two baselines because hosts differ on where their
  // closed-state bottom sits (see header comment).
  $effect(() => { dockInset = open ? Math.max(0, sheetH - safeBottom) : 0; });
  $effect(() => { dockFull = open ? sheetH : 0; });

  function updateKbInset() {
    const vv = window.visualViewport;
    if (!vv) return;
    // Pinch-zoom also shrinks vv.height — that's not a keyboard.
    if (vv.scale && Math.abs(vv.scale - 1) > 0.01) { kbInset = 0; return; }
    // offsetTop subtracted: when the browser pans to reveal the focused
    // field, that pan already exposes part of the covered strip.
    kbInset = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
  }

  /** env() is CSS-only — read the real safe-area pixel value via a probe. */
  function measureSafeBottom(): number {
    if (typeof document === 'undefined') return 0;
    const el = document.createElement('div');
    el.style.cssText =
      'position:fixed;left:0;bottom:0;width:1px;height:env(safe-area-inset-bottom,0px);pointer-events:none;visibility:hidden;';
    document.body.appendChild(el);
    const h = el.getBoundingClientRect().height;
    el.remove();
    return h;
  }

  // A6-5: measure safe-area whenever the sheet is open — covers bindable
  // open=true (no openDock() call) and orientation changes while open.
  $effect(() => {
    if (!open || typeof window === 'undefined') return;
    safeBottom = measureSafeBottom();
    const remeasure = () => { safeBottom = measureSafeBottom(); };
    window.addEventListener('resize', remeasure);
    window.visualViewport?.addEventListener('resize', remeasure);
    return () => {
      window.removeEventListener('resize', remeasure);
      window.visualViewport?.removeEventListener('resize', remeasure);
    };
  });

  /** Open from a user gesture (tap handler call stack — see iOS rules).
   *
   * `opts.focus` (TM-02): when true, flush then focus the input for the
   * current mode before return so a host can raise the keyboard in the same
   * touchend stack. Omitted / false keeps v0.10.1 quiet-COMPOSE behaviour.
   * DIRECT still focuses by design (documented contract). */
  export function openDock(opts?: { focus?: boolean }) {
    // Re-read per open — the safe area changes with orientation (34px
    // portrait vs 21px landscape on Face-ID iPhones).
    safeBottom = measureSafeBottom();
    // TM-01: flush open before focus — without this the sheet is still
    // visibility:hidden and focus on the ghost input is a no-op in WebKit
    // (same gesture-stack constraint switchMode already documents).
    flushSync(() => { open = true; });
    // COMPOSE opens quiet unless the host asked for focus; DIRECT has no
    // visible field so it always summons the keyboard right here.
    const shouldFocus = mode === 'direct' || opts?.focus === true;
    if (shouldFocus) {
      if (mode === 'direct') directInputEl?.focus({ preventScroll: true });
      else composeEl?.focus({ preventScroll: true });
    }
  }

  /** Open showing the COMPOSE field regardless of the current mode — for
   * programmatic prefills (upload messages): in DIRECT there is no visible
   * input, so a prefilled message would be invisible (fleet finding).
   * Pass `{ focus: true }` to focus the textarea inside the same gesture. */
  export function openCompose(opts?: { focus?: boolean }) {
    flushSync(() => { mode = 'compose'; });
    openDock(opts);
  }

  export function closeDock() {
    open = false;
    // The ghost input is invisible — left focused it would keep the OS
    // keyboard up over a closed sheet.
    directInputEl?.blur();
    composeEl?.blur();
  }

  function switchMode(next: 'compose' | 'direct') {
    // flushSync so the compose textarea exists before the synchronous focus —
    // same gesture-stack constraint as openDock.
    flushSync(() => { mode = next; });
    if (next === 'direct') directInputEl?.focus({ preventScroll: true });
    else composeEl?.focus({ preventScroll: true });
  }

  function sendCompose() {
    const v = text.trim();
    if (!v) return;
    onSend(v);
    text = '';
    if (composeEl) composeEl.style.height = 'auto';
    closeDock();
  }

  function autoGrow() {
    if (!composeEl) return;
    composeEl.style.height = 'auto';
    composeEl.style.height = `${Math.min(composeEl.scrollHeight, 142)}px`;
  }

  // Host-driven prefills (recent-prompt reuse, upload result) must grow the
  // textarea too, not only local typing.
  $effect(() => {
    text;
    if (composeEl) autoGrow();
  });

  function composeKeydown(e: KeyboardEvent) {
    // A6-2: IME candidate accept uses Enter while isComposing — must not SEND.
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendCompose();
    }
  }

  // DIRECT mode — every keystroke goes straight out. Text (incl. Thai IME)
  // arrives via input events; control keys via keydown.
  // A6-2: skip interim composition text and candidate-control keys.
  function directInput(e: Event) {
    if (e instanceof InputEvent && e.isComposing) return;
    const el = e.target as HTMLInputElement;
    if (el.value) {
      onDirectText(el.value);
      el.value = '';
    }
  }

  function directKeyName(e: KeyboardEvent): string {
    const code = e.code;
    if (code && code.length === 4 && code.startsWith('Key')) {
      const letter = code.charAt(3);
      if (letter >= 'A' && letter <= 'Z') return letter.toLowerCase();
    }
    return e.key.toLowerCase();
  }

  function directKeydown(e: KeyboardEvent) {
    if (e.isComposing || e.keyCode === 229) return;
    // The ghost input owns browser text entry and paste. Let printable text
    // become an input event (including Thai/IME), and preserve the same
    // Ctrl(+Shift)+V / Cmd+V browser paste policy as DesktopKeys.
    if (
      (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) ||
      (directKeyName(e) === 'v' && (e.ctrlKey || e.metaKey))
    ) return;

    const seq = keyboardEventToSequence(e);
    if (seq === null) return;
    e.preventDefault();
    onDirectKey(seq);
  }

  $effect(() => {
    window.visualViewport?.addEventListener('resize', updateKbInset);
    window.visualViewport?.addEventListener('scroll', updateKbInset);
    return () => {
      window.visualViewport?.removeEventListener('resize', updateKbInset);
      window.visualViewport?.removeEventListener('scroll', updateKbInset);
    };
  });
</script>

<div class="sheet dock" class:open class:kb={kbInset > 0} bind:offsetHeight={sheetH} data-testid="input-sheet" style:--kb-inset={kbInset > 0 ? `${kbInset}px` : null}>
  <div class="modes">
    <button class="mode-btn" class:on={mode === 'compose'} onclick={() => switchMode('compose')}>{labels.compose}</button>
    <button class="mode-btn" class:on={mode === 'direct'} onclick={() => switchMode('direct')}>{labels.direct}</button>
    <span class="mode-hint" lang="th">
      {mode === 'direct' ? labels.hintDirect : labels.hintCompose}
    </span>
    <button class="close" onclick={closeDock} aria-label={labels.close}>✕</button>
  </div>
  <!-- DIRECT's input: no visible field — the OS keyboard IS the input. This
       invisible input only holds focus and relays keys. ALWAYS mounted (not
       inside the mode {#if}) so a DIRECT tap can focus it synchronously. -->
  <input
    bind:this={directInputEl}
    class="ghost-key"
    data-testid="ghost-key"
    oninput={directInput}
    onkeydown={directKeydown}
    onpaste={handlePaste}
    aria-label={labels.directAria}
    autocomplete="off"
    autocapitalize="off"
    spellcheck="false"
  />
  {#if mode === 'compose'}
    <div class="crow">
      <textarea
        bind:this={composeEl}
        bind:value={text}
        oninput={autoGrow}
        onkeydown={composeKeydown}
        onpaste={handlePaste}
        rows="1"
        placeholder={labels.placeholder}
        lang="th"
      ></textarea>
      <button class="snd" onclick={sendCompose}>{labels.send}</button>
    </div>
  {/if}
</div>

<style>
  .sheet {
    position: absolute; left: 0; right: 0; bottom: 0; z-index: 50;
    background: var(--hud); border-top: 1px solid var(--hud-line);
    padding: 10px 10px calc(10px + env(safe-area-inset-bottom));
    transform: translateY(105%);
    /* closed = INVISIBLE, not merely translated: host insets can shift the
       stage and drag a "closed" sheet's rect back into the viewport (fleet
       finding). Delayed visibility keeps the slide-out animation intact. */
    visibility: hidden;
    transition: transform .28s cubic-bezier(.25,1,.5,1), visibility 0s .28s;
    font-family: var(--font-mono);
  }
  .sheet.open { transform: translateY(0); visibility: visible; transition: transform .28s cubic-bezier(.25,1,.5,1); }
  /* ONLY this sheet rides the OS keyboard (VisualViewport-tracked). Closed
     sibling sheets must stay below the stage edge where overflow clips them —
     lifting them parks them visibly behind iOS's translucent keyboard. */
  .sheet.dock { bottom: var(--kb-inset, 0px); }
  /* Keyboard up → it covers the home-indicator zone; keep the safe-area
     padding and you get a 34px dead strip between the field and the keys. */
  .sheet.kb { padding-bottom: 10px; }
  .modes { display: flex; align-items: center; gap: 0; margin-bottom: 8px; }
  .mode-btn {
    min-height: 44px; padding: 0 14px;
    border: 1px solid var(--hud-line); background: transparent; color: var(--hud-fg);
    opacity: .65; font: 700 10px var(--font-mono); letter-spacing: .06em; touch-action: manipulation;
  }
  .mode-btn + .mode-btn { border-left: none; }
  .mode-btn.on { background: var(--agent); color: var(--tstage); border-color: var(--agent); opacity: 1; }
  .mode-hint { margin-left: 10px; font: 600 10.5px var(--font-thai); color: var(--hud-fg); opacity: .65; line-height: 1.5; }
  .close { margin-left: auto; min-width: 44px; min-height: 44px; background: none; border: 1px solid var(--hud-line); color: var(--hud-fg); font: 700 13px var(--font-mono); touch-action: manipulation; }
  .crow { display: flex; align-items: flex-end; }
  .crow textarea {
    flex: 1; min-height: 46px; max-height: 142px;
    border: 1px solid var(--hud-line); background: rgba(0,0,0,.25);
    color: var(--hud-fg); font: 400 16px var(--font-thai); line-height: 1.55;
    padding: 11px 10px; resize: none; overflow-y: auto;
  }
  .crow textarea::placeholder { color: var(--hud-fg); opacity: .4; }
  .snd {
    min-width: 64px; min-height: 46px; border: 1px solid var(--agent); border-left: none;
    background: var(--agent); color: var(--tstage);
    font: 700 11px var(--font-mono); letter-spacing: .05em; touch-action: manipulation;
  }
  /* DIRECT's focus target: invisible but focusable (opacity — never
     display:none, iOS refuses focus). 16px font blocks Safari's zoom-on-focus. */
  .ghost-key {
    position: absolute; left: 10px; bottom: 6px;
    width: 1px; height: 1px;
    opacity: 0; border: none; padding: 0; margin: 0;
    background: transparent; color: transparent; caret-color: transparent;
    font-size: 16px;
    pointer-events: none;
  }
</style>
