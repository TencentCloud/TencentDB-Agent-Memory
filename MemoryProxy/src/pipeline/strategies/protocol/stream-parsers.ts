/**
 * 纯 SSE 解析函数, 按协议提取 usage / assistant text / tool_call 意图。
 *
 * 提取自 3 个 handler 的 stream tap 内部逻辑, 抽成纯函数便于:
 *   1. Phase 2 fixture 测试 (blueprint-review §3 硬门槛)
 *   2. Phase 4 组装 protocol.createStreamTap 时被 tap coroutine 复用
 *
 * ⚠️ 与老 handler 的差别: 老实现是流式增量累积 (维护 state),
 * 这里的函数是"整段 SSE 文本一次性解析", 用于:
 *   - fixture 测试 (输入完整 SSE 文本, 断言最终 usage / assistantText)
 *   - non-stream fallback (upstream 返 stream 但客户端非 stream 场景)
 *
 * 增量版本 (为 createStreamTap 用) Phase 4 再抽; 现在先把语义固定下来。
 */

// ── OpenAI Chat Completions ──────────────────────────────────────────────

/**
 * 从整段 openai SSE 文本提取 usage (取 last-write-wins)。
 * 复用 handler.ts:228 extractSseUsage 语义。
 */
export function extractOpenaiSseUsage(sseText: string): Record<string, unknown> | null {
  let lastUsage: Record<string, unknown> | null = null;
  for (const line of sseText.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const dataStr = trimmed.slice(5).trim();
    if (!dataStr || dataStr === "[DONE]") continue;
    try {
      const evt = JSON.parse(dataStr) as Record<string, unknown>;
      if (evt.usage && typeof evt.usage === "object") {
        lastUsage = evt.usage as Record<string, unknown>;
      }
    } catch {
      // ignore malformed line
    }
  }
  return lastUsage;
}

/**
 * 从整段 openai SSE 文本累积 assistant text (choices[0].delta.content)。
 */
export function extractOpenaiSseAssistantText(sseText: string): string {
  let text = "";
  for (const line of sseText.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const dataStr = trimmed.slice(5).trim();
    if (!dataStr || dataStr === "[DONE]") continue;
    try {
      const evt = JSON.parse(dataStr) as Record<string, unknown>;
      const choices = evt.choices as Array<Record<string, unknown>> | undefined;
      if (!Array.isArray(choices) || choices.length === 0) continue;
      const delta = choices[0]?.delta as Record<string, unknown> | undefined;
      if (delta && typeof delta.content === "string") {
        text += delta.content;
      }
    } catch {
      // ignore
    }
  }
  return text;
}

// ── Anthropic Messages ──────────────────────────────────────────────────

export interface AnthropicStreamParsed {
  usage: Record<string, unknown>;
  assistantText: string;
  /** tool_use 块的累积 (供 emitModelIntentTelemetry 用) */
  toolUses: Array<{ name: string; inputJson: string }>;
}

/**
 * 解析 Anthropic SSE (event: xxx\ndata: {...}\n\n), 一次性提取 usage / text / tool_uses。
 * 复用 anthropicHandler.ts:2400+ 的 event switch。
 */
export function parseAnthropicSseStream(sseText: string): AnthropicStreamParsed {
  const usage: Record<string, unknown> = {};
  let assistantText = "";
  const toolUseByIndex = new Map<number, { name: string; inputJson: string }>();

  for (const line of sseText.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const dataStr = trimmed.slice(5).trim();
    if (!dataStr) continue;
    try {
      const evt = JSON.parse(dataStr) as Record<string, unknown>;
      const evtType = evt.type as string;
      if (evtType === "message_start") {
        const message = evt.message as Record<string, unknown> | undefined;
        if (message?.usage && typeof message.usage === "object") {
          Object.assign(usage, message.usage);
        }
      } else if (evtType === "message_delta") {
        if (evt.usage && typeof evt.usage === "object") {
          Object.assign(usage, evt.usage);
        }
      } else if (evtType === "content_block_delta") {
        const delta = evt.delta as Record<string, unknown> | undefined;
        if (delta?.type === "text_delta" && typeof delta.text === "string") {
          assistantText += delta.text;
        } else if (delta?.type === "input_json_delta" && typeof delta.partial_json === "string") {
          const idx = evt.index as number | undefined;
          if (typeof idx === "number") {
            const acc = toolUseByIndex.get(idx);
            if (acc) acc.inputJson += delta.partial_json;
          }
        }
      } else if (evtType === "content_block_start") {
        const block = evt.content_block as Record<string, unknown> | undefined;
        if (block?.type === "tool_use") {
          const idx = evt.index as number | undefined;
          if (typeof idx === "number") {
            toolUseByIndex.set(idx, { name: (block.name as string) ?? "", inputJson: "" });
          }
        }
      }
    } catch {
      // ignore malformed
    }
  }

  return {
    usage,
    assistantText,
    toolUses: Array.from(toolUseByIndex.values()),
  };
}

// ── OpenAI Responses (codex / workbuddy) ────────────────────────────────

export interface ResponsesStreamParsed {
  usage: Record<string, unknown> | null;
  assistantText: string;
  /** function_call 累积 (name + arguments) */
  functionCalls: Array<{ name: string; arguments: string }>;
  /** response 结束时的 response.id (供 upstreamRequestId 回填) */
  responseId: string | null;
}

/**
 * 解析 openai Responses API SSE, 事件类型:
 *   - response.output_text.delta: 累积 text
 *   - response.output_item.done (function_call): 追加到 functionCalls
 *   - response.completed: response.usage + response.id
 * 复用 codexHandler.ts:1520 事件表 + 1695 的 completed 分支。
 */
export function parseResponsesSseStream(sseText: string): ResponsesStreamParsed {
  let usage: Record<string, unknown> | null = null;
  let assistantText = "";
  const functionCalls: Array<{ name: string; arguments: string }> = [];
  let responseId: string | null = null;

  for (const line of sseText.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const dataStr = trimmed.slice(5).trim();
    if (!dataStr) continue;
    try {
      const evt = JSON.parse(dataStr) as Record<string, unknown>;
      const evtType = evt.type as string;
      if (evtType === "response.output_text.delta") {
        const delta = evt.delta;
        if (typeof delta === "string") {
          assistantText += delta;
        }
      } else if (evtType === "response.output_item.done") {
        const item = evt.item as Record<string, unknown> | undefined;
        if (item?.type === "function_call") {
          functionCalls.push({
            name: (item.name as string) ?? "",
            arguments: (item.arguments as string) ?? "",
          });
        }
      } else if (evtType === "response.completed") {
        const response = evt.response as Record<string, unknown> | undefined;
        if (response?.usage && typeof response.usage === "object") {
          usage = response.usage as Record<string, unknown>;
        }
        if (typeof response?.id === "string") {
          responseId = response.id;
        }
      }
    } catch {
      // ignore
    }
  }

  return { usage, assistantText, functionCalls, responseId };
}
