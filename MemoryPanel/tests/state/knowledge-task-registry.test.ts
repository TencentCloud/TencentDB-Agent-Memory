import { describe, expect, it, vi } from 'vitest';

import { KnowledgeTaskRegistry } from '../../src/panel/state/knowledge-task-registry.js';
import type { KnowledgeTask } from '../../src/panel/state/knowledge-task-registry.js';

const BASE_TIME = 1_700_000_000_000; // 2023-11-14 in ms epoch

function task(overrides: Partial<KnowledgeTask> = {}): KnowledgeTask {
  return {
    knowledge_id: 'wiki-1',
    type: 'wiki',
    team_id: 'team-1',
    owner_user_id: 'user-1',
    owner_user_key: 'sk-user-1',
    service_id: 'mem-1',
    created_at: BASE_TIME,
    ...overrides,
  };
}

describe('KnowledgeTaskRegistry', () => {
  it('records tasks and returns them by knowledge_id', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(BASE_TIME));
      const registry = new KnowledgeTaskRegistry();
      const wiki = task({ knowledge_id: 'wiki-1', type: 'wiki' });
      const codeGraph = task({ knowledge_id: 'cg-1', type: 'code-graph' });

      registry.record(wiki);
      registry.record(codeGraph);

      expect(registry.size()).toBe(2);
      expect(registry.peek('wiki-1')).toEqual(wiki);
      expect(registry.peek('cg-1')).toEqual(codeGraph);
      expect(registry.peek('missing')).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('overwrites the previous task when the same knowledge_id is recorded again', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(BASE_TIME));
      const registry = new KnowledgeTaskRegistry();
      registry.record(task({ owner_user_id: 'old-owner' }));
      registry.record(task({ owner_user_id: 'new-owner' }));

      expect(registry.size()).toBe(1);
      expect(registry.peek('wiki-1')?.owner_user_id).toBe('new-owner');
    } finally {
      vi.useRealTimers();
    }
  });

  it('take returns the task and removes it from the registry', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(BASE_TIME));
      const registry = new KnowledgeTaskRegistry();
      const stored = task();
      registry.record(stored);

      const taken = registry.take('wiki-1');

      expect(taken).toEqual(stored);
      expect(registry.size()).toBe(0);
      expect(registry.take('wiki-1')).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('explicit sweep(now) removes tasks older than the configured TTL', () => {
    const ttlMs = 1_000;
    const registry = new KnowledgeTaskRegistry(ttlMs);
    // Populate around a controllable clock so record()'s implicit sweep also
    // reads the fake time.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(100));
      registry.record(task({ knowledge_id: 'fresh', created_at: 100 }));
      registry.record(task({ knowledge_id: 'stale', created_at: 100 }));

      vi.setSystemTime(new Date(5_000));
      registry.record(task({ knowledge_id: 'fresh-2', created_at: 5_000 }));

      // Explicit sweep at t=1_500 → t=100 entries are stale (age 1_400 > ttl),
      // t=5_000 entry has a negative age and survives.
      registry.sweep(1_500);

      // Freeze the clock at t=1_500 so peek()'s implicit sweep matches.
      vi.setSystemTime(new Date(1_500));
      expect(registry.peek('fresh-2')).toBeDefined();
      expect(registry.peek('fresh')).toBeUndefined();
      expect(registry.peek('stale')).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('record implicitly sweeps expired entries', () => {
    const ttlMs = 1_000;
    const registry = new KnowledgeTaskRegistry(ttlMs);
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(0));
      registry.record(task({ knowledge_id: 'expiring', created_at: 0 }));

      vi.setSystemTime(new Date(5_000));
      registry.record(task({ knowledge_id: 'fresh', created_at: 5_000 }));

      expect(registry.peek('expiring')).toBeUndefined();
      expect(registry.peek('fresh')).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
