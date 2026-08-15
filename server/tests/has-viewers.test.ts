import { expect, test } from "bun:test";
import { TmuxWsMux, type TmuxDriver } from "../src/ws-mux";

class FakeWS {
  sent: string[] = [];
  send(data: string): void { this.sent.push(data); }
}

function fakeDriver(): TmuxDriver {
  return {
    listSessions: () => [{ name: "s", windows: 1, attached: false }],
    capturePane: async () => "hello\n",
    sendKeys: () => {},
    getSessionActivity: () => new Map(),
    getHistoryLimit: () => 2_000,
    setSessionHistoryLimit: () => {},
    resizeWindow: () => {},
    hash: (content) => content,
  };
}

/**
 * These pin the contract `RetentionLane` depends on: the lane skips a session
 * the viewer path is already archiving, so a wrong answer here means either two
 * writers on one archive (false) or a session that silently stops being
 * retained while a stale socket is remembered (true).
 */

test("a session nobody subscribed to has no viewers", () => {
  const mux = new TmuxWsMux<FakeWS>({ driver: fakeDriver() });
  expect(mux.hasViewers("s")).toBe(false);
  expect(mux.hasViewers("never-heard-of-it")).toBe(false);
  mux.stop();
});

test("subscribing makes it true, and asking does not create the channel", () => {
  const mux = new TmuxWsMux<FakeWS>({ driver: fakeDriver() });
  const ws = new FakeWS();

  expect(mux.hasViewers("s")).toBe(false);
  mux.handleMessage({ type: "subscribe", session: "s" }, ws);
  expect(mux.hasViewers("s")).toBe(true);

  // Asking about an unknown session must not register it as one being watched.
  expect(mux.hasViewers("other")).toBe(false);
  expect(mux.hasViewers("other")).toBe(false);
  mux.stop();
});

test("the last unsubscribe takes it back to false", () => {
  const mux = new TmuxWsMux<FakeWS>({ driver: fakeDriver() });
  const first = new FakeWS();
  const second = new FakeWS();

  mux.handleMessage({ type: "subscribe", session: "s" }, first);
  mux.handleMessage({ type: "subscribe", session: "s" }, second);
  expect(mux.hasViewers("s")).toBe(true);

  mux.handleMessage({ type: "unsubscribe", session: "s" }, first);
  expect(mux.hasViewers("s")).toBe(true);   // second is still watching

  mux.handleMessage({ type: "unsubscribe", session: "s" }, second);
  expect(mux.hasViewers("s")).toBe(false);
  mux.stop();
});

test("a socket closing releases its sessions", () => {
  const mux = new TmuxWsMux<FakeWS>({ driver: fakeDriver() });
  const ws = new FakeWS();

  mux.handleMessage({ type: "subscribe", session: "s" }, ws);
  expect(mux.hasViewers("s")).toBe(true);

  mux.unsubscribeAll(ws);
  expect(mux.hasViewers("s")).toBe(false);
  mux.stop();
});
