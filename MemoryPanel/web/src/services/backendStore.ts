/**
 * backendStore.ts — Team / Agent / Task 的后端数据层（链路 A）。
 *
 * 取代原来 demoStore.ts 里 team/agent/task 相关的 localStorage 实现：
 *   - Team    走 teamApi.teamsApi + teamApi.membersApi
 *   - Agent   走 teamApi.agentsApi
 *   - Task    走 teamApi.tasksApi
 *
 * 后端 schema 里没有的 UI 专属字段（icon / accent / role_prompt / rules_prompt /
 * skills / code_graphs / llm_wikis / chat_memories / task.participants 等）
 * 统一序列化进 agent.metadata_json / task.metadata_json 的 "ui" namespace，
 * 保证刷新页面后这些字段不丢 —— 等对应的资产/字段在后端落地后，把
 * readXxxUiMeta / writeXxxUiMeta 里的读写目标换成真字段即可，组件层不用改。
 *
 * 缓存策略：
 *   - 模块级缓存 + in-flight promise 去重：同一时刻多个 useTeams()/useAgents() 只发一次请求；
 *   - invalidateBackendCache()：所有写操作后调用，清缓存并广播 BACKEND_REFRESH_EVENT；
 *   - useTeams/useAgents/useTasks 监听该事件自动重新拉取。
 */

import {
  tasksApi,
  type Team as BackendTeam,
  type Agent as BackendAgent,
  type TeamMember as BackendMember,
  type BackendTask,
} from '@/lib/teamApi';
import { invalidateBackendCache } from '@/stores/backend';

// ========================= Types（前端展示形状，尽量贴近旧 demoStore，减少调用方改动） =========================

export interface TeamMember {
  user_id: string;
  role: 'admin' | 'member' | 'reviewer';
  joined_at_ms: number;
  username?: string;
}

export interface Team {
  team_id: string;
  name: string;
  description: string;
  owner_user_id: string;
  status: 'active' | 'archived';
  created_at_ms: number;
  members: TeamMember[];
}

export interface Agent {
  agent_id: string;
  team_id: string;
  owner_user_id: string;
  name: string;
  description: string;
  role_prompt: string;
  rules_prompt: string;
  icon: string;
  accent: 'blue' | 'purple' | 'orange' | 'emerald' | 'rose' | 'slate';
  skills: string[];
  code_graphs: string[];
  llm_wikis: string[];
  chat_memories: string[];
  /** 后端 metadata_json 透传（写回时需要在旧值基础上 merge，而不是整体覆盖） */
  metadata_json?: string;
  created_at_ms: number;
  updated_at_ms: number;
}

export type TaskStatus = 'running' | 'completed';
export type TaskSourceType = 'manual' | 'tapd';

export interface Task {
  task_id: string;
  team_id: string;
  creator_user_id: string;
  participants: string[];
  title: string;
  description: string;
  source_type: TaskSourceType;
  source_url: string;
  linked_agents: string[];
  status: TaskStatus;
  created_at_ms: number;
  updated_at_ms: number;
  metadata_json?: string;
}

// ========================= metadata_json 兜底读写（"ui" namespace） =========================

interface AgentUiMeta {
  role_prompt: string;
  rules_prompt: string;
  icon: string;
  accent: Agent['accent'];
  skills: string[];
  code_graphs: string[];
  llm_wikis: string[];
  chat_memories: string[];
}

const ACCENT_CYCLE: Agent['accent'][] = ['blue', 'purple', 'orange', 'emerald', 'rose', 'slate'];
const ICON_CYCLE = ['🤖', '✨', '⚡', '🎯', '🚀', '🧩'];

function defaultAgentUiMeta(index: number): AgentUiMeta {
  return {
    role_prompt: '',
    rules_prompt: '',
    icon: ICON_CYCLE[index % ICON_CYCLE.length],
    accent: ACCENT_CYCLE[index % ACCENT_CYCLE.length],
    skills: [],
    code_graphs: [],
    llm_wikis: [],
    chat_memories: [],
  };
}

function readAgentUiMeta(metadataJson: string | undefined, index: number): AgentUiMeta {
  const fallback = defaultAgentUiMeta(index);
  if (!metadataJson) return fallback;
  try {
    const meta = JSON.parse(metadataJson) as Record<string, unknown>;
    const slot = meta?.ui;
    if (slot && typeof slot === 'object') {
      return { ...fallback, ...(slot as Partial<AgentUiMeta>) };
    }
    return fallback;
  } catch {
    return fallback;
  }
}

/** 把 ui 专属字段 merge 写回 metadata_json（保留其它 namespace，如 chat_memory）。 */
export function writeAgentUiMeta(prevMetadataJson: string | undefined, patch: Partial<AgentUiMeta>): string {
  let meta: Record<string, unknown> = {};
  if (prevMetadataJson) {
    try {
      const parsed = JSON.parse(prevMetadataJson);
      if (parsed && typeof parsed === 'object') meta = parsed as Record<string, unknown>;
    } catch {
      /* 旧值不合法直接丢 */
    }
  }
  const prevUi = (meta.ui && typeof meta.ui === 'object' ? meta.ui : {}) as Partial<AgentUiMeta>;
  meta.ui = { ...prevUi, ...patch };
  return JSON.stringify(meta);
}

interface TaskUiMeta {
  participants: string[];
}

function readTaskUiMeta(metadataJson: string | undefined, fallbackParticipant: string): TaskUiMeta {
  const fallback: TaskUiMeta = { participants: fallbackParticipant ? [fallbackParticipant] : [] };
  if (!metadataJson) return fallback;
  try {
    const meta = JSON.parse(metadataJson) as Record<string, unknown>;
    const slot = meta?.ui as Partial<TaskUiMeta> | undefined;
    if (slot && Array.isArray(slot.participants)) {
      return { participants: Array.from(new Set([...(slot.participants as string[]), fallbackParticipant].filter(Boolean))) };
    }
    return fallback;
  } catch {
    return fallback;
  }
}

function writeTaskUiMeta(prevMetadataJson: string | undefined, patch: Partial<TaskUiMeta>): string {
  let meta: Record<string, unknown> = {};
  if (prevMetadataJson) {
    try {
      const parsed = JSON.parse(prevMetadataJson);
      if (parsed && typeof parsed === 'object') meta = parsed as Record<string, unknown>;
    } catch {
      /* ignore */
    }
  }
  const prevUi = (meta.ui && typeof meta.ui === 'object' ? meta.ui : {}) as Partial<TaskUiMeta>;
  meta.ui = { ...prevUi, ...patch };
  return JSON.stringify(meta);
}

// ========================= Adapters（export 供 stores/backend.ts 使用） =========================

export function adaptTeam(bt: BackendTeam, members: TeamMember[]): Team {
  return {
    team_id: bt.team_id,
    name: bt.name,
    description: bt.description ?? '',
    owner_user_id: bt.owner_user_id,
    status: bt.status,
    created_at_ms: new Date(bt.created_at).getTime(),
    members,
  };
}

export function adaptMember(bm: BackendMember): TeamMember {
  return {
    user_id: bm.user_id,
    role: bm.role,
    joined_at_ms: new Date(bm.joined_at).getTime(),
    username: bm.username,
  };
}

export function adaptAgent(ba: BackendAgent, index: number): Agent {
  const ui = readAgentUiMeta(ba.metadata_json, index);
  // prompt 回退：当 metadata_json 不含 ui.role_prompt 时（agent 可能通过后端 API 直接创建，
  // 而非前端 UI），从后端 prompt 字段回退。prompt 是 role+rules 合在一起的完整文本，
  // 没有 ui 拆分时整体放到 role_prompt，rules_prompt 保持空。
  const rolePrompt = ui.role_prompt || ba.prompt || '';
  return {
    agent_id: ba.agent_id,
    team_id: ba.team_id,
    owner_user_id: ba.owner_user_id,
    name: ba.name,
    description: ba.description ?? '',
    role_prompt: rolePrompt,
    rules_prompt: ui.rules_prompt,
    icon: ui.icon,
    accent: ui.accent,
    // 资产绑定不再从 metadata_json.ui 读（.ui 已废弃为资产存储）。
    // 真实绑定读 skill 表 owner_agent_id / agent-fixed-asset 表：
    // list 计数走 agent-overview/bootstrap.counts，详情弹窗走 skillApi.listByAgent
    // + knowledgeApi.agentFixed + chatMemoryApi.agentFixed。这些字段保留仅为类型兼容。
    skills: [],
    code_graphs: [],
    llm_wikis: [],
    chat_memories: [],
    metadata_json: ba.metadata_json,
    created_at_ms: new Date(ba.created_at).getTime(),
    updated_at_ms: new Date(ba.updated_at).getTime(),
  };
}

function normalizeTaskStatus(backend: BackendTask['status']): TaskStatus {
  return backend === 'completed' ? 'completed' : 'running';
}

export function adaptTask(bt: BackendTask, linkedAgents: string[]): Task {
  const ui = readTaskUiMeta(bt.metadata_json, bt.creator_user_id);
  return {
    task_id: bt.task_id,
    team_id: bt.team_id,
    creator_user_id: bt.creator_user_id,
    participants: ui.participants,
    title: bt.title,
    description: bt.description ?? '',
    source_type: bt.source_type === 'tapd' ? 'tapd' : 'manual',
    source_url: bt.source_url ?? '',
    linked_agents: linkedAgents,
    status: normalizeTaskStatus(bt.status),
    created_at_ms: new Date(bt.created_at).getTime(),
    updated_at_ms: new Date(bt.updated_at).getTime(),
    metadata_json: bt.metadata_json,
  };
}

// ========================= Active team id（客户端 UI 状态，localStorage 持久化） =========================

const ACTIVE_TEAM_KEY = 'tdai-memory.activeTeam.v1';
const LOCAL_CHANGE_EVENT = 'tdai-memory.demo-store-change';

export function readActiveTeamId(): string | null {
  try { return localStorage.getItem(ACTIVE_TEAM_KEY); } catch { return null; }
}

export function writeActiveTeamId(teamId: string | null): void {
  try {
    if (teamId) localStorage.setItem(ACTIVE_TEAM_KEY, teamId);
    else localStorage.removeItem(ACTIVE_TEAM_KEY);
  } catch { /* ignore */ }
  try { window.dispatchEvent(new Event(LOCAL_CHANGE_EVENT)); } catch { /* ignore */ }
}

/** teams 加载完成后确保 activeTeamId 指向一个有效 team（否则选第一个 / 清空）。 */
export function ensureValidActiveTeamId(teams: Team[]): void {
  const cur = readActiveTeamId();
  if (cur && teams.some((t) => t.team_id === cur)) return;
  if (teams.length === 0) {
    if (cur) writeActiveTeamId(null);
    return;
  }
  writeActiveTeamId(teams[0].team_id);
}

// ========================= Hooks & cache（已迁移到 stores/backend.ts） =========================
//
// 旧的模块级变量（_cachedTeams / _cachedAgentsMap / _inflightTeams …）已全部
// 迁移到 zustand store（stores/backend.ts），通过 useTeams / useAgents / useTasks
// 从 store 读数据 + 触发 fetch，多个组件共享同一份状态，不再重复请求。
//
// invalidateBackendCache / clearBackendCache 也由新 store 提供，这里 re-export
// 保持调用方无需改 import 路径。

export {
  useTeams,
  useAgents,
  useTasks,
  readActiveTeamAgents,
  invalidateBackendCache,
  clearBackendCache,
  invalidateTeamCache,
} from '@/stores/backend';

// ========================= Permissions =========================

export function roleInTeam(team: Team | null | undefined, userId: string): 'admin' | 'member' | 'reviewer' | null {
  if (!team) return null;
  const member = team.members.find((m) => m.user_id === userId);
  if (member) return member.role;
  // team owner 如果不在 members 列表里（后端 owner 不一定出现在 members 数组中），
  // 默认按 'member' 处理——owner 在 team 内能管理资源，应能看到资源页。
  // 不返回 'admin' 是因为 useCurrentRole 返回的 'admin' 语义是"全局 admin"（看不到资源页），
  // team owner 不是全局 admin，不应被 AdminResourceLock 锁住。
  if (team.owner_user_id === userId) return 'member';
  return null;
}

export function isTeamAdmin(team: Team | null | undefined, userId: string): boolean {
  if (!team) return false;
  if (team.owner_user_id === userId) return true;
  return team.members.some((m) => m.user_id === userId && m.role === 'admin');
}

export function isTeamMember(team: Team | null | undefined, userId: string): boolean {
  return roleInTeam(team, userId) !== null;
}

export function canManageAsset(
  asset: { owner_user_id: string; team_id: string },
  team: Team | null | undefined,
  userId: string,
  _isGlobalAdminFlag?: boolean
): boolean {
  if (!userId) return false;
  // admin 不再拥有全局特权，与 member 一致：只能操作自己 owner 的资产。
  if (asset.owner_user_id === userId) return true;
  if (team && team.team_id === asset.team_id && isTeamAdmin(team, userId)) return true;
  return false;
}

export function canEditTask(task: Task, team: Team | null | undefined, userId: string): boolean {
  if (!userId) return false;
  if (!team || team.team_id !== task.team_id) return false;
  return isTeamMember(team, userId);
}

export function canDeleteTask(task: Task, team: Team | null | undefined, userId: string): boolean {
  return canManageAsset({ owner_user_id: task.creator_user_id, team_id: task.team_id }, team, userId);
}

// ========================= Task mutations（async，包一层 diff/参与者逻辑） =========================

export async function createTaskAsync(input: {
  team_id: string;
  creator_user_id: string;
  title: string;
  description: string;
  source_type: TaskSourceType;
  source_url: string;
  linked_agents: string[];
}): Promise<Task> {
  const created = await tasksApi.create(input.team_id, {
    title: input.title,
    description: input.description,
    source_type: input.source_type,
    source_url: input.source_url || undefined,
    linked_agents: input.linked_agents.length > 0 ? input.linked_agents : undefined,
  });
  invalidateBackendCache();
  return adaptTask(created, input.linked_agents);
}

export async function deleteTaskAsync(taskId: string): Promise<void> {
  await tasksApi.delete(taskId);
  invalidateBackendCache();
}

export async function updateTaskStatusAsync(taskId: string, status: TaskStatus, actorUserId?: string): Promise<void> {
  const patch: Record<string, unknown> = { status };
  if (actorUserId) {
    // 参与者留痕：读一次当前 task 详情，把 actor 并入 participants 再写回 metadata_json
    try {
      const current = await tasksApi.get(taskId);
      const ui = readTaskUiMeta(current.metadata_json, current.creator_user_id);
      if (!ui.participants.includes(actorUserId)) {
        patch.metadata_json = writeTaskUiMeta(current.metadata_json, {
          participants: [...ui.participants, actorUserId],
        });
      }
    } catch { /* 参与者留痕失败不阻断状态切换 */ }
  }
  await tasksApi.update(taskId, patch as Parameters<typeof tasksApi.update>[1]);
  invalidateBackendCache();
}

export async function updateTaskAsync(
  taskId: string,
  patch: Partial<Pick<Task, 'title' | 'description' | 'source_type' | 'source_url' | 'linked_agents'>>,
  actorUserId?: string
): Promise<void> {
  const current = await tasksApi.get(taskId);
  const updatePayload: Record<string, unknown> = {};
  if (patch.title !== undefined) updatePayload.title = patch.title;
  if (patch.description !== undefined) updatePayload.description = patch.description;
  if (patch.source_url !== undefined) updatePayload.source_url = patch.source_url;

  const ui = readTaskUiMeta(current.metadata_json, current.creator_user_id);
  const nextParticipants = actorUserId && !ui.participants.includes(actorUserId)
    ? [...ui.participants, actorUserId]
    : ui.participants;
  if (nextParticipants !== ui.participants) {
    updatePayload.metadata_json = writeTaskUiMeta(current.metadata_json, { participants: nextParticipants });
  }
  if (Object.keys(updatePayload).length > 0) {
    await tasksApi.update(taskId, updatePayload as Parameters<typeof tasksApi.update>[1]);
  }

  if (patch.linked_agents) {
    const before = new Set(current.agents.filter((a) => a.status === 'active').map((a) => a.agent_id));
    const after = new Set(patch.linked_agents);
    const toLink = [...after].filter((id) => !before.has(id));
    const toUnlink = [...before].filter((id) => !after.has(id));
    await Promise.all([
      ...toLink.map((id) => tasksApi.linkAgent(taskId, id)),
      ...toUnlink.map((id) => tasksApi.unlinkAgent(taskId, id)),
    ]);
  }
  invalidateBackendCache();
}
