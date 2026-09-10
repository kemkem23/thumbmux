/**
 * Subpath surface gate for `thumbmux/server/recall`.
 *
 * Why this file exists, stated plainly so nobody re-derives it later:
 * `scripts/contract-check.ts` builds its whole report from
 * `git-dist/{core,server,svelte,app}/index.d.ts`. Everything it can see must
 * therefore be reachable from a barrel. `server/recall` is a **subpath** and is
 * deliberately *not* re-exported from the server barrel — the barrel would then
 * drag `bun:sqlite` into every consumer that only wanted the mux. The result is
 * that today the surface gate is blind to it: deleting `createRecallHandler`,
 * or changing `readNote`'s parameters, leaves `bun run contract` green.
 *
 * The fix is NOT to hoist recall onto the barrel so the existing gate can see
 * it. Moving a name onto a public barrel to make it easier to check *is a
 * public contract change*, not an addition of a check. So this file checks the
 * subpath where it actually lives.
 *
 * What it checks, and against what:
 *   - the **installed artifact** (`node_modules/thumbmux`) of the host that
 *     depends on thumbmux — not `packages/thumbmux/git-dist`, not a path alias,
 *     not the source in this repo. A gate that reads the repo's own source
 *     cannot tell a released package from an unreleased edit;
 *   - its `exports["./server/recall"]` condition map still points at files that
 *     exist, for both `types` and `import`;
 *   - every public name and normalized declaration signature recorded in
 *     `contract/menu345-recall-surface.json`;
 *   - the runtime bindings the `.js` half actually exports, so a declaration
 *     that survives a deleted implementation is still caught.
 *
 * Scope, stated so the snapshot is not over-read: it records the surface of the
 * pinned artifact as supplementary evidence for one subpath. It assigns **no
 * tier**. `contract/manifest/*.json` remains the only tier inventory, and this
 * file does not retroactively promise F/S/X/D for anything.
 */

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import ts from "typescript";
import { normalizeDeclarationText } from "./contract-check";

const PACKAGE_ROOT = resolve(import.meta.dir, "..");
const SNAPSHOT_PATH = resolve(PACKAGE_ROOT, "contract", "menu345-recall-surface.json");
const SUBPATH = "./server/recall";
const SPECIFIER = "thumbmux/server/recall";

/** Contract breaks read `ผิดสัญญา`; a missing artifact reads `ARTIFACT MISSING`. */
const BREACH = "menu345-subpath: ผิดสัญญา (contract break)";
const MISSING = "menu345-subpath: ARTIFACT MISSING";

export type SurfaceKind = "value" | "type";

export type SurfaceEntry = {
  name: string;
  kind: SurfaceKind;
  /** sha256 over the normalized declaration frames. */
  signature: string;
  /** Normalized declaration text, kept so a diff is readable without a decoder. */
  declaration: string;
};

export type SubpathSurface = {
  subpath: string;
  declarations: SurfaceEntry[];
  /** Names the artifact's `.js` half binds at runtime, sorted. */
  runtime: string[];
};

export type ArtifactLocation = {
  hostRoot: string;
  artifactRoot: string;
  version: string;
  pin: string;
  typesPath: string;
  runtimePath: string;
  declaredTypes: string;
  declaredImport: string;
};

/** True when this tree is the monorepo copy rather than a standalone checkout. */
export function isMonorepoCheckout(packageRoot = PACKAGE_ROOT): boolean {
  return packageRoot.endsWith(`${sep}packages${sep}thumbmux`);
}

function readJson(path: string): Record<string, unknown> {
  const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} must contain a JSON object`);
  }
  return value as Record<string, unknown>;
}

function dependencyPin(pkg: Record<string, unknown>): string | null {
  for (const field of ["dependencies", "devDependencies"] as const) {
    const table = pkg[field];
    if (typeof table !== "object" || table === null) continue;
    const pin = (table as Record<string, unknown>).thumbmux;
    if (typeof pin === "string" && pin.length > 0) return pin;
  }
  return null;
}

/**
 * Walk up from `start` for the nearest package that both declares a `thumbmux`
 * dependency and has it installed. The walk stops after the first ancestor
 * holding a `.git` entry so it can never wander out of the checkout and grade
 * some unrelated tree's install.
 */
export function findConsumerHost(start = PACKAGE_ROOT): { root: string; pin: string } | null {
  let dir = start;
  for (;;) {
    const manifest = resolve(dir, "package.json");
    if (existsSync(manifest)) {
      const pin = dependencyPin(readJson(manifest));
      if (pin !== null && existsSync(resolve(dir, "node_modules", "thumbmux", "package.json"))) {
        return { root: dir, pin };
      }
    }
    if (existsSync(resolve(dir, ".git"))) return null;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function conditionPath(
  entry: unknown,
  condition: "types" | "import",
  context: string,
): string {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    throw new Error(`${BREACH}: ${context} must map ${SUBPATH} to a condition object`);
  }
  const value = (entry as Record<string, unknown>)[condition];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(
      `${BREACH}: ${context} no longer declares a "${condition}" condition for ${SUBPATH}`,
    );
  }
  return value;
}

/** Locate the installed subpath entrypoint of `hostRoot`'s thumbmux install. */
export function resolveSubpathArtifact(hostRoot: string, pin = ""): ArtifactLocation {
  const artifactRoot = resolve(hostRoot, "node_modules", "thumbmux");
  const manifestPath = resolve(artifactRoot, "package.json");
  if (!existsSync(manifestPath)) {
    throw new Error(`${MISSING}: no installed artifact manifest at ${manifestPath}`);
  }
  const pkg = readJson(manifestPath);
  const exportsMap = pkg.exports;
  if (typeof exportsMap !== "object" || exportsMap === null) {
    throw new Error(`${BREACH}: installed artifact declares no exports map`);
  }
  const entry = (exportsMap as Record<string, unknown>)[SUBPATH];
  if (entry === undefined) {
    throw new Error(
      `${BREACH}: installed artifact no longer exports ${SUBPATH}`
      + ` (a consumer's \`import ... from "${SPECIFIER}"\` stops resolving)`,
    );
  }
  const declaredTypes = conditionPath(entry, "types", "installed artifact");
  const declaredImport = conditionPath(entry, "import", "installed artifact");
  const typesPath = resolve(artifactRoot, declaredTypes);
  const runtimePath = resolve(artifactRoot, declaredImport);
  for (const [label, path] of [["types", typesPath], ["import", runtimePath]] as const) {
    if (!existsSync(path)) {
      throw new Error(`${MISSING}: ${SUBPATH} "${label}" file is absent from the install: ${path}`);
    }
  }
  const version = typeof pkg.version === "string" ? pkg.version : "";
  return { hostRoot, artifactRoot, version, pin, typesPath, runtimePath, declaredTypes, declaredImport };
}

function compilerOptions(): ts.CompilerOptions {
  return {
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    noEmit: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ESNext,
    types: [],
  };
}

function resolveAlias(checker: ts.TypeChecker, symbol: ts.Symbol): ts.Symbol {
  if (!(symbol.flags & ts.SymbolFlags.Alias)) return symbol;
  try {
    return checker.getAliasedSymbol(symbol);
  } catch {
    return symbol;
  }
}

/**
 * Read every public name and its normalized declaration text out of a built
 * `.d.ts` entrypoint. Deliberately whole-declaration: for a class this includes
 * its members, so a changed constructor or a dropped readonly field is drift.
 */
export function deriveSubpathSurface(typesPath: string, runtimeNames: readonly string[]): SubpathSurface {
  const program = ts.createProgram([typesPath], compilerOptions());
  const sourceFile = program.getSourceFile(typesPath);
  if (!sourceFile) throw new Error(`${MISSING}: could not read declaration entrypoint ${typesPath}`);
  const checker = program.getTypeChecker();
  const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
  if (!moduleSymbol) throw new Error(`${BREACH}: ${typesPath} declares no module surface`);

  const declarations = checker.getExportsOfModule(moduleSymbol).map((exported) => {
    const symbol = resolveAlias(checker, exported);
    const nodes = [...(symbol.declarations ?? [])].sort((left, right) =>
      left.getSourceFile().fileName.localeCompare(right.getSourceFile().fileName)
      || left.pos - right.pos);
    if (nodes.length === 0) {
      throw new Error(`${BREACH}: public symbol has no declaration: ${exported.getName()}`);
    }
    const frames: string[] = [];
    for (const node of nodes) {
      const text = normalizeDeclarationText(node.getText());
      if (!frames.includes(text)) frames.push(text);
    }
    return {
      name: exported.getName(),
      kind: (symbol.flags & ts.SymbolFlags.Value ? "value" : "type") as SurfaceKind,
      signature: createHash("sha256").update(JSON.stringify(frames), "utf8").digest("hex"),
      declaration: frames.join(" ; "),
    };
  }).sort((left, right) => left.name.localeCompare(right.name));

  return { subpath: SPECIFIER, declarations, runtime: [...runtimeNames].sort() };
}

/** Import the artifact's runtime half and report the bindings it really has. */
export async function readRuntimeExports(runtimePath: string): Promise<string[]> {
  const loaded = (await import(runtimePath)) as Record<string, unknown>;
  return Object.keys(loaded).filter((name) => name !== "default").sort();
}

export function readSnapshot(path = SNAPSHOT_PATH): SubpathSurface {
  if (!existsSync(path)) {
    throw new Error(`${MISSING}: recorded subpath surface is absent: ${path}`);
  }
  const value = readJson(path);
  const declarations = value.declarations;
  const runtime = value.runtime;
  if (!Array.isArray(declarations) || !Array.isArray(runtime)) {
    throw new Error(`${path} must record "declarations" and "runtime" arrays`);
  }
  return {
    subpath: String(value.subpath),
    declarations: declarations as SurfaceEntry[],
    runtime: runtime as string[],
  };
}

/**
 * Compare a recorded surface against a live one. Every message is a contract
 * break; "the file was not there" is raised by the resolver above instead, so
 * the two failure modes never share wording.
 */
export function compareSurface(expected: SubpathSurface, actual: SubpathSurface): string[] {
  const problems: string[] = [];
  const live = new Map(actual.declarations.map((entry) => [entry.name, entry]));
  for (const want of expected.declarations) {
    const got = live.get(want.name);
    if (!got) {
      problems.push(
        `${BREACH}: removed export ${SPECIFIER}#${want.name}`
        + ` (recorded ${want.kind}: ${want.declaration})`,
      );
      continue;
    }
    if (got.kind !== want.kind) {
      problems.push(
        `${BREACH}: ${SPECIFIER}#${want.name} changed kind ${want.kind} -> ${got.kind}`,
      );
    }
    if (got.signature !== want.signature) {
      problems.push(
        `${BREACH}: changed public signature of ${SPECIFIER}#${want.name}`
        + `\n    recorded: ${want.declaration}`
        + `\n    installed: ${got.declaration}`,
      );
    }
  }
  for (const got of actual.declarations) {
    if (!expected.declarations.some((entry) => entry.name === got.name)) {
      problems.push(
        `${BREACH}: undeclared export ${SPECIFIER}#${got.name} is not recorded in the snapshot`
        + ` (additive changes are allowed, but must be recorded intentionally)`,
      );
    }
  }
  for (const name of expected.runtime) {
    if (!actual.runtime.includes(name)) {
      problems.push(`${BREACH}: runtime binding ${SPECIFIER}#${name} is gone from the installed .js`);
    }
  }
  for (const name of actual.runtime) {
    if (!expected.runtime.includes(name)) {
      problems.push(`${BREACH}: unrecorded runtime binding ${SPECIFIER}#${name}`);
    }
  }
  return problems;
}

const host = findConsumerHost();

describe("thumbmux/server/recall subpath surface", () => {
  test("the checked-in snapshot records a surface the existing barrel gate cannot see", () => {
    const snapshot = readSnapshot();
    expect(snapshot.subpath).toBe(SPECIFIER);
    expect(snapshot.declarations.length).toBeGreaterThan(0);
    expect(snapshot.runtime.length).toBeGreaterThan(0);
    // The premise of this whole file. If recall ever does reach the server
    // barrel, `contract-check.ts` covers it and this line should fail loudly
    // rather than let two gates silently disagree about who owns the name.
    const barrel = resolve(PACKAGE_ROOT, "git-dist", "server", "index.d.ts");
    if (existsSync(barrel)) {
      const text = readFileSync(barrel, "utf8");
      for (const entry of snapshot.declarations) {
        expect(text.includes(entry.name)).toBe(false);
      }
    }
  });

  test("a monorepo checkout has a consumer that installed the pinned artifact", () => {
    if (!isMonorepoCheckout()) return;
    // Inside the monorepo the reference consumer is what makes the subpath a
    // shipped promise. No install means nothing was actually verified, and a
    // green run here would be a lie of omission.
    expect(host).not.toBeNull();
  });

  test.skipIf(host === null)(
    "the installed artifact still exports the recorded recall surface",
    async () => {
      const found = host!;
      const artifact = resolveSubpathArtifact(found.root, found.pin);
      const runtime = await readRuntimeExports(artifact.runtimePath);
      const live = deriveSubpathSurface(artifact.typesPath, runtime);
      const problems = compareSurface(readSnapshot(), live);
      expect(problems.join("\n")).toBe("");
    },
  );
});

/**
 * Instrument verification. A gate nobody has watched fail is a gate nobody
 * knows works. Each case builds a synthetic artifact root in a temp directory,
 * mutates one thing, and asserts the *wording* of the failure — because
 * "changed signature" and "file not found" must never be confused for each
 * other when someone reads a red log at 2am.
 */
describe("the subpath gate reports breaks and absences differently", () => {
  function stageArtifact(): { root: string; cleanup: () => void } {
    const found = host;
    if (!found) throw new Error("no consumer host to stage from");
    const source = resolveSubpathArtifact(found.root, found.pin);
    const root = mkdtempSync(join(tmpdir(), "thumbmux-menu345-subpath-"));
    const target = resolve(root, "node_modules", "thumbmux");
    const dist = resolve(target, "git-dist", "server");
    mkdirSync(dist, { recursive: true });
    cpSync(source.typesPath, resolve(dist, "recall-handler.d.ts"));
    cpSync(source.runtimePath, resolve(dist, "recall-handler.js"));
    writeFileSync(
      resolve(target, "package.json"),
      JSON.stringify({
        name: "thumbmux",
        version: source.version,
        type: "module",
        exports: {
          [SUBPATH]: {
            types: "./git-dist/server/recall-handler.d.ts",
            import: "./git-dist/server/recall-handler.js",
          },
        },
      }, null, 2),
    );
    writeFileSync(
      resolve(root, "package.json"),
      JSON.stringify({ name: "menu345-staged-host", dependencies: { thumbmux: source.pin || "staged" } }, null, 2),
    );
    return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
  }

  test.skipIf(host === null)("a changed parameter list fails as a contract break", async () => {
    const staged = stageArtifact();
    try {
      const types = resolve(staged.root, "node_modules", "thumbmux", "git-dist", "server", "recall-handler.d.ts");
      const before = readFileSync(types, "utf8");
      const mutated = before.replace(
        "readNote(session: string, expectedLifecycleId?: string)",
        "readNote(session: string, expectedLifecycleId: string)",
      );
      expect(mutated).not.toBe(before);
      writeFileSync(types, mutated);

      const artifact = resolveSubpathArtifact(staged.root);
      const runtime = await readRuntimeExports(artifact.runtimePath);
      const problems = compareSurface(readSnapshot(), deriveSubpathSurface(artifact.typesPath, runtime));
      expect(problems.length).toBeGreaterThan(0);
      expect(problems.join("\n")).toContain("changed public signature");
      expect(problems.join("\n")).toContain("RecallHandler");
      expect(problems.join("\n")).not.toContain(MISSING);
    } finally {
      staged.cleanup();
    }
  });

  test.skipIf(host === null)("a deleted export fails as a removal, not as a missing file", async () => {
    const staged = stageArtifact();
    try {
      const types = resolve(staged.root, "node_modules", "thumbmux", "git-dist", "server", "recall-handler.d.ts");
      const before = readFileSync(types, "utf8");
      const mutated = before.replace(
        "export declare function createRecallHandler(opts: RecallHandlerOptions): RecallHandler;\n",
        "",
      );
      expect(mutated).not.toBe(before);
      writeFileSync(types, mutated);

      const artifact = resolveSubpathArtifact(staged.root);
      const runtime = await readRuntimeExports(artifact.runtimePath);
      const problems = compareSurface(readSnapshot(), deriveSubpathSurface(artifact.typesPath, runtime));
      expect(problems.join("\n")).toContain("removed export thumbmux/server/recall#createRecallHandler");
      expect(problems.join("\n")).not.toContain(MISSING);
    } finally {
      staged.cleanup();
    }
  });

  test.skipIf(host === null)("a declaration that outlives its implementation is caught", async () => {
    // The case a declaration-only gate cannot see: the `.d.ts` still promises
    // the name, the shipped `.js` no longer binds it, and every typecheck in
    // every consumer stays green until something calls it at runtime.
    const staged = stageArtifact();
    try {
      const runtimeFile = resolve(staged.root, "node_modules", "thumbmux", "git-dist", "server", "recall-handler.js");
      const before = readFileSync(runtimeFile, "utf8");
      const mutated = before.replace("\n  createRecallHandler,", "");
      expect(mutated).not.toBe(before);
      writeFileSync(runtimeFile, mutated);

      const artifact = resolveSubpathArtifact(staged.root);
      const runtime = await readRuntimeExports(artifact.runtimePath);
      expect(runtime).not.toContain("createRecallHandler");
      const problems = compareSurface(readSnapshot(), deriveSubpathSurface(artifact.typesPath, runtime));
      expect(problems.join("\n")).toContain(
        "runtime binding thumbmux/server/recall#createRecallHandler is gone from the installed .js",
      );
      expect(problems.join("\n")).not.toContain(MISSING);
    } finally {
      staged.cleanup();
    }
  });

  test.skipIf(host === null)("a dropped subpath export fails before any file is read", () => {
    const staged = stageArtifact();
    try {
      const manifest = resolve(staged.root, "node_modules", "thumbmux", "package.json");
      writeFileSync(manifest, JSON.stringify({ name: "thumbmux", version: "0.0.0", exports: {} }, null, 2));
      expect(() => resolveSubpathArtifact(staged.root)).toThrow(/no longer exports \.\/server\/recall/);
    } finally {
      staged.cleanup();
    }
  });

  test.skipIf(host === null)("an absent declaration file says ARTIFACT MISSING, not ผิดสัญญา", () => {
    const staged = stageArtifact();
    try {
      const types = resolve(staged.root, "node_modules", "thumbmux", "git-dist", "server", "recall-handler.d.ts");
      rmSync(types);
      let message = "";
      try {
        resolveSubpathArtifact(staged.root);
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toContain(MISSING);
      expect(message).not.toContain("ผิดสัญญา");
    } finally {
      staged.cleanup();
    }
  });
});
