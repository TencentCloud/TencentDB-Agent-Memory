/**
 * SQLite 后端跑 IMetadataStore 契约测试套件。
 * 每个用例用一个全新的内存库，保证用例之间互不污染。
 */
import { SqliteMetadataStore } from "./sqlite-adapter.js";
import { runMetadataStoreContract } from "./metadata-store.contract.js";

runMetadataStoreContract(
  "sqlite",
  async () => new SqliteMetadataStore(":memory:"),
  async (store) => {
    await store.close();
  },
);
