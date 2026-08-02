/**
 * TaskWorkbench — 用户工作台。
 *
 * 与上一版「社区研发 Loop 工作台」不同，这一版按 PRD §7 / §17.4 把工作台
 * 收敛到两件事：
 *   1. 列出/创建/管理本团队下的 task；
 *   2. 通过 log tab 看 task 历史记录。
 *
 * 项目管理类的统计、配置中心、PR/issue 看板都已移除。
 *
 * 数据走后端链路 A（services/backendStore.ts，内部调用 @/lib/teamApi 的 meta 接口）。
 *
 * Tea 组件重构版：左右主从布局改用 Card + List，编辑区改用 Input / Segment /
 * Checkbox，状态提示统一走 tea-bridge，去除所有 emoji 与自定义 Tailwind 圆角卡片。
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Tag, Card, List, Text, Input } from 'tea-component';
import { AddIcon, DeleteIcon, EditIcon, UserIcon, UsergroupIcon } from 'tea-icons-react';
import {
  useTasks,
  useTeams,
  createTask,
  deleteTask,
  updateTask,
  updateTaskStatus,
  canEditTask,
  canDeleteTask,
  type Task,
  type Team
} from '@/services';
import { participationLogsApi } from '@/lib/teamApi';
import { tea } from '@/lib/tea-bridge';
import TaskCreateDialog, { type TaskDraft } from './TaskCreateDialog';
import './task-workbench.css';

export type WorkbenchTab = 'board' | 'logs';

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// Task 状态在演示阶段简化为二态：进行中 / 已完成。
// 历史的 待处理 / 阻塞 / 已归档 已下线（参见 backendStore.ts 里的 normalizeTaskStatus）。

const STATUS_LABEL: Record<Task['status'], string> = {
  running: '进行中',
  completed: '已完成'
};

// Tag 组件合法 theme: default/primary/success/warning/error
const STATUS_THEME: Record<Task['status'], 'primary' | 'success'> = {
  running: 'primary',
  completed: 'success'
};

interface AgentOption {
  id: string;
  name: string;
}

/**
 * task 层聚合视图：按 task_id 分桶后再各自 dedupe。
 *
 * 内核 append-only 语义：同一 (user, agent, task) 每次 session init 都追加一条，
 * 数据库表里会累积冗余；前端按 Set 做客户端 dedupe，"跑 10 次 session"和
 * "跑 1 次"展示一致。
 */
export interface TaskParticipationView {
  /** dedupe 后的 user_id 列表 */
  users: string[];
  /** dedupe 后的 agent_id 列表 */
  agentIds: string[];
}

const EMPTY_VIEW: TaskParticipationView = { users: [], agentIds: [] };

/**
 * 拉取整个 team 的参与日志，按 task_id 分桶。一次请求覆盖列表页 N 个 task 的
 * 统计数字（避免 fanout N 次），详情页也复用同一份数据从 Map 里取。
 *
 * - 数据源：proxy 侧 session init 完成时 append 到内核 `/v3/meta/participation-log/*`
 * - 请求失败降级为空 Map，各处显示 0 / '—'，不阻断其它区域
 * - 追随 BACKEND_REFRESH_EVENT 自动重新拉取
 */
function useTeamParticipation(teamId: string | null): Map<string, TaskParticipationView> {
  const [byTask, setByTask] = useState<Map<string, TaskParticipationView>>(() => new Map());

  const fetchLogs = useCallback(async () => {
    if (!teamId) {
      setByTask(new Map());
      return;
    }
    try {
      const logs = await participationLogsApi.listByTeam(teamId);
      const buckets = new Map<string, { users: Set<string>; agentIds: Set<string> }>();
      for (const log of logs) {
        if (!log.task_id) continue;
        let bucket = buckets.get(log.task_id);
        if (!bucket) {
          bucket = { users: new Set(), agentIds: new Set() };
          buckets.set(log.task_id, bucket);
        }
        if (log.user_id) bucket.users.add(log.user_id);
        if (log.agent_id) bucket.agentIds.add(log.agent_id);
      }
      const next = new Map<string, TaskParticipationView>();
      for (const [taskId, { users, agentIds }] of buckets) {
        next.set(taskId, { users: [...users], agentIds: [...agentIds] });
      }
      setByTask(next);
    } catch (err) {
      console.warn('[TaskWorkbench] load participation logs failed:', err);
      setByTask(new Map());
    }
  }, [teamId]);

  useEffect(() => {
    let cancelled = false;
    fetchLogs().catch(() => { /* handled inside */ });
    const handler = () => { if (!cancelled) fetchLogs(); };
    window.addEventListener('tdai-memory.backend-refresh', handler);
    return () => {
      cancelled = true;
      window.removeEventListener('tdai-memory.backend-refresh', handler);
    };
  }, [fetchLogs]);

  return byTask;
}

function participationOf(
  byTask: Map<string, TaskParticipationView>,
  taskId: string,
): TaskParticipationView {
  return byTask.get(taskId) ?? EMPTY_VIEW;
}

export default function TaskWorkbench(props: {
  tab?: WorkbenchTab;
  onTabChange?: (tab: WorkbenchTab) => void;
  /** 当前激活的 team id（可空：未选时只显示 empty state） */
  activeTeamId: string | null;
  /** 当前用户名（task 的 creator_user_id） */
  currentUser: string;
  /** 当前 team 下可关联的 Agent 列表（来自 TeamManagementPanel 的同源数据） */
  agents: AgentOption[];
  /** 是否为全局 admin */
  isAdmin?: boolean;
}) {
  const { activeTeamId, currentUser, agents, isAdmin } = props;
  const tasks = useTasks(activeTeamId);
  const { teams, activeTeam } = useTeams();
  const participationByTask = useTeamParticipation(activeTeamId);
  const [showCreate, setShowCreate] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const sortedTasks = useMemo(() => {
    return [...tasks].sort((a, b) => b.updated_at_ms - a.updated_at_ms);
  }, [tasks]);

  const selected = useMemo(
    () => (selectedId ? tasks.find((t) => t.task_id === selectedId) ?? null : null),
    [selectedId, tasks]
  );

  /**
   * 创建 task：team_id 完全由当前激活 team 决定，不再让 dialog 选 team
   * （切 team 的唯一入口在右上角全局 TeamSwitcher）。
   */
  async function handleCreate(draft: TaskDraft) {
    // 谁点击「创建 Task」，谁就是 creator_user_id。
    const team = teams.find((t) => t.team_id === draft.team_id);
    if (!team) {
      tea.notify.error(`team「${draft.team_id}」不存在，无法创建 task。`);
      return;
    }
    try {
      const t = await createTask({
        team_id: draft.team_id,
        creator_user_id: currentUser,
        title: draft.title,
        description: draft.description,
        source_type: draft.source_type,
        source_url: draft.source_url,
        linked_agents: draft.linked_agents
      });
      setSelectedId(t.task_id);
      setShowCreate(false);
    } catch (err) {
      tea.notify.error(errMsg(err));
    }
  }

  return (
    <div className="_memory-workbench-body">
      {!activeTeamId ? (
        <EmptyTeam />
      ) : (
        <BoardView
          tasks={sortedTasks}
          selected={selected}
          onSelect={(id) => setSelectedId(id)}
          onCreate={() => setShowCreate(true)}
          onDelete={async (task) => {
            // 权限：删除 task 仅创建者 / team admin / 全局 admin
            const team = teams.find((t) => t.team_id === task.team_id) ?? null;
            if (!canDeleteTask(task, team, currentUser) && !isAdmin) {
              tea.notify.warning(
                `你不是 task「${task.title}」的创建者，也不是 team 管理员，无法删除。创建者: ${task.creator_user_id}`
              );
              return;
            }
            const ok = await tea.confirm({
              message: `确认删除 task「${task.title}」？`,
              description: `Task ID: ${task.task_id}`,
              okText: '删除',
              cancelText: '取消',
            });
            if (ok) {
              try {
                await deleteTask(task.task_id);
                if (selectedId === task.task_id) setSelectedId(null);
              } catch (err) {
                tea.notify.error(errMsg(err));
              }
            }
          }}
          onUpdateStatus={async (task, status) => {
            // 权限：编辑 task（含切换 status）允许 team 内任意 member / admin
            const team = teams.find((t) => t.team_id === task.team_id) ?? null;
            if (!canEditTask(task, team, currentUser) && !isAdmin) {
              tea.notify.warning('你不是该 team 的成员，无权修改此 task。');
              return;
            }
            try {
              await updateTaskStatus(task.task_id, status, currentUser);
            } catch (err) {
              tea.notify.error(errMsg(err));
            }
          }}
          onUpdateTask={async (task, patch) => {
            const team = teams.find((t) => t.team_id === task.team_id) ?? null;
            if (!canEditTask(task, team, currentUser) && !isAdmin) {
              tea.notify.warning('你不是该 team 的成员，无权修改此 task。');
              return;
            }
            try {
              await updateTask(task.task_id, patch, currentUser);
            } catch (err) {
              tea.notify.error(errMsg(err));
            }
          }}
          agents={agents}
          teams={teams}
          currentUser={currentUser}
          isAdmin={isAdmin}
          participationByTask={participationByTask}
        />
      )}

      {showCreate && activeTeam && (
        // team 由右上角全局 TeamSwitcher 决定，dialog 里不再让用户选；
        // 这里 activeTeam 必为非空，因为上面 !activeTeamId 分支已经走 EmptyTeam 了
        <TaskCreateDialog
          team={{ team_id: activeTeam.team_id, name: activeTeam.name }}
          onClose={() => setShowCreate(false)}
          onCreate={handleCreate}
        />
      )}
    </div>
  );
}

// ============= Sub views =============

function EmptyTeam() {
  const { t } = useTranslation();
  return (
    <Card>
      <Card.Body className="_memory-workbench-empty-card">
        <Text theme="strong" className="_memory-workbench-empty-title">{t('workbench.noTeamTitle', { defaultValue: '还没有可用的 Team' })}</Text>
        <Text theme="weak" className="_memory-workbench-empty-desc">
          {t('workbench.noTeamDesc', { defaultValue: '请先在「团队管理」里创建一个 team，再回到工作台创建 task。' })}
        </Text>
      </Card.Body>
    </Card>
  );
}

function BoardView({
  tasks,
  selected,
  onSelect,
  onCreate,
  onDelete,
  onUpdateStatus,
  onUpdateTask,
  agents,
  teams,
  currentUser,
  isAdmin,
  participationByTask,
}: {
  tasks: Task[];
  selected: Task | null;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onDelete: (task: Task) => void;
  onUpdateStatus: (task: Task, status: Task['status']) => void;
  onUpdateTask: (task: Task, patch: Partial<Pick<Task, 'title' | 'description' | 'source_type' | 'source_url' | 'linked_agents'>>) => void;
  agents: AgentOption[];
  teams: Team[];
  currentUser: string;
  isAdmin?: boolean;
  participationByTask: Map<string, TaskParticipationView>;
}) {
  const { t } = useTranslation();
  return (
    <div className="_memory-workbench-split">
      {/* Left: task list */}
      <div className="_memory-workbench-list">
        <Card className="_memory-workbench-card">
          <Card.Body className="_memory-workbench-list-body">
            <div className="_memory-workbench-list-header">
              <Text theme="strong">{t('workbench.taskListTitle', { defaultValue: 'Task 列表' })}</Text>
              <Button type="primary" onClick={onCreate}>
                <AddIcon size={14} />
                {t('workbench.createTask', { defaultValue: '新建 Task' })}
              </Button>
            </div>
            {tasks.length === 0 ? (
              <div className="_memory-workbench-list-empty">
                <Text theme="weak">{t('workbench.emptyState', { defaultValue: '暂无 task。点击右上角「新建 Task」创建第一个。' })}</Text>
              </div>
            ) : (
              <List split="divide" className="_memory-workbench-list-items">
                {tasks.map((tItem) => {
                  const active = selected?.task_id === tItem.task_id;
                  const team = teams.find((x) => x.team_id === tItem.team_id) ?? null;
                  const canDelete = canDeleteTask(tItem, team, currentUser) || isAdmin;
                  const view = participationOf(participationByTask, tItem.task_id);
                  const imParticipant = view.users.includes(currentUser);
                  const agentNameById = new Map(agents.map((a) => [a.id, a.name]));
                  const agentLabels = view.agentIds.map((id) => agentNameById.get(id) ?? id);
                  const statusText = tItem.status === 'running'
                    ? t('workbench.statusFilter.running', { defaultValue: '进行中' })
                    : t('workbench.statusFilter.completed', { defaultValue: '已完成' });
                  return (
                    <List.Item
                      key={tItem.task_id}
                      selected={active}
                      onClick={() => onSelect(tItem.task_id)}
                      className="_memory-workbench-item"
                    >
                      <div className="_memory-workbench-item-top">
                        <Tag theme={STATUS_THEME[tItem.status]} variant="soft">
                          {statusText}
                        </Tag>
                        <Text theme="weak" className="_memory-mono _memory-workbench-item-id" tooltip={tItem.task_id}>
                          {tItem.task_id}
                        </Text>
                        {canDelete && (
                          <Button type="text"
                            tooltip="删除该 Task"
                            className="_memory-workbench-item-delete"
                            onClick={(e) => {
                              e?.stopPropagation();
                              onDelete(tItem);
                            }}
                          >
                            <DeleteIcon size={14} />
                          </Button>
                        )}
                      </div>
                      <div className="_memory-workbench-item-title">{tItem.title}</div>
                      <p className="_memory-workbench-item-desc">{tItem.description}</p>
                      <div className="_memory-workbench-item-meta">
                        <span
                          className="_memory-workbench-badge"
                          title={view.users.length === 0 ? '暂无实际参与的 user' : `实际参与 User：\n${view.users.join('\n')}`}
                        >
                          <UsergroupIcon size={12} />
                          {view.users.length} 人
                          {imParticipant && <Tag theme="warning" variant="soft" size="sm">含你</Tag>}
                        </span>
                        <span title={agentLabels.length === 0 ? '暂无实际参与的 Agent' : `实际参与 Agent：\n${agentLabels.join('\n')}`}>
                          {agentLabels.length} 个 Agent
                        </span>
                        <span className="_memory-workbench-item-time">
                          {new Date(tItem.updated_at_ms).toLocaleString()}
                        </span>
                      </div>
                    </List.Item>
                  );
                })}
              </List>
            )}
          </Card.Body>
        </Card>
      </div>

      {/* Right: detail */}
      <div className="_memory-workbench-detail">
        <Card className="_memory-workbench-card">
          <Card.Body className="_memory-workbench-detail-body">
            {!selected ? (
              <div className="_memory-workbench-detail-empty">
                <Text theme="weak">{t('workbench.searchPlaceholder', { defaultValue: '在左侧选中一条 task，或点击「新建 Task」开始一个新任务。' })}</Text>
              </div>
            ) : (
              <TaskDetail
                task={selected}
                onUpdateStatus={(s) => onUpdateStatus(selected, s)}
                onUpdateTask={(patch) => onUpdateTask(selected, patch)}
                agents={agents}
                team={teams.find((t) => t.team_id === selected.team_id) ?? null}
                currentUser={currentUser}
                isAdmin={isAdmin}
                participation={participationOf(participationByTask, selected.task_id)}
              />
            )}
          </Card.Body>
        </Card>
      </div>
    </div>
  );
}

function TaskDetail({
  task,
  onUpdateStatus,
  onUpdateTask,
  agents,
  team,
  currentUser,
  isAdmin,
  participation,
}: {
  task: Task;
  onUpdateStatus: (s: Task['status']) => void;
  onUpdateTask: (patch: Partial<Pick<Task, 'title' | 'description' | 'source_type' | 'source_url' | 'linked_agents'>>) => void;
  agents: AgentOption[];
  /** 当前 task 所属 team — 可能为 null（理论上不会，但 team 被删除场景需兜底） */
  team: Team | null;
  currentUser: string;
  isAdmin?: boolean;
  /** 从 useTeamParticipation 分桶后传下来的当前 task 观测数据 */
  participation: TaskParticipationView;
}) {
  // PRD §10：编辑权限。team 内任意 member 可改 task（含切换 status）；admin 全权限。
  const canEdit = canEditTask(task, team, currentUser) || isAdmin;

  // —— 编辑态：只在用户点「编辑」后才进入；草稿独立维护，取消即丢弃 —— //
  const [editing, setEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState(task.title);
  const [draftDesc, setDraftDesc] = useState(task.description);

  // 切换 task / 退出编辑时同步草稿（避免编辑 A 后切换到 B 草稿还停在 A）
  useEffect(() => {
    setEditing(false);
    setDraftTitle(task.title);
    setDraftDesc(task.description);
  }, [task.task_id]);

  function startEdit() {
    setDraftTitle(task.title);
    setDraftDesc(task.description);
    setEditing(true);
  }
  function cancelEdit() {
    setEditing(false);
  }
  function saveEdit() {
    const patch: Partial<Pick<Task, 'title' | 'description' | 'source_type' | 'source_url' | 'linked_agents'>> = {};
    const title = draftTitle.trim();
    if (title.length === 0) {
      tea.notify.warning('任务标题不能为空。');
      return;
    }
    if (title !== task.title) patch.title = title;
    if (draftDesc !== task.description) patch.description = draftDesc;

    if (Object.keys(patch).length === 0) {
      setEditing(false);
      return;
    }
    onUpdateTask(patch);
    setEditing(false);
  }

  // 参与者展示：creator 单列独立；其余进 "参与的 User"。
  // 数据源统一走 participation-log 观测 —— proxy session init 完成时 append 的
  // "实际起过 session 的 user"。creator 用自己的 agent 开工也算一次真实参与，
  // 所以不再过滤 creator（会同时出现在"创建者"和"参与的 User"两处，语义不同）。
  const participantUsers = participation.users;

  // 「实际参与 Agent」：session 观测到的 agent，映射到 team 的 agent name；
  // 未在 team agents 列表里的（比如已被删除）保留 agent_id 兜底展示。
  const sessionAgents = useMemo(() => {
    const nameById = new Map(agents.map((a) => [a.id, a.name]));
    return participation.agentIds.map((id) => ({ id, name: nameById.get(id) ?? id }));
  }, [participation.agentIds, agents]);

  return (
    <div className="_memory-workbench-detail-content">
      {/* === Header === */}
      <div className="_memory-workbench-detail-header">
        <div className="_memory-workbench-detail-title-col">
          {editing ? (
            <Input
              value={draftTitle}
              onChange={setDraftTitle}
              placeholder="任务标题"
              size="full"
              className="_memory-workbench-title-input"
            />
          ) : (
            <Text theme="strong" className="_memory-workbench-detail-title">{task.title}</Text>
          )}
          <div className="_memory-workbench-detail-meta">
            <Text theme="weak">task_id：</Text>
            <Text theme="text" className="_memory-mono">{task.task_id}</Text>
            <span className="_memory-workbench-meta-sep">·</span>
            <Text theme="weak">team：</Text>
            {team ? (
              <>
                <Text theme="text">{team.name}</Text>
                <Text theme="weak" className="_memory-mono">（{team.team_id}）</Text>
              </>
            ) : (
              <Text theme="weak" className="_memory-mono">{task.team_id} · 已删除</Text>
            )}
          </div>
        </div>
        <div className="_memory-workbench-detail-actions">
          {/* 编辑按钮：仅 team 成员可见可点；编辑态下隐藏，由保存/取消替代 */}
          {!editing && canEdit && (
            <Button onClick={startEdit} tooltip="编辑任务详情（标题、描述）">
              <EditIcon size={14} />
              编辑
            </Button>
          )}
          {editing && (
            <>
              <Button onClick={cancelEdit}>取消</Button>
              <Button type="primary" onClick={saveEdit}>保存</Button>
            </>
          )}
          <div className="_memory-workbench-status-switch" title={canEdit ? '切换任务状态（你会被加入参与者）' : '仅 team 成员可切换 task 状态'}>
            {(Object.keys(STATUS_LABEL) as Task['status'][]).map((s) => {
              const active = task.status === s;
              return (
                <Button
                  key={s}
                  disabled={!canEdit || editing}
                  type={active ? 'primary' : 'weak'}
                  onClick={() => onUpdateStatus(s)}
                >
                  {STATUS_LABEL[s]}
                </Button>
              );
            })}
          </div>
        </div>
      </div>

      {/* === 创建者 + 参与的 User + 实际参与 Agent ===
          创建者：演示阶段 = team admin（创建 task 时自动取 team.owner_user_id）。
          参与的 User / Agent：来源 participation-log 观测，proxy session init
          完成时 fire-and-forget append 到内核；append-only 语义，前端按 Set 去重。 */}
      <div className="_memory-workbench-people">
        <div className="_memory-workbench-people-row">
          <Text theme="weak" className="_memory-workbench-people-label">创建者</Text>
          <span
            className="_memory-workbench-chip"
            title="创建者（默认 = team admin）；仅创建者或 team 管理员可删除本 task"
          >
            <UserIcon size={12} />
            <Text theme="text">{task.creator_user_id}</Text>
            {task.creator_user_id === currentUser && <Tag theme="warning" variant="soft" size="sm">你</Tag>}
          </span>
        </div>
        <div className="_memory-workbench-people-row">
          <Text theme="weak" className="_memory-workbench-people-label">参与的 User</Text>
          {participantUsers.length === 0 ? (
            <Text theme="weak">—</Text>
          ) : (
            participantUsers.map((u) => (
              <span
                key={u}
                className="_memory-workbench-chip"
                title="参与者：通过 proxy 起过 session 的 user（含 creator 自己开工）"
              >
                <UserIcon size={12} />
                <Text theme="text">{u}</Text>
                {u === currentUser && <Tag theme="warning" variant="soft" size="sm">你</Tag>}
              </span>
            ))
          )}
        </div>
        <div className="_memory-workbench-people-row">
          <Text theme="weak" className="_memory-workbench-people-label">实际参与 Agent</Text>
          {sessionAgents.length === 0 ? (
            <Text theme="weak">—</Text>
          ) : (
            sessionAgents.map((a) => (
              <span
                key={a.id}
                className="_memory-workbench-chip"
                title={`proxy 侧观测到起过 session 的 agent · agent_id=${a.id}`}
              >
                <UsergroupIcon size={12} />
                <Text theme="text">{a.name}</Text>
              </span>
            ))
          )}
        </div>
      </div>

      {/* === 描述 === */}
      <div className="_memory-workbench-block">
        <Text theme="label" className="_memory-workbench-block-label">任务描述</Text>
        {editing ? (
          <Input.TextArea
            value={draftDesc}
            onChange={setDraftDesc}
            rows={6}
            size="full"
            placeholder="包含背景、目标、验收标准…"
          />
        ) : (
          <pre className="_memory-workbench-desc-view">{task.description}</pre>
        )}
      </div>

      {/* 关联 Agent 分区已下线：改为顶部 "实际参与 Agent" 展示 session 观测；
          task-agent/link 的人工声明关系不再在此页面展示。 */}

      <Text theme="weak" className="_memory-workbench-footer">
        创建：{new Date(task.created_at_ms).toLocaleString()} · 更新：{new Date(task.updated_at_ms).toLocaleString()}
      </Text>
    </div>
  );
}
