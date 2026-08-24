import { describe, expect, test } from "bun:test";
import {
  parseTmuxControlWalBytesLine,
  parseTmuxControlWalLine,
} from "../src/integrations/terminal-wal";

describe("tmux control-mode WAL parser", () => {
  test("decodes %output octal escapes without UTF-8 reinterpretation", () => {
    const event = parseTmuxControlWalLine("%output %7 A\\000\\377\\134 z");
    expect(event).toMatchObject({ kind: "output", paneId: "%7", extended: false });
    if (event.kind !== "output") throw new Error("expected output");
    expect([...event.bytes]).toEqual([0x41, 0x00, 0xff, 0x5c, 0x20, 0x7a]);
  });

  test("parses %extended-output age, future arguments, and raw bytes", () => {
    const event = parseTmuxControlWalLine("%extended-output %19 42 future=v1 : hi\\012");
    expect(event).toMatchObject({
      kind: "output",
      paneId: "%19",
      extended: true,
      ageMs: 42,
      futureArgs: ["future=v1"],
    });
    if (event.kind !== "output") throw new Error("expected output");
    expect(Buffer.from(event.bytes).toString("hex")).toBe("68690a");
  });

  test("preserves raw UTF-8, emoji, and octal NUL in one byte-safe payload", () => {
    const payload = Buffer.from("ไทย🙂", "utf8");
    const line = Buffer.concat([
      Buffer.from("%extended-output %19 0 : raw-", "ascii"),
      payload,
      Buffer.from("\\000-tail", "ascii"),
    ]);
    const event = parseTmuxControlWalBytesLine(line);
    if (event.kind !== "output") throw new Error("expected output");
    expect(Buffer.from(event.bytes)).toEqual(Buffer.concat([
      Buffer.from("raw-", "ascii"),
      payload,
      Buffer.from([0x00]),
      Buffer.from("-tail", "ascii"),
    ]));
  });

  test("extracts geometry only from a one-pane %layout-change", () => {
    const event = parseTmuxControlWalLine(
      "%layout-change @751 b14c,187x45,0,0,751 b14c,187x45,0,0,751 *",
    );
    expect(event).toEqual({
      kind: "layout-change",
      windowId: "@751",
      paneId: "%751",
      geometry: { cols: 187, rows: 45 },
      windowLayout: "b14c,187x45,0,0,751",
      visibleLayout: "b14c,187x45,0,0,751",
      windowFlags: "*",
    });
  });

  test("accepts printable UTF-8 but fails closed on malformed escapes", () => {
    expect(() => parseTmuxControlWalLine("%output %1 bad\\x"))
      .toThrow("invalid tmux control-mode escape");
    const event = parseTmuxControlWalLine("%output %1 café");
    if (event.kind !== "output") throw new Error("expected output");
    expect(Buffer.from(event.bytes)).toEqual(Buffer.from("café", "utf8"));
  });

  test("finds the exact target pane in a split layout", () => {
    const layout = "bb62,159x48,0,0{79x48,0,0,647,79x48,80,0[79x24,80,0,648,79x23,80,25,649]}";
    const event = parseTmuxControlWalBytesLine(
      Buffer.from(`%layout-change @42 ${layout} ${layout} *`, "ascii"),
      { paneId: "%647", windowId: "@42" },
    );
    expect(event).toMatchObject({
      kind: "layout-change",
      windowId: "@42",
      paneId: "%647",
      geometry: { cols: 79, rows: 48 },
    });
  });

  test("fails closed on untargeted split layouts, mismatches, and unknown events", () => {
    const split = "dead,80x24,0,0{40x24,0,0,1,39x24,41,0,2}";
    expect(() => parseTmuxControlWalLine(
      `%layout-change @1 ${split} ${split} *`,
    )).toThrow("not a one-pane");
    expect(() => parseTmuxControlWalBytesLine(
      Buffer.from(`%layout-change @1 ${split} ${split} *`, "ascii"),
      { paneId: "%99", windowId: "@1" },
    )).toThrow("does not contain target");
    expect(() => parseTmuxControlWalLine(
      "%layout-change @1 b25e,80x24,0,0,1 abcd,81x24,0,0,1 *",
    )).toThrow("does not match");
    expect(() => parseTmuxControlWalLine("%pause %1"))
      .toThrow("not a WAL input event");
  });
});
