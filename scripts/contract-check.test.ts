import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import ts from "typescript";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { prepareReleasePackage } from "./prepare-release-package";
import { assertReleaseVersion } from "./check-release-version";
import {
  assertRuntimeDisplayExport,
  checkContract,
  deriveGitDistReport,
  evaluateBaseline,
  resolveBaselineMode,
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

  test("an X optional addition may ride a patch, but an X rewrite still cannot", () => {
    const baseline = fixture("0.8.4");
    writeCoreDeclarations(baseline, [
      "export declare function frozen(input: string): string;",
      "export declare function stabilizing(input: number): number;",
      "export interface experimental { required: string }",
      "export declare const legacy: string;",
    ]);
    writeBaselineManifest(baseline);

    const additive = fixture("0.8.5");
    writeCoreDeclarations(additive, [
      "export declare function frozen(input: string): string;",
      "export declare function stabilizing(input: number): number;",
      "export interface experimental { required: string; added?: boolean }",
      "export declare const legacy: string;",
    ]);
    writeBaselineManifest(additive);
    expect(runFixture(additive, baseline).errors.map(({ code, name }) => [code, name]))
      .not.toContainEqual(["baseline-patch-change", "experimental"]);

    const rewritten = fixture("0.8.5");
    writeCoreDeclarations(rewritten, [
      "export declare function frozen(input: string): string;",
      "export declare function stabilizing(input: number): number;",
      "export interface experimental { required: number }",
      "export declare const legacy: string;",
    ]);
    writeBaselineManifest(rewritten);
    expect(runFixture(rewritten, baseline).errors.map(({ code, name }) => [code, name]))
      .toContainEqual(["baseline-patch-change", "experimental"]);
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

  test("the v0.18 reviewed additions require the exact release and digest pair", () => {
    const name = "TmuxDriver";
    const baselineDigest = "31a1557c524f410f91b43202343d0496bd89cb9e2c3335c6972abf62c2a4c62e";
    const reviewedDigest = "6b15203b589dccd2acc8102af15f3d40b82d2b52bcbb909656553275185393f2";
    const manifest: ContractEntry[] = [{
      name,
      kind: "type",
      signature: baselineDigest,
      tier: "F",
    }];
    const baselineLive = [{
      name,
      kind: "type" as const,
      signature: baselineDigest,
      compatibilitySignature: baselineDigest,
    }];
    const currentLive = [{
      name,
      kind: "type" as const,
      signature: reviewedDigest,
      compatibilitySignature: reviewedDigest,
    }];

    expect(evaluateBaseline(
      "server",
      manifest,
      manifest,
      baselineLive,
      currentLive,
      "0.17.0",
      "0.18.0",
    ).errors).toEqual([]);

    const wrongDigest = [{
      ...currentLive[0]!,
      compatibilitySignature: `${reviewedDigest.slice(0, -1)}0`,
    }];
    expect(evaluateBaseline(
      "server",
      manifest,
      manifest,
      baselineLive,
      wrongDigest,
      "0.17.0",
      "0.18.0",
    ).errors.map(({ code, name: exportName }) => [code, exportName]))
      .toContainEqual(["baseline-signature-change", name]);

    expect(evaluateBaseline(
      "server",
      manifest,
      manifest,
      baselineLive,
      currentLive,
      "0.17.0",
      "0.18.1",
    ).errors.map(({ code, name: exportName }) => [code, exportName]))
      .toContainEqual(["baseline-signature-change", name]);
  });

  test("the v0.18.6 nested upload additions require the exact patch and digest pair", () => {
    const name = "AppAdapters";
    const baselineDigest = "4daaa8569401f924d83ae1d3ed7efde5c7744969ca10decc4bc4d29ca51f8f37";
    const reviewedDigest = "94a4200917228a4cdfb183dd31d6a37b9c437b1a4e9f9d71ccd0e571d1431b4b";
    const manifest: ContractEntry[] = [{
      name,
      kind: "type",
      signature: baselineDigest,
      tier: "S",
    }];
    const baselineLive = [{
      name,
      kind: "type" as const,
      signature: baselineDigest,
      compatibilitySignature: baselineDigest,
    }];
    const currentLive = [{
      name,
      kind: "type" as const,
      signature: reviewedDigest,
      compatibilitySignature: reviewedDigest,
    }];

    expect(evaluateBaseline(
      "app",
      manifest,
      manifest,
      baselineLive,
      currentLive,
      "0.18.5",
      "0.18.6",
    ).errors).toEqual([]);

    const wrongDigest = [{
      ...currentLive[0]!,
      compatibilitySignature: `${reviewedDigest.slice(0, -1)}0`,
    }];
    expect(evaluateBaseline(
      "app",
      manifest,
      manifest,
      baselineLive,
      wrongDigest,
      "0.18.5",
      "0.18.6",
    ).errors.map(({ code, name: exportName }) => [code, exportName]))
      .toContainEqual(["baseline-signature-change", name]);

    expect(evaluateBaseline(
      "app",
      manifest,
      manifest,
      baselineLive,
      currentLive,
      "0.18.5",
      "0.18.7",
    ).errors.map(({ code, name: exportName }) => [code, exportName]))
      .toContainEqual(["baseline-signature-change", name]);
  });

  test("the v0.18.16 public session-list push requires the exact patch and digest pair", () => {
    const name = "TmuxWsMux";
    const baselineDigest = "5fab451dd0c8f853304b66a5ebe2654661cde7773dad0c11219f5553a2a52873";
    const reviewedDigest = "b56a5adebfc41698659299d151810ca4f52d01eadf5df4659073716219fa0782";
    const manifest: ContractEntry[] = [{
      name,
      kind: "value",
      signature: reviewedDigest,
      tier: "F",
    }];
    const baselineLive = [{
      name,
      kind: "value" as const,
      signature: baselineDigest,
      compatibilitySignature: baselineDigest,
    }];
    const currentLive = [{
      name,
      kind: "value" as const,
      signature: reviewedDigest,
      compatibilitySignature: reviewedDigest,
    }];

    expect(evaluateBaseline(
      "server",
      [{ ...manifest[0]!, signature: baselineDigest }],
      manifest,
      baselineLive,
      currentLive,
      "0.18.13",
      "0.18.16",
    ).errors).toEqual([]);

    const wrongDigest = [{
      ...currentLive[0]!,
      compatibilitySignature: `${reviewedDigest.slice(0, -1)}0`,
    }];
    expect(evaluateBaseline(
      "server",
      [{ ...manifest[0]!, signature: baselineDigest }],
      manifest,
      baselineLive,
      wrongDigest,
      "0.18.13",
      "0.18.16",
    ).errors.map(({ code, name: exportName }) => [code, exportName]))
      .toContainEqual(["baseline-signature-change", name]);

    expect(evaluateBaseline(
      "server",
      [{ ...manifest[0]!, signature: baselineDigest }],
      manifest,
      baselineLive,
      currentLive,
      "0.18.13",
      "0.18.17",
    ).errors.map(({ code, name: exportName }) => [code, exportName]))
      .toContainEqual(["baseline-signature-change", name]);
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

  test("an optional member added to a type alias is as additive as one on an interface", () => {
    // The proof strips optional properties and requires the rest to be identical.
    // `type X = { a?: T }` is the same contract as `interface X { a?: T }`, and it
    // was rejected for years only because the owner filter read interfaces alone.
    const baseline = fixture("0.9.2");
    writeCoreDeclarations(baseline, [
      "export type frozen = { channel: string; cursor?: number };",
      "export declare function stabilizing(input: number): number;",
      "export declare function experimental(input: boolean): boolean;",
      "export declare const legacy: string;",
    ]);
    writeBaselineManifest(baseline);

    const current = fixture("0.10.0");
    writeCoreDeclarations(current, [
      "export type frozen = { channel: string; cursor?: number; screen?: boolean };",
      "export declare function stabilizing(input: number): number;",
      "export declare function experimental(input: boolean): boolean;",
      "export declare const legacy: string;",
    ]);
    writeBaselineManifest(current);
    expect(runFixture(current, baseline).errors.map(({ code, name }) => [code, name]))
      .not.toContainEqual(["baseline-signature-change", "frozen"]);
  });

  test("a type alias that gains a REQUIRED member is still a break", () => {
    const baseline = fixture("0.9.2");
    writeCoreDeclarations(baseline, [
      "export type frozen = { channel: string; cursor?: number };",
      "export declare function stabilizing(input: number): number;",
      "export declare function experimental(input: boolean): boolean;",
      "export declare const legacy: string;",
    ]);
    writeBaselineManifest(baseline);

    const current = fixture("0.10.0");
    writeCoreDeclarations(current, [
      "export type frozen = { channel: string; cursor?: number; screen: boolean };",
      "export declare function stabilizing(input: number): number;",
      "export declare function experimental(input: boolean): boolean;",
      "export declare const legacy: string;",
    ]);
    writeBaselineManifest(current);
    expect(runFixture(current, baseline).errors.map(({ code, name }) => [code, name]))
      .toContainEqual(["baseline-signature-change", "frozen"]);
  });

  test("dropping an optional member from a type alias is still a break", () => {
    const baseline = fixture("0.9.2");
    writeCoreDeclarations(baseline, [
      "export type frozen = { channel: string; cursor?: number };",
      "export declare function stabilizing(input: number): number;",
      "export declare function experimental(input: boolean): boolean;",
      "export declare const legacy: string;",
    ]);
    writeBaselineManifest(baseline);

    const current = fixture("0.10.0");
    writeCoreDeclarations(current, [
      "export type frozen = { channel: string };",
      "export declare function stabilizing(input: number): number;",
      "export declare function experimental(input: boolean): boolean;",
      "export declare const legacy: string;",
    ]);
    writeBaselineManifest(current);
    expect(runFixture(current, baseline).errors.map(({ code, name }) => [code, name]))
      .toContainEqual(["baseline-signature-change", "frozen"]);
  });

  test("an optional member added to a REFERENCED type alias is additive too", () => {
    // A dependency was never strippable, so a dependent could not be proven
    // additive when the type it referenced gained an optional member.
    const baseline = fixture("0.9.2");
    writeCoreDeclarations(baseline, [
      "type Payload = { channel: string; cursor?: number };",
      "export type frozen = Payload | { type: \"pong\" };",
      "export declare function stabilizing(input: number): number;",
      "export declare function experimental(input: boolean): boolean;",
      "export declare const legacy: string;",
    ]);
    writeBaselineManifest(baseline);

    const current = fixture("0.10.0");
    writeCoreDeclarations(current, [
      "type Payload = { channel: string; cursor?: number; screen?: boolean };",
      "export type frozen = Payload | { type: \"pong\" };",
      "export declare function stabilizing(input: number): number;",
      "export declare function experimental(input: boolean): boolean;",
      "export declare const legacy: string;",
    ]);
    writeBaselineManifest(current);
    expect(runFixture(current, baseline).errors.map(({ code, name }) => [code, name]))
      .not.toContainEqual(["baseline-signature-change", "frozen"]);
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
    writeComponent("string", "{ focus(): void }", "'open' | 'text' | 'mode'");
    const bindingsBefore = deriveGitDistReport(root, ["svelte"]).svelte[0]
      ?.compatibilitySignature;
    writeComponent("string", "{ focus(): void }", "'open' | 'mode' | 'text'");
    const bindingsReordered = deriveGitDistReport(root, ["svelte"]).svelte[0]
      ?.compatibilitySignature;
    writeComponent("string", "{ focus(): void }", "'open' | 'mode'");
    const bindingRemoved = deriveGitDistReport(root, ["svelte"]).svelte[0]
      ?.compatibilitySignature;

    expect(defaultChanged).not.toBe(before);
    expect(exposedChanged).not.toBe(before);
    expect(bindingsReordered).toBe(bindingsBefore);
    expect(bindingRemoved).not.toBe(bindingsBefore);
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
      "export declare class PublicClass { private renamedSecret; private handleProjectionRouteChange; read(): string; }",
    ]);
    const after = deriveGitDistReport(root, ["core"]).core[0]?.signature;

    expect(after).toBe(before);
    writeCoreDeclarations(root, [
      "export declare class PublicClass { private renamedSecret; handleProjectionRouteChange(session: string): void; read(): string; }",
    ]);
    expect(deriveGitDistReport(root, ["core"]).core[0]?.signature).not.toBe(before);
  });
});

describe("optional additions inside a referenced type", () => {
  /** Build a fixture whose only export is an interface holding an optional
   *  property typed as a second interface — the shape that matters, because a
   *  type reached ONLY through an optional property is never reached by the
   *  stripped base traversal. */
  function referencedOptionalFixture(version: string, nested: string[]): string {
    const root = fixture(version);
    writeCoreDeclarations(root, [
      "export interface Nested {",
      "  required: string;",
      ...nested,
      "}",
      "export interface Holder {",
      "  base: string;",
      "  nested?: Nested;",
      "}",
    ], { stampLegacy: false });
    return root;
  }

  function evaluate(baselineRoot: string, currentRoot: string) {
    const baselineManifest = deriveGitDistReport(baselineRoot, ["core"]).core.map((entry) => ({
      name: entry.name,
      kind: entry.kind,
      signature: entry.signature,
      tier: "F" as ContractTier,
    }));
    const currentLive = deriveGitDistReport(currentRoot, ["core"]).core;
    const currentManifest = currentLive.map((entry) => ({
      name: entry.name,
      kind: entry.kind,
      signature: entry.signature,
      tier: "F" as ContractTier,
    }));
    return evaluateBaseline(
      "core",
      baselineManifest,
      currentManifest,
      deriveGitDistReport(baselineRoot, ["core"]).core,
      currentLive,
      "0.11.2",
      "0.12.0",
    );
  }

  test("adding an optional to the referenced type is additive for its holder", () => {
    const before = referencedOptionalFixture("0.11.2", []);
    const after = referencedOptionalFixture("0.12.0", ["  added?: boolean;"]);
    const result = evaluate(before, after);
    expect(result.errors.map((error) => error.message)).toEqual([]);
  });

  test("removing an optional from the referenced type still fails", () => {
    const before = referencedOptionalFixture("0.11.2", ["  existing?: boolean;"]);
    const after = referencedOptionalFixture("0.12.0", []);
    const messages = evaluate(before, after).errors.map((error) => error.message);
    // Both the type that lost the member and the holder that reaches it.
    expect(messages.some((message) => message.includes('"Nested"'))).toBe(true);
    expect(messages.some((message) => message.includes('"Holder"'))).toBe(true);
  });

  test("narrowing a required member of the referenced type still fails", () => {
    const before = referencedOptionalFixture("0.11.2", []);
    const after = fixture("0.12.0");
    writeCoreDeclarations(after, [
      "export interface Nested {",
      "  required: number;",
      "}",
      "export interface Holder {",
      "  base: string;",
      "  nested?: Nested;",
      "}",
    ], { stampLegacy: false });
    const messages = evaluate(before, after).errors.map((error) => error.message);
    expect(messages.some((message) => message.includes('"Holder"'))).toBe(true);
  });
});

test("a missing immutable baseline is an error, not a silent skip", () => {
  // The baseline block answers "did a frozen name change"; the surface gate only
  // answers "is every name declared". Skipping the first one silently printed
  // the same success line as a full run, and that false all-clear was reported
  // to a human once already.
  const missing = resolveBaselineMode({});
  expect(missing.error).toContain("THUMBMUX_CONTRACT_BASELINE_ROOT");
  expect(missing.skipped).toBe(false);
});

test("a baseline root is used when supplied", () => {
  const supplied = resolveBaselineMode({ THUMBMUX_CONTRACT_BASELINE_ROOT: "/tmp/baseline" });
  expect(supplied.baselinePackageRoot).toBe("/tmp/baseline");
  expect(supplied.skipped).toBe(false);
  expect(supplied.error).toBeUndefined();
});

test("the old baseline opt-out cannot bypass immutable comparison", () => {
  const skipped = resolveBaselineMode({ THUMBMUX_CONTRACT_BASELINE: "skip" });
  expect(skipped.skipped).toBe(false);
  expect(skipped.error).toContain("THUMBMUX_CONTRACT_BASELINE_ROOT");
  // Neither old spelling bypasses the required immutable baseline.
  expect(resolveBaselineMode({ THUMBMUX_CONTRACT_BASELINE: "yes" }).error).toBeTruthy();
});

test("an empty baseline root is treated as absent rather than as a directory", () => {
  expect(resolveBaselineMode({ THUMBMUX_CONTRACT_BASELINE_ROOT: "   " }).error).toBeTruthy();
});

// Independent digests generated from the two reviewed artifacts, not read back
// from the authorization table. No optional-addition model: exercise the pin.
describe("0.20.3 reviewed optional graph additions", () => {
  const cases = [
  {
    "pair": "app:AppAdapters:ff0496b7d15e989b9b76bf23dc55f293b46b5e3a64ef027d6e7e938b4b6acecc:5eec4498dd463722cf26d8dc6d44e35f123287fa62eed1bde57673b2ecabb2e0",
    "tier": "S",
    "kind": "type"
  },
  {
    "pair": "app:EmbedView:c69f8218441df93163845a633976e77393d6d3cf663d32f9c92067c4b75730b0:46f7f6c8a7bef4d8ed33468c252ad22b3180d78ed6896b4db2e2e915c5e7fcb7",
    "tier": "S",
    "kind": "component"
  },
  {
    "pair": "app:HubView:4fc5b44e79b19361b04f4c7b9b73380de5675c6b2d5cbf9a02482ba1ffb37395:e98a99dfa1891ebef3e78dd26b6485c7687ccb44808042e23aac9ac9f4e8b702",
    "tier": "S",
    "kind": "component"
  },
  {
    "pair": "app:SessionView:9ce1975f811d2a8c9c014b43ab64574b2f41861db67c17f89d7af19eb550e7ab:e8a4c3c6399bbee28663b068d9572ece989d78ee7c89b3587fbbec40a33bbb8b",
    "tier": "S",
    "kind": "component"
  },
  {
    "pair": "app:ThumbmuxApp:722f87982a8855cd0c866bc052a6d107f09e7fd261be46e147dbf952f6ae78f7:6f6e2591a5f4154d627d630a21302dbdc22e385dcde546d9291759017c815c18",
    "tier": "S",
    "kind": "component"
  },
  {
    "pair": "app:createSessionsStore:a0e779ba22b195a125bddc92471833c9cda88bb551096004c5e735e37a216bc7:320b7698efd9586312a113ebdcfe0ffca1dcfff8b5af3c2cd67f04ed3b434afc",
    "tier": "S",
    "kind": "value"
  },
  {
    "pair": "server:AppRoutes:fe42014191714e58106a980ce7be95346ef9c3475a9baa670328606a983ee0b2:bf2781650331649829f6cd26221c47f86cef6c9b049cb4d92686bd7f22e25c33",
    "tier": "S",
    "kind": "type"
  },
  {
    "pair": "server:AppRoutesOptions:77425c95e25bdfbf6d7135febdf15becb3c28e0c0e0e880b5a924ff013f2a053:c42593b8bb94c0f8ca9c7ad55e42f5b508990f091467bc64c764bea96a5ef7a2",
    "tier": "S",
    "kind": "type"
  },
  {
    "pair": "server:TmuxWsMux:ccce251f320b964b0ba227756d8b5fcbd5e3ef2c61b2382d1cc49927b3fd7821:32d590ee6e9e014949d780b3709e93087d92e203f962e3c0d3b72b35f1daf7b8",
    "tier": "F",
    "kind": "value"
  },
  {
    "pair": "server:TmuxWsMuxOptions:c773fec3a455782ce9dc482157303fa0a341e29cb344ec899308951ea5f8adc1:4babcf10cd875dd8965e6afede1adce81b70be54e456e9ba9791146f1404fb57",
    "tier": "F",
    "kind": "type"
  },
  {
    "pair": "server:createAppRoutes:f3542c4ae9ee4a2ed20e740de1d78eedce04a95419aa39e191d921be04ae82e5:1d34d34dbbfb7c22edd28ae3145dc8de8590ce887de93e31a2fed79825da823a",
    "tier": "S",
    "kind": "value"
  }
] as const;
  for (const { pair, tier, kind } of cases) {
    test(pair.split(":").slice(0, 2).join(":"), () => {
      const [subpath, name, before, after] = pair.split(":") as ["server" | "app", string, string, string];
      const oldEntry = { name, kind, tier, signature: before, compatibilitySignature: before };
      const newEntry = { name, kind, tier, signature: after, compatibilitySignature: after };
      const run = (oldLive = oldEntry, newLive = newEntry, oldVersion = "0.20.2", newVersion = "0.20.3") =>
        evaluateBaseline(subpath, [oldEntry], [newEntry], [oldLive], [newLive], oldVersion, newVersion).errors;
      expect(run()).toEqual([]);
      expect(run(oldEntry, { ...newEntry, compatibilitySignature: "narrowed-unreviewed-declaration" }))
        .toEqual(expect.arrayContaining([expect.objectContaining({ code: "baseline-signature-change" })]));
      expect(run({ ...oldEntry, compatibilitySignature: "different-prior-artifact" }))
        .toEqual(expect.arrayContaining([expect.objectContaining({ code: "baseline-signature-change" })]));
      expect(run(oldEntry, newEntry, "0.20.1"))
        .toEqual(expect.arrayContaining([expect.objectContaining({ code: "baseline-signature-change" })]));
      expect(run(oldEntry, newEntry, "0.20.2", "0.20.4"))
        .toEqual(expect.arrayContaining([expect.objectContaining({ code: "baseline-signature-change" })]));
      expect(evaluateBaseline(subpath, [oldEntry], [], [oldEntry], [], "0.20.2", "0.20.3").errors)
        .toEqual(expect.arrayContaining([expect.objectContaining({ code: "baseline-protected-removal" })]));
    });
  }
});

describe("0.20.5 reviewed createBunTmuxDriver return widening", () => {
  // Pair copied from the two artifacts (v0.20.4-dist baseline, 0.20.5 git-dist),
  // not read back from V0205_REVIEWED_ADDITIONS, so the gate and this test hold
  // separate copies.
  const pair = "server:createBunTmuxDriver:5794c580d54ac2143b9d42aac0cbc2b93ae27ee9f2d019e55938caff91d9bb06:3efb16f11cae1e6712b1a96e3871bc1949d5becbe732ce43f2a08a22ce391e0b";
  test(pair.split(":").slice(0, 2).join(":"), () => {
    const [subpath, name, before, after] = pair.split(":") as ["server", string, string, string];
    const oldEntry = { name, kind: "value" as const, tier: "F" as const, signature: before, compatibilitySignature: before };
    const newEntry = { name, kind: "value" as const, tier: "F" as const, signature: after, compatibilitySignature: after };
    const run = (oldLive = oldEntry, newLive = newEntry, oldVersion = "0.20.4", newVersion = "0.20.5") =>
      evaluateBaseline(subpath, [oldEntry], [newEntry], [oldLive], [newLive], oldVersion, newVersion).errors;
    expect(run()).toEqual([]);
    expect(run(oldEntry, { ...newEntry, compatibilitySignature: "narrowed-unreviewed-declaration" }))
      .toEqual(expect.arrayContaining([expect.objectContaining({ code: "baseline-signature-change" })]));
    expect(run({ ...oldEntry, compatibilitySignature: "different-prior-artifact" }))
      .toEqual(expect.arrayContaining([expect.objectContaining({ code: "baseline-signature-change" })]));
    expect(run(oldEntry, newEntry, "0.20.3"))
      .toEqual(expect.arrayContaining([expect.objectContaining({ code: "baseline-signature-change" })]));
    expect(run(oldEntry, newEntry, "0.20.4", "0.20.6"))
      .toEqual(expect.arrayContaining([expect.objectContaining({ code: "baseline-signature-change" })]));
    expect(evaluateBaseline(subpath, [oldEntry], [], [oldEntry], [], "0.20.4", "0.20.5").errors)
      .toEqual(expect.arrayContaining([expect.objectContaining({ code: "baseline-protected-removal" })]));
  });
});

describe("0.20.5 reviewed NEWARCH v2 TmuxWsMux graph", () => {
  // Pairs copied from the two artifacts (v0.20.4-dist baseline, 0.20.5 git-dist
  // with lot I), not read back from V0205_REVIEWED_ADDITIONS.
  const cases = [
    { pair: "server:AppRoutes:bf2781650331649829f6cd26221c47f86cef6c9b049cb4d92686bd7f22e25c33:0cee4584b304111af833cf65a34d7205cdd27e714d815411d9ca1ad137d054e3", tier: "S", kind: "type" },
    { pair: "server:AppRoutesOptions:c42593b8bb94c0f8ca9c7ad55e42f5b508990f091467bc64c764bea96a5ef7a2:413b5cbbaada29e23a00e522f4dcd30c9990dd926048df394ebf004fb2d66ce7", tier: "S", kind: "type" },
    { pair: "server:createAppRoutes:1d34d34dbbfb7c22edd28ae3145dc8de8590ce887de93e31a2fed79825da823a:dcd3b01f07acdc453c2cf3cd977c44478d384beb6b592e7431b58e2700ec700e", tier: "S", kind: "value" },
    { pair: "server:TmuxWsMux:32d590ee6e9e014949d780b3709e93087d92e203f962e3c0d3b72b35f1daf7b8:24d3a6f011af24425930aec4c32d0707f4e5264776d26bba3ab26791186f0ebb", tier: "F", kind: "value" },
  ] as const;
  for (const { pair, tier, kind } of cases) {
    test(pair.split(":").slice(0, 2).join(":"), () => {
      const [subpath, name, before, after] = pair.split(":") as ["server", string, string, string];
      const oldEntry = { name, kind, tier, signature: before, compatibilitySignature: before };
      const newEntry = { name, kind, tier, signature: after, compatibilitySignature: after };
      const run = (oldLive = oldEntry, newLive = newEntry, oldVersion = "0.20.4", newVersion = "0.20.5") =>
        evaluateBaseline(subpath, [oldEntry], [newEntry], [oldLive], [newLive], oldVersion, newVersion).errors;
      expect(run()).toEqual([]);
      expect(run(oldEntry, { ...newEntry, compatibilitySignature: "narrowed-unreviewed-declaration" }))
        .toEqual(expect.arrayContaining([expect.objectContaining({ code: "baseline-signature-change" })]));
      expect(run({ ...oldEntry, compatibilitySignature: "different-prior-artifact" }))
        .toEqual(expect.arrayContaining([expect.objectContaining({ code: "baseline-signature-change" })]));
      expect(run(oldEntry, newEntry, "0.20.3"))
        .toEqual(expect.arrayContaining([expect.objectContaining({ code: "baseline-signature-change" })]));
      expect(run(oldEntry, newEntry, "0.20.4", "0.20.6"))
        .toEqual(expect.arrayContaining([expect.objectContaining({ code: "baseline-signature-change" })]));
      expect(evaluateBaseline(subpath, [oldEntry], [], [oldEntry], [], "0.20.4", "0.20.5").errors)
        .toEqual(expect.arrayContaining([expect.objectContaining({ code: "baseline-protected-removal" })]));
    });
  }
});

// P: verbatim declaration excerpts from v0.21.0-dist, immutable commit
// f057decc360b007907dfafdf56ec1efb9f7079fa, git-dist/app/config.d.ts.
// AppAdapters includes only the two WJ members under test; other interfaces
// are complete. This is an offline excerpt fixture, not a whole-package copy.
const P_WJ_0210_DECLARATIONS = "export interface SubmissionReceipt {\n    status: 'sent' | 'rejected' | 'uncertain';\n    submissionId?: string;\n    reason?: string;\n}\nexport interface PromptEntry {\n    text: string;\n    source: 'ui' | 'screen';\n    state?: 'sent' | 'uncertain';\n    submissionId?: string;\n}\nexport interface AppLabels {\n    hubTitle: string;\n    hubCount: (count: number) => string;\n    gridNew: string;\n    gridEmpty: string;\n    gridLoading: string;\n    gridAll: string;\n    gridSearchLabel: string;\n    gridSearchPlaceholder: string;\n    gridGroup: string;\n    gridUngrouped: string;\n    launchTitle: string;\n    launchHint: string;\n    launchContext: string;\n    launchPermission: string;\n    launchModel: string;\n    launchAction: string;\n    launchBusy: string;\n    /** Takes the message so a host can replace the whole line, not just a\n     * prefix. Mirrors `uploadFailed`, which already worked this way. */\n    launchFailed: (message: string) => string;\n    hudBack: string;\n    hudChip: string;\n    hudConnected: string;\n    hudOffline: string;\n    terminalAria: (session: string) => string;\n    fabAria: string;\n    actionType: string;\n    actionUpload: string;\n    actionUploading: string;\n    actionDpad: string;\n    actionCopy: string;\n    actionShortcuts: string;\n    actionTheme: string;\n    actionFontUp: string;\n    actionFontDown: string;\n    scrollNewContent: string;\n    scrollBottom: string;\n    uploadFailed: (message: string) => string;\n    noteEmpty: string;\n    noteEdit: string;\n    noteSave: string;\n    noteCancel: string;\n    promptsTitle: string;\n    promptsLoading: string;\n    promptsEmpty: string;\n    /** Heading over exact rows sent from the UI (`PromptEntry.source: 'ui'`). */\n    promptSourceUi?: string;\n    /** Heading over rows rebuilt from the terminal screen. */\n    promptSourceScreen?: string;\n    /** Badge on a `ui` row whose delivery is unknown. */\n    promptUncertain?: string;\n    /** Shown after `submitText` reports `uncertain` (or rejects) and the draft\n     * has been put back. */\n    submissionUncertain?: string;\n    shortcutsTitle: string;\n    shortcutAdd: string;\n    shortcutLabel: string;\n    shortcutSend: string;\n    shortcutDelete: string;\n    shortcutUp: string;\n    shortcutDown: string;\n    themeTitle: string;\n    themeBackground: string;\n    themeDark: string;\n    themeLight: string;\n    themeDefault: string;\n    themeCustom: string;\n    composerCompose: string;\n    composerDirect: string;\n    composerHintCompose: string;\n    composerHintDirect: string;\n    composerPlaceholder: string;\n    composerSend: string;\n    composerDirectAria: string;\n    close: string;\n}\nexport interface AppAdapters {\n    submitText?: (session: string, text: string) => Promise<SubmissionReceipt>;\n    promptEntries?: (session: string) => Promise<PromptEntry[] | null>;\n}\n";
const P_WJ_0210_EXCERPT_SHA256 = "3f7d84b0e3968e7f60c91b2a161ae0d9b5f8de9c1e6bf711da9da4e9a3ea9325";

const P_WJ_CONSUMER = String.raw`
import type { AppAdapters, AppLabels, PromptEntry, SubmissionReceipt } from "thumbmux/app";
const receipt: SubmissionReceipt = { status: "uncertain", submissionId: "h-1" };
const entries: PromptEntry[] = [{ text: "first\n\n  second", source: "ui", state: "sent" }];
const optedIn: AppAdapters = {
  submitText: async (_session, _text) => receipt,
  promptEntries: async () => entries,
};
const absent: AppAdapters = {};
const unavailable: AppAdapters = { promptEntries: async () => null };
type NewLabels = "promptSourceUi" | "promptSourceScreen" | "promptUncertain" | "submissionUncertain";
declare const legacyLabels: Omit<AppLabels, NewLabels>;
const stillValid: AppLabels = legacyLabels;
void [optedIn, absent, unavailable, stillValid];
`;

function pCompileConsumer(source: string, entries: Record<string, string>) {
  // Virtual consumer only: built declarations are read from disk. No product
  // module is imported or executed and no compiler subprocess/network is used.
  const entry = resolve(import.meta.dir, "p-consumer.fixture.ts");
  const options: ts.CompilerOptions = {
    strict: true, noEmit: true, skipLibCheck: true, types: [],
    target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    paths: Object.fromEntries(Object.entries(entries).map(([key, value]) => [key, [value]])),
  };
  const host = ts.createCompilerHost(options);
  const originalRead = host.readFile.bind(host);
  const originalExists = host.fileExists.bind(host);
  const originalSource = host.getSourceFile.bind(host);
  host.readFile = (file) => file === entry ? source : originalRead(file);
  host.fileExists = (file) => file === entry || originalExists(file);
  host.getSourceFile = (file, languageVersion, onError, shouldCreate) => file === entry
    ? ts.createSourceFile(file, source, languageVersion, true)
    : originalSource(file, languageVersion, onError, shouldCreate);
  const program = ts.createProgram([entry], options, host);
  return ts.getPreEmitDiagnostics(program).map((diagnostic) => ({
    code: diagnostic.code,
    text: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
  }));
}

function pWjExcerpt(): string {
  const root = fixture("0.21.0");
  const file = join(root, "wj.d.ts");
  writeFileSync(file, P_WJ_0210_DECLARATIONS);
  return file;
}

describe("P .21 WJ consumer contract", () => {
  test("pinned offline .21 excerpts compile the host's WJ and legacy-label shapes", () => {
    expect(createHash("sha256").update(P_WJ_0210_DECLARATIONS).digest("hex"))
      .toBe(P_WJ_0210_EXCERPT_SHA256);
    expect(pCompileConsumer(P_WJ_CONSUMER, { "thumbmux/app": pWjExcerpt() })).toEqual([]);
  });

  test("current built public app barrel retains WJ types and optional adapters/labels", () => {
    expect(pCompileConsumer(P_WJ_CONSUMER, {
      "thumbmux/app": resolve(import.meta.dir, "../git-dist/app/index.d.ts"),
    })).toEqual([]);
  });

  test("removing the public receipt fails by its export name, not by missing setup", () => {
    const file = pWjExcerpt();
    // An explicit export declaration disables ambient implicit exports, so
    // removing this modifier really makes SubmissionReceipt module-private.
    writeFileSync(
      file,
      P_WJ_0210_DECLARATIONS.replace("export interface SubmissionReceipt", "interface SubmissionReceipt")
        + "\nexport {};\n",
    );
    const diagnostics = pCompileConsumer(P_WJ_CONSUMER, { "thumbmux/app": file });
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({ code: 2459 });
    expect(diagnostics[0]!.text).toContain("SubmissionReceipt");
  });

  test("making the new adapter required breaks the absent-adapter host", () => {
    const file = pWjExcerpt();
    writeFileSync(file, P_WJ_0210_DECLARATIONS.replace("submitText?:", "submitText:"));
    const diagnostics = pCompileConsumer(P_WJ_CONSUMER, { "thumbmux/app": file });
    expect(diagnostics.map(({ code }) => code)).toEqual([2741, 2741]);
    expect(diagnostics.every(({ text }) => text.includes("submitText"))).toBe(true);
  });

  test("receipt state and prompt payload types reject unrelated strings", () => {
    const diagnostics = pCompileConsumer(`
      import type { SubmissionReceipt, PromptEntry } from "thumbmux/app";
      const receipt: SubmissionReceipt = { status: "maybe" };
      const prompt: PromptEntry = { text: 42, source: "ui" };
    `, { "thumbmux/app": pWjExcerpt() });
    expect(diagnostics.map(({ code }) => code)).toEqual([2322, 2322]);
    expect(diagnostics[0]!.text).toContain("maybe");
    expect(diagnostics[1]!.text).toContain("number");
  });
});

// P .20.5 geometry excerpt: the class header and methods are verbatim from
// 62f092bd8c54cac4b47e04b52189ce52751b8579/git-dist/server/ws-mux.d.ts.
// WsLike/session-row supporting declarations are minimal fixture scaffolding;
// no claim is made that this is the entire legacy server package.
const P_GEOMETRY_0205 = "export type WsLike = { send(data: string): unknown };\nexport interface SessionListRow { name: string }\nexport interface SessionListItem extends SessionListRow {}\nexport declare class TmuxWsMux<WS extends WsLike = WsLike, SessionRow extends SessionListRow = SessionListItem> {\n    handleResize(session: string, cols: number, rows: number, ws?: WS, client?: unknown): void;\n    applyGeometry(session: string, cols: number, rows: number, ws?: WS): void;\n}\n";
const P_GEOMETRY_EXCERPT_SHA256 = "256b7392f1521511801c2b3aadbe1746ef6dbf7f361612d327825f18659ca3cb";

const P_GEOMETRY_CALLER = `
import { TmuxWsMux } from "thumbmux/server";
declare const mux: TmuxWsMux;
mux.handleResize("session", 78, 120);
mux.applyGeometry("session", 78, 120);
const resize: (session: string, cols: number, rows: number) => void = mux.handleResize.bind(mux);
const geometry: (session: string, cols: number, rows: number) => void = mux.applyGeometry.bind(mux);
class Inherited extends TmuxWsMux {}
void [resize, geometry, Inherited];
`;
const P_GEOMETRY_OVERRIDE = `
import { TmuxWsMux } from "thumbmux/server";
class LegacyOverride extends TmuxWsMux {
  override handleResize(_session: string, _cols: number, _rows: number): void {}
  override applyGeometry(_session: string, _cols: number, _rows: number): void {}
}
`;

function pArtifactFixture(): string {
  const root = fixture("0.23.0");
  const packageRoot = resolve(import.meta.dir, "..");
  cpSync(join(packageRoot, "git-dist"), join(root, "git-dist"), { recursive: true });
  cpSync(join(packageRoot, "contract/manifest"), join(root, "contract/manifest"), { recursive: true });
  const pkg = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  // Match the release map transformation, using the actual public map as input.
  const exports = JSON.parse(JSON.stringify(pkg.exports).replace(/\.\/([^/" ]+)\/dist\//g, "./git-dist/$1/"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "thumbmux", type: "module", version: pkg.version, exports }));
  return root;
}

function pRuntimeImport(root: string) {
  // Runs only under the reviewed runner. Every host effect is made fatal in
  // this fresh process before importing the public runtime subpath.
  const script = `
    import { mock } from "bun:test";
    import * as child from "node:child_process";
    import * as fs from "node:fs";
    const forbidden = () => { throw Error("P import attempted host IO/timer/database"); };
    mock.module("bun:sqlite", () => ({ Database: class { constructor() { forbidden(); } } }));
    mock.module("node:child_process", () => ({ ...child, spawn: forbidden, spawnSync: forbidden, exec: forbidden, execSync: forbidden, execFile: forbidden, execFileSync: forbidden, fork: forbidden }));
    mock.module("node:fs", () => ({ ...fs, openSync: forbidden, writeFileSync: forbidden, mkdirSync: forbidden, rmSync: forbidden }));
    globalThis.setTimeout = forbidden;
    globalThis.setInterval = forbidden;
    const runtime = await import("thumbmux/pipe-history-runtime");
    if (typeof runtime.NewarchV2Display !== "function") throw Error("NewarchV2Display missing constructor");
    const display = Reflect.construct(runtime.NewarchV2Display, [{}]);
    if (!(display instanceof runtime.NewarchV2Display)) throw Error("NewarchV2Display is not constructible");
    console.log("P NewarchV2Display inert constructor");
  `;
  return spawnSync(process.execPath, ["--eval", script], { cwd: root, encoding: "utf8" });
}

describe("P runtime barrel and dual consumer guards", () => {
  test("public built runtime provides a constructible value and matching type", () => {
    const root = pArtifactFixture();
    expect(() => assertRuntimeDisplayExport(root)).not.toThrow();
    const runtime = pRuntimeImport(root);
    expect({ error: runtime.error?.message, status: runtime.status, stderr: runtime.stderr })
      .toEqual({ error: undefined, status: 0, stderr: "" });
    expect(runtime.stdout.trim()).toBe("P NewarchV2Display inert constructor");
    expect(pCompileConsumer(`
      import { NewarchV2Display } from "thumbmux/pipe-history-runtime";
      declare const reader: ConstructorParameters<typeof NewarchV2Display>[0];
      const display: NewarchV2Display = new NewarchV2Display(reader);
      declare const session: Parameters<NewarchV2Display["select"]>[0];
      display.select(session);
    `, { "thumbmux/pipe-history-runtime": join(root, "git-dist/server/pipe-history-runtime.d.ts") }))
      .toEqual([]);
  });

  test("missing runtime value is rejected by the actual export name", () => {
    const root = pArtifactFixture();
    writeFileSync(join(root, "git-dist/server/pipe-history-runtime.js"), "export const Other = 1;\n");
    expect(() => assertRuntimeDisplayExport(root)).toThrow("NewarchV2Display");
    const runtime = pRuntimeImport(root);
    expect(runtime.status).toBe(1);
    expect(runtime.stderr).toContain("NewarchV2Display missing constructor");
    expect(runtime.stderr).not.toContain("Cannot find");
  });

  test("a callable-only declaration is not a constructor/type barrel", () => {
    const root = pArtifactFixture();
    writeFileSync(join(root, "git-dist/server/pipe-history-runtime.d.ts"), "export declare const NewarchV2Display: () => void;\nexport type NewarchV2Display = number;\n");
    expect(() => assertRuntimeDisplayExport(root)).toThrow("NewarchV2Display");
  });

  test("a wrong instance alias is rejected even when the value is constructible", () => {
    const root = pArtifactFixture();
    writeFileSync(join(root, "git-dist/server/pipe-history-runtime.d.ts"), "declare class Display { select(): string; }\nexport declare const NewarchV2Display: typeof Display;\nexport type NewarchV2Display = number;\n");
    expect(() => assertRuntimeDisplayExport(root)).toThrow("NewarchV2Display");
  });

  test("discarded result, void callbacks and inherited subclass compile against both surfaces", () => {
    expect(createHash("sha256").update(P_GEOMETRY_0205).digest("hex"))
      .toBe(P_GEOMETRY_EXCERPT_SHA256);
    const root = fixture("0.20.5");
    const baseline = join(root, "geometry.d.ts");
    writeFileSync(baseline, P_GEOMETRY_0205);
    for (const file of [baseline, resolve(import.meta.dir, "../git-dist/server/index.d.ts")]) {
      expect(pCompileConsumer(P_GEOMETRY_CALLER, { "thumbmux/server": file })).toEqual([]);
    }
    expect(pCompileConsumer(P_GEOMETRY_OVERRIDE, { "thumbmux/server": baseline })).toEqual([]);
    const errors = pCompileConsumer(P_GEOMETRY_OVERRIDE, {
      "thumbmux/server": resolve(import.meta.dir, "../git-dist/server/index.d.ts"),
    });
    expect(errors.map(({ code }) => code)).toEqual([2416, 2416]);
    expect(errors[0]!.text).toContain("handleResize");
    expect(errors[1]!.text).toContain("applyGeometry");
  });

  test(".21 WJ host also consumes the NEWARCH public constructor", () => {
    const source = P_WJ_CONSUMER + `
      import { NewarchV2Display } from "thumbmux/pipe-history-runtime";
      declare const display: NewarchV2Display;
      const ctor: typeof NewarchV2Display = NewarchV2Display;
      void [display, ctor];
    `;
    expect(pCompileConsumer(source, {
      "thumbmux/app": resolve(import.meta.dir, "../git-dist/app/index.d.ts"),
      "thumbmux/pipe-history-runtime": resolve(import.meta.dir, "../git-dist/server/pipe-history-runtime.d.ts"),
    })).toEqual([]);
  });

  test("missing immutable baseline remains an error, including the old skip environment", () => {
    expect(resolveBaselineMode({}).error).toBeTruthy();
    expect(resolveBaselineMode({ THUMBMUX_CONTRACT_BASELINE: "skip" }).error).toBeTruthy();
  });
});

describe("P 0.23 release metadata and WJ manifests", () => {
  const packageRoot = resolve(import.meta.dir, "..");
  const releaseManifests = ["package.json", "core/package.json", "server/package.json", "svelte/package.json", "app/package.json"];

  test("the five releases are .23, demo stays private .1, source export layout stays intact", () => {
    expect(assertReleaseVersion("v0.23.0", packageRoot)).toBe("0.23.0");
    const pkg = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
    expect(pkg.private).toBe(true);
    expect(pkg.exports["./pipe-history-runtime"]).toEqual({
      types: "./server/dist/pipe-history-runtime.d.ts", import: "./server/dist/pipe-history-runtime.js",
    });
    const demo = JSON.parse(readFileSync(join(packageRoot, "demo/package.json"), "utf8"));
    expect({ version: demo.version, private: demo.private }).toEqual({ version: "0.1.0", private: true });
  });

  test("every wrong package version and every wrong internal range is rejected separately", () => {
    for (const path of releaseManifests) {
      const root = fixture("0.23.0");
      for (const manifest of releaseManifests) {
        mkdirSync(resolve(root, manifest, ".."), { recursive: true });
        cpSync(join(packageRoot, manifest), join(root, manifest));
      }
      const current = JSON.parse(readFileSync(join(root, path), "utf8"));
      writeFileSync(join(root, path), JSON.stringify({ ...current, version: "0.21.0" }));
      expect(() => assertReleaseVersion("v0.23.0", root)).toThrow(`${path}: version 0.21.0 != 0.23.0`);
      writeFileSync(join(root, path), JSON.stringify(current));
      for (const key of Object.keys(current.dependencies ?? {}).filter((name) => name.startsWith("@thumbmux/"))) {
        writeFileSync(join(root, path), JSON.stringify({ ...current, dependencies: { ...current.dependencies, [key]: "^0.21.0" } }));
        expect(() => assertReleaseVersion("v0.23.0", root)).toThrow(`${path}: ${key}`);
        writeFileSync(join(root, path), JSON.stringify(current));
      }
    }
  });

  test("release lock metadata does not alter the pinned dependency resolution graph", () => {
    const lock = readFileSync(join(packageRoot, "bun.lock"), "utf8");
    const packages = lock.slice(lock.indexOf('  "packages":'));
    expect(createHash("sha256").update(packages).digest("hex"))
      .toBe("9a7395fbe5654194a127c2e28c2103412c8d3a92ba5fe509aa57b3a1ce5b11f7");
  });

  test("WJ manifest names retain immutable .21 tiers and match built declarations", () => {
    const live = deriveGitDistReport(packageRoot, ["app", "svelte"]);
    const baselineTiers = {"app": {"AppAdapters": "S", "AppLabels": "S", "DEFAULT_APP_LABELS": "S", "EmbedView": "S", "HubView": "S", "PromptEntry": "S", "SessionView": "S", "SubmissionReceipt": "S", "ThumbmuxApp": "S"}, "svelte": {"PromptsPanel": "F"}} as const;
    const expected = {
      app: ["AppAdapters", "AppLabels", "DEFAULT_APP_LABELS", "EmbedView", "HubView", "SessionView", "ThumbmuxApp", "SubmissionReceipt", "PromptEntry"],
      svelte: ["PromptsPanel"],
    } as const;
    for (const subpath of ["app", "svelte"] as const) {
      const manifest = JSON.parse(readFileSync(join(packageRoot, `contract/manifest/${subpath}.json`), "utf8")) as ContractEntry[];
      for (const name of expected[subpath]) {
        const entry = manifest.find((value) => value.name === name);
        const actual = live[subpath].find((value) => value.name === name);
        expect(entry).toBeDefined();
        expect(actual).toBeDefined();
        expect(entry!.kind).toBe(actual!.kind);
        expect(entry!.signature).toBe(actual!.signature);
        expect(entry!.tier).toBe((baselineTiers[subpath] as Record<string, string>)[name]);
      }
    }
  });
});

test("P release checkContract requires a baseline before reading current artifacts", () => {
  expect(() => checkContract({ packageRoot: fixture("0.23.0") })).toThrow("immutable baseline");
});

// P amendment: independent literal oracle from immutable .20.5/.21 and
// emitted .22 declarations; never import or enumerate the checker exception table.
const P_RELEASE_SIGNATURES = [
  ["0.20.5", "core", "MuxClientMessage", "type", "11b80be731ac23950de4b40bc3d5366de4e5742a349597daacf4f266b3e9aa08", "95541994b6b91a3de5cce4ced1bde641e72b80727ae5c4fee10a25f8d9bb8c8c", "11b80be731ac23950de4b40bc3d5366de4e5742a349597daacf4f266b3e9aa08", "95541994b6b91a3de5cce4ced1bde641e72b80727ae5c4fee10a25f8d9bb8c8c"],
  ["0.20.5", "core", "MuxStrictClientMessage", "type", "51b53a06dce56e69bd5a46f2f79354403426c4cc70b24c06097fbd1aa849dca7", "b11b2d2c76bef804cff2f2416dff74b0d9a6cea56f428be0dd96643bf05040b8", "51b53a06dce56e69bd5a46f2f79354403426c4cc70b24c06097fbd1aa849dca7", "b11b2d2c76bef804cff2f2416dff74b0d9a6cea56f428be0dd96643bf05040b8"],
  ["0.20.5", "server", "AppRoutes", "type", "bf2781650331649829f6cd26221c47f86cef6c9b049cb4d92686bd7f22e25c33", "5dea581f65f6b4a5d633d4ea4ee3ea6deb29cd4a085978c2eb09d7078b870962", "bf2781650331649829f6cd26221c47f86cef6c9b049cb4d92686bd7f22e25c33", "5dea581f65f6b4a5d633d4ea4ee3ea6deb29cd4a085978c2eb09d7078b870962"],
  ["0.20.5", "server", "AppRoutesOptions", "type", "c42593b8bb94c0f8ca9c7ad55e42f5b508990f091467bc64c764bea96a5ef7a2", "9e69f0be331dac06b210d91862ef15bfe645727e483e0813e1f2d179c5e0e8bd", "c42593b8bb94c0f8ca9c7ad55e42f5b508990f091467bc64c764bea96a5ef7a2", "9e69f0be331dac06b210d91862ef15bfe645727e483e0813e1f2d179c5e0e8bd"],
  ["0.20.5", "server", "createAppRoutes", "value", "1d34d34dbbfb7c22edd28ae3145dc8de8590ce887de93e31a2fed79825da823a", "5734a338d1cd7c00bd7d43881dd87bbe220f4402e86699ace520d36ad772b24c", "1d34d34dbbfb7c22edd28ae3145dc8de8590ce887de93e31a2fed79825da823a", "5734a338d1cd7c00bd7d43881dd87bbe220f4402e86699ace520d36ad772b24c"],
  ["0.20.5", "server", "createTokenGuard", "value", "e92f263a3649439f4de1b063251e5d6a9fc182405e27377d5838dcacdc8a441a", "482980078f7898eddce045ed224d0a8768b9ce276bdccadb364de79c745548b0", "e92f263a3649439f4de1b063251e5d6a9fc182405e27377d5838dcacdc8a441a", "482980078f7898eddce045ed224d0a8768b9ce276bdccadb364de79c745548b0"],
  ["0.20.5", "server", "MuxAuthResult", "type", "92afd799d24d279dda1e214fc8a95a27128e59717f738dfd4849177cec7d76e9", "460fe9f1684fa9ee2b2994b5c42f2c5c693724466beea87860c8faa9c2478b3d", "92afd799d24d279dda1e214fc8a95a27128e59717f738dfd4849177cec7d76e9", "460fe9f1684fa9ee2b2994b5c42f2c5c693724466beea87860c8faa9c2478b3d"],
  ["0.20.5", "server", "MuxAuthSuccess", "type", "7abfb5f990ed14b60cd2db4d8cefd5b04e519ef46e775a4788d84ee58acccb40", "10f49452f67462cc015bba9d35fe35329a94079c4fbf8da6d6bee3afbe2c3b43", "7abfb5f990ed14b60cd2db4d8cefd5b04e519ef46e775a4788d84ee58acccb40", "10f49452f67462cc015bba9d35fe35329a94079c4fbf8da6d6bee3afbe2c3b43"],
  ["0.20.5", "server", "TmuxWsMux", "value", "32d590ee6e9e014949d780b3709e93087d92e203f962e3c0d3b72b35f1daf7b8", "6967c1491b7646b30887d2d25e27ce303f53c0ec5322d2cb0ce9f609e92bebfa", "32d590ee6e9e014949d780b3709e93087d92e203f962e3c0d3b72b35f1daf7b8", "6967c1491b7646b30887d2d25e27ce303f53c0ec5322d2cb0ce9f609e92bebfa"],
  ["0.20.5", "server", "TokenGuard", "type", "1024637b6163694f89bd8accdf3bf5aaf12e0903f5659173fd243a711bb7b630", "39cd8055efde9bd6824b774e73ecbb3154d02691796491a6b8a6718d432d3ea4", "1024637b6163694f89bd8accdf3bf5aaf12e0903f5659173fd243a711bb7b630", "39cd8055efde9bd6824b774e73ecbb3154d02691796491a6b8a6718d432d3ea4"],
  ["0.20.5", "svelte", "tmuxMux", "value", "1498d12202be9d8d9568f782239b74969ebceecba90cddc5b47c2aad2bbb20d1", "20bd012b7250b1fd6dd72c1e3fd23bc09684b3d2edb77c413a1077306e2b7919", "1498d12202be9d8d9568f782239b74969ebceecba90cddc5b47c2aad2bbb20d1", "20bd012b7250b1fd6dd72c1e3fd23bc09684b3d2edb77c413a1077306e2b7919"],
  ["0.20.5", "svelte", "TmuxMux", "value", "10b84ceb2007aea4331aec0e0a49131f75c59ce62755c859e0fb769022258336", "ef1ddeb06ad92c01c0f92b0dbd5b58a638981f57ba174dd2cd312fe8614a4ac1", "10b84ceb2007aea4331aec0e0a49131f75c59ce62755c859e0fb769022258336", "ef1ddeb06ad92c01c0f92b0dbd5b58a638981f57ba174dd2cd312fe8614a4ac1"],
  ["0.20.5", "svelte", "PromptsPanel", "component", "eeabae3cbcca4ab135572967cb25dd554d6b1c26fd1bcc9657d253b58c0a6e0d", "5bf24f6434b53337d1bf67321caa790d58b731f36fcb9561c322664620a6528f", "a01d69dc347c3a26ab42fe661d95bbcd9fc74387a88c9b7dcb204feaa5f39a8e", "62ff18e2aa2b7c89a0e0086e4700a7a2310856060ff16a7aa4e90fb48786bdf5"],
  ["0.20.5", "app", "AppAdapters", "type", "5eec4498dd463722cf26d8dc6d44e35f123287fa62eed1bde57673b2ecabb2e0", "07b4ae6e154fce7a6e4860b9cfd0742968682dd1ad15ceea569052dcf858875b", "5eec4498dd463722cf26d8dc6d44e35f123287fa62eed1bde57673b2ecabb2e0", "07b4ae6e154fce7a6e4860b9cfd0742968682dd1ad15ceea569052dcf858875b"],
  ["0.20.5", "app", "createSessionsStore", "value", "320b7698efd9586312a113ebdcfe0ffca1dcfff8b5af3c2cd67f04ed3b434afc", "a6668e54536d49d154c9ab7b7d878cd22055e050bd447d00ce9766b7d1263034", "320b7698efd9586312a113ebdcfe0ffca1dcfff8b5af3c2cd67f04ed3b434afc", "a6668e54536d49d154c9ab7b7d878cd22055e050bd447d00ce9766b7d1263034"],
  ["0.20.5", "app", "EmbedView", "component", "b51656395a3b996f2c5b5bd70b2a38f8ec431acb4bb69d761f0e1a4a3194b86e", "aeba95b3b046ab33f58a67701e5dc45485eda9b32a3ae0acd9369ebab0bde416", "46f7f6c8a7bef4d8ed33468c252ad22b3180d78ed6896b4db2e2e915c5e7fcb7", "bbe2fe42f25da707fdc00563c796de9e655c85225a355f8a270bd444c25b006d"],
  ["0.20.5", "app", "HubView", "component", "5924951958271059e63f1f738c90d335e0a624b572f986d6ebf99351190a3646", "9888a1a8adb079099c7f40c5cdcd5c7b74fe39024cad5436baa23e0d2b03193e", "e98a99dfa1891ebef3e78dd26b6485c7687ccb44808042e23aac9ac9f4e8b702", "3609341b43f82f78978aa132f92e0c01171f01a333ac1434e86c23a130c7d0a9"],
  ["0.20.5", "app", "SessionView", "component", "be5f48e09dca94255ee8fcaa0497e147287450947c12ec4e68badc09d0631d60", "b02acd824f574311b3214456133d7392ec9a0857834e789561aee392ba8d6675", "e8a4c3c6399bbee28663b068d9572ece989d78ee7c89b3587fbbec40a33bbb8b", "d8223970b90a41c6fa6650ded1c1a20183fd27ff3f4e2a43aef7d9ca93ff32cd"],
  ["0.20.5", "app", "ThumbmuxApp", "component", "9acd4c600929f4c9fa84f5716d124d184be5df10f8335dba720147f9e1385da5", "071191bd20d7c304b10c7dfecec48e8b5ab638d794bab611fe127199e0f8242f", "6f6e2591a5f4154d627d630a21302dbdc22e385dcde546d9291759017c815c18", "24e56e84869abefdab2302613f0265a96b3647ee247dc55fd7b7dc2ef54cc27b"],
  ["0.20.5", "app", "DEFAULT_APP_LABELS", "value", "fcaf14520699415db6431bc8d934536ac4be7232184dd97f724849d4de0e71d0", "96a4226e7ce0f26bff723516145368641512444fcd2119428305e31d726854e5", "fcaf14520699415db6431bc8d934536ac4be7232184dd97f724849d4de0e71d0", "96a4226e7ce0f26bff723516145368641512444fcd2119428305e31d726854e5"],
  ["0.21.0", "core", "MuxClientMessage", "type", "11b80be731ac23950de4b40bc3d5366de4e5742a349597daacf4f266b3e9aa08", "95541994b6b91a3de5cce4ced1bde641e72b80727ae5c4fee10a25f8d9bb8c8c", "11b80be731ac23950de4b40bc3d5366de4e5742a349597daacf4f266b3e9aa08", "95541994b6b91a3de5cce4ced1bde641e72b80727ae5c4fee10a25f8d9bb8c8c"],
  ["0.21.0", "core", "MuxStrictClientMessage", "type", "51b53a06dce56e69bd5a46f2f79354403426c4cc70b24c06097fbd1aa849dca7", "b11b2d2c76bef804cff2f2416dff74b0d9a6cea56f428be0dd96643bf05040b8", "51b53a06dce56e69bd5a46f2f79354403426c4cc70b24c06097fbd1aa849dca7", "b11b2d2c76bef804cff2f2416dff74b0d9a6cea56f428be0dd96643bf05040b8"],
  ["0.21.0", "server", "AppRoutes", "type", "bf2781650331649829f6cd26221c47f86cef6c9b049cb4d92686bd7f22e25c33", "5dea581f65f6b4a5d633d4ea4ee3ea6deb29cd4a085978c2eb09d7078b870962", "bf2781650331649829f6cd26221c47f86cef6c9b049cb4d92686bd7f22e25c33", "5dea581f65f6b4a5d633d4ea4ee3ea6deb29cd4a085978c2eb09d7078b870962"],
  ["0.21.0", "server", "AppRoutesOptions", "type", "c42593b8bb94c0f8ca9c7ad55e42f5b508990f091467bc64c764bea96a5ef7a2", "9e69f0be331dac06b210d91862ef15bfe645727e483e0813e1f2d179c5e0e8bd", "c42593b8bb94c0f8ca9c7ad55e42f5b508990f091467bc64c764bea96a5ef7a2", "9e69f0be331dac06b210d91862ef15bfe645727e483e0813e1f2d179c5e0e8bd"],
  ["0.21.0", "server", "createAppRoutes", "value", "1d34d34dbbfb7c22edd28ae3145dc8de8590ce887de93e31a2fed79825da823a", "5734a338d1cd7c00bd7d43881dd87bbe220f4402e86699ace520d36ad772b24c", "1d34d34dbbfb7c22edd28ae3145dc8de8590ce887de93e31a2fed79825da823a", "5734a338d1cd7c00bd7d43881dd87bbe220f4402e86699ace520d36ad772b24c"],
  ["0.21.0", "server", "createTokenGuard", "value", "e92f263a3649439f4de1b063251e5d6a9fc182405e27377d5838dcacdc8a441a", "482980078f7898eddce045ed224d0a8768b9ce276bdccadb364de79c745548b0", "e92f263a3649439f4de1b063251e5d6a9fc182405e27377d5838dcacdc8a441a", "482980078f7898eddce045ed224d0a8768b9ce276bdccadb364de79c745548b0"],
  ["0.21.0", "server", "MuxAuthResult", "type", "92afd799d24d279dda1e214fc8a95a27128e59717f738dfd4849177cec7d76e9", "460fe9f1684fa9ee2b2994b5c42f2c5c693724466beea87860c8faa9c2478b3d", "92afd799d24d279dda1e214fc8a95a27128e59717f738dfd4849177cec7d76e9", "460fe9f1684fa9ee2b2994b5c42f2c5c693724466beea87860c8faa9c2478b3d"],
  ["0.21.0", "server", "MuxAuthSuccess", "type", "7abfb5f990ed14b60cd2db4d8cefd5b04e519ef46e775a4788d84ee58acccb40", "10f49452f67462cc015bba9d35fe35329a94079c4fbf8da6d6bee3afbe2c3b43", "7abfb5f990ed14b60cd2db4d8cefd5b04e519ef46e775a4788d84ee58acccb40", "10f49452f67462cc015bba9d35fe35329a94079c4fbf8da6d6bee3afbe2c3b43"],
  ["0.21.0", "server", "TmuxWsMux", "value", "32d590ee6e9e014949d780b3709e93087d92e203f962e3c0d3b72b35f1daf7b8", "6967c1491b7646b30887d2d25e27ce303f53c0ec5322d2cb0ce9f609e92bebfa", "32d590ee6e9e014949d780b3709e93087d92e203f962e3c0d3b72b35f1daf7b8", "6967c1491b7646b30887d2d25e27ce303f53c0ec5322d2cb0ce9f609e92bebfa"],
  ["0.21.0", "server", "TokenGuard", "type", "1024637b6163694f89bd8accdf3bf5aaf12e0903f5659173fd243a711bb7b630", "39cd8055efde9bd6824b774e73ecbb3154d02691796491a6b8a6718d432d3ea4", "1024637b6163694f89bd8accdf3bf5aaf12e0903f5659173fd243a711bb7b630", "39cd8055efde9bd6824b774e73ecbb3154d02691796491a6b8a6718d432d3ea4"],
  ["0.21.0", "svelte", "tmuxMux", "value", "1498d12202be9d8d9568f782239b74969ebceecba90cddc5b47c2aad2bbb20d1", "20bd012b7250b1fd6dd72c1e3fd23bc09684b3d2edb77c413a1077306e2b7919", "1498d12202be9d8d9568f782239b74969ebceecba90cddc5b47c2aad2bbb20d1", "20bd012b7250b1fd6dd72c1e3fd23bc09684b3d2edb77c413a1077306e2b7919"],
  ["0.21.0", "svelte", "TmuxMux", "value", "10b84ceb2007aea4331aec0e0a49131f75c59ce62755c859e0fb769022258336", "ef1ddeb06ad92c01c0f92b0dbd5b58a638981f57ba174dd2cd312fe8614a4ac1", "10b84ceb2007aea4331aec0e0a49131f75c59ce62755c859e0fb769022258336", "ef1ddeb06ad92c01c0f92b0dbd5b58a638981f57ba174dd2cd312fe8614a4ac1"],
  ["0.21.0", "app", "AppAdapters", "type", "50d641bf27f09f0ae615e970bf8d7624989b114f622f72c11835cbfc4500198e", "07b4ae6e154fce7a6e4860b9cfd0742968682dd1ad15ceea569052dcf858875b", "50d641bf27f09f0ae615e970bf8d7624989b114f622f72c11835cbfc4500198e", "07b4ae6e154fce7a6e4860b9cfd0742968682dd1ad15ceea569052dcf858875b"],
  ["0.21.0", "app", "createSessionsStore", "value", "320b7698efd9586312a113ebdcfe0ffca1dcfff8b5af3c2cd67f04ed3b434afc", "a6668e54536d49d154c9ab7b7d878cd22055e050bd447d00ce9766b7d1263034", "320b7698efd9586312a113ebdcfe0ffca1dcfff8b5af3c2cd67f04ed3b434afc", "a6668e54536d49d154c9ab7b7d878cd22055e050bd447d00ce9766b7d1263034"],
  ["0.21.0", "app", "EmbedView", "component", "572213494862d88db6ea5007e2121c2dfd7864f6ac68141f6ceb36f8e8deabc5", "aeba95b3b046ab33f58a67701e5dc45485eda9b32a3ae0acd9369ebab0bde416", "9f335097a884f0bfb073318afef04337066a0177c83dc996ab5e8c4131c25655", "bbe2fe42f25da707fdc00563c796de9e655c85225a355f8a270bd444c25b006d"],
  ["0.21.0", "app", "HubView", "component", "1ec52ee234f6d0360204fe9d6821d307ce835b9d8d983e979e4844c42bd4fbc2", "9888a1a8adb079099c7f40c5cdcd5c7b74fe39024cad5436baa23e0d2b03193e", "c6ba2b9c0d4e42ae2862eae8b1b66952526128b05e715eb0127d1cc330d66c2d", "3609341b43f82f78978aa132f92e0c01171f01a333ac1434e86c23a130c7d0a9"],
  ["0.21.0", "app", "SessionView", "component", "1eacff8aa9a25c47c4b3f6d8a1de9ce1c636b55bf8c823b31781c2dcdb1370dc", "b02acd824f574311b3214456133d7392ec9a0857834e789561aee392ba8d6675", "dedf0f63a9fe2a6025e41e1cc27a1f2f2bd7207cb210674e21a449b1f3c22859", "d8223970b90a41c6fa6650ded1c1a20183fd27ff3f4e2a43aef7d9ca93ff32cd"],
  ["0.21.0", "app", "ThumbmuxApp", "component", "5c112b90f02054e06fed35a770bfc078f9820af0c4553058502693f54fd7806d", "071191bd20d7c304b10c7dfecec48e8b5ab638d794bab611fe127199e0f8242f", "50b1fb4a24a6043109873a8c2159dca737cb7e88db3dfeed784e52941dd83b09", "24e56e84869abefdab2302613f0265a96b3647ee247dc55fd7b7dc2ef54cc27b"],
] as const;
const P_AMENDED_MANIFEST_ROWS = [
  ["core", "MuxClientMessage", "type", "F", "95541994b6b91a3de5cce4ced1bde641e72b80727ae5c4fee10a25f8d9bb8c8c"],
  ["core", "MuxStrictClientMessage", "type", "S", "b11b2d2c76bef804cff2f2416dff74b0d9a6cea56f428be0dd96643bf05040b8"],
  ["core", "NEWARCH_V2_WIRE_LIMITS", "value", "S", "9494168f71294a320418e03be796c75bb51f46396a7d614145668a89e569e457"],
  ["core", "newarchV2CursorFor", "value", "S", "6707eeadccea7a01d76a03f9f91d0caabb9f720422cc869f0432ebb065257cc3"],
  ["core", "NewarchV2HistoryErrorCode", "type", "S", "25eff5ddf5536ab52ae18220a291dfa4df147bcd4cd7dd452ed2c66fbec71a05"],
  ["core", "NewarchV2HistoryExpandMessage", "type", "S", "1fe069ebf773b317b35bb9daf31ca3e28f281a33483b2dbc9a8f1ab22e3d5e24"],
  ["core", "NewarchV2HistoryReply", "type", "S", "004f777ae44a703cf7f373fbfd822b6527aefc9f9f5faf7d69ea9f0e65a48997"],
  ["core", "newarchV2ReplyMatches", "value", "S", "55386507acc491c431a1f8a6eb68119388990759492874e3df00c5380d630bde"],
  ["core", "newarchV2SamePane", "value", "S", "0d9adb0bb4be8da8df16625143e830a356a05cf3d9960c00c3814f204ed507bc"],
  ["core", "NewarchV2WireCell", "type", "S", "baf13c2feb7a3316628407a1c39552533135e104640cc858bbf3f65e4d850c23"],
  ["core", "NewarchV2WireEntry", "type", "S", "20a5ef6172de57bf51bc607259ca48eacec6a49bb25a40ed7aae175691d1eea6"],
  ["core", "NewarchV2WireRow", "type", "S", "20b94749a59c7ef268fb90857be70984d9cdcbf9feff4c7a2b8c5fbd2f6c8da6"],
  ["server", "AppRoutes", "type", "S", "5dea581f65f6b4a5d633d4ea4ee3ea6deb29cd4a085978c2eb09d7078b870962"],
  ["server", "AppRoutesOptions", "type", "S", "9e69f0be331dac06b210d91862ef15bfe645727e483e0813e1f2d179c5e0e8bd"],
  ["server", "createAppRoutes", "value", "S", "5734a338d1cd7c00bd7d43881dd87bbe220f4402e86699ace520d36ad772b24c"],
  ["server", "createTokenGuard", "value", "F", "482980078f7898eddce045ed224d0a8768b9ce276bdccadb364de79c745548b0"],
  ["server", "MuxAuthResult", "type", "F", "460fe9f1684fa9ee2b2994b5c42f2c5c693724466beea87860c8faa9c2478b3d"],
  ["server", "MuxAuthSuccess", "type", "F", "10f49452f67462cc015bba9d35fe35329a94079c4fbf8da6d6bee3afbe2c3b43"],
  ["server", "TmuxWsMux", "value", "F", "6967c1491b7646b30887d2d25e27ce303f53c0ec5322d2cb0ce9f609e92bebfa"],
  ["server", "TmuxWsMuxOptions", "type", "F", "ca02f48f366f176ddd31bbd2774350a4446871359accdbe3a7c04889abb19c2e"],
  ["server", "TokenGuard", "type", "F", "39cd8055efde9bd6824b774e73ecbb3154d02691796491a6b8a6718d432d3ea4"],
  ["svelte", "PromptsPanel", "component", "F", "5bf24f6434b53337d1bf67321caa790d58b731f36fcb9561c322664620a6528f"],
  ["svelte", "TermView", "component", "F", "ff7c3b6bc8649efafec2842757993f8b1c8c0f62b152a36414404e44f22ccd13"],
  ["svelte", "tmuxMux", "value", "F", "20bd012b7250b1fd6dd72c1e3fd23bc09684b3d2edb77c413a1077306e2b7919"],
  ["svelte", "TmuxMux", "value", "F", "ef1ddeb06ad92c01c0f92b0dbd5b58a638981f57ba174dd2cd312fe8614a4ac1"],
  ["app", "AppAdapters", "type", "S", "07b4ae6e154fce7a6e4860b9cfd0742968682dd1ad15ceea569052dcf858875b"],
  ["app", "AppLabels", "type", "S", "8f12b3ffaee29a9167d5a076cb845a1a6d1655787e80853bed6122e0c050d1ba"],
  ["app", "createSessionsStore", "value", "S", "a6668e54536d49d154c9ab7b7d878cd22055e050bd447d00ce9766b7d1263034"],
  ["app", "DEFAULT_APP_LABELS", "value", "S", "96a4226e7ce0f26bff723516145368641512444fcd2119428305e31d726854e5"],
  ["app", "EmbedView", "component", "S", "aeba95b3b046ab33f58a67701e5dc45485eda9b32a3ae0acd9369ebab0bde416"],
  ["app", "HubView", "component", "S", "9888a1a8adb079099c7f40c5cdcd5c7b74fe39024cad5436baa23e0d2b03193e"],
  ["app", "PromptEntry", "type", "S", "9b6616320842f9e1609b0d32f78b8c6ffed2198d31b761da043f0b49d52d05e9"],
  ["app", "SessionView", "component", "S", "b02acd824f574311b3214456133d7392ec9a0857834e789561aee392ba8d6675"],
  ["app", "SubmissionReceipt", "type", "S", "a8d6d88ffd1699ec59a1a305b1026baefefa2507d17d506cbb13d080e19abea5"],
  ["app", "ThumbmuxApp", "component", "S", "071191bd20d7c304b10c7dfecec48e8b5ab638d794bab611fe127199e0f8242f"],
] as const;

// P2: literal .23 inventory from emitted declarations, independent of the
// exception table; the .22 P_AMENDED_MANIFEST_ROWS above remains historical.
const P2_WS_MANIFEST_ROWS = [
  [
    "server",
    "AppRoutes",
    "type",
    "S",
    "faed5511bfccc48eb9d48aa38b78982c6a839dc2228d5166adb05152968e4c5d"
  ],
  [
    "server",
    "AppRoutesOptions",
    "type",
    "S",
    "288eab3b125ab2ea77ac0a35f6eac6dc00fdcbb36fe22d7409bb380685fdd5d8"
  ],
  [
    "server",
    "createAppRoutes",
    "value",
    "S",
    "4d7d7fae77e6d4e55d43a8c0ccc2154a8718a2c43fc0df8a7fcd5915fb573b4d"
  ],
  [
    "server",
    "MuxOwnedTaskInventory",
    "type",
    "S",
    "69e64d185e85ccdd57ecd17cbeebd79b251108a3b087095b7badf3340837f82f"
  ],
  [
    "server",
    "TmuxWsMux",
    "value",
    "F",
    "393bf02df2002885a3145174dc7871361e59c059b20c38da8e2851e9bacc28d4"
  ],
  [
    "server",
    "TmuxWsMuxOptions",
    "type",
    "F",
    "ae588b37c27bd91afbbc3ba3920d21bfbe872860bf411b5b6b1813981545d947"
  ]
] as const;

// Only these three class-graph changes lack structural optional-addition proof.
const P2_WS_SIGNATURES = [
  [
    "0.22.0",
    "server",
    "AppRoutes",
    "type",
    "5dea581f65f6b4a5d633d4ea4ee3ea6deb29cd4a085978c2eb09d7078b870962",
    "faed5511bfccc48eb9d48aa38b78982c6a839dc2228d5166adb05152968e4c5d",
    "5dea581f65f6b4a5d633d4ea4ee3ea6deb29cd4a085978c2eb09d7078b870962",
    "faed5511bfccc48eb9d48aa38b78982c6a839dc2228d5166adb05152968e4c5d"
  ],
  [
    "0.22.0",
    "server",
    "createAppRoutes",
    "value",
    "5734a338d1cd7c00bd7d43881dd87bbe220f4402e86699ace520d36ad772b24c",
    "4d7d7fae77e6d4e55d43a8c0ccc2154a8718a2c43fc0df8a7fcd5915fb573b4d",
    "5734a338d1cd7c00bd7d43881dd87bbe220f4402e86699ace520d36ad772b24c",
    "4d7d7fae77e6d4e55d43a8c0ccc2154a8718a2c43fc0df8a7fcd5915fb573b4d"
  ],
  [
    "0.22.0",
    "server",
    "TmuxWsMux",
    "value",
    "6967c1491b7646b30887d2d25e27ce303f53c0ec5322d2cb0ce9f609e92bebfa",
    "393bf02df2002885a3145174dc7871361e59c059b20c38da8e2851e9bacc28d4",
    "6967c1491b7646b30887d2d25e27ce303f53c0ec5322d2cb0ce9f609e92bebfa",
    "393bf02df2002885a3145174dc7871361e59c059b20c38da8e2851e9bacc28d4"
  ]
] as const;

function pReleaseComparison(row: readonly string[], change: {
  from?: string; to?: string; subpath?: "core" | "server" | "svelte" | "app";
  name?: string; oldSignature?: string; newSignature?: string;
  oldCompatibility?: string; newCompatibility?: string; wrongKind?: boolean;
} = {}) {
  const [from, subpath, name, kind, oldSignature, newSignature, oldCompatibility, newCompatibility] = row;
  const previous: ContractEntry = {
    name: change.name ?? name!, kind: kind as ContractEntry["kind"], tier: "F",
    signature: change.oldSignature ?? oldSignature!,
    compatibilitySignature: change.oldCompatibility ?? oldCompatibility!,
  };
  const next: ContractEntry = {
    ...previous, kind: change.wrongKind ? (previous.kind === "type" ? "value" : "type") : previous.kind,
    signature: change.newSignature ?? newSignature!,
    compatibilitySignature: change.newCompatibility ?? newCompatibility!,
  };
  return evaluateBaseline(change.subpath ?? subpath as "core" | "server" | "svelte" | "app",
    [previous], [next], [previous], [next], change.from ?? from!, change.to ?? "0.22.0");
}

describe("P exact .20.5/.21 to .22 artifact signatures", () => {
  for (const row of P_RELEASE_SIGNATURES) {
    const [from, subpath, name] = row;
    test(`${from} ${subpath}/${name}: exact reviewed tuple only`, () => {
      expect(pReleaseComparison(row).errors).toEqual([]);
      const mutations = [
        { from: "0.20.4" }, { from: "0.22.0" }, { to: "0.22.1" }, { to: "0.23.0" },
        { name: `${name}Unreviewed` },
        { subpath: subpath === "core" ? "server" as const : "core" as const },
        { oldSignature: "1".repeat(64) }, { newSignature: "2".repeat(64) },
        { oldCompatibility: "3".repeat(64) }, { newCompatibility: "4".repeat(64) },
        { wrongKind: true },
      ];
      for (const mutation of mutations) {
        const errors = pReleaseComparison(row, mutation).errors;
        expect(errors.some((error) => error.code === "baseline-signature-change"
          && error.name === ("name" in mutation ? mutation.name : name)
          && error.subpath === ("subpath" in mutation ? mutation.subpath : subpath))).toBe(true);
      }
      expect(() => pReleaseComparison(row, { from: "0.23.0" }))
        .toThrow("contract version moved backwards: 0.23.0 → 0.22.0");
    });
  }

  test("historical .22 fixture retains the emitted digests used by its exact exceptions", () => {
    for (const [, subpath, name, kind, , signature] of P_RELEASE_SIGNATURES) {
      const historical = P_AMENDED_MANIFEST_ROWS.find(row => row[0] === subpath && row[1] === name);
      expect(historical).toBeDefined();
      expect(historical![2]).toBe(kind);
      expect(historical![4]).toBe(signature);
    }
  });

  test("current .23 inventory preserves historical names/tiers and uses current artifact digests", () => {
    const root = resolve(import.meta.dir, "..");
    const live = deriveGitDistReport(root);
    const currentRows = [
      ...P_AMENDED_MANIFEST_ROWS.filter(row => !P2_WS_MANIFEST_ROWS.some(next => next[0] === row[0] && next[1] === row[1])),
      ...P2_WS_MANIFEST_ROWS,
    ];
    for (const [subpath, name, kind, tier, signature] of currentRows) {
      const entries = JSON.parse(readFileSync(join(root, `contract/manifest/${subpath}.json`), "utf8")) as ContractEntry[];
      expect(entries.find((entry) => entry.name === name)).toEqual({ name, kind, tier, signature });
      expect(live[subpath].find((entry) => entry.name === name)).toMatchObject({ name, kind, signature });
    }
    // Helpers that implement the shared wire validation remain internal.
    const internal = ["newarchV2EntryPane", "newarchV2Utf8Bytes", "newarchV2CursorInBounds", "newarchV2RequestInBounds"];
    for (const name of internal) expect(live.core.some((entry) => entry.name === name)).toBe(false);
  });

  test("old exhaustive auth operation handling exposes the documented new-union breaking edge", () => {
    const root = fixture();
    const baseline = join(root, "auth.d.ts");
    // Verbatim MuxAuthSuccess.operation from immutable .20.5 and .21 token-guard.d.ts.
    writeFileSync(baseline, `export interface MuxAuthSuccess {
      operation: "ping" | "client_info" | "sessions_subscribe" | "sessions_unsubscribe" | "subscribe" | "unsubscribe" | "history_expand" | "resync" | "keys" | "resize";
    }`);
    const consumer = `import type { MuxAuthSuccess } from "thumbmux/server";
      declare function exhausted(value: never): void;
      function handle(operation: MuxAuthSuccess["operation"]) {
        switch (operation) {
          case "ping": case "client_info": case "sessions_subscribe": case "sessions_unsubscribe":
          case "subscribe": case "unsubscribe": case "history_expand": case "resync": case "keys": case "resize": return;
          default: exhausted(operation);
        }
      }`;
    expect(pCompileConsumer(consumer, { "thumbmux/server": baseline })).toEqual([]);
    const errors = pCompileConsumer(consumer, { "thumbmux/server": resolve(import.meta.dir, "../git-dist/server/index.d.ts") });
    expect(errors.map((error) => error.code)).toEqual([2345]);
    expect(errors[0]!.text).toContain("history_expand_v2");
  });
});

// P2 tests are for the separately reviewed runner. No tmux, host DB, browser,
// installed workspace alias or WS task/failure harness is used here (A3 owns it).
const P2_WS_CONSUMER = `
import { TmuxWsMux, type TmuxWsMuxOptions, type MuxOwnedTaskInventory } from "thumbmux/server";
declare const driver: TmuxWsMuxOptions["driver"];
const absent: TmuxWsMuxOptions = { driver };
const disabled: TmuxWsMuxOptions = { driver, ownedLifetime: false };
const owned: TmuxWsMuxOptions = { driver, ownedLifetime: true };
const mux = new TmuxWsMux(owned);
const drain: Promise<void> = mux.quiesceAndDrain();
const inventory: MuxOwnedTaskInventory = mux.getOwnedTaskInventory();
const phase: "legacy" | "active" | "quiescing" | "drained" | "failed" = inventory.phase;
const tasks: readonly { kind: string }[] = inventory.tasks;
const failures: readonly { kind: string; cause: unknown }[] = inventory.failures;
const retained: number = inventory.retainedCleanups;
const legacyStop: void = new TmuxWsMux(absent).stop();
const falseStop: void = new TmuxWsMux(disabled).stop();
void [drain, phase, tasks, failures, retained, legacyStop, falseStop];
`;

function p2CompilePublic(root: string, source = P2_WS_CONSUMER) {
  const entry = join(root, "consumer.ts");
  // The real package export map resolves the import; no TS paths alias.
  writeFileSync(entry, source);
  const options: ts.CompilerOptions = {
    strict: true, noEmit: true, skipLibCheck: true, types: [],
    target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
  };
  const resolution = ts.resolveModuleName("thumbmux/server", entry, options, ts.sys)
    .resolvedModule?.resolvedFileName;
  const errors = ts.getPreEmitDiagnostics(ts.createProgram([entry], options)).map(d => ({
    code: d.code, text: ts.flattenDiagnosticMessageText(d.messageText, "\n"),
  }));
  return { resolution, errors };
}

function p2AssertPublicTypes(root: string) {
  const result = p2CompilePublic(root);
  expect(result.resolution).toBe(join(root, "git-dist/server/index.d.ts"));
  expect(result.errors).toEqual([]);
}

function p2WsRuntime(root: string) {
  const script = `
    import { mock } from "bun:test";
    import * as child from "node:child_process";
    import * as fs from "node:fs";
    const forbidden = () => { throw Error("P2 forbidden host effect"); };
    mock.module("bun:sqlite", () => ({ Database: class { constructor() { forbidden(); } } }));
    mock.module("node:child_process", () => ({ ...child, spawn: forbidden, spawnSync: forbidden, exec: forbidden, execSync: forbidden, execFile: forbidden, execFileSync: forbidden, fork: forbidden }));
    mock.module("node:fs", () => ({ ...fs, openSync: forbidden, writeFileSync: forbidden, mkdirSync: forbidden, rmSync: forbidden }));
    globalThis.setTimeout = forbidden;
    globalThis.setInterval = forbidden;
    const { TmuxWsMux } = await import("thumbmux/server");
    const driver = { listSessions: () => [], capturePane: async () => "", sendKeys() {},
      getSessionActivity: () => new Map(), getHistoryLimit: () => 2000,
      setSessionHistoryLimit() {}, resizeWindow() {}, hash: x => x };
    const mux = new TmuxWsMux({ driver, ownedLifetime: true });
    console.log("P2 imported and constructed");
    if (typeof mux.quiesceAndDrain !== "function") throw Error("P2 missing drain method");
    const drain = mux.quiesceAndDrain();
    if (!(drain instanceof Promise)) throw Error("P2 drain must return Promise");
    if (mux.quiesceAndDrain() !== drain) throw Error("P2 drain promise identity");
    await drain;
    if (mux.getOwnedTaskInventory().phase !== "drained") throw Error("P2 empty drain failed");
    if (mux.quiesceAndDrain() !== drain) throw Error("P2 settled drain promise identity");
    for (const options of [{ driver }, { driver, ownedLifetime: false }]) {
      const legacy = new TmuxWsMux(options);
      let rejection;
      try { await legacy.quiesceAndDrain(); } catch (error) { rejection = error; }
      if (!rejection?.message.includes("ownedLifetime")) throw Error("P2 legacy must reject");
      const sent = [];
      legacy.handleMessage({ type: "ping" }, { send: frame => { sent.push(frame); return 1; } });
      if (sent.length !== 1 || JSON.parse(sent[0]).type !== "pong") throw Error("P2 legacy unusable");
      if (legacy.getOwnedTaskInventory().phase !== "legacy") throw Error("P2 legacy state changed");
      if (legacy.stop() !== undefined) throw Error("P2 stop must remain void");
    }
    console.log("P2 public owned and legacy API passed");
  `;
  return spawnSync(process.execPath, ["--eval", script], { cwd: root, encoding: "utf8" });
}

function p2AssertPublicRuntime(root: string) {
  const result = p2WsRuntime(root);
  expect({ error: result.error?.message, status: result.status, stderr: result.stderr })
    .toEqual({ error: undefined, status: 0, stderr: "" });
  expect(result.stdout).toContain("P2 imported and constructed");
  expect(result.stdout).toContain("P2 public owned and legacy API passed");
}

function p2PackedArtifact(): string {
  const root = pArtifactFixture();
  prepareReleasePackage(root);
  const packed = spawnSync(process.execPath, ["pm", "pack", "--ignore-scripts", "--filename", "public.tgz"], {
    cwd: root, encoding: "utf8", env: { ...process.env,
      BUN_INSTALL_CACHE_DIR: join(root, "bun-cache"), npm_config_cache: join(root, "npm-cache"), TMPDIR: root },
  });
  expect({ error: packed.error?.message, status: packed.status }).toEqual({ error: undefined, status: 0 });
  const unpacked = join(root, "unpacked");
  mkdirSync(unpacked);
  const unpack = spawnSync("tar", ["-xf", join(root, "public.tgz"), "-C", unpacked], { encoding: "utf8" });
  expect({ error: unpack.error?.message, status: unpack.status }).toEqual({ error: undefined, status: 0 });
  const pkg = join(unpacked, "package");
  for (const file of ["server/index.js", "server/index.d.ts", "server/ws-mux.d.ts", "core/index.js"]) {
    expect(readFileSync(join(pkg, "git-dist", file))).toEqual(readFileSync(join(root, "git-dist", file)));
  }
  return pkg;
}

// Historical .22 declaration closure, source-relative even for packed mutants.
// These pins were computed from the immutable dist's exact bytes, separately
// from the JSON's self-reported hashes. No rolling release baseline or network.
const P2_BASELINE_BUNDLE = resolve(import.meta.dir, "fixtures/p2-baseline-v0220");
const P2_BASELINE_SHARDS = {
  "metadata.json": "2bf77d87a512b0163ab43ac66e50ce1450d4397e143249f485ff384f9626186d",
  "core.json": "01ae52a55e11bb9bacc05466df20e84e87d768dd5c730e129e72f5cdb0908abe",
  "server.json": "ec2651a4d3988b84541d27da57d0d442f93db6480b60653e8e09427c93f6c67d",
  "svelte.json": "a730e5b4d02d794ee3ce2cd06196a879506e0e82d92cae9572d725cdf0fe470a",
  "app.json": "468ac9d8892a7ece346dd7e590869ccdb0771fc40845ab81e986840714743852",
} as const;
const P2_BASELINE_AGGREGATE = "f06c1875853986d09fb4657bfa6097315cfb190485de1f1509c022b4e806d100";
const P2_BASELINE_PATHS = "216fe60d551a1089f9e2e666522ab03a836db2ef5618e1812c9b619459cd509b";
const P2_BASELINE_DIST = "551dc3b27b6dd8c77327c1accdd8916da35a77e7";
const P2_SUBPACKAGES = ["core", "server", "svelte", "app"] as const;
type P2BaselineFile = { path: string; byteLength: number; sha256: string; base64: string };
type P2BaselineInventory = Omit<P2BaselineFile, "base64"> & { shard: string };
type P2BaselineShard = { schema: string; files: P2BaselineFile[] };
type P2BaselineMetadata = P2BaselineShard & {
  version: string; source: string; sourceTagObject: string; dist: string; distTag: string;
  archiveSha256: string; fileCount: number; totalBytes: number; inventory: P2BaselineInventory[];
};

function p2Digest(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function p2BaselineRequire(condition: unknown, reason: string): asserts condition {
  if (!condition) throw Error(`P2 baseline ${reason}`);
}

function p2BaselinePath(path: unknown): asserts path is string {
  p2BaselineRequire(typeof path === "string"
    && path.split("/").every(part => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part))
    && /^(?:package\.json|contract\/manifest\/(?:core|server|svelte|app)\.json|git-dist\/(?:core|server|svelte|app)\/.+\.d\.ts)$/.test(path),
  `unsafe or unlisted path: ${String(path)}`);
}

function p2ReadBaselineBundle(bundleRoot: string) {
  const shards = new Map<string, { raw: Buffer; parsed: P2BaselineShard }>();
  for (const name of Object.keys(P2_BASELINE_SHARDS)) {
    const file = join(bundleRoot, name);
    p2BaselineRequire(existsSync(file), `missing shard: ${name}`);
    p2BaselineRequire(lstatSync(file).isFile(), `shard must be a regular file: ${name}`);
    const raw = readFileSync(file);
    const parsed = JSON.parse(raw.toString("utf8")) as P2BaselineShard;
    p2BaselineRequire(parsed && parsed.schema === "thumbmux-p2-baseline/1"
      && Array.isArray(parsed.files), `invalid shard schema: ${name}`);
    shards.set(name, { raw, parsed });
  }
  const metadata = shards.get("metadata.json")!.parsed as P2BaselineMetadata;
  p2BaselineRequire(metadata.version === "0.22.0", "wrong version");
  p2BaselineRequire(metadata.dist === P2_BASELINE_DIST && metadata.distTag === "v0.22.0-dist", "wrong dist tuple");
  p2BaselineRequire(metadata.source === "c47aa9d58a7719616ae8e7c727785118988f5a19"
    && metadata.sourceTagObject === "59bdc2cf5b812b5f6ba6d29c84f905afdad74648"
    && metadata.archiveSha256 === "4afe27e80c1f97cb0a6afd495f6aea98cfdc46e427fa1564b016d990218fdcb0", "wrong source/archive tuple");
  p2BaselineRequire(metadata.fileCount === 145 && Array.isArray(metadata.inventory)
    && metadata.inventory.length === 145 && metadata.totalBytes === 865506, "incomplete inventory");

  const inventory = new Map<string, P2BaselineInventory>();
  for (const row of metadata.inventory) {
    p2BaselinePath(row?.path);
    p2BaselineRequire(!inventory.has(row.path), `duplicate inventory path: ${row.path}`);
    inventory.set(row.path, row);
  }
  const paths = [...inventory.keys()];
  p2BaselineRequire(JSON.stringify(paths) === JSON.stringify([...paths].sort())
    && p2Digest(paths.join("\n") + "\n") === P2_BASELINE_PATHS, "wrong exact file set");
  for (const path of ["package.json", ...P2_SUBPACKAGES.flatMap(sub => [
    `contract/manifest/${sub}.json`, `git-dist/${sub}/index.d.ts`,
  ])]) p2BaselineRequire(inventory.has(path), `missing required file: ${path}`);

  const files = new Map<string, { bytes: Buffer; sha256: string }>();
  for (const [name, { parsed }] of shards) {
    let previousPath = "";
    for (const row of parsed.files) {
      p2BaselinePath(row?.path);
      p2BaselineRequire(!files.has(row.path), `duplicate file: ${row.path}`);
      p2BaselineRequire(row.path > previousPath, `unsorted shard: ${name}`);
      previousPath = row.path;
      const expected = inventory.get(row.path);
      p2BaselineRequire(expected && expected.shard === name, `unexpected file/shard: ${row.path}`);
      p2BaselineRequire(typeof row.base64 === "string", `missing bytes: ${row.path}`);
      const bytes = Buffer.from(row.base64, "base64");
      p2BaselineRequire(bytes.toString("base64") === row.base64, `invalid base64: ${row.path}`);
      p2BaselineRequire(Number.isSafeInteger(row.byteLength) && row.byteLength > 0
        && bytes.length === row.byteLength && row.byteLength === expected.byteLength, `byte length mismatch: ${row.path}`);
      p2BaselineRequire(/^[a-f0-9]{64}$/.test(row.sha256)
        && p2Digest(bytes) === row.sha256 && row.sha256 === expected.sha256, `file hash mismatch: ${row.path}`);
      files.set(row.path, { bytes, sha256: row.sha256 });
    }
  }
  for (const path of paths) p2BaselineRequire(files.has(path), `missing file: ${path}`);
  p2BaselineRequire(files.size === 145 && [...files.values()].reduce((n, file) => n + file.bytes.length, 0) === 865506,
    "incomplete file bytes");
  p2BaselineRequire(JSON.parse(files.get("package.json")!.bytes.toString("utf8")).version === "0.22.0", "wrong package version");
  // Structural diagnostics above explain corruption. Independent pins below
  // authenticate it before any bytes may be materialized, even if rehashed.
  let aggregate = "";
  for (const [name, expected] of Object.entries(P2_BASELINE_SHARDS)) {
    const actual = p2Digest(shards.get(name)!.raw);
    p2BaselineRequire(actual === expected, `pinned shard hash mismatch: ${name}`);
    aggregate += `${name}:${actual}\n`;
  }
  p2BaselineRequire(p2Digest(aggregate) === P2_BASELINE_AGGREGATE, "pinned bundle identity mismatch");
  return files;
}

function p2BaselineRoot(bundleRoot = P2_BASELINE_BUNDLE): string {
  const files = p2ReadBaselineBundle(bundleRoot);
  // No path cache: afterEach deletes each root. Write only verified regular
  // files into a fresh temp directory, never links into the frozen checkout.
  const root = mkdtempSync(join(tmpdir(), "thumbmux-p2-baseline-"));
  roots.push(root);
  for (const [path, { bytes, sha256 }] of files) {
    const destination = join(root, path);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, bytes, { flag: "wx" });
    p2BaselineRequire(lstatSync(destination).isFile()
      && p2Digest(readFileSync(destination)) === sha256, `materialized bytes mismatch: ${path}`);
  }
  return root;
}

function p2BaselineCopy(): string {
  const root = mkdtempSync(join(tmpdir(), "thumbmux-p2-bundle-copy-"));
  roots.push(root);
  cpSync(P2_BASELINE_BUNDLE, root, { recursive: true });
  return root;
}

function p2EditBaselineShard(root: string, name: string, edit: (data: P2BaselineMetadata) => void) {
  const path = join(root, name);
  const data = JSON.parse(readFileSync(path, "utf8")) as P2BaselineMetadata;
  edit(data);
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
}

function p2ArtifactComparison(root: string) {
  const baselineRoot = p2BaselineRoot();
  const before = deriveGitDistReport(baselineRoot, ["server"]).server;
  for (const [, , name, kind, oldSignature, , oldCompatibility] of P2_WS_SIGNATURES) {
    expect(before.find(row => row.name === name)).toMatchObject({ kind, signature: oldSignature, compatibilitySignature: oldCompatibility });
  }
  // Run the same artifact oracle for positives and mutants. Manifest checking
  // also catches loss of the newly exported inventory type (absent from .22).
  return checkContract({ packageRoot: root, baselinePackageRoot: baselineRoot,
    subpackages: ["server"], validateExportParity: false });
}

function p2Replace(file: string, before: string, after: string) {
  const original = readFileSync(file, "utf8");
  expect(original.split(before)).toHaveLength(2);
  writeFileSync(file, original.replace(before, after));
}

describe("P2 pinned offline .22 baseline provider", () => {
  test("materializes the complete immutable closure with exact bytes and a fresh root per call", () => {
    const files = p2ReadBaselineBundle(P2_BASELINE_BUNDLE);
    expect(files.size).toBe(145);
    const first = p2BaselineRoot();
    const second = p2BaselineRoot();
    expect(first).not.toBe(second);
    expect(roots).toContain(first);
    expect(roots).toContain(second);
    for (const [path, { bytes }] of files) {
      expect(readFileSync(join(first, path))).toEqual(bytes);
      expect(readFileSync(join(second, path))).toEqual(bytes);
    }
    expect(JSON.parse(readFileSync(join(first, "package.json"), "utf8")).version).toBe("0.22.0");
  });

  test("all four baseline export graphs match the pinned names, kinds, signatures and historical tiers", () => {
    const root = p2BaselineRoot();
    const live = deriveGitDistReport(root);
    const expectedTiers = {
      core: { F: 86, S: 78, X: 96, D: 5 },
      server: { F: 59, S: 20, X: 11, D: 2 },
      svelte: { F: 36, S: 104, X: 14, D: 0 },
      app: { F: 0, S: 39, X: 0, D: 0 },
    };
    for (const sub of P2_SUBPACKAGES) {
      const manifest = JSON.parse(readFileSync(join(root, `contract/manifest/${sub}.json`), "utf8")) as ContractEntry[];
      const shape = (rows: readonly { name: string; kind: string; signature: string }[]) =>
        rows.map(({ name, kind, signature }) => ({ name, kind, signature }))
          .sort((a, b) => a.name.localeCompare(b.name));
      expect(shape(live[sub])).toEqual(shape(manifest));
      const tiers = { F: 0, S: 0, X: 0, D: 0 };
      for (const entry of manifest) {
        expect(["F", "S", "X", "D"]).toContain(entry.tier);
        tiers[entry.tier]++;
      }
      expect(tiers).toEqual(expectedTiers[sub]);
    }
    expect(live.server.some(row => row.name === "MuxOwnedTaskInventory")).toBe(false);
    for (const [, , name, kind, signature, , compatibilitySignature] of P2_WS_SIGNATURES) {
      expect(live.server.find(row => row.name === name)).toMatchObject({ kind, signature, compatibilitySignature });
    }
  });

  test("missing shard is a provider error, not a skipped contract check", () => {
    const copy = p2BaselineCopy();
    p2BaselineRoot(copy);
    rmSync(join(copy, "server.json"));
    expect(() => p2BaselineRoot(copy)).toThrow("P2 baseline missing shard: server.json");
  });

  for (const [field, value, reason] of [
    ["version", "0.23.0", "wrong version"],
    ["dist", "0".repeat(40), "wrong dist tuple"],
    ["source", "0".repeat(40), "wrong source/archive tuple"],
  ] as const) {
    test(`rejects a wrong historical ${field}`, () => {
      const copy = p2BaselineCopy();
      p2BaselineRoot(copy);
      p2EditBaselineShard(copy, "metadata.json", data => { data[field] = value; });
      expect(() => p2BaselineRoot(copy)).toThrow(`P2 baseline ${reason}`);
    });
  }

  for (const path of ["git-dist/server/index.d.ts", "git-dist/server/sqlite-history/reader.d.ts"]) {
    test(`rejects missing declaration closure file ${path}`, () => {
      const copy = p2BaselineCopy();
      p2BaselineRoot(copy);
      p2EditBaselineShard(copy, "server.json", data => {
        expect(data.files.some(row => row.path === path)).toBe(true);
        data.files = data.files.filter(row => row.path !== path);
      });
      expect(() => p2BaselineRoot(copy)).toThrow(`P2 baseline missing file: ${path}`);
    });
  }

  test("dropping a nested file and its inventory row still cannot redefine completeness", () => {
    const copy = p2BaselineCopy();
    p2BaselineRoot(copy);
    const path = "git-dist/server/sqlite-history/reader.d.ts";
    p2EditBaselineShard(copy, "server.json", data => { data.files = data.files.filter(row => row.path !== path); });
    p2EditBaselineShard(copy, "metadata.json", data => {
      data.inventory = data.inventory.filter(row => row.path !== path);
      data.fileCount--;
    });
    expect(() => p2BaselineRoot(copy)).toThrow("P2 baseline incomplete inventory");
  });

  for (const rehash of [false, true]) {
    test(`tampered declaration is rejected even when self-reported hashes are ${rehash ? "rewritten" : "unchanged"}`, () => {
      const copy = p2BaselineCopy();
      p2BaselineRoot(copy);
      const path = "git-dist/core/copy.d.ts";
      let changedHash = "";
      p2EditBaselineShard(copy, "core.json", data => {
        const row = data.files.find(row => row.path === path)!;
        const bytes = Buffer.from(row.base64, "base64");
        bytes[0] = bytes[0]! ^ 1;
        row.base64 = bytes.toString("base64");
        changedHash = p2Digest(bytes);
        if (rehash) row.sha256 = changedHash;
      });
      if (rehash) p2EditBaselineShard(copy, "metadata.json", data => {
        data.inventory.find(row => row.path === path)!.sha256 = changedHash;
      });
      expect(() => p2BaselineRoot(copy)).toThrow(rehash
        ? "P2 baseline pinned shard hash mismatch: metadata.json"
        : `P2 baseline file hash mismatch: ${path}`);
    });
  }

  test("wrong byte length is rejected before materialization", () => {
    const copy = p2BaselineCopy();
    p2BaselineRoot(copy);
    p2EditBaselineShard(copy, "core.json", data => { data.files[0]!.byteLength++; });
    expect(() => p2BaselineRoot(copy)).toThrow("P2 baseline byte length mismatch:");
  });

  test("duplicate payload path is refused even when all bytes remain authentic", () => {
    const copy = p2BaselineCopy();
    p2BaselineRoot(copy);
    p2EditBaselineShard(copy, "core.json", data => { data.files.push({ ...data.files[0]! }); });
    expect(() => p2BaselineRoot(copy)).toThrow("P2 baseline duplicate file:");
  });

  test("duplicate inventory path is refused", () => {
    const copy = p2BaselineCopy();
    p2BaselineRoot(copy);
    p2EditBaselineShard(copy, "metadata.json", data => { data.inventory[1] = { ...data.inventory[0]! }; });
    expect(() => p2BaselineRoot(copy)).toThrow("P2 baseline duplicate inventory path:");
  });

  for (const path of ["../escape.d.ts", "/tmp/escape.d.ts", "git-dist/core/../../escape.d.ts", "git-dist/core/escape.js", "git-dist\\core\\escape.d.ts"]) {
    test(`refuses an escaping or disallowed payload path: ${path}`, () => {
      const copy = p2BaselineCopy();
      p2BaselineRoot(copy);
      p2EditBaselineShard(copy, "core.json", data => { data.files[0]!.path = path; });
      expect(() => p2BaselineRoot(copy)).toThrow(`P2 baseline unsafe or unlisted path: ${path}`);
    });
  }
});

test("P2 complete built surface matches manifests and immutable .22", () => {
  const result = checkContract({
    packageRoot: resolve(import.meta.dir, ".."),
    baselinePackageRoot: p2BaselineRoot(),
  });
  expect(result.currentVersion).toBe("0.23.0");
  expect(result.errors).toEqual([]);
});

describe("P2 public built and packed WS API", () => {
  for (const [label, make] of [["built", pArtifactFixture], ["packed", p2PackedArtifact]] as const) {
    test(`${label}: actual public imports compile owned/legacy and execute empty drain`, () => {
      const root = make();
      p2AssertPublicTypes(root);
      p2AssertPublicRuntime(root);
      expect(p2ArtifactComparison(root).errors).toEqual([]);
    });
  }

  test("copied actual JS without drain imports/constructs before the positive runtime oracle rejects it", () => {
    const root = pArtifactFixture();
    p2AssertPublicTypes(root);
    p2AssertPublicRuntime(root);
    p2Replace(join(root, "git-dist/server/index.js"), "  quiesceAndDrain() {", "  removedDrain() {");
    const result = p2WsRuntime(root);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("P2 imported and constructed");
    expect(result.stderr).toContain("P2 missing drain method");
    expect(result.stderr).not.toContain("Cannot find");
  });

  for (const [label, before, after, code, text, contractCode, contractName] of [
    ["removed drain", "    quiesceAndDrain(): Promise<void>;", "", 2339, "quiesceAndDrain", "signature-mismatch", "TmuxWsMux"],
    ["narrowed return", "    quiesceAndDrain(): Promise<void>;", "    quiesceAndDrain(): void;", 2322, "void", "signature-mismatch", "TmuxWsMux"],
    ["required option", "    ownedLifetime?: boolean;", "    ownedLifetime: boolean;", 2741, "ownedLifetime", "baseline-signature-change", "TmuxWsMuxOptions"],
    ["removed legacy member", "    stop(): void;", "", 2339, "stop", "baseline-signature-change", "TmuxWsMux"],
    ["missing inventory type", "export type MuxOwnedTaskInventory =", "type MuxOwnedTaskInventory =", 2305, "MuxOwnedTaskInventory", "missing-protected-export", "MuxOwnedTaskInventory"],
  ] as const) {
    test(`actual copied declarations reject ${label} after positive setup`, () => {
      const root = pArtifactFixture();
      p2AssertPublicTypes(root);
      p2AssertPublicRuntime(root);
      expect(p2ArtifactComparison(root).errors).toEqual([]);
      const declaration = join(root, "git-dist/server/ws-mux.d.ts");
      if (label === "missing inventory type") {
        // Disable ambient implicit exports; normalization must pass all three
        // positive oracles before removing the actual export modifier.
        writeFileSync(declaration, readFileSync(declaration, "utf8") + "\nexport {};\n");
        p2AssertPublicTypes(root);
        p2AssertPublicRuntime(root);
        expect(p2ArtifactComparison(root).errors).toEqual([]);
      }
      p2Replace(declaration, before, after);
      const negative = p2CompilePublic(root);
      expect(negative.resolution).toBe(join(root, "git-dist/server/index.d.ts"));
      expect(negative.errors.some(d => d.code === code && d.text.includes(text))).toBe(true);
      expect(negative.errors.some(d => d.code === 2307 || d.code === 1005)).toBe(false);
      // The real public JS still imports/runs: parse/setup failure is not RED.
      p2AssertPublicRuntime(root);
      expect(p2ArtifactComparison(root).errors).toContainEqual(expect.objectContaining({
        code: contractCode, subpath: "server", name: contractName,
      }));
    });
  }

  test("workspace export escape is rejected by the same public resolution oracle", () => {
    const root = pArtifactFixture();
    p2AssertPublicTypes(root);
    p2AssertPublicRuntime(root);
    const path = join(root, "package.json");
    const pkg = JSON.parse(readFileSync(path, "utf8"));
    pkg.exports["./server"] = { types: "../../server/src/index.ts", import: "../../server/src/index.ts" };
    writeFileSync(path, JSON.stringify(pkg));
    const result = p2CompilePublic(root);
    expect(result.resolution).toBeUndefined();
    expect(result.errors.some(d => d.code === 2307 && d.text.includes("thumbmux/server"))).toBe(true);
  });
});

describe("P2 exact .22 to .23 class graph tuples", () => {
  for (const row of P2_WS_SIGNATURES) {
    test(`${row[2]}: exact versions, spelling, kind and both digest pairs`, () => {
      expect(pReleaseComparison(row, { to: "0.23.0" }).errors).toEqual([]);
      for (const mutation of [
        { from: "0.21.0" }, { from: "0.22.1" }, { to: "0.23.1" }, { to: "0.24.0" },
        { name: `${row[2]}Unreviewed` }, { subpath: "core" as const }, { wrongKind: true },
        { oldSignature: "1".repeat(64) }, { newSignature: "2".repeat(64) },
        { oldCompatibility: "3".repeat(64) }, { newCompatibility: "4".repeat(64) },
      ]) {
        expect(pReleaseComparison(row, { to: "0.23.0", ...mutation }).errors
          .some(d => d.code === "baseline-signature-change")).toBe(true);
      }
      // Changing BOTH kinds must also miss the tuple (not just kindChanged).
      const changed = [...row];
      changed[3] = row[3] === "type" ? "value" : "type";
      expect(pReleaseComparison(changed, { to: "0.23.0" }).errors
        .some(d => d.code === "baseline-signature-change")).toBe(true);
    });
  }
});

describe("P2 TM0103 module resolution only (no browser semantics)", () => {
  test("package-local fallback and explicit override resolve independent fixture installations", () => {
    const script = readFileSync(resolve(import.meta.dir, "../svelte/tests/tm-01-03-webkit-red.mjs"), "utf8");
    expect(script).not.toMatch(/\/home\/|\/Users\/|webkit-\d+/);
    const expression = script.match(/const require = (createRequire\([\s\S]*?\));/)?.[1];
    expect(expression).toBe("createRequire(process.env.PLAYWRIGHT_FROM ?? import.meta.url)");
    const root = fixture();
    const local = join(root, "local");
    const override = join(root, "override");
    for (const [dir, id] of [[local, "local"], [override, "override"]]) {
      const packageDir = join(dir!, "node_modules/@playwright/test");
      mkdirSync(packageDir, { recursive: true });
      writeFileSync(join(packageDir, "package.json"), JSON.stringify({ name: "@playwright/test", main: "index.cjs" }));
      writeFileSync(join(packageDir, "index.cjs"), `module.exports = ${JSON.stringify(id)};`);
    }
    // Evaluate only the extracted resolver expression with fixture-local inputs.
    const resolveFrom = new Function("createRequire", "process", "moduleUrl",
      `return ${expression!.replace("import.meta.url", "moduleUrl")};`);
    const moduleUrl = pathToFileURL(join(local, "probe.mjs")).href;
    expect(resolveFrom(createRequire, { env: {} }, moduleUrl)("@playwright/test")).toBe("local");
    expect(resolveFrom(createRequire, { env: { PLAYWRIGHT_FROM: join(override, "package.json") } }, moduleUrl)("@playwright/test")).toBe("override");
  });
});
