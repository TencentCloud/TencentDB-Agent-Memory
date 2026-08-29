/**
 * stores/backend.ts — 全局后端数据 store（zustand）。
 *
 * 取代 backendStore.ts 里的模块级变量（_cachedTeams / _cachedAgentsMap / _inflightTeams …）。
 *
 * 核心设计：
 *   - teamsLoaded / agentsLoadedTeamIds：标记"已加载过"，
 *     避免每个组件挂载都重复 fetch。
 *   - invalidate()：写操作后调，清所有缓存 + 广播 BACKEND_REFRESH_EVENT。
 *   - invalidateTeam(teamId)：切 team 时只清当前 team 的 agents/tasks 缓存。
 *   - useTeams / useAgents / useTasks：从 store 读数据 + 触发 fetch，多组件共享同一份状态。
 */

import { create } from 'zustand';
import { useEffect, useState } from 'react';
import {
  teamsApi,
  membersApi,
  agentsApi,
  tasksApi,
  type TeamMember as BackendMember,
} from '@/lib/teamApi';
import { tea } from '@/lib/tea-bridge';
import i18n from '@/i18n';
import { seedDisplayNameCache } from '@/services/user-profile-store';

// 从 backendStore.ts re-import 纯函数（adapters / types），避免循环依赖
import {
  type Team,
  type Agent,
  type Task,
  adaptTeam,
  adaptMember,
  adaptAgent,
  adaptTask,
  readActiveTeamId,
  writeActiveTeamId,
  ensureValidActiveTeamId,
} from '@/services/backendStore';

// ========================= 事件常量 =========================

const BACKEND_REFRESH_EVENT = 'tdai-memory.backend-refresh';
const LOCAL_CHANGE_EVENT = 'tdai-memory.demo-store-change';

function emitBackendRefresh() {
  try { window.dispatchEvent(new Event(BACKEND_REFRESH_EVENT)); } catch { /* ignore */ }
}

// ========================= Store 类型 =========================

interface BackendState {
  // 数据
  teams: Team[];
  activeTeamId: string | null;
  agentsByTeam: Record<string, Agent[]>;
  // 全量总数（内核返回的 total），前端分页基于此计算总页数
  tasksTotalByTeam: Record<string, number>;
  // 后端分页缓存：tasksPagesByTeam[teamId]["offset:limit"] = Task[]
  tasksPagesByTeam: Record<string, Record<string, Task[]>>;
  // loaded 标记（避免重复 fetch）
  teamsLoaded: boolean;
  teamsLoading: boolean;
  agentsLoadedTeamIds: Set<string>;
  // in-flight 去重
  inflightTeams: Promise<void> | null;
  inflightAgents: Record<string, Promise<Agent[]>>;
  inflightTasks: Record<string, Promise<Task[]> | undefined>;

  // actions
  fetchTeams: () => Promise<void>;
  /**
   * 强制重新拉取 team 列表（忽略 teamsLoaded 缓存，保留 in-flight 去重）。
   * `silent: true` 时不在 UI 层翻转 teamsLoading —— 用于下拉框展开等后台保新鲜
   * 场景，避免 TeamManagementPanel 等消费方因 teamsLoading=true 而整体进入
   * loading 占位（表现为"点一下下拉框页面就刷新"）。
   */
  refreshTeams: (opts?: { silent?: boolean }) => Promise<void>;
  fetchAgents: (teamId: string) => Promise<Agent[]>;
  fetchTasks: (teamId: string, params?: { limit?: number; offset?: number; force?: boolean }) => Promise<Task[]>;
  setActiveTeamId: (teamId: string | null) => void;
  invalidate: () => void;
  invalidateTeam: (teamId: string) => void;
  clearAll: () => void;
}

// ========================= Store 实现 =========================

export const useBackendStore = create<BackendState>((set, get) => ({
  teams: [],
  activeTeamId: readActiveTeamId(),
  agentsByTeam: {},
  tasksTotalByTeam: {},
  tasksPagesByTeam: {},
  teamsLoaded: false,
  teamsLoading: false,
  agentsLoadedTeamIds: new Set(),
  inflightTeams: null,
  inflightAgents: {},
  inflightTasks: {},

  fetchTeams: async () => {
    const state = get();
    // 已加载过 → 不重复 fetch（只有 invalidate / clearAll 后才会重新拉）
    if (state.teamsLoaded) return;
    await get().refreshTeams();
  },

  refreshTeams: async (opts?: { silent?: boolean }) => {
    const state = get();
    // in-flight 去重：多个组件同时挂载时只发一次
    if (state.inflightTeams) { await state.inflightTeams; return; }

    const silent = opts?.silent === true;
    const promise = (async () => {
      // 静默刷新不翻转 teamsLoading —— 消费方（TeamManagementPanel 等）依赖它
      // 显示 loading 占位；下拉框展开这类后台保新鲜场景翻转它会导致
      // "点一下下拉框整个页面闪成 loading 再恢复"。
      if (!silent) set({ teamsLoading: true });
      try {
        const backendTeams = await teamsApi.list();
        // 批量拉 members（N+1 → N，但这是后端 API 限制，无批量接口）
        const memberResults = await Promise.all(
          backendTeams.map((t) => membersApi.list(t.team_id).catch(() => [] as BackendMember[]))
        );
        const adapted = backendTeams.map((bt, i) =>
          adaptTeam(bt, memberResults[i].map(adaptMember))
        );
        seedDisplayNameCache(adapted.flatMap((t) => t.members));
        ensureValidActiveTeamId(adapted);
        set({
          teams: adapted,
          teamsLoaded: true,
          teamsLoading: false,
          activeTeamId: readActiveTeamId(),
        });
      } catch (err) {
        console.error('[backend store] refreshTeams failed:', err);
        set({ teamsLoading: false });
        tea.notify.error(i18n.t('backend.loadTeamsFailed'));
      } finally {
        set({ inflightTeams: null });
      }
    })();

    set({ inflightTeams: promise });
    await promise;
  },

  fetchAgents: async (teamId: string) => {
    const state = get();
    // 已加载过 → 直接返回缓存
    if (state.agentsLoadedTeamIds.has(teamId)) {
      return state.agentsByTeam[teamId] ?? [];
    }
    // in-flight 去重
    if (state.inflightAgents[teamId] != null) {
      return state.inflightAgents[teamId];
    }

    const promise = (async () => {
      try {
        const backendAgents = await agentsApi.list(teamId);
        const adapted = backendAgents.map((ba, i) => adaptAgent(ba, i));
        set((s) => ({
          agentsByTeam: { ...s.agentsByTeam, [teamId]: adapted },
          agentsLoadedTeamIds: new Set(s.agentsLoadedTeamIds).add(teamId),
          inflightAgents: Object.fromEntries(
            Object.entries(s.inflightAgents).filter(([k]) => k !== teamId)
          ),
        }));
        return adapted;
      } catch (err) {
        console.error('[backend store] fetchAgents failed:', err);
        set((s) => ({
          inflightAgents: Object.fromEntries(
            Object.entries(s.inflightAgents).filter(([k]) => k !== teamId)
          ),
        }));
        tea.notify.error(i18n.t('backend.loadAgentsFailed'));
        return [];
      }
    })();

    set((s) => ({ inflightAgents: { ...s.inflightAgents, [teamId]: promise } }));
    return promise;
  },

  fetchTasks: async (teamId: string, params?: { limit?: number; offset?: number; force?: boolean }) => {
    const state = get();
    const limit = params?.limit ?? 20;
    const offset = params?.offset ?? 0;
    // 缓存 key：按 (offset, limit) 粒度（teamId 已在 tasksPagesByTeam[teamId] 这层隔离）
    const cacheKey = `${offset}:${limit}`;
    // 已缓存且非强制刷新 → 直接返回
    if (!params?.force && state.tasksPagesByTeam[teamId]?.[cacheKey]) {
      return state.tasksPagesByTeam[teamId][cacheKey];
    }
    // in-flight 去重
    if (state.inflightTasks[cacheKey]) { await state.inflightTasks[cacheKey]; return get().tasksPagesByTeam[teamId]?.[cacheKey] ?? []; }

    const promise = (async () => {
      try {
        const { items: tasksWithAgents, total } = await tasksApi.listWithAgents(teamId, { limit, offset });
        const adapted = tasksWithAgents.map((t) =>
          adaptTask(t, t.agents.filter((a) => a.status === 'active').map((a) => a.agent_id))
        );
        set((s) => {
          const teamPages = s.tasksPagesByTeam[teamId] ?? {};
          return {
            tasksPagesByTeam: { ...s.tasksPagesByTeam, [teamId]: { ...teamPages, [cacheKey]: adapted } },
            tasksTotalByTeam: { ...s.tasksTotalByTeam, [teamId]: total },
            inflightTasks: Object.fromEntries(
              Object.entries(s.inflightTasks).filter(([k]) => k !== cacheKey)
            ),
          };
        });
        return adapted;
      } catch (err) {
        console.error('[backend store] fetchTasks failed:', err);
        set((s) => ({
          inflightTasks: Object.fromEntries(
            Object.entries(s.inflightTasks).filter(([k]) => k !== cacheKey)
          ),
        }));
        tea.notify.error(i18n.t('backend.loadTasksFailed'));
        return [];
      }
    })();

    set((s) => ({ inflightTasks: { ...s.inflightTasks, [cacheKey]: promise } }));
    return promise;
  },

  setActiveTeamId: (teamId) => {
    writeActiveTeamId(teamId);
    set({ activeTeamId: teamId });
  },

  // 写操作后调：清所有缓存 + 广播刷新
  invalidate: () => {
    set({
      teams: [],
      teamsLoaded: false,
      teamsLoading: false,
      agentsByTeam: {},
      tasksTotalByTeam: {},
      tasksPagesByTeam: {},
      agentsLoadedTeamIds: new Set(),
      inflightTeams: null,
      inflightAgents: {},
      inflightTasks: {},
    });
    emitBackendRefresh();
  },

  // 切 team 时调：只清当前 team 的 agents/tasks 缓存
  invalidateTeam: (teamId) => {
    set((s) => {
      const agentsLoadedTeamIds = new Set(s.agentsLoadedTeamIds);
      agentsLoadedTeamIds.delete(teamId);
      const agentsByTeam = { ...s.agentsByTeam };
      delete agentsByTeam[teamId];
      const tasksPagesByTeam = { ...s.tasksPagesByTeam };
      delete tasksPagesByTeam[teamId];
      const tasksTotalByTeam = { ...s.tasksTotalByTeam };
      delete tasksTotalByTeam[teamId];
      return { agentsLoadedTeamIds, agentsByTeam, tasksPagesByTeam, tasksTotalByTeam };
    });
    emitBackendRefresh();
  },

  // 登出 / 401 时调：清所有缓存但不广播事件
  clearAll: () => {
    set({
      teams: [],
      teamsLoaded: false,
      teamsLoading: false,
      agentsByTeam: {},
      tasksTotalByTeam: {},
      tasksPagesByTeam: {},
      agentsLoadedTeamIds: new Set(),
      inflightTeams: null,
      inflightAgents: {},
      inflightTasks: {},
    });
  },
}));

// ========================= React Hooks =========================

/**
 * useTeams — 从 store 读 team 列表 + activeTeamId。
 *
 * 多个组件调 useTeams() 只会触发一次 fetchTeams（teamsLoaded 标记 + in-flight 去重）。
 * 写操作后调 invalidate() → teamsLoaded=false → 下次组件挂载/渲染时重新 fetch。
 * 切 team 通过 setActiveTeamId → 写 localStorage + 更新 state。
 */
export function useTeams(): {
  teams: Team[];
  activeTeamId: string | null;
  activeTeam: Team | null;
  loading: boolean;
} {
  const teams = useBackendStore((s) => s.teams);
  const teamsLoaded = useBackendStore((s) => s.teamsLoaded);
  const teamsLoading = useBackendStore((s) => s.teamsLoading);
  const activeTeamId = useBackendStore((s) => s.activeTeamId);
  const fetchTeams = useBackendStore((s) => s.fetchTeams);

  useEffect(() => {
    if (!teamsLoaded && !teamsLoading) {
      void fetchTeams();
    }
  }, [teamsLoaded, teamsLoading, fetchTeams]);

  // 监听 localStorage 变化（TeamSwitcher 写 activeTeamId 时触发）
  const [, force] = useState(0);
  useEffect(() => {
    const onLocalChange = () => {
      useBackendStore.setState({ activeTeamId: readActiveTeamId() });
      force((n) => n + 1);
    };
    window.addEventListener(LOCAL_CHANGE_EVENT, onLocalChange);
    return () => window.removeEventListener(LOCAL_CHANGE_EVENT, onLocalChange);
  }, []);

  const activeTeam = teams.find((t) => t.team_id === activeTeamId) ?? null;
  return { teams, activeTeamId, activeTeam, loading: teamsLoading };
}

const EMPTY_AGENTS: Agent[] = [];
const EMPTY_TASKS: Task[] = [];

/**
 * useAgents — 从 store 读指定 team 的 agent 列表。
 *
 * 同一 teamId 多个组件调用只触发一次 fetch。
 * invalidate() 或 invalidateTeam(teamId) 后才会重新拉。
 */
export function useAgents(teamId: string | null | undefined): {
  agents: Agent[];
  loading: boolean;
} {
  // 用 ref 缓存上次的 teamId，避免 selector 每次返回不同引用
  const agents = useBackendStore((s) =>
    teamId ? (s.agentsByTeam[teamId] ?? EMPTY_AGENTS) : EMPTY_AGENTS
  );
  const loaded = useBackendStore((s) => (teamId ? s.agentsLoadedTeamIds.has(teamId) : true));
  const fetchAgents = useBackendStore((s) => s.fetchAgents);

  useEffect(() => {
    if (!teamId) return;
    if (!loaded) {
      void fetchAgents(teamId);
    }
  }, [teamId, loaded, fetchAgents]);

  return { agents, loading: !!teamId && !loaded };
}

/**
 * useTasks — 从 store 读指定 team 的 task 列表。
 */
export function useTasks(teamId: string | null | undefined, page: number = 1, pageSize: number = 12): {
  tasks: Task[];
  total: number;
  loading: boolean;
} {
  const offset = (page - 1) * pageSize;
  const cacheKey = `${offset}:${pageSize}`;
  const tasks = useBackendStore((s) =>
    teamId ? (s.tasksPagesByTeam[teamId]?.[cacheKey] ?? EMPTY_TASKS) : EMPTY_TASKS
  );
  const total = useBackendStore((s) =>
    teamId ? (s.tasksTotalByTeam[teamId] ?? 0) : 0
  );
  const loaded = useBackendStore((s) =>
    teamId ? !!s.tasksPagesByTeam[teamId]?.[cacheKey] : true
  );
  const fetchTasks = useBackendStore((s) => s.fetchTasks);

  useEffect(() => {
    if (!teamId || loaded) return;
    void fetchTasks(teamId, { limit: pageSize, offset });
  }, [teamId, offset, pageSize, loaded, fetchTasks]);

  return { tasks, total, loading: !!teamId && !loaded };
}

/**
 * readActiveTeamAgents — 同步读缓存的 agent 列表（不触发请求）。
 * 供 SkillsPanel 等仅需"引用列表"的场景使用。
 */
export function readActiveTeamAgents(teamId: string | null): Array<{ id: string; name: string }> {
  if (!teamId) return [];
  const cached = useBackendStore.getState().agentsByTeam[teamId];
  if (cached) return cached.map((a) => ({ id: a.agent_id, name: a.name }));
  // 缓存未命中：触发后台拉取
  void useBackendStore.getState().fetchAgents(teamId);
  return [];
}

// ========================= 导出 invalidate / clearAll（供 mutations 调用） =========================

export function invalidateBackendCache(): void {
  useBackendStore.getState().invalidate();
}

export function clearBackendCache(): void {
  useBackendStore.getState().clearAll();
}

export function invalidateTeamCache(teamId: string): void {
  useBackendStore.getState().invalidateTeam(teamId);
}
