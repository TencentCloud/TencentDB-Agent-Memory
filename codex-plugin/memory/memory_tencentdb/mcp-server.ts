import { runMemoryMcpServer } from "../../../src/adapters/adapter-sdk/index.js";

await runMemoryMcpServer({
  name: "tencentdb-memory",
  version: "1.0.0",
});
