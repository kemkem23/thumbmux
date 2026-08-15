import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DurableHistoryArchive } from "../src/durable-history-archive";
import { TmuxWsMux, type TmuxDriver } from "../src/ws-mux";

/**
 * Every other retention test uses a fake driver, and the defect that motivated
 * this whole release survived a fake-driver suite for months: the reconciliation
 * tolerated two repainted rows while real agents repaint five to eight, so 96%
 * of genuine scrolls archived nothing. Only a real terminal can catch that class
 * of mistake, so this one drives tmux.
 *
 * Private socket and an `sh-` prefixed name: this must never be able to touch a
 * host's agent sessions.
 */

const SOCKET = join(tmpdir(), `thumbmux-retention-${process.pid}.sock`);
const SESSION = "sh-retention-probe";
const PANE_ROWS = 24;
const tmux = (...args: string[]) => Bun.spawnSync(["tmux", "-S", SOCKET, ...args]);

afterEach(() => {
  tmux("kill-session", "-t", `=${SESSION}`);
});

test("a session nobody is watching keeps every line it produced", async () => {
  const root = mkdtempSync(join(tmpdir(), "thumbmux-live-"));
  try {
    tmux("new-session", "-d", "-s", SESSION, "-x", "120", "-y", String(PANE_ROWS), "bash", "--noprofile", "--norc");
    await Bun.sleep(500);
    tmux("send-keys", "-t", `=${SESSION}:0.0`, "PS1='$ '", "Enter");
    await Bun.sleep(400);

    const driver: TmuxDriver = {
      listSessions: () => [{ name: SESSION, paneRows: PANE_ROWS }] as never,
      capturePane: async (_session, opts) => {
        const start = opts.startLine ?? -1_000;
        return tmux("capture-pane", "-t", `=${SESSION}:0.0`, "-p", "-e", "-S", String(start))
          .stdout.toString();
      },
      sendKeys: () => {},
      getSessionActivity: () => new Map([[SESSION, Date.now()]]),
      getHistoryLimit: () => 50_000,
      setSessionHistoryLimit: () => {},
      resizeWindow: () => {},
      hash: (content) => content,
    };
    const archive = new DurableHistoryArchive({ root, group: () => "probe" });
    const mux = new TmuxWsMux({
      driver,
      archive,
      liveLineLimit: 200,
      retention: { enabled: true, intervalMs: 50 },
    });
    mux.retainSession(SESSION);

    await mux.runRetentionTickForTests();
    for (let batch = 0; batch < 3; batch++) {
      const from = batch * 400 + 1;
      tmux("send-keys", "-t", `=${SESSION}:0.0`, `for i in $(seq ${from} ${from + 399}); do echo "N $i"; done`, "Enter");
      await Bun.sleep(2_500);
      await mux.runRetentionTickForTests();
    }
    mux.stop();

    // Everything the archive holds, including the rows the viewer would still
    // be shown live — durability and display are separate questions now.
    const stored: string[] = [];
    let before: number | null = null;
    for (;;) {
      const page = archive.readBefore(SESSION, before, 2_000);
      if (page.lines.length === 0 || page.startLine === null) break;
      stored.unshift(...page.lines);
      if (!page.hasMore) break;
      before = page.startLine;
    }
    const liveStart = archive.liveStartLine(SESSION) ?? 0;
    // `readBefore` deliberately stops at the live boundary, so the rows the
    // viewer would still be showing come from the pane — the same two sources a
    // real client stitches together.
    const liveRows = tmux("capture-pane", "-t", `=${SESSION}:0.0`, "-p", "-S", String(-2_000))
      .stdout.toString().split("\n");

    const seen = new Set<number>();
    for (const line of [...stored, ...liveRows]) {
      const match = /^N (\d+)\s*$/.exec(line.replace(/\x1b\[[0-9;]*m/g, "").trim());
      if (match) seen.add(Number(match[1]));
    }

    expect(liveStart).toBeGreaterThan(0);
    expect(seen.size).toBe(1_200);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);
