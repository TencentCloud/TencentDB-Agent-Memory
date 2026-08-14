import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { buildHookCommand, installProject, quotePosixShell, quoteWindowsCommandLine } from '../scripts/install.mjs';

const script = (name) => fileURLToPath(new URL(`../scripts/${name}.mjs`, import.meta.url));
const safeEnv = (stateDir) => ({
  ...process.env,
  TDAI_MEMORY_GATEWAY_URL: 'https://gateway.example.test', TDAI_MEMORY_SERVICE_ID: 'service-id',
  TDAI_MEMORY_USER_ID: 'user-id', TDAI_MEMORY_STATE_DIR: stateDir, TDAI_MEMORY_API_KEY: 'installer-secret',
});
const run = (name, project, env) => spawnSync(process.execPath, [script(name), '--project', project], { encoding: 'utf8', env });
const runCommand = (command, input, env) => new Promise((resolve, reject) => {
  const child = spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `"${command}"`], { encoding: 'utf8', env, stdio: ['pipe', 'pipe', 'pipe'], windowsVerbatimArguments: true });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; }); child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.once('error', reject); child.once('close', (code) => resolve({ code, stdout, stderr })); child.stdin.end(input);
});

test('installer is idempotent, writes a secret-free receipt, and doctor verifies it', async () => {
  const project = await mkdtemp(join(tmpdir(), 'kiro installer space '));
  try {
    const env = safeEnv(join(project, 'state'));
    const first = run('install', project, env);
    assert.equal(first.status, 0);
    assert.equal(first.stdout.includes('installer-secret'), false);
    const hookPath = join(project, '.kiro', 'hooks', 'tdai-memory.json');
    const hook = JSON.parse(await readFile(hookPath, 'utf8'));
    assert.equal(hook.version, 'v1');
    assert.equal(Array.isArray(hook.hooks), true);
    assert.deepEqual(hook.hooks.map((item) => item.trigger), ['UserPromptSubmit', 'PostToolUse', 'Stop']);
    assert.equal(hook.hooks[1].matcher, '*');
    assert.equal(hook.hooks[0].action.command.includes(process.execPath), true);
    const receipt = await readFile(join(project, '.kiro', 'tdai-memory-install.json'), 'utf8');
    assert.equal(receipt.includes('installer-secret'), false);
    assert.equal(run('install', project, env).status, 0);
    const doctor = run('doctor', project, env);
    assert.equal(doctor.status, 0);
    assert.equal(doctor.stdout.includes('installer-secret'), false);
  } finally { await rm(project, { recursive: true, force: true }); }
});

test('installer preserves a conflicting hook and uninstaller only removes matching adapter files', async () => {
  const project = await mkdtemp(join(tmpdir(), 'kiro-installer-'));
  try {
    const env = safeEnv(join(project, 'state'));
    assert.equal(run('install', project, env).status, 0);
    const hookPath = join(project, '.kiro', 'hooks', 'tdai-memory.json');
    await writeFile(hookPath, '{"user":"changed"}\n');
    const reinstall = run('install', project, env);
    assert.notEqual(reinstall.status, 0);
    assert.equal(await readFile(hookPath, 'utf8'), '{"user":"changed"}\n');
    const uninstall = run('uninstall', project, env);
    assert.notEqual(uninstall.status, 0);
    assert.equal(await readFile(hookPath, 'utf8'), '{"user":"changed"}\n');
    assert.equal(run('doctor', project, env).status, 1);
  } finally { await rm(project, { recursive: true, force: true }); }
});

test('uninstaller is repeatable and does not delete other hooks', async () => {
  const project = await mkdtemp(join(tmpdir(), 'kiro-uninstall-'));
  try {
    const env = safeEnv(join(project, 'state'));
    assert.equal(run('install', project, env).status, 0);
    const other = join(project, '.kiro', 'hooks', 'other.json');
    await writeFile(other, '{"user":true}\n');
    assert.equal(run('uninstall', project, env).status, 0);
    assert.equal(await readFile(other, 'utf8'), '{"user":true}\n');
    assert.equal(run('uninstall', project, env).status, 0);
  } finally { await rm(project, { recursive: true, force: true }); }
});

test('manual template is exact v1 hook JSON and contains no credential fields', async () => {
  const template = JSON.parse(await readFile(new URL('../templates/hooks.json.example', import.meta.url), 'utf8'));
  assert.equal(template.version, 'v1');
  assert.equal(Array.isArray(template.hooks), true);
  assert.deepEqual(template.hooks.map((item) => item.trigger), ['UserPromptSubmit', 'PostToolUse', 'Stop']);
  assert.equal(template.hooks[0].name.startsWith('tdai-memory-'), true);
  assert.equal(template.hooks[1].matcher, '*');
  assert.equal(Object.hasOwn(template.hooks[0], 'matcher'), false);
  assert.equal(Object.hasOwn(template.hooks[2], 'matcher'), false);
  assert.equal(template.hooks[1].timeout, 5);
  assert.equal(template.hooks.every((item) => Object.keys(item).every((key) => ['name', 'trigger', 'action', 'timeout', 'enabled', 'matcher'].includes(key)) && item.action.type === 'command'), true);
  assert.equal(JSON.stringify(template).toLowerCase().includes('token'), false);
  assert.equal(JSON.stringify(template).toLowerCase().includes('api_key'), false);
});

test('shell quoting preserves hostile adapter paths without command injection', async () => {
  assert.equal(quotePosixShell("$() `x` ' &"), "'$() `x` '\"'\"' &'");
  assert.equal(quoteWindowsCommandLine('C:\\node\\trailing\\').startsWith('"'), true);
  assert.throws(() => buildHookCommand('C:\\adapter', 'recall', { executable: 'C:\\%bad%\\node.exe', platform: 'win32' }), /command/);
  const root = await mkdtemp(join(tmpdir(), 'kiro command root '));
  const adapterPath = join(root, 'adapter %PATH% & ^ literal');
  const project = join(root, 'workspace');
  const sourceAdapter = fileURLToPath(new URL('..', import.meta.url));
  try {
    await cp(sourceAdapter, adapterPath, { recursive: true });
    await writeFile(join(adapterPath, 'src', 'cli.js'), "export async function runCli(){let input='';for await(const chunk of process.stdin)input+=chunk;await new Promise((resolve)=>setTimeout(resolve,10));return {exitCode:0,stdout:`seen:${input}`};}\n");
    const env = safeEnv(join(root, 'state'));
    const installed = spawnSync(process.execPath, [join(adapterPath, 'scripts', 'install.mjs'), '--project', project], { encoding: 'utf8', env });
    assert.equal(installed.status, 0);
    const command = JSON.parse(await readFile(join(project, '.kiro', 'hooks', 'tdai-memory.json'), 'utf8')).hooks[0].action.command;
    assert.equal(command.includes(adapterPath), false);
    const input = JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 'quoted', prompt: 'recall' });
    const result = await runCommand(command, input, env);
    assert.equal(result.code, 0, JSON.stringify(result)); assert.equal(result.stderr, ''); assert.equal(result.stdout, `seen:${input}`);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('installer rejects a hook claimed by a concurrent conflicting writer without creating a receipt', async () => {
  const project = await mkdtemp(join(tmpdir(), 'kiro-install-race-'));
  try {
    const env = safeEnv(join(project, 'state'));
    const hookPath = join(project, '.kiro', 'hooks', 'tdai-memory.json');
    const userHook = '{"owned":"by-user"}\n';
    await assert.rejects(installProject({ project, env, beforePublish: async () => { await writeFile(hookPath, userHook); } }), /conflict/);
    assert.equal(await readFile(hookPath, 'utf8'), userHook);
    await assert.rejects(readFile(join(project, '.kiro', 'tdai-memory-install.json'), 'utf8'), { code: 'ENOENT' });
  } finally { await rm(project, { recursive: true, force: true }); }
});

test('concurrent identical installs both succeed and leave a complete v1 hook', async () => {
  const project = await mkdtemp(join(tmpdir(), 'kiro-install-identical-'));
  try {
    const env = safeEnv(join(project, 'state'));
    await Promise.all([installProject({ project, env }), installProject({ project, env })]);
    const hook = JSON.parse(await readFile(join(project, '.kiro', 'hooks', 'tdai-memory.json'), 'utf8'));
    assert.equal(hook.version, 'v1'); assert.deepEqual(hook.hooks.map((item) => item.trigger), ['UserPromptSubmit', 'PostToolUse', 'Stop']);
  } finally { await rm(project, { recursive: true, force: true }); }
});

test('installer refuses an existing different receipt without overwriting it', async () => {
  const project = await mkdtemp(join(tmpdir(), 'kiro-receipt-conflict-'));
  try {
    const env = safeEnv(join(project, 'state'));
    await installProject({ project, env });
    const receiptPath = join(project, '.kiro', 'tdai-memory-install.json');
    const userReceipt = '{"owned":"by-user"}\n';
    await writeFile(receiptPath, userReceipt);
    await assert.rejects(installProject({ project, env }), /conflict/);
    assert.equal(await readFile(receiptPath, 'utf8'), userReceipt);
  } finally { await rm(project, { recursive: true, force: true }); }
});

test('barriered concurrent installs publish one identical receipt without rename races', async () => {
  for (let index = 0; index < 50; index += 1) {
    const project = await mkdtemp(join(tmpdir(), 'kiro-receipt-race-'));
    try {
      const env = safeEnv(join(project, 'state'));
      let arrived = 0; let release;
      const barrier = new Promise((resolve) => { release = resolve; });
      const afterHookPublished = async () => { arrived += 1; if (arrived === 2) release(); await barrier; };
      await Promise.all([installProject({ project, env, afterHookPublished }), installProject({ project, env, afterHookPublished })]);
      const receipt = JSON.parse(await readFile(join(project, '.kiro', 'tdai-memory-install.json'), 'utf8'));
      assert.equal(receipt.version, 1);
    } finally { await rm(project, { recursive: true, force: true }); }
  }
});

test('installer and doctor use safe failure output for missing configuration', async () => {
  const project = await mkdtemp(join(tmpdir(), 'kiro-missing-config-'));
  try {
    const env = { ...process.env };
    delete env.TDAI_MEMORY_GATEWAY_URL; delete env.TDAI_MEMORY_SERVICE_ID; delete env.TDAI_MEMORY_USER_ID;
    const installer = run('install', project, env);
    assert.notEqual(installer.status, 0); assert.equal(installer.stdout, ''); assert.equal(installer.stderr.includes('TDAI_MEMORY_'), false);
    const doctor = run('doctor', project, env);
    assert.notEqual(doctor.status, 0); assert.equal(doctor.stdout.includes('config: fail'), true); assert.equal(doctor.stderr, '');
  } finally { await rm(project, { recursive: true, force: true }); }
});

test('doctor rejects a hash-consistent hook with an invalid v1 action schema', async () => {
  const project = await mkdtemp(join(tmpdir(), 'kiro-doctor-schema-'));
  try {
    const env = safeEnv(join(project, 'state'));
    assert.equal(run('install', project, env).status, 0);
    const hookPath = join(project, '.kiro', 'hooks', 'tdai-memory.json');
    const receiptPath = join(project, '.kiro', 'tdai-memory-install.json');
    const hook = JSON.parse(await readFile(hookPath, 'utf8'));
    hook.hooks[0].action.type = 'unsafe';
    const source = `${JSON.stringify(hook, null, 2)}\n`;
    const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
    receipt.hook_sha256 = createHash('sha256').update(source).digest('hex');
    await writeFile(hookPath, source); await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
    assert.equal(run('doctor', project, env).status, 1);
  } finally { await rm(project, { recursive: true, force: true }); }
});

test('package exposes hook lifecycle commands', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.scripts['install:hooks'], 'node scripts/install.mjs');
  assert.equal(pkg.scripts['uninstall:hooks'], 'node scripts/uninstall.mjs');
  assert.equal(pkg.scripts.doctor, 'node scripts/doctor.mjs');
});
