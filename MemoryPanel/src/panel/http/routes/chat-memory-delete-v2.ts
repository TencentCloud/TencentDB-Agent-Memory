/**
 * Chat Memory Deletion V2 — 面板层审计与幂等辅助。
 *
 * 946-C（docs/946spec.md §8/§13）：
 *   - 幂等：按 (actor_user_id, asset_id, layer, operation_key) 记录请求结果，
 *     重放相同 key 返回原始结果，避免网络超时重试导致重复下游变更；
 *   - 审计：每次破坏性操作输出一条审计事件（含 actor/owner 分离、授权决策、
 *     per-item 结果），且不包含原始记忆内容。
 */

import type { Logger } from '../../infra/logger.js';

// ── 幂等存储（内存 LRU，面板层单实例适用） ──────────────────────────────────

export interface IdempotencyEntry {
  key: string;
  result: unknown;
  createdAt: number;
}

const IDEMPOTENCY_TTL_MS = 10 * 60 * 1000; // 10 分钟
const IDEMPOTENCY_MAX_ENTRIES = 500;

class InMemoryIdempotencyStore {
  private map = new Map<string, IdempotencyEntry>();

  get(key: string): IdempotencyEntry | undefined {
    const e = this.map.get(key);
    if (!e) return undefined;
    if (Date.now() - e.createdAt > IDEMPOTENCY_TTL_MS) {
      this.map.delete(key);
      return undefined;
    }
    return e;
  }

  set(key: string, result: unknown): void {
    // 简单 LRU：超限时删除最旧条目
    if (this.map.size >= IDEMPOTENCY_MAX_ENTRIES) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    this.map.set(key, { key, result, createdAt: Date.now() });
  }
}

const idempotencyStore = new InMemoryIdempotencyStore();

/**
 * 构造幂等键。规范（§8）：(actor_user_id, asset_id, operation_type, idempotency_key)。
 * operation_type 形如 "delete:L0" / "delete:L1" / "delete:L2"。
 */
export function buildIdempotencyKey(
  actorUserId: string,
  assetId: string,
  operationType: string,
  idempotencyKey: string,
): string {
  return `${actorUserId}|${assetId}|${operationType}|${idempotencyKey}`;
}

/** 读幂等结果（无则 undefined）。 */
export function readIdempotency(key: string): unknown | undefined {
  return idempotencyStore.get(key)?.result;
}

/** 写幂等结果。 */
export function writeIdempotency(key: string, result: unknown): void {
  idempotencyStore.set(key, result);
}

// ── 审计事件（§13） ──────────────────────────────────────────────────────────

export type MemoryDeleteAuditResult = "deleted" | "partial" | "denied" | "failed";

export interface MemoryDeleteAuditEvent {
  eventId: string;
  requestId: string;

  actorUserId: string;
  actorTeamId?: string;

  ownerUserId: string;
  assetId: string;
  layer: "L0" | "L1" | "L2";

  authorizationDecisionId: string;

  result: MemoryDeleteAuditResult;
  itemCount: number;

  createdAt: string;
}

let auditSeq = 0;

/** 生成审计事件 id（requestId + 序号，进程内唯一）。 */
export function newAuditEventId(requestId: string): string {
  auditSeq += 1;
  return `audit-${requestId}-${auditSeq}`;
}

/**
 * 输出一条删除审计事件。默认写 info 日志；denied/failed 写 warn。
 * 审计内容不含任何记忆原文（§13）。
 */
export function emitDeleteAudit(
  logger: Logger,
  event: MemoryDeleteAuditEvent,
): void {
  const line = JSON.stringify(event);
  if (event.result === "denied" || event.result === "failed") {
    logger.warn(`[chat-memory-delete-audit] ${line}`);
  } else {
    logger.info(`[chat-memory-delete-audit] ${line}`);
  }
}
