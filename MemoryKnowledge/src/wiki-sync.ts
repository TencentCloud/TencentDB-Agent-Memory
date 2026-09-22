#!/usr/bin/env node
/**
 * knowledge-wiki-sync — project a TDAI wiki onto a local git checkout.
 *
 * TDAI is the live wiki; this bin is a one-way **projection** (v1). It reads the
 * processed pages over the Knowledge Service HTTP API (`page/ls` + `page/read`)
 * and materialises them 1:1 under `<repo>/wiki/`, deletes the files whose pages
 * have vanished from the wiki, and commits the result. It never writes back to
 * the wiki — `page/write` remains the only write path, reached through the
 * agent tools.
 *
 * Why a client and not a service-side job: the service holds no git remotes or
 * credentials, and a projection failure must not be able to touch the live
 * wiki. The checkout is the caller's, so git identity and auth stay with the
 * caller (`--push` uses the checkout's own remote + credentials).
 *
 * The repo tree mirrors the API ref namespace exactly (`wiki/products/x/x.md`),
 * so a file path maps to a ref by identity — no rewriting, no second taxonomy.
 *
 * Usage:
 *   knowledge-wiki-sync --wiki-id <id> --repo <path> [--push]
 *
 * Exit codes: 0 ok · 1 error (nothing is written when a read fails).
 */

import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

import simpleGit from "simple-git";

import { callApi, type HttpClientOptions } from "./mcp/http-client.js";
import { createLogger } from "./logger.js";

const log = createLogger("wiki-sync");

/** Page tree root — same namespace in API refs and in the checkout. */
const WIKI_ROOT = "wiki";

/** Server-side cap on refs per `page/read` call (store/wiki-service PAGE_READ_MAX). */
const PAGE_READ_BATCH = 20;

/**
 * Service-generated structural files: they are the service's own artefact, not
 * wiki content, and `page/write` refuses to author them. Never projected.
 */
const STRUCTURAL_PAGES = new Set([`${WIKI_ROOT}/schema.md`, `${WIKI_ROOT}/purpose.md`]);

export interface Options {
  repo: string;
  wikiId: string;
  apiUrl: string;
  serviceId?: string;
  token?: string;
  push: boolean;
  noCommit: boolean;
  dryRun: boolean;
  allowEmpty: boolean;
}

export interface SyncPlan {
  /** Refs to write, relative to the repo root. */
  write: string[];
  /** Existing page files with no counterpart in the wiki. */
  delete: string[];
}

/**
 * True if `p` is a page file this bin owns: markdown, under `wiki/`, not in the
 * `media/` subtree (assets are not pages, and `page/ls` does not list them —
 * deleting from a listing that cannot contain them would be data loss).
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

/** Page files the wiki says exist, de-duplicated and sorted. */
export function wantedPages(pagePaths: string[]): string[] {
  const wanted = new Set<string>();
  for (const p of pagePaths) {
    if (isPageFile(p) && !isStructuralPage(p)) wanted.add(p);
  }
  return [...wanted].sort();
}

/**
 * Diff the wiki's page set against the checkout's. Pure: the whole decision is
 * `wanted` minus `existing` in each direction, so it is testable without a
 * service or a repo.
 */
export function planSync(pagePaths: string[], existingPaths: string[]): SyncPlan {
  const write = wantedPages(pagePaths);
  const kept = new Set(write);
  // Structural files are neither written nor deleted — this bin does not own
  // them, so a checkout that has them keeps them.
  const remove = existingPaths.filter(
    (p) => isPageFile(p) && !isStructuralPage(p) && !kept.has(p),
  );
  return { write, delete: [...new Set(remove)].sort() };
}

/** Page files currently in the checkout, as repo-relative posix paths. */
export function walkPageFiles(repoDir: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // missing/unreadable subtree = nothing to delete
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "media") continue;
        walk(full);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      out.push(relative(repoDir, full).split(sep).join("/"));
    }
  };
  walk(join(repoDir, WIKI_ROOT));
  return out;
}

async function listPages(http: HttpClientOptions, wikiId: string): Promise<string[]> {
  const data = (await callApi(http, "/wiki/page/ls", { wiki_id: wikiId })) as {
    items?: { path?: string }[];
  };
  return (data?.items ?? []).map((i) => i.path).filter((p): p is string => Boolean(p));
}

/**
 * Read every ref, in server-sized batches. Content is the page verbatim —
 * including its frontmatter — so the projection is byte-for-byte the wiki.
 *
 * A ref the service reports as missing aborts the whole run: a silent drop
 * here is a page deleted from every clone of the projection.
 */
async function readPages(
  http: HttpClientOptions,
  wikiId: string,
  refs: string[],
): Promise<Map<string, string>> {
  const contents = new Map<string, string>();
  for (let i = 0; i < refs.length; i += PAGE_READ_BATCH) {
    const batch = refs.slice(i, i + PAGE_READ_BATCH);
    const data = (await callApi(http, "/wiki/page/read", { wiki_id: wikiId, refs: batch })) as {
      items?: { ref?: string; content?: string; not_found?: boolean }[];
    };
    for (const item of data?.items ?? []) {
      if (!item.ref || item.not_found || typeof item.content !== "string") {
        throw new Error(`page not readable: ${item.ref ?? "(missing ref)"}`);
      }
      contents.set(item.ref, item.content);
    }
  }
  for (const ref of refs) {
    if (!contents.has(ref)) throw new Error(`page missing from read response: ${ref}`);
  }
  return contents;
}

function applyPlan(repoDir: string, plan: SyncPlan, contents: Map<string, string>): void {
  for (const ref of plan.write) {
    const abs = join(repoDir, ref);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, contents.get(ref) ?? "", "utf-8");
  }
  for (const ref of plan.delete) {
    rmSync(join(repoDir, ref), { force: true });
  }
}

/** Stage `wiki/`, commit if that changed anything, optionally push. */
async function commitProjection(repoDir: string, message: string, push: boolean): Promise<boolean> {
  const git = simpleGit(repoDir);
  await git.raw(["add", "-A", "--", WIKI_ROOT]);
  const status = await git.status();
  if (status.files.length === 0) {
    log.info("no changes to commit");
    return false;
  }
  await git.commit(message);
  if (push) await git.push();
  return true;
}

function usage(): string {
  return [
    "Project a TDAI wiki onto a local git checkout.",
    "",
    "Usage:",
    "  knowledge-wiki-sync --wiki-id <id> --repo <path> [options]",
    "",
    "Required:",
    "  --wiki-id <id>        Wiki to project (e.g. wiki-g8lwpmlz)",
    "  --repo <path>         Existing git checkout to write <repo>/wiki/ into",
    "",
    "Options:",
    "  --api-url <url>       Knowledge Service base URL (env KNOWLEDGE_API_URL, default http://localhost:8421)",
    "  --service-id <id>     Tenant id, sent as x-tdai-service-id (env KNOWLEDGE_SERVICE_ID)",
    "  --token <token>       Bearer token (env KNOWLEDGE_API_TOKEN)",
    "  --push                Push the commit to the checkout's remote",
    "  --no-commit           Write the tree, leave staging/committing to you",
    "  --dry-run             Report the plan, write nothing",
    "  --allow-empty         Permit an empty page listing (can wipe the checkout)",
    "  -h, --help            Show this help",
    "",
    "Exit codes: 0 ok · 1 error (a failed read writes nothing)",
    "",
  ].join("\n");
}

export function parseArgs(argv: string[]): Options | "help" {
  const flags = new Map<string, string>();
  const bools = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") return "help";
    if (!arg.startsWith("--")) throw new Error(`unexpected argument: ${arg}`);
    const eq = arg.indexOf("=");
    if (eq !== -1) {
      flags.set(arg.slice(2, eq), arg.slice(eq + 1));
      continue;
    }
    const inlineBools = new Set(["push", "no-commit", "dry-run", "allow-empty"]);
    if (inlineBools.has(arg.slice(2))) {
      bools.add(arg.slice(2));
      continue;
    }
    const value = argv[++i];
    if (value === undefined || value.startsWith("--")) throw new Error(`${arg} requires a value`);
    flags.set(arg.slice(2), value);
  }

  const repo = flags.get("repo");
  const wikiId = flags.get("wiki-id");
  if (!repo) throw new Error("--repo is required");
  if (!wikiId) throw new Error("--wiki-id is required");

  return {
    repo,
    wikiId,
    apiUrl: flags.get("api-url") ?? process.env.KNOWLEDGE_API_URL ?? "http://localhost:8421",
    serviceId: flags.get("service-id") ?? process.env.KNOWLEDGE_SERVICE_ID,
    token: flags.get("token") ?? process.env.KNOWLEDGE_API_TOKEN,
    push: bools.has("push"),
    noCommit: bools.has("no-commit"),
    dryRun: bools.has("dry-run"),
    allowEmpty: bools.has("allow-empty"),
  };
}

export async function runSync(opts: Options): Promise<SyncPlan> {
  const repoDir = resolve(opts.repo);
  if (!existsSync(repoDir)) throw new Error(`repo directory not found: ${repoDir}`);

  const http: HttpClientOptions = { baseUrl: opts.apiUrl, token: opts.token, serviceId: opts.serviceId };
  const pagePaths = await listPages(http, opts.wikiId);
  const wanted = wantedPages(pagePaths);

  // An empty listing is almost always a wrong --service-id or a wiki that is
  // not `ready` (page/ls returns []), not a wiki someone emptied. Writing that
  // plan would delete every page file in the checkout.
  if (wanted.length === 0 && !opts.allowEmpty) {
    throw new Error(
      "wiki returned no pages — refusing to delete the checkout's page files " +
        "(check --service-id / wiki status, or pass --allow-empty)",
    );
  }

  const plan = planSync(pagePaths, walkPageFiles(repoDir));
  log.info(`wiki ${opts.wikiId}: ${plan.write.length} pages, ${plan.delete.length} to delete`);

  if (opts.dryRun) {
    for (const p of plan.delete) log.info(`would delete ${p}`);
    return plan;
  }

  const contents = await readPages(http, opts.wikiId, plan.write);
  applyPlan(repoDir, plan, contents);
  for (const p of plan.delete) log.info(`deleted ${p}`);

  if (!opts.noCommit) {
    const message = `sync wiki ${opts.wikiId}: ${plan.write.length} written, ${plan.delete.length} deleted`;
    await commitProjection(repoDir, message, opts.push);
  }
  return plan;
}

/**
 * Entry point. Catches everything so a launcher can `void main()` — a rejection
 * escaping here would surface as an unhandled rejection, not a clean exit.
 */
export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  try {
    const parsed = parseArgs(argv);
    if (parsed === "help") {
      process.stdout.write(usage());
      return;
    }
    await runSync(parsed);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`knowledge-wiki-sync: ${msg}\n`);
    process.exitCode = 1;
  }
}

// Direct run (`tsx src/wiki-sync.ts`). The published bin goes through
// bin/wiki-sync.mjs, which calls main() itself — argv[1] is the launcher there,
// so this guard is false and nothing runs twice.
if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}