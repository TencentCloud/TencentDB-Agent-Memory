/**
 * api/skills.ts — Skill 数据面（/api/v1/skill/*）。
 *
 * 与 meta 链路的关键区别：
 *   - skill 有独立存储与主键 skill_id（前缀 skl-），团队内可读、owner agent 可写；
 *   - 身份字段（user_id / team_id / agent_id）放在 body，不放 Header（鉴权 Header
 *     仍是 X-Tdai-Service-Id + X-Tdai-User-Key，与 meta 一致）；
 *   - 写操作（create/update/patch/delete/files.*）需带 agent_id（= owner），
 *     update/patch/delete/files.* 还需 expected_version 乐观锁；
 *   - 分页用嵌套 pagination.{limit,offset}。
 *
 * 「挂载到 Agent」的语义：让 skill 真正归属某 agent 的唯一机制是 fork —— 复制一份
 * owner_agent_id=目标 agent 的独立副本（见 skillApi.forkToAgent）。acl/grant 只改
 * meta 授权层，对「固定资产」tab 与运行时注入（均按 owner_agent_id）无效。
 */
import { getPanelSession } from '../panelSession';
import { request, getCurrentUser, ApiError, META_PAGE_SIZE } from './base';
import type { MetaEnvelope } from './types';

export interface SkillSummary {
  skill_id: string;
  name: string;
  description: string;
  version: number;
  is_head: boolean;
  status: 'active' | 'archived';
  owner_user_id: string;
  owner_agent_id: string;
  team_id: string;
  task_id: string;
  created_at_ms: number;
  updated_at_ms: number;
  metadata?: Record<string, unknown>;
}

export interface SkillManifestEntry {
  path: string;
  size_bytes: number;
  mime_type: string;
  is_executable: boolean;
}

export interface SkillDetail extends SkillSummary {
  content: string;
  manifest: SkillManifestEntry[];
  content_hash?: string;
  storage_dir?: string;
}

export interface SkillResourcePayload {
  path: string;
  content: string;
  encoding: 'utf-8' | 'base64';
  mime_type?: string;
  is_executable?: boolean;
}

export interface SkillFileContent {
  path: string;
  content: string;
  encoding: 'utf-8' | 'base64';
  size_bytes: number;
  mime_type: string;
  version: number;
}

const SKILL_PREFIX = '/api/v1/skill';

/** skill 数据面调用：注入双 Header，POST body，解析信封（code!=0 抛 ApiError）。 */
async function skillCall<T>(
  action: string,
  body: Record<string, unknown>,
  headers: Record<string, string>
): Promise<T> {
  const envelope = await request<MetaEnvelope<T>>('POST', `${SKILL_PREFIX}/${action}`, body, headers);
  if (envelope.code !== 0) {
    throw new ApiError(200, envelope.message, '', {
      code: envelope.code,
      requestId: envelope.request_id,
      rawMessage: envelope.message,
    });
  }
  if (envelope.data === null || envelope.data === undefined) {
    throw new ApiError(200, envelope.message || 'empty skill response', '', {
      code: envelope.code,
      requestId: envelope.request_id,
      rawMessage: envelope.message || 'empty skill response',
    });
  }
  return envelope.data;
}

async function skillPost<T>(action: string, body: Record<string, unknown> = {}): Promise<T> {
  const session = getPanelSession();
  if (!session) {
    throw new ApiError(401, 'Unauthorized', 'no active panel session');
  }
  return skillCall<T>(action, body, {
    'X-Tdai-Service-Id': session.instanceId,
    'X-Tdai-User-Key': session.userKey,
  });
}

export const skillApi = {
  /** 列出 team 下的 head skill（分页拉全量；可选按 owner agent / 名称前缀 / 状态过滤） */
  list: async (
    teamId: string,
    opts?: { ownerAgentId?: string; namePrefix?: string; status?: Array<'active' | 'archived'> }
  ): Promise<SkillSummary[]> => {
    const me = await getCurrentUser();
    const items: SkillSummary[] = [];
    let offset = 0;
    for (;;) {
      const page = await skillPost<{ items: SkillSummary[]; total: number }>('list', {
        user_id: me.user_id,
        team_id: teamId,
        filters: {
          owner_agent_id: opts?.ownerAgentId,
          name_prefix: opts?.namePrefix,
          status: opts?.status ?? ['active'],
        },
        pagination: { limit: META_PAGE_SIZE, offset },
      });
      items.push(...page.items);
      offset += page.items.length;
      if (page.items.length === 0 || offset >= page.total) break;
    }
    return items;
  },

  /** 列出某个 agent 拥有（owner）的 skill */
  listByAgent: (teamId: string, agentId: string): Promise<SkillSummary[]> =>
    skillApi.list(teamId, { ownerAgentId: agentId }),

  /** 获取 skill 详情（含 SKILL.md 正文 + 资源清单） */
  get: async (teamId: string, skillId: string): Promise<SkillDetail> => {
    const me = await getCurrentUser();
    return skillPost<SkillDetail>('get', {
      user_id: me.user_id,
      team_id: teamId,
      skill_id: skillId,
      include_content: true,
      include_manifest: true,
    });
  },

  /** 读取单个资源文件内容 */
  filesRead: async (teamId: string, skillId: string, path: string): Promise<SkillFileContent> => {
    const me = await getCurrentUser();
    return skillPost<SkillFileContent>('files/read', {
      user_id: me.user_id,
      team_id: teamId,
      skill_id: skillId,
      path,
    });
  },

  /** 创建 skill（agentId 将成为 owner_agent_id） */
  create: async (
    teamId: string,
    agentId: string,
    data: { name: string; content: string; resources?: SkillResourcePayload[]; metadata?: Record<string, unknown> }
  ): Promise<SkillSummary> => {
    const me = await getCurrentUser();
    return skillPost<SkillSummary>('create', {
      user_id: me.user_id,
      team_id: teamId,
      agent_id: agentId,
      name: data.name,
      content: data.content,
      resources: data.resources,
      metadata: data.metadata,
    });
  },

  /** 软删除（归档）；需 owner agent_id + expected_version 乐观锁 */
  delete: async (
    teamId: string,
    agentId: string,
    skillId: string,
    expectedVersion: number
  ): Promise<{ skill_id: string; archived: boolean }> => {
    const me = await getCurrentUser();
    return skillPost<{ skill_id: string; archived: boolean }>('delete', {
      user_id: me.user_id,
      team_id: teamId,
      agent_id: agentId,
      skill_id: skillId,
      expected_version: expectedVersion,
    });
  },

  /** 全量更新 SKILL.md 内容；需 owner agent_id + expected_version */
  update: async (
    teamId: string,
    agentId: string,
    skillId: string,
    expectedVersion: number,
    content: string
  ): Promise<SkillSummary> => {
    const me = await getCurrentUser();
    return skillPost<SkillSummary>('update', {
      user_id: me.user_id,
      team_id: teamId,
      agent_id: agentId,
      skill_id: skillId,
      expected_version: expectedVersion,
      content,
    });
  },

  /** 团队范围搜索 skill */
  search: async (
    teamId: string,
    query: string,
    opts?: { topK?: number; scope?: 'team' }
  ): Promise<Array<SkillSummary & { score: number; snippet: string }>> => {
    const me = await getCurrentUser();
    const res = await skillPost<{ items: Array<SkillSummary & { score: number; snippet: string }> }>('search', {
      user_id: me.user_id,
      team_id: teamId,
      query,
      top_k: opts?.topK ?? 10,
      scope: opts?.scope ?? 'team',
    });
    return res.items;
  },

  /**
   * Fork skill 给 Agent —— 复制一份独立副本，`owner_agent_id` = 目标 agent。
   *
   * 为什么用 fork 而不是 meta 授权（acl/grant）：
   *   - 「固定资产」tab（SkillsPanel）按 `owner_agent_id` 过滤展示；
   *   - agent 运行时注入 `<available_skills>`（/skill/listing）同样按
   *     `owner_agent_id` 过滤。
   *   两处读取都认 `owner_agent_id`，而 acl/grant 只改 meta 授权层，对它们均无效。
   *   因此让 skill 真正归属某 agent 的唯一机制就是复制一份 owner=该 agent 的副本。
   *
   * 命名：副本沿用**源 skill 原名**，不加后缀。skill 唯一约束是
   * (team_id, owner_agent_id, name)：同一 team 允许多个同名副本（分属不同 agent），
   * 但同一 agent 下重名会被后端拒绝（42201）——此时向上抛错，由调用方提示。
   *
   * 实现：getSkill（源正文 + 清单）→ filesRead（逐个资源，单个失败跳过）→
   *       create（name=原名，agent_id=目标 agent 即 owner）。
   */
  forkToAgent: async (
    teamId: string,
    sourceSkillId: string,
    targetAgentId: string
  ): Promise<SkillSummary> => {
    const detail = await skillApi.get(teamId, sourceSkillId);
    const resources: SkillResourcePayload[] = [];
    for (const entry of detail.manifest ?? []) {
      try {
        const f = await skillApi.filesRead(teamId, sourceSkillId, entry.path);
        resources.push({
          path: f.path,
          content: f.content,
          encoding: f.encoding,
          mime_type: f.mime_type || undefined,
          is_executable: entry.is_executable || undefined,
        });
      } catch {
        /* 单个资源读取失败则跳过，不阻断 fork 主流程 */
      }
    }
    return skillApi.create(teamId, targetAgentId, {
      name: detail.name,
      content: detail.content,
      resources: resources.length ? resources : undefined,
      // 血缘：记录 fork 自哪个源 skill，供从副本反查源、避免重复 fork。
      metadata: { forked_from: { skill_id: sourceSkillId, name: detail.name } },
    });
  },
};
