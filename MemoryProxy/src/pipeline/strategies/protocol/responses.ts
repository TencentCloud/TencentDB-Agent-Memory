/**
 * OpenAI Responses ProtocolStrategy — codex + workbuddy 共用 (Phase 2)。
 *
 * 老代码入口: codexHandler.ts::handleCodexEndpoint + workbuddyHandler.ts::handleWorkbuddyEndpoint。
 *
 * Phase 2 只填纯函数骨架, Phase 4 补:
 *   - buildUpstreamBody (含 codex/wb 各自的 synthetic body 合成)
 *   - createStreamTap (tee() + coroutine, parseResponsesSseStream 增量版)
 *   - buildMemResponse (SSE form response 或 text)
 */

import type {
  ProtocolStrategy,
  NonStreamParseResult,
  MemResponseOpts,
  StreamOutcome,
} from "./types.js";
import type { PipelineContext } from "../../context.js";
import type { ForwardTarget } from "../../../guard-adapter.js";
import { parseResponsesSseStream } from "./stream-parsers.js";

export const responsesProtocol: ProtocolStrategy = {
  name: "responses",

  extractMessages(body): unknown[] {
    // Responses API: body.input 而非 body.messages
    return Array.isArray(body.input) ? body.input as unknown[] : [];
  },

  extractUserQuery(_body, _headers): string {
    return "";
  },

  applySessionContext(body, block): void {
    // Responses 协议: session context 合成到 body.input[0] (synthetic input item)
    // 详见 common/codex-injection.ts / common/workbuddy-injection.ts。
    // Phase 4 走 injection/pipeline 时统一; 这里 stub 不改 body。
    if (!block) return;
    // 保留 body 引用不变 (契约: 不引入 stub 副作用)
  },

  applyInjection(_body, _block): void {},

  buildUpstreamBody(body, target: ForwardTarget): unknown {
    if (target.bodyOverrides) {
      return { ...body, ...target.bodyOverrides };
    }
    return body;
  },

  buildUpstreamHeaders(_clientHeaders, _effectiveKey, _target, _sessionKey): Record<string, string> {
    // Phase 4: SKIP_REQUEST_HEADERS_WITH_INTERNAL + Bearer (Responses 沿用 openai auth)
    return {};
  },

  createStreamTap(_ctx: PipelineContext, _upstreamBody: ReadableStream<Uint8Array>): {
    clientStream: ReadableStream<Uint8Array>;
    outcome: Promise<StreamOutcome>;
  } {
    throw new Error("responsesProtocol.createStreamTap not implemented yet (Phase 4)");
  },

  parseNonStreamResponse(text): NonStreamParseResult {
    // Responses 通常是 stream, 但也支持非 stream (response 对象)
    try {
      const respJson = JSON.parse(text) as Record<string, unknown>;
      const usage = (respJson.usage && typeof respJson.usage === "object")
        ? respJson.usage as Record<string, unknown>
        : undefined;
      // response.output = [{type:"message",content:[{type:"output_text",text}]}, ...]
      const output = respJson.output as Array<Record<string, unknown>> | undefined;
      let assistantText: string | undefined;
      if (Array.isArray(output)) {
        const parts: string[] = [];
        for (const item of output) {
          if (item.type === "message") {
            const content = item.content as Array<Record<string, unknown>> | undefined;
            if (Array.isArray(content)) {
              for (const c of content) {
                if (c.type === "output_text" && typeof c.text === "string") {
                  parts.push(c.text);
                }
              }
            }
          }
        }
        if (parts.length > 0) assistantText = parts.join("");
      }
      const upstreamRequestId = typeof respJson.id === "string" ? respJson.id : undefined;
      return { usage, assistantText, upstreamRequestId };
    } catch {
      // 上游返 SSE 兜底
      const parsed = parseResponsesSseStream(text);
      return {
        usage: parsed.usage ?? undefined,
        assistantText: parsed.assistantText || undefined,
        upstreamRequestId: parsed.responseId ?? undefined,
      };
    }
  },

  buildMemResponse(_text: string, _opts: MemResponseOpts): Response {
    throw new Error("responsesProtocol.buildMemResponse not implemented yet (Phase 4)");
  },

  buildErrorResponse(msg: string, status: number): Response {
    // Responses envelope: {error: {type, message}}
    return new Response(
      JSON.stringify({
        error: {
          type: status === 401 ? "authentication_error" : "invalid_request_error",
          message: msg,
        },
      }),
      { status, headers: { "content-type": "application/json" } },
    );
  },

  buildLangfuseInput(body): unknown {
    // Phase 4: buildCodexLangfuseInput / buildWorkbuddyLangfuseInput
    return { input: body.input };
  },
};
