import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { metadata, sessionHeaders, launch } from './session-init.mjs';

test('session identity replaces stale headers without retaining a no-task sentinel', () => {
  const headers = sessionHeaders('X-Task-Id: old\nx-team-id: old\nx-session-id: pinned\nx-trace-id: keep', 'team', 'agent');
  assert.equal(headers, 'x-trace-id: keep\nx-team-id: team\nx-agent-id: agent');
  assert.match(sessionHeaders(headers, 'team', 'agent', 'real'), /x-task-id: real$/);
  assert.throws(() => sessionHeaders('', 'team\ninjected: yes', 'agent'));
});

test('metadata paginates filtered empty pages and rejects auth errors', async () => {
  const seen = [];
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); seen.push({ path: req.url, body, key: req.headers['x-tdai-user-key'] });
    if (req.url.endsWith('/auth/verify')) res.writeHead(401).end('{}');
    else res.end(JSON.stringify({ code: 0, data: { total: 101, items: body.offset === 0 ? [] : [{ team_id: 'team' }] } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const api = metadata(`http://127.0.0.1:${server.address().port}`, 'default', 'test-key');
    assert.deepEqual(await api.list('team/list', { user_id: 'user' }), [{ team_id: 'team' }]);
    assert.deepEqual(seen.map((r) => r.body.offset), [0, 100]);
    assert.ok(seen.every((r) => r.key === 'test-key' && r.body.user_id === 'user'));
    await assert.rejects(api.verify(), /HTTP 401/);
  } finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
});

test('launch uses private temporary settings, preserves exit status and cleans on failure', async () => {
  // Node acts as a test child and inspects the file supplied in argv, like Claude.
  const code = `const fs=require('fs');const p=process.argv[1];const s=JSON.parse(fs.readFileSync(p));if(s.env.TEST_SESSION!=='yes'||(fs.statSync(p).mode&0o777)!==0o600)process.exit(2);process.exit(7)`;
  // Adapter executable receives --settings first; a small wrapper is supplied via shell.
  const { mkdtempSync, writeFileSync, rmSync, readdirSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'tdai-test-'));
  const wrapper = join(dir, 'child');
  const pathRecord = join(dir, 'path');
  writeFileSync(wrapper, `#!/bin/sh\nprintf '%s' "$2" > '${pathRecord}'\nexec '${process.execPath}' -e '${code.replaceAll("'", "'\\''")}' "$2"\n`, { mode: 0o700 });
  try {
    assert.equal(await launch(wrapper, [], { TEST_SESSION: 'yes' }), 7);
    assert.equal(existsSync(readFileSync(pathRecord, 'utf8')), false);
    const before = readdirSync(tmpdir()).filter((p) => p.startsWith('tdai-session-')).sort();
    await assert.rejects(launch(join(dir, 'missing'), [], {}), /无法启动/);
    assert.deepEqual(readdirSync(tmpdir()).filter((p) => p.startsWith('tdai-session-')).sort(), before);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
