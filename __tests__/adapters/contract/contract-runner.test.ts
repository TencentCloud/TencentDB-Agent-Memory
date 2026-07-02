/**
 * 合约测试运行器 — 验证所有 MemoryPlatformAdapter 实现的行为一致性。
 *
 * 每个适配器必须通过合约套件的全部测试。
 */

import { contractSuite } from "./contract-suite.js";
import { GatewayClient } from "../../../src/adapters/shared/gateway-client.js";
import { RestMemoryAdapter } from "../../../src/adapters/rest/rest-adapter.js";
import { McpMemoryAdapter } from "../../../src/adapters/mcp/mcp-adapter.js";
import { CodexMemoryAdapter } from "../../../src/adapters/codex/codex-adapter.js";
import { ClaudeCodeMemoryAdapter } from "../../../src/adapters/claude-code/claude-code-adapter.js";
import { DifyMemoryAdapter } from "../../../src/adapters/dify/dify-adapter.js";

function createClient(): GatewayClient {
  return new GatewayClient({
    baseUrl: "http://127.0.0.1:8420",
    retry: { maxAttempts: 0 },
  });
}

contractSuite("RestMemoryAdapter", async () => new RestMemoryAdapter(createClient()));
contractSuite("McpMemoryAdapter", async () => new McpMemoryAdapter(createClient()));
contractSuite("CodexMemoryAdapter", async () => new CodexMemoryAdapter(createClient()));
contractSuite("ClaudeCodeMemoryAdapter", async () => new ClaudeCodeMemoryAdapter(createClient()));
contractSuite("DifyMemoryAdapter", async () => new DifyMemoryAdapter(createClient()));
