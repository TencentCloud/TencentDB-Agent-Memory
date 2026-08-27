/**
 * mem-command 模块类型定义
 */

import type { ProxyConfig, MemCommandConfig } from "../types.js";

/**
 * 最近对话消息片段。task-draft-generator 消费。
 * 目前只需 role + content，不带 tool_calls / attachment，保持极简。
 */
export interface MemCommandMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface MemCommandContext {
  sessionKey: string;
  agentSource: string;
  config: ProxyConfig;
  spaceId: string;
  userId: string;
  apiKey: string;
  sessionInfo: Record<string, unknown>;
  protocol: "anthropic" | "openai" | "responses";
  stream: boolean;
  /** 命令参数（如 create-skill / create-task 的提示词） */
  args: string;
  /** 请求是否开启了 extended thinking（Anthropic 专用） */
  thinking?: boolean;
  /**
   * 当前请求的最近对话消息（用于 task-draft-generator 生成草稿）。
   *
   * - CC/CB 走 chat/completions：直接是 body.messages[]
   * - Codex/WorkBuddy 走 Responses API：目前传空数组（阶段 5 联调时再补 body.input 解析）
   *
   * 未提供时视为空数组，task 命令族会返 "no recent messages" 错误。
   */
  bodyMessages?: MemCommandMessage[];
}

/**
 * 已支持的 mem: 命令名 —— 强类型联合，供 index.ts 分派 / commands/* 收窄使用。
 * 未列入的字符串会被 executeMemCommand 走"未知命令"兜底。
 */
export type MemCommandName =
  | "help"
  | "sync"
  | "create-skill"
  | "create-task"
  | "update-task";

export interface MemCommandResult {
  success: boolean;
  /** 用户可读的结果文本（写入 L0 / 展示给用户） */
  messageText: string;
  /** 结构化数据（可选） */
  data?: Record<string, unknown>;
  /** 构造好的 HTTP Response（已按协议格式伪造） */
  response: Response;
}

export type { MemCommandConfig };
