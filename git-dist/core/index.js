// src/terminal-controls.ts
var ESC = "\x1B";
var BEL = "\x07";
var ST = "\\";
function isSurrogatePairAt(text, index) {
  if (index < 0 || index + 1 >= text.length)
    return false;
  const hi = text.charCodeAt(index);
  const lo = text.charCodeAt(index + 1);
  return hi >= 55296 && hi <= 56319 && lo >= 56320 && lo <= 57343;
}
function stripTerminalControls(raw) {
  if (raw.indexOf(ESC) < 0)
    return raw;
  let out = "";
  let i = 0;
  while (i < raw.length) {
    if (raw[i] !== ESC) {
      out += raw[i];
      i += 1;
      continue;
    }
    if (i + 1 >= raw.length)
      break;
    const next = raw[i + 1];
    if (next === "[") {
      let end = i + 2;
      let abortedAt = -1;
      while (end < raw.length) {
        const code = raw.charCodeAt(end);
        if (code === 27) {
          abortedAt = end;
          break;
        }
        if (code >= 64 && code <= 126)
          break;
        end += 1;
      }
      if (abortedAt >= 0) {
        i = abortedAt;
        continue;
      }
      if (end >= raw.length)
        break;
      i = end + 1;
      continue;
    }
    if (next === "]") {
      let end = i + 2;
      let after = raw.length;
      let terminated = false;
      while (end < raw.length) {
        if (raw[end] === BEL) {
          after = end + 1;
          terminated = true;
          break;
        }
        if (raw[end] === ESC && end + 1 < raw.length && raw[end + 1] === ST) {
          after = end + 2;
          terminated = true;
          break;
        }
        end += 1;
      }
      if (!terminated)
        break;
      i = after;
      continue;
    }
    if (next === "(" || next === ")" || next === "*" || next === "+" || next === "-" || next === "." || next === "/" || next === "#" || next === "%") {
      const third = i + 2;
      if (third >= raw.length || raw.charCodeAt(third) === 27 || isSurrogatePairAt(raw, third)) {
        i = Math.min(raw.length, third);
      } else {
        i = Math.min(raw.length, i + 3);
      }
      continue;
    }
    if (next === "=" || next === ">" || next === "7" || next === "8") {
      i += 2;
      continue;
    }
    i += 2;
  }
  return out;
}

// src/claude-status.ts
var CLAUDE_ACTIVITY_MARKER = "[●·✻✽✶✳✢*]";
var CLAUDE_STATUS_WORD = "\\p{L}[\\p{L}'’-]*";
var CLAUDE_ACTIVITY_DETAIL = "(?:\\bthinking\\b|\\beffort\\b|\\btokens?\\b)";
var CLAUDE_ACTIVE_STATUS = new RegExp(`^${CLAUDE_ACTIVITY_MARKER}\\s+${CLAUDE_STATUS_WORD}(?:…|\\.{3})\\s+` + `\\((?=[^\\n)]*${CLAUDE_ACTIVITY_DETAIL})[^\\n)]*\\)\\s*$`, "iu");
var CLAUDE_STATUS_PAINT_PARTS = new RegExp(`^(${CLAUDE_ACTIVITY_MARKER})\\s+(${CLAUDE_STATUS_WORD}(?:…|\\.{3}))\\s+\\(`, "u");
function isClaudeActivityStatusLine(line) {
  const normalized = line.replace(/\u00a0/g, " ").trim();
  if (normalized.length === 0 || normalized.length > 4096)
    return false;
  return CLAUDE_ACTIVE_STATUS.test(normalized);
}
function strictUnsigned(value, emptyIsZero = false) {
  if (value === undefined)
    return null;
  if (value === "")
    return emptyIsZero ? 0 : null;
  if (!/^\d+$/.test(value))
    return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}
function validRgb(parts) {
  return parts.length === 3 && parts.every((part) => strictUnsigned(part) !== null);
}
function applyPaintSgr(parameters, state) {
  if (parameters === "") {
    return { foreground: null, inverse: false, concealed: false };
  }
  const fields = parameters.split(";");
  let next = { ...state };
  for (let index = 0;index < fields.length; index += 1) {
    const field = fields[index] ?? "";
    const colon = field.split(":");
    const value = strictUnsigned(colon[0], field === "");
    if (value === null)
      continue;
    if (value === 0) {
      next = { foreground: null, inverse: false, concealed: false };
      continue;
    }
    if (value === 39) {
      next.foreground = null;
      continue;
    }
    if (value === 7) {
      next.inverse = true;
      continue;
    }
    if (value === 27) {
      next.inverse = false;
      continue;
    }
    if (value === 8) {
      next.concealed = true;
      continue;
    }
    if (value === 28) {
      next.concealed = false;
      continue;
    }
    if (value === 38 || value === 48 || value === 58) {
      if (colon.length > 1) {
        const mode2 = strictUnsigned(colon[1], true);
        if (value === 38 && mode2 === 5) {
          const paletteIndex = strictUnsigned(colon[2]);
          if (paletteIndex !== null && paletteIndex <= 255) {
            next.foreground = paletteIndex;
          }
        } else if (value === 38 && mode2 === 2) {
          const componentStart = colon.length >= 6 ? 3 : 2;
          if (validRgb(colon.slice(componentStart, componentStart + 3))) {
            next.foreground = -1;
          }
        }
        continue;
      }
      const mode = strictUnsigned(fields[index + 1], true);
      if (mode === 5) {
        const consumed = Math.min(2, fields.length - index - 1);
        const paletteIndex = strictUnsigned(fields[index + 2]);
        if (value === 38) {
          if (paletteIndex !== null && paletteIndex <= 255) {
            next.foreground = paletteIndex;
          }
        }
        index += consumed;
        continue;
      }
      if (mode === 2) {
        const consumed = Math.min(4, fields.length - index - 1);
        if (value === 38 && fields[index + 4] !== undefined && validRgb(fields.slice(index + 2, index + 5)))
          next.foreground = -1;
        index += consumed;
        continue;
      }
      continue;
    }
    if (value >= 30 && value <= 37 || value >= 90 && value <= 97) {
      next.foreground = -1;
    }
  }
  return next;
}
function terminalPaintSnapshot(raw, initialForeground = null, initialInverse = false, initialConcealed = false) {
  let paintState = {
    foreground: initialForeground,
    inverse: initialInverse,
    concealed: initialConcealed
  };
  let visible = "";
  const foregrounds = [];
  let index = 0;
  while (index < raw.length) {
    if (raw[index] !== "\x1B") {
      const codePoint = raw.codePointAt(index);
      if (codePoint === undefined)
        break;
      const painted = String.fromCodePoint(codePoint);
      visible += painted;
      const effectiveForeground = paintState.inverse || paintState.concealed ? -1 : paintState.foreground;
      for (let unit = 0;unit < painted.length; unit += 1) {
        foregrounds.push(effectiveForeground);
      }
      index += painted.length;
      continue;
    }
    if (raw[index + 1] === "[") {
      let end = index + 2;
      while (end < raw.length) {
        const code = raw.charCodeAt(end);
        if (code === 27)
          return null;
        if (code >= 64 && code <= 126)
          break;
        end += 1;
      }
      if (end >= raw.length)
        return null;
      if (raw[end] === "m") {
        paintState = applyPaintSgr(raw.slice(index + 2, end), paintState);
      }
      index = end + 1;
      continue;
    }
    if (raw[index + 1] === "]") {
      let end = index + 2;
      let terminated = false;
      while (end < raw.length) {
        if (raw[end] === "\x07") {
          index = end + 1;
          terminated = true;
          break;
        }
        if (raw[end] === "\x1B" && raw[end + 1] === "\\") {
          index = end + 2;
          terminated = true;
          break;
        }
        end += 1;
      }
      if (!terminated)
        return null;
      continue;
    }
    const next = raw[index + 1];
    if (next === "\x1B")
      return null;
    if (next && "()*+-./#%".includes(next) && raw[index + 2] === "\x1B")
      return null;
    if (next === "c") {
      paintState = { foreground: null, inverse: false, concealed: false };
    }
    index += next && "()*+-./#%".includes(next) ? 3 : 2;
  }
  if (visible !== stripTerminalControls(raw))
    return null;
  return {
    visible,
    foregrounds,
    endForeground: paintState.foreground,
    endInverse: paintState.inverse,
    endConcealed: paintState.concealed
  };
}
function isStyledClaudeActivityStatusLine(raw, initialForeground = null, initialInverse = false, initialConcealed = false) {
  if (raw.length === 0 || raw.length > 65536)
    return false;
  const paint = terminalPaintSnapshot(raw, initialForeground, initialInverse, initialConcealed);
  if (!paint)
    return false;
  const visible = paint.visible.replace(/\u00a0/g, " ");
  if (visible !== visible.trimStart())
    return false;
  const normalized = visible.trimEnd();
  if (!isClaudeActivityStatusLine(normalized))
    return false;
  const parts = CLAUDE_STATUS_PAINT_PARTS.exec(normalized);
  const marker = parts?.[1];
  const verb = parts?.[2];
  if (!marker || !verb)
    return false;
  const verbStart = normalized.indexOf(verb, marker.length);
  const metadataStart = normalized.indexOf("(", verbStart + verb.length);
  const metadataEnd = normalized.lastIndexOf(")");
  if (verbStart < 0 || metadataStart < 0 || metadataEnd <= metadataStart)
    return false;
  const paintedAs = (start, end, expected) => {
    for (let unit = start;unit < end; unit += 1) {
      if (/\s/u.test(normalized[unit] ?? ""))
        continue;
      if (paint.foregrounds[unit] !== expected)
        return false;
    }
    return true;
  };
  const currentPaint = paintedAs(0, marker.length, 174) && paintedAs(verbStart, verbStart + verb.length, 174) && paintedAs(metadataStart, metadataEnd + 1, 246);
  const legacyPaint = paintedAs(0, marker.length, 246) && paintedAs(verbStart, verbStart + verb.length, null) && paintedAs(metadataStart, metadataEnd + 1, null);
  return currentPaint || legacyPaint;
}

// src/cells.ts
var ZERO_WIDTH_MARK = /\p{Mn}|\p{Me}/u;
function isZeroWidthFormat(cp) {
  if (cp >= 8203 && cp <= 8207)
    return true;
  if (cp >= 65024 && cp <= 65039)
    return true;
  if (cp === 1564 || cp === 6158 || cp === 65279)
    return true;
  if (cp >= 8234 && cp <= 8238)
    return true;
  if (cp >= 8288 && cp <= 8292)
    return true;
  if (cp >= 8294 && cp <= 8303)
    return true;
  if (cp >= 65529 && cp <= 65531)
    return true;
  return false;
}
var VS16 = 65039;
var WIDE_RANGES = [
  [4352, 4447],
  [8986, 8987],
  [9001, 9002],
  [9193, 9196],
  [9200, 9200],
  [9203, 9203],
  [9725, 9726],
  [9748, 9749],
  [9800, 9811],
  [9855, 9855],
  [9875, 9875],
  [9889, 9889],
  [9898, 9899],
  [9917, 9918],
  [9924, 9925],
  [9934, 9934],
  [9940, 9940],
  [9962, 9962],
  [9970, 9971],
  [9973, 9973],
  [9978, 9978],
  [9981, 9981],
  [9989, 9989],
  [9994, 9995],
  [10024, 10024],
  [10060, 10060],
  [10062, 10062],
  [10067, 10069],
  [10071, 10071],
  [10133, 10135],
  [10160, 10160],
  [10175, 10175],
  [11035, 11036],
  [11088, 11088],
  [11093, 11093],
  [11904, 12350],
  [12353, 13311],
  [13312, 19903],
  [19968, 40959],
  [40960, 42191],
  [43360, 43391],
  [44032, 55203],
  [63744, 64255],
  [65040, 65049],
  [65072, 65135],
  [65280, 65376],
  [65504, 65510],
  [126976, 129791],
  [131072, 262141]
];
function charCellWidth(cp) {
  const ch = String.fromCodePoint(cp);
  if (isZeroWidthFormat(cp) || ZERO_WIDTH_MARK.test(ch))
    return 0;
  for (const [a, b] of WIDE_RANGES) {
    if (cp >= a && cp <= b)
      return 2;
    if (cp < a)
      break;
  }
  return 1;
}
function stringCells(text) {
  let cells = 0;
  let prevWidth = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    const w = charCellWidth(cp);
    if (w === 0 && cp === VS16 && prevWidth === 1) {
      cells += 1;
      prevWidth = 2;
      continue;
    }
    cells += w;
    if (w > 0)
      prevWidth = w;
  }
  return cells;
}
function prefixForCells(text, cells) {
  if (cells <= 0)
    return { prefix: "", cells: 0 };
  let consumed = 0;
  let end = 0;
  let prevWidth = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    const w = charCellWidth(cp);
    if (w === 0 && cp === VS16 && prevWidth === 1) {
      if (consumed + 1 > cells)
        break;
      consumed += 1;
      prevWidth = 2;
      end += ch.length;
      for (const next of text.slice(end)) {
        if (charCellWidth(next.codePointAt(0)) !== 0)
          break;
        end += next.length;
      }
      if (consumed === cells)
        break;
      continue;
    }
    if (w > 0 && consumed + w > cells)
      break;
    consumed += w;
    end += ch.length;
    if (w > 0)
      prevWidth = w;
    if (consumed === cells) {
      for (const next of text.slice(end)) {
        const ncp = next.codePointAt(0);
        const nw = charCellWidth(ncp);
        if (nw !== 0)
          break;
        if (ncp === VS16 && prevWidth === 1)
          break;
        end += next.length;
      }
      break;
    }
  }
  return { prefix: text.slice(0, end), cells: consumed };
}

// src/ansi-html.ts
var VS162 = 65039;
function wideUnitLength(text, i) {
  if (i >= text.length)
    return 0;
  const cp = text.codePointAt(i);
  const cpLen = cp > 65535 ? 2 : 1;
  const w = charCellWidth(cp);
  if (w === 2) {
    let end = i + cpLen;
    while (end < text.length) {
      const next = text.codePointAt(end);
      if (charCellWidth(next) !== 0)
        break;
      end += next > 65535 ? 2 : 1;
    }
    return end - i;
  }
  if (w === 1) {
    const j = i + cpLen;
    if (j < text.length && text.codePointAt(j) === VS162) {
      let end = j + 1;
      while (end < text.length) {
        const next = text.codePointAt(end);
        if (charCellWidth(next) !== 0)
          break;
        end += next > 65535 ? 2 : 1;
      }
      return end - i;
    }
  }
  return 0;
}
function isTerminalGridGlyph(cp) {
  return cp >= 9472 && cp <= 9631 || cp >= 10240 && cp <= 10495;
}
var GRAPHEME = new Intl.Segmenter("en", { granularity: "grapheme" });
function graphemeAt(text, i) {
  if (i >= text.length)
    return "";
  const first = GRAPHEME.segment(text.slice(i))[Symbol.iterator]().next().value;
  return first ? first.segment : "";
}
var BEL2 = "\x07";
var ESC2 = "\x1B";
var ST2 = "\\";
function safeCssColor(value) {
  if (value == null)
    return null;
  const t = value.trim();
  if (/^#[0-9a-fA-F]{3}$/.test(t) || /^#[0-9a-fA-F]{6}$/.test(t) || /^#[0-9a-fA-F]{8}$/.test(t)) {
    return t.toLowerCase();
  }
  return null;
}
function createSgrState() {
  return {
    fg: null,
    bg: null,
    bold: false,
    dim: false,
    italic: false,
    underline: false,
    underlineStyle: null,
    underlineColor: null,
    inverse: false,
    strike: false,
    osc8Href: null
  };
}
function cloneSgrState(s) {
  return {
    fg: s.fg,
    bg: s.bg,
    bold: s.bold,
    dim: s.dim,
    italic: s.italic,
    underline: s.underline,
    underlineStyle: s.underlineStyle ?? null,
    underlineColor: s.underlineColor ?? null,
    inverse: s.inverse,
    strike: s.strike,
    osc8Href: s.osc8Href ?? null
  };
}
function sgrStateKey(s) {
  return [
    s.fg ?? "",
    s.bg ?? "",
    +s.bold,
    +s.dim,
    +s.italic,
    +s.underline,
    s.underlineStyle ?? "",
    s.underlineColor ?? "",
    +s.inverse,
    +s.strike,
    s.osc8Href ?? ""
  ].join("|");
}
function xterm256(n) {
  if (n < 16)
    return "";
  if (n >= 232) {
    const v = 8 + (n - 232) * 10;
    const h2 = v.toString(16).padStart(2, "0");
    return `#${h2}${h2}${h2}`;
  }
  const idx = n - 16;
  const steps = [0, 95, 135, 175, 215, 255];
  const r = steps[Math.floor(idx / 36) % 6];
  const g = steps[Math.floor(idx / 6) % 6];
  const b = steps[idx % 6];
  const h = (v) => v.toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}
function colorFor(palette, spec) {
  if (spec === null)
    return null;
  const direct = safeCssColor(spec);
  if (direct)
    return direct;
  if (!/^\d+$/.test(spec))
    return null;
  const n = Number(spec);
  if (!Number.isSafeInteger(n) || n < 0 || n > 255)
    return null;
  if (n < 16)
    return safeCssColor(palette.base[n] ?? null);
  return xterm256(n);
}
function parseUnsigned(value, emptyIsZero = false) {
  if (value === undefined)
    return null;
  if (value === "")
    return emptyIsZero ? 0 : null;
  if (!/^\d+$/.test(value))
    return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}
function clampByte(value) {
  return Math.max(0, Math.min(255, value));
}
function rgbColor(r, g, b) {
  const values = [parseUnsigned(r), parseUnsigned(g), parseUnsigned(b)];
  if (values.some((value) => value === null))
    return null;
  return `#${values.map((value) => clampByte(value).toString(16).padStart(2, "0")).join("")}`;
}
function indexedColor(value) {
  const index = parseUnsigned(value);
  return index !== null && index <= 255 ? String(index) : null;
}
function colorFromColon(parts) {
  const mode = parseUnsigned(parts[1], true);
  if (mode === 5)
    return indexedColor(parts[2]);
  if (mode !== 2)
    return null;
  const componentStart = parts.length >= 6 ? 3 : 2;
  return rgbColor(parts[componentStart], parts[componentStart + 1], parts[componentStart + 2]);
}
function colorFromSemicolon(fields, at) {
  const mode = parseUnsigned(fields[at + 1], true);
  if (mode === 5) {
    const consumed = Math.min(2, fields.length - at - 1);
    return {
      color: fields[at + 2] === undefined ? null : indexedColor(fields[at + 2]),
      consumed
    };
  }
  if (mode === 2) {
    const consumed = Math.min(4, fields.length - at - 1);
    return {
      color: fields[at + 4] === undefined ? null : rgbColor(fields[at + 2], fields[at + 3], fields[at + 4]),
      consumed
    };
  }
  return { color: null, consumed: 0 };
}
function resetSgr(st) {
  st.fg = null;
  st.bg = null;
  st.bold = false;
  st.dim = false;
  st.italic = false;
  st.underline = false;
  st.underlineStyle = null;
  st.underlineColor = null;
  st.inverse = false;
  st.strike = false;
}
function setUnderline(st, style) {
  st.underline = style !== null;
  st.underlineStyle = style;
}
function applyUnderlineVariant(st, code) {
  switch (code) {
    case 0:
      setUnderline(st, null);
      break;
    case 1:
      setUnderline(st, "single");
      break;
    case 2:
      setUnderline(st, "double");
      break;
    case 3:
      setUnderline(st, "curly");
      break;
    case 4:
      setUnderline(st, "dotted");
      break;
    case 5:
      setUnderline(st, "dashed");
      break;
    default:
      break;
  }
}
function applySgrParams(raw, st) {
  const fields = raw === "" ? ["0"] : raw.split(";");
  for (let i = 0;i < fields.length; i += 1) {
    const field = fields[i];
    const colon = field.split(":");
    const code = parseUnsigned(colon[0], field === "");
    if (code === null)
      continue;
    if (code === 4 && colon.length > 1) {
      applyUnderlineVariant(st, parseUnsigned(colon[1], true));
      continue;
    }
    switch (code) {
      case 0:
        resetSgr(st);
        break;
      case 1:
        st.bold = true;
        break;
      case 2:
        st.dim = true;
        break;
      case 3:
        st.italic = true;
        break;
      case 4:
        setUnderline(st, "single");
        break;
      case 7:
        st.inverse = true;
        break;
      case 9:
        st.strike = true;
        break;
      case 21:
        setUnderline(st, "double");
        break;
      case 22:
        st.bold = false;
        st.dim = false;
        break;
      case 23:
        st.italic = false;
        break;
      case 24:
        setUnderline(st, null);
        break;
      case 27:
        st.inverse = false;
        break;
      case 29:
        st.strike = false;
        break;
      case 38:
      case 48:
      case 58: {
        const color = colon.length > 1 ? colorFromColon(colon) : (() => {
          const parsed = colorFromSemicolon(fields, i);
          i += parsed.consumed;
          return parsed.color;
        })();
        if (color === null)
          break;
        if (code === 38)
          st.fg = color;
        else if (code === 48)
          st.bg = color;
        else
          st.underlineColor = color;
        break;
      }
      case 39:
        st.fg = null;
        break;
      case 49:
        st.bg = null;
        break;
      case 59:
        st.underlineColor = null;
        break;
      default:
        if (code >= 30 && code <= 37)
          st.fg = String(code - 30);
        else if (code >= 90 && code <= 97)
          st.fg = String(code - 90 + 8);
        else if (code >= 40 && code <= 47)
          st.bg = String(code - 40);
        else if (code >= 100 && code <= 107)
          st.bg = String(code - 100 + 8);
        break;
    }
  }
}
function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
var WIDE_CELL_CLASS = "mtv-w2";
var NARROW_CELL_CLASS = "mtv-w1";
var MULTI_CELL_CLASS = "mtv-wx";
var FIT_CLASS = "mtv-fit";
function clusterNeedsFit(text) {
  const cp = text.codePointAt(0);
  if (cp === undefined)
    return false;
  const ch = String.fromCodePoint(cp);
  return /\p{S}/u.test(ch) || /\p{Extended_Pictographic}/u.test(ch);
}
function pinSpan(text, cells) {
  const body = escapeHtml(text);
  if (cells <= 1) {
    const fit = clusterNeedsFit(text) ? ` ${FIT_CLASS}` : "";
    return `<span class="${NARROW_CELL_CLASS}${fit}">${body}</span>`;
  }
  if (cells === 2)
    return `<span class="${WIDE_CELL_CLASS}">${body}</span>`;
  return `<span class="${MULTI_CELL_CLASS}" style="--mtv-cells:${cells}">${body}</span>`;
}
function escapeHtmlWithWideCells(text) {
  const len = text.length;
  if (len === 0)
    return "";
  let out = "";
  let bufStart = 0;
  let i = 0;
  while (i < len) {
    const cp = text.codePointAt(i);
    if (cp < 128 || isTerminalGridGlyph(cp)) {
      i += cp > 65535 ? 2 : 1;
      continue;
    }
    const unitLen = wideUnitLength(text, i);
    if (unitLen > 0) {
      if (i > bufStart)
        out += escapeHtml(text.slice(bufStart, i));
      out += `<span class="${WIDE_CELL_CLASS}">${escapeHtml(text.slice(i, i + unitLen))}</span>`;
      i += unitLen;
      bufStart = i;
      continue;
    }
    const grapheme = graphemeAt(text, i);
    if (grapheme) {
      if (i > bufStart)
        out += escapeHtml(text.slice(bufStart, i));
      out += pinSpan(grapheme, stringCells(grapheme));
      i += grapheme.length;
      bufStart = i;
      continue;
    }
    i += cp > 65535 ? 2 : 1;
  }
  if (bufStart < len)
    out += escapeHtml(text.slice(bufStart));
  return out;
}
function escapeAttr(s) {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/'/g, "&#39;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function isSafeHref(rawHref) {
  if (rawHref === "" || rawHref !== rawHref.trim() || /[\u0000-\u001f\u007f]/.test(rawHref))
    return null;
  try {
    const protocol = new URL(rawHref).protocol.toLowerCase();
    return protocol === "http:" || protocol === "https:" || protocol === "mailto:" ? rawHref : null;
  } catch {
    return null;
  }
}
function applyOscPayload(payload, st) {
  if (!payload.startsWith("8;"))
    return;
  const firstSeparator = payload.indexOf(";");
  const secondSeparator = payload.indexOf(";", firstSeparator + 1);
  if (secondSeparator === -1) {
    st.osc8Href = null;
    return;
  }
  st.osc8Href = isSafeHref(payload.slice(secondSeparator + 1));
}
function isDefaultSgrState(st) {
  return st.fg === null && st.bg === null && !st.bold && !st.dim && !st.italic && !st.underline && (st.underlineStyle ?? null) === null && (st.underlineColor ?? null) === null && !st.inverse && !st.strike;
}
function styleDeclarations(st, palette, linkUnderline = false) {
  const defaultFg = safeCssColor(palette.defaultFg) ?? "#e6e6e6";
  const defaultBg = safeCssColor(palette.defaultBg) ?? "#000000";
  let fg = colorFor(palette, st.fg) ?? defaultFg;
  let bg = colorFor(palette, st.bg);
  if (st.inverse) {
    const realBg = bg ?? defaultBg;
    bg = fg;
    fg = realBg;
  }
  if (st.bold && st.fg !== null) {
    const n = Number(st.fg);
    if (Number.isFinite(n) && n >= 0 && n < 8)
      fg = colorFor(palette, String(n + 8)) ?? fg;
  }
  const styles = [`color:${fg}`];
  if (bg)
    styles.push(`background-color:${bg}`);
  if (st.bold)
    styles.push("font-weight:700");
  if (st.dim)
    styles.push("opacity:.6");
  if (st.italic)
    styles.push("font-style:italic");
  const decoration = [];
  if (st.underline || linkUnderline)
    decoration.push("underline");
  if (st.strike)
    decoration.push("line-through");
  if (decoration.length)
    styles.push(`text-decoration:${decoration.join(" ")}`);
  if (st.underline) {
    const underlineStyle = st.underlineStyle ?? null;
    if (underlineStyle === "double")
      styles.push("text-decoration-style:double");
    else if (underlineStyle === "dotted")
      styles.push("text-decoration-style:dotted");
    else if (underlineStyle === "dashed")
      styles.push("text-decoration-style:dashed");
    else if (underlineStyle === "curly")
      styles.push("text-decoration-style:wavy");
    const underlineColor = colorFor(palette, st.underlineColor ?? null);
    if (underlineColor)
      styles.push(`text-decoration-color:${underlineColor}`);
  }
  return styles;
}
function spanOpen(st, palette) {
  return `<span style="${styleDeclarations(st, palette).join(";")}">`;
}
function anchorOpen(st, palette, href) {
  const attrs = `href="${escapeAttr(href)}" target="_blank" rel="noopener noreferrer"`;
  if (isDefaultSgrState(st)) {
    return `<a ${attrs} style="color:inherit;text-decoration:underline">`;
  }
  return `<a ${attrs} style="${styleDeclarations(st, palette, true).join(";")}">`;
}
function isUsableRange(range) {
  return Number.isSafeInteger(range.start) && Number.isSafeInteger(range.end) && range.start >= 0 && range.end > range.start;
}
function compareRangeStart(a, b) {
  return a.start - b.start || a.ord - b.ord;
}
function buildRangeWalker(links, overlays) {
  const linksByStart = links.map((link, ord) => ({
    start: link.start,
    end: link.end,
    href: link.href,
    ord
  }));
  linksByStart.sort(compareRangeStart);
  const overlaysByStart = overlays.map((overlay, ord) => ({
    start: overlay.start,
    end: overlay.end,
    kind: overlay.kind,
    ord
  }));
  overlaysByStart.sort(compareRangeStart);
  const bounds = [];
  for (const link of linksByStart) {
    bounds.push(link.start, link.end);
  }
  for (const overlay of overlaysByStart) {
    bounds.push(overlay.start, overlay.end);
  }
  bounds.sort((a, b) => a - b);
  let boundLen = 0;
  for (let i = 0;i < bounds.length; i += 1) {
    const value = bounds[i];
    if (boundLen === 0 || bounds[boundLen - 1] !== value) {
      bounds[boundLen] = value;
      boundLen += 1;
    }
  }
  bounds.length = boundLen;
  let boundIdx = 0;
  let linkStartIdx = 0;
  let overlayStartIdx = 0;
  const activeLinks = [];
  const activeOverlays = [];
  let syncedAt = -1;
  const syncActive = (position) => {
    if (position === syncedAt)
      return;
    let w = 0;
    for (let r = 0;r < activeLinks.length; r += 1) {
      if (activeLinks[r].end > position)
        activeLinks[w++] = activeLinks[r];
    }
    activeLinks.length = w;
    w = 0;
    for (let r = 0;r < activeOverlays.length; r += 1) {
      if (activeOverlays[r].end > position)
        activeOverlays[w++] = activeOverlays[r];
    }
    activeOverlays.length = w;
    while (linkStartIdx < linksByStart.length && linksByStart[linkStartIdx].start <= position) {
      const link = linksByStart[linkStartIdx++];
      if (link.end > position)
        activeLinks.push(link);
    }
    while (overlayStartIdx < overlaysByStart.length && overlaysByStart[overlayStartIdx].start <= position) {
      const overlay = overlaysByStart[overlayStartIdx++];
      if (overlay.end > position)
        activeOverlays.push(overlay);
    }
    syncedAt = position;
  };
  return {
    nextBoundary(position) {
      while (boundIdx < bounds.length && bounds[boundIdx] <= position)
        boundIdx += 1;
      return boundIdx < bounds.length ? bounds[boundIdx] : Infinity;
    },
    hrefAt(position) {
      syncActive(position);
      if (activeLinks.length === 0)
        return null;
      let best = activeLinks[0];
      for (let i = 1;i < activeLinks.length; i += 1) {
        const candidate = activeLinks[i];
        if (candidate.ord < best.ord)
          best = candidate;
      }
      return best.href;
    },
    overlayAt(position) {
      syncActive(position);
      let hasMatch = false;
      for (let i = 0;i < activeOverlays.length; i += 1) {
        const kind = activeOverlays[i].kind;
        if (kind === "search-active")
          return "search-active";
        if (kind === "search-match")
          hasMatch = true;
      }
      return hasMatch ? "search-match" : null;
    }
  };
}
function isSurrogatePairAt2(text, index) {
  if (index < 0 || index + 1 >= text.length)
    return false;
  const hi = text.charCodeAt(index);
  const lo = text.charCodeAt(index + 1);
  return hi >= 55296 && hi <= 56319 && lo >= 56320 && lo <= 57343;
}
function withOverlay(text, kind) {
  const escaped = escapeHtmlWithWideCells(text);
  if (kind === "search-active")
    return `<span class="search-active">${escaped}</span>`;
  if (kind === "search-match")
    return `<span class="search-match">${escaped}</span>`;
  return escaped;
}
function lineToHtml(line, st, palette, links, overlays) {
  let out = "";
  let col = 0;
  const usableLinks = [];
  if (links?.length) {
    for (const link of links) {
      if (!isUsableRange(link))
        continue;
      const href = isSafeHref(link.href);
      if (!href)
        continue;
      usableLinks.push({ start: link.start, end: link.end, href });
    }
  }
  const usableOverlays = [];
  if (overlays?.length) {
    for (const overlay of overlays) {
      if (!isUsableRange(overlay))
        continue;
      if (overlay.kind !== "search-match" && overlay.kind !== "search-active")
        continue;
      usableOverlays.push(overlay);
    }
  }
  const rangeWalker = usableLinks.length > 0 || usableOverlays.length > 0 ? buildRangeWalker(usableLinks, usableOverlays) : null;
  let memoOsc8Raw = undefined;
  let memoOsc8Safe = null;
  const safeOsc8Href = () => {
    const raw = st.osc8Href ?? null;
    if (raw === memoOsc8Raw)
      return memoOsc8Safe;
    memoOsc8Raw = raw;
    memoOsc8Safe = raw ? isSafeHref(raw) : null;
    return memoOsc8Safe;
  };
  const appendText = (rawText) => {
    if (!rawText)
      return;
    const explicitHref = safeOsc8Href();
    if (!explicitHref && !rangeWalker) {
      out += isDefaultSgrState(st) ? escapeHtmlWithWideCells(rawText) : `${spanOpen(st, palette)}${escapeHtmlWithWideCells(rawText)}</span>`;
      col += rawText.length;
      return;
    }
    let offset = 0;
    while (offset < rawText.length) {
      const absolute = col + offset;
      const boundary = rangeWalker ? rangeWalker.nextBoundary(absolute) : Infinity;
      const take = boundary === Infinity ? rawText.length - offset : Math.min(rawText.length - offset, boundary - absolute);
      let count = take > 0 ? take : 1;
      if (offset + count < rawText.length && isSurrogatePairAt2(rawText, offset + count - 1)) {
        if (count > 1)
          count -= 1;
        else
          count += 1;
      }
      let href = explicitHref ?? (rangeWalker ? rangeWalker.hrefAt(absolute) : null);
      let overlayKind = rangeWalker ? rangeWalker.overlayAt(absolute) : null;
      if (!explicitHref && count >= 2 && isSurrogatePairAt2(rawText, offset)) {
        if (!href && rangeWalker)
          href = rangeWalker.hrefAt(absolute + 1);
        if (!overlayKind && rangeWalker)
          overlayKind = rangeWalker.overlayAt(absolute + 1);
      }
      const contents = withOverlay(rawText.slice(offset, offset + count), overlayKind);
      if (href)
        out += `${anchorOpen(st, palette, href)}${contents}</a>`;
      else if (isDefaultSgrState(st))
        out += contents;
      else
        out += `${spanOpen(st, palette)}${contents}</span>`;
      offset += count;
    }
    col += rawText.length;
  };
  let cursor = 0;
  let textStart = 0;
  while (cursor < line.length) {
    if (line[cursor] !== ESC2) {
      cursor += 1;
      continue;
    }
    appendText(line.slice(textStart, cursor));
    const next = line[cursor + 1];
    if (next === undefined) {
      cursor = line.length;
      textStart = cursor;
      break;
    }
    if (next === "[") {
      let end = cursor + 2;
      let aborted = false;
      while (end < line.length) {
        const code = line.charCodeAt(end);
        if (code === 27) {
          aborted = true;
          break;
        }
        if (code >= 64 && code <= 126)
          break;
        end += 1;
      }
      if (aborted) {
        cursor = end;
        textStart = cursor;
        continue;
      }
      if (end >= line.length) {
        cursor = line.length;
        textStart = cursor;
        break;
      }
      if (line[end] === "m")
        applySgrParams(line.slice(cursor + 2, end), st);
      cursor = end + 1;
      textStart = cursor;
      continue;
    }
    if (next === "]") {
      let end = cursor + 2;
      let after = line.length;
      let terminated = false;
      while (end < line.length) {
        if (line[end] === BEL2) {
          applyOscPayload(line.slice(cursor + 2, end), st);
          after = end + 1;
          terminated = true;
          break;
        }
        if (line[end] === ESC2 && line[end + 1] === ST2) {
          applyOscPayload(line.slice(cursor + 2, end), st);
          after = end + 2;
          terminated = true;
          break;
        }
        end += 1;
      }
      if (!terminated && line.slice(cursor + 2).startsWith("8;"))
        st.osc8Href = null;
      cursor = after;
      textStart = cursor;
      continue;
    }
    if (next === "(" || next === ")" || next === "*" || next === "+" || next === "-" || next === "." || next === "/" || next === "#" || next === "%") {
      const third = cursor + 2;
      if (third >= line.length || line.charCodeAt(third) === 27 || isSurrogatePairAt2(line, third)) {
        cursor = Math.min(line.length, third);
      } else {
        cursor = Math.min(line.length, cursor + 3);
      }
    } else if (line.charCodeAt(cursor + 1) === 27 || isSurrogatePairAt2(line, cursor + 1)) {
      cursor += 1;
    } else {
      cursor += 2;
    }
    textStart = cursor;
  }
  if (textStart < line.length)
    appendText(line.slice(textStart));
  return out || " ";
}
// src/search.ts
var MAX_PATTERN_UNITS = 256;
var MAX_MATCHES = 1e4;
var MAX_QUANT = 100;
function createError(code, message) {
  return { code, message };
}
function codePointWidth(s, offset) {
  const cp = s.codePointAt(offset);
  return cp !== undefined && cp > 65535 ? 2 : 1;
}
function sliceCodePoint(s, offset) {
  return s.slice(offset, offset + codePointWidth(s, offset));
}
function foldVisibleText(value) {
  let text = "";
  const starts = [];
  const ends = [];
  for (let offset = 0;offset < value.length; ) {
    const codePoint = value.codePointAt(offset);
    const width = codePoint !== undefined && codePoint > 65535 ? 2 : 1;
    const folded = value.slice(offset, offset + width).toLowerCase();
    text += folded;
    for (let unit = 0;unit < folded.length; unit += 1) {
      starts.push(offset);
      ends.push(offset + width);
    }
    offset += width;
  }
  return { text, starts, ends };
}
function parseEscapedChar(pattern, at) {
  const ch = pattern[at + 1];
  if (ch === undefined) {
    return { value: "", next: at, error: createError("malformed-pattern", "incomplete escape sequence") };
  }
  if (ch >= "0" && ch <= "9") {
    return {
      value: "",
      next: at,
      error: createError("unsupported-syntax", "backreference escapes are not supported")
    };
  }
  switch (ch) {
    case "n":
      return { value: `
`, next: at + 2, error: null };
    case "r":
      return { value: "\r", next: at + 2, error: null };
    case "t":
      return { value: "\t", next: at + 2, error: null };
    case "f":
      return { value: "\f", next: at + 2, error: null };
    case "v":
      return { value: "\v", next: at + 2, error: null };
    default:
      return { value: ch, next: at + 2, error: null };
  }
}
function parseClassEscapedChar(pattern, at) {
  if (at + 1 >= pattern.length) {
    return { value: -1, next: at, error: createError("malformed-pattern", "incomplete escaped class character") };
  }
  const ch = pattern[at + 1];
  if (ch >= "0" && ch <= "9") {
    return {
      value: -1,
      next: at,
      error: createError("unsupported-syntax", "backreference escapes are not supported")
    };
  }
  switch (ch) {
    case "n":
      return { value: 10, next: at + 2, error: null };
    case "r":
      return { value: 13, next: at + 2, error: null };
    case "t":
      return { value: 9, next: at + 2, error: null };
    case "f":
      return { value: 12, next: at + 2, error: null };
    case "v":
      return { value: 11, next: at + 2, error: null };
    default: {
      const cp = pattern.codePointAt(at + 1);
      const width = cp > 65535 ? 2 : 1;
      return { value: cp, next: at + 1 + width, error: null };
    }
  }
}
function parseQuantifier(pattern, at) {
  const ch = pattern[at];
  if (ch === "?") {
    return { quant: { min: 0, max: 1 }, next: at + 1, error: null };
  }
  if (ch === "*") {
    return { quant: { min: 0, max: null }, next: at + 1, error: null };
  }
  if (ch === "+") {
    return { quant: { min: 1, max: null }, next: at + 1, error: null };
  }
  if (ch !== "{") {
    return { quant: { min: 1, max: 1 }, next: at, error: null };
  }
  let i = at + 1;
  if (i >= pattern.length) {
    return { quant: { min: 1, max: 1 }, next: at, error: createError("malformed-pattern", "incomplete quantifier") };
  }
  const readNumber = (start) => {
    if (start >= pattern.length || pattern[start] < "0" || pattern[start] > "9")
      return null;
    let value = 0;
    let end = start;
    while (end < pattern.length && pattern[end] >= "0" && pattern[end] <= "9") {
      value = value * 10 + (pattern.charCodeAt(end) - 48);
      end += 1;
    }
    return { value, end };
  };
  const first = readNumber(i);
  if (first === null) {
    return {
      quant: { min: 1, max: 1 },
      next: at,
      error: createError("malformed-pattern", "invalid bounded quantifier")
    };
  }
  i = first.end;
  if (i < pattern.length && pattern[i] === "}") {
    const n = first.value;
    if (n > MAX_QUANT) {
      return {
        quant: { min: 1, max: 1 },
        next: at,
        error: createError("invalid-bound", `quantifier bound ${n} exceeds ${MAX_QUANT}`)
      };
    }
    return { quant: { min: n, max: n }, next: i + 1, error: null };
  }
  if (i >= pattern.length || pattern[i] !== ",") {
    return {
      quant: { min: 1, max: 1 },
      next: at,
      error: createError("malformed-pattern", "invalid bounded quantifier")
    };
  }
  const commaAfter = i + 1;
  const second = readNumber(commaAfter);
  if (second === null) {
    return {
      quant: { min: 1, max: 1 },
      next: at,
      error: createError("malformed-pattern", "invalid bounded quantifier")
    };
  }
  i = second.end;
  if (i >= pattern.length || pattern[i] !== "}") {
    return {
      quant: { min: 1, max: 1 },
      next: at,
      error: createError("malformed-pattern", "invalid bounded quantifier")
    };
  }
  const min = first.value;
  const max = second.value;
  if (max > MAX_QUANT || min > MAX_QUANT) {
    return {
      quant: { min: 1, max: 1 },
      next: at,
      error: createError("invalid-bound", `quantifier bound exceeds ${MAX_QUANT}`)
    };
  }
  if (min > max) {
    return {
      quant: { min: 1, max: 1 },
      next: at,
      error: createError("invalid-bound", "lower bound exceeds upper bound")
    };
  }
  return { quant: { min, max }, next: i + 1, error: null };
}
function parseCharClass(pattern, at) {
  let i = at + 1;
  const singles = [];
  const ranges = [];
  let count = 0;
  const pushRange = (low, high) => {
    if (low > high) {
      return createError("malformed-pattern", "invalid character class range");
    }
    ranges.push({ start: low, end: high });
  };
  while (i < pattern.length) {
    if (pattern[i] === "]") {
      if (count === 0) {
        return { node: null, next: i + 1, error: createError("malformed-pattern", "empty character class") };
      }
      return {
        node: {
          kind: "class",
          singles,
          ranges,
          quant: { min: 1, max: 1 }
        },
        next: i + 1,
        error: null
      };
    }
    let lowCode;
    if (pattern[i] === "\\") {
      const result = parseClassEscapedChar(pattern, i);
      if (result.error)
        return { node: null, next: at, error: result.error };
      lowCode = result.value;
      i = result.next;
    } else {
      lowCode = pattern.codePointAt(i);
      i += lowCode > 65535 ? 2 : 1;
    }
    count += 1;
    if (i < pattern.length && pattern[i] === "-" && i + 1 < pattern.length && pattern[i + 1] !== "]") {
      i += 1;
      let highCode;
      if (pattern[i] === "\\") {
        const result = parseClassEscapedChar(pattern, i);
        if (result.error)
          return { node: null, next: at, error: result.error };
        highCode = result.value;
        i = result.next;
      } else {
        highCode = pattern.codePointAt(i);
        i += highCode > 65535 ? 2 : 1;
      }
      const err = pushRange(lowCode, highCode);
      if (err)
        return { node: null, next: at, error: err };
      continue;
    }
    if (i < pattern.length && pattern[i] === "-") {
      return { node: null, next: at, error: createError("malformed-pattern", "invalid character class range") };
    }
    singles.push(lowCode);
  }
  return { node: null, next: pattern.length, error: createError("malformed-pattern", "unterminated character class") };
}
function parseRegexLite(query) {
  if (query.length > MAX_PATTERN_UNITS) {
    return { nodes: [], error: createError("pattern-too-long", `pattern exceeds ${MAX_PATTERN_UNITS} UTF-16 units`) };
  }
  const nodes = [];
  let i = 0;
  while (i < query.length) {
    const ch = query[i];
    let node = null;
    if (ch === "(" || ch === ")" || ch === "|") {
      return { nodes: [], error: createError("unsupported-syntax", "unsupported regex operator") };
    }
    if (ch === "*" || ch === "+" || ch === "?" || ch === "{" || ch === "}") {
      return {
        nodes: [],
        error: createError(ch === "{" || ch === "}" ? "malformed-pattern" : "unsupported-syntax", "quantifier without atom")
      };
    }
    if (ch === "^") {
      node = { kind: "start-anchor", quant: { min: 1, max: 1 } };
      i += 1;
    } else if (ch === "$") {
      node = { kind: "end-anchor", quant: { min: 1, max: 1 } };
      i += 1;
    } else if (ch === ".") {
      node = { kind: "dot", quant: { min: 1, max: 1 } };
      i += 1;
    } else if (ch === "[") {
      const result = parseCharClass(query, i);
      if (result.error)
        return { nodes: [], error: result.error };
      node = result.node;
      i = result.next;
    } else if (ch === "\\") {
      const result = parseEscapedChar(query, i);
      if (result.error)
        return { nodes: [], error: result.error };
      node = { kind: "literal", value: result.value, quant: { min: 1, max: 1 } };
      i = result.next;
    } else {
      const cp = query.codePointAt(i);
      const width = cp > 65535 ? 2 : 1;
      node = { kind: "literal", value: query.slice(i, i + width), quant: { min: 1, max: 1 } };
      i += width;
    }
    if (node === null) {
      return { nodes: [], error: createError("malformed-pattern", "unable to parse pattern") };
    }
    if (i < query.length) {
      const q = query[i];
      if (q === "?" || q === "*" || q === "+" || q === "{") {
        const qResult = parseQuantifier(query, i);
        if (qResult.error)
          return { nodes: [], error: qResult.error };
        if (node.kind === "start-anchor" || node.kind === "end-anchor") {
          return { nodes: [], error: createError("unsupported-syntax", "anchored token cannot be quantified") };
        }
        node = { ...node, quant: qResult.quant };
        i = qResult.next;
      }
    }
    nodes.push(node);
  }
  if (nodes.length === 0) {
    return { nodes: [], error: createError("malformed-pattern", "empty pattern") };
  }
  return { nodes, error: null };
}
function classMatches(node, ch, caseSensitive) {
  const code = ch.codePointAt(0);
  if (caseSensitive) {
    for (let i = 0;i < node.ranges.length; i += 1) {
      const range = node.ranges[i];
      if (code >= range.start && code <= range.end)
        return true;
    }
    for (let i = 0;i < node.singles.length; i += 1) {
      if (node.singles[i] === code)
        return true;
    }
    return false;
  }
  const left = ch.toLowerCase();
  for (let i = 0;i < node.ranges.length; i += 1) {
    const range = node.ranges[i];
    if (code >= range.start && code <= range.end)
      return true;
    const foldedStart = String.fromCodePoint(range.start).toLowerCase();
    const foldedEnd = String.fromCodePoint(range.end).toLowerCase();
    if (left >= foldedStart && left <= foldedEnd)
      return true;
  }
  for (let i = 0;i < node.singles.length; i += 1) {
    const item = String.fromCodePoint(node.singles[i]);
    if (item.toLowerCase() === left)
      return true;
  }
  return false;
}
function literalMatches(value, ch, caseSensitive) {
  return caseSensitive ? value === ch : value.toLowerCase() === ch.toLowerCase();
}
function consumeMatches(node, ch, caseSensitive) {
  switch (node.kind) {
    case "dot":
      return ch !== "";
    case "literal":
      return literalMatches(node.value, ch, caseSensitive);
    case "class":
      return classMatches(node, ch, caseSensitive);
    default:
      return false;
  }
}
function buildStateTables(nodes) {
  const stateToken = [];
  const stateRep = [];
  const firstStateForToken = [];
  for (let i = 0;i < nodes.length; i += 1) {
    firstStateForToken[i] = stateToken.length;
    const max = nodes[i].quant.max;
    const repCount = max === null ? 2 : max + 1;
    for (let rep = 0;rep < repCount; rep += 1) {
      stateToken.push(i);
      stateRep.push(rep);
    }
  }
  return {
    stateToken,
    stateRep,
    firstStateForToken,
    acceptState: stateToken.length
  };
}
function addState(id, closureStack, seen, visitTag) {
  if (seen[id] === visitTag)
    return;
  closureStack.push(id);
}
function epsilonClose(initial, lineLen, pos, nodes, tables, seen, visitTag) {
  const out = [];
  const stack = [...initial];
  while (stack.length > 0) {
    const id = stack.pop();
    if (seen[id] === visitTag)
      continue;
    seen[id] = visitTag;
    if (id === tables.acceptState) {
      out.push(id);
      continue;
    }
    const tokenIndex = tables.stateToken[id];
    const repeats = tables.stateRep[id];
    const node = nodes[tokenIndex];
    if (node.kind === "start-anchor") {
      if (pos === 0) {
        if (tokenIndex + 1 >= nodes.length) {
          addState(tables.acceptState, stack, seen, visitTag);
        } else {
          addState(tables.firstStateForToken[tokenIndex + 1], stack, seen, visitTag);
        }
      }
      continue;
    }
    if (node.kind === "end-anchor") {
      if (pos === lineLen) {
        if (tokenIndex + 1 >= nodes.length) {
          addState(tables.acceptState, stack, seen, visitTag);
        } else {
          addState(tables.firstStateForToken[tokenIndex + 1], stack, seen, visitTag);
        }
      }
      continue;
    }
    out.push(id);
    if (repeats >= node.quant.min) {
      if (tokenIndex + 1 >= nodes.length) {
        addState(tables.acceptState, stack, seen, visitTag);
      } else {
        addState(tables.firstStateForToken[tokenIndex + 1], stack, seen, visitTag);
      }
    }
  }
  return out;
}
function nextRepeat(node, repeat) {
  if (node.quant.max === null) {
    return 1;
  }
  if (repeat < node.quant.max)
    return repeat + 1;
  return null;
}
function isConsumingNode(node) {
  return node.kind === "dot" || node.kind === "literal" || node.kind === "class";
}
function requiredSequencePossible(line, nodes, caseSensitive) {
  let cursor = 0;
  for (const node of nodes) {
    if (!isConsumingNode(node) || node.quant.min === 0)
      continue;
    for (let repeat = 0;repeat < node.quant.min; repeat += 1) {
      while (cursor < line.length && !consumeMatches(node, sliceCodePoint(line, cursor), caseSensitive)) {
        cursor += codePointWidth(line, cursor);
      }
      if (cursor >= line.length)
        return false;
      cursor += codePointWidth(line, cursor);
    }
  }
  return true;
}
function latestPossibleStart(line, nodes, caseSensitive) {
  let latestStart = null;
  for (const node of nodes) {
    if (!isConsumingNode(node) || node.quant.min === 0)
      continue;
    let last = -1;
    for (let offset = 0;offset < line.length; ) {
      const w = codePointWidth(line, offset);
      if (consumeMatches(node, line.slice(offset, offset + w), caseSensitive))
        last = offset;
      offset += w;
    }
    if (last < 0)
      return -1;
    latestStart = latestStart === null ? last : Math.min(latestStart, last);
  }
  return latestStart;
}
function endAnchorCanMatchLineEnd(line, nodes, caseSensitive) {
  if (line.length === 0)
    return true;
  let lastStart = 0;
  for (let o = 0;o < line.length; ) {
    lastStart = o;
    o += codePointWidth(line, o);
  }
  const finalUnit = line.slice(lastStart);
  let suffixRequiresConsumption = false;
  let hasCandidate = false;
  for (let index = nodes.length - 1;index >= 0; index -= 1) {
    const node = nodes[index];
    if (!isConsumingNode(node))
      continue;
    if (!suffixRequiresConsumption && node.quant.max !== 0) {
      hasCandidate = true;
      if (consumeMatches(node, finalUnit, caseSensitive))
        return true;
    }
    if (node.quant.min > 0)
      suffixRequiresConsumption = true;
  }
  return !hasCandidate;
}
function containsEndAnchor(nodes) {
  for (const node of nodes)
    if (node.kind === "end-anchor")
      return true;
  return false;
}
function containsStartAnchor(nodes) {
  for (const node of nodes)
    if (node.kind === "start-anchor")
      return true;
  return false;
}
function containsAcceptState(states, acceptState) {
  for (const state of states)
    if (state === acceptState)
      return true;
  return false;
}
function advanceVisitTag(seen, visitTag) {
  if (visitTag >= 4294967294) {
    seen.fill(0);
    return 1;
  }
  return visitTag + 1;
}
function collectRegexMatches(line, nodes, caseSensitive, lineIndex, limitState, tables, seen, transitionSeen) {
  if (!requiredSequencePossible(line, nodes, caseSensitive))
    return;
  if (containsEndAnchor(nodes) && !endAnchorCanMatchLineEnd(line, nodes, caseSensitive))
    return;
  let visitTag = 1;
  let transitionTag = 1;
  seen.fill(0);
  transitionSeen.fill(0);
  const lineLen = line.length;
  const startUpperBound = latestPossibleStart(line, nodes, caseSensitive);
  const startAnchored = containsStartAnchor(nodes);
  let start = 0;
  while (start < lineLen && !limitState.limitReached) {
    if (startAnchored && start > 0)
      break;
    if (startUpperBound !== null && start > startUpperBound)
      break;
    const initialId = tables.firstStateForToken[0];
    let states = [initialId];
    let bestEnd = -1;
    let pos = start;
    while (pos <= lineLen) {
      states = epsilonClose(states, lineLen, pos, nodes, tables, seen, visitTag);
      visitTag = advanceVisitTag(seen, visitTag);
      if (pos > start && containsAcceptState(states, tables.acceptState)) {
        bestEnd = pos;
      }
      if (pos === lineLen || states.length === 0)
        break;
      const w = codePointWidth(line, pos);
      const ch = line.slice(pos, pos + w);
      const nextStates = [];
      for (let j = 0;j < states.length; j += 1) {
        const id = states[j];
        if (id === tables.acceptState)
          continue;
        const tokenIndex = tables.stateToken[id];
        const repeat = tables.stateRep[id];
        const node = nodes[tokenIndex];
        if (node.kind !== "dot" && node.kind !== "literal" && node.kind !== "class")
          continue;
        if (!consumeMatches(node, ch, caseSensitive))
          continue;
        const progressed = nextRepeat(node, repeat);
        if (progressed === null)
          continue;
        const nextId = tables.firstStateForToken[tokenIndex] + progressed;
        if (!Number.isFinite(nextId))
          continue;
        if (transitionSeen[nextId] !== transitionTag) {
          transitionSeen[nextId] = transitionTag;
          nextStates.push(nextId);
        }
      }
      states = nextStates;
      if (states.length === 0)
        break;
      transitionTag = advanceVisitTag(transitionSeen, transitionTag);
      pos += w;
    }
    if (bestEnd > start) {
      if (limitState.matches.length >= MAX_MATCHES) {
        limitState.limitReached = true;
        break;
      }
      limitState.matches.push({ line: lineIndex, start, end: bestEnd });
      start = bestEnd;
    } else {
      start += codePointWidth(line, start);
    }
  }
}
function isPureAscii(s) {
  for (let i = 0;i < s.length; i += 1) {
    if (s.charCodeAt(i) > 127)
      return false;
  }
  return true;
}
function collectPlainMatches(line, needle, caseSensitive, lineIndex, limitState) {
  if (!caseSensitive && isPureAscii(line)) {
    const haystack2 = line.toLowerCase();
    const queryLen2 = needle.length;
    let pos2 = 0;
    while (true) {
      if (limitState.limitReached)
        break;
      if (pos2 + queryLen2 > haystack2.length)
        break;
      const found = haystack2.indexOf(needle, pos2);
      if (found < 0)
        break;
      if (limitState.matches.length >= MAX_MATCHES) {
        limitState.limitReached = true;
        break;
      }
      const end = found + queryLen2;
      if (end > found) {
        limitState.matches.push({ line: lineIndex, start: found, end });
      }
      pos2 = found + 1;
    }
    return;
  }
  const folded = caseSensitive ? null : foldVisibleText(line);
  const haystack = caseSensitive ? line : folded.text;
  const queryLen = needle.length;
  let pos = 0;
  while (true) {
    if (limitState.limitReached)
      break;
    if (pos + queryLen > haystack.length)
      break;
    const found = haystack.indexOf(needle, pos);
    if (found < 0)
      break;
    if (limitState.matches.length >= MAX_MATCHES) {
      limitState.limitReached = true;
      break;
    }
    const start = caseSensitive ? found : folded.starts[found];
    const end = caseSensitive ? found + queryLen : folded.ends[found + queryLen - 1];
    if (start !== undefined && end !== undefined && end > start) {
      limitState.matches.push({ line: lineIndex, start, end });
    }
    pos = found + 1;
  }
}
function searchLines(rawLines, query, options) {
  if (query.length === 0) {
    return {
      matches: [],
      error: createError("empty-query", "query cannot be empty")
    };
  }
  if (query.length > MAX_PATTERN_UNITS) {
    return {
      matches: [],
      error: createError("pattern-too-long", `query exceeds ${MAX_PATTERN_UNITS} UTF-16 units`)
    };
  }
  const mode = options?.mode ?? "plain";
  const caseSensitive = options?.caseSensitive ?? false;
  const limitState = {
    limitReached: false,
    matches: []
  };
  if (mode === "plain") {
    const needle = caseSensitive ? query : query.toLowerCase();
    for (let line = 0;line < rawLines.length; line += 1) {
      if (limitState.limitReached)
        break;
      const visible = stripTerminalControls(rawLines[line]);
      collectPlainMatches(visible, needle, caseSensitive, line, limitState);
    }
    return {
      matches: limitState.matches,
      error: limitState.limitReached ? createError("result-limit", "too many matches") : null
    };
  }
  if (mode !== "regex-lite") {
    return {
      matches: [],
      error: createError("unsupported-syntax", "unsupported search mode")
    };
  }
  const parse = parseRegexLite(query);
  if (parse.error) {
    return { matches: [], error: parse.error };
  }
  const tables = buildStateTables(parse.nodes);
  const seen = new Uint32Array(tables.acceptState + 1);
  const transitionSeen = new Uint32Array(tables.acceptState + 1);
  for (let line = 0;line < rawLines.length; line += 1) {
    if (limitState.limitReached)
      break;
    const visible = stripTerminalControls(rawLines[line]);
    collectRegexMatches(visible, parse.nodes, caseSensitive, line, limitState, tables, seen, transitionSeen);
  }
  return {
    matches: limitState.matches,
    error: limitState.limitReached ? createError("result-limit", "too many matches") : null
  };
}
// src/protocol.ts
function splitMuxOutputData(data) {
  return data.split(`
`);
}
var UTF8_ENCODER = new TextEncoder;
function fnv1a32(value) {
  const bytes = UTF8_ENCODER.encode(value);
  let hash = 2166136261;
  for (let i = 0;i < bytes.length; i++) {
    hash ^= bytes[i];
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
function muxPrefixHash(lines) {
  return fnv1a32(JSON.stringify(lines));
}
function muxCommonPrefixLength(base, next) {
  const limit = Math.min(base.length, next.length);
  let prefix = 0;
  while (prefix < limit && base[prefix] === next[prefix])
    prefix += 1;
  return prefix;
}
function createMuxDeltaFrame(channel, base, next, cursor) {
  const prefix = muxCommonPrefixLength(base, next);
  const frame = {
    channel,
    type: "delta",
    baseLength: base.length,
    prefix,
    prefixHash: muxPrefixHash(base.slice(0, prefix)),
    lines: next.slice(prefix)
  };
  if (cursor !== undefined)
    frame.cursor = cursor;
  return frame;
}
function isMuxCursor(value) {
  if (value === null)
    return true;
  if (typeof value !== "object" || value === null)
    return false;
  const cursor = value;
  return Number.isInteger(cursor.row) && Number.isInteger(cursor.col) && cursor.col >= 0;
}
function isMuxPaneScreen(value) {
  if (value === null)
    return true;
  if (typeof value !== "object" || value === null)
    return false;
  const screen = value;
  return typeof screen.alt === "boolean" && typeof screen.mouseSgr === "boolean" && typeof screen.mouseAny === "boolean";
}
function validateMuxHistoryBoundary(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return null;
  const boundary = value;
  if (typeof boundary.generation !== "string" || boundary.generation.length === 0 || boundary.generation.length > 256 || !Number.isSafeInteger(boundary.liveStartLine) || boundary.liveStartLine < 0 || typeof boundary.walSequence !== "string" || !/^(0|[1-9][0-9]{0,19})$/.test(boundary.walSequence) || !Number.isSafeInteger(boundary.walOffset) || boundary.walOffset < 0)
    return null;
  return {
    generation: boundary.generation,
    liveStartLine: boundary.liveStartLine,
    walSequence: boundary.walSequence,
    walOffset: boundary.walOffset
  };
}
function compareDecimalStrings(left, right) {
  if (left.length !== right.length)
    return left.length < right.length ? -1 : 1;
  if (left === right)
    return 0;
  return left < right ? -1 : 1;
}
function muxHistoryBoundaryTransition(previous, next) {
  if (previous.generation !== next.generation)
    return "generation-mismatch";
  const sequenceOrder = compareDecimalStrings(previous.walSequence, next.walSequence);
  const offsetOrder = Math.sign(next.walOffset - previous.walOffset);
  if (next.liveStartLine < previous.liveStartLine || sequenceOrder > 0 || offsetOrder < 0 || sequenceOrder === 0 !== (offsetOrder === 0) || next.liveStartLine > previous.liveStartLine && sequenceOrder === 0)
    return "regression";
  return next.liveStartLine === previous.liveStartLine && sequenceOrder === 0 && next.walOffset === previous.walOffset ? "same" : "advance";
}
function validateMuxDeltaFrame(frame, base) {
  if (typeof frame !== "object" || frame === null)
    return null;
  const candidate = frame;
  if (candidate.channel === undefined || typeof candidate.channel !== "string")
    return null;
  if (candidate.type !== "delta")
    return null;
  const baseLength = candidate.baseLength;
  const prefix = candidate.prefix;
  if (typeof baseLength !== "number" || !Number.isInteger(baseLength) || baseLength !== base.length)
    return null;
  if (typeof prefix !== "number" || !Number.isInteger(prefix) || prefix < 0 || prefix > base.length)
    return null;
  if (typeof candidate.prefixHash !== "string")
    return null;
  if (candidate.prefixHash !== muxPrefixHash(base.slice(0, prefix)))
    return null;
  if (!Array.isArray(candidate.lines) || !candidate.lines.every((line) => typeof line === "string"))
    return null;
  if (Object.prototype.hasOwnProperty.call(candidate, "cursor") && !isMuxCursor(candidate.cursor)) {
    return null;
  }
  if (Object.prototype.hasOwnProperty.call(candidate, "screen") && !isMuxPaneScreen(candidate.screen)) {
    return null;
  }
  if (Object.prototype.hasOwnProperty.call(candidate, "boundary") && validateMuxHistoryBoundary(candidate.boundary) === null)
    return null;
  return candidate;
}
function applyMuxDelta(base, frame) {
  const delta = validateMuxDeltaFrame(frame, base);
  return delta ? base.slice(0, delta.prefix).concat(delta.lines) : null;
}
function utf8Size(value) {
  return new TextEncoder().encode(value).byteLength;
}
function serializedMuxFrameSize(frame) {
  return utf8Size(JSON.stringify(frame));
}
function shouldUseMuxDelta(full, delta) {
  return full.reset === undefined && delta.prefix > 0 && serializedMuxFrameSize(delta) < serializedMuxFrameSize(full);
}
function chooseMuxOutputFrame(full, base) {
  const delta = createMuxDeltaFrame(full.channel, base, splitMuxOutputData(full.data), full.cursor);
  if (full.screen !== undefined)
    delta.screen = full.screen;
  if (full.boundary !== undefined)
    delta.boundary = full.boundary;
  return shouldUseMuxDelta(full, delta) ? delta : full;
}

// src/replay.ts
var SEEK_SNAPSHOT_STRIDE = 64;

class ReplayJournal {
  session;
  records;
  checkpoints;
  seekSnapshots;
  firstAt;
  lastAt;
  lastState = null;
  constructor(session, records, checkpoints, seekSnapshots) {
    this.session = session;
    this.records = records;
    this.checkpoints = checkpoints;
    this.seekSnapshots = seekSnapshots;
    this.firstAt = records[0].at;
    this.lastAt = records[records.length - 1].at;
  }
  static fromValidated(session, records, checkpoints, seekSnapshots) {
    const snapshots = seekSnapshots ?? checkpoints.map((checkpoint) => ({
      recordIndex: checkpoint.recordIndex,
      lines: checkpoint.lines,
      cursor: cloneCursor(checkpoint.frame.cursor)
    }));
    return new ReplayJournal(session, records, checkpoints, snapshots);
  }
  get durationMs() {
    return this.lastAt - this.firstAt;
  }
  get startAt() {
    return this.firstAt;
  }
  get endAt() {
    return this.lastAt;
  }
  get sessionName() {
    return this.session;
  }
  get count() {
    return this.records.length;
  }
  get checkpointCount() {
    return this.checkpoints.length;
  }
  get fullCheckpoints() {
    return this.checkpoints.map((checkpoint) => ({
      ...checkpoint,
      frame: cloneFullFrame(checkpoint.frame),
      lines: checkpoint.lines.slice()
    }));
  }
  getFrameAt(time) {
    return this.seek(time).frame;
  }
  getLinesAt(time) {
    return this.seek(time).lines;
  }
  getRawLineAt(time) {
    return this.seek(time).rawLine;
  }
  seek(time) {
    if (!Number.isFinite(time)) {
      throw new Error(`Cannot seek with non-finite time: ${String(time)}`);
    }
    const recordIndex = this.findRecordIndexByTime(time);
    const record = this.records[recordIndex];
    const state = this.reconstructState(recordIndex);
    const selectedFrame = record.record.frame;
    const frame = makeFrameFromReconstruction(this.session, state.lines, state.cursor);
    if (selectedFrame.type === "output" && Object.prototype.hasOwnProperty.call(selectedFrame, "reset")) {
      frame.reset = selectedFrame.reset;
    }
    return {
      at: record.record.at,
      recordIndex,
      frame,
      lines: state.lines.slice(),
      rawLine: record.rawLine
    };
  }
  findRecordIndexByTime(time) {
    if (time < this.firstAt)
      return 0;
    if (time >= this.lastAt)
      return this.records.length - 1;
    let low = 0;
    let high = this.records.length - 1;
    while (low < high) {
      const mid = Math.floor((low + high + 1) / 2);
      if (this.records[mid].at <= time) {
        low = mid;
      } else {
        high = mid - 1;
      }
    }
    return low;
  }
  reconstructState(recordIndex) {
    if (this.checkpoints.length === 0) {
      throw new Error("Replay has no full-frame checkpoints.");
    }
    const snapshot = this.findSeekSnapshotForRecordIndex(recordIndex);
    let startIndex;
    let lines;
    let cursor;
    if (this.lastState !== null && this.lastState.recordIndex <= recordIndex && this.lastState.recordIndex >= snapshot.recordIndex) {
      startIndex = this.lastState.recordIndex;
      lines = this.lastState.lines;
      cursor = cloneCursor(this.lastState.cursor);
    } else {
      startIndex = snapshot.recordIndex;
      lines = snapshot.lines.slice();
      cursor = cloneCursor(snapshot.cursor);
    }
    for (let i = startIndex + 1;i <= recordIndex; i += 1) {
      const frame = this.records[i].record.frame;
      if (frame.type === "output") {
        lines = splitMuxOutputData(frame.data);
        cursor = cloneCursor(frame.cursor);
        continue;
      }
      const next = applyMuxDelta(lines, frame);
      if (!next) {
        throw new Error(`Reconstruction invariant broken at record ${i} (${this.records[i].at})`);
      }
      if (Object.prototype.hasOwnProperty.call(frame, "cursor")) {
        cursor = cloneCursor(frame.cursor);
      }
      lines = next;
    }
    const resultCursor = cloneCursor(cursor);
    this.lastState = {
      recordIndex,
      lines,
      cursor: resultCursor
    };
    return { lines, cursor: resultCursor };
  }
  findSeekSnapshotForRecordIndex(recordIndex) {
    let low = 0;
    let high = this.seekSnapshots.length - 1;
    while (low < high) {
      const mid = Math.floor((low + high + 1) / 2);
      if (this.seekSnapshots[mid].recordIndex <= recordIndex) {
        low = mid;
      } else {
        high = mid - 1;
      }
    }
    return this.seekSnapshots[low];
  }
}
function parseReplayJournal(source) {
  const parsedRecords = [];
  const checkpoints = [];
  const seekSnapshots = [];
  const lines = splitCompleteNdjsonLines(source);
  if (lines.length === 0) {
    throw new Error("Journal contains no complete NDJSON records.");
  }
  let activeSession = null;
  let currentBase = null;
  let currentCursor;
  let previousAt = Number.NEGATIVE_INFINITY;
  for (let index = 0;index < lines.length; index += 1) {
    const rawLine = lines[index];
    const physicalLine = index + 1;
    if (rawLine.length === 0) {
      throw new Error(`Malformed blank line at NDJSON line ${physicalLine}.`);
    }
    const record = parseJournalRecord(rawLine, physicalLine);
    if (activeSession === null) {
      activeSession = record.session;
    } else if (record.session !== activeSession) {
      throw new Error(`Session mismatch at NDJSON line ${physicalLine}: expected "${activeSession}", got "${record.session}".`);
    }
    if (record.frame.channel !== record.session) {
      throw new Error(`Session/channel mismatch at NDJSON line ${physicalLine}: record.session="${record.session}" but frame.channel="${record.frame.channel}".`);
    }
    if (!Number.isFinite(record.at)) {
      throw new Error(`Invalid at timestamp at NDJSON line ${physicalLine}: must be finite.`);
    }
    if (record.at < previousAt) {
      throw new Error(`Out-of-order timestamp at NDJSON line ${physicalLine}: ${record.at} < ${previousAt}.`);
    }
    previousAt = record.at;
    if (index === 0 && record.frame.type === "delta") {
      throw new Error(`Invalid first record at NDJSON line ${physicalLine}: journal must start with a full frame.`);
    }
    parsedRecords.push({
      at: record.at,
      record,
      rawLine
    });
    if (record.frame.type === "output") {
      const fullLines = splitMuxOutputData(record.frame.data);
      currentBase = fullLines;
      currentCursor = record.frame.cursor;
      checkpoints.push({
        recordIndex: index,
        at: record.at,
        frame: cloneFullFrame(record.frame),
        lines: fullLines.slice(),
        rawLine
      });
      seekSnapshots.push({
        recordIndex: index,
        lines: currentBase,
        cursor: cloneCursor(currentCursor)
      });
      continue;
    }
    if (currentBase === null) {
      throw new Error(`Invalid delta at NDJSON line ${physicalLine}: no prior full frame available.`);
    }
    const delta = validateMuxDeltaFrame(record.frame, currentBase);
    if (!delta) {
      throw new Error(`Invalid delta at NDJSON line ${physicalLine}: does not validate against current base.`);
    }
    const candidateNext = applyMuxDelta(currentBase, delta);
    if (!candidateNext) {
      throw new Error(`Invalid delta at NDJSON line ${physicalLine}: apply failed against current base.`);
    }
    const nextCursor = Object.prototype.hasOwnProperty.call(delta, "cursor") ? delta.cursor : currentCursor;
    const candidateFull = {
      channel: activeSession,
      type: "output",
      data: candidateNext.join(`
`)
    };
    if (Object.prototype.hasOwnProperty.call(delta, "cursor")) {
      candidateFull.cursor = cloneCursor(delta.cursor);
    }
    if (!shouldUseMuxDelta(candidateFull, delta)) {
      throw new Error(`Invalid delta at NDJSON line ${physicalLine}: candidate delta is not eligible under strict protocol size semantics.`);
    }
    currentBase = candidateNext;
    currentCursor = nextCursor;
    if (index % SEEK_SNAPSHOT_STRIDE === 0) {
      seekSnapshots.push({
        recordIndex: index,
        lines: currentBase,
        cursor: cloneCursor(currentCursor)
      });
    }
  }
  if (activeSession === null) {
    throw new Error("Journal contains no complete NDJSON records.");
  }
  return ReplayJournal.fromValidated(activeSession, parsedRecords, checkpoints, seekSnapshots);
}
function splitCompleteNdjsonLines(source) {
  const lines = [];
  let start = 0;
  while (true) {
    const newline = source.indexOf(`
`, start);
    if (newline === -1)
      break;
    lines.push(source.slice(start, newline));
    start = newline + 1;
  }
  return lines;
}
function makeFrameFromReconstruction(channel, lines, cursor) {
  const frame = {
    channel,
    type: "output",
    data: lines.join(`
`)
  };
  if (cursor !== undefined) {
    frame.cursor = cloneCursor(cursor);
  }
  return frame;
}
function parseJournalRecord(rawLine, lineNo) {
  let parsed;
  try {
    parsed = JSON.parse(rawLine);
  } catch (error) {
    throw new Error(`Malformed JSON at NDJSON line ${lineNo}: ${error instanceof Error ? error.message : "invalid JSON."}`);
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`Invalid record at NDJSON line ${lineNo}: must be an object.`);
  }
  const record = parsed;
  const keyCount = Object.keys(record).length;
  const expectedKeys = new Set(["v", "session", "at", "frame"]);
  if (keyCount !== expectedKeys.size) {
    throw new Error(`Invalid record shape at NDJSON line ${lineNo}: must contain exactly v, session, at, frame.`);
  }
  for (const key of expectedKeys) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) {
      throw new Error(`Invalid record shape at NDJSON line ${lineNo}: missing "${key}".`);
    }
  }
  if (record.v !== 1) {
    throw new Error(`Invalid journal version at NDJSON line ${lineNo}: expected 1.`);
  }
  if (typeof record.session !== "string") {
    throw new Error(`Invalid session at NDJSON line ${lineNo}: expected a string session.`);
  }
  if (typeof record.at !== "number" || !Number.isFinite(record.at)) {
    throw new Error(`Invalid at at NDJSON line ${lineNo}: expected a finite number.`);
  }
  const frame = parseFrame(record.frame, lineNo, record.session);
  return {
    v: 1,
    session: record.session,
    at: record.at,
    frame
  };
}
function parseFrame(value, lineNo, session) {
  if (typeof value !== "object" || value === null) {
    throw new Error(`Invalid frame at NDJSON line ${lineNo}: must be an object.`);
  }
  const frame = value;
  if (frame.type === undefined) {
    throw new Error(`Invalid frame at NDJSON line ${lineNo}: missing "type".`);
  }
  if (frame.type === "output") {
    return parseFullOutputFrame(frame, lineNo, session);
  }
  if (frame.type === "delta") {
    return parseRawDeltaFrame(frame, lineNo, session);
  }
  throw new Error(`Invalid frame at NDJSON line ${lineNo}: unsupported frame type "${String(frame.type)}".`);
}
function parseFullOutputFrame(frame, lineNo, session) {
  const required = ["channel", "type", "data"];
  const allowed = new Set(["channel", "type", "data", "cursor", "reset"]);
  for (const key of Object.keys(frame)) {
    if (!allowed.has(key)) {
      throw new Error(`Invalid full frame keys at NDJSON line ${lineNo}: unexpected property "${key}".`);
    }
  }
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(frame, key)) {
      throw new Error(`Invalid full frame at NDJSON line ${lineNo}: missing "${key}".`);
    }
  }
  if (typeof frame.channel !== "string" || frame.channel !== session) {
    throw new Error(`Invalid full frame at NDJSON line ${lineNo}: channel must equal record.session.`);
  }
  if (frame.type !== "output") {
    throw new Error(`Invalid full frame at NDJSON line ${lineNo}: expected type "output".`);
  }
  if (typeof frame.data !== "string") {
    throw new Error(`Invalid full frame at NDJSON line ${lineNo}: data must be a string.`);
  }
  let reset;
  if (Object.prototype.hasOwnProperty.call(frame, "reset")) {
    const candidateReset = frame.reset;
    if (candidateReset !== "resize" && candidateReset !== "resync") {
      throw new Error(`Invalid full frame at NDJSON line ${lineNo}: reset must be "resize" or "resync".`);
    }
    reset = candidateReset;
  }
  const cursor = parseOptionalCursor(frame, lineNo, "full frame");
  const outputFrame = {
    channel: frame.channel,
    type: "output",
    data: frame.data
  };
  if (cursor !== undefined) {
    outputFrame.cursor = cursor;
  }
  if (reset !== undefined) {
    outputFrame.reset = reset;
  }
  return outputFrame;
}
function parseRawDeltaFrame(frame, lineNo, session) {
  const required = ["channel", "type", "baseLength", "prefix", "prefixHash", "lines"];
  const allowed = new Set(["channel", "type", "baseLength", "prefix", "prefixHash", "lines", "cursor"]);
  for (const key of Object.keys(frame)) {
    if (!allowed.has(key)) {
      throw new Error(`Invalid delta frame keys at NDJSON line ${lineNo}: unexpected property "${key}".`);
    }
  }
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(frame, key)) {
      throw new Error(`Invalid delta frame at NDJSON line ${lineNo}: missing "${key}".`);
    }
  }
  if (typeof frame.channel !== "string" || frame.channel !== session) {
    throw new Error(`Invalid delta frame at NDJSON line ${lineNo}: channel must equal record.session.`);
  }
  if (frame.type !== "delta") {
    throw new Error(`Invalid delta frame at NDJSON line ${lineNo}: expected type "delta".`);
  }
  if (typeof frame.baseLength !== "number" || !Number.isInteger(frame.baseLength) || frame.baseLength < 0) {
    throw new Error(`Invalid delta frame at NDJSON line ${lineNo}: baseLength must be a non-negative integer.`);
  }
  if (typeof frame.prefix !== "number" || !Number.isInteger(frame.prefix) || frame.prefix < 0) {
    throw new Error(`Invalid delta frame at NDJSON line ${lineNo}: prefix must be a non-negative integer.`);
  }
  if (typeof frame.prefixHash !== "string") {
    throw new Error(`Invalid delta frame at NDJSON line ${lineNo}: prefixHash must be a string.`);
  }
  if (!Array.isArray(frame.lines) || frame.lines.some((line) => typeof line !== "string")) {
    throw new Error(`Invalid delta frame at NDJSON line ${lineNo}: lines must be string[].`);
  }
  const cursor = parseOptionalCursor(frame, lineNo, "delta frame");
  const deltaFrame = {
    channel: frame.channel,
    type: "delta",
    baseLength: frame.baseLength,
    prefix: frame.prefix,
    prefixHash: frame.prefixHash,
    lines: frame.lines.slice()
  };
  if (cursor !== undefined) {
    deltaFrame.cursor = cursor;
  }
  return deltaFrame;
}
function isMuxCursor2(value) {
  if (value === null)
    return true;
  if (typeof value !== "object" || Array.isArray(value))
    return false;
  const cursor = value;
  const keys = Object.keys(cursor);
  return keys.length === 2 && Object.prototype.hasOwnProperty.call(cursor, "row") && Object.prototype.hasOwnProperty.call(cursor, "col") && Number.isInteger(cursor.row) && Number.isInteger(cursor.col);
}
function parseOptionalCursor(frame, lineNo, frameKind) {
  if (!Object.prototype.hasOwnProperty.call(frame, "cursor"))
    return;
  const cursor = frame.cursor;
  if (!isMuxCursor2(cursor)) {
    throw new Error(`Invalid ${frameKind} at NDJSON line ${lineNo}: cursor must be {row:number,col:number} or null.`);
  }
  return cloneCursor(cursor);
}
function cloneFullFrame(frame) {
  const next = {
    channel: frame.channel,
    type: "output",
    data: frame.data
  };
  if (Object.prototype.hasOwnProperty.call(frame, "cursor")) {
    next.cursor = cloneCursor(frame.cursor);
  }
  if (Object.prototype.hasOwnProperty.call(frame, "reset")) {
    next.reset = frame.reset;
  }
  return next;
}
function cloneCursor(cursor) {
  if (cursor === null || cursor === undefined)
    return cursor;
  return { row: cursor.row, col: cursor.col };
}
// src/notification.ts
var AGENT_NOTIFICATION_LIMITS = Object.freeze({
  id: 128,
  session: 256,
  state: Object.freeze(["finished", "waiting"]),
  title: 160,
  body: 4096,
  tag: 128,
  url: 2048,
  occurredAtMin: 0,
  occurredAtMax: 8640000000000000
});

class AgentNotificationValidationError extends Error {
  field;
  code;
  constructor(field, code, message) {
    super(message);
    this.name = "AgentNotificationValidationError";
    this.field = field;
    this.code = code;
    Object.setPrototypeOf(this, AgentNotificationValidationError.prototype);
  }
}
var ALLOWED_FIELDS = new Set([
  "id",
  "session",
  "state",
  "occurredAt",
  "title",
  "body",
  "url",
  "tag"
]);
function isOrdinaryObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
function countCodePoints(value) {
  let count = 0;
  for (const _ of value) {
    count += 1;
  }
  return count;
}
function trimNormalize(value) {
  return value.normalize("NFC").trim();
}
function requireOwnEnumerableDataFields(value) {
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== Object.keys(value).length) {
    throw new AgentNotificationValidationError("__root__", "invalid_record", "All fields must be own enumerable string data fields");
  }
  for (const key of ownKeys) {
    if (typeof key !== "string") {
      throw new AgentNotificationValidationError("__root__", "unknown_field", "Only own enumerable string fields are allowed");
    }
    if (!ALLOWED_FIELDS.has(key)) {
      throw new AgentNotificationValidationError(key, "unknown_field", `Unknown field ${key}`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || descriptor.get || descriptor.set) {
      throw new AgentNotificationValidationError(key, "invalid_field_accessor", `Field ${key} must be an own enumerable data field`);
    }
  }
}
function validateRequiredFields(value) {
  for (const field of ["id", "session", "state", "occurredAt"]) {
    if (!Object.prototype.hasOwnProperty.call(value, field)) {
      throw new AgentNotificationValidationError(field, "missing_required_field", `Missing required field ${field}`);
    }
  }
}
function normalizeStringField(value, field, maxCodePoints, required) {
  if (typeof value !== "string") {
    throw new AgentNotificationValidationError(field, "invalid_type", `Field ${field} must be a string`);
  }
  const normalized = trimNormalize(value);
  if (normalized === "") {
    if (required) {
      throw new AgentNotificationValidationError(field, "invalid_length", `Field ${field} must not be empty`);
    }
    return;
  }
  if (countCodePoints(normalized) > maxCodePoints) {
    throw new AgentNotificationValidationError(field, "invalid_length", `Field ${field} exceeds ${maxCodePoints} code points`);
  }
  return normalized;
}
function normalizeOptionalStringField(value, field, maxCodePoints) {
  if (!Object.prototype.hasOwnProperty.call(value, field))
    return;
  return normalizeStringField(value[field], field, maxCodePoints, false);
}
function parseEventState(value) {
  if (value === "finished" || value === "waiting") {
    return value;
  }
  throw new AgentNotificationValidationError("state", "invalid_state", 'state must be "finished" or "waiting"');
}
function parseOccurredAt(value) {
  if (typeof value !== "number" || !Number.isInteger(value) || !Number.isSafeInteger(value) || value < AGENT_NOTIFICATION_LIMITS.occurredAtMin || value > AGENT_NOTIFICATION_LIMITS.occurredAtMax) {
    throw new AgentNotificationValidationError("occurredAt", "invalid_timestamp", "occurredAt must be a safe integer in [0, 8640000000000000]");
  }
  return value;
}
function parseHttpOrigin(origin) {
  if (typeof origin !== "string")
    return null;
  const normalizedOrigin = trimNormalize(origin);
  let parsed;
  try {
    parsed = new URL(normalizedOrigin);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "" || parsed.pathname !== "/" || parsed.search !== "" || parsed.hash !== "") {
    return null;
  }
  return parsed;
}
function sameOriginNotificationUrlFromOrigin(candidate, origin) {
  if (typeof candidate !== "string" || typeof origin !== "string" || !candidate)
    return null;
  const normalizedOrigin = trimNormalize(origin);
  const trusted = parseHttpOrigin(normalizedOrigin);
  if (!trusted)
    return null;
  const normalizedCandidate = trimNormalize(candidate);
  if (normalizedCandidate === "")
    return null;
  if (normalizedCandidate.startsWith("//"))
    return null;
  if (countCodePoints(normalizedCandidate) > AGENT_NOTIFICATION_LIMITS.url)
    return null;
  let parsed;
  try {
    parsed = new URL(normalizedCandidate, trusted);
  } catch {
    return null;
  }
  if (parsed.username || parsed.password)
    return null;
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    return null;
  if (parsed.origin !== trusted.origin)
    return null;
  const canonical = `${parsed.pathname}${parsed.search}${parsed.hash}`;
  if (canonical.startsWith("//"))
    return null;
  return canonical;
}
function sameOriginNotificationUrl(candidate, origin) {
  return sameOriginNotificationUrlFromOrigin(candidate, origin);
}
function normalizeUrl(value, options) {
  if (typeof value !== "string") {
    throw new AgentNotificationValidationError("url", "invalid_type", "url must be a string");
  }
  const normalized = trimNormalize(value);
  if (normalized === "")
    return;
  if (countCodePoints(normalized) > AGENT_NOTIFICATION_LIMITS.url) {
    throw new AgentNotificationValidationError("url", "invalid_length", `url exceeds ${AGENT_NOTIFICATION_LIMITS.url} code points`);
  }
  if (typeof options.origin !== "string" || options.origin.trim() === "") {
    throw new AgentNotificationValidationError("url", "invalid_url", "url is present but options.origin is missing");
  }
  const canonical = sameOriginNotificationUrlFromOrigin(normalized, options.origin);
  if (canonical === null) {
    throw new AgentNotificationValidationError("url", "invalid_url", "url is not a safe same-origin HTTP(S) URL");
  }
  if (countCodePoints(canonical) > AGENT_NOTIFICATION_LIMITS.url) {
    throw new AgentNotificationValidationError("url", "invalid_length", `url exceeds ${AGENT_NOTIFICATION_LIMITS.url} code points`);
  }
  return canonical;
}
function normalizeNotificationEvent(value, options = {}) {
  if (!isOrdinaryObject(value)) {
    throw new AgentNotificationValidationError("__root__", "invalid_record", "Notification input must be a plain object");
  }
  requireOwnEnumerableDataFields(value);
  validateRequiredFields(value);
  const normalized = {
    id: normalizeStringField(value.id, "id", AGENT_NOTIFICATION_LIMITS.id, true),
    session: normalizeStringField(value.session, "session", AGENT_NOTIFICATION_LIMITS.session, true),
    state: parseEventState(value.state),
    occurredAt: parseOccurredAt(value.occurredAt)
  };
  const title = normalizeOptionalStringField(value, "title", AGENT_NOTIFICATION_LIMITS.title);
  if (title !== undefined)
    normalized.title = title;
  const body = normalizeOptionalStringField(value, "body", AGENT_NOTIFICATION_LIMITS.body);
  if (body !== undefined)
    normalized.body = body;
  const tag = normalizeOptionalStringField(value, "tag", AGENT_NOTIFICATION_LIMITS.tag);
  if (tag !== undefined)
    normalized.tag = tag;
  const url = Object.prototype.hasOwnProperty.call(value, "url") ? normalizeUrl(value.url, options) : undefined;
  if (url !== undefined)
    normalized.url = url;
  return normalized;
}
function normalizeAgentNotificationEvent(value, options = {}) {
  return normalizeNotificationEvent(value, options);
}
function validateAgentNotificationEvent(value, options = {}) {
  return normalizeNotificationEvent(value, options);
}
// src/terminal-link.ts
var urlStartRe = /https?:\/\//g;
var terminalTokenRe = /^[^\s<>"{}]+/;
var urlTokenStickyRe = /https?:\/\/[^\s<>"{}]+/y;
var urlSchemeAtStartRe = /^https?:\/\//;
var midParameterContextRe = /[?&=]$/;
var CONTINUATION_SEAM_LINES = 32;
var MAX_CONTINUATION_ROWS = 128;
function isMidParameterContext(urlSoFar) {
  return midParameterContextRe.test(urlSoFar);
}
function utf16ToCellOffset(text, utf16Offset) {
  if (utf16Offset <= 0)
    return 0;
  if (utf16Offset >= text.length)
    return stringCells(text);
  let cols = 0;
  let i = 0;
  for (const ch of text) {
    const next = i + ch.length;
    if (next > utf16Offset)
      break;
    cols += charCellWidth(ch.codePointAt(0));
    i = next;
  }
  return cols;
}
function collectTerminalUrlSegments(rawLines, startLine, endLine, cols) {
  const matches = [];
  const cacheBase = startLine;
  const cacheSize = Math.max(0, endLine - startLine) + CONTINUATION_SEAM_LINES;
  const strippedCache = new Array(cacheSize);
  const getStripped = (i) => {
    const slot = i - cacheBase;
    let cached = strippedCache[slot];
    if (cached === undefined) {
      cached = stripAnsi(rawLines[i]).trimEnd();
      strippedCache[slot] = cached;
    }
    return cached;
  };
  const consumedEndCol = new Map;
  const continuationLimit = Math.min(rawLines.length, endLine + CONTINUATION_SEAM_LINES);
  for (let wi = startLine;wi < endLine; wi++) {
    const stripped = getStripped(wi);
    const rowConsumed = consumedEndCol.get(wi) ?? 0;
    urlStartRe.lastIndex = 0;
    let match;
    while ((match = urlStartRe.exec(stripped)) !== null) {
      if (match.index < rowConsumed)
        continue;
      urlTokenStickyRe.lastIndex = match.index;
      const urlOnLine = urlTokenStickyRe.exec(stripped);
      if (!urlOnLine)
        continue;
      let fullUrl = urlOnLine[0];
      const segments = [{
        lineIdx: wi,
        startCol: utf16ToCellOffset(stripped, match.index),
        endCol: utf16ToCellOffset(stripped, match.index + fullUrl.length),
        rawText: fullUrl
      }];
      let curIdx = wi;
      let curEndPos = segments[0].endCol;
      while (curEndPos >= 10 && curIdx + 1 < continuationLimit && segments.length - 1 < MAX_CONTINUATION_ROWS) {
        const curLineCells = stringCells(getStripped(curIdx));
        const looksSoftWrapped = cols > 0 && (curLineCells >= cols - 1 || curEndPos >= cols);
        if (!looksSoftWrapped)
          break;
        const nextStripped = getStripped(curIdx + 1);
        const trimmed = nextStripped.trimStart();
        if (trimmed.length === 0)
          break;
        if (urlSchemeAtStartRe.test(trimmed) && !isMidParameterContext(fullUrl))
          break;
        const cont = trimmed.match(terminalTokenRe);
        if (!cont)
          break;
        const continuationText = cont[0];
        fullUrl += continuationText;
        curIdx++;
        const indent = nextStripped.slice(0, nextStripped.length - trimmed.length);
        const indentCols = stringCells(indent);
        segments.push({
          lineIdx: curIdx,
          startCol: indentCols,
          endCol: indentCols + stringCells(continuationText),
          rawText: continuationText
        });
        curEndPos = segments[segments.length - 1].endCol;
      }
      let trailingTrim = 0;
      while (fullUrl.length > 1 && /[.,;:!?)}>\]]$/.test(fullUrl)) {
        if (fullUrl.endsWith(")") && fullUrl.includes("("))
          break;
        if (fullUrl.endsWith("]") && fullUrl.includes("["))
          break;
        fullUrl = fullUrl.slice(0, -1);
        trailingTrim += 1;
      }
      let remainingTrim = trailingTrim;
      while (remainingTrim > 0 && segments.length > 0) {
        const last = segments[segments.length - 1];
        const remove = Math.min(remainingTrim, last.rawText.length);
        if (last.rawText.length <= remainingTrim) {
          remainingTrim -= last.rawText.length;
          segments.pop();
          continue;
        }
        const dropText = last.rawText.slice(last.rawText.length - remove);
        last.rawText = last.rawText.slice(0, last.rawText.length - remove);
        last.endCol -= stringCells(dropText);
        remainingTrim = 0;
      }
      if (segments.length === 0 || !segments.some((segment) => segment.endCol > segment.startCol)) {
        continue;
      }
      const publicSegments = segments.map((segment) => {
        const { rawText: _rawText, ...publicSegment } = segment;
        return publicSegment;
      });
      for (let si = 1;si < segments.length; si++) {
        const seg = segments[si];
        const prev = consumedEndCol.get(seg.lineIdx) ?? 0;
        consumedEndCol.set(seg.lineIdx, Math.max(prev, seg.endCol));
      }
      matches.push({
        url: fullUrl,
        segments: publicSegments
      });
    }
  }
  return matches;
}
function findTerminalUrlAtCell(rawLines, lineIdx, col, cols) {
  if (!Number.isFinite(lineIdx) || !Number.isFinite(col) || !Number.isFinite(cols))
    return null;
  const targetLine = Math.floor(lineIdx);
  const targetCol = Math.floor(col);
  if (targetLine < 0 || targetLine >= rawLines.length || targetCol < 0 || cols <= 0)
    return null;
  if (targetCol >= cols)
    return null;
  const windowStart = Math.max(0, targetLine - MAX_CONTINUATION_ROWS);
  const windowEnd = Math.min(rawLines.length, targetLine + MAX_CONTINUATION_ROWS + 1);
  for (const match of collectTerminalUrlSegments(rawLines, windowStart, windowEnd, cols)) {
    for (const segment of match.segments) {
      if (segment.lineIdx === targetLine && targetCol >= segment.startCol && targetCol < segment.endCol) {
        return match.url;
      }
    }
  }
  return null;
}
var stripAnsi = stripTerminalControls;
// src/terminal-scroll.ts
var DEFAULT_WHEEL_PIXEL_SCALE = 0.6;
var MAX_WHEEL_LINES_PER_FRAME = 12;
function findLineOverlap(previousLines, nextLines) {
  const max = Math.min(previousLines.length, nextLines.length);
  let budget = 2 * (previousLines.length + nextLines.length) + 64;
  for (let overlap = max;overlap > 0; overlap--) {
    let matches = true;
    const previousStart = previousLines.length - overlap;
    for (let i = 0;i < overlap; i++) {
      if (--budget < 0) {
        return findLineOverlapLinear(previousLines, nextLines);
      }
      if (previousLines[previousStart + i] !== nextLines[i]) {
        matches = false;
        break;
      }
    }
    if (matches)
      return overlap;
  }
  return 0;
}
function findLineOverlapLinear(previousLines, nextLines) {
  if (previousLines.length === 0 || nextLines.length === 0)
    return 0;
  const m = nextLines.length;
  const idByLine = new Map;
  const pattern = new Int32Array(m);
  let nextId = 0;
  for (let i = 0;i < m; i++) {
    const line = nextLines[i];
    let id = idByLine.get(line);
    if (id === undefined) {
      id = nextId++;
      idByLine.set(line, id);
    }
    pattern[i] = id;
  }
  const pi = new Int32Array(m);
  for (let i = 1, len = 0;i < m; ) {
    if (pattern[i] === pattern[len]) {
      pi[i++] = ++len;
    } else if (len > 0) {
      len = pi[len - 1];
    } else {
      pi[i++] = 0;
    }
  }
  let state = 0;
  for (let i = 0;i < previousLines.length; i++) {
    if (state === m) {
      state = pi[m - 1];
    }
    const id = idByLine.get(previousLines[i]) ?? -1;
    while (state > 0 && pattern[state] !== id) {
      state = pi[state - 1];
    }
    if (pattern[state] === id) {
      state++;
    }
  }
  return state;
}
function mergeCapturedLinesForStableScroll(previousLines, nextLines) {
  if (previousLines.length === 0) {
    return { lines: nextLines, appendedLineCount: nextLines.length, preservedPrefix: false };
  }
  const overlap = findLineOverlap(previousLines, nextLines);
  const minimumStableOverlap = Math.min(8, previousLines.length, nextLines.length);
  if (overlap >= minimumStableOverlap) {
    const appended = nextLines.slice(overlap);
    return {
      lines: appended.length > 0 ? [...previousLines, ...appended] : previousLines,
      appendedLineCount: appended.length,
      preservedPrefix: true
    };
  }
  return {
    lines: nextLines,
    appendedLineCount: nextLines.length - previousLines.length,
    preservedPrefix: false
  };
}
function readerAnchorLineDelta(previousLines, nextLines, maxTailRewrite = 2) {
  const lineDelta = nextLines.length - previousLines.length;
  const minLength = Math.min(previousLines.length, nextLines.length);
  if (lineDelta === 0 || minLength === 0)
    return 0;
  let commonPrefix = 0;
  while (commonPrefix < minLength && previousLines[commonPrefix] === nextLines[commonPrefix])
    commonPrefix++;
  const toleratedTail = Math.max(0, Math.floor(maxTailRewrite));
  const requiredPrefix = Math.max(1, minLength - toleratedTail);
  return commonPrefix >= requiredPrefix ? lineDelta : 0;
}
function wheelDeltaToLines(event, lineHeightPx, rows, pixelScale = DEFAULT_WHEEL_PIXEL_SCALE) {
  if (!Number.isFinite(event.deltaY) || event.deltaY === 0)
    return 0;
  if (event.deltaMode === 1)
    return event.deltaY;
  if (event.deltaMode === 2)
    return event.deltaY * Math.max(1, rows);
  return event.deltaY / Math.max(1, lineHeightPx) * pixelScale;
}
function consumeWholeWheelLines(remainder) {
  const wholeLines = remainder > 0 ? Math.floor(remainder) : Math.ceil(remainder);
  if (wholeLines === 0)
    return { wholeLines: 0, remainder };
  const clamped = Math.max(-MAX_WHEEL_LINES_PER_FRAME, Math.min(MAX_WHEEL_LINES_PER_FRAME, wholeLines));
  return {
    wholeLines: clamped,
    remainder: remainder - clamped
  };
}
// src/prompt-scan.ts
var DEFAULT_TARGET_COUNT = 5;
var DEFAULT_INITIAL_SCAN_LINES = 240;
var DEFAULT_MAX_SCAN_LINES = 1200;
var PROMPT_MARKERS = new Set(["❯", "›"]);
function stripAnsi2(text) {
  return stripTerminalControls(text);
}
function sgrFaint(params, faint) {
  if (params === "")
    return false;
  const codes = params.split(";");
  let i = 0;
  while (i < codes.length) {
    const code = Number(codes[i]);
    if (code === 38 || code === 48 || code === 58) {
      const mode = Number(codes[i + 1]);
      if (mode === 5) {
        i += 3;
        continue;
      }
      if (mode === 2) {
        i += 5;
        continue;
      }
      i += 1;
      continue;
    }
    if (code === 0 || code === 22)
      faint = false;
    else if (code === 2)
      faint = true;
    i += 1;
  }
  return faint;
}
function isFaintPayload(rawLine) {
  let faint = false;
  let markerSeen = false;
  let i = 0;
  const n = rawLine.length;
  while (i < n) {
    const ch = rawLine[i];
    if (ch === "\x1B") {
      const csi = /^\x1b\[([0-9;]*)m/.exec(rawLine.slice(i));
      if (csi) {
        faint = sgrFaint(csi[1] ?? "", faint);
        i += csi[0].length;
        continue;
      }
      const osc = /^\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/.exec(rawLine.slice(i));
      if (osc) {
        i += osc[0].length;
        continue;
      }
      const otherCsi = /^\x1b\[[0-9;:?<=>\-]*[@-~]/.exec(rawLine.slice(i));
      if (otherCsi) {
        i += otherCsi[0].length;
        continue;
      }
      i += 2;
      continue;
    }
    const isWs = ch === " " || ch === " " || ch === "\t";
    if (!markerSeen) {
      if (!isWs)
        markerSeen = true;
      i += 1;
      continue;
    }
    if (isWs) {
      i += 1;
      continue;
    }
    return faint;
  }
  return false;
}
function stripTrailingClock(text) {
  return text.replace(/\s{2,}\d{1,2}:\d{2}\s*[AP]M\s*$/, "").trimEnd();
}
function isCodexStatusLine(trimmed) {
  return /\bcontext\s+\d+%\s+used\b/i.test(trimmed) && /\b(gpt|codex|weekly|5h|daily)\b/i.test(trimmed);
}
function isClaudeStatusLine(trimmed) {
  return /\b(new task\?|\/clear to save|bypass permissions|opus|sonnet|haiku)/i.test(trimmed) && /\b(tokens|permissions|effort|5h|week|ctx:)/i.test(trimmed);
}
function isGrokStatusLine(trimmed) {
  const grokBrand = /^(?:Grok(?:[\s-]|$)|SuperGrok\b)/i.test(trimmed);
  const hasTranscript = /\bctrl\+o\s+transcript\b/i.test(trimmed);
  const hasApprove = /\balways-approve\b/i.test(trimmed);
  const hasQueue = /\b\/queue\b/.test(trimmed) || /\b\d+\s+queued\b/i.test(trimmed);
  const hasTokens = /\b\d+(?:\.\d+)?[kKmM]?\s*\/\s*\d+(?:\.\d+)?[kKmM]?\b/.test(trimmed);
  const chromeBits = [hasTranscript, hasApprove, hasQueue, hasTokens].filter(Boolean).length;
  if (grokBrand && chromeBits >= 1)
    return true;
  return chromeBits >= 2;
}
var DEFAULT_PROMPT_MATCHERS = Object.freeze({
  promptPayload(line) {
    const normalized = line.replace(/\u00a0/g, " ").trimStart();
    const marker = normalized[0];
    if (!marker || !PROMPT_MARKERS.has(marker))
      return null;
    const leading = line.length - line.trimStart().length;
    if (leading > 6)
      return null;
    const payload = stripTrailingClock(normalized.slice(1).trim());
    return payload || null;
  },
  isFaintPayload,
  isStatusLine(trimmedLine) {
    return isCodexStatusLine(trimmedLine) || isClaudeStatusLine(trimmedLine) || isGrokStatusLine(trimmedLine);
  },
  isPromptTerminator(line) {
    const trimmed = line.replace(/\u00a0/g, " ").trim();
    if (!trimmed)
      return false;
    if (/^[●•◦✻⎿■⚠╭╰│─◆❙┃⠀-⣿]/.test(trimmed))
      return true;
    if (/^(?:Tip:|OpenAI Codex\b)/i.test(trimmed))
      return true;
    if (/^(?:Turn completed in\s|Shift\+Tab:mode|Enter:send)/.test(trimmed))
      return true;
    return false;
  }
});
function cleanPromptLine(line) {
  return line.replace(/\u00a0/g, " ").replace(/^\s{0,2}/, "").trimEnd();
}
function extractMarkdownSection(lines, title) {
  const heading = new RegExp(`^#{2,6}\\s+${title}\\s*$`, "i");
  const start = lines.findIndex((line) => heading.test(line.trim()));
  if (start < 0)
    return null;
  const section = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{2,6}\s+\S/.test(line.trim()))
      break;
    section.push(line);
  }
  const text = section.join(" ").replace(/\s+/g, " ").trim();
  return text || null;
}
function normalizePromptBlock(lines) {
  const cleanLines = lines.map(cleanPromptLine).filter((line, index, all) => line.trim() || index > 0 && index < all.length - 1);
  const userReport = extractMarkdownSection(cleanLines, "User report");
  const source = userReport ?? cleanLines.join(" ");
  return source.replace(/\s+/g, " ").trim();
}
function collectPrompts(lines, start, matchers) {
  const prompts = [];
  let i = start;
  while (i < lines.length) {
    const raw = lines[i] ?? "";
    const line = stripAnsi2(raw).trimEnd();
    const firstLine = matchers.promptPayload(line);
    if (firstLine === null) {
      i++;
      continue;
    }
    if (matchers.isFaintPayload(raw)) {
      i++;
      continue;
    }
    const block = [firstLine];
    i++;
    while (i < lines.length) {
      const continuationLine = stripAnsi2(lines[i] ?? "").trimEnd();
      const trimmedContinuation = continuationLine.replace(/\u00a0/g, " ").trim();
      if (matchers.promptPayload(continuationLine) !== null || matchers.isPromptTerminator(continuationLine) || trimmedContinuation !== "" && matchers.isStatusLine(trimmedContinuation))
        break;
      block.push(continuationLine);
      i++;
    }
    let decisive = i;
    while (decisive < lines.length) {
      const row = stripAnsi2(lines[decisive] ?? "").replace(/\u00a0/g, " ").trim();
      if (row !== "" && !/^[\u2500-\u257f\s]+$/.test(row))
        break;
      decisive++;
    }
    const terminator = decisive < lines.length ? stripAnsi2(lines[decisive] ?? "").replace(/\u00a0/g, " ").trim() : "";
    if (terminator && matchers.isStatusLine(terminator)) {
      continue;
    }
    const prompt = normalizePromptBlock(block);
    if (prompt && prompt.length >= 3 && !prompt.startsWith("/")) {
      prompts.push(prompt);
    }
  }
  return prompts;
}
function extractRecentPrompts(lines, options = {}) {
  if (lines.length === 0)
    return [];
  const targetCount = options.targetCount ?? DEFAULT_TARGET_COUNT;
  if (targetCount <= 0)
    return [];
  const initialScanLines = Math.max(0, options.initialScanLines ?? DEFAULT_INITIAL_SCAN_LINES);
  const maxScanLines = options.maxScanLines ?? DEFAULT_MAX_SCAN_LINES;
  const matchers = options.matchers ?? DEFAULT_PROMPT_MATCHERS;
  const boundedMaxScanLines = Math.min(lines.length, maxScanLines);
  let scanLines = Math.min(lines.length, initialScanLines, boundedMaxScanLines);
  let prompts = collectPrompts(lines, Math.max(0, lines.length - scanLines), matchers);
  let unique = dedupeKeepLatest(prompts);
  while (unique.length < targetCount && scanLines < boundedMaxScanLines) {
    scanLines = Math.min(boundedMaxScanLines, scanLines <= 0 ? 1 : scanLines * 2);
    prompts = collectPrompts(lines, Math.max(0, lines.length - scanLines), matchers);
    unique = dedupeKeepLatest(prompts);
  }
  return unique.slice(-targetCount);
}
function extractRecentPromptsFromPane(content, targetCount = 5, options = {}) {
  if (targetCount <= 0)
    return [];
  const lines = content.split(`
`);
  if (lines.length === 0)
    return [];
  const matchers = options.matchers ?? DEFAULT_PROMPT_MATCHERS;
  return dedupeKeepLatest(collectPrompts(lines, 0, matchers)).slice(-targetCount);
}
function dedupeKeepLatest(prompts) {
  const seen = new Set;
  const deduped = [];
  for (let j = prompts.length - 1;j >= 0; j--) {
    const p = prompts[j];
    if (p !== undefined && !seen.has(p)) {
      seen.add(p);
      deduped.unshift(p);
    }
  }
  return deduped;
}
// src/claude-bash.ts
var DEFAULT_MAX_SCAN_LINES2 = 20000;
var DEFAULT_MAX_BLOCK_LINES = 2000;
var DEFAULT_MAX_BLOCKS = 512;
var DEFAULT_MAX_COMMAND_CHARS = 4096;
var DEFAULT_MAX_OUTPUT_CHARS = 8192;
var DEFAULT_MAX_GROUP_COMMAND_CHARS = 3000;
var DEFAULT_MAX_GROUP_OUTPUT_CHARS = 6000;
var DEFAULT_MAX_SUMMARY_CHARS = 240;
var MAX_CANDIDATE_ROW_CHARS = 65536;
var MIN_PLAUSIBLE_SOFT_WRAP_CELLS = 64;
var SGR = "\\x1b\\[[0-9;:]*m";
var STYLED_BLANK_PREFIX = new RegExp(`^(?:${SGR})+ (?:${SGR})+ $`);
var BOLD_BASH = /\x1b\[(?:1(?:;[0-9;:]*)?|[0-9;:]*;1(?:;[0-9;:]*)?)mBash/;
var GREY_OR_DIM_SGR = /\x1b\[(?:38(?:;|:)[0-9;:]+|3[0-7]|9[0-7]|2)m/;
function boundedInteger(value, fallback, maximum) {
  if (value === undefined || !Number.isFinite(value))
    return fallback;
  return Math.max(0, Math.min(maximum, Math.floor(value)));
}
function visibleLine(raw) {
  return stripAnsi2(raw).replace(/\u00a0/g, " ").trimEnd();
}
function completedHeader(raw) {
  if (raw.length > MAX_CANDIDATE_ROW_CHARS)
    return null;
  const match = /^(?:●|⏺) Bash\((.*)$/.exec(visibleLine(raw));
  return match ? { status: "completed", firstCommandText: match[1] ?? "" } : null;
}
function activeHeader(raw) {
  if (raw.length > MAX_CANDIDATE_ROW_CHARS)
    return null;
  const plain = visibleLine(raw);
  const match = /^ {2}Bash\((.*)$/.exec(plain);
  if (!match)
    return null;
  const boldBash = BOLD_BASH.exec(raw);
  if (!boldBash || boldBash.index < 0)
    return null;
  const markerPrefix = raw.slice(0, boldBash.index);
  if (!STYLED_BLANK_PREFIX.test(markerPrefix))
    return null;
  if (!GREY_OR_DIM_SGR.test(markerPrefix))
    return null;
  return { status: "active", firstCommandText: match[1] ?? "" };
}
function headerAt(raw) {
  return completedHeader(raw) ?? activeHeader(raw);
}
function isCalibratedCompletedHeader(raw) {
  if (completedHeader(raw) === null || !isCalibratedClaudeTopLevel(raw))
    return false;
  const boldBash = BOLD_BASH.exec(raw);
  if (!boldBash)
    return false;
  const semanticPrefix = stripAnsi2(raw.slice(0, boldBash.index)).replace(/\u00a0/g, " ");
  return semanticPrefix === "● " || semanticPrefix === "⏺ ";
}
function isResultDelimiter(line) {
  return /^ {2}⎿(?: {1,2}|$)/.test(line);
}
function terminalPaintCorridor(rawLines, startLine) {
  const entries = [];
  const boundedStart = Math.max(0, Math.min(startLine, rawLines.length));
  let state = boundedStart === 0 ? { foreground: null, inverse: false, concealed: false } : { foreground: -1, inverse: false, concealed: true };
  for (let index = boundedStart;index < rawLines.length; index += 1) {
    const raw = rawLines[index] ?? "";
    entries.push(state);
    if (raw.length > MAX_CANDIDATE_ROW_CHARS) {
      state = { foreground: -1, inverse: false, concealed: true };
      continue;
    }
    const paint = terminalPaintSnapshot(raw, state.foreground, state.inverse, state.concealed);
    state = paint ? {
      foreground: paint.endForeground,
      inverse: paint.endInverse,
      concealed: paint.endConcealed
    } : { foreground: -1, inverse: false, concealed: true };
  }
  return { startLine: boundedStart, entries };
}
function terminalPaintEntryAt(corridor, line) {
  if (line < corridor.startLine)
    return;
  return corridor.entries[line - corridor.startLine];
}
function boundaryKind(raw, line) {
  const dialogContent = line.replace(/^\s*[│┃║╭┌┏](?:[─━-]*\s*)?/, "").trimStart();
  if (/^(?:I want to run:|Do you want to (?:allow|proceed)|Would you like to (?:allow|proceed)|This command requires approval)/i.test(dialogContent) || /^❯\s*\d+[.)]\s*(?:Yes|No|Allow|Deny)\b/i.test(dialogContent))
    return "approval";
  if (/^ {0,2}❯(?:\s|$)/u.test(line))
    return "user-prompt";
  if (/^(?:●|⏺|✻)(?:\s|$)/.test(line) || isCalibratedClaudeTopLevel(raw))
    return "top-level";
  if (/^[─━-]{8,}\s*$/.test(line))
    return "composer-rule";
  if (/^[╭┌┏](?:[─━-]|\s)/.test(line))
    return "dialog";
  return null;
}
function claudeComposerRule(raw, initialForeground = null, initialInverse = false, initialConcealed = false) {
  const paint = terminalPaintSnapshot(raw, initialForeground, initialInverse, initialConcealed);
  if (!paint)
    return null;
  const line = paint.visible.replace(/\u00a0/g, " ").trimEnd();
  if (!/^[─━-]{8,}$/.test(line))
    return null;
  for (let unit = 0;unit < line.length; unit += 1) {
    if (paint.foregrounds[unit] !== 244)
      return null;
  }
  return {
    cells: stringCells(line),
    endForeground: paint.endForeground,
    endInverse: paint.endInverse,
    endConcealed: paint.endConcealed
  };
}
function confirmedClaudeComposerPairAt(rawLines, topIndex, bottomIndex, paintCorridor) {
  if (topIndex < paintCorridor.startLine || bottomIndex !== topIndex + 2 || bottomIndex >= rawLines.length || (rawLines[topIndex]?.length ?? 0) > MAX_CANDIDATE_ROW_CHARS || (rawLines[topIndex + 1]?.length ?? 0) > MAX_CANDIDATE_ROW_CHARS || (rawLines[bottomIndex]?.length ?? 0) > MAX_CANDIDATE_ROW_CHARS)
    return null;
  const topEntry = terminalPaintEntryAt(paintCorridor, topIndex);
  const top = claudeComposerRule(rawLines[topIndex] ?? "", topEntry?.foreground ?? null, topEntry?.inverse ?? false, topEntry?.concealed ?? false);
  if (!top)
    return null;
  const middleRaw = rawLines[topIndex + 1] ?? "";
  const middlePaint = terminalPaintSnapshot(middleRaw, top.endForeground, top.endInverse, top.endConcealed);
  if (!middlePaint)
    return null;
  const middle = middlePaint.visible.replace(/\u00a0/g, " ").trimEnd();
  if (!/^❯(?:\s|$)/.test(middle))
    return null;
  for (let unit = 0;unit < middle.length; unit += 1) {
    if (/\s/u.test(middle[unit] ?? ""))
      continue;
    if (middlePaint.foregrounds[unit] !== 244) {
      return null;
    }
  }
  const bottom = claudeComposerRule(rawLines[bottomIndex] ?? "", middlePaint.endForeground, middlePaint.endInverse, middlePaint.endConcealed);
  return bottom?.cells === top.cells ? top.cells : null;
}
function confirmedClaudeComposerRuleAt(rawLines, index, paintCorridor) {
  for (const otherIndex of [index + 2, index - 2]) {
    if (otherIndex < 0 || otherIndex >= rawLines.length)
      continue;
    const cells = confirmedClaudeComposerPairAt(rawLines, Math.min(index, otherIndex), Math.max(index, otherIndex), paintCorridor);
    if (cells !== null)
      return cells;
  }
  return null;
}
function confirmedClaudeComposerPromptAt(rawLines, index, paintCorridor) {
  return confirmedClaudeComposerPairAt(rawLines, index - 1, index + 1, paintCorridor) !== null;
}
function isContextualClaudeActivityStatusAt(rawLines, index, paintCorridor) {
  const entry = terminalPaintEntryAt(paintCorridor, index);
  if (!isStyledClaudeActivityStatusLine(rawLines[index] ?? "", entry?.foreground ?? null, entry?.inverse ?? false, entry?.concealed ?? false))
    return false;
  const end = Math.min(rawLines.length, index + 8);
  let candidate = index + 1;
  const skipBlankRows = () => {
    let skipped = 0;
    while (candidate < end && visibleLine(rawLines[candidate] ?? "").trim() === "") {
      skipped += 1;
      if (skipped > 2)
        return false;
      candidate += 1;
    }
    return true;
  };
  const hasComposer = () => candidate < end && confirmedClaudeComposerRuleAt(rawLines, candidate, paintCorridor) !== null;
  if (!skipBlankRows())
    return false;
  if (hasComposer())
    return true;
  const first = visibleLine(rawLines[candidate] ?? "").trimStart();
  if (/^⎿\s*Tip:/.test(first)) {
    candidate += 1;
    if (!skipBlankRows())
      return false;
    return hasComposer();
  }
  if (/^● How is Claude doing this session\?\s*\(optional\)\s*$/.test(first)) {
    candidate += 1;
    const choices = visibleLine(rawLines[candidate] ?? "").trim();
    if (!/^1:\s*Bad\s+2:\s*Fine\s+3:\s*Good\s+0:\s*Dismiss$/.test(choices)) {
      return false;
    }
    candidate += 1;
    if (!skipBlankRows())
      return false;
    return hasComposer();
  }
  return false;
}
function resumeAfterAmbiguousCorridor(rawLines, ambiguousLine, scanEnd, paintCorridor) {
  for (let index = Math.min(rawLines.length, scanEnd) - 1;index > ambiguousLine; index -= 1) {
    if (confirmedClaudeComposerRuleAt(rawLines, index, paintCorridor) !== null)
      return index;
  }
  return scanEnd;
}
function inferredPaneColumns(rawLines, paintCorridor) {
  const start = Math.max(paintCorridor.startLine, rawLines.length - 64);
  for (let index = rawLines.length - 1;index >= start; index -= 1) {
    const cells = confirmedClaudeComposerRuleAt(rawLines, index, paintCorridor);
    if (cells !== null)
      return cells;
  }
  return null;
}
function isCalibratedClaudeTopLevel(raw) {
  return /^(?:\x1b\[0m)?\x1b\[38(?:;5;|:5:)(?:114|174|231|246|211|220)m(?:\x1b\[49m)?(?:●|⏺|✻)\x1b\[39m(?:\s|$)/.test(raw);
}
function protectedPromptContinuationRows(rawLines, scanStart, paintCorridor) {
  const protectedRows = new Set;
  let guarding = scanStart > 0;
  for (let index = scanStart;index < rawLines.length; index += 1) {
    const raw = rawLines[index] ?? "";
    if (raw.length <= MAX_CANDIDATE_ROW_CHARS) {
      const line = visibleLine(raw);
      if (boundaryKind(raw, line) === "user-prompt") {
        if (confirmedClaudeComposerPromptAt(rawLines, index, paintCorridor)) {
          guarding = false;
          continue;
        }
        guarding = true;
        continue;
      }
      if (guarding && (activeHeader(raw) !== null || isCalibratedCompletedHeader(raw))) {
        guarding = false;
        continue;
      }
    }
    if (!guarding)
      continue;
    if (index >= scanStart)
      protectedRows.add(index);
  }
  return protectedRows;
}
function trimOneClosingParen(rows) {
  for (let i = rows.length - 1;i >= 0; i -= 1) {
    if ((rows[i] ?? "") === "")
      continue;
    rows[i] = (rows[i] ?? "").replace(/\)\s*$/, "");
    return;
  }
}
function commandText(rawLines, startLine, endLine, firstCommandText) {
  const rows = [firstCommandText.trimEnd()];
  for (let i = startLine + 1;i < endLine; i += 1) {
    const row = visibleLine(rawLines[i] ?? "");
    rows.push(row.startsWith("      ") ? row.slice(6) : row);
  }
  trimOneClosingParen(rows);
  return rows.join(`
`).trim();
}
function removeResultPrefix(line) {
  return line.replace(/^ {2}⎿(?: {1,2})?/, "");
}
function outputText(rawLines, startLine, endLine) {
  const rows = [];
  for (let i = startLine;i < endLine; i += 1) {
    const row = visibleLine(rawLines[i] ?? "");
    if (isResultDelimiter(row))
      rows.push(removeResultPrefix(row));
    else
      rows.push(row.startsWith("     ") ? row.slice(5) : row);
  }
  return rows.join(`
`).trim();
}
function truncateUtf16(text, maxChars) {
  if (text.length <= maxChars)
    return { text, truncated: false };
  if (maxChars <= 0)
    return { text: "", truncated: text.length > 0 };
  let end = maxChars;
  const final = text.charCodeAt(end - 1);
  if (final >= 55296 && final <= 56319 && end < text.length)
    end -= 1;
  return { text: text.slice(0, end), truncated: true };
}
function fnv1a322(text, seed) {
  let hash = seed >>> 0;
  for (let i = 0;i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash;
}
function blockFingerprint(command, output, status) {
  const normalizedCommand = command.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
  const normalizedOutput = output.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
  const normalized = status === "completed" ? `${normalizedCommand}\x00${normalizedOutput}` : normalizedCommand;
  const first = fnv1a322(normalized, 2166136261).toString(16).padStart(8, "0");
  const second = fnv1a322(normalized, 2654435769).toString(16).padStart(8, "0");
  return `claude-bash-v1-${first}${second}`;
}
function groupFingerprint(blocks, status) {
  const normalized = `${status}\x00${blocks.map((block) => block.fingerprint).join("\x00")}`;
  const first = fnv1a322(normalized, 2166136261).toString(16).padStart(8, "0");
  const second = fnv1a322(normalized, 2654435769).toString(16).padStart(8, "0");
  return `claude-bash-group-v1-${first}${second}`;
}
function range(startLine, endLine) {
  return Object.freeze({ startLine, endLine });
}
function parseCandidate(rawLines, startLine, header, limits) {
  const maximumCandidateEnd = startLine + limits.maxBlockLines;
  const scanEnd = Math.min(rawLines.length, maximumCandidateEnd + 1);
  let delimiterLine = -1;
  let boundaryLine = -1;
  let completionBoundary = false;
  let pendingBlankStart = -1;
  let softWrappedWeakBoundary = false;
  let ambiguousActivityStatusLine = -1;
  for (let i = startLine + 1;i < scanEnd; i += 1) {
    const raw = rawLines[i] ?? "";
    if (raw.length > MAX_CANDIDATE_ROW_CHARS)
      return { block: null };
    const line = visibleLine(raw);
    if (delimiterLine < 0 && isResultDelimiter(line)) {
      delimiterLine = i;
      pendingBlankStart = -1;
      continue;
    }
    const nextHeader = headerAt(raw);
    const semanticActivityStatus = isClaudeActivityStatusLine(line);
    const paintEntry = terminalPaintEntryAt(limits.paintCorridor, i);
    const styledActivityStatus = semanticActivityStatus && isStyledClaudeActivityStatusLine(raw, paintEntry?.foreground ?? null, paintEntry?.inverse ?? false, paintEntry?.concealed ?? false);
    const contextualActivityStatus = styledActivityStatus && isContextualClaudeActivityStatusAt(rawLines, i, limits.paintCorridor);
    const activityStatusBoundary = contextualActivityStatus && limits.activityStatusLines.has(i);
    const boundary = nextHeader ? "top-level" : activityStatusBoundary ? "top-level" : semanticActivityStatus ? null : boundaryKind(raw, line);
    if (semanticActivityStatus && !activityStatusBoundary && delimiterLine >= 0) {
      ambiguousActivityStatusLine = i;
    }
    if (boundary) {
      if (ambiguousActivityStatusLine >= 0 && !activityStatusBoundary) {
        return { block: null };
      }
      if (boundary === "user-prompt") {
        if (delimiterLine < 0) {
          return {
            block: null,
            resumeLine: resumeAfterAmbiguousCorridor(rawLines, i, scanEnd, limits.paintCorridor)
          };
        }
        const previousCells = stringCells(visibleLine(rawLines[i - 1] ?? ""));
        const previousFillsCurrentPane = limits.paneColumns !== null && previousCells === limits.paneColumns;
        const previousCouldFillAnotherPane = previousCells >= MIN_PLAUSIBLE_SOFT_WRAP_CELLS && !previousFillsCurrentPane;
        if (previousFillsCurrentPane || previousCouldFillAnotherPane) {
          return {
            block: null,
            resumeLine: resumeAfterAmbiguousCorridor(rawLines, i, scanEnd, limits.paintCorridor)
          };
        }
        boundaryLine = pendingBlankStart >= 0 ? pendingBlankStart : i;
        break;
      }
      if ((boundary === "dialog" || boundary === "approval") && delimiterLine < 0) {
        return { block: null };
      }
      if (delimiterLine >= 0) {
        if (boundary === "approval")
          return { block: null };
        const calibratedTopLevel = boundary === "top-level" && (activityStatusBoundary || isCalibratedClaudeTopLevel(raw));
        const previousCells = stringCells(visibleLine(rawLines[i - 1] ?? ""));
        const previousFillsCurrentPane = limits.paneColumns !== null && previousCells === limits.paneColumns;
        const previousCouldFillAnotherPane = previousCells >= MIN_PLAUSIBLE_SOFT_WRAP_CELLS && !previousFillsCurrentPane;
        const rejectedAmbiguousBoundary = nextHeader ? {
          block: null,
          resumeLine: resumeAfterAmbiguousCorridor(rawLines, i, scanEnd, limits.paintCorridor)
        } : { block: null };
        if (boundary === "dialog" && /^╭/.test(line)) {
          return {
            block: null,
            resumeLine: resumeAfterAmbiguousCorridor(rawLines, i, scanEnd, limits.paintCorridor)
          };
        }
        if (boundary === "composer-rule" && confirmedClaudeComposerRuleAt(rawLines, i, limits.paintCorridor) !== null) {
          if (ambiguousActivityStatusLine >= 0)
            return { block: null };
          if (previousFillsCurrentPane || previousCouldFillAnotherPane && !softWrappedWeakBoundary) {
            return rejectedAmbiguousBoundary;
          }
          completionBoundary = true;
          boundaryLine = pendingBlankStart >= 0 ? pendingBlankStart : i;
          break;
        }
        if (previousCouldFillAnotherPane && !softWrappedWeakBoundary) {
          return rejectedAmbiguousBoundary;
        }
        if (previousFillsCurrentPane && calibratedTopLevel) {
          return rejectedAmbiguousBoundary;
        }
        if (previousFillsCurrentPane && !calibratedTopLevel) {
          pendingBlankStart = -1;
          softWrappedWeakBoundary = true;
          continue;
        }
        if (softWrappedWeakBoundary && boundary === "top-level" && !calibratedTopLevel) {
          return { block: null };
        }
        if (boundary === "dialog" || boundary === "composer-rule") {
          return { block: null };
        }
      }
      completionBoundary = true;
      boundaryLine = pendingBlankStart >= 0 ? pendingBlankStart : i;
      break;
    }
    if (delimiterLine >= 0) {
      if (line.trim() === "") {
        if (pendingBlankStart < 0)
          pendingBlankStart = i;
      } else {
        pendingBlankStart = -1;
      }
    }
  }
  const hitLineLimit = maximumCandidateEnd < rawLines.length && boundaryLine < 0;
  if (hitLineLimit)
    return { block: null };
  let endLine = boundaryLine;
  if (header.status === "completed") {
    if (delimiterLine < 0 || endLine < 0)
      return { block: null };
  } else if (endLine < 0) {
    if (ambiguousActivityStatusLine >= 0)
      return { block: null };
    endLine = rawLines.length;
  }
  if (endLine <= startLine)
    return { block: null };
  const commandEndLine = delimiterLine >= 0 ? delimiterLine : endLine;
  const outputStartLine = delimiterLine >= 0 ? delimiterLine : endLine;
  const fullCommand = commandText(rawLines, startLine, commandEndLine, header.firstCommandText);
  if (!fullCommand)
    return { block: null };
  const fullOutput = delimiterLine >= 0 ? outputText(rawLines, outputStartLine, endLine) : "";
  const boundedCommand = truncateUtf16(fullCommand, limits.maxCommandChars);
  const boundedOutput = truncateUtf16(fullOutput, limits.maxOutputChars);
  const status = header.status === "active" && delimiterLine >= 0 && completionBoundary ? "completed" : header.status;
  const fingerprint = blockFingerprint(fullCommand, fullOutput, status);
  const lineCount = endLine - startLine;
  return {
    block: Object.freeze({
      id: fingerprint,
      lineCount,
      rawStart: startLine,
      rawEndExclusive: endLine,
      status,
      sourceRange: range(startLine, endLine),
      commandRange: range(startLine, commandEndLine),
      outputRange: range(outputStartLine, endLine),
      command: boundedCommand.text,
      output: boundedOutput.text,
      commandTruncated: boundedCommand.truncated,
      outputTruncated: boundedOutput.truncated,
      fingerprint
    })
  };
}
function detectClaudeBashBlocksInternal(rawLines, options, provenActivityStatusLines) {
  const maxScanLines = boundedInteger(options.maxScanLines, DEFAULT_MAX_SCAN_LINES2, 1e6);
  const scanStart = Math.max(0, rawLines.length - maxScanLines);
  const scanRange = range(scanStart, rawLines.length);
  const screenMode = options.screenMode ?? "normal";
  if (screenMode !== "normal" || maxScanLines === 0) {
    return Object.freeze({ blocks: Object.freeze([]), scanRange, enabled: false });
  }
  const maxBlockLines = boundedInteger(options.maxBlockLines, DEFAULT_MAX_BLOCK_LINES, 1e5);
  const maxBlocks = boundedInteger(options.maxBlocks, DEFAULT_MAX_BLOCKS, 1e5);
  const maxCommandChars = boundedInteger(options.maxCommandChars, DEFAULT_MAX_COMMAND_CHARS, 1e6);
  const maxOutputChars = boundedInteger(options.maxOutputChars, DEFAULT_MAX_OUTPUT_CHARS, 2000000);
  const activityStatusLines = new Set;
  for (const line of provenActivityStatusLines.slice(0, 512)) {
    if (Number.isInteger(line) && line >= scanStart && line < rawLines.length) {
      activityStatusLines.add(line);
    }
  }
  if (maxBlockLines < 2 || maxBlocks === 0) {
    return Object.freeze({ blocks: Object.freeze([]), scanRange, enabled: true });
  }
  const blocks = [];
  const paintCorridor = terminalPaintCorridor(rawLines, scanStart);
  const paneColumns = inferredPaneColumns(rawLines, paintCorridor);
  const promptContinuationRows = protectedPromptContinuationRows(rawLines, scanStart, paintCorridor);
  let i = scanStart;
  while (i < rawLines.length) {
    if (promptContinuationRows.has(i)) {
      i += 1;
      continue;
    }
    const header = headerAt(rawLines[i] ?? "");
    if (!header) {
      i += 1;
      continue;
    }
    const parsed = parseCandidate(rawLines, i, header, {
      maxBlockLines,
      maxCommandChars,
      maxOutputChars,
      paneColumns,
      activityStatusLines,
      paintCorridor
    });
    if (!parsed.block) {
      i = Math.max(i + 1, parsed.resumeLine ?? 0);
      continue;
    }
    if (blocks.length === maxBlocks)
      blocks.shift();
    blocks.push(parsed.block);
    i = parsed.block.sourceRange.endLine;
  }
  return Object.freeze({
    blocks: Object.freeze(blocks),
    scanRange,
    enabled: true
  });
}
function detectClaudeBashBlocks(rawLines, options = {}) {
  return detectClaudeBashBlocksInternal(rawLines, options, []);
}
function detectClaudeBashBlocksWithActivityEvidence(rawLines, provenActivityStatusLines, options = {}) {
  return detectClaudeBashBlocksInternal(rawLines, options, provenActivityStatusLines);
}
function isBlankPresentationRow(raw) {
  return visibleLine(raw).trim() === "";
}
function crossesBarrier(start, end, barrierLines) {
  for (const barrier of barrierLines) {
    if (barrier >= start && barrier <= end)
      return true;
  }
  return false;
}
function mergedGroupPreview(blocks, field, maxChars) {
  const memberWasTruncated = blocks.some((block) => field === "command" ? block.commandTruncated : block.outputTruncated);
  if (blocks.length <= 1) {
    const bounded = truncateUtf16(blocks[0]?.[field] ?? "", maxChars);
    return { text: bounded.text, truncated: bounded.truncated || memberWasTruncated };
  }
  const labels = blocks.map((_, index) => `[Bash ${index + 1}/${blocks.length}]`);
  const fixedChars = labels.reduce((sum, label) => sum + label.length + 1, 0) + (blocks.length - 1) * 2;
  if (fixedChars >= maxChars) {
    const bounded = truncateUtf16(labels.join(`

`), maxChars);
    return { text: bounded.text, truncated: true };
  }
  let remainingChars = maxChars - fixedChars;
  let remainingMembers = blocks.length;
  let truncated = memberWasTruncated;
  const pieces = blocks.map((block, index) => {
    const share = Math.floor(remainingChars / remainingMembers);
    const bounded = truncateUtf16(block[field], share);
    remainingChars -= bounded.text.length;
    remainingMembers -= 1;
    truncated ||= bounded.truncated;
    return `${labels[index]}
${bounded.text}`;
  });
  return { text: pieces.join(`

`), truncated };
}
function groupClaudeBashBlocks(rawLines, detectedBlocks, options = {}) {
  const maxCommandChars = boundedInteger(options.maxCommandChars, DEFAULT_MAX_GROUP_COMMAND_CHARS, 1e6);
  const maxOutputChars = boundedInteger(options.maxOutputChars, DEFAULT_MAX_GROUP_OUTPUT_CHARS, 2000000);
  const barrierLines = new Set((options.barrierLines ?? []).filter((line) => Number.isSafeInteger(line) && line >= 0 && line <= rawLines.length));
  const sortedBlocks = [...detectedBlocks].filter((block) => block.rawStart >= 0 && block.rawEndExclusive <= rawLines.length && block.rawStart < block.rawEndExclusive).sort((a, b) => a.rawStart - b.rawStart);
  const blocks = [];
  let acceptedEnd = 0;
  for (const block of sortedBlocks) {
    if (blocks.length > 0 && block.rawStart < acceptedEnd)
      continue;
    blocks.push(block);
    acceptedEnd = block.rawEndExclusive;
  }
  const members = [];
  for (const block of blocks) {
    const current = members.at(-1);
    const previous = current?.at(-1);
    const blankOnlyGap = previous ? rawLines.slice(previous.rawEndExclusive, block.rawStart).every(isBlankPresentationRow) : false;
    if (current && previous && blankOnlyGap && !crossesBarrier(previous.rawEndExclusive, block.rawStart, barrierLines)) {
      current.push(block);
    } else {
      members.push([block]);
    }
  }
  return Object.freeze(members.map((groupBlocks) => {
    const first = groupBlocks[0];
    const last = groupBlocks.at(-1);
    const status = groupBlocks.some((block) => block.status === "active") ? "active" : "completed";
    let rawStart = first.rawStart;
    let leadingStart = rawStart;
    while (leadingStart > 0 && !barrierLines.has(leadingStart) && isBlankPresentationRow(rawLines[leadingStart - 1] ?? ""))
      leadingStart -= 1;
    if (leadingStart > 0 && !barrierLines.has(leadingStart)) {
      rawStart = leadingStart;
    }
    let rawEndExclusive = last.rawEndExclusive;
    let trailingEnd = rawEndExclusive;
    while (trailingEnd < rawLines.length && !barrierLines.has(trailingEnd) && isBlankPresentationRow(rawLines[trailingEnd] ?? ""))
      trailingEnd += 1;
    if (trailingEnd < rawLines.length && !barrierLines.has(trailingEnd)) {
      rawEndExclusive = trailingEnd;
    }
    const command = mergedGroupPreview(groupBlocks, "command", maxCommandChars);
    const output = mergedGroupPreview(groupBlocks, "output", maxOutputChars);
    const fingerprint = groupBlocks.length === 1 ? first.fingerprint : groupFingerprint(groupBlocks, status);
    return Object.freeze({
      id: fingerprint,
      fingerprint,
      lineCount: rawEndExclusive - rawStart,
      rawStart,
      rawEndExclusive,
      status,
      sourceRange: range(rawStart, rawEndExclusive),
      blockCount: groupBlocks.length,
      blocks: Object.freeze([...groupBlocks]),
      command: command.text,
      output: output.text,
      commandTruncated: command.truncated,
      outputTruncated: output.truncated
    });
  }));
}
function summaryFor(summaries, fingerprint) {
  if (!summaries)
    return null;
  const maybeMap = summaries;
  if (typeof maybeMap.get === "function")
    return maybeMap.get(fingerprint) ?? null;
  const record = summaries;
  if (!Object.prototype.hasOwnProperty.call(record, fingerprint))
    return null;
  return record[fingerprint] ?? null;
}
function cleanPlaceholderText(text, maxChars) {
  const plain = stripAnsi2(text).replace(/\u00a0/g, " ").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "").replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "").replace(/\s+/g, " ").trim();
  return truncateUtf16(plain, maxChars).text;
}
function groupedPlaceholderLine(group, mode, summaries, maxSummaryChars, summaryEligible) {
  if (group.status === "active") {
    return { line: "Bash กำลังรัน…", needsSummary: false, summaryState: "none" };
  }
  if (mode === "hide") {
    const rows = group.sourceRange.endLine - group.sourceRange.startLine;
    return { line: `Bash ซ่อนอยู่ · ${rows} แถว`, needsSummary: false, summaryState: "none" };
  }
  const summary = summaryFor(summaries, group.fingerprint);
  const clean = summary === null ? "" : cleanPlaceholderText(summary, maxSummaryChars);
  if (clean)
    return { line: `Bash · ${clean}`, needsSummary: false, summaryState: "resolved" };
  if (!summaryEligible) {
    return { line: "hidden bash", needsSummary: false, summaryState: "suppressed" };
  }
  return { line: "Bash กำลังสรุป…", needsSummary: true, summaryState: "pending" };
}
function groupedIdentityProjection(rawLines, mode, detectedBlocks = Object.freeze([])) {
  const rows = rawLines.map((line, visualRow) => Object.freeze({
    visualRow,
    kind: "raw",
    line,
    rawRange: range(visualRow, visualRow + 1),
    rawStart: visualRow,
    rawEndExclusive: visualRow + 1,
    group: null,
    block: null,
    fingerprint: null,
    status: null,
    summaryState: "none"
  }));
  const visualToRawRange = rows.map((row) => row.rawRange);
  const rawToVisualRow = rawLines.map((_, index) => index);
  return Object.freeze({
    mode,
    rawLines,
    lines: rawLines,
    rows: Object.freeze(rows),
    visualToRawRange: Object.freeze(visualToRawRange),
    visualToRaw: Object.freeze(visualToRawRange),
    rawToVisualRow: Object.freeze(rawToVisualRow),
    rawToVisual: Object.freeze(rawToVisualRow),
    detectedBlocks,
    detectedGroups: Object.freeze([]),
    summaryRequests: Object.freeze([])
  });
}
function projectClaudeBashGroupedLines(rawLines, options) {
  if (options.mode === "off")
    return groupedIdentityProjection(rawLines, "off");
  const detection = options.detection ?? detectClaudeBashBlocks(rawLines, options.detectionOptions);
  if (!detection.enabled || detection.blocks.length === 0) {
    return groupedIdentityProjection(rawLines, options.mode, detection.blocks);
  }
  const maxSummaryChars = boundedInteger(options.maxSummaryChars, DEFAULT_MAX_SUMMARY_CHARS, 4096);
  const groups = groupClaudeBashBlocks(rawLines, detection.blocks, options.groupingOptions);
  const rows = [];
  const rawToVisualRow = new Array(rawLines.length);
  const summaryRequests = [];
  const requested = new Set;
  let rawLine = 0;
  const pushRaw = (index) => {
    const visualRow = rows.length;
    rows.push(Object.freeze({
      visualRow,
      kind: "raw",
      line: rawLines[index] ?? "",
      rawRange: range(index, index + 1),
      rawStart: index,
      rawEndExclusive: index + 1,
      group: null,
      block: null,
      fingerprint: null,
      status: null,
      summaryState: "none"
    }));
    rawToVisualRow[index] = visualRow;
  };
  for (const group of groups) {
    const { startLine, endLine } = group.sourceRange;
    if (startLine < rawLine)
      continue;
    while (rawLine < startLine) {
      pushRaw(rawLine);
      rawLine += 1;
    }
    const placeholder = groupedPlaceholderLine(group, options.mode, options.summaries, maxSummaryChars, options.summaryEligibleIds?.has(group.fingerprint) ?? true);
    const visualRow = rows.length;
    rows.push(Object.freeze({
      visualRow,
      kind: "bash-placeholder",
      line: placeholder.line,
      rawRange: group.sourceRange,
      rawStart: startLine,
      rawEndExclusive: endLine,
      group,
      block: group.blockCount === 1 ? group.blocks[0] ?? null : null,
      fingerprint: group.fingerprint,
      status: group.status,
      summaryState: placeholder.summaryState
    }));
    for (let index = startLine;index < endLine; index += 1) {
      rawToVisualRow[index] = visualRow;
    }
    rawLine = endLine;
    if (placeholder.needsSummary && !requested.has(group.fingerprint)) {
      requested.add(group.fingerprint);
      summaryRequests.push(Object.freeze({
        id: group.id,
        fingerprint: group.fingerprint,
        lineCount: group.lineCount,
        command: group.command,
        output: group.output,
        commandTruncated: group.commandTruncated,
        outputTruncated: group.outputTruncated,
        blockCount: group.blockCount
      }));
    }
  }
  while (rawLine < rawLines.length) {
    pushRaw(rawLine);
    rawLine += 1;
  }
  const lines = rows.map((row) => row.line);
  const visualToRawRange = rows.map((row) => row.rawRange);
  return Object.freeze({
    mode: options.mode,
    rawLines,
    lines: Object.freeze(lines),
    rows: Object.freeze(rows),
    visualToRawRange: Object.freeze(visualToRawRange),
    visualToRaw: Object.freeze(visualToRawRange),
    rawToVisualRow: Object.freeze(rawToVisualRow),
    rawToVisual: Object.freeze(rawToVisualRow),
    detectedBlocks: detection.blocks,
    detectedGroups: groups,
    summaryRequests: Object.freeze(summaryRequests)
  });
}
function legacyPlaceholderLine(block, mode, summaries, maxSummaryChars) {
  if (block.status === "active") {
    return { line: "Bash กำลังรัน…", needsSummary: false };
  }
  if (mode === "hide") {
    const rows = block.sourceRange.endLine - block.sourceRange.startLine;
    return { line: `Bash ซ่อนอยู่ · ${rows} แถว`, needsSummary: false };
  }
  const summary = summaryFor(summaries, block.fingerprint);
  const clean = summary === null ? "" : cleanPlaceholderText(summary, maxSummaryChars);
  if (!clean)
    return { line: "Bash กำลังสรุป…", needsSummary: true };
  return { line: `Bash · ${clean}`, needsSummary: false };
}
function identityProjection(rawLines, mode, detectedBlocks = Object.freeze([])) {
  const rows = rawLines.map((line, visualRow) => Object.freeze({
    visualRow,
    kind: "raw",
    line,
    rawRange: range(visualRow, visualRow + 1),
    rawStart: visualRow,
    rawEndExclusive: visualRow + 1,
    block: null,
    fingerprint: null,
    status: null
  }));
  const visualToRawRange = rows.map((row) => row.rawRange);
  const rawToVisualRow = rawLines.map((_, index) => index);
  return Object.freeze({
    mode,
    rawLines,
    lines: rawLines,
    rows: Object.freeze(rows),
    visualToRawRange: Object.freeze(visualToRawRange),
    visualToRaw: Object.freeze(visualToRawRange),
    rawToVisualRow: Object.freeze(rawToVisualRow),
    rawToVisual: Object.freeze(rawToVisualRow),
    detectedBlocks,
    summaryRequests: Object.freeze([])
  });
}
function projectClaudeBashLines(rawLines, options) {
  if (options.mode === "off")
    return identityProjection(rawLines, "off");
  const detection = options.detection ?? detectClaudeBashBlocks(rawLines, options.detectionOptions);
  if (!detection.enabled || detection.blocks.length === 0) {
    return identityProjection(rawLines, options.mode, detection.blocks);
  }
  const maxSummaryChars = boundedInteger(options.maxSummaryChars, DEFAULT_MAX_SUMMARY_CHARS, 4096);
  const candidates = [...detection.blocks].filter((block) => block.sourceRange.startLine >= 0 && block.sourceRange.endLine <= rawLines.length && block.sourceRange.startLine < block.sourceRange.endLine).sort((a, b) => a.sourceRange.startLine - b.sourceRange.startLine);
  const rows = [];
  const rawToVisualRow = new Array(rawLines.length);
  const summaryRequests = [];
  const requested = new Set;
  let rawLine = 0;
  const pushRaw = (index) => {
    const visualRow = rows.length;
    rows.push(Object.freeze({
      visualRow,
      kind: "raw",
      line: rawLines[index] ?? "",
      rawRange: range(index, index + 1),
      rawStart: index,
      rawEndExclusive: index + 1,
      block: null,
      fingerprint: null,
      status: null
    }));
    rawToVisualRow[index] = visualRow;
  };
  for (const block of candidates) {
    const { startLine, endLine } = block.sourceRange;
    if (startLine < rawLine)
      continue;
    while (rawLine < startLine) {
      pushRaw(rawLine);
      rawLine += 1;
    }
    const placeholder = legacyPlaceholderLine(block, options.mode, options.summaries, maxSummaryChars);
    const visualRow = rows.length;
    rows.push(Object.freeze({
      visualRow,
      kind: "bash-placeholder",
      line: placeholder.line,
      rawRange: block.sourceRange,
      rawStart: startLine,
      rawEndExclusive: endLine,
      block,
      fingerprint: block.fingerprint,
      status: block.status
    }));
    for (let index = startLine;index < endLine; index += 1) {
      rawToVisualRow[index] = visualRow;
    }
    rawLine = endLine;
    if (placeholder.needsSummary && !requested.has(block.fingerprint)) {
      requested.add(block.fingerprint);
      summaryRequests.push(Object.freeze({
        id: block.id,
        fingerprint: block.fingerprint,
        lineCount: block.lineCount,
        command: block.command,
        output: block.output,
        commandTruncated: block.commandTruncated,
        outputTruncated: block.outputTruncated
      }));
    }
  }
  while (rawLine < rawLines.length) {
    pushRaw(rawLine);
    rawLine += 1;
  }
  const lines = rows.map((row) => row.line);
  const visualToRawRange = rows.map((row) => row.rawRange);
  return Object.freeze({
    mode: options.mode,
    rawLines,
    lines: Object.freeze(lines),
    rows: Object.freeze(rows),
    visualToRawRange: Object.freeze(visualToRawRange),
    visualToRaw: Object.freeze(visualToRawRange),
    rawToVisualRow: Object.freeze(rawToVisualRow),
    rawToVisual: Object.freeze(rawToVisualRow),
    detectedBlocks: detection.blocks,
    summaryRequests: Object.freeze(summaryRequests)
  });
}
// src/tool-projection.ts
var MAX_RECONCILE_DP_CELLS = 512 * 512;
function selectMonotonicIndices(larger, smaller) {
  if (smaller.length === 0)
    return [];
  if (larger.length === smaller.length)
    return larger.map((_, index) => index);
  if (larger.length * smaller.length <= MAX_RECONCILE_DP_CELLS) {
    const columns = smaller.length + 1;
    const decisions = new Uint8Array((larger.length + 1) * columns);
    let previousCosts = new Float64Array(columns);
    let currentCosts = new Float64Array(columns);
    previousCosts.fill(Number.POSITIVE_INFINITY);
    previousCosts[0] = 0;
    for (let largerIndex2 = 1;largerIndex2 <= larger.length; largerIndex2 += 1) {
      currentCosts.fill(Number.POSITIVE_INFINITY);
      currentCosts[0] = 0;
      const reachable = Math.min(largerIndex2, smaller.length);
      for (let smallerIndex2 = 1;smallerIndex2 <= reachable; smallerIndex2 += 1) {
        const skipCost = previousCosts[smallerIndex2] ?? Number.POSITIVE_INFINITY;
        const matchCost = (previousCosts[smallerIndex2 - 1] ?? Number.POSITIVE_INFINITY) + Math.abs((larger[largerIndex2 - 1] ?? 0) - (smaller[smallerIndex2 - 1] ?? 0));
        if (matchCost < skipCost) {
          currentCosts[smallerIndex2] = matchCost;
          decisions[largerIndex2 * columns + smallerIndex2] = 1;
        } else
          currentCosts[smallerIndex2] = skipCost;
      }
      [previousCosts, currentCosts] = [currentCosts, previousCosts];
    }
    const selected2 = Array(smaller.length);
    let largerIndex = larger.length;
    let smallerIndex = smaller.length;
    while (smallerIndex > 0 && largerIndex > 0) {
      if (decisions[largerIndex * columns + smallerIndex] === 1) {
        selected2[smallerIndex - 1] = largerIndex - 1;
        smallerIndex -= 1;
      }
      largerIndex -= 1;
    }
    return selected2;
  }
  const selected = [];
  let cursor = 0;
  for (let smallerIndex = 0;smallerIndex < smaller.length; smallerIndex += 1) {
    const maximum = larger.length - (smaller.length - smallerIndex);
    const target = smaller[smallerIndex] ?? 0;
    while (cursor < maximum) {
      const currentDistance = Math.abs((larger[cursor] ?? 0) - target);
      const nextDistance = Math.abs((larger[cursor + 1] ?? 0) - target);
      if (nextDistance >= currentDistance)
        break;
      cursor += 1;
    }
    selected.push(cursor);
    cursor += 1;
  }
  return selected;
}
function monotonicSourcePairs(previous, next) {
  if (previous.length === 0 || next.length === 0)
    return [];
  if (previous.length >= next.length) {
    const selectedPrevious = selectMonotonicIndices(previous.map(({ startLine }) => startLine), next.map(({ startLine }) => startLine));
    return next.flatMap((nextOccurrence, index) => {
      const previousOccurrence = previous[selectedPrevious[index] ?? -1];
      return previousOccurrence ? [{ previous: previousOccurrence.block, nextIndex: nextOccurrence.nextIndex }] : [];
    });
  }
  const selectedNext = selectMonotonicIndices(next.map(({ startLine }) => startLine), previous.map(({ startLine }) => startLine));
  return previous.flatMap((previousOccurrence, index) => {
    const nextOccurrence = next[selectedNext[index] ?? -1];
    return nextOccurrence ? [{ previous: previousOccurrence.block, nextIndex: nextOccurrence.nextIndex }] : [];
  });
}
function sortedPreviousOccurrences(blocks) {
  return blocks.map((block, order) => ({
    block,
    order,
    startLine: block.sourceRange.startLine
  })).filter(({ startLine }) => Number.isSafeInteger(startLine)).sort((left, right) => left.startLine - right.startLine || left.order - right.order);
}
function sortedNextOccurrences(indexes, nextBlocks) {
  return indexes.map((nextIndex, order) => ({
    nextIndex,
    order,
    startLine: nextBlocks[nextIndex]?.sourceRange.startLine ?? Number.NaN
  })).filter(({ startLine }) => Number.isSafeInteger(startLine)).sort((left, right) => left.startLine - right.startLine || left.order - right.order);
}
function detectorPhysicalRow(block) {
  const prefix = `${block.fingerprint}:row-`;
  if (!block.id.startsWith(prefix))
    return null;
  const row = Number(block.id.slice(prefix.length));
  return Number.isSafeInteger(row) ? row : null;
}
var detectorOriginByBlock = new WeakMap;
function detectorOrigin(block) {
  if (detectorOriginByBlock.has(block))
    return detectorOriginByBlock.get(block) ?? null;
  const absoluteRow = detectorPhysicalRow(block);
  const origin = absoluteRow === null ? null : absoluteRow - block.sourceRange.startLine;
  const safeOrigin = origin !== null && Number.isSafeInteger(origin) ? origin : null;
  detectorOriginByBlock.set(block, safeOrigin);
  return safeOrigin;
}
function occurrenceLookupId(block) {
  const origin = detectorOrigin(block);
  const absoluteRow = origin === null ? null : origin + block.sourceRange.startLine;
  return absoluteRow !== null && Number.isSafeInteger(absoluteRow) ? `${block.fingerprint}:row-${absoluteRow}` : block.id;
}
function commonDetectorOrigin(occurrences, blockAt) {
  let common = null;
  for (const occurrence of occurrences) {
    const block = blockAt(occurrence);
    if (!block)
      return null;
    const origin = detectorOrigin(block);
    if (origin === null)
      return null;
    if (common === null)
      common = origin;
    else if (common !== origin)
      return null;
  }
  return common;
}
function reconcileToolBlockIds(previousBlocks, nextBlocks) {
  if (previousBlocks.length === 0 || nextBlocks.length === 0)
    return nextBlocks;
  const previousById = new Map(previousBlocks.map((block) => [
    occurrenceLookupId(block),
    block
  ]));
  const exactCandidateByNext = new Map;
  const forceFreshNext = new Set;
  const assigned = Array(nextBlocks.length).fill(null);
  nextBlocks.forEach((block, index) => {
    const exact = previousById.get(occurrenceLookupId(block));
    if (exact?.fingerprint === block.fingerprint)
      exactCandidateByNext.set(index, exact);
  });
  const previousByFingerprint = new Map;
  for (const block of previousBlocks) {
    const group = previousByFingerprint.get(block.fingerprint);
    if (group)
      group.push(block);
    else
      previousByFingerprint.set(block.fingerprint, [block]);
  }
  const nextByFingerprint = new Map;
  nextBlocks.forEach((block, index) => {
    const group = nextByFingerprint.get(block.fingerprint);
    if (group)
      group.push(index);
    else
      nextByFingerprint.set(block.fingerprint, [index]);
  });
  for (const [fingerprint, nextIndexes] of nextByFingerprint) {
    const previous = sortedPreviousOccurrences(previousByFingerprint.get(fingerprint) ?? []);
    const next = sortedNextOccurrences(nextIndexes, nextBlocks);
    if (previous.length === 0 || next.length === 0)
      continue;
    const previousPosition = new Map(previous.map((occurrence, index) => [
      occurrence.block,
      index
    ]));
    const nextPosition = new Map(next.map((occurrence, index) => [
      occurrence.nextIndex,
      index
    ]));
    const previousOrigin = commonDetectorOrigin(previous, (occurrence) => ("block" in occurrence) ? occurrence.block : undefined);
    const nextOrigin = commonDetectorOrigin(next, (occurrence) => ("nextIndex" in occurrence) ? nextBlocks[occurrence.nextIndex] : undefined);
    const detectorOriginChanged = previousOrigin !== null && nextOrigin !== null && previousOrigin !== nextOrigin;
    const anchors = nextIndexes.flatMap((nextIndex) => {
      const exact = exactCandidateByNext.get(nextIndex);
      const previousIndex = exact ? previousPosition.get(exact) : undefined;
      const nextIndexInOrder = nextPosition.get(nextIndex);
      const nextBlock = nextBlocks[nextIndex];
      const detectorRowCandidate = exact !== undefined && nextBlock !== undefined && detectorPhysicalRow(exact) !== null && detectorPhysicalRow(nextBlock) !== null;
      const unchangedDetectorOccurrence = detectorRowCandidate && previousOrigin !== null && nextOrigin !== null && previousOrigin === nextOrigin && previousIndex !== undefined && nextIndexInOrder !== undefined && previousIndex === nextIndexInOrder;
      if (detectorRowCandidate && !detectorOriginChanged && !unchangedDetectorOccurrence) {
        return [];
      }
      return previousIndex !== undefined && nextIndexInOrder !== undefined ? [{ previousIndex, nextIndex: nextIndexInOrder }] : [];
    }).sort((left, right) => left.previousIndex - right.previousIndex);
    if (previous.length === next.length && anchors.length === 0) {
      for (const pair of monotonicSourcePairs(previous, next)) {
        assigned[pair.nextIndex] = pair.previous.id;
      }
      continue;
    }
    const anchorsAreMonotonic = !anchors.some((anchor, index) => index > 0 && (anchor.previousIndex <= (anchors[index - 1]?.previousIndex ?? -1) || anchor.nextIndex <= (anchors[index - 1]?.nextIndex ?? -1)));
    const acceptedAnchors = anchorsAreMonotonic ? anchors : [];
    const acceptedAnchorNext = new Set(acceptedAnchors.map((anchor) => next[anchor.nextIndex]?.nextIndex).filter((nextIndex) => nextIndex !== undefined));
    const rejectedExactNext = [];
    for (const nextIndex of nextIndexes) {
      if (exactCandidateByNext.has(nextIndex) && !acceptedAnchorNext.has(nextIndex)) {
        rejectedExactNext.push(nextIndex);
      }
    }
    for (const anchor of acceptedAnchors) {
      const previousOccurrence = previous[anchor.previousIndex];
      const nextOccurrence = next[anchor.nextIndex];
      if (previousOccurrence && nextOccurrence) {
        assigned[nextOccurrence.nextIndex] = previousOccurrence.block.id;
      }
    }
    let previousCursor = 0;
    let nextCursor = 0;
    const corridorEnds = [
      ...acceptedAnchors,
      { previousIndex: previous.length, nextIndex: next.length }
    ];
    for (const end of corridorEnds) {
      const previousCorridor = previous.slice(previousCursor, end.previousIndex);
      const nextCorridor = next.slice(nextCursor, end.nextIndex);
      for (const pair of monotonicSourcePairs(previousCorridor, nextCorridor)) {
        if (assigned[pair.nextIndex] === null)
          assigned[pair.nextIndex] = pair.previous.id;
      }
      previousCursor = end.previousIndex + 1;
      nextCursor = end.nextIndex + 1;
    }
    for (const nextIndex of rejectedExactNext) {
      if (assigned[nextIndex] === null)
        forceFreshNext.add(nextIndex);
    }
  }
  const reservedAssignedIds = new Map;
  assigned.forEach((id, index) => {
    if (id !== null && !forceFreshNext.has(index))
      reservedAssignedIds.set(id, index);
  });
  const seen = new Set;
  return nextBlocks.map((block, index) => {
    const physicalOrigin = detectorOrigin(block);
    let id = assigned[index] ?? block.id;
    if (forceFreshNext.has(index) || assigned[index] === null && reservedAssignedIds.get(id) !== undefined || seen.has(id)) {
      const base = `${block.id}:provisional-${block.sourceRange.startLine}-${index}`;
      id = base;
      let suffix = 1;
      while (seen.has(id) || reservedAssignedIds.has(id)) {
        id = `${base}-${suffix}`;
        suffix += 1;
      }
    }
    seen.add(id);
    const reconciled = id === block.id ? block : Object.freeze({ ...block, id });
    detectorOriginByBlock.set(reconciled, physicalOrigin);
    return reconciled;
  });
}
function fnv1a323(text, seed) {
  let hash = seed >>> 0;
  for (let index = 0;index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash;
}
function stableToolFingerprint(provider, kind, outcome, semanticParts) {
  const normalizedContent = semanticParts.map((part) => stripTerminalControls(part)).join("").replace(/\u00a0/g, " ").replace(/\s+/gu, "");
  const normalized = [provider, kind, outcome, normalizedContent].join("\x00");
  const first = fnv1a323(normalized, 2166136261).toString(16).padStart(8, "0");
  const second = fnv1a323(normalized, 2654435769).toString(16).padStart(8, "0");
  return `tool-v1-${first}${second}`;
}
function range2(startLine, endLine) {
  return Object.freeze({ startLine, endLine });
}
function validRange(candidate, lineCount) {
  return Number.isSafeInteger(candidate.startLine) && Number.isSafeInteger(candidate.endLine) && candidate.startLine >= 0 && candidate.startLine < candidate.endLine && candidate.endLine <= lineCount;
}
function contains(outer, inner) {
  return outer.startLine <= inner.startLine && outer.endLine >= inner.endLine;
}
function overlaps(left, right) {
  return left.startLine < right.endLine && right.startLine < left.endLine;
}
function orderedWithoutOverlap(ranges) {
  for (let index = 1;index < ranges.length; index += 1) {
    const previous = ranges[index - 1];
    const current = ranges[index];
    if (!previous || !current || previous.endLine > current.startLine)
      return false;
  }
  return true;
}
function classifyOne(block, lineCount) {
  if (block.id.trim() === "" || block.fingerprint.trim() === "" || block.label.trim() === "") {
    return "invalid-identity";
  }
  if (!validRange(block.sourceRange, lineCount))
    return "invalid-source-range";
  if (!validRange(block.proofRange, lineCount))
    return "invalid-proof-range";
  if (!contains(block.proofRange, block.sourceRange))
    return "proof-does-not-cover-source";
  if (block.collapseRanges.length === 0)
    return "invalid-collapse-range";
  if (block.collapseRanges.some((candidate) => !validRange(candidate, lineCount))) {
    return "invalid-collapse-range";
  }
  if (block.protectedRanges.some((candidate) => !validRange(candidate, lineCount))) {
    return "invalid-protected-range";
  }
  const allRanges = [...block.collapseRanges, ...block.protectedRanges];
  if (allRanges.some((candidate) => !contains(block.sourceRange, candidate))) {
    return "range-outside-source";
  }
  if (!orderedWithoutOverlap(block.collapseRanges) || !orderedWithoutOverlap(block.protectedRanges))
    return "range-overlap";
  const ordered = [...allRanges].sort((left, right) => left.startLine - right.startLine);
  for (let index = 1;index < ordered.length; index += 1) {
    const previous = ordered[index - 1];
    const current = ordered[index];
    if (!previous || !current || overlaps(previous, current))
      return "range-overlap";
  }
  let cursor = block.sourceRange.startLine;
  for (const candidate of ordered) {
    if (candidate.startLine !== cursor)
      return "source-not-fully-classified";
    cursor = candidate.endLine;
  }
  return cursor === block.sourceRange.endLine ? null : "source-not-fully-classified";
}
function validateToolCollapseBlocks(rawLines, blocks) {
  const rejectedByIndex = new Map;
  blocks.forEach((block, index) => {
    const reason = classifyOne(block, rawLines.length);
    if (reason)
      rejectedByIndex.set(index, reason);
  });
  const individuallyInvalid = new Set(rejectedByIndex.keys());
  const idOwners = new Map;
  blocks.forEach((block, index) => {
    if (individuallyInvalid.has(index))
      return;
    const owners = idOwners.get(block.id);
    if (owners)
      owners.push(index);
    else
      idOwners.set(block.id, [index]);
  });
  for (const owners of idOwners.values()) {
    if (owners.length < 2)
      continue;
    for (const index of owners)
      rejectedByIndex.set(index, "duplicate-id");
  }
  const orderedBlocks = blocks.flatMap((block, index) => individuallyInvalid.has(index) ? [] : [{ block, index }]).sort((left, right) => left.block.sourceRange.startLine - right.block.sourceRange.startLine || right.block.sourceRange.endLine - left.block.sourceRange.endLine);
  let furthest = null;
  for (const current of orderedBlocks) {
    if (furthest && overlaps(furthest.block.sourceRange, current.block.sourceRange)) {
      rejectedByIndex.set(furthest.index, "block-overlap");
      rejectedByIndex.set(current.index, "block-overlap");
    }
    if (!furthest || current.block.sourceRange.endLine > furthest.block.sourceRange.endLine) {
      furthest = current;
    }
  }
  const acceptedBlocks = blocks.filter((_, index) => !rejectedByIndex.has(index)).slice().sort((left, right) => left.sourceRange.startLine - right.sourceRange.startLine);
  const rejectedBlocks = blocks.flatMap((block, index) => {
    const reason = rejectedByIndex.get(index);
    return reason ? [{ block, reason }] : [];
  });
  return { acceptedBlocks, rejectedBlocks };
}
function defaultPlaceholder(context) {
  return `${context.block.label} ซ่อนอยู่ · ${context.lineCount} แถว`;
}
function rawProjectionRows(rawLines) {
  return rawLines.map((line, rawRow) => ({
    visualRow: rawRow,
    kind: "raw",
    line,
    rawStart: rawRow,
    rawEndExclusive: rawRow + 1,
    rawRange: range2(rawRow, rawRow + 1),
    block: null,
    fingerprint: null,
    placeholderKey: null
  }));
}
function projectToolLines(rawLines, options) {
  if (options.enabled === false) {
    const rows2 = rawProjectionRows(rawLines);
    const visualToRawRange2 = rows2.map((row) => row.rawRange);
    const rawToVisualRow2 = rows2.map((row) => row.visualRow);
    return {
      rawLines,
      lines: rawLines,
      rows: rows2,
      visualToRawRange: visualToRawRange2,
      visualToRaw: visualToRawRange2,
      rawToVisualRow: rawToVisualRow2,
      rawToVisual: rawToVisualRow2,
      projectedBlocks: [],
      rejectedBlocks: [],
      hiddenLineCount: 0
    };
  }
  const validation = validateToolCollapseBlocks(rawLines, options.blocks);
  if (validation.acceptedBlocks.length === 0) {
    const rows2 = rawProjectionRows(rawLines);
    const visualToRawRange2 = rows2.map((row) => row.rawRange);
    const rawToVisualRow2 = rows2.map((row) => row.visualRow);
    return {
      rawLines,
      lines: rawLines,
      rows: rows2,
      visualToRawRange: visualToRawRange2,
      visualToRaw: visualToRawRange2,
      rawToVisualRow: rawToVisualRow2,
      rawToVisual: rawToVisualRow2,
      projectedBlocks: [],
      rejectedBlocks: validation.rejectedBlocks,
      hiddenLineCount: 0
    };
  }
  const collapseAt = new Map;
  for (const block of validation.acceptedBlocks) {
    block.collapseRanges.forEach((collapseRange, collapseIndex) => {
      collapseAt.set(collapseRange.startLine, {
        block,
        collapseRange,
        collapseIndex
      });
    });
  }
  const rows = [];
  const rawToVisualRow = Array(rawLines.length);
  let hiddenLineCount = 0;
  for (let rawRow = 0;rawRow < rawLines.length; ) {
    const entry = collapseAt.get(rawRow);
    if (!entry) {
      const visualRow2 = rows.length;
      const rawRange = range2(rawRow, rawRow + 1);
      rows.push({
        visualRow: visualRow2,
        kind: "raw",
        line: rawLines[rawRow] ?? "",
        rawStart: rawRow,
        rawEndExclusive: rawRow + 1,
        rawRange,
        block: null,
        fingerprint: null,
        placeholderKey: null
      });
      rawToVisualRow[rawRow] = visualRow2;
      rawRow += 1;
      continue;
    }
    const visualRow = rows.length;
    const lineCount = entry.collapseRange.endLine - entry.collapseRange.startLine;
    const placeholderKey = `tool-placeholder:${entry.block.provider}:` + `${entry.block.id}:part-${entry.collapseIndex}`;
    const context = {
      block: entry.block,
      collapseRange: entry.collapseRange,
      collapseIndex: entry.collapseIndex,
      lineCount,
      placeholderKey
    };
    rows.push({
      visualRow,
      kind: "tool-placeholder",
      line: (options.placeholder ?? defaultPlaceholder)(context),
      rawStart: entry.collapseRange.startLine,
      rawEndExclusive: entry.collapseRange.endLine,
      rawRange: entry.collapseRange,
      block: entry.block,
      fingerprint: entry.block.fingerprint,
      placeholderKey
    });
    for (let hiddenRow = entry.collapseRange.startLine;hiddenRow < entry.collapseRange.endLine; hiddenRow += 1)
      rawToVisualRow[hiddenRow] = visualRow;
    hiddenLineCount += lineCount;
    rawRow = entry.collapseRange.endLine;
  }
  const lines = rows.map((row) => row.line);
  const visualToRawRange = rows.map((row) => row.rawRange);
  return {
    rawLines,
    lines,
    rows,
    visualToRawRange,
    visualToRaw: visualToRawRange,
    rawToVisualRow,
    rawToVisual: rawToVisualRow,
    projectedBlocks: validation.acceptedBlocks,
    rejectedBlocks: validation.rejectedBlocks,
    hiddenLineCount
  };
}
// src/codex-tools.ts
var DEFAULT_MAX_SCAN_LINES3 = 20000;
var DEFAULT_MAX_BLOCK_LINES2 = 2000;
var DEFAULT_MAX_BLOCK_CHARS = 8 * 1024 * 1024;
var DEFAULT_MAX_BLOCKS2 = 512;
var MAX_ROW_CHARS = 65536;
var MAX_LIMIT = 1e5;
var MAX_BLOCK_CHARS = 16 * 1024 * 1024;
var SUCCESS_BULLET = /^(?:\x1b\[0m)?\x1b\[(?:0;)?1m\x1b\[38;5;2m(?:\x1b\[49m)?•\x1b\[0m /u;
var FAILURE_BULLET = /^(?:\x1b\[0m)?\x1b\[(?:0;)?1m\x1b\[38;5;1m(?:\x1b\[49m)?•\x1b\[0m /u;
var DIM_EVENT_PREFIX = /^\x1b\[(?:0;)?2m• \x1b\[0;1m/u;
var RUN_GROUP = new RegExp("^(?:\\x1b\\[0m)?\\x1b\\[(?:0;)?1m\\x1b\\[38;5;2m" + "(?:\\x1b\\[49m)?•\\x1b\\[0m \\x1b\\[(?:0;)?1m" + "Ran ([1-9]\\d*) command(s?)\\x1b\\[0;2m · ctrl \\+ t to view transcript" + "\\x1b\\[0m$", "u");
var RUN_SUCCESS = new RegExp("^(?:\\x1b\\[0m)?\\x1b\\[(?:0;)?1m\\x1b\\[38;5;2m" + "(?:\\x1b\\[49m)?•\\x1b\\[0m \\x1b\\[(?:0;)?1mRan\\x1b\\[0m " + "((?=\\x1b\\[38;(?:2|5);).+)$", "u");
var WAITED = new RegExp("^\\x1b\\[(?:0;)?1m• Waited for background terminal" + "(?:\\x1b\\[0;2m(?: · (.*?))?(?:\\x1b\\[0m)?|\\x1b\\[0m)$", "u");
var BACKGROUND_INTERACTION = new RegExp("^\\x1b\\[(?:0;)?2m↳ \\x1b\\[0;1mInteracted with background terminal" + "\\x1b\\[0;2m(?: · (.*?))?(?:\\x1b\\[0m)?$", "u");
var AGENT_EVENT = /^\x1b\[(?:0;)?2m• \x1b\[0;1m(Waiting for agents|Finished waiting|Viewed Image)\x1b\[0m$/u;
var AGENT_INTERACTION = /^\x1b\[(?:0;)?2m• \x1b\[0;1mInteracted with \x1b\[0m\x1b\[38;5;6m(`[^`\n]+`)\x1b\[39m$/u;
var AGENT_LIFECYCLE = /^\x1b\[(?:0;)?2m• \x1b\[0;1m(Started|Completed) \x1b\[0m\x1b\[38;5;6m(`[^`\n]+`)\x1b\[39m$/u;
var EDITED = /^\x1b\[(?:0;)?2m• \x1b\[0;1mEdited\x1b\[0m (.+) \(\x1b\[38;5;2m\+(\d+)\x1b\[39m \x1b\[38;5;1m-(\d+)\x1b\[39m\)$/u;
var DIM_ROW = /^\x1b\[(?:0;)?2m.*\x1b\[0m$/u;
var TREE_DETAIL = /^\x1b\[(?:0;)?2m  └ .+\x1b\[0m$/u;
var TREE_DETAIL_RESET_MARKER = /^\x1b\[(?:0;)?2m  └ \x1b\[0m.+$/u;
function boundedInteger2(value, fallback, maximum) {
  if (value === undefined || !Number.isFinite(value))
    return fallback;
  return Math.max(0, Math.min(maximum, Math.floor(value)));
}
function range3(startLine, endLine) {
  return Object.freeze({ startLine, endLine });
}
function hasOnlyCompleteTerminalControls(raw) {
  let index = 0;
  while (index < raw.length) {
    if (raw[index] !== "\x1B") {
      index += 1;
      continue;
    }
    const next = raw[index + 1];
    if (next === "[") {
      let end = index + 2;
      while (end < raw.length) {
        const code = raw.charCodeAt(end);
        if (code === 27)
          return false;
        if (code >= 64 && code <= 126)
          break;
        end += 1;
      }
      if (end >= raw.length)
        return false;
      index = end + 1;
      continue;
    }
    if (next === "]") {
      let end = index + 2;
      let terminated = false;
      while (end < raw.length) {
        if (raw[end] === "\x07") {
          index = end + 1;
          terminated = true;
          break;
        }
        if (raw[end] === "\x1B" && raw[end + 1] === "\\") {
          index = end + 2;
          terminated = true;
          break;
        }
        end += 1;
      }
      if (!terminated)
        return false;
      continue;
    }
    if (next === "(" || next === ")" || next === "*" || next === "+" || next === "-" || next === "." || next === "/" || next === "#" || next === "%") {
      if (index + 2 >= raw.length || raw[index + 2] === "\x1B")
        return false;
      index += 3;
      continue;
    }
    if (next === "7" || next === "8" || next === "D" || next === "E" || next === "H" || next === "M" || next === "c" || next === "=") {
      index += 2;
      continue;
    }
    return false;
  }
  return true;
}
function visible(raw) {
  return stripTerminalControls(raw).replace(/\u00a0/g, " ").trimEnd();
}
function applySgrPaint(parameters, initial) {
  const values = (parameters === "" ? ["0"] : parameters.replaceAll(":", ";").split(";")).map((part) => Number.parseInt(part.split(":", 1)[0] ?? "", 10));
  let dim = initial.dim;
  let foreground = initial.foreground;
  for (let index = 0;index < values.length; index += 1) {
    const code = values[index];
    if (code === 38 || code === 48 || code === 58) {
      const colorMode = values[index + 1];
      if (colorMode === 2) {
        if (code === 38) {
          foreground = values.slice(index, index + 5).join(";");
        }
        index += 4;
      } else if (colorMode === 5) {
        if (code === 38) {
          foreground = values.slice(index, index + 3).join(";");
        }
        index += 2;
      } else if (code === 38)
        foreground = "38;unknown";
      continue;
    }
    if (code === 0) {
      dim = false;
      foreground = null;
    } else if (code === 2)
      dim = true;
    else if (code === 22)
      dim = false;
    else if (code !== undefined && code >= 30 && code <= 37 || code !== undefined && code >= 90 && code <= 97)
      foreground = String(code);
    else if (code === 39)
      foreground = null;
  }
  return { dim, foreground };
}
function dimPaintEvidence(raw, inherited) {
  let state = { ...inherited };
  let firstSemanticCellDim = false;
  let firstSemanticCellForeground = false;
  let firstSemanticCellForegroundKey = null;
  let hasSemanticCell = false;
  let allSemanticCellsUndim = true;
  const semanticForegroundKeys = new Set;
  let index = 0;
  while (index < raw.length) {
    if (raw[index] !== "\x1B") {
      const codePoint = raw.codePointAt(index);
      const char = codePoint === undefined ? "" : String.fromCodePoint(codePoint);
      if (!hasSemanticCell && char !== "" && !/\s/u.test(char)) {
        hasSemanticCell = true;
        firstSemanticCellDim = state.dim;
        firstSemanticCellForeground = state.foreground !== null;
        firstSemanticCellForegroundKey = state.foreground;
      }
      if (char !== "" && !/\s/u.test(char)) {
        semanticForegroundKeys.add(state.foreground);
        if (state.dim)
          allSemanticCellsUndim = false;
      }
      index += char.length || 1;
      continue;
    }
    const next = raw[index + 1];
    if (next === "[") {
      let end = index + 2;
      while (end < raw.length) {
        const code = raw.charCodeAt(end);
        if (code >= 64 && code <= 126)
          break;
        end += 1;
      }
      if (end >= raw.length)
        break;
      if (raw[end] === "m")
        state = applySgrPaint(raw.slice(index + 2, end), state);
      index = end + 1;
      continue;
    }
    if (next === "]") {
      let end = index + 2;
      while (end < raw.length) {
        if (raw[end] === "\x07") {
          end += 1;
          break;
        }
        if (raw[end] === "\x1B" && raw[end + 1] === "\\") {
          end += 2;
          break;
        }
        end += 1;
      }
      index = end;
      continue;
    }
    if (next === "(" || next === ")" || next === "*" || next === "+" || next === "-" || next === "." || next === "/" || next === "#" || next === "%")
      index += 3;
    else
      index += 2;
  }
  return {
    firstSemanticCellDim,
    firstSemanticCellForeground,
    firstSemanticCellForegroundKey,
    semanticForegroundKeys: Object.freeze([...semanticForegroundKeys]),
    allSemanticCellsUndim,
    hasSemanticCell,
    endDim: state.dim,
    endForeground: state.foreground !== null,
    endForegroundKey: state.foreground
  };
}
function dimDetailRows(header) {
  const headerPaint = dimPaintEvidence(header, { dim: false, foreground: null });
  let inherited = { dim: headerPaint.endDim, foreground: headerPaint.endForegroundKey };
  return (raw) => {
    const evidence = dimPaintEvidence(raw, inherited);
    inherited = { dim: evidence.endDim, foreground: evidence.endForegroundKey };
    return evidence.hasSemanticCell && evidence.firstSemanticCellDim;
  };
}
function foregroundPalette(raw) {
  const colors = new Set;
  let state = { dim: false, foreground: null };
  const sgr = /\x1b\[([0-9:;]*)m/gu;
  for (const match of raw.matchAll(sgr)) {
    state = applySgrPaint(match[1] ?? "", state);
    if (state.foreground !== null && state.foreground !== "38;unknown") {
      colors.add(state.foreground);
    }
  }
  return colors;
}
function ranDetailRows(header, commandFragment) {
  const headerPaint = dimPaintEvidence(header, { dim: false, foreground: null });
  let inherited = { dim: headerPaint.endDim, foreground: headerPaint.endForegroundKey };
  const commandColors = foregroundPalette(commandFragment);
  let commandContinuationOpen = headerPaint.endForegroundKey !== null && commandColors.has(headerPaint.endForegroundKey);
  let sawDimDetail = false;
  return {
    accepts: (raw) => {
      const evidence = dimPaintEvidence(raw, inherited);
      inherited = { dim: evidence.endDim, foreground: evidence.endForegroundKey };
      if (!evidence.hasSemanticCell)
        return false;
      if (evidence.firstSemanticCellDim) {
        sawDimDetail = true;
        commandContinuationOpen = false;
        return true;
      }
      const usesOnlyCommandColors = evidence.firstSemanticCellForeground && evidence.firstSemanticCellForegroundKey !== null && evidence.semanticForegroundKeys.every((color) => color !== null && commandColors.has(color));
      if (commandContinuationOpen && evidence.allSemanticCellsUndim && usesOnlyCommandColors) {
        commandContinuationOpen = evidence.endForegroundKey !== null && commandColors.has(evidence.endForegroundKey);
        return true;
      }
      commandContinuationOpen = false;
      return false;
    },
    sawDimDetail: () => sawDimDetail
  };
}
function isSealRow(raw) {
  return /^[ \t]*$/.test(raw);
}
function leadingBoundaryIsKnown(rawLines, line, scanStart, leadingEdgeSealed) {
  if (line === 0)
    return scanStart === 0 && leadingEdgeSealed;
  if (line <= scanStart)
    return false;
  return isSealRow(rawLines[line - 1] ?? "");
}
function exactFailureHeader(raw) {
  return FAILURE_BULLET.test(raw) && /\x1b\[(?:0;)?1mRan\x1b\[0m /u.test(raw);
}
function isProtectedSemanticRow(raw) {
  if (raw.length > MAX_ROW_CHARS || !hasOnlyCompleteTerminalControls(raw))
    return true;
  const line = visible(raw).trim();
  if (line === "")
    return false;
  if (/^[›»](?:\s|$)/u.test(line))
    return true;
  if (/^(?:◦|•|·)\s+(?:Working|Thinking|Reading|Waiting)\b/iu.test(line)) {
    return true;
  }
  if (/^\d+\s+background terminals?\b/iu.test(line))
    return true;
  if (/\besc to interrupt\b/iu.test(line))
    return true;
  if (/^(?:■|⚠|Warning\b|Error\b|FAILED\b|Approval\b|Approve\b|Allow\b|Deny\b|Do you want\b)/iu.test(line)) {
    return true;
  }
  if (/^─+\s*Worked for\b/u.test(line) || /^─{8,}$/u.test(line))
    return true;
  if (exactFailureHeader(raw))
    return true;
  if (/^(?:◦|•|·)\s+/u.test(line))
    return true;
  return DIM_EVENT_PREFIX.test(raw) || SUCCESS_BULLET.test(raw);
}
function sealedBody(rawLines, startLine, maxBlockLines, maxBlockChars, acceptsRow) {
  const maximumEnd = Math.min(rawLines.length, startLine + maxBlockLines + 1);
  const bodyLines = [];
  let candidateChars = rawLines[startLine]?.length ?? 0;
  if (candidateChars > maxBlockChars)
    return null;
  for (let line = startLine + 1;line < maximumEnd; line += 1) {
    const raw = rawLines[line] ?? "";
    if (isSealRow(raw)) {
      const sourceEnd = line;
      if (sourceEnd <= startLine || sourceEnd - startLine > maxBlockLines)
        return null;
      return { sourceEnd, proofEnd: line + 1, bodyLines };
    }
    candidateChars += raw.length;
    if (candidateChars > maxBlockChars)
      return null;
    if (isProtectedSemanticRow(raw) || !acceptsRow(raw, bodyLines.length))
      return null;
    bodyLines.push(raw);
  }
  return null;
}
function completedBlock(kind, outcome, sourceStart, sourceEnd, proofEnd, collapseRanges, protectedRanges, label, semanticParts) {
  const fingerprint = stableToolFingerprint("codex", kind, outcome, semanticParts);
  return Object.freeze({
    id: fingerprint,
    provider: "codex",
    kind,
    outcome,
    sourceRange: range3(sourceStart, sourceEnd),
    proofRange: range3(sourceStart, proofEnd),
    collapseRanges: Object.freeze([...collapseRanges]),
    protectedRanges: Object.freeze([...protectedRanges]),
    fingerprint,
    label
  });
}
function wholeBlock(kind, outcome, startLine, body, label, semanticParts) {
  return completedBlock(kind, outcome, startLine, body.sourceEnd, body.proofEnd, [range3(startLine, body.sourceEnd)], [], label, semanticParts);
}
function oneLineSealed(rawLines, startLine) {
  const seal = rawLines[startLine + 1];
  return seal !== undefined && isSealRow(seal) ? { sourceEnd: startLine + 1, proofEnd: startLine + 2, bodyLines: [] } : null;
}
function waitingPair(rawLines, startLine, maxBlockLines, maxBlockChars) {
  if (!isSealRow(rawLines[startLine + 1] ?? "\x1B"))
    return null;
  const finishedLine = startLine + 2;
  if (AGENT_EVENT.exec(rawLines[finishedLine] ?? "")?.[1] !== "Finished waiting")
    return null;
  const maximumEnd = Math.min(rawLines.length, startLine + maxBlockLines + 1);
  const semanticParts = ["Waiting for agents", "Finished waiting"];
  let candidateChars = (rawLines[startLine]?.length ?? 0) + (rawLines[finishedLine]?.length ?? 0);
  if (candidateChars > maxBlockChars)
    return null;
  for (let line = finishedLine + 1;line < maximumEnd; line += 1) {
    const raw = rawLines[line] ?? "";
    if (isSealRow(raw)) {
      if (line - startLine > maxBlockLines)
        return null;
      return completedBlock("agent-wait", "completed", startLine, line, line + 1, [range3(startLine, line)], [], "Codex agent wait", semanticParts);
    }
    candidateChars += raw.length;
    if (candidateChars > maxBlockChars)
      return null;
    if (!hasOnlyCompleteTerminalControls(raw) || isProtectedSemanticRow(raw) || !(TREE_DETAIL_RESET_MARKER.test(raw) || DIM_ROW.test(raw)))
      return null;
    semanticParts.push(visible(raw));
  }
  return null;
}
function parseAt(rawLines, startLine, maxBlockLines, maxBlockChars) {
  const raw = rawLines[startLine] ?? "";
  if (raw.length > MAX_ROW_CHARS || raw.length > maxBlockChars || !hasOnlyCompleteTerminalControls(raw))
    return null;
  const group = RUN_GROUP.exec(raw);
  if (group) {
    const count = Number(group[1]);
    const plural = group[2] ?? "";
    if (count === 1 && plural !== "" || count !== 1 && plural !== "s")
      return null;
    const sourceEnd = startLine + 1;
    return completedBlock("run-group", "succeeded", startLine, sourceEnd, sourceEnd, [range3(startLine, sourceEnd)], [], "Codex commands", [`Ran ${count} command${plural}`]);
  }
  const ran = RUN_SUCCESS.exec(raw);
  if (ran) {
    const detail = ranDetailRows(raw, ran[1] ?? "");
    const body = sealedBody(rawLines, startLine, maxBlockLines, maxBlockChars, detail.accepts);
    if (!body || body.bodyLines.length === 0 || !detail.sawDimDetail())
      return null;
    return wholeBlock("run", "succeeded", startLine, body, "Codex command", [ran[1] ?? "", ...body.bodyLines]);
  }
  const waited = WAITED.exec(raw);
  if (waited) {
    const body = sealedBody(rawLines, startLine, maxBlockLines, maxBlockChars, dimDetailRows(raw));
    if (!body)
      return null;
    return wholeBlock("background-wait", "completed", startLine, body, "Codex background wait", [waited[1] ?? "", ...body.bodyLines]);
  }
  const backgroundInteraction = BACKGROUND_INTERACTION.exec(raw);
  if (backgroundInteraction) {
    const body = sealedBody(rawLines, startLine, maxBlockLines, maxBlockChars, dimDetailRows(raw));
    if (!body)
      return null;
    return wholeBlock("background-interaction", "completed", startLine, body, "Codex background interaction", [backgroundInteraction[1] ?? "", ...body.bodyLines]);
  }
  const agentEvent = AGENT_EVENT.exec(raw)?.[1];
  if (agentEvent === "Waiting for agents") {
    return waitingPair(rawLines, startLine, maxBlockLines, maxBlockChars);
  }
  if (agentEvent === "Finished waiting") {
    const body = sealedBody(rawLines, startLine, maxBlockLines, maxBlockChars, (line, offset) => offset === 0 ? TREE_DETAIL_RESET_MARKER.test(line) : DIM_ROW.test(line));
    if (!body)
      return null;
    return wholeBlock("agent-wait", "completed", startLine, body, "Codex agent wait", ["Finished waiting", ...body.bodyLines]);
  }
  if (agentEvent === "Viewed Image") {
    const body = sealedBody(rawLines, startLine, maxBlockLines, maxBlockChars, (line, offset) => offset === 0 ? TREE_DETAIL.test(line) : DIM_ROW.test(line));
    if (!body || body.bodyLines.length === 0)
      return null;
    return wholeBlock("view-image", "completed", startLine, body, "Codex image", body.bodyLines);
  }
  const interacted = AGENT_INTERACTION.exec(raw);
  if (interacted) {
    const body = oneLineSealed(rawLines, startLine);
    if (!body)
      return null;
    return wholeBlock("agent-interaction", "completed", startLine, body, "Codex agent interaction", [interacted[1] ?? ""]);
  }
  const lifecycle = AGENT_LIFECYCLE.exec(raw);
  if (lifecycle) {
    const body = oneLineSealed(rawLines, startLine);
    if (!body)
      return null;
    const event = lifecycle[1] === "Started" ? "agent-start" : "agent-complete";
    return wholeBlock(event, "completed", startLine, body, event === "agent-start" ? "Codex agent started" : "Codex agent completed", [lifecycle[2] ?? ""]);
  }
  const edited = EDITED.exec(raw);
  if (edited) {
    const body = sealedBody(rawLines, startLine, maxBlockLines, maxBlockChars, dimDetailRows(raw));
    if (!body || body.bodyLines.length === 0)
      return null;
    return completedBlock("edit", "completed", startLine, body.sourceEnd, body.proofEnd, [range3(startLine + 1, body.sourceEnd)], [range3(startLine, startLine + 1)], "Codex edit details", [edited[1] ?? "", edited[2] ?? "", edited[3] ?? "", ...body.bodyLines]);
  }
  return null;
}
function detectCodexToolBlocks(rawLines, options = {}) {
  const maxScanLines = boundedInteger2(options.maxScanLines, DEFAULT_MAX_SCAN_LINES3, MAX_LIMIT);
  const maxBlockLines = boundedInteger2(options.maxBlockLines, DEFAULT_MAX_BLOCK_LINES2, MAX_LIMIT);
  const maxBlockChars = boundedInteger2(options.maxBlockChars, DEFAULT_MAX_BLOCK_CHARS, MAX_BLOCK_CHARS);
  const maxBlocks = boundedInteger2(options.maxBlocks, DEFAULT_MAX_BLOCKS2, MAX_LIMIT);
  const identityLineOffset = Number.isSafeInteger(options.identityLineOffset) ? Math.trunc(options.identityLineOffset ?? 0) : 0;
  const scanStart = Math.max(0, rawLines.length - maxScanLines);
  const scanRange = range3(scanStart, rawLines.length);
  if ((options.screenMode ?? "normal") !== "normal") {
    return { provider: "codex", blocks: [], scanRange, enabled: false };
  }
  if (maxScanLines === 0 || maxBlockLines === 0 || maxBlockChars === 0 || maxBlocks === 0) {
    return { provider: "codex", blocks: [], scanRange, enabled: true };
  }
  const blocks = [];
  for (let line = scanStart;line < rawLines.length; line += 1) {
    if (!leadingBoundaryIsKnown(rawLines, line, scanStart, options.leadingEdgeSealed === true))
      continue;
    const block = parseAt(rawLines, line, maxBlockLines, maxBlockChars);
    if (!block)
      continue;
    const absoluteStart = identityLineOffset + block.sourceRange.startLine;
    if (!Number.isSafeInteger(absoluteStart))
      continue;
    blocks.push(Object.freeze({
      ...block,
      id: `${block.fingerprint}:row-${absoluteStart}`
    }));
    line = Math.max(line, block.sourceRange.endLine - 1);
  }
  return {
    provider: "codex",
    blocks: blocks.slice(-maxBlocks),
    scanRange,
    enabled: true
  };
}
// src/surface.ts
var DEFAULT_BASE_SURFACE = {
  agent: "#7dffa0",
  tbg: "#101014",
  tstage: "#0a0a0d",
  tfg: "#e6e6e6",
  hud: "rgba(16,16,20,.95)",
  hudFg: "#e6e6e6",
  hudLine: "#34343a",
  badge: "#1a1a1a",
  badgeFg: "#e6e6e6",
  xterm: {}
};
var ANSI_NORMAL = {
  red: "#cd3131",
  green: "#0dbc79",
  yellow: "#e5e510",
  blue: "#2472c8",
  magenta: "#bc3fbc",
  cyan: "#11a8cd"
};
var ANSI_BRIGHT = {
  red: "#f14c4c",
  green: "#23d18b",
  yellow: "#f5f543",
  blue: "#3b8eea",
  magenta: "#d670d6",
  cyan: "#29b8db"
};
var DEFAULT_ANSI_BASE = [
  "#101014",
  ANSI_NORMAL.red,
  ANSI_NORMAL.green,
  ANSI_NORMAL.yellow,
  ANSI_NORMAL.blue,
  ANSI_NORMAL.magenta,
  ANSI_NORMAL.cyan,
  "#e5e5e5",
  "#666666",
  ANSI_BRIGHT.red,
  ANSI_BRIGHT.green,
  ANSI_BRIGHT.yellow,
  ANSI_BRIGHT.blue,
  ANSI_BRIGHT.magenta,
  ANSI_BRIGHT.cyan,
  "#ffffff"
];
var DEFAULT_ANSI_COLORS = Object.freeze([...DEFAULT_ANSI_BASE]);
var ANSI_COLOR_NAMES = ["red", "green", "yellow", "blue", "magenta", "cyan"];
var MIN_TEXT_CONTRAST = 4.5;
var MIN_ACCENT_CONTRAST = 3;
function normalizeHexColor(raw) {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(raw.trim());
  if (!m || !m[1])
    return null;
  if (m[1].length === 3) {
    return `#${m[1].split("").map((d) => `${d}${d}`).join("")}`.toLowerCase();
  }
  return `#${m[1].toLowerCase()}`;
}
function hexToRgb(hex) {
  const normalized = normalizeHexColor(hex);
  if (!normalized)
    return null;
  const n = parseInt(normalized.slice(1), 16);
  return [n >> 16 & 255, n >> 8 & 255, n & 255];
}
function rgbToHex(r, g, b) {
  const c = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`;
}
function mix(hexA, hexB, ratioB) {
  const a = hexToRgb(hexA);
  const b = hexToRgb(hexB);
  if (!a || !b)
    return hexA;
  return rgbToHex(a[0] + (b[0] - a[0]) * ratioB, a[1] + (b[1] - a[1]) * ratioB, a[2] + (b[2] - a[2]) * ratioB);
}
function luminance(hex) {
  const rgb = hexToRgb(hex);
  if (!rgb)
    return 0;
  const linearize = (channel) => {
    const c = channel / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  const [r, g, b] = rgb.map(linearize);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrastRatio(hexA, hexB) {
  const l1 = luminance(hexA);
  const l2 = luminance(hexB);
  const high = Math.max(l1, l2);
  const low = Math.min(l1, l2);
  return (high + 0.05) / (low + 0.05);
}
function readableFallback(hexBg) {
  return contrastRatio("#ffffff", hexBg) >= contrastRatio("#000000", hexBg) ? "#ffffff" : "#000000";
}
function enforceContrast(hex, bg, minContrast) {
  const normalized = normalizeHexColor(hex);
  if (!normalized)
    return readableFallback(bg);
  if (contrastRatio(normalized, bg) >= minContrast)
    return normalized;
  return readableFallback(bg);
}
var DERIVED_DARK_ANSI = {
  ...ANSI_NORMAL,
  brightRed: ANSI_BRIGHT.red,
  brightGreen: ANSI_BRIGHT.green,
  brightYellow: ANSI_BRIGHT.yellow,
  brightBlue: ANSI_BRIGHT.blue,
  brightMagenta: ANSI_BRIGHT.magenta,
  brightCyan: ANSI_BRIGHT.cyan,
  brightBlack: "#8a8a92"
};
var DERIVED_LIGHT_ANSI = {
  red: "#b3261e",
  green: "#1d7a3e",
  yellow: "#8a6d00",
  blue: "#4a35b8",
  magenta: "#a81560",
  cyan: "#0c6580",
  brightBlack: "#6e675f",
  brightRed: "#b3261e",
  brightGreen: "#1d7a3e",
  brightYellow: "#8a6d00",
  brightBlue: "#4a35b8",
  brightMagenta: "#a81560",
  brightCyan: "#0c6580"
};
function deriveSurface(bg, base) {
  const normalizedBg = normalizeHexColor(bg) ?? DEFAULT_BASE_SURFACE.tbg;
  const isLightBg = luminance(normalizedBg) > 0.55;
  const candidateFg = isLightBg ? "#1f1812" : mix("#ffffff", normalizedBg, 0.08);
  const fg = enforceContrast(candidateFg, normalizedBg, MIN_TEXT_CONTRAST);
  const stage = mix(normalizedBg, "#000000", isLightBg ? 0.12 : 0.4);
  const hudSolid = isLightBg ? mix(normalizedBg, "#ffffff", 0.25) : mix(normalizedBg, "#000000", 0.55);
  const agentCandidate = normalizeHexColor(base.agent) ?? DEFAULT_BASE_SURFACE.agent;
  const accent = enforceContrast(agentCandidate, normalizedBg, MIN_ACCENT_CONTRAST);
  const rgb = hexToRgb(hudSolid) ?? [20, 20, 20];
  return {
    ...base,
    agent: accent,
    tbg: normalizedBg,
    tstage: stage,
    tfg: fg,
    hud: `rgba(${rgb[0]},${rgb[1]},${rgb[2]},.94)`,
    hudFg: fg,
    hudLine: mix(normalizedBg, fg, 0.4),
    xterm: {
      background: normalizedBg,
      foreground: fg,
      cursor: fg,
      cursorAccent: normalizedBg,
      selectionBackground: stage,
      black: normalizedBg,
      white: fg,
      brightWhite: fg,
      ...isLightBg ? DERIVED_LIGHT_ANSI : DERIVED_DARK_ANSI
    }
  };
}
function paletteForSurface(surface) {
  const colors = [...DEFAULT_ANSI_BASE];
  const theme = surface.xterm;
  colors[0] = theme.black ?? surface.tbg;
  colors[7] = theme.white ?? surface.tfg;
  colors[8] = theme.brightBlack ?? colors[8];
  colors[15] = theme.brightWhite ?? surface.tfg;
  for (let index = 0;index < ANSI_COLOR_NAMES.length; index++) {
    const name = ANSI_COLOR_NAMES[index];
    const normal = theme[name] ?? colors[index + 1];
    const brightName = `bright${name[0].toUpperCase()}${name.slice(1)}`;
    colors[index + 1] = normal;
    colors[index + 9] = theme[brightName] ?? normal;
  }
  return {
    base: colors,
    defaultFg: surface.tfg,
    defaultBg: surface.tbg
  };
}
function defaultSurface(bg) {
  const surface = deriveSurface(bg, DEFAULT_BASE_SURFACE);
  return { ...surface, palette: paletteForSurface(surface) };
}
// src/launch.ts
function buildLaunchCommand(preset, permission, model) {
  if (!preset.baseCommand)
    return "";
  const perm = preset.permissionOptions.find((o) => o.value === permission) ?? preset.permissionOptions[0];
  const mod = preset.modelOptions.find((o) => o.value === model) ?? preset.modelOptions[0];
  return [preset.baseCommand, perm?.flag, mod?.flag].filter(Boolean).join(" ");
}
function buildLaunchSpec(preset, permission, model) {
  const perm = preset.permissionOptions.find((o) => o.value === permission) ?? preset.permissionOptions[0];
  const mod = preset.modelOptions.find((o) => o.value === model) ?? preset.modelOptions[0];
  return {
    presetId: preset.id,
    agent: preset.agent,
    worktree: !!preset.worktree,
    permission: perm?.value ?? "",
    model: mod?.value ?? "",
    command: buildLaunchCommand(preset, permission, model)
  };
}
var CLAUDE_PERMISSIONS = [
  { value: "bypass", label: "Bypass permissions", flag: "--dangerously-skip-permissions" },
  { value: "accept-edits", label: "Auto-accept edits", flag: "--permission-mode acceptEdits" },
  { value: "plan", label: "Plan mode", flag: "--permission-mode plan" },
  { value: "ask", label: "Ask every time", flag: "" }
];
var CLAUDE_MODELS = [
  { value: "default", label: "Default model", flag: "" },
  { value: "opus", label: "Opus", flag: "--model opus" },
  { value: "sonnet", label: "Sonnet", flag: "--model sonnet" },
  { value: "haiku", label: "Haiku", flag: "--model haiku" }
];
var CODEX_PERMISSIONS = [
  { value: "bypass", label: "Bypass approvals", flag: "--dangerously-bypass-approvals-and-sandbox" },
  { value: "auto", label: "Workspace sandbox", flag: "--full-auto" },
  { value: "ask", label: "Ask every time", flag: "" }
];
var CODEX_MODELS = [
  { value: "default", label: "Default model", flag: "" },
  { value: "gpt-5.5", label: "GPT-5.5", flag: "-m gpt-5.5" },
  { value: "gpt-5.4", label: "GPT-5.4", flag: "-m gpt-5.4" },
  { value: "gpt-5.4-mini", label: "GPT-5.4 mini", flag: "-m gpt-5.4-mini" }
];
var GROK_PERMISSIONS = [
  { value: "bypass", label: "Bypass permissions", flag: "--permission-mode bypassPermissions" },
  { value: "ask", label: "Ask every time", flag: "" }
];
var GROK_MODELS = [
  { value: "default", label: "Default model", flag: "" },
  { value: "grok-4.5", label: "Grok 4.5", flag: "--model grok-4.5" }
];
var DEFAULT_LAUNCH_PRESETS = [
  {
    id: "claude",
    label: "Claude Code",
    color: "#B05606",
    agent: "cc",
    baseCommand: "claude",
    permissionOptions: CLAUDE_PERMISSIONS,
    modelOptions: CLAUDE_MODELS
  },
  {
    id: "claude-worktree",
    label: "Claude Code · worktree",
    color: "#B05606",
    agent: "cc",
    worktree: true,
    baseCommand: "claude",
    permissionOptions: CLAUDE_PERMISSIONS,
    modelOptions: CLAUDE_MODELS
  },
  {
    id: "codex",
    label: "Codex",
    color: "#0709BD",
    agent: "codex",
    baseCommand: "codex",
    permissionOptions: CODEX_PERMISSIONS,
    modelOptions: CODEX_MODELS
  },
  {
    id: "codex-worktree",
    label: "Codex · worktree",
    color: "#0709BD",
    agent: "codex",
    worktree: true,
    baseCommand: "codex",
    permissionOptions: CODEX_PERMISSIONS,
    modelOptions: CODEX_MODELS
  },
  {
    id: "grok",
    label: "Grok",
    color: "#1A1A1A",
    agent: "grok",
    baseCommand: "grok",
    permissionOptions: GROK_PERMISSIONS,
    modelOptions: GROK_MODELS
  },
  {
    id: "grok-worktree",
    label: "Grok · worktree",
    color: "#1A1A1A",
    agent: "grok",
    worktree: true,
    baseCommand: "grok",
    permissionOptions: GROK_PERMISSIONS,
    modelOptions: GROK_MODELS
  },
  {
    id: "blank",
    label: "Blank terminal",
    color: "#6A645C",
    agent: "",
    baseCommand: "",
    permissionOptions: [{ value: "none", label: "—", flag: "" }],
    modelOptions: [{ value: "none", label: "—", flag: "" }]
  }
];
// src/upload.ts
function makeStoredName(original, now, entropy) {
  const base = original.split(/[/\\]/).pop() ?? "file";
  const cleaned = base.replace(/[^\w.\-]+/g, "_").replace(/^[._]+/, "").slice(0, 80) || "file";
  return `${now}_${entropy}_${cleaned}`;
}
function formatUploadMessage(files, dir = "uploads") {
  return files.map((f) => `Uploaded "${f.original}" → ${dir}/${f.stored}`).join(`
`);
}
// src/copy.ts
function paneTextForCopy(lines) {
  const out = lines.map((l) => stripAnsi2(l ?? "").replace(/\s+$/, ""));
  let end = out.length;
  while (end > 0 && out[end - 1] === "")
    end--;
  return out.slice(0, end).join(`
`);
}
// src/prefs.ts
function mergePrefs(base, patch) {
  const next = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (k === "__proto__")
      continue;
    if (v === undefined || v === null)
      delete next[k];
    else
      next[k] = v;
  }
  return next;
}
var DEFAULT_SHORTCUTS = [
  { id: "continue", label: "continue", send: "continue" },
  { id: "run-it", label: "run it", send: "go ahead, run it" },
  { id: "explain", label: "explain", send: "explain what you just did" }
];
// src/keys.ts
var ESC3 = "\x1B";
var arrowFinals = {
  ArrowUp: "A",
  ArrowDown: "B",
  ArrowRight: "C",
  ArrowLeft: "D"
};
var homeEndFinals = {
  Home: "H",
  End: "F"
};
var tildeNamedKeys = {
  Delete: 3,
  PageUp: 5,
  PageDown: 6
};
var ss3FunctionKeys = {
  F1: "P",
  F2: "Q",
  F3: "R",
  F4: "S"
};
var tildeFunctionKeys = {
  F5: 15,
  F6: 17,
  F7: 18,
  F8: 19,
  F9: 20,
  F10: 21,
  F11: 23,
  F12: 24
};
function keyboardEventToSequence(e, opts = {}) {
  if (e.isComposing || e.metaKey)
    return null;
  const altIsMeta = opts.altIsMeta ?? true;
  const applicationCursorKeys = !!opts.applicationCursorKeys;
  const key = e.key;
  const shifted = !!e.shiftKey;
  const alt = !!e.altKey;
  const ctrl = !!e.ctrlKey;
  const arrowFinal = arrowFinals[key];
  if (arrowFinal) {
    return shifted || alt || ctrl ? modifiedCsi(arrowFinal, shifted, alt, ctrl) : applicationCursorKeys ? `${ESC3}O${arrowFinal}` : `${ESC3}[${arrowFinal}`;
  }
  const homeEndFinal = homeEndFinals[key];
  if (homeEndFinal) {
    return shifted || alt || ctrl ? modifiedCsi(homeEndFinal, shifted, alt, ctrl) : applicationCursorKeys ? `${ESC3}O${homeEndFinal}` : `${ESC3}[${homeEndFinal}`;
  }
  if (key === "Enter")
    return alt ? `${ESC3}\r` : "\r";
  if (key === "Tab") {
    if (alt || ctrl)
      return null;
    return shifted ? `${ESC3}[Z` : "\t";
  }
  const namedKey = namedKeySequence(key, shifted, alt, ctrl);
  if (namedKey !== undefined)
    return namedKey;
  const functionKey = functionKeySequence(key, shifted, alt, ctrl);
  if (functionKey)
    return functionKey;
  if (ctrl && alt && key.length === 1)
    return key;
  if (ctrl)
    return ctrlSequence(e);
  if (key.length === 1)
    return alt && altIsMeta ? `${ESC3}${key}` : key;
  return null;
}
function bracketedPaste(text) {
  const body = text.replace(/\r\n|\n/g, "\r").replace(/\x1b/g, "");
  return `${ESC3}[200~${body}${ESC3}[201~`;
}
function modifiedCsi(final, shift, alt, ctrl) {
  const modifier = modifierValue(shift, alt, ctrl);
  return `${ESC3}[1;${modifier}${final}`;
}
function modifierValue(shift, alt, ctrl) {
  return 1 + (shift ? 1 : 0) + (alt ? 2 : 0) + (ctrl ? 4 : 0);
}
function namedKeySequence(key, shift, alt, ctrl) {
  if (key === "Backspace") {
    const base = ctrl ? "\b" : "";
    return alt ? `${ESC3}${base}` : base;
  }
  if (key === "Escape")
    return alt ? `${ESC3}${ESC3}` : ESC3;
  if (key === "Insert") {
    if (shift || ctrl)
      return null;
    return alt ? `${ESC3}[2;3~` : `${ESC3}[2~`;
  }
  const tildeCode = tildeNamedKeys[key];
  if (tildeCode) {
    if (shift && !alt && !ctrl && (key === "PageUp" || key === "PageDown")) {
      return null;
    }
    const modifier = modifierValue(shift, alt, ctrl);
    return modifier > 1 ? `${ESC3}[${tildeCode};${modifier}~` : `${ESC3}[${tildeCode}~`;
  }
  return;
}
function functionKeySequence(key, shift, alt, ctrl) {
  const ss3Final = ss3FunctionKeys[key];
  if (ss3Final) {
    const modifier = modifierValue(shift, alt, ctrl);
    return modifier > 1 ? `${ESC3}[1;${modifier}${ss3Final}` : `${ESC3}O${ss3Final}`;
  }
  const tildeCode = tildeFunctionKeys[key];
  if (tildeCode) {
    const modifier = modifierValue(shift, alt, ctrl);
    return modifier > 1 ? `${ESC3}[${tildeCode};${modifier}~` : `${ESC3}[${tildeCode}~`;
  }
  return null;
}
function ctrlSequence(e) {
  if (e.key === " " || e.code === "Space")
    return "\x00";
  if (e.key.length === 1 && e.key >= "0" && e.key <= "9") {
    return ctrlDigitSequences[e.key] ?? null;
  }
  if (e.key === "[")
    return ESC3;
  if (e.key === "\\")
    return "\x1C";
  if (e.key === "]")
    return "\x1D";
  const fromCode = ctrlLetterFromCode(e.code);
  if (fromCode !== null)
    return fromCode;
  const lower = e.key.toLowerCase();
  if (lower.length === 1 && lower >= "a" && lower <= "z") {
    return String.fromCharCode(lower.charCodeAt(0) - 96);
  }
  return null;
}
function ctrlLetterFromCode(code) {
  if (!code || code.length !== 4 || !code.startsWith("Key"))
    return null;
  const letter = code.charAt(3);
  if (letter < "A" || letter > "Z")
    return null;
  return String.fromCharCode(letter.charCodeAt(0) - 64);
}
var ctrlDigitSequences = {
  "0": null,
  "1": null,
  "2": "\x00",
  "3": ESC3,
  "4": "\x1C",
  "5": "\x1D",
  "6": "\x1E",
  "7": "\x1F",
  "8": "",
  "9": null
};
// src/sgr-mouse.ts
var SNAP_BOTTOM_EVENTS = 24;
var DEFAULT_WHEEL_MAX_PER_CALL = 6;
var WHEEL_UP_CODE = 64;
var WHEEL_DOWN_CODE = 65;
var DEFAULT_COMPOSER_ROWS = 8;
var DEFAULT_PAGE_LINES = 50;
function positiveCell(value) {
  if (!Number.isFinite(value))
    return 1;
  return Math.max(1, Math.floor(value));
}
function eventCount(count = 1) {
  if (!Number.isFinite(count))
    return 1;
  return Math.max(1, Math.floor(count));
}
function positiveFinite(value, fallback) {
  if (!Number.isFinite(value))
    return fallback;
  return Math.max(1, value);
}
function positiveInteger(value) {
  if (!Number.isFinite(value))
    return null;
  const integer = Math.floor(value);
  return integer > 0 ? integer : null;
}
function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
function sgrWheel(dir, cx, cy, count) {
  const code = dir === "up" ? WHEEL_UP_CODE : WHEEL_DOWN_CODE;
  const x = positiveCell(cx);
  const y = positiveCell(cy);
  return `\x1B[<${code};${x};${y}M`.repeat(eventCount(count));
}
function sgrClick(cx, cy) {
  const x = positiveCell(cx);
  const y = positiveCell(cy);
  return `\x1B[<0;${x};${y}M\x1B[<0;${x};${y}m`;
}
function sgrSnapToBottom(cx, cy) {
  return sgrWheel("down", cx, cy, SNAP_BOTTOM_EVENTS);
}
function wheelEventToLines(deltaY, deltaMode, lineHeightPx, pageLines = DEFAULT_PAGE_LINES) {
  if (!Number.isFinite(deltaY) || deltaY === 0)
    return 0;
  let browserLines;
  if (deltaMode === 1) {
    browserLines = deltaY;
  } else if (deltaMode === 2) {
    browserLines = deltaY * positiveFinite(pageLines, DEFAULT_PAGE_LINES);
  } else {
    browserLines = deltaY / positiveFinite(lineHeightPx, 1);
  }
  return -browserLines;
}
function centerContentCell(geom, opts = {}) {
  const cols = Number.isFinite(geom.cols) ? Math.floor(geom.cols) : 0;
  const rows = Number.isFinite(geom.rows) ? Math.floor(geom.rows) : 0;
  const composerRows = typeof opts.composerRows === "number" && Number.isFinite(opts.composerRows) ? Math.floor(opts.composerRows) : DEFAULT_COMPOSER_ROWS;
  const cx = Math.max(1, Math.floor(cols / 2));
  const cy = Math.max(1, Math.min(rows - composerRows, Math.floor(rows / 2)));
  return { cx, cy };
}
function contentCellFromPoint(clientX, clientY, rect, geom) {
  if (!Number.isFinite(clientX) || !Number.isFinite(clientY) || !Number.isFinite(rect.left) || !Number.isFinite(rect.top) || !Number.isFinite(rect.width) || !Number.isFinite(rect.height) || rect.width <= 0 || rect.height <= 0) {
    return null;
  }
  const cols = positiveInteger(geom.cols);
  const rows = positiveInteger(geom.rows);
  if (cols === null || rows === null)
    return null;
  const right = rect.left + rect.width;
  const bottom = rect.top + rect.height;
  if (!Number.isFinite(right) || !Number.isFinite(bottom) || clientX < rect.left || clientX > right || clientY < rect.top || clientY > bottom) {
    return null;
  }
  const col0 = clamp(Math.floor((clientX - rect.left) / rect.width * cols), 0, cols - 1);
  const row0 = clamp(Math.floor((clientY - rect.top) / rect.height * rows), 0, rows - 1);
  return {
    cx: col0 + 1,
    cy: row0 + 1,
    col0,
    row0
  };
}
// src/paste.ts
var DEFAULT_WARN_LINES = 6;
var DEFAULT_WARN_BYTES = 4096;
function utf8ByteLength(text) {
  if (typeof TextEncoder !== "undefined")
    return new TextEncoder().encode(text).length;
  let bytes = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp <= 127)
      bytes += 1;
    else if (cp <= 2047)
      bytes += 2;
    else if (cp <= 65535)
      bytes += 3;
    else
      bytes += 4;
  }
  return bytes;
}
function pasteInfo(text, opts = {}) {
  const warnLines = opts.warnLines ?? DEFAULT_WARN_LINES;
  const warnBytes = opts.warnBytes ?? DEFAULT_WARN_BYTES;
  const lineCount = text.split(/\r\n|\r|\n/).length;
  const byteLength = utf8ByteLength(text);
  const multiline = warnLines > 0 && lineCount >= warnLines;
  const large = warnBytes > 0 && byteLength >= warnBytes;
  if (!multiline && !large)
    return null;
  return {
    text,
    lineCount,
    byteLength,
    reason: multiline && large ? "multiline-large" : multiline ? "multiline" : "large"
  };
}
// src/submit.ts
var DEFAULT_ENTER_DELAY_MS = 150;
var EXTRA_ENTER_DELAY_MS = 1000;
var EXTRA_ENTER_AGENT = `${"co"}${"dex"}`;
function submitPlan(text, opts = {}) {
  const enterDelayMs = opts.enterDelayMs ?? DEFAULT_ENTER_DELAY_MS;
  const steps = [];
  if (text) {
    const keys = /[\r\n]/.test(text) ? bracketedPaste(text) : text;
    steps.push({ keys, delayBeforeMs: 0 });
  }
  steps.push({ keys: "\r", delayBeforeMs: enterDelayMs });
  if (opts.agent === EXTRA_ENTER_AGENT) {
    steps.push({ keys: "\r", delayBeforeMs: EXTRA_ENTER_DELAY_MS });
  }
  return steps;
}
// src/prepend.ts
var STATE_ONLY_PALETTE = {
  base: [
    "#000000",
    "#800000",
    "#008000",
    "#808000",
    "#000080",
    "#800080",
    "#008080",
    "#c0c0c0",
    "#808080",
    "#ff0000",
    "#00ff00",
    "#ffff00",
    "#0000ff",
    "#ff00ff",
    "#00ffff",
    "#ffffff"
  ],
  defaultFg: "#ffffff",
  defaultBg: "#000000"
};
function planPrepend(batch, firstExistingLineRaw, existingFirstState) {
  const st = createSgrState();
  const batchStates = [];
  for (const line of batch) {
    lineToHtml(line, st, STATE_ONLY_PALETTE);
    batchStates.push(cloneSgrState(st));
  }
  const endState = cloneSgrState(st);
  return {
    batchStates,
    endState,
    existingCacheValid: sgrStateKey(endState) === sgrStateKey(existingFirstState)
  };
}
// src/deprecate.ts
var warnedDeprecations = new Map;
var VERSION_FORMAT = /^\d+\.\d+\.\d+$/;
var SINGLE_LINE_FORMAT = /^[^\r\n]+$/;
function assertVersion(value, field) {
  if (typeof value !== "string" || !VERSION_FORMAT.test(value)) {
    throw new TypeError(`warnDeprecated details.${field} must be an X.Y.Z version`);
  }
}
function assertDeprecationDetails(details) {
  if (typeof details !== "object" || details === null || Array.isArray(details)) {
    throw new TypeError("warnDeprecated details must be an object");
  }
  const candidate = details;
  assertVersion(candidate.since, "since");
  if (typeof candidate.replacement !== "string" || !SINGLE_LINE_FORMAT.test(candidate.replacement)) {
    throw new TypeError("warnDeprecated details.replacement must be a non-empty single-line string");
  }
  assertVersion(candidate.removeNoEarlierThan, "removeNoEarlierThan");
}
function warnDeprecated(key, details, log = (warning) => console.warn(warning)) {
  if (typeof key !== "string" || !SINGLE_LINE_FORMAT.test(key)) {
    throw new TypeError("warnDeprecated key must be a non-empty single-line string");
  }
  assertDeprecationDetails(details);
  if (warnedDeprecations.has(key))
    return;
  log(`[thumbmux] ${key} is deprecated since v${details.since} — use ${details.replacement}; removal no earlier than v${details.removeNoEarlierThan}`);
  warnedDeprecations.set(key, true);
}
function resetDeprecationWarnings() {
  warnedDeprecations.clear();
}

// src/index.ts
function isClaudeActivityStatusLine2(line) {
  return isClaudeActivityStatusLine(line);
}
export {
  wheelEventToLines,
  wheelDeltaToLines,
  warnDeprecated,
  validateToolCollapseBlocks,
  validateMuxHistoryBoundary,
  validateMuxDeltaFrame,
  validateAgentNotificationEvent,
  utf8ByteLength,
  submitPlan,
  stripAnsi2 as stripAnsi,
  stringCells,
  stableToolFingerprint,
  splitMuxOutputData,
  shouldUseMuxDelta,
  sgrWheel,
  sgrStateKey,
  sgrSnapToBottom,
  sgrClick,
  serializedMuxFrameSize,
  searchLines,
  sameOriginNotificationUrl,
  rgbToHex,
  resetDeprecationWarnings,
  reconcileToolBlockIds,
  readerAnchorLineDelta,
  projectToolLines,
  projectClaudeBashLines,
  projectClaudeBashGroupedLines,
  prefixForCells,
  planPrepend,
  pasteInfo,
  parseReplayJournal,
  paneTextForCopy,
  normalizeHexColor,
  normalizeAgentNotificationEvent,
  muxPrefixHash,
  muxHistoryBoundaryTransition,
  muxCommonPrefixLength,
  mix,
  mergePrefs,
  mergeCapturedLinesForStableScroll,
  makeStoredName,
  luminance,
  lineToHtml,
  keyboardEventToSequence,
  isGrokStatusLine,
  isFaintPayload,
  isCodexStatusLine,
  isClaudeStatusLine,
  isClaudeActivityStatusLine2 as isClaudeActivityStatusLine,
  hexToRgb,
  groupClaudeBashBlocks,
  formatUploadMessage,
  fnv1a32,
  findTerminalUrlAtCell,
  findLineOverlap,
  extractRecentPromptsFromPane,
  extractRecentPrompts,
  detectCodexToolBlocks,
  detectClaudeBashBlocksWithActivityEvidence,
  detectClaudeBashBlocks,
  deriveSurface,
  defaultSurface,
  createSgrState,
  createMuxDeltaFrame,
  contrastRatio,
  contentCellFromPoint,
  consumeWholeWheelLines,
  collectTerminalUrlSegments,
  cloneSgrState,
  chooseMuxOutputFrame,
  charCellWidth,
  centerContentCell,
  buildLaunchSpec,
  buildLaunchCommand,
  bracketedPaste,
  applyMuxDelta,
  SNAP_BOTTOM_EVENTS,
  ReplayJournal,
  MAX_WHEEL_LINES_PER_FRAME,
  GROK_MODELS,
  DEFAULT_WHEEL_PIXEL_SCALE,
  DEFAULT_WHEEL_MAX_PER_CALL,
  DEFAULT_SHORTCUTS,
  DEFAULT_PROMPT_MATCHERS,
  DEFAULT_LAUNCH_PRESETS,
  DEFAULT_ANSI_COLORS,
  AgentNotificationValidationError,
  AGENT_NOTIFICATION_LIMITS
};
