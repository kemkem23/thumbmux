import type { SessionListItem, SessionListRow } from "@thumbmux/core";
import {
  TmuxWsMux,
  type MuxHooks,
  type TmuxDriver,
  type WsLike,
} from "../src/ws-mux";
import { createBunTmuxDriver } from "../src/bun-driver";
import {
  createSpawnHandler,
  type SpawnHandlerOptions,
} from "../src/spawn-handler";

interface HostSessionRow {
  name: string;
  owner: string;
  created: number;
}

interface HostSocket extends WsLike {
  principal: string;
}

interface HostSpawnRow {
  name: string;
  owner: string;
}

const hostRow: HostSessionRow = {
  name: "agent",
  owner: "kem",
  created: 1_722_400_000,
};
const hostRows: HostSessionRow[] = [hostRow];

const sharedDriverMethods = {
  async capturePane() {
    return "";
  },
  sendKeys() {},
  getSessionActivity() {
    return new Map<string, number>();
  },
  getHistoryLimit() {
    return 2_000;
  },
  setSessionHistoryLimit() {},
  resizeWindow() {},
  hash(content: string) {
    return content;
  },
};

// A host-declared interface with only real host fields must satisfy every
// session-list entry point without an index signature, casts, or fake tmux
// data. Its host-owned numeric `created` field also proves the generic is
// constrained only by the minimum row rather than tmux's richer field types.
const minimumRow: SessionListRow = hostRow;
const hostDriver: TmuxDriver<HostSessionRow> = {
  ...sharedDriverMethods,
  listSessions: () => hostRows,
};
const hostHooks: MuxHooks<HostSocket, HostSessionRow> = {
  filterSessionList: (sessions, ws) =>
    sessions.filter((session) => session.owner === ws.principal),
};
const hostMux = new TmuxWsMux<HostSocket, HostSessionRow>({
  driver: hostDriver,
  hooks: hostHooks,
});
hostMux.setSessionListProvider(() => hostRows);

// createSpawnHandler only reads `name`, so a host driver with no stock tmux
// fields must infer its row type without an explicit generic argument.
const hostSpawnDriver: Pick<TmuxDriver<HostSpawnRow>, "listSessions"> = {
  listSessions: () => [{ name: "agent", owner: "kem" }],
};
const hostSpawnHandler = createSpawnHandler({ driver: hostSpawnDriver });

// Existing complete object literals and the bundled driver remain assignable,
// with all stock fields still required and readable on SessionListItem.
const completeDriver: TmuxDriver = {
  ...sharedDriverMethods,
  listSessions: () => [{
    name: "stock",
    created: "0",
    windows: 1,
    attached: false,
    activityAt: 0,
  }],
};
const bundledDriver: TmuxDriver = createBunTmuxDriver();
const stockActivities: number[] = completeDriver.listSessions()
  .map((row: SessionListItem) => row.activityAt);
const defaultSpawnOptions: SpawnHandlerOptions = { driver: completeDriver };
const defaultSpawnActivities: number[] = defaultSpawnOptions.driver!
  .listSessions()
  .map((row) => row.activityAt);
const defaultSpawnHandler = createSpawnHandler(defaultSpawnOptions);
const noOptionsSpawnHandler = createSpawnHandler();

void minimumRow;
void hostMux;
void completeDriver;
void bundledDriver;
void stockActivities;
void defaultSpawnActivities;
void hostSpawnHandler;
void defaultSpawnHandler;
void noOptionsSpawnHandler;
