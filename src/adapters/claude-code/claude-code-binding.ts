/**
 * ClaudeCodeEventBinding — Claude Code 宿主侧事件绑定（Track 2 的「一个接口」实现）。
 *
 * 实现 HostEventBinding 的 4 个方法，把 Claude Code 事件翻译成 TdaiClient 调用：
 *   - onUserPrompt  → client.recall()  → <relevant-memories> 包裹注入
 *   - onTurnEnd     → client.capture() → CaptureAck（snake_case → camelCase）
 *   - onSessionEnd  → client.endSession()（静默吞错）
 *   - getToolSchemas → 返回 TDAI_TOOL_SCHEMAS 副本
 *
 * 事件 → Gateway 调用映射（设计 §2 数据流）：
 *   UserPromptSubmit → onUserPrompt → POST /recall  → additionalContext 注入
 *   Stop            → onTurnEnd    → POST /capture → L0 入库 + 流水线调度
 *   SessionEnd      → onSessionEnd → POST /session/end → flush
 *
 * 错误处理原则（设计 §6 + event-binding.ts 契约注释）：记忆永不阻塞对话。
 *   - recall / capture 失败 → 返回 null（不注入、不 capture）
 *   - endSession 失败 → 静默返回（不 flush）
 *   - getToolSchemas 不应抛（返回静态常量副本）
 *
 * 注入 TdaiClient（接口）+ ClaudeCodeAdapterConfig，便于测试用 mock client。
 * 持有接口而非具体类 → 满足「新平台只需实现一个接口」的核心承诺。
 */

import type { TdaiClient } from "../../sdk/client.js";
import type {
  HostEventBinding,
  HostEventContext,
  HostCompletedTurn,
  RecallInjection,
  CaptureAck,
  ToolSchema,
} from "../../sdk/event-binding.js";
import { TDAI_TOOL_SCHEMAS } from "../../sdk/tool-schemas.js";
import type { ClaudeCodeAdapterConfig } from "./config.js";

/**
 * recall 注入的包裹标签。
 *
 * 对齐 OpenClaw before_message_write 钩子的清洗正则（匹配
 * relevant-memories 标签块并清除，见 index.ts:628），
 * 使同一套清洗逻辑能跨宿主工作，避免历史 transcript 累积旧的召回内容。
 */
const MEMORY_BLOCK_OPEN = "<relevant-memories>";
const MEMORY_BLOCK_CLOSE = "</relevant-memories>";

export class ClaudeCodeEventBinding implements HostEventBinding {
  readonly hostType = "claude-code";

  constructor(
    private readonly client: TdaiClient,
    private readonly config: ClaudeCodeAdapterConfig,
  ) {}

  /**
   * 用户提问时触发。
   *
   * 调 client.recall()，把返回的 context 包裹进 <relevant-memories> 作为
   * additionalContext 注入到用户提示前方。context 为空 / 调用失败 → 返回 null。
   */
  async onUserPrompt(prompt: string, ctx: HostEventContext): Promise<RecallInjection | null> {
    try {
      const resp = await this.client.recall(prompt, ctx.sessionKey, this.resolveUserId(ctx));
      const context = resp.context?.trim();
      if (!context) return null;
      const additionalContext = `${MEMORY_BLOCK_OPEN}\n${context}\n${MEMORY_BLOCK_CLOSE}`;
      return { additionalContext };
    } catch {
      // 记忆永不阻塞对话：recall 失败 → 不注入
      return null;
    }
  }

  /**
   * 对话轮结束时触发。
   *
   * 调 client.capture()，把 turn 的 userText/assistantText 写入 L0 + 调度流水线。
   * sessionKey 取 turn.sessionKey（权威）；sessionId 取 turn.sessionId ?? ctx.sessionId；
   * userId 取 ctx；messages 透传 turn.messages（供 L1 提取更多上下文）。
   *
   * CaptureResponse (snake_case) → CaptureAck (camelCase) 映射。失败返回 null。
   */
  async onTurnEnd(turn: HostCompletedTurn, ctx: HostEventContext): Promise<CaptureAck | null> {
    try {
      const resp = await this.client.capture(
        turn.userText,
        turn.assistantText,
        turn.sessionKey,
        {
          sessionId: turn.sessionId ?? ctx.sessionId,
          userId: this.resolveUserId(ctx),
          messages: turn.messages,
        },
      );
      return {
        l0Recorded: resp.l0_recorded,
        schedulerNotified: resp.scheduler_notified,
      };
    } catch {
      // 记忆永不阻塞对话：capture 失败 → 不记录
      return null;
    }
  }

  /**
   * 会话结束时触发。
   *
   * 调 client.endSession() flush 当前会话状态。失败静默吞掉（设计 §6）。
   */
  async onSessionEnd(ctx: HostEventContext): Promise<void> {
    try {
      await this.client.endSession(ctx.sessionKey, this.resolveUserId(ctx));
    } catch {
      // 静默吞掉，记忆永不阻塞
    }
  }

  /**
   * 返回此宿主暴露给 Agent 的记忆工具 schema 列表。
   *
   * 返回数组副本（而非常量本身），避免调用方 mutate 污染共享常量。
   */
  getToolSchemas(): ToolSchema[] {
    return [...TDAI_TOOL_SCHEMAS];
  }

  /**
   * 解析 userId：优先 ctx.userId（trim 后非空），回退 config.userId。
   *
   * HostEventContext.userId 类型上是必填 string，但调用方（hooks/mcp-server）
   * 可能传入空串；做防御式回退到 config.userId（默认 "default_user"）。
   */
  private resolveUserId(ctx: HostEventContext): string {
    return ctx.userId?.trim() || this.config.userId;
  }
}
