/**
 * BoardView —— 工作台任务卡片网格 + 详情抽屉。
 */
import { useTranslation } from 'react-i18next';
import { Button, Drawer, Pagination, Tag, Text } from 'tea-component';
import { AddIcon, ChevronRightIcon, UsergroupIcon } from 'tea-icons-react';
import { canDeleteTask, type Task, type Team } from '@/services';
import { useDisplayNameResolver } from '@/services/user-profile-store';
import TaskDetail from './TaskDetail';
import { participationOf, useStatusLabels, type AgentOption, type TaskParticipationView } from '../utils/workbench-utils';

export default function BoardView({
  tasks,
  tasksLoading,
  tasksTotal,
  currentPage,
  setCurrentPage,
  pageSize,
  selected,
  onSelect,
  onCreate,
  onDelete,
  onUpdateStatus,
  onUpdateTask,
  agents,
  teams,
  currentUser,
  participationByTask,
}: {
  tasks: Task[];
  tasksLoading: boolean;
  tasksTotal: number;
  currentPage: number;
  setCurrentPage: (page: number) => void;
  pageSize: number;
  selected: Task | null;
  onSelect: (id: string | null) => void;
  onCreate: () => void;
  onDelete: (task: Task) => void;
  onUpdateStatus: (task: Task, status: Task['status']) => void;
  onUpdateTask: (task: Task, patch: Partial<Pick<Task, 'title' | 'description' | 'source_type' | 'source_url' | 'linked_agents'>>) => void;
  agents: AgentOption[];
  teams: Team[];
  currentUser: string;
  participationByTask: Map<string, TaskParticipationView>;
}) {
  const { t } = useTranslation();
  const statusLabels = useStatusLabels();
  // 参与者 tooltip 展示 display_name 而非 user_id（与抽屉详情 UserChip 同一缓存）
  const resolveUserName = useDisplayNameResolver();
  const selectedTeam = selected ? teams.find((x) => x.team_id === selected.team_id) ?? null : null;

  // 后端分页：useTasks 已只返回当前页数据，不需要前端切片
  const totalPages = Math.max(1, Math.ceil(tasksTotal / pageSize));
  const safePage = Math.min(currentPage, totalPages);
  const pagedTasks = tasks;
  return (
    <div className="_memory-panel-card">
      {/* 头部：复用 members / agents 的 Section 通用头部（标题 + 计数 Tag + 副标题 + 右侧操作） */}
      <div className="_memory-section-header">
        <div className="_memory-section-header-info">
          <div className="_memory-section-header-title-row">
            <div className="_memory-section-title">{t('task.list.title')}</div>
            <Tag size="sm">{t('task.list.count', { count: tasksTotal })}</Tag>
          </div>
          <div className="_memory-section-subtitle">{t('task.list.subtitle')}</div>
        </div>
        <Button type="primary" onClick={onCreate}>
          <AddIcon size={14} />
          {t('task.create')}
        </Button>
      </div>

      {tasksLoading && tasks.length === 0 ? (
        // 首屏加载骨架屏：6 个占位卡片 + shimmer 动画
        <div className="_memory-workbench-skeleton-grid" aria-label="loading">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="_memory-workbench-skeleton-card">
              <div className="_memory-workbench-skeleton-line _memory-workbench-skeleton-line--title" />
              <div className="_memory-workbench-skeleton-line _memory-workbench-skeleton-line--desc" />
              <div className="_memory-workbench-skeleton-line _memory-workbench-skeleton-line--meta" />
            </div>
          ))}
        </div>
      ) : tasks.length === 0 ? (
        <div className="_memory-workbench-list-empty">
          <Text theme="weak">{t('task.empty')}</Text>
        </div>
      ) : (
        <div className="_memory-workbench-task-grid">
          {pagedTasks.map((task) => {
            const view = participationOf(participationByTask, task.task_id);
            const imParticipant = view.users.includes(currentUser);
            const agentNameById = new Map(agents.map((a) => [a.id, a.name]));
            const agentLabels = view.agentIds.map((id) => agentNameById.get(id) ?? id);
            return (
              <button
                type="button"
                key={task.task_id}
                className="_memory-workbench-task-card"
                onClick={() => onSelect(task.task_id)}
              >
                {/* 标题行：状态 pill + 标题 + 箭头 */}
                <div className="_memory-workbench-task-card-head">
                  <span className={`_memory-workbench-status-pill _memory-workbench-status-pill--${task.status}`}>
                    {statusLabels[task.status]}
                  </span>
                  <span className="_memory-workbench-task-card-title" title={task.title}>{task.title}</span>
                  <ChevronRightIcon size={14} className="_memory-workbench-task-card-chevron" />
                </div>

                {/* 描述 */}
                {task.description && (
                  <p className="_memory-workbench-task-card-desc">{task.description}</p>
                )}

                {/* 元信息行：参与者 · Agent · 时间 */}
                <div className="_memory-workbench-task-card-meta">
                  <span
                    className="_memory-workbench-meta-item"
                    title={view.users.length === 0 ? t('task.participants.empty') : t('task.participants.tooltip', { users: view.users.map((u) => resolveUserName(u)).join('\n') })}
                  >
                    <UsergroupIcon size={12} />
                    {t('task.peopleCount', { count: view.users.length })}
                    {imParticipant && <span className="_memory-workbench-meta-you">{t('common.you2')}</span>}
                  </span>
                  <span
                    className="_memory-workbench-meta-item"
                    title={agentLabels.length === 0 ? t('task.agents.empty') : t('task.agents.tooltip', { agents: agentLabels.join('\n') })}
                  >
                    {t('task.agentCount', { count: agentLabels.length })}
                  </span>
                  <span className="_memory-workbench-task-card-time">
                    {new Date(task.updated_at_ms).toLocaleString()}
                  </span>
                </div>
              </button>
            );
          })}
        </div>
      )}

      {/* 分页：超过 1 页才展示 */}
      {totalPages > 1 && (
        <div className="_memory-workbench-pagination">
          <Pagination
            pageIndex={safePage}
            pageSize={pageSize}
            recordCount={tasksTotal}
            pageSizeVisible={false}
            onPagingChange={(query) => {
              if (query.pageIndex) setCurrentPage(query.pageIndex);
            }}
          />
        </div>
      )}

      {/* 详情抽屉：设置（状态 / 编辑 / 删除）都在抽屉内完成 */}
      <Drawer
        visible={!!selected}
        size="l"
        onClose={() => onSelect(null)}
        title={selected?.title}
        subtitle={selected && (
          <span className="_memory-workbench-drawer-subtitle">
            <span className="_memory-mono">{selected.task_id}</span>
            {selectedTeam && (
              <>
                <span className="_memory-workbench-meta-sep">·</span>
                {selectedTeam.name}
              </>
            )}
          </span>
        )}
        destroyOnClose
      >
        {selected && (
          <TaskDetail
            task={selected}
            onUpdateStatus={(s) => onUpdateStatus(selected, s)}
            onUpdateTask={(patch) => onUpdateTask(selected, patch)}
            onDelete={() => onDelete(selected)}
            canDelete={canDeleteTask(selected, selectedTeam, currentUser)}
            agents={agents}
            team={selectedTeam}
            currentUser={currentUser}
            participation={participationOf(participationByTask, selected.task_id)}
          />
        )}
      </Drawer>
    </div>
  );
}
