/**
 * TaskWorkbench — 用户工作台。
 *
 * 收敛到两件事：
 *   1. 列出/创建/管理本团队下的 task；
 *   2. 通过 log tab 看 task 历史记录。
 *
 * 布局：进入页面为全宽卡片网格；点击卡片拉出 Drawer，在抽屉内查看详情与设置
 * （改状态、编辑标题/描述、删除）。
 *
 * 数据走后端链路 A（services/backendStore.ts，内部调用 @/lib/teamApi 的 meta 接口）。
 */
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Card, Text } from 'tea-component';
import {
  useTasks,
  useTeams,
  createTask,
  deleteTask,
  updateTask,
  updateTaskStatus,
  canDeleteTask,
  canEditTask,
} from '@/services';
import { tea } from '@/lib/tea-bridge';
import { TeamHeaderCard } from '@/components/team/TeamHeaderCard';
import TaskCreateDialog, { type TaskDraft } from './TaskCreateDialog';
import TaskImportDialog from './TaskImportDialog';
import { taskSourceApi, type TaskSourceProvider } from '../../../lib/api/taskSource';
import { invalidateBackendCache } from '@/stores/backend';
import BoardView from './BoardView';
import { useTeamParticipation } from '../hooks/useTeamParticipation';
import { errMsg, type AgentOption, type WorkbenchTab } from '../utils/workbench-utils';
import '../styles/task-workbench.css';

function EmptyTeam() {
  const { t } = useTranslation();
  return (
    <Card>
      <Card.Body className="_memory-workbench-empty-card">
        <Text theme="strong" className="_memory-workbench-empty-title">{t('task.emptyTeam.title')}</Text>
        <Text theme="weak" className="_memory-workbench-empty-desc">
          {t('task.emptyTeam.desc')}
        </Text>
      </Card.Body>
    </Card>
  );
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
  /** 是否为全局 admin（保留接口兼容；admin 不再有 task 特权） */
  isAdmin?: boolean;
}) {
  const { t } = useTranslation();
  const { activeTeamId, currentUser, agents } = props;
  // 后端分页：useTasks 根据 page + pageSize 调 Panel 聚合接口，内核只返回当前页
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(12);
  const { tasks, total: tasksTotal, loading: tasksLoading } = useTasks(activeTeamId, currentPage, pageSize);
  const { teams, activeTeam } = useTeams();
  const participationByTask = useTeamParticipation(activeTeamId);
  const [showCreate, setShowCreate] = useState(false);
  /** 当前正在导入的来源 id（非空即弹窗打开）。由「导入 Task」下拉框选中项决定。 */
  const [importProviderId, setImportProviderId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  /** 已启用的外部来源。空数组 → BoardView 隐藏「导入 Task」入口。 */
  const [providers, setProviders] = useState<TaskSourceProvider[]>([]);

  // 切换 team 时重置到第 1 页
  useEffect(() => { setCurrentPage(1); }, [activeTeamId]);

  // 越界页码拉回：总数收缩（删掉末页最后几条 / 页长调大后页数变少）时，
  // 若 currentPage 仍停在失效页，fetch 会用越界 offset 拿到空数组，
  // 看板会错误地显示「暂无 task」空态 —— 这里把页码拉回有效末页。
  const totalPages = Math.max(1, Math.ceil(tasksTotal / pageSize));
  useEffect(() => {
    if (!tasksLoading && tasksTotal > 0 && currentPage > totalPages) {
      setCurrentPage(totalPages);
    }
  }, [tasksLoading, tasksTotal, currentPage, totalPages]);

  // 拉取已启用的外部来源。失败静默（未配置来源时本就不显示入口，不打扰用户）。
  useEffect(() => {
    if (!activeTeamId) return;
    let alive = true;
    taskSourceApi
      .providers(activeTeamId)
      .then((res) => { if (alive) setProviders(res.providers ?? []); })
      .catch(() => { if (alive) setProviders([]); });
    return () => { alive = false; };
  }, [activeTeamId]);

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
      tea.notify.error(`team "${draft.team_id}" ${t('task.emptyTeam.title')}`);
      return;
    }
    try {
      const task = await createTask({
        team_id: draft.team_id,
        creator_user_id: currentUser,
        title: draft.title,
        description: draft.description,
        source_type: draft.source_type,
        source_url: draft.source_url,
        linked_agents: draft.linked_agents
      });
      setSelectedId(task.task_id);
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
        <>
          {/* 当前 team 概览（与 team 管理页同一组件） */}
          {activeTeam && <TeamHeaderCard team={activeTeam} />}
          <BoardView
          tasks={sortedTasks}
          tasksLoading={tasksLoading}
          tasksTotal={tasksTotal}
          currentPage={currentPage}
          setCurrentPage={setCurrentPage}
          pageSize={pageSize}
          setPageSize={setPageSize}
          selected={selected}
          onSelect={(id) => setSelectedId(id)}
          onCreate={() => setShowCreate(true)}
          // 下拉选源：把选中的 provider_id 传上来，据此打开对应来源的导入弹窗。
          // 未启用外部来源时传 undefined → 入口隐藏。
          onImport={providers.length ? (providerId) => setImportProviderId(providerId) : undefined}
          importSources={providers.map((p) => ({ id: p.id }))}
          onDelete={async (task) => {
            // 权限：删除 task 仅创建者 / team admin / 全局 admin
            const team = teams.find((t) => t.team_id === task.team_id) ?? null;
            if (!canDeleteTask(task, team, currentUser)) {
              tea.notify.warning(
                t('task.delete.noPermission', { title: task.title, creator: task.creator_user_id })
              );
              return;
            }
            const ok = await tea.confirm({
              message: t('task.delete.confirm', { title: task.title }),
              description: t('task.delete.description', { id: task.task_id }),
              okText: t('task.delete.okText'),
              cancelText: t('task.delete.cancelText'),
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
            if (!canEditTask(task, team, currentUser)) {
              tea.notify.warning(t('task.noPermissionEdit'));
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
            if (!canEditTask(task, team, currentUser)) {
              tea.notify.warning(t('task.noPermissionEdit'));
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
          participationByTask={participationByTask}
          />
        </>
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
      {importProviderId && activeTeamId && (
        <TaskImportDialog
          teamId={activeTeamId}
          providers={providers}
          providerId={importProviderId}
          onClose={() => setImportProviderId(null)}
          // 导入后清缓存 + 广播，触发 useTasks 重新拉取（与其他写操作同一机制）
          onImported={() => invalidateBackendCache()}
        />
      )}
    </div>
  );
}
