/**
 * 构造「proxy 直接返回给客户端」的 assistant 工具调用响应，三种协议：
 *
 *   anthropic : thinking(空 + 占位签名) + tool_use（Messages API，SSE / JSON）
 *   openai    : assistant.tool_calls + reasoning_content 占位（Chat Completions，SSE / JSON）
 *   responses : function_call 输出项（Responses API，SSE / JSON）
 *
 * 推理占位用于满足 DeepSeek 等「历史 assistant 必须带 thinking / reasoning_content」的
 * 上游（只查存在性），与 session-init 表单同一做法。Anthropic 原生上游开启 thinking
 * 时不会走到这里（见 isSignatureCheckedUpstream）。
 */

import type { ClientToolProtocol } from "./detect.js";

const THINKING_SIGNATURE_PLACEHOLDER =
  "UHJveHlTa2lsbExvYWRGYWtlVGhpbmtpbmdQbGFjZWhvbGRlclNpZw==";
/** OpenAI 协议 reasoning_content 占位 —— 必须非空（空串会被部分客户端丢弃，上游 400）。 */
const REASONING_PLACEHOLDER = "[proxy skill load]";

export interface ClientToolResponseInput {
  protocol: ClientToolProtocol;
  model: string;
  /** 调用 id（Anthropic tool_use.id / OpenAI tool_calls[].id / Responses call_id）。 */
  toolUseId: string;
  toolName: string;
  input: Record<string, unknown>;
  stream: boolean;
}

const SSE_HEADERS = { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" };
const JSON_HEADERS = { "content-type": "application/json" };

export function buildClientToolResponse(args: ClientToolResponseInput): Response {
  switch (args.protocol) {
    case "openai":
      return buildOpenAIChat(args);
    case "responses":
      return buildResponses(args);
    default:
      return buildAnthropic(args);
  }
}

function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      controller.close();
    },
  });
}

// ── Anthropic Messages ───────────────────────────────────────────────────────

function buildAnthropic(args: ClientToolResponseInput): Response {
  const msgId = `msg_skload_${Date.now()}`;
  const { model, toolUseId, toolName, input } = args;

  if (!args.stream) {
    return new Response(JSON.stringify({
      id: msgId,
      type: "message",
      role: "assistant",
      model,
      content: [
        { type: "thinking", thinking: "", signature: THINKING_SIGNATURE_PLACEHOLDER },
        { type: "tool_use", id: toolUseId, name: toolName, input },
      ],
      stop_reason: "tool_use",
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    }), { status: 200, headers: JSON_HEADERS });
  }

  const enc = new TextEncoder();
  const sse = (event: string, d: unknown) => enc.encode(`event: ${event}\ndata: ${JSON.stringify(d)}\n\n`);
  return new Response(streamOf([
    sse("message_start", {
      type: "message_start",
      message: {
        id: msgId, type: "message", role: "assistant", model,
        content: [], stop_reason: null, stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    }),
    sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }),
    sse("content_block_delta", {
      type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: THINKING_SIGNATURE_PLACEHOLDER },
    }),
    sse("content_block_stop", { type: "content_block_stop", index: 0 }),
    sse("content_block_start", {
      type: "content_block_start", index: 1, content_block: { type: "tool_use", id: toolUseId, name: toolName, input: {} },
    }),
    sse("content_block_delta", {
      type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) },
    }),
    sse("content_block_stop", { type: "content_block_stop", index: 1 }),
    sse("message_delta", { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 0 } }),
    sse("message_stop", { type: "message_stop" }),
  ]), { status: 200, headers: SSE_HEADERS });
}

// ── OpenAI Chat Completions ──────────────────────────────────────────────────

function buildOpenAIChat(args: ClientToolResponseInput): Response {
  const id = `chatcmpl-skload-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);
  const { model, toolUseId, toolName } = args;
  const argsStr = JSON.stringify(args.input);

  if (!args.stream) {
    return new Response(JSON.stringify({
      id, object: "chat.completion", created, model,
      choices: [{
        index: 0,
        message: {
          role: "assistant",
          content: null,
          reasoning_content: REASONING_PLACEHOLDER,
          tool_calls: [{ id: toolUseId, type: "function", function: { name: toolName, arguments: argsStr } }],
        },
        finish_reason: "tool_calls",
      }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    }), { status: 200, headers: JSON_HEADERS });
  }

  const enc = new TextEncoder();
  const chunk = (choice: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    enc.encode(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, ...choice }], ...extra })}\n\n`);
  return new Response(streamOf([
    chunk({
      delta: {
        role: "assistant",
        content: null,
        reasoning_content: REASONING_PLACEHOLDER,
        tool_calls: [{ index: 0, id: toolUseId, type: "function", function: { name: toolName, arguments: "" } }],
      },
      finish_reason: null,
    }),
    chunk({ delta: { tool_calls: [{ index: 0, function: { arguments: argsStr } }] }, finish_reason: null }),
    chunk({ delta: {}, finish_reason: "tool_calls" }, { usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } }),
    enc.encode("data: [DONE]\n\n"),
  ]), { status: 200, headers: SSE_HEADERS });
}

// ── OpenAI Responses ─────────────────────────────────────────────────────────

function buildResponses(args: ClientToolResponseInput): Response {
  const ts = Date.now();
  const responseId = `resp_skload_${ts}`;
  // Responses 规范：item.id 用 fc_ 前缀；call_id 是与 function_call_output 配对的键。
  const fcId = `fc_skload_${ts}`;
  const argsStr = JSON.stringify(args.input);
  const item = { type: "function_call", id: fcId, call_id: args.toolUseId, name: args.toolName, arguments: argsStr, status: "completed" };
  const response = {
    id: responseId, object: "response", status: "completed", model: args.model,
    output: [item], usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
  };

  if (!args.stream) {
    return new Response(JSON.stringify(response), { status: 200, headers: JSON_HEADERS });
  }

  const enc = new TextEncoder();
  // 每个 event 的 data 必须带同名 `type`，否则 codex 客户端解析不到事件类型。
  const sse = (event: string, d: Record<string, unknown>) =>
    enc.encode(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...d })}\n\n`);
  const inProgress = { ...response, status: "in_progress", output: [] };
  return new Response(streamOf([
    sse("response.created", { response: inProgress }),
    sse("response.in_progress", { response: inProgress }),
    sse("response.output_item.added", { output_index: 0, item: { ...item, arguments: "", status: "in_progress" } }),
    sse("response.function_call_arguments.delta", { output_index: 0, item_id: fcId, delta: argsStr }),
    sse("response.function_call_arguments.done", { output_index: 0, item_id: fcId, arguments: argsStr }),
    sse("response.output_item.done", { output_index: 0, item }),
    sse("response.completed", { response }),
  ]), { status: 200, headers: SSE_HEADERS });
}
