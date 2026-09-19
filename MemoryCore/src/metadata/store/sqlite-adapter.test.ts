/**
 * SQLite 版 IMetadataStore 契约测试运行器。
 *
 * 用例本体在 metadata-store.contract.ts（与后端无关）；本文件只负责以
 * `:memory:` SQLite 后端实例化 store 并驱动整套契约。MongoDB 侧对应
 * mongodb-adapter.test.ts。
 */
import { runMetadataStoreContract } from "./metadata-store.contract.js";
import { SqliteMetadataStore } from "./sqlite-adapter.js";

runMetadataStoreContract(
  "sqlite",
  async () => new SqliteMetadataStore(":memory:"),
  async (store) => {
    store.close();
  },
);
