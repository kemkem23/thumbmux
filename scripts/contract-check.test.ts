import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkContract,
  deriveGitDistReport,
  type ContractEntry,
  type ContractTier,
} from "./contract-check";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(version = "0.8.5"): string {
  const root = mkdtempSync(join(tmpdir(), "thumbmux-contract-check-"));
  roots.push(root);
  mkdirSync(join(root, "git-dist/core"), { recursive: true });
  mkdirSync(join(root, "contract/manifest"), { recursive: true });
  writeFileSync(join(root, "package.json"), `${JSON.stringify({ version })}\n`);
  writeCoreDeclarations(root, [
    "export declare function frozen(input: string): string;",
    "export declare function stabilizing(input: number): number;",
    "export declare function experimental(input: boolean): boolean;",
    "export declare const legacy: string;",
  ]);
  return root;
}

function writeCoreDeclarations(root: string, declarations: string[]): void {
  writeFileSync(join(root, "git-dist/core/index.d.ts"), `${declarations.join("\n")}\n`);
}

function writeBaselineManifest(
  root: string,
  tiers: Record<string, ContractTier> = {
    frozen: "F",
    stabilizing: "S",
    experimental: "X",
    legacy: "F",
  },
): ContractEntry[] {
  const entries = deriveGitDistReport(root, ["core"]).core.map((entry) => ({
    ...entry,
    tier: tiers[entry.name] ?? "X",
    ...(entry.name === "legacy"
      ? {
        deprecated: {
          since: "0.8.0",
          removeNoEarlierThan: "0.9.0",
          replacement: "frozen",
        },
      }
      : {}),
  }));
  writeFileSync(
    join(root, "contract/manifest/core.json"),
    `${JSON.stringify(entries, null, 2)}\n`,
  );
  return entries;
}

function runFixture(root: string) {
  return checkContract({
    packageRoot: root,
    subpackages: ["core"],
    validateExportParity: false,
  });
}

describe("contract surface policy", () => {
  test("rejects missing F names and changed S signatures", () => {
    const root = fixture();
    writeBaselineManifest(root);
    writeCoreDeclarations(root, [
      "export declare function stabilizing(input: string): number;",
      "export declare function experimental(input: boolean): boolean;",
      "export declare const legacy: string;",
    ]);

    const result = runFixture(root);

    expect(result.errors.map(({ code, name }) => [code, name])).toEqual([
      ["missing-protected-export", "frozen"],
      ["signature-mismatch", "stabilizing"],
    ]);
  });

  test("rejects a new public name until its manifest entry declares a tier", () => {
    const root = fixture();
    writeBaselineManifest(root);
    writeCoreDeclarations(root, [
      readFileSync(join(root, "git-dist/core/index.d.ts"), "utf8").trimEnd(),
      "export declare const surprise: number;",
    ]);

    const result = runFixture(root);

    expect(result.errors.map(({ code, name }) => [code, name])).toEqual([
      ["undeclared-export", "surprise"],
    ]);
    expect(result.errors[0]?.message).toContain("add it to the manifest and declare a tier");
  });

  test("reports X signature drift without failing", () => {
    const root = fixture();
    writeBaselineManifest(root);
    writeCoreDeclarations(root, [
      "export declare function frozen(input: string): string;",
      "export declare function stabilizing(input: number): number;",
      "export declare function experimental(input: string): string;",
      "export declare const legacy: string;",
    ]);

    const result = runFixture(root);

    expect(result.errors).toEqual([]);
    expect(result.summaries.map(({ code, name }) => [code, name])).toContainEqual([
      "experimental-signature-change",
      "experimental",
    ]);
  });

  test("rejects early deprecated removal", () => {
    const root = fixture("0.8.9");
    writeBaselineManifest(root);
    writeCoreDeclarations(root, [
      "export declare function frozen(input: string): string;",
      "export declare function stabilizing(input: number): number;",
      "export declare function experimental(input: boolean): boolean;",
    ]);

    const result = runFixture(root);

    expect(result.errors.map(({ code, name }) => [code, name])).toContainEqual([
      "deprecated-early-removal",
      "legacy",
    ]);
  });

  test("warns when a deprecated name remains at its removal version", () => {
    const root = fixture("0.9.0");
    writeBaselineManifest(root);

    const result = runFixture(root);

    expect(result.errors).toEqual([]);
    expect(result.warnings.map(({ code, name }) => [code, name])).toEqual([
      ["deprecated-removal-due", "legacy"],
    ]);
  });

  test("allows deprecated removal at the recorded version", () => {
    const root = fixture("0.9.0");
    writeBaselineManifest(root);
    writeCoreDeclarations(root, [
      "export declare function frozen(input: string): string;",
      "export declare function stabilizing(input: number): number;",
      "export declare function experimental(input: boolean): boolean;",
    ]);

    const result = runFixture(root);

    expect(result.errors).toEqual([]);
    expect(result.summaries.map(({ code, name }) => [code, name])).toContainEqual([
      "deprecated-removal-eligible",
      "legacy",
    ]);
  });

  test("does not treat a prerelease as the stable removal version", () => {
    const root = fixture("0.9.0-beta.1");
    writeBaselineManifest(root);
    writeCoreDeclarations(root, [
      "export declare function frozen(input: string): string;",
      "export declare function stabilizing(input: number): number;",
      "export declare function experimental(input: boolean): boolean;",
    ]);

    const result = runFixture(root);

    expect(result.errors.map(({ code, name }) => [code, name])).toContainEqual([
      "deprecated-early-removal",
      "legacy",
    ]);
  });

  test("pins a D export's declared shape", () => {
    const root = fixture();
    writeBaselineManifest(root, {
      frozen: "D",
      stabilizing: "S",
      experimental: "X",
      legacy: "F",
    });
    writeCoreDeclarations(root, [
      "export declare function frozen(input: number): string;",
      "export declare function stabilizing(input: number): number;",
      "export declare function experimental(input: boolean): boolean;",
      "export declare const legacy: string;",
    ]);

    const result = runFixture(root);

    expect(result.errors.map(({ code, name }) => [code, name])).toContainEqual([
      "signature-mismatch",
      "frozen",
    ]);
  });
});

describe("declaration signatures", () => {
  test("normalizes declaration trivia without normalizing string literal contents", () => {
    const root = fixture();
    writeCoreDeclarations(root, [
      "export declare const spaced: 'two  spaces';",
    ]);
    const before = deriveGitDistReport(root, ["core"]).core[0]?.signature;

    writeCoreDeclarations(root, [
      "export /* formatting only */ declare const\nspaced : 'two  spaces' ;",
    ]);
    const after = deriveGitDistReport(root, ["core"]).core[0]?.signature;

    expect(after).toBe(before);
  });

  test("component signatures hash props only", () => {
    const root = mkdtempSync(join(tmpdir(), "thumbmux-contract-component-"));
    roots.push(root);
    mkdirSync(join(root, "git-dist/svelte"), { recursive: true });
    writeFileSync(
      join(root, "git-dist/svelte/index.d.ts"),
      "export { default as PublicWidget } from './Widget.svelte';\n",
    );
    const componentPath = join(root, "git-dist/svelte/Widget.svelte.d.ts");
    writeFileSync(componentPath, [
      "type Detail = { status: string };",
      "type Props = { label: string; detail: Detail };",
      "declare const Widget: import('svelte').Component<Props, { focus(): void }, ''>;",
      "export default Widget;",
      "",
    ].join("\n"));
    const before = deriveGitDistReport(root, ["svelte"]).svelte[0];

    writeFileSync(componentPath, [
      "type Detail = { status: string };",
      "type Props = { label: string; detail: Detail };",
      "declare const Widget: import('svelte').Component<Props, { blur(): void }, 'label'>;",
      "export default Widget;",
      "",
    ].join("\n"));
    const exposedChanged = deriveGitDistReport(root, ["svelte"]).svelte[0];

    writeFileSync(componentPath, [
      "type Detail = { status: number };",
      "type Props = { label: string; detail: Detail };",
      "declare const Widget: import('svelte').Component<Props, { blur(): void }, 'label'>;",
      "export default Widget;",
      "",
    ].join("\n"));
    const propsChanged = deriveGitDistReport(root, ["svelte"]).svelte[0];

    expect(before?.kind).toBe("component");
    expect(exposedChanged?.signature).toBe(before?.signature);
    expect(propsChanged?.signature).not.toBe(before?.signature);
  });

  test("follows non-exported declarations reachable from a public signature", () => {
    const root = fixture();
    writeCoreDeclarations(root, [
      "interface HiddenResult { code: string }",
      "export declare function publicResult(): HiddenResult;",
    ]);
    const before = deriveGitDistReport(root, ["core"]).core[0]?.signature;

    writeCoreDeclarations(root, [
      "interface HiddenResult { code: number }",
      "export declare function publicResult(): HiddenResult;",
    ]);
    const after = deriveGitDistReport(root, ["core"]).core[0]?.signature;

    expect(after).not.toBe(before);
  });

  test("does not hash private class implementation fields", () => {
    const root = fixture();
    writeCoreDeclarations(root, [
      "export declare class PublicClass { private firstSecret; read(): string; }",
    ]);
    const before = deriveGitDistReport(root, ["core"]).core[0]?.signature;

    writeCoreDeclarations(root, [
      "export declare class PublicClass { private renamedSecret; read(): string; }",
    ]);
    const after = deriveGitDistReport(root, ["core"]).core[0]?.signature;

    expect(after).toBe(before);
  });
});
