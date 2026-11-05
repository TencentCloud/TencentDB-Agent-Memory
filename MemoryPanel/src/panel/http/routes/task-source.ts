/**
 * /api/v1/task/source/* —— Task 外部来源（导入 Task）。
 *
 * Panel 职责边界（对应设计文档 §5.1 / §5.3）：
 *   - **薄转发**：业务全在 Core（/v3/task-source/*），Panel 不持有业务逻辑。
 *   - **令牌透传**：用户在 UI 上填入的令牌（太湖统一认证令牌 / TAPD 个人令牌）
 *     随请求体 `credential` 字段提交，Panel 原样转发给 Core。
 *     Panel **不落库、不缓存、不写日志**；请求结束即不再持有。
 */

import type { Context, Hono } from 'hono';
import type { PanelDeps } from '../../panel-deps.js';
import type { MetaCallContext } from '../../kernel/types.js';
import { validatePanelMetaHeaders } from '../middleware/validate-panel-headers.js';
import { respondEnvelope, respondControlError } from '../envelope.js';

function buildCtx(c: Context): MetaCallContext {
  const panelMeta = c.get('panelMeta');
  return {
    instanceId: panelMeta.instanceId,
    gatewayEndpoint: panelMeta.gatewayEndpoint,
    gatewayApiKey: panelMeta.gatewayApiKey,
    userKey: panelMeta.userKey,
    reqId: c.get('reqId'),
  };
}

/** 用户提交的令牌形状。只做最小校验，不加工、不落盘。 */
interface CredentialBody {
  kind: 'bearer' | 'basic' | 'custom';
  secret: string;
  username?: string;
  extra?: Record<string, unknown>;
}

function isCredential(v: unknown): v is CredentialBody {
  if (!v || typeof v !== 'object') return false;
  const c = v as Partial<CredentialBody>;
  return (
    typeof c.secret === 'string' &&
    c.secret.trim().length > 0 &&
    (c.kind === 'bearer' || c.kind === 'basic' || c.kind === 'custom')
  );
}

export function registerTaskSourceRoutes(api: Hono, deps: PanelDeps): void {
  /**
   * providers 不需要令牌（只是列出已启用来源与认证方式），
   * 前端据此渲染令牌输入框。
   */
  api.post('/task/source/providers', validatePanelMetaHeaders(deps), async (c: Context) => {
    const body = await c.req.json<Record<string, unknown>>().catch((): Record<string, unknown> => ({}));
    const env = await deps.taskSourceKernel.invoke('providers', body, buildCtx(c));
    return respondEnvelope(c, env);
  });

  /**
   * 需要令牌的转发（workspaces / candidates / import）。
   *
   * 令牌由用户在 UI 填入，随请求体提交；缺失 → 400，不带着空令牌去调 Core。
   */
  const withCredential = (action: string) =>
    api.post(`/task/source/${action}`, validatePanelMetaHeaders(deps), async (c: Context) => {
      const body = await c.req
        .json<Record<string, unknown> & { credential?: unknown }>()
        .catch((): Record<string, unknown> & { credential?: unknown } => ({}));
      if (!isCredential(body.credential)) {
        return respondControlError(c, 400, 'MISSING_CREDENTIAL');
      }
      const env = await deps.taskSourceKernel.invoke(
        action,
        body as Record<string, unknown>,
        buildCtx(c),
      );
      return respondEnvelope(c, env);
    });

  withCredential('workspaces');
  withCredential('candidates');
  withCredential('import');
}
