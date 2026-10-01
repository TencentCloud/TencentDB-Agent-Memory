/**
 * Regression tests for the store-init cache (issue #1155).
 *
 * `initStores()` is a once-async singleton keyed by `pluginDataDir`: the
 * resolved bundle is cached forever, so a bundle that went bad after the fact
 * is served on every subsequent call.
 *
 * Two ways that happens without anyone calling `resetStores()`:
 *   1. `_doInitStores()` swallows an init error (or refuses to proceed because
 *      the store is degraded) and still returns the bundle, which the cache
 *      then stores as if it were healthy — one transient error permanently
 *      disables vector/FTS recall and embedding.
 *   2. The store is closed outside the shutdown path (context-engine compaction
 *      teardown, a restart race). `VectorStore`'s methods are fault-tolerant and
 *      return empty/false rather than throwing, so nothing downstream can tell
 *      a closed store from an empty one — every read fails with
 *      "statement has been finalized" / "database is not open".
 *
 * Either way the symptoms persist until the whole process restarts, and
 * `/health` keeps reporting the store as available.
 */
/**
 * Store instances are compared with `===` / `!==` rather than `toBe` /
 * `not.toBe`: vitest's diff serializer walks the object on failure, and
 * walking a closed `VectorStore` trips its finalized statements.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initStores, resetStores } from "./pipeline-factory.js";
import { parseConfig } from "../config.js";
import type { MemoryTdaiConfig } from "../config.js";
import type { Logger } from "../core/types.js";

/** A config the sqlite backend accepts with no embedding service. */
function sqliteConfig(): MemoryTdaiConfig {
  return parseConfig({ storeBackend: "sqlite" });
}

/** tcvdb without url/apiKey → `createStoreBundle` throws inside `_doInitStores`. */
function brokenConfig(): MemoryTdaiConfig {
  return { ...parseConfig({}), storeBackend: "tcvdb" } as MemoryTdaiConfig;
}

const warnings: string[] = [];
const logger: Logger = {
  debug: () => {},
  info: () => {},
  warn: (m) => warnings.push(m),
  error: (m) => warnings.push(m),
};

let dirs: string[] = [];
const freshDir = (): string => {
  const d = mkdtempSync(join(tmpdir(), "tdai-store-init-cache-"));
  dirs.push(d);
  return d;
};

beforeEach(() => {
  resetStores();
  warnings.length = 0;
});

afterEach(() => {
  resetStores();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

describe("initStores cache self-healing", () => {
  it("reuses a healthy bundle across calls", async () => {
    const dir = freshDir();
    const cfg = sqliteConfig();

    const first = await initStores(cfg, dir, logger);
    const second = await initStores(cfg, dir, logger);

    expect(first.vectorStore).toBeDefined();
    expect(second.vectorStore === first.vectorStore).toBe(true);
    expect(warnings.join("\n")).not.toContain("discarding it and re-initializing");
  });

  it("re-initializes after a failed init instead of caching the failure", async () => {
    const dir = freshDir();

    const failed = await initStores(brokenConfig(), dir, logger);
    expect(failed.vectorStore).toBeUndefined();

    // The transient cause is gone — a healthy config must get a real store,
    // not the cached failure.
    const recovered = await initStores(sqliteConfig(), dir, logger);
    expect(recovered.vectorStore).toBeDefined();
    expect(recovered.vectorStore?.isDegraded()).toBe(false);
    expect(warnings.join("\n")).toContain("discarding it and re-initializing");
  });

  it("re-initializes after the cached store was closed elsewhere", async () => {
    const dir = freshDir();
    const cfg = sqliteConfig();

    const first = await initStores(cfg, dir, logger);
    const firstStore = first.vectorStore;
    expect(firstStore).toBeDefined();

    // Close outside the shutdown path — compaction teardown / restart race.
    // Nothing calls resetStores() for it.
    firstStore!.close();
    expect(firstStore!.isClosed?.()).toBe(true);

    const second = await initStores(cfg, dir, logger);

    expect(second.vectorStore).toBeDefined();
    expect(second.vectorStore !== firstStore).toBe(true);
    // The replacement must actually work: not closed, not degraded, and able
    // to serve a query rather than throwing "database is not open".
    expect(second.vectorStore!.isClosed?.()).toBe(false);
    expect(second.vectorStore!.isDegraded()).toBe(false);
    expect(second.vectorStore!.countL1()).toBe(0);
    expect(warnings.join("\n")).toContain("discarding it and re-initializing");
  });

  it("keys the cache per data directory", async () => {
    const dirA = freshDir();
    const dirB = freshDir();
    const cfg = sqliteConfig();

    const a = await initStores(cfg, dirA, logger);
    const b = await initStores(cfg, dirB, logger);

    expect(a.vectorStore).toBeDefined();
    expect(b.vectorStore).toBeDefined();
    expect(a.vectorStore !== b.vectorStore).toBe(true);
  });
});
