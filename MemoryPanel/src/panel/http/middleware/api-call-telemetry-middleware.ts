/**
 * API 调用审计中间件 — await next() 后采集请求信息写入 ClickHouse。
 *
 * 仅对经过 validatePanelMetaHeaders 的请求（有 panelMeta）生效；
 * 静态资源、/health 等不经过 API 路由的请求自然被跳过。
 *
 * ## user_id 埋点策略（三级兜底）
 *   1. route handler 里 `c.set('resolvedUserId', ...)` → 优先用
 *   2. 中间件级 `userIdResolver.get(userKey, ctx)` → cache 命中即拿
 *   3. 都没有 → 空串。miss 会 fire-and-forget 触发 auth/verify，
 *      下条同 user_key 的请求就能拿到
 */
import { createMiddleware } from 'hono/factory';
import type { PanelApiCallTelemetry } from '../../infra/api-call-telemetry.js';
import { formatClickHouseTimestamp } from '../../infra/api-call-telemetry.js';
import type { PanelUserIdResolver } from '../../infra/user-id-resolver.js';

declare module 'hono' {
  interface ContextVariableMap {
    /** 路由 handler 中 resolveCallerUserId 成功后 set，审计中间件优先读取。 */
    resolvedUserId?: string;
  }
}

/**
 * 注册到 api 子 app：`api.use('*', apiCallTelemetryMiddleware(deps.apiCallTelemetry, deps.userIdResolver))`
 */
export function apiCallTelemetryMiddleware(
  telemetry: PanelApiCallTelemetry,
  userIdResolver: PanelUserIdResolver,
) {
  return createMiddleware(async (c, next) => {
    const start = Date.now();
    await next();

    // 只记录经过了 validatePanelMetaHeaders 的请求
    const panelMeta = c.get('panelMeta');
    if (!panelMeta) return;

    // 三级兜底 user_id: route 显式 set > resolver cache > 空
    let userId = c.get('resolvedUserId') ?? '';
    if (!userId && panelMeta.userKey) {
      userId = userIdResolver.get(panelMeta.userKey, {
        instanceId: panelMeta.instanceId,
        gatewayEndpoint: panelMeta.gatewayEndpoint,
        gatewayApiKey: panelMeta.gatewayApiKey,
        reqId: c.get('reqId'),
      }) ?? '';
    }

    telemetry.record({
      timestamp: formatClickHouseTimestamp(new Date()),
      instance_id: panelMeta.instanceId ?? '',
      user_key: panelMeta.userKey ?? '',
      user_id: userId,
      endpoint: c.req.path,
      http_method: c.req.method,
      http_status: c.res.status,
      duration_ms: Date.now() - start,
      request_id: c.get('reqId') ?? '',
      host: process.env.HOSTNAME ?? '',
    });
  });
}
