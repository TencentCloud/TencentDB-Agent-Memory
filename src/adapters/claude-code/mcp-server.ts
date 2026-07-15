/**
 * mcp-server.ts — Claude Code 记忆适配器的 MCP stdio server 入口。
 *
 * 职责（设计 §2 数据流 / §6 错误处理）：
 *   - 用低层 Server API 注册 tools/list 与 tools/call 两个 handler。
 *   - tools/list 直接复用 TDAI_TOOL_SCHEMAS 的 JSON Schema（ToolSchema.parameters →
 *     MCP Tool.inputSchema），不引入 zod，避免与 tool-schemas.ts 重复定义。
 *   - tools/call 分发到 dispatchToolCall（纯逻辑，可单测），调用 TdaiClient
 *     走 HTTP Gateway 完成 search/capture。
 *   - 启动时 GatewaySupervisor.ensureAlive() 做健康探测，不阻塞失败：
 *     Gateway 不可达时 server 照常启动，工具调用自然返回错误文本（isError:true）。
 *
 * 工具契约（与 OpenClaw index.ts 对齐）：
 *   tdai_memory_search       query/limit/type/scene     → client.searchMemories
 *   tdai_conversation_search query/limit/session_key    → client.searchConversations
 *   tdai_capture             user_content/assistant_content/session_key → client.capture
 *
 * 注意：schema 用 snake_case（session_key/user_content），client 用 camelCase，
 * 分发时在 dispatchToolCall 内做转换。limit 在此 clamp 到 1~20（与 OpenClaw 一致）。
 *
 * stdio 协议要求：stdout 只能输出 MCP 消息；所有日志写 stderr。
 */

import { pathToFileURL } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";

import { TdaiHttpClient } from "../../sdk/client.js";
import type { TdaiClient } from "../../sdk/client.js";
import { TDAI_TOOL_SCHEMAS } from "../../sdk/tool-schemas.js";
import { loadClaudeCodeConfig, resolveSessionKey } from "./config.js";
import type { ClaudeCodeAdapterConfig } from "./config.js";
import { GatewaySupervisor } from "./gateway-supervisor.js";

// ============================
// 常量
// ============================

const SERVER_NAME = "memory-tdai-mcp";
const SERVER_VERSION = "0.1.0";

const TOOL_MEMORY_SEARCH = "tdai_memory_search";
const TOOL_CONVERSATION_SEARCH = "tdai_conversation_search";
const TOOL_CAPTURE = "tdai_capture";

/** limit clamp 区间，对齐 OpenClaw 工具实现（schema 不带 min/max，clamp 在 execute 做）。 */
const LIMIT_MIN = 1;
const LIMIT_MAX = 20;

// ============================
// 工具调用分发（纯逻辑，可单测）
// ============================

/**
 * 分发 tools/call 到对应工具处理器。
 *
 * 任何异常（client 抛错、参数缺失、未知工具）都转为 `{ isError: true }` 的
 * CallToolResult 返回，绝不向 MCP 框架抛出（设计 §6：记忆永不阻塞对话）。
 */
export async function dispatchToolCall(
  client: TdaiClient,
  config: ClaudeCodeAdapterConfig,
  name: string,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  try {
    switch (name) {
      case TOOL_MEMORY_SEARCH:
        return await handleMemorySearch(client, args);
      case TOOL_CONVERSATION_SEARCH:
        return await handleConversationSearch(client, args);
      case TOOL_CAPTURE:
        return await handleCapture(client, config, args);
      default:
        return errorResult(`Unknown tool: ${name}`);
    }
  } catch (err) {
    return errorResult(err instanceof Error ? err.message : String(err));
  }
}

async function handleMemorySearch(
  client: TdaiClient,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  const query = readString(args, "query");
  if (!query) return errorResult("Parameter 'query' is required");
  const resp = await client.searchMemories({
    query,
    limit: readLimit(args),
    type: readString(args, "type"),
    scene: readString(args, "scene"),
  });
  return textResult(resp.results);
}

async function handleConversationSearch(
  client: TdaiClient,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  const query = readString(args, "query");
  if (!query) return errorResult("Parameter 'query' is required");
  const resp = await client.searchConversations({
    query,
    limit: readLimit(args),
    sessionKey: readString(args, "session_key"),
  });
  return textResult(resp.results);
}

async function handleCapture(
  client: TdaiClient,
  config: ClaudeCodeAdapterConfig,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  const userContent = readString(args, "user_content");
  const assistantContent = readString(args, "assistant_content");
  if (!userContent) return errorResult("Parameter 'user_content' is required");
  if (!assistantContent) return errorResult("Parameter 'assistant_content' is required");
  // session_key 缺省 → resolveSessionKey()（cwd+date 回退，语义对齐 OpenClaw）
  const sessionKey = readString(args, "session_key") ?? resolveSessionKey();
  const resp = await client.capture(userContent, assistantContent, sessionKey, {
    userId: config.userId,
  });
  return textResult(
    JSON.stringify({
      l0_recorded: resp.l0_recorded,
      scheduler_notified: resp.scheduler_notified,
    }),
  );
}

// ============================
// helpers
// ============================

function textResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

function errorResult(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/** 读取字符串参数；非 string 或 trim 后为空 → undefined。 */
function readString(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t || undefined;
}

/** 读取 limit 并 clamp 到 [LIMIT_MIN, LIMIT_MAX]；非法值 → undefined（用默认）。 */
function readLimit(args: Record<string, unknown>): number | undefined {
  const v = args.limit;
  if (v === undefined || v === null) return undefined;
  const n = typeof v === "number" ? v : parseInt(String(v), 10);
  if (!Number.isFinite(n)) return undefined;
  return Math.max(LIMIT_MIN, Math.min(LIMIT_MAX, n));
}

// ============================
// MCP server 创建
// ============================

/**
 * 创建并配置 MCP Server（注册 tools/list 与 tools/call），不连接 transport。
 *
 * 抽出此函数便于测试：可对返回的 Server 注入 InMemoryTransport 验证 handler。
 *
 * @param client  TdaiClient（生产用 TdaiHttpClient，测试可注入 mock）
 * @param config  适配器配置（提供 userId 给 capture）
 */
export function createMcpServer(client: TdaiClient, config: ClaudeCodeAdapterConfig): Server {
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

  // tools/list — 直接复用 TDAI_TOOL_SCHEMAS 的 JSON Schema 作为 inputSchema
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TDAI_TOOL_SCHEMAS.map((s) => ({
      name: s.name,
      description: s.description,
      inputSchema: s.parameters as Tool["inputSchema"],
    })),
  }));

  // tools/call — 分发到 dispatchToolCall（永不抛，错误转 isError 结果）
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    return dispatchToolCall(client, config, name, (args ?? {}) as Record<string, unknown>);
  });

  return server;
}

// ============================
// 入口
// ============================

/**
 * 启动 MCP stdio server（生产入口）。
 *
 * 流程：loadConfig → TdaiHttpClient → GatewaySupervisor.ensureAlive()（不阻塞）
 *      → createMcpServer → StdioServerTransport.connect。
 */
export async function runMcpServer(): Promise<void> {
  const config = loadClaudeCodeConfig();
  const client = new TdaiHttpClient({
    baseUrl: config.gatewayBaseUrl,
    apiKey: config.apiKey,
  });
  const supervisor = new GatewaySupervisor({ client });

  // 启动时健康探测；失败不阻塞（设计 §6：Gateway 宕机时工具调用自然返回错误文本）
  const alive = await supervisor.ensureAlive();
  if (!alive) {
    console.error(
      `[${SERVER_NAME}] warning: gateway not reachable at ${config.gatewayBaseUrl}; ` +
        `tool calls will return errors until it recovers.`,
    );
  }

  const server = createMcpServer(client, config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// 直接运行入口（npx tsx src/adapters/claude-code/mcp-server.ts）
const isMainModule = (() => {
  try {
    return !!process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
  } catch {
    return false;
  }
})();

if (isMainModule) {
  runMcpServer().catch((err) => {
    console.error(`[${SERVER_NAME}] fatal:`, err);
    process.exit(1);
  });
}
