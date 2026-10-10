/**
 * /api/v1/knowledge/source/* —— 外部来源（工蜂 / GitHub / GitLab）薄封装。
 *
 * 设计约束：Panel 不含业务逻辑，来源清单与凭据存储的唯一真相源都在 KS。
 * Panel 只做三件事：
 *   1. 校验调用者身份（team 门控 + user_id）
 *   2. 带上实例凭证、x-tdai-team-id 与 x-tdai-user-id 转发给 KS
 *   3. 把 KS 的 envelope 原样返回
 *
 * 凭据挂在**资源**上（resource_type + resource_id），与用户解耦。
 * team 门控由 KS 侧完成（校验 resource_id 属于 x-tdai-team-id），Panel 只把
 * requireTeamMember 通过后的 gate.userId + gate.teamId 透传。
 *
 * 安全边界：
 *   - 明文令牌**只**在 PUT 请求体里经 Panel 转发给 KS，不落 Panel 日志、不回吐。
 *   - Panel 不接受 body 里的 user_id / team_id，防止 A 改 B 的资源。
 */
import type { Hono } from 'hono';
import { validatePanelMetaHeaders } from '../../middleware/validate-panel-headers.js';
import { respondControlError } from '../../envelope.js';
import type { PanelDeps } from '../../../panel-deps.js';
import type { ResourceType } from '../../../kernel/ports/knowledge-client-port.js';
import {
  buildCtx,
  readJson,
  str,
  requireTeamMember,
  runKs,
} from './common.js';

const VALID_TYPES: readonly ResourceType[] = ['code-graph', 'wiki'];

/** 从 body / query 解析并校验 resource_type + resource_id。 */
function parseRef(body: Record<string, unknown>): { type: ResourceType; id: string } | string {
  const type = str(body, 'resource_type');
  const id = str(body, 'resource_id');
  if (!type || !VALID_TYPES.includes(type as ResourceType)) return 'INVALID_RESOURCE_TYPE';
  if (!id) return 'MISSING_RESOURCE_ID';
  return { type: type as ResourceType, id };
}

export function registerKnowledgeSourceRoutes(api: Hono, deps: PanelDeps): void {
  const mw = validatePanelMetaHeaders(deps);

  // 已启用的 codegraph 来源列表（前端下拉数据源）
  api.post('/knowledge/source/providers', mw, async (c) => {
    const ctx = buildCtx(c);
    const body = await readJson(c);
    const teamId = str(body, 'team_id');
    if (!teamId) return respondControlError(c, 400, 'MISSING_TEAM_ID');
    const gate = await requireTeamMember(deps, c, ctx, teamId);
    if ('error' in gate) return gate.error;
    const kc = deps.knowledgeClientFactory(ctx.instanceId);
    return runKs(c, () => kc.sourceProviderListCode());
  });

  // 已启用的 wiki 来源列表（前端下拉数据源）
  api.post('/knowledge/source/wiki-providers', mw, async (c) => {
    const ctx = buildCtx(c);
    const body = await readJson(c);
    const teamId = str(body, 'team_id');
    if (!teamId) return respondControlError(c, 400, 'MISSING_TEAM_ID');
    const gate = await requireTeamMember(deps, c, ctx, teamId);
    if ('error' in gate) return gate.error;
    const kc = deps.knowledgeClientFactory(ctx.instanceId);
    return runKs(c, () => kc.sourceProviderListWiki());
  });

  // 列远端文档树（注册 wiki 时勾选）
  // body: { team_id, wiki_id, source_url, provider_id }
  api.post('/knowledge/source/wiki/list', mw, async (c) => {
    const ctx = buildCtx(c);
    const body = await readJson(c);
    const teamId = str(body, 'team_id');
    const wikiId = str(body, 'wiki_id');
    const sourceUrl = str(body, 'source_url');
    const providerId = str(body, 'provider_id');
    if (!teamId) return respondControlError(c, 400, 'MISSING_TEAM_ID');
    if (!wikiId) return respondControlError(c, 400, 'MISSING_WIKI_ID');
    if (!sourceUrl) return respondControlError(c, 400, 'MISSING_SOURCE_URL');
    if (!providerId) return respondControlError(c, 400, 'MISSING_PROVIDER_ID');
    const gate = await requireTeamMember(deps, c, ctx, teamId);
    if ('error' in gate) return gate.error;
    const kc = deps.knowledgeClientFactory(ctx.instanceId);
    return runKs(c, () =>
      kc.wikiSourceList({
        wikiId,
        sourceUrl,
        providerId,
        actor: { teamId, userId: gate.userId },
      }),
    );
  });

  // 导入远端文档（拉取 + 写盘，不触发 ingest）
  // body: { team_id, wiki_id, source_url, provider_id, page_ids? }
  api.post('/knowledge/source/wiki/import', mw, async (c) => {
    const ctx = buildCtx(c);
    const body = await readJson(c);
    const teamId = str(body, 'team_id');
    const wikiId = str(body, 'wiki_id');
    const sourceUrl = str(body, 'source_url');
    const providerId = str(body, 'provider_id');
    const pageIds = Array.isArray(body['page_ids'])
      ? (body['page_ids'] as unknown[]).filter((x): x is string => typeof x === 'string')
      : undefined;
    if (!teamId) return respondControlError(c, 400, 'MISSING_TEAM_ID');
    if (!wikiId) return respondControlError(c, 400, 'MISSING_WIKI_ID');
    if (!sourceUrl) return respondControlError(c, 400, 'MISSING_SOURCE_URL');
    if (!providerId) return respondControlError(c, 400, 'MISSING_PROVIDER_ID');
    const gate = await requireTeamMember(deps, c, ctx, teamId);
    if ('error' in gate) return gate.error;
    const kc = deps.knowledgeClientFactory(ctx.instanceId);
    return runKs(c, () =>
      kc.wikiSourceImport({
        wikiId,
        sourceUrl,
        providerId,
        pageIds,
        actor: { teamId, userId: gate.userId },
      }),
    );
  });

  // 某资源的凭据状态（仅元数据）
  // body: { team_id, resource_type, resource_id }
  api.post('/knowledge/source/credential/status', mw, async (c) => {
    const ctx = buildCtx(c);
    const body = await readJson(c);
    const teamId = str(body, 'team_id');
    if (!teamId) return respondControlError(c, 400, 'MISSING_TEAM_ID');
    const ref = parseRef(body);
    if (typeof ref === 'string') return respondControlError(c, 400, ref);
    const gate = await requireTeamMember(deps, c, ctx, teamId);
    if ('error' in gate) return gate.error;
    const kc = deps.knowledgeClientFactory(ctx.instanceId);
    return runKs(c, () =>
      kc
        .sourceCredentialStatus(ref.type, ref.id, { teamId, userId: gate.userId })
        .then((credential) => ({ configured: !!credential, credential })),
    );
  });

  // 写入 / 更新令牌
  // body: { team_id, resource_type, resource_id, provider_id, secret, cred_kind?, username? }
  // ⚠ secret 只在本次请求体内转发给 KS；不写日志、不回吐、不落 Panel 任何存储。
  api.post('/knowledge/source/credential', mw, async (c) => {
    const ctx = buildCtx(c);
    const body = await readJson(c);
    const teamId = str(body, 'team_id');
    if (!teamId) return respondControlError(c, 400, 'MISSING_TEAM_ID');
    const ref = parseRef(body);
    if (typeof ref === 'string') return respondControlError(c, 400, ref);
    const providerId = str(body, 'provider_id');
    // Git passwords may contain surrounding spaces; match the create endpoint's
    // byte-preserving forwarding without changing Wiki's existing normalization.
    const secret = ref.type === 'code-graph' ? body.secret : str(body, 'secret');
    const username = ref.type === 'code-graph' ? body.username : str(body, 'username') ?? undefined;
    const kind = str(body, 'cred_kind') ?? 'bearer';
    if (!providerId) return respondControlError(c, 400, 'MISSING_PROVIDER_ID');
    if (typeof secret !== 'string' || !secret) return respondControlError(c, 400, 'MISSING_SECRET');
    if ((username !== undefined && (typeof username !== 'string' || !username)) ||
        (ref.type === 'code-graph' && kind === 'basic' && username === undefined)) {
      return respondControlError(c, 400, 'INVALID_CREDENTIAL');
    }
    const gate = await requireTeamMember(deps, c, ctx, teamId);
    if ('error' in gate) return gate.error;
    const kc = deps.knowledgeClientFactory(ctx.instanceId);
    // 只回 KS 给的元数据（KS 保证不含 secret），不回显请求体。
    return runKs(c, () =>
      kc.sourceCredentialPut(ref.type, ref.id, { teamId, userId: gate.userId }, {
        provider_id: providerId,
        cred_kind: kind,
        secret,
        username,
      }),
    );
  });

  // 删除令牌
  // body: { team_id, resource_type, resource_id }
  api.post('/knowledge/source/credential/delete', mw, async (c) => {
    const ctx = buildCtx(c);
    const body = await readJson(c);
    const teamId = str(body, 'team_id');
    if (!teamId) return respondControlError(c, 400, 'MISSING_TEAM_ID');
    const ref = parseRef(body);
    if (typeof ref === 'string') return respondControlError(c, 400, ref);
    const gate = await requireTeamMember(deps, c, ctx, teamId);
    if ('error' in gate) return gate.error;
    const kc = deps.knowledgeClientFactory(ctx.instanceId);
    return runKs(c, () =>
      kc.sourceCredentialDelete(ref.type, ref.id, { teamId, userId: gate.userId }),
    );
  });
}
