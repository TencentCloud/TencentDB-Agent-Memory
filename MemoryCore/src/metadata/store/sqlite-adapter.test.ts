/**
 * SqliteMetadataStore 契约测试入口。
 *
 * 用例本体全部在 metadata-store.contract.ts（与后端无关），这里只负责为
 * SQLite 后端提供干净实例 + 清理。每个用例一个独立的 ":memory:" 库，
 * 天然隔离，无需清表。
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
