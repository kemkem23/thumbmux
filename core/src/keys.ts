const ESC = '\x1b';

export type KeyLike = {
  key: string;
  code?: string;
  ctrlKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  isComposing?: boolean;
};

export type KeyboardSequenceOptions = {
  /**
   * Treat Alt/Option as Meta for printable characters. Set false when the
   * caller wants Option-composed printable characters sent verbatim; named keys
   * still use Alt in their terminal modifier encoding. Ctrl+Alt printable
   * AltGr input is always sent verbatim.
   */
  altIsMeta?: boolean;
};

const arrowFinals: Record<string, string> = {
  ArrowUp: 'A',
  ArrowDown: 'B',
  ArrowRight: 'C',
  ArrowLeft: 'D',
};

const homeEndFinals: Record<string, string> = {
  Home: 'H',
  End: 'F',
};

const tildeNamedKeys: Record<string, number> = {
  Delete: 3,
  PageUp: 5,
  PageDown: 6,
};

const ss3FunctionKeys: Record<string, string> = {
  F1: 'P',
  F2: 'Q',
  F3: 'R',
  F4: 'S',
};

const tildeFunctionKeys: Record<string, number> = {
  F5: 15,
  F6: 17,
  F7: 18,
  F8: 19,
  F9: 20,
  F10: 21,
  F11: 23,
  F12: 24,
};

/**
 * Returns bytes to send to the pane, or null = let the browser handle it.
 *
 * `altIsMeta` defaults to true, preserving PC-style Alt behavior for printable
 * keys. Set it to false for macOS Option composition; printable Option output
 * is then sent verbatim while named keys still encode Alt as a modifier.
 */
export function keyboardEventToSequence(e: KeyLike, opts: KeyboardSequenceOptions = {}): string | null {
  if (e.isComposing || e.metaKey) return null;

  const altIsMeta = opts.altIsMeta ?? true;
  const key = e.key;
  const shifted = !!e.shiftKey;
  const alt = !!e.altKey;
  const ctrl = !!e.ctrlKey;

  const arrowFinal = arrowFinals[key];
  if (arrowFinal) {
    return shifted || alt || ctrl
      ? modifiedCsi(arrowFinal, shifted, alt, ctrl)
      : `${ESC}[${arrowFinal}`;
  }

  const homeEndFinal = homeEndFinals[key];
  if (homeEndFinal) {
    return shifted || alt || ctrl
      ? modifiedCsi(homeEndFinal, shifted, alt, ctrl)
      : `${ESC}[${homeEndFinal}`;
  }

  if (key === 'Enter') return alt ? `${ESC}\r` : '\r';
  if (key === 'Tab') {
    if (alt || ctrl) return null;
    return shifted ? `${ESC}[Z` : '\t';
  }

  const namedKey = namedKeySequence(key, shifted, alt, ctrl);
  if (namedKey !== undefined) return namedKey;

  const functionKey = functionKeySequence(key, shifted, alt, ctrl);
  if (functionKey) return functionKey;

  if (ctrl && alt && key.length === 1) return key;
  if (ctrl) return ctrlSequence(e);
  if (key.length === 1) return alt && altIsMeta ? `${ESC}${key}` : key;

  return null;
}

/** Wrap text for bracketed paste; normalize \r\n and \n to \r (like xterm.js). */
export function bracketedPaste(text: string): string {
  return `${ESC}[200~${text.replace(/\r\n|\n/g, '\r')}${ESC}[201~`;
}

function modifiedCsi(final: string, shift: boolean, alt: boolean, ctrl: boolean): string {
  const modifier = modifierValue(shift, alt, ctrl);
  return `${ESC}[1;${modifier}${final}`;
}

function modifierValue(shift: boolean, alt: boolean, ctrl: boolean): number {
  return 1 + (shift ? 1 : 0) + (alt ? 2 : 0) + (ctrl ? 4 : 0);
}

function namedKeySequence(key: string, shift: boolean, alt: boolean, ctrl: boolean): string | null | undefined {
  if (key === 'Backspace') {
    const base = ctrl ? '\x08' : '\x7f';
    return alt ? `${ESC}${base}` : base;
  }

  if (key === 'Escape') return ESC;

  if (key === 'Insert') {
    if (shift || ctrl) return null;
    return alt ? `${ESC}[2;3~` : `${ESC}[2~`;
  }

  const tildeCode = tildeNamedKeys[key];
  if (tildeCode) {
    const modifier = modifierValue(shift, alt, ctrl);
    return modifier > 1 ? `${ESC}[${tildeCode};${modifier}~` : `${ESC}[${tildeCode}~`;
  }

  return undefined;
}

function functionKeySequence(key: string, shift: boolean, alt: boolean, ctrl: boolean): string | null {
  const ss3Final = ss3FunctionKeys[key];
  if (ss3Final) {
    const modifier = modifierValue(shift, alt, ctrl);
    return modifier > 1 ? `${ESC}[1;${modifier}${ss3Final}` : `${ESC}O${ss3Final}`;
  }

  const tildeCode = tildeFunctionKeys[key];
  if (tildeCode) {
    const modifier = modifierValue(shift, alt, ctrl);
    return modifier > 1 ? `${ESC}[${tildeCode};${modifier}~` : `${ESC}[${tildeCode}~`;
  }

  return null;
}

function ctrlSequence(e: KeyLike): string | null {
  if (e.key === ' ' || e.code === 'Space') return '\x00';
  if (e.key.length === 1 && e.key >= '0' && e.key <= '9') {
    return ctrlDigitSequences[e.key] ?? null;
  }
  if (e.key === '[') return ESC;
  if (e.key === '\\') return '\x1c';
  if (e.key === ']') return '\x1d';

  const lower = e.key.toLowerCase();
  if (lower.length === 1 && lower >= 'a' && lower <= 'z') {
    return String.fromCharCode(lower.charCodeAt(0) - 96);
  }

  return null;
}

const ctrlDigitSequences: Record<string, string | null> = {
  '0': null,
  '1': null,
  '2': '\x00',
  '3': ESC,
  '4': '\x1c',
  '5': '\x1d',
  '6': '\x1e',
  '7': '\x1f',
  '8': '\x7f',
  '9': null,
};
