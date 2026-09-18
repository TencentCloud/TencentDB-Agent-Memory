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
  /**
   * 线程维度（`x-thread-id`）。口径与 handler 侧一致：只有
   * `sessionInit.threadIsolation.enabled === true` 时才进入 store 复合键，
   * 见 `session/store.ts::buildStoreSessionKey`。
   *
   * 命令层必须把它带进来，否则 `mem:session-reset` 会写到不带 `:thread` 后缀的键上，
   * 命中不到真实会话状态——表现为"命令回复说已重置，但下一轮不再弹表单"。
   */
  threadId?: string | null;
  agentSource: string;
  config: ProxyConfig;
  spaceId: string;
  userId: string;
  apiKey: string;
  sessionInfo: Record<string, unknown>;
  protocol: "anthropic" | "openai" | "responses";
  stream: boolean;
  /**
   * 客户端当次请求的模型名（body.model 经 resolveModelId 归一化后的真实 model_id）。
   * 方案 D：taskDraft LLM 跟随主模型，不再依赖 config.memCommand.taskDraft。
   */
  model?: string;
  /**
   * per-agent 解析后的上游 base url（不含具体 endpoint）。
   * 方案 D：taskDraft 复用主链路同一上游，规则与主链路转发一致：
   *   config.upstream.agents?.[agent]?.url ?? config.upstream.url
   */
  upstreamUrl?: string;
  /**
   * taskDraft LLM 上游 **API 协议家族**（决定请求形状，与本 ctx.protocol 语义不同）。
   *
   * ⚠️ 与 `protocol` 字段区分：
   *   - `protocol`（下方，本 ctx 已有的老字段）: **响应渲染协议** —— 决定
   *     `buildMemResponse` 用哪种 SSE 骨架把 mem 命令结果吐给客户端（跟客户端
   *     侧协议一一对应，如 anthropic/openai/responses）。
   *   - `upstreamProtocol`（本字段）: **taskDraft LLM 请求上游用哪种协议** ——
   *     决定 attemptDraftOnce 打 /v1/messages、/chat/completions 还是 /responses。
   *     取决于客户端主链路真正走的上游端点，**不一定等于响应协议**。
   *
   * 典型 case: WorkBuddy 客户端拿 Responses SSE 骨架渲染响应 (protocol="responses"),
   * 但主链路上游其实是 OpenAI chat/completions (upstreamProtocol="openai")。
   *
   * 缺省时 task-draft-generator 按 "openai" 处理。
   */
  upstreamProtocol?: "openai" | "anthropic" | "responses";
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
