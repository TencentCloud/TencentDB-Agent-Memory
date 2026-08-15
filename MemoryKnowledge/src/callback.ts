/**
 * Status callback — notify TMC when wiki/code-graph ingest/sync completes.
 *
 * Flow:
 *   1. Async ingest/sync finishes (ready or failed)
 *   2. If ready: auto-generate summary (wiki via LLM, code-graph via template)
 *   3. HTTP POST to TMC_CALLBACK_URL with {knowledge_id, type, status, summary, ...}
 *   4. Retry once on failure; never block the main async task
 *
 * When TMC_CALLBACK_URL is empty, all callbacks are skipped (no-op).
 *
 * Also supports fire-and-forget ingest_progress callbacks during wiki ingest.
 */

import type { LlmConfig } from "./config.js";
import type { IngestProgress, ProgressFn } from "./engines/wiki/manager.js";

const TAG = "[callback]";
const RETRY_DELAY_MS = 1000;

export interface StatusCallbackPayload {
  knowledge_id: string;
  /** Owning tenant (001 multi-tenancy) = x-tdai-service-id; lets TMC scope the status update. */
  service_id?: string;
  type: "wiki" | "code-graph";
  status: "ready" | "failed";
  summary: string | null;
  sync_error: string | null;
  timestamp: string;
  /** 与本次 ingest 进度回调同一代际；Panel 用以拒绝 clear 后的迟到 progress */
  run_id?: string;
}

export interface IngestProgressCallback {
  wiki_id: string;
  service_id: string;
  team_id: string;
  event: "ingest_progress";
  progress: IngestProgress;
  /** 单次 ingest 代际 id；与终态 callback 的 run_id 一致 */
  run_id?: string;
}

export interface CallbackConfig {
  tmcCallbackUrl: string;
}

/**
 * Send status callback to TMC.
 * Failures are logged but never thrown — this runs in async task paths.
 */
export async function callbackTMC(
  payload: StatusCallbackPayload,
  config: CallbackConfig,
): Promise<void> {
  if (!config.tmcCallbackUrl) {
    return; // no-op when unconfigured
  }

  const url = `${config.tmcCallbackUrl.replace(/\/$/, "")}/api/v1/knowledge/status-callback`;
  const body = JSON.stringify(payload);

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        signal: AbortSignal.timeout(5000),
      });
      if (resp.ok) {
        return;
      }
      const respText = await resp.text().catch(() => "(unreadable)");
      console.warn(`${TAG} TMC callback HTTP ${resp.status} for ${payload.knowledge_id} (attempt ${attempt + 1}): ${respText.slice(0, 500)}`);
    } catch (err) {
      console.warn(`${TAG} TMC callback failed for ${payload.knowledge_id} (attempt ${attempt + 1}/${2}):`, err);
    }
    if (attempt === 0) {
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    }
  }
  console.error(`${TAG} TMC callback gave up after 2 attempts for ${payload.knowledge_id} (type=${payload.type}, status=${payload.status})`);
}

/**
 * Fire-and-forget progress callback during wiki ingest.
 * Failures are logged as warn only — never block the ingest pipeline.
 */
export function sendProgressCallback(tmcCallbackUrl: string, payload: IngestProgressCallback): void {
  if (!tmcCallbackUrl) return;
  const url = `${tmcCallbackUrl.replace(/\/$/, "")}/api/v1/knowledge/status-callback`;
  void fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(5000),
  }).catch((err) => {
    console.warn(`${TAG} progress callback failed for ${payload.wiki_id}:`, err);
  });
}

/** Build an onProgress fn that POSTs ingest_progress to TMC/Panel. */
export function buildProgressFn(
  tmcCallbackUrl: string,
  wikiId: string,
  serviceId: string,
  teamId: string,
  runId?: string,
): ProgressFn {
  return (progress) => {
    sendProgressCallback(tmcCallbackUrl, {
      wiki_id: wikiId,
      service_id: serviceId,
      team_id: teamId,
      event: "ingest_progress",
      progress,
      ...(runId ? { run_id: runId } : {}),
    });
  };
}

// ═══════════════════════════════════════════════════════════════════════
//  Summary generation
// ═══════════════════════════════════════════════════════════════════════

/**
 * Generate wiki summary via LLM.
 * Reads page titles + descriptions, asks LLM for a ≤100 char Chinese summary.
 * 复用 createLlmClient（自动走正确协议 openai/anthropic + Langfuse 追踪 + 超时处理）。
 */
import { createLlmClient } from "./engines/wiki/ingest-v2/llm.js";

export async function generateWikiSummary(
  wikiId: string,
  name: string,
  pages: Array<{ title: string; description?: string }>,
  llm: LlmConfig,
): Promise<string> {
  if (pages.length === 0) {
    console.warn(`${TAG} wiki summary skipped: no pages for ${wikiId}`);
    return "";
  }

  const pageList = pages
    .slice(0, 20) // limit to avoid token overflow
    .map((p) => `- ${p.title}${p.description ? `: ${p.description.slice(0, 80)}` : ""}`)
    .join("\n");

  const prompt = `请为以下知识库生成一个不超过100字的中文摘要，描述它的主要内容和用途。只输出摘要文本，不要输出其他内容。

知识库名称：${name}
包含的页面：
${pageList}`;

  console.info(`${TAG} wiki summary LLM call start for ${wikiId} (model=${llm.model}, protocol=${llm.protocol}, pages=${pages.length})`);
  try {
    const client = createLlmClient(llm);
    const text = await client.chat({
      system: "你是一个知识库摘要生成器。只输出摘要文本，不要输出其他内容。",
      prompt,
      maxOutputTokens: 1024,
      temperature: 0.3,
      label: `wiki-summary`,
    });
    const result = text.slice(0, 256); // enforce ≤256 char limit
    console.info(`${TAG} wiki summary LLM call done for ${wikiId} (len=${result.length}, empty=${result.length === 0})`);
    return result;
  } catch (err) {
    console.error(`${TAG} wiki summary generation failed for ${wikiId}:`, err);
    return "";
  }
}

/**
 * Generate code-graph summary via template (no LLM call).
 * Format: "{repo_name}（{branch}）- {files} 个文件、{nodes} 个符号节点"
 */
export function generateCodeGraphSummary(
  repoName: string,
  branch: string,
  stats: { files: number; nodes: number; edges: number } | null,
): string {
  if (!stats) {
    return `${repoName}（${branch}）`;
  }
  return `${repoName}（${branch}）- ${stats.files} 个文件、${stats.nodes} 个符号节点`.slice(0, 256);
}
