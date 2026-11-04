import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { PgMemoryStore } from "./postgres.js";
import type { PostgresConfig } from "../../config.js";

const runPostgresTests = process.env.TDAI_POSTGRES_TEST === "1";
const describePostgres = runPostgresTests ? describe : describe.skip;

const schema = `agent_memory_test_${process.pid}`;
const config: PostgresConfig = {
  host: process.env.TDAI_PGHOST ?? "127.0.0.1",
  port: Number(process.env.TDAI_PGPORT ?? 5432),
  database: process.env.TDAI_PGDATABASE ?? "postgres",
  user: process.env.TDAI_PGUSER ?? "postgres",
  password: process.env.TDAI_PGPASSWORD,
  schema,
  ssl: false,
  poolMax: 2,
  statementTimeoutMs: 10000,
  textConfig: "simple",
  vectorIndex: "none",
  useVectorScale: false,
};

describePostgres("PgMemoryStore", () => {
  let store: PgMemoryStore;

  beforeAll(async () => {
    const pool = new Pool(config);
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();

    store = new PgMemoryStore(config, 3);
    const init = await store.init({ provider: "test", model: "unit" });
    expect(store.isDegraded()).toBe(false);
    expect(init.needsReindex).toBe(false);
  });

  afterAll(async () => {
    store?.close();
    const pool = new Pool(config);
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
  });

  it("persists and searches L1 and L0 records", async () => {
    await expect(store.upsertL1({
      id: "l1-a",
      content: "PostgreSQL stores durable agent memory",
      type: "persona",
      priority: 80,
      scene_name: "database",
      source_message_ids: [],
      metadata: {},
      timestamps: ["2026-01-01T00:00:00.000Z"],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      sessionKey: "session-key",
      sessionId: "session-id",
    }, new Float32Array([1, 0, 0]))).resolves.toBe(true);

    await expect(store.upsertL0({
      id: "l0-a",
      sessionKey: "session-key",
      sessionId: "session-id",
      role: "user",
      messageText: "Please remember the PostgreSQL backend design",
      recordedAt: "2026-01-01T00:00:01.000Z",
      timestamp: 1767225601000,
    }, new Float32Array([1, 0, 0]))).resolves.toBe(true);

    await expect(store.countL1()).resolves.toBe(1);
    await expect(store.countL0()).resolves.toBe(1);

    const l1Vec = await store.searchL1Vector(new Float32Array([1, 0, 0]), 1);
    expect(l1Vec[0]?.record_id).toBe("l1-a");

    const l0Vec = await store.searchL0Vector(new Float32Array([1, 0, 0]), 1);
    expect(l0Vec[0]?.record_id).toBe("l0-a");

    if (store.isFtsAvailable()) {
      const l1Fts = await store.searchL1Fts("PostgreSQL", 1);
      expect(l1Fts[0]?.record_id).toBe("l1-a");

      const l0Fts = await store.searchL0Fts("PostgreSQL", 1);
      expect(l0Fts[0]?.record_id).toBe("l0-a");
    }
  });

  it("syncs profiles with optimistic versions", async () => {
    await store.syncProfiles([{
      id: "profile:l3:test",
      type: "l3",
      filename: "persona.md",
      content: "User prefers PostgreSQL-backed memory.",
      contentMd5: "md5-a",
      version: 0,
      createdAtMs: 1,
      updatedAtMs: 1,
      baselineVersion: 0,
    }]);

    const profiles = await store.pullProfiles();
    expect(profiles).toHaveLength(1);
    expect(profiles[0].version).toBe(1);
  });
});
