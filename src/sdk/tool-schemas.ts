/**
 * 记忆工具 schema 常量 — 供 MCP server 注册与 HostEventBinding.getToolSchemas() 复用。
 *
 * 设计：
 *   - 两个 search schema 严格对齐 OpenClaw `index.ts` 里 registerTool 的 parameters
 *     （字段名、类型、enum、required 完全一致），保证跨宿主工具契约统一。
 *   - capture schema 对齐 Gateway CaptureRequest 的 agent 可见子集
 *     （user_content / assistant_content 必填；session_key 可选，缺省由 binding 从
 *     HostEventContext 注入；session_id / user_id / messages 为内部字段，不暴露给 Agent）。
 *   - 用 ToolSchema.parameters（OpenClaw 惯例）而非 MCP inputSchema；MCP server
 *     注册时做 { parameters } → { inputSchema } 的字段重命名（见 mcp-server.ts）。
 *   - limit 的 clamp（1~20）在工具 execute 里做（与 OpenClaw 一致），schema 不加
 *     maximum/minimum 以保持与 OpenClaw parameters 逐字对齐。
 */

import type { ToolSchema } from "./event-binding.js";

// ============================
// tdai_memory_search — L1 记忆搜索
// ============================

export const MEMORY_SEARCH_SCHEMA: ToolSchema = {
  name: "tdai_memory_search",
  description:
    "Search through the user's long-term memories. Use this when you need to recall specific information about the user's preferences, past events, instructions, or context from previous conversations. Returns relevant memory records ranked by relevance. " +
    "Limit: tdai_memory_search and tdai_conversation_search share a combined limit of 3 calls per turn. Stop searching after 3 total attempts.",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Search query describing what you want to recall about the user",
      },
      limit: {
        type: "number",
        description: "Maximum number of results to return (default: 5, max: 20)",
      },
      type: {
        type: "string",
        enum: ["persona", "episodic", "instruction"],
        description:
          "Optional filter by memory type: persona (identity/preferences), episodic (events/activities), instruction (user rules/commands)",
      },
      scene: {
        type: "string",
        description: "Optional filter by scene name",
      },
    },
    required: ["query"],
  },
};

// ============================
// tdai_conversation_search — L0 会话搜索
// ============================

export const CONVERSATION_SEARCH_SCHEMA: ToolSchema = {
  name: "tdai_conversation_search",
  description:
    "Search through past conversation history (raw dialogue records). " +
    "Use this when tdai_memory_search (structured memories) doesn't have the information you need, " +
    "or when you want to find specific past conversations, dialogue context, or exact words " +
    "the user said before. Returns relevant individual messages ranked by relevance. " +
    "Limit: tdai_memory_search and tdai_conversation_search share a combined limit of 3 calls per turn. Stop searching after 3 total attempts.",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Search query describing what conversation content you want to find",
      },
      limit: {
        type: "number",
        description: "Maximum number of messages to return (default: 5, max: 20)",
      },
      session_key: {
        type: "string",
        description: "Optional: filter results to a specific session",
      },
    },
    required: ["query"],
  },
};

// ============================
// tdai_capture — 手动捕获对话轮
// ============================

export const CAPTURE_SCHEMA: ToolSchema = {
  name: "tdai_capture",
  description:
    "Manually capture a conversation turn into long-term memory (writes an L0 record and schedules the L1/L2/L3 extraction pipeline). " +
    "Capture normally happens automatically via hooks at turn end; use this tool only when you need to explicitly persist a specific exchange. " +
    "Both user_content and assistant_content are required.",
  parameters: {
    type: "object",
    properties: {
      user_content: {
        type: "string",
        description: "The user's message text to capture",
      },
      assistant_content: {
        type: "string",
        description: "The assistant's reply text to capture",
      },
      session_key: {
        type: "string",
        description:
          "Optional session key for grouping; defaults to the current session (injected by the binding) if omitted",
      },
    },
    required: ["user_content", "assistant_content"],
  },
};

// ============================
// 聚合导出
// ============================

/** 全部记忆工具 schema，供 HostEventBinding.getToolSchemas() 直接返回。 */
export const TDAI_TOOL_SCHEMAS: readonly ToolSchema[] = [
  MEMORY_SEARCH_SCHEMA,
  CONVERSATION_SEARCH_SCHEMA,
  CAPTURE_SCHEMA,
];
