/**
 * Runs the subscription account contract on MongoDB. It needs a local `mongod` binary, taken from
 * MONGOMS_SYSTEM_BINARY or from PATH. Without one, the suite is skipped.
 */
import { afterAll, beforeAll, describe } from "vitest";
import { execFileSync } from "node:child_process";
import { MongoClient } from "mongodb";
import type { MongoMemoryServer } from "mongodb-memory-server";
import { MongoMetadataStore } from "./mongodb-adapter.js";
import { runSubscriptionAccountContract } from "./subscription-account.contract.js";

function findMongod(): string | null {
  if (process.env.MONGOMS_SYSTEM_BINARY) return process.env.MONGOMS_SYSTEM_BINARY;
  try {
    const found = execFileSync("which", ["mongod"], { encoding: "utf8" }).trim();
    return found || null;
  } catch {
    return null;
  }
}

const mongodPath = findMongod();

if (!mongodPath) {
  describe.skip("subscription accounts: mongodb (no mongod binary found)", () => {});
} else {
  let server: MongoMemoryServer;
  let client: MongoClient;
  let dbSeq = 0;

  beforeAll(async () => {
    process.env.MONGOMS_SYSTEM_BINARY = mongodPath;
    const { MongoMemoryServer: Server } = await import("mongodb-memory-server");
    server = await Server.create();
    client = new MongoClient(server.getUri());
    await client.connect();
  }, 120_000);

  afterAll(async () => {
    await client?.close();
    await server?.stop();
  });

  runSubscriptionAccountContract(
    "mongodb",
    async () => {
      dbSeq += 1;
      // A standalone server has no transactions, so the store runs without them.
      return new MongoMetadataStore(client, `meta_sub_account_${dbSeq}`, {
        useTransactions: false,
        ownsClient: false,
      });
    },
    async (store) => {
      await store.close();
    },
  );
}
