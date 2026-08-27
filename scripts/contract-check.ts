import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
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
  /** Legacy digest recorded in contract/manifest. */
  signature: string;
  /** Rich release-to-release digest; deliberately not stored in the mutable manifest. */
  compatibilitySignature?: string;
  /** Structural proof used to distinguish additive optional members at a minor boundary. */
  optionalAddition?: {
    baseSignature: string;
    members: string[];
  };
  /** Raw text after the emitted declaration's @deprecated tag. */
  deprecatedDeclaration?: string;
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
  | "deprecated-removal-due"
  | "deprecated-declaration-missing"
  | "deprecated-declaration-mismatch"
  | "deprecated-manifest-missing"
  | "deprecated-since-version-mismatch"
  | "deprecated-replacement-missing"
  | "deprecated-replacement-incompatible"
  | "deprecated-window-invalid"
  | "baseline-protected-removal"
  | "baseline-signature-change"
  | "baseline-tier-weakening"
  | "baseline-patch-change";

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
  /** Immutable prior release artifact (package.json + git-dist + manifests). */
  baselinePackageRoot?: string;
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

function supportingDeclaration(declaration: ts.Declaration, rich = false): boolean {
  if (rich && (ts.isModuleDeclaration(declaration) || ts.isSourceFile(declaration))) {
    return true;
  }
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

function referencedTypeSymbol(
  checker: ts.TypeChecker,
  node: ts.Node,
  rich = false,
): ts.Symbol | undefined {
  let location: ts.Node | undefined;
  if (ts.isTypeReferenceNode(node)) location = node.typeName;
  else if (ts.isExpressionWithTypeArguments(node)) location = node.expression;
  else if (ts.isTypeQueryNode(node)) location = node.exprName;
  else if (ts.isImportTypeNode(node)) {
    location = node.qualifier;
    if (
      rich
      && !location
      && ts.isLiteralTypeNode(node.argument)
      && ts.isStringLiteral(node.argument.literal)
    ) {
      location = node.argument.literal;
    }
  }
  if (!location) return undefined;
  const symbol = checker.getSymbolAtLocation(location);
  return symbol ? resolveAlias(checker, symbol) : undefined;
}

function declarationKey(declaration: ts.Declaration): string {
  return `${declaration.getSourceFile().fileName}:${declaration.pos}:${declaration.end}`;
}

function moduleExportDeclarations(
  checker: ts.TypeChecker,
  symbol: ts.Symbol,
): ts.Declaration[] {
  // TypeScript exposes unmodified top-level ambient declarations from an
  // external .d.ts module through both named imports and `typeof import()`.
  // `getExportsOfModule` is the authority here; filtering by an explicit
  // `export` modifier would under-hash that real consumer-visible surface.
  return checker.getExportsOfModule(symbol).flatMap((entry) =>
    resolveAlias(checker, entry).declarations ?? []);
}

function signatureWithDependencies(
  checker: ts.TypeChecker,
  rootDeclarations: readonly ts.Declaration[],
  rootTexts: readonly string[],
  traversalRoots: readonly ts.Node[],
  declarationRoot: string,
  rich = false,
  surfaceText: (declaration: ts.Declaration) => string = declarationSurfaceText,
  ignoreNode: (node: ts.Node) => boolean = () => false,
  onDeclaration: (declaration: ts.Declaration) => void = () => {},
): string {
  const rootKeys = new Set(rootDeclarations.map(declarationKey));
  for (const declaration of rootDeclarations) onDeclaration(declaration);
  const dependencies = new Map<string, ts.Declaration>();
  const pending: ts.Node[] = [...traversalRoots];
  for (let index = 0; index < pending.length; index++) {
    const node = pending[index];
    if (ignoreNode(node)) continue;
    const symbol = referencedTypeSymbol(checker, node, rich);
    if (symbol) {
      const declarations = rich && (symbol.flags & ts.SymbolFlags.Module)
        ? moduleExportDeclarations(checker, symbol)
        : symbol.declarations ?? [];
      for (const declaration of declarations) {
        const key = declarationKey(declaration);
        if (
          rootKeys.has(key)
          || dependencies.has(key)
          || !supportingDeclaration(declaration, rich)
          || !declarationInside(declaration, declarationRoot)
        ) {
          continue;
        }
        dependencies.set(key, declaration);
        onDeclaration(declaration);
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
    .map(surfaceText);
  return signatureHash([...rootTexts, ...dependencyTexts]);
}

function directPropertyOwner(
  node: ts.Node,
): ts.InterfaceDeclaration | ts.TypeAliasDeclaration | undefined {
  if (ts.isInterfaceDeclaration(node.parent)) return node.parent;
  if (
    ts.isTypeLiteralNode(node.parent)
    && ts.isTypeAliasDeclaration(node.parent.parent)
    && node.parent.parent.type === node.parent
  ) {
    return node.parent.parent;
  }
  return undefined;
}

function directOptionalProperties(declaration: ts.Declaration): ts.PropertySignature[] {
  const members: readonly ts.TypeElement[] = ts.isInterfaceDeclaration(declaration)
    ? declaration.members
    : ts.isTypeAliasDeclaration(declaration) && ts.isTypeLiteralNode(declaration.type)
      ? declaration.type.members
      : [];
  return members.filter((member): member is ts.PropertySignature =>
    ts.isPropertySignature(member) && Boolean(member.questionToken));
}

/** A declaration whose own optional properties the additive proof can strip.
 *
 * `interface X { a?: T }` and `type X = { a?: T }` are the same contract to a
 * consumer, and `directOptionalProperties` has always read both — but the owner
 * gate was a set of ROOT INTERFACE declarations only, so the identical change
 * expressed as a type alias could not be proven, and neither could one made to a
 * dependency rather than the root. That is a modelling gap, not a promise: the
 * proof is unchanged, it is `baseSignature` identical plus a member multiset
 * that only grew, and it stays sound wherever the owner sits. A required member,
 * a removed one, a narrowed one, an optional turned required, or a new union
 * variant all still move `baseSignature` and still fail.
 */
function ownsStrippableOptionals(declaration: ts.Declaration): boolean {
  return ts.isInterfaceDeclaration(declaration)
    || (ts.isTypeAliasDeclaration(declaration) && ts.isTypeLiteralNode(declaration.type));
}

function isDirectOptionalProperty(node: ts.Node): node is ts.PropertySignature {
  return ts.isPropertySignature(node)
    && Boolean(node.questionToken)
    && directPropertyOwner(node) !== undefined;
}

function stripDirectOptionalProperties(declaration: ts.Declaration): string {
  const members = directOptionalProperties(declaration);
  if (members.length === 0) return declarationSurfaceText(declaration);
  const base = declaration.getStart();
  let text = declaration.getText();
  for (const member of [...members].sort((left, right) => right.getStart() - left.getStart())) {
    text = `${text.slice(0, member.getStart() - base)}${text.slice(member.getEnd() - base)}`;
  }
  return text;
}

function optionalAdditionModel(
  checker: ts.TypeChecker,
  rootDeclarations: readonly ts.Declaration[],
  rootTexts: readonly string[],
  traversalRoots: readonly ts.Node[],
  declarationRoot: string,
): NonNullable<LiveContractEntry["optionalAddition"]> {
  const declarations = new Map<string, ts.Declaration>();
  const strippedSurface = (declaration: ts.Declaration): string =>
    ownsStrippableOptionals(declaration)
      ? stripDirectOptionalProperties(declaration)
      : declarationSurfaceText(declaration);
  const baseSignature = signatureWithDependencies(
    checker,
    rootDeclarations,
    rootTexts,
    traversalRoots,
    declarationRoot,
    true,
    strippedSurface,
    (node) => {
      if (!isDirectOptionalProperty(node)) return false;
      const owner = directPropertyOwner(node);
      return Boolean(owner && ownsStrippableOptionals(owner));
    },
    (declaration) => declarations.set(declarationKey(declaration), declaration),
  );

  // A member's own signature is computed with the SAME stripping applied to
  // everything it reaches. Without that, `foo?: SomeInterface` changes its
  // member hash the moment `SomeInterface` gains an optional property of its
  // own — a member that reads as REMOVED, failing the exact case this predicate
  // exists to allow. Narrowing is still caught: the stripped text of a reached
  // declaration contains all of its non-optional structure.
  //
  // The base traversal never reaches a type referenced only through an optional
  // property (it skips those nodes), so member traversal is also where such
  // declarations are discovered. They are folded into the queue so their own
  // optionals are modelled as members too — which is what keeps a REMOVAL from
  // one of them a failure rather than an invisible change.
  const queue = [...declarations.values()];
  const seen = new Set(queue.map(declarationKey));
  const members: string[] = [];
  for (let index = 0; index < queue.length; index++) {
    const declaration = queue[index]!;
    if (!ownsStrippableOptionals(declaration)) continue;
    const owner = ts.isInterfaceDeclaration(declaration) || ts.isTypeAliasDeclaration(declaration)
      ? declaration.name.text
      : "";
    const file = relative(declarationRoot, declaration.getSourceFile().fileName)
      .split(sep).join("/");
    for (const member of directOptionalProperties(declaration)) {
      const memberSignature = signatureWithDependencies(
        checker,
        [],
        [member.getText().replace(/;\s*$/, "")],
        [member],
        declarationRoot,
        true,
        strippedSurface,
        () => false,
        (reached) => {
          const key = declarationKey(reached);
          if (seen.has(key)) return;
          seen.add(key);
          queue.push(reached);
        },
      );
      members.push(`${file}:${owner}:${memberSignature}`);
    }
  }
  members.sort();
  return { baseSignature, members };
}

function exactOptionalProperty(
  node: ts.Node,
  declarationName: string | null,
  propertyName: string,
  propertyType: string,
  allowedOwnerKeys?: ReadonlySet<string>,
): node is ts.PropertySignature {
  if (
    !ts.isPropertySignature(node)
    || !node.questionToken
    || node.name?.getText() !== propertyName
    || !node.type
    || normalizeDeclarationText(node.type.getText()) !== normalizeDeclarationText(propertyType)
  ) {
    return false;
  }
  const owner = directPropertyOwner(node);
  if (!owner) return false;
  if (declarationName && owner.name.text !== declarationName) return false;
  return !allowedOwnerKeys || allowedOwnerKeys.has(declarationKey(owner));
}

function stripExactOptionalProperty(
  declaration: ts.Declaration,
  declarationName: string | null,
  propertyName: string,
  propertyType: string,
  allowedOwnerKeys?: ReadonlySet<string>,
): string {
  if (!ts.isInterfaceDeclaration(declaration) && !ts.isTypeAliasDeclaration(declaration)) {
    return declarationSurfaceText(declaration);
  }
  if (declarationName && declaration.name.text !== declarationName) {
    return declarationSurfaceText(declaration);
  }
  const matches: ts.PropertySignature[] = [];
  const visit = (node: ts.Node): void => {
    if (exactOptionalProperty(
      node,
      declarationName,
      propertyName,
      propertyType,
      allowedOwnerKeys,
    )) {
      matches.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(declaration);
  if (matches.length !== 1) return declarationSurfaceText(declaration);

  const base = declaration.getStart();
  let text = declaration.getText();
  const member = matches[0]!;
  text = `${text.slice(0, member.getStart() - base)}${text.slice(member.getEnd() - base)}`;
  return text;
}

function componentTypeArgumentNodes(typeNode: ts.TypeNode | undefined): readonly ts.TypeNode[] {
  if (!typeNode) return [];
  if (ts.isImportTypeNode(typeNode)) {
    const moduleName = ts.isLiteralTypeNode(typeNode.argument)
      && ts.isStringLiteral(typeNode.argument.literal)
      ? typeNode.argument.literal.text
      : null;
    if (moduleName === "svelte" && typeNode.qualifier?.getText() === "Component") {
      return typeNode.typeArguments ?? [];
    }
  }
  if (ts.isTypeReferenceNode(typeNode) && typeNode.typeName.getText() === "Component") {
    return typeNode.typeArguments ?? [];
  }
  return [];
}

function componentTypeArgumentSurface(argument: ts.TypeNode, index: number): string {
  // Svelte's generated third Component<> argument is a union of bindable prop
  // names. Union order has no TypeScript meaning, but svelte2tsx has emitted
  // different orders for byte-identical source across toolchain runs. Sort
  // only that bindings union so the immutable gate measures the public set,
  // while props/defaults and exported methods remain order-sensitive inputs.
  const surface = index === 2 && ts.isUnionTypeNode(argument)
    ? argument.types.map((member) => normalizeDeclarationText(member.getText())).sort().join(" | ")
    : argument.getText();
  return `component-argument-${index}: ${surface}`;
}

function compatibilityComponentSignature(
  checker: ts.TypeChecker,
  symbol: ts.Symbol,
  exportName: string,
  declarationRoot: string,
): string {
  for (const declaration of symbol.declarations ?? []) {
    if (!ts.isVariableDeclaration(declaration)) continue;
    const typeArguments = componentTypeArgumentNodes(declaration.type);
    if (typeArguments.length === 0) continue;
    return signatureWithDependencies(
      checker,
      [],
      typeArguments.map(componentTypeArgumentSurface),
      typeArguments,
      declarationRoot,
      true,
    );
  }
  throw new Error(`could not read Svelte component declaration for ${exportName}`);
}

function componentOptionalAdditionModel(
  checker: ts.TypeChecker,
  symbol: ts.Symbol,
  exportName: string,
  declarationRoot: string,
): NonNullable<LiveContractEntry["optionalAddition"]> {
  for (const declaration of symbol.declarations ?? []) {
    if (!ts.isVariableDeclaration(declaration)) continue;
    const typeArguments = componentTypeArgumentNodes(declaration.type);
    if (typeArguments.length === 0) continue;
    const propsSymbol = typeReferenceSymbol(checker, typeArguments[0]!);
    void propsSymbol;
    return optionalAdditionModel(
      checker,
      [],
      typeArguments.map(componentTypeArgumentSurface),
      typeArguments,
      declarationRoot,
    );
  }
  throw new Error(`could not read Svelte component declaration for ${exportName}`);
}

function compatibilityDeclarationSignature(
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
  const parts = [...new Set(declarations.map(declarationSurfaceText))];
  return signatureWithDependencies(
    checker,
    declarations,
    parts,
    declarations.flatMap(signatureTraversalNodes),
    declarationRoot,
    true,
  );
}

function declarationOptionalAdditionModel(
  checker: ts.TypeChecker,
  symbol: ts.Symbol,
  declarationRoot: string,
): NonNullable<LiveContractEntry["optionalAddition"]> {
  const declarations = [...(symbol.declarations ?? [])].sort((left, right) =>
    left.getSourceFile().fileName.localeCompare(right.getSourceFile().fileName)
    || left.pos - right.pos);
  if (declarations.length === 0) {
    throw new Error(`public symbol has no declaration: ${symbol.getName()}`);
  }
  const parts = [...new Set(declarations.map((declaration) =>
    ownsStrippableOptionals(declaration)
      ? stripDirectOptionalProperties(declaration)
      : declarationSurfaceText(declaration)))];
  return optionalAdditionModel(
    checker,
    declarations,
    parts,
    declarations.flatMap(signatureTraversalNodes),
    declarationRoot,
  );
}

function deprecatedDeclarationText(symbol: ts.Symbol): string | undefined {
  const comments = (symbol.declarations ?? []).flatMap((declaration) => {
    const nodes: ts.Node[] = [];
    for (let node: ts.Node | undefined = declaration;
      node && !ts.isSourceFile(node);
      node = node.parent) {
      nodes.push(node);
    }
    return nodes.flatMap((node) => ts.getJSDocTags(node))
      .filter((tag): tag is ts.JSDocDeprecatedTag => ts.isJSDocDeprecatedTag(tag))
      .map((tag) => typeof tag.comment === "string"
        ? tag.comment.trim()
        : tag.comment?.map((part) => part.getText()).join("").trim() ?? "");
  });
  return comments.find((comment) => comment.length > 0);
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
      // Deprecation belongs to the exported spelling. Resolving an alias first
      // would inspect the replacement declaration and lose the stamp attached
      // to `export { replacement as oldName }`.
      const deprecatedDeclaration = deprecatedDeclarationText(exportedSymbol);
      const optionalAddition = isComponent
        ? componentOptionalAdditionModel(checker, symbol, name, declarationRoot)
        : declarationOptionalAdditionModel(checker, symbol, declarationRoot);
      return {
        name,
        kind,
        signature: isComponent
          ? componentPropsSignature(checker, symbol, name, declarationRoot)
          : declarationSignature(checker, symbol, declarationRoot),
        compatibilitySignature: isComponent
          ? compatibilityComponentSignature(checker, symbol, name, declarationRoot)
          : compatibilityDeclarationSignature(checker, symbol, declarationRoot),
        optionalAddition,
        ...(deprecatedDeclaration ? { deprecatedDeclaration } : {}),
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

function validDeprecationWindow(since: string, removeNoEarlierThan: string): boolean {
  let from: ParsedSemver;
  let until: ParsedSemver;
  try {
    from = parseSemver(since);
    until = parseSemver(removeNoEarlierThan);
  } catch {
    return false;
  }
  if (compareVersions(removeNoEarlierThan, since) <= 0) return false;
  if (from.core[0] < 1) {
    return until.core[0] > from.core[0]
      || (until.core[0] === from.core[0] && until.core[1] > from.core[1]);
  }
  return until.core[0] > from.core[0];
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
    if (expected.deprecated) {
      const metadata = expected.deprecated;
      if (!validDeprecationWindow(metadata.since, metadata.removeNoEarlierThan)) {
        errors.push(diagnostic(
          "deprecated-window-invalid",
          subpath,
          expected,
          `deprecated export "${expected.name}" has an invalid removal window ${metadata.since} → ${metadata.removeNoEarlierThan}`,
        ));
      }
      if (
        metadata.replacement === expected.name
        || !liveByName.has(metadata.replacement)
      ) {
        errors.push(diagnostic(
          "deprecated-replacement-missing",
          subpath,
          expected,
          `deprecated export "${expected.name}" replacement "${metadata.replacement}" is not a live distinct export`,
        ));
      }
      const replacement = liveByName.get(metadata.replacement);
      if (
        actual
        && replacement
        && metadata.replacement !== expected.name
        && compareVersions(metadata.since, currentVersion) === 0
        && (
          replacement.kind !== actual.kind
          || (replacement.compatibilitySignature ?? replacement.signature)
            !== (actual.compatibilitySignature ?? actual.signature)
        )
      ) {
        errors.push(diagnostic(
          "deprecated-replacement-incompatible",
          subpath,
          expected,
          `newly deprecated export "${expected.name}" replacement "${metadata.replacement}" does not preserve its kind and declaration shape`,
        ));
      }
      if (actual) {
        const stamp = `since v${metadata.since} — use ${metadata.replacement}; removal no earlier than v${metadata.removeNoEarlierThan}`;
        if (!actual.deprecatedDeclaration) {
          errors.push(diagnostic(
            "deprecated-declaration-missing",
            subpath,
            expected,
            `deprecated export "${expected.name}" has no emitted @deprecated declaration stamp`,
          ));
        } else if (actual.deprecatedDeclaration !== stamp) {
          errors.push(diagnostic(
            "deprecated-declaration-mismatch",
            subpath,
            expected,
            `deprecated export "${expected.name}" declaration stamp does not match its manifest metadata`,
          ));
        }
      }
    } else if (actual?.deprecatedDeclaration) {
      errors.push(diagnostic(
        "deprecated-manifest-missing",
        subpath,
        expected,
        `deprecated export "${expected.name}" has an emitted declaration stamp but no manifest metadata`,
      ));
    }
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

function releaseBoundary(
  fromVersion: string,
  toVersion: string,
): "same" | "patch" | "minor" | "major" | "retag" {
  const from = parseSemver(fromVersion);
  const to = parseSemver(toVersion);
  if (compareVersions(toVersion, fromVersion) < 0) {
    throw new Error(`contract version moved backwards: ${fromVersion} → ${toVersion}`);
  }
  if (from.core[0] === 0 && to.core[0] === 1 && to.core[1] === 0 && to.core[2] === 0) {
    return "retag";
  }
  if (from.core[0] !== to.core[0]) return "major";
  if (from.core[1] !== to.core[1]) return "minor";
  if (from.core[2] !== to.core[2]) return "patch";
  return "same";
}

/**
 * Declarations reviewed by hand for the 0.10.1 -> 0.11.0 release, each pinned to
 * BOTH the digest it was reviewed against and the digest it was reviewed as.
 * Entries are `subpath:name:baseline:current`.
 *
 * One entry, one reason. TM-02 asked for `openDock(opts?: {focus?: boolean})`
 * and `openCompose(opts?: {focus?: boolean})` — a trailing optional PARAMETER,
 * which every existing caller satisfies by passing nothing. `isMinorOptionalAddition`
 * proves added optional MEMBERS; it does not model parameters, and teaching it to
 * is a separate concept with its own edges (rest params, overloads, variance) that
 * should not be invented under release pressure. The 0.9.2 -> 0.10.0 table is gone
 * from this file because its version guard made it inert the moment 0.10.1 became
 * the baseline, which is how these tables are supposed to end.
 *
 * The evidence is the one CONTRACT.md names for behaviour declarations cannot
 * express: the packed tarball installs into the frozen app-host consumer,
 * typechecks with 0 ERRORS, builds, and drives a real session end to end.
 *
 * Do not add a row here to make a red gate green. Add one only after a fixture
 * has proven the change, and delete the table when the release ships.
 */
const V0110_REVIEWED_ADDITIONS: ReadonlySet<string> = new Set([
  "svelte:ComposerDock:fec2af5c980d60e92ba24a8d4f9d249ac420af65c4a006c9cf1a814c3cb7a725:2880a78a343f06c126269d00c681f7181adb91562a922620898a6597c77acb00",
]);

/**
 * Additive durable-boundary and Claude Bash presentation declarations reviewed
 * for 0.17.0 -> 0.18.0. The generic optional-member proof accepts the direct
 * protocol additions, but cannot prove every transitive path through a class,
 * function return, component prop, or an existing optional member whose
 * referenced type gained optionals. None of these rows authorizes a removal or
 * narrowing: the v0.17 frozen minimal, guarded, and app consumers all typecheck,
 * build, and run against the packed v0.18 artifact.
 */
const V0180_REVIEWED_ADDITIONS: ReadonlySet<string> = new Set([
  "server:AppRoutes:c5fc6c71e0d6b04a658e3930357ce13b9fbc5af4804da6c1abe445b1f73cb4fd:bf934db559492005973a16f4f91591e078db81d6adcadfe00e4fc81b17aae770",
  "server:AppRoutesOptions:cc662cd6518c7151ad2cdcd5f8bc4d6a8be74d8b97b33283faa9b53a8fd84e8d:fdfc8f38ca74022e9dafe7a539a41660b0fddd5f475c4d03c63ad4e34149f8c5",
  "server:createAppRoutes:e1f89ea4f7ea071fce9e85f7533dcbadcf001e88310134ab3ba78825d3cd3205:82d6b1f45e0c93c5f95e9545385a8b10ea505d4fad03fc4c684309349869a137",
  "server:createBunTmuxDriver:96f8d9a246633892db34aba944eccb2432e5145292ea5f572c6cb0663fff4d52:0029dcffa9eba1547ebd27d5df7d5a2fb16da49c5e447ec470ddf4da2a38de40",
  "server:createSpawnHandler:3f45c1e0f3c983bb87c731caa8b7619aaaafe410114bd575bf71ba3ea24729ea:a230098d3172bcdba10994d1c8c22f5dc1aedfd8f70974e3ce1ae59ac0d81721",
  "server:DurableHistoryArchive:ac2b8b225618deafba39ee3e27f33cb9aa14f716f272f1353f9227838bc66e41:70e25ca5e888960798469ee6a6a964d25716bc244fdb9664138e9e533680d01d",
  "server:FileHistoryArchive:0de8be2d28f4cef7212c9be036565fbe38617864d6ad8486360642c6ba2f7e50:8779b4916cd1eac29c78b373855f10408572b950d3fcf80406d2442359cc6cf9",
  "server:HistoryArchiveLike:f642d7abe2d7d1c755654d87b47bd2b576302314b9627934ce82ce0b13dec94f:a9f287b16a5ba85604b061a9d0f6bf0214bc8c42cb53b9c3b477d7de2053f16d",
  "server:RetentionLane:591d0e1371c38e9013bf9e49bbade02d95f04c48a77e9b5440c645f9eb0c8d6c:4add5e1a70895280942ea425a7362e2e7e94ec9c91150c63904c66c14026bb23",
  "server:RetentionLaneOptions:98e35df9bddaa0e69ace24e1cae5cd480e7eb860dd934f89cb9d076357ba003c:c98b4fcec3a99e2167774a3c77165dfdd233cedfb0ed815cc9eb28a8538eb215",
  "server:SpawnHandlerOptions:e2ad3a02503ebb921d0874ab127e725b3c6d49a251a92a1efee51bee567c1d76:e9411ae2ea80c75cc8e71275a0b03f45c10ae0553e42609c7f6d3e354032b48c",
  "server:TmuxDriver:31a1557c524f410f91b43202343d0496bd89cb9e2c3335c6972abf62c2a4c62e:6b15203b589dccd2acc8102af15f3d40b82d2b52bcbb909656553275185393f2",
  "server:TmuxWsMux:8ab44d4250b9e866ebf7de4f65eb0b17fdc2d289c282fcde78a8006674c52050:5fab451dd0c8f853304b66a5ebe2654661cde7773dad0c11219f5553a2a52873",
  "server:TmuxWsMuxOptions:d9cad580dd157b901490827749bf3836e39d83d9baa0dbe17c22afdc5a27d3a0:e1bd26d1c7826a7d6cfd59f19cbb44e8acf95480cada689c3abab8404a3c9a87",
  "app:AppAdapters:f0011ca974218b3de4aac5d1f95ac54514d048a765b0a3fa7f66e4804daaecdf:4daaa8569401f924d83ae1d3ed7efde5c7744969ca10decc4bc4d29ca51f8f37",
  "app:createSessionsStore:0f71378ac1f9f6ff6a6c1f8f475b850b5163f4cb863dd668362de505c0b39684:f2fe5f45457282241f459b41fb7045fc3898a168211f43e4e503e3d319891607",
  "app:EmbedView:75354449febbc27879485892b4068650054867cee3b4b25610131d861d5ffbea:42d35e1d767944b17d91723c5d4b44125b90cea1232b1fefac7c581152f42933",
  "app:HubView:3c1945999923d9b96bd84a5ed4b76036d9cf88476f293491fe7933e9cc966435:721857db61ece49f68f7b985bf4c265df717ddd29de1ca30262b24e3e837aa24",
  "app:SessionView:1ffcecd9cfde2f4700abab082a8ec3259263350d608aae6066998f50683ff19f:97d277a4b1fc9cbb273eb17f3754b39ae36358b9a3113f23c57acdeb6c9c8fa3",
  "app:ThumbmuxApp:8d9f842e391d521d8d8f58a649df37159d1381e0a1cfd6c4042f266ddba7dcc3:05c5f730406d035669b8b1ba69ed5c183e9fd89bf98521737fc578c6e9a6a55a",
]);

/**
 * Additive request-receipt hooks reviewed for 0.18.5 -> 0.18.6. The direct
 * UploadAction props pass the structural optional-member proof. AppAdapters
 * carries the same two optionals inside its existing optional `upload` member,
 * and that nested declaration propagates through the four app components that
 * accept AppAdapters. The generic proof deliberately does not recurse into an
 * existing optional member, so these rows pin the exact old/new compatibility
 * digests. The frozen app consumer still has to compile, build, and run against
 * the packed artifact in the public verify-gate before the source tag is cut.
 */
const V0186_REVIEWED_ADDITIONS: ReadonlySet<string> = new Set([
  "app:AppAdapters:4daaa8569401f924d83ae1d3ed7efde5c7744969ca10decc4bc4d29ca51f8f37:94a4200917228a4cdfb183dd31d6a37b9c437b1a4e9f9d71ccd0e571d1431b4b",
  "app:EmbedView:42d35e1d767944b17d91723c5d4b44125b90cea1232b1fefac7c581152f42933:81907789d818447c5c7e6714eef73c61851967cb2a862c8e56b2387030bc7e57",
  "app:HubView:721857db61ece49f68f7b985bf4c265df717ddd29de1ca30262b24e3e837aa24:3d0081589b979829a8dad9ae6c450f4c098e6a17499adcb4fee78079399c348e",
  "app:SessionView:97d277a4b1fc9cbb273eb17f3754b39ae36358b9a3113f23c57acdeb6c9c8fa3:d3e868503f999de175ce3cfe8e43b155ed9b24df37c0ec329d0ce1d83678626e",
  "app:ThumbmuxApp:05c5f730406d035669b8b1ba69ed5c183e9fd89bf98521737fc578c6e9a6a55a:c824a279f048823a40d097e0b8b58b1b6f8f9e8e39f149a4ec68ea8fe7353c52",
]);

function isV0110MinorException(
  baselineVersion: string,
  currentVersion: string,
  subpath: PublicSubpackage,
  name: string,
  baselineLive: LiveContractEntry,
  currentLive: LiveContractEntry,
): boolean {
  if (baselineVersion !== "0.10.1" || currentVersion !== "0.11.0") return false;
  const reviewed = `${subpath}:${name}:${baselineLive.compatibilitySignature ?? baselineLive.signature}:${currentLive.compatibilitySignature ?? currentLive.signature}`;
  return V0110_REVIEWED_ADDITIONS.has(reviewed);
}

function isV0180MinorException(
  baselineVersion: string,
  currentVersion: string,
  subpath: PublicSubpackage,
  name: string,
  baselineLive: LiveContractEntry,
  currentLive: LiveContractEntry,
): boolean {
  if (baselineVersion !== "0.17.0" || currentVersion !== "0.18.0") return false;
  const reviewed = `${subpath}:${name}:${baselineLive.compatibilitySignature ?? baselineLive.signature}:${currentLive.compatibilitySignature ?? currentLive.signature}`;
  return V0180_REVIEWED_ADDITIONS.has(reviewed);
}

function isV0186PatchException(
  baselineVersion: string,
  currentVersion: string,
  subpath: PublicSubpackage,
  name: string,
  baselineLive: LiveContractEntry,
  currentLive: LiveContractEntry,
): boolean {
  if (baselineVersion !== "0.18.5" || currentVersion !== "0.18.6") return false;
  const reviewed = `${subpath}:${name}:${baselineLive.compatibilitySignature ?? baselineLive.signature}:${currentLive.compatibilitySignature ?? currentLive.signature}`;
  return V0186_REVIEWED_ADDITIONS.has(reviewed);
}

function isMinorOptionalAddition(
  baselineLive: LiveContractEntry,
  currentLive: LiveContractEntry,
): boolean {
  const baseline = baselineLive.optionalAddition;
  const current = currentLive.optionalAddition;
  if (!baseline || !current || baseline.baseSignature !== current.baseSignature) return false;
  const remaining = new Map<string, number>();
  for (const member of current.members) {
    remaining.set(member, (remaining.get(member) ?? 0) + 1);
  }
  for (const member of baseline.members) {
    const count = remaining.get(member) ?? 0;
    if (count === 0) return false;
    remaining.set(member, count - 1);
  }
  return true;
}

/**
 * Compare the current mutable manifest/artifact with an immutable prior release.
 * This is the authorization boundary missing from a current-tree-only snapshot.
 */
export function evaluateBaseline(
  subpath: PublicSubpackage,
  baselineManifest: readonly ContractEntry[],
  currentManifest: readonly ContractEntry[],
  baselineLive: readonly LiveContractEntry[],
  currentLive: readonly LiveContractEntry[],
  baselineVersion: string,
  currentVersion: string,
): ContractEvaluation {
  const errors: ContractDiagnostic[] = [];
  const warnings: ContractDiagnostic[] = [];
  const summaries: ContractDiagnostic[] = [];
  const boundary = releaseBoundary(baselineVersion, currentVersion);
  const baselineLiveByName = new Map(baselineLive.map((entry) => [entry.name, entry]));
  const currentLiveByName = new Map(currentLive.map((entry) => [entry.name, entry]));
  const currentManifestByName = new Map(currentManifest.map((entry) => [entry.name, entry]));
  const baselineManifestNames = new Set(baselineManifest.map((entry) => entry.name));

  for (const previous of baselineManifest) {
    const previousLive = baselineLiveByName.get(previous.name);
    if (!previousLive) {
      throw new Error(`${subpath} immutable baseline is missing declared export ${previous.name}`);
    }
    const next = currentManifestByName.get(previous.name);
    const nextLive = currentLiveByName.get(previous.name);
    const eligibleDeprecatedRemoval = Boolean(
      (boundary === "minor" || boundary === "major")
      &&
      previous.deprecated
      && compareVersions(currentVersion, previous.deprecated.removeNoEarlierThan) >= 0,
    );
    const postOneMajor = boundary === "major"
      && parseSemver(baselineVersion).core[0] >= 1;

    if (!next || !nextLive) {
      if (eligibleDeprecatedRemoval) {
        summaries.push(diagnostic(
          "deprecated-removal-eligible",
          subpath,
          previous,
          `baseline deprecated export "${previous.name}" is absent at an eligible removal version`,
        ));
      } else if (previous.tier === "F" && postOneMajor) {
        // F freezes one post-1.0 major line at a time. A new major is the
        // documented boundary at which that name may break or disappear.
      } else if (previous.tier === "X" && (boundary === "minor" || boundary === "major")) {
        summaries.push(diagnostic(
          "experimental-removal",
          subpath,
          previous,
          `baseline X export "${previous.name}" was removed at a ${boundary} boundary`,
        ));
      } else {
        errors.push(diagnostic(
          "baseline-protected-removal",
          subpath,
          previous,
          `immutable baseline ${previous.tier} export "${previous.name}" was removed from the manifest or artifact`,
        ));
      }
      continue;
    }

    const weakened = previous.tier === "F"
      ? next.tier !== "F"
      : previous.tier === "S"
        ? next.tier === "X" || next.tier === "D"
        : previous.tier === "D"
          ? next.tier !== "D" && next.tier !== "F"
          : false;
    if (weakened) {
      errors.push(diagnostic(
        "baseline-tier-weakening",
        subpath,
        previous,
        `immutable baseline tier ${previous.tier} for "${previous.name}" was changed to ${next.tier}`,
      ));
    }
    if (
      !previous.deprecated
      && next.deprecated
      && compareVersions(next.deprecated.since, currentVersion) !== 0
    ) {
      errors.push(diagnostic(
        "deprecated-since-version-mismatch",
        subpath,
        previous,
        `new deprecation metadata for "${previous.name}" says ${next.deprecated.since}, expected ${currentVersion}`,
      ));
    }

    if (
      (previous.deprecated || boundary === "retag")
      && JSON.stringify(previous.deprecated) !== JSON.stringify(next.deprecated)
    ) {
      errors.push(diagnostic(
        "baseline-tier-weakening",
        subpath,
        previous,
        `immutable deprecation metadata for "${previous.name}" was removed or changed`,
      ));
    }

    const signatureChanged = (
      previousLive.compatibilitySignature ?? previousLive.signature
    ) !== (
      nextLive.compatibilitySignature ?? nextLive.signature
    );
    const kindChanged = previousLive.kind !== nextLive.kind;
    if (!signatureChanged && !kindChanged) continue;
    // A patch may carry an addition every existing consumer ignores — CONTRACT.md
    // "Additive changes may ride a patch on this line". The permission is not the
    // boundary, it is `isMinorOptionalAddition`: a structural proof that the new
    // declaration is the old one plus optional members, with nothing removed,
    // renamed or narrowed. A change that cannot prove that still fails here,
    // whatever its version number.
    //
    // Know what this predicate does NOT prove. It treats a new union variant as
    // an addition, and a union variant can break a consumer: v0.8.0 added one,
    // saw only added lines, called it additive, and every consumer reading
    // `frame.channel` failed with TS2339. So this branch is not the safety
    // argument for a union change — the frozen consumer fixtures are, which is
    // what CONTRACT.md means by behaviour that declarations cannot express.
    // Never let a union change through on this predicate alone.
    //
    // 0.9.2 is the worked example: `MuxServerFrame` gained `MuxPongFrame`, which
    // is channel-less exactly like the v0.8.0 case — but the union already
    // contained channel-less `MuxAuthErrorFrame`, so any consumer reading
    // `channel` already had to narrow first, and the fixtures confirmed it
    // compiles and runs.
    if (
      (boundary === "minor" || boundary === "patch" || boundary === "same")
      && !kindChanged
      && (previous.tier === "F" || previous.tier === "S")
      && isMinorOptionalAddition(previousLive, nextLive)
    ) {
      continue;
    }

    if (
      boundary === "minor"
      && !kindChanged
      && (
        isV0110MinorException(
          baselineVersion,
          currentVersion,
          subpath,
          previous.name,
          previousLive,
          nextLive,
        )
        || isV0180MinorException(
          baselineVersion,
          currentVersion,
          subpath,
          previous.name,
          previousLive,
          nextLive,
        )
      )
    ) {
      continue;
    }

    if (
      !kindChanged
      && isV0186PatchException(
        baselineVersion,
        currentVersion,
        subpath,
        previous.name,
        previousLive,
        nextLive,
      )
    ) {
      continue;
    }

    // S changes are introduced by adding a replacement route while the old
    // declaration remains intact and enters the deprecation window. Replacing
    // the old declaration in place would erase the compatibility alias.
    if (previous.tier === "F" && postOneMajor) {
      continue;
    }
    if (previous.tier === "F" || previous.tier === "S" || previous.tier === "D") {
      errors.push(diagnostic(
        "baseline-signature-change",
        subpath,
        previous,
        `immutable baseline ${previous.tier} export "${previous.name}" changed its public declaration`,
      ));
      continue;
    }
    if (boundary === "same" || boundary === "patch" || boundary === "retag") {
      errors.push(diagnostic(
        "baseline-patch-change",
        subpath,
        previous,
        `immutable baseline ${previous.tier} export "${previous.name}" changed without a minor boundary`,
      ));
    }
  }
  for (const next of currentManifest) {
    if (
      baselineManifestNames.has(next.name)
      || !next.deprecated
      || compareVersions(next.deprecated.since, currentVersion) === 0
    ) {
      continue;
    }
    errors.push(diagnostic(
      "deprecated-since-version-mismatch",
      subpath,
      next,
      `new deprecated export "${next.name}" says ${next.deprecated.since}, expected ${currentVersion}`,
    ));
  }
  // A retag must be byte-identical — that is the whole claim 1.0 rests on — so a
  // new export there is always an error. A patch may carry one: a name no prior
  // artifact exported cannot be referenced by any consumer compiled against it,
  // so there is nothing to break. CONTRACT.md "Additive changes may ride a patch
  // on this line" is the rule; this is its narrowest case.
  //
  // The declaration still has to be declared in the manifest with a tier, which
  // is the part that stays a decision: the checks above already refuse an
  // undeclared export, and a new name entering at F would freeze something no
  // consumer has used.
  if (boundary === "retag" || boundary === "same") {
    for (const next of currentManifest) {
      if (baselineManifestNames.has(next.name)) continue;
      errors.push(diagnostic(
        "baseline-patch-change",
        subpath,
        next,
        `new ${next.tier} export "${next.name}" was declared without a version bump`,
      ));
    }
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
  if (options.baselinePackageRoot) {
    const baselinePackageRoot = resolve(options.baselinePackageRoot);
    const baselinePkg = JSON.parse(
      readFileSync(resolve(baselinePackageRoot, "package.json"), "utf8"),
    ) as { version?: unknown };
    if (typeof baselinePkg.version !== "string") {
      throw new Error("baseline package.json version must be a string");
    }
    parseSemver(baselinePkg.version);
    const baselineLive = deriveGitDistReport(baselinePackageRoot, subpackages);
    for (const subpath of subpackages) {
      const baselineManifest = readContractManifest(baselinePackageRoot, subpath);
      const baselineEvaluation = evaluateBaseline(
        subpath,
        baselineManifest,
        manifests[subpath],
        baselineLive[subpath],
        live[subpath],
        baselinePkg.version,
        pkg.version,
      );
      result.errors.push(...baselineEvaluation.errors);
      result.warnings.push(...baselineEvaluation.warnings);
      result.summaries.push(...baselineEvaluation.summaries);
    }
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

/**
 * Decide whether this run may proceed without the immutable baseline.
 *
 * The baseline block is the half of this gate that answers "did a frozen name
 * change" — the surface gate alone only answers "is every name declared". They
 * were opt-in the wrong way round: without `THUMBMUX_CONTRACT_BASELINE_ROOT`
 * the baseline block was skipped **silently**, so `bun run contract` by hand
 * printed the same "contract check passed" line as a full run. It has already
 * produced one false all-clear reported to a human.
 *
 * So a missing baseline is now an error, and skipping it takes a deliberate,
 * greppable opt-out that the success line then admits to.
 */
export function resolveBaselineMode(env: Record<string, string | undefined>): {
  baselinePackageRoot?: string;
  skipped: boolean;
  error?: string;
} {
  const baselinePackageRoot = env.THUMBMUX_CONTRACT_BASELINE_ROOT?.trim();
  if (baselinePackageRoot) return { baselinePackageRoot, skipped: false };
  if (env.THUMBMUX_CONTRACT_BASELINE === "skip") return { skipped: true };
  return {
    skipped: false,
    error: "contract check needs the immutable baseline: set "
      + "THUMBMUX_CONTRACT_BASELINE_ROOT=<dir> (materialize one with "
      + "`bun scripts/materialize-contract-baseline.ts <empty-dir>`), or state "
      + "that you are skipping the frozen-surface half with "
      + "THUMBMUX_CONTRACT_BASELINE=skip",
  };
}

if (import.meta.main) {
  try {
    const baseline = resolveBaselineMode(process.env);
    if (baseline.error) throw new Error(baseline.error);
    const baselinePackageRoot = baseline.baselinePackageRoot;
    const result = checkContract({
      ...(baselinePackageRoot ? { baselinePackageRoot } : {}),
    });
    for (const item of result.summaries) console.log(`[contract summary] ${item.message}`);
    for (const item of result.warnings) console.warn(`[contract warning] ${item.message}`);
    if (result.errors.length > 0) {
      console.error(`contract check failed with ${result.errors.length} error(s):`);
      for (const item of result.errors) console.error(`- ${item.message}`);
      process.exitCode = 1;
    } else {
      // A run that skipped the frozen-surface half must not print the same
      // sentence as one that checked it. "Passed" without a scope is how a
      // partial check gets quoted as a full one.
      const scope = baseline.skipped
        ? "contract check passed WITHOUT the immutable baseline (frozen-surface changes were NOT checked)"
        : "contract check passed";
      console.log(
        `${scope}: ${CONTRACT_SUBPACKAGES.map((subpath) =>
          tierSummary(subpath, result.live[subpath], result.manifests[subpath])).join(", ")}`,
      );
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
