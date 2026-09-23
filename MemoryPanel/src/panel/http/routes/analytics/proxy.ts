import type { Context, Hono } from 'hono';
import {
  isAllowedAnalyticsAction,
  isAnalyticsGetAction,
} from '../../../api/analytics-actions.js';
import type { PanelDeps } from '../../../panel-deps.js';
import { validatePanelMetaHeaders } from '../../middleware/validate-panel-headers.js';
import { respondControlError, respondEnvelope } from '../../envelope.js';
import type { MetaCallContext } from '../../../kernel/types.js';

/**
 * 从请求路径中解析 analytics action。
 * action 带二级路径（session-init/summary、tool-calls/list、usage-raw/list 等），
 * 故取 `/analytics/` 之后的全部片段。
 */
function readAction(path: string): string {
  const marker = '/analytics/';
  const idx = path.indexOf(marker);
  if (idx < 0) return '';
  return path.slice(idx + marker.length);
}

/**
 * 注册 analytics 查询面透明代理：
 *   GET  /api/v1/analytics/{config|spaces} → 内核 GET  /v3/analytics/{action}
 *   POST /api/v1/analytics/{action}        → 内核 POST /v3/analytics/{action}
 *
 * 关键点：
 *   - 前端不能直连内核 —— analytics 要求 Bearer（网关 api_key），该密钥仅存在于
 *     Panel 后端的实例注册表，绝不能进入浏览器 bundle。故必须由本代理注入。
 *   - method 必须与内核声明一致：config / spaces 为 GET，其余为 POST，否则内核 405。
 *   - 权限（system_admin）与 CH 可用性（503）均由内核判定后原样透传，Panel 不预判。
 */
export function registerAnalyticsProxyRoutes(api: Hono, deps: PanelDeps): void {
  const handler = async (c: Context) => {
    const action = readAction(c.req.path);
    if (!action || !isAllowedAnalyticsAction(action)) {
      return respondControlError(c, 404, 'UNKNOWN_ANALYTICS_ACTION');
    }
    // method 与内核声明不一致时直接拒绝，避免把 405 甩给用户
    const wantGet = isAnalyticsGetAction(action);
    const isGet = c.req.method.toUpperCase() === 'GET';
    if (wantGet !== isGet) {
      return respondControlError(c, 405, 'METHOD_NOT_ALLOWED');
    }

    let body: Record<string, unknown> = {};
    if (!isGet) {
      body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    }

    const panelMeta = c.get('panelMeta');
    const ctx: MetaCallContext = {
      instanceId: panelMeta.instanceId,
      gatewayEndpoint: panelMeta.gatewayEndpoint,
      gatewayApiKey: panelMeta.gatewayApiKey,
      userKey: panelMeta.userKey,
      reqId: c.get('reqId'),
    };

    const envelope = await deps.analyticsKernel.invoke(action, body, ctx);
    return respondEnvelope(c, envelope);
  };

  api.get('/analytics/*', validatePanelMetaHeaders(deps), handler);
  api.post('/analytics/*', validatePanelMetaHeaders(deps), handler);
}
