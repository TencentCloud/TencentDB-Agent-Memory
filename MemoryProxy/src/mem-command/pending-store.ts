/**
 * Pending Task Action Store
 *
 * 存放 mem:create-task / mem:update-task 首次调用生成的"待确认"动作草稿。
 * 用户下一轮回复 `... confirm` 时从这里取出落库；回复 `... cancel` 或超时则丢弃。
 *
 * 设计取舍：
 *   - 内存 Map，重启丢失（用户重发一次即可，符合"过渡态"定位）。
 *   - TTL 5 分钟，getPending 时 lazy 清理。
 *   - key = team_id:agent_id:session_id（对齐 kernel 侧唯一键含义）；缺 agent_id
 *     则用 "-" 占位，兼容未来 agent_id 缺失的路径。
 */

export type PendingKind = "create" | "update";

export interface PendingCreateDraft {
  title: string;
  description: string;
  hint?: string;
}

export interface PendingUpdateDraft {
  /** 目标 task id（一定是"当前 session 绑定的真实 task"）*/
  taskId: string;
  /** LLM 生成或用户直传的新描述 */
  description: string;
  /** LLM 建议的状态（如 "running" / "completed" / 其它自由文本），可为空 */
  statusSuggestion?: string;
  /** 原任务当前 title（只读展示用） */
  currentTitle?: string;
  /** 原任务当前 status（只读展示用） */
  currentStatus?: string;
  /** 输入提示（args 或 "session context"） */
  hint?: string;
}

export interface PendingCreatePayload {
  kind: "create";
  draft: PendingCreateDraft;
  /** 当前会话已绑定的旧 task，用于提示"将替换绑定" */
  currentTaskId: string;
  currentTaskTitle?: string;
}

export interface PendingUpdatePayload {
  kind: "update";
  draft: PendingUpdateDraft;
}

export type PendingPayload = PendingCreatePayload | PendingUpdatePayload;

interface PendingEntry {
  payload: PendingPayload;
  expiresAt: number;
}

const DEFAULT_TTL_MS = 5 * 60 * 1000;

const store = new Map<string, PendingEntry>();

export interface PendingKeyInput {
  team_id?: string;
  agent_id?: string;
  session_id?: string;
}

export function makePendingKey(input: PendingKeyInput): string {
  const t = input.team_id ?? "-";
  const a = input.agent_id ?? "-";
  const s = input.session_id ?? "-";
  return `${t}:${a}:${s}`;
}

export function setPending(key: string, payload: PendingPayload, ttlMs = DEFAULT_TTL_MS): void {
  store.set(key, { payload, expiresAt: Date.now() + ttlMs });
}

export function getPending(key: string): PendingPayload | null {
  const entry = store.get(key);
  if (!entry) return null;
  if (Date.now() >= entry.expiresAt) {
    store.delete(key);
    return null;
  }
  return entry.payload;
}

export function clearPending(key: string): boolean {
  return store.delete(key);
}

/** 测试用：全清 */
export function _resetPendingStoreForTests(): void {
  store.clear();
}
