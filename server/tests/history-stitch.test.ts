import { expect, test } from "bun:test";
import { locateAnchor, stitchCapture } from "../src/history-stitch";

const PANE_ROWS = 5;

/** A capture is scrollback followed by the visible screen. */
function capture(scrollback: string[], screen: string[] = ["+--+", "| >", "+--+", "hints", "tokens"]) {
  return [...scrollback, ...screen];
}

function rows(from: number, to: number): string[] {
  const out: string[] = [];
  for (let index = from; index <= to; index++) out.push(`L${index}`);
  return out;
}

test("locateAnchor reports a unique match, and refuses an ambiguous one", () => {
  expect(locateAnchor(["a", "b", "c", "d"], ["b", "c"])).toEqual({ index: 1 });
  expect(locateAnchor(["a", "b", "a", "b"], ["a", "b"])).toBe("ambiguous");
  expect(locateAnchor(["a", "b"], ["z"])).toBe("missing");
  expect(locateAnchor(["a"], ["a", "b"])).toBe("missing");
});

test("a first sighting keeps everything above the visible screen", () => {
  const result = stitchCapture({
    archivedTail: [],
    captured: capture(rows(1, 10)),
    paneRows: PANE_ROWS,
    liveLineLimit: 1_000,
  });
  expect(result.appended).toEqual(rows(1, 10));
  expect(result.anchored).toBe(false);
});

test("an agent repainting a six-row composer does not stall the stitch", () => {
  // Measured on production panes: composers redraw 5-8 rows every turn, which is
  // why an overlap tolerant of only two rewritten rows archived 4% of scrolls.
  const before = stitchCapture({
    archivedTail: [],
    captured: capture(rows(1, 10), ["+--+", "| > ", "+--+", "shortcuts", "tokens"]),
    paneRows: PANE_ROWS,
    liveLineLimit: 1_000,
  });
  const after = stitchCapture({
    archivedTail: before.appended.slice(-40),
    captured: capture(rows(1, 16), ["+--+", "| > typing", "+--+", "shortcuts", "tokens 2"]),
    paneRows: PANE_ROWS,
    liveLineLimit: 1_000,
  });
  expect(after.appended).toEqual(rows(11, 16));
  expect(after.anchored).toBe(true);
});

test("an ambiguous anchor defers instead of guessing", () => {
  const repeated = ["same", "same", "same"];
  const result = stitchCapture({
    archivedTail: repeated,
    captured: capture([...repeated, "x", ...repeated, "y"]),
    paneRows: PANE_ROWS,
    liveLineLimit: 1_000,
  });
  expect(result.appended).toEqual([]);
  expect(result.deferred).toBe(true);
});

test("a pane still smaller than the visible screen has nothing to store yet", () => {
  const result = stitchCapture({
    archivedTail: rows(1, 40),
    captured: capture([]),
    paneRows: PANE_ROWS,
    liveLineLimit: 1_000,
  });
  expect(result.appended).toEqual([]);
  expect(result.tooShort).toBe(true);
  expect(result.deferred).toBe(false);
});

test("a lost thread is reported, not silently skipped", () => {
  const result = stitchCapture({
    archivedTail: ["ancient-1", "ancient-2", "ancient-3"],
    captured: capture(rows(500, 510)),
    paneRows: PANE_ROWS,
    liveLineLimit: 1_000,
  });
  expect(result.anchored).toBe(false);
  expect(result.deferred).toBe(false);
  expect(result.appended).toEqual(rows(500, 510));
});
