import { createHash } from "node:crypto";
import { estimateTokens } from "../core/session/session-snapshot.js";

export interface NormalizeToolResultInput {
  toolName: string;
  toolCallId: string;
  timestamp: string;
  result: unknown;
  maxTokens: number;
  summaryMaxTokens?: number;
  previewMaxChars?: number;
  writeRef: (content: string) => Promise<string>;
}

export interface NormalizeToolResultOutput {
  offloaded: boolean;
  promptResult: unknown;
  resultRef?: string;
  contentHash?: string;
  originalTokens: number;
}

export async function normalizeToolResultForPrompt(input: NormalizeToolResultInput): Promise<NormalizeToolResultOutput> {
  const serialized = stableSerialize(input.result);
  const originalTokens = estimateTokens(serialized);
  if (originalTokens <= Math.max(1, input.maxTokens)) {
    return { offloaded: false, promptResult: input.result, originalTokens };
  }

  const contentHash = sha256(serialized);
  const resultRef = await input.writeRef(serialized);
  const summary = buildDeterministicSummary(serialized, input.previewMaxChars ?? 1200, input.summaryMaxTokens ?? 350);
  return {
    offloaded: true,
    resultRef,
    contentHash,
    originalTokens,
    promptResult: {
      _tdai_offloaded: true,
      tool_name: input.toolName,
      tool_call_id: input.toolCallId,
      result_ref: resultRef,
      content_hash: contentHash,
      original_tokens: originalTokens,
      summary,
      instruction: "需要完整工具结果时调用 tdai_offload_read({ result_ref })，可用 start_line/end_line/query/max_tokens 精确读取。",
    },
  };
}

export function stableSerialize(value: unknown): string {
  return JSON.stringify(sortForJson(value), null, 2);
}

function sortForJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortForJson);
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => [k, sortForJson(v)]);
    return Object.fromEntries(entries);
  }
  return value;
}

function buildDeterministicSummary(serialized: string, previewMaxChars: number, summaryMaxTokens: number): string {
  const maxChars = Math.max(80, Math.min(previewMaxChars, summaryMaxTokens * 4));
  const preview = Array.from(serialized).slice(0, maxChars).join("").trimEnd();
  return preview.length < serialized.length ? `${preview}\n[truncated]` : preview;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
