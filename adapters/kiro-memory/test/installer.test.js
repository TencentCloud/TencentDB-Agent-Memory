import assert from 'node:assert/strict';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, unlink as fsUnlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { buildHookCommand, installProject, quotePosixShell, quoteWindowsCommandLine } from '../scripts/install.mjs';
import { uninstallProject } from '../scripts/uninstall.mjs';

const script = (name) => fileURLToPath(new URL(`../scripts/${name}.mjs`, import.meta.url));
const safeEnv = (stateDir) => ({
  ...process.env,
  TDAI_MEMORY_GATEWAY_URL: 'https://gateway.example.test', TDAI_MEMORY_SERVICE_ID: 'service-id',
  TDAI_MEMORY_USER_ID: 'user-id', TDAI_MEMORY_STATE_DIR: stateDir, TDAI_MEMORY_API_KEY: 'installer-secret',
});
const run = (name, project, env) => spawnSync(process.execPath, [script(name), '--project', project], { encoding: 'utf8', env });
const runAsync = (name, project, env) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [script(name), '--project', project], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; }); child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.once('error', reject); child.once('close', (status) => resolve({ status, stdout, stderr }));
});
const waitForBarrier = async (promise) => {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('barrier-timeout')), 1000); })]); } finally { clearTimeout(timer); }
};
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

test('uninstaller rejects a foreign adapter receipt and preserves both files byte-for-byte', async () => {
  const project = await mkdtemp(join(tmpdir(), 'kiro-uninstall-foreign-'));
  try {
    const env = safeEnv(join(project, 'state'));
    assert.equal(run('install', project, env).status, 0);
    const hookPath = join(project, '.kiro', 'hooks', 'tdai-memory.json');
    const receiptPath = join(project, '.kiro', 'tdai-memory-install.json');
    const hookSource = await readFile(hookPath, 'utf8');
    const receipt = JSON.parse(await readFile(receiptPath, 'utf8')); receipt.adapter_path = 'C:\\foreign-adapter';
    const receiptSource = `${JSON.stringify(receipt, null, 2)}\n`; await writeFile(receiptPath, receiptSource);
    assert.notEqual(run('uninstall', project, env).status, 0);
    assert.equal(await readFile(hookPath, 'utf8'), hookSource); assert.equal(await readFile(receiptPath, 'utf8'), receiptSource);
  } finally { await rm(project, { recursive: true, force: true }); }
});

test('uninstaller quarantines the owned hook before allowing a new user hook at the original path', async () => {
  const project = await mkdtemp(join(tmpdir(), 'kiro-uninstall-replace-'));
  try {
    const env = safeEnv(join(project, 'state')); await installProject({ project, env });
    const hookPath = join(project, '.kiro', 'hooks', 'tdai-memory.json'); const userHook = '{"new":"user-hook"}\n';
    await uninstallProject({ project, afterHookQuarantined: async () => { await writeFile(hookPath, userHook); } });
    assert.equal(await readFile(hookPath, 'utf8'), userHook);
    await assert.rejects(readFile(join(project, '.kiro', 'tdai-memory-install.json'), 'utf8'), { code: 'ENOENT' });
  } finally { await rm(project, { recursive: true, force: true }); }
});

test('uninstaller restores a quarantined modified hook when hash validation fails', async () => {
  const project = await mkdtemp(join(tmpdir(), 'kiro-uninstall-restore-'));
  try {
    const env = safeEnv(join(project, 'state')); await installProject({ project, env });
    const hookPath = join(project, '.kiro', 'hooks', 'tdai-memory.json'); const changed = '{"changed":true}\n'; await writeFile(hookPath, changed);
    await assert.rejects(uninstallProject({ project }), /changed/);
    assert.equal(await readFile(hookPath, 'utf8'), changed);
    assert.equal((await readdir(join(project, '.kiro', 'hooks'))).some((name) => name.endsWith('.quarantine')), false);
  } finally { await rm(project, { recursive: true, force: true }); }
});

test('uninstaller keeps both a replacement hook and quarantine backup when restore is occupied', async () => {
  const project = await mkdtemp(join(tmpdir(), 'kiro-uninstall-occupied-'));
  try {
    const env = safeEnv(join(project, 'state')); await installProject({ project, env });
    const hookDirectory = join(project, '.kiro', 'hooks'); const hookPath = join(hookDirectory, 'tdai-memory.json');
    const quarantinedContent = '{"changed":"old"}\n'; const replacement = '{"new":"user"}\n'; await writeFile(hookPath, quarantinedContent);
    await assert.rejects(uninstallProject({ project, afterHookQuarantined: async () => { await writeFile(hookPath, replacement); } }), /changed/);
    assert.equal(await readFile(hookPath, 'utf8'), replacement);
    const backup = join(project, '.kiro', '.tdai-memory-uninstall', 'hook.quarantine');
    assert.equal(await readFile(backup, 'utf8'), quarantinedContent);
  } finally { await rm(project, { recursive: true, force: true }); }
});

test('uninstaller resumes after hook quarantine deletion fails', async () => {
  const project = await mkdtemp(join(tmpdir(), 'kiro-uninstall-hook-delete-'));
  try {
    const env = safeEnv(join(project, 'state')); await installProject({ project, env });
    let failed = false;
    const unlinkQuarantine = async (path) => { if (!failed && path.endsWith('hook.quarantine')) { failed = true; throw new Error('hook-unlink'); } await fsUnlink(path); };
    await assert.rejects(uninstallProject({ project, unlinkQuarantine }), /hook-unlink/);
    const tx = join(project, '.kiro', '.tdai-memory-uninstall');
    assert.equal(JSON.parse(await readFile(join(tx, 'receipt.quarantine'), 'utf8')).version, 1);
    await readFile(join(tx, 'hook.quarantine'), 'utf8');
    await uninstallProject({ project });
    await assert.rejects(readFile(join(tx, 'receipt.quarantine'), 'utf8'), { code: 'ENOENT' });
  } finally { await rm(project, { recursive: true, force: true }); }
});

test('uninstaller resumes after receipt quarantine deletion fails', async () => {
  const project = await mkdtemp(join(tmpdir(), 'kiro-uninstall-receipt-delete-'));
  try {
    const env = safeEnv(join(project, 'state')); await installProject({ project, env });
    let failed = false;
    const unlinkQuarantine = async (path) => { if (!failed && path.endsWith('receipt.quarantine')) { failed = true; throw new Error('receipt-unlink'); } await fsUnlink(path); };
    await assert.rejects(uninstallProject({ project, unlinkQuarantine }), /receipt-unlink/);
    const tx = join(project, '.kiro', '.tdai-memory-uninstall');
    await assert.rejects(readFile(join(tx, 'hook.quarantine'), 'utf8'), { code: 'ENOENT' });
    await readFile(join(tx, 'receipt.quarantine'), 'utf8');
    await uninstallProject({ project });
    await assert.rejects(readFile(join(tx, 'receipt.quarantine'), 'utf8'), { code: 'ENOENT' });
  } finally { await rm(project, { recursive: true, force: true }); }
});

test('uninstaller resumes each deterministic transaction crash stage', async () => {
  for (const [name, option] of [
    ['directory', 'afterTransactionCreated'],
    ['receipt', 'afterReceiptStaged'],
    ['hook', 'afterHookStaged'],
  ]) {
    const project = await mkdtemp(join(tmpdir(), `kiro-uninstall-crash-${name}-`));
    try {
      const env = safeEnv(join(project, 'state')); await installProject({ project, env });
      await assert.rejects(uninstallProject({ project, [option]: async () => { throw new Error(`crash-${name}`); } }), new RegExp(`crash-${name}`));
      await uninstallProject({ project });
      await assert.rejects(readFile(join(project, '.kiro', 'tdai-memory-install.json'), 'utf8'), { code: 'ENOENT' });
      await assert.rejects(readFile(join(project, '.kiro', 'hooks', 'tdai-memory.json'), 'utf8'), { code: 'ENOENT' });
    } finally { await rm(project, { recursive: true, force: true }); }
  }
});

test('uninstaller completes a receipt-first staged install that has no hook', async () => {
  const project = await mkdtemp(join(tmpdir(), 'kiro-uninstall-staged-only-'));
  try {
    const env = safeEnv(join(project, 'state'));
    await assert.rejects(installProject({ project, env, afterReceiptPublished: async () => { throw new Error('install-crash'); } }), /install-crash/);
    await uninstallProject({ project });
    await assert.rejects(readFile(join(project, '.kiro', 'tdai-memory-install.json'), 'utf8'), { code: 'ENOENT' });
  } finally { await rm(project, { recursive: true, force: true }); }
});

test('two concurrent uninstalls safely complete the same transaction', async () => {
  for (let index = 0; index < 20; index += 1) {
    const project = await mkdtemp(join(tmpdir(), 'kiro-uninstall-concurrent-'));
    try {
      const env = safeEnv(join(project, 'state')); await installProject({ project, env });
      await Promise.all([uninstallProject({ project }), uninstallProject({ project })]);
      await assert.rejects(readFile(join(project, '.kiro', 'tdai-memory-install.json'), 'utf8'), { code: 'ENOENT' });
      await assert.rejects(readFile(join(project, '.kiro', 'hooks', 'tdai-memory.json'), 'utf8'), { code: 'ENOENT' });
    } finally { await rm(project, { recursive: true, force: true }); }
  }
});

test('uninstaller refuses non-regular original and transaction objects without moving them', async () => {
  for (const target of ['receipt', 'hook', 'transaction-receipt', 'transaction-hook']) {
    const project = await mkdtemp(join(tmpdir(), `kiro-uninstall-object-${target}-`));
    try {
      const env = safeEnv(join(project, 'state')); await installProject({ project, env });
      const receiptPath = join(project, '.kiro', 'tdai-memory-install.json');
      const hookPath = join(project, '.kiro', 'hooks', 'tdai-memory.json');
      const receiptSource = await readFile(receiptPath, 'utf8'); const hookSource = await readFile(hookPath, 'utf8');
      const tx = join(project, '.kiro', '.tdai-memory-uninstall'); await mkdir(tx, { recursive: true });
      const path = target === 'receipt' ? receiptPath : target === 'hook' ? hookPath : join(tx, target === 'transaction-receipt' ? 'receipt.quarantine' : 'hook.quarantine');
      if (target === 'receipt' || target === 'hook') await fsUnlink(path);
      await mkdir(path);
      await assert.rejects(uninstallProject({ project }), /object/);
      assert.equal((await lstat(path)).isDirectory(), true);
      if (target !== 'receipt') assert.equal(await readFile(receiptPath, 'utf8'), receiptSource);
      if (target !== 'hook') assert.equal(await readFile(hookPath, 'utf8'), hookSource);
    } finally { await rm(project, { recursive: true, force: true }); }
  }
});

test('uninstaller refuses symbolic-link hook and receipt paths without moving the links', async () => {
  for (const target of ['receipt', 'hook']) {
    const project = await mkdtemp(join(tmpdir(), `kiro-uninstall-symlink-${target}-`));
    try {
      const env = safeEnv(join(project, 'state')); await installProject({ project, env });
      const path = target === 'receipt' ? join(project, '.kiro', 'tdai-memory-install.json') : join(project, '.kiro', 'hooks', 'tdai-memory.json');
      const external = join(project, 'external'); await mkdir(external); await fsUnlink(path); await symlink(external, path, 'junction');
      await assert.rejects(uninstallProject({ project }), /object/);
      assert.equal((await lstat(path)).isSymbolicLink(), true);
      assert.equal((await lstat(external)).isDirectory(), true);
    } finally { await rm(project, { recursive: true, force: true }); }
  }
});

test('installer refuses while a recoverable uninstall transaction owns the receipt', async () => {
  const project = await mkdtemp(join(tmpdir(), 'kiro-lifecycle-interleave-'));
  try {
    const env = safeEnv(join(project, 'state')); await installProject({ project, env });
    let release; const released = new Promise((resolve) => { release = resolve; });
    let entered; const staged = new Promise((resolve) => { entered = resolve; });
    const uninstalling = uninstallProject({ project, afterReceiptStaged: async () => { entered(); await released; } });
    await staged;
    const installing = await runAsync('install', project, env);
    assert.notEqual(installing.status, 0); assert.equal(installing.stderr.includes('installer-secret'), false);
    release(); await uninstalling;
    await assert.rejects(readFile(join(project, '.kiro', 'tdai-memory-install.json'), 'utf8'), { code: 'ENOENT' });
    await assert.rejects(readFile(join(project, '.kiro', 'hooks', 'tdai-memory.json'), 'utf8'), { code: 'ENOENT' });
  } finally { await rm(project, { recursive: true, force: true }); }
});

test('installer compensates if uninstall starts after its transaction check and finishes before hook publication', async () => {
  const project = await mkdtemp(join(tmpdir(), 'kiro-lifecycle-check-act-'));
  try {
    const env = safeEnv(join(project, 'state')); let release; const released = new Promise((resolve) => { release = resolve; });
    let entered; const receiptPublished = new Promise((resolve) => { entered = resolve; });
    const installing = installProject({ project, env, afterReceiptPublished: async () => { entered(); await released; } });
    await receiptPublished; await uninstallProject({ project }); release();
    await assert.rejects(installing, /lifecycle/);
    await assert.rejects(readFile(join(project, '.kiro', 'tdai-memory-install.json'), 'utf8'), { code: 'ENOENT' });
    await assert.rejects(readFile(join(project, '.kiro', 'hooks', 'tdai-memory.json'), 'utf8'), { code: 'ENOENT' });
  } finally { await rm(project, { recursive: true, force: true }); }
});

test('installer compensation preserves a user hook created at the original path by concurrent uninstall', async () => {
  const project = await mkdtemp(join(tmpdir(), 'kiro-lifecycle-user-hook-'));
  try {
    const env = safeEnv(join(project, 'state')); const hookPath = join(project, '.kiro', 'hooks', 'tdai-memory.json'); const userHook = '{"user":true}\n';
    const installing = installProject({
      project,
      env,
      afterHookPublished: async () => uninstallProject({ project, afterHookQuarantined: async () => { await writeFile(hookPath, userHook); } }),
    });
    await assert.rejects(installing, /lifecycle/);
    assert.equal(await readFile(hookPath, 'utf8'), userHook);
    await assert.rejects(readFile(join(project, '.kiro', 'tdai-memory-install.json'), 'utf8'), { code: 'ENOENT' });
  } finally { await rm(project, { recursive: true, force: true }); }
});

test('an abandoned uninstall transaction is resumed before installation can recover', async () => {
  const project = await mkdtemp(join(tmpdir(), 'kiro-lifecycle-recover-'));
  try {
    const env = safeEnv(join(project, 'state')); await installProject({ project, env });
    await assert.rejects(uninstallProject({ project, afterReceiptStaged: async () => { throw new Error('crash'); } }), /crash/);
    await assert.rejects(installProject({ project, env }), /lifecycle/);
    await uninstallProject({ project });
    await installProject({ project, env });
    assert.equal((await lstat(join(project, '.kiro', 'tdai-memory-install.json'))).isFile(), true);
    assert.equal((await lstat(join(project, '.kiro', 'hooks', 'tdai-memory.json'))).isFile(), true);
  } finally { await rm(project, { recursive: true, force: true }); }
});

test('installer rolls back a newly published receipt when uninstall starts after its initial check', async () => {
  const project = await mkdtemp(join(tmpdir(), 'kiro-receipt-race-'));
  try {
    const env = safeEnv(join(project, 'state')); await installProject({ project, env });
    let continueInstall; const installReleased = new Promise((resolve) => { continueInstall = resolve; });
    let initialChecked; const initialCheck = new Promise((resolve) => { initialChecked = resolve; });
    const installing = installProject({ project, env, afterInitialTransactionCheck: async () => { initialChecked(); await installReleased; } });
    await waitForBarrier(initialCheck);
    let continueUninstall; const uninstallReleased = new Promise((resolve) => { continueUninstall = resolve; });
    let receiptStaged; const staged = new Promise((resolve) => { receiptStaged = resolve; });
    const uninstalling = uninstallProject({ project, afterReceiptStaged: async () => { receiptStaged(); await uninstallReleased; } });
    await staged; continueInstall(); await assert.rejects(installing, /lifecycle/); continueUninstall(); await uninstalling;
    await assert.rejects(readFile(join(project, '.kiro', 'tdai-memory-install.json'), 'utf8'), { code: 'ENOENT' });
    await assert.rejects(readFile(join(project, '.kiro', 'hooks', 'tdai-memory.json'), 'utf8'), { code: 'ENOENT' });
  } finally { await rm(project, { recursive: true, force: true }); }
});

test('receipt rollback preserves a concurrent user file or directory at the original path', async () => {
  for (const replacement of ['file', 'directory']) {
    const project = await mkdtemp(join(tmpdir(), `kiro-receipt-replace-${replacement}-`));
    try {
      const env = safeEnv(join(project, 'state')); await installProject({ project, env });
      const receiptPath = join(project, '.kiro', 'tdai-memory-install.json'); const userReceipt = '{"user":true}\n';
      let continueInstall; const installReleased = new Promise((resolve) => { continueInstall = resolve; });
      let initialChecked; const initialCheck = new Promise((resolve) => { initialChecked = resolve; });
      const installing = installProject({
        project,
        env,
        afterInitialTransactionCheck: async () => { initialChecked(); await installReleased; },
        beforeReceiptRollback: async () => { await fsUnlink(receiptPath); if (replacement === 'file') await writeFile(receiptPath, userReceipt); else await mkdir(receiptPath); },
      });
      await waitForBarrier(initialCheck);
      let continueUninstall; const uninstallReleased = new Promise((resolve) => { continueUninstall = resolve; });
      let receiptStaged; const staged = new Promise((resolve) => { receiptStaged = resolve; });
      const uninstalling = uninstallProject({ project, afterReceiptStaged: async () => { receiptStaged(); await uninstallReleased; } });
      await staged; continueInstall(); await assert.rejects(installing, /lifecycle/);
      if (replacement === 'file') assert.equal(await readFile(receiptPath, 'utf8'), userReceipt); else assert.equal((await lstat(receiptPath)).isDirectory(), true);
      continueUninstall(); await uninstalling;
      if (replacement === 'file') assert.equal(await readFile(receiptPath, 'utf8'), userReceipt); else assert.equal((await lstat(receiptPath)).isDirectory(), true);
    } finally { await rm(project, { recursive: true, force: true }); }
  }
});

test('installer never removes an existing matching receipt when uninstall owns the old receipt', async () => {
  const project = await mkdtemp(join(tmpdir(), 'kiro-receipt-existing-race-'));
  try {
    const env = safeEnv(join(project, 'state')); await installProject({ project, env });
    const receiptPath = join(project, '.kiro', 'tdai-memory-install.json'); const matching = await readFile(receiptPath, 'utf8');
    let continueInstall; const installReleased = new Promise((resolve) => { continueInstall = resolve; });
    let initialChecked; const initialCheck = new Promise((resolve) => { initialChecked = resolve; });
    const installing = installProject({ project, env, afterInitialTransactionCheck: async () => { initialChecked(); await installReleased; } });
    await waitForBarrier(initialCheck);
    let continueUninstall; const uninstallReleased = new Promise((resolve) => { continueUninstall = resolve; });
    let receiptStaged; const staged = new Promise((resolve) => { receiptStaged = resolve; });
    const uninstalling = uninstallProject({ project, afterReceiptStaged: async () => { receiptStaged(); await uninstallReleased; } });
    await staged; await writeFile(receiptPath, matching); continueInstall(); await assert.rejects(installing, /lifecycle/);
    assert.equal(await readFile(receiptPath, 'utf8'), matching); continueUninstall(); await uninstalling;
    assert.equal(await readFile(receiptPath, 'utf8'), matching);
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

test('installer rejects a hook claimed by a concurrent conflicting writer while preserving a recoverable staged receipt', async () => {
  const project = await mkdtemp(join(tmpdir(), 'kiro-install-race-'));
  try {
    const env = safeEnv(join(project, 'state'));
    const hookPath = join(project, '.kiro', 'hooks', 'tdai-memory.json');
    const userHook = '{"owned":"by-user"}\n';
    await assert.rejects(installProject({ project, env, beforePublish: async () => { await writeFile(hookPath, userHook); } }), /conflict/);
    assert.equal(await readFile(hookPath, 'utf8'), userHook);
    assert.equal(JSON.parse(await readFile(join(project, '.kiro', 'tdai-memory-install.json'), 'utf8')).version, 1);
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

test('installer refuses a different staged receipt before creating a hook', async () => {
  const project = await mkdtemp(join(tmpdir(), 'kiro-staged-receipt-conflict-'));
  try {
    const env = safeEnv(join(project, 'state'));
    const receiptPath = join(project, '.kiro', 'tdai-memory-install.json');
    const hookPath = join(project, '.kiro', 'hooks', 'tdai-memory.json');
    const userReceipt = '{"owned":"by-user"}\n';
    await mkdir(join(project, '.kiro'), { recursive: true });
    await writeFile(receiptPath, userReceipt, { encoding: 'utf8' });
    await assert.rejects(installProject({ project, env }), /conflict/);
    assert.equal(await readFile(receiptPath, 'utf8'), userReceipt);
    await assert.rejects(readFile(hookPath, 'utf8'), { code: 'ENOENT' });
  } finally { await rm(project, { recursive: true, force: true }); }
});

test('a staged receipt without a hook recovers on the next install, doctor, and uninstall', async () => {
  const project = await mkdtemp(join(tmpdir(), 'kiro-staged-receipt-recovery-'));
  try {
    const env = safeEnv(join(project, 'state'));
    const hookPath = join(project, '.kiro', 'hooks', 'tdai-memory.json');
    await assert.rejects(installProject({ project, env, afterReceiptPublished: async () => { throw new Error('simulated-crash'); } }), /simulated-crash/);
    await assert.rejects(readFile(hookPath, 'utf8'), { code: 'ENOENT' });
    assert.equal(JSON.parse(await readFile(join(project, '.kiro', 'tdai-memory-install.json'), 'utf8')).version, 1);
    await installProject({ project, env });
    assert.equal(run('doctor', project, env).status, 0);
    assert.equal(run('uninstall', project, env).status, 0);
  } finally { await rm(project, { recursive: true, force: true }); }
});

test('barriered concurrent installs publish one identical receipt without rename races', async () => {
  for (let index = 0; index < 50; index += 1) {
    const project = await mkdtemp(join(tmpdir(), 'kiro-receipt-race-'));
    try {
      const env = safeEnv(join(project, 'state'));
      let arrived = 0; let release;
      const barrier = new Promise((resolve) => { release = resolve; });
      const afterReceiptPublished = async () => { arrived += 1; if (arrived === 2) release(); await barrier; };
      await Promise.all([installProject({ project, env, afterReceiptPublished }), installProject({ project, env, afterReceiptPublished })]);
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
