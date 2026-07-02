/**
 * MCP (Model Context Protocol) 类型定义。
 *
 * JSON-RPC 2.0 消息类型 + MCP 生命周期 + 工具定义。
 * 手写实现，零外部依赖。
 */

// ============================
// JSON-RPC 2.0 基础类型
// ============================

/** JSON-RPC 2.0 请求。 */
export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

/** JSON-RPC 2.0 成功响应。 */
export interface JsonRpcSuccessResponse {
  jsonrpc: "2.0";
  id: number | string;
  result: unknown;
}

/** JSON-RPC 2.0 错误响应。 */
export interface JsonRpcErrorResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}

/** JSON-RPC 2.0 响应（成功或错误）。 */
export type JsonRpcResponse = JsonRpcSuccessResponse | JsonRpcErrorResponse;

/** JSON-RPC 2.0 通知（无 id）。 */
export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
}

/** JSON-RPC 2.0 消息（请求、通知或响应）。 */
export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

// ============================
// JSON-RPC 错误码
// ============================

/** JSON-RPC 2.0 标准错误码。 */
export const ErrorCode = {
  /** 无效 JSON。 */
  PARSE_ERROR: -32700,
  /** 无效请求对象。 */
  INVALID_REQUEST: -32600,
  /** 方法不存在。 */
  METHOD_NOT_FOUND: -32601,
  /** 无效参数。 */
  INVALID_PARAMS: -32602,
  /** 内部错误。 */
  INTERNAL_ERROR: -32603,
} as const;

// ============================
// MCP 生命周期
// ============================

/** MCP 初始化请求参数。 */
export interface InitializeParams {
  protocolVersion: string;
  capabilities: Record<string, unknown>;
  clientInfo: {
    name: string;
    version: string;
  };
}

/** MCP 初始化结果。 */
export interface InitializeResult {
  protocolVersion: string;
  capabilities: {
    tools?: Record<string, unknown>;
  };
  serverInfo: {
    name: string;
    version: string;
  };
}

// ============================
// MCP 工具定义
// ============================

/** MCP 工具输入 schema（JSON Schema 格式）。 */
export interface McpToolInputSchema {
  type: "object";
  properties: Record<string, {
    type: string;
    description: string;
  }>;
  required: string[];
}

/** MCP 工具定义。 */
export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: McpToolInputSchema;
}

/** MCP tools/list 响应。 */
export interface ToolsListResult {
  tools: McpToolDefinition[];
}

/** MCP tools/call 请求参数。 */
export interface ToolsCallParams {
  name: string;
  arguments?: Record<string, unknown>;
}

/** MCP tools/call 响应。 */
export interface ToolsCallResult {
  content: Array<{
    type: "text";
    text: string;
  }>;
  isError?: boolean;
}

// ============================
// 内存工具定义
// ============================

/**
 * TDAI 记忆工具的 MCP 工具定义。
 *
 * 6 个工具：tdai_recall, tdai_capture, tdai_search_memories,
 * tdai_search_conversations, tdai_end_session, tdai_health
 */
export const TDAI_TOOLS: McpToolDefinition[] = [
  {
    name: "tdai_recall",
    description: "召回与当前查询相关的记忆上下文。在构建 LLM 提示词前调用。",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "查询文本（通常是用户的最新消息）" },
        session_key: { type: "string", description: "会话标识符" },
      },
      required: ["query", "session_key"],
    },
  },
  {
    name: "tdai_capture",
    description: "记录一次对话交互到记忆系统。在 LLM 回复完成后调用。",
    inputSchema: {
      type: "object",
      properties: {
        user_content: { type: "string", description: "用户消息内容" },
        assistant_content: { type: "string", description: "助手回复内容" },
        session_key: { type: "string", description: "会话标识符" },
        session_id: { type: "string", description: "会话 ID（可选）" },
      },
      required: ["user_content", "assistant_content", "session_key"],
    },
  },
  {
    name: "tdai_search_memories",
    description: "搜索 L1 结构化记忆（如提取的知识、偏好、指令等）。",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "搜索查询" },
        limit: { type: "number", description: "返回结果上限（默认 5）" },
        type: { type: "string", description: "记忆类型过滤（episodic/instruction/persona）" },
        scene: { type: "string", description: "场景名过滤" },
      },
      required: ["query"],
    },
  },
  {
    name: "tdai_search_conversations",
    description: "搜索 L0 原始对话记录。",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "搜索查询" },
        limit: { type: "number", description: "返回结果上限（默认 5）" },
        session_key: { type: "string", description: "限定会话（可选）" },
      },
      required: ["query"],
    },
  },
  {
    name: "tdai_end_session",
    description: "结束会话并触发缓冲数据刷新到持久层。",
    inputSchema: {
      type: "object",
      properties: {
        session_key: { type: "string", description: "要结束的会话标识符" },
      },
      required: ["session_key"],
    },
  },
  {
    name: "tdai_health",
    description: "检查记忆服务健康状态。",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
];
