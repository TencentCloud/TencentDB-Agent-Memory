// Task 3: Trae MCP server - JSON-RPC over stdio, 5 tools calling TdaiBridge
// ponytail: 手写 JSON-RPC 2.0，不引 @modelcontextprotocol/sdk（供应链安全，参照 #372）
import type { TdaiBridge } from "../tdai-bridge/tdai-bridge.js";
import type { GatewayClient } from "../tdai-bridge/tdai-bridge.js";
import { TdaiBridge as TdaiBridgeImpl } from "../tdai-bridge/tdai-bridge.js";
import * as readline from "node:readline";

interface JsonRpcReq {
  jsonrpc: string;
  id?: unknown;
  method: string;
  params?: any;
}

interface JsonRpcRes {
  jsonrpc: "2.0";
  id?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

interface Tool {
  name: string;
  inputSchema: {
    type: "object";
    properties: Record<string, { type: string }>;
    additionalProperties: boolean;
    required?: string[];
  };
}

// 5 个工具的 closed schema 定义
const TOOLS: Tool[] = [
  {
    name: "tdai_recall",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        session_key: { type: "string" },
      },
      additionalProperties: false,
      required: ["query", "session_key"],
    },
  },
  {
    name: "tdai_capture",
    inputSchema: {
      type: "object",
      properties: {
        user_content: { type: "string" },
        assistant_content: { type: "string" },
        session_key: { type: "string" },
      },
      additionalProperties: false,
      required: ["user_content", "assistant_content", "session_key"],
    },
  },
  {
    name: "tdai_memory_search",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "number" },
      },
      additionalProperties: false,
      required: ["query"],
    },
  },
  {
    name: "tdai_conversation_search",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "number" },
      },
      additionalProperties: false,
      required: ["query"],
    },
  },
  {
    name: "tdai_session_end",
    inputSchema: {
      type: "object",
      properties: {
        session_key: { type: "string" },
      },
      additionalProperties: false,
      required: ["session_key"],
    },
  },
];

export class TraeMcpServer {
  constructor(private readonly bridge: TdaiBridge) {}

  async handle(req: JsonRpcReq): Promise<JsonRpcRes | undefined> {
    const id = req.id;

    if (req.method === "initialize") {
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          serverInfo: {
            name: "tdai-trae",
            version: "0.1.0",
          },
        },
      };
    }

    if (req.method === "tools/list") {
      return {
        jsonrpc: "2.0",
        id,
        result: {
          tools: TOOLS,
        },
      };
    }

    if (req.method === "tools/call") {
      const { name, arguments: args } = req.params ?? {};

      // ponytail: 运行时强校验（参照 #372，schema 声明 + 运行时双保险）
      const tool = TOOLS.find((t) => t.name === name);
      if (tool && args) {
        const allowedKeys = new Set(Object.keys(tool.inputSchema.properties));
        const actualKeys = new Set(Object.keys(args));
        for (const key of actualKeys) {
          if (!allowedKeys.has(key)) {
            return {
              jsonrpc: "2.0",
              id,
              error: {
                code: -32602,
                message: `Invalid params: unknown field '${key}' for tool '${name}'`,
              },
            };
          }
        }
      }

      try {
        let data: unknown;

        switch (name) {
          case "tdai_recall":
            data = await this.bridge.recall(args.query, args.session_key);
            break;
          case "tdai_capture":
            data = await this.bridge.capture(
              { userText: args.user_content, assistantText: args.assistant_content },
              args.session_key
            );
            break;
          case "tdai_memory_search":
            data = await this.bridge.searchMemory(args.query, { limit: args.limit });
            break;
          case "tdai_conversation_search":
            data = await this.bridge.searchConversation(args.query, { limit: args.limit });
            break;
          case "tdai_session_end":
            await this.bridge.endSession(args.session_key);
            data = { ok: true };
            break;
          default:
            return {
              jsonrpc: "2.0",
              id,
              error: { code: -32601, message: `unknown tool: ${name}` },
            };
        }

        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: JSON.stringify(data) }],
          },
        };
      } catch (e) {
        return {
          jsonrpc: "2.0",
          id,
          error: { code: -32000, message: (e as Error).message },
        };
      }
    }

    return {
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `method not found: ${req.method}` },
    };
  }
}

// === 最小 fetch-based GatewayClient ===
// ponytail: 实现 TdaiBridge 的 GatewayClient 接口，使用 plain fetch
// 范注：这是 Task 1 本地接口的生产注入，临时实现直到 PR #316 合并
// PR #316 的 GatewayMemoryClient 与此结构兼容，可直接替换
class FetchGatewayClient implements GatewayClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly timeoutMs: number = 10000
  ) {}

  private async fetchEndpoint<T>(path: string, body: unknown): Promise<T> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const responseBody = await response.text();
        const error = new Error(`HTTP ${response.status}: ${response.statusText}`);
        (error as any).status = response.status;
        (error as any).responseBody = responseBody;
        throw error;
      }

      return (await response.json()) as T;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async recall(body: { query: string; session_key: string }): Promise<{ context: string }> {
    return this.fetchEndpoint<{ context: string }>("/recall", body);
  }

  async capture(body: {
    user_text: string;
    assistant_text: string;
    session_key: string;
  }): Promise<unknown> {
    return this.fetchEndpoint("/capture", body);
  }

  async searchMemories(body: { query: string; limit: number }): Promise<unknown> {
    return this.fetchEndpoint("/search/memories", body);
  }

  async searchConversations(body: { query: string; limit: number }): Promise<unknown> {
    return this.fetchEndpoint("/search/conversations", body);
  }

  async endSession(body: { session_key: string }): Promise<unknown> {
    return this.fetchEndpoint("/session/end", body);
  }
}

// === stdio 入口点 ===
export async function runStdioTraeMcp(): Promise<void> {
  const client = new FetchGatewayClient(
    requireEnv("TDAI_GATEWAY_URL"),
    requireEnv("TDAI_GATEWAY_API_KEY"),
    Number(process.env.TDAI_GATEWAY_TIMEOUT_MS ?? 10000)
  );

  const bridge = new TdaiBridgeImpl(client);
  const server = new TraeMcpServer(bridge);
  const rl = readline.createInterface({ input: process.stdin });

  // ponytail: parse error → 跳过单帧，不崩 server
  for await (const line of rl) {
    try {
      const req = JSON.parse(line);
      const res = await server.handle(req);
      if (res) {
        process.stdout.write(JSON.stringify(res) + "\n");
      }
    } catch (e) {
      // ponytail: 静默跳过解析错误，保持 stdio 稳定性
      console.error("[mcp-server] frame error:", (e as Error).message);
    }
  }
}

function requireEnv(k: string): string {
  const v = process.env[k];
  if (!v) throw new Error(`missing env var: ${k}`);
  return v;
}
