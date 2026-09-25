/**
 * Service-to-service auth middleware.
 *
 * 模型（对齐 MemoryCore gateway 的 Layer 1 Bearer 语义）：
 *   - KNOWLEDGE_SERVICE_KEY 为空  → 不启用鉴权，全部放行（向后兼容本地/开发部署）；
 *   - KNOWLEDGE_SERVICE_KEY 非空  → /v3 下除只读白名单外的端点均要求
 *     `Authorization: Bearer <serviceKey>`，缺失/错误一律 401（fail-closed）。
 *
 * 只读白名单（Agent 直连面）保持开放：
 *   tools/list、tools/call（Agent 自发现与只读工具执行）、wiki/code-graph 查询类、
 *   source-credential/status（子系统状态，不含凭证内容）、auto-sync/status。
 * 注意：llm-binding 的 status/list 虽不回显 api_key 明文，但会暴露 binding
 * 存在性与 base_url（侦察价值），故不放行——唯一调用方 Panel 均携带 key。
 * 写/管理面（wiki ingest、raw/page write、llm-binding/set、source-credential 的
 * create/list/get/delete/test、auto-sync/trigger 等）一律需要 key ——
 * 新增端点默认受保护。
 *
 * ⚠️ 历史遗留：原白名单里有一条 `READONLY_GET_PREFIXES = ["/source-provider"]`
 * 前缀放行，但仓库内**从未有过**该路由的实现。前缀放行意味着将来任何人在
 * `/source-provider/*` 下挂新端点都会**静默免鉴权**，属于延时炸弹，故本次删除。
 * 若将来确实要加该前缀，请改为精确路径白名单。
 *
 * /health、/docs、/openapi.json 挂在 api 子 app 之外（server.ts），不受本中间件影响。
 */

import { timingSafeEqual } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import { wrapError } from "../api-helpers.js";
import { createLogger } from "../logger.js";

const log = createLogger("auth");

export interface KnowledgeAuthConfig {
  serviceKey: string;
}

/**
 * Timing-safe 字符串比较。长度不同时也对自身做一次比较，
 * 避免通过响应时序泄露 key 长度。
 */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) {
    timingSafeEqual(ba, ba);
    return false;
  }
  return timingSafeEqual(ba, bb);
}

/**
 * 只读白名单（相对 apiPrefix 的路径，如 "/tools/list"）。
 * key 启用后这些端点仍无需鉴权。
 */
const READONLY_POST_PATHS: ReadonlySet<string> = new Set([
  // Agent 自发现 + 只读工具执行（search_wiki / query_code_graph 等）
  "/tools/list",
  "/tools/call",
  // wiki 查询类
  "/wiki/get",
  "/wiki/list",
  "/wiki/raw/ls",
  "/wiki/raw/read",
  "/wiki/page/ls",
  "/wiki/page/read",
  "/wiki/graph",
  "/wiki/search",
  // code-graph 查询类
  "/code-graph/list",
  "/code-graph/get",
  // 注意：/internal/llm-binding/* 全部需要 key（含 status/list）——
  // 它们虽不回显 api_key 明文，但暴露 binding 存在性与 base_url；
  // 唯一调用方是 Panel（携带 KNOWLEDGE_AUTH_TOKEN），见 ensure-knowledge-llm-binding。
]);

const READONLY_GET_PATHS: ReadonlySet<string> = new Set([
  // 凭证子系统状态：只回「是否配置 + 数量 + 支持的类型」，不含任何凭证内容或租户数据。
  // 其余 /source-credential/*（list/get/create/delete/test）一律需要 key —— 它们会
  // 暴露凭证元数据（name/host/created_by），或触发对外的连通性探测。
  "/source-credential/status",
  "/auto-sync/status",
]);

export function isReadonlyPath(method: string, path: string): boolean {
  if (method === "POST") return READONLY_POST_PATHS.has(path);
  if (method === "GET") return READONLY_GET_PATHS.has(path);
  return false;
}

/** 纯函数：校验 Authorization header 是否为 `Bearer <serviceKey>`。 */
export function verifyBearer(authHeader: string | undefined, serviceKey: string): boolean {
  if (!authHeader) return false;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(authHeader);
  if (!m) return false;
  return safeEqual(m[1], serviceKey);
}

/**
 * Hono 中间件工厂。挂在 /v3 子 app 上（server.ts），
 * c.req.path 为完整路径，先 strip apiPrefix 再匹配白名单。
 */
export function createServiceAuthMiddleware(
  cfg: KnowledgeAuthConfig,
  apiPrefix: string,
): MiddlewareHandler {
  return async (c, next) => {
    // 未配置 key = 不启用鉴权（向后兼容，启动时另有 posture warn 日志）
    if (!cfg.serviceKey) return next();

    const full = c.req.path;
    const path = full.startsWith(apiPrefix) ? full.slice(apiPrefix.length) : full;
    if (isReadonlyPath(c.req.method, path)) return next();

    if (verifyBearer(c.req.header("authorization"), cfg.serviceKey)) return next();

    log.warn(`rejected unauthenticated request: ${c.req.method} ${full}`);
    return c.json(wrapError(401, "unauthorized: valid service key required"), 401);
  };
}
