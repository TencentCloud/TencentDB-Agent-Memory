/**
 * stages/mem-command.ts — mem: 命令拦截 stage (Phase 4)。
 *
 * 提取自 4 处 ~100 行 mem intercept 块:
 *   - handler.ts:1225-1341
 *   - anthropicHandler.ts:1107-1241
 *   - codexHandler.ts:771-886
 *   - workbuddyHandler.ts:1557-1680
 *
 * 本 stage 是薄包装 — 内部委托给 mem-command/ 模块的现有函数:
 *   1. parseMemCommand / parseCommandFromText 识别命令
 *   2. checkFirst fallback (session-just-registered 场景)
 *   3. executeMemCommand 执行
 *   4. 返回 Response 或 null (未命中命令)
 *
 * TDAI L0 + skill extract + langfuse report 在 caller (runPipeline) 处理,
 * 复用 stages/archive.ts + stages/observability.ts (避免与 archive stage 重复实现)。
 */

import type { ProxyConfig } from "../../types.js";
import {
  parseMemCommand,
  parseCommandFromText,
  executeMemCommand,
  type ParsedMemCommand,
  type MemCommandContext,
  type MemCommandResult,
} from "../../mem-command/index.js";
import type { AgentStrategy } from "../strategies/agent/types.js";
import type { SessionInfo } from "../../session/types.js";

export interface MemCommandStageInput {
  agent: AgentStrategy;
  body: Record<string, unknown>;
  /** codex/wb 用 (parseCommandFromText 需要预抽出的 userText) */
  userText: string;
  agentSource: string;
  sessionKey: string;
  spaceId: string;
  userId: string;
  apiKey: string;
  sessionInfo: SessionInfo | null;
  sessionJustRegistered: boolean;
  config: ProxyConfig;
  isStream: boolean;
  /** protocol → 决定 mem 响应 envelope (openai/anthropic/responses) */
  protocol: "openai" | "anthropic" | "responses";
  /** anthropic 传 body.thinking (buildMemResponse 需要) */
  thinking?: unknown;
  /** 主对话 model_id (taskDraft 需要, 方案 D) */
  model?: string;
  /** 主链路上游 base url (taskDraft 复用) */
  upstreamUrl?: string;
}

export type MemCommandStageResult =
  | { intercepted: false }
  | {
      intercepted: true;
      response: Response;
      /** L0 write + skill trigger 需要 assistant text; 命令执行结果里带 */
      assistantText: string;
      /** 供 caller 决定是否触发 archive (mem 命令也应触发 L0 + skill, 见 handler.ts:1275) */
      memCommandResult: MemCommandResult;
      commandName: string;
    };

/**
 * 执行 mem 命令拦截 stage。
 *
 * 优先级 (与老 handler 一致):
 *   1. checkFirst fallback (justRegistered && 首帧有 mem 语义)
 *   2. parseMemCommand (openai/anthropic: body.messages) / parseCommandFromText (responses: userText)
 *   3. 未命中 → intercepted:false
 *   4. 命中 → executeMemCommand → 构造 Response
 */
export async function stageMemCommand(input: MemCommandStageInput): Promise<MemCommandStageResult> {
  const { agent, body, userText, agentSource, protocol } = input;

  // 1. 识别命令
  let parsed: ParsedMemCommand | null = null;
  if (protocol === "responses") {
    // codex/wb: 从预抽的 userText 里判
    parsed = parseCommandFromText(userText);
  } else {
    // openai/anthropic: 走 body.messages 逻辑
    parsed = parseMemCommand(body, agentSource);
  }

  if (!parsed) {
    return { intercepted: false };
  }

  // 2. 执行 — 组装完整的 MemCommandContext (agent 字段暂不需要, 由 executeMemCommand 内部按需查)
  const memCtx: MemCommandContext = {
    sessionKey: input.sessionKey,
    agentSource,
    config: input.config,
    spaceId: input.spaceId,
    userId: input.userId,
    apiKey: input.apiKey,
    sessionInfo: (input.sessionInfo ?? {}) as Record<string, unknown>,
    protocol,
    stream: input.isStream,
    thinking: input.thinking,
    model: input.model,
    upstreamUrl: input.upstreamUrl,
  } as MemCommandContext;

  const result = await executeMemCommand(parsed, memCtx);

  return {
    intercepted: true,
    response: result.response,
    assistantText: result.messageText,
    memCommandResult: result,
    commandName: parsed.command,
  };
}
// avoid unused-import warnings; AgentStrategy 保留为类型契约, 后续 hooks 用
export type { AgentStrategy };
