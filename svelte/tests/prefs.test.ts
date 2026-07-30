import { afterEach, describe, expect, test } from "bun:test";
import {
  DEFAULT_SHORTCUTS,
  mergePrefs,
  type ThumbmuxPrefs,
} from "@thumbmux/core";

import { createLocalPrefs, createServerPrefs } from "../src/prefs.svelte";

type FetchCall = {
  input: string | URL | Request;
  init?: RequestInit;
};

type Deferred<T> = {
  promise: Promise<T>;
  resolve(value: T): void;
};

const realStorage = globalThis.localStorage;
const originalStorageDescriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
const originalFetchDescriptor = Object.getOwnPropertyDescriptor(globalThis, "fetch");
const cacheKeys = new Set<string>();
let cacheSequence = 0;

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function cacheKey(label: string): string {
  const key = `thumbmux-w4-t6-${label}-${++cacheSequence}`;
  cacheKeys.add(key);
  return key;
}

function seedCache(key: string): ThumbmuxPrefs {
  realStorage.setItem(key, JSON.stringify({
    fontPx: 13,
    shortcuts: DEFAULT_SHORTCUTS.map((shortcut) => ({ ...shortcut })),
    cacheRevision: cacheSequence,
  }));
  return readStoredPrefs(key);
}

function readStoredPrefs(key: string): ThumbmuxPrefs {
  const raw = realStorage.getItem(key);
  if (raw === null) throw new Error(`missing test cache ${key}`);
  return JSON.parse(raw) as ThumbmuxPrefs;
}

function restoreGlobal(
  key: "fetch" | "localStorage",
  descriptor: PropertyDescriptor | undefined,
): void {
  if (descriptor) Object.defineProperty(globalThis, key, descriptor);
  else Reflect.deleteProperty(globalThis, key);
}

/**
 * createServerPrefs refreshes GET in a detached `.then(...).catch(...)` chain.
 * This fetch thenable observes that exact continuation and resolves `done` only
 * after response parsing and cache/subscriber updates have finished.
 */
function trackedBackgroundFetch(
  handler: (input: string | URL | Request, init?: RequestInit) => Response | Promise<Response>,
): { fetchFn: typeof fetch; calls: FetchCall[]; done: Promise<void> } {
  const calls: FetchCall[] = [];
  const completed = deferred<void>();

  const fetchFn = ((input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({ input, init });
    const source = Promise.resolve().then(() => handler(input, init));
    const thenable = {
      then(
        onFulfilled?: ((response: Response) => unknown) | null,
        onRejected?: ((reason: unknown) => unknown) | null,
      ): Promise<unknown> {
        const chain = source.then(onFulfilled ?? undefined, onRejected ?? undefined);
        void chain.then(
          () => completed.resolve(),
          () => completed.resolve(),
        );
        return chain;
      },
    };
    return thenable as unknown as Promise<Response>;
  }) as typeof fetch;

  return { fetchFn, calls, done: completed.promise };
}

function trackedContinuation<T>(source: Promise<T>): { promise: Promise<T>; done: Promise<void> } {
  const completed = deferred<void>();
  const thenable = {
    then(
      onFulfilled?: ((value: T) => unknown) | null,
      onRejected?: ((reason: unknown) => unknown) | null,
    ): Promise<unknown> {
      const chain = source.then(onFulfilled ?? undefined, onRejected ?? undefined);
      void chain.then(
        () => completed.resolve(),
        () => completed.resolve(),
      );
      return chain;
    },
  };
  return {
    promise: thenable as unknown as Promise<T>,
    done: completed.promise,
  };
}

afterEach(() => {
  restoreGlobal("fetch", originalFetchDescriptor);
  restoreGlobal("localStorage", originalStorageDescriptor);
  for (const key of cacheKeys) realStorage.removeItem(key);
  cacheKeys.clear();
});

describe("createServerPrefs", () => {
  test("refreshes cached preferences with the successful server snapshot", async () => {
    const key = cacheKey("success");
    const cached = seedCache(key);
    const response = Response.json(mergePrefs(cached, {
      fontPx: Number(cached.fontPx) + 4,
      serverRevision: Number(cached.cacheRevision) + 1,
    }));
    const authoritative = await response.clone().json() as ThumbmuxPrefs;
    const tracked = trackedBackgroundFetch(() => response);
    const adapter = createServerPrefs({
      url: `/prefs/${key}`,
      cacheKey: key,
      fetchFn: tracked.fetchFn,
    });
    const emissions: ThumbmuxPrefs[] = [];
    let visible = cached;
    adapter.subscribe?.((prefs) => {
      emissions.push(prefs);
      visible = prefs;
    });

    const immediate = await adapter.load();
    await tracked.done;

    expect(immediate).toEqual(cached);
    expect(tracked.calls).toHaveLength(1);
    expect(emissions).toHaveLength(1);
    expect({ visible, stored: readStoredPrefs(key) }).toEqual({
      visible: authoritative,
      stored: authoritative,
    });
  });

  for (const emptyCase of [
    {
      name: "an empty object",
      response: () => Response.json({}),
    },
    {
      name: "an empty body",
      response: () => new Response("", { status: 200 }),
    },
    {
      name: "an object missing the cached preference keys",
      response: () => Response.json({ serverRevision: 1 }),
    },
  ]) {
    test(`keeps the existing cache when GET returns ${emptyCase.name}`, async () => {
      const key = cacheKey("empty-get");
      const cached = seedCache(key);
      const rawBefore = realStorage.getItem(key);
      const tracked = trackedBackgroundFetch(() => emptyCase.response());
      const adapter = createServerPrefs({
        url: `/prefs/${key}`,
        cacheKey: key,
        fetchFn: tracked.fetchFn,
      });
      const emissions: ThumbmuxPrefs[] = [];
      let visible = cached;
      adapter.subscribe?.((prefs) => {
        emissions.push(prefs);
        visible = prefs;
      });

      const immediate = await adapter.load();
      await tracked.done;

      expect(immediate).toEqual(cached);
      expect({
        rawAfter: realStorage.getItem(key),
        visible,
        emissionCount: emissions.length,
      }).toEqual({
        rawAfter: rawBefore,
        visible: cached,
        emissionCount: 0,
      });
    });
  }

  for (const errorCase of [
    {
      name: "HTTP 500",
      response: () => Response.json({ error: "prefs unavailable" }, { status: 500 }),
    },
    {
      name: "a network rejection",
      response: () => Promise.reject(new Error("network unavailable")),
    },
  ]) {
    test(`keeps the existing cache when GET fails with ${errorCase.name}`, async () => {
      const key = cacheKey("failed-get");
      const cached = seedCache(key);
      const rawBefore = realStorage.getItem(key);
      const tracked = trackedBackgroundFetch(() => errorCase.response());
      const adapter = createServerPrefs({
        url: `/prefs/${key}`,
        cacheKey: key,
        fetchFn: tracked.fetchFn,
      });
      const emissions: ThumbmuxPrefs[] = [];
      let visible = cached;
      adapter.subscribe?.((prefs) => {
        emissions.push(prefs);
        visible = prefs;
      });

      const immediate = await adapter.load();
      await tracked.done;

      expect(immediate).toEqual(cached);
      expect({
        rawAfter: realStorage.getItem(key),
        visible,
        emissionCount: emissions.length,
      }).toEqual({
        rawAfter: rawBefore,
        visible: cached,
        emissionCount: 0,
      });
    });
  }

  for (const errorCase of [
    {
      name: "HTTP 500",
      response: () => Response.json({ error: "write rejected" }, { status: 500 }),
    },
    {
      name: "a network rejection",
      response: () => Promise.reject(new Error("write unavailable")),
    },
  ]) {
    test(`restores the in-memory and cached snapshot when PUT fails with ${errorCase.name}`, async () => {
      const key = cacheKey("failed-put");
      const cached = seedCache(key);
      const adapter = createServerPrefs({
        url: `/prefs/${key}`,
        cacheKey: key,
        fetchFn: (async () => errorCase.response()) as typeof fetch,
      });
      let visible = cached;
      adapter.subscribe?.((prefs) => {
        visible = prefs;
      });

      await adapter.save({
        fontPx: Number(cached.fontPx) + 8,
        shortcuts: undefined,
      });

      expect({ visible, stored: readStoredPrefs(key) }).toEqual({
        visible: cached,
        stored: cached,
      });
    });
  }

  test("serializes overlapping PUTs and ends at the latest authoritative snapshot", async () => {
    const key = cacheKey("overlap");
    const cached = seedCache(key);
    const firstPatch: Partial<ThumbmuxPrefs> = {
      clientSequence: Number(cached.cacheRevision) + 1,
      fontPx: Number(cached.fontPx) + 1,
      obsolete: undefined,
    };
    const secondPatch: Partial<ThumbmuxPrefs> = {
      clientSequence: Number(firstPatch.clientSequence) + 1,
      theme: { mode: "light" },
    };
    const firstSnapshot = {
      ...mergePrefs(cached, firstPatch),
      serverRevision: 1,
    };
    const secondSnapshot = {
      ...mergePrefs(firstSnapshot, secondPatch),
      serverRevision: 2,
    };
    const firstResponse = Response.json(firstSnapshot);
    const secondResponse = Response.json(secondSnapshot);
    const authoritativeFinal = await secondResponse.clone().json() as ThumbmuxPrefs;
    const gates = [deferred<Response>(), deferred<Response>()];
    const requestBodies: Array<Record<string, unknown>> = [];
    let active = 0;
    let maxInFlight = 0;

    const fetchFn = ((_: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const gate = gates[requestBodies.length];
      if (!gate) throw new Error("unexpected extra PUT");
      requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      active += 1;
      maxInFlight = Math.max(maxInFlight, active);
      return gate.promise.finally(() => {
        active -= 1;
      });
    }) as typeof fetch;

    const adapter = createServerPrefs({
      url: `/prefs/${key}`,
      cacheKey: key,
      fetchFn,
    });
    let visible = cached;
    adapter.subscribe?.((prefs) => {
      visible = prefs;
    });

    const firstSave = adapter.save(firstPatch);
    const secondSave = adapter.save(secondPatch);
    await Promise.resolve();
    const requestsBeforeFirstSettled = requestBodies.length;

    gates[0]!.resolve(firstResponse);
    await firstSave;
    for (let turn = 0; turn < 8 && requestBodies.length < 2; turn += 1) {
      await Promise.resolve();
    }
    gates[1]!.resolve(secondResponse);
    await secondSave;

    const observedSequence = requestBodies.map((body) => Number(body.clientSequence));
    expect(observedSequence).toEqual([...observedSequence].sort((a, b) => a - b));
    expect(requestBodies[0]?.obsolete).toBeNull();
    expect({
      requestsBeforeFirstSettled,
      maxInFlight,
      requestCount: requestBodies.length,
      visible,
      stored: readStoredPrefs(key),
    }).toEqual({
      requestsBeforeFirstSettled: 1,
      maxInFlight: 1,
      requestCount: 2,
      visible: authoritativeFinal,
      stored: authoritativeFinal,
    });
  });

  test("discards a GET started during a pending PUT after that PUT settles", async () => {
    const key = cacheKey("put-then-stale-get");
    const cached = seedCache(key);
    const patch: Partial<ThumbmuxPrefs> = {
      fontPx: Number(cached.fontPx) + 5,
      clientRevision: Number(cached.cacheRevision) + 1,
    };
    const authoritative = {
      ...mergePrefs(cached, patch),
      serverRevision: Number(cached.cacheRevision) + 2,
    };
    const stale = {
      ...cached,
      serverRevision: Number(cached.cacheRevision),
    };
    const putResponse = deferred<Response>();
    const getResponse = deferred<Response>();
    const trackedGet = trackedContinuation(getResponse.promise);
    const putStarted = deferred<void>();
    const requestMethods: string[] = [];
    const fetchFn = ((_: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const method = init?.method ?? "GET";
      requestMethods.push(method);
      if (method === "PUT") {
        putStarted.resolve();
        return putResponse.promise;
      }
      return trackedGet.promise;
    }) as typeof fetch;
    const adapter = createServerPrefs({
      url: `/prefs/${key}`,
      cacheKey: key,
      fetchFn,
    });
    const emissions: ThumbmuxPrefs[] = [];
    let visible = cached;
    adapter.subscribe?.((prefs) => {
      emissions.push(prefs);
      visible = prefs;
    });

    const saving = adapter.save(patch);
    await putStarted.promise;
    const loadedWhilePutWasPending = await adapter.load();

    putResponse.resolve(Response.json(authoritative));
    await saving;
    getResponse.resolve(Response.json(stale));
    await trackedGet.done;

    expect(requestMethods).toEqual(["PUT", "GET"]);
    expect(loadedWhilePutWasPending.fontPx).toBe(patch.fontPx);
    expect(emissions).toHaveLength(2);
    expect({ visible, stored: readStoredPrefs(key) }).toEqual({
      visible: authoritative,
      stored: authoritative,
    });
  });

  test("does not let an older concurrent GET overwrite a newer GET snapshot", async () => {
    const key = cacheKey("concurrent-loads");
    const cached = seedCache(key);
    const older = {
      ...cached,
      fontPx: Number(cached.fontPx) + 1,
      serverRevision: Number(cached.cacheRevision) + 1,
    };
    const newer = {
      ...cached,
      fontPx: Number(cached.fontPx) + 2,
      serverRevision: Number(cached.cacheRevision) + 2,
    };
    const responseGates = [deferred<Response>(), deferred<Response>()];
    const trackedResponses = responseGates.map((gate) => trackedContinuation(gate.promise));
    let requestCount = 0;
    const fetchFn = (() => {
      const response = trackedResponses[requestCount++];
      if (!response) throw new Error("unexpected extra GET");
      return response.promise;
    }) as typeof fetch;
    const adapter = createServerPrefs({
      url: `/prefs/${key}`,
      cacheKey: key,
      fetchFn,
    });
    const emissions: ThumbmuxPrefs[] = [];
    let visible = cached;
    adapter.subscribe?.((prefs) => {
      emissions.push(prefs);
      visible = prefs;
    });

    await Promise.all([adapter.load(), adapter.load()]);
    responseGates[1]!.resolve(Response.json(newer));
    await trackedResponses[1]!.done;
    responseGates[0]!.resolve(Response.json(older));
    await trackedResponses[0]!.done;

    expect(requestCount).toBe(2);
    expect(emissions).toHaveLength(1);
    expect({ visible, stored: readStoredPrefs(key) }).toEqual({
      visible: newer,
      stored: newer,
    });
  });

  test("does not let an older concurrent GET resolving first win over a newer GET", async () => {
    const key = cacheKey("concurrent-loads-older-first");
    const cached = seedCache(key);
    const older = {
      ...cached,
      fontPx: Number(cached.fontPx) + 1,
      serverRevision: Number(cached.cacheRevision) + 1,
    };
    const newer = {
      ...cached,
      fontPx: Number(cached.fontPx) + 2,
      serverRevision: Number(cached.cacheRevision) + 2,
    };
    const responseGates = [deferred<Response>(), deferred<Response>()];
    const trackedResponses = responseGates.map((gate) => trackedContinuation(gate.promise));
    let requestCount = 0;
    const fetchFn = (() => {
      const response = trackedResponses[requestCount++];
      if (!response) throw new Error("unexpected extra GET");
      return response.promise;
    }) as typeof fetch;
    const adapter = createServerPrefs({
      url: `/prefs/${key}`,
      cacheKey: key,
      fetchFn,
    });
    const emissions: ThumbmuxPrefs[] = [];
    let visible = cached;
    adapter.subscribe?.((prefs) => {
      emissions.push(prefs);
      visible = prefs;
    });

    await Promise.all([adapter.load(), adapter.load()]);
    responseGates[0]!.resolve(Response.json(older));
    await trackedResponses[0]!.done;
    responseGates[1]!.resolve(Response.json(newer));
    await trackedResponses[1]!.done;

    expect(requestCount).toBe(2);
    expect(emissions).toHaveLength(1);
    expect({ visible, stored: readStoredPrefs(key) }).toEqual({
      visible: newer,
      stored: newer,
    });
  });

  for (const malformed of [
    {
      name: "an empty body",
      response: () => new Response("", { status: 200 }),
    },
    {
      name: "an array snapshot",
      response: () => Response.json([{ fontPx: 99 }]),
    },
  ]) {
    test(`rolls back and rejects a successful PUT with ${malformed.name}`, async () => {
      const key = cacheKey("malformed-put");
      const cached = seedCache(key);
      const patch: Partial<ThumbmuxPrefs> = {
        fontPx: Number(cached.fontPx) + 7,
      };
      const adapter = createServerPrefs({
        url: `/prefs/${key}`,
        cacheKey: key,
        fetchFn: (async () => malformed.response()) as typeof fetch,
      });
      const emissions: ThumbmuxPrefs[] = [];
      let visible = cached;
      adapter.subscribe?.((prefs) => {
        emissions.push(prefs);
        visible = prefs;
      });

      const saving = adapter.save(patch);
      await expect(saving).rejects.toThrow(
        "Invalid preferences response: expected a JSON object",
      );

      expect(emissions).toHaveLength(2);
      expect({ visible, stored: readStoredPrefs(key) }).toEqual({
        visible: cached,
        stored: cached,
      });
    });
  }

  test("uses fetchFn without touching the global fetch transport", async () => {
    const key = cacheKey("fetch-override");
    const cached = seedCache(key);
    const url = `/prefs/${key}`;
    const response = Response.json(mergePrefs(cached, {
      serverRevision: Number(cached.cacheRevision) + 1,
    }));
    const authoritative = await response.clone().json() as ThumbmuxPrefs;
    const tracked = trackedBackgroundFetch(() => response);
    let matchingGlobalCalls = 0;

    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      writable: true,
      value: (async (input: string | URL | Request) => {
        if (String(input) === url) matchingGlobalCalls += 1;
        return Response.json({ unexpectedGlobalTransport: true });
      }) as typeof fetch,
    });

    try {
      const adapter = createServerPrefs({
        url,
        cacheKey: key,
        fetchFn: tracked.fetchFn,
      });
      await adapter.load();
      await tracked.done;

      expect({
        overrideCalls: tracked.calls.length,
        matchingGlobalCalls,
        stored: readStoredPrefs(key),
      }).toEqual({
        overrideCalls: 1,
        matchingGlobalCalls: 0,
        stored: authoritative,
      });
    } finally {
      restoreGlobal("fetch", originalFetchDescriptor);
    }
  });
});

describe("createLocalPrefs", () => {
  test("falls back for malformed JSON without erasing the stored bytes", async () => {
    const key = cacheKey("malformed-local");
    realStorage.setItem(key, "{not valid JSON");
    const rawBefore = realStorage.getItem(key);

    const loaded = await createLocalPrefs(key).load();

    expect({ loaded, rawAfter: realStorage.getItem(key) }).toEqual({
      loaded: {},
      rawAfter: rawBefore,
    });
  });

  test("falls back when localStorage throws without attempting a destructive write", async () => {
    const key = cacheKey("throwing-local");
    seedCache(key);
    const rawBefore = realStorage.getItem(key);
    const operations = { getItem: 0, setItem: 0, removeItem: 0, clear: 0 };
    const throwingStorage = {
      get length() { return 0; },
      key() { return null; },
      getItem() {
        operations.getItem += 1;
        throw new Error("storage unavailable");
      },
      setItem() { operations.setItem += 1; },
      removeItem() { operations.removeItem += 1; },
      clear() { operations.clear += 1; },
    } as Storage;
    let loaded: ThumbmuxPrefs | undefined;

    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      writable: true,
      value: throwingStorage,
    });
    try {
      loaded = await createLocalPrefs(key).load();
    } finally {
      restoreGlobal("localStorage", originalStorageDescriptor);
    }

    expect({
      loaded,
      operations,
      rawAfter: realStorage.getItem(key),
    }).toEqual({
      loaded: {},
      operations: { getItem: 1, setItem: 0, removeItem: 0, clear: 0 },
      rawAfter: rawBefore,
    });
  });

  for (const kind of ["local", "server"] as const) {
    test(`queues reentrant ${kind} subscriber emissions without nested callbacks`, async () => {
      const key = cacheKey(`reentrant-${kind}`);
      const cached = seedCache(key);
      let serverSnapshot = cached;
      const adapter = kind === "local"
        ? createLocalPrefs(key)
        : createServerPrefs({
            url: `/prefs/${key}`,
            cacheKey: key,
            fetchFn: (async (_input, init) => {
              const patch = JSON.parse(String(init?.body)) as Partial<ThumbmuxPrefs>;
              serverSnapshot = mergePrefs(serverSnapshot, patch);
              return Response.json(serverSnapshot);
            }) as typeof fetch,
          });
      const firstFontPx = Number(cached.fontPx) + 1;
      const trace: string[] = [];
      const nestedSaves: Promise<void>[] = [];
      let callbackDepth = 0;
      let maxCallbackDepth = 0;
      let reentrantSaveCount = 0;
      const stopMutator = adapter.subscribe?.((prefs) => {
        callbackDepth += 1;
        maxCallbackDepth = Math.max(maxCallbackDepth, callbackDepth);
        trace.push(`mutator:${String(prefs.fontPx)}`);
        if (reentrantSaveCount < 3) {
          reentrantSaveCount += 1;
          nestedSaves.push(adapter.save({ fontPx: Number(prefs.fontPx) + 1 }));
        }
        callbackDepth -= 1;
      });
      const stopObserver = adapter.subscribe?.((prefs) => {
        trace.push(`observer:${String(prefs.fontPx)}`);
      });

      const outerSave = adapter.save({ fontPx: firstFontPx });
      stopMutator?.();
      stopObserver?.();
      await Promise.all([outerSave, ...nestedSaves]);

      expect(maxCallbackDepth).toBe(1);
      expect(trace).toEqual([
        `mutator:${firstFontPx}`,
        `observer:${firstFontPx}`,
        `mutator:${firstFontPx + 1}`,
        `observer:${firstFontPx + 1}`,
        `mutator:${firstFontPx + 2}`,
        `observer:${firstFontPx + 2}`,
        `mutator:${firstFontPx + 3}`,
        `observer:${firstFontPx + 3}`,
      ]);
    });
  }
});
