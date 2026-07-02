/**
 * Minimal SGR (ANSI color) → HTML renderer for the mobile terminal engine.
 *
 * tmux `capture-pane -e` output is plain text lines with inline SGR codes —
 * no cursor movement — so a color-state machine over `ESC[...m` is enough.
 * SGR state legally carries across lines, so callers thread the state:
 *
 *   const st = createSgrState();
 *   for (const line of lines) html.push(lineToHtml(line, st, palette));
 *
 * Used by MobileTermView: lines render once into DOM and scrolling is a pure
 * GPU transform, so this parser is OFF the scroll hot path by design.
 */

export type SgrState = {
  fg: string | null;
  bg: string | null;
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
  inverse: boolean;
  strike: boolean;
};

export type AnsiPalette = {
  /** indexes 0-15; 16-255 computed */
  base: string[];
  defaultFg: string;
  defaultBg: string;
};

export function createSgrState(): SgrState {
  return { fg: null, bg: null, bold: false, dim: false, italic: false, underline: false, inverse: false, strike: false };
}

export function cloneSgrState(s: SgrState): SgrState {
  return { ...s };
}

export function sgrStateKey(s: SgrState): string {
  return `${s.fg ?? ''}|${s.bg ?? ''}|${+s.bold}${+s.dim}${+s.italic}${+s.underline}${+s.inverse}${+s.strike}`;
}

function xterm256(n: number): string {
  if (n < 16) return ''; // handled via palette.base
  if (n >= 232) {
    const v = 8 + (n - 232) * 10;
    const h = v.toString(16).padStart(2, '0');
    return `#${h}${h}${h}`;
  }
  const idx = n - 16;
  const steps = [0, 95, 135, 175, 215, 255];
  const r = steps[Math.floor(idx / 36) % 6];
  const g = steps[Math.floor(idx / 6) % 6];
  const b = steps[idx % 6];
  const h = (v: number) => v.toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

function colorFor(palette: AnsiPalette, spec: string | null): string | null {
  if (spec === null) return null;
  if (spec.startsWith('#')) return spec;
  const n = Number(spec);
  if (Number.isFinite(n)) {
    if (n < 16) return palette.base[n] ?? null;
    return xterm256(n);
  }
  return null;
}

function applySgrParams(params: number[], raw: string[], st: SgrState): void {
  for (let i = 0; i < params.length; i++) {
    const p = params[i];
    switch (p) {
      case 0: Object.assign(st, createSgrState()); break;
      case 1: st.bold = true; break;
      case 2: st.dim = true; break;
      case 3: st.italic = true; break;
      case 4: st.underline = true; break;
      case 7: st.inverse = true; break;
      case 9: st.strike = true; break;
      case 22: st.bold = false; st.dim = false; break;
      case 23: st.italic = false; break;
      case 24: st.underline = false; break;
      case 27: st.inverse = false; break;
      case 29: st.strike = false; break;
      case 38:
      case 48: {
        const isFg = p === 38;
        const mode = params[i + 1];
        if (mode === 5 && params.length > i + 2) {
          const v = String(params[i + 2]);
          if (isFg) st.fg = v; else st.bg = v;
          i += 2;
        } else if (mode === 2 && params.length > i + 4) {
          const hex = `#${[params[i + 2], params[i + 3], params[i + 4]]
            .map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0')).join('')}`;
          if (isFg) st.fg = hex; else st.bg = hex;
          i += 4;
        }
        break;
      }
      case 39: st.fg = null; break;
      case 49: st.bg = null; break;
      default:
        if (p >= 30 && p <= 37) st.fg = String(p - 30);
        else if (p >= 90 && p <= 97) st.fg = String(p - 90 + 8);
        else if (p >= 40 && p <= 47) st.bg = String(p - 40);
        else if (p >= 100 && p <= 107) st.bg = String(p - 100 + 8);
        break;
    }
    void raw;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function spanOpen(st: SgrState, palette: AnsiPalette): string {
  let fg = colorFor(palette, st.fg) ?? palette.defaultFg;
  let bg = colorFor(palette, st.bg);
  if (st.inverse) {
    const realBg = bg ?? palette.defaultBg;
    bg = fg;
    fg = realBg;
  }
  if (st.bold && st.fg !== null) {
    const n = Number(st.fg);
    if (Number.isFinite(n) && n >= 0 && n < 8) fg = colorFor(palette, String(n + 8)) ?? fg;
  }
  const styles: string[] = [`color:${fg}`];
  if (bg) styles.push(`background-color:${bg}`);
  if (st.bold) styles.push('font-weight:700');
  if (st.dim) styles.push('opacity:.6');
  if (st.italic) styles.push('font-style:italic');
  const deco: string[] = [];
  if (st.underline) deco.push('underline');
  if (st.strike) deco.push('line-through');
  if (deco.length) styles.push(`text-decoration:${deco.join(' ')}`);
  return `<span style="${styles.join(';')}">`;
}

const SGR_RE = /\x1b\[([0-9;]*)m/g;
const OTHER_ESC_RE = /\x1b(?:\][^\x07\x1b]*(?:\x07|\x1b\\)|\[[0-9;?]*[A-LN-Za-ln-z]|[()][AB0-2]|[=>]|[78])/g;

/**
 * Render one line to HTML, mutating `st` to the state AFTER the line.
 * Default-state runs are emitted bare (no span) to keep the DOM light.
 */
export type LineLinkRange = { start: number; end: number; href: string };

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

export function lineToHtml(line: string, st: SgrState, palette: AnsiPalette, links?: LineLinkRange[]): string {
  const cleaned = line.replace(OTHER_ESC_RE, '');
  let out = '';
  let last = 0;
  let col = 0; // visible column cursor (for link ranges)
  SGR_RE.lastIndex = 0;
  const defaultKey = sgrStateKey(createSgrState());
  let m: RegExpExecArray | null;
  const wrap = (text: string, href: string | null) => {
    if (!text) return;
    const isDefault = sgrStateKey(st) === defaultKey;
    if (href) {
      const attrs = `href="${escapeAttr(href)}" target="_blank" rel="noopener noreferrer"`;
      const opener = isDefault
        ? `<a ${attrs} style="color:inherit;text-decoration:underline">`
        : spanOpen(st, palette).replace('<span style="', `<a ${attrs} style="text-decoration:underline;`);
      out += opener + escapeHtml(text) + '</a>';
    } else {
      out += isDefault ? escapeHtml(text) : spanOpen(st, palette) + escapeHtml(text) + '</span>';
    }
  };

  // Split emitted runs at link boundaries so mid-line URLs (and slices of a
  // URL wrapped across lines) become real <a> elements.
  const emit = (text: string) => {
    if (!text) return;
    if (!links || links.length === 0) {
      wrap(text, null);
      col += text.length;
      return;
    }
    let pos = 0;
    while (pos < text.length) {
      const abs = col + pos;
      const active = links.find((l) => abs >= l.start && abs < l.end);
      if (active) {
        const take = Math.min(text.length - pos, active.end - abs);
        wrap(text.slice(pos, pos + take), active.href);
        pos += take;
      } else {
        let next = Infinity;
        for (const l of links) if (l.start > abs && l.start < next) next = l.start;
        const take = next === Infinity ? text.length - pos : Math.min(text.length - pos, next - abs);
        wrap(text.slice(pos, pos + take), null);
        pos += take;
      }
    }
    col += text.length;
  };
  while ((m = SGR_RE.exec(cleaned)) !== null) {
    emit(cleaned.slice(last, m.index));
    const raw = m[1].length ? m[1].split(';') : ['0'];
    applySgrParams(raw.map((x) => (x === '' ? 0 : Number(x))), raw, st);
    last = m.index + m[0].length;
  }
  emit(cleaned.slice(last));
  return out || ' ';
}
