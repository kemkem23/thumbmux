import { afterEach, describe, expect, test } from "bun:test";
import {
  createBunTmuxDriver,
  killTmuxSession,
  spawnTmuxSession,
} from "../src/bun-driver";

let sequence = 0;
const sessions = new Set<string>();

function uniqueSessionName(label: string): string {
  sequence += 1;
  return `thumbmux-target-${label}-${process.pid}-${Date.now()}-${sequence}`;
}

function runTmux(args: string[]): string {
  const process = Bun.spawnSync(["tmux", ...args]);
  if (process.exitCode !== 0) {
    throw new Error(process.stderr.toString().trim() || `tmux ${args[0]} failed`);
  }
  return process.stdout.toString();
}

function createSession(name: string): void {
  runTmux([
    "new-session",
    "-d",
    "-s",
    name,
    "tmux display-message -p '#{session_name}'; exec sleep 30",
  ]);
  sessions.add(name);
}

function killExactly(name: string): void {
  const process = Bun.spawnSync(["tmux", "kill-session", "-t", `=${name}`]);
  if (process.exitCode === 0) sessions.delete(name);
}

function hasSession(name: string): boolean {
  return Bun.spawnSync(["tmux", "has-session", "-t", `=${name}`]).exitCode === 0;
}

async function captureUntil(name: string, expected: string): Promise<string> {
  const driver = createBunTmuxDriver();
  let content = "";
  for (let attempt = 0; attempt < 40; attempt += 1) {
    content = await driver.capturePane(name, { currentPaneOnly: true });
    if (content.includes(expected)) return content;
    await Bun.sleep(25);
  }
  return content;
}

afterEach(() => {
  for (const name of [...sessions]) killExactly(name);
});

describe("Bun tmux driver target resolution", () => {
  test("a dead exact session cannot fall through to a live prefix sibling", async () => {
    const name = uniqueSessionName("dead");
    const sibling = `${name}-2`;
    createSession(name);
    createSession(sibling);

    // The sibling pane identifies itself using tmux's own session_name value.
    expect(await captureUntil(sibling, sibling)).toContain(sibling);
    killExactly(name);

    const driver = createBunTmuxDriver();
    await expect(driver.capturePane(name, { currentPaneOnly: true }))
      .rejects.toThrow(`capture-pane failed for ${name}`);
  });

  test("killTmuxSession refuses a dead exact name and preserves its prefix sibling", async () => {
    const name = uniqueSessionName("kill-dead");
    const sibling = `${name}-2`;
    createSession(name);
    createSession(sibling);
    killExactly(name);

    expect(() => killTmuxSession(name)).toThrow();
    expect(hasSession(sibling)).toBe(true);
    expect(await captureUntil(sibling, sibling)).toContain(sibling);
  });

  test("spawn, capture, and kill preserve a session name that begins with equals", async () => {
    const name = `=${uniqueSessionName("leading-equals")}`;
    // Track first because spawn creates the session before delivering command text.
    sessions.add(name);
    spawnTmuxSession(name, "/tmp", "tmux display-message -p '#{session_name}'");

    expect(await captureUntil(name, name)).toContain(name);
    killTmuxSession(name);
    expect(hasSession(name)).toBe(false);
    sessions.delete(name);
  });

  test("legacy target mode remains an explicit opt-out for prefix users", async () => {
    const name = uniqueSessionName("legacy");
    const sibling = `${name}-2`;
    createSession(name);
    createSession(sibling);
    killExactly(name);

    const legacyDriver = createBunTmuxDriver({ targetMode: "legacy" });
    expect(await legacyDriver.capturePane(name, { currentPaneOnly: true })).toContain(sibling);
    expect(() => killTmuxSession(name, { targetMode: "legacy" })).not.toThrow();
    expect(hasSession(sibling)).toBe(false);
    sessions.delete(sibling);
  });
});
