import { MongoClient } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import { describe, expect, it } from "vitest";
import { SqliteMetadataStore } from "./sqlite-adapter.js";
import { MongoMetadataStore } from "./mongodb-adapter.js";
import { MetadataService } from "../service/metadata-service.js";

describe("metadata skill control access", () => {
  it("reuses the SQLite metadata database without exposing a raw handle", async () => {
    const store = new SqliteMetadataStore(":memory:");
    store.init();
    try {
      const service = new MetadataService(store, "instance-a");
      const first = await service.getSkillStateStore();
      const second = await service.getSkillStateStore();
      expect(first).toBe(second);
      expect(await first.create("operation-a", { status: "queued" })).toBe(true);
      expect(await second.read("operation-a")).toEqual({ revision: 1, value: { status: "queued" } });
    } finally { store.close(); }
  });

  it("uses Mongo single-document control even when metadata composite transactions are disabled", async () => {
    const server = await MongoMemoryServer.create();
    const client = await MongoClient.connect(server.getUri());
    const store = new MongoMetadataStore(client, "skill_control_access", { useTransactions: false });
    try {
      const service = new MetadataService(store, "instance-a");
      const state = await service.getSkillStateStore();
      expect(await state.create("operation-a", { state: "queued" })).toBe(true);
      expect(await state.compareAndSet("operation-a", 1, { state: "running" })).toBe(true);
      const again = new MetadataService(new MongoMetadataStore(client, "skill_control_access", { useTransactions: false, ownsClient: false }), "instance-a");
      expect(await (await again.getSkillStateStore()).read("operation-a")).toEqual({ revision: 2, value: { state: "running" } });
    } finally { await store.close(); await server.stop(); }
  });
});
