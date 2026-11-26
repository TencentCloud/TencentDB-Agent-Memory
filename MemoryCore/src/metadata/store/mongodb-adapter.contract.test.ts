/**
 * MongoDB 后端的 IMetadataStore 契约测试入口。
 *
 * 需要 TDAI_TEST_MONGODB_URI（建议单节点 replica set，事务才生效）；
 * 未设置时整组跳过 —— 与 CI 无 mongo 服务的现状一致。
 */
import { describe } from "vitest";
import { MongoClient } from "mongodb";
import { MongoMetadataStore } from "./mongodb-adapter.js";
import { runMetadataStoreContract } from "./metadata-store.contract.js";

const uri = process.env.TDAI_TEST_MONGODB_URI;
const d = uri ? describe : describe.skip;

d("MongoMetadataStore contract", () => {
  let client: MongoClient;
  const dbName = `tdai_contract_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

  runMetadataStoreContract(
    `MongoDB (${dbName})`,
    async () => {
      client = new MongoClient(uri!, { ignoreUndefined: true });
      await client.connect();
      // 单节点 replica set 下 useTransactions=true 即可验证真实事务路径；
      // 若目标不是 replica set，withTx 内部会抛错，此时应显式降级为 false 再跑。
      return new MongoMetadataStore(client, dbName, { useTransactions: true });
    },
    async () => {
      if (client) {
        await client.db(dbName).dropDatabase().catch(() => {});
        await client.close();
      }
    },
  );
});
