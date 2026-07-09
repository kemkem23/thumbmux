// src/ansi-html.ts
function createSgrState() {
  return { fg: null, bg: null, bold: false, dim: false, italic: false, underline: false, inverse: false, strike: false };
}
function cloneSgrState(s) {
  return { ...s };
}
function sgrStateKey(s) {
  return `${s.fg ?? ""}|${s.bg ?? ""}|${+s.bold}${+s.dim}${+s.italic}${+s.underline}${+s.inverse}${+s.strike}`;
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
  if (spec.startsWith("#"))
    return spec;
  const n = Number(spec);
  if (Number.isFinite(n)) {
    if (n < 16)
      return palette.base[n] ?? null;
    return xterm256(n);
  }
  return null;
}
function applySgrParams(params, raw, st) {
  for (let i = 0;i < params.length; i++) {
    const p = params[i];
    switch (p) {
      case 0:
        Object.assign(st, createSgrState());
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
        st.underline = true;
        break;
      case 7:
        st.inverse = true;
        break;
      case 9:
        st.strike = true;
        break;
      case 22:
        st.bold = false;
        st.dim = false;
        break;
      case 23:
        st.italic = false;
        break;
      case 24:
        st.underline = false;
        break;
      case 27:
        st.inverse = false;
        break;
      case 29:
        st.strike = false;
        break;
      case 38:
      case 48: {
        const isFg = p === 38;
        const mode = params[i + 1];
        if (mode === 5 && params.length > i + 2) {
          const v = String(params[i + 2]);
          if (isFg)
            st.fg = v;
          else
            st.bg = v;
          i += 2;
        } else if (mode === 2 && params.length > i + 4) {
          const hex = `#${[params[i + 2], params[i + 3], params[i + 4]].map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, "0")).join("")}`;
          if (isFg)
            st.fg = hex;
          else
            st.bg = hex;
          i += 4;
        }
        break;
      }
      case 39:
        st.fg = null;
        break;
      case 49:
        st.bg = null;
        break;
      default:
        if (p >= 30 && p <= 37)
          st.fg = String(p - 30);
        else if (p >= 90 && p <= 97)
          st.fg = String(p - 90 + 8);
        else if (p >= 40 && p <= 47)
          st.bg = String(p - 40);
        else if (p >= 100 && p <= 107)
          st.bg = String(p - 100 + 8);
        break;
    }
  }
}
function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function spanOpen(st, palette) {
  let fg = colorFor(palette, st.fg) ?? palette.defaultFg;
  let bg = colorFor(palette, st.bg);
  if (st.inverse) {
    const realBg = bg ?? palette.defaultBg;
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
  const deco = [];
  if (st.underline)
    deco.push("underline");
  if (st.strike)
    deco.push("line-through");
  if (deco.length)
    styles.push(`text-decoration:${deco.join(" ")}`);
  return `<span style="${styles.join(";")}">`;
}
var SGR_RE = /\x1b\[([0-9;]*)m/g;
var OTHER_ESC_RE = /\x1b(?:\][^\x07\x1b]*(?:\x07|\x1b\\)|\[[0-9;?]*[A-LN-Za-ln-z]|[()][AB0-2]|[=>]|[78])/g;
function escapeAttr(s) {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}
function lineToHtml(line, st, palette, links) {
  const cleaned = line.replace(OTHER_ESC_RE, "");
  let out = "";
  let last = 0;
  let col = 0;
  SGR_RE.lastIndex = 0;
  const defaultKey = sgrStateKey(createSgrState());
  let m;
  const wrap = (text, href) => {
    if (!text)
      return;
    const isDefault = sgrStateKey(st) === defaultKey;
    if (href) {
      const attrs = `href="${escapeAttr(href)}" target="_blank" rel="noopener noreferrer"`;
      const opener = isDefault ? `<a ${attrs} style="color:inherit;text-decoration:underline">` : spanOpen(st, palette).replace('<span style="', `<a ${attrs} style="text-decoration:underline;`);
      out += opener + escapeHtml(text) + "</a>";
    } else {
      out += isDefault ? escapeHtml(text) : spanOpen(st, palette) + escapeHtml(text) + "</span>";
    }
  };
  const emit = (text) => {
    if (!text)
      return;
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
        for (const l of links)
          if (l.start > abs && l.start < next)
            next = l.start;
        const take = next === Infinity ? text.length - pos : Math.min(text.length - pos, next - abs);
        wrap(text.slice(pos, pos + take), null);
        pos += take;
      }
    }
    col += text.length;
  };
  while ((m = SGR_RE.exec(cleaned)) !== null) {
    emit(cleaned.slice(last, m.index));
    const raw = m[1].length ? m[1].split(";") : ["0"];
    applySgrParams(raw.map((x) => x === "" ? 0 : Number(x)), raw, st);
    last = m.index + m[0].length;
  }
  emit(cleaned.slice(last));
  return out || " ";
}
// src/terminal-link.ts
var urlStartRe = /https?:\/\//g;
var terminalTokenRe = /^[^\s<>"')\]}{]+/;
function collectTerminalUrlSegments(rawLines, startLine, endLine, cols) {
  const matches = [];
  for (let wi = startLine;wi < endLine; wi++) {
    const stripped = stripAnsi(rawLines[wi]).trimEnd();
    urlStartRe.lastIndex = 0;
    let match;
    while ((match = urlStartRe.exec(stripped)) !== null) {
      const urlOnLine = stripped.slice(match.index).match(/^https?:\/\/[^\s<>"')\]}{]+/);
      if (!urlOnLine)
        continue;
      let fullUrl = urlOnLine[0];
      const segments = [{
        lineIdx: wi,
        startCol: match.index,
        endCol: match.index + urlOnLine[0].length
      }];
      let curIdx = wi;
      let curEndPos = segments[0].endCol;
      while (curEndPos >= cols - 2 && curEndPos > 10 && curIdx + 1 < rawLines.length) {
        const nextStripped = stripAnsi(rawLines[curIdx + 1]).trimEnd();
        const trimmed = nextStripped.trimStart();
        if (trimmed.length === 0)
          break;
        const cont = trimmed.match(terminalTokenRe);
        if (!cont)
          break;
        fullUrl += cont[0];
        curIdx++;
        const indent = nextStripped.length - trimmed.length;
        segments.push({
          lineIdx: curIdx,
          startCol: indent,
          endCol: indent + cont[0].length
        });
        curEndPos = segments[segments.length - 1].endCol;
      }
      let trailingTrim = 0;
      while (fullUrl.length > 1 && /[.,;:!?)}\]>]$/.test(fullUrl)) {
        if (fullUrl.endsWith(")") && fullUrl.includes("("))
          break;
        fullUrl = fullUrl.slice(0, -1);
        trailingTrim += 1;
      }
      let remainingTrim = trailingTrim;
      while (remainingTrim > 0 && segments.length > 0) {
        const last = segments[segments.length - 1];
        const segmentLen = last.endCol - last.startCol;
        if (segmentLen > remainingTrim) {
          last.endCol -= remainingTrim;
          remainingTrim = 0;
        } else {
          segments.pop();
          remainingTrim -= segmentLen;
        }
      }
      if (segments.length === 0 || !segments.some((segment) => segment.endCol > segment.startCol)) {
        continue;
      }
      matches.push({
        url: fullUrl,
        segments
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
  const windowStart = Math.max(0, targetLine - 10);
  const windowEnd = Math.min(rawLines.length, targetLine + 11);
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
  return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "").replace(/\x1b\][^\x1b]*\x1b\\/g, "");
}
// src/terminal-scroll.ts
var DEFAULT_WHEEL_PIXEL_SCALE = 0.6;
var MAX_WHEEL_LINES_PER_FRAME = 12;
function findLineOverlap(previousLines, nextLines) {
  const max = Math.min(previousLines.length, nextLines.length);
  for (let overlap = max;overlap > 0; overlap--) {
    let matches = true;
    const previousStart = previousLines.length - overlap;
    for (let i = 0;i < overlap; i++) {
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
  return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "").replace(/\x1b\][^\x1b]*\x1b\\/g, "");
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
function promptPayload(line) {
  const normalized = line.replace(/\u00a0/g, " ").trimStart();
  const marker = normalized[0];
  if (!marker || !PROMPT_MARKERS.has(marker))
    return null;
  const leading = line.length - line.trimStart().length;
  if (leading > 6)
    return null;
  return stripTrailingClock(normalized.slice(1).trim());
}
function stripTrailingClock(text) {
  return text.replace(/\s{2,}\d{1,2}:\d{2}\s*[AP]M\s*$/, "").trimEnd();
}
function isCodexStatusLine(trimmed) {
  return /\bcontext\s+\d+%\s+used\b/i.test(trimmed) && /\b(gpt|codex|weekly|5h|daily)\b/i.test(trimmed);
}
function isClaudeStatusLine(trimmed) {
  return /\b(new task\?|\/clear to save|bypass permissions|opus|sonnet|haiku)\b/i.test(trimmed) && /\b(tokens|permissions|effort|5h|week)\b/i.test(trimmed);
}
function isPromptTerminator(line) {
  const trimmed = line.replace(/\u00a0/g, " ").trim();
  if (!trimmed)
    return false;
  if (promptPayload(line) !== null)
    return true;
  if (/^[●•◦✻⎿■⚠╭╰│─◆❙┃⠀-⣿]/.test(trimmed))
    return true;
  if (/^(?:Tip:|OpenAI Codex\b)/i.test(trimmed))
    return true;
  if (/^(?:Turn completed in\s|Shift\+Tab:mode|Enter:send)/.test(trimmed))
    return true;
  if (isCodexStatusLine(trimmed) || isClaudeStatusLine(trimmed))
    return true;
  return false;
}
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
  return `${text.slice(0, MAX_PROMPT_DISPLAY_CHARS - 3).trimEnd()}...`;
}
function normalizePromptBlock(lines) {
  const cleanLines = lines.map(cleanPromptLine).filter((line, index, all) => line.trim() || index > 0 && index < all.length - 1);
  const userReport = extractMarkdownSection(cleanLines, "User report");
  const source = userReport ?? cleanLines.join(" ");
  return truncatePrompt(source.replace(/\s+/g, " ").trim());
}
function collectPrompts(lines, start) {
  const prompts = [];
  let i = start;
  while (i < lines.length) {
    const raw = lines[i] ?? "";
    const line = stripAnsi2(raw).trimEnd();
    const firstLine = promptPayload(line);
    if (firstLine === null) {
      i++;
      continue;
    }
    if (isFaintPayload(raw)) {
      i++;
      continue;
    }
    const block = [firstLine];
    i++;
    while (i < lines.length) {
      const continuationLine = stripAnsi2(lines[i]).trimEnd();
      if (isPromptTerminator(continuationLine))
        break;
      block.push(continuationLine);
      i++;
    }
    const terminator = i < lines.length ? stripAnsi2(lines[i] ?? "").replace(/\u00a0/g, " ").trim() : "";
    if (terminator && (isCodexStatusLine(terminator) || isClaudeStatusLine(terminator))) {
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
  const initialScanLines = options.initialScanLines ?? DEFAULT_INITIAL_SCAN_LINES;
  const maxScanLines = options.maxScanLines ?? DEFAULT_MAX_SCAN_LINES;
  const boundedMaxScanLines = Math.min(lines.length, maxScanLines);
  let scanLines = Math.min(lines.length, initialScanLines, boundedMaxScanLines);
  let prompts = collectPrompts(lines, Math.max(0, lines.length - scanLines));
  while (prompts.length < targetCount && scanLines < boundedMaxScanLines) {
    scanLines = Math.min(boundedMaxScanLines, scanLines * 2);
    prompts = collectPrompts(lines, Math.max(0, lines.length - scanLines));
  }
  return dedupeKeepLatest(prompts).slice(-targetCount);
}
function extractRecentPromptsFromPane(content, targetCount = 5) {
  const lines = content.split(`
`);
  if (lines.length === 0)
    return [];
  return dedupeKeepLatest(collectPrompts(lines, 0)).slice(-targetCount);
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
function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m || !m[1])
    return null;
  const n = parseInt(m[1], 16);
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
  const [r, g, b] = rgb.map((v) => v / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
var DERIVED_DARK_ANSI = {
  red: "#ff7a7a",
  green: "#7dffa0",
  yellow: "#ffef9e",
  blue: "#c8b4ff",
  magenta: "#ff9ad5",
  cyan: "#9be9ff",
  brightBlack: "#b9b2aa"
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
  const isLightBg = luminance(bg) > 0.55;
  const fg = isLightBg ? "#1f1812" : mix("#ffffff", bg, 0.08);
  const stage = mix(bg, "#000000", isLightBg ? 0.12 : 0.4);
  const hudSolid = isLightBg ? mix(bg, "#ffffff", 0.25) : mix(bg, "#000000", 0.55);
  const accentOk = Math.abs(luminance(base.agent) - luminance(bg)) > 0.25;
  const accent = accentOk ? base.agent : isLightBg ? "#1A1A1A" : "#FFFFFF";
  const rgb = hexToRgb(hudSolid) ?? [20, 20, 20];
  return {
    ...base,
    agent: accent,
    tbg: bg,
    tstage: stage,
    tfg: fg,
    hud: `rgba(${rgb[0]},${rgb[1]},${rgb[2]},.94)`,
    hudFg: fg,
    hudLine: mix(bg, fg, 0.4),
    xterm: {
      background: bg,
      foreground: fg,
      cursor: fg,
      cursorAccent: bg,
      selectionBackground: stage,
      black: bg,
      white: fg,
      brightWhite: fg,
      ...isLightBg ? DERIVED_LIGHT_ANSI : DERIVED_DARK_ANSI
    }
  };
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
  { value: "grok-build", label: "Grok Build", flag: "--model grok-build" },
  { value: "grok-composer-2.5-fast", label: "Composer 2.5 fast", flag: "--model grok-composer-2.5-fast" }
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
var ESC = "\x1B";
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
  const key = e.key;
  const shifted = !!e.shiftKey;
  const alt = !!e.altKey;
  const ctrl = !!e.ctrlKey;
  const arrowFinal = arrowFinals[key];
  if (arrowFinal) {
    return shifted || alt || ctrl ? modifiedCsi(arrowFinal, shifted, alt, ctrl) : `${ESC}[${arrowFinal}`;
  }
  const homeEndFinal = homeEndFinals[key];
  if (homeEndFinal) {
    return shifted || alt || ctrl ? modifiedCsi(homeEndFinal, shifted, alt, ctrl) : `${ESC}[${homeEndFinal}`;
  }
  if (key === "Enter")
    return alt ? `${ESC}\r` : "\r";
  if (key === "Tab") {
    if (alt || ctrl)
      return null;
    return shifted ? `${ESC}[Z` : "\t";
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
    return alt && altIsMeta ? `${ESC}${key}` : key;
  return null;
}
function bracketedPaste(text) {
  return `${ESC}[200~${text.replace(/\r\n|\n/g, "\r")}${ESC}[201~`;
}
function modifiedCsi(final, shift, alt, ctrl) {
  const modifier = modifierValue(shift, alt, ctrl);
  return `${ESC}[1;${modifier}${final}`;
}
function modifierValue(shift, alt, ctrl) {
  return 1 + (shift ? 1 : 0) + (alt ? 2 : 0) + (ctrl ? 4 : 0);
}
function namedKeySequence(key, shift, alt, ctrl) {
  if (key === "Backspace") {
    const base = ctrl ? "\b" : "";
    return alt ? `${ESC}${base}` : base;
  }
  if (key === "Escape")
    return ESC;
  if (key === "Insert") {
    if (shift || ctrl)
      return null;
    return alt ? `${ESC}[2;3~` : `${ESC}[2~`;
  }
  const tildeCode = tildeNamedKeys[key];
  if (tildeCode) {
    const modifier = modifierValue(shift, alt, ctrl);
    return modifier > 1 ? `${ESC}[${tildeCode};${modifier}~` : `${ESC}[${tildeCode}~`;
  }
  return;
}
function functionKeySequence(key, shift, alt, ctrl) {
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
function ctrlSequence(e) {
  if (e.key === " " || e.code === "Space")
    return "\x00";
  if (e.key.length === 1 && e.key >= "0" && e.key <= "9") {
    return ctrlDigitSequences[e.key] ?? null;
  }
  if (e.key === "[")
    return ESC;
  if (e.key === "\\")
    return "\x1C";
  if (e.key === "]")
    return "\x1D";
  const lower = e.key.toLowerCase();
  if (lower.length === 1 && lower >= "a" && lower <= "z") {
    return String.fromCharCode(lower.charCodeAt(0) - 96);
  }
  return null;
}
var ctrlDigitSequences = {
  "0": null,
  "1": null,
  "2": "\x00",
  "3": ESC,
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
  if (text)
    steps.push({ keys: text, delayBeforeMs: 0 });
  steps.push({ keys: "\r", delayBeforeMs: enterDelayMs });
  if (opts.agent === EXTRA_ENTER_AGENT) {
    steps.push({ keys: "\r", delayBeforeMs: EXTRA_ENTER_DELAY_MS });
  }
  return steps;
}
export {
  wheelEventToLines,
  wheelDeltaToLines,
  utf8ByteLength,
  submitPlan,
  stripAnsi2 as stripAnsi,
  stringCells,
  sgrWheel,
  sgrStateKey,
  sgrSnapToBottom,
  sgrClick,
  rgbToHex,
  prefixForCells,
  pasteInfo,
  paneTextForCopy,
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
  findTerminalUrlAtCell,
  findLineOverlap,
  extractRecentPromptsFromPane,
  extractRecentPrompts,
  deriveSurface,
  createSgrState,
  contentCellFromPoint,
  consumeWholeWheelLines,
  collectTerminalUrlSegments,
  cloneSgrState,
  charCellWidth,
  centerContentCell,
  buildLaunchSpec,
  buildLaunchCommand,
  bracketedPaste,
  SNAP_BOTTOM_EVENTS,
  MAX_WHEEL_LINES_PER_FRAME,
  DEFAULT_WHEEL_PIXEL_SCALE,
  DEFAULT_WHEEL_MAX_PER_CALL,
  DEFAULT_SHORTCUTS,
  DEFAULT_LAUNCH_PRESETS
};
