<script module lang="ts">
  export type DesktopPasteInfo = {
    text: string;
    lineCount: number;
    byteLength: number;
    reason: 'multiline' | 'large' | 'multiline-large';
  };

  export type DesktopKeysProps = {
    enabled?: boolean;
    focused?: boolean;
    ariaLabel?: string;
    pasteWarningLines?: number;
    pasteWarningBytes?: number;
    /** Alt/Option+printable → ESC prefix (PC style). Default: auto — true
     * everywhere except macOS-like platforms, where Option composes characters
     * that should be sent verbatim. */
    altIsMeta?: boolean;
    onKeys: (data: string) => void;
    onFocusChange?: (focused: boolean) => void;
    confirmPaste?: (info: DesktopPasteInfo) => boolean | Promise<boolean>;
    children?: import('svelte').Snippet;
  };
</script>

<script lang="ts">
  import type { Snippet } from 'svelte';
  import { bracketedPaste, keyboardEventToSequence, pasteInfo as corePasteInfo, type PasteInfo } from '../core/index.js';

  type ChildSnippet = (() => unknown) | Snippet;
  type RuntimeProps = Omit<DesktopKeysProps, 'children'> & { children?: ChildSnippet };

  let {
    enabled = true,
    focused = $bindable(false),
    ariaLabel = 'Terminal input',
    pasteWarningLines = 6,
    pasteWarningBytes = 4096,
    altIsMeta = undefined,
    onKeys,
    onFocusChange = undefined,
    confirmPaste = undefined,
    children = undefined,
  }: RuntimeProps = $props();

  let rootEl = $state<HTMLDivElement | null>(null);
  let nativeFocused = $state(false);
  let composing = $state(false);
  // A6-4: async paste confirm can outlive this instance (unmount or {#key}
  // remount when the host session changes). Bump on destroy so a late accept
  // never calls onKeys into a pane the user has left.
  let pasteGeneration = 0;
  let destroyed = false;

  // macOS Option is a character-composition modifier (third-level shift), not
  // Meta — Option-composed printables must be sent verbatim there.
  const macLikePlatform =
    typeof navigator !== 'undefined' &&
    /mac|iphone|ipad|ipod/i.test(navigator.platform || (navigator as { userAgentData?: { platform?: string } }).userAgentData?.platform || '');
  const effectiveAltIsMeta = () => altIsMeta ?? !macLikePlatform;

  function nodeInsideRoot(node: Node | null): boolean {
    return !!(node && rootEl && (node === rootEl || rootEl.contains(node)));
  }

  /**
   * Real text entry owns its keystrokes. A link or button rendered *inside*
   * the terminal (OSC-8 / detected URLs from ansi-html, rare in-pane buttons)
   * must not — those are part of the pane surface, not a form.
   */
  function isRealTextEntry(target: EventTarget | null): boolean {
    if (!(target instanceof Element)) return false;
    return !!target.closest('input,textarea,select,[contenteditable="true"]');
  }

  /**
   * True when this wrapper should route keys: either the root itself is
   * focused, or focus landed on a non-editable descendant inside the pane
   * (e.g. an OSC-8 <a>). Real text entry inside the wrapper is excluded.
   *
   * Encoded behaviour (pinned by FS4 tests): reclaim focus onto the wrapper
   * and still forward the keystroke — do not silently mute the terminal.
   */
  function terminalOwnsKeyboard(target: EventTarget | null): boolean {
    if (!enabled) return false;
    if (isRealTextEntry(target)) return false;
    if (nativeFocused) return true;
    // Focus stole onto a non-editable descendant — reclaim so the wrapper
    // remains the focus owner and subsequent keydowns hit a stable target.
    const ae = typeof document !== 'undefined' ? document.activeElement : null;
    if (!nodeInsideRoot(ae) || isRealTextEntry(ae)) return false;
    rootEl?.focus({ preventScroll: true });
    // focus() should fire handleFocus; if the host/DOM suppresses it, keep
    // routing state consistent with the reclaim we just performed.
    if (!nativeFocused) {
      nativeFocused = true;
      focused = true;
      onFocusChange?.(true);
    }
    return true;
  }

  function terminalSelectionActive(): boolean {
    const sel = typeof window !== 'undefined' ? window.getSelection?.() : null;
    return !!(
      sel &&
      !sel.isCollapsed &&
      (nodeInsideRoot(sel.anchorNode) || nodeInsideRoot(sel.focusNode))
    );
  }

  function collapseTerminalSelection() {
    if (!terminalSelectionActive()) return;
    const sel = window.getSelection?.();
    if (!sel) return;
    try {
      sel.collapseToEnd();
    } catch {
      sel.removeAllRanges();
    }
  }

  /**
   * Chord identity for copy/paste policy. Prefer physical KeyA–KeyZ from
   * `e.code` (same rule core/src/keys.ts uses in ctrlLetterFromCode) so a Thai
   * Kedmanee Ctrl+C arrives as KeyC even when e.key is 'แ'. Fall back to e.key
   * when code is absent or not a letter key. No mapping table — one code rule.
   */
  function keyName(e: KeyboardEvent): string {
    const code = e.code;
    if (code && code.length === 4 && code.startsWith('Key')) {
      const letter = code.charAt(3);
      if (letter >= 'A' && letter <= 'Z') return letter.toLowerCase();
    }
    return e.key.toLowerCase();
  }

  function isCopyShortcut(e: KeyboardEvent): boolean {
    return keyName(e) === 'c' && (e.ctrlKey || e.metaKey);
  }

  function isPasteShortcut(e: KeyboardEvent): boolean {
    return keyName(e) === 'v' && (e.ctrlKey || e.metaKey);
  }

  function isShiftInsert(e: KeyboardEvent): boolean {
    return e.key === 'Insert' && e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey;
  }

  // Threshold logic lives in thumbmux/core (pure + unit-tested); this is a
  // thin bind of the component's warning props.
  function pasteInfo(text: string): DesktopPasteInfo | null {
    const info: PasteInfo | null = corePasteInfo(text, {
      warnLines: pasteWarningLines,
      warnBytes: pasteWarningBytes,
    });
    return info;
  }

  function defaultConfirmPaste(info: DesktopPasteInfo): boolean {
    if (typeof window === 'undefined' || !window.confirm) return true;
    return window.confirm(`Paste ${info.lineCount} lines into the terminal?`);
  }

  function isPromiseLike<T>(value: T | Promise<T>): value is Promise<T> {
    return !!(
      value &&
      (typeof value === 'object' || typeof value === 'function') &&
      typeof (value as { then?: unknown }).then === 'function'
    );
  }

  function clipboardHasFiles(data: DataTransfer | null): boolean {
    if (!data) return false;
    if (data.files && data.files.length > 0) return true;
    return Array.from(data.items ?? []).some((item) => item.kind === 'file');
  }

  async function confirmTextPaste(text: string): Promise<boolean> {
    const info = pasteInfo(text);
    if (!info) return true;

    let decision: boolean | Promise<boolean>;
    try {
      decision = confirmPaste ? confirmPaste(info) : defaultConfirmPaste(info);
    } catch {
      return false;
    }

    if (isPromiseLike(decision)) {
      try {
        return await decision;
      } catch {
        return false;
      }
    }

    return decision;
  }

  async function sendPasteText(text: string, event?: ClipboardEvent | KeyboardEvent, alreadyConsumed = false) {
    if (!text || !enabled || !nativeFocused || destroyed) return;
    const gen = pasteGeneration;
    const accepted = await confirmTextPaste(text);
    // A host confirm dialog steals wrapper focus while we await, so an
    // accepted paste must not be gated on focus again (§4: send exactly once).
    // A6-4: drop if this instance was destroyed or remounted while we waited.
    if (!accepted || !enabled || destroyed || gen !== pasteGeneration) return;
    if (event && !alreadyConsumed) {
      event.preventDefault();
      event.stopPropagation();
    }
    collapseTerminalSelection();
    onKeys(bracketedPaste(text));
  }

  function handleKeydown(e: KeyboardEvent) {
    if (!enabled || composing || e.isComposing) return;
    if (!terminalOwnsKeyboard(e.target)) return;

    if (isCopyShortcut(e)) {
      // Ctrl+Shift+C = browser convention (devtools / terminal-style copy) —
      // never SIGINT. Plain Ctrl+C only reaches the pane without a selection.
      if (e.metaKey || e.shiftKey || terminalSelectionActive()) return;
    }

    // Ctrl(+Shift)+V / Cmd+V: browser paste pipeline owns these.
    if (isPasteShortcut(e)) return;

    if (isShiftInsert(e)) {
      const readText = navigator.clipboard?.readText;
      if (!readText) return;
      e.preventDefault();
      e.stopPropagation();
      void (async () => {
        let text = '';
        try {
          text = await navigator.clipboard.readText();
        } catch {
          return;
        }
        await sendPasteText(text, e, true);
      })();
      return;
    }

    const sequence = keyboardEventToSequence(e, { altIsMeta: effectiveAltIsMeta() });
    if (sequence === null) return;
    collapseTerminalSelection();
    e.preventDefault();
    e.stopPropagation();
    onKeys(sequence);
  }

  function handlePaste(e: ClipboardEvent) {
    if (!enabled || composing || !terminalOwnsKeyboard(e.target)) return;
    const data = e.clipboardData;
    if (!data || clipboardHasFiles(data)) return;
    const text = data.getData('text/plain') || data.getData('text');
    if (!text) return;
    // Consume synchronously — a threshold confirm may await, and preventDefault
    // after the dispatch turn is a no-op. Consumed-then-declined is sanctioned
    // by the spec (§4).
    e.preventDefault();
    e.stopPropagation();
    void sendPasteText(text, e, true);
  }

  function handlePointerDown(e: PointerEvent) {
    if (!enabled || e.button !== 0 || isRealTextEntry(e.target)) return;
    // Let real <a> keep the click (navigation / open). Keys reclaim focus later
    // via terminalOwnsKeyboard — focusing the root on pointerdown can cancel
    // the link activation in some browsers.
    if (e.target instanceof Element && e.target.closest('a')) return;
    rootEl?.focus({ preventScroll: true });
  }

  function handleFocus() {
    if (nativeFocused) return;
    nativeFocused = true;
    focused = true;
    onFocusChange?.(true);
  }

  function handleBlur() {
    if (!nativeFocused && !focused) return;
    nativeFocused = false;
    composing = false;
    focused = false;
    onFocusChange?.(false);
  }

  function handleCompositionStart(e: CompositionEvent) {
    if (!enabled || !nativeFocused || isRealTextEntry(e.target)) return;
    composing = true;
  }

  function handleCompositionEnd(e: CompositionEvent) {
    const data = e.data;
    composing = false;
    if (!enabled || !nativeFocused || isRealTextEntry(e.target) || !data) return;
    onKeys(data);
  }

  function handleCompositionCancel() {
    composing = false;
  }

  // `oncompositioncancel` is a real DOM event but is absent from Svelte's
  // HTML attribute typings, so a template attr fails svelte-check. Bind with
  // addEventListener so composition cancel still clears `composing` the same
  // way compositionend does — do not drop the handler to silence the type.
  $effect(() => {
    const el = rootEl;
    if (!el) return;
    el.addEventListener('compositioncancel', handleCompositionCancel);
    return () => {
      el.removeEventListener('compositioncancel', handleCompositionCancel);
    };
  });

  $effect(() => {
    if (!rootEl || typeof document === 'undefined') return;
    if (!enabled) {
      composing = false;
      if (document.activeElement === rootEl) {
        rootEl.blur();
      } else if (focused || nativeFocused) {
        nativeFocused = false;
        focused = false;
        onFocusChange?.(false);
      }
      return;
    }
    if (focused && document.activeElement !== rootEl) {
      rootEl.focus({ preventScroll: true });
    } else if (!focused && document.activeElement === rootEl) {
      rootEl.blur();
    }
  });

  $effect(() => {
    destroyed = false;
    return () => {
      destroyed = true;
      pasteGeneration += 1;
    };
  });
</script>

<div
  bind:this={rootEl}
  class="desktop-keys"
  tabindex={enabled ? 0 : undefined}
  role="group"
  aria-label={ariaLabel}
  onpointerdown={handlePointerDown}
  onfocus={handleFocus}
  onblur={handleBlur}
  onkeydown={handleKeydown}
  onpaste={handlePaste}
  oncompositionstart={handleCompositionStart}
  oncompositionend={handleCompositionEnd}
>
  {#if children}
    {@const childSnippet = children as Snippet}
    {@render childSnippet()}
  {/if}
</div>

<style>
  .desktop-keys {
    position: relative;
    width: 100%;
    height: 100%;
    min-width: 0;
    min-height: 0;
    outline: none;
  }

  .desktop-keys:focus-visible {
    outline: 1px solid currentColor;
    outline-offset: -1px;
  }
</style>
