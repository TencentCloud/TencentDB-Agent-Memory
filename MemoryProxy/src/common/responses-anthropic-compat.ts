/**
 * OpenAI Responses API ↔ Anthropic Messages 双向兼容层（TRACK 05B）。
 *
 * 设计：不重复实现 Responses↔Anthropic 的直接映射，而是组合复用两套已
 * 测试的转换层：
 *
 *   Responses ↔ Chat（responses-chat-compat.ts，05B 补齐了反向）
 *   Chat ↔ Anthropic（chat-anthropic-compat.ts，TRACK 05A）
 *
 * 方向（handler 接线）：
 *   - Codex（Responses 客户端）→ Anthropic 风格上游：
 *       responsesToAnthropic + createAnthropicSseToResponsesSse + anthropicJsonToResponsesJson
 *   - Claude Code（Anthropic 客户端）→ Responses 风格上游：
 *       anthropicToResponses + createResponsesSseToAnthropicSse + responsesJsonToAnthropicJson
 *
 * 独立性约束：不 import 任何 client handler / adapter，纯函数 + TransformStream，
 * 便于单测。
 */

import {
  responsesBodyToChat,
  createChatSseToResponses,
  chatJsonToResponses,
  chatBodyToResponses,
  createResponsesSseToChatSse,
  responsesJsonToChatJson,
} from "./responses-chat-compat.js";
import {
  chatToAnthropic,
  createAnthropicSseToChatSse,
  anthropicJsonToChatJson,
  anthropicToChat,
  createChatSseToAnthropicSse,
  chatJsonToAnthropicJson,
} from "./chat-anthropic-compat.js";

export interface CompatOpts {
  model?: string;
}

// ── 请求体 ─────────────────────────────────────────────────────────────────

/** Responses 请求 → Anthropic 请求（Responses → Chat → Anthropic）。 */
export function responsesToAnthropic(
  body: Record<string, unknown>,
  opts?: CompatOpts,
): Record<string, unknown> {
  return chatToAnthropic(responsesBodyToChat(body, opts));
}

/** Anthropic 请求 → Responses 请求（Anthropic → Chat → Responses）。 */
export function anthropicToResponses(
  body: Record<string, unknown>,
  opts?: CompatOpts,
): Record<string, unknown> {
  return chatBodyToResponses(anthropicToChat(body), opts);
}

// ── 非流式 JSON 响应 ────────────────────────────────────────────────────────

/** 上游 Anthropic JSON → 客户端 Responses JSON（Anthropic → Chat → Responses）。 */
export function anthropicJsonToResponsesJson(
  json: Record<string, unknown>,
  opts?: CompatOpts,
): Record<string, unknown> {
  // 两跳转换只计一次 usage：第一跳 suppress，最终 chat→responses 一跳落统计。
  return chatJsonToResponses(
    anthropicJsonToChatJson(json, { suppressUsageStat: true }),
    opts ?? {},
  );
}

/** 上游 Responses JSON → 客户端 Anthropic JSON（Responses → Chat → Anthropic）。 */
export function responsesJsonToAnthropicJson(
  json: Record<string, unknown>,
  opts?: CompatOpts,
): Record<string, unknown> {
  // 两跳转换只计一次 usage：第一跳 suppress，最终 chat→anthropic 一跳落统计。
  return chatJsonToAnthropicJson(
    responsesJsonToChatJson(json, { ...(opts ?? {}), suppressUsageStat: true }),
  );
}

// ── 流式 SSE ───────────────────────────────────────────────────────────────

/**
 * 组合两个 TransformStream：把第一个的 readable pipe 进第二个，对外暴露一个
 * 单一 TransformStream。背压沿写入链传递；上游/客户端中断按现有转换器风格
 * 静默忽略。
 */
function composeTransforms(
  a: TransformStream<Uint8Array, Uint8Array>,
  b: TransformStream<Uint8Array, Uint8Array>,
): TransformStream<Uint8Array, Uint8Array> {
  let writer: WritableStreamDefaultWriter<Uint8Array> | undefined;
  let donePromise: Promise<void> | undefined;
  return new TransformStream<Uint8Array, Uint8Array>({
    start(controller) {
      // 目标 writable 把第二跳的最终事件同步写进外层 controller；
      // donePromise 等整条管道（a → b → dest）走完，保证 flush 前
      // 所有收尾事件（output_item.done / response.completed / message_stop
      // 等）都已送达，避免外层 readable 提前关闭丢尾帧。
      donePromise = a.readable
        .pipeThrough(b)
        .pipeTo(
          new WritableStream<Uint8Array>({
            write(chunk) {
              controller.enqueue(chunk);
            },
          }),
        )
        .catch(() => {
          /* 上游异常/客户端断开时忽略 */
        });
      writer = a.writable.getWriter();
    },
    transform(chunk) {
      if (!writer) return;
      return writer.write(chunk);
    },
    async flush() {
      if (!writer) return;
      await writer.close();
      await donePromise;
    },
  });
}

/** 上游 Anthropic SSE → 客户端 Responses SSE（Anthropic → Chat → Responses）。 */
export function createAnthropicSseToResponsesSse(
  opts?: CompatOpts,
): TransformStream<Uint8Array, Uint8Array> {
  return composeTransforms(
    createAnthropicSseToChatSse(opts),
    createChatSseToResponses(opts ?? {}),
  );
}

/** 上游 Responses SSE → 客户端 Anthropic SSE（Responses → Chat → Anthropic）。 */
export function createResponsesSseToAnthropicSse(
  opts?: CompatOpts,
): TransformStream<Uint8Array, Uint8Array> {
  return composeTransforms(
    createResponsesSseToChatSse(opts ?? {}),
    createChatSseToAnthropicSse(opts),
  );
}
