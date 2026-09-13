import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { Memory } from '../dist/memory.js';
import { install, quote } from '../dist/install.js';
import * as codex from '../dist/adapters/codex.js';
import * as zcode from '../dist/adapters/zcode.js';
import * as standard from '../dist/adapters/standard.js';

function setup(t, client = 'zcode') {
  const dir = mkdtempSync(join(tmpdir(), "memory ' test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const config = join(dir, 'memory.json');
  writeFileSync(config, JSON.stringify({ endpoint: 'http://127.0.0.1:8420', user_key: 'test-key', team_id: 'team', agent_id: 'agent' }));
  const memory = new Memory(config, client), calls = [];
  memory.post = async (path, body) => {
    calls.push({ path, body });
    return {
      '/v3/meta/auth/verify': { valid: true, user: { user_id: 'verified-user' } },
      '/v3/meta/agent/get': { team_id: 'team' }, '/v3/meta/acl/check': { allowed: true },
      '/v3/atomic/search': { items: [{ content: 'health /health/cedar' }] }, '/v3/conversation/add': {},
    }[path];
  };
  return { memory, calls, config, dir };
}
const event = (name, fields = {}) => ({ version: 1, event: name, session_id: 's', turn_id: 't', ...fields });

test('native adapters recall with verified identity, cross-session query, bounded untrusted output', async t => {
  const { memory, calls } = setup(t);
  for (const e of [
    zcode.normalize({ hookEventName: 'UserPromptSubmit', sessionId: 's', turnId: 't', prompt: 'mem:recall health' }),
    codex.normalize({ hook_event_name: 'UserPromptSubmit', session_id: 's', turn_id: 't', prompt: 'mem:recall health' }),
  ]) {
    assert.deepEqual(standard.normalize(e), e);
    const context = await memory.handle(e);
    assert.match(context, /untrusted data/);
    assert.match(zcode.encode(context, e).hookSpecificOutput.additionalContext, /health\/cedar/);
    assert.deepEqual(standard.encode(context, e), { context });
    assert.equal(calls.at(-1).body.user_id, 'verified-user');
    assert.equal(calls.at(-1).body.session_id, undefined);
  }
  assert.throws(() => standard.normalize({ version: 2 }));
});

test('default, opt-out, secrets, missing IDs and recursive Stop never upload', async t => {
  const { memory, calls } = setup(t);
  for (const [i, prompt] of ['ordinary', 'mem:remember /nomemory private', 'mem:remember sk-1234567890123456', 'mem:recall mem:off health'].entries()) {
    await memory.handle(event('UserPromptSubmit', { prompt, turn_id: String(i) }));
    await memory.handle(event('Stop', { reply: 'answer', turn_id: String(i) }));
  }
  await memory.handle(event('UserPromptSubmit', { prompt: 'mem:remember x', turn_id: undefined }));
  assert.equal(calls.length, 0);
  memory.cfg.capture = true;
  await memory.handle(event('UserPromptSubmit', { prompt: 'ordinary' }));
  await memory.handle(event('Stop', { reply: 'intermediate', stop_active: true }));
  assert.equal(calls.length, 0);
  await memory.handle(event('Stop', { reply: 'final' }));
  assert.equal(memory.status().sent, 1);
});

test('native final-pair capture excludes transcript/thinking and deduplicates Stop', async t => {
  const { memory, calls } = setup(t, 'codex');
  const base = { session_id: 's', turn_id: 't', transcript_path: '/never-read' };
  await memory.handle(codex.normalize({ ...base, hook_event_name: 'UserPromptSubmit', prompt: 'mem:remember cedar' }));
  const stop = codex.normalize({ ...base, hook_event_name: 'Stop', last_assistant_message: 'final', thinking: 'hidden' });
  await memory.handle(stop);
  await memory.handle(stop);
  const writes = calls.filter(c => c.path.endsWith('/conversation/add'));
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].body.messages, [{ role: 'user', content: 'mem:remember cedar' }, { role: 'assistant', content: 'final' }]);
  assert.equal(writes[0].body.session_id, 'agent-memory:codex:s');
  const db = memory.db();
  try { assert.deepEqual({ ...db.prepare('SELECT prompt,reply,status FROM turns').get() }, { prompt: null, reply: null, status: 'sent' }); }
  finally { db.close(); }
});

test('network failure retains complete pair and restart retries once; Unicode chunks remain lossless', async t => {
  const { memory, calls, config } = setup(t);
  const reply = '😀'.repeat(9000);
  await memory.handle(event('UserPromptSubmit', { prompt: 'mem:remember cedar' }));
  const post = memory.post;
  memory.post = async () => { throw new Error('offline'); };
  await assert.rejects(memory.handle(event('Stop', { reply })));
  assert.equal(memory.status().pending, 1);
  const restarted = new Memory(config, 'zcode');
  restarted.post = post;
  assert.equal(await restarted.retry(), true);
  assert.equal(await restarted.retry(), false);
  const messages = calls.at(-1).body.messages;
  assert.equal(messages.filter(x => x.role === 'assistant').map(x => x.content).join(''), reply);
  assert.ok(messages.every(x => x.content.length <= 8192));
});

test('invalid identity, mismatched team and denied ACL never reach data plane', async t => {
  const { memory } = setup(t);
  for (const denial of ['auth', 'team', 'acl']) {
    memory.post = async path => {
      if (path.endsWith('/auth/verify')) return { valid: denial !== 'auth', user: { user_id: 'u' } };
      if (path.endsWith('/agent/get')) return { team_id: denial === 'team' ? 'other' : 'team' };
      if (path.endsWith('/acl/check')) return { allowed: false };
      assert.fail('unauthorized data access');
    };
    await assert.rejects(memory.recall('health'));
  }
});

test('install migrates old hooks, preserves providers, quotes paths and removes only owned entries', t => {
  const { config, dir } = setup(t);
  const script = fileURLToPath(new URL('../dist/hook.js', import.meta.url));
  const legacy = fileURLToPath(new URL('../hook.py', import.meta.url));
  for (const client of ['codex', 'zcode']) {
    const other = { type: 'command', command: 'echo existing' };
    const old = client === 'codex' ? { type: 'command', command: `python3 ${quote(legacy)} --adapter codex --config ${quote(config)}` }
      : { type: 'process', command: 'python3', args: [legacy, '--adapter', 'zcode', '--config', config] };
    const events = { Stop: [{ hooks: [other, old] }], UserPromptSubmit: [{ hooks: [old] }] };
    const original = { provider: { subscription: { apiKey: 'untouched' } }, hooks: client === 'codex' ? events : { events } };
    const settings = join(dir, `${client}.json`);
    writeFileSync(settings, JSON.stringify(original));
    assert.equal(install(settings, config, client), true);
    assert.equal(install(settings, config, client), false);
    const data = JSON.parse(readFileSync(settings, 'utf8'));
    assert.deepEqual(data.provider, original.provider);
    const result = client === 'codex' ? data.hooks : data.hooks.events;
    assert.equal(result.Stop.length, 2);
    if (client === 'codex') {
      const command = result.UserPromptSubmit[0].hooks[0].command;
      assert.ok(command.includes(quote(config)));
      // Execute generated shell command with quote-bearing path; no trust settings are edited.
      const run = spawnSync('/bin/sh', ['-c', command], { input: '{}', encoding: 'utf8' });
      assert.equal(run.status, 0); assert.deepEqual(JSON.parse(run.stdout), {});
      assert.ok(command.includes(script));
    }
    assert.equal(install(settings, config, client, true), true);
    const removed = JSON.parse(readFileSync(settings, 'utf8'));
    assert.deepEqual((client === 'codex' ? removed.hooks : removed.hooks.events).Stop, [{ hooks: [other] }]);
    assert.equal(install(settings, config, client, true), false);
    assert.equal(statSync(settings).mode & 0o777, 0o600);
  }
  assert.equal(readdirSync(dir).filter(x => x.endsWith('.bak')).length, 4);
});

test('disabled hooks are preserved; CLI errors fail open without disclosing input', t => {
  const { config, dir } = setup(t);
  const settings = join(dir, 'disabled.json');
  writeFileSync(settings, '{"hooks":{"enabled":false}}');
  assert.throws(() => install(settings, config, 'zcode'));
  assert.equal(readFileSync(settings, 'utf8'), '{"hooks":{"enabled":false}}');
  const run = spawnSync(process.execPath, [fileURLToPath(new URL('../dist/hook.js', import.meta.url)), '--config', '/missing'], { input: 'private-test-input', encoding: 'utf8' });
  assert.equal(run.status, 0); assert.deepEqual(JSON.parse(run.stdout), {});
  assert.ok(!run.stderr.includes('private-test-input'));
});

test('HTTP uses independent headers, rejects redirects and oversized responses', async t => {
  const { config } = setup(t);
  let received;
  const server = createServer((req, res) => {
    received = req.headers;
    if (req.url === '/redirect') { res.writeHead(302, { Location: '/secret' }); res.end(); }
    else if (req.url === '/large') res.end('x'.repeat(1024 * 1024 + 1));
    else { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ code: 0, data: { ok: true } })); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const cfg = JSON.parse(readFileSync(config, 'utf8'));
  cfg.endpoint = `http://127.0.0.1:${server.address().port}`; cfg.gateway_key = 'gateway-test';
  writeFileSync(config, JSON.stringify(cfg));
  const memory = new Memory(config);
  assert.deepEqual(await memory.post('/ok', {}), { ok: true });
  assert.equal(received['x-tdai-user-key'], 'test-key');
  assert.equal(received.authorization, 'Bearer gateway-test');
  await assert.rejects(memory.post('/redirect', {}));
  await assert.rejects(memory.post('/large', {}));
  cfg.endpoint = 'http://example.com'; writeFileSync(config, JSON.stringify(cfg));
  assert.throws(() => new Memory(config));
});

test('Python-era scope and pending rows survive migration without recapturing sent turns', async t => {
  const { memory, calls } = setup(t);
  assert.equal(memory.scope, '87c149c31a3a89685a6c5465328da1728ab87395fccc724b7aedc74d92be0d7c');
  const db = memory.db();
  db.prepare('INSERT INTO turns VALUES (?,?,?,?,?,?)').run(memory.scope, 'legacy', 'pending', 'remember', 'answer', 'pending');
  db.prepare('INSERT INTO turns VALUES (?,?,?,?,?,?)').run(memory.scope, 'legacy', 'sent', null, null, 'sent');
  db.close();
  assert.equal(await memory.retry(), true);
  await memory.handle(event('Stop', { session_id: 'legacy', turn_id: 'sent', reply: 'answer' }));
  assert.equal(calls.filter(x => x.path.endsWith('/conversation/add')).length, 1);
  assert.deepEqual(memory.status(), { sent: 2 });
});

test('oversized writes retain the entire reply and sensitive replies discard the waiting prompt', async t => {
  const { memory, calls } = setup(t);
  await memory.handle(event('UserPromptSubmit', { prompt: 'mem:remember large' }));
  const reply = 'x'.repeat(4096 * 100);
  await assert.rejects(memory.handle(event('Stop', { reply })));
  assert.equal(calls.filter(x => x.path.endsWith('/conversation/add')).length, 0);
  const db = memory.db();
  assert.equal(db.prepare('SELECT reply FROM turns').get().reply, reply);
  db.close();
  await memory.handle(event('UserPromptSubmit', { prompt: 'mem:remember private', turn_id: 'private' }));
  await memory.handle(event('Stop', { reply: 'Bearer secret1234567890', turn_id: 'private' }));
  assert.deepEqual(memory.status(), { pending: 1, skipped: 1 });
});
