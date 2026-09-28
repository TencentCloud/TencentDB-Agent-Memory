/**
 * memory-access 审计线（Session 隔离可辩护性：谁在什么时候读/写了谁的记忆）。
 *
 * 设计约束：
 * - fire-and-forget，任何失败（日志 / 落盘 / 轮转）都绝不阻塞业务；
 * - 事件字段全部由 proxy 服务端派生，客户端 header 不参与，业务无法伪造；
 * - 长字段做长度封顶，防止审计文件被单条超大事件撑爆；
 * - 可选 JSONL 落盘：`AUDIT_LOG_FILE` 指定路径，`AUDIT_LOG_MAX_BYTES` 控制
 *   单文件上限（默认 100MB，达到后轮转为 `<file>.1`）；
 * - trace_id 保留完整值（不再截断），与 Opik trace 串联时可直接关联。
 */
import { log } from "./report/log.js";
import { appendFile, rename, rm, stat } from "node:fs/promises";

const DEFAULT_AUDIT_MAX_BYTES = 100 * 1024 * 1024;
const MIN_AUDIT_MAX_BYTES = 1024;
const MAX_STRING_FIELD = 256;
const MAX_TRACE_ID = 128;

export interface MemoryAccessEvent {
  /** 请求发起者 user_id（auth/verify 后）。 */
  actorUser?: string;
  /** 会话绑定的 agent_id。 */
  actorAgent?: string;
  action: "recall" | "write" | "search" | "read" | "query";
  /** 目标命名空间：team:agent[:task]。 */
  target: string;
  /** 结果摘要（召回条数 / l0 / 错误码等）。 */
  result: string | number;
  sessionKey?: string;
  traceId?: string;
  /** 写入作用域：normal / no-task（缺 task 归属的 bypass 会话）。 */
  scope?: string;
}

export interface AuditPayload {
  actor_user: string;
  actor_agent: string;
  action: MemoryAccessEvent["action"];
  target: string;
  result: string | number;
  session_key: string;
  scope: string;
  trace_id: string;
  ts: string;
}

function cap(value: unknown, max: number): string {
  const s = String(value ?? "");
  return s.length > max ? s.slice(0, max) : s;
}

/** 纯函数：事件 → 落盘/日志 payload（长度封顶、字段归一，便于单测）。 */
export function buildAuditPayload(
  evt: MemoryAccessEvent,
  now: Date = new Date(),
): AuditPayload {
  return {
    actor_user: cap(evt.actorUser, MAX_STRING_FIELD) || "anonymous",
    actor_agent: cap(evt.actorAgent, MAX_STRING_FIELD) || "-",
    action: evt.action,
    target: cap(evt.target, MAX_STRING_FIELD),
    result: typeof evt.result === "number" ? evt.result : cap(evt.result, MAX_STRING_FIELD),
    session_key: cap(evt.sessionKey, MAX_STRING_FIELD),
    scope: cap(evt.scope, MAX_STRING_FIELD) || "normal",
    trace_id: cap(evt.traceId, MAX_TRACE_ID),
    ts: now.toISOString(),
  };
}

function auditFileSettings(): { file: string; maxBytes: number } {
  const file = (process.env.AUDIT_LOG_FILE ?? "").trim();
  const rawMax = Number(process.env.AUDIT_LOG_MAX_BYTES ?? "");
  const maxBytes =
    Number.isFinite(rawMax) && rawMax > 0
      ? Math.max(MIN_AUDIT_MAX_BYTES, Math.floor(rawMax))
      : DEFAULT_AUDIT_MAX_BYTES;
  return { file, maxBytes };
}

/** 达到大小上限时轮转：`<file>` → `<file>.1`（旧 .1 覆盖，单进程场景足够）。 */
async function rotateIfNeeded(file: string, maxBytes: number): Promise<void> {
  try {
    const info = await stat(file);
    if (info.size < maxBytes) return;
    const backup = `${file}.1`;
    await rm(backup, { force: true });
    await rename(file, backup);
  } catch {
    /* 无文件或轮转失败：静默，下一轮 append 继续 */
  }
}

/** 审计事件写只追加 JSONL（可独立导出供路由/测试直接落盘）。 */
export async function appendAuditLine(payload: AuditPayload): Promise<void> {
  const { file, maxBytes } = auditFileSettings();
  if (!file) return;
  try {
    await rotateIfNeeded(file, maxBytes);
    await appendFile(file, `${JSON.stringify(payload)}\n`);
  } catch (err) {
    log.debug("audit.append_failed", { error: String(err) });
  }
}

export function auditMemoryAccess(evt: MemoryAccessEvent): void {
  try {
    const payload = buildAuditPayload(evt);
    log.info("audit.memory-access", { ...payload });
    void appendAuditLine(payload);
  } catch {
    /* audit must never throw */
  }
}
