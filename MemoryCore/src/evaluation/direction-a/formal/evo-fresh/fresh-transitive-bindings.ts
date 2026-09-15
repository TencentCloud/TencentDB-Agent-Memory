import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, relative, resolve } from "node:path";
import ts from "typescript";

export type FreshClosureKind = "AUTHORIZATION_GENERATION" | "PAID_EXECUTION";
export interface FreshClosureRoot { path: string; role: string; reason: string }
export interface FreshClosureEdge { from: string; to: string; kind: "static-import" | "re-export" | "dynamic-import" | "require"; specifier: string }
export interface FreshClosureFile {
  path: string;
  sha256: string;
  bytes: number;
  role: string;
  reachableFrom: string[];
  dependencyReasons: string[];
}

const hash = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
const slash = (value: string): string => value.replaceAll("\\", "/");

function scriptKind(path: string): ts.ScriptKind {
  const ext = extname(path).toLowerCase();
  if (ext === ".tsx") return ts.ScriptKind.TSX;
  if (ext === ".jsx") return ts.ScriptKind.JSX;
  if (ext === ".json") return ts.ScriptKind.JSON;
  if (ext === ".js" || ext === ".mjs" || ext === ".cjs") return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function resolveLocalModule(from: string, specifier: string): string | undefined {
  if (!specifier.startsWith(".") && !specifier.startsWith("/")) return undefined;
  const base = resolve(dirname(from), specifier);
  const ext = extname(base).toLowerCase();
  const candidates = [base];
  if (ext === ".js") candidates.push(base.slice(0, -3) + ".ts", base.slice(0, -3) + ".tsx");
  else if (ext === ".mjs") candidates.push(base.slice(0, -4) + ".mts");
  else if (ext === ".cjs") candidates.push(base.slice(0, -4) + ".cts");
  else if (!ext) candidates.push(...[".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs", ".json"].map((suffix) => base + suffix));
  candidates.push(...["index.ts", "index.tsx", "index.mts", "index.js", "index.mjs", "index.json"].map((name) => resolve(base, name)));
  return candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile());
}

function runtimeSpecifiers(path: string): Array<{ specifier: string; kind: FreshClosureEdge["kind"] }> {
  if (extname(path).toLowerCase() === ".json") return [];
  const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, scriptKind(path));
  const result: Array<{ specifier: string; kind: FreshClosureEdge["kind"] }> = [];
  const add = (node: ts.Expression | undefined, kind: FreshClosureEdge["kind"]): void => {
    if (node && ts.isStringLiteralLike(node)) result.push({ specifier: node.text, kind });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      const namedOnlyTypes = clause?.namedBindings && ts.isNamedImports(clause.namedBindings)
        && clause.namedBindings.elements.length > 0 && clause.namedBindings.elements.every((item) => item.isTypeOnly);
      if (!clause?.isTypeOnly && !namedOnlyTypes) add(node.moduleSpecifier, "static-import");
    } else if (ts.isExportDeclaration(node)) {
      const namedOnlyTypes = node.exportClause && ts.isNamedExports(node.exportClause)
        && node.exportClause.elements.length > 0 && node.exportClause.elements.every((item) => item.isTypeOnly);
      if (!node.isTypeOnly && !namedOnlyTypes) add(node.moduleSpecifier, "re-export");
    } else if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) add(node.arguments[0], "dynamic-import");
      else if (ts.isIdentifier(node.expression) && node.expression.text === "require") add(node.arguments[0], "require");
    } else if (ts.isImportEqualsDeclaration(node) && !node.isTypeOnly && ts.isExternalModuleReference(node.moduleReference)) {
      add(node.moduleReference.expression, "require");
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return result;
}

export function buildFreshLocalDependencyClosure(input: {
  workspaceRoot: string;
  roots: FreshClosureRoot[];
  closureKind: FreshClosureKind;
}): { files: FreshClosureFile[]; edges: FreshClosureEdge[] } {
  const workspaceRoot = resolve(input.workspaceRoot);
  const rootInfo = new Map(input.roots.map((root) => [slash(relative(workspaceRoot, resolve(workspaceRoot, root.path))), root]));
  const paths = new Set<string>();
  const reach = new Map<string, Set<string>>();
  const reasons = new Map<string, Set<string>>();
  const edgeMap = new Map<string, FreshClosureEdge>();
  for (const root of [...input.roots].sort((a, b) => a.path.localeCompare(b.path))) {
    const absoluteRoot = resolve(workspaceRoot, root.path);
    if (!existsSync(absoluteRoot) || !statSync(absoluteRoot).isFile()) throw new Error(`FRESH_CLOSURE_ROOT_MISSING:${root.path}`);
    const queue = [absoluteRoot]; const visited = new Set<string>();
    while (queue.length) {
      const current = queue.shift()!;
      if (visited.has(current)) continue;
      visited.add(current); paths.add(current);
      const currentRelative = slash(relative(workspaceRoot, current));
      if (currentRelative.startsWith("../")) throw new Error(`FRESH_CLOSURE_PATH_ESCAPE:${currentRelative}`);
      (reach.get(currentRelative) ?? reach.set(currentRelative, new Set()).get(currentRelative)!).add(root.path);
      (reasons.get(currentRelative) ?? reasons.set(currentRelative, new Set()).get(currentRelative)!).add(
        current === absoluteRoot ? root.reason : `runtime dependency reachable from ${root.path}`,
      );
      for (const dependency of runtimeSpecifiers(current)) {
        const target = resolveLocalModule(current, dependency.specifier);
        if (!target) continue;
        const targetRelative = slash(relative(workspaceRoot, target));
        if (targetRelative.startsWith("../")) throw new Error(`FRESH_CLOSURE_PATH_ESCAPE:${targetRelative}`);
        const edge = { from: currentRelative, to: targetRelative, kind: dependency.kind, specifier: dependency.specifier } as FreshClosureEdge;
        edgeMap.set(JSON.stringify(edge), edge); queue.push(target);
      }
    }
  }
  const files = [...paths].map((absolute) => {
    const path = slash(relative(workspaceRoot, absolute)); const bytes = readFileSync(absolute); const root = rootInfo.get(path);
    return { path, sha256: hash(bytes), bytes: bytes.length, role: root?.role ?? `${input.closureKind}_TRANSITIVE_RUNTIME_DEPENDENCY`,
      reachableFrom: [...(reach.get(path) ?? [])].sort(), dependencyReasons: [...(reasons.get(path) ?? [])].sort() };
  }).sort((a, b) => a.path.localeCompare(b.path));
  return { files, edges: [...edgeMap.values()].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) };
}
