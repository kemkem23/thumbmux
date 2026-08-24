import { describe, expect, test } from "bun:test";
import {
  TmuxControlStreamParser,
  decodeTmuxControlValue,
  paneGeometryFromTmuxLayout,
} from "../src/tmux-control-stream";

describe("tmux control-mode ordered stream", () => {
  test("decodes octal escapes as bytes without corrupting UTF-8 or NUL", () => {
    const utf8 = Buffer.from("ไทย🙂", "utf8");
    const encoded = Buffer.concat([Buffer.from("A\\134\\000\\015\\012"), utf8, Buffer.from("\\033[31m")]);
    expect(Buffer.from(decodeTmuxControlValue(encoded))).toEqual(Buffer.concat([
      Buffer.from("A\\\0\r\n"), utf8, Buffer.from("\u001b[31m"),
    ]));
    expect(() => decodeTmuxControlValue(Buffer.from("bad\\n"))).toThrow(/escape/);
  });

  test("emits output and resize in their exact source order across chunks", () => {
    const parser = new TmuxControlStreamParser({ paneId: "%647", windowId: "@88" });
    const source = Buffer.concat([
      Buffer.from("%extended-output %647 0 : before\\015\\012\n"),
      Buffer.from("%layout-change @88 a87d,100x30,0,0,647 a87d,100x30,0,0,647 *\n"),
      Buffer.from("%output %647 \\033[2Jafter\n"),
    ]);
    const events = [
      ...parser.push(source.subarray(0, 17)),
      ...parser.push(source.subarray(17, 75)),
      ...parser.push(source.subarray(75)),
    ];
    parser.finish();
    expect(events.map((event) => event.type)).toEqual(["output", "layout", "output"]);
    expect(Buffer.from((events[0] as any).bytes).toString()).toBe("before\r\n");
    expect(events[1]).toEqual({ type: "layout", windowId: "@88", paneId: "%647", cols: 100, rows: 30 });
    expect(Buffer.from((events[2] as any).bytes).toString()).toBe("\u001b[2Jafter");
  });

  test("parses a target leaf inside a split layout", () => {
    const layout = "bb62,159x48,0,0{79x48,0,0,647,79x48,80,0[79x24,80,0,648,79x23,80,25,649]}";
    expect(paneGeometryFromTmuxLayout(layout, "%647")).toEqual({ cols: 79, rows: 48 });
    expect(paneGeometryFromTmuxLayout(layout, "%648")).toEqual({ cols: 79, rows: 24 });
    expect(paneGeometryFromTmuxLayout(layout, "%999")).toBeNull();
  });

  test("ignores command block payload and other panes", () => {
    const parser = new TmuxControlStreamParser({ paneId: "%1" });
    const events = parser.push(Buffer.from([
      "%begin 1 2 0", "%output %1 command-output", "%end 1 2 0", "%output %2 ignored",
      "%pause %1", "%continue %1", "%exit server exited", "",
    ].join("\n")));
    expect(events).toEqual([
      { type: "pause", paneId: "%1" },
      { type: "continue", paneId: "%1" },
      { type: "exit", reason: "server exited" },
    ]);
  });

  test("fails closed on torn or malformed protocol", () => {
    const parser = new TmuxControlStreamParser({ paneId: "%1", maxBufferedLineBytes: 8 });
    expect(() => parser.push(Buffer.from("123456789"))).toThrow(/exceeds/);
    const torn = new TmuxControlStreamParser({ paneId: "%1" });
    torn.push(Buffer.from("%output %1 unfinished"));
    expect(() => torn.finish()).toThrow(/torn/);
    const malformed = new TmuxControlStreamParser({ paneId: "%1" });
    expect(() => malformed.push(Buffer.from("%output nope x\n"))).toThrow(/pane id/);
  });
});
