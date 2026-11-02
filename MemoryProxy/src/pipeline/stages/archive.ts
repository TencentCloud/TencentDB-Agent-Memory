/**
 * stages/archive.ts — TDAI L0 write + skill extract 触发 (Phase 1)。
 *
 * 提取自:
 *   - handler.ts:1884-1888 (TDAI L0) + 1953-1966 (skill trigger)
 *   - anthropicHandler.ts:1803-1809 + 1873-1890
 *   - codexHandler.ts / workbuddyHandler.ts 内部 archiveCtx + triggerCodex/WbArchiveHooks
 *
 * 差异只在 `protocol` 参数 ("openai" / "anthropic" / "responses"), 由各 runner
 * 以字面量传入 (CC/CB → "anthropic"/"openai", codex/wb → "responses"); codex/wb
 * 的 hasAssistantContent gate 修复 (handler-audit bug B3) 也在这里统一。
 *
 * 与老 handler 100% 等价, 差别在:
 *   1. 统一使用 hasAssistantContent 判据 (wb 原来的 gate 过严)
 *   2. 统一走 isExtractionAllowed gate (以前 codex/wb 也有, 保持)
 */

import type { ProxyConfig } from "../../types.js";
import type { TdaiClient } from "../../tdai/client.js";
import type { TdaiIdentity, TdaiMessage } from "../../tdai/types.js";
import { recordTdaiTurn } from "../../tdai/recorder.js";
import { trackWrite, withL0Retry } from "../../tdai/pending-writes.js";
import { isExtractionAllowed, logExtractionSkipped } from "../../extraction-gate.js";
import { triggerSkillExtractIfReady } from "../../skill/handler-glue.js";
import type { AssetCapabilityFlags } from "../../injection/types.js";
import type { ArchiveProtocol } from "../strategies/agent/types.js";

/** 用户可见的 assistant content — 用于 skill trigger 判据 + TDAI L0 写入 */
export interface ArchiveAssistantContent {
  /** stream 累积或 non-stream 解析后的最终 assistant 文本 */
  text: string;
  /** protocol-specific 完整 assistant message 对象 (openai: {role, content, tool_calls},
   *  anthropic: {content: [...]}, responses: {type: "message", content: [...]}) —
   *  供 triggerSkillExtractIfReady 走 protocol-specific 归一化。可 null 表示无 assistant 消息。 */
  raw: Record<string, unknown> | null;
}

export interface ArchiveStageInput {
  config: ProxyConfig;
  sessionKey: string;
  agentSource: string;
  sessionInfo?: Record<string, unknown> | null;
  /** 请求侧完整 messages/input, 用于 skill trigger */
  inputMessages: unknown[];
  assistant: ArchiveAssistantContent;
  /** OpenAI / Anthropic / Responses → 影响 skill trigger 传给下游的 protocol 字段 */
  protocol: ArchiveProtocol;
  /** session-init 拿到的 asset capability flags */
  assetCapabilities?: AssetCapabilityFlags;

  /** TDAI L0 相关 (可为空: injectionSkipped / auxiliary / dsh headless 场景) */
  tdaiClient?: TdaiClient | null;
  tdaiIdentity?: TdaiIdentity;
  tdaiUserMessage?: TdaiMessage;

  /** archive-hook 短路旗标:
   *   - isAuxiliary = codex/dsh sideRequest → 完全跳过 (不写 L0, 不 trigger skill)
   *   - dshHeadless = dsh 无 ask_user_question → 同上
   *   - injectionSkipped = session-init 报错/bypass → 保留 L0 但可能跳 skill
   */
  isAuxiliary: boolean;
  dshHeadless: boolean;

  /**
   * TDAI L0 write 语义:
   *   - "sync-await" (默认): 直接 await recordTdaiTurn, 用于 non-stream 分支
   *   - "fire-and-forget-tracked": trackWrite + withL0Retry 3 次退避, 挂全局 in-flight set,
   *     SIGTERM 时 index.ts flushPendingWrites 兜底; 用于 stream 完成后调用 (不阻塞 pipe close)
   */
  tdaiWriteMode?: "sync-await" | "fire-and-forget-tracked";

  /**
   * 传给 triggerSkillExtractIfReady 的 tool_call 数覆写。
   * codex/wb stream 场景专用: stream tap 累计到 count, 用它触发轮边界判据;
   * openai/anthropic non-stream 场景传 undefined (由 skill trigger 自己数)。
   */
  toolCallCountOverride?: number;

  /**
   * warn log 前缀 (纯观测, 不影响业务); "[codex-tdai-l0]"/"[workbuddy-tdai-l0]" 等。
   * 只在 tdaiWriteMode="fire-and-forget-tracked" 时用到。
   */
  logPrefix?: string;
}

/**
 * 检查是否有实际 assistant content (统一判据, 修 handler-audit bug B3)。
 * 老 wb 用 `text 非空` 判据过严, stream 中 raw 有 tool_use 但 text 空的场景
 * 会漏归档; 现改成 "text 或 raw 里含任何 assistant 结构" 就算有。
 */
export function hasAssistantContent(assistant: ArchiveAssistantContent): boolean {
  if (assistant.text && assistant.text.length > 0) return true;
  if (assistant.raw) {
    const raw = assistant.raw;
    // openai: role/content/tool_calls; anthropic: content[]; responses: type/content
    if (raw.role || raw.content || raw.tool_calls || raw.type) return true;
  }
  return false;
}

/**
 * archive stage — TDAI L0 write + skill extract trigger 两件事。
 * 全部 fire-and-forget 语义? 不,原 handler 是 `await`, 保持一致以确保
 * SIGTERM 时 pending-writes 能等它写完 (blueprint §5.2)。
 */
export async function stageArchive(input: ArchiveStageInput): Promise<void> {
  // side-request / dsh headless: 完全跳过, 保持归档 buffer 语义纯净
  if (input.isAuxiliary || input.dshHeadless) return;

  const {
    config,
    sessionKey,
    agentSource,
    sessionInfo,
    inputMessages,
    assistant,
    protocol,
    assetCapabilities,
    tdaiClient,
    tdaiIdentity,
    tdaiUserMessage,
  } = input;

  // 1. TDAI L0 write (若 client + identity + userMessage 都齐才写)
  // codex/wb 老 archive-hook 只要求 tdaiClient + tdaiIdentity, tdaiUserMessage 可空 (会写 null message);
  // openai-chat/anthropic 老 handler 三者都要求; 这里保留"三者都齐"最保守判据。
  // TODO: 若发现 codex/wb 依赖"tdaiUserMessage null 时仍写 L0", 需要放宽此判据。
  const writeMode = input.tdaiWriteMode ?? "sync-await";
  if (tdaiClient && tdaiIdentity && tdaiUserMessage) {
    if (isExtractionAllowed(config, "tdai-memory")) {
      if (writeMode === "fire-and-forget-tracked") {
        // stream 场景: 挂全局 in-flight set, retry 3 次, catch 后 warn 不 throw
        trackWrite(
          withL0Retry(() =>
            recordTdaiTurn(tdaiClient, tdaiIdentity, tdaiUserMessage, assistant.text || null),
          ).catch((err: unknown) => {
            console.warn(
              `${input.logPrefix ?? "[archive-tdai-l0]"} failed:`,
              err instanceof Error ? err.message : String(err),
            );
          }),
        );
      } else {
        // non-stream 场景: 直接 await, 让 handler 顶端能感知失败
        await recordTdaiTurn(tdaiClient, tdaiIdentity, tdaiUserMessage, assistant.text);
      }
    } else {
      logExtractionSkipped(config, "tdai-memory", sessionKey);
    }
  }

  // 2. skill extract trigger — 无论 sync/stream 都 await, 保证跨节点下轮读到最新 buffer
  if (isExtractionAllowed(config, "skill")) {
    await triggerSkillExtractIfReady({
      config,
      sessionKey,
      agentSource,
      sessionInfo,
      inputMessages,
      assistantMessage: assistant.raw,
      protocol,
      assetCapabilities,
      toolCallCountOverride: input.toolCallCountOverride,
    });
  } else {
    logExtractionSkipped(config, "skill", sessionKey);
  }
}
