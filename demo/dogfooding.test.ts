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
  mock.module("@thumbmux/app", () => import("../app/src/index.ts"));
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

test("demo contains no local history archive implementation", () => {
  const localImplementations = [
    ...new Bun.Glob("**/history-archive.ts").scanSync({ cwd: import.meta.dir, onlyFiles: true }),
  ].sort();

  expect(localImplementations).toEqual([]);
});
