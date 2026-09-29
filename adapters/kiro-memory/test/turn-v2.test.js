import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { buildSkillConversationPayload } from '../src/core/capture-service.js';
import { TurnStore } from '../src/core/turn-store.js';
import { handlePostToolUse } from '../src/hooks/post-tool-use.js';

const config = { teamId: 'team', userId: 'user', agentId: 'agent' };

test('new turns are v2 and observed tool messages carry the real hook observation timestamp', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'kiro-turn-v2-'));
  try {
    const times = [new Date('2026-08-16T01:00:00.000Z'), new Date('2026-08-16T01:01:00.000Z')];
    const store = new TurnStore({ stateDir, idFactory: () => 'turn-v2', now: () => times.shift() ?? new Date('2026-08-16T01:02:00.000Z') });
    const turn = await store.createTurn({ sessionId: 'session', prompt: 'prompt' });
    assert.equal(turn.version, 2);
    await handlePostToolUse({ eventName: 'PostToolUse', sessionId: 'session', toolName: 'read', toolInput: {}, toolResponse: {} }, {
      turnStore: store, toolCallIdFactory: () => 'call', now: () => new Date('2026-08-16T01:01:30.000Z'),
    });
    const completed = await store.completeTurn('session');
    assert.equal(completed.tool_events[0].observed_at, '2026-08-16T01:01:30.000Z');
    const payload = buildSkillConversationPayload(completed, config);
    assert.equal(payload.messages[0].timestamp, completed.created_at);
    assert.equal(payload.messages[1].timestamp, '2026-08-16T01:01:30.000Z');
    assert.equal(payload.messages[2].timestamp, '2026-08-16T01:01:30.000Z');
  } finally { await rm(stateDir, { recursive: true, force: true }); }
});
test('the first real mutation upgrades an active v1 turn without inventing legacy observation time', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'kiro-turn-v1-'));
  try {
    const store = new TurnStore({ stateDir, idFactory: () => 'legacy', now: () => new Date('2026-08-16T02:00:00.000Z') });
    await store.createTurn({ sessionId: 'session', prompt: 'prompt' });
    const path = store.turnPath('session', 'legacy');
    const legacy = JSON.parse(await readFile(path, 'utf8'));
    legacy.version = 1;
    legacy.tool_events = [{
      tool_call_id: 'old', tool_name: 'read',
      tool_call: { role: 'tool_call', tool_name: 'read', tool_call_id: 'old', content: '{}' },
      tool_result: { role: 'tool_result', tool_name: 'read', tool_call_id: 'old', content: '{}' },
    }];
    await writeFile(path, `${JSON.stringify(legacy)}\n`);
    const updated = await store.appendToolEvent('session', {
      tool_call_id: 'new', tool_name: 'read', observed_at: '2026-08-16T02:01:00.000Z',
      tool_call: { role: 'tool_call', tool_name: 'read', tool_call_id: 'new', content: '{}' },
      tool_result: { role: 'tool_result', tool_name: 'read', tool_call_id: 'new', content: '{}' },
    });
    assert.equal(updated.version, 2);
    assert.equal(updated.tool_events[0].observed_at, null);
    const completed = await store.completeTurn('session');
    const payload = buildSkillConversationPayload(completed, config);
    assert.equal(Object.hasOwn(payload.messages[1], 'timestamp'), false);
    assert.equal(Object.hasOwn(payload.messages[2], 'timestamp'), false);
  } finally { await rm(stateDir, { recursive: true, force: true }); }
});
