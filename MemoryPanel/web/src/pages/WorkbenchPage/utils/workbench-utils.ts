/**
 * workbench-utils —— 工作台的共享类型、常量与纯工具函数。
 * 从 TaskWorkbench.tsx 拆出。
 */
import { useTranslation } from 'react-i18next';

export type WorkbenchTab = 'board' | 'logs';

export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
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

export function participationOf(
  byTask: Map<string, TaskParticipationView>,
  taskId: string,
): TaskParticipationView {
  return byTask.get(taskId) ?? EMPTY_VIEW;
}
