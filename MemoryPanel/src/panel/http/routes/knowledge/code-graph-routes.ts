/**
 * /api/v1/knowledge/code-graph/* —— Panel Code-Graph 业务路由（stateless）。
 *
 * 实现冻结契约 docs/api/knowledge-panel-api.md §2.0 Code 最小端点集，透传
 * HttpKnowledgeClient → KS /v3/code-graph/*。查询端点（search/explore）统一
 * 返回 KS 的 { text, isError } 文本块。
 */
import type { Hono } from 'hono';
import { validatePanelMetaHeaders } from '../../middleware/validate-panel-headers.js';
import { respondControlError } from '../../envelope.js';
import type { PanelDeps } from '../../../panel-deps.js';
import { CoreUpstreamError } from '../../../domain/errors.js';
import { toKernelCredentials, type MetaCallContext } from '../../../kernel/types.js';
import { respondEnvelope } from '../../envelope.js';
import {
  buildCtx,
  readJson,
  str,
  strArray,
  okEnvelope,
  requireTeamMember,
  requireKnowledgeRead,
  resolveCallerUserId,
  isTeamMember,
  runKs,
  ensureKnowledgeAsset,
  deleteCodeGraphCascadeChecked,
  ASSET_TYPE_CODE_GRAPH,
} from './common.js';
import { tryWithCodeGraphLifecycleLock, withCodeGraphLifecycleLock } from './code-graph-lifecycle-lock.js';

export function registerKnowledgeCodeGraphRoutes(api: Hono, deps: PanelDeps): void {
  const mw = validatePanelMetaHeaders(deps);
  const removeMatchingMeta = async (ctx: MetaCallContext, id: string, teamId: string, ownerUserId: string): Promise<void> => {
    const current = await deps.metaKernel.invoke('asset/get', { asset_id: id }, ctx);
    const asset = current.data as { asset_id?: string; asset_type?: string; team_id?: string; owner_user_id?: string } | null;
    if (current.code === 0 && asset?.asset_id === id && asset.asset_type === ASSET_TYPE_CODE_GRAPH &&
        asset.team_id === teamId && asset.owner_user_id === ownerUserId) {
      await deps.metaKernel.invoke('asset/delete', { asset_ids: [id] }, ctx);
    }
  };

  // C2 list — @deprecated 面板 UI 已改用 team-assets / my-assets
  api.post('/knowledge/code-graph/list', mw, async (c) => {
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
    return runKs(c, () => kc.codeGraphList(teamId, opts));
  });

  // C1 create — team 门控；KS create 后自动 build，meta 在 ready callback 登记
  api.post('/knowledge/code-graph/create', mw, async (c) => {
    const ctx = buildCtx(c);
    const body = await readJson(c);
    const teamId = str(body, 'team_id');
    const repoUrl = str(body, 'repo_url');
    if (!teamId) return respondControlError(c, 400, 'MISSING_TEAM_ID');
    if (!repoUrl) return respondControlError(c, 400, 'MISSING_REPO_URL');
    const gate = await requireTeamMember(deps, c, ctx, teamId);
    if ('error' in gate) return gate.error;
    const branch = str(body, 'branch') ?? undefined;
    const repoName = str(body, 'repo_name') ?? undefined;
    const kc = deps.knowledgeClientFactory(ctx.instanceId);
    try {
      const detail = await kc.codeGraphCreate(teamId, repoUrl, branch, gate.userId, repoName);
      // stash owner key 供 status-callback ready 时以 owner 身份注册 meta asset
      // （callback 是 S2S、无 user_key；详见 knowledge-task-registry.ts）
      // KS create is idempotent by repository and branch. A teammate may get
      // back somebody else's existing asset; their key must never replace the
      // actual owner's key in the callback registry.
      if (ctx.userKey && detail.team_id === teamId && detail.owner_user_id === gate.userId) {
        deps.knowledgeTaskRegistry.record({
          knowledge_id: detail.code_graph_id,
          type: 'code-graph',
          team_id: teamId,
          owner_user_id: gate.userId,
          owner_user_key: ctx.userKey,
          service_id: ctx.instanceId,
          created_at: Date.now(),
        });
        deps.logger.info('[code-graph/create] stashed owner key for S2S meta register', {
          knowledge_id: detail.code_graph_id, team_id: teamId, owner: gate.userId,
        });
        // A very fast build can send its ready callback before this request
        // records the key. Re-read after stashing: if it is already ready,
        // register with the verified owner's key here. If it is still
        // building, the later callback will find the stash.
        let deletedDuringRegistration = false;
        try {
          const locked = await tryWithCodeGraphLifecycleLock(ctx.instanceId, detail.code_graph_id, async () => {
            const latest = await kc.codeGraphGet(detail.code_graph_id);
            if (
              latest.status === 'ready' &&
              latest.code_graph_id === detail.code_graph_id &&
              latest.team_id === teamId &&
              latest.owner_user_id === gate.userId &&
              latest.service_url
            ) {
              let registered = false;
              try {
                const reg = await ensureKnowledgeAsset(deps, ctx, {
                  assetId: latest.code_graph_id,
                  teamId: latest.team_id,
                  assetType: ASSET_TYPE_CODE_GRAPH,
                  name: latest.repo_name || latest.repo_url,
                  ownerUserId: gate.userId,
                  serviceUrl: latest.service_url,
                });
                registered = reg.ok;
              } catch (err) {
                deps.logger.warn('[code-graph/create] meta registration result unknown', {
                  knowledge_id: detail.code_graph_id, error: err instanceof Error ? err.message : String(err),
                });
              }
              // A remote asset/create may have committed even if its reply was
              // lost. Always settle the KS ordering before leaving this path.
              try {
                const confirmed = await kc.codeGraphGet(detail.code_graph_id);
                if (confirmed.code_graph_id !== detail.code_graph_id || confirmed.team_id !== teamId ||
                    confirmed.owner_user_id !== gate.userId) return;
              }
              catch (err) {
                if (err instanceof CoreUpstreamError && err.httpStatus === 404) {
                  await removeMatchingMeta(ctx, detail.code_graph_id, teamId, gate.userId);
                  deletedDuringRegistration = true;
                  return;
                }
                throw err;
              }
              if (registered) deps.knowledgeTaskRegistry.take(detail.code_graph_id);
            }
          });
          if (!locked.acquired) return respondControlError(c, 409, 'CODE_GRAPH_BUSY');
        } catch (err) {
          deps.logger.warn('[code-graph/create] ready-state meta register check failed', {
            knowledge_id: detail.code_graph_id,
            error: err instanceof Error ? err.message : String(err),
          });
          if (err instanceof CoreUpstreamError && err.httpStatus === 404) {
            return respondControlError(c, 409, 'CODE_GRAPH_DELETED_DURING_CREATE');
          }
        }
        if (deletedDuringRegistration) return respondControlError(c, 409, 'CODE_GRAPH_DELETED_DURING_CREATE');
      } else {
        deps.logger.warn('[code-graph/create] cannot stash callback credential without matching KS owner and team', {
          knowledge_id: detail.code_graph_id, requested_team_id: teamId,
          ks_team_id: detail.team_id, ks_owner_user_id: detail.owner_user_id, caller_user_id: gate.userId,
        });
      }
      return respondEnvelope(c, okEnvelope(c, detail));
    } catch (err) {
      return runKs(c, () => Promise.reject(err));
    }
  });

  // C3b register-meta — code ready 后 owner 登记 meta（create 时不写 meta）
  api.post('/knowledge/code-graph/register-meta', mw, async (c) => {
    const ctx = buildCtx(c);
    const log = deps.logger;
    const body = await readJson(c);
    const teamId = str(body, 'team_id');
    const cgId = str(body, 'code_graph_id');
    if (!teamId) return respondControlError(c, 400, 'MISSING_TEAM_ID');
    if (!cgId) return respondControlError(c, 400, 'MISSING_CODE_GRAPH_ID');
    log.info('[code-graph/register-meta] invoked (frontend fallback)', { code_graph_id: cgId, team_id: teamId });
    const gate = await requireTeamMember(deps, c, ctx, teamId);
    if ('error' in gate) return gate.error;
    const readGate = await requireKnowledgeRead(deps, c, ctx, cgId, { allowInFlightCodeOwner: true, verifyCodeGraphIdentity: true });
    if ('error' in readGate) return readGate.error;
    const kc = deps.knowledgeClientFactory(ctx.instanceId);
    return withCodeGraphLifecycleLock(ctx.instanceId, cgId, async () => {
      let detail;
      try { detail = await kc.codeGraphGet(cgId); }
      catch (err) { return runKs(c, () => Promise.reject(err)); }
      if (detail.status !== 'ready') {
        log.warn('[code-graph/register-meta] not ready → 409', { code_graph_id: cgId, status: detail.status });
        return respondControlError(c, 409, 'CODE_GRAPH_NOT_READY');
      }
      if (detail.code_graph_id !== cgId || detail.team_id !== teamId || detail.owner_user_id !== gate.userId) {
        return respondControlError(c, 403, 'KNOWLEDGE_IDENTITY_MISMATCH');
      }
      log.info('[code-graph/register-meta] gating passed; registering meta asset', {
        code_graph_id: cgId, owner: gate.userId,
      });
      let reg: Awaited<ReturnType<typeof ensureKnowledgeAsset>> | undefined;
      try {
        reg = await ensureKnowledgeAsset(deps, ctx, {
          assetId: detail.code_graph_id,
          teamId: detail.team_id,
          assetType: ASSET_TYPE_CODE_GRAPH,
          name: detail.repo_name || detail.repo_url,
          ownerUserId: gate.userId,
          serviceUrl: detail.service_url,
        });
      } catch (err) {
        log.warn('[code-graph/register-meta] meta registration result unknown', {
          code_graph_id: cgId, error: err instanceof Error ? err.message : String(err),
        });
      }
      // The remote create may have committed even if its reply failed. A KS
      // 404 after the write attempt requires an identity-checked cleanup.
      try {
        const confirmed = await kc.codeGraphGet(cgId);
        if (confirmed.code_graph_id !== cgId || confirmed.team_id !== teamId || confirmed.owner_user_id !== gate.userId) {
          return respondControlError(c, 403, 'KNOWLEDGE_IDENTITY_MISMATCH');
        }
      }
      catch (err) {
        if (err instanceof CoreUpstreamError && err.httpStatus === 404) {
          await removeMatchingMeta(ctx, cgId, teamId, gate.userId);
          return respondControlError(c, 409, 'CODE_GRAPH_DELETED_DURING_REGISTER');
        }
        return runKs(c, () => Promise.reject(err));
      }
      if (!reg) return respondControlError(c, 502, 'UPSTREAM_ERROR');
      if (!reg.ok) return respondEnvelope(c, reg.env);
      return respondEnvelope(c, okEnvelope(c, { registered: true, code_graph_id: cgId }));
    });
  });

  // C3 get — id-only（构建中无 meta 时 owner 可读）
  api.post('/knowledge/code-graph/get', mw, async (c) => {
    const ctx = buildCtx(c);
    const body = await readJson(c);
    const cgId = str(body, 'code_graph_id');
    if (!cgId) return respondControlError(c, 400, 'MISSING_CODE_GRAPH_ID');
    const gate = await requireKnowledgeRead(deps, c, ctx, cgId, { allowInFlightCodeOwner: true, verifyCodeGraphIdentity: true });
    if ('error' in gate) return gate.error;
    const kc = deps.knowledgeClientFactory(ctx.instanceId);
    return runKs(c, () => kc.codeGraphGet(cgId));
  });

  // C4 sync — id-only
  api.post('/knowledge/code-graph/sync', mw, async (c) => {
    const ctx = buildCtx(c);
    const body = await readJson(c);
    const cgId = str(body, 'code_graph_id');
    if (!cgId) return respondControlError(c, 400, 'MISSING_CODE_GRAPH_ID');
    const gate = await requireKnowledgeRead(deps, c, ctx, cgId, { action: 'write', allowInFlightCodeOwner: true, verifyCodeGraphIdentity: true });
    if ('error' in gate) return gate.error;
    const kc = deps.knowledgeClientFactory(ctx.instanceId);
    return runKs(c, () => kc.codeGraphSync(cgId));
  });

  // C5 delete — 删三处：KS + entity_knowledge 明细 + meta_asset（见 §0.6）
  api.post('/knowledge/code-graph/delete', mw, async (c) => {
    const ctx = buildCtx(c);
    const body = await readJson(c);
    const cgIds = strArray(body, 'code_graph_ids');
    if (cgIds.length === 0) return respondControlError(c, 400, 'MISSING_CODE_GRAPH_ID');
    const authorizedIds: Array<{ id: string; teamId: string; hasCodeGraphMeta: boolean; ksAlreadyGone: boolean }> = [];
    const alreadyAbsent: Array<{ id: string; reason: string }> = [];
    const kc = deps.knowledgeClientFactory(ctx.instanceId);
    const callerUserId = await resolveCallerUserId(deps, ctx);
    if (!callerUserId) return respondControlError(c, 401, 'INVALID_USER_KEY');
    type CoreCodeGraph = { knowledge_id: string; type: string; team_id: string; user_id: string | null };
    const coreIdentity = async (id: string): Promise<CoreCodeGraph | null> => {
      const cred = toKernelCredentials(ctx, { timeoutMs: deps.config.metadataRemoteTimeoutMs }, { omitUserKey: true });
      const env = await deps.kernelHttp.postEnvelope<CoreCodeGraph>(
        '/v3/knowledge/get', { knowledge_id: id }, cred,
      );
      if (env.code === 404) return null;
      if (env.code !== 0 || !env.data) throw new Error(`Core knowledge/get failed for ${id}`);
      return env.data;
    };
    for (const cgId of cgIds) {
      const gate = await requireKnowledgeRead(deps, c, ctx, cgId, {
        action: 'write',
        allowInFlightCodeOwner: true,
        verifyCodeGraphIdentity: true,
        allowMissingCodeGraph: true,
      });
      if ('error' in gate) {
        if (gate.error.status === 404) {
          // With no meta and no KS row, an earlier delete may still have a
          // Core detail to clean. Confirm both are absent before trusting the
          // Core detail as an owner/team authorization anchor.
          try {
            const meta = await deps.metaKernel.invoke('asset/get', { asset_id: cgId }, ctx);
            if (meta.code !== 404) return gate.error;
            try {
              await kc.codeGraphGet(cgId);
              return gate.error;
            } catch (err) {
              if (!(err instanceof CoreUpstreamError) || err.httpStatus !== 404) {
                return runKs(c, () => Promise.reject(err));
              }
            }
            const core = await coreIdentity(cgId);
            if (core && core.knowledge_id === cgId && core.type === 'code-graph' &&
                core.user_id === callerUserId && await isTeamMember(deps, ctx, core.team_id, callerUserId)) {
              authorizedIds.push({ id: cgId, teamId: core.team_id, hasCodeGraphMeta: false, ksAlreadyGone: true });
            } else {
              alreadyAbsent.push({ id: cgId, reason: 'not found' });
            }
            continue;
          } catch {
            return respondControlError(c, 502, 'UPSTREAM_ERROR');
          }
        }
        return gate.error;
      }
      if (gate.asset && gate.asset.asset_type !== ASSET_TYPE_CODE_GRAPH) {
        return respondControlError(c, 404, 'KNOWLEDGE_NOT_FOUND');
      }
      // Core's asset/delete requires the owner even when acl/check grants
      // write. Check before deleting anything in KS so the cascade cannot
      // stop with a live meta binding to an already removed CodeGraph.
      if (gate.asset && gate.asset.owner_user_id !== gate.userId) {
        return respondControlError(c, 403, 'NOT_RESOURCE_OWNER');
      }
      // Core's id-only delete is unscoped as well. A conflicting Core detail
      // must not be removed even when KS and meta identities are valid.
      try {
        const core = await coreIdentity(cgId);
        const sourceTeam = gate.codeGraphDetail?.team_id ?? gate.asset?.team_id;
        if (core && (core.knowledge_id !== cgId || core.type !== 'code-graph' ||
            core.user_id !== gate.userId || core.team_id !== sourceTeam)) {
          return respondControlError(c, 403, 'KNOWLEDGE_IDENTITY_MISMATCH');
        }
      } catch {
        return respondControlError(c, 502, 'UPSTREAM_ERROR');
      }
      const sourceTeam = gate.codeGraphDetail?.team_id ?? gate.asset?.team_id;
      if (!sourceTeam) return respondControlError(c, 502, 'KNOWLEDGE_TEAM_UNKNOWN');
      authorizedIds.push({ id: cgId, teamId: sourceTeam, hasCodeGraphMeta: !!gate.asset, ksAlreadyGone: !!gate.codeGraphMissing });
    }
    return runKs(c, async () => {
      const deletedIds: string[] = [];
      const failed: Array<{ id: string; reason: string }> = [...alreadyAbsent];
      // A KS batch can span many assets and exceed the client's deadline after
      // some rows were already committed. Commit each Core/meta cascade beside
      // its single-asset KS result so a later failure cannot strand earlier IDs.
      for (const { id: cgId, teamId, hasCodeGraphMeta, ksAlreadyGone } of authorizedIds) {
        const locked = await tryWithCodeGraphLifecycleLock(ctx.instanceId, cgId, async () => {
          const result = await kc.codeGraphDelete([cgId]);
          const alreadyGone = (hasCodeGraphMeta || ksAlreadyGone) && result.failed.some((item) =>
            item.id === cgId && (item.reason === 'not found' || item.reason === 'not_found'));
          if (result.deleted_ids.includes(cgId) || alreadyGone) {
            if (await deleteCodeGraphCascadeChecked(deps, ctx, cgId, teamId)) deletedIds.push(cgId);
            else failed.push({ id: cgId, reason: 'remote cleanup failed; retry' });
          } else {
            failed.push(result.failed.find((item) => item.id === cgId) ?? { id: cgId, reason: 'delete failed' });
          }
        });
        if (!locked.acquired) failed.push({ id: cgId, reason: 'busy' });
      }
      return { deleted_ids: deletedIds, failed };
    });
  });

  // C7 search — id-only; before meta registration, only KS owner + team member may query.
  api.post('/knowledge/code-graph/search', mw, async (c) => {
    const ctx = buildCtx(c);
    const body = await readJson(c);
    const cgId = str(body, 'code_graph_id');
    const query = str(body, 'query');
    if (!cgId) return respondControlError(c, 400, 'MISSING_CODE_GRAPH_ID');
    if (!query) return respondControlError(c, 400, 'MISSING_QUERY');
    const gate = await requireKnowledgeRead(deps, c, ctx, cgId, { allowInFlightCodeOwner: true, verifyCodeGraphIdentity: true });
    if ('error' in gate) return gate.error;
    const params: Record<string, unknown> = { query };
    if (str(body, 'kind')) params.kind = str(body, 'kind');
    if (typeof body.limit === 'number') params.limit = body.limit;
    const kc = deps.knowledgeClientFactory(ctx.instanceId);
    return runKs(c, () => kc.codeGraphQuery(cgId, 'search', params));
  });

  // C8 explore — same owner fallback as search while the first build has no meta.
  api.post('/knowledge/code-graph/explore', mw, async (c) => {
    const ctx = buildCtx(c);
    const body = await readJson(c);
    const cgId = str(body, 'code_graph_id');
    const query = str(body, 'query');
    if (!cgId) return respondControlError(c, 400, 'MISSING_CODE_GRAPH_ID');
    if (!query) return respondControlError(c, 400, 'MISSING_QUERY');
    const gate = await requireKnowledgeRead(deps, c, ctx, cgId, { allowInFlightCodeOwner: true, verifyCodeGraphIdentity: true });
    if ('error' in gate) return gate.error;
    const params: Record<string, unknown> = { query };
    if (typeof body.maxFiles === 'number') params.maxFiles = body.maxFiles;
    const kc = deps.knowledgeClientFactory(ctx.instanceId);
    return runKs(c, () => kc.codeGraphQuery(cgId, 'explore', params));
  });
}
