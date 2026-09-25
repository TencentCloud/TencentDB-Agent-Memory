/**
 * 上游 JSON 响应的通用摘要（三种协议形态统一读取）。
 *
 * codex 的非流式 trace 收尾不能假设"上游一定是 Responses 形态"：当该 agent 打开了
 * chatCompletions / responsesToAnthropic，上游返回的是 Chat 或 Anthropic JSON。
 * 收尾只关心三件事——回复文本、工具调用数、用量——因此这里把三种形态统一成
 * `{ text, toolCallCount, usage }`，usage 一律归到 Responses 口径
 * （`input_tokens` / `output_tokens` / `cached_tokens`），使同一条 codex 链路的
 * trace 在"是否转换"两种情况下字段一致。
 */

import { summarizeResponsesOutput } from "../opik-metadata.js";

export interface UpstreamJsonSummary {
  /** 回复正文（无正文时为空串）。 */
  text: string;
  /** 工具调用条数（三种形态下的 tool_calls / tool_use 计数）。 */
  toolCallCount: number;
  /** Responses 口径的用量；上游未返回 usage 时为空对象。 */
  usage: Record<string, unknown>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function pickNumber(source: Record<string, unknown>, key: string): number | undefined {
  const value = source[key];
  return typeof value === "number" ? value : undefined;
}

/** Chat 用量 → Responses 口径。 */
function chatUsageToResponses(usage: Record<string, unknown>): Record<string, unknown> {
  const cachedDetails = asRecord(usage.prompt_tokens_details);
  const cached =
    pickNumber(cachedDetails ?? {}, "cached_tokens") ??
    pickNumber(usage, "prompt_cache_hit_tokens");
  const out: Record<string, unknown> = {};
  const input = pickNumber(usage, "prompt_tokens");
  const output = pickNumber(usage, "completion_tokens");
  const total = pickNumber(usage, "total_tokens");
  if (input !== undefined) out.input_tokens = input;
  if (output !== undefined) out.output_tokens = output;
  if (total !== undefined) out.total_tokens = total;
  if (cached !== undefined) out.cached_tokens = cached;
  return out;
}

/** Anthropic 用量 → Responses 口径。 */
function anthropicUsageToResponses(usage: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const input = pickNumber(usage, "input_tokens");
  const output = pickNumber(usage, "output_tokens");
  const cached = pickNumber(usage, "cache_read_input_tokens");
  if (input !== undefined) out.input_tokens = input;
  if (output !== undefined) out.output_tokens = output;
  if (input !== undefined && output !== undefined) out.total_tokens = input + output;
  if (cached !== undefined) out.cached_tokens = cached;
  return out;
}

/** Responses 形态：output[] + Responses 口径 usage（原样保留）。 */
function summarizeResponsesShape(json: Record<string, unknown>): UpstreamJsonSummary {
  const output = Array.isArray(json.output) ? (json.output as unknown[]) : [];
  const { text, toolCalls } = summarizeResponsesOutput(output);
  const usage = asRecord(json.usage) ?? {};
  return { text, toolCallCount: toolCalls.length, usage };
}

/** Chat 形态：choices[0].message。 */
function summarizeChatShape(json: Record<string, unknown>): UpstreamJsonSummary {
  const choices = Array.isArray(json.choices) ? (json.choices as unknown[]) : [];
  const first = asRecord(choices[0]);
  const message = first ? asRecord(first.message) : null;
  const text = message && typeof message.content === "string" ? message.content : "";
  const toolCalls =
    message && Array.isArray(message.tool_calls) ? (message.tool_calls as unknown[]) : [];
  const usage = asRecord(json.usage);
  return {
    text,
    toolCallCount: toolCalls.length,
    usage: usage ? chatUsageToResponses(usage) : {},
  };
}

/** Anthropic 形态：content[] 文本块与 tool_use 块。 */
function summarizeAnthropicShape(json: Record<string, unknown>): UpstreamJsonSummary {
  const content = Array.isArray(json.content) ? (json.content as unknown[]) : [];
  const textParts: string[] = [];
  let toolCallCount = 0;
  for (const raw of content) {
    const block = asRecord(raw);
    if (!block) continue;
    if (block.type === "text" && typeof block.text === "string") textParts.push(block.text);
    if (block.type === "tool_use") toolCallCount += 1;
  }
  const usage = asRecord(json.usage);
  return {
    text: textParts.join("\n"),
    toolCallCount,
    usage: usage ? anthropicUsageToResponses(usage) : {},
  };
}

/**
 * 识别上游 JSON 属于哪种形态并给出统一摘要。
 *
 * 判定顺序按字段特征：有 `output` 数组 → Responses；有 `choices` → Chat；
 * 有 `content` 数组 → Anthropic；都不匹配时返回空摘要（调用方按"无正文、无用量"处理）。
 */
export function summarizeUpstreamJson(json: unknown): UpstreamJsonSummary {
  const record = asRecord(json);
  if (!record) return { text: "", toolCallCount: 0, usage: {} };
  if (Array.isArray(record.output)) return summarizeResponsesShape(record);
  if (Array.isArray(record.choices)) return summarizeChatShape(record);
  if (Array.isArray(record.content)) return summarizeAnthropicShape(record);
  return { text: "", toolCallCount: 0, usage: {} };
}
