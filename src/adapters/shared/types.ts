/**
 * TdaiPlatformAdapter — 统一平台适配器接口与标准工具定义.
 *
 * 这是 TencentDB-Agent-Memory 跨平台接入的核心抽象。
 * 每个 AI Agent 平台只需实现 HostAdapter 接口（约 85行薄壳），
 * 即可获得完整的四层记忆能力（recall/capture/search/session管理）。
 *
 * 与 OpenClawHostAdapter / StandaloneHostAdapter 相同的"薄壳"模式。
 *
 * 标准工具定义 (TDAI_TOOLS) 供所有平台复用。
 */

import type {
  HostAdapter,
  RuntimeContext,
  Logger,
  LLMRunnerFactory,
} from "../../core/types.js";

// ============================
// 平台适配器构造选项
// ============================

export interface PlatformAdapterOptions {
  dataDir: string;
  logger: Logger;
  llmConfig?: {
    baseUrl?: string;
    apiKey?: string;
    model?: string;
  };
  platform?: string;
  defaultUserId?: string;
}

// ============================
// 标准工具参数定义
// ============================

export interface PlatformToolParam {
  name: string;
  type: string;
  description: string;
  required?: boolean;
  enum?: string[];
}

export interface PlatformTool {
  name: string;
  label: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, PlatformToolParam>;
    required?: string[];
  };
}

// ============================
// 标准工具定义（所有平台一致）
// ============================

export const TDAI_TOOLS: Record<string, PlatformTool> = {
  memory_search: {
    name: "tdai_memory_search",
    label: "Memory Search",
    description:
      "搜索长期记忆。使用场景：回忆用户偏好、过往事件、指令、历史上下文。" +
      "返回按相关性排序的记忆记录。",
    parameters: {
      type: "object",
      properties: {
        query: {
          name: "query",
          type: "string",
          description: "搜索查询，描述你想回忆什么",
          required: true,
        },
        limit: {
          name: "limit",
          type: "number",
          description: "最大返回数 (默认: 5, 最大: 20)",
        },
        type: {
          name: "type",
          type: "string",
          description: "可选：按记忆类型过滤",
          enum: ["persona", "episodic", "instruction"],
        },
        scene: {
          name: "scene",
          type: "string",
          description: "可选：按场景名称过滤",
        },
      },
      required: ["query"],
    },
  },

  conversation_search: {
    name: "tdai_conversation_search",
    label: "Conversation Search",
    description:
      "搜索历史对话原文。使用场景：找特定对话、用户说过的原话。" +
      "当结构化记忆搜索不够时使用。",
    parameters: {
      type: "object",
      properties: {
        query: {
          name: "query",
          type: "string",
          description: "搜索查询，描述你想找什么对话内容",
          required: true,
        },
        limit: {
          name: "limit",
          type: "number",
          description: "最大返回数 (默认: 5, 最大: 20)",
        },
        session_key: {
          name: "session_key",
          type: "string",
          description: "可选：限定到特定会话",
        },
      },
      required: ["query"],
    },
  },
};
