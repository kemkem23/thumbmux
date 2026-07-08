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

const plainNamedKeys: Record<string, string> = {
  Backspace: '\x7f',
  Escape: ESC,
  Delete: `${ESC}[3~`,
  Insert: `${ESC}[2~`,
  PageUp: `${ESC}[5~`,
  PageDown: `${ESC}[6~`,
};

const functionKeys: Record<string, string> = {
  F1: `${ESC}OP`,
  F2: `${ESC}OQ`,
  F3: `${ESC}OR`,
  F4: `${ESC}OS`,
  F5: `${ESC}[15~`,
  F6: `${ESC}[17~`,
  F7: `${ESC}[18~`,
  F8: `${ESC}[19~`,
  F9: `${ESC}[20~`,
  F10: `${ESC}[21~`,
  F11: `${ESC}[23~`,
  F12: `${ESC}[24~`,
};

/** Returns bytes to send to the pane, or null = let the browser handle it. */
export function keyboardEventToSequence(e: KeyLike): string | null {
  if (e.isComposing || e.metaKey) return null;

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

  const plainNamed = plainNamedKeys[key];
  if (plainNamed) return plainNamed;

  const functionKey = functionKeys[key];
  if (functionKey) return functionKey;

  if (ctrl) return ctrlSequence(e);
  if (key.length === 1) return alt ? `${ESC}${key}` : key;

  return null;
}

/** Wrap text for bracketed paste; normalize \r\n and \n to \r (like xterm.js). */
export function bracketedPaste(text: string): string {
  return `${ESC}[200~${text.replace(/\r\n|\n/g, '\r')}${ESC}[201~`;
}

function modifiedCsi(final: string, shift: boolean, alt: boolean, ctrl: boolean): string {
  const modifier = 1 + (shift ? 1 : 0) + (alt ? 2 : 0) + (ctrl ? 4 : 0);
  return `${ESC}[1;${modifier}${final}`;
}

function ctrlSequence(e: KeyLike): string | null {
  if (e.key === ' ' || e.code === 'Space') return '\x00';
  if (e.key === '[') return ESC;
  if (e.key === '\\') return '\x1c';
  if (e.key === ']') return '\x1d';

  const lower = e.key.toLowerCase();
  if (lower.length === 1 && lower >= 'a' && lower <= 'z') {
    return String.fromCharCode(lower.charCodeAt(0) - 96);
  }

  return null;
}
