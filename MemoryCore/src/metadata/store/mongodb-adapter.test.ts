/**
 * MongoDB 版 IMetadataStore 契约测试运行器。
 *
 * 用例本体在 metadata-store.contract.ts（与后端无关）。MongoDB 需要真实
 * 服务端：设置 `TDAI_TEST_MONGODB_URI`（standalone 即可，契约不依赖事务）
 * 时运行，否则整组跳过 —— 保证本地 / CI 无 Mongo 时不假失败。
 */
import { describe } from "vitest";
import { MongoClient } from "mongodb";
import { runMetadataStoreContract } from "./metadata-store.contract.js";
import { MongoMetadataStore } from "./mongodb-adapter.js";

const uri = process.env.TDAI_TEST_MONGODB_URI ?? "";
const maybeDescribe = uri ? describe : describe.skip;

maybeDescribe("mongodb metadata store contract", () => {
  let dbSeq = 0;

  runMetadataStoreContract(
    "mongodb",
    async () => {
      const client = new MongoClient(uri);
      dbSeq += 1;
      const dbName = `tdai_contract_${Date.now()}_${dbSeq}`;
      return new MongoMetadataStore(client, dbName, { useTransactions: false });
    },
    async (store) => {
      await store.close();
    },
  );
});
