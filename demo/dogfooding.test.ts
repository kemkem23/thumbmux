import { expect, mock, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { tmuxMux } from "@thumbmux/svelte";
import type { Component } from "svelte";
import { flushSync, mount, tick, unmount } from "../svelte/tests/svelte-client";

type ParsedImport = {
  clause: string;
  specifier: string;
};

function parseImports(source: string): ParsedImport[] {
  const importFrom = /^\s*import\s+([\s\S]*?)\s+from\s+(["'])([^"'\r\n]+)\2\s*;?/gm;
  return [...source.matchAll(importFrom)].map((match) => ({
    clause: match[1]!,
    specifier: match[3]!,
  }));
}

function namedImportSpecifiers(source: string, importedName: string): string[] {
  return parseImports(source)
    .filter(({ clause }) => {
      const namedBindings = clause.match(/\{([\s\S]*?)\}/)?.[1];
      if (!namedBindings) return false;

      return namedBindings.split(",").some((binding) => {
        const imported = binding
          .trim()
          .replace(/^type\s+/, "")
          .split(/\s+as\s+/)[0]
          ?.trim();
        return imported === importedName;
      });
    })
    .map(({ specifier }) => specifier);
}

function namedImports(source: string, specifier: string): string[] {
  return parseImports(source)
    .filter((entry) => entry.specifier === specifier)
    .flatMap(({ clause }) => {
      const namedBindings = clause.match(/\{([\s\S]*?)\}/)?.[1];
      if (!namedBindings) return [];
      return namedBindings.split(",").map((binding) => (
        binding
          .trim()
          .replace(/^type\s+/, "")
          .split(/\s+as\s+/)[0]
          ?.trim() ?? ""
      )).filter(Boolean);
    });
}

function countCalls(source: string, identifier: string): number {
  const codeOnly = source.replace(
    /\/\*[\s\S]*?\*\/|\/\/[^\r\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/g,
    " ",
  );
  const escapedIdentifier = identifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [...codeOnly.matchAll(new RegExp(`\\b${escapedIdentifier}\\s*\\(`, "g"))].length;
}

function countConstructions(source: string, identifier: string): number {
  const codeOnly = source.replace(
    /\/\*[\s\S]*?\*\/|\/\/[^\r\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/g,
    " ",
  );
  const escapedIdentifier = identifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [...codeOnly.matchAll(new RegExp(`\\bnew\\s+${escapedIdentifier}\\s*\\(`, "g"))].length;
}

const serveSource = await readFile(new URL("./serve.ts", import.meta.url), "utf8");
const appSource = await readFile(new URL("./src/App.svelte", import.meta.url), "utf8");
const policySource = await readFile(new URL("./policy.ts", import.meta.url), "utf8");
const serverPolicySource = await readFile(new URL("./server-policy.ts", import.meta.url), "utf8");

// Registered ONCE, at module scope. Two mounting tests want the same mock, and
// calling mock.module a second time for a module that is already mocked — with a
// factory that dynamically imports it — deadlocks under bun 1.3.14: the factory
// waits on a registry entry that the re-registration is holding. bun 1.3.11 let
// it through, so CI (unpinned, on 1.3.14) hung for an hour while the same file
// ran locally in 4.6s.
mock.module("@thumbmux/app", () => import("../app/src/index.ts"));

function restoreProperty(
  target: object,
  key: string,
  descriptor: PropertyDescriptor | undefined,
): void {
  if (descriptor) Object.defineProperty(target, key, descriptor);
  else Reflect.deleteProperty(target, key);
}

async function settleUi(): Promise<void> {
  for (let pass = 0; pass < 6; pass += 1) {
    await Promise.resolve();
    await tick();
    flushSync();
  }
}

function click(target: HTMLElement, selector: string): void {
  const button = target.querySelector<HTMLButtonElement>(selector);
  if (!button) throw new Error(`missing button: ${selector}`);
  flushSync(() => button.click());
}

test("demo mounts the packaged app shell without importing its UI pieces directly", () => {
  expect(namedImportSpecifiers(appSource, "ThumbmuxApp")).toEqual(["@thumbmux/app"]);
  expect(namedImportSpecifiers(appSource, "AppAdapters")).toEqual(["@thumbmux/app"]);
  expect(appSource.match(/<ThumbmuxApp(?:\s|\/>)/g)).toHaveLength(1);

  const allowedSvelteInfrastructure = new Set(["createLocalPrefs", "tmuxMux"]);
  const directSvelteUi = namedImports(appSource, "@thumbmux/svelte")
    .filter((name) => !allowedSvelteInfrastructure.has(name))
    .sort();
  expect(directSvelteUi).toEqual([]);
});

test("demo delegates the server surface to createAppRoutes", () => {
  expect(namedImportSpecifiers(serveSource, "createAppRoutes")).toEqual(["@thumbmux/server"]);
  expect(countCalls(serveSource, "createAppRoutes")).toBe(1);
  expect(namedImportSpecifiers(serveSource, "TmuxWsMux")).toEqual([]);
  expect(countConstructions(serveSource, "TmuxWsMux")).toBe(0);
});

test("demo projects launch policy into session rows for reloads and other clients", () => {
  expect(serveSource).toContain("projectSessionList");
  expect(policySource).toContain("demoSubmitAgent");
  expect(policySource).toContain("demoAltScreenMouse");
  expect(appSource).toContain("demoSubmitAgent");
  expect(appSource).toContain("sessionMetadataFromRows");
  expect(appSource).toContain("metadata.altScreens");
});

test("demo decodes its dist filesystem URL", () => {
  expect(serveSource).toContain("demoDistPath");
  expect(serverPolicySource).toContain("fileURLToPath");
  expect(serveSource).not.toContain('new URL("./dist/", import.meta.url).pathname');
});

test("demo session and worktree identities do not repeat across server runs", () => {
  expect(serveSource).toContain("createDemoSessionPolicy");
  expect(serveSource).not.toContain("cleanupStaleDemoWorktrees");
  expect(serveSource).not.toContain("`demo-${++spawnCounter}`");
});

test("demo imports FileHistoryArchive through the server package", () => {
  expect(namedImportSpecifiers(serveSource, "FileHistoryArchive")).toEqual(["@thumbmux/server"]);
});

test("demo imports defaultSurface through the core package", () => {
  expect(namedImportSpecifiers(appSource, "defaultSurface")).toEqual(["@thumbmux/core"]);
});

test("demo calls the imported defaultSurface instead of leaving a dogfood-only import", () => {
  expect(countCalls(appSource, "defaultSurface")).toBeGreaterThan(0);
});

test("demo preserves the pre-extraction raw launch error line", async () => {
  const { default: App } = await import("./src/App.svelte");
  const mux = tmuxMux as unknown as {
    onSessions(callback: (rows: unknown[]) => void): () => void;
    subscribe(...args: unknown[]): () => void;
  };
  const originalOnSessions = Object.getOwnPropertyDescriptor(mux, "onSessions");
  const originalSubscribe = Object.getOwnPropertyDescriptor(mux, "subscribe");
  const originalFetch = Object.getOwnPropertyDescriptor(globalThis, "fetch");
  const target = document.createElement("div");
  let instance: Record<string, unknown> | undefined;

  try {
    history.replaceState(null, "", "/");
    localStorage.clear();
    document.body.appendChild(target);
    mux.onSessions = (callback) => {
      callback([]);
      return () => {};
    };
    mux.subscribe = () => () => {};
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
      if (url === "/api/sessions") return Response.json([]);
      if (url === "/api/spawn" && init?.method === "POST") {
        return Response.json({ error: "policy rejected request" }, { status: 403 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    flushSync(() => {
      instance = mount(App as Component, { target }) as Record<string, unknown>;
    });
    await settleUi();
    click(target, '[data-testid="grid-new"]');
    click(target, '[data-testid="launch-preset"]');
    click(target, '[data-testid="launch-go"]');
    await settleUi();

    expect(target.querySelector("[data-testid=\"launch-sheet\"] .err")?.textContent?.trim())
      .toBe("policy rejected request");
  } finally {
    if (instance) unmount(instance);
    target.remove();
    restoreProperty(mux, "onSessions", originalOnSessions);
    restoreProperty(mux, "subscribe", originalSubscribe);
    restoreProperty(globalThis, "fetch", originalFetch);
    localStorage.clear();
    history.replaceState(null, "", "/");
    document.body.replaceChildren();
  }
});

test("deep-link session hydrates from later mux pushes when REST bootstrap fails", async () => {
  const { default: App } = await import("./src/App.svelte");
  const mux = tmuxMux as unknown as {
    onSessions(callback: (rows: unknown[]) => void): () => void;
    subscribe(...args: unknown[]): () => void;
    sendKeys(session: string, keys: string): void;
  };
  const originalOnSessions = Object.getOwnPropertyDescriptor(mux, "onSessions");
  const originalSubscribe = Object.getOwnPropertyDescriptor(mux, "subscribe");
  const originalSendKeys = Object.getOwnPropertyDescriptor(mux, "sendKeys");
  const originalFetch = Object.getOwnPropertyDescriptor(globalThis, "fetch");
  const callbacks = new Set<(rows: unknown[]) => void>();
  const keyCalls: Array<[string, string]> = [];
  const target = document.createElement("div");
  let registrations = 0;
  let instance: Record<string, unknown> | undefined;

  try {
    history.replaceState(null, "", "/?session=deep-link-session");
    localStorage.clear();
    document.body.appendChild(target);
    mux.onSessions = (callback) => {
      registrations += 1;
      callbacks.add(callback);
      return () => { callbacks.delete(callback); };
    };
    mux.subscribe = () => () => {};
    mux.sendKeys = (session, keys) => { keyCalls.push([session, keys]); };
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
      if (url === "/api/sessions") {
        return Response.json({ error: "bootstrap unavailable" }, { status: 500 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    flushSync(() => {
      instance = mount(App as Component, { target }) as Record<string, unknown>;
    });
    await settleUi();
    expect(target.querySelector('[data-testid="session-view"]')).not.toBeNull();
    expect(registrations).toBeGreaterThanOrEqual(2);

    const liveRows = [{
      name: "deep-link-session",
      created: "1",
      windows: 1,
      attached: false,
      activityAt: 1,
      demoSubmitAgent: "codex",
      demoAltScreenMouse: false,
    }];
    for (const callback of [...callbacks]) callback(liveRows);
    await settleUi();

    click(target, '[data-testid="mtv"]');
    await settleUi();
    const input = target.querySelector<HTMLTextAreaElement>('[data-testid="input-sheet"] textarea');
    const send = target.querySelector<HTMLButtonElement>('[data-testid="input-sheet"] .snd');
    if (!input || !send) throw new Error("deep-link composer did not mount");
    flushSync(() => {
      input.value = "deep link metadata";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await settleUi();
    flushSync(() => send.click());
    await Bun.sleep(1_250);

    expect(keyCalls).toEqual([
      ["deep-link-session", "deep link metadata"],
      ["deep-link-session", "\r"],
      ["deep-link-session", "\r"],
    ]);

    // The next authoritative list removes the row. A recycled/dead name must
    // not keep the prior codex submission policy in the client maps.
    for (const callback of [...callbacks]) callback([]);
    await settleUi();
    keyCalls.length = 0;
    click(target, '[data-testid="mtv"]');
    await settleUi();
    const nextInput = target.querySelector<HTMLTextAreaElement>('[data-testid="input-sheet"] textarea');
    const nextSend = target.querySelector<HTMLButtonElement>('[data-testid="input-sheet"] .snd');
    if (!nextInput || !nextSend) throw new Error("reopened deep-link composer did not mount");
    flushSync(() => {
      nextInput.value = "after removal";
      nextInput.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await settleUi();
    flushSync(() => nextSend.click());
    await Bun.sleep(1_250);
    expect(keyCalls).toEqual([
      ["deep-link-session", "after removal"],
      ["deep-link-session", "\r"],
    ]);
  } finally {
    if (instance) unmount(instance);
    target.remove();
    restoreProperty(mux, "onSessions", originalOnSessions);
    restoreProperty(mux, "subscribe", originalSubscribe);
    restoreProperty(mux, "sendKeys", originalSendKeys);
    restoreProperty(globalThis, "fetch", originalFetch);
    localStorage.clear();
    history.replaceState(null, "", "/");
    document.body.replaceChildren();
  }
});

test("demo contains no local history archive implementation", () => {
  const localImplementations = [
    ...new Bun.Glob("**/history-archive.ts").scanSync({ cwd: import.meta.dir, onlyFiles: true }),
  ].sort();

  expect(localImplementations).toEqual([]);
});
