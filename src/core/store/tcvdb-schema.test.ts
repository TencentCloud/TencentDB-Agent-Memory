/**
 * tz-05 Ф4b.3 — a collection created before this package has no filter index on
 * `scope` / `project_id`, and `createCollection` returns early when the
 * collection already exists, so an upgraded install silently keeps the old
 * schema. The store cannot fix that itself (TCVDB has no "add filter index"),
 * so it warns and carries on — it must NOT mark itself degraded, and reads must
 * keep working.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { request } from "undici";
import { TcvdbMemoryStore } from "./tcvdb.js";
import { startTcvdbFake, type TcvdbFake } from "./tcvdb-fake.js";

const DATABASE = "schemadb";
const L1 = `${DATABASE}_l1_memories`;

let fake: TcvdbFake;
let warnings: string[];

function makeStore(): TcvdbMemoryStore {
  warnings = [];
  return new TcvdbMemoryStore({
    url: fake.url,
    username: "u",
    apiKey: "k",
    database: DATABASE,
    embeddingModel: "m",
    timeout: 5000,
    logger: {
      info: () => {},
      warn: (m: string) => warnings.push(m),
      error: () => {},
      debug: () => {},
    },
  });
}

beforeEach(async () => {
  fake = await startTcvdbFake();
});

afterEach(async () => {
  await fake.close();
});

describe("startup schema check", () => {
  it("warns when an existing collection predates the scope indexes", async () => {
    // The pre-tz-05 schema: every filter index except scope / project_id.
    await request(`${fake.url}/collection/create`, {
      method: "POST",
      body: JSON.stringify({
        database: DATABASE,
        collection: L1,
        indexes: [
          { fieldName: "type", fieldType: "string", indexType: "filter" },
        ],
      }),
    });

    const store = makeStore();
    await store.init();

    const hit = warnings.find((w) => w.includes("no filter index"));
    expect(hit).toBeDefined();
    expect(hit).toContain("scope");
    expect(hit).toContain("project_id");
    // Advisory only: the store stays usable and unmarked.
    expect(store.isDegraded()).toBe(false);
    store.close();
  });

  it("says nothing when the collection is created with the indexes", async () => {
    const store = makeStore();
    await store.init();

    expect(warnings.filter((w) => w.includes("no filter index"))).toEqual([]);
    expect(fake.filterFields.get(L1)).toEqual(
      expect.arrayContaining(["scope", "project_id"]),
    );
    store.close();
  });
});
