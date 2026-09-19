import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createHash } from 'node:crypto';

import { buildHookDefinition, installProject } from '../scripts/install.mjs';
import { uninstallProject } from '../scripts/uninstall.mjs';

const envFor = (stateDir) => ({
  TDAI_MEMORY_GATEWAY_URL: 'https://memory.example.test',
  TDAI_MEMORY_SERVICE_ID: 'service', TDAI_MEMORY_USER_ID: 'user', TDAI_MEMORY_STATE_DIR: stateDir,
});

test('installer writes receipt v2 and merges an exact read-only MCP entry without changing other servers', async () => {
  const project = await mkdtemp(join(tmpdir(), 'kiro-mcp-install-'));
  try {
    const settings = join(project, '.kiro', 'settings');
    await mkdir(settings, { recursive: true });
    const existing = { custom: { keep: true }, mcpServers: { other: { command: 'other', args: ['x'] } } };
    await writeFile(join(settings, 'mcp.json'), `${JSON.stringify(existing, null, 2)}\n`);
    await installProject({ project, env: envFor(join(project, 'state')) });
    const mcp = JSON.parse(await readFile(join(settings, 'mcp.json'), 'utf8'));
    assert.deepEqual(mcp.custom, { keep: true });
    assert.deepEqual(mcp.mcpServers.other, existing.mcpServers.other);
    assert.equal(mcp.mcpServers['tdai-memory'].command, process.execPath);
    assert.equal(mcp.mcpServers['tdai-memory'].args.at(-2), '--workspace');
    assert.equal(mcp.mcpServers['tdai-memory'].args.at(-1), project);
    assert.deepEqual(mcp.mcpServers['tdai-memory'].env, { TDAI_MEMORY_API_KEY: '${TDAI_MEMORY_API_KEY}' });
    assert.equal(Object.hasOwn(mcp.mcpServers['tdai-memory'], 'autoApprove'), false);
    const receipt = JSON.parse(await readFile(join(project, '.kiro', 'tdai-memory-install.json'), 'utf8'));
    assert.equal(receipt.version, 2);
    assert.deepEqual(Object.keys(receipt).sort(), ['adapter_path', 'hook', 'mcp', 'version']);
    assert.equal(JSON.stringify(receipt).includes('memory.example'), false);
  } finally { await rm(project, { recursive: true, force: true }); }
});

test('uninstaller removes only the exact owned MCP entry and keeps unrelated JSON', async () => {
  const project = await mkdtemp(join(tmpdir(), 'kiro-mcp-uninstall-'));
  try {
    await installProject({ project, env: envFor(join(project, 'state')) });
    const path = join(project, '.kiro', 'settings', 'mcp.json');
    const mcp = JSON.parse(await readFile(path, 'utf8'));
    mcp.keep = 'value';
    mcp.mcpServers.other = { command: 'other' };
    await writeFile(path, `${JSON.stringify(mcp, null, 2)}\n`);
    await uninstallProject({ project });
    const remaining = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(remaining.keep, 'value');
    assert.deepEqual(remaining.mcpServers.other, { command: 'other' });
    assert.equal(Object.hasOwn(remaining.mcpServers, 'tdai-memory'), false);
  } finally { await rm(project, { recursive: true, force: true }); }
});

test('installer and uninstaller refuse a modified owned MCP entry without overwriting it', async () => {
  const project = await mkdtemp(join(tmpdir(), 'kiro-mcp-conflict-'));
  try {
    await installProject({ project, env: envFor(join(project, 'state')) });
    const path = join(project, '.kiro', 'settings', 'mcp.json');
    const mcp = JSON.parse(await readFile(path, 'utf8'));
    mcp.mcpServers['tdai-memory'].disabled = true;
    const changed = `${JSON.stringify(mcp, null, 2)}\n`;
    await writeFile(path, changed);
    await assert.rejects(installProject({ project, env: envFor(join(project, 'state')) }), /conflict/);
    await assert.rejects(uninstallProject({ project }), /changed/);
    assert.equal(await readFile(path, 'utf8'), changed);
  } finally { await rm(project, { recursive: true, force: true }); }
});

test('installer upgrades an exact Phase 1 receipt while retaining its recovery evidence until success', async () => {
  const project = await mkdtemp(join(tmpdir(), 'kiro-mcp-upgrade-'));
  try {
    const adapterPath = new URL('..', import.meta.url).pathname.replace(/^\/(.:)/, '$1').replaceAll('/', '\\');
    const hook = `${JSON.stringify(buildHookDefinition(adapterPath), null, 2)}\n`;
    await mkdir(join(project, '.kiro', 'hooks'), { recursive: true });
    await writeFile(join(project, '.kiro', 'hooks', 'tdai-memory.json'), hook);
    await writeFile(join(project, '.kiro', 'tdai-memory-install.json'), `${JSON.stringify({
      version: 1, hook_path: '.kiro/hooks/tdai-memory.json',
      hook_sha256: createHash('sha256').update(hook).digest('hex'), adapter_path: adapterPath,
    }, null, 2)}\n`);
    await installProject({ project, env: envFor(join(project, 'state')), adapterPath });
    assert.equal(JSON.parse(await readFile(join(project, '.kiro', 'tdai-memory-install.json'), 'utf8')).version, 2);
  } finally { await rm(project, { recursive: true, force: true }); }
});

test('installer resumes an interrupted MCP merge without dropping unrelated settings', async () => {
  const project = await mkdtemp(join(tmpdir(), 'kiro-mcp-resume-'));
  try {
    const settings = join(project, '.kiro', 'settings');
    const transaction = join(project, '.kiro', '.tdai-memory-mcp-install');
    await mkdir(settings, { recursive: true });
    await writeFile(join(settings, 'mcp.json'), `${JSON.stringify({ keep: true, mcpServers: { other: { command: 'other' } } }, null, 2)}\n`);
    await installProject({ project, env: envFor(join(project, 'state')) });
    const installed = JSON.parse(await readFile(join(settings, 'mcp.json'), 'utf8'));
    delete installed.mcpServers['tdai-memory'];
    await mkdir(transaction, { recursive: true });
    await writeFile(join(transaction, 'mcp.quarantine'), `${JSON.stringify(installed, null, 2)}\n`);
    await rm(join(settings, 'mcp.json'));

    await installProject({ project, env: envFor(join(project, 'state')) });

    const recovered = JSON.parse(await readFile(join(settings, 'mcp.json'), 'utf8'));
    assert.equal(recovered.keep, true);
    assert.deepEqual(recovered.mcpServers.other, { command: 'other' });
    assert.ok(recovered.mcpServers['tdai-memory']);
    await assert.rejects(access(transaction), { code: 'ENOENT' });
  } finally { await rm(project, { recursive: true, force: true }); }
});

test('installer accepts a strict project Config v2 without duplicating non-secret values in the environment', async () => {
  const project = await mkdtemp(join(tmpdir(), 'kiro-mcp-project-config-'));
  try {
    await mkdir(join(project, '.kiro'), { recursive: true });
    await mkdir(join(project, '.kiro', 'settings'), { recursive: true });
    await writeFile(join(project, '.kiro', 'settings', 'tdai-memory.json'), `${JSON.stringify({
      version: 2,
      gatewayUrl: 'https://memory.example.test',
      serviceId: 'service',
      userId: 'user',
      stateDir: join(project, 'state'),
    }, null, 2)}\n`);

    await installProject({ project, env: {} });

    assert.equal(JSON.parse(await readFile(join(project, '.kiro', 'tdai-memory-install.json'), 'utf8')).version, 2);
  } finally { await rm(project, { recursive: true, force: true }); }
});

test('a fresh install rolls back its hook and receipt when the MCP entry conflicts', async () => {
  const project = await mkdtemp(join(tmpdir(), 'kiro-mcp-atomic-conflict-'));
  try {
    const settings = join(project, '.kiro', 'settings');
    await mkdir(settings, { recursive: true });
    const foreign = `${JSON.stringify({ mcpServers: { 'tdai-memory': { command: 'foreign' } } }, null, 2)}\n`;
    await writeFile(join(settings, 'mcp.json'), foreign);
    await assert.rejects(installProject({ project, env: envFor(join(project, 'state')) }), /conflict/);
    await assert.rejects(access(join(project, '.kiro', 'hooks', 'tdai-memory.json')), { code: 'ENOENT' });
    await assert.rejects(access(join(project, '.kiro', 'tdai-memory-install.json')), { code: 'ENOENT' });
    assert.equal(await readFile(join(settings, 'mcp.json'), 'utf8'), foreign);
  } finally { await rm(project, { recursive: true, force: true }); }
});

test('post-commit cleanup failure preserves v2 commit and Phase 1 recovery evidence', async () => {
  const project = await mkdtemp(join(tmpdir(), 'kiro-mcp-cleanup-'));
  try {
    const adapterPath = new URL('..', import.meta.url).pathname.replace(/^\/(.:)/, '$1').replaceAll('/', '\\');
    const hook = `${JSON.stringify(buildHookDefinition(adapterPath), null, 2)}\n`;
    const hookHash = createHash('sha256').update(hook).digest('hex');
    await mkdir(join(project, '.kiro', 'hooks'), { recursive: true });
    await mkdir(join(project, '.kiro', 'settings'), { recursive: true });
    await writeFile(join(project, '.kiro', 'hooks', 'tdai-memory.json'), hook);
    await writeFile(join(project, '.kiro', 'tdai-memory-install.json'), `${JSON.stringify({ version: 1, hook_path: '.kiro/hooks/tdai-memory.json', hook_sha256: hookHash, adapter_path: adapterPath }, null, 2)}\n`);
    await writeFile(join(project, '.kiro', 'settings', 'mcp.json'), `${JSON.stringify({ mcpServers: { other: { command: 'other' } } }, null, 2)}\n`);
    await assert.rejects(installProject({
      project, adapterPath, env: envFor(join(project, 'state')),
      beforeMcpCleanup: async () => { throw new Error('cleanup-busy'); },
    }), /cleanup-busy/);
    assert.equal(JSON.parse(await readFile(join(project, '.kiro', 'tdai-memory-install.json'), 'utf8')).version, 2);
    assert.ok(JSON.parse(await readFile(join(project, '.kiro', 'settings', 'mcp.json'), 'utf8')).mcpServers['tdai-memory']);
    await access(join(project, '.kiro', '.tdai-memory-mcp-install', 'mcp.quarantine'));
    await access(join(project, '.kiro', '.tdai-memory-phase1-receipt', 'receipt.quarantine'));
    await installProject({ project, adapterPath, env: envFor(join(project, 'state')) });
    await assert.rejects(access(join(project, '.kiro', '.tdai-memory-mcp-install')), { code: 'ENOENT' });
    await assert.rejects(access(join(project, '.kiro', '.tdai-memory-phase1-receipt')), { code: 'ENOENT' });
  } finally { await rm(project, { recursive: true, force: true }); }
});
