/** OpenAI-compatible model discovery backed by the local pricing table. */

import type { Context } from "hono";
import { getInstanceUpstreamConfigs, resolveForAgent } from "./instance-upstream-cache.js";
import { verifyUserKey } from "./auth.js";
import { extractSpaceIdFromPath } from "./credit-reporter.js";
import { poolServiceFor } from "./guard-adapter.js";
import { extractBearerToken } from "./opik.js";
import { normalizePublicModelName } from "./pricing.js";
import type { CreditPricingConfig, ProxyConfig } from "./types.js";

export interface OpenAIModel {
  id: string;
  object: "model";
  created: number;
  owned_by: string;
}

export interface OpenAIModelsResponse {
  object: "list";
  data: OpenAIModel[];
}

/**
 * Builds the public model catalog from pricing entries accepted by
 * `isModelInPricing`: only non-empty `modelName` values are client-facing.
 * `extraIds` (the live model-pool service) are listed first.
 */
export function buildModelsResponse(pricing: CreditPricingConfig, extraIds: string[] = []): OpenAIModelsResponse {
  const ids = new Set<string>();
  const data: OpenAIModel[] = [];

  for (const rawId of [...extraIds, ...(pricing.models ?? []).map((entry) => entry.modelName)]) {
    const id = rawId?.trim() ?? "";
    const normalizedId = normalizePublicModelName(id);
    if (!normalizedId || ids.has(normalizedId)) continue;

    ids.add(normalizedId);
    data.push({ id, object: "model", created: 0, owned_by: "context-proxy" });
  }

  return { object: "list", data };
}

/** Handles the tenant-scoped OpenAI-compatible `GET /v1/models` endpoint locally. */
export async function handleModels(c: Context, config: ProxyConfig): Promise<Response> {
  const spaceId = extractSpaceIdFromPath(c.req.path);
  if (!spaceId) {
    return c.json({ error: "spaceId is required in the request path" }, 400);
  }

  const apiKey = c.req.header("x-api-key")
    ?? extractBearerToken(c.req.header("authorization") ?? c.req.header("Authorization") ?? "")
    ?? "";
  const { rejected, rejectReason } = await verifyUserKey(apiKey, spaceId);

  if (rejected) {
    return c.json({ error: `Authentication failed: ${rejectReason ?? "unknown"}` }, 401);
  }

  c.header("cache-control", "no-store");
  const pool = poolServiceFor(config);

  // P1: 该 agent 命中的组若配置了 model_ids 清单,则只暴露清单内模型
  // (正常客户端经 /models 选模型,清单外请求不会发生);
  // 未命中/未配置/获取失败 → 维持全局目录(向后兼容)。手工构造的清单外请求
  // 在 override 阶段回落清单第一个,不报错 —— 口径见 instance-upstream-override.ts。
  let groupModelIds: string[] | null = null;
  try {
    const agent = c.req.path.split("/").filter(Boolean)[0] ?? "";
    if (agent) {
      const items = await getInstanceUpstreamConfigs(
        config.coreSkill, spaceId, config.instanceUpstream,
      );
      const teamId = (c.req.header("x-team-id") ?? "").toLowerCase();
      const res = resolveForAgent(items, agent, teamId);
      const row = "row" in res ? res.row : null;
      if (row?.model_ids && row.model_ids.length > 0) groupModelIds = row.model_ids;
    }
  } catch {
    // 清单获取失败 → 退回全局目录
  }

  if (groupModelIds) {
    return c.json({
      object: "list",
      data: groupModelIds.map((id) => ({ id, object: "model", created: 0, owned_by: "context-proxy" })),
    });
  }
  return c.json(buildModelsResponse(config.creditPricing, pool.active ? [pool.serviceName] : []));
}
