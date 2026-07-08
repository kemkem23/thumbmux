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
    onKeys: (data: string) => void;
    onFocusChange?: (focused: boolean) => void;
    confirmPaste?: (info: DesktopPasteInfo) => boolean | Promise<boolean>;
    children?: import('svelte').Snippet;
  };
</script>

<script lang="ts">
  import type { Snippet } from 'svelte';
  import { bracketedPaste, keyboardEventToSequence } from '@thumbmux/core';

  type ChildSnippet = (() => unknown) | Snippet;
  type RuntimeProps = Omit<DesktopKeysProps, 'children'> & { children?: ChildSnippet };

  let {
    enabled = true,
    focused = $bindable(false),
    ariaLabel = 'Terminal input',
    pasteWarningLines = 6,
    pasteWarningBytes = 4096,
    onKeys,
    onFocusChange = undefined,
    confirmPaste = undefined,
    children = undefined,
  }: RuntimeProps = $props();

  let rootEl = $state<HTMLDivElement | null>(null);
  let nativeFocused = $state(false);
  let composing = $state(false);

  function nodeInsideRoot(node: Node | null): boolean {
    return !!(node && rootEl && (node === rootEl || rootEl.contains(node)));
  }

  function targetIsInteractive(target: EventTarget | null): boolean {
    if (!(target instanceof Element)) return false;
    return !!target.closest('input,textarea,select,button,a,[contenteditable="true"]');
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

  function keyName(e: KeyboardEvent): string {
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

  function utf8ByteLength(text: string): number {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(text).length;
    let bytes = 0;
    for (const ch of text) {
      const cp = ch.codePointAt(0) ?? 0;
      if (cp <= 0x7f) bytes += 1;
      else if (cp <= 0x7ff) bytes += 2;
      else if (cp <= 0xffff) bytes += 3;
      else bytes += 4;
    }
    return bytes;
  }

  function pasteInfo(text: string): DesktopPasteInfo | null {
    const lineCount = text.split(/\r\n|\r|\n/).length;
    const byteLength = utf8ByteLength(text);
    const multiline = pasteWarningLines > 0 && lineCount >= pasteWarningLines;
    const large = pasteWarningBytes > 0 && byteLength >= pasteWarningBytes;
    if (!multiline && !large) return null;
    return {
      text,
      lineCount,
      byteLength,
      reason: multiline && large ? 'multiline-large' : multiline ? 'multiline' : 'large',
    };
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
    if (!text) return;
    const accepted = await confirmTextPaste(text);
    if (!accepted || !enabled || !nativeFocused) return;
    if (event && !alreadyConsumed) {
      event.preventDefault();
      event.stopPropagation();
    }
    collapseTerminalSelection();
    onKeys(bracketedPaste(text));
  }

  function handleKeydown(e: KeyboardEvent) {
    if (!enabled || !nativeFocused || composing || e.isComposing || targetIsInteractive(e.target)) return;

    if (isCopyShortcut(e)) {
      if (e.metaKey || terminalSelectionActive()) return;
    }

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

    const sequence = keyboardEventToSequence(e);
    if (sequence === null) return;
    collapseTerminalSelection();
    e.preventDefault();
    e.stopPropagation();
    onKeys(sequence);
  }

  function handlePaste(e: ClipboardEvent) {
    if (!enabled || !nativeFocused || composing || targetIsInteractive(e.target)) return;
    const data = e.clipboardData;
    if (!data || clipboardHasFiles(data)) return;
    const text = data.getData('text/plain') || data.getData('text');
    if (!text) return;
    void sendPasteText(text, e);
  }

  function handlePointerDown(e: PointerEvent) {
    if (!enabled || e.button !== 0 || targetIsInteractive(e.target)) return;
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
    if (!enabled || !nativeFocused || targetIsInteractive(e.target)) return;
    composing = true;
  }

  function handleCompositionEnd(e: CompositionEvent) {
    const data = e.data;
    composing = false;
    if (!enabled || !nativeFocused || targetIsInteractive(e.target) || !data) return;
    onKeys(data);
  }

  function handleCompositionCancel() {
    composing = false;
  }

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
  oncompositioncancel={handleCompositionCancel}
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
