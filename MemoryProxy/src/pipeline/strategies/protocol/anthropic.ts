/**
 * Anthropic Messages ProtocolStrategy (Phase 2)。
 *
 * 覆盖 claude-code agent 走的协议。老代码入口: anthropicHandler.ts::handleAnthropicMessages。
 *
 * Phase 2 只填纯函数骨架, Phase 4 补齐 buildUpstreamBody (含 sanitizeThinkingBlocks)
 * / createStreamTap (含 createSseThinkingFixStream 中间件) / sanitizeForRetry 钩子。
 */

import type {
  ProtocolStrategy,
  NonStreamParseResult,
  MemResponseOpts,
  StreamOutcome,
} from "./types.js";
import type { PipelineContext } from "../../context.js";
import type { ForwardTarget } from "../../../guard-adapter.js";
import { parseAnthropicSseStream } from "./stream-parsers.js";

export const anthropicProtocol: ProtocolStrategy = {
  name: "anthropic",

  extractMessages(body): unknown[] {
    return Array.isArray(body.messages) ? body.messages as unknown[] : [];
  },

  extractUserQuery(_body, _headers): string {
    return "";
  },

  applySessionContext(body, block): void {
    // anthropic 协议: session context 追加到 body.system (原 anthropicHandler
    // 走 injection/agents/claude-code 的 apply, 详见 injection/adapters/anthropic-body.ts)。
    // Phase 4 走 injection/pipeline 时保留同样语义 —— 这里 stub 只做类型契约占位。
    if (!block) return;
    const existing = typeof body.system === "string" ? body.system : "";
    body.system = existing ? `${existing}\n${block}` : block;
  },

  applyInjection(_body, _block): void {
    // Phase 4 接入 injection/pipeline
  },

  buildUpstreamBody(body, target: ForwardTarget): unknown {
    // Phase 4: 需要 sanitizeThinkingBlocks + target.bodyOverrides 合并。
    // 当前 stub 仅做 bodyOverrides 合并 (与 handler openai 一致语义 for 非 thinking 路径)。
    if (target.bodyOverrides) {
      return { ...body, ...target.bodyOverrides };
    }
    return body;
  },

  sanitizeForRetry(body): Record<string, unknown> {
    // Phase 4: 需要真正调 sanitizeThinkingBlocks (anthropicHandler.ts:279+)。
    // 当前 stub 返回浅复制, 契约表明"anthropic 独有 retry sanitize 钩子存在"。
    return { ...body };
  },

  buildUpstreamHeaders(_clientHeaders, _effectiveKey, _target, _sessionKey): Record<string, string> {
    // Phase 4: SKIP_REQUEST_HEADERS_WITH_INTERNAL + x-api-key 而非 Bearer
    return {};
  },

  createStreamTap(_ctx: PipelineContext, _upstreamBody: ReadableStream<Uint8Array>): {
    clientStream: ReadableStream<Uint8Array>;
    outcome: Promise<StreamOutcome>;
  } {
    throw new Error("anthropicProtocol.createStreamTap not implemented yet (Phase 4)");
  },

  parseNonStreamResponse(text): NonStreamParseResult {
    try {
      const respJson = JSON.parse(text) as Record<string, unknown>;
      const usage = (respJson.usage && typeof respJson.usage === "object")
        ? respJson.usage as Record<string, unknown>
        : undefined;
      // anthropic non-stream: content 是 blocks 数组 [{type:"text",text:"..."}]
      const content = respJson.content as Array<Record<string, unknown>> | undefined;
      let assistantText: string | undefined;
      if (Array.isArray(content)) {
        assistantText = content
          .filter((b) => b.type === "text" && typeof b.text === "string")
          .map((b) => b.text as string)
          .join("");
      }
      const upstreamRequestId = typeof respJson.id === "string" ? respJson.id : undefined;
      return { usage, assistantText, upstreamRequestId };
    } catch {
      // 若上游返 SSE 而非 JSON, 走 SSE 解析兜底
      const parsed = parseAnthropicSseStream(text);
      return {
        usage: Object.keys(parsed.usage).length ? parsed.usage : undefined,
        assistantText: parsed.assistantText || undefined,
        upstreamRequestId: undefined,
      };
    }
  },

  buildMemResponse(_text, _opts: MemResponseOpts): Response {
    throw new Error("anthropicProtocol.buildMemResponse not implemented yet (Phase 4)");
  },

  buildErrorResponse(msg: string, status: number): Response {
    // Anthropic envelope: {type:"error", error: {type, message}}
    return new Response(
      JSON.stringify({
        type: "error",
        error: {
          type: status === 401 ? "authentication_error" : "invalid_request_error",
          message: msg,
        },
      }),
      { status, headers: { "content-type": "application/json" } },
    );
  },

  buildLangfuseInput(body): unknown {
    // Phase 4: 用 flattenAnthropicMessagesForOpik (anthropicHandler.ts 有)
    return { system: body.system, messages: body.messages };
  },
};
