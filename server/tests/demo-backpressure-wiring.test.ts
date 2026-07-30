import { expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TmuxWsMux } from "@thumbmux/server";

test("demo forwards Bun websocket drain events to TmuxWsMux", async () => {
  const historyRoot = await mkdtemp(join(tmpdir(), "thumbmux-demo-wiring-"));
  const previousHistoryRoot = process.env.THUMBMUX_HISTORY_ROOT;
  process.env.THUMBMUX_HISTORY_ROOT = historyRoot;
  let registered: any;
  const serveSpy = spyOn(Bun, "serve").mockImplementation(((options: any) => {
    registered = options;
    return {} as any;
  }) as typeof Bun.serve);
  const logSpy = spyOn(console, "log").mockImplementation(() => {});
  const handleDrainSpy = spyOn(TmuxWsMux.prototype, "handleDrain").mockImplementation(() => {});

  try {
    await import("../../demo/serve.ts");

    const drain = registered?.websocket?.drain;
    expect(drain).toBeFunction();
    if (typeof drain !== "function") return;

    const ws = { send: () => 1 };
    drain(ws);

    expect(handleDrainSpy).toHaveBeenCalledTimes(1);
    expect(handleDrainSpy).toHaveBeenLastCalledWith(ws);
  } finally {
    handleDrainSpy.mockRestore();
    logSpy.mockRestore();
    serveSpy.mockRestore();
    if (previousHistoryRoot === undefined) delete process.env.THUMBMUX_HISTORY_ROOT;
    else process.env.THUMBMUX_HISTORY_ROOT = previousHistoryRoot;
    await rm(historyRoot, { recursive: true, force: true });
  }
});
