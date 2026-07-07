/**
 * HostEventBinding — Track 2 宿主侧事件绑定契约。
 *
 * Track 2 适配器（进程外宿主，如 Claude Code、Codex、Dify）通过实现这个
 * 接口把宿主事件翻译成 TdaiClient 调用。新平台接入只需：
 *   1. 实现这 4 个方法
 *   2. 选语言对应的 TdaiClient 实现（TS 用 TdaiHttpClient，Python 复用 client.py）
 *
 * 与 core/types.ts 的 HostAdapter（Track 1 引擎侧契约）的关系：
 *   - HostAdapter 是引擎消费的（getRuntimeContext / getLogger / getLLMRunnerFactory）
 *   - HostEventBinding 是宿主消费的（onUserPrompt / onTurnEnd / onSessionEnd / getToolSchemas）
 *   - 两者解耦：Track 2 宿主不碰 HostAdapter，只通过 HTTP Gateway 间接驱动 TdaiCore
 *
 * 本文件零运行时依赖、不 import core，保持 SDK 层独立可移植。
 */

// ============================
// 事件上下文
// ============================

/** 单次事件触发时由宿主侧适配器构建的上下文。 */
export interface HostEventContext {
  /**
   * 会话分组键（L0 分组用）。
   * Claude Code 用 session_id；OpenClaw 用 sessionKey；无 session_id 时回退 cwd+日期。
   */
  sessionKey: string;
  /** 宿主侧会话 ID（可选，用于日志/审计）。 */
  sessionId?: string;
  /** 用户标识。v1 默认 "default_user"，多用户场景读 TDAI_USER_ID。 */
  userId: string;
  /** 工作目录（可选，用于回退 sessionKey 与日志）。 */
  workspaceDir?: string;
}

// ============================
// 返回类型
// ============================

/** recall 注入结果。任一字段为空表示该方向不注入。 */
export interface RecallInjection {
  /** 注入到用户提示前方的上下文（置于用户消息之前）。 */
  additionalContext?: string;
  /** 追加到系统提示的上下文。 */
  systemContext?: string;
}

/** capture 确认。 */
export interface CaptureAck {
  /** L0 入库记录数（通常为 1）。 */
  l0Recorded: number;
  /** 是否已通知流水线调度器（L1/L2/L3 异步提取）。 */
  schedulerNotified: boolean;
}

// ============================
// 工具 schema
// ============================

/**
 * MCP / 工具 schema 模板。
 * 对齐 OpenClaw `tdai_memory_search` / `tdai_conversation_search` 的参数定义，
 * 使同一套 schema 可同时用于 MCP server 注册与 OpenClaw 工具声明。
 */
export interface ToolSchema {
  name: string;
  description: string;
  /** JSON Schema 形式的参数定义。 */
  parameters: Record<string, unknown>;
}

// ============================
// 宿主侧 Turn 描述
// ============================

/**
 * SDK 自包含的最小 Turn 描述。
 *
 * 不依赖 core/types.ts 的 CompletedTurn，避免 SDK 耦合核心层。
 * 宿主侧从自己的事件载荷（如 Claude Code Stop 钩子的 transcript）提取这两个字段。
 */
export interface HostCompletedTurn {
  /** 本轮用户输入文本。 */
  userText: string;
  /** 本轮助手回复文本。 */
  assistantText: string;
  /** 会话分组键（同 HostEventContext.sessionKey）。 */
  sessionKey: string;
  /** 宿主侧会话 ID（可选）。 */
  sessionId?: string;
  /** 完整消息列表（可选，供 L1 提取更多上下文）。 */
  messages?: unknown[];
}

// ============================
// HostEventBinding 契约
// ============================

/**
 * Track 2 宿主侧绑定契约。新平台接入 = 实现这 4 个方法 + 选语言对应的 TdaiClient。
 *
 * 实现方负责把宿主事件（钩子、回调、工具调用）映射到这 4 个方法，
 * 并在方法内调 TdaiClient 完成与 Gateway 的通信。
 *
 * 错误处理原则（对齐 OpenClaw / Hermes）：记忆永不阻塞对话。
 *   - onUserPrompt 失败 → 返回 null（不注入记忆）
 *   - onTurnEnd 失败 → 返回 null（不 capture）
 *   - onSessionEnd 失败 → 静默返回（不 flush）
 *   - getToolSchemas 不应抛（返回静态常量）
 */
export interface HostEventBinding {
  /** 宿主类型标识（如 "claude-code"、"codex"、"dify"）。 */
  readonly hostType: string;

  /**
   * 用户提问时触发。
   * 对应 Claude Code UserPromptSubmit、OpenClaw before_prompt_build、Hermes prefetch。
   *
   * 实现：调 client.recall()，返回记忆注入文本。失败返回 null。
   */
  onUserPrompt(
    prompt: string,
    ctx: HostEventContext,
  ): Promise<RecallInjection | null>;

  /**
   * 对话轮结束时触发。
   * 对应 Claude Code Stop、OpenClaw agent_end、Hermes sync_turn。
   *
   * 实现：调 client.capture()，返回 L0 入库确认。失败返回 null。
   */
  onTurnEnd(
    turn: HostCompletedTurn,
    ctx: HostEventContext,
  ): Promise<CaptureAck | null>;

  /**
   * 会话结束时触发。
   * 对应 Claude Code SessionEnd、OpenClaw gateway_stop、Hermes on_session_end。
   *
   * 实现：调 client.endSession()，flush 当前会话状态。失败静默返回。
   */
  onSessionEnd(ctx: HostEventContext): Promise<void>;

  /**
   * 返回此宿主暴露给 Agent 的记忆工具 schema 列表。
   * 实现：返回 tool-schemas.ts 的常量（或自定义 schema）。
   */
  getToolSchemas(): ToolSchema[];
}
