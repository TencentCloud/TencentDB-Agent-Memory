/**
 * /api/v1/chat-memory/* —— Chat Memory 面板专用业务路由（stateless panel 架构）。
 *
 * 为什么单独一层而不是走 /meta/{action}：
 *   - 新面板 §0 决策 12.3：`asset/*` 与 `agent-fixed-asset/*` 一期在 meta pass-through
 *     里 501（NOT_IN_SCOPE）。
 *   - 但 Chat Memory 面板 3-tab 页面需要这些资产操作。本文件就是那个"12.3 决策例外"
 *     的落点：只对 chat_memory 这一类 asset 做业务化包装，跟 skill/wiki/code_graph 隔离。
 *
 * 请求约定（跟 /meta/* 相同）：
 *   - 全部 POST
 *   - Header 必带 `X-Tdai-Service-Id`（选实例）+ `X-Tdai-User-Key`（caller 身份）
 *   - 返回 envelope `{ code, message, request_id, data }`
 *
 * 内核调用：
 *   元数据层走 `deps.metaKernel.invoke(action, body, ctx)` → 内核 `/v3/meta/*`。
 *   数据面层（/layer、/import）走 `deps.kernelHttp.postEnvelope('/v3/...', body, cred)`。
 *   面板层职责：拼装 caller header、聚合多次调用、权限/类型/借入 ≤ 2 校验。
 *
 * 10 endpoints（与前端 web/src/components/ChatMemoryPanel.tsx 3 tab 对应）：
 *   POST /chat-memory/team-assets     团队 tab（visibility=team 且非 me owner）
 *   POST /chat-memory/agent-fixed     固定资产 tab（选中 agent 的 fixed_assets）
 *   POST /chat-memory/my-agents       我的资产分配 tab（我 owner 的 agent 列表）
 *   POST /chat-memory/mine            (老) owner=me 的 asset 列表
 *   POST /chat-memory/create          创建独立 UserAsset (mem-xxx)
 *   POST /chat-memory/patch-scope     改 scope（team ↔ private）
 *   POST /chat-memory/allocate        分配（借入），含 ≤ 2 校验
 *   POST /chat-memory/unbind          从 agent 解绑
 *   POST /chat-memory/layer           L0/L1/L2/L3 分层懒加载
 *   POST /chat-memory/import          导入历史对话到 agent 的 L0
 */
import type { Hono } from 'hono';
import { validatePanelMetaHeaders } from '../middleware/validate-panel-headers.js';
import { respondControlError, respondEnvelope } from '../envelope.js';
import type { PanelDeps } from '../../panel-deps.js';
import { toKernelCredentials, type MetaCallContext } from '../../kernel/types.js';
import type { MetaEnvelope } from '../../kernel/envelope.js';
import { MAX_IMPORTED_AGENTS } from '../../domain/chat-memory-governance.js';
import { newExternalAssetId } from '../../domain/asset-id.js';

// ── 内核 raw 类型（只列本文件用到的字段，避免依赖 SDK） ────────────
interface AssetRaw {
  asset_id: string;
  team_id: string;
  asset_type: string;
  name: string;
  description?: string | null;
  owner_user_id: string;
  visibility: string;
  status: string;
  updated_at: string;
}
interface AgentRaw {
  agent_id: string;
  team_id: string;
  owner_user_id: string;
  name: string;
}
interface FixedAssetRaw {
  asset_id: string;
  asset_type: string;
  injection_mode?: string;
  priority?: number;
  created_by?: string;
}
interface ListEnvelopeData<T> {
  items: T[];
  total?: number;
  limit?: number;
  offset?: number;
}

// ── 出参 shape（与前端 MemoryBlock 对齐） ─────────────────────────
interface MemoryBlockOut {
  id: string;
  title: string;
  summary: string;
  uploaded_by_user_id: string;
  updated_at_ms: number;
  layer_counts: { L0_messages: number; L1: number; L2: number; L3: number };
  scope?: 'team' | 'private';
  bound_agent_count?: number;
  agent_id?: string;
}

export function registerChatMemoryRoutes(api: Hono, deps: PanelDeps): void {
  // 4.1 团队资产 tab
  //
  // 产品语义：这个 tab 显示当前团队内所有已共享的记忆资产。
  //   - visibility=team（已共享）
  //   - 不区分 owner，自己共享出去的也应在团队资产里可见。
  api.post('/chat-memory/team-assets', validatePanelMetaHeaders(deps), async (c) => {
    const ctx = buildCtx(c);
    const teamId = requiredTeamId(await readJson(c));
    if (!teamId) return respondControlError(c, 400, 'MISSING_TEAM_ID');

    const listEnv = await deps.metaKernel.invoke(
      'asset/list',
      { team_id: teamId, asset_type: 'chat_memory', visibility: 'team' },
      ctx,
    );
    if (listEnv.code !== 0) return respondEnvelope(c, listEnv);
    const items = extractListItems<AssetRaw>(listEnv).filter(isActive);

    // perf: 列表接口不再计算 bound_agent_count（旧实现 N+1：M 条 asset × 每条
    // 一次 agent/list + 一次 summary-by-agents，20 asset 场景实测 41 次 kernel 调用，
    // 用户实测 3.5s+ 卡顿）。前端不在列表 UI 里展示该字段（layer counts / 绑定数都
    // 只在右侧详情面板出现），故直接省掉。若后续需要在列表里显示绑定数，走独立
    // 懒加载端点，不要放回主列表循环。
    const out: MemoryBlockOut[] = items.map((a) => ({
      id: a.asset_id,
      title: a.name,
      summary: buildSummary(),
      uploaded_by_user_id: a.owner_user_id,
      updated_at_ms: toMs(a.updated_at),
      layer_counts: emptyLayers(),
    }));
    return respondEnvelope(c, okEnvelope(c, { items: out, total: out.length }));
  });

  // ── 4.2 固定资产 tab ─────────────────────────────────────
  //
  // POST /chat-memory/agent-fixed  body: { agent_id }
  //
  // 返回该 agent 名下 meta_agent_fixed_assets 里 asset_type=chat_memory 的绑定。
  // 通过 /v3/meta/agent-fixed-asset/list-with-detail 一次拿到 asset 详情。
  //
  // 权限（产品定义："固定资产" = 我 owner 的 agent 的绑定资产）：
  //   1. agent.owner_user_id === me → 可见自己 agent 借入的所有 asset
  //   2. agent.owner_user_id !== me → 403 NOT_YOUR_AGENT
  //   3. 无 caller 身份 → 401
  api.post('/chat-memory/agent-fixed', validatePanelMetaHeaders(deps), async (c) => {
    const ctx = buildCtx(c);
    const body = await readJson(c);
    const agentId = typeof body?.agent_id === 'string' ? body.agent_id : '';
    if (!agentId) return respondControlError(c, 400, 'MISSING_AGENT_ID');

    const meUserId = await resolveCallerUserId(deps, ctx);
    if (!meUserId) return respondControlError(c, 401, 'INVALID_USER_KEY');

    // 查 agent 拿 owner 决定过滤策略
    const agentEnv = await deps.metaKernel.invoke('agent/get', { agent_id: agentId }, ctx);
    if (agentEnv.code === 404 || (agentEnv.code === 0 && !agentEnv.data)) {
      return respondControlError(c, 404, 'AGENT_NOT_FOUND');
    }
    if (agentEnv.code !== 0) return respondEnvelope(c, agentEnv);
    const agent = agentEnv.data as AgentRaw;
    if (agent.owner_user_id !== meUserId) {
      return respondControlError(c, 403, 'NOT_YOUR_AGENT');
    }

    // 展示策略：返回全部物理绑定（apply_visibility_filter=false），前端根据
    // scope + owner 灰化"其他人已切私密"的条目：
    //   - 记忆内容/详情：不允许查看（前端展示占位）
    //   - 解绑操作：允许（清理脏 binding 的入口）
    // 若用 filter=true 会直接把已私密条目从 items 里剔除 → 使用者永远无法
    // 知晓/清理这些残留绑定；filter=false + 前端标记是"感知 + 可清理"的更好体验。
    const listEnv = await deps.metaKernel.invoke(
      'agent-fixed-asset/list-with-detail',
      { agent_id: agentId, apply_visibility_filter: false, touch_usage: false },
      ctx,
    );
    if (listEnv.code !== 0) return respondEnvelope(c, listEnv);

    // list-with-detail 返回的 items（AgentAssetView）不带 owner_user_id
    interface FixedAssetDetailRaw {
      asset_id: string;
      asset_type: string;
      name: string;
      status: string;
      visibility: string;
      created_at: string;
    }
    const items = extractListItems<FixedAssetDetailRaw>(listEnv)
      .filter((it) => it.asset_type === 'chat_memory')
      .filter((it) => it.status !== 'archived' && it.status !== 'deprecated' && it.status !== 'failed');

    // 拿真实 owner_user_id 和 updated_at（list-with-detail 不返这两个字段）
    const out: MemoryBlockOut[] = await Promise.all(
      items.map(async (it) => {
        let ownerUserId = '';
        let updatedAt = it.created_at; // 兜底：asset/get 失败时用 created_at
        try {
          const aEnv = await deps.metaKernel.invoke('asset/get', { asset_id: it.asset_id }, ctx);
          if (aEnv.code === 0 && aEnv.data) {
            const a = aEnv.data as AssetRaw;
            ownerUserId = a.owner_user_id;
            updatedAt = a.updated_at || it.created_at;
          }
        } catch { /* fallback 空 */ }
        return {
          id: it.asset_id,
          title: it.name,
          summary: buildSummary(),
          uploaded_by_user_id: ownerUserId,
          updated_at_ms: toMs(updatedAt),
          // 透传给前端做灰化：team 正常显示，private 灰化 + 打"已被 owner 设为私密"标签
          scope: it.visibility === 'private' ? 'private' : 'team',
          // TEMP：本地测试展示用；生产应改为懒加载
          layer_counts: emptyLayers(),
          agent_id: agentId,
        };
      }),
    );
    return respondEnvelope(c, okEnvelope(c, { items: out, total: out.length }));
  });

  // ── 4.3b 我的资产分配 tab（新语义）─────────────────────────
  //
  // POST /chat-memory/my-agents  body: { team_id }
  //
  // 产品语义：一个 agent = 一块记忆，"我的资产分配"tab 显示我 owner 的所有 agent，
  // 每个 agent 上有"团队可见"开关（scope）。这里返回每个 agent 对应的 chat_memory
  // 块视图（block.id = chat_memory-{team}-{agent}，title = agent.name，
  // scope 来自该 agent 自有 chat_memory 的 visibility）。
  api.post('/chat-memory/my-agents', validatePanelMetaHeaders(deps), async (c) => {
    const ctx = buildCtx(c);
    const body = await readJson(c);
    const teamId = requiredTeamId(body);
    if (!teamId) return respondControlError(c, 400, 'MISSING_TEAM_ID');

    const meUserId = await resolveCallerUserId(deps, ctx);
    if (!meUserId) return respondControlError(c, 401, 'INVALID_USER_KEY');

    // 拉 team 下所有 agent，然后面板层按 owner=me 过滤
    // （tdai /v3/meta/agent/list 传 team_id 时会忽略 owner_user_id，需自己过滤）
    const agentEnv = await deps.metaKernel.invoke(
      'agent/list',
      { team_id: teamId, status: 'active' },
      ctx,
    );
    if (agentEnv.code !== 0) return respondEnvelope(c, agentEnv);
    const agents = extractListItems<AgentRaw & { name: string; description?: string }>(agentEnv)
      .filter((a) => a.owner_user_id === meUserId);

    // 每个 agent 对应一块记忆：查 chat_memory asset（若已 auto-mint）拿到 visibility
    const out: MemoryBlockOut[] = await Promise.all(
      agents.map(async (a) => {
        const assetId = `chat_memory-${teamId}-${a.agent_id}`;
        let visibility: 'team' | 'private' = 'private';
        let updated_at_ms = 0;
        try {
          const assetEnv = await deps.metaKernel.invoke('asset/get', { asset_id: assetId }, ctx);
          if (assetEnv.code === 0 && assetEnv.data) {
            const asset = assetEnv.data as AssetRaw;
            visibility = asset.visibility === 'team' ? 'team' : 'private';
            updated_at_ms = toMs(asset.updated_at);
          }
        } catch { /* asset 不存在 → 保留 private + 0 */ }
        return {
          id: assetId,
          title: a.name, // ← 用 agent name 作为块标题，符合"一 agent 一块记忆"
          summary: buildSummary(),
          uploaded_by_user_id: meUserId,
          updated_at_ms,
          layer_counts: emptyLayers(),
          scope: visibility,
          agent_id: a.agent_id,
        };
      }),
    );
    return respondEnvelope(c, okEnvelope(c, { items: out, total: out.length }));
  });

  // 4.3 我的资产 tab
  api.post('/chat-memory/mine', validatePanelMetaHeaders(deps), async (c) => {
    const ctx = buildCtx(c);
    const body = await readJson(c);
    const teamId = requiredTeamId(body);
    if (!teamId) return respondControlError(c, 400, 'MISSING_TEAM_ID');

    // caller = 当前 user_key 对应的 user_id（走 auth/verify 反查，不信任前端传参）
    const meUserId = await resolveCallerUserId(deps, ctx);
    if (!meUserId) return respondControlError(c, 401, 'INVALID_USER_KEY');

    const listEnv = await deps.metaKernel.invoke(
      'asset/list',
      { team_id: teamId, asset_type: 'chat_memory', owner_user_id: meUserId },
      ctx,
    );
    if (listEnv.code !== 0) return respondEnvelope(c, listEnv);
    const items = extractListItems<AssetRaw>(listEnv).filter(isActive);

    const out: MemoryBlockOut[] = await Promise.all(
      items.map(async (a) => ({
        id: a.asset_id,
        title: a.name,
        summary: buildSummary(),
        uploaded_by_user_id: a.owner_user_id,
        updated_at_ms: toMs(a.updated_at),
        // TEMP：本地测试展示用；生产应改为懒加载或前端点击时按需拉
        layer_counts: emptyLayers(),
        scope: (a.visibility === 'private' ? 'private' : 'team') as 'team' | 'private',
      })),
    );
    return respondEnvelope(c, okEnvelope(c, { items: out, total: out.length }));
  });

  // 4.7 创建 UserAsset
  //
  // tdai asset/create schema 要求 asset_id + owner_user_id 必填（不会从 header 反查），
  // 所以面板层要：
  //   1. auth/verify 拿 caller user_id
  //   2. 用 newExternalAssetId('chat_memory') 生成 mem-xxx id
  //   3. 再 asset/create
  api.post('/chat-memory/create', validatePanelMetaHeaders(deps), async (c) => {
    const ctx = buildCtx(c);
    const body = await readJson(c);
    const teamId = requiredTeamId(body);
    if (!teamId) return respondControlError(c, 400, 'MISSING_TEAM_ID');
    const title = typeof body?.title === 'string' ? body.title.trim() : '';
    if (!title || title.length > 200) {
      return respondControlError(c, 400, 'INVALID_TITLE');
    }
    const scope = body?.scope === 'private' ? 'private' : 'team';
    const description = typeof body?.description === 'string' ? body.description : undefined;

    // 反查 caller user_id
    const meUserId = await resolveCallerUserId(deps, ctx);
    if (!meUserId) return respondControlError(c, 401, 'INVALID_USER_KEY');

    const createEnv = await deps.metaKernel.invoke(
      'asset/create',
      {
        asset_id: newExternalAssetId('chat_memory'),
        team_id: teamId,
        asset_type: 'chat_memory',
        name: title,
        description,
        owner_user_id: meUserId,
        source_type: 'uploaded',
        visibility: scope,
      },
      ctx,
    );
    if (createEnv.code !== 0) return respondEnvelope(c, createEnv);
    const asset = createEnv.data as AssetRaw;
    return respondEnvelope(
      c,
      okEnvelope(c, {
        id: asset.asset_id,
        title: asset.name,
        summary: buildSummary(),
        uploaded_by_user_id: asset.owner_user_id,
        updated_at_ms: toMs(asset.updated_at),
        layer_counts: emptyLayers(),
        scope: asset.visibility === 'private' ? 'private' : 'team',
      } satisfies MemoryBlockOut),
    );
  });

  // ── 4.10 导入历史对话到 agent 记忆池 ──────────────────────
  //
  // POST /chat-memory/import  body: { team_id, agent_id, session_id?, messages: [{role, content, ts?}] }
  //
  // 语义："把这段历史对话作为 L0 塞进选定 agent 的记忆池"，让 tdai pipeline 后续
  // 自动蒸馏出 L1/L2/L3。**不建新 asset** —— 该 agent 的 chat_memory asset 已由
  // ensureChatMemoryAsset 自动登记，本接口只写数据面 L0。
  //
  // 权限：agent.owner = me（只能往自己的 agent 导入）
  //
  // 走 tdai /v3/conversation/add：
  //   body: { team_id, user_id (=agent.owner), agent_id, session_id, messages }
  api.post('/chat-memory/import', validatePanelMetaHeaders(deps), async (c) => {
    const ctx = buildCtx(c);
    const body = await readJson(c);
    const teamId = requiredTeamId(body);
    const agentId = typeof body?.agent_id === 'string' ? body.agent_id : '';
    const rawMessages = body?.messages;
    if (!teamId) return respondControlError(c, 400, 'MISSING_TEAM_ID');
    if (!agentId) return respondControlError(c, 400, 'MISSING_AGENT_ID');
    if (!Array.isArray(rawMessages) || rawMessages.length === 0) {
      return respondControlError(c, 400, 'MISSING_MESSAGES');
    }
    // tdai conversationAddRequestSchema 上限 100，超了内核会挡回来 → 面板层也 100
    if (rawMessages.length > 100) {
      return respondControlError(c, 400, 'TOO_MANY_MESSAGES');
    }

    // 规范化 messages
    interface Msg { role: string; content: string; ts?: string }
    const messages: Msg[] = [];
    for (const raw of rawMessages) {
      if (!raw || typeof raw !== 'object') continue;
      const m = raw as Record<string, unknown>;
      const role = typeof m.role === 'string' ? m.role : '';
      const content = typeof m.content === 'string' ? m.content : '';
      if (!role || !content) continue;
      messages.push({
        role,
        content,
        ts: typeof m.ts === 'string' ? m.ts : undefined,
      });
    }
    if (messages.length === 0) {
      return respondControlError(c, 400, 'NO_VALID_MESSAGES');
    }

    // 权限：agent.owner = me
    const meUserId = await resolveCallerUserId(deps, ctx);
    if (!meUserId) return respondControlError(c, 401, 'INVALID_USER_KEY');
    const agentEnv = await deps.metaKernel.invoke('agent/get', { agent_id: agentId }, ctx);
    if (agentEnv.code === 404 || (agentEnv.code === 0 && !agentEnv.data)) {
      return respondControlError(c, 404, 'AGENT_NOT_FOUND');
    }
    if (agentEnv.code !== 0) return respondEnvelope(c, agentEnv);
    const agent = agentEnv.data as AgentRaw;
    if (agent.team_id !== teamId) return respondControlError(c, 400, 'AGENT_NOT_IN_TEAM');
    if (agent.owner_user_id !== meUserId) return respondControlError(c, 403, 'NOT_YOUR_AGENT');

    // session_id 兜底：调用方可传，或生成一个 imported-{ts}
    const sessionId =
      typeof body?.session_id === 'string' && body.session_id.trim()
        ? body.session_id.trim()
        : `imported-${Date.now().toString(36)}`;

    // 走数据面 conversation/add；user_id 用 agent.owner_user_id（数据面按 owner 隔离）
    const cred = toKernelCredentials(ctx, { timeoutMs: 15_000 });
    const addEnv = await deps.kernelHttp.postEnvelope<{ accepted_ids?: string[] }>(
      '/v3/conversation/add',
      {
        team_id: teamId,
        user_id: agent.owner_user_id,
        agent_id: agentId,
        session_id: sessionId,
        messages,
      },
      cred,
    );
    if (addEnv.code !== 0) return respondEnvelope(c, addEnv);
    const acceptedCount = (addEnv.data as { accepted_ids?: string[] } | null)?.accepted_ids?.length ?? 0;

    return respondEnvelope(
      c,
      okEnvelope(c, {
        imported: true,
        block_id: `chat_memory-${teamId}-${agentId}`,
        session_id: sessionId,
        accepted_count: acceptedCount,
      }),
    );
  });

  // 4.8 改 scope
  //
  // 双层校验：
  //   1. 面板层：asset_type === 'chat_memory'（防止 chat-memory 路由被用于修改
  //      其它类型 asset 的 visibility，这条路由是 chat-memory 专用）
  //   2. tdai 层：`updateAssetForCaller` 走 `assertCallerIsAssetOwner`，非 owner
  //      直接 permission_denied
  api.post('/chat-memory/patch-scope', validatePanelMetaHeaders(deps), async (c) => {
    const ctx = buildCtx(c);
    const body = await readJson(c);
    const blockId = requiredBlockId(body);
    if (!blockId) return respondControlError(c, 400, 'MISSING_BLOCK_ID');
    const scope = body?.scope === 'private' ? 'private' : body?.scope === 'team' ? 'team' : undefined;
    if (!scope) return respondControlError(c, 400, 'INVALID_SCOPE');

    // 校验目标 asset 是 chat_memory
    const preEnv = await deps.metaKernel.invoke('asset/get', { asset_id: blockId }, ctx);
    if (preEnv.code === 404 || (preEnv.code === 0 && !preEnv.data)) {
      return respondControlError(c, 404, 'BLOCK_NOT_FOUND');
    }
    if (preEnv.code !== 0) return respondEnvelope(c, preEnv);
    const preAsset = preEnv.data as AssetRaw;
    if (preAsset.asset_type !== 'chat_memory') {
      return respondControlError(c, 400, 'NOT_CHAT_MEMORY');
    }

    const env = await deps.metaKernel.invoke(
      'asset/update',
      { asset_id: blockId, visibility: scope },
      ctx,
    );
    if (env.code !== 0) return respondEnvelope(c, env);
    const asset = env.data as AssetRaw;
    // 切私密后：不再由 backend 主动 prune 其它 agent 的绑定
    //   1. 内核权限模型要求 caller = agent.owner 才能 set；owner 本人只能 set 自己的 agent
    //   2. 保留脏 binding 也无害：下游 injection / memory-bridge 会在读侧调
    //      apply_visibility_filter=true 过滤掉 canBindAsset=false 的项；
    //      详情页也会一并过滤，不会被展示
    //   3. 前端在切私密按钮弹 confirm 提示用户"其他 agent 已绑定会不能再用"
    return respondEnvelope(
      c,
      okEnvelope(c, {
        updated: true,
        id: asset.asset_id,
        scope: asset.visibility === 'private' ? 'private' : 'team',
      }),
    );
  });

  // 4.5a 批量设置固定 memory（原子校验 + 单次 set，避免多次 allocate 并发覆盖）
  api.post('/chat-memory/set-agent-fixed', validatePanelMetaHeaders(deps), async (c) => {
    const ctx = buildCtx(c);
    const body = await readJson(c);
    const agentId = typeof body?.agent_id === 'string' ? body.agent_id : '';
    const teamId = typeof body?.team_id === 'string' ? body.team_id : '';
    const rawBlockIds = Array.isArray(body?.block_ids) ? body.block_ids : [];
    if (!agentId) return respondControlError(c, 400, 'MISSING_AGENT_ID');
    if (!teamId) return respondControlError(c, 400, 'MISSING_TEAM_ID');

    const blockIds = Array.from(new Set(rawBlockIds.filter((id): id is string => typeof id === 'string' && id.trim().length > 0)));
    const selfChatMemoryId = `chat_memory-${teamId}-${agentId}`;
    const importedIds = blockIds.filter((id) => id !== selfChatMemoryId);
    if (importedIds.length > MAX_IMPORTED_AGENTS) {
      return respondControlError(c, 400, 'IMPORT_LIMIT_EXCEEDED');
    }

    const meUserId = await resolveCallerUserId(deps, ctx);
    if (!meUserId) return respondControlError(c, 401, 'INVALID_USER_KEY');

    const agentEnv = await deps.metaKernel.invoke('agent/get', { agent_id: agentId }, ctx);
    if (agentEnv.code === 404 || (agentEnv.code === 0 && !agentEnv.data)) {
      return respondControlError(c, 404, 'AGENT_NOT_FOUND');
    }
    if (agentEnv.code !== 0) return respondEnvelope(c, agentEnv);
    const agent = agentEnv.data as AgentRaw;
    if (agent.team_id !== teamId) return respondControlError(c, 400, 'AGENT_NOT_IN_TEAM');
    if (agent.owner_user_id !== meUserId) return respondControlError(c, 403, 'NOT_YOUR_AGENT');

    for (const blockId of importedIds) {
      const assetEnv = await deps.metaKernel.invoke('asset/get', { asset_id: blockId }, ctx);
      if (assetEnv.code === 404 || (assetEnv.code === 0 && !assetEnv.data)) {
        return respondControlError(c, 404, 'BLOCK_NOT_FOUND');
      }
      if (assetEnv.code !== 0) return respondEnvelope(c, assetEnv);
      const asset = assetEnv.data as AssetRaw;
      if (asset.asset_type !== 'chat_memory') return respondControlError(c, 400, 'NOT_CHAT_MEMORY');
      if (asset.team_id !== teamId) return respondControlError(c, 400, 'TEAM_MISMATCH');
      if (asset.visibility !== 'team' && asset.owner_user_id !== meUserId) {
        return respondControlError(c, 403, 'ASSET_NOT_SHARED');
      }
    }

    const bindEnv = await deps.metaKernel.invoke('agent-fixed-asset/list', { agent_id: agentId }, ctx);
    if (bindEnv.code !== 0) return respondEnvelope(c, bindEnv);
    const existing = extractListItems<FixedAssetRaw>(bindEnv);
    const nonMemoryBindings = existing.filter((b) => b.asset_type !== 'chat_memory');
    const selfBinding = existing.find((b) => b.asset_type === 'chat_memory' && b.asset_id === selfChatMemoryId);
    const newBindings = [
      ...nonMemoryBindings.map((b) => ({
        asset_id: b.asset_id,
        asset_type: b.asset_type,
        injection_mode: b.injection_mode ?? 'direct',
        priority: b.priority ?? 50,
        created_by: b.created_by,
      })),
      ...(selfBinding ? [{
        asset_id: selfBinding.asset_id,
        asset_type: selfBinding.asset_type,
        injection_mode: selfBinding.injection_mode ?? 'summary',
        priority: selfBinding.priority ?? 50,
        created_by: selfBinding.created_by ?? agent.owner_user_id,
      }] : []),
      ...importedIds.map((blockId) => ({
        asset_id: blockId,
        asset_type: 'chat_memory',
        injection_mode: 'summary',
        priority: 50,
        created_by: agent.owner_user_id,
      })),
    ];

    const setEnv = await deps.metaKernel.invoke('agent-fixed-asset/set', { agent_id: agentId, bindings: newBindings }, ctx);
    if (setEnv.code !== 0) return respondEnvelope(c, setEnv);
    return respondEnvelope(c, okEnvelope(c, { updated: true, agent_id: agentId, block_ids: [selfChatMemoryId, ...importedIds] }));
  });

  // 4.5 分配（借入）+ ≤ 2 校验
  api.post('/chat-memory/allocate', validatePanelMetaHeaders(deps), async (c) => {
    const ctx = buildCtx(c);
    const body = await readJson(c);
    const blockId = requiredBlockId(body);
    const agentId = typeof body?.agent_id === 'string' ? body.agent_id : '';
    const teamId = typeof body?.team_id === 'string' ? body.team_id : '';
    if (!blockId) return respondControlError(c, 400, 'MISSING_BLOCK_ID');
    if (!agentId) return respondControlError(c, 400, 'MISSING_AGENT_ID');
    if (!teamId) return respondControlError(c, 400, 'MISSING_TEAM_ID');

    // 校验 asset 存在 + type + team 一致
    const assetEnv = await deps.metaKernel.invoke('asset/get', { asset_id: blockId }, ctx);
    if (assetEnv.code === 404 || (assetEnv.code === 0 && !assetEnv.data)) {
      return respondControlError(c, 404, 'BLOCK_NOT_FOUND');
    }
    if (assetEnv.code !== 0) return respondEnvelope(c, assetEnv);
    const asset = assetEnv.data as AssetRaw;
    if (asset.asset_type !== 'chat_memory') {
      return respondControlError(c, 400, 'NOT_CHAT_MEMORY');
    }
    if (asset.team_id !== teamId) {
      return respondControlError(c, 400, 'TEAM_MISMATCH');
    }

    // 校验 agent 存在 + 同 team
    const agentEnv = await deps.metaKernel.invoke('agent/get', { agent_id: agentId }, ctx);
    if (agentEnv.code === 404 || (agentEnv.code === 0 && !agentEnv.data)) {
      return respondControlError(c, 404, 'AGENT_NOT_FOUND');
    }
    if (agentEnv.code !== 0) return respondEnvelope(c, agentEnv);
    const agent = agentEnv.data as AgentRaw;
    if (agent.team_id !== teamId) {
      return respondControlError(c, 400, 'AGENT_NOT_IN_TEAM');
    }

    // 权限校验（普通用户视角）：只能给"自己 owner 的 agent"借入资产
    // 目标 asset 必须是 visibility=team（团队已共享），或者是自己 owner 的（自留自用也 OK）
    const meUserId = await resolveCallerUserId(deps, ctx);
    if (!meUserId) return respondControlError(c, 401, 'INVALID_USER_KEY');
    if (agent.owner_user_id !== meUserId) {
      return respondControlError(c, 403, 'NOT_YOUR_AGENT');
    }
    if (asset.visibility !== 'team' && asset.owner_user_id !== meUserId) {
      return respondControlError(c, 403, 'ASSET_NOT_SHARED');
    }

    // 禁止把 agent 自己的 chat_memory 再分配回自己；自有记忆由 auto-mint 固定存在，
    // 分配入口只用于把其它 agent 的共享记忆借入到当前 agent。
    const selfChatMemoryId = `chat_memory-${teamId}-${agentId}`;
    if (blockId === selfChatMemoryId) {
      return respondControlError(c, 400, '不能把该 Agent 自己的记忆再分配给自己。');
    }

    // 拉现有绑定
    const bindEnv = await deps.metaKernel.invoke(
      'agent-fixed-asset/list',
      { agent_id: agentId },
      ctx,
    );
    if (bindEnv.code !== 0) return respondEnvelope(c, bindEnv);
    const bindings = extractListItems<FixedAssetRaw>(bindEnv);
    if (bindings.some((b) => b.asset_id === blockId)) {
      return respondControlError(c, 409, '这条记忆已经分配给该 Agent，无需重复分配。');
    }

    // 借入 ≤ 2 校验：非自有 chat_memory 计数
    const imported = bindings.filter(
      (b) => b.asset_type === 'chat_memory' && b.asset_id !== selfChatMemoryId,
    );
    if (imported.length >= MAX_IMPORTED_AGENTS) {
      return respondControlError(c, 400, 'IMPORT_LIMIT_EXCEEDED');
    }

    // 组合：list → append → set（tdai 无 append 端点）
    const newBindings = [
      ...bindings.map((b) => ({
        asset_id: b.asset_id,
        asset_type: b.asset_type,
        injection_mode: b.injection_mode ?? 'summary',
        priority: b.priority ?? 50,
        created_by: b.created_by,
      })),
      {
        asset_id: blockId,
        asset_type: 'chat_memory',
        injection_mode: 'summary',
        priority: 50,
        created_by: agent.owner_user_id, // 用 agent owner 作为绑定的 created_by
      },
    ];
    const setEnv = await deps.metaKernel.invoke(
      'agent-fixed-asset/set',
      { agent_id: agentId, bindings: newBindings },
      ctx,
    );
    if (setEnv.code !== 0) return respondEnvelope(c, setEnv);
    return respondEnvelope(
      c,
      okEnvelope(c, { allocated: true, agent_id: agentId, block_id: blockId }),
    );
  });

  // 4.6 解绑
  api.post('/chat-memory/unbind', validatePanelMetaHeaders(deps), async (c) => {
    const ctx = buildCtx(c);
    const body = await readJson(c);
    const blockId = requiredBlockId(body);
    const agentId = typeof body?.agent_id === 'string' ? body.agent_id : '';
    const teamId = typeof body?.team_id === 'string' ? body.team_id : '';
    if (!blockId) return respondControlError(c, 400, 'MISSING_BLOCK_ID');
    if (!agentId) return respondControlError(c, 400, 'MISSING_AGENT_ID');
    if (!teamId) return respondControlError(c, 400, 'MISSING_TEAM_ID');

    // 禁止解绑 agent 的"自有" chat_memory（由 auto-mint 建的）
    const selfChatMemoryId = `chat_memory-${teamId}-${agentId}`;
    if (blockId === selfChatMemoryId) {
      return respondControlError(c, 400, 'CANNOT_UNBIND_SELF_CHAT_MEMORY');
    }

    // 权限校验（普通用户视角）：只能解绑"自己 owner 的 agent"上的借入
    const meUserId = await resolveCallerUserId(deps, ctx);
    if (!meUserId) return respondControlError(c, 401, 'INVALID_USER_KEY');
    const agentEnv = await deps.metaKernel.invoke('agent/get', { agent_id: agentId }, ctx);
    if (agentEnv.code !== 0) return respondEnvelope(c, agentEnv);
    const agent = agentEnv.data as AgentRaw | null;
    if (!agent) return respondControlError(c, 404, 'AGENT_NOT_FOUND');
    if (agent.team_id !== teamId) {
      return respondControlError(c, 400, 'AGENT_NOT_IN_TEAM');
    }
    if (agent.owner_user_id !== meUserId) {
      return respondControlError(c, 403, 'NOT_YOUR_AGENT');
    }

    // 校验 asset 是 chat_memory（防止此路由被用作通用 fixed-asset unbind 入口）
    const assetEnv = await deps.metaKernel.invoke('asset/get', { asset_id: blockId }, ctx);
    if (assetEnv.code === 404 || (assetEnv.code === 0 && !assetEnv.data)) {
      return respondControlError(c, 404, 'BLOCK_NOT_FOUND');
    }
    if (assetEnv.code !== 0) return respondEnvelope(c, assetEnv);
    const asset = assetEnv.data as AssetRaw;
    if (asset.asset_type !== 'chat_memory') {
      return respondControlError(c, 400, 'NOT_CHAT_MEMORY');
    }

    // 拉 agent 的绑定：过滤时既要移除本次目标，也要**顺便过滤 canBindAsset=false
    // 的历史脏 binding**（例如别人已把资产切私密但绑定未清），否则下一步 set 全量
    // 重写会触发内核 asset_not_bindable 409。这里用 list-with-detail 一次拉齐
    // 每条 binding 对应 asset 的 visibility，本地做过滤，避免 N 次 asset/get。
    const bindEnv = await deps.metaKernel.invoke(
      'agent-fixed-asset/list-with-detail',
      { agent_id: agentId, apply_visibility_filter: true, touch_usage: false },
      ctx,
    );
    if (bindEnv.code !== 0) return respondEnvelope(c, bindEnv);
    interface BindingWithDetail {
      asset_id: string;
      asset_type: string;
      injection_mode?: string;
      priority?: number;
      created_by?: string;
      visibility?: string;
      status?: string;
    }
    const detailBindings = extractListItems<BindingWithDetail>(bindEnv);

    // 若 blockId 不在 filter 后 items 里，说明要么本来就没绑定，要么内核判定 caller 不能 bind
    // 都视为"当前实际可解的绑定不含 blockId" → 404 便于 UI 语义清晰
    // 但也要处理"binding 存在但因私密被 filter 掉"的场景 —— 该场景下也应允许解绑，
    // 需要用不带 filter 的 list 二次确认原始绑定存在。
    const targetInFilteredList = detailBindings.some((b) => b.asset_id === blockId);
    if (!targetInFilteredList) {
      const rawEnv = await deps.metaKernel.invoke('agent-fixed-asset/list', { agent_id: agentId }, ctx);
      if (rawEnv.code !== 0) return respondEnvelope(c, rawEnv);
      const raw = extractListItems<FixedAssetRaw>(rawEnv);
      const exists = raw.some((b) => b.asset_id === blockId);
      if (!exists) return respondControlError(c, 404, 'BINDING_NOT_FOUND');
      // 存在但因 visibility 被 filter 掉 —— 属于"要清理的脏 binding"，允许继续
    }

    // set 用 apply_visibility_filter=true 过滤后的 remaining（不包含目标 blockId），
    // 保证 canBindAsset 全部 pass。
    const remaining = detailBindings.filter((b) => b.asset_id !== blockId);
    const setEnv = await deps.metaKernel.invoke(
      'agent-fixed-asset/set',
      {
        agent_id: agentId,
        bindings: remaining.map((b) => ({
          asset_id: b.asset_id,
          asset_type: b.asset_type,
          injection_mode: b.injection_mode ?? 'summary',
          priority: b.priority ?? 50,
          created_by: b.created_by ?? meUserId,
        })),
      },
      ctx,
    );
    if (setEnv.code !== 0) return respondEnvelope(c, setEnv);
    return respondEnvelope(
      c,
      okEnvelope(c, { unbound: true, agent_id: agentId, block_id: blockId }),
    );
  });

  // ── 4.4 分层懒加载 ─────────────────────────────────────────
  //
  // POST /chat-memory/layer  body: { block_id, layer, limit?, offset? }
  //   layer ∈ 'L0' | 'L1' | 'L2' | 'L3'
  //
  // 从 asset_id 反解出 team_id/agent_id，调 tdai 数据面（不是 /v3/meta/*）：
  //   L0 → /v3/conversation/query
  //   L1 → /v3/atomic/query
  //   L2 → /v3/scenario/ls
  //   L3 → /v3/core/read
  //
  // 只支持系统自动登记的 chat_memory-{team}-{agent}（可反解 agent_id）；
  // 用户自建 UserAsset（mem-xxx）没有关联的 agent，直接返空。
  api.post('/chat-memory/layer', validatePanelMetaHeaders(deps), async (c) => {
    const ctx = buildCtx(c);
    const body = await readJson(c);
    const blockId = requiredBlockId(body);
    const layerRaw = typeof body?.layer === 'string' ? body.layer.toUpperCase() : '';
    const limit = typeof body?.limit === 'number' && body.limit > 0 && body.limit <= 200 ? body.limit : 50;
    const offset = typeof body?.offset === 'number' && body.offset >= 0 ? body.offset : 0;
    // before_ts: L0 游标分页参数（ISO8601）。第二页起由前端传「最后一条消息的 created_at」，
    // 后端转换为 time_end（-1ms 排他）传给内核 /v3/conversation/query，offset 归零。
    // 这样 VDB 只需 filter recorded_at_ms < cursor 即可，不需要 skip 大量记录。
    const beforeTs = typeof body?.before_ts === 'string' ? body.before_ts.trim() : undefined;

    if (!blockId) return respondControlError(c, 400, 'MISSING_BLOCK_ID');
    if (!['L0', 'L1', 'L2', 'L3'].includes(layerRaw)) return respondControlError(c, 400, 'INVALID_LAYER');
    const layer = layerRaw as 'L0' | 'L1' | 'L2' | 'L3';

    // 反解 team_id / agent_id
    const parsed = parseChatMemoryAssetId(blockId);
    if (!parsed) {
      // 用户自建 UserAsset —— 没有关联 agent，无 layer 数据可拉，直接返空
      return respondEnvelope(c, okEnvelope(c, { layer, items: [], total: 0, limit, offset }));
    }

    // 数据面调用需要额外传 team_id / agent_id / user_id / session_id
    const meUserId = await resolveCallerUserId(deps, ctx);
    if (!meUserId) return respondControlError(c, 401, 'INVALID_USER_KEY');

    // ── ACL 校验：防止知道 asset_id 就能读私密内容 ─────────────
    // 允许读的条件（任一即可）：
    //   a) caller 是 asset 的 owner（自留自用）
    //   b) asset.visibility='team'（团队已共享）
    //   c) asset 已被绑定到 caller 名下某个 agent（借入借关系）
    //
    // asset 元数据从 asset/get 拿；c 需遍历 caller 的 agent 的 fixed-list。
    const assetEnv = await deps.metaKernel.invoke('asset/get', { asset_id: blockId }, ctx);
    if (assetEnv.code === 404 || (assetEnv.code === 0 && !assetEnv.data)) {
      return respondControlError(c, 404, 'BLOCK_NOT_FOUND');
    }
    if (assetEnv.code !== 0) return respondEnvelope(c, assetEnv);
    const asset = assetEnv.data as AssetRaw;
    if (asset.asset_type !== 'chat_memory') {
      return respondControlError(c, 400, 'NOT_CHAT_MEMORY');
    }

    const isOwner = asset.owner_user_id === meUserId;
    // team-shared 必须 caller ∈ team，才算可读；否则等同 private（防止外 team 的
    // 用户知道 asset_id 就能读走 chat_memory 内容）。tdai /v3/meta/asset/get 本身
    // 没做这个校验，所以由 Control 层收口。
    let isTeamShared = false;
    if (asset.visibility === 'team') {
      isTeamShared = await isTeamMember(deps, ctx, asset.team_id, meUserId);
    }
    let isBorrowed = false;
    if (!isOwner && !isTeamShared) {
      // 遍历 caller 的 agent（限本 team），看有没有绑定过该 asset
      try {
        const myAgentsEnv = await deps.metaKernel.invoke(
          'agent/list',
          { team_id: asset.team_id, status: 'active' },
          ctx,
        );
        if (myAgentsEnv.code === 0) {
          const myAgents = extractListItems<AgentRaw>(myAgentsEnv).filter(
            (a) => a.owner_user_id === meUserId,
          );
          for (const a of myAgents) {
            const bindEnv = await deps.metaKernel.invoke(
              'agent-fixed-asset/list',
              { agent_id: a.agent_id },
              ctx,
            );
            if (bindEnv.code !== 0) continue;
            const bindings = extractListItems<FixedAssetRaw>(bindEnv);
            if (bindings.some((b) => b.asset_id === blockId)) {
              isBorrowed = true;
              break;
            }
          }
        }
      } catch { /* fallthrough → deny */ }
    }

    if (!isOwner && !isTeamShared && !isBorrowed) {
      return respondControlError(c, 403, 'ASSET_NOT_ACCESSIBLE');
    }

    // chat_memory 数据是 asset owner 写入（用其 user_id 隔离），caller 未必是 owner
    // （借入场景）。用 asset.owner_user_id 作为数据面 user_id。
    const ownerUserId = asset.owner_user_id;

    const cred = toKernelCredentials(ctx, { timeoutMs: 15_000 });

    // v3 严格 isolation：session_id 必填。管理面聚合场景传 'default'
    const idFields = {
      team_id: parsed.teamId,
      agent_id: parsed.agentId,
      user_id: ownerUserId,
      session_id: 'default',
    };

    try {
      if (layer === 'L0') {
        // 关键：不传 session_id，tdai 会跨 session 聚合返 (team,user,agent) 全部消息
        // tdai 返 { messages: [...], total } 而不是 { items: [...] }
        const { session_id: _drop, ...noSid } = idFields;
        void _drop;

        // 游标分页：before_ts → time_end（-1ms 排他）。
        // 内核 /v3/conversation/query 的 time_end 是 recorded_at_ms <= timeEndMs（含等），
        // 游标语义需要排他（< beforeTs），否则最后一条会被重复返回。
        // 减 1ms 把含等转为不含等。毫秒精度足够（同一 ms 的重复极少且前端有 id 去重兜底）。
        const l0Query: Record<string, unknown> = { ...noSid };
        if (beforeTs) {
          const d = new Date(beforeTs);
          if (Number.isFinite(d.getTime())) {
            l0Query.time_end = new Date(d.getTime() - 1).toISOString();
            l0Query.offset = 0; // 游标模式下 offset 归零
          }
        } else {
          l0Query.offset = offset;
        }
        l0Query.limit = limit;

        const env = await deps.kernelHttp.postEnvelope<{ messages?: unknown[]; total?: number }>(
          '/v3/conversation/query',
          l0Query,
          cred,
        );
        if (env.code !== 0) return respondEnvelope(c, env);
        const data = (env.data as { messages?: Array<Record<string, unknown>>; total?: number } | null) ?? { messages: [] };
        return respondEnvelope(
          c,
          okEnvelope(c, {
            layer,
            items: (data.messages ?? []).map((m) => ({
              id: m.id ?? '',
              role: typeof m.role === 'string' ? m.role : 'msg',
              title: `${m.role ?? 'msg'} @ ${m.session_id ?? ''}`,
              body: typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? ''),
              tags: m.role ? [String(m.role)] : [],
              refs: [],
              // L0 时间来源（v3 内核实际返回）：
              //   - timestamp（ISO 字符串）—— 内核 conversation/query 的标准字段
              //   - recorded_at_ms / timestamp 数值 ms —— 部分老数据/内部字段
              created_at:
                (typeof m.timestamp === 'string' && m.timestamp) ||
                msToIso(m.recorded_at_ms) ||
                msToIso(m.timestamp) ||
                undefined,
            })),
            total: data.total ?? (data.messages ?? []).length,
            limit,
            offset,
          }),
        );
      }

      if (layer === 'L1') {
        const env = await deps.kernelHttp.postEnvelope<{ items?: unknown[]; total?: number }>(
          '/v3/atomic/query',
          { ...idFields, limit, offset },
          cred,
        );
        if (env.code !== 0) return respondEnvelope(c, env);
        const data = (env.data as { items?: Array<Record<string, unknown>>; total?: number } | null) ?? { items: [] };
        return respondEnvelope(
          c,
          okEnvelope(c, {
            layer,
            items: (data.items ?? []).map((r) => ({
              id: r.record_id ?? r.id,
              title: (r.type ?? 'atomic') as string,
              body: r.content ?? '',
              tags: r.tags ?? [],
              refs: [],
              // L1 时间来源（v3 内核实际返回）：
              //   - created_at（ISO 字符串）—— 内核 atomic/query 的标准字段
              //   - created_time_ms（数值 ms） / timestamp_str —— 老数据兼容
              created_at:
                (typeof r.created_at === 'string' && r.created_at) ||
                msToIso(r.created_time_ms) ||
                (typeof r.timestamp_str === 'string' && r.timestamp_str ? r.timestamp_str : undefined),
            })),
            total: data.total ?? (data.items ?? []).length,
            limit,
            offset,
          }),
        );
      }

      if (layer === 'L2') {
        const requestedPath = typeof body?.path === 'string' ? body.path.trim() : '';
        if (requestedPath) {
          const readEnv = await deps.kernelHttp.postEnvelope<{ content?: string | null }>(
            '/v3/scenario/read',
            { ...idFields, path: requestedPath },
            cred,
          );
          if (readEnv.code !== 0) return respondEnvelope(c, readEnv);
          const readData = readEnv.data as { content?: string | null } | null;
          const content = typeof readData?.content === 'string' ? readData.content : '';
          const readTime =
            (readData as { updated_at?: string; modified_at?: string; created_at?: string } | null | undefined)?.updated_at ??
            (readData as { modified_at?: string } | null | undefined)?.modified_at ??
            (readData as { created_at?: string } | null | undefined)?.created_at;
          return respondEnvelope(
            c,
            okEnvelope(c, {
              layer,
              items: [{ id: requestedPath, title: requestedPath, body: content, tags: content ? ['markdown'] : [], refs: [], created_at: readTime }],
              total: content ? 1 : 0,
              limit: 1,
              offset: 0,
            }),
          );
        }

        // scenario/ls 只返回 L2 标题列表；具体 Markdown 原文由前端点击单条后
        // 再带 path 回到本接口触发 scenario/read，避免一次性打开全部 md。
        const env = await deps.kernelHttp.postEnvelope<{ entries?: unknown[]; total?: number }>(
          '/v3/scenario/ls',
          idFields,
          cred,
        );
        if (env.code !== 0) return respondEnvelope(c, env);
        const data = (env.data as { entries?: Array<Record<string, unknown>>; total?: number } | null) ?? { entries: [] };
        const entries = data.entries ?? [];
        return respondEnvelope(
          c,
          okEnvelope(c, {
            layer,
            items: entries.map((r) => {
              const path = typeof r.path === 'string' ? r.path : String(r.id ?? '');
              // L2 时间来源（scenario/ls）：updated_at / modified_at / updated_time_ms
              const t =
                (typeof r.updated_at === 'string' && r.updated_at) ||
                (typeof r.modified_at === 'string' && r.modified_at) ||
                msToIso(r.updated_time_ms) ||
                undefined;
              return { id: path, title: path, body: '', tags: [], refs: [], created_at: t };
            }),
            total: data.total ?? entries.length,
            limit,
            offset,
          }),
        );
      }

      // L3
      const env = await deps.kernelHttp.postEnvelope<{ content?: string; version?: string; updated_at?: string }>(
        '/v3/core/read',
        idFields,
        cred,
      );
      if (env.code !== 0) return respondEnvelope(c, env);
      const data = (env.data as { content?: string; version?: string; updated_at?: string } | null) ?? {};
      const content = stripL3SceneTail(data.content ?? '');
      return respondEnvelope(
        c,
        okEnvelope(c, {
          layer,
          items: content
            ? [{ id: 'core', title: 'core memory', body: content, tags: [], refs: [], created_at: data.updated_at }]
            : [],
          total: content ? 1 : 0,
          limit,
          offset,
        }),
      );
    } catch (err) {
      return respondControlError(
        c,
        500,
        `LAYER_FETCH_ERROR: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  });
}

/**
 * 从 chat_memory-{team_id}-{agent_id} 解出 team_id / agent_id
 * 依赖 agent id 以 `agt` 开头这一稳定前缀（新版格式：chat_memory-{team}-agt{agent}）。
 * 兼容旧版格式：chat_memory-{team}-{agent}（agent id 无 `agt` 前缀，
 * MemoryCore buildChatMemoryAssetId 生成，v2.0.0 及更早数据）。
 */
function parseChatMemoryAssetId(assetId: string): { teamId: string; agentId: string } | null {
  if (!assetId.startsWith('chat_memory-')) return null;
  const inner = assetId.slice('chat_memory-'.length);
  const dashAgt = inner.lastIndexOf('-agt');
  if (dashAgt >= 0) {
    return {
      teamId: inner.slice(0, dashAgt),
      agentId: inner.slice(dashAgt + 1),
    };
  }
  // 旧版格式：agent id 无 `agt` 前缀，按最后一个 '-' 分割
  const dash = inner.lastIndexOf('-');
  if (dash <= 0) return null;
  return {
    teamId: inner.slice(0, dash),
    agentId: inner.slice(dash + 1),
  };
}

// ============================================================================
// 辅助
// ============================================================================

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

function requiredTeamId(body: Record<string, unknown>): string | null {
  const t = body?.team_id;
  return typeof t === 'string' && t.trim() ? t.trim() : null;
}

function requiredBlockId(body: Record<string, unknown>): string | null {
  const t = body?.block_id;
  return typeof t === 'string' && t.trim() ? t.trim() : null;
}

function extractListItems<T>(env: MetaEnvelope<unknown>): T[] {
  const d = env.data as unknown;
  if (d && typeof d === 'object' && Array.isArray((d as ListEnvelopeData<T>).items)) {
    return (d as ListEnvelopeData<T>).items;
  }
  return [];
}

function isActive(a: AssetRaw): boolean {
  return a.status !== 'archived' && a.status !== 'deprecated' && a.status !== 'failed';
}

function emptyLayers(): MemoryBlockOut['layer_counts'] {
  return { L0_messages: 0, L1: 0, L2: 0, L3: 0 };
}

function buildSummary(): string {
  return '0 条 L1 · 0 条 L2 · 0 条 L3';
}

function stripL3SceneTail(content: string): string {
  const withFooter = content.search(/\n---\s*\n\s*> \*\*最后更新\*\*[\s\S]*?\n---\s*\n## 🗺️ Scene Navigation/);
  if (withFooter >= 0) return content.slice(0, withFooter).trimEnd();
  const sceneIndex = content.search(/\n---\s*\n## 🗺️ Scene Navigation|\n## 🗺️ Scene Navigation/);
  if (sceneIndex >= 0) return content.slice(0, sceneIndex).trimEnd();
  return content;
}

function toMs(iso: string | undefined): number {
  if (!iso) return 0;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
}

/**
 * 内核 chat_memory L0/L1 层用毫秒时间戳存 (recorded_at_ms / created_time_ms)；
 * 前端展示需要 ISO 字符串（可用 Date.toLocaleString 呈现），此处统一转换。
 * 只接受"看起来像 ms epoch"的数值（> 10^12，约 2001-09 以后），其余返 undefined
 * 让 caller fallback 到别的字段（如 timestamp_str / updated_at）。
 */
function msToIso(v: unknown): string | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 1e12) return undefined;
  try {
    return new Date(v).toISOString();
  } catch {
    return undefined;
  }
}

function okEnvelope<T>(c: import('hono').Context, data: T): MetaEnvelope<T> {
  return { code: 0, message: 'ok', request_id: c.get('reqId') ?? '', data };
}

/**
 * 通过 auth/verify 反查 caller 的 user_id。
 * envelope.data.user.user_id 为空或非法都返 null。
 */
async function resolveCallerUserId(deps: PanelDeps, ctx: MetaCallContext): Promise<string | null> {
  if (!ctx.userKey) return null;
  const env = await deps.metaKernel.invoke('auth/verify', { user_key: ctx.userKey }, ctx);
  if (env.code !== 0) return null;
  const data = env.data as { valid?: boolean; user?: { user_id?: string } } | null;
  if (!data?.valid) return null;
  const uid = data.user?.user_id;
  return typeof uid === 'string' && uid.length > 0 ? uid : null;
}

/**
 * 校验 user 是否是 team 成员。
 * 走 tdai `/v3/meta/team-member/get`（存在→成员；404→非成员）。
 * 内核抛异常时保守返 false（拒绝），避免 fail-open。
 */
async function isTeamMember(
  deps: PanelDeps,
  ctx: MetaCallContext,
  teamId: string,
  userId: string,
): Promise<boolean> {
  if (!teamId || !userId) return false;
  try {
    const env = await deps.metaKernel.invoke(
      'team-member/get',
      { team_id: teamId, user_id: userId },
      ctx,
    );
    if (env.code === 0 && env.data) return true;
    return false;
  } catch {
    return false;
  }
}

// countBindings 已随 team-assets 的 N+1 优化下线；未来若右侧详情面板要按需拉
// 单条绑定数，走独立 endpoint（body: {team_id, block_id}）实现，别再放回列表循环。
