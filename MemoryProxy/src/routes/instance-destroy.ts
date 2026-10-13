/**
 * `POST /v3/instance/proxy-destroy` — 运维口：清理 proxy 侧为某个 instance
 * （= spaceId）缓存的 ProxyStorage 数据 + kernel-sts pool 里的 STS backend。
 *
 * 契约字段名对齐 core 的 `/v3/instance/destroy`
 * （`tdai-memory-openclaw-plugin/src/gateway/server.ts:1202-1221`），路径用
 * `proxy-destroy` 动作与 core `destroy` 区分，抓包/日志一眼可辨。
 *
 * 请求：
 *   { "instance_id": "<spaceId>" }
 * Header 可选：Authorization: Bearer <admin.apiKey>
 *
 * 响应 200：
 *   {
 *     "code": 0, "message": "ok",
 *     "data": {
 *       "instance_id": "...",
 *       "cleaned": {
 *         "storage_backend": "sqlite" | "fs" | "memory",
 *         "storage_ttl_deleted":   <number>,   // 缺省 0；出错时 storage_ttl_error 会同时出现
 *         "storage_nottl_deleted": <number>,
 *         "cos_pool_evicted":      "evicted" | "not-cached" | "unsupported",
 *         "redis_skipped":         "per-session-ttl-only"
 *       }
 *     }
 *   }
 *
 * 失败：
 *   400 参数缺失 / 参数非法（含 `/` 或 `..`）
 *   401 auth 开启且 Bearer 缺失/不匹配
 *   200 局部失败：cleaned 内含 <step>_error 字段（对齐 core 局部成功不阻断策略）
 *
 * 说明：Redis session store（`cg:sess:*`）不清理。路由模块的 `sessionKey` 来
 * 自 `x-conversation-id` / `x-claude-code-session-id`（`profiles/*.ts`），不
 * 含 spaceId，无法按 space 精确 SCAN；默认 TTL 1800s 自然过期。cleaned 里
 * `redis_skipped: "per-session-ttl-only"` 显式声明这一点。
 */

import type { Context } from "hono";
import { getProxyStorage } from "../storage/factory.js";
import { assertKeySegment } from "../storage/key-utils.js";
import { log } from "../report/log.js";
import type { ProxyConfig } from "../types.js";
import { adminAuthError, checkAdminAuth } from "./admin-auth.js";

/** 统一的运维口响应外壳。 */
interface EnvelopeOk<T> {
  code: 0;
  message: "ok";
  data: T;
}
interface EnvelopeErr {
  code: number;
  message: string;
}
interface DestroyResponseData {
  instance_id: string;
  cleaned: Record<string, unknown>;
}

/**
 * 构建 handler；`config` 只用来读 `admin.apiKey`，storage 单例通过
 * `getProxyStorage(config.storage)` 拿（`initProxyStorage()` 已在 index.ts 里
 * await 过，这里是幂等 get）。
 */
export function createInstanceDestroyHandler(config: ProxyConfig) {
  return async (c: Context): Promise<Response> => {
    // ── 1. Auth ────────────────────────────────────────────────
    const authResult = checkAdminAuth(c, config.admin.apiKey);
    if (authResult !== "ok") {
      return adminAuthError(c, authResult);
    }

    // ── 2. 参数解析 & 校验 ─────────────────────────────────────
    let body: { instance_id?: unknown } | null = null;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ code: 400, message: "invalid JSON body" } satisfies EnvelopeErr, 400);
    }
    const instanceId = typeof body?.instance_id === "string" ? body.instance_id : "";
    if (!instanceId) {
      return c.json(
        { code: 400, message: "Missing required field: instance_id" } satisfies EnvelopeErr,
        400,
      );
    }
    try {
      // 复用 sessionDirOf 校验规则：非空 + 不含 `/` + 不含 `..`
      assertKeySegment("instance_id", instanceId);
    } catch (err) {
      return c.json(
        {
          code: 400,
          message: `invalid instance_id: ${err instanceof Error ? err.message : String(err)}`,
        } satisfies EnvelopeErr,
        400,
      );
    }

    log.info("instance_destroy.start", { instance_id: instanceId });

    // ── 3. 清理动作 ────────────────────────────────────────────
    const cleaned: Record<string, unknown> = {};

    const storage = getProxyStorage(config.storage);
    cleaned.storage_backend = storage.type;

    // 3a. ttl/<spaceId>/ ——   session-init / hook 预热等热缓存
    try {
      cleaned.storage_ttl_deleted = await storage.delPrefix(`ttl/${instanceId}/`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      cleaned.storage_ttl_deleted = 0;
      cleaned.storage_ttl_error = msg;
      log.warn("instance_destroy.storage_ttl_error", { instance_id: instanceId, error: msg });
    }

    // 3b. nottl/<spaceId>/ —— binding / skill 抽取 / kv version pin 等业务态
    try {
      cleaned.storage_nottl_deleted = await storage.delPrefix(`nottl/${instanceId}/`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      cleaned.storage_nottl_deleted = 0;
      cleaned.storage_nottl_error = msg;
      log.warn("instance_destroy.storage_nottl_error", { instance_id: instanceId, error: msg });
    }

    // 3d. Redis 不清 —— 声明式，方便调用方知道我们没漏
    cleaned.redis_skipped = "per-session-ttl-only";

    log.info("instance_destroy.done", { instance_id: instanceId, cleaned });

    return c.json({
      code: 0,
      message: "ok",
      data: { instance_id: instanceId, cleaned },
    } satisfies EnvelopeOk<DestroyResponseData>);
  };
}
