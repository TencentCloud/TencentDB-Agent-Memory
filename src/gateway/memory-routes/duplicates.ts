/**
 * GET /memory/duplicates — vector-only candidate finding (P3 + P10).
 *
 * Batch-embed records, cosine search topK, sameScope filter — the
 * l1-dedup candidate mechanism WITHOUT the LLM judgment phase.
 * findDuplicateClusters is reused by the P10 dashboard.
 *
 * Split from memory-routes.ts to keep that file ≤150 lines.
 */

import type http from "node:http";
import { sendJson } from "../http-utils.js";
import type {
  MemoryDuplicatesResponse,
} from "../types.js";
import type { Logger } from "../../core/types.js";
import type { IMemoryStore } from "../../core/store/types.js";
import type { EmbeddingService } from "../../core/store/embedding.js";
import type { MemoryRoutesContext } from "./context.js";
import {
  queryL1Rows,
  clampInt,
  clampFloat,
  sameScope,
  type DuplicateCandidate,
} from "./helpers.js";

export async function findDuplicateClusters(
  deps: {
    store?: IMemoryStore;
    embed?: EmbeddingService;
    dataDir: string;
    logger: Logger;
  },
  opts: {
    since?: string;
    project?: string;
    type?: string;
    topK: number;
    threshold: number;
    limit: number;
  },
): Promise<{
  clusters: MemoryDuplicatesResponse["clusters"];
  degraded: boolean;
  reason?: string;
}> {
  const { store, embed, dataDir, logger } = deps;
  if (!store || !embed) {
    return {
      clusters: [],
      degraded: true,
      reason: "vector store or embedding service unavailable",
    };
  }

  const rows = queryL1Rows(dataDir, logger, {
    since: opts.since,
    project: opts.project,
    type: opts.type,
    limit: opts.limit,
  });
  if (!rows) {
    return { clusters: [], degraded: true, reason: "memory records query failed" };
  }

  const clusters: MemoryDuplicatesResponse["clusters"] = [];
  for (const row of rows) {
    const content = typeof row.content === "string" ? row.content : "";
    if (!content) continue;
    let vec: Float32Array;
    try {
      vec = await embed.embed(content);
    } catch (err) {
      logger.warn(
        `[memory/duplicates] embed failed for ${String(row.record_id)}: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }
    const projectId = typeof row.project_id === "string" ? row.project_id : "";
    const scope = typeof row.scope === "string" && row.scope ? (row.scope as "global" | "project") : undefined;

    // Widened call: workspace store accepts a 4th projectId arg; committed
    // takes 3. Extra args are ignored by older signatures.
    const hits = await (store.searchL1Vector as unknown as (
      emb: Float32Array, topK?: number, text?: string, projectId?: string,
    ) => Promise<DuplicateCandidate[]>)(vec, opts.topK, content, projectId);
    const similar = hits
      .filter((h) => h.record_id !== row.record_id)
      .filter((h) => sameScope(h, scope, projectId))
      .filter((h) => h.score >= opts.threshold)
      .map((h) => ({
        record_id: h.record_id,
        score: Math.round(h.score * 10_000) / 10_000,
        scope: h.scope ?? "",
        project_id: h.project_id ?? "",
        type: h.type,
      }));
    if (similar.length > 0) clusters.push({ record_id: String(row.record_id), similar });
  }

  return { clusters, degraded: false };
}

export async function handleMemoryDuplicates(
  ctx: MemoryRoutesContext,
  url: URL,
  res: http.ServerResponse,
): Promise<void> {
  const since = url.searchParams.get("since") ?? undefined;
  const project = url.searchParams.get("project") ?? undefined;
  const type = url.searchParams.get("type") ?? undefined;
  const topK = clampInt(
    url.searchParams.get("topK"),
    1,
    20,
    ctx.config.memory.embedding.conflictRecallTopK || 5,
  );
  const threshold = clampFloat(
    url.searchParams.get("threshold"),
    0,
    1,
    ctx.config.memory.recall.scoreThreshold,
  );
  const limit = clampInt(url.searchParams.get("limit"), 1, 500, 100);

  const found = await findDuplicateClusters(
    {
      store: ctx.core.getVectorStore(),
      embed: ctx.core.getEmbeddingService(),
      dataDir: ctx.config.data.baseDir,
      logger: ctx.logger,
    },
    { since, project, type, topK, threshold, limit },
  );
  const response: MemoryDuplicatesResponse = {
    total: found.clusters.length,
    clusters: found.clusters,
    topK,
    threshold,
    degraded: found.degraded,
    reason: found.reason,
  };
  sendJson(res, 200, response);
}
