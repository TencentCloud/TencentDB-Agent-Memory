import type { MemoryTdaiConfig } from "../../config.js";
import type { Logger } from "../types.js";

const TAG = "[memory-tdai] [recall-rerank]";

interface RerankResultItem {
  index?: unknown;
  relevance_score?: unknown;
  score?: unknown;
}

interface RerankResponse {
  results?: RerankResultItem[];
}

export async function rerankRecallLines(params: {
  query: string;
  lines: string[];
  cfg: MemoryTdaiConfig;
  logger?: Logger;
  fetchImpl?: typeof fetch;
}): Promise<string[]> {
  const { query, lines, cfg, logger, fetchImpl = fetch } = params;
  const rerank = cfg.recall.rerank;

  if (!rerank?.enabled || lines.length < 2) return lines;
  if (!rerank.baseUrl || !rerank.apiKey || !rerank.model) {
    logger?.warn?.(`${TAG} enabled but baseUrl/apiKey/model is incomplete; keeping original recall order`);
    return lines;
  }

  const timeoutMs = rerank.timeoutMs > 0 ? rerank.timeoutMs : 1000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const baseUrl = rerank.baseUrl.replace(/\/+$/, "");
    const response = await fetchImpl(`${baseUrl}/rerank`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${rerank.apiKey}`,
      },
      body: JSON.stringify({
        model: rerank.model,
        query,
        documents: lines,
        top_n: lines.length,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      logger?.warn?.(`${TAG} remote rerank failed with HTTP ${response.status}; keeping original recall order`);
      return lines;
    }

    const json = await response.json() as RerankResponse;
    const reordered = applyRerankResponse(lines, json);
    if (!reordered) {
      logger?.warn?.(`${TAG} remote rerank returned an unsupported response shape; keeping original recall order`);
      return lines;
    }

    logger?.debug?.(`${TAG} reordered ${lines.length} recall candidate(s)`);
    return reordered;
  } catch (err) {
    logger?.warn?.(`${TAG} remote rerank failed: ${err instanceof Error ? err.message : String(err)}; keeping original recall order`);
    return lines;
  } finally {
    clearTimeout(timer);
  }
}

export function applyRerankResponse(lines: string[], response: RerankResponse): string[] | undefined {
  if (!Array.isArray(response.results)) return undefined;

  const ranked: Array<{ index: number; score: number }> = [];
  for (const item of response.results) {
    const index = typeof item.index === "number" ? item.index : undefined;
    const score =
      typeof item.relevance_score === "number" ? item.relevance_score :
      typeof item.score === "number" ? item.score :
      undefined;
    if (index == null || score == null) continue;
    if (!Number.isInteger(index) || index < 0 || index >= lines.length) continue;
    ranked.push({ index, score });
  }

  if (ranked.length === 0) return undefined;

  ranked.sort((a, b) => b.score - a.score);
  const used = new Set<number>();
  const reordered: string[] = [];
  for (const item of ranked) {
    if (used.has(item.index)) continue;
    used.add(item.index);
    reordered.push(lines[item.index]);
  }

  for (let i = 0; i < lines.length; i++) {
    if (!used.has(i)) reordered.push(lines[i]);
  }

  return reordered;
}
