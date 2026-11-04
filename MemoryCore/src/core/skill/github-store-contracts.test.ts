import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { MongoMemoryServer } from "mongodb-memory-server";
import { MongoClient, Collection } from "mongodb";
import { MongoSkillStore } from "../store/mongodb/skill-store.js";
import { TcvdbSkillStore } from "../store/tcvdb/skill-store.js";
import { TcvdbClient } from "../store/tcvdb/client.js";
import type { AppendVersionInput } from "./types.js";
// Search is outside this publication contract; CRUD and unique indexes use real MongoDB.
vi.mock("../store/mongodb/search-index.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ensureSearchIndex: async () => false,
}));
const input: AppendVersionInput = {
  skill_id: "skill-test",
  team_id: "team-test",
  owner_agent_id: "agent-test",
  name: "demo",
  description: "demo",
  content: "body",
  content_hash: "hash",
  manifest: [],
  storage_dir: "skills/skill-test/v1-private",
  expected_version: 0,
};
describe("MongoDB Skill publication contract", () => {
  let mongo: MongoMemoryServer;
  let client: MongoClient;
  let store: MongoSkillStore;
  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    client = new MongoClient(mongo.getUri());
    await client.connect();
    store = new MongoSkillStore({
      mongoConfig: {} as never,
      pool: {
        getDb: async () => client.db("github_contract"),
        getClusterProfile: async () => ({ mongot: true }),
      } as never,
    });
    store.init();
  });
  afterAll(async () => {
    await client?.close();
    await mongo?.stop();
  });
  it("honors private resource directories and rejects a stale or concurrent publication", async () => {
    const first = await store.appendVersion(input);
    expect(first.storage_dir).toBe(input.storage_dir);
    await expect(store.appendVersion(input)).rejects.toMatchObject({
      code: "SKILL_VERSION_STALE",
    });
    const insert = Collection.prototype.insertOne;
    let arrivals = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(Collection.prototype, "insertOne").mockImplementation(
      async function (doc, options) {
        if (doc.skill_id === input.skill_id && doc.version === 2) {
          if (++arrivals === 2) release();
          await barrier;
        }
        return insert.call(this, doc, options);
      },
    );
    const results = await Promise.allSettled([
      store.appendVersion({
        ...input,
        expected_version: 1,
        storage_dir: "skills/skill-test/v2-writer-a",
      }),
      store.appendVersion({
        ...input,
        expected_version: 1,
        storage_dir: "skills/skill-test/v2-writer-b",
      }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find((r) => r.status === "rejected")).toMatchObject({
      reason: { code: "SKILL_VERSION_STALE" },
    });
    expect(await store.countVersions(input.skill_id, input.team_id)).toBe(2);
    expect(await store.getHead(input.skill_id, "other-team")).toBeNull();
  });
});
describe("TCVDB Skill transport contract (no cloud service)", () => {
  function fixture(headVersion: number) {
    const head = {
      id: "old-row",
      skill_id: input.skill_id,
      team_id: input.team_id,
      owner_agent_id: "agent-test",
      version: headVersion,
      is_head: 1,
      name: "demo",
      description: "demo",
      content: "body",
      content_hash: "hash",
      manifest_json: "[]",
      storage_dir: "old-dir",
      status: "active",
      metadata_json: "{}",
      created_at_ms: 1,
      updated_at_ms: 1,
    };
    vi.spyOn(TcvdbClient.prototype, "query").mockImplementation(
      async (_collection, query) => ({
        documents: String(query.filter).includes("is_head=1") ? [head] : [],
      }),
    );
    const write = vi.spyOn(TcvdbClient.prototype, "upsert").mockResolvedValue();
    const cas = vi.spyOn(TcvdbClient.prototype, "update").mockResolvedValue(1);
    const remove = vi
      .spyOn(TcvdbClient.prototype, "deleteDoc")
      .mockResolvedValue(1);
    const store = new TcvdbSkillStore({
      url: "http://unused.invalid",
      apiKey: "test",
      username: "test",
      database: "test",
      embeddingModel: "test",
      timeout: 1000,
      ulid: () => "new-row",
    });
    return { store, write, cas, remove };
  }
  it("preserves the staged directory and sends a team-scoped compare-and-swap", async () => {
    const f = fixture(1);
    const row = await f.store.appendVersion({
      ...input,
      expected_version: 1,
      storage_dir: "private-new-dir",
    });
    expect(row.storage_dir).toBe("private-new-dir");
    expect(f.cas).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        filter: expect.stringContaining('team_id="team-test"'),
      }),
    );
    expect(f.write).toHaveBeenCalledWith(expect.any(String), [
      expect.objectContaining({ storage_dir: "private-new-dir" }),
    ]);
  });
  it("does not write when the expected head is stale", async () => {
    const f = fixture(2);
    await expect(
      f.store.appendVersion({ ...input, expected_version: 1 }),
    ).rejects.toMatchObject({ code: "SKILL_VERSION_STALE" });
    expect(f.write).not.toHaveBeenCalled();
  });
  it("deletes only its own provisional row when CAS loses", async () => {
    const f = fixture(1);
    f.cas.mockResolvedValue(0);
    await expect(
      f.store.appendVersion({ ...input, expected_version: 1 }),
    ).rejects.toMatchObject({ code: "SKILL_VERSION_STALE" });
    expect(f.remove).toHaveBeenCalledWith(expect.any(String), {
      query: { documentIds: ["new-row"] },
    });
  });
});
