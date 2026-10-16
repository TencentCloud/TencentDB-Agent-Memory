import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CHAT_MEMORY_REL,
  MAX_IMPORTED_AGENTS,
  readChatMemoryRel,
  validateImportedAgents,
  writeChatMemoryRel,
} from '../../src/panel/domain/chat-memory-governance.js';

const team = [{ agent_id: 'a1' }, { agent_id: 'a2' }, { agent_id: 'a3' }];

describe('validateImportedAgents', () => {
  it('accepts an empty list', () => {
    expect(validateImportedAgents('self', [], team)).toEqual({ ok: true });
  });

  it('accepts up to MAX_IMPORTED_AGENTS valid agents', () => {
    expect(validateImportedAgents('self', ['a1', 'a2'], team)).toEqual({ ok: true });
  });

  it('rejects more than MAX_IMPORTED_AGENTS', () => {
    const r = validateImportedAgents('self', ['a1', 'a2', 'a3'], team);
    expect(r).toEqual({ ok: false, reason: `最多只能借入 ${MAX_IMPORTED_AGENTS} 个 agent` });
  });

  it('rejects importing oneself', () => {
    const r = validateImportedAgents('a1', ['a1'], team);
    expect(r).toEqual({ ok: false, reason: '不能借入自己的记忆' });
  });

  it('rejects an agent outside the team', () => {
    const r = validateImportedAgents('self', ['outsider'], team);
    expect(r).toEqual({ ok: false, reason: 'agent_id "outsider" 不在当前 team 中' });
  });

  it('rejects duplicate ids', () => {
    const r = validateImportedAgents('self', ['a1', 'a1'], team);
    expect(r).toEqual({ ok: false, reason: '借入列表中存在重复 agent' });
  });

  it('rejects non-string ids', () => {
    const r = validateImportedAgents('self', ['a1', 42 as unknown as string], team);
    expect(r).toEqual({ ok: false, reason: '存在无效的 agent_id' });
  });

  it('rejects a non-array', () => {
    const r = validateImportedAgents('self', 'a1' as unknown as string[], team);
    expect(r).toEqual({ ok: false, reason: 'imported_agent_ids 必须是数组' });
  });
});

describe('readChatMemoryRel', () => {
  it('returns defaults when metadata_json is absent', () => {
    expect(readChatMemoryRel({ agent_id: 'a1' })).toEqual(DEFAULT_CHAT_MEMORY_REL);
  });

  it('returns defaults when the chat_memory slot is absent', () => {
    const agent = { agent_id: 'a1', metadata_json: JSON.stringify({ other: 1 }) };
    expect(readChatMemoryRel(agent)).toEqual(DEFAULT_CHAT_MEMORY_REL);
  });

  it('returns defaults on malformed JSON', () => {
    const agent = { agent_id: 'a1', metadata_json: '{not json' };
    expect(readChatMemoryRel(agent)).toEqual(DEFAULT_CHAT_MEMORY_REL);
  });

  it('reads and normalizes a valid rel', () => {
    const agent = {
      agent_id: 'a1',
      metadata_json: JSON.stringify({
        chat_memory: { memory_shared_with_team: false, imported_agent_ids: ['a2'] },
      }),
    };
    expect(readChatMemoryRel(agent)).toEqual({
      memory_shared_with_team: false,
      imported_agent_ids: ['a2'],
    });
  });

  it('caps imported_agent_ids to MAX_IMPORTED_AGENTS when normalizing', () => {
    const agent = {
      agent_id: 'a1',
      metadata_json: JSON.stringify({
        chat_memory: { imported_agent_ids: ['a1', 'a2', 'a3', 'a4'] },
      }),
    };
    const rel = readChatMemoryRel(agent);
    expect(rel.imported_agent_ids).toHaveLength(MAX_IMPORTED_AGENTS);
  });
});

describe('writeChatMemoryRel', () => {
  it('writes only the chat_memory slot when no previous metadata exists', () => {
    const out = writeChatMemoryRel(undefined, DEFAULT_CHAT_MEMORY_REL);
    expect(JSON.parse(out)).toEqual({ chat_memory: DEFAULT_CHAT_MEMORY_REL });
  });

  it('preserves unrelated keys while writing the rel', () => {
    const prev = JSON.stringify({ other: 42 });
    const out = writeChatMemoryRel(prev, DEFAULT_CHAT_MEMORY_REL);
    expect(JSON.parse(out)).toEqual({ other: 42, chat_memory: DEFAULT_CHAT_MEMORY_REL });
  });

  it('discards malformed previous metadata', () => {
    const out = writeChatMemoryRel('{broken', DEFAULT_CHAT_MEMORY_REL);
    expect(JSON.parse(out)).toEqual({ chat_memory: DEFAULT_CHAT_MEMORY_REL });
  });

  it('does not mutate the input rel object', () => {
    const rel = { ...DEFAULT_CHAT_MEMORY_REL, imported_agent_ids: ['a1'] };
    writeChatMemoryRel(undefined, rel);
    expect(rel).toEqual({ ...DEFAULT_CHAT_MEMORY_REL, imported_agent_ids: ['a1'] });
  });
});
