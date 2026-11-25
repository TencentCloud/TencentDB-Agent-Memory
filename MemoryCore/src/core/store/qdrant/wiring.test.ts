import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it, expect, vi, afterAll } from "vitest";
import { QdrantClient } from "@qdrant/js-client-rest";
import { parseConfig } from "../../../config.js";
import { LocalBackendResolver, validateResolution, dbChoiceToStoreConfigs } from "../../backend-selection/index.js";
import { BackendCapabilityError, ProfileVersionConflictError } from "../profile-row-store.js";
import { createStoreBundle } from "../factory.js";
import { StorePool } from "../store-pool.js";
import { readQdrantEnvConfig } from "../../../utils/env-config.js";
import { SqliteSkillStore } from "../sqlite/skill-store.js";
import { QdrantMemoryStore } from "./memory-store.js";
import { classifyError } from "../../../gateway/error-handler.js";

const QDRANT_URL = process.env.QDRANT_TEST_URL ?? "";
const prefixes: string[] = [];

afterAll(async () => {
  if (!QDRANT_URL) return;
  const client = new QdrantClient({ url: QDRANT_URL, checkCompatibility: false });
  const { collections } = await client.getCollections();
  await Promise.all(
    collections
      .filter((c) => prefixes.some((p) => c.name.startsWith(`${p}_`)))
      .map((c) => client.deleteCollection(c.name)),
  );
});

const silentLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

describe("qdrant config", () => {
  it("parses storeBackend=qdrant and reads QDRANT_* env with a default prefix", () => {
    expect(parseConfig({ storeBackend: "qdrant" }).storeBackend).toBe("qdrant");
    vi.stubEnv("QDRANT_URL", "http://env:6333");
    vi.stubEnv("QDRANT_API_KEY", "env-key");
    vi.stubEnv("QDRANT_COLLECTION_PREFIX", "");
    expect(readQdrantEnvConfig()).toEqual({ url: "http://env:6333", apiKey: "env-key", collectionPrefix: "tdai" });
  });
});

describe("qdrant backend selection", () => {
  const source = {
    resolveVdb: async () => { throw new Error("unused"); },
    resolveMongo: async () => { throw new Error("unused"); },
    resolveCos: async () => null,
  };

  it("STORE_MODE=qdrant resolves to a conn-less db choice", async () => {
    const resolver = new LocalBackendResolver({ deployMode: "standalone", storeMode: "qdrant", source });
    const res = await resolver.resolve("inst");
    expect(res.db).toEqual({ kind: "qdrant", conn: null });
    expect(dbChoiceToStoreConfigs(res.db)).toEqual({ vdbConfig: null, mongoConfig: null });
  });

  it("qdrant serves profile rows, so rowfs is a legal file plane", () => {
    expect(() => validateResolution({
      db: { kind: "qdrant", conn: null },
      fs: { profile: "rows", others: { kind: "local", conn: null } },
    })).not.toThrow();
    expect(() => validateResolution({
      db: { kind: "sqlite", conn: null },
      fs: { profile: "rows", others: { kind: "local", conn: null } },
    })).toThrow(BackendCapabilityError);
  });

  it("createStoreBundle fails fast without a url", () => {
    vi.stubEnv("QDRANT_URL", "");
    expect(() => createStoreBundle(parseConfig({ storeBackend: "qdrant" }), { dataDir: tmpdir() }))
      .toThrow(/QDRANT_URL/);
  });
});

describe("profile write conflicts", () => {
  it("surface as a retryable 409, not a 500", () => {
    const c = classifyError(new ProfileVersionConflictError("p", 3, "[memory-tdai][qdrant]"));
    expect(c.status).toBe(409);
    expect(c.client).toMatchObject({ code: 409, retryable: true });
  });
});

describe("qdrant skill store", () => {
  it("StorePool in qdrant mode serves per-instance SQLite skill stores that survive eviction", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "tdai-pool-skill-"));
    const pool = new StorePool({ mode: "qdrant", memoryCfg: parseConfig({}), dataDir, logger: silentLogger });
    const a = await pool.getSkillStore("default", null, null);
    const b = await pool.getSkillStore("inst-b", null, null);
    expect(a).toBeInstanceOf(SqliteSkillStore);
    expect(b).not.toBe(a);
    expect(await pool.getSkillStore("default", null, null)).toBe(a);
    pool.evictSkillStore("default");
    expect(await a.listSkills({ team_id: "t" })).toEqual({ items: [], total: 0 });
    expect(await (await pool.getSkillStore("default", null, null)).listSkills({ team_id: "t" })).toEqual({ items: [], total: 0 });
    const { existsSync } = await import("node:fs");
    expect(existsSync(path.join(dataDir, "skills.db"))).toBe(true);
    expect(existsSync(path.join(dataDir, "instances", "inst-b", "skills.db"))).toBe(true);
    pool.setGraceCloseDelay(0);
    await pool.closeAll();
  });
});

describe.skipIf(!QDRANT_URL)("qdrant wiring (live)", () => {
  it("createStoreBundle builds a keyword-only Qdrant store and manifest snapshot", async () => {
    const prefix = `tdai_wiring_${randomUUID().slice(0, 8)}`;
    prefixes.push(prefix);
    vi.stubEnv("QDRANT_URL", QDRANT_URL);
    vi.stubEnv("QDRANT_COLLECTION_PREFIX", prefix);
    const bundle = createStoreBundle(parseConfig({ storeBackend: "qdrant" }), { dataDir: tmpdir(), logger: silentLogger });
    expect(bundle.store).toBeInstanceOf(QdrantMemoryStore);
    expect(bundle.storeSnapshot).toEqual({ type: "qdrant", qdrantUrl: QDRANT_URL, qdrantCollectionPrefix: prefix });
    await bundle.store.init();
    expect(bundle.store.getCapabilities().vectorSearch).toBe(false);
    expect(await bundle.store.countL1()).toBe(0);
  });

  it("StorePool in qdrant mode shares collections across instances, isolated by tenant", async () => {
    const prefix = `tdai_pool_${randomUUID().slice(0, 8)}`;
    prefixes.push(prefix);
    vi.stubEnv("QDRANT_URL", QDRANT_URL);
    vi.stubEnv("QDRANT_COLLECTION_PREFIX", prefix);
    const pool = new StorePool({
      mode: "qdrant",
      memoryCfg: parseConfig({}),
      dataDir: mkdtempSync(path.join(tmpdir(), "tdai-pool-")),
      logger: silentLogger,
    });
    pool.setGraceCloseDelay(0);

    const a = await pool.getStore("inst-a", null, null);
    const b = await pool.getStore("inst-b", null, null);
    const def = await pool.getStore("default", null, null);
    expect(a.store).toBeInstanceOf(QdrantMemoryStore);
    expect(await pool.getStore("inst-a", null, null)).toBe(a);

    const ts = new Date().toISOString();
    await a.store.upsertL1({
      id: "only-in-a", content: "instance a memory", type: "persona", priority: 1, scene_name: "",
      source_message_ids: [], metadata: {}, timestamps: [ts], createdAt: ts, updatedAt: ts,
      sessionKey: "sk", sessionId: "sid",
    });
    expect(await a.store.countL1()).toBe(1);
    expect(await b.store.countL1()).toBe(0);

    const client = new QdrantClient({ url: QDRANT_URL, checkCompatibility: false });
    const names = (await client.getCollections()).collections.map((c) => c.name);
    expect(names.filter((n) => n.startsWith(`${prefix}_`))).toHaveLength(9);
    expect(names).toContain(`${prefix}_l1`);
    expect(await def.store.countL1()).toBe(0);
    await pool.closeAll();
  });
});
