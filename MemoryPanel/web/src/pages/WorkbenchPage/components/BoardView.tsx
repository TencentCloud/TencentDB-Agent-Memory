/**
 * BoardView —— 工作台任务卡片网格 + 详情抽屉。
 */
import { useTranslation } from 'react-i18next';
import { Button, Copy, Drawer, Dropdown, List, Pagination, Tag, Text } from 'tea-component';
import { AddIcon, ChevronDownIcon, ChevronRightIcon, UsergroupIcon } from 'tea-icons-react';
import { canDeleteTask, type Task, type Team } from '@/services';
import { useDisplayNameResolver } from '@/services/user-profile-store';
import TaskDetail from './TaskDetail';
import {
  participationOf,
  readExternalProvider,
  useSourceLabel,
  useStatusLabels,
  visibleAgentIds,
  type AgentOption,
  type TaskParticipationView,
} from '../utils/workbench-utils';

/**
 * 可选页长。默认 12 与 TaskWorkbench 的初始值一致；
 * 上限取 96 —— 内核 meta list 的 limit 最大 100，页长必须落在其内。
 */
const PAGE_SIZE_OPTIONS = [12, 24, 48, 96];

/**
 * 「导入 Task」下拉入口。
 *
 * 为什么不直接做成一个按钮：后续会接入多个导入源（当前只有 TAPD），
 * 用户需要先选「从哪个源导入」。列表由后端已启用的来源驱动 ——
 * 新增来源时后端 registry 加一个 provider，前端无需再改这里。
 *
 * 只有一个来源时仍保持下拉形态：多一个点击，但交互与多源时一致，
 * 避免「加第二个源时按钮行为突变」。
 */
function ImportTaskDropdown({
  sources,
  onPick,
}: {
  sources: Array<{ id: string }>;
  onPick: (providerId: string) => void;
}) {
  const { t } = useTranslation();
  const sourceLabel = useSourceLabel();
  return (
    <Dropdown
      appearance="pure"
      clickClose
      button={
        <Button type="weak">
          {t('task.import')}
          <ChevronDownIcon size={14} />
        </Button>
      }
    >
      {() => (
        <List type="option">
          {sources.map((s) => (
            <List.Item key={s.id} onClick={() => onPick(s.id)}>
              {t('task.importFrom', { source: sourceLabel(s.id) })}
            </List.Item>
          ))}
        </List>
      )}
    </Dropdown>
  );
}

export default function BoardView({
  tasks,
  tasksLoading,
  tasksTotal,
  currentPage,
  setCurrentPage,
  pageSize,
  setPageSize,
  selected,
  onSelect,
  onCreate,
  onDelete,
  onUpdateStatus,
  onUpdateTask,
  /**
   * 「导入 Task」入口（下拉选源）。
   *
   * 传 undefined 或空 sources → 入口隐藏：后端未启用任何外部来源时
   * 不应暴露一个点开必然失败的入口。
   */
  onImport,
  importSources,
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
  setPageSize: (size: number) => void;
  selected: Task | null;
  onSelect: (id: string | null) => void;
  onCreate: () => void;
  onDelete: (task: Task) => void;
  onUpdateStatus: (task: Task, status: Task['status']) => void;
  onUpdateTask: (
    task: Task,
    patch: Partial<
      Pick<Task, 'title' | 'description' | 'source_type' | 'source_url' | 'linked_agents'>
    >,
  ) => void;
  /** 选中某个来源后回调，参数是该来源 id（如 `tapd`）。 */
  onImport?: (providerId: string) => void;
  /** 可导入的来源列表（后端已启用的）。空 → 入口隐藏。 */
  importSources?: Array<{ id: string }>;
  agents: AgentOption[];
  teams: Team[];
  currentUser: string;
  participationByTask: Map<string, TaskParticipationView>;
}) {
  const { t } = useTranslation();
  const statusLabels = useStatusLabels();
  // 来源 chip：具体来源（tapd…）→ 展示名；手动任务显示「手动创建」
  const sourceLabel = useSourceLabel();
  // 参与者 tooltip 展示 display_name 而非 user_id（与抽屉详情 UserChip 同一缓存）
  const resolveUserName = useDisplayNameResolver();
  const selectedTeam = selected
    ? (teams.find((x) => x.team_id === selected.team_id) ?? null)
    : null;

  // 后端分页：useTasks 已只返回当前页数据，不需要前端切片
  const totalPages = Math.max(1, Math.ceil(tasksTotal / pageSize));
  // 越界保护：父组件已用 effect 把 currentPage 拉回有效范围，
  // 这里的 clamp 只是拉回生效前一帧的展示兜底，真正的修复在 TaskWorkbench。
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
        <div style={{ display: 'flex', gap: 8 }}>
          {/* 未启用任何外部来源时 importSources 为空 → 入口隐藏 */}
          {onImport && importSources && importSources.length > 0 && (
            <ImportTaskDropdown sources={importSources} onPick={onImport} />
          )}
          <Button type="primary" onClick={onCreate}>
            <AddIcon size={14} />
            {t('task.create')}
          </Button>
        </div>
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
            // 与抽屉页一致：滤掉导入哨兵（历史参与记录），不渲染「外部任务导入」标签。
            const agentLabels = visibleAgentIds(view.agentIds).map(
              (id) => agentNameById.get(id) ?? id,
            );
            return (
              <button
                type="button"
                key={task.task_id}
                className={`_memory-workbench-task-card _memory-workbench-task-card--${task.status}`}
                onClick={() => onSelect(task.task_id)}
              >
                {/* 头行：标题 + 右侧状态 pill + 箭头 */}
                <div className="_memory-workbench-task-card-head">
                  <span className="_memory-workbench-task-card-title" title={task.title}>
                    {task.title}
                  </span>
                  <span
                    className={`_memory-workbench-status-pill _memory-workbench-status-pill--${task.status}`}
                  >
                    {statusLabels[task.status]}
                  </span>
                  <ChevronRightIcon size={14} className="_memory-workbench-task-card-chevron" />
                </div>

                {/* id + 来源 chips：id 可点击复制（tea Copy 自带「复制成功」气泡） */}
                <div className="_memory-workbench-task-card-chips">
                  <Tag size="sm" variant="outlined" className="_memory-workbench-task-card-id">
                    {/* stopPropagation：复制点击不能冒泡成卡片选中（打开抽屉） */}
                    <span onClick={(e) => e.stopPropagation()}>
                      <Copy text={task.task_id}>
                        <span className="_memory-mono">{task.task_id}</span>
                      </Copy>
                    </span>
                  </Tag>
                  <Tag size="sm">{sourceLabel(readExternalProvider(task) ?? 'manual')}</Tag>
                </div>

                {/* 描述：无描述也给占位行，保持卡片等高节奏 */}
                <p
                  className={
                    task.description?.trim()
                      ? '_memory-workbench-task-card-desc'
                      : '_memory-workbench-task-card-desc _memory-workbench-task-card-desc--empty'
                  }
                >
                  {task.description?.trim() || t('task.noDesc')}
                </p>

                {/* 灰色面板：参与者 / Agent 规模（tooltip 列出明细名单） */}
                <div className="_memory-workbench-task-card-panel">
                  <span
                    className="_memory-workbench-meta-item"
                    title={
                      view.users.length === 0
                        ? t('task.participants.empty')
                        : t('task.participants.tooltip', {
                            users: view.users.map((u) => resolveUserName(u)).join('\n'),
                          })
                    }
                  >
                    <UsergroupIcon size={12} />
                    {t('task.peopleCount', { count: view.users.length })}
                    {imParticipant && (
                      <span className="_memory-workbench-meta-you">{t('common.you2')}</span>
                    )}
                  </span>
                  <span className="_memory-workbench-meta-sep">/</span>
                  <span
                    className="_memory-workbench-meta-item"
                    title={
                      agentLabels.length === 0
                        ? t('task.agents.empty')
                        : t('task.agents.tooltip', { agents: agentLabels.join('\n') })
                    }
                  >
                    {t('task.agentCount', { count: agentLabels.length })}
                  </span>
                </div>

                {/* 底部：创建时间 */}
                <div className="_memory-workbench-task-card-meta">
                  <span className="_memory-workbench-task-card-time">
                    {t('task.createdAt', {
                      time: new Date(task.created_at_ms).toLocaleString(),
                    })}
                  </span>
                </div>
              </button>
            );
          })}
        </div>
      )}

      {/*
        分页：有数据就展示（页长下拉常驻 —— 若只在多页时显示，
        总数 ≤ 一页时用户会失去调整页长的入口）。
        页长上限 96 < 内核 meta list 的 limit 最大值 100。
      */}
      {tasksTotal > 0 && (
        <div className="_memory-workbench-pagination">
          <Pagination
            pageIndex={safePage}
            pageSize={pageSize}
            pageSizeOptions={PAGE_SIZE_OPTIONS}
            recordCount={tasksTotal}
            onPagingChange={({ pageIndex, pageSize: nextSize }) => {
              // 改页长时组件已把页码重置为 1（isPagingReset 默认 true），两个值一起下发
              if (nextSize && nextSize !== pageSize) setPageSize(nextSize);
              if (pageIndex) setCurrentPage(pageIndex);
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
        // 标题右侧是弱化的元信息（task_id / team）：带字段名标签，
        // 否则 id 紧跟在任务标题后，读起来会和任务名称混成一段。
        subtitle={
          selected && (
            <span className="_memory-workbench-drawer-subtitle">
              <span>
                <span className="_memory-mono">{selected.task_id}</span>
              </span>
            </span>
          )
        }
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
