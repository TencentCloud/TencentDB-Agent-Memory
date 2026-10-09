/**
 * Passthrough ProtocolStrategy (Phase 4) — /direct/* 纯透传。
 *
 * 老代码入口: directHandler.ts::handleDirectPassthrough。
 * 无 auth / injection / mem 命令 / session-init / model gate。
 * 只做 URL rewrite + header 剥离 + fetch + response 直返。
 *
 * 大部分 ProtocolStrategy 方法都不适用 —— 保留 throw 以便 caller 早发现误用。
 */

import type {
  ProtocolStrategy,
  NonStreamParseResult,
  MemResponseOpts,
  StreamOutcome,
} from "./types.js";
import type { PipelineContext } from "../../context.js";

const NOT_APPLICABLE = "passthrough protocol does not implement this method";

export const passthroughProtocol: ProtocolStrategy = {
  name: "passthrough",
  extractMessages(): unknown[] { return []; },
  extractUserQuery(): string { return ""; },
  applySessionContext(): void { /* noop */ },
  applyInjection(): void { /* noop */ },
  buildUpstreamBody(body): unknown { return body; },
  buildUpstreamHeaders(): Record<string, string> { return {}; },
  createStreamTap(_ctx: PipelineContext, upstreamBody: ReadableStream<Uint8Array>): {
    clientStream: ReadableStream<Uint8Array>;
    outcome: Promise<StreamOutcome>;
  } {
    // passthrough — 客户端流 = 上游流 (无 tap)
    return {
      clientStream: upstreamBody,
      outcome: Promise.resolve({}),
    };
  },
  parseNonStreamResponse(): NonStreamParseResult { return {}; },
  buildMemResponse(_text: string, _opts: MemResponseOpts): Response {
    throw new Error(NOT_APPLICABLE);
  },
  buildErrorResponse(msg, status): Response {
    return new Response(JSON.stringify({ error: msg }), {
      status,
      headers: { "content-type": "application/json" },
    });
  },
  buildLangfuseInput(): unknown { return null; },
};
