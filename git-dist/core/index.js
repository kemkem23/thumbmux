// src/ansi-html.ts
var BEL = "\x07";
var ESC = "\x1B";
var ST = "\\";
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
function isSurrogatePairAt(text, index) {
  if (index < 0 || index + 1 >= text.length)
    return false;
  const hi = text.charCodeAt(index);
  const lo = text.charCodeAt(index + 1);
  return hi >= 55296 && hi <= 56319 && lo >= 56320 && lo <= 57343;
}
function withOverlay(text, kind) {
  const escaped = escapeHtml(text);
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
      out += isDefaultSgrState(st) ? escapeHtml(rawText) : `${spanOpen(st, palette)}${escapeHtml(rawText)}</span>`;
      col += rawText.length;
      return;
    }
    let offset = 0;
    while (offset < rawText.length) {
      const absolute = col + offset;
      const boundary = rangeWalker ? rangeWalker.nextBoundary(absolute) : Infinity;
      const take = boundary === Infinity ? rawText.length - offset : Math.min(rawText.length - offset, boundary - absolute);
      let count = take > 0 ? take : 1;
      if (offset + count < rawText.length && isSurrogatePairAt(rawText, offset + count - 1)) {
        if (count > 1)
          count -= 1;
        else
          count += 1;
      }
      let href = explicitHref ?? (rangeWalker ? rangeWalker.hrefAt(absolute) : null);
      let overlayKind = rangeWalker ? rangeWalker.overlayAt(absolute) : null;
      if (!explicitHref && count >= 2 && isSurrogatePairAt(rawText, offset)) {
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
    if (line[cursor] !== ESC) {
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
        if (line[end] === BEL) {
          applyOscPayload(line.slice(cursor + 2, end), st);
          after = end + 1;
          terminated = true;
          break;
        }
        if (line[end] === ESC && line[end + 1] === ST) {
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
      if (third >= line.length || line.charCodeAt(third) === 27 || isSurrogatePairAt(line, third)) {
        cursor = Math.min(line.length, third);
      } else {
        cursor = Math.min(line.length, cursor + 3);
      }
    } else if (line.charCodeAt(cursor + 1) === 27 || isSurrogatePairAt(line, cursor + 1)) {
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
var ESC2 = "\x1B";
var BEL2 = "\x07";
var ST2 = "\\";
function createError(code, message) {
  return { code, message };
}
function isSurrogatePairAt2(text, index) {
  if (index < 0 || index + 1 >= text.length)
    return false;
  const hi = text.charCodeAt(index);
  const lo = text.charCodeAt(index + 1);
  return hi >= 55296 && hi <= 56319 && lo >= 56320 && lo <= 57343;
}
function stripTerminalControls(raw) {
  if (raw.indexOf(ESC2) < 0)
    return raw;
  let out = "";
  let i = 0;
  while (i < raw.length) {
    if (raw[i] !== ESC2) {
      out += raw[i];
      i += 1;
      continue;
    }
    if (i + 1 >= raw.length) {
      break;
    }
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
      if (end >= raw.length) {
        break;
      }
      i = end + 1;
      continue;
    }
    if (next === "]") {
      let end = i + 2;
      let after = raw.length;
      let terminated = false;
      while (end < raw.length) {
        if (raw[end] === BEL2) {
          after = end + 1;
          terminated = true;
          break;
        }
        if (raw[end] === ESC2 && end + 1 < raw.length && raw[end + 1] === ST2) {
          after = end + 2;
          terminated = true;
          break;
        }
        end += 1;
      }
      if (!terminated) {
        break;
      }
      i = after;
      continue;
    }
    if (next === "(" || next === ")" || next === "*" || next === "+" || next === "-" || next === "." || next === "/" || next === "#" || next === "%") {
      const third = i + 2;
      if (third >= raw.length || raw.charCodeAt(third) === 27 || isSurrogatePairAt2(raw, third)) {
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
// src/cells.ts
var ZERO_WIDTH = /^[​-‍︀-️]$/;
var COMBINING = /\p{M}/u;
var WIDE_RANGES = [
  [4352, 4447],
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
  if (ZERO_WIDTH.test(ch) || COMBINING.test(ch))
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
  for (const ch of text)
    cells += charCellWidth(ch.codePointAt(0));
  return cells;
}
function prefixForCells(text, cells) {
  if (cells <= 0)
    return { prefix: "", cells: 0 };
  let consumed = 0;
  let end = 0;
  for (const ch of text) {
    const w = charCellWidth(ch.codePointAt(0));
    if (w > 0 && consumed + w > cells)
      break;
    consumed += w;
    end += ch.length;
    if (consumed === cells) {
      for (const next of text.slice(end)) {
        if (charCellWidth(next.codePointAt(0)) !== 0)
          break;
        end += next.length;
      }
      break;
    }
  }
  return { prefix: text.slice(0, end), cells: consumed };
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
function stripAnsi(text) {
  if (text.indexOf("\x1B") < 0)
    return text;
  return text.replace(/\x1b\[[0-9:;]*[a-zA-Z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "").replace(/\x1b\][^\x1b]*\x1b\\/g, "");
}
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
var MAX_PROMPT_DISPLAY_CHARS = 500;
var PROMPT_MARKERS = new Set(["❯", "›"]);
function stripAnsi2(text) {
  return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "").replace(/\x1b\][^\x1b]*\x1b\\/g, "").replace(/\x1b\[[0-9;:?<=>\-]*[@-~]?|\x1b/g, "");
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
var DEFAULT_PROMPT_MATCHERS = Object.freeze({
  promptPayload(line) {
    const normalized = line.replace(/\u00a0/g, " ").trimStart();
    const marker = normalized[0];
    if (!marker || !PROMPT_MARKERS.has(marker))
      return null;
    const leading = line.length - line.trimStart().length;
    if (leading > 6)
      return null;
    return stripTrailingClock(normalized.slice(1).trim());
  },
  isFaintPayload,
  isStatusLine(trimmedLine) {
    return isCodexStatusLine(trimmedLine) || isClaudeStatusLine(trimmedLine);
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
function truncatePrompt(text) {
  if (text.length <= MAX_PROMPT_DISPLAY_CHARS)
    return text;
  let end = MAX_PROMPT_DISPLAY_CHARS - 3;
  if (end > 0 && end <= text.length) {
    const last = text.charCodeAt(end - 1);
    if (last >= 55296 && last <= 56319)
      end -= 1;
  }
  return `${text.slice(0, end).trimEnd()}...`;
}
function normalizePromptBlock(lines) {
  const cleanLines = lines.map(cleanPromptLine).filter((line, index, all) => line.trim() || index > 0 && index < all.length - 1);
  const userReport = extractMarkdownSection(cleanLines, "User report");
  const source = userReport ?? cleanLines.join(" ");
  return truncatePrompt(source.replace(/\s+/g, " ").trim());
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
export {
  wheelEventToLines,
  wheelDeltaToLines,
  warnDeprecated,
  validateMuxDeltaFrame,
  validateAgentNotificationEvent,
  utf8ByteLength,
  submitPlan,
  stripAnsi2 as stripAnsi,
  stringCells,
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
  readerAnchorLineDelta,
  prefixForCells,
  planPrepend,
  pasteInfo,
  parseReplayJournal,
  paneTextForCopy,
  normalizeHexColor,
  normalizeAgentNotificationEvent,
  muxPrefixHash,
  muxCommonPrefixLength,
  mix,
  mergePrefs,
  mergeCapturedLinesForStableScroll,
  makeStoredName,
  luminance,
  lineToHtml,
  keyboardEventToSequence,
  isFaintPayload,
  isCodexStatusLine,
  isClaudeStatusLine,
  hexToRgb,
  formatUploadMessage,
  fnv1a32,
  findTerminalUrlAtCell,
  findLineOverlap,
  extractRecentPromptsFromPane,
  extractRecentPrompts,
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
