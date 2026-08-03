import { describe, expect, it } from 'vitest';

import {
  DEFAULT_CHAT_MEMORY_REL,
  MAX_IMPORTED_AGENTS,
  readChatMemoryRel,
  validateImportedAgents,
  writeChatMemoryRel,
} from '../../src/panel/domain/chat-memory-governance.js';

const teamAgents = [
  { agent_id: 'a1' },
  { agent_id: 'a2' },
  { agent_id: 'a3' },
];

describe('validateImportedAgents', () => {
  it('accepts up to MAX_IMPORTED_AGENTS distinct same-team peers', () => {
    const first = MAX_IMPORTED_AGENTS >= 1 ? ['a2'] : [];
    expect(validateImportedAgents('a1', first, teamAgents)).toEqual({ ok: true });

    const full = teamAgents
      .filter((agent) => agent.agent_id !== 'a1')
      .slice(0, MAX_IMPORTED_AGENTS)
      .map((agent) => agent.agent_id);
    expect(validateImportedAgents('a1', full, teamAgents)).toEqual({ ok: true });
  });

  it('rejects arrays exceeding the borrow limit', () => {
    const oversize = ['a2', 'a3', 'a1-clone'];
    expect(validateImportedAgents('a1', oversize, teamAgents)).toEqual({
      ok: false,
      reason: `最多只能借入 ${MAX_IMPORTED_AGENTS} 个 agent`,
    });
  });

  it('rejects non-array or malformed inputs', () => {
    expect(
      validateImportedAgents('a1', 'not-an-array' as unknown as string[], teamAgents),
    ).toEqual({ ok: false, reason: 'imported_agent_ids 必须是数组' });
    expect(validateImportedAgents('a1', ['' as unknown as string], teamAgents)).toEqual({
      ok: false,
      reason: '存在无效的 agent_id',
    });
  });

  it('rejects borrowing yourself, cross-team agents, or duplicates', () => {
    expect(validateImportedAgents('a1', ['a1'], teamAgents)).toEqual({
      ok: false,
      reason: '不能借入自己的记忆',
    });
    expect(validateImportedAgents('a1', ['outsider'], teamAgents)).toEqual({
      ok: false,
      reason: 'agent_id "outsider" 不在当前 team 中',
    });
    expect(validateImportedAgents('a1', ['a2', 'a2'], teamAgents)).toEqual({
      ok: false,
      reason: '借入列表中存在重复 agent',
    });
  });
});

describe('readChatMemoryRel / writeChatMemoryRel', () => {
  it('returns the default relation when metadata is absent or unparseable', () => {
    expect(readChatMemoryRel({ agent_id: 'a1' })).toEqual(DEFAULT_CHAT_MEMORY_REL);
    expect(readChatMemoryRel({ agent_id: 'a1', metadata_json: 'not-json' })).toEqual(
      DEFAULT_CHAT_MEMORY_REL,
    );
  });

  it('round-trips chat_memory relations while preserving foreign metadata', () => {
    const rel = { memory_shared_with_team: false, imported_agent_ids: ['a2', 'a3'] };
    const prev = JSON.stringify({ untouched: { keep: true } });
    const next = writeChatMemoryRel(prev, rel);

    const parsed = JSON.parse(next);
    expect(parsed.untouched).toEqual({ keep: true });
    expect(readChatMemoryRel({ agent_id: 'a1', metadata_json: next })).toEqual(rel);
  });

  it('normalizes malformed values on read and enforces the borrow cap on write', () => {
    const rel = {
      memory_shared_with_team: 'yes' as unknown as boolean,
      imported_agent_ids: ['a1', 'a1', 'a2', 42 as unknown as string, 'a3', 'a4'],
    };
    const raw = writeChatMemoryRel(undefined, rel);
    const normalized = readChatMemoryRel({ agent_id: 'self', metadata_json: raw });

    expect(normalized.memory_shared_with_team).toBe(true);
    expect(normalized.imported_agent_ids.length).toBeLessThanOrEqual(MAX_IMPORTED_AGENTS);
    expect(new Set(normalized.imported_agent_ids).size).toBe(
      normalized.imported_agent_ids.length,
    );
    for (const id of normalized.imported_agent_ids) {
      expect(typeof id).toBe('string');
    }
  });
});
