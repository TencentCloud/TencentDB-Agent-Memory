/**
 * useSkillsPanel —— Skills 页面的状态与数据逻辑。
 * 组件层只保留 JSX 渲染，状态 / 数据逻辑集中在此。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { assetsApi, agentsApi, type Asset } from '@/lib/teamApi';
import {
  listSkills,
  getSkill,
  deleteSkillV3,
  exportSkill,
  type SkillSummary,
} from '@/lib/skill-api';
import { getPanelSession } from '@/lib/panelSession';
import { useTeams } from '@/services';
import { useSkillDetailCache } from '@/services/use-skill-detail-cache';
import { tea } from '@/lib/tea-bridge';

export type Tab = 'team' | 'fixed';

export const TAB_I18N_KEY: Record<Tab, string> = {
  team: 'skills.scope.team',
  fixed: 'skills.scope.fixed',
};

export function useSkillsPanel() {
  const { t } = useTranslation();
  // 默认展示 Agent 资产（fixed），避免用户误以为自己的资产在「团队资产」里
  const [tab, setTab] = useState<Tab>('fixed');
  const { activeTeamId, activeTeam } = useTeams();
  const myUserId = getPanelSession()?.user?.user_id ?? '';
  const [selectedAgent, setSelectedAgent] = useState<string>('');
  const [skills, setSkills] = useState<SkillSummary[]>([]);

  // team 内 agent 数据 —— 一次全量拉取，前端派生两份，避免之前分别为
  // 「name 映射（全量）」和「我 owner 的 agent（fixed 下拉）」发两次 agent/list：
  //   - agentNameMap：team 内**全部** agent 的 id→name（团队资产里会出现别人
  //     agent 的 skill，需要能显示归属 agent 名）。
  //   - teamAgents：前端按 owner_user_id === myUserId 过滤出**我 owner 的 agent**
  //     （fixed tab 下拉 / 导入 / fork 用；agent 私有可见性语义）。
  const [teamAgents, setTeamAgents] = useState<Array<{ id: string; name: string }>>([]);
  const [agentNameMap, setAgentNameMap] = useState<Record<string, string>>({});
  // agent 列表加载态：fixed tab 依赖 agent（下拉 + 按 agent 拉 skill），
  // 初始 true 让首屏就是加载态，避免 agent 请求期间左侧列表先闪空态再变加载态。
  const [agentsLoading, setAgentsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    if (!activeTeamId) {
      setAgentNameMap({});
      setTeamAgents([]);
      setAgentsLoading(false);
      return () => {
        cancelled = true;
      };
    }
    setAgentsLoading(true);
    agentsApi
      .list(activeTeamId)
      .then((agents) => {
        if (cancelled) return;
        setAgentNameMap(Object.fromEntries(agents.map((a) => [a.agent_id, a.name])));
        setTeamAgents(
          agents
            .filter((a) => !!myUserId && a.owner_user_id === myUserId)
            .map((a) => ({ id: a.agent_id, name: a.name })),
        );
      })
      .catch((err) => {
        if (cancelled) return;
        // agent 加载失败不致命（列表 fallback 显示 agent_id），但仍给出提示。
        tea.notify.error(err?.message || t('skills.notify.loadAgentsFailed'));
        setAgentNameMap({});
        setTeamAgents([]);
      })
      .finally(() => {
        if (!cancelled) setAgentsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeTeamId, myUserId]);

  const [loading, setLoading] = useState(false);
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null);
  const [showImport, setShowImport] = useState(false);
  const [showFork, setShowFork] = useState(false);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [exportLoading, setExportLoading] = useState(false);
  // team tab 下每条 skill 的 visibility（从 meta_assets 拿），列表徽章展示用。
  // key = skill_id（=asset_id）。fixed tab 不填。
  const [visibilityMap, setVisibilityMap] = useState<Record<string, Asset['visibility']>>({});

  // ── 按需 skill 详情缓存 ──
  // team tab 列表数据源是 asset/list-accessible，不含 skill 数据面的
  // version / owner_agent_id；不再对每条 skill 并发 N 次 getSkill()，
  // 改为用户选中后才按需拉取并写入此缓存。
  const {
    applyCachedDetail,
    preload: preloadSkillDetail,
    cacheVersion,
  } = useSkillDetailCache(activeTeamId);

  // 对 skills 列表应用缓存：已拉过的 skill 更新为真实 version / owner_agent_id。
  const skillsWithCache = useMemo(
    () => skills.map((s) => applyCachedDetail(s)),
    [skills, cacheVersion],
  );

  // 选中某条 skill 时按需预拉其数据面详情（幂等，已缓存则跳过）。
  // 不做列表级批量预取：有多少 skill 就发多少次 getSkill() 太浪费，
  // 详情只在用户点开时按需加载。
  useEffect(() => {
    if (selectedSkillId) void preloadSkillDetail(selectedSkillId);
  }, [selectedSkillId, preloadSkillDetail]);

  // ============================
  // Data fetching
  // ============================

  // 请求序号防竞态：快速切换 tab/agent 时，先发的请求可能后返回，
  // 旧 tab 的数据会覆盖新 tab 的数据。
  const refreshSeqRef = useRef(0);

  const refresh = useCallback(async () => {
    if (!activeTeamId) {
      setSkills([]);
      setVisibilityMap({});
      return;
    }
    const seq = ++refreshSeqRef.current;
    setLoading(true);
    // 立即清空旧数据 —— 否则切 tab 时会先看到上一个 tab 的列表，
    // 新数据到了才突然替换，视觉上就是"闪一下"。
    setSkills([]);
    setVisibilityMap({});
    try {
      if (tab === 'team') {
        // 团队资产 tab 语义：**只显示共享的（visibility=team） skill**，
        // 私密 skill（包括自己 owner 的）都不出现在这里。自己的私密去
        // "我的资产分配" tab 查看和管理。
        //
        // 数据源（服务端严格过滤，抓包也拿不到不该看的）：
        //   asset/list-accessible + visibility='team'
        //     → 内核 SQL 层直接过滤 private，HTTP 响应体里根本不包含别人的
        //       private，也不包含自己的 private，安全。
        //
        // 为什么不调 skill/list：
        //   数据面 skill/list 没有 visibility 概念，会把别人的 private 一并
        //   返回（虽然内核 permission-checker 后续会拦截读取，但列表响应
        //   仍会带回 name/owner 等元信息，前端过滤 = 数据已泄露）。
        //
        // 按需加载 version / owner_agent_id：
        //   asset 表无这两个字段；旧实现在此处对每条 skill 并发 N 次
        //   getSkill()（N+1），用户还没点开任何一条就把全部详情拉回来。
        //   现在先用 asset 默认值渲染，version/owner_agent_id 等用户选中
        //   后才由 useSkillDetailCache 按需拉取并写入缓存。
        const accessible = await assetsApi.listAccessible(activeTeamId, {
          asset_type: 'skill',
          action: 'read',
          visibility: 'team',
        });
        if (seq !== refreshSeqRef.current) return; // 已被后续请求取代
        const visMap: Record<string, Asset['visibility']> = {};
        for (const a of accessible) visMap[a.asset_id] = a.visibility;
        const toMs = (iso: string): number => new Date(iso).getTime();
        const items: SkillSummary[] = accessible.map((a) => ({
          skill_id: a.asset_id,
          name: a.name,
          description: a.description ?? '',
          version: a.version ?? 1,
          is_head: true,
          status: a.status === 'archived' ? 'archived' : 'active',
          owner_user_id: a.owner_user_id,
          owner_agent_id: '',
          team_id: a.team_id,
          task_id: '',
          created_at_ms: toMs(a.created_at),
          updated_at_ms: toMs(a.updated_at),
        })) as SkillSummary[];
        // 不再额外等待；直接用 asset 默认值渲染，缓存命中后自动更新。
        setSkills(items);
        setVisibilityMap(visMap);
      } else {
        // 固定资产 = 指定 agent 拥有（owner）的 skill；这一 tab 侧重"某 agent 装备了什么"，
        // 由 owner 权限判定即可，不再叠加 visibility 过滤（agent owner 一定能看到自己的 skill）。
        // meta_assets 主表，与 assetsApi.update 写入同源，读写一致。
        if (!selectedAgent) {
          if (seq !== refreshSeqRef.current) return;
          setSkills([]);
          setVisibilityMap({});
        } else {
          const [listRes, accessible] = await Promise.all([
            listSkills({
              team_id: activeTeamId,
              filters: { owner_agent_id: selectedAgent, status: ['active'] },
              pagination: { limit: 200 },
            }),
            assetsApi
              .listAccessible(activeTeamId, { asset_type: 'skill', action: 'read' })
              .catch(() => [] as Asset[]),
          ]);
          if (seq !== refreshSeqRef.current) return; // 已被后续请求取代
          const vm: Record<string, Asset['visibility']> = {};
          for (const a of accessible) vm[a.asset_id] = a.visibility;
          setSkills(listRes.items);
          setVisibilityMap(vm);
        }
      }
    } catch (err) {
      if (seq !== refreshSeqRef.current) return;
      tea.notify.error(err);
      setSkills([]);
      setVisibilityMap({});
    } finally {
      if (seq === refreshSeqRef.current) setLoading(false);
    }
  }, [tab, selectedAgent, activeTeamId]);

  // 同步 selectedAgent 到 teamAgents：
  //   - 切换 team 后，老 selectedAgent 可能已不在新 team 内，需要重置；
  //   - 首次渲染时也要给 selectedAgent 一个默认值。
  useEffect(() => {
    if (teamAgents.length === 0) {
      if (selectedAgent) setSelectedAgent('');
      return;
    }
    if (!selectedAgent || !teamAgents.some((a) => a.id === selectedAgent)) {
      setSelectedAgent(teamAgents[0].id);
    }
  }, [teamAgents, selectedAgent]);

  // 触发 refresh：依赖原始参数 + refresh，并用 key 去重防止短时间内重复触发。
  // 之前直接 `useEffect(() => refresh(), [refresh])` 会因 refresh 引用变化
  // （selectedAgent 等依赖异步同步）触发多次，导致 asset/list-accessible 等接口被反复请求。
  const fetchKeyRef = useRef<string>('');
  useEffect(() => {
    // key 中只有 fixed tab 才纳入 selectedAgent —— team tab 的数据源
    // asset/list-accessible 与选中 agent 无关。若把 selectedAgent 纳入 team 的 key，
    // teamAgents 异步加载完后 selectedAgent 会从 '' 变成首个 agent，导致 key 变化、
    // 再触发一次**完全重复**的 list-accessible（进页面即多打一次接口）。
    const key =
      tab === 'fixed' ? `${activeTeamId}|${tab}|${selectedAgent}` : `${activeTeamId}|${tab}`;
    if (fetchKeyRef.current === key) return;
    fetchKeyRef.current = key;
    void refresh();
  }, [activeTeamId, tab, selectedAgent, refresh]);

  // 选中项不在列表里时清空选中。
  // 跳过 loading 中间态：refresh 会先 setSkills([]) 再重新拉取，
  // 若在清空瞬间就判断会把选中误置空（编辑保存后刷新会丢失当前选中）。
  // 等刷新完成（loading=false）、列表填充后再判断，选中项仍在则保留。
  useEffect(() => {
    if (loading) return;
    if (selectedSkillId && !skillsWithCache.find((s) => s.skill_id === selectedSkillId)) {
      setSelectedSkillId(null);
    }
  }, [skillsWithCache, selectedSkillId, loading]);

  const selectedSkill = useMemo(
    () =>
      selectedSkillId
        ? (skillsWithCache.find((s) => s.skill_id === selectedSkillId) ?? null)
        : null,
    [selectedSkillId, skillsWithCache],
  );

  // ============================
  // Delete handler
  // ============================

  const handleDelete = useCallback(
    async (skill: SkillSummary) => {
      if (!activeTeamId) return;
      setDeleteLoading(true);
      try {
        // 数据面软删除需要 owner_agent_id + expected_version 乐观锁。
        // 团队 tab 数据源来自 asset/list-accessible，那份数据没有 owner_agent_id
        // 和 version（asset 表无这两字段），列表里 skill.owner_agent_id 会是 ''。
        // 这里按需再拉一次 skill/get 补齐。
        let ownerAgentId = skill.owner_agent_id;
        let version = skill.version;
        if (!ownerAgentId) {
          const full = await getSkill({
            skill_id: skill.skill_id,
            team_id: activeTeamId,
            include_content: false,
            include_manifest: false,
          });
          ownerAgentId = full.owner_agent_id;
          version = full.version;
        }
        await deleteSkillV3({
          user_id: myUserId,
          team_id: activeTeamId,
          agent_id: ownerAgentId,
          skill_id: skill.skill_id,
          expected_version: version,
        });
        if (selectedSkillId === skill.skill_id) {
          setSelectedSkillId(null);
        }
        tea.notify.success(t('skills.notify.deleted', { name: skill.name }));
        void refresh();
      } catch (err) {
        tea.notify.error(err);
      } finally {
        setDeleteLoading(false);
      }
    },
    [selectedSkillId, refresh, activeTeamId, myUserId],
  );

  // ============================
  // Export handler
  // ============================

  const handleExport = useCallback(async () => {
    const exportSkillId = selectedSkillId;
    if (!exportSkillId) return;
    setExportLoading(true);
    try {
      const result = await exportSkill({
        team_id: activeTeamId ?? '',
        skill_id: exportSkillId,
      });
      // base64 → Blob → download
      const byteChars = atob(result.zip_base64);
      const byteNums = new Array(byteChars.length);
      for (let i = 0; i < byteChars.length; i++) {
        byteNums[i] = byteChars.charCodeAt(i);
      }
      const blob = new Blob([new Uint8Array(byteNums)], { type: 'application/zip' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = result.filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      if (result.warnings.length > 0) {
        tea.notify.warning(t('skills.export.partial', { warnings: result.warnings.join('; ') }));
      }
    } catch (err: any) {
      const msg =
        err?.name === 'AbortError' || err?.name === 'TimeoutError'
          ? t('skills.export.timeout')
          : (err?.message ?? String(err));
      tea.notify.error({ description: msg });
    } finally {
      setExportLoading(false);
    }
  }, [selectedSkillId, activeTeamId]);

  // ============================
  // Visibility toggle (shared/private)
  // ============================
  // 共享/私密切换：原「个人资产」tab 的能力，迁到「Agent 资产(fixed)」tab 的资产项上，
  // 仅 owner 可切（SkillsPanel 渲染处按 owner_user_id 判断）。skill_id === asset_id。
  const handleToggleVisibility = useCallback(
    async (skill: SkillSummary, scope: 'team' | 'private') => {
      const current = visibilityMap[skill.skill_id];
      // current 缺失时按 private 兜底：owner 视角下 getAssets 已不过滤，
      // 正常都能拿到 visibility；万一仍缺失（旧数据/接口异常），也允许
      // 切换而非直接 return，避免又卡死无法切回 team。
      if (current === scope) return;
      try {
        await assetsApi.update(skill.skill_id, { visibility: scope });
        // 局部更新 visibility 徽章，避免整表 flicker
        setVisibilityMap((prev) => ({ ...prev, [skill.skill_id]: scope }));
      } catch (err) {
        tea.notify.error(err);
      }
    },
    [visibilityMap],
  );

  // 列表加载态（供左侧 AssetListPanel 使用）。
  // fixed tab 依赖 agent，需覆盖三段"数据未就绪"期，否则会先闪空态：
  //   1) agentsLoading：agent 列表请求中
  //   2) teamAgents 已就绪但 selectedAgent 尚未由 effect 设定的 gap
  //   3) loading：按 agent 拉 skill 列表请求中
  // team tab 不依赖 agent，直接用 skill 列表 loading。
  const listLoading =
    tab === 'fixed'
      ? agentsLoading || loading || (teamAgents.length > 0 && !selectedAgent)
      : loading;

  return {
    // context
    activeTeam,
    activeTeamId,
    myUserId,
    teamAgents,
    agentNameMap,
    // state
    tab,
    setTab,
    selectedAgent,
    setSelectedAgent,
    skills,
    loading: listLoading,
    selectedSkillId,
    setSelectedSkillId,
    showImport,
    setShowImport,
    showFork,
    setShowFork,
    deleteLoading,
    exportLoading,
    visibilityMap,
    // cache
    skillsWithCache,
    preloadSkillDetail,
    applyCachedDetail,
    cacheVersion,
    // handlers
    refresh,
    handleDelete,
    handleExport,
    handleToggleVisibility,
    selectedSkill,
  };
}

export type SkillsStore = ReturnType<typeof useSkillsPanel>;
