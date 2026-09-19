import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { formatMcpResult } from '../src/mcp/formatter.js';

const listen = async (handler) => {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}` };
};

const gateway = async () => listen(async (request, response) => {
  if (request.url === '/health') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ status: 'ok', version: '0.2.0', storage: { enabled: true, requested: 'cos', effective: 'cos', degraded: false } }));
    return;
  }
  let body = '';
  for await (const chunk of request) body += chunk;
  const parsed = body ? JSON.parse(body) : {};
  let data;
  if (request.url === '/v3/atomic/search') data = { items: [{ id: 'a', content: 'atomic memory', type: 'fact', created_at: '2026-08-16T00:00:00.000Z', updated_at: '2026-08-16T00:00:01.000Z', score: 1 }] };
  else if (request.url === '/v3/core/read') data = { content: 'core' };
  else if (request.url === '/v3/skill/search') data = { items: [{ skill_id: 's', name: 'Skill', description: 'skill', snippet: 'skill', version: 1, status: 'active', score: 1 }] };
  else if (request.url === '/v3/conversation/search') data = { messages: [{ id: 'c', role: 'user', content: 'conversation', score: 1 }] };
  else data = {};
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ code: 0, data }));
});

test('official SDK initializes the stdio server and exposes exactly three read-only tools', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kiro-mcp-'));
  const remote = await gateway();
  const stderr = [];
  let client;
  try {
    await mkdir(join(root, '.kiro', 'settings'), { recursive: true });
    const env = Object.fromEntries(Object.entries({
      ...process.env,
      TDAI_MEMORY_GATEWAY_URL: remote.url,
      TDAI_MEMORY_SERVICE_ID: 'service',
      TDAI_MEMORY_USER_ID: 'user',
      TDAI_MEMORY_STATE_DIR: join(root, 'state'),
      TDAI_MEMORY_MCP_MAX_OUTPUT_CHARS: '1200',
    }).filter(([, value]) => typeof value === 'string'));
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [new URL('../src/mcp/server.js', import.meta.url).pathname.replace(/^\/(.:)/, '$1'), '--workspace', root],
      env,
      stderr: 'pipe',
    });
    transport.stderr?.on('data', (chunk) => stderr.push(String(chunk)));
    client = new Client({ name: 'kiro-mcp-test', version: '1.0.0' });
    await client.connect(transport);
    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), [
      'tdai_conversation_search', 'tdai_memory_search', 'tdai_memory_status',
    ]);
    assert.equal(listed.tools.every((tool) => tool.annotations?.readOnlyHint === true), true);

    const search = await client.callTool({ name: 'tdai_memory_search', arguments: { query: 'private query', limit: 3 } });
    assert.equal(search.isError, undefined);
    assert.equal(search.content[0].type, 'text');
    assert.match(search.content[0].text, /^<TDAI_MEMORY_RESULTS untrusted="true">/);
    assert.equal(search.content[0].text.length <= 1200, true);
    assert.equal(search.structuredContent.query_fingerprint.startsWith('sha256:'), true);
    assert.equal(JSON.stringify(search.structuredContent).includes('private query'), false);

    const conversation = await client.callTool({ name: 'tdai_conversation_search', arguments: { query: 'history' } });
    assert.equal(conversation.structuredContent.items[0].source, 'conversation');
    const status = await client.callTool({ name: 'tdai_memory_status', arguments: {} });
    assert.equal(status.structuredContent.status, 'degraded');
    const invalid = await client.callTool({ name: 'tdai_memory_status', arguments: { unexpected: true } });
    assert.equal(invalid.isError, true);
    const blankQuery = await client.callTool({ name: 'tdai_memory_search', arguments: { query: ' \n ' } });
    assert.equal(blankQuery.isError, true);
    assert.notEqual(blankQuery.content[0].text, 'Memory search is unavailable.');
    const unicodeQuery = await client.callTool({ name: 'tdai_memory_search', arguments: { query: '😀'.repeat(2000), limit: 1 } });
    assert.equal(unicodeQuery.isError, undefined);
    assert.equal(stderr.join('').includes('private query'), false);
  } finally {
    await client?.close();
    await new Promise((resolve) => remote.server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test('MCP formatter progressively retains ranked content within the framed total budget', () => {
  const structured = {
    query_fingerprint: `sha256:${'a'.repeat(64)}`,
    items: [
      { source: 'atomic', stable_id: 'a', rank: 1, fused_score: 1, content: 'x'.repeat(900), metadata: {} },
      { source: 'skill', stable_id: 'b', rank: 1, fused_score: 0.5, content: 'y'.repeat(900), metadata: {} },
    ],
    core_content: 'core', degraded_sources: [], truncated: false,
  };
  const result = formatMcpResult(structured, 700);
  assert.equal([...result.content[0].text].length <= 700, true);
  assert.equal(result.structuredContent.items.length, 1);
  assert.match(result.structuredContent.items[0].content, /<TRUNCATED original_chars=900>$/);
  assert.equal(result.structuredContent.truncated, true);
});

test('MCP search reports a fixed safe error when all requested sources fail', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kiro-mcp-fail-'));
  const remote = await listen((_request, response) => { response.writeHead(503); response.end('secret upstream body'); });
  let client;
  try {
    const env = Object.fromEntries(Object.entries({ ...process.env, TDAI_MEMORY_GATEWAY_URL: remote.url, TDAI_MEMORY_SERVICE_ID: 's', TDAI_MEMORY_USER_ID: 'u', TDAI_MEMORY_STATE_DIR: join(root, 'state') }).filter(([, value]) => typeof value === 'string'));
    const transport = new StdioClientTransport({ command: process.execPath, args: [new URL('../src/mcp/server.js', import.meta.url).pathname.replace(/^\/(.:)/, '$1'), '--workspace', root], env, stderr: 'pipe' });
    client = new Client({ name: 'test', version: '1' });
    await client.connect(transport);
    const result = await client.callTool({ name: 'tdai_memory_search', arguments: { query: 'q' } });
    assert.equal(result.isError, true);
    assert.equal(result.content[0].text, 'Memory search is unavailable.');
  } finally {
    await client?.close();
    await new Promise((resolve) => remote.server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
