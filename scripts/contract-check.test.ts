import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkContract,
  deriveGitDistReport,
  evaluateBaseline,
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

function writeCoreDeclarations(
  root: string,
  declarations: string[],
  options: { stampLegacy?: boolean } = {},
): void {
  const stampLegacy = options.stampLegacy ?? true;
  const stamped = declarations.flatMap((declaration, index) => {
    if (
      stampLegacy
      && declaration.includes("export declare const legacy")
      && !declarations[index - 1]?.includes("@deprecated")
    ) {
      return [
        "/** @deprecated since v0.8.0 — use frozen; removal no earlier than v0.9.0 */",
        declaration,
      ];
    }
    return [declaration];
  });
  writeFileSync(join(root, "git-dist/core/index.d.ts"), `${stamped.join("\n")}\n`);
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
    name: entry.name,
    kind: entry.kind,
    signature: entry.signature,
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

function writeManifest(root: string, entries: readonly ContractEntry[]): void {
  writeFileSync(
    join(root, "contract/manifest/core.json"),
    `${JSON.stringify(entries, null, 2)}\n`,
  );
}

function runFixture(root: string, baselinePackageRoot?: string) {
  return checkContract({
    packageRoot: root,
    subpackages: ["core"],
    validateExportParity: false,
    ...(baselinePackageRoot ? { baselinePackageRoot } : {}),
  });
}

describe("contract surface policy", () => {
  test("immutable baseline rejects removal, signature authorization, and F demotion", () => {
    const baseline = fixture("0.8.4");
    const baselineEntries = writeBaselineManifest(baseline);

    const removed = fixture("0.8.5");
    writeCoreDeclarations(removed, [
      "export declare function stabilizing(input: number): number;",
      "export declare function experimental(input: boolean): boolean;",
      "export declare const legacy: string;",
    ]);
    writeManifest(removed, baselineEntries.filter(({ name }) => name !== "frozen"));
    expect(runFixture(removed, baseline).errors.map(({ code, name }) => [code, name]))
      .toContainEqual(["baseline-protected-removal", "frozen"]);

    const replaced = fixture("0.8.5");
    writeCoreDeclarations(replaced, [
      "export declare function frozen(input: number): string;",
      "export declare function stabilizing(input: number): number;",
      "export declare function experimental(input: boolean): boolean;",
      "export declare const legacy: string;",
    ]);
    writeBaselineManifest(replaced);
    expect(runFixture(replaced, baseline).errors.map(({ code, name }) => [code, name]))
      .toContainEqual(["baseline-signature-change", "frozen"]);

    const demoted = fixture("0.8.5");
    writeBaselineManifest(demoted, {
      frozen: "X",
      stabilizing: "S",
      experimental: "X",
      legacy: "F",
    });
    expect(runFixture(demoted, baseline).errors.map(({ code, name }) => [code, name]))
      .toContainEqual(["baseline-tier-weakening", "frozen"]);
  });

  test("X drift is rejected in a patch and allowed at a minor boundary", () => {
    const baseline = fixture("0.8.4");
    writeBaselineManifest(baseline);

    const patch = fixture("0.8.5");
    writeCoreDeclarations(patch, [
      "export declare function frozen(input: string): string;",
      "export declare function stabilizing(input: number): number;",
      "export declare function experimental(input: string): string;",
      "export declare const legacy: string;",
    ]);
    writeBaselineManifest(patch);
    expect(runFixture(patch, baseline).errors.map(({ code, name }) => [code, name]))
      .toContainEqual(["baseline-patch-change", "experimental"]);

    const minor = fixture("0.9.0");
    writeCoreDeclarations(minor, [
      "export declare function frozen(input: string): string;",
      "export declare function stabilizing(input: number): number;",
      "export declare function experimental(input: string): string;",
      "export declare const legacy: string;",
    ]);
    writeBaselineManifest(minor);
    expect(runFixture(minor, baseline).errors.map(({ code, name }) => [code, name]))
      .not.toContainEqual(["baseline-patch-change", "experimental"]);
  });

  test("an S route cannot be replaced at a minor boundary", () => {
    const baseline = fixture("0.8.4");
    writeBaselineManifest(baseline);

    const minor = fixture("0.9.0");
    writeCoreDeclarations(minor, [
      "export declare function frozen(input: string): string;",
      "export declare function stabilizing(input: string): string;",
      "export declare function experimental(input: boolean): boolean;",
      "export declare const legacy: string;",
    ]);
    writeBaselineManifest(minor);

    expect(runFixture(minor, baseline).errors.map(({ code, name }) => [code, name]))
      .toContainEqual(["baseline-signature-change", "stabilizing"]);
  });

  test("a minor may add optional members without weakening existing F members", () => {
    const baseline = fixture("0.8.4");
    writeCoreDeclarations(baseline, [
      "export interface frozen { required: string; oldOptional?: number }",
      "export declare function stabilizing(input: number): number;",
      "export declare function experimental(input: boolean): boolean;",
      "export declare const legacy: string;",
    ]);
    writeBaselineManifest(baseline);

    const additive = fixture("0.9.0");
    writeCoreDeclarations(additive, [
      "export interface frozen { required: string; oldOptional?: number; newHook?: () => void }",
      "export declare function stabilizing(input: number): number;",
      "export declare function experimental(input: boolean): boolean;",
      "export declare const legacy: string;",
    ]);
    writeBaselineManifest(additive);
    expect(runFixture(additive, baseline).errors.map(({ name }) => name)).not.toContain("frozen");

    const changed = fixture("0.9.0");
    writeCoreDeclarations(changed, [
      "export interface frozen { required: string; oldOptional?: string; newHook?: () => void }",
      "export declare function stabilizing(input: number): number;",
      "export declare function experimental(input: boolean): boolean;",
      "export declare const legacy: string;",
    ]);
    writeBaselineManifest(changed);
    expect(runFixture(changed, baseline).errors.map(({ code, name }) => [code, name]))
      .toContainEqual(["baseline-signature-change", "frozen"]);
  });

  test("optional-addition policy does not open closed results or existing optional types", () => {
    const closedBaseline = fixture("0.8.4");
    writeCoreDeclarations(closedBaseline, [
      "interface ClosedResult { required: string }",
      "export declare function frozen(): ClosedResult;",
      "export declare function stabilizing(input: number): number;",
      "export declare function experimental(input: boolean): boolean;",
      "export declare const legacy: string;",
    ]);
    writeBaselineManifest(closedBaseline);
    const closedCurrent = fixture("0.9.0");
    writeCoreDeclarations(closedCurrent, [
      "interface ClosedResult { required: string; newKey?: boolean }",
      "export declare function frozen(): ClosedResult;",
      "export declare function stabilizing(input: number): number;",
      "export declare function experimental(input: boolean): boolean;",
      "export declare const legacy: string;",
    ]);
    writeBaselineManifest(closedCurrent);
    expect(runFixture(closedCurrent, closedBaseline).errors.map(({ code, name }) => [code, name]))
      .toContainEqual(["baseline-signature-change", "frozen"]);

    const optionalBaseline = fixture("0.8.4");
    writeCoreDeclarations(optionalBaseline, [
      "interface Config { required: string }",
      "export interface frozen { config?: Config }",
      "export declare function stabilizing(input: number): number;",
      "export declare function experimental(input: boolean): boolean;",
      "export declare const legacy: string;",
    ]);
    writeBaselineManifest(optionalBaseline);
    const optionalCurrent = fixture("0.9.0");
    writeCoreDeclarations(optionalCurrent, [
      "interface Config { required: number }",
      "export interface frozen { config?: Config; newHook?: () => void }",
      "export declare function stabilizing(input: number): number;",
      "export declare function experimental(input: boolean): boolean;",
      "export declare const legacy: string;",
    ]);
    writeBaselineManifest(optionalCurrent);
    expect(runFixture(optionalCurrent, optionalBaseline).errors.map(({ code, name }) => [code, name]))
      .toContainEqual(["baseline-signature-change", "frozen"]);
  });

  test("a patch may declare a new export", () => {
    const baseline = fixture("0.8.4");
    writeBaselineManifest(baseline);

    // A name no prior artifact exported cannot be referenced by any consumer
    // compiled against it, so a patch carrying one breaks nothing. This rule
    // changed in 0.9.2 — it previously required a minor boundary, which the
    // releases had not followed since 0.8.2.
    const patch = fixture("0.8.5");
    writeCoreDeclarations(patch, [
      readFileSync(join(patch, "git-dist/core/index.d.ts"), "utf8").trimEnd(),
      "export declare const additiveInPatch: string;",
    ]);
    writeBaselineManifest(patch);
    expect(runFixture(patch, baseline).errors.map(({ code, name }) => [code, name]))
      .not.toContainEqual(["baseline-patch-change", "additiveInPatch"]);

    // The other direction — a retag must stay byte-identical because 1.0 claims
    // exactly that — is pinned by "the 1.0 boundary is an exact no-surface-delta
    // retag" below, which expects `onePointZeroSurprise` to error. Asserting it
    // twice would only give two places to update and one to forget.

    const minor = fixture("0.9.0");
    writeCoreDeclarations(minor, [
      readFileSync(join(minor, "git-dist/core/index.d.ts"), "utf8").trimEnd(),
      "export declare const additiveAtMinor: string;",
    ]);
    writeBaselineManifest(minor);
    expect(runFixture(minor, baseline).errors.map(({ code, name }) => [code, name]))
      .not.toContainEqual(["baseline-patch-change", "additiveAtMinor"]);
  });

  test("the 1.0 boundary is an exact no-surface-delta retag", () => {
    const baseline = fixture("0.9.9");
    writeBaselineManifest(baseline);

    const retag = fixture("1.0.0");
    writeCoreDeclarations(retag, [
      "export declare function frozen(input: string): string;",
      "export declare function stabilizing(input: number): number;",
      "export declare function experimental(input: string): string;",
      "export declare const legacy: string;",
      "export declare const onePointZeroSurprise: true;",
    ]);
    writeBaselineManifest(retag);

    const errors = runFixture(retag, baseline).errors.map(({ code, name }) => [code, name]);
    expect(errors).toContainEqual(["baseline-patch-change", "experimental"]);
    expect(errors).toContainEqual(["baseline-patch-change", "onePointZeroSurprise"]);
  });

  test("the 1.0 retag may strengthen tier labels without changing declarations", () => {
    const baseline = fixture("0.9.9");
    writeBaselineManifest(baseline, {
      frozen: "D",
      stabilizing: "S",
      experimental: "X",
      legacy: "F",
    });

    const retag = fixture("1.0.0");
    writeBaselineManifest(retag, {
      frozen: "F",
      stabilizing: "F",
      experimental: "F",
      legacy: "F",
    });

    expect(runFixture(retag, baseline).errors.map(({ code, name }) => [code, name]))
      .not.toEqual(expect.arrayContaining([
        ["baseline-tier-weakening", "frozen"],
        ["baseline-tier-weakening", "stabilizing"],
        ["baseline-tier-weakening", "experimental"],
      ]));
  });

  test("post-1.0 F declarations may break only at a new major", () => {
    const baseline = fixture("1.9.0");
    writeBaselineManifest(baseline);

    const major = fixture("2.0.0");
    writeCoreDeclarations(major, [
      "export declare function frozen(input: number): number;",
      "export declare function stabilizing(input: number): number;",
      "export declare function experimental(input: boolean): boolean;",
      "export declare const legacy: string;",
    ]);
    writeBaselineManifest(major);
    expect(runFixture(major, baseline).errors.map(({ code, name }) => [code, name]))
      .not.toContainEqual(["baseline-signature-change", "frozen"]);

    const minor = fixture("1.10.0");
    writeCoreDeclarations(minor, [
      "export declare function frozen(input: number): number;",
      "export declare function stabilizing(input: number): number;",
      "export declare function experimental(input: boolean): boolean;",
      "export declare const legacy: string;",
    ]);
    writeBaselineManifest(minor);
    expect(runFixture(minor, baseline).errors.map(({ code, name }) => [code, name]))
      .toContainEqual(["baseline-signature-change", "frozen"]);
  });

  test("v0.9.2 exceptions erase only the two exact optional additions", () => {
    const rootsFor = (subpath: "server" | "app") => {
      const baseline = mkdtempSync(join(tmpdir(), `thumbmux-${subpath}-baseline-`));
      const current = mkdtempSync(join(tmpdir(), `thumbmux-${subpath}-current-`));
      roots.push(baseline, current);
      mkdirSync(join(baseline, `git-dist/${subpath}`), { recursive: true });
      mkdirSync(join(current, `git-dist/${subpath}`), { recursive: true });
      return { baseline, current };
    };
    const manifestFor = (entries: ReturnType<typeof deriveGitDistReport>["server"]) =>
      entries.map(({ name, kind, signature }) => ({ name, kind, signature, tier: "S" as const }));

    const server = rootsFor("server");
    const writeServer = (root: string, member: string) => writeFileSync(
      join(root, "git-dist/server/index.d.ts"),
      [
        `export interface AppRoutesOptions { basePath?: string; ${member} }`,
        "export declare function createAppRoutes(options?: AppRoutesOptions): void;",
        "",
      ].join("\n"),
    );
    writeServer(server.baseline, "");
    writeServer(
      server.current,
      "projectSessionList?: (sessions: readonly SessionListItem[]) => readonly SessionListItem[];",
    );
    writeFileSync(
      join(server.baseline, "git-dist/server/session.d.ts"),
      "export interface SessionListItem { name: string }\n",
    );
    writeFileSync(
      join(server.current, "git-dist/server/session.d.ts"),
      "export interface SessionListItem { name: string }\n",
    );
    // Keep the fixture self-contained while retaining the exact reviewed type text.
    for (const root of [server.baseline, server.current]) {
      const path = join(root, "git-dist/server/index.d.ts");
      writeFileSync(path, `interface SessionListItem { name: string }\n${readFileSync(path, "utf8")}`);
    }
    const oldServer = deriveGitDistReport(server.baseline, ["server"]).server;
    const newServer = deriveGitDistReport(server.current, ["server"]).server;
    expect(evaluateBaseline(
      "server",
      manifestFor(oldServer),
      manifestFor(newServer),
      oldServer,
      newServer,
      "0.9.1",
      "0.9.2",
    ).errors).toEqual([]);

    writeServer(server.baseline, "nested?: { keep?: boolean; };");
    const nestedOldServer = deriveGitDistReport(server.baseline, ["server"]).server;
    writeServer(
      server.current,
      "nested?: { keep?: boolean; projectSessionList?: (sessions: readonly SessionListItem[]) => readonly SessionListItem[]; };",
    );
    const nestedServer = deriveGitDistReport(server.current, ["server"]).server;
    expect(evaluateBaseline(
      "server",
      manifestFor(nestedOldServer),
      manifestFor(nestedServer),
      nestedOldServer,
      nestedServer,
      "0.9.1",
      "0.9.2",
    ).errors).not.toEqual([]);

    writeServer(server.current, "projectSessionList?: string;");
    const badServer = deriveGitDistReport(server.current, ["server"]).server;
    expect(evaluateBaseline(
      "server",
      manifestFor(oldServer),
      manifestFor(badServer),
      oldServer,
      badServer,
      "0.9.1",
      "0.9.2",
    ).errors).not.toEqual([]);

    const app = rootsFor("app");
    const writeApp = (root: string, extra: string) => {
      writeFileSync(
        join(root, "git-dist/app/index.d.ts"),
        "export { default as EmbedView } from './EmbedView.svelte';\n",
      );
      writeFileSync(join(root, "git-dist/app/EmbedView.svelte.d.ts"), [
        `type Props = { session: string; ${extra} };`,
        "declare const EmbedView: import('svelte').Component<Props, {}, ''>;",
        "export default EmbedView;",
        "",
      ].join("\n"));
    };
    writeApp(app.baseline, "");
    writeApp(app.current, "claimGeometry?: boolean;");
    const oldApp = deriveGitDistReport(app.baseline, ["app"]).app;
    const newApp = deriveGitDistReport(app.current, ["app"]).app;
    expect(evaluateBaseline(
      "app",
      manifestFor(oldApp),
      manifestFor(newApp),
      oldApp,
      newApp,
      "0.9.1",
      "0.9.2",
    ).errors).toEqual([]);

    writeApp(app.baseline, "nested?: { keep?: boolean };");
    const nestedOldApp = deriveGitDistReport(app.baseline, ["app"]).app;
    writeApp(app.current, "nested?: { keep?: boolean; claimGeometry?: boolean };");
    const nestedApp = deriveGitDistReport(app.current, ["app"]).app;
    expect(evaluateBaseline(
      "app",
      manifestFor(nestedOldApp),
      manifestFor(nestedApp),
      nestedOldApp,
      nestedApp,
      "0.9.1",
      "0.9.2",
    ).errors).not.toEqual([]);

    writeApp(app.current, "claimGeometry: boolean;");
    const badApp = deriveGitDistReport(app.current, ["app"]).app;
    expect(evaluateBaseline(
      "app",
      manifestFor(oldApp),
      manifestFor(badApp),
      oldApp,
      badApp,
      "0.9.1",
      "0.9.2",
    ).errors).not.toEqual([]);
  });

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
      ["deprecated-replacement-missing", "legacy"],
      ["signature-mismatch", "stabilizing"],
    ]);
  });

  test("rejects a new public name until its manifest entry declares a tier", () => {
    const root = fixture();
    writeBaselineManifest(root);
    writeCoreDeclarations(root, [
      readFileSync(join(root, "git-dist/core/index.d.ts"), "utf8").trimEnd(),
      "export declare const surprise: number;",
    ], { stampLegacy: false });

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

  test("rejects incomplete declaration, replacement, and removal-window ceremony", () => {
    const root = fixture("0.8.6");
    writeCoreDeclarations(root, [
      "export declare function frozen(input: string): string;",
      "export declare function stabilizing(input: number): number;",
      "export declare function experimental(input: boolean): boolean;",
      "export declare const legacy: string;",
    ], { stampLegacy: false });
    const entries = writeBaselineManifest(root).map((entry) => entry.name === "legacy"
      ? {
          ...entry,
          deprecated: {
            since: "0.8.5",
            removeNoEarlierThan: "0.8.6",
            replacement: "doesNotExist",
          },
        }
      : entry);
    writeManifest(root, entries);

    const result = runFixture(root);
    expect(result.errors.map(({ code, name }) => [code, name])).toEqual(expect.arrayContaining([
      ["deprecated-declaration-missing", "legacy"],
      ["deprecated-replacement-missing", "legacy"],
      ["deprecated-window-invalid", "legacy"],
    ]));
  });

  test("requires manifest metadata for every emitted deprecated declaration", () => {
    const root = fixture("0.8.6");
    writeCoreDeclarations(root, [
      "/** @deprecated since v0.8.6 — use stabilizing; removal no earlier than v0.9.0 */",
      "export declare function frozen(input: string): string;",
      "export declare function stabilizing(input: number): number;",
      "export declare function experimental(input: boolean): boolean;",
      "export declare const legacy: string;",
    ]);
    writeBaselineManifest(root);

    expect(runFixture(root).errors.map(({ code, name }) => [code, name]))
      .toContainEqual(["deprecated-manifest-missing", "frozen"]);
  });

  test("new deprecation metadata starts at the current release", () => {
    const baseline = fixture("0.9.1");
    writeBaselineManifest(baseline);

    const current = fixture("0.9.2");
    writeCoreDeclarations(current, [
      "export declare function frozen(input: string): string;",
      "/** @deprecated since v0.8.0 — use frozen; removal no earlier than v0.9.0 */",
      "export declare function stabilizing(input: number): number;",
      "export declare function experimental(input: boolean): boolean;",
      "export declare const legacy: string;",
    ]);
    const entries = writeBaselineManifest(current).map((entry) => entry.name === "stabilizing"
      ? {
          ...entry,
          deprecated: {
            since: "0.8.0",
            removeNoEarlierThan: "0.9.0",
            replacement: "frozen",
          },
        }
      : entry);
    writeManifest(current, entries);

    expect(runFixture(current, baseline).errors.map(({ code, name }) => [code, name]))
      .toContainEqual(["deprecated-since-version-mismatch", "stabilizing"]);
  });

  test("a newly exported deprecated name cannot backdate its warning window", () => {
    const baseline = fixture("0.9.1");
    writeBaselineManifest(baseline);

    const current = fixture("0.10.0");
    writeCoreDeclarations(current, [
      readFileSync(join(current, "git-dist/core/index.d.ts"), "utf8").trimEnd(),
      "/** @deprecated since v0.8.0 — use frozen; removal no earlier than v0.9.0 */",
      "export declare const backdated: string;",
    ], { stampLegacy: false });
    const entries = writeBaselineManifest(current).map((entry) => entry.name === "backdated"
      ? {
          ...entry,
          deprecated: {
            since: "0.8.0",
            removeNoEarlierThan: "0.9.0",
            replacement: "frozen",
          },
        }
      : entry);
    writeManifest(current, entries);

    expect(runFixture(current, baseline).errors.map(({ code, name }) => [code, name]))
      .toContainEqual(["deprecated-since-version-mismatch", "backdated"]);
  });

  test("a due deprecated name cannot disappear at the same published version", () => {
    const baseline = fixture("0.9.0");
    const baselineEntries = writeBaselineManifest(baseline);

    const current = fixture("0.9.0");
    writeCoreDeclarations(current, [
      "export declare function frozen(input: string): string;",
      "export declare function stabilizing(input: number): number;",
      "export declare function experimental(input: boolean): boolean;",
    ]);
    writeManifest(current, baselineEntries.filter(({ name }) => name !== "legacy"));

    expect(runFixture(current, baseline).errors.map(({ code, name }) => [code, name]))
      .toContainEqual(["baseline-protected-removal", "legacy"]);
  });

  test("accepts a complete declaration deprecation ceremony", () => {
    const root = fixture("0.8.6");
    writeCoreDeclarations(root, [
      "export declare function frozen(input: string): string;",
      "export declare function stabilizing(input: number): number;",
      "export declare function experimental(input: boolean): boolean;",
      "/** @deprecated since v0.8.5 — use frozen; removal no earlier than v0.9.0 */",
      "export declare const legacy: string;",
    ]);
    const entries = writeBaselineManifest(root).map((entry) => entry.name === "legacy"
      ? {
          ...entry,
          deprecated: {
            since: "0.8.5",
            removeNoEarlierThan: "0.9.0",
            replacement: "frozen",
          },
        }
      : entry);
    writeManifest(root, entries);

    expect(runFixture(root).errors.filter(({ code }) => code.startsWith("deprecated-")))
      .toEqual([]);
  });

  test("a new deprecation replacement must preserve the old consumer shape", () => {
    const root = fixture("0.8.6");
    writeCoreDeclarations(root, [
      "/** @deprecated since v0.8.6 — use stabilizing; removal no earlier than v0.9.0 */",
      "export declare function frozen(input: string): string;",
      "export declare function stabilizing(input: number): number;",
      "export declare function experimental(input: boolean): boolean;",
      "export declare const legacy: string;",
    ]);
    const entries = writeBaselineManifest(root).map((entry) => entry.name === "frozen"
      ? {
          ...entry,
          deprecated: {
            since: "0.8.6",
            removeNoEarlierThan: "0.9.0",
            replacement: "stabilizing",
          },
        }
      : entry);
    writeManifest(root, entries);

    expect(runFixture(root).errors.map(({ code, name }) => [code, name]))
      .toContainEqual(["deprecated-replacement-incompatible", "frozen"]);
  });

  test("accepts a stamped export alias as the compatibility replacement", () => {
    const root = fixture("0.8.6");
    writeCoreDeclarations(root, [
      "export declare function replacement(input: string): string;",
      "/** @deprecated since v0.8.6 — use replacement; removal no earlier than v0.9.0 */",
      "export { replacement as oldAlias };",
    ], { stampLegacy: false });
    const entries = writeBaselineManifest(root).map((entry) => entry.name === "oldAlias"
      ? {
          ...entry,
          deprecated: {
            since: "0.8.6",
            removeNoEarlierThan: "0.9.0",
            replacement: "replacement",
          },
        }
      : entry);
    writeManifest(root, entries);

    expect(runFixture(root).errors.filter(({ code }) => code.startsWith("deprecated-")))
      .toEqual([]);
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

  test("compatibility signatures include component defaults, exports, and bindings", () => {
    const root = mkdtempSync(join(tmpdir(), "thumbmux-contract-component-rich-"));
    roots.push(root);
    mkdirSync(join(root, "git-dist/svelte"), { recursive: true });
    writeFileSync(
      join(root, "git-dist/svelte/index.d.ts"),
      "export { default as PublicWidget } from './Widget.svelte';\n",
    );
    const componentPath = join(root, "git-dist/svelte/Widget.svelte.d.ts");
    const writeComponent = (defaultType: string, exported: string, bindings: string) => {
      writeFileSync(componentPath, [
        `type Props<T = ${defaultType}> = { value: T };`,
        `declare const Widget: import('svelte').Component<Props, ${exported}, ${bindings}>;`,
        "export default Widget;",
        "",
      ].join("\n"));
    };
    writeComponent("string", "{ focus(): void }", "''");
    const before = deriveGitDistReport(root, ["svelte"]).svelte[0]?.compatibilitySignature;

    writeComponent("number", "{ focus(): void }", "''");
    const defaultChanged = deriveGitDistReport(root, ["svelte"]).svelte[0]
      ?.compatibilitySignature;
    writeComponent("string", "{ blur(): void }", "'value'");
    const exposedChanged = deriveGitDistReport(root, ["svelte"]).svelte[0]
      ?.compatibilitySignature;

    expect(defaultChanged).not.toBe(before);
    expect(exposedChanged).not.toBe(before);
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

  test("compatibility signatures follow import-module and namespace return shapes", () => {
    const root = fixture();
    writeCoreDeclarations(root, [
      'export declare function imported(): typeof import("./internal");',
      "declare namespace Hidden { const value: string }",
      "export declare function namespaced(): typeof Hidden;",
    ]);
    writeFileSync(join(root, "git-dist/core/internal.d.ts"), "export declare const value: string;\n");
    const before = new Map(deriveGitDistReport(root, ["core"]).core.map((entry) => [
      entry.name,
      entry.compatibilitySignature,
    ]));

    writeCoreDeclarations(root, [
      'export declare function imported(): typeof import("./internal");',
      "declare namespace Hidden { const value: number }",
      "export declare function namespaced(): typeof Hidden;",
    ]);
    writeFileSync(join(root, "git-dist/core/internal.d.ts"), "export declare const value: number;\n");
    const after = new Map(deriveGitDistReport(root, ["core"]).core.map((entry) => [
      entry.name,
      entry.compatibilitySignature,
    ]));

    expect(after.get("imported")).not.toBe(before.get("imported"));
    expect(after.get("namespaced")).not.toBe(before.get("namespaced"));
  });

  test("import-module compatibility includes ambient declarations exposed by a d.ts module", () => {
    const root = fixture();
    writeCoreDeclarations(root, [
      'export declare function imported(): typeof import("./internal");',
    ]);
    const internal = join(root, "git-dist/core/internal.d.ts");
    writeFileSync(internal, [
      "export declare const visible: string;",
      "declare const privateOnly: string;",
      "",
    ].join("\n"));
    const before = deriveGitDistReport(root, ["core"]).core[0]?.compatibilitySignature;

    writeFileSync(internal, [
      "export declare const visible: string;",
      "declare const privateOnly: number;",
      "",
    ].join("\n"));
    const ambientChanged = deriveGitDistReport(root, ["core"]).core[0]?.compatibilitySignature;
    expect(ambientChanged).not.toBe(before);

    writeFileSync(internal, [
      "export declare const visible: number;",
      "declare const privateOnly: number;",
      "",
    ].join("\n"));
    const publicChanged = deriveGitDistReport(root, ["core"]).core[0]?.compatibilitySignature;
    expect(publicChanged).not.toBe(before);
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
