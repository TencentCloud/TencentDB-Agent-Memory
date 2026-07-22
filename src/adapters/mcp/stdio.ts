import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMemoryMcpServer } from "./server.js";

async function main(): Promise<void> {
  const server = createMemoryMcpServer();
  await server.connect(new StdioServerTransport());
}

main().catch((error) => {
  process.stderr.write(`[memory-tencentdb][mcp] ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});