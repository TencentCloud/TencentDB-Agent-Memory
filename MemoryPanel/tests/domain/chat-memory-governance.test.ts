import { describe, expect, it } from 'vitest';
import {
  readChatMemoryRel,
  validateImportedAgents,
  writeChatMemoryRel,
} from '../../src/panel/domain/chat-memory-governance.js';
import { isGlobalAdmin } from '../../web/src/services/permissions.js';

const teamAgents = ['self', 'peer-a', 'peer-b', 'peer-c'].map((agent_id) => ({ agent_id }));

describe('chat-memory borrowing policy', () => {
  it.each([{ ids: [] }, { ids: ['peer-a'] }, { ids: ['peer-a', 'peer-b'] }])('accepts an allowed borrowing list $ids', ({ ids }) => {
    expect(validateImportedAgents('self', ids, teamAgents)).toEqual({ ok: true });
  });

  it.each([
    { ids: ['peer-a', 'peer-b', 'peer-c'], reason: '最多只能借入 2 个 agent' },
    { ids: ['self'], reason: '不能借入自己的记忆' },
    { ids: ['outsider'], reason: 'agent_id "outsider" 不在当前 team 中' },
    { ids: ['peer-a', 'peer-a'], reason: '借入列表中存在重复 agent' },
    { ids: [''], reason: '存在无效的 agent_id' },
    { ids: [42], reason: '存在无效的 agent_id' },
    { ids: null, reason: 'imported_agent_ids 必须是数组' },
  ])('rejects $ids', ({ ids, reason }) => {
    expect(validateImportedAgents('self', ids as string[], teamAgents)).toEqual({ ok: false, reason });
  });

  it.each([undefined, '', '{bad json', 'null', '42', '{}'])('tolerates missing/legacy metadata %s', (metadata_json) => {
    expect(readChatMemoryRel({ agent_id: 'self', metadata_json })).toEqual({
      memory_shared_with_team: true,
      imported_agent_ids: [],
    });
  });

  it('normalizes duplicate, non-string and excess imports while preserving an explicit private flag', () => {
    const metadata_json = JSON.stringify({
      chat_memory: { memory_shared_with_team: false, imported_agent_ids: ['peer-a', 9, 'peer-a', 'peer-b', 'peer-c'] },
    });
    expect(readChatMemoryRel({ agent_id: 'self', metadata_json })).toEqual({
      memory_shared_with_team: false,
      imported_agent_ids: ['peer-a', 'peer-b'],
    });
  });

  it('writes its namespace without losing other metadata or mutating the supplied relation', () => {
    const relation = { memory_shared_with_team: false, imported_agent_ids: ['peer-a', 'peer-a'] };
    const result = JSON.parse(writeChatMemoryRel('{"custom":{"label":"keep"}}', relation));
    expect(result).toEqual({
      custom: { label: 'keep' },
      chat_memory: { memory_shared_with_team: false, imported_agent_ids: ['peer-a'] },
    });
    expect(relation.imported_agent_ids).toEqual(['peer-a', 'peer-a']);
  });
});

describe('frontend admin presentation boundary', () => {
  it('never elevates a username to system administrator', () => {
    expect(isGlobalAdmin('admin')).toBe(false);
    expect(isGlobalAdmin('admin', false)).toBe(false);
    expect(isGlobalAdmin('ordinary-user', true)).toBe(true);
  });
});
