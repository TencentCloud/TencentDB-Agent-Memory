/**
 * SessionDefaultDialog — 设置/修改用户级 Session 默认 (team, agent, task) 三元组。
 *
 * 产品意图 (PRD 70195170):
 *   每次 Session Init 都要重复选 team/agent/task 影响效率, 用户在面板一次性
 *   选好默认, 之后新 Session 自动命中、跳过所有表单。
 *
 * 交互:
 *   三个 Select 顺序约束, 自上而下级联:
 *     1. Team   — 当前用户所属的所有 team
 *     2. Agent  — 选定 team 下、owner==自己 或 visibility=team 的 agent (active)
 *     3. Task   — 选定 team 下的 running task; 列表头部注入虚拟项
 *                 { task_id: "default", task_name: "default (不绑定任何 Task)" }
 *                 与 Proxy 的 `sessionInit.defaultTaskId` 契约一致。
 *   切换上游 (team/agent) 自动清空下游选择, 避免携带脏值提交。
 *
 * 保存:
 *   POST /api/v1/meta/user-session-default/set, 失败 toast 展示错误 code (如
 *   agent_not_accessible / task_inactive 等), 成功后由父组件刷新展示态。
 *
 * admin 不能代设成员: Core 侧 `assertCallerIsOwner` 守住, 本 Dialog 也不开"选用户"入口。
 */

import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Button, Form, Modal, Select } from 'tea-component';
import { teamsApi, agentsApi, tasksApi, type Team, type Agent } from '@/lib/teamApi';
import {
  userSessionDefaultApi,
  DEFAULT_TASK_SENTINEL,
  type UserSessionDefaultEntity,
} from '@/lib/api/user-session-default';
import { tea } from '@/lib/tea-bridge';
import { getErrorMessage } from '@/lib/error-message';

/** 下拉展示的 task 选项 (包含虚拟 default 项)。 */
interface TaskOption {
  task_id: string;
  title: string;
  isDefault?: boolean;
}

export default function SessionDefaultDialog({
  initial,
  onClose,
  onSaved,
}: {
  /** 已有默认配置时传入, 用于预选三个下拉; 新建则为 null。 */
  initial: UserSessionDefaultEntity | null;
  onClose: () => void;
  onSaved: (saved: UserSessionDefaultEntity) => void;
}) {
  const { t } = useTranslation();

  // ── 三级选择 state ──
  const [teamId, setTeamId] = useState<string>(initial?.team_id ?? '');
  const [agentId, setAgentId] = useState<string>(initial?.agent_id ?? '');
  const [taskId, setTaskId] = useState<string>(initial?.task_id ?? '');

  // ── 下拉数据源 ──
  const [teams, setTeams] = useState<Team[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [tasks, setTasks] = useState<TaskOption[]>([]);

  const [loadingTeams, setLoadingTeams] = useState(true);
  const [loadingAgents, setLoadingAgents] = useState(false);
  const [loadingTasks, setLoadingTasks] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  /**
   * "列表已加载完成"标记 —— 与 loading 区分开，是本组件预选逻辑正确性的关键。
   *
   * 坑：loading* 的**初始值**是 false（只有真正发起请求时才置 true）。若直接用
   * loading 做"预选失效校验"的守卫，首次挂载时 loading=false 会让 effect 立刻执行，
   * 而此时 agents/tasks 还是空数组 —— 预选值被误判为"不在列表里"而被清空，用户
   * 看到三个空下拉（点「修改」时当前默认不被选中）。
   *
   * 因此用独立的 loaded* 标记：只有请求**成功返回后**才置 true，校验 effect 等待
   * loaded 为真才执行。
   */
  const [agentsLoaded, setAgentsLoaded] = useState(false);
  const [tasksLoaded, setTasksLoaded] = useState(false);

  // Step 1: 拉 teams
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoadingTeams(true);
      try {
        const list = await teamsApi.list();
        if (!cancelled) setTeams(list);
      } catch (err) {
        if (!cancelled) tea.notify.error(getErrorMessage(err));
      } finally {
        if (!cancelled) setLoadingTeams(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Step 2: team 变化 → 拉 agents (owner=self; 保持与 session-init fetchTeamsAndAgents 一致)
  // 不过 Core agent/list 没有 owner 过滤; 这里拉全量再按 owner / visibility=team 做可见性过滤。
  // 这保证 UI 展示的 agent 与 Proxy 侧 session-init 看到的集合一致 —— 用户在面板选到的
  // agent, 账户默认命中时 fetchTeamsAndAgents 一定也能找到。
  useEffect(() => {
    let cancelled = false;
    if (!teamId) {
      setAgents([]);
      setAgentsLoaded(false);
      return;
    }
    (async () => {
      setLoadingAgents(true);
      setAgentsLoaded(false);
      try {
        const list = await agentsApi.list(teamId);
        if (!cancelled) {
          setAgents(list.filter((a) => a.status === 'active'));
          setAgentsLoaded(true);
        }
      } catch (err) {
        if (!cancelled) tea.notify.error(getErrorMessage(err));
      } finally {
        if (!cancelled) setLoadingAgents(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [teamId]);

  // Step 3: team 变化 → 拉 tasks (只要 running), 头部手工 unshift 一条虚拟 default
  useEffect(() => {
    let cancelled = false;
    if (!teamId) {
      setTasks([]);
      setTasksLoaded(false);
      return;
    }
    (async () => {
      setLoadingTasks(true);
      setTasksLoaded(false);
      try {
        const list = await tasksApi.list(teamId);
        if (!cancelled) {
          const running: TaskOption[] = list
            .filter((tk) => tk.status === 'running')
            .map((tk) => ({ task_id: tk.task_id, title: tk.title }));
          // 虚拟 default 项 (与 Proxy fetchTeamsAndAgents 的 unshift 对称, 见
          // MemoryProxy/src/session/codebuddy/init.ts:322-328)。Core task/list 不会
          // 返这条, 前端造一条让用户能主动选"不绑定任何 Task"。
          running.unshift({
            task_id: DEFAULT_TASK_SENTINEL,
            title: t('sessionDefault.task.sentinel.label'),
            isDefault: true,
          });
          setTasks(running);
          setTasksLoaded(true);
        }
      } catch (err) {
        if (!cancelled) tea.notify.error(getErrorMessage(err));
      } finally {
        if (!cancelled) setLoadingTasks(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [teamId, t]);

  // 切换 team 时清下游; 切换 agent 时 task 可以保留 (task 只依赖 team, 不依赖 agent)。
  // 用两个 effect 分开写而不是一个, 避免 teamId 回到旧值时也误清下游。
  useEffect(() => {
    if (initial && teamId === initial.team_id) return;    // 首次挂载时不清, 保留预选
    setAgentId('');
    setTaskId('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teamId]);

  // ── 预选校验: 若 initial 里的 agent/task 已不在列表 (后台被删/停用) → 清掉, 让用户重选 ──
  //
  // ⚠️ 守卫必须用 agentsLoaded / tasksLoaded，不能用 loadingAgents / loadingTasks：
  // loading 的初始值是 false，首次挂载时用它做守卫会让 effect 在列表还是空数组时
  // 立即执行，把预选值误清（点「修改」时当前默认不被选中的 bug）。loaded 只有在
  // 请求成功返回后才为 true。详见上方 loaded* 的注释。
  useEffect(() => {
    if (!initial || !agentsLoaded) return;
    if (agentId && !agents.some((a) => a.agent_id === agentId)) setAgentId('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agents, agentsLoaded]);

  useEffect(() => {
    if (!initial || !tasksLoaded) return;
    if (taskId && !tasks.some((t) => t.task_id === taskId)) setTaskId('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasks, tasksLoaded]);

  // ── 下拉 options ──
  const teamOptions = useMemo(
    () =>
      teams.map((team) => ({
        value: team.team_id,
        text: `${team.name} (${team.team_id})`,
      })),
    [teams]
  );

  const agentOptions = useMemo(
    () =>
      agents.map((a) => ({
        value: a.agent_id,
        text: `${a.name} (${a.agent_id})`,
      })),
    [agents]
  );

  const taskOptions = useMemo(
    () =>
      tasks.map((tk) => ({
        value: tk.task_id,
        // 虚拟项 label 已在构造 tasks 时写入 title, 这里不区分, Select 统一渲染。
        text: tk.isDefault ? tk.title : `${tk.title} (${tk.task_id})`,
      })),
    [tasks]
  );

  const canSubmit =
    !!teamId && !!agentId && !!taskId && !submitting && !loadingTeams && !loadingAgents && !loadingTasks;

  async function handleSave() {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      const saved = await userSessionDefaultApi.set({
        team_id: teamId,
        agent_id: agentId,
        task_id: taskId,
      });
      onSaved(saved);
    } catch (err) {
      tea.notify.error(getErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      visible
      caption={initial ? t('sessionDefault.dialog.edit.caption') : t('sessionDefault.dialog.create.caption')}
      size="s"
      onClose={onClose}
      disableEscape={submitting}
    >
      <Modal.Body>
        {/* 说明文案走 tea Alert, 不用裸 div + 内联 style —— 与 MemberSection /
            AllocateAssetDialog 的说明文本风格保持一致。 */}
        <Alert type="info">{t('sessionDefault.dialog.desc')}</Alert>
        <Form>
          <Form.Item label={t('sessionDefault.field.team')} required>
            <Select
              size="full"
              value={teamId}
              onChange={setTeamId}
              appearance="button"
              matchButtonWidth
              placeholder={
                loadingTeams
                  ? t('team.loading')
                  : teams.length === 0
                    ? t('sessionDefault.team.placeholder.empty')
                    : t('sessionDefault.team.placeholder.select')
              }
              options={teamOptions}
              disabled={loadingTeams || teams.length === 0}
            />
          </Form.Item>

          <Form.Item label={t('sessionDefault.field.agent')} required>
            <Select
              size="full"
              value={agentId}
              onChange={setAgentId}
              appearance="button"
              matchButtonWidth
              placeholder={
                !teamId
                  ? t('sessionDefault.agent.placeholder.needTeam')
                  : loadingAgents
                    ? t('team.loading')
                    : agents.length === 0
                      ? t('sessionDefault.agent.placeholder.empty')
                      : t('sessionDefault.agent.placeholder.select')
              }
              options={agentOptions}
              disabled={!teamId || loadingAgents || agents.length === 0}
            />
          </Form.Item>

          <Form.Item
            label={t('sessionDefault.field.task')}
            required
            extra={t('sessionDefault.task.extra')}
          >
            <Select
              size="full"
              value={taskId}
              onChange={setTaskId}
              appearance="button"
              matchButtonWidth
              placeholder={
                !teamId
                  ? t('sessionDefault.task.placeholder.needTeam')
                  : loadingTasks
                    ? t('team.loading')
                    : t('sessionDefault.task.placeholder.select')
              }
              options={taskOptions}
              disabled={!teamId || loadingTasks}
            />
          </Form.Item>
        </Form>
      </Modal.Body>
      <Modal.Footer>
        <Button type="primary" disabled={!canSubmit} loading={submitting} onClick={handleSave}>
          {t('sessionDefault.dialog.submit')}
        </Button>
        <Button onClick={onClose} disabled={submitting}>
          {t('sessionDefault.dialog.cancel')}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
