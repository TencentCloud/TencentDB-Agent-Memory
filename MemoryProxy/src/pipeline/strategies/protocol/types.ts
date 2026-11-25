/**
 * ProtocolStrategy — 按协议 (openai-chat / anthropic / responses / passthrough /
 * utility) 切分的策略接口。
 *
 * 6 个 handler 里协议维度差异集中在:
 *   1. body 结构 (messages vs input, system 字段位置)
 *   2. stream 解析 (SSE 事件结构不同)
 *   3. buildUpstreamBody (bodyOverrides / stream_options / sanitizeThinkingBlocks)
 *   4. buildUpstreamHeaders (Bearer vs x-api-key)
 *   5. 错误信封 (OpenAI / Anthropic / Responses)
 *   6. mem/form 响应格式
 *
 * 具体实现在 Phase 2 (v2 §4 Phase 2)。types.ts 只定义契约。
 */

import type { PipelineContext } from "../../context.js";
import type { ForwardTarget } from "../../../guard-adapter.js";

export type ProtocolName =
  | "openai-chat"
  | "anthropic"
  | "responses"
  | "passthrough"
  | "utility";

/** stream tap 的产出 (usage / assistantText / upstreamRequestId 等) */
export interface StreamOutcome {
  usage?: Record<string, unknown>;
  assistantText?: string;
  upstreamRequestId?: string;
  toolCalls?: unknown[];
}

/** 非 stream 响应解析结果 */
export interface NonStreamParseResult {
  usage?: Record<string, unknown>;
  assistantText?: string;
  upstreamRequestId?: string;
}

/** mem 命令响应生成参数 */
export interface MemResponseOpts {
  isStream: boolean;
  modelId: string;
  sessionKey: string;
}

export interface ProtocolStrategy {
  readonly name: ProtocolName;

  /** 从 raw body 提取统一的 messages 数组 (openai/anthropic: body.messages; responses: body.input) */
  extractMessages(body: Record<string, unknown>): unknown[];

  /** 从 body/headers 提取用户最后一条输入文本 */
  extractUserQuery(body: Record<string, unknown>, headers: Record<string, string>): string;

  /** 注入 session context block 到 body (不同协议位置不同) */
  applySessionContext(body: Record<string, unknown>, block: string): void;

  /** 注入资产 (skill/knowledge/memory) 到 body */
  applyInjection(body: Record<string, unknown>, block: string): void;

  /** 构造上游请求体 (bodyOverrides / stream_options / sanitizeThinkingBlocks 等协议特化) */
  buildUpstreamBody(body: Record<string, unknown>, target: ForwardTarget): unknown;

  /** 构造上游请求头 (Bearer vs x-api-key) */
  buildUpstreamHeaders(
    clientHeaders: Headers,
    effectiveKey: string,
    target: ForwardTarget,
    sessionKey: string,
  ): Record<string, string>;

  /**
   * anthropic 独有: retry body 需要二次 sanitize thinking blocks。
   * 其他协议不实现该方法。
   */
  sanitizeForRetry?(body: Record<string, unknown>): Record<string, unknown>;

  /**
   * 构造 stream tap: fork 一份流给客户端、另一份后台解析 usage/text/tools。
   *
   * ⚠️ blueprint §3.3 红线 6: 各协议的并发模型 (inline TransformStream vs
   * tee()+coroutine) 差异必须在此方法内部封装, 不暴露给 stage。
   *
   * ⚠️ addendum §4.1: CFQ 兜底路径必须在此保留 (preparedStats.cfqFallback)。
   */
  createStreamTap(ctx: PipelineContext, upstreamBody: ReadableStream<Uint8Array>): {
    clientStream: ReadableStream<Uint8Array>;
    outcome: Promise<StreamOutcome>;
  };

  /** 非 stream 响应解析 */
  parseNonStreamResponse(text: string): NonStreamParseResult;

  /** 构造 mem 命令响应 (不同协议返回格式不同) */
  buildMemResponse(text: string, opts: MemResponseOpts): Response;

  /** 构造错误响应 envelope */
  buildErrorResponse(msg: string, status: number): Response;

  /** 构造 langfuse input (不同协议的 messages 结构不同) */
  buildLangfuseInput(body: Record<string, unknown>): unknown;
}
