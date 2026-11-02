/**
 * OpenAI Chat Completions ProtocolStrategy (Phase 2)。
 *
 * 覆盖 codebuddy / dsh / opencode / pi / default agent 走的协议。
 * 老代码入口: handler.ts::handleChatCompletions。
 *
 * ⚠️ 本文件目前只填 3 类方法:
 *   1. 纯函数 (extractMessages / extractUserQuery / applyInjection)
 *   2. buildErrorResponse (openai envelope)
 *   3. 委托 stream-parsers (parseNonStreamResponse)
 *
 * 尚未填的方法 (Phase 4 组装时补):
 *   - buildUpstreamBody: 需要 target 已 resolve + prepareUpstreamRequest 逻辑
 *   - buildUpstreamHeaders: 需要 effectiveApiKey + SKIP_REQUEST_HEADERS
 *   - createStreamTap: 需要完整 ctx (lf/tdai/opik/cfq) — Phase 4 定型
 *   - buildMemResponse / buildLangfuseInput: 大量入参, Phase 4 时按需
 *
 * 所以本策略当前不完整, 尚不能被 runPipeline 直接使用; 属于 "types.ts 契约 +
 * 首批可复用纯函数集中放置" 的过渡形态。Phase 4 前会补齐所有方法。
 */

import type {
  ProtocolStrategy,
  NonStreamParseResult,
  MemResponseOpts,
  StreamOutcome,
} from "./types.js";
import type { PipelineContext } from "../../context.js";
import type { ForwardTarget } from "../../../guard-adapter.js";
import { extractOpenaiSseUsage, extractOpenaiSseAssistantText } from "./stream-parsers.js";

/** OpenAI Chat protocol strategy — Phase 2 skeleton with pure helpers. */
export const openaiChatProtocol: ProtocolStrategy = {
  name: "openai-chat",

  extractMessages(body): unknown[] {
    return Array.isArray(body.messages) ? body.messages as unknown[] : [];
  },

  extractUserQuery(_body, _headers): string {
    // 实际实现在 handler.ts 里用 resolveLatestUserQuery + resolveAgentProfile 拿最新用户输入;
    // Phase 4 组装时接入。当前 stub 返回空 —— caller 若要用, 用 stages/observability.ts
    // 里的 resolveLatestUserQuery 桥接。
    return "";
  },

  applySessionContext(body, block): void {
    // openai 协议: session context 追加到 messages[0].content 尾部
    // (原 handler 逻辑, 见 injection/agents 里的 apply 实现)。
    // Phase 4 接入 injection/pipeline 时统一走 pipeline.process, 这里保留 stub。
    const messages = Array.isArray(body.messages) ? (body.messages as Array<Record<string, unknown>>) : [];
    if (messages.length === 0 || !block) return;
    const first = messages[0];
    if (typeof first.content === "string") {
      first.content = `${first.content}\n${block}`;
    }
  },

  applyInjection(_body, _block): void {
    // Phase 4 接入 injection/pipeline (injection 已是独立模块, 不需要 protocol 定制)
  },

  buildUpstreamBody(body, target: ForwardTarget): unknown {
    // handler.ts:255 buildUpstreamBody 语义: 直接 body 或 body + target.bodyOverrides
    if (target.bodyOverrides) {
      return { ...body, ...target.bodyOverrides };
    }
    return body;
  },

  buildUpstreamHeaders(_clientHeaders, _effectiveKey, _target, _sessionKey): Record<string, string> {
    // Phase 4 组装完整版; 需要 SKIP_REQUEST_HEADERS_HOP_BY_HOP + target.authHeaders
    return {};
  },

  createStreamTap(_ctx: PipelineContext, _upstreamBody: ReadableStream<Uint8Array>): {
    clientStream: ReadableStream<Uint8Array>;
    outcome: Promise<StreamOutcome>;
  } {
    throw new Error("openaiChatProtocol.createStreamTap not implemented yet (Phase 4)");
  },

  parseNonStreamResponse(text): NonStreamParseResult {
    try {
      const respJson = JSON.parse(text) as Record<string, unknown>;
      const usage = (respJson.usage && typeof respJson.usage === "object")
        ? respJson.usage as Record<string, unknown>
        : undefined;
      const choices = respJson.choices as Array<Record<string, unknown>> | undefined;
      const first = choices?.[0];
      const message = first?.message as Record<string, unknown> | undefined;
      const assistantText = typeof message?.content === "string" ? message.content : undefined;
      const upstreamRequestId = typeof respJson.id === "string" ? respJson.id : undefined;
      return { usage, assistantText, upstreamRequestId };
    } catch {
      // 上游返非 JSON → 让 stream helper 兜底
      return {
        usage: undefined,
        assistantText: extractOpenaiSseAssistantText(text) || undefined,
        upstreamRequestId: undefined,
      };
    }
  },

  buildMemResponse(_text: string, _opts: MemResponseOpts): Response {
    throw new Error("openaiChatProtocol.buildMemResponse not implemented yet (Phase 4)");
  },

  buildErrorResponse(msg: string, status: number): Response {
    // handler.ts 里的错误 envelope: `{error: {message, type, code}}`
    // 也兼容简单 `{error: msg}` 姿势 (401 auth failed 用简单形式) — 用参数保守通用姿势
    return new Response(
      JSON.stringify({ error: { message: msg, type: "invalid_request_error" } }),
      { status, headers: { "content-type": "application/json" } },
    );
  },

  buildLangfuseInput(body): unknown {
    // 复用 handler.ts flattenMessagesForOpik 语义, Phase 4 直接 import
    return Array.isArray(body.messages) ? body.messages : [];
  },
};
