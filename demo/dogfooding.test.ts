import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

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

function countCalls(source: string, identifier: string): number {
  const codeOnly = source.replace(
    /\/\*[\s\S]*?\*\/|\/\/[^\r\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/g,
    " ",
  );
  const escapedIdentifier = identifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [...codeOnly.matchAll(new RegExp(`\\b${escapedIdentifier}\\s*\\(`, "g"))].length;
}

const serveSource = await readFile(new URL("./serve.ts", import.meta.url), "utf8");
const appSource = await readFile(new URL("./src/App.svelte", import.meta.url), "utf8");

test("demo imports FileHistoryArchive through the server package", () => {
  expect(namedImportSpecifiers(serveSource, "FileHistoryArchive")).toEqual(["@thumbmux/server"]);
});

test("demo imports defaultSurface through the core package", () => {
  expect(namedImportSpecifiers(appSource, "defaultSurface")).toEqual(["@thumbmux/core"]);
});

test("demo calls the imported defaultSurface instead of leaving a dogfood-only import", () => {
  expect(countCalls(appSource, "defaultSurface")).toBeGreaterThan(0);
});

test("demo contains no local history archive implementation", () => {
  const localImplementations = [
    ...new Bun.Glob("**/history-archive.ts").scanSync({ cwd: import.meta.dir, onlyFiles: true }),
  ].sort();

  expect(localImplementations).toEqual([]);
});
