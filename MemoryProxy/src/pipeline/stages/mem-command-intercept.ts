/**
 * stages/mem-command-intercept.ts — mem: 命令拦截 stage (main dispatcher)。
 *
 * 提取自 4 处 ~100 行 mem intercept 块 (blueprint §2.4):
 *   - openai-chat runner
 *   - anthropic runner
 *   - codex runner  (用 parseCommandFromText, 不同的 body 提取路径)
 *   - workbuddy runner (类似 codex)
 *
 * 语义: session-init 完成后, 检查 body 里有无 mem 命令 (session-reset 已被 pre-hook
 * 拦截)。命中则:
 *   1. 未初始化 (sessionInfo=null/injectionSkipped=true) → 返回"会话未初始化"错误响应
 *   2. 已初始化 → executeMemCommand + L0 write + skill extract + langfuse report + 返回响应
 * 未命中返回 null 让 caller 继续 pipeline。
 */

import type { ProxyConfig } from "../../types.js";
import type { TdaiClient } from "../../tdai/client.js";
import { recordTdaiTurn } from "../../tdai/recorder.js";
import { deriveTdaiIdentity } from "../../tdai/identity.js";
import { isExtractionAllowed } from "../../extraction-gate.js";
import { triggerSkillExtractIfReady } from "../../skill/handler-glue.js";
import { countHumanTurns } from "../../turnSeq.js";
import { langfuseTurnTraceId, langfuseReportGeneration } from "../../langfuse.js";
import type { SessionResetProtocol } from "./session-reset-pre-hook.js";
import type { AssetCapabilityFlags } from "../../injection/types.js";
import type { MemCommandMessage } from "../../mem-command/types.js";

export interface MemCommandInterceptInput {
  /** memoryTurn/isMainDialog gate — false 时短路 (不拦截) */
  enabled: boolean;
  body: Record<string, unknown>;
  agentSource: string;
  sessionKey: string;
  sessionInfo: Record<string, unknown> | null | undefined;
  /** true 时视为"会话未初始化", 返回错误响应 */
  injectionSkipped: boolean;
  /** session-init 本 turn 完成终态 → checkFirst fallback 走原始意图 */
  sessionJustRegistered: boolean;
  config: ProxyConfig;
  spaceId: string;
  userId: string;
  apiKey: string;
  callerUserKey?: string;
  isStream: boolean;
  protocol: SessionResetProtocol;
  /** 主链路 modelId (mem taskDraft 跟随主模型) */
  modelId: string;
  /** 主链路上游 URL (mem taskDraft 复用) */
  upstreamUrl: string;
  /** anthropic body.thinking */
  thinking?: boolean;
  /** codex/wb 用: 从 body.input[] 抽出的 userText → parseCommandFromText;
   *  其他 protocol 用 parseMemCommand(body) */
  userText?: string;
  /** 主对话 messages (skill extract 需要) */
  messages: unknown[];
  /** L0 write 用的 tdai client / identity 构造依赖 sessionInfo */
  createTdaiClientFn: (config: ProxyConfig, spaceId?: string) => TdaiClient | null;
  /** OpenAI/CC/CB: body.messages; codex/wb: 从 input[] 拿 message segments */
  bodyMessages: MemCommandMessage[];
  /** assistant content 结构: openai=字符串, anthropic=blocks 数组, responses=message 对象 */
  assistantContentFormat: "openai-string" | "anthropic-blocks" | "responses-message";
  /** startTime for langfuse */
  startTime: string;
  /** langfuse traceName 用 */
  keyId: string;
  /** session-init 拿到的 asset capability */
  assetCapabilities?: AssetCapabilityFlags;
  /** taskDraft LLM 上游协议 (通常 == protocol) */
  upstreamProtocol: "openai" | "anthropic" | "responses";
  /** codex/wb 有独立 lf turn ctx, 优先复用避免 inline 重算 traceId */
  langfuseCtx?: {
    traceId: string;
    userId: string;
    sessionId: string;
    tags: string[];
  };
}

/**
 * 返回 Response = 拦截并直接下发; 返回 null = 未命中 → caller 继续 pipeline。
 */
export async function stageMemCommandIntercept(
  input: MemCommandInterceptInput,
): Promise<Response | null> {
  if (!input.enabled) return null;

  const {
    body, agentSource, sessionKey, sessionInfo, injectionSkipped,
    sessionJustRegistered, config, spaceId, userId, apiKey, callerUserKey,
    isStream, protocol, modelId, upstreamUrl, thinking, userText,
    messages, createTdaiClientFn, bodyMessages,
    assistantContentFormat, startTime, keyId, assetCapabilities, upstreamProtocol,
  } = input;

  const {
    parseMemCommand, parseCommandFromText, executeMemCommand,
    buildMemResponse, truncateArgs,
  } = await import("../../mem-command/index.js");

  // 识别命令
  let memCmd: ReturnType<typeof parseMemCommand> = null;
  if (protocol === "responses" && userText !== undefined) {
    memCmd = parseCommandFromText(userText);
  } else {
    memCmd = parseMemCommand(body, agentSource);
    if (!memCmd && sessionJustRegistered) {
      memCmd = parseMemCommand(body, agentSource, { checkFirst: true });
    }
  }
  // session-reset 已在 pre-hook 处理, 跳过避免重复
  if (memCmd?.command === "session-reset") memCmd = null;
  if (!memCmd) return null;

  // 未初始化 → 错误响应
  if (!sessionInfo || injectionSkipped) {
    const errText = `⚠️ 会话未初始化，命令不可用。请先完成 session 初始化（选择 Team/Agent）后重试。`;
    console.log(`[mem-command] cmd=${memCmd.command} args="${truncateArgs(memCmd.args)}" session=${sessionKey} blocked: session not initialized`);
    return buildMemResponse(errText, {
      protocol,
      stream: isStream,
      requestId: `mem-cmd-${Date.now()}`,
      thinking,
    });
  }

  // 执行命令
  const memResult = await executeMemCommand(memCmd, {
    sessionKey,
    agentSource,
    config,
    spaceId,
    userId,
    apiKey: apiKey || "",
    sessionInfo: sessionInfo as Record<string, unknown>,
    protocol,
    stream: isStream,
    args: memCmd.args,
    thinking,
    bodyMessages,
    model: modelId,
    upstreamUrl,
    upstreamProtocol,
  });

  // L0 write (同步 await 保证落盘)
  const tdaiClientForMem = createTdaiClientFn(config, spaceId);
  const tdaiIdentityForMem = deriveTdaiIdentity({
    sessionInfo: sessionInfo as Record<string, unknown> | null | undefined,
    userId: userId || null,
    sessionKey,
    userKey: callerUserKey,
  });
  if (tdaiClientForMem && tdaiIdentityForMem && isExtractionAllowed(config, "tdai-memory")) {
    const userMsg = { role: "user" as const, content: memCmd.rawMessage };
    try {
      await recordTdaiTurn(tdaiClientForMem, tdaiIdentityForMem, userMsg, memResult.messageText);
    } catch (err: unknown) {
      if (tdaiClientForMem.requiresDurableCapture) throw err;
      console.error("[mem-command] L0 write error:", err);
    }
  }

  // Skill extract (同步 await 保证 buffer 落盘)
  if (isExtractionAllowed(config, "skill")) {
    try {
      const assistantMsg = assistantContentFormat === "anthropic-blocks"
        ? { role: "assistant", content: [{ type: "text", text: memResult.messageText }] }
        : assistantContentFormat === "responses-message"
          ? { type: "message" as const, role: "assistant" as const, content: [{ type: "output_text" as const, text: memResult.messageText }] }
          : { role: "assistant", content: memResult.messageText };
      await triggerSkillExtractIfReady({
        config,
        sessionKey,
        agentSource,
        sessionInfo: sessionInfo as Record<string, unknown>,
        inputMessages: messages,
        assistantMessage: assistantMsg,
        protocol: protocol === "responses" ? "responses" : (protocol as "openai" | "anthropic"),
        assetCapabilities,
      });
    } catch (err: unknown) {
      console.warn("[mem-command] skill extract trigger error:", err instanceof Error ? err.message : String(err));
    }
  }

  console.log(`[mem-command] cmd=${memCmd.command} args="${truncateArgs(memCmd.args)}" session=${sessionKey} success=${memResult.success}`);

  // Langfuse report — 优先复用 caller 传入的 lf ctx (codex/wb 已构造),
  // 未提供则 inline 计算 turnSeq → traceId (openai-chat / anthropic 走这条,
  // 因为它们的 mem 拦截在 lf 构造之前)。
  let lfTraceId: string;
  let lfUserId: string;
  let lfSessionId: string;
  let lfTags: string[];
  if (input.langfuseCtx) {
    lfTraceId = input.langfuseCtx.traceId;
    lfUserId = input.langfuseCtx.userId;
    lfSessionId = input.langfuseCtx.sessionId;
    lfTags = [...input.langfuseCtx.tags, "mem-command"];
  } else {
    const memTurnSeq = countHumanTurns(messages, protocol === "anthropic" ? "anthropic" : "openai");
    lfTraceId = langfuseTurnTraceId(sessionKey, memTurnSeq);
    lfUserId = keyId;
    lfSessionId = sessionKey;
    lfTags = [
      `agent_source:${agentSource}`,
      `protocol:${protocol}`,
      isStream ? "stream" : "non-stream",
      `session:${sessionKey}`,
      "mem-command",
    ];
  }
  langfuseReportGeneration({
    traceId: lfTraceId,
    name: "memory-proxy",
    model: "memory-proxy",
    startTime,
    endTime: new Date().toISOString(),
    input: memCmd.rawMessage,
    output: memResult.messageText,
    usage: { input_tokens: 0, output_tokens: 0 },
    traceName: `memory-proxy / ${keyId}`,
    userId: lfUserId,
    sessionId: lfSessionId,
    tags: lfTags,
    traceInput: memCmd.rawMessage,
    traceOutput: memResult.messageText,
  });

  return memResult.response;
}
