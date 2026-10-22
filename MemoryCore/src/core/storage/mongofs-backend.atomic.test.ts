import { describe, expect, it } from "vitest";
import { MongoFSBackend } from "./mongo-fs-backend.js";

function matches(value: Record<string, unknown>, filter: Record<string, any>): boolean {
  return Object.entries(filter).every(([key, expected]) => {
    if (expected && typeof expected === "object" && "$exists" in expected) {
      return (value[key] !== undefined) === expected.$exists;
    }
    if (expected && typeof expected === "object" && "$ne" in expected) {
      return value[key] !== expected.$ne;
    }
    if (expected && typeof expected === "object" && "$in" in expected) {
      return expected.$in.includes(value[key]);
    }
    if (expected && typeof expected === "object" && "$lt" in expected) {
      return value[key] < expected.$lt;
    }
    return value[key] === expected;
  });
}

class FakeCollection {
  docs: Record<string, any>[] = [];
  failNextInsert = false;

  async createIndex() {}

  async dropIndex() {}

  async deleteMany(filter: Record<string, any>) {
    this.docs = this.docs.filter((doc) => !matches(doc, filter));
    return { deletedCount: 0 };
  }

  async insertMany(docs: Record<string, any>[]) {
    this.docs.push(...docs);
    if (this.failNextInsert) {
      this.failNextInsert = false;
      throw new Error("simulated chunk insert interruption");
    }
    return { insertedCount: docs.length };
  }

  async updateOne(
    filter: Record<string, any>,
    update: Record<string, any>,
    opts?: { upsert?: boolean },
  ) {
    let doc = this.docs.find((candidate) => matches(candidate, filter));
    if (!doc && opts?.upsert) {
      doc = { ...(update.$setOnInsert ?? {}), ...filter };
      this.docs.push(doc);
    }
    if (!doc) return { matchedCount: 0, modifiedCount: 0 };
    Object.assign(doc, update.$set ?? {});
    for (const [key, amount] of Object.entries(update.$inc ?? {})) {
      doc[key] = ((doc[key] as number | undefined) ?? 0) + (amount as number);
    }
    return { matchedCount: 1, modifiedCount: 1 };
  }

  async findOneAndUpdate(
    filter: Record<string, any>,
    update: Record<string, any>,
    opts?: { upsert?: boolean },
  ) {
    let doc = this.docs.find((candidate) => matches(candidate, filter));
    if (!doc && opts?.upsert) {
      doc = { ...(update.$setOnInsert ?? {}), ...filter };
      this.docs.push(doc);
    }
    if (!doc) return null;
    Object.assign(doc, update.$set ?? {});
    for (const [key, amount] of Object.entries(update.$inc ?? {})) {
      doc[key] = ((doc[key] as number | undefined) ?? 0) + (amount as number);
    }
    return doc;
  }

  async findOne(filter: Record<string, any>) {
    return this.docs.find((candidate) => matches(candidate, filter)) ?? null;
  }

  find(filter: Record<string, any>) {
    const selected = this.docs.filter((candidate) => matches(candidate, filter));
    return {
      sort: (order: { seq: number }) => ({
        toArray: async () =>
          [...selected].sort((a, b) => (a.seq - b.seq) * order.seq),
      }),
    };
  }
}

class FakeDb {
  objects = new FakeCollection();
  chunks = new FakeCollection();

  collection(name: string) {
    if (name === "fs_objects") return this.objects;
    if (name === "fs_chunks") return this.chunks;
    throw new Error(`unexpected collection ${name}`);
  }
}

describe("MongoFSBackend atomic replacement", () => {
  it("keeps the committed object when a replacement chunk write is interrupted", async () => {
    const db = new FakeDb();
    const backend = new MongoFSBackend({ db: db as any });
    await backend.putObject("state.json", "old-valid");

    db.chunks.failNextInsert = true;
    await expect(backend.putObject("state.json", "new-value")).rejects.toThrow(
      "simulated chunk insert interruption",
    );

    const current = await backend.getObject("state.json");
    expect(current?.content.toString()).toBe("old-valid");
  });

  it("continues to read legacy objects without a generation", async () => {
    const db = new FakeDb();
    db.objects.docs.push({
      _id: "legacy.json",
      size: 11,
      version: 1,
      nextSeq: 1,
      updatedAt: new Date(),
    });
    db.chunks.docs.push({
      _id: "legacy.json 0",
      key: "legacy.json",
      seq: 0,
      data: Buffer.from("legacy-data"),
      createdAt: new Date(),
    });
    const backend = new MongoFSBackend({ db: db as any });

    const current = await backend.getObject("legacy.json");
    expect(current?.content.toString()).toBe("legacy-data");
  });

  it("appends to the committed generation", async () => {
    const db = new FakeDb();
    const backend = new MongoFSBackend({ db: db as any });
    await backend.putObject("state.json", "hello");
    await backend.appendObject("state.json", "-world");

    const current = await backend.getObject("state.json");
    expect(current?.content.toString()).toBe("hello-world");
  });

  it("keeps the committed length when an append chunk write is interrupted", async () => {
    const db = new FakeDb();
    const backend = new MongoFSBackend({ db: db as any });
    await backend.putObject("state.json", "old-valid");

    db.chunks.failNextInsert = true;
    await expect(backend.appendObject("state.json", "-new")).rejects.toThrow(
      "simulated chunk insert interruption",
    );

    const current = await backend.getObject("state.json");
    expect(current?.content.toString()).toBe("old-valid");
  });
});
