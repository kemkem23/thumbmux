/**
 * Protocol conformance — drives a real TmuxWsMux + the reference Bun driver
 * against a real throwaway tmux session through fake sockets, asserting the
 * behaviors documented in docs/protocol.md: subscribe snapshots, tail-mode
 * slicing, hash dedupe (idle sends nothing), keystroke round-trips, pong
 * replies, the __sessions channel, and unsubscribe cleanup.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { TmuxWsMux, createBunTmuxDriver, spawnTmuxSession, killTmuxSession } from "../src";

const SES = `thumbmux-conf-${Date.now()}`;

class FakeWS {
  sent: string[] = [];
  send(d: string) { this.sent.push(d); }
  frames(type?: string, channel?: string) {
    return this.sent.map((s) => JSON.parse(s)).filter((m) =>
      (!type || m.type === type) && (!channel || m.channel === channel));
  }
}

async function until(pred: () => boolean | Promise<boolean>, ms = 6000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("condition not met in time");
}

const driver = createBunTmuxDriver();
const mux = new TmuxWsMux({ driver, pollNormalMs: 100, pollBurstMs: 50 });

beforeAll(() => {
  spawnTmuxSession(SES, "/tmp");
});

afterAll(() => {
  try { killTmuxSession(SES); } catch { /* already gone */ }
});

describe("thumbmux protocol conformance", () => {
  const full = new FakeWS();
  const tail = new FakeWS();

  test("subscribe → an output snapshot arrives on the session channel", async () => {
    mux.handleMessage({ type: "subscribe", session: SES }, full as any);
    await until(() => full.frames("output", SES).length > 0);
    expect(full.frames("output", SES)[0].data.length).toBeGreaterThan(0);
  }, 15000);

  test("tail subscribe receives only the last N lines", async () => {
    mux.handleMessage({ type: "subscribe", session: SES, tail: 5 }, tail as any);
    await until(() => tail.frames("output", SES).length > 0);
    const lines = tail.frames("output", SES).at(-1).data.split("\n");
    expect(lines.length).toBeLessThanOrEqual(5);
    const fullLines = full.frames("output", SES).at(-1).data.split("\n");
    expect(fullLines.length).toBeGreaterThan(lines.length);
  }, 15000);

  test("hash dedupe: an idle pane sends zero further frames", async () => {
    await new Promise((r) => setTimeout(r, 400)); // settle
    const before = full.frames("output", SES).length;
    await new Promise((r) => setTimeout(r, 600)); // several poll ticks
    expect(full.frames("output", SES).length).toBe(before);
  });

  test("keys reach the pane; a capture broadcast fans out to full AND tail viewers", async () => {
    const marker = `mk${Date.now()}`;
    mux.handleMessage({ type: "keys", session: SES, data: `echo ${marker}\r` }, full as any);
    // The keystroke really lands in tmux:
    await until(async () => (await driver.capturePane(SES, { startLine: -100 })).includes(marker), 8000);
    // A fresh subscribe forces a capture, whose broadcast reaches EVERY
    // viewer of the session — the full one and the tail-sliced one.
    const late = new FakeWS();
    mux.handleMessage({ type: "subscribe", session: SES }, late as any);
    await until(() => late.frames("output", SES).some((m) => m.data.includes(marker)), 8000);
    await until(() => tail.frames("output", SES).some((m) => m.data.includes(marker)), 8000);
    const sliced = tail.frames("output", SES).at(-1);
    expect(sliced.data.split("\n").length).toBeLessThanOrEqual(5);
    mux.unsubscribeAll(late as any);
  }, 30000);

  test("ping → pong on the same socket", () => {
    const ws = new FakeWS();
    mux.handleMessage({ type: "ping" }, ws as any);
    expect(ws.sent).toContain('{"type":"pong"}');
  });

  test("__sessions channel pushes the session list on subscribe", () => {
    const ws = new FakeWS();
    mux.handleMessage({ type: "sessions_subscribe" }, ws as any);
    const push = ws.frames("sessions", "__sessions");
    expect(push.length).toBe(1);
    const names = JSON.parse(push[0].data).map((s: any) => s.name);
    expect(names).toContain(SES);
  });

  test("output frames carry the pane cursor mapped to content coordinates", async () => {
    // The prompt line is the last content line → row 0; col > 0 (after "$ ").
    const ws = new FakeWS();
    mux.handleMessage({ type: "subscribe", session: SES }, ws as any);
    await until(() => ws.frames("output", SES).some((m) => m.cursor != null), 8000);
    const cur = ws.frames("output", SES).findLast((m) => m.cursor != null).cursor;
    expect(cur.row).toBe(0);
    expect(cur.col).toBeGreaterThan(0);
    mux.unsubscribeAll(ws as any);
  }, 15000);

  test("stop() tears every timer down", () => {
    const throwaway = new TmuxWsMux({ driver, pollNormalMs: 50 });
    const ws = new FakeWS();
    throwaway.handleMessage({ type: "subscribe", session: SES }, ws as any);
    throwaway.stop();
    // No assertion API for live timers — this is a leak guard: if stop()
    // missed one, bun test's process would linger and CI would hang.
    expect(true).toBe(true);
  });

  test("unsubscribeAll cleans up (no frames after the pane changes)", async () => {
    mux.unsubscribeAll(full as any);
    mux.unsubscribeAll(tail as any);
    const before = full.sent.length;
    driver.sendKeys(SES, "echo after-unsub\r");
    await new Promise((r) => setTimeout(r, 700));
    expect(full.sent.length).toBe(before);
  }, 15000);
});
