/**
 * /api/v1/knowledge/wiki/* —— Panel Wiki 业务路由（stateless）。
 *
 * 实现冻结契约 docs/api/knowledge-panel-api.md §2.0 Wiki 最小端点集，透传
 * HttpKnowledgeClient → KS /v3/wiki/*。风格与 chat-memory.ts 一致：
 * validatePanelMetaHeaders → auth/verify(+team-member) → KS → envelope。
 *
 * 门控：
 *   - 带 team_id 的端点（list/create/raw/write）→ 要求 team 成员；
 *   - id-only 端点（get/ingest/delete/graph/page/search/raw/ls）→ 要求有效 caller，
 *     KS 按 x-tdai-service-id + team 逻辑隔离。
 */
import type { Hono } from 'hono';
import { validatePanelMetaHeaders } from '../../middleware/validate-panel-headers.js';
import { respondControlError } from '../../envelope.js';
import type { PanelDeps } from '../../../panel-deps.js';
import type { WikiRawWriteFile } from '../../../kernel/ports/knowledge-client-port.js';
import { respondEnvelope } from '../../envelope.js';
import {
  buildCtx,
  readJson,
  str,
  strArray,
  okEnvelope,
  requireTeamMember,
  requireKnowledgeRead,
  runKs,
  ensureKnowledgeAsset,
  deleteKnowledgeCascade,
  ASSET_TYPE_WIKI,
} from './common.js';

export function registerKnowledgeWikiRoutes(api: Hono, deps: PanelDeps): void {
  const mw = validatePanelMetaHeaders(deps);

  // W2 list — @deprecated 面板 UI 已改用 team-assets / my-assets
  api.post('/knowledge/wiki/list', mw, async (c) => {
    const ctx = buildCtx(c);
    const body = await readJson(c);
    const teamId = str(body, 'team_id');
    if (!teamId) return respondControlError(c, 400, 'MISSING_TEAM_ID');
    const gate = await requireTeamMember(deps, c, ctx, teamId);
    if ('error' in gate) return gate.error;
    const kc = deps.knowledgeClientFactory(ctx.instanceId);
    const opts = {
      status: str(body, 'status') ?? undefined,
      limit: typeof body.limit === 'number' ? body.limit : undefined,
      offset: typeof body.offset === 'number' ? body.offset : undefined,
    };
    return runKs(c, () => kc.wikiList(teamId, opts));
  });

  // W1 create — team 门控；KS create → 拿 wiki_id → 幂等登记 meta_asset（asset_id=wiki_id）
  api.post('/knowledge/wiki/create', mw, async (c) => {
    const ctx = buildCtx(c);
    const body = await readJson(c);
    const teamId = str(body, 'team_id');
    const name = str(body, 'name');
    if (!teamId) return respondControlError(c, 400, 'MISSING_TEAM_ID');
    if (!name) return respondControlError(c, 400, 'MISSING_NAME');
    const gate = await requireTeamMember(deps, c, ctx, teamId);
    if ('error' in gate) return gate.error;
    const kc = deps.knowledgeClientFactory(ctx.instanceId);
    let detail;
    try {
      detail = await kc.wikiCreate(teamId, name, gate.userId);
    } catch (err) {
      return runKs(c, () => Promise.reject(err));
    }
    // 登记 meta_asset（权限权威）；asset_id == wiki_id（外键联查约束）
    // 创建时即注册，前端可立刻看到抽取中的 wiki；callback 回来时不再重复注册。
    const reg = await ensureKnowledgeAsset(deps, ctx, {
      assetId: detail.wiki_id,
      teamId,
      assetType: ASSET_TYPE_WIKI,
      name: detail.name,
      ownerUserId: gate.userId,
      serviceUrl: detail.service_url,
    });
    if (!reg.ok) return respondEnvelope(c, reg.env); // 用户重试，KS 幂等自愈
    return respondEnvelope(c, okEnvelope(c, detail));
  });

  // W4 ingest — id-only（需 read 权限）+ 空 wiki 校验
  api.post('/knowledge/wiki/ingest', mw, async (c) => {
    const ctx = buildCtx(c);
    const body = await readJson(c);
    const wikiId = str(body, 'wiki_id');
    if (!wikiId) return respondControlError(c, 400, 'MISSING_WIKI_ID');
    const gate = await requireKnowledgeRead(deps, c, ctx, wikiId, { action: 'write' });
    if ('error' in gate) return gate.error;
    const kc = deps.knowledgeClientFactory(ctx.instanceId);
    // 空 wiki 禁止 ingest：先查 raw/ls，无源文件则拒绝
    try {
      const listing = await kc.wikiRawLs(wikiId);
      if (!listing.items || listing.items.length === 0) {
        return respondControlError(c, 400, 'WIKI_EMPTY_NO_SOURCES');
      }
    } catch {
      // raw/ls 查询失败不阻塞 ingest（KS 侧也有防御）
    }
    return runKs(c, () => kc.wikiIngest(wikiId));
  });

  // W3 get — id-only（需 read 权限）；聚合 Panel 内存 ingest progress（不新增接口）
  api.post('/knowledge/wiki/get', mw, async (c) => {
    const ctx = buildCtx(c);
    const body = await readJson(c);
    const wikiId = str(body, 'wiki_id');
    if (!wikiId) return respondControlError(c, 400, 'MISSING_WIKI_ID');
    const gate = await requireKnowledgeRead(deps, c, ctx, wikiId);
    if ('error' in gate) return gate.error;
    const kc = deps.knowledgeClientFactory(ctx.instanceId);
    return runKs(c, async () => {
      const detail = await kc.wikiGet(wikiId);
      const status = (detail as { status?: string } | null)?.status;
      const stored =
        status === 'processing' ? deps.ingestProgressStore.get(wikiId) : null;
      return {
        ...(detail as unknown as Record<string, unknown>),
        progress: stored,
      };
    });
  });

  // W5 delete — 删三处：KS + entity_knowledge 明细 + meta_asset（见 §0.6）
  api.post('/knowledge/wiki/delete', mw, async (c) => {
    const ctx = buildCtx(c);
    const body = await readJson(c);
    const wikiIds = strArray(body, 'wiki_ids');
    if (wikiIds.length === 0) return respondControlError(c, 400, 'MISSING_WIKI_ID');
    for (const wikiId of wikiIds) {
      const gate = await requireKnowledgeRead(deps, c, ctx, wikiId, { action: 'write' });
      if ('error' in gate) return gate.error;
    }
    const kc = deps.knowledgeClientFactory(ctx.instanceId);
    return runKs(c, async () => {
      const result = await kc.wikiDelete(wikiIds);
      await deleteKnowledgeCascade(deps, ctx, wikiIds);
      return result;
    });
  });

  // W15 graph — id-only
  api.post('/knowledge/wiki/graph', mw, async (c) => {
    const ctx = buildCtx(c);
    const body = await readJson(c);
    const wikiId = str(body, 'wiki_id');
    if (!wikiId) return respondControlError(c, 400, 'MISSING_WIKI_ID');
    const gate = await requireKnowledgeRead(deps, c, ctx, wikiId);
    if ('error' in gate) return gate.error;
    const kc = deps.knowledgeClientFactory(ctx.instanceId);
    return runKs(c, () => kc.wikiGraph(wikiId));
  });

  // W11 page/ls — id-only
  api.post('/knowledge/wiki/page/ls', mw, async (c) => {
    const ctx = buildCtx(c);
    const body = await readJson(c);
    const wikiId = str(body, 'wiki_id');
    if (!wikiId) return respondControlError(c, 400, 'MISSING_WIKI_ID');
    const gate = await requireKnowledgeRead(deps, c, ctx, wikiId);
    if ('error' in gate) return gate.error;
    const kc = deps.knowledgeClientFactory(ctx.instanceId);
    return runKs(c, () => kc.wikiPageLs(wikiId));
  });

  // W12 page/read — id-only
  api.post('/knowledge/wiki/page/read', mw, async (c) => {
    const ctx = buildCtx(c);
    const body = await readJson(c);
    const wikiId = str(body, 'wiki_id');
    const refs = strArray(body, 'refs');
    if (!wikiId) return respondControlError(c, 400, 'MISSING_WIKI_ID');
    if (refs.length === 0) return respondControlError(c, 400, 'MISSING_REFS');
    const gate = await requireKnowledgeRead(deps, c, ctx, wikiId);
    if ('error' in gate) return gate.error;
    const kc = deps.knowledgeClientFactory(ctx.instanceId);
    return runKs(c, () => kc.wikiPageRead(wikiId, refs));
  });

  // W14 page/rm — id-only + write 权限；KS 需要 team_id，来自 meta_asset.team_id
  api.post('/knowledge/wiki/page/rm', mw, async (c) => {
    const ctx = buildCtx(c);
    const body = await readJson(c);
    const wikiId = str(body, 'wiki_id');
    const refs = strArray(body, 'refs');
    if (!wikiId) return respondControlError(c, 400, 'MISSING_WIKI_ID');
    if (refs.length === 0) return respondControlError(c, 400, 'MISSING_REFS');
    const gate = await requireKnowledgeRead(deps, c, ctx, wikiId, { action: 'write' });
    if ('error' in gate) return gate.error;
    const teamId = gate.asset?.team_id;
    if (!teamId) return respondControlError(c, 400, 'MISSING_TEAM_ID');
    const kc = deps.knowledgeClientFactory(ctx.instanceId);
    return runKs(c, () => kc.wikiPageRm(teamId, wikiId, refs, gate.userId));
  });

  // W16 search — id-only
  api.post('/knowledge/wiki/search', mw, async (c) => {
    const ctx = buildCtx(c);
    const body = await readJson(c);
    const wikiId = str(body, 'wiki_id');
    const query = str(body, 'query');
    if (!wikiId) return respondControlError(c, 400, 'MISSING_WIKI_ID');
    if (!query) return respondControlError(c, 400, 'MISSING_QUERY');
    const gate = await requireKnowledgeRead(deps, c, ctx, wikiId);
    if ('error' in gate) return gate.error;
    const limit = typeof body.limit === 'number' ? body.limit : undefined;
    const kc = deps.knowledgeClientFactory(ctx.instanceId);
    return runKs(c, () => kc.wikiSearch(wikiId, query, limit));
  });

  // W7 raw/ls — id-only
  api.post('/knowledge/wiki/raw/ls', mw, async (c) => {
    const ctx = buildCtx(c);
    const body = await readJson(c);
    const wikiId = str(body, 'wiki_id');
    if (!wikiId) return respondControlError(c, 400, 'MISSING_WIKI_ID');
    const gate = await requireKnowledgeRead(deps, c, ctx, wikiId);
    if ('error' in gate) return gate.error;
    const kc = deps.knowledgeClientFactory(ctx.instanceId);
    return runKs(c, () => kc.wikiRawLs(wikiId));
  });

  // W8 raw/read — id-only
  api.post('/knowledge/wiki/raw/read', mw, async (c) => {
    const ctx = buildCtx(c);
    const body = await readJson(c);
    const wikiId = str(body, 'wiki_id');
    if (!wikiId) return respondControlError(c, 400, 'MISSING_WIKI_ID');
    const filenames = Array.isArray(body.filenames) ? (body.filenames as string[]) : [];
    if (filenames.length === 0) return respondControlError(c, 400, 'MISSING_FILENAMES');
    const gate = await requireKnowledgeRead(deps, c, ctx, wikiId);
    if ('error' in gate) return gate.error;
    const kc = deps.knowledgeClientFactory(ctx.instanceId);
    return runKs(c, () => kc.wikiRawRead(wikiId, filenames));
  });

  // W10 raw/rm — id-only + write 权限；KS 需要 team_id，来自 meta_asset.team_id
  api.post('/knowledge/wiki/raw/rm', mw, async (c) => {
    const ctx = buildCtx(c);
    const body = await readJson(c);
    const wikiId = str(body, 'wiki_id');
    if (!wikiId) return respondControlError(c, 400, 'MISSING_WIKI_ID');
    const filenames = Array.isArray(body.filenames) ? (body.filenames as string[]) : [];
    if (filenames.length === 0) return respondControlError(c, 400, 'MISSING_FILENAMES');
    const gate = await requireKnowledgeRead(deps, c, ctx, wikiId, { action: 'write' });
    if ('error' in gate) return gate.error;
    const teamId = gate.asset?.team_id;
    if (!teamId) return respondControlError(c, 400, 'MISSING_TEAM_ID');
    const kc = deps.knowledgeClientFactory(ctx.instanceId);
    return runKs(c, () => kc.wikiRawRm(teamId, wikiId, filenames, gate.userId));
  });

  // W9 raw/write — team 门控 + 上传大小限制
  const MAX_FILE_SIZE = 512 * 1024;        // 单文件 512KB
  const MAX_FILES_PER_REQUEST = 10;        // 单次最多 10 个文件
  const MAX_TOTAL_SIZE = 5 * 1024 * 1024;  // 单次总大小 5MB

  api.post('/knowledge/wiki/raw/write', mw, async (c) => {
    const ctx = buildCtx(c);
    const body = await readJson(c);
    const teamId = str(body, 'team_id');
    const wikiId = str(body, 'wiki_id');
    if (!teamId) return respondControlError(c, 400, 'MISSING_TEAM_ID');
    if (!wikiId) return respondControlError(c, 400, 'MISSING_WIKI_ID');
    const files = Array.isArray(body.files) ? (body.files as WikiRawWriteFile[]) : [];
    if (files.length === 0) return respondControlError(c, 400, 'MISSING_FILES');
    if (files.length > MAX_FILES_PER_REQUEST) {
      return respondControlError(c, 413, `TOO_MANY_FILES (max ${MAX_FILES_PER_REQUEST})`);
    }
    let totalSize = 0;
    for (const f of files) {
      const size = Buffer.byteLength(f.content ?? '', 'utf-8');
      if (size > MAX_FILE_SIZE) {
        return respondControlError(c, 413, `FILE_TOO_LARGE (max ${MAX_FILE_SIZE} bytes, got ${size})`);
      }
      totalSize += size;
    }
    if (totalSize > MAX_TOTAL_SIZE) {
      return respondControlError(c, 413, `TOTAL_TOO_LARGE (max ${MAX_TOTAL_SIZE} bytes, got ${totalSize})`);
    }
    const gate = await requireTeamMember(deps, c, ctx, teamId);
    if ('error' in gate) return gate.error;
    const kc = deps.knowledgeClientFactory(ctx.instanceId);
    return runKs(c, () => kc.wikiRawWrite(teamId, wikiId, files, gate.userId));
  });
}
