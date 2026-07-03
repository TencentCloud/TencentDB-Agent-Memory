/**
 * TdaiPlatformAdapter — 统一平台适配器接口.
 *
 * 这是 TencentDB-Agent-Memory 跨平台接入的核心抽象.
 * 每个 AI Agent 平台只需实现此接口（约 100 行薄连接器），
 * 即可获得完整的四层记忆能力（recall/capture/search/session管理）。
 *
 * 设计原则:
 *   1. 复用项目已有的 TdaiCore + HostAdapter 架构
 *   2. 不引入新的抽象层 — TdaiCore 已经是 host-neutral 引擎
 *   3. 每个平台的适配器是"薄壳"，负责将平台事件映射到 TdaiCore 调用
 *
 * 与 PR #339 的 TdaiAdapter ABC 的区别:
 *   - PR #339: 在 Gateway HTTP API 之上再包一层抽象（HTTP wrapper 的 wrapper）
 *   - 本接口: 直接复用 TdaiCore 的 HostAdapter + 生命周期映射模式
 *     （和 OpenClawHostAdapter 一样的"薄壳"模式，已被生产验证）
 *
 * 现有实现:
 *   - OpenClawHostAdapter  (src/adapters/openclaw/)  — 117行
 *   - StandaloneHostAdapter (src/adapters/standalone/) — 97行
 *   - CCHostAdapter         (src/adapters/claude-code/) — 新增
 *   - CodeBuddyHostAdapter  (src/adapters/codebuddy/)   — 新增
 */

import type {
  HostAdapter,
  RuntimeContext,
  Logger,
  LLMRunnerFactory,
} from "../../core/types.js";

// ============================
// Platform context — what every platform must provide
// ============================

/** 平台适配器构造选项（最小公共接口） */
export interface PlatformAdapterOptions {
  /** 数据目录（TDAI 存储位置） */
  dataDir: string;
  /** 日志器 */
  logger: Logger;
  /** LLM 配置（用于 L1/L2/L3 pipeline，如果平台托管 LLM 则可为空） */
  llmConfig?: {
    baseUrl?: string;
    apiKey?: string;
    model?: string;
  };
  /** 平台标识 */
  platform?: string;
  /** 默认用户 ID */
  defaultUserId?: string;
}

// ============================
// Platform tool schema — 统一工具声明
// ============================

/** 平台工具参数定义 */
export interface PlatformToolParam {
  name: string;
  type: string;
  description: string;
  required?: boolean;
  enum?: string[];
}

/** 平台工具定义 */
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
// Platform adapter lifecycle — 平台事件映射
// ============================

/**
 * 平台生命周期钩子.
 *
 * 每个平台的适配器负责:
 *   1. 在平台事件触发时调用对应的 TdaiCore 方法
 *   2. 将平台上下文（session_id, user_id 等）转为 RuntimeContext
 *   3. 将 TdaiCore 返回结果注入到平台的正确位置
 */
export interface PlatformLifecycle {
  /** 用户发送消息前 — 执行记忆召回，注入上下文 */
  onBeforeUserMessage?(sessionKey: string, userText: string): Promise<{
    prependContext?: string;
    appendSystemContext?: string;
  }>;

  /** 助手完成回复后 — 执行对话捕获 */
  onAfterAssistantResponse?(sessionKey: string, userText: string, assistantText: string, messages?: unknown[]): Promise<{
    l0Recorded: number;
    schedulerNotified: boolean;
  }>;

  /** 会话结束时 — 刷新缓冲 */
  onSessionEnd?(sessionKey: string): Promise<void>;
}

// ============================
// TDAI 标准工具列表
// ============================

/** TDAI 平台工具定义（所有平台一致） */
export const TDAI_TOOLS: Record<string, PlatformTool> = {
  memory_search: {
    name: "tdai_memory_search",
    label: "Memory Search",
    description:
      "Search through the user's long-term memories. Use this when you need to " +
      "recall specific information about the user's preferences, past events, " +
      "instructions, or context from previous conversations. Returns relevant " +
      "memory records ranked by relevance.",
    parameters: {
      type: "object",
      properties: {
        query: {
          name: "query",
          type: "string",
          description: "Search query describing what you want to recall about the user",
          required: true,
        },
        limit: {
          name: "limit",
          type: "number",
          description: "Maximum number of results to return (default: 5, max: 20)",
        },
        type: {
          name: "type",
          type: "string",
          description: "Optional filter by memory type",
          enum: ["persona", "episodic", "instruction"],
        },
        scene: {
          name: "scene",
          type: "string",
          description: "Optional filter by scene name",
        },
      },
      required: ["query"],
    },
  },

  conversation_search: {
    name: "tdai_conversation_search",
    label: "Conversation Search",
    description:
      "Search through past conversation history (raw dialogue records). " +
      "Use this when tdai_memory_search (structured memories) doesn't have the " +
      "information you need, or when you want to find specific past conversations.",
    parameters: {
      type: "object",
      properties: {
        query: {
          name: "query",
          type: "string",
          description: "Search query describing what conversation content you want to find",
          required: true,
        },
        limit: {
          name: "limit",
          type: "number",
          description: "Maximum number of messages to return (default: 5, max: 20)",
        },
        session_key: {
          name: "session_key",
          type: "string",
          description: "Optional: filter results to a specific session",
        },
      },
      required: ["query"],
    },
  },
};
