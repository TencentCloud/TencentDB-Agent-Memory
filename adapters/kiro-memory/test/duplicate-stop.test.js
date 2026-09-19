import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { KiroIdeHookAssistantProvider } from '../src/core/assistant-response-provider.js';
import { CaptureService } from '../src/core/capture-service.js';
import { normalizeHookEvent } from '../src/core/event-normalizer.js';
import { GatewayClient } from '../src/core/gateway-client.js';
import { Outbox } from '../src/core/outbox.js';
import { RecallService } from '../src/core/recall-service.js';
import { TurnStore } from '../src/core/turn-store.js';
import { handlePostToolUse } from '../src/hooks/post-tool-use.js';
import { handlePromptSubmit } from '../src/hooks/prompt-submit.js';
import { handleStop } from '../src/hooks/stop.js';

const fixture = async (name) => JSON.parse(await readFile(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));

test('does not capture twice when Kiro delivers Stop repeatedly for the same normalized session', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'kiro-duplicate-stop-'));
  let server;
  try {
    const requests = [];
    server = createServer(async (request, response) => {
      let raw = '';
      for await (const chunk of request) raw += chunk;
      requests.push({ path: request.url, body: JSON.parse(raw) });
      const data = request.url === '/v3/atomic/search' ? { items: [] }
        : request.url === '/v3/core/read' ? { content: null }
          : { status: 'archived', archived: { task_id: requests.at(-1).body.task_id, archived_at_ms: 1, archive_key: 'archive-key', reason: 'tool_calls' } };
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ code: 0, data }));
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const config = {
      stateDir, gatewayUrl: `http://127.0.0.1:${server.address().port}`, timeoutMs: 500, serviceId: 'duplicate-service',
      teamId: 'team', userId: 'user', agentId: 'kiro', recallEnabled: true, maxRecallResults: 5, maxContextChars: 6000,
    };
    const gatewayClient = new GatewayClient(config);
    const outbox = new Outbox({ stateDir, gatewayClient });
    const turnStore = new TurnStore({ stateDir, idFactory: () => 'turn-duplicate' });
    const dependencies = {
      turnStore,
      recallService: new RecallService({ gatewayClient, config }),
      captureService: new CaptureService({ config, gatewayClient, outbox }),
      assistantResponseProvider: new KiroIdeHookAssistantProvider(),
      flushOutbox: () => outbox.flush(),
    };
    const sessionId = 'session-duplicate';
    await handlePromptSubmit(normalizeHookEvent({ ...(await fixture('prompt-submit.json')), session_id: sessionId }), dependencies);
    await handlePostToolUse(normalizeHookEvent({ ...(await fixture('post-tool-use.json')), session_id: sessionId }), { ...dependencies, toolCallIdFactory: () => 'call-duplicate' });
    const first = await handleStop(normalizeHookEvent({ ...(await fixture('stop.json')), session_id: sessionId }), dependencies);
    const second = await handleStop(normalizeHookEvent({ ...(await fixture('stop.json')), session_id: sessionId }), dependencies);
    const third = await handleStop(normalizeHookEvent({ ...(await fixture('stop.json')), session_id: sessionId }), dependencies);

    assert.equal(first.exitCode, 0);
    assert.equal(first.status, 'partial_captured');
    assert.deepEqual([second, third].map((result) => result.exitCode), [0, 0]);
    assert.deepEqual([second, third].map((result) => result.status), ['duplicate_or_unmatched_stop', 'duplicate_or_unmatched_stop']);
    assert.equal(requests.filter((request) => request.path === '/v3/skill/conversation/add').length, 1);
    const turnFiles = (await readdir(join(turnStore.sessionDirectory(sessionId), 'turns'))).filter((name) => name.endsWith('.json'));
    assert.equal(turnFiles.length, 1);
    const turn = JSON.parse(await readFile(turnStore.turnPath(sessionId, 'turn-duplicate'), 'utf8'));
    assert.equal(turn.lifecycle_status, 'completed');
  } finally {
    if (server) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(stateDir, { recursive: true, force: true });
  }
});
