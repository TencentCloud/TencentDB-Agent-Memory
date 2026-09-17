/**
 * Knowledge Panel 路由共享助手。
 *
 * 与 chat-memory.ts 同款风格：从 panelMeta 组 ctx、auth/verify 反查 caller、
 * team-member/get 门控、统一 envelope。KS 上游错误（CoreUpstreamError/DomainError）
 * 映射为 Control envelope。
 */
import type { Context } from 'hono';
import type { PanelDeps } from '../../../panel-deps.js';
import { toKernelCredentials, type MetaCallContext } from '../../../kernel/types.js';
import type { MetaEnvelope } from '../../../kernel/envelope.js';
import { DomainError } from '../../../domain/errors.js';
import { respondControlError, respondEnvelope } from '../../envelope.js';

export function buildCtx(c: Context): MetaCallContext {
  const panelMeta = c.get('panelMeta');
  return {
    instanceId: panelMeta.instanceId,
    gatewayEndpoint: panelMeta.gatewayEndpoint,
    gatewayApiKey: panelMeta.gatewayApiKey,
    userKey: panelMeta.userKey,
    reqId: c.get('reqId'),
  };
}

export async function readJson(c: Context): Promise<Record<string, unknown>> {
  try {
    return (await c.req.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function str(body: Record<string, unknown>, key: string): string | null {
  const v = body?.[key];
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

export function strArray(body: Record<string, unknown>, key: string): string[] {
  const v = body?.[key];
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0);
}

export function okEnvelope<T>(c: Context, data: T): MetaEnvelope<T> {
  return { code: 0, message: 'ok', request_id: c.get('reqId') ?? '', data };
}

export function extractListItems<T>(env: MetaEnvelope<unknown>): T[] {
  const d = env.data as { items?: unknown } | null;
  if (d && Array.isArray(d.items)) return d.items as T[];
  return [];
}

/** 通过 auth/verify 反查 caller 的 user_id。失败返 null。 */
export async function resolveCallerUserId(
  deps: PanelDeps,
  ctx: MetaCallContext,
): Promise<string | null> {
  if (!ctx.userKey) return null;
  const env = await deps.metaKernel.invoke('auth/verify', { user_key: ctx.userKey }, ctx);
  if (env.code !== 0) return null;
  const data = env.data as { valid?: boolean; user?: { user_id?: string } } | null;
  if (!data?.valid) return null;
  const uid = data.user?.user_id;
  return typeof uid === 'string' && uid.length > 0 ? uid : null;
}

/** 判断当前 caller 是否为 system_admin（auth/verify 返回 user.user_type）。失败保守返 false。 */
export async function isCallerSystemAdmin(
  deps: PanelDeps,
  ctx: MetaCallContext,
): Promise<boolean> {
  if (!ctx.userKey) return false;
  const env = await deps.metaKernel.invoke('auth/verify', { user_key: ctx.userKey }, ctx);
  if (env.code !== 0) return false;
  const data = env.data as { valid?: boolean; user?: { user_type?: string } } | null;
  return data?.valid === true && data.user?.user_type === 'system_admin';
}

/** 校验 user 是否是 team 成员（team-member/get 存在→成员）。异常保守返 false。 */
export async function isTeamMember(
  deps: PanelDeps,
  ctx: MetaCallContext,
  teamId: string,
  userId: string,
): Promise<boolean> {
  if (!teamId || !userId) return false;
  try {
    const env = await deps.metaKernel.invoke('team-member/get', { team_id: teamId, user_id: userId }, ctx);
    return env.code === 0 && !!env.data;
  } catch {
    return false;
  }
}

/**
 * team 门控：要求 caller 是有效用户且为 team 成员。
 * 通过返回 { userId }；不通过返回 { error: Response }（路由直接 return）。
 */
export async function requireTeamMember(
  deps: PanelDeps,
  c: Context,
  ctx: MetaCallContext,
  teamId: string,
): Promise<{ userId: string } | { error: Response }> {
  const userId = await resolveCallerUserId(deps, ctx);
  if (!userId) return { error: respondControlError(c, 401, 'INVALID_USER_KEY') };
  const member = await isTeamMember(deps, ctx, teamId, userId);
  if (!member) return { error: respondControlError(c, 403, 'NOT_TEAM_MEMBER') };
  return { userId };
}

/** id-only 端点门控：仅要求 caller 是有效用户（KS 按 service_id + team 隔离）。 */
export async function requireCaller(
  deps: PanelDeps,
  c: Context,
  ctx: MetaCallContext,
): Promise<{ userId: string } | { error: Response }> {
  const userId = await resolveCallerUserId(deps, ctx);
  if (!userId) return { error: respondControlError(c, 401, 'INVALID_USER_KEY') };
  return { userId };
}

/**
 * 把 KS 调用包起来：成功 → okEnvelope；上游/领域错误 → 映射 Control envelope。
 */
export async function runKs<T>(
  c: Context,
  fn: () => Promise<T>,
): Promise<Response> {
  try {
    const data = await fn();
    return respondEnvelope(c, okEnvelope(c, data));
  } catch (err) {
    if (err instanceof DomainError) {
      return respondControlError(c, err.httpStatus, err.message || err.code);
    }
    return respondControlError(c, 502, 'UPSTREAM_ERROR');
  }
}

// ── meta_asset 生命周期（见设计 §0.6）────────────────────────────
// asset_id == knowledge_id（wiki_id / cg_id），asset_type 映射如下。
export const ASSET_TYPE_WIKI = 'llm_wiki';
export const ASSET_TYPE_CODE_GRAPH = 'code_graph';

/**
 * create 时（ForCaller）幂等登记 meta_asset：asset_id = KS 返回的 knowledge_id。
 * 已存在（同名 KS 幂等复用）→ 跳过；不存在 → asset/create。
 * 失败返回 { ok:false, env }，路由据此报错（用户重试，KS 幂等自愈）。
 */
export async function ensureKnowledgeAsset(
  deps: PanelDeps,
  ctx: MetaCallContext,
  params: {
    assetId: string;
    teamId: string;
    assetType: typeof ASSET_TYPE_WIKI | typeof ASSET_TYPE_CODE_GRAPH;
    name: string;
    ownerUserId: string;
    serviceUrl?: string | null;
  },
): Promise<{ ok: true } | { ok: false; env: MetaEnvelope<unknown> }> {
  const log = deps.logger;
  const getEnv = await deps.metaKernel.invoke('asset/get', { asset_id: params.assetId }, ctx);
  if (getEnv.code === 0 && getEnv.data) {
    log.info('[ensure-knowledge-asset] already present; idempotent skip', {
      asset_id: params.assetId, asset_type: params.assetType, team_id: params.teamId,
    });
    return { ok: true }; // 幂等：已存在
  }
  log.info('[ensure-knowledge-asset] not present; creating', {
    asset_id: params.assetId, asset_type: params.assetType, team_id: params.teamId, owner: params.ownerUserId,
  });
  const createEnv = await deps.metaKernel.invoke(
    'asset/create',
    {
      asset_id: params.assetId,
      team_id: params.teamId,
      asset_type: params.assetType,
      name: params.name,
      owner_user_id: params.ownerUserId,
      source_type: 'manual',
      visibility: 'team',
      content_ref: params.serviceUrl ?? undefined,
    },
    ctx,
  );
  if (createEnv.code !== 0) {
    log.error('[ensure-knowledge-asset] asset/create rejected', {
      asset_id: params.assetId, code: createEnv.code, message: createEnv.message,
    });
    return { ok: false, env: createEnv };
  }
  log.info('[ensure-knowledge-asset] created', { asset_id: params.assetId, visibility: 'team' });
  return { ok: true };
}

/** 删除内核明细 entity_knowledge（S2S，/v3/knowledge/delete）。best-effort，不抛。 */
export async function deleteKnowledgeDetail(
  deps: PanelDeps,
  ctx: MetaCallContext,
  ids: string[],
): Promise<void> {
  try {
    const cred = toKernelCredentials(ctx, { timeoutMs: deps.config.metadataRemoteTimeoutMs }, { omitUserKey: true });
    await deps.kernelHttp.postEnvelope('/v3/knowledge/delete', { knowledge_ids: ids }, cred);
  } catch {
    /* best-effort */
  }
}

/** 删除 meta_asset（ForCaller，asset/delete）。best-effort，不抛。
 *  kernel 侧 asset/delete 会级联清理 agent-fixed-asset 绑定 + ACL，无需额外解绑。 */
export async function deleteKnowledgeAssets(
  deps: PanelDeps,
  ctx: MetaCallContext,
  ids: string[],
): Promise<void> {
  try {
    await deps.metaKernel.invoke('asset/delete', { asset_ids: ids }, ctx);
  } catch {
    /* best-effort */
  }
}

/** 删除 knowledge 的远端侧级联：entity_knowledge 明细 + meta_asset（含 agent 绑定级联）。
 *  KS 侧删除由调用方负责（返回 KS result 给前端）。两步均 best-effort，不抛。 */
export async function deleteKnowledgeCascade(
  deps: PanelDeps,
  ctx: MetaCallContext,
  ids: string[],
): Promise<void> {
  await deleteKnowledgeDetail(deps, ctx, ids);
  await deleteKnowledgeAssets(deps, ctx, ids);
}

// ── meta list 分页 + 鉴权 + KS join ─────────────────────────────

const META_LIST_PAGE = 100;
const FILTERED_ASSET_STATUSES = new Set(['archived', 'deprecated', 'failed']);

export interface KnowledgeAssetMetaRaw {
  asset_id: string;
  team_id: string;
  asset_type: string;
  name: string;
  description?: string | null;
  owner_user_id: string;
  visibility: string;
  status: string;
  created_at?: string;
  updated_at?: string;
}

/**
 * 分页拉取 meta list 全部 items（不限具体 action —— 任何返回 `{items:[], total}` 的
 * list 接口都可复用，避免单页 DEFAULT_PAGINATION=20 在资产多时被静默截断）。
 *
 * 注意：内核 `DEFAULT_PAGINATION = {limit: 20}`，调用方不传 limit 时只会拿到前 20 条；
 * 任何做「list 全量 → 改 → set 全量替换」语义的接口（如 knowledge/allocate 里的
 * agent-fixed-asset/list）必须用本工具拿到全量，否则后段老 binding 会被静默覆盖。
 *
 * 错误处理：分页中途失败时调用 `onError(env)` 并返回已收集的数据，由调用方决定
 * 是透传错误还是继续 —— 禁止静默忽略（写路径上会把错误当"空列表"做全量替换，
 * 造成数据清空）。
 */
export async function fetchAllMetaListItems<T>(
  deps: PanelDeps,
  ctx: MetaCallContext,
  action: string,
  body: Record<string, unknown>,
  onError?: (env: MetaEnvelope<unknown>) => void,
): Promise<T[]> {
  const all: T[] = [];
  let offset = 0;
  for (;;) {
    const env = await deps.metaKernel.invoke(action, { ...body, limit: META_LIST_PAGE, offset }, ctx);
    if (env.code !== 0) {
      onError?.(env);
      return all;
    }
    const batch = extractListItems<T>(env);
    all.push(...batch);
    const total = (env.data as { total?: number } | null)?.total;
    if (batch.length === 0) {
      // 空页：已到末尾（无 total 接口的唯一终止信号）。但带过滤语义的接口中间页
      // 可能整页为空（total 仍是绑定总数），此时继续推进避免漏拉。
      if (typeof total === 'number' && offset < total) {
        offset += META_LIST_PAGE;
        continue;
      }
      break;
    }
    if (typeof total === 'number' && offset + batch.length >= total) break;
    offset += META_LIST_PAGE;
  }
  return all;
}

export function isActiveMetaAsset(status: string | undefined): boolean {
  return !!status && !FILTERED_ASSET_STATUSES.has(status);
}

/** acl/check：caller 对 asset 是否有指定 action 权限。 */
export async function checkAssetPermission(
  deps: PanelDeps,
  ctx: MetaCallContext,
  userId: string,
  assetId: string,
  action: 'read' | 'write' | 'use' = 'read',
): Promise<boolean> {
  const env = await deps.metaKernel.invoke(
    'acl/check',
    { user_id: userId, asset_id: assetId, action },
    ctx,
  );
  if (env.code !== 0) return false;
  const data = env.data as { allowed?: boolean } | null;
  return !!data?.allowed;
}

/** @deprecated use checkAssetPermission */
export async function checkAssetReadPermission(
  deps: PanelDeps,
  ctx: MetaCallContext,
  userId: string,
  assetId: string,
): Promise<boolean> {
  return checkAssetPermission(deps, ctx, userId, assetId, 'read');
}

/**
 * 知识资源读门控：meta asset 存在时走 acl/check；
 * code-graph 构建中无 meta 时，仅允许 KS owner 读 get（窄例外）。
 */
export async function requireKnowledgeRead(
  deps: PanelDeps,
  c: Context,
  ctx: MetaCallContext,
  knowledgeId: string,
  opts?: { allowInFlightCodeOwner?: boolean; action?: 'read' | 'write' | 'use' },
): Promise<{ userId: string; asset?: KnowledgeAssetMetaRaw } | { error: Response }> {
  const userId = await resolveCallerUserId(deps, ctx);
  if (!userId) return { error: respondControlError(c, 401, 'INVALID_USER_KEY') };
  const action = opts?.action ?? 'read';

  const assetEnv = await deps.metaKernel.invoke('asset/get', { asset_id: knowledgeId }, ctx);
  if (assetEnv.code === 0 && assetEnv.data) {
    const asset = assetEnv.data as KnowledgeAssetMetaRaw;
    const allowed = await checkAssetPermission(deps, ctx, userId, knowledgeId, action);
    if (!allowed) return { error: respondControlError(c, 403, 'FORBIDDEN') };
    const member = await isTeamMember(deps, ctx, asset.team_id, userId);
    if (!member) return { error: respondControlError(c, 403, 'NOT_TEAM_MEMBER') };
    return { userId, asset };
  }

  if (opts?.allowInFlightCodeOwner && (action === 'read' || action === 'write')) {
    try {
      const kc = deps.knowledgeClientFactory(ctx.instanceId);
      const detail = await kc.codeGraphGet(knowledgeId);
      if (detail.owner_user_id === userId) {
        const member = await isTeamMember(deps, ctx, detail.team_id, userId);
        if (!member) return { error: respondControlError(c, 403, 'NOT_TEAM_MEMBER') };
        return { userId };
      }
    } catch {
      /* fall through */
    }
  }

  return { error: respondControlError(c, 404, 'KNOWLEDGE_NOT_FOUND') };
}

export interface KnowledgeAssetListItem {
  knowledge_id: string;
  asset_type: string;
  name: string;
  description?: string | null;
  visibility: string;
  owner_user_id: string;
  meta_status: string;
  status: string;
  internal_status?: string | null;
  sync_error?: string | null;
  ks_missing?: boolean;
  team_id?: string;
  summary?: string | null;
  page_count?: number | null;
  last_sync_at?: string | null;
  repo_name?: string;
  repo_url?: string;
  branch?: string;
  commit_hash?: string | null;
  stats?: { files: number; nodes: number; edges: number } | null;
  created_at?: string;
  updated_at?: string;
}

async function joinWikiKs(
  kc: ReturnType<PanelDeps['knowledgeClientFactory']>,
  meta: KnowledgeAssetMetaRaw,
): Promise<KnowledgeAssetListItem> {
  const base: KnowledgeAssetListItem = {
    knowledge_id: meta.asset_id,
    asset_type: meta.asset_type,
    name: meta.name,
    description: meta.description ?? null,
    visibility: meta.visibility,
    owner_user_id: meta.owner_user_id,
    meta_status: meta.status,
    status: 'missing',
    ks_missing: true,
    created_at: meta.created_at,
    updated_at: meta.updated_at,
  };
  try {
    const ks = await kc.wikiGet(meta.asset_id);
    return {
      ...base,
      team_id: ks.team_id,
      status: ks.status,
      internal_status: ks.internal_status ?? null,
      sync_error: ks.sync_error,
      summary: ks.summary,
      page_count: ks.page_count,
      last_sync_at: ks.last_sync_at,
      ks_missing: false,
      created_at: ks.created_at,
      updated_at: ks.updated_at,
    };
  } catch {
    return base;
  }
}

async function joinCodeKs(
  kc: ReturnType<PanelDeps['knowledgeClientFactory']>,
  meta: KnowledgeAssetMetaRaw,
): Promise<KnowledgeAssetListItem> {
  const base: KnowledgeAssetListItem = {
    knowledge_id: meta.asset_id,
    asset_type: meta.asset_type,
    name: meta.name,
    description: meta.description ?? null,
    visibility: meta.visibility,
    owner_user_id: meta.owner_user_id,
    meta_status: meta.status,
    status: 'missing',
    ks_missing: true,
    created_at: meta.created_at,
    updated_at: meta.updated_at,
  };
  try {
    const ks = await kc.codeGraphGet(meta.asset_id);
    return {
      ...base,
      team_id: ks.team_id,
      name: ks.repo_name || meta.name,
      status: ks.status,
      sync_error: ks.sync_error,
      summary: ks.summary,
      repo_name: ks.repo_name,
      repo_url: ks.repo_url,
      branch: ks.branch,
      commit_hash: ks.commit_hash,
      stats: ks.stats,
      last_sync_at: ks.last_sync_at,
      ks_missing: false,
      created_at: ks.created_at,
      updated_at: ks.updated_at,
    };
  } catch {
    return base;
  }
}

export async function joinKnowledgeAssetsWithKs(
  deps: PanelDeps,
  ctx: MetaCallContext,
  assets: KnowledgeAssetMetaRaw[],
  assetType: typeof ASSET_TYPE_WIKI | typeof ASSET_TYPE_CODE_GRAPH,
): Promise<KnowledgeAssetListItem[]> {
  const kc = deps.knowledgeClientFactory(ctx.instanceId);
  const joiner = assetType === ASSET_TYPE_WIKI ? joinWikiKs : joinCodeKs;
  const settled = await Promise.allSettled(assets.map((a) => joiner(kc, a)));
  return settled.map((r, i) => {
    const meta = assets[i];
    if (r.status === 'fulfilled') return r.value;
    if (!meta) {
      return {
        knowledge_id: '',
        asset_type: assetType,
        name: '',
        visibility: 'team',
        owner_user_id: '',
        meta_status: 'unknown',
        status: 'missing',
        ks_missing: true,
      };
    }
    return {
      knowledge_id: meta.asset_id,
      asset_type: meta.asset_type,
      name: meta.name,
      visibility: meta.visibility,
      owner_user_id: meta.owner_user_id,
      meta_status: meta.status,
      status: 'missing',
      ks_missing: true,
    };
  });
}

// ── KS-only items（meta 未注册，如创建中/失败的 code-graph）──────────

/** 从 KS 侧查列表，构造 meta 未注册的 KnowledgeAssetListItem。 */
async function fetchKsOnlyItems(
  kc: ReturnType<PanelDeps['knowledgeClientFactory']>,
  teamId: string,
  assetType: typeof ASSET_TYPE_WIKI | typeof ASSET_TYPE_CODE_GRAPH,
): Promise<KnowledgeAssetListItem[]> {
  try {
    if (assetType === ASSET_TYPE_WIKI) {
      const res = await kc.wikiList(teamId);
      return res.items.map((ks) => ({
        knowledge_id: ks.wiki_id,
        asset_type: ASSET_TYPE_WIKI,
        name: ks.name,
        description: null,
        visibility: 'team',
        owner_user_id: ks.owner_user_id ?? '',
        meta_status: 'unregistered',
        status: ks.status,
        team_id: ks.team_id,
        internal_status: ks.internal_status ?? null,
        sync_error: ks.sync_error,
        summary: ks.summary,
        page_count: ks.page_count,
        last_sync_at: ks.last_sync_at,
        ks_missing: false,
        created_at: ks.created_at,
        updated_at: ks.updated_at,
      }));
    }
    const res = await kc.codeGraphList(teamId);
    return res.items.map((ks) => ({
      knowledge_id: ks.code_graph_id,
      asset_type: ASSET_TYPE_CODE_GRAPH,
      name: ks.repo_name || ks.repo_url || ks.code_graph_id,
      description: null,
      visibility: 'team',
      owner_user_id: ks.owner_user_id ?? '',
      meta_status: 'unregistered',
      status: ks.status,
      team_id: ks.team_id,
      sync_error: ks.sync_error,
      summary: ks.summary,
      repo_name: ks.repo_name,
      repo_url: ks.repo_url,
      branch: ks.branch,
      commit_hash: ks.commit_hash,
      stats: ks.stats,
      last_sync_at: ks.last_sync_at,
      ks_missing: false,
      created_at: ks.created_at,
      updated_at: ks.updated_at,
    }));
  } catch {
    return [];
  }
}

/**
 * 合并 meta 资产列表与 KS 侧列表：meta 为主，KS 补充 meta 未注册的项。
 * 用于 team-assets / my-assets 接口，确保"创建中/失败"的资源也能展示。
 *
 * 权限说明：meta 侧已由 asset/list-accessible 做权限校验；
 * KS 侧返回的是 team 级别数据，调用方已通过 requireTeamMember 校验 team 归属。
 */
export async function mergeWithKsOnlyItems(
  deps: PanelDeps,
  ctx: MetaCallContext,
  teamId: string,
  joined: KnowledgeAssetListItem[],
  assetType: typeof ASSET_TYPE_WIKI | typeof ASSET_TYPE_CODE_GRAPH,
): Promise<KnowledgeAssetListItem[]> {
  const kc = deps.knowledgeClientFactory(ctx.instanceId);
  const ksItems = await fetchKsOnlyItems(kc, teamId, assetType);
  if (ksItems.length === 0) return joined;

  const knownIds = new Set(joined.map((j) => j.knowledge_id));
  const orphans = ksItems.filter((ks) => !knownIds.has(ks.knowledge_id));
  return [...joined, ...orphans];
}
