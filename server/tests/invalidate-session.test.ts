import { afterEach, describe, expect, test } from "bun:test";
import type { SessionListItem } from "../../core/src/protocol";
import {
  TmuxWsMux,
  createBunTmuxDriver,
  killTmuxSession,
  spawnTmuxSession,
  type HistoryArchiveLike,
  type TmuxDriver,
} from "../src";

let sequence = 0;
const liveSessions = new Set<string>();

function uniqueSessionName(label: string): string {
  sequence += 1;
  return `thumbmux-invalidate-${label}-${process.pid}-${Date.now()}-${sequence}`;
}

function sessionListItem(name: string): SessionListItem {
  return { name, created: "0", windows: 1, attached: false, activityAt: 0 };
}

class FakeWS {
  sent: string[] = [];
  sendStatus: unknown = undefined;

  send(data: string) {
    this.sent.push(data);
    return this.sendStatus;
  }

  frames(type?: string, channel?: string) {
    return this.sent.map((data) => JSON.parse(data)).filter((frame) =>
      (!type || frame.type === type) && (!channel || frame.channel === channel));
  }
}

async function until(predicate: () => boolean, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(10);
  }
  throw new Error("condition not met before timeout");
}

function killOnlyPane(session: string): void {
  const process = Bun.spawnSync(["tmux", "kill-pane", "-t", `=${session}:`]);
  if (process.exitCode !== 0) {
    throw new Error(process.stderr.toString().trim() || `tmux kill-pane failed for ${session}`);
  }
  liveSessions.delete(session);
}

function fakeDriver(
  session: string,
  capturePane: TmuxDriver["capturePane"],
): TmuxDriver {
  return {
    listSessions: () => [sessionListItem(session)],
    capturePane,
    sendKeys: () => {},
    getSessionActivity: () => new Map([[session, Date.now()]]),
    getHistoryLimit: () => 2_000,
    setSessionHistoryLimit: () => {},
    resizeWindow: () => {},
    hash: (content) => content,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  for (const session of [...liveSessions]) {
    try { killTmuxSession(session); } catch { /* already gone */ }
    liveSessions.delete(session);
  }
});

describe("session invalidation", () => {
  test("a killed real pane stops generating capture attempts and error frames after invalidation", async () => {
    const session = uniqueSessionName("real");
    spawnTmuxSession(session, "/tmp");
    liveSessions.add(session);

    const reference = createBunTmuxDriver();
    let captureAttempts = 0;
    const driver: TmuxDriver = {
      ...reference,
      captureWithCursor: async (name, opts) => {
        captureAttempts += 1;
        return reference.captureWithCursor!(name, opts);
      },
    };
    const mux = new TmuxWsMux({
      driver,
      profile: () => ({ resize: true, currentPaneOnly: false, archive: false }),
      pollNormalMs: 35,
      pollReconcileMs: 35,
    });
    const first = new FakeWS();
    const second = new FakeWS();

    try {
      mux.subscribe(session, first);
      mux.subscribe(session, first); // Set de-duplicates one socket into one viewer.
      mux.subscribe(session, second);
      await until(() => first.frames("output", session).length > 0
        && second.frames("output", session).length > 0);
      await until(() => !(mux as any).queuedCapturesInFlight.has(session));

      killOnlyPane(session);
      const deadStartCaptures = captureAttempts;
      const deadStartErrors = first.frames("error", session).length;
      await until(() => captureAttempts - deadStartCaptures >= 2
        && first.frames("error", session).length - deadStartErrors >= 2);
      const deadMiddleCaptures = captureAttempts;
      const deadMiddleErrors = first.frames("error", session).length;
      await until(() => captureAttempts - deadMiddleCaptures >= 2
        && first.frames("error", session).length - deadMiddleErrors >= 2);

      const beforeInvalidateCaptures = captureAttempts;
      const beforeInvalidateErrors = first.frames("error", session).length;
      const secondBeforeInvalidateErrors = second.frames("error", session).length;
      const affected = mux.invalidateSession(session);
      const afterCallCaptures = captureAttempts;
      const afterCallErrors = first.frames("error", session).length;
      const secondAfterCallErrors = second.frames("error", session).length;
      await Bun.sleep(220);
      const afterWaitCaptures = captureAttempts;
      const afterWaitErrors = first.frames("error", session).length;

      const measurements = {
        firstDeadWindowCaptures: deadMiddleCaptures - deadStartCaptures,
        firstDeadWindowErrors: deadMiddleErrors - deadStartErrors,
        secondDeadWindowCaptures: beforeInvalidateCaptures - deadMiddleCaptures,
        secondDeadWindowErrors: beforeInvalidateErrors - deadMiddleErrors,
        affected,
        firstTerminalSignals: afterCallErrors - beforeInvalidateErrors,
        secondTerminalSignals: secondAfterCallErrors - secondBeforeInvalidateErrors,
        capturesAfterReturn: afterWaitCaptures - afterCallCaptures,
        errorsAfterReturn: afterWaitErrors - afterCallErrors,
      };
      console.info(`[c5-real-tmux] ${JSON.stringify(measurements)}`);

      expect(measurements.firstDeadWindowCaptures).toBeGreaterThanOrEqual(2);
      expect(measurements.firstDeadWindowErrors).toBeGreaterThanOrEqual(2);
      expect(measurements.secondDeadWindowCaptures).toBeGreaterThanOrEqual(2);
      expect(measurements.secondDeadWindowErrors).toBeGreaterThanOrEqual(2);
      expect(measurements.affected).toBe(2);
      expect(measurements.firstTerminalSignals).toBe(1);
      expect(measurements.secondTerminalSignals).toBe(1);
      expect(first.frames("error", session).at(-1)?.data.length).toBeGreaterThan(0);
      expect(second.frames("error", session).at(-1)?.data.length).toBeGreaterThan(0);
      expect(measurements.capturesAfterReturn).toBe(0);
      expect(measurements.errorsAfterReturn).toBe(0);
      expect((mux as any).subscribers.has(session)).toBe(false);
    } finally {
      mux.stop();
    }
  }, 15_000);

  test("an old in-flight capture cannot cross into a replacement lifecycle", async () => {
    const session = "invalidate-in-flight";
    const oldCapture = deferred<string>();
    const replacementCapture = deferred<string>();
    let captureAttempts = 0;
    const driver = fakeDriver(session, async () => {
      captureAttempts += 1;
      if (captureAttempts === 1) return oldCapture.promise;
      if (captureAttempts === 2) return replacementCapture.promise;
      return "fresh lifecycle";
    });
    const mux = new TmuxWsMux({ driver, pollNormalMs: 60_000 });
    const oldViewer = new FakeWS();
    const replacementViewer = new FakeWS();
    const lateViewer = new FakeWS();

    try {
      mux.subscribe(session, oldViewer);
      await until(() => captureAttempts === 1);

      const affected = mux.invalidateSession(session);
      mux.subscribe(session, replacementViewer);
      await Bun.sleep(20);
      const replacementStartedBeforeOldSettled = captureAttempts === 2;

      oldCapture.resolve("stale lifecycle");
      await Bun.sleep(20);
      mux.subscribe(session, lateViewer);
      await Bun.sleep(20);
      const oldFinallyPreservedReplacementLane = captureAttempts === 2;

      replacementCapture.resolve("fresh lifecycle");
      await until(() => replacementViewer.frames("output", session).length > 0
        && lateViewer.frames("output", session).length > 0);
      await until(() => captureAttempts >= 3);

      expect(affected).toBe(1);
      expect(replacementStartedBeforeOldSettled).toBe(true);
      expect(oldFinallyPreservedReplacementLane).toBe(true);
      expect(oldViewer.frames("output", session)).toHaveLength(0);
      expect(oldViewer.frames("error", session)).toHaveLength(1);
      expect(oldViewer.frames("error", session)[0]?.data.length).toBeGreaterThan(0);
      expect(replacementViewer.frames("output", session)).toHaveLength(1);
      expect(lateViewer.frames("output", session)).toHaveLength(1);
      expect((mux as any).contents.has(session)).toBe(true);
    } finally {
      oldCapture.reject(new Error("test cleanup"));
      replacementCapture.reject(new Error("test cleanup"));
      mux.stop();
    }
  });

  test("a late rejected capture cannot add another error to either lifecycle", async () => {
    const session = "invalidate-rejected-capture";
    const oldCapture = deferred<string>();
    let captureAttempts = 0;
    const driver = fakeDriver(session, async () => {
      captureAttempts += 1;
      if (captureAttempts === 1) return oldCapture.promise;
      return "replacement output";
    });
    const mux = new TmuxWsMux({ driver, pollNormalMs: 60_000 });
    const oldViewer = new FakeWS();
    const replacementViewer = new FakeWS();

    try {
      mux.subscribe(session, oldViewer);
      await until(() => captureAttempts === 1);
      const oldErrorsBefore = oldViewer.frames("error", session).length;
      expect(mux.invalidateSession(session)).toBe(1);
      const oldErrorsAfterSignal = oldViewer.frames("error", session).length;

      mux.subscribe(session, replacementViewer);
      await until(() => replacementViewer.frames("output", session).length > 0);
      const replacementErrorsBeforeReject = replacementViewer.frames("error", session).length;
      oldCapture.reject(new Error("old capture failed"));
      await Bun.sleep(20);

      expect(oldErrorsAfterSignal - oldErrorsBefore).toBe(1);
      expect(oldViewer.frames("error", session).length - oldErrorsAfterSignal).toBe(0);
      expect(replacementViewer.frames("error", session).length - replacementErrorsBeforeReject).toBe(0);
      expect(replacementViewer.frames("output", session)).toHaveLength(1);
    } finally {
      oldCapture.reject(new Error("test cleanup"));
      mux.stop();
    }
  });

  test("renaming a queued lifecycle cannot strand the old capture lane", async () => {
    const oldSession = "rename-capture-owner-old";
    const newSession = "rename-capture-owner-new";
    const oldCapture = deferred<string>();
    const attempts: Array<{ session: string; startLine?: number }> = [];
    const driver = fakeDriver(oldSession, async (session, opts) => {
      attempts.push({ session, startLine: opts.startLine });
      if (session === oldSession && attempts.filter((attempt) => attempt.session === oldSession).length === 1) {
        return oldCapture.promise;
      }
      return `${session} fresh`;
    });
    const mux = new TmuxWsMux({ driver, pollNormalMs: 60_000 });
    const first = new FakeWS();
    const reused = new FakeWS();

    try {
      mux.subscribe(oldSession, first);
      await until(() => attempts.length === 1);
      (mux as any).queueCapture(oldSession); // queues a normal successor behind the full-history bootstrap
      expect((mux as any).queuedCapturesPending.has(oldSession)).toBe(true);
      expect((mux as any).queuedCapturesInFlight.has(oldSession)).toBe(true);

      mux.handleSessionRename(oldSession, newSession);
      await until(() => attempts.some((attempt) => attempt.session === newSession));
      const initialStartLine = attempts[0]?.startLine;
      const renamedStartLine = attempts.find((attempt) => attempt.session === newSession)?.startLine;
      oldCapture.resolve("renamed stale capture");
      await Bun.sleep(20);

      mux.subscribe(oldSession, reused);
      await Bun.sleep(20);
      const oldAttempts = attempts.filter((attempt) => attempt.session === oldSession).length;

      expect((mux as any).queuedCapturesInFlight.has(oldSession)).toBe(false);
      expect(renamedStartLine).toBe(initialStartLine);
      expect(oldAttempts).toBe(2);
      expect(reused.frames("output", oldSession)).toHaveLength(1);
    } finally {
      oldCapture.reject(new Error("test cleanup"));
      mux.stop();
    }
  });

  test("round-trip rename cannot make the original capture owner current again", async () => {
    const firstName = "rename-round-trip-a";
    const secondName = "rename-round-trip-b";
    const firstCapture = deferred<string>();
    let captureAttempts = 0;
    const driver = fakeDriver(firstName, async () => {
      captureAttempts += 1;
      if (captureAttempts === 1) return firstCapture.promise;
      return `capture-${captureAttempts}`;
    });
    const mux = new TmuxWsMux({ driver, pollNormalMs: 60_000 });
    const ws = new FakeWS();

    try {
      mux.subscribe(firstName, ws);
      await until(() => captureAttempts === 1);
      mux.handleSessionRename(firstName, secondName);
      await until(() => ws.frames("output", secondName).length > 0);
      mux.handleSessionRename(secondName, firstName);
      await until(() => ws.frames("output", firstName).length > 0);

      const outputsBeforeOldSettled = ws.frames("output", firstName).length;
      const attemptsBeforeOldSettled = captureAttempts;
      firstCapture.resolve("stale before both renames");
      await Bun.sleep(20);

      expect(ws.frames("output", firstName).length - outputsBeforeOldSettled).toBe(0);
      expect(captureAttempts - attemptsBeforeOldSettled).toBe(0);
    } finally {
      firstCapture.reject(new Error("test cleanup"));
      mux.stop();
    }
  });

  test("late callbacks from an invalidated pipe cannot affect its replacement", async () => {
    const session = "invalidate-pipe-callbacks";
    const callbacks: Array<{
      onData(data: string): void;
      onBroken(): void;
      onRestarted(): void;
    }> = [];
    let captureAttempts = 0;
    const pipes = {
      startPipe: (
        _session: string,
        onData: (data: string) => void,
        onBroken: () => void,
        onRestarted: () => void,
      ) => {
        callbacks.push({ onData, onBroken, onRestarted });
        return true;
      },
      stopPipe: () => {},
      handleRename: () => {},
    };
    const mux = new TmuxWsMux({
      driver: fakeDriver(session, async () => {
        captureAttempts += 1;
        return `capture-${captureAttempts}`;
      }),
      pipes,
      pollNormalMs: 60_000,
    });
    const oldViewer = new FakeWS();
    const replacementViewer = new FakeWS();

    try {
      mux.subscribe(session, oldViewer);
      await until(() => callbacks.length === 1 && oldViewer.frames("output", session).length > 0);
      expect(mux.invalidateSession(session)).toBe(1);
      callbacks[0]!.onRestarted();

      mux.subscribe(session, replacementViewer);
      await until(() => replacementViewer.frames("output", session).length > 0);
      const capturesBeforeOldCallbacks = captureAttempts;
      callbacks[0]!.onBroken();
      callbacks[0]!.onData("dirty");
      await Bun.sleep(120);

      expect(callbacks).toHaveLength(2);
      expect((mux as any).piped.has(session)).toBe(true);
      expect(captureAttempts - capturesBeforeOldCallbacks).toBe(0);
    } finally {
      mux.stop();
    }
  });

  test("a throwing pipe stop cannot suppress teardown or the final signal", async () => {
    const session = "invalidate-throwing-pipe";
    let stopCalls = 0;
    const pipes = {
      startPipe: () => true,
      stopPipe: () => {
        stopCalls += 1;
        throw new Error("stop failed");
      },
      handleRename: () => {},
    };
    const mux = new TmuxWsMux({
      driver: fakeDriver(session, async () => "output"),
      pipes,
      pollNormalMs: 60_000,
      logError: () => {},
    });
    const ws = new FakeWS();

    try {
      mux.subscribe(session, ws);
      await until(() => ws.frames("output", session).length > 0);
      const errorsBefore = ws.frames("error", session).length;
      let affected: number | undefined;
      let threw = false;
      try {
        affected = mux.invalidateSession(session);
      } catch {
        threw = true;
      }

      expect(threw).toBe(false);
      expect(affected).toBe(1);
      expect(stopCalls).toBe(1);
      expect(ws.frames("error", session).length - errorsBefore).toBe(1);
      expect((mux as any).piped.has(session)).toBe(false);
    } finally {
      try { mux.stop(); } catch { /* pre-fix cleanup */ }
    }
  });

  test("a throwing logger cannot suppress the final signal or return value", async () => {
    const session = "invalidate-throwing-log";
    let throwFromLog = false;
    const mux = new TmuxWsMux({
      driver: fakeDriver(session, async () => "output"),
      pollNormalMs: 60_000,
      log: () => {
        if (throwFromLog) throw new Error("log failed");
      },
    });
    const ws = new FakeWS();

    try {
      mux.subscribe(session, ws);
      await until(() => ws.frames("output", session).length > 0);
      const errorsBefore = ws.frames("error", session).length;
      throwFromLog = true;
      let affected: number | undefined;
      let threw = false;
      try {
        affected = mux.invalidateSession(session);
      } catch {
        threw = true;
      }

      expect(threw).toBe(false);
      expect(affected).toBe(1);
      expect(ws.frames("error", session).length - errorsBefore).toBe(1);
      expect((mux as any).interval).toBeNull();
    } finally {
      throwFromLog = false;
      mux.stop();
    }
  });

  test("a queued final signal preserves socket backpressure state", async () => {
    const session = "invalidate-backpressure";
    const mux = new TmuxWsMux({
      driver: fakeDriver(session, async () => "output"),
      pollNormalMs: 60_000,
    });
    const ws = new FakeWS();

    try {
      mux.subscribe(session, ws);
      await until(() => ws.frames("output", session).length > 0);
      ws.sendStatus = -1;
      const errorsBefore = ws.frames("error", session).length;

      expect(mux.invalidateSession(session)).toBe(1);
      expect(ws.frames("error", session).length - errorsBefore).toBe(1);
      expect(mux.isBackpressured(ws)).toBe(true);
    } finally {
      mux.stop();
    }
  });

  test("archive purge is opt-in and a purge failure cannot prevent teardown", async () => {
    const session = "invalidate-archive";
    let dropCalls = 0;
    let failDrop = false;
    const archive: HistoryArchiveLike = {
      ingestSnapshot: (_session, content) => ({ liveContent: content }),
      readBefore: () => ({ lines: [], startLine: null, hasMore: false }),
      renameSession: () => {},
      dropSession: () => {
        dropCalls += 1;
        if (failDrop) throw new Error("purge failed");
      },
    };
    const mux = new TmuxWsMux({
      driver: fakeDriver(session, async () => "content"),
      archive,
      pollNormalMs: 60_000,
      logError: () => {},
    });
    const ws = new FakeWS();

    try {
      mux.subscribe(session, ws);
      await until(() => ws.frames("output", session).length > 0);
      expect(mux.invalidateSession(session)).toBe(1);
      expect(dropCalls).toBe(0);

      mux.subscribe(session, ws);
      await until(() => (mux as any).queuedCapturesInFlight.has(session) === false);
      failDrop = true;
      const errorsBeforePurge = ws.frames("error", session).length;
      expect(() => mux.invalidateSession(session, { purgeArchive: true })).not.toThrow();
      expect(dropCalls).toBe(1);
      expect((mux as any).subscribers.has(session)).toBe(false);
      expect(ws.frames("error", session).length - errorsBeforePurge).toBe(1);
    } finally {
      mux.stop();
    }
  });
});
