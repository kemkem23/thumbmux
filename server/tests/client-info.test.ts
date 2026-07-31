import { expect, test } from "bun:test";
import { TmuxWsMux, type TmuxDriver } from "../src/ws-mux";

class FakeWS {
  sent: string[] = [];

  send(data: string): void {
    this.sent.push(data);
  }
}

function fakeDriver(): TmuxDriver {
  return {
    listSessions: () => [],
    capturePane: async () => "",
    sendKeys: () => {},
    getSessionActivity: () => new Map(),
    getHistoryLimit: () => 2_000,
    setSessionHistoryLimit: () => {},
    resizeWindow: () => {},
    hash: (content) => content,
  };
}

test("standalone client_info reaches the host hook with its socket descriptor", () => {
  const calls: Array<{ ws: FakeWS; client: unknown }> = [];
  const mux = new TmuxWsMux<FakeWS>({
    driver: fakeDriver(),
    hooks: {
      onClientInfo: (ws, client) => calls.push({ ws, client }),
    },
  });
  const ws = new FakeWS();
  const client = {
    visibilityState: "hidden",
    uxClientId: "client-7",
    viewport: { width: 390, height: 844 },
  };

  mux.handleMessage({ type: "client_info", client }, ws);

  expect(calls).toHaveLength(1);
  expect(calls[0]?.ws).toBe(ws);
  expect(calls[0]?.client).toBe(client);
  mux.stop();
});
