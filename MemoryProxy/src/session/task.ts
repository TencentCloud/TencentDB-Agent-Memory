import type { SessionInitState, TaskInTeam } from "./types.js";

/** Convert the UI's no-task option to an absent business dimension. */
export function normalizeTaskId(
  taskId: string | undefined,
  defaultTaskId: string | undefined,
  tasks: TaskInTeam[] = [],
): string | undefined {
  if (!taskId || taskId === defaultTaskId || tasks.some((t) => t.task_id === taskId && t.isDefault)) {
    return undefined;
  }
  return taskId;
}

/** Clean legacy completed sessions without changing pending form selections. */
export function normalizeSessionTask(
  state: SessionInitState,
  defaultTaskId: string | undefined,
): SessionInitState {
  const session = state.sessionInfo;
  if (!session?.task_id) return state;
  const tasks = state.cachedTeams?.find((t) => t.team_id === session.team_id)?.tasks;
  if (normalizeTaskId(session.task_id, defaultTaskId, tasks) !== undefined) return state;
  return {
    ...state,
    sessionInfo: { ...session, task_id: undefined },
    taskDetail: null,
  };
}
