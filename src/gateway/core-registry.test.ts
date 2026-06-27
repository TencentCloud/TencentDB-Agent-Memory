import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CoreRegistry, safeAccountDir } from "./core-registry.js";
import { parseConfig } from "../config.js";
import type { StandaloneLLMConfig } from "../adapters/standalone/llm-runner.js";
import type { Logger } from "../core/types.js";

const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

const llmConfig: StandaloneLLMConfig = {
  baseUrl: "http://127.0.0.1:0",
  apiKey: "",
  model: "test-model",
  maxTokens: 256,
  timeoutMs: 1000,
  disableThinking: false,
};

// Extraction off → no background timers / LLM calls spun up by initialize().
// provider "none" → no embedding service (keyword/FTS path), no network.
const memory = parseConfig({ extraction: { enabled: false }, embedding: { provider: "none" } });

function makeRegistry(
  baseDir: string,
  multiTenant: boolean,
  maxResidentCores?: number,
): CoreRegistry {
  return new CoreRegistry({
    baseDir,
    llmConfig,
    memory,
    logger: silentLogger,
    multiTenant,
    maxResidentCores,
  });
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe("safeAccountDir", () => {
  it("is deterministic for the same key", () => {
    expect(safeAccountDir("ai4all:alice")).toBe(safeAccountDir("ai4all:alice"));
  });

  it("throws on empty / whitespace keys", () => {
    expect(() => safeAccountDir("")).toThrow();
    expect(() => safeAccountDir("   ")).toThrow();
  });

  it("never emits a path separator, traversal, or hidden segment", () => {
    for (const key of ["ai4all:../../etc/passwd", "a/b/c", "..", ".", "../x", "\\\\evil", "..\\..\\x"]) {
      const dir = safeAccountDir(key);
      expect(dir).not.toContain("/");
      expect(dir).not.toContain("\\");
      expect(dir.startsWith(".")).toBe(false);
      expect(dir).not.toBe("..");
      // Stays a single path segment.
      expect(path.basename(dir)).toBe(dir);
    }
  });

  it("maps slug-colliding keys to DISTINCT dirs (hash guards isolation)", () => {
    // 'a/b' and 'a_b' sanitise to the same slug but must not share a directory.
    expect(safeAccountDir("a/b")).not.toBe(safeAccountDir("a_b"));
    expect(safeAccountDir("ai4all:x")).not.toBe(safeAccountDir("ai4all:y"));
  });
});

describe("CoreRegistry extraction cap", () => {
  function reg(multiTenant: boolean, maxConcurrentExtractions?: number): CoreRegistry {
    return new CoreRegistry({
      baseDir: "/tmp/tdai-cap-unused", // no core is created in these stats-only checks
      llmConfig,
      memory,
      logger: silentLogger,
      multiTenant,
      maxConcurrentExtractions,
    });
  }

  it("multi-tenant defaults to a bounded cap", () => {
    expect(reg(true).extractionStats().limit).toBe(4);
  });

  it("single-tenant defaults to unbounded (0)", () => {
    expect(reg(false).extractionStats().limit).toBe(0);
  });

  it("an explicit positive cap wins in either mode", () => {
    expect(reg(true, 2).extractionStats().limit).toBe(2);
    expect(reg(false, 3).extractionStats().limit).toBe(3);
  });

  it("an explicit 0 forces unbounded even in multi-tenant", () => {
    expect(reg(true, 0).extractionStats().limit).toBe(0);
  });

  it("starts idle (no active or waiting permits)", () => {
    const stats = reg(true).extractionStats();
    expect(stats.active).toBe(0);
    expect(stats.waiting).toBe(0);
  });
});

describe("CoreRegistry LRU eviction (multi-tenant)", () => {
  let baseDir: string;
  const registries: CoreRegistry[] = [];

  function reg(maxResidentCores?: number, multiTenant = true): CoreRegistry {
    const r = makeRegistry(baseDir, multiTenant, maxResidentCores);
    registries.push(r);
    return r;
  }

  beforeEach(async () => {
    baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "tdai-lru-"));
  });

  afterEach(async () => {
    await Promise.all(registries.splice(0).map((r) => r.destroyAll()));
    await fs.rm(baseDir, { recursive: true, force: true });
  });

  it("defaults to unlimited resident cores (limit 0)", () => {
    expect(reg().residentStats().limit).toBe(0);
  });

  it("single-tenant ignores the resident cap (always unlimited)", () => {
    expect(reg(2, false).residentStats().limit).toBe(0);
  });

  it("honours an explicit positive cap", () => {
    expect(reg(3).residentStats().limit).toBe(3);
  });

  it("unlimited keeps every account resident", async () => {
    const r = reg(); // unlimited
    await r.getCore("ai4all:a");
    await r.getCore("ai4all:b");
    await r.getCore("ai4all:c");
    expect(r.size).toBe(3);
    expect(r.residentStats().count).toBe(3);
  });

  it("evicts the least-recently-used core past the cap, sparing the active one", async () => {
    const r = reg(2);
    await r.getCore("ai4all:a");
    await delay(5);
    await r.getCore("ai4all:b");
    await delay(5);
    await r.getCore("ai4all:a"); // touch a → b becomes the LRU
    await delay(5);
    await r.getCore("ai4all:c"); // size would be 3 (> 2) → evict b

    expect(r.size).toBe(2);
    expect(r.peek("ai4all:b")).toBeUndefined();
    expect(r.peek("ai4all:a")).toBeDefined();
    expect(r.peek("ai4all:c")).toBeDefined();
  });

  it("eviction flushes + closes the core but KEEPS the dataDir (unlike wipe)", async () => {
    const r = reg(1);
    const aDir = r.resolveDataDir("ai4all:a");
    await r.getCore("ai4all:a");
    await fs.writeFile(path.join(aDir, "marker.txt"), "x");
    await delay(5);
    await r.getCore("ai4all:b"); // evicts a

    expect(r.peek("ai4all:a")).toBeUndefined();
    // dir + its contents survive eviction — eviction is not a hard delete.
    expect((await fs.stat(aDir)).isDirectory()).toBe(true);
    expect(await fs.readFile(path.join(aDir, "marker.txt"), "utf8")).toBe("x");
  });

  it("re-requesting an evicted account rebuilds a working core on the same dataDir", async () => {
    const r = reg(1);
    const first = await r.getCore("ai4all:a");
    const aDir = r.resolveDataDir("ai4all:a");
    await delay(5);
    await r.getCore("ai4all:b"); // evicts a (teardown in flight)

    // Re-request a: must wait for the old SQLite handle to close, then reopen.
    const again = await r.getCore("ai4all:a"); // evicts b in turn
    expect(again).not.toBe(first); // a fresh core, not the destroyed one
    expect(r.resolveDataDir("ai4all:a")).toBe(aDir); // same dataDir reused
    expect(r.peek("ai4all:a")).toBe(again);
    expect(r.peek("ai4all:b")).toBeUndefined();
    expect(r.size).toBe(1);
  });
});

describe("CoreRegistry wipe guards", () => {
  it("refuses namespace wipe in single-tenant mode", async () => {
    const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "tdai-wipe-st-"));
    const registry = makeRegistry(baseDir, false);
    try {
      await expect(registry.wipe("ai4all:alice")).rejects.toThrow(/multi-tenant/);
    } finally {
      await registry.destroyAll();
      await fs.rm(baseDir, { recursive: true, force: true });
    }
  });
});

describe("CoreRegistry (single-tenant)", () => {
  let baseDir: string;
  let registry: CoreRegistry;

  beforeEach(async () => {
    baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "tdai-registry-st-"));
    registry = makeRegistry(baseDir, false);
  });

  afterEach(async () => {
    await registry.destroyAll();
    await fs.rm(baseDir, { recursive: true, force: true });
  });

  it("returns one shared core rooted at baseDir regardless of session_key", async () => {
    const a = await registry.getCore("ai4all:alice");
    const b = await registry.getCore("ai4all:bob");
    const c = await registry.getCore("");
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(registry.size).toBe(1);
    expect(registry.resolveDataDir("anything")).toBe(baseDir);
  });
});

describe("CoreRegistry (multi-tenant)", () => {
  let baseDir: string;
  let registry: CoreRegistry;

  beforeEach(async () => {
    baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "tdai-registry-mt-"));
    registry = makeRegistry(baseDir, true);
  });

  afterEach(async () => {
    await registry.destroyAll();
    await fs.rm(baseDir, { recursive: true, force: true });
  });

  it("creates a distinct core + dataDir per account, both under baseDir", async () => {
    const alice = await registry.getCore("ai4all:alice");
    const bob = await registry.getCore("ai4all:bob");

    expect(alice).not.toBe(bob);
    expect(registry.size).toBe(2);

    const aliceDir = registry.resolveDataDir("ai4all:alice");
    const bobDir = registry.resolveDataDir("ai4all:bob");
    expect(aliceDir).not.toBe(bobDir);
    expect(path.dirname(aliceDir)).toBe(baseDir);
    expect(path.dirname(bobDir)).toBe(baseDir);

    // initialize() creates the per-account directory tree on disk.
    expect((await fs.stat(aliceDir)).isDirectory()).toBe(true);
    expect((await fs.stat(bobDir)).isDirectory()).toBe(true);
    const entries = (await fs.readdir(baseDir)).sort();
    expect(entries).toContain(path.basename(aliceDir));
    expect(entries).toContain(path.basename(bobDir));
  });

  it("caches per account: repeated + concurrent gets return the same core", async () => {
    const first = await registry.getCore("ai4all:alice");
    const again = await registry.getCore("ai4all:alice");
    expect(again).toBe(first);

    const [c1, c2] = await Promise.all([
      registry.getCore("ai4all:carol"),
      registry.getCore("ai4all:carol"),
    ]);
    expect(c1).toBe(c2);
    expect(registry.size).toBe(2); // alice + carol
  });

  it("requires a non-empty session_key", async () => {
    await expect(registry.getCore("")).rejects.toThrow();
    expect(() => registry.resolveDataDir("")).toThrow();
  });

  it("wipe removes the account core + its dataDir, idempotently", async () => {
    const dir = registry.resolveDataDir("ai4all:erin");
    await registry.getCore("ai4all:erin");
    await fs.writeFile(path.join(dir, "marker.txt"), "x");
    expect((await fs.stat(dir)).isDirectory()).toBe(true);

    await registry.wipe("ai4all:erin");
    expect(registry.peek("ai4all:erin")).toBeUndefined();
    expect(registry.size).toBe(0);
    await expect(fs.stat(dir)).rejects.toBeTruthy(); // dir gone

    // Wiping an already-wiped / never-seen account does not throw.
    await expect(registry.wipe("ai4all:erin")).resolves.toBeTruthy();
    await expect(registry.wipe("ai4all:never")).resolves.toBeTruthy();
  });

  it("peek does not create a core; evict tears one down and frees the slot", async () => {
    expect(registry.peek("ai4all:dave")).toBeUndefined();
    const core = await registry.getCore("ai4all:dave");
    expect(registry.peek("ai4all:dave")).toBe(core);

    const dir = await registry.evict("ai4all:dave");
    expect(dir).toBe(registry.resolveDataDir("ai4all:dave"));
    expect(registry.peek("ai4all:dave")).toBeUndefined();
    expect(registry.size).toBe(0);
    // Evicting an absent account is a no-op.
    expect(await registry.evict("ai4all:dave")).toBeUndefined();
  });
});
