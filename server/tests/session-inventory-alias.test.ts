import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetDeprecationWarnings, type SessionListItem } from "@thumbmux/core";
import { TmuxWsMux, type TmuxDriver } from "../src/ws-mux";

class FakeWS {
  sent: string[] = [];

  send(data: string) {
    this.sent.push(data);
    return data.length;
  }

  sessionListFrames() {
    return this.sent
      .map((s) => {
        try {
          return JSON.parse(s);
        } catch {
          return null;
        }
      })
      .filter((f) => f && f.channel === "__sessions" && f.type === "sessions");
  }
}

function makeDriver(sessions: SessionListItem[]): TmuxDriver {
  return {
    listSessions: () => sessions,
    capturePane: async () => "",
    sendKeys: () => {},
    resizeWindow: () => {},
    getSessionActivity: () => new Map(),
    getHistoryLimit: () => 2000,
  };
}

describe("TmuxWsMux session inventory alias and deprecation", () => {
  const originalWarn = console.warn;
  let warnings: string[] = [];

  beforeEach(() => {
    warnings = [];
    resetDeprecationWarnings();
    console.warn = (msg: string) => {
      warnings.push(msg);
    };
  });

  afterEach(() => {
    console.warn = originalWarn;
    resetDeprecationWarnings();
  });

  test("pushSessionInventory pushes current inventory to subscribers", () => {
    const list: SessionListItem[] = [
      { name: "s1", windows: 1, created: 100, active: true },
    ];
    const mux = new TmuxWsMux({ driver: makeDriver(list) });
    const ws = new FakeWS();
    mux.subscribeSessions(ws as any);

    // Initial subscribe sends current inventory
    expect(ws.sessionListFrames().length).toBe(1);

    // Mutate provider list and push
    list.push({ name: "s2", windows: 1, created: 200, active: false });
    mux.pushSessionInventory();

    const frames = ws.sessionListFrames();
    expect(frames.length).toBe(2);
    expect(JSON.parse(frames[1].data)).toEqual(list);

    // Calling pushSessionInventory directly should NOT log deprecation warning
    expect(warnings.length).toBe(0);
    mux.stop();
  });

  test("broadcastSessionList delegates to pushSessionInventory and emits a deprecation warning", () => {
    const list: SessionListItem[] = [
      { name: "s1", windows: 1, created: 100, active: true },
    ];
    const mux = new TmuxWsMux({ driver: makeDriver(list) });
    const ws = new FakeWS();
    mux.subscribeSessions(ws as any);

    expect(ws.sessionListFrames().length).toBe(1);

    // Mutate and invoke legacy broadcastSessionList
    list.push({ name: "s-legacy", windows: 1, created: 300, active: false });
    mux.broadcastSessionList();

    const frames = ws.sessionListFrames();
    expect(frames.length).toBe(2);
    expect(JSON.parse(frames[1].data)).toEqual(list);

    // Verifies deprecation stamp matches CONTRACT requirements
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toBe(
      "[thumbmux] TmuxWsMux.broadcastSessionList is deprecated since v0.18.18 — use pushSessionInventory; removal no earlier than v0.19.0",
    );

    // Calling again should push if data changed, but warning must only fire once per process
    list.push({ name: "s-legacy-2", windows: 1, created: 400, active: false });
    mux.broadcastSessionList();
    expect(ws.sessionListFrames().length).toBe(3);
    expect(warnings.length).toBe(1);

    mux.stop();
  });

  test("alias preserves prototype and function signature for legacy hosts", () => {
    expect(typeof TmuxWsMux.prototype.pushSessionInventory).toBe("function");
    expect(typeof TmuxWsMux.prototype.broadcastSessionList).toBe("function");
    expect(TmuxWsMux.prototype.pushSessionInventory.length).toBe(0);
    expect(TmuxWsMux.prototype.broadcastSessionList.length).toBe(0);
  });
});
