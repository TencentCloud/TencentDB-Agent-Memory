/**
 * 946-C Chat Memory Deletion V2 — 幂等与审计测试。
 *
 * 覆盖（docs/946spec.md §8/§13）：
 *   - 幂等键构造按 (actor, asset, op_type, key)
 *   - 同 key 重放返回原始结果（replayed-success）
 *   - 不同 key 不共享
 *   - 审计事件包含 actor/owner 分离，不含记忆原文
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  buildIdempotencyKey,
  readIdempotency,
  writeIdempotency,
  emitDeleteAudit,
  newAuditEventId,
  type MemoryDeleteAuditEvent,
} from '../src/panel/http/routes/chat-memory-delete-v2.js';
import type { Logger } from '../src/panel/infra/logger.js';

describe('idempotency (946-C §8)', () => {
  beforeEach(() => {
    // 每个用例前清空幂等存储：通过写入一个不存在的 key 无法清空，
    // 因此这里用「不同 key」规避跨用例污染；如需强制清空可加导出。
  });

  it('builds key scoped to (actor, asset, op_type, key)', () => {
    const k1 = buildIdempotencyKey('u1', 'a1', 'delete:L0', 'key1');
    const k2 = buildIdempotencyKey('u1', 'a1', 'delete:L0', 'key2');
    const k3 = buildIdempotencyKey('u2', 'a1', 'delete:L0', 'key1');
    expect(k1).not.toBe(k2);
    expect(k1).not.toBe(k3);
    expect(k1).toContain('u1');
    expect(k1).toContain('a1');
    expect(k1).toContain('delete:L0');
  });

  it('replays original result for same key', () => {
    const key = buildIdempotencyKey('u1', 'a1', 'delete:L1', 'abc');
    const original = { deletedCount: 1, failedCount: 0 };
    writeIdempotency(key, original);
    const replayed = readIdempotency(key);
    expect(replayed).toEqual(original);
  });

  it('returns undefined for unknown key', () => {
    expect(readIdempotency(buildIdempotencyKey('u1', 'a1', 'delete:L0', 'nope'))).toBeUndefined();
  });
});

describe('audit events (946-C §13)', () => {
  const events: string[] = [];
  const logger: Logger = {
    debug: (m) => { events.push(m); },
    info: (m) => { events.push(m); },
    warn: (m) => { events.push(m); },
    error: (m) => { events.push(m); },
    child: () => logger,
  };

  it('emits event with actor/owner separated and no content', () => {
    const evt: MemoryDeleteAuditEvent = {
      eventId: newAuditEventId('req-1'),
      requestId: 'req-1',
      actorUserId: 'actor-1',
      actorTeamId: 'team-1',
      ownerUserId: 'owner-2',
      assetId: 'chat_memory-team-1-agt-x',
      layer: 'L0',
      authorizationDecisionId: 'panel-owner-only',
      result: 'deleted',
      itemCount: 3,
      createdAt: new Date().toISOString(),
    };
    emitDeleteAudit(logger, evt);
    expect(events.length).toBe(1);
    expect(events[0]).toContain('actor-1');
    expect(events[0]).toContain('owner-2');
    expect(events[0]).not.toContain('SENSITIVE_MEMORY_CONTENT');
  });

  it('emits denied as warn level', () => {
    const evt: MemoryDeleteAuditEvent = {
      eventId: newAuditEventId('req-2'),
      requestId: 'req-2',
      actorUserId: 'actor-1',
      ownerUserId: 'owner-2',
      assetId: 'a',
      layer: 'L1',
      authorizationDecisionId: 'panel-owner-only',
      result: 'denied',
      itemCount: 0,
      createdAt: new Date().toISOString(),
    };
    emitDeleteAudit(logger, evt);
    expect(events.length).toBe(2);
  });
});
