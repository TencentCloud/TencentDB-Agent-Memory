import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { parseConfig } from "../../config.js";
import type { MemoryTdaiConfig } from "../../config.js";
import { TdaiCore } from "../../core/tdai-core.js";
import { loadGatewayConfig } from "../config.js";
import type { GatewayConfig } from "../config.js";
import { TdaiGateway } from "../server.js";

// ============================
// Isolated test environment
// ============================
// The gateway config loader picks up `tdai-gateway.yaml` from CWD or the
// default data dir if present — both stubbed to a per-test temp dir so no
// machine-level configuration can leak into these tests.

const tmpRoots: string[] = [];
let tmpRoot = "";
let warnSpy: ReturnType<typeof vi.spyOn>;
let stderrSpy: ReturnType<typeof vi.spyOn>;

function makeTmpRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-multi-user-"));
  tmpRoots.push(dir);
  return dir;
}

beforeEach(() => {
  tmpRoot = makeTmpRoot();
  // Empty config file → deterministic base config, no host machine leakage.
  fs.writeFileSync(path.join(tmpRoot, "gateway-config.json"), "{}");
  vi.stubEnv("TDAI_GATEWAY_CONFIG", path.join(tmpRoot, "gateway-config.json"));
  vi.stubEnv("TDAI_DATA_DIR", path.join(tmpRoot, "data"));
  delete process.env.TDAI_MULTI_USER;
  delete process.env.TDAI_MULTI_USER_OWNERS;

  // Mute the gateway's console logger to keep test output pristine; the warn
  // spy stays observable so tests can assert on normalization rejections.
  vi.spyOn(console, "debug").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  // Config-load WARNs go to raw stderr (no logger exists yet) — same deal.
  stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterAll(() => {
  for (const dir of tmpRoots) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup — leftover temp dirs must not fail the suite.
    }
  }
});

// ============================
// Helpers
// ============================

let gwCounter = 0;

/** Memory config with background extraction off — captures then only write
 *  L0, keeping the unit test free of pipeline timers and LLM calls. */
function captureOnlyMemoryConfig(): MemoryTdaiConfig {
  return parseConfig({ extraction: { enabled: false } });
}

interface TestGateway {
  gw: TdaiGateway;
  resolve: (raw: unknown) => Promise<TdaiCore>;
  baseDir: string;
}

function makeGateway(multiUser: GatewayConfig["multiUser"]): TestGateway {
  const baseDir = path.join(tmpRoot, `gw-${++gwCounter}`);
  const gw = new TdaiGateway({
    data: { baseDir },
    multiUser,
    memory: captureOnlyMemoryConfig(),
  });
  const resolve = (gw as unknown as { _resolveCore: (raw: unknown) => Promise<TdaiCore> })._resolveCore
    .bind(gw) as (raw: unknown) => Promise<TdaiCore>;
  return { gw, resolve, baseDir };
}

function readAllJsonl(dir: string): string {
  if (!fs.existsSync(dir)) return "";
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => fs.readFileSync(path.join(dir, f), "utf-8"))
    .join("\n");
}

// ============================
// Config loading
// ============================

describe("multiUser config loading", () => {
  it("defaults to disabled with an empty owner list", () => {
    expect(loadGatewayConfig().multiUser).toEqual({ enabled: false, ownerUserIds: [] });
  });

  it("reads TDAI_MULTI_USER ('true'/'1' enable; other values do not)", () => {
    vi.stubEnv("TDAI_MULTI_USER", "true");
    expect(loadGatewayConfig().multiUser.enabled).toBe(true);
    vi.stubEnv("TDAI_MULTI_USER", "1");
    expect(loadGatewayConfig().multiUser.enabled).toBe(true);
    vi.stubEnv("TDAI_MULTI_USER", "TRUE");
    expect(loadGatewayConfig().multiUser.enabled).toBe(true);
    vi.stubEnv("TDAI_MULTI_USER", "yes");
    expect(loadGatewayConfig().multiUser.enabled).toBe(false);
    vi.stubEnv("TDAI_MULTI_USER", "false");
    expect(loadGatewayConfig().multiUser.enabled).toBe(false);
  });

  it("reads TDAI_MULTI_USER_OWNERS, normalizing entries and dropping invalid ones", () => {
    vi.stubEnv("TDAI_MULTI_USER", "true");
    vi.stubEnv("TDAI_MULTI_USER_OWNERS", "HuangZhengBo, wendy.li , Wang , dup , dup");
    const cfg = loadGatewayConfig();
    expect(cfg.multiUser.enabled).toBe(true);
    expect(cfg.multiUser.ownerUserIds).toEqual(["huangzhengbo", "wang", "dup"]);
    // The dropped invalid entry is announced (operator typo visibility).
    const dropWarn = stderrSpy.mock.calls.find((call) => String(call[0]).includes("dropping invalid multiUser.ownerUserIds entry"));
    expect(dropWarn).toBeTruthy();
    expect(String(dropWarn![0])).toContain("wendy.li");
  });

  it("reads yaml multiUser.enabled / multiUser.ownerUserIds", () => {
    fs.writeFileSync(
      path.join(tmpRoot, "gateway.yaml"),
      ["multiUser:", "  enabled: true", '  ownerUserIds: ["HuangZhengBo", "bad.id"]'].join("\n"),
    );
    vi.stubEnv("TDAI_GATEWAY_CONFIG", path.join(tmpRoot, "gateway.yaml"));
    expect(loadGatewayConfig().multiUser).toEqual({ enabled: true, ownerUserIds: ["huangzhengbo"] });
  });

  it("prefers env over yaml for enabled, and yaml over env for ownerUserIds", () => {
    fs.writeFileSync(
      path.join(tmpRoot, "gateway.yaml"),
      ["multiUser:", "  enabled: true", "  ownerUserIds: [yamlOwner]"].join("\n"),
    );
    vi.stubEnv("TDAI_GATEWAY_CONFIG", path.join(tmpRoot, "gateway.yaml"));
    vi.stubEnv("TDAI_MULTI_USER", "false");
    vi.stubEnv("TDAI_MULTI_USER_OWNERS", "envOwner");
    expect(loadGatewayConfig().multiUser).toEqual({ enabled: false, ownerUserIds: ["yamlowner"] });
  });

  it("lets partial constructor overrides patch multiUser without dropping siblings", () => {
    const cfg = loadGatewayConfig({ multiUser: { enabled: true, ownerUserIds: ["a_b"] } });
    expect(cfg.multiUser).toEqual({ enabled: true, ownerUserIds: ["a_b"] });
    expect(cfg.data.baseDir).toBeTruthy(); // sibling fields survive the merge
  });
});

// ============================
// Gateway core routing
// ============================

describe("TdaiGateway per-user core routing", () => {
  it("routes regular users to lazily-created cores rooted at <baseDir>/users/<uid>", async () => {
    const { gw, resolve, baseDir } = makeGateway({ enabled: true, ownerUserIds: ["huangzhengbo"] });
    try {
      const mainCore = await resolve(undefined);
      const wendy = await resolve("Wendy");

      expect(wendy).toBeInstanceOf(TdaiCore);
      expect(wendy).not.toBe(mainCore);

      // Normalized uid variants share one core (Map dedup + promise dedup).
      expect(await resolve("wendy")).toBe(wendy);
      expect(await resolve("  WENDY  ")).toBe(wendy);

      // A second user gets her own core.
      expect(await resolve("li-hua")).not.toBe(wendy);
      expect(await resolve("li-hua")).not.toBe(mainCore);

      // Per-user data layout: <baseDir>/users/<uid>/ (initialize() creates it).
      expect(fs.existsSync(path.join(baseDir, "users", "wendy"))).toBe(true);
      expect(fs.existsSync(path.join(baseDir, "users", "li-hua"))).toBe(true);
    } finally {
      await gw.stop();
    }
  });

  it("keeps owner / 'default' alias / invalid / missing uids on the main core", async () => {
    const { gw, resolve, baseDir } = makeGateway({ enabled: true, ownerUserIds: ["huangzhengbo"] });
    try {
      const mainCore = await resolve(undefined);
      expect(await resolve("huangzhengbo")).toBe(mainCore);
      expect(await resolve("HuangZhengBo")).toBe(mainCore);
      expect(await resolve("default")).toBe(mainCore);
      expect(await resolve("wendy.li")).toBe(mainCore); // fail-closed, no stripping
      expect(await resolve("../etc/passwd")).toBe(mainCore);
      expect(await resolve(42)).toBe(mainCore);
      expect(await resolve("")).toBe(mainCore);

      // None of the above may create a per-user directory.
      expect(fs.existsSync(path.join(baseDir, "users"))).toBe(false);
    } finally {
      await gw.stop();
    }
  });

  it("warns on normalization rejection, silently for owner and 'default'", async () => {
    const { gw, resolve } = makeGateway({ enabled: true, ownerUserIds: ["huangzhengbo"] });
    try {
      await resolve("huangzhengbo");
      await resolve("default");
      expect(warnSpy).not.toHaveBeenCalled();

      await resolve("wendy.li");
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(String(warnSpy.mock.calls[0]?.[0])).toContain("Invalid or missing user_id");
    } finally {
      await gw.stop();
    }
  });

  it("routes everything to the main core when the feature is off", async () => {
    const { gw, resolve, baseDir } = makeGateway({ enabled: false, ownerUserIds: [] });
    try {
      const mainCore = await resolve(undefined);
      expect(await resolve("wendy")).toBe(mainCore);
      expect(await resolve("wendy.li")).toBe(mainCore);
      expect(await resolve("Wendy")).toBe(mainCore);
      expect(fs.existsSync(path.join(baseDir, "users"))).toBe(false);
    } finally {
      await gw.stop();
    }
  });

  it("isolates per-user stores: each user's capture lands only in its own directory", async () => {
    const { gw, resolve, baseDir } = makeGateway({ enabled: true, ownerUserIds: [] });
    try {
      const wendy = await resolve("wendy");
      const lihua = await resolve("li-hua");

      // startedAt in the past: L0 only records messages strictly newer than
      // the per-session cursor floor (= startedAt on first capture), and
      // synthetic messages are timestamped "now" when recorded.
      const startedAt = Date.now() - 60_000;
      const turn = (sessionKey: string) => ({
        userText: `hello from ${sessionKey}`,
        assistantText: "hi there",
        messages: [
          { role: "user", content: `hello from ${sessionKey}` },
          { role: "assistant", content: "hi there" },
        ],
        sessionKey,
        startedAt,
      });

      const wendyResult = await wendy.handleTurnCommitted(turn("sess-wendy-1"));
      expect(wendyResult.l0RecordedCount).toBeGreaterThan(0);
      const lihuaResult = await lihua.handleTurnCommitted(turn("sess-lihua-1"));
      expect(lihuaResult.l0RecordedCount).toBeGreaterThan(0);

      const wendyJsonl = readAllJsonl(path.join(baseDir, "users", "wendy", "conversations"));
      const lihuaJsonl = readAllJsonl(path.join(baseDir, "users", "li-hua", "conversations"));
      expect(wendyJsonl).toContain("sess-wendy-1");
      expect(wendyJsonl).not.toContain("sess-lihua-1");
      expect(lihuaJsonl).toContain("sess-lihua-1");
      expect(lihuaJsonl).not.toContain("sess-wendy-1");

      // The main store stays free of per-user captures.
      expect(readAllJsonl(path.join(baseDir, "conversations"))).not.toContain("sess-wendy-1");
      expect(readAllJsonl(path.join(baseDir, "conversations"))).not.toContain("sess-lihua-1");
    } finally {
      await gw.stop();
    }
  });

  it("stop() destroys every live per-user core", async () => {
    const { gw, resolve } = makeGateway({ enabled: true, ownerUserIds: [] });
    const wendy = await resolve("wendy");
    const lihua = await resolve("li-hua");
    const wendyDestroy = vi.spyOn(wendy, "destroy");
    const lihuaDestroy = vi.spyOn(lihua, "destroy");

    await gw.stop();

    expect(wendyDestroy).toHaveBeenCalled();
    expect(lihuaDestroy).toHaveBeenCalled();
  });

  it("awaits user-core initialization: a first-request search on a cold core is not the empty-results degradation", async () => {
    // TdaiCore.searchConversations/searchMemories do not await store readiness
    // internally — they degrade to {results: [], total: 0} when the
    // vectorStore is still undefined. _resolveCore must therefore await the
    // shared initialize() promise before handing the core to handlers.
    const baseDir = path.join(tmpRoot, `gw-${++gwCounter}`);
    const make = () =>
      new TdaiGateway({
        data: { baseDir },
        multiUser: { enabled: true, ownerUserIds: [] },
        memory: captureOnlyMemoryConfig(),
      });
    const startedAt = Date.now() - 60_000;

    // Gateway 1: capture data for wendy, then stop — destroy() closes the
    // store and resets the per-dataDir store cache, so gateway 2 starts cold.
    const gw1 = make();
    const wendy1 = await (gw1 as unknown as { _resolveCore: (raw: unknown) => Promise<TdaiCore> })
      ._resolveCore.bind(gw1)("wendy");
    const capture = await wendy1.handleTurnCommitted({
      userText: "hello from sess-wendy-cold",
      assistantText: "hi there",
      messages: [
        { role: "user", content: "hello from sess-wendy-cold" },
        { role: "assistant", content: "hi there" },
      ],
      sessionKey: "sess-wendy-cold",
      startedAt,
    });
    expect(capture.l0RecordedCount).toBeGreaterThan(0);
    await gw1.stop();

    // Gateway 2 (same baseDir, empty userCores): wendy's FIRST request is a
    // search on a cold core. Before the fix the search ran before store init
    // completed and returned the {total: 0, strategy: "none"} degradation.
    const gw2 = make();
    try {
      const wendy2 = await (gw2 as unknown as { _resolveCore: (raw: unknown) => Promise<TdaiCore> })
        ._resolveCore.bind(gw2)("wendy");
      expect(wendy2).not.toBe(wendy1); // fresh cold core, not the warmed one
      expect(wendy2.getVectorStore()).toBeDefined(); // store ready before search

      const result = await wendy2.searchConversations({ query: "hello from sess-wendy-cold" });
      expect(result.total).toBeGreaterThan(0);
    } finally {
      await gw2.stop();
    }
  });

  it("evicts the least-recently-used core beyond 64 users: map entry gone, on-disk data kept, re-resolve works, WARN logged", async () => {
    // Plan §7.2 scenario: the LRU bound reclaims in-memory handles only —
    // `users/<uid>/` on disk is never touched, and a later request for an
    // evicted user transparently re-creates the core over the same data.
    const { gw, resolve, baseDir } = makeGateway({ enabled: true, ownerUserIds: [] });
    const userCores = (gw as unknown as { userCores: Map<string, { core: TdaiCore }> }).userCores;
    try {
      // Give the first user (the future eviction victim) a durable marker.
      const first = await resolve("u-000");
      const capture = await first.handleTurnCommitted({
        userText: "hello from sess-u-000",
        assistantText: "hi there",
        messages: [
          { role: "user", content: "hello from sess-u-000" },
          { role: "assistant", content: "hi there" },
        ],
        sessionKey: "sess-u-000",
        startedAt: Date.now() - 60_000,
      });
      expect(capture.l0RecordedCount).toBeGreaterThan(0);

      // Push past the LRU capacity: u-000 + 64 more = 65 cores created,
      // so exactly one eviction fires (u-000 is the oldest by lastAccess).
      for (let i = 1; i <= 64; i++) {
        await resolve(`u-${String(i).padStart(3, "0")}`);
      }

      // Oldest core evicted from the map, capacity respected.
      expect(userCores.has("u-000")).toBe(false);
      expect(userCores.size).toBe(64);

      // The eviction was announced with a WARN.
      const evictWarn = warnSpy.mock.calls.find((call) => String(call[0]).includes("LRU evicted"));
      expect(evictWarn).toBeTruthy();
      expect(String(evictWarn![0])).toContain("uid=u-000");

      // On-disk data (directory + captured L0 jsonl) survives eviction.
      const firstUserDir = path.join(baseDir, "users", "u-000");
      expect(fs.existsSync(firstUserDir)).toBe(true);
      expect(readAllJsonl(path.join(firstUserDir, "conversations"))).toContain("sess-u-000");

      // Re-resolve IMMEDIATELY — while the background destroy (2s timeout
      // race) may still be draining. Eviction must reset the shared
      // store-init cache synchronously BEFORE the destroy starts, so the
      // fresh core cannot inherit store handles that destroy is about to
      // close. (The old test slept 250ms here, which masked exactly this
      // rebuild-window race.)
      const again = await resolve("u-000");
      expect(again).not.toBe(first);
      expect(userCores.get("u-000")?.core).toBe(again);

      // The fresh core is usable right away: its store holds the surviving
      // data (a stale/closed store handle would make this fail or degrade).
      // Polled because the capture path defers the L0 index write to a
      // background task — visibility is eventual even over a healthy store.
      const deadline = Date.now() + 5_000;
      let search = await again.searchConversations({ query: "hello from sess-u-000" });
      while (search.total === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
        search = await again.searchConversations({ query: "hello from sess-u-000" });
      }
      expect(search.total).toBeGreaterThan(0);
      expect(readAllJsonl(path.join(firstUserDir, "conversations"))).toContain("sess-u-000");
    } finally {
      await gw.stop();
    }
  }, 120_000);

  it("dedups concurrent first requests across normalization: resolving 'w' and 'W' together yields one core, one initialization", async () => {
    // Plan §7.2 scenario: two simultaneous first requests whose raw ids
    // normalize to the same uid must share a single Map entry — no second
    // TdaiCore, no second initialize() racing the first.
    const { gw, resolve } = makeGateway({ enabled: true, ownerUserIds: [] });
    const userCores = (gw as unknown as { userCores: Map<string, { core: TdaiCore }> }).userCores;
    try {
      const [viaW, viaCapW] = await Promise.all([resolve("w"), resolve("W")]);

      // Shared identity — both raw ids got the SAME core instance.
      expect(viaCapW).toBe(viaW);

      // Exactly one entry, keyed by the normalized uid (one initialization).
      expect(userCores.size).toBe(1);
      expect(userCores.has("w")).toBe(true);
      expect(userCores.get("w")?.core).toBe(viaW);
    } finally {
      await gw.stop();
    }
  });
});
