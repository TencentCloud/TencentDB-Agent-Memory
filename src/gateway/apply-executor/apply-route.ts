/**
 * HTTP handler + syncSceneIndex (P4).
 *
 * syncSceneIndex features the I3/I4 `syncSceneIndexAllProjects` (per-project
 * rebuild after rewriting scene_blocks/<slug>). When absent (committed tree),
 * falls back to syncSceneIndexPerProject in scene-index-fallback.ts.
 *
 * Split from the apply-executor.ts shim + syncSceneIndexPerProject to keep
 * this file ≤150 lines.
 */

import type http from "node:http";
import { parseJsonBody, sendJson, sendError } from "../http-utils.js";
import * as sceneIndex from "../../core/scene/scene-index.js";
import type { TdaiCore } from "../../core/tdai-core.js";
import type { GatewayConfig } from "../config.js";
import type { Logger } from "../../core/types.js";
import type { ApplyExecutorDeps } from "./apply-executor-deps.js";
import type { ApplyResult } from "./types.js";
import { syncSceneIndexPerProject } from "./scene-index-fallback.js";

export interface ApplyRouteContext {
  core: TdaiCore;
  config: GatewayConfig;
  logger: Logger;
}

export async function syncSceneIndex(
  deps: ApplyExecutorDeps,
): Promise<boolean> {
  try {
    const allProjects = (
      sceneIndex as typeof sceneIndex & {
        syncSceneIndexAllProjects?: (dataDir: string) => Promise<unknown>;
      }
    ).syncSceneIndexAllProjects;
    if (typeof allProjects === "function") {
      await allProjects(deps.dataDir);
    } else {
      await syncSceneIndexPerProject(deps);
    }
    return true;
  } catch (err) {
    deps.logger.warn?.(
      `[memory/apply] syncSceneIndex failed: ${err instanceof Error ? err.message : String(err)} — ` +
        "scene_index.json rebuilds on the next /memory/validate",
    );
    return false;
  }
}

/**
 * Route handler: Content-Type must be application/json (критерий 20); the
 * write-gate (Bearer OR x-memory-token) is enforced by server.ts BEFORE
 * this handler. Status mapping: 200 applied · 400 validation · 409
 * drift/stale/abort-with-heal · 500 runtime/failed.
 */
export async function handleMemoryApply(
  ctx: ApplyRouteContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const contentType = req.headers["content-type"];
  if (
    typeof contentType !== "string" ||
    !contentType.toLowerCase().startsWith("application/json")
  ) {
    sendError(res, 415, "Content-Type must be application/json");
    return;
  }

  let body: unknown;
  try {
    body = await parseJsonBody<unknown>(req);
  } catch {
    sendError(res, 400, "Invalid JSON body");
    return;
  }

  // Lazy import to avoid cycle: apply-executor.ts (shim) exports ApplyExecutor.
  const { ApplyExecutor } = await import("../apply-executor.js");
  const executor = new ApplyExecutor({
    dataDir: ctx.config.data.baseDir,
    logger: ctx.logger,
    vectorStore: ctx.core.getVectorStore(),
    embeddingService: ctx.core.getEmbeddingService(),
    runRepo: ctx.config.memory?.consolidation?.applyRunRepo === true,
  });
  const runId = (body as { runId?: unknown } | null)?.runId;

  let result: ApplyResult;
  try {
    result = await executor.apply(
      body,
      typeof runId === "string" ? { runId } : undefined,
    );
  } catch (err) {
    ctx.logger.error?.(
      `[memory/apply] unexpected error: ${err instanceof Error ? err.message : String(err)}`,
    );
    sendError(
      res,
      500,
      `Apply executor failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }

  if (result.ok) {
    sendJson(res, 200, result);
    return;
  }

  // Aborts carry their own status code (400 validation · 409 drift/stale ·
  // 500 runtime); "failed" (syncSceneIndex / unresolved counts) is a 500.
  const status = result.statusCode ?? (result.status === "failed" ? 500 : 400);
  sendJson(res, status, result);
}
