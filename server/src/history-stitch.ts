/**
 * Reconcile a fresh capture against what a durable archive already holds.
 *
 * The boundary this uses is the one tmux guarantees: `capture-pane` returns
 * scrollback followed by the visible screen, and only the visible screen can be
 * repainted in place. Rows above it have scrolled into tmux history and can no
 * longer change, so they are safe to store. Nothing here encodes how many rows
 * an agent's composer redraws — that number is a property of the agent, and
 * every version of this logic that tried to guess it lost real history.
 */

export type AnchorMatch = { index: number } | "missing" | "ambiguous";

/** Locate `needle` in `hay`. Two matches are as useless as none. */
export function locateAnchor(hay: readonly string[], needle: readonly string[]): AnchorMatch {
  if (needle.length === 0 || hay.length < needle.length) return "missing";
  let found = -1;
  for (let start = 0; start <= hay.length - needle.length; start++) {
    let matches = true;
    for (let index = 0; index < needle.length; index++) {
      if (hay[start + index] !== needle[index]) {
        matches = false;
        break;
      }
    }
    if (!matches) continue;
    if (found !== -1) return "ambiguous";
    found = start;
  }
  return found === -1 ? "missing" : { index: found };
}

export type StitchInput = {
  /** Newest archived lines, used to find where we already are in this capture. */
  archivedTail: readonly string[];
  /** A whole `capture-pane` result: scrollback then the visible screen. */
  captured: readonly string[];
  /** Height of the visible screen — the only region tmux can repaint. */
  paneRows: number;
  /** What the mux serves as live. Reported, never used to limit storage. */
  liveLineLimit: number;
};

export type StitchResult = {
  /** Lines to append, in order. */
  appended: string[];
  /** True when the archive tail was found — the history is provably continuous. */
  anchored: boolean;
  /** True when the anchor was ambiguous: write nothing, try again next capture. */
  deferred: boolean;
  /** True when the capture holds nothing above the visible screen yet. */
  tooShort: boolean;
};

const EMPTY: StitchResult = { appended: [], anchored: false, deferred: false, tooShort: false };

export function stitchCapture(input: StitchInput): StitchResult {
  const cut = Math.max(0, input.captured.length - Math.max(1, input.paneRows));
  if (cut === 0) return { ...EMPTY, tooShort: true };

  if (input.archivedTail.length === 0) {
    return { ...EMPTY, appended: input.captured.slice(0, cut) };
  }

  const match = locateAnchor(input.captured, input.archivedTail);
  if (match === "ambiguous") return { ...EMPTY, deferred: true };
  if (match === "missing") {
    return { ...EMPTY, appended: input.captured.slice(0, cut) };
  }

  const from = match.index + input.archivedTail.length;
  return {
    ...EMPTY,
    anchored: true,
    appended: from >= cut ? [] : input.captured.slice(from, cut),
  };
}
