import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import ts from "typescript";
import {
  assertGitDistExportParity,
  type GitDistExportManifests,
  type PublicSubpackage,
} from "./rewrite-git-dist-imports";

const PACKAGE_ROOT = resolve(import.meta.dir, "..");
export const CONTRACT_SUBPACKAGES = ["core", "server", "svelte", "app"] as const;

export type ContractKind = "value" | "type" | "component";
export type ContractTier = "F" | "S" | "X" | "D";

export type ContractDeprecation = {
  since: string;
  removeNoEarlierThan: string;
  replacement: string;
};

export type LiveContractEntry = {
  name: string;
  kind: ContractKind;
  signature: string;
};

export type ContractEntry = LiveContractEntry & {
  tier: ContractTier;
  deprecated?: ContractDeprecation;
};

export type GitDistContractReport = Record<PublicSubpackage, LiveContractEntry[]>;

export type ContractDiagnosticCode =
  | "missing-protected-export"
  | "signature-mismatch"
  | "kind-mismatch"
  | "undeclared-export"
  | "experimental-signature-change"
  | "experimental-kind-change"
  | "experimental-removal"
  | "deprecated-early-removal"
  | "deprecated-removal-eligible"
  | "deprecated-removal-due";

export type ContractDiagnostic = {
  code: ContractDiagnosticCode;
  subpath: PublicSubpackage;
  name: string;
  message: string;
};

export type ContractEvaluation = {
  errors: ContractDiagnostic[];
  warnings: ContractDiagnostic[];
  summaries: ContractDiagnostic[];
};

export type ContractCheckResult = ContractEvaluation & {
  currentVersion: string;
  live: GitDistContractReport;
  manifests: Record<PublicSubpackage, ContractEntry[]>;
};

export type ContractCheckOptions = {
  packageRoot?: string;
  subpackages?: readonly PublicSubpackage[];
  /** Unit fixtures can omit source barrels and runtime JS. The release gate cannot. */
  validateExportParity?: boolean;
};

function compilerOptions(): ts.CompilerOptions {
  return {
    allowArbitraryExtensions: true,
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
 * Normalize declaration trivia without touching whitespace inside string and
 * template literal tokens. Comments and formatting are not API signatures.
 */
export function normalizeDeclarationText(source: string): string {
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    true,
    ts.LanguageVariant.Standard,
    source,
  );
  const tokens: string[] = [];
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    tokens.push(scanner.getTokenText());
  }
  return tokens.join(" ");
}

function signatureHash(parts: readonly string[]): string {
  // JSON frames overloads/declaration merges unambiguously while the payload of
  // every frame remains the normalized declaration text required by the gate.
  const normalized = JSON.stringify(parts.map(normalizeDeclarationText));
  return createHash("sha256").update(normalized, "utf8").digest("hex");
}

function componentExports(sourceFile: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  for (const statement of sourceFile.statements) {
    if (!ts.isExportDeclaration(statement) || statement.isTypeOnly) continue;
    if (!statement.moduleSpecifier || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    if (!statement.moduleSpecifier.text.endsWith(".svelte")) continue;
    if (!statement.exportClause || !ts.isNamedExports(statement.exportClause)) continue;
    for (const specifier of statement.exportClause.elements) {
      if (!specifier.isTypeOnly && specifier.propertyName?.text === "default") {
        names.add(specifier.name.text);
      }
    }
  }
  return names;
}

function svelteComponentPropsNode(typeNode: ts.TypeNode | undefined): ts.TypeNode | undefined {
  if (!typeNode) return undefined;
  if (ts.isImportTypeNode(typeNode)) {
    const moduleName = ts.isLiteralTypeNode(typeNode.argument)
      && ts.isStringLiteral(typeNode.argument.literal)
      ? typeNode.argument.literal.text
      : null;
    if (moduleName === "svelte" && typeNode.qualifier?.getText() === "Component") {
      return typeNode.typeArguments?.[0];
    }
  }
  if (ts.isTypeReferenceNode(typeNode) && typeNode.typeName.getText() === "Component") {
    return typeNode.typeArguments?.[0];
  }
  return undefined;
}

function typeReferenceSymbol(
  checker: ts.TypeChecker,
  node: ts.TypeNode,
): ts.Symbol | undefined {
  if (ts.isTypeReferenceNode(node)) {
    const symbol = checker.getSymbolAtLocation(node.typeName);
    return symbol ? resolveAlias(checker, symbol) : undefined;
  }
  if (ts.isTypeQueryNode(node)) {
    const symbol = checker.getSymbolAtLocation(node.exprName);
    return symbol ? resolveAlias(checker, symbol) : undefined;
  }
  return undefined;
}

function interfaceShapeText(declaration: ts.InterfaceDeclaration): string {
  const typeParameters = declaration.typeParameters?.length
    ? `<${declaration.typeParameters.map((node) => node.getText()).join(", ")}>`
    : "";
  const heritage = declaration.heritageClauses?.map((node) => node.getText()).join(" ") ?? "";
  return `${typeParameters} ${heritage} { ${declaration.members.map((node) => node.getText()).join(" ")} }`;
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node)
    && Boolean(ts.getModifiers(node)?.some((modifier) => modifier.kind === kind));
}

function classMemberIsPrivate(member: ts.ClassElement): boolean {
  if (member.name && ts.isPrivateIdentifier(member.name)) return true;
  return hasModifier(member, ts.SyntaxKind.PrivateKeyword);
}

function classSurfaceText(declaration: ts.ClassDeclaration): string {
  const abstract = hasModifier(declaration, ts.SyntaxKind.AbstractKeyword) ? "abstract " : "";
  const name = declaration.name?.getText() ?? "default";
  const typeParameters = declaration.typeParameters?.length
    ? `<${declaration.typeParameters.map((node) => node.getText()).join(", ")}>`
    : "";
  const heritage = declaration.heritageClauses?.map((node) => node.getText()).join(" ") ?? "";
  const members = declaration.members.flatMap((member) => {
    if (!classMemberIsPrivate(member)) return [member.getText()];
    // Constructor accessibility affects whether consumers may instantiate the
    // class, but private implementation fields and their names do not.
    return ts.isConstructorDeclaration(member) ? ["private constructor;"] : [];
  });
  return `${abstract}class ${name}${typeParameters} ${heritage} { ${members.join(" ")} }`;
}

function signatureNodeForDeclaration(declaration: ts.Declaration): ts.Node {
  if (
    ts.isVariableDeclaration(declaration)
    && ts.isVariableDeclarationList(declaration.parent)
    && ts.isVariableStatement(declaration.parent.parent)
  ) {
    return declaration.parent.parent;
  }
  return declaration;
}

function declarationSurfaceText(declaration: ts.Declaration): string {
  if (ts.isClassDeclaration(declaration)) return classSurfaceText(declaration);
  return signatureNodeForDeclaration(declaration).getText();
}

function signatureTraversalNodes(declaration: ts.Declaration): readonly ts.Node[] {
  if (ts.isClassDeclaration(declaration)) {
    return [
      ...(declaration.typeParameters ?? []),
      ...(declaration.heritageClauses ?? []),
      ...declaration.members.filter((member) => !classMemberIsPrivate(member)),
    ];
  }
  return [declaration];
}

function supportingDeclaration(declaration: ts.Declaration): boolean {
  if (
    ts.isTypeAliasDeclaration(declaration)
    || ts.isInterfaceDeclaration(declaration)
    || ts.isClassDeclaration(declaration)
    || ts.isEnumDeclaration(declaration)
    || ts.isFunctionDeclaration(declaration)
  ) {
    return true;
  }
  return ts.isVariableDeclaration(declaration)
    && ts.isVariableDeclarationList(declaration.parent)
    && ts.isVariableStatement(declaration.parent.parent);
}

function declarationInside(declaration: ts.Declaration, declarationRoot: string): boolean {
  const file = resolve(declaration.getSourceFile().fileName);
  return file === declarationRoot || file.startsWith(`${declarationRoot}${sep}`);
}

function referencedTypeSymbol(checker: ts.TypeChecker, node: ts.Node): ts.Symbol | undefined {
  let location: ts.Node | undefined;
  if (ts.isTypeReferenceNode(node)) location = node.typeName;
  else if (ts.isExpressionWithTypeArguments(node)) location = node.expression;
  else if (ts.isTypeQueryNode(node)) location = node.exprName;
  else if (ts.isImportTypeNode(node)) location = node.qualifier;
  if (!location) return undefined;
  const symbol = checker.getSymbolAtLocation(location);
  return symbol ? resolveAlias(checker, symbol) : undefined;
}

function declarationKey(declaration: ts.Declaration): string {
  return `${declaration.getSourceFile().fileName}:${declaration.pos}:${declaration.end}`;
}

function signatureWithDependencies(
  checker: ts.TypeChecker,
  rootDeclarations: readonly ts.Declaration[],
  rootTexts: readonly string[],
  traversalRoots: readonly ts.Node[],
  declarationRoot: string,
): string {
  const rootKeys = new Set(rootDeclarations.map(declarationKey));
  const dependencies = new Map<string, ts.Declaration>();
  const pending: ts.Node[] = [...traversalRoots];
  for (let index = 0; index < pending.length; index++) {
    const node = pending[index];
    const symbol = referencedTypeSymbol(checker, node);
    if (symbol) {
      for (const declaration of symbol.declarations ?? []) {
        const key = declarationKey(declaration);
        if (
          rootKeys.has(key)
          || dependencies.has(key)
          || !supportingDeclaration(declaration)
          || !declarationInside(declaration, declarationRoot)
        ) {
          continue;
        }
        dependencies.set(key, declaration);
        pending.push(...signatureTraversalNodes(declaration));
      }
    }
    ts.forEachChild(node, (child) => {
      pending.push(child);
    });
  }

  const dependencyTexts = [...dependencies.values()]
    .sort((left, right) =>
      left.getSourceFile().fileName.localeCompare(right.getSourceFile().fileName)
      || left.pos - right.pos)
    .map(declarationSurfaceText);
  return signatureHash([...rootTexts, ...dependencyTexts]);
}

function componentPropsSignature(
  checker: ts.TypeChecker,
  symbol: ts.Symbol,
  exportName: string,
  declarationRoot: string,
): string {
  const declarations = symbol.declarations ?? [];
  for (const declaration of declarations) {
    if (!ts.isVariableDeclaration(declaration)) continue;
    const propsNode = svelteComponentPropsNode(declaration.type);
    if (!propsNode) continue;

    const propsSymbol = typeReferenceSymbol(checker, propsNode);
    const propDeclarations = [...(propsSymbol?.declarations ?? [])].sort((left, right) =>
      left.getSourceFile().fileName.localeCompare(right.getSourceFile().fileName)
      || left.pos - right.pos);
    const parts = propDeclarations.map((propsDeclaration) => {
      if (ts.isTypeAliasDeclaration(propsDeclaration)) return propsDeclaration.type.getText();
      if (ts.isInterfaceDeclaration(propsDeclaration)) return interfaceShapeText(propsDeclaration);
      return propsDeclaration.getText();
    });
    if (parts.length === 0) parts.push(propsNode.getText());
    const traversalRoots: ts.Node[] = propDeclarations.length > 0
      ? propDeclarations.flatMap(signatureTraversalNodes)
      : [propsNode];
    if (ts.isTypeReferenceNode(propsNode) && propsNode.typeArguments?.length) {
      parts.push(...propsNode.typeArguments.map((argument) => argument.getText()));
      traversalRoots.push(...propsNode.typeArguments);
    }
    return signatureWithDependencies(
      checker,
      propDeclarations,
      parts,
      traversalRoots,
      declarationRoot,
    );
  }
  throw new Error(`could not read Svelte props declaration for component ${exportName}`);
}

function declarationSignature(
  checker: ts.TypeChecker,
  symbol: ts.Symbol,
  declarationRoot: string,
): string {
  const declarations = [...(symbol.declarations ?? [])].sort((left, right) =>
    left.getSourceFile().fileName.localeCompare(right.getSourceFile().fileName)
    || left.pos - right.pos);
  if (declarations.length === 0) {
    throw new Error(`public symbol has no declaration: ${symbol.getName()}`);
  }

  const parts: string[] = [];
  const seen = new Set<string>();
  for (const declaration of declarations) {
    const text = declarationSurfaceText(declaration);
    if (!seen.has(text)) {
      seen.add(text);
      parts.push(text);
    }
  }
  return signatureWithDependencies(
    checker,
    declarations,
    parts,
    declarations.flatMap(signatureTraversalNodes),
    declarationRoot,
  );
}

function emptyReport(): GitDistContractReport {
  return { core: [], server: [], svelte: [], app: [] };
}

/** Read public names and normalized declaration signatures from built git-dist. */
export function deriveGitDistReport(
  packageRoot = PACKAGE_ROOT,
  subpackages: readonly PublicSubpackage[] = CONTRACT_SUBPACKAGES,
  parity?: GitDistExportManifests,
): GitDistContractReport {
  const report = emptyReport();
  const declarationRoot = resolve(packageRoot, "git-dist");
  for (const subpath of subpackages) {
    const entryPath = resolve(packageRoot, "git-dist", subpath, "index.d.ts");
    const program = ts.createProgram([entryPath], compilerOptions());
    const sourceFile = program.getSourceFile(entryPath);
    if (!sourceFile) throw new Error(`missing git-dist declaration entrypoint: ${entryPath}`);
    const checker = program.getTypeChecker();
    const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
    if (!moduleSymbol) throw new Error(`could not inspect git-dist entrypoint: ${entryPath}`);

    const components = componentExports(sourceFile);
    const runtime = parity ? new Set(parity[subpath].runtime) : null;
    report[subpath] = checker.getExportsOfModule(moduleSymbol).map((exportedSymbol) => {
      const symbol = resolveAlias(checker, exportedSymbol);
      const name = exportedSymbol.getName();
      const isComponent = components.has(name);
      const kind: ContractKind = isComponent
        ? "component"
        : (runtime?.has(name) ?? Boolean(symbol.flags & ts.SymbolFlags.Value))
          ? "value"
          : "type";
      return {
        name,
        kind,
        signature: isComponent
          ? componentPropsSignature(checker, symbol, name, declarationRoot)
          : declarationSignature(checker, symbol, declarationRoot),
      };
    }).sort((left, right) => left.name.localeCompare(right.name));

    if (parity) {
      const liveNames = new Set(report[subpath].map(({ name }) => name));
      if (
        liveNames.size !== parity[subpath].declarations.length
        || parity[subpath].declarations.some((name) => !liveNames.has(name))
      ) {
        throw new Error(`${subpath} git-dist declaration inventory disagrees with export parity`);
      }
    }
  }
  return report;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertStringField(
  value: Record<string, unknown>,
  field: string,
  context: string,
): string {
  const item = value[field];
  if (typeof item !== "string" || item.length === 0) {
    throw new Error(`${context}.${field} must be a non-empty string`);
  }
  return item;
}

/** Load and validate a checked-in manifest before applying compatibility policy. */
export function readContractManifest(
  packageRoot: string,
  subpath: PublicSubpackage,
): ContractEntry[] {
  const path = resolve(packageRoot, "contract", "manifest", `${subpath}.json`);
  const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!Array.isArray(value)) throw new Error(`${path} must contain a JSON array`);
  const names = new Set<string>();
  return value.map((item, index) => {
    const context = `${path}[${index}]`;
    if (!isRecord(item)) throw new Error(`${context} must be an object`);
    const name = assertStringField(item, "name", context);
    if (names.has(name)) throw new Error(`${path} contains duplicate export ${name}`);
    names.add(name);
    const kind = assertStringField(item, "kind", context);
    if (kind !== "value" && kind !== "type" && kind !== "component") {
      throw new Error(`${context}.kind must be value, type, or component`);
    }
    const tier = assertStringField(item, "tier", context);
    if (tier !== "F" && tier !== "S" && tier !== "X" && tier !== "D") {
      throw new Error(`${context}.tier must be F, S, X, or D`);
    }
    const signature = assertStringField(item, "signature", context);
    if (!/^[a-f0-9]{64}$/.test(signature)) {
      throw new Error(`${context}.signature must be a lowercase SHA-256 digest`);
    }
    let deprecated: ContractDeprecation | undefined;
    if (item.deprecated !== undefined) {
      if (!isRecord(item.deprecated)) throw new Error(`${context}.deprecated must be an object`);
      deprecated = {
        since: assertStringField(item.deprecated, "since", `${context}.deprecated`),
        removeNoEarlierThan: assertStringField(
          item.deprecated,
          "removeNoEarlierThan",
          `${context}.deprecated`,
        ),
        replacement: assertStringField(item.deprecated, "replacement", `${context}.deprecated`),
      };
    }
    return { name, kind, tier, signature, ...(deprecated ? { deprecated } : {}) };
  });
}

type ParsedSemver = {
  core: readonly [number, number, number];
  prerelease: readonly string[] | null;
};

function parseSemver(version: string): ParsedSemver {
  const match = version.match(
    /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/,
  );
  if (!match) throw new Error(`invalid semantic version: ${version}`);
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] ? match[4].split(".") : null,
  };
}

function compareVersions(left: string, right: string): number {
  const a = parseSemver(left);
  const b = parseSemver(right);
  for (let index = 0; index < a.core.length; index++) {
    if (a.core[index] !== b.core[index]) return a.core[index] - b.core[index];
  }
  if (!a.prerelease && !b.prerelease) return 0;
  if (!a.prerelease) return 1;
  if (!b.prerelease) return -1;
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index++) {
    const leftPart = a.prerelease[index];
    const rightPart = b.prerelease[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    if (leftPart === rightPart) continue;
    const leftNumeric = /^\d+$/.test(leftPart);
    const rightNumeric = /^\d+$/.test(rightPart);
    if (leftNumeric && rightNumeric) return Number(leftPart) - Number(rightPart);
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftPart.localeCompare(rightPart);
  }
  return 0;
}

function diagnostic(
  code: ContractDiagnosticCode,
  subpath: PublicSubpackage,
  entry: Pick<ContractEntry, "name">,
  message: string,
): ContractDiagnostic {
  return { code, subpath, name: entry.name, message: `${subpath}: ${message}` };
}

/** Apply the tier and deprecation rules to one subpath without reading files. */
export function evaluateManifest(
  subpath: PublicSubpackage,
  manifest: readonly ContractEntry[],
  live: readonly LiveContractEntry[],
  currentVersion: string,
): ContractEvaluation {
  const errors: ContractDiagnostic[] = [];
  const warnings: ContractDiagnostic[] = [];
  const summaries: ContractDiagnostic[] = [];
  const liveByName = new Map(live.map((entry) => [entry.name, entry]));
  const manifestNames = new Set<string>();

  for (const expected of manifest) {
    if (manifestNames.has(expected.name)) {
      throw new Error(`${subpath} manifest contains duplicate export ${expected.name}`);
    }
    manifestNames.add(expected.name);
    const actual = liveByName.get(expected.name);
    if (!actual) {
      if (expected.deprecated) {
        if (compareVersions(currentVersion, expected.deprecated.removeNoEarlierThan) < 0) {
          errors.push(diagnostic(
            "deprecated-early-removal",
            subpath,
            expected,
            `deprecated export "${expected.name}" was removed before ${expected.deprecated.removeNoEarlierThan}`,
          ));
        } else {
          summaries.push(diagnostic(
            "deprecated-removal-eligible",
            subpath,
            expected,
            `deprecated export "${expected.name}" is absent at an eligible removal version`,
          ));
        }
      } else if (expected.tier === "X") {
        summaries.push(diagnostic(
          "experimental-removal",
          subpath,
          expected,
          `X export "${expected.name}" is absent (experimental removal allowed)`,
        ));
      } else {
        errors.push(diagnostic(
          "missing-protected-export",
          subpath,
          expected,
          `${expected.tier} export "${expected.name}" is missing from git-dist`,
        ));
      }
      continue;
    }

    if (
      expected.deprecated
      && compareVersions(currentVersion, expected.deprecated.removeNoEarlierThan) >= 0
    ) {
      warnings.push(diagnostic(
        "deprecated-removal-due",
        subpath,
        expected,
        `deprecated export "${expected.name}" remains after ${expected.deprecated.removeNoEarlierThan}`,
      ));
    }

    if (expected.kind !== actual.kind) {
      const item = diagnostic(
        expected.tier === "X" ? "experimental-kind-change" : "kind-mismatch",
        subpath,
        expected,
        `${expected.tier} export "${expected.name}" changed kind from ${expected.kind} to ${actual.kind}`,
      );
      (expected.tier === "X" ? summaries : errors).push(item);
    }
    if (expected.signature !== actual.signature) {
      const item = diagnostic(
        expected.tier === "X" ? "experimental-signature-change" : "signature-mismatch",
        subpath,
        expected,
        `${expected.tier} export "${expected.name}" signature mismatch (manifest ${expected.signature}, git-dist ${actual.signature})`,
      );
      (expected.tier === "X" ? summaries : errors).push(item);
    }
  }

  for (const actual of live) {
    if (manifestNames.has(actual.name)) continue;
    errors.push(diagnostic(
      "undeclared-export",
      subpath,
      actual,
      `new public export "${actual.name}" is not declared; add it to the manifest and declare a tier`,
    ));
  }
  return { errors, warnings, summaries };
}

/** Run the checked-in surface gate against a built package root. */
export function checkContract(options: ContractCheckOptions = {}): ContractCheckResult {
  const packageRoot = resolve(options.packageRoot ?? PACKAGE_ROOT);
  const subpackages = options.subpackages ?? CONTRACT_SUBPACKAGES;
  const pkg = JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf8")) as {
    version?: unknown;
  };
  if (typeof pkg.version !== "string") throw new Error("package.json version must be a string");
  parseSemver(pkg.version);

  const parity = options.validateExportParity === false
    ? undefined
    : assertGitDistExportParity(packageRoot, packageRoot);
  const live = deriveGitDistReport(packageRoot, subpackages, parity);
  const manifests: Record<PublicSubpackage, ContractEntry[]> = {
    core: [],
    server: [],
    svelte: [],
    app: [],
  };
  const result: ContractEvaluation = { errors: [], warnings: [], summaries: [] };
  for (const subpath of subpackages) {
    manifests[subpath] = readContractManifest(packageRoot, subpath);
    const evaluation = evaluateManifest(
      subpath,
      manifests[subpath],
      live[subpath],
      pkg.version,
    );
    result.errors.push(...evaluation.errors);
    result.warnings.push(...evaluation.warnings);
    result.summaries.push(...evaluation.summaries);
  }
  return { ...result, currentVersion: pkg.version, live, manifests };
}

function tierSummary(
  subpath: PublicSubpackage,
  live: readonly LiveContractEntry[],
  manifest: readonly ContractEntry[],
): string {
  const tiers = new Map(manifest.map((entry) => [entry.name, entry.tier]));
  const counts: Record<ContractTier, number> = { F: 0, S: 0, X: 0, D: 0 };
  for (const entry of live) {
    const tier = tiers.get(entry.name);
    if (tier) counts[tier]++;
  }
  return `${subpath} ${live.length} (F ${counts.F}, S ${counts.S}, X ${counts.X}, D ${counts.D})`;
}

if (import.meta.main) {
  try {
    const result = checkContract();
    for (const item of result.summaries) console.log(`[contract summary] ${item.message}`);
    for (const item of result.warnings) console.warn(`[contract warning] ${item.message}`);
    if (result.errors.length > 0) {
      console.error(`contract check failed with ${result.errors.length} error(s):`);
      for (const item of result.errors) console.error(`- ${item.message}`);
      process.exitCode = 1;
    } else {
      console.log(
        `contract check passed: ${CONTRACT_SUBPACKAGES.map((subpath) =>
          tierSummary(subpath, result.live[subpath], result.manifests[subpath])).join(", ")}`,
      );
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
