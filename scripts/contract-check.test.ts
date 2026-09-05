import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
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

  test("the v0.18.18 pushSessionInventory alias requires the exact patch and digest pair", () => {
    const name = "TmuxWsMux";
    const baselineDigest = "b56a5adebfc41698659299d151810ca4f52d01eadf5df4659073716219fa0782";
    const reviewedDigest = "9ba44fbc46c195803b405d3f7ba45377dbcda95c6cab5ac88911ebbe7ce20f68";
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
      "0.18.17",
      "0.18.18",
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
      "0.18.17",
      "0.18.18",
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
      "export declare class PublicClass { private renamedSecret; read(): string; }",
    ]);
    const after = deriveGitDistReport(root, ["core"]).core[0]?.signature;

    expect(after).toBe(before);
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

test("skipping the baseline takes a deliberate opt-out", () => {
  const skipped = resolveBaselineMode({ THUMBMUX_CONTRACT_BASELINE: "skip" });
  expect(skipped.skipped).toBe(true);
  expect(skipped.error).toBeUndefined();
  // Anything other than the exact word is not an opt-out.
  expect(resolveBaselineMode({ THUMBMUX_CONTRACT_BASELINE: "yes" }).error).toBeTruthy();
});

test("an empty baseline root is treated as absent rather than as a directory", () => {
  expect(resolveBaselineMode({ THUMBMUX_CONTRACT_BASELINE_ROOT: "   " }).error).toBeTruthy();
});
