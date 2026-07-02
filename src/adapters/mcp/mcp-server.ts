/**
 * MCP stdio 服务器 — JSON-RPC 2.0 over stdin/stdout。
 *
 * 实现 MCP 协议的生命周期和工具调用。
 * 所有 MCP 客户端（Claude Code、Codex、Cursor、Windsurf 等）
 * 都可以通过此服务器接入记忆引擎。
 *
 * 设计原则：
 * 1. stdin 读取请求，stdout 写入响应，stderr 写入日志
 * 2. 每个请求对应一个响应（包括错误响应）
 * 3. 通知（无 id 的消息）不产生响应
 * 4. 内部使用 GatewayClient 与 Gateway 通信
 */

import { createInterface } from "node:readline";
import { GatewayClient } from "../shared/gateway-client.js";
import {
  ErrorCode,
  TDAI_TOOLS,
  type JsonRpcRequest,
  type JsonRpcErrorResponse,
  type JsonRpcSuccessResponse,
  type ToolsListResult,
  type ToolsCallParams,
  type ToolsCallResult,
  type InitializeParams,
  type InitializeResult,
} from "./mcp-types.js";

/**
 * MCP 服务器配置。
 */
export interface McpServerOptions {
  /** Gateway 基础 URL。 */
  gatewayUrl?: string;
  /** Gateway API Key。 */
  apiKey?: string;
  /** 服务器名称。 */
  name?: string;
  /** 服务器版本。 */
  version?: string;
}

// ============================
// McpServer 类
// ============================

/**
 * MCP stdio 服务器。
 *
 * 启动后阻塞在 stdin 上，逐行读取 JSON-RPC 消息，
 * 处理后将 JSON-RPC 响应写入 stdout。
 */
export class McpServer {
  private client: GatewayClient;
  private name: string;
  private version: string;
  private initialized = false;
  private running = false;

  constructor(opts: McpServerOptions = {}) {
    this.client = new GatewayClient({
      baseUrl: opts.gatewayUrl ?? "http://127.0.0.1:8420",
      apiKey: opts.apiKey,
    });
    this.name = opts.name ?? "memory-tencentdb";
    this.version = opts.version ?? "0.1.0";
  }

  /**
   * 启动 MCP 服务器。阻塞直到 stdin 关闭。
   *
   * @param input  - 可读流（默认 process.stdin）
   * @param output - 可写流（默认 process.stdout）
   */
  async start(
    input: NodeJS.ReadableStream = process.stdin,
    output: NodeJS.WritableStream = process.stdout,
  ): Promise<void> {
    this.running = true;
    this.log("MCP 服务器启动中...");

    const rl = createInterface({ input, crlfDelay: Infinity });

    for await (const line of rl) {
      if (!this.running) break;
      if (!line.trim()) continue;

      try {
        const message = JSON.parse(line) as Record<string, unknown>;

        // 通知（无 id）→ 不回复
        if (message.id == null && message.method) {
          await this.handleNotification(message);
          continue;
        }

        // 请求（有 id）→ 处理并回复
        if (message.id != null && message.method) {
          const response = await this.handleRequest(message as unknown as JsonRpcRequest);
          const responseLine = JSON.stringify(response);
          output.write(responseLine + "\n");
        }
      } catch (parseError) {
        // JSON 解析错误
        const errorResponse: JsonRpcErrorResponse = {
          jsonrpc: "2.0",
          id: null,
          error: {
            code: ErrorCode.PARSE_ERROR,
            message: `JSON 解析错误: ${(parseError as Error).message}`,
          },
        };
        output.write(JSON.stringify(errorResponse) + "\n");
      }
    }

    this.cleanup();
    this.log("MCP 服务器已关闭");
  }

  /** 停止服务器。 */
  stop(): void {
    this.running = false;
  }

  // ============================
  // 请求处理
  // ============================

  private async handleRequest(
    request: JsonRpcRequest,
  ): Promise<JsonRpcSuccessResponse | JsonRpcErrorResponse> {
    const { id, method, params } = request;

    try {
      switch (method) {
        case "initialize":
          return this.handleInitialize(id, params as unknown as InitializeParams);

        case "notifications/initialized":
          // 客户端确认初始化完成，无需回复
          this.initialized = true;
          return { jsonrpc: "2.0", id, result: {} };

        case "tools/list":
          return { jsonrpc: "2.0", id, result: this.getToolsList() };

        case "tools/call":
          return {
            jsonrpc: "2.0",
            id,
            result: await this.handleToolCall(params as unknown as ToolsCallParams),
          };

        default:
          return {
            jsonrpc: "2.0",
            id,
            error: {
              code: ErrorCode.METHOD_NOT_FOUND,
              message: `未知方法: ${method}`,
            },
          };
      }
    } catch (error) {
      const err = error as Error;
      this.log(`请求处理错误 [${method}]: ${err.message}`);
      return {
        jsonrpc: "2.0",
        id,
        error: {
          code: ErrorCode.INTERNAL_ERROR,
          message: err.message,
        },
      };
    }
  }

  /** 处理通知（fire-and-forget，不回复）。 */
  private async handleNotification(message: Record<string, unknown>): Promise<void> {
    const method = message.method as string;
    this.log(`收到通知: ${method}`);
    // 暂无需要处理的 MCP 通知
  }

  // ============================
  // MCP 生命周期
  // ============================

  private handleInitialize(
    id: number | string,
    _params?: InitializeParams,
  ): JsonRpcSuccessResponse {
    const result: InitializeResult = {
      protocolVersion: "2024-11-05",
      capabilities: {
        tools: {},
      },
      serverInfo: {
        name: this.name,
        version: this.version,
      },
    };
    return { jsonrpc: "2.0", id, result };
  }

  // ============================
  // 工具
  // ============================

  private getToolsList(): ToolsListResult {
    return { tools: TDAI_TOOLS };
  }

  /**
   * 处理工具调用。路由到对应的 Gateway API 端点。
   */
  private async handleToolCall(params: ToolsCallParams): Promise<ToolsCallResult> {
    const { name, arguments: args = {} } = params;

    switch (name) {
      case "tdai_health": {
        const h = await this.client.health();
        return {
          content: [{
            type: "text",
            text: JSON.stringify(h, null, 2),
          }],
        };
      }

      case "tdai_recall": {
        const query = String(args.query ?? "");
        const sessionKey = String(args.session_key ?? "");
        if (!query || !sessionKey) {
          return errorResult("query 和 session_key 为必填参数");
        }
        const r = await this.client.recall(query, sessionKey);
        return { content: [{ type: "text", text: r.context }] };
      }

      case "tdai_capture": {
        const userContent = String(args.user_content ?? "");
        const assistantContent = String(args.assistant_content ?? "");
        const sessionKey = String(args.session_key ?? "");
        const sessionId = args.session_id ? String(args.session_id) : undefined;
        if (!userContent || !assistantContent || !sessionKey) {
          return errorResult("user_content、assistant_content 和 session_key 为必填参数");
        }
        const r = await this.client.capture(userContent, assistantContent, sessionKey, sessionId);
        return { content: [{ type: "text", text: `已记录 ${r.l0_recorded} 条对话` }] };
      }

      case "tdai_search_memories": {
        const query = String(args.query ?? "");
        if (!query) {
          return errorResult("query 为必填参数");
        }
        const limit = args.limit != null ? Number(args.limit) : undefined;
        const type = args.type ? String(args.type) : undefined;
        const scene = args.scene ? String(args.scene) : undefined;
        const r = await this.client.searchMemories(query, limit, type, scene);
        return { content: [{ type: "text", text: r.results }] };
      }

      case "tdai_search_conversations": {
        const query = String(args.query ?? "");
        if (!query) {
          return errorResult("query 为必填参数");
        }
        const limit = args.limit != null ? Number(args.limit) : undefined;
        const sessionKey = args.session_key ? String(args.session_key) : undefined;
        const r = await this.client.searchConversations(query, limit, sessionKey);
        return { content: [{ type: "text", text: r.results }] };
      }

      case "tdai_end_session": {
        const sessionKey = String(args.session_key ?? "");
        if (!sessionKey) {
          return errorResult("session_key 为必填参数");
        }
        await this.client.endSession(sessionKey);
        return { content: [{ type: "text", text: `会话 ${sessionKey} 已结束` }] };
      }

      default:
        return errorResult(`未知工具: ${name}`);
    }
  }

  // ============================
  // 工具方法
  // ============================

  /** 暴露 GatewayClient（用于测试）。 */
  get gatewayClient(): GatewayClient {
    return this.client;
  }

  /** 是否已初始化。 */
  get isInitialized(): boolean {
    return this.initialized;
  }

  private log(message: string): void {
    process.stderr.write(`[mcp-server] ${message}\n`);
  }

  private cleanup(): void {
    this.running = false;
  }
}

/** 生成错误结果。 */
function errorResult(message: string): ToolsCallResult {
  return {
    content: [{ type: "text", text: `错误: ${message}` }],
    isError: true,
  };
}
