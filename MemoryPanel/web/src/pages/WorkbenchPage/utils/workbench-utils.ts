/**
 * workbench-utils —— 工作台的共享类型、常量与纯工具函数。
 * 从 TaskWorkbench.tsx 拆出。
 */
import { useTranslation } from 'react-i18next';

export type WorkbenchTab = 'board' | 'logs';

export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * 从 task 的 metadata_json 里读出**具体来源** id。
 *
 * 与后端 `readExternalRef` 对应：source_type 只表大类（manual / external），
 * 具体是哪个系统存在 `metadata_json.external.provider`。
 * 读不到返回 null —— 调用方据此回落到「不显示来源行」。
 */
export function readExternalProvider(task: { metadata_json?: string }): string | null {
  if (!task.metadata_json) return null;
  try {
    const meta = JSON.parse(task.metadata_json) as {
      external?: { provider?: unknown };
    };
    const provider = meta.external?.provider;
    return typeof provider === 'string' && provider ? provider : null;
  } catch {
    // metadata_json 非 JSON（脏数据/旧格式）：当作没有来源，不抛错。
    return null;
  }
}

/**
 * 外部来源 id → 展示名。
 *
 * 按约定取 `task.source.<id>`，不在代码里列举来源 —— 新增来源只需在 i18n
 * 加一条，无需改本函数（若在此处写 `if (id === 'tapd')`，每接一个源都要改代码）。
 *
 * 未登记的来源回落到 id 本身，不会显示空白。
 */
export function useSourceLabel() {
  const { t } = useTranslation();
  return (sourceId: string): string =>
    t(`task.source.${sourceId}`, { defaultValue: sourceId });
}

// Task 状态在演示阶段简化为二态：进行中 / 已完成。
// 历史的 待处理 / 阻塞 / 已归档 已下线（参见 backendStore.ts 里的 normalizeTaskStatus）。
export function useStatusLabels() {
  const { t } = useTranslation();
  return {
    running: t('task.status.running'),
    completed: t('task.status.completed'),
  };
}

export interface AgentOption {
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

export const EMPTY_VIEW: TaskParticipationView = { users: [], agentIds: [] };

/**
 * 需要隐藏的「非真实 agent」哨兵 id。
 *
 * 导入产生的参与记录用哨兵 `external-import` 作 agent_id（对应 meta_agents 里
 * 名为「外部任务导入」的假 agent）—— 因为 participation_log 的 agent_id 必填，
 * 而导入场景没有真实 agent 开工。
 *
 * 该哨兵是**记账占位**，不是真的有 agent 参与，故展示层统一过滤掉它：
 *   - 「实际参与 Agent」→ 列表为空 → 落到既有的「—」，与非导入 task 一致；
 *   - 看板卡片 → 同样不渲染该 chip。
 *
 * 注意这只影响 **agentIds** 桶；同一条记录的 `user_id`（来源系统的处理人）照常
 * 进 `users` 桶，正常显示在「参与的 User」—— 两个桶互不干扰。
 *
 * `tapd-import` 是**改名前的旧值**，历史上已写入库，一并过滤以免旧数据
 * 露出「外部任务导入」（只做展示过滤、**不删数据**：参与记录是观测数据）。
 */
const HIDDEN_AGENT_IDS = new Set(['external-import', 'tapd-import']);

export function isHiddenAgentId(agentId: string): boolean {
  return HIDDEN_AGENT_IDS.has(agentId);
}

/** 过滤掉哨兵后的真实 agent_id 列表。 */
export function visibleAgentIds(agentIds: readonly string[]): string[] {
  return agentIds.filter((id) => !isHiddenAgentId(id));
}

export function participationOf(
  byTask: Map<string, TaskParticipationView>,
  taskId: string,
): TaskParticipationView {
  return byTask.get(taskId) ?? EMPTY_VIEW;
}
