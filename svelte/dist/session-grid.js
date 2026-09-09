const DEFAULT_UNGROUPED_LABEL = 'Ungrouped';
const MIN_CONTRAST = 4.5;
function finiteActivityAt(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
function normalizeSearch(value) {
    return (value ?? '').trim().toLocaleLowerCase();
}
function searchHaystack(session) {
    return [session.name, session.chip, session.groupLabel]
        .filter((value) => typeof value === 'string' && value.length > 0)
        .join('\u0000')
        .toLocaleLowerCase();
}
function compareRecent(a, b) {
    const aTime = a.finiteActivityAt;
    const bTime = b.finiteActivityAt;
    if (aTime !== null && bTime !== null && aTime !== bTime)
        return bTime - aTime;
    if (aTime !== null && bTime === null)
        return -1;
    if (aTime === null && bTime !== null)
        return 1;
    return a.index - b.index;
}
function compareGroupRecent(a, b) {
    if (a.newestActivityAt !== null && b.newestActivityAt !== null && a.newestActivityAt !== b.newestActivityAt) {
        return b.newestActivityAt - a.newestActivityAt;
    }
    if (a.newestActivityAt !== null && b.newestActivityAt === null)
        return -1;
    if (a.newestActivityAt === null && b.newestActivityAt !== null)
        return 1;
    return a.firstIndex - b.firstIndex;
}
export function activityDatetime(value) {
    const finite = finiteActivityAt(value);
    if (finite === null)
        return null;
    const date = new Date(finite);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
export function displayStateLabel(session) {
    if (!session.state)
        return null;
    return session.stateLabel ?? session.state.toUpperCase();
}
export function splitSessionName(name, options = {}) {
    // Defaults sized for the NARROWEST real cards (2-col phone grid ≈ 110-120px
    // at 10.5px mono ≈ 17-19 chars): split earlier and keep the tail long enough
    // that sibling names stay distinguishable. Launchers commonly append a
    // shared ~10-char stamp (worker/timestamp), so the tail must reach PAST it
    // to the first differing character — 12 keeps "…a-<stamp>" and "…b-<stamp>"
    // apart where 10 would render both cards identically.
    const maxChars = Math.max(12, Math.floor(options.maxChars ?? 18));
    const tailChars = Math.max(6, Math.min(maxChars - 4, Math.floor(options.tailChars ?? 12)));
    if (name.length <= maxChars) {
        return { full: name, truncated: false, head: name, tail: '' };
    }
    const headChars = Math.max(4, maxChars - tailChars - 1);
    return {
        full: name,
        truncated: true,
        head: name.slice(0, headChars),
        tail: name.slice(-tailChars),
    };
}
export function buildSessionGridModel(sessions, options = {}) {
    const selectedFilter = options.filterValue ?? '';
    const search = normalizeSearch(options.search);
    const order = options.order ?? 'input';
    const ungroupedLabel = options.ungroupedLabel ?? DEFAULT_UNGROUPED_LABEL;
    const prepared = sessions.map((session, index) => {
        const groupKey = session.groupKey ?? '';
        return {
            session,
            index,
            displayName: splitSessionName(session.name),
            activityDatetime: activityDatetime(session.lastActivityAt),
            groupKey,
            groupLabel: session.groupLabel ?? ungroupedLabel,
            finiteActivityAt: finiteActivityAt(session.lastActivityAt),
        };
    });
    const filtered = prepared
        .filter((item) => !selectedFilter || item.session.filterValue === selectedFilter)
        .filter((item) => !search || searchHaystack(item.session).includes(search));
    const ordered = [...filtered].sort(order === 'recent' ? compareRecent : (a, b) => a.index - b.index);
    if (!options.grouped)
        return { items: ordered, groups: [], grouped: false };
    const groupMap = new Map();
    for (const item of ordered) {
        let group = groupMap.get(item.groupKey);
        if (!group) {
            group = {
                key: item.groupKey,
                label: item.groupLabel,
                newestActivityAt: item.finiteActivityAt,
                firstIndex: item.index,
                items: [],
            };
            groupMap.set(item.groupKey, group);
        }
        group.items.push(item);
        if (item.finiteActivityAt !== null &&
            (group.newestActivityAt === null || item.finiteActivityAt > group.newestActivityAt)) {
            group.newestActivityAt = item.finiteActivityAt;
        }
        group.firstIndex = Math.min(group.firstIndex, item.index);
    }
    const groups = Array.from(groupMap.values()).sort(order === 'recent' ? compareGroupRecent : (a, b) => a.firstIndex - b.firstIndex);
    return { items: ordered, groups, grouped: true };
}
function parseHex(hex) {
    const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
    if (!match?.[1])
        return null;
    const value = Number.parseInt(match[1], 16);
    return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}
function toHex(r, g, b) {
    const part = (value) => Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, '0');
    return `#${part(r)}${part(g)}${part(b)}`;
}
function relativeLuminance(hex) {
    const rgb = parseHex(hex);
    if (!rgb)
        return null;
    const [r, g, b] = rgb.map((value) => {
        const channel = value / 255;
        return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export function contrastRatio(foreground, background) {
    const fg = relativeLuminance(foreground);
    const bg = relativeLuminance(background);
    if (fg === null || bg === null)
        return 1;
    const light = Math.max(fg, bg);
    const dark = Math.min(fg, bg);
    return (light + 0.05) / (dark + 0.05);
}
function mix(foreground, target, ratio) {
    const fg = parseHex(foreground);
    const to = parseHex(target);
    if (!fg || !to)
        return target;
    return toHex(fg[0] + (to[0] - fg[0]) * ratio, fg[1] + (to[1] - fg[1]) * ratio, fg[2] + (to[2] - fg[2]) * ratio);
}
export function readableColorOn(background, foreground, minimum = MIN_CONTRAST) {
    const safeBg = parseHex(background) ? background : '#101014';
    let candidate = parseHex(foreground) ? foreground : '#ffffff';
    if (contrastRatio(candidate, safeBg) >= minimum)
        return candidate;
    const black = '#050505';
    const white = '#ffffff';
    const target = contrastRatio(black, safeBg) >= contrastRatio(white, safeBg) ? black : white;
    for (let step = 1; step <= 12; step++) {
        candidate = mix(foreground, target, step / 12);
        if (contrastRatio(candidate, safeBg) >= minimum)
            return candidate;
    }
    return target;
}
export function deriveThumbnailPalette(palette) {
    const defaultBg = parseHex(palette.defaultBg) ? palette.defaultBg : '#101014';
    const defaultFg = readableColorOn(defaultBg, palette.defaultFg);
    const base = palette.base.map((color) => readableColorOn(defaultBg, color));
    return { base, defaultFg, defaultBg };
}
