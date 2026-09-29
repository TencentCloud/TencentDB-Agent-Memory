import assert from 'node:assert/strict';
import test from 'node:test';

import { RecallService } from '../src/core/recall-service.js';

test('hook recall selects configured sources and formats the shared query result', async () => {
  let request;
  const queryService = { query: async (value) => {
    request = value;
    return {
      hits: [{ source: 'skill', stableId: 'skill:s', sourceRank: 1, fusedScore: 1 / 61, content: 'skill memory', metadata: {} }],
      coreContent: 'core memory', degradedSources: ['conversation'], truncated: false,
    };
  } };
  const service = new RecallService({ queryService, config: {
    recallEnabled: true, conversationRecallEnabled: true, skillRecallEnabled: true,
    maxRecallResults: 5, maxContextChars: 6000, timeoutMs: 2500,
  } });
  const output = await service.recall('  current question  ');
  assert.deepEqual(request.sources, ['atomic', 'core', 'conversation', 'skill']);
  assert.equal(request.query, '  current question  ');
  assert.match(output, /\[Skill Memories\]\n1\. skill memory/);
  assert.match(output, /\[Core Memory\]\ncore memory/);
  assert.match(output, /^<TDAI_MEMORY_CONTEXT>/);
  assert.match(output, /<\/TDAI_MEMORY_CONTEXT>$/);
});
test('hook recall fails open when the shared query core rejects', async () => {
  const service = new RecallService({
    queryService: { query: async () => { throw new Error('private prompt'); } },
    config: { recallEnabled: true, maxRecallResults: 5, maxContextChars: 6000, timeoutMs: 2500 },
  });
  assert.equal(await service.recall('private prompt'), '');
});
