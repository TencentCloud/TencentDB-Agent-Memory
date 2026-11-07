/**
 * Pure reconciliation logic for knowledge-wiki-sync.
 *
 * Both sides are compared against the **last reconciled state**, not against
 * each other — the same three-way shape a merge uses:
 *
 *   - moved on one side only  → that side's version is applied to the other
 *   - moved on neither        → nothing to do
 *   - moved on both, equal    → already converged, nothing to do
 *   - moved on both, differ   → CONFLICT: never resolved silently
 *
 * The last reconciled state is a manifest of page content hashes plus the
 * commit that carries it (`wiki-sync-state.json`), which is what makes the
 * comparison possible at all: the HTTP API returns page content and nothing
 * else — no revision, no etag — so "did this page change since last time" can
 * only be answered by remembering what it was.
 *
 * Nothing here touches git, HTTP or the filesystem.
 */

import { createHash } from "node:crypto";

/** Page tree root — the same namespace in API refs, in git paths, and on disk. */
export const WIKI_ROOT = "wiki";

/**
 * Service-generated structural files: the service's own artefact, not wiki
 * content, and `page/write` refuses to author them. Never written, never
 * deleted, on either side.
 */
export const STRUCTURAL_PAGES: ReadonlySet<string> = new Set([
  `${WIKI_ROOT}/schema.md`,
  `${WIKI_ROOT}/purpose.md`,
]);

/**
 * True if `p` is a page file this tool owns: markdown, under `wiki/`, not in
 * the `media/` subtree. `media/` holds assets and is never listed by
 * `page/ls`, so deleting from a listing that cannot contain it would be data
 * loss.
 */
export function isPageFile(p: string): boolean {
  if (!p.startsWith(`${WIKI_ROOT}/`)) return false;
  if (!p.endsWith(".md")) return false;
  if (p.includes("..") || p.includes("//")) return false;
  if (p.startsWith(`${WIKI_ROOT}/media/`)) return false;
  return true;
}

export function isStructuralPage(p: string): boolean {
  return STRUCTURAL_PAGES.has(p);
}

/** A path this tool may act on at all. */
function isManagedPage(p: string): boolean {
  return isPageFile(p) && !isStructuralPage(p);
}

/** Content hash. `null` (absent) hashes to `null`, so absence is comparable. */
export function hashContent(content: string | null | undefined): string | null {
  if (content === null || content === undefined) return null;
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/** Page files the wiki reports, de-duplicated and sorted. */
export function wantedPages(pagePaths: string[]): string[] {
  const wanted = new Set<string>();
  for (const p of pagePaths) {
    if (isManagedPage(p)) wanted.add(p);
  }
  return [...wanted].sort();
}

/** How a path changed in git since the last reconciled commit. */
export type GitStatus = "added" | "modified" | "deleted";

export interface ReconcileInput {
  /** Current wiki pages: repo-relative path → content. */
  tdai: Map<string, string>;
  /** Paths changed in git since the last reconciled commit. */
  gitChanged: Map<string, GitStatus>;
  /** Content hashes recorded at the last reconciled state. */
  manifest: Map<string, string>;
  /**
   * Content at HEAD for a path (or null if absent). Only consulted for paths
   * that moved on *both* sides, to tell an independent convergence from a real
   * conflict — so it stays cheap.
   */
  gitContent: (path: string) => string | null;
}

export interface ReconcilePlan {
  toGit: { write: string[]; delete: string[] };
  toWiki: { write: string[]; delete: string[] };
  /** Moved on both sides, with different content. Blocks the run by default. */
  conflicts: string[];
  /** Present in git but not in the wiki: not ours, or the wiki dropped it. */
  unmanaged: string[];
}

function emptyPlan(): ReconcilePlan {
  return { toGit: { write: [], delete: [] }, toWiki: { write: [], delete: [] }, conflicts: [], unmanaged: [] };
}

/**
 * The first run. There is no last reconciled state, so there is nothing to
 * compare against — this run *establishes* it: the wiki becomes the baseline
 * and the checkout is rewritten to match. Checkout-side edits are not an input
 * here; adopting them would silently import a repo's pre-existing content.
 */
export function bootstrapPlan(tdai: Map<string, string>, gitPages: string[]): ReconcilePlan {
  const plan = emptyPlan();
  const wanted = new Set(wantedPages([...tdai.keys()]));
  plan.toGit.write = [...wanted].sort();
  plan.toGit.delete = wantedPages(gitPages).filter((p) => !wanted.has(p));
  return plan;
}

/**
 * Paths whose wiki content moved since the last reconciled state: content hash
 * differs from the manifest, in either direction (added, changed, or gone).
 *
 * Exported because the caller needs the same answer *before* reconciling: a
 * path that moved on both sides needs its git content read to tell convergence
 * from conflict, and reading git is not something this module does.
 */
export function wikiMoved(tdai: Map<string, string>, manifest: Map<string, string>): Set<string> {
  const moved = new Set<string>();
  for (const path of tdai.keys()) {
    if (hashContent(tdai.get(path) ?? null) !== (manifest.get(path) ?? null)) moved.add(path);
  }
  for (const path of manifest.keys()) {
    if (!tdai.has(path)) moved.add(path);
  }
  return moved;
}

/** The steady state: compare each side to the last reconciled state. */
export function reconcile(input: ReconcileInput): ReconcilePlan {
  const plan = emptyPlan();
  const candidates = new Set<string>([
    ...input.tdai.keys(),
    ...input.manifest.keys(),
    ...input.gitChanged.keys(),
  ]);
  const moved = wikiMoved(input.tdai, input.manifest);

  for (const path of [...candidates].sort()) {
    if (isStructuralPage(path)) continue;
    // A path outside the managed tree that git touched is not ours to project
    // or to delete; report it instead of acting.
    if (!isPageFile(path)) {
      if (input.gitChanged.has(path)) plan.unmanaged.push(path);
      continue;
    }

    const tdaiContent = input.tdai.get(path) ?? null;
    const tdaiMoved = moved.has(path);
    const gitStatus = input.gitChanged.get(path);
    const gitMoved = gitStatus !== undefined;

    if (!tdaiMoved && !gitMoved) continue;

    // One side moved: it is the newer truth, and it applies to the other.
    if (tdaiMoved && !gitMoved) {
      if (tdaiContent === null) plan.toGit.delete.push(path);
      else plan.toGit.write.push(path);
      continue;
    }
    if (!tdaiMoved && gitMoved) {
      if (gitStatus === "deleted") plan.toWiki.delete.push(path);
      else plan.toWiki.write.push(path);
      continue;
    }

    // Both moved. Same content is convergence, not conflict.
    const gitContent = input.gitContent(path);
    if (tdaiContent !== null && gitContent !== null && tdaiContent === gitContent) continue;
    plan.conflicts.push(path);
  }
  return plan;
}

/** Content hashes of the reconciled wiki, for the next run's comparison. */
export function buildManifest(tdai: Map<string, string>): Map<string, string> {
  const manifest = new Map<string, string>();
  for (const path of wantedPages([...tdai.keys()])) {
    const hash = hashContent(tdai.get(path) ?? null);
    if (hash !== null) manifest.set(path, hash);
  }
  return manifest;
}