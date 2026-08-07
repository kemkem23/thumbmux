import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { compile as compileSvelte, parse as parseSvelte } from "svelte/compiler";
import ts from "typescript";

const PACKAGE_ROOT = resolve(import.meta.dir, "..");

type Document = {
  path: string;
  relativePath: string;
  source: string;
};

type Fence = {
  document: Document;
  language: string;
  code: string;
  codeLine: number;
};

function markdownFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...markdownFiles(path));
    else if (entry.isFile() && entry.name.endsWith(".md")) files.push(path);
  }
  return files;
}

const documents: Document[] = [
  join(PACKAGE_ROOT, "README.md"),
  ...markdownFiles(join(PACKAGE_ROOT, "docs")),
]
  .sort()
  .map((path) => ({
    path,
    relativePath: relative(PACKAGE_ROOT, path).replaceAll("\\", "/"),
    source: readFileSync(path, "utf8"),
  }));

function extractFences(document: Document): Fence[] {
  const lines = document.source.split("\n");
  const fences: Fence[] = [];

  for (let index = 0; index < lines.length; index++) {
    const opening = lines[index]!.match(/^\s*(`{3,}|~{3,})\s*([^\s`]*)?.*$/);
    if (!opening) continue;

    const marker = opening[1]!;
    const language = (opening[2] ?? "").toLowerCase();
    const codeLine = index + 2;
    const code: string[] = [];
    const closing = new RegExp(`^\\s*${marker[0]}{${marker.length},}\\s*$`);

    index++;
    while (index < lines.length && !closing.test(lines[index]!)) {
      code.push(lines[index]!);
      index++;
    }

    fences.push({ document, language, code: code.join("\n"), codeLine });
  }

  return fences;
}

const fences = documents.flatMap(extractFences);

function locationForOffset(fence: Fence, offset: number): string {
  const before = fence.code.slice(0, Math.max(0, offset));
  const lines = before.split("\n");
  return `${fence.document.relativePath}:${fence.codeLine + lines.length - 1}:${lines.at(-1)!.length + 1}`;
}

function bareEllipsisAttributeOffsets(root: unknown): number[] {
  const offsets: number[] = [];
  const seen = new Set<object>();

  function visit(value: unknown): void {
    if (!value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const child of value) visit(child);
      return;
    }

    const node = value as Record<string, unknown>;
    if (node.type === "Attribute" && node.name === "..." && typeof node.start === "number") {
      offsets.push(node.start);
    }
    for (const child of Object.values(node)) visit(child);
  }

  visit(root);
  return offsets;
}

describe("public documentation snippets", () => {
  test("every documented thumbmux package specifier exists in package exports", () => {
    const manifest = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")) as {
      name: string;
      exports: Record<string, unknown>;
    };
    const exportedSpecifiers = new Set(
      Object.keys(manifest.exports).map((key) => key === "." ? manifest.name : `${manifest.name}${key.slice(1)}`),
    );
    const failures = new Set<string>();
    const packageReference = /(?<![\/\w.-])(?:@thumbmux|thumbmux)\/[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?(?:\/[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?)*/gi;
    const importPatterns = [
      /\bfrom\s*(["'])([^"']+)\1/g,
      /\bimport\s*(?:\(\s*)?(["'])([^"']+)\1/g,
    ];

    for (const document of documents) {
      for (const [index, line] of document.source.split("\n").entries()) {
        const validate = (specifier: string): void => {
          if (exportedSpecifiers.has(specifier)) return;
          failures.add(
            `${document.relativePath}:${index + 1}: ${JSON.stringify(specifier)} is not exported by package.json`,
          );
        };

        for (const match of line.matchAll(packageReference)) {
          validate(match[0]);
        }
        for (const pattern of importPatterns) {
          for (const match of line.matchAll(pattern)) {
            const specifier = match[2]!;
            if (
              specifier === manifest.name
              || specifier.startsWith(`${manifest.name}/`)
              || specifier.startsWith("@thumbmux/")
            ) {
              validate(specifier);
            }
          }
        }
      }
    }

    expect([...failures]).toEqual([]);
  });

  test("every json fence contains parseable JSON", () => {
    const failures: string[] = [];
    for (const fence of fences.filter(({ language }) => language === "json")) {
      try {
        JSON.parse(fence.code);
      } catch (error) {
        failures.push(
          `${fence.document.relativePath}:${fence.codeLine}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    expect(failures).toEqual([]);
  });

  test("TypeScript and Svelte fences are syntactically valid and contain no bare ellipsis props", () => {
    const failures: string[] = [];

    for (const fence of fences) {
      if (["ts", "typescript", "js", "javascript"].includes(fence.language)) {
        const result = ts.transpileModule(fence.code, {
          compilerOptions: {
            module: ts.ModuleKind.ESNext,
            target: ts.ScriptTarget.ESNext,
          },
          fileName: `${fence.document.relativePath}:${fence.codeLine}.${fence.language}`,
          reportDiagnostics: true,
        });
        for (const diagnostic of result.diagnostics ?? []) {
          if (diagnostic.category !== ts.DiagnosticCategory.Error) continue;
          failures.push(
            `${locationForOffset(fence, diagnostic.start ?? 0)}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")}`,
          );
        }
      }

      if (fence.language === "svelte") {
        let ast: unknown;
        try {
          ast = parseSvelte(fence.code, { filename: fence.document.relativePath });
          compileSvelte(fence.code, { filename: fence.document.relativePath });
        } catch (error) {
          const parseError = error as Error & { position?: [number, number] };
          failures.push(
            `${locationForOffset(fence, parseError.position?.[0] ?? 0)}: ${parseError.message}`,
          );
        }

        for (const offset of bareEllipsisAttributeOffsets(ast)) {
          failures.push(`${locationForOffset(fence, offset)}: bare ... is not a copyable Svelte prop`);
        }
      }
    }

    expect(failures).toEqual([]);
  });
});

/**
 * Adoption-report regressions (Hispeed TM-11 / TM-20 / TM-23).
 * These are prose contracts that ship inside node_modules via the `files`
 * whitelist — a wrong install glob or an undocumented hard requirement is how
 * consumers get stranded (v0.9.1 README → v0.8.3 forever).
 */
describe("adoption-report documentation contracts (TM-11, TM-20, TM-23)", () => {
  const readme = readFileSync(join(PACKAGE_ROOT, "README.md"), "utf8");
  const contract = readFileSync(join(PACKAGE_ROOT, "CONTRACT.md"), "utf8");
  const protocol = readFileSync(join(PACKAGE_ROOT, "docs/protocol.md"), "utf8");

  test("TM-20: README and CONTRACT require moduleResolution bundler for svelte/app", () => {
    // Must name both the setting and the broken alternatives — otherwise a
    // host can keep node16 and think "bundler" is optional advice.
    for (const body of [readme, contract]) {
      expect(body).toMatch(/moduleResolution/);
      expect(body).toMatch(/["']bundler["']/);
      expect(body).toMatch(/node16|nodenext/i);
      expect(body).toMatch(/thumbmux\/svelte/);
    }
  });

  test("TM-11: host CSS custom properties are named as a load-bearing surface", () => {
    // Load-bearing vars from the adoption report — especially --font-mono,
    // which silently breaks geometry when missing.
    expect(readme).toContain("Host CSS custom properties");
    for (const prop of [
      "--font-mono",
      "--font-thai",
      "--tbg",
      "--tfg",
      "--tstage",
      "--agent",
      "--hud",
      "--hud-fg",
      "--hud-line",
    ]) {
      expect(readme).toContain(prop);
    }
    // CONTRACT must point at the README list (manifests cannot inventory CSS).
    expect(contract).toMatch(/CSS custom properties/);
    expect(contract).toContain("--font-mono");
  });

  test("TM-23: protocol states history prepend has no content de-duplication", () => {
    expect(protocol).toMatch(/does not content-de-duplicate/i);
    expect(protocol).toMatch(/must not.*return rows the client already has/i);
  });

  test("TM-23: protocol states sessions_subscribe is idempotent per socket", () => {
    expect(protocol).toMatch(/sessions_subscribe.*idempoten|idempoten.*sessions_subscribe/is);
    expect(protocol).toMatch(/Set/);
    expect(protocol).toMatch(/exactly once/i);
  });

  test("install guidance never reintroduces a minor-pinned dist glob", () => {
    // v0.9.1 trap: refs/tags/v0.8.*-dist stranded consumers on 0.8.3.
    expect(readme).not.toMatch(/refs\/tags\/v0\.\d+\.\*-dist/);
    expect(readme).toMatch(/refs\/tags\/v0\.\*-dist/);
  });
});
