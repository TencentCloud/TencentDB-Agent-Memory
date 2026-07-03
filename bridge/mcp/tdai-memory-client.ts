/**
 * TdaiMcpClient --- TypeScript MemoryAdapter via MCP stdio transport.
 *
 * Implements the `MemoryAdapter` interface by calling the Python
 * bridge/mcp/server.py through MCP stdio protocol.
 *
 * No duplicate server logic: all 5 tools (health/recall/capture/search)
 * and 4 gates (auth/rate-limit/circuit-breaker/audit) live in Python.
 * TS side is a thin ~20-line MCP client.
 *
 * Usage:
 *   import { TdaiMcpClient } from "./tdai-memory-client";
 *   const adapter = new TdaiMcpClient();
 *   adapter.initialize();
 *   const ctx = adapter.recall("user preference");
 *
 * Dependencies:
 *   npm install @modelcontextprotocol/sdk
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export interface TdaiMcpConfig {
  python?: string;       // Python executable (default: "python")
  serverModule?: string; // MCP server module (default: "bridge.mcp.server")
  apiKey?: string;       // MCP_BRIDGE_API_KEY (optional for loopback)
}

export class TdaiMcpClient {
  private transport: StdioClientTransport | null = null;

  constructor(private config: TdaiMcpConfig = {}) {}

  initialize(): void {
    const env: Record<string, string> = {};
    if (this.config.apiKey) {
      env.MCP_BRIDGE_API_KEY = this.config.apiKey;
    }
    this.transport = new StdioClientTransport({
      command: this.config.python ?? "python",
      args: ["-m", this.config.serverModule ?? "bridge.mcp.server"],
      env: Object.keys(env).length > 0 ? env : undefined,
    });
  }

  private async _call<T>(tool: string, args: Record<string, unknown>): Promise<T> {
    if (!this.transport) throw new Error("Not initialized");
    const client = new Client({ name: "bridge-ts-mcp-client" });
    await client.connect(this.transport);
    const result = await client.request(
      { method: "tools/call", params: { name: tool, arguments: args } },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      {} as any,
    );
    return JSON.parse((result as { content: Array<{ text: string }> }).content[0].text) as T;
  }

  async mcpHealth(): Promise<{ available: boolean }> {
    return this._call("tdai_health", {});
  }

  async recall(query: string, limit?: number): Promise<{ prependContext: string; appendSystemContext: string }> {
    return this._call("tdai_recall", { query, limit });
  }

  async capture(userContent: string, assistantContent: string, sessionId?: string): Promise<{ success: boolean }> {
    return this._call("tdai_capture", { user_content: userContent, assistant_content: assistantContent, session_id: sessionId });
  }

  async searchMemory(query: string, limit?: number): Promise<Array<Record<string, unknown>>> {
    return this._call("tdai_memory_search", { query, limit });
  }

  async searchConversation(query: string, limit?: number): Promise<Array<Record<string, unknown>>> {
    return this._call("tdai_conversation_search", { query, limit });
  }

  shutdown(): void {
    if (this.transport) {
      void this.transport.close();
      this.transport = null;
    }
  }
}
