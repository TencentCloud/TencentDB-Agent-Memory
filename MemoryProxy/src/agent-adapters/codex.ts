/**
 * Codex CLI 客户端适配器。
 *
 * 特化实现：
 *   - classifyRequest: 严格白名单判 aux（endpoint path + memgen header +
 *     已知 thread_source 值），未知一律 main（偏严不偏宽）
 *   - extractUserText: 从 codex body.input[] 提取最后一条 type=message &&
 *     role=user 的 content[].input_text 拼接
 *
 * 详见 docs/2026-08-07-codex-integration-plan.md §1 / §9。
 */

import type { AgentAdapter, RequestKind } from "./types.js";

// ── Aux detection constants ──────────────────────────────────────────────────

/** 已知的 aux endpoint path suffix。源码 codex-rs/core/src/client.rs 常量。 */
const CODEX_AUX_PATH_SUFFIXES = new Set([
  "/responses/compact",
  "/memories/trace_summarize",
  "/realtime/calls",
]);

/**
 * 已知 codex 客户端 body.client_metadata.thread_source 的 aux 值。
 *
 * - "memory_consolidation": 源码 ThreadSource::MemoryConsolidation
 * - "system": 抓包 §7.4 title-generation aux 实测
 *
 * 未知值一律当主对话（偏严）。
 */
const CODEX_AUX_THREAD_SOURCES = new Set([
  "memory_consolidation",
  "system",
]);

/**
 * 判定 codex 请求是否为 aux（辅助请求）。
 *
 * 三层信号按优先级：
 *   1. endpoint path suffix 白名单（最强，硬编码在 codex 源码）
 *   2. x-openai-memgen-request header（memory consolidation 独占）
 *   3. body.client_metadata.thread_source 白名单
 */
function isCodexAuxiliary(
  path: string | undefined,
  headers: Record<string, string> | undefined,
  body: Record<string, unknown>,
): boolean {
  // 信号 1：aux endpoint（path 白名单）
  if (path) {
    for (const suffix of CODEX_AUX_PATH_SUFFIXES) {
      if (path.endsWith(suffix)) return true;
    }
  }

  // 信号 2：x-openai-memgen-request: true
  if (headers?.["x-openai-memgen-request"] === "true") return true;

  // 信号 3：body.client_metadata.thread_source 命中白名单
  const meta = body.client_metadata as { thread_source?: string } | undefined;
  const ts = meta?.thread_source;
  if (typeof ts === "string" && CODEX_AUX_THREAD_SOURCES.has(ts)) return true;

  return false;
}

// ── User text extraction ─────────────────────────────────────────────────────

/**
 * 从 codex input[] 提取最后一条 type=message && role=user 的 content[].input_text。
 *
 * codex input[] item 类型清单（抓包底稿 §7.2）：
 *   - {type:"message", role, content:[{type:"input_text",text}]}
 *   - {type:"function_call", name, arguments}
 *   - {type:"function_call_output", output}
 *   - {type:"reasoning", encrypted_content}
 *
 * 只关心 type=message && role=user 的 content 里 type=input_text 段。
 */
function extractCodexUserText(input: unknown): string | null {
  if (!Array.isArray(input)) return null;

  // 从后往前找最后一条 role=user 的 message
  for (let i = input.length - 1; i >= 0; i--) {
    const item = input[i] as Record<string, unknown> | null | undefined;
    if (!item || typeof item !== "object") continue;
    if (item.type !== "message" || item.role !== "user") continue;

    const content = item.content;
    if (!Array.isArray(content)) continue;

    const texts: string[] = [];
    for (const block of content) {
      const b = block as Record<string, unknown> | null | undefined;
      if (!b || typeof b !== "object") continue;
      if (b.type === "input_text" && typeof b.text === "string") {
        texts.push(b.text);
      }
    }
    return texts.length > 0 ? texts.join("\n") : null;
  }

  return null;
}

// ── Adapter export ───────────────────────────────────────────────────────────

export const codexAdapter: AgentAdapter = {
  agentKind: "codex",

  classifyRequest(
    body: Record<string, unknown>,
    path?: string,
    headers?: Record<string, string>,
  ): RequestKind {
    return isCodexAuxiliary(path, headers, body) ? "auxiliary" : "main";
  },

  extractUserText(content: unknown): string | null {
    return extractCodexUserText(content);
  },
};
