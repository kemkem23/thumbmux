import { describe, expect, test } from "bun:test";
import type { TerminalReplayResult } from "../src/terminal-replay-materializer";
import {
  terminalReplayResultFromWire,
  terminalReplayResultToWire,
} from "../src/integrations/terminal-replay-worker";

describe("terminal replay worker result wire", () => {
  test("preserves the last successful WAL record timestamp", () => {
    const source: TerminalReplayResult = {
      complete: true,
      verified: true,
      recoveredFromCheckpoint: false,
      ended: false,
      walOffset: 123,
      sequence: 9_007_199_254_740_993n,
      lastRecordAt: 1_789_508_400_000,
      hasMoreWal: false,
      historyBytes: 0,
      identity: null,
      geometry: null,
      pendingResize: null,
      screen: null,
      historyPath: "/tmp/history.ansi",
      checkpointPath: "/tmp/checkpoint.json",
    };

    const revived = terminalReplayResultFromWire(
      JSON.parse(JSON.stringify(terminalReplayResultToWire(source))),
    );
    expect(revived.sequence).toBe(source.sequence);
    expect(revived.lastRecordAt).toBe(source.lastRecordAt);
  });
});
