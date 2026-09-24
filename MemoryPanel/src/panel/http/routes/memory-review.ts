/**
 * Memory Review 路由 —— 记忆变更集（session diff）的查询与撤销代理。
 *
 * 两个端点都是数据面透明代理，直接转发到内核 /v3/memory/*：
 *   POST /api/v1/memory/diff        → POST /v3/memory/diff
 *   POST /api/v1/memory/diff/revert → POST /v3/memory/diff/revert
 *
 * body 原样透传（session_id / record_id / reason / team_id / user_id /
 * agent_id 由调用方提供，内核侧做 v3 严格隔离校验——缺三元组直接 422）。
 */
import type { Hono } from 'hono';
import type { PanelDeps } from '../../../panel-deps.js';
import { validatePanelMetaHeaders } from '../../middleware/validate-panel-headers.js';
import { respondEnvelope } from '../../envelope.js';
import { toKernelCredentials, type MetaCallContext } from '../../../kernel/types.js';

function buildCtx(c: import('hono').Context): MetaCallContext {
  const panelMeta = c.get('panelMeta');
  return {
    instanceId: panelMeta.instanceId,
    gatewayEndpoint: panelMeta.gatewayEndpoint,
    gatewayApiKey: panelMeta.gatewayApiKey,
    userKey: panelMeta.userKey,
    reqId: c.get('reqId'),
  };
}

async function readJson(c: import('hono').Context): Promise<Record<string, unknown>> {
  try {
    return (await c.req.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function registerMemoryReviewRoutes(api: Hono, deps: PanelDeps): void {
  api.post('/memory/diff', validatePanelMetaHeaders(deps), async (c) => {
    const ctx = buildCtx(c);
    const body = await readJson(c);
    const cred = toKernelCredentials(ctx, { timeoutMs: 15_000 });
    const envelope = await deps.kernelHttp.postEnvelope('/v3/memory/diff', body, cred);
    return respondEnvelope(c, envelope);
  });

  api.post('/memory/diff/revert', validatePanelMetaHeaders(deps), async (c) => {
    const ctx = buildCtx(c);
    const body = await readJson(c);
    const cred = toKernelCredentials(ctx, { timeoutMs: 30_000 });
    const envelope = await deps.kernelHttp.postEnvelope('/v3/memory/diff/revert', body, cred);
    return respondEnvelope(c, envelope);
  });
}
