import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const script = (name) => fileURLToPath(new URL(`../scripts/${name}.mjs`, import.meta.url));
const safeEnv = (stateDir) => ({
  ...process.env,
  TDAI_MEMORY_GATEWAY_URL: 'https://gateway.example.test', TDAI_MEMORY_SERVICE_ID: 'service-id',
  TDAI_MEMORY_USER_ID: 'user-id', TDAI_MEMORY_STATE_DIR: stateDir, TDAI_MEMORY_API_KEY: 'installer-secret',
});
const run = (name, project, env) => spawnSync(process.execPath, [script(name), '--project', project], { encoding: 'utf8', env });

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
    assert.equal(hook.hooks.PostToolUse[0].matcher, '*');
    assert.equal(hook.hooks.UserPromptSubmit[0].command.includes(process.execPath), true);
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
  assert.deepEqual(Object.keys(template.hooks), ['UserPromptSubmit', 'PostToolUse', 'Stop']);
  assert.equal(template.hooks.UserPromptSubmit[0].name.startsWith('tdai-memory-'), true);
  assert.equal(template.hooks.PostToolUse[0].matcher, '*');
  assert.equal(template.hooks.PostToolUse[0].timeout, 5);
  assert.equal(JSON.stringify(template).toLowerCase().includes('token'), false);
  assert.equal(JSON.stringify(template).toLowerCase().includes('api_key'), false);
});
