import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { runCli } from '../src/cli.js';

const config = {
  gatewayUrl: 'http://127.0.0.1:1', serviceId: 'service', userId: 'user',
  teamId: 'team', agentId: 'kiro', stateDir: 'state', timeoutMs: 10,
  recallEnabled: true, captureEnabled: true, maxRecallResults: 5, maxContextChars: 6000,
};

const cliPath = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const invoke = (command, input, env) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [cliPath, command], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; }); child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.once('error', reject); child.once('close', (code) => resolve({ code, stdout, stderr })); child.stdin.end(input);
});
const gateway = async () => {
  const server = createServer(async (request, response) => {
    let source = ''; for await (const chunk of request) source += chunk;
    const path = request.url;
    const data = path === '/v3/atomic/search' ? { items: [{ content: 'child-memory' }] } : path === '/v3/core/read' ? { content: null } : { status: 'ok' };
    response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ code: 0, data }));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) };
};

test('CLI recall returns only recalled context and flushes once', async () => {
  let flushes = 0;
  const result = await runCli({
    argv: ['recall'],
    stdin: '{"hook_event_name":"UserPromptSubmit","session_id":"s","prompt":"p"}',
    loadConfig: () => config,
    createDependencies: () => ({
      outbox: { flush: async () => { flushes += 1; } },
      recallService: { recall: async () => '<TDAI_MEMORY_CONTEXT>safe</TDAI_MEMORY_CONTEXT>' },
      turnStore: { createTurn: async () => ({ turn_id: 'turn' }) },
    }),
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, '<TDAI_MEMORY_CONTEXT>safe</TDAI_MEMORY_CONTEXT>');
  assert.equal(flushes, 1);
});

test('CLI fails open for invalid JSON and mismatched command', async () => {
  for (const input of ['{', '{"hook_event_name":"Stop","session_id":"s"}']) {
    const result = await runCli({ argv: ['recall'], stdin: input, loadConfig: () => { throw new Error('secret-value'); } });
    assert.deepEqual(result, { exitCode: 0, stdout: '' });
  }
});

test('capture disabled recall does not create a Turn and ignores assistant response', async () => {
  let created = false;
  const result = await runCli({
    argv: ['recall'],
    stdin: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 's', prompt: 'p', assistant_response: 'do not capture' }),
    loadConfig: () => ({ ...config, captureEnabled: false }),
    createDependencies: () => ({
      outbox: { flush: async () => {} },
      recallService: { recall: async () => 'memory' },
      turnStore: { createTurn: async () => { created = true; } },
    }),
  });
  assert.equal(result.stdout, 'memory');
  assert.equal(created, false);
});

test('CLI rejects stdin over four MiB without leaking input', async () => {
  const secret = 'cli-secret-must-not-leak';
  const result = await runCli({ argv: ['recall'], stdin: `${secret}${'x'.repeat(4 * 1024 * 1024)}` });
  assert.deepEqual(result, { exitCode: 0, stdout: '' });
});

test('direct CLI child process recalls safely and keeps post/stop output empty', async () => {
  const state = await mkdtemp(join(tmpdir(), 'kiro-cli-child-'));
  const server = await gateway();
  try {
    const env = { ...process.env, TDAI_MEMORY_GATEWAY_URL: server.url, TDAI_MEMORY_SERVICE_ID: 'svc', TDAI_MEMORY_USER_ID: 'user', TDAI_MEMORY_STATE_DIR: state };
    const prompt = JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 'child', prompt: 'read' });
    const recalled = await invoke('recall', prompt, env);
    assert.equal(recalled.code, 0); assert.equal(recalled.stderr, ''); assert.equal(recalled.stdout.includes('child-memory'), true);
    for (const [command, input] of [['post-tool-use', JSON.stringify({ hook_event_name: 'PostToolUse', session_id: 'none', tool_name: 'read', tool_input: {}, tool_response: {} })], ['stop', JSON.stringify({ hook_event_name: 'Stop', session_id: 'none' })]]) {
      const result = await invoke(command, input, env);
      assert.deepEqual(result, { code: 0, stdout: '', stderr: '' });
    }
  } finally { await server.close(); await rm(state, { recursive: true, force: true }); }
});

test('direct CLI child process fails open without leaking malformed input or config values', async () => {
  const secret = 'child-process-secret';
  for (const [input, env] of [['{', { ...process.env, TDAI_MEMORY_GATEWAY_URL: secret }], [JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 's', prompt: secret }), { ...process.env }]]) {
    const result = await invoke('recall', input, env);
    assert.equal(result.code, 0); assert.equal(result.stdout.includes(secret), false); assert.equal(result.stderr.includes(secret), false);
  }
});
