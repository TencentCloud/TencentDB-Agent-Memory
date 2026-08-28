/**
 * memory-access 审计线（Session 隔离可辩护性：谁在什么时候读/写了谁的记忆）。
 * fire-and-forget，失败绝不阻塞业务；当前输出结构化日志（audit.memory-access），
 * 后续可接 Opik audit_log 项目 / 审计存储。
 */
import { log } from "./report/log.js";
import { appendFile } from "node:fs/promises";

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

export function auditMemoryAccess(evt: MemoryAccessEvent): void {
  try {
    const payload = {
      actor_user: evt.actorUser ?? "anonymous",
      actor_agent: evt.actorAgent ?? "-",
      action: evt.action,
      target: evt.target,
      result: evt.result,
      session_key: evt.sessionKey ?? "",
      scope: evt.scope ?? "normal",
      trace_id: evt.traceId ? String(evt.traceId).slice(0, 8) : "",
      ts: new Date().toISOString(),
    };
    log.info("audit.memory-access", payload);
    // 可选本地落盘（评审意见 6）：审计事件写只追加文件，业务请求无法伪造
    // （字段全部由 proxy 服务端派生，客户端 header 不参与）。控制面只读拉取。
    const auditFile = process.env.AUDIT_LOG_FILE;
    if (auditFile && auditFile.length > 0) {
      void appendFile(auditFile, `${JSON.stringify(payload)}\n`).catch(() => {
        /* 落盘失败不阻断业务 */
      });
    }
  } catch {
    /* audit must never throw */
  }
}
