/**
 * MongoMetadataStore 契约测试入口。
 *
 * 用例本体全部在 metadata-store.contract.ts（与后端无关），这里只负责拉起一个
 * 内存 mongod 并为每个用例分配独立 database。
 *
 * 用 **单节点副本集** 而不是 standalone：MongoMetadataStore 默认 useTransactions=true，
 * 复合写入（createTeam / createTask+linkAgents / setFixedAssets）走 session.withTransaction，
 * standalone 不支持事务会直接抛错 —— 副本集才与生产默认配置一致。
 *
 * mongod 由 mongodb-memory-server 首次运行时下载并缓存（约 600MB），后续复用。
 * 服务进程在所有用例间共享（每个用例只换 database 名），避免每个用例重启 mongod。
 */
import { MongoClient } from "mongodb";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { MongoMetadataStore } from "./mongodb-adapter.js";
import { runMetadataStoreContract } from "./metadata-store.contract.js";

let replSet: MongoMemoryReplSet | null = null;
let client: MongoClient | null = null;
let dbSeq = 0;
/** 最近一次 makeStore 分配的库名 —— teardown 与 makeStore 由契约套件成对串行调用。 */
let lastDbName = "";

async function ensureClient(): Promise<MongoClient> {
  if (client) return client;
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  client = new MongoClient(replSet.getUri());
  await client.connect();
  return client;
}

runMetadataStoreContract(
  "mongodb",
  async () => {
    const c = await ensureClient();
    lastDbName = `contract_${process.pid}_${++dbSeq}`;
    return new MongoMetadataStore(c, lastDbName, { ownsClient: false });
  },
  async (store) => {
    await store.close();
    // close() 在 ownsClient=false 时是 no-op，故显式回收本用例的库。
    if (client && lastDbName) {
      await client.db(lastDbName).dropDatabase();
    }
  },
);
