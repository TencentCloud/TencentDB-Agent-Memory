/**
 * SQLite 后端的 IMetadataStore 契约测试入口。
 *
 * metadata-store.contract.ts 的用例此前没有任何 runner 引用（仓库里唯一的
 * "契约套件" 是个从未被执行的死文件），这里补上 SQLite 侧的接线，
 * `npm test` 即可运行全部 60+ 条契约用例。
 * MongoDB 侧见 mongodb-adapter.contract.test.ts（需要 TDAI_TEST_MONGODB_URI）。
 */
import type { IMetadataStore } from "./interface.js";
import { SqliteMetadataStore } from "./sqlite-adapter.js";
import { runMetadataStoreContract } from "./metadata-store.contract.js";

runMetadataStoreContract(
  "SQLite (node:sqlite, :memory:)",
  async (): Promise<IMetadataStore> => new SqliteMetadataStore(":memory:"),
  async (store) => {
    store.close();
  },
);
