import { createHash, randomUUID } from 'node:crypto';
import { link, lstat, mkdir, open, readFile, rename, rmdir, unlink } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import { resolveConfig } from '../src/core/config.js';

const sha256 = (source) => createHash('sha256').update(source).digest('hex');
const args = () => process.argv.length === 4 && process.argv[2] === '--project' && process.argv[3].length > 0 ? process.argv[3] : null;
const adapterPathFor = () => resolve(dirname(fileURLToPath(import.meta.url)), '..');
const safeExecutable = (value) => typeof value === 'string' && value.length > 0 && !/[\r\n%]/.test(value);
const uninstallTransactionFor = (project) => join(project, '.kiro', '.tdai-memory-uninstall');

const transactionExists = async (project) => {
  try { await lstat(uninstallTransactionFor(project)); return true; } catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
};

const refuseUninstallTransaction = async (project) => {
  if (await transactionExists(project)) throw new Error('lifecycle');
};

const writeTempSynced = async (path, source) => {
  const handle = await open(path, 'wx', 0o600);
  try { await handle.writeFile(source, 'utf8'); await handle.sync(); } finally { await handle.close(); }
};

export async function publishContentNoReplace(path, expected, { beforePublish = async () => {} } = {}) {
  const tempPath = `${path}.${randomUUID()}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeTempSynced(tempPath, expected);
    await beforePublish();
    try {
      await link(tempPath, path);
      return 'created';
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      if (await readFile(path, 'utf8') !== expected) throw new Error('conflict');
      return 'existing';
    }
  } finally {
    try { await unlink(tempPath); } catch (error) { if (error?.code !== 'ENOENT') { /* best-effort temporary cleanup */ } }
  }
}

export const publishHookNoReplace = (hookPath, expected, options) => publishContentNoReplace(hookPath, expected, options);

const removeExpectedPublishedFile = async (path, expected) => {
  const quarantine = `${path}.${randomUUID()}.install-rollback`;
  try {
    if (!(await lstat(path)).isFile()) return;
  } catch (error) { if (error?.code === 'ENOENT') return; throw error; }
  try { await rename(path, quarantine); } catch (error) { if (error?.code === 'ENOENT') return; throw error; }
  if (!(await lstat(quarantine)).isFile()) {
    try { await rename(quarantine, path); } catch { /* keep the non-regular object quarantined if the original path is occupied */ }
    return;
  }
  if (await readFile(quarantine, 'utf8') === expected) {
    await unlink(quarantine);
    return;
  }
  try { await link(quarantine, path); } catch (error) { if (error?.code === 'EEXIST') return; throw error; }
  await unlink(quarantine);
};

export const quotePosixShell = (value) => {
  if (typeof value !== 'string') throw new Error('quote');
  return `'${value.replace(/'/g, `'"'"'`)}'`;
};

export const quoteWindowsCommandLine = (value) => {
  if (typeof value !== 'string') throw new Error('quote');
  return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/g, '$1$1')}"`;
};

const quoteForPlatform = (value, platform) => platform === 'win32' ? quoteWindowsCommandLine(value) : quotePosixShell(value);

export function buildHookCommand(adapterPath, command, { executable = process.execPath, platform = process.platform } = {}) {
  if (typeof adapterPath !== 'string' || adapterPath.length === 0 || !['recall', 'post-tool-use', 'stop'].includes(command) || !safeExecutable(executable)) throw new Error('command');
  const cliUrl = pathToFileURL(join(adapterPath, 'src', 'cli.js')).href;
  const encodedUrl = Buffer.from(cliUrl, 'utf8').toString('base64');
  const source = `try{const{runCli}=await import(Buffer.from('${encodedUrl}','base64').toString('utf8'));const r=await runCli({argv:['${command}']});if(r.stdout)process.stdout.write(r.stdout)}catch{}`;
  return `${quoteForPlatform(executable, platform)} --input-type=module --eval ${quoteForPlatform(source, platform)}`;
}

export function buildHookDefinition(adapterPath, options = {}) {
  return {
    version: 'v1',
    hooks: [
      { name: 'tdai-memory-recall', trigger: 'UserPromptSubmit', action: { type: 'command', command: buildHookCommand(adapterPath, 'recall', options) }, timeout: 5, enabled: true },
      { name: 'tdai-memory-tool-trace', trigger: 'PostToolUse', action: { type: 'command', command: buildHookCommand(adapterPath, 'post-tool-use', options) }, timeout: 5, enabled: true },
      { name: 'tdai-memory-stop', trigger: 'Stop', action: { type: 'command', command: buildHookCommand(adapterPath, 'stop', options) }, timeout: 5, enabled: true },
    ],
  };
}

export function buildMcpEntry(adapterPath, project, { executable = process.execPath } = {}) {
  if (!safeExecutable(executable)) throw new Error('command');
  return {
    command: executable,
    args: [join(adapterPath, 'src', 'mcp', 'server.js'), '--workspace', project],
    env: { TDAI_MEMORY_API_KEY: '${TDAI_MEMORY_API_KEY}' },
    disabled: false,
  };
}

const sameJson = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const regularOrMissing = async (path) => {
  try { return (await lstat(path)).isFile() ? 'regular' : 'object'; }
  catch (error) { if (error?.code === 'ENOENT') return 'missing'; throw error; }
};

async function installMcpEntry(project, entry) {
  const mcpPath = join(project, '.kiro', 'settings', 'mcp.json');
  const transactionDirectory = join(project, '.kiro', '.tdai-memory-mcp-install');
  const quarantine = join(transactionDirectory, 'mcp.quarantine');
  const mergeSource = (original) => {
    let document;
    try { document = JSON.parse(original); } catch { throw new Error('conflict'); }
    if (!document || typeof document !== 'object' || Array.isArray(document)) throw new Error('conflict');
    if (document.mcpServers !== undefined && (!document.mcpServers || typeof document.mcpServers !== 'object' || Array.isArray(document.mcpServers))) throw new Error('conflict');
    const servers = document.mcpServers ?? {};
    if (Object.hasOwn(servers, 'tdai-memory') && !sameJson(servers['tdai-memory'], entry)) throw new Error('conflict');
    return `${JSON.stringify({ ...document, mcpServers: { ...servers, 'tdai-memory': entry } }, null, 2)}\n`;
  };
  const noTransaction = {
    cleanup: async () => rmdir(transactionDirectory).catch((error) => { if (error?.code !== 'ENOENT' && error?.code !== 'ENOTEMPTY') throw error; }),
    rollback: async () => {},
  };
  const transactionFor = (merged) => ({
    cleanup: async () => {
      if (await regularOrMissing(quarantine) === 'regular') await unlink(quarantine);
      await rmdir(transactionDirectory).catch((error) => { if (error?.code !== 'ENOENT' && error?.code !== 'ENOTEMPTY') throw error; });
    },
    rollback: async () => {
      await removeExpectedPublishedFile(mcpPath, merged).catch(() => {});
      if (await regularOrMissing(quarantine) === 'regular' && await regularOrMissing(mcpPath) === 'missing') {
        try { await link(quarantine, mcpPath); await unlink(quarantine); }
        catch (error) { if (error?.code !== 'EEXIST') throw error; }
      }
      await rmdir(transactionDirectory).catch((error) => { if (error?.code !== 'ENOENT' && error?.code !== 'ENOTEMPTY') throw error; });
    },
  });

  const quarantineKind = await regularOrMissing(quarantine);
  if (quarantineKind === 'object') throw new Error('lifecycle');
  if (quarantineKind === 'regular') {
    const merged = mergeSource(await readFile(quarantine, 'utf8'));
    const currentKind = await regularOrMissing(mcpPath);
    if (currentKind === 'object') throw new Error('conflict');
    if (currentKind === 'missing') await publishContentNoReplace(mcpPath, merged);
    else if (await readFile(mcpPath, 'utf8') !== merged) throw new Error('conflict');
    return transactionFor(merged);
  }
  const kind = await regularOrMissing(mcpPath);
  if (kind === 'object') throw new Error('conflict');
  if (kind === 'missing') {
    const source = `${JSON.stringify({ mcpServers: { 'tdai-memory': entry } }, null, 2)}\n`;
    const status = await publishContentNoReplace(mcpPath, source);
    return status === 'created' ? {
      cleanup: async () => {},
      rollback: async () => removeExpectedPublishedFile(mcpPath, source),
    } : noTransaction;
  }
  const original = await readFile(mcpPath, 'utf8');
  const document = JSON.parse(original);
  const servers = document.mcpServers ?? {};
  if (Object.hasOwn(servers, 'tdai-memory')) {
    if (!sameJson(servers['tdai-memory'], entry)) throw new Error('conflict');
    return noTransaction;
  }
  const merged = mergeSource(original);
  await mkdir(transactionDirectory, { recursive: true });
  if (await regularOrMissing(quarantine) !== 'missing') throw new Error('lifecycle');
  await rename(mcpPath, quarantine);
  try {
    await publishContentNoReplace(mcpPath, merged);
    if (await readFile(mcpPath, 'utf8') !== merged) throw new Error('conflict');
    return transactionFor(merged);
  } catch (error) {
    await removeExpectedPublishedFile(mcpPath, merged).catch(() => {});
    try { await link(quarantine, mcpPath); await unlink(quarantine); } catch { /* preserve quarantine when occupied */ }
    throw error;
  }
}

async function publishReceiptV2({ project, receiptPath, expected, adapterPath, hookHash }) {
  const transactionDirectory = join(project, '.kiro', '.tdai-memory-phase1-receipt');
  const quarantine = join(transactionDirectory, 'receipt.quarantine');
  const read = async (path) => readFile(path, 'utf8').catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error));
  const validV1 = (source) => {
    try {
      const value = JSON.parse(source);
      return value && typeof value === 'object' && !Array.isArray(value)
        && Object.keys(value).length === 4 && value.version === 1
        && value.hook_path === '.kiro/hooks/tdai-memory.json'
        && value.hook_sha256 === hookHash && value.adapter_path === adapterPath;
    } catch { return false; }
  };
  const current = await read(receiptPath);
  if (current === expected) return { status: 'existing', cleanup: async () => {
    if (await read(quarantine) !== null) await unlink(quarantine);
    await rmdir(transactionDirectory).catch((error) => { if (error?.code !== 'ENOENT' && error?.code !== 'ENOTEMPTY') throw error; });
  }, rollback: async () => {} };
  let staged = await read(quarantine);
  if (current !== null) {
    if (!validV1(current) || staged !== null) throw new Error('conflict');
    await mkdir(transactionDirectory, { recursive: true });
    await rename(receiptPath, quarantine);
    staged = current;
  }
  if (staged !== null && !validV1(staged)) throw new Error('conflict');
  const status = await publishContentNoReplace(receiptPath, expected);
  return { status, cleanup: async () => {
    if (await read(quarantine) !== null) await unlink(quarantine);
    await rmdir(transactionDirectory).catch((error) => { if (error?.code !== 'ENOENT' && error?.code !== 'ENOTEMPTY') throw error; });
  }, rollback: async () => {
    if (status === 'created') await removeExpectedPublishedFile(receiptPath, expected);
    if (staged !== null && await read(quarantine) !== null) {
      try { await link(quarantine, receiptPath); await unlink(quarantine); }
      catch (error) { if (error?.code !== 'EEXIST') throw error; }
    }
    await rmdir(transactionDirectory).catch((error) => { if (error?.code !== 'ENOENT' && error?.code !== 'ENOTEMPTY') throw error; });
  } };
}

export async function installProject({
  project: projectArg,
  env = process.env,
  homedir,
  adapterPath = adapterPathFor(),
  beforePublish,
  afterInitialTransactionCheck = async () => {},
  afterReceiptPublished = async () => {},
  beforeReceiptRollback = async () => {},
  afterHookPublished = async () => {},
  beforeMcpCleanup = async () => {},
} = {}) {
  if (typeof projectArg !== 'string' || projectArg.length === 0) throw new Error('args');
  const project = resolve(projectArg);
  await resolveConfig({ env, workspace: project, ...(homedir === undefined ? {} : { homedir }) });
  const hookPath = join(project, '.kiro', 'hooks', 'tdai-memory.json');
  const receiptPath = join(project, '.kiro', 'tdai-memory-install.json');
  const hook = buildHookDefinition(adapterPath);
  const mcpEntry = buildMcpEntry(adapterPath, project);
  const expected = `${JSON.stringify(hook, null, 2)}\n`;
  const receipt = {
    version: 2,
    adapter_path: adapterPath,
    hook: { path: '.kiro/hooks/tdai-memory.json', sha256: sha256(expected) },
    mcp: { path: '.kiro/settings/mcp.json', server_name: 'tdai-memory', entry_sha256: sha256(JSON.stringify(mcpEntry)) },
  };
  const receiptExpected = `${JSON.stringify(receipt, null, 2)}\n`;
  await refuseUninstallTransaction(project);
  await afterInitialTransactionCheck();
  let hookPublished;
  let mcpTransaction;
  let receiptPublication;
  try {
    hookPublished = await publishHookNoReplace(hookPath, expected, { beforePublish });
    await afterHookPublished();
    if (await readFile(hookPath, 'utf8') !== expected) throw new Error('conflict');
    await refuseUninstallTransaction(project);
    mcpTransaction = await installMcpEntry(project, mcpEntry);
    await refuseUninstallTransaction(project);
    receiptPublication = await publishReceiptV2({ project, receiptPath, expected: receiptExpected, adapterPath, hookHash: receipt.hook.sha256 });
    await afterReceiptPublished();
    if (await transactionExists(project)
      || await readFile(receiptPath, 'utf8').catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error)) !== receiptExpected
      || await readFile(hookPath, 'utf8').catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error)) !== expected) {
      throw new Error('lifecycle');
    }
  } catch (error) {
    if (receiptPublication?.status === 'created') await beforeReceiptRollback();
    await receiptPublication?.rollback().catch(() => {});
    await mcpTransaction?.rollback().catch(() => {});
    if (hookPublished === 'created') await removeExpectedPublishedFile(hookPath, expected).catch(() => {});
    throw error;
  }
  await beforeMcpCleanup();
  await mcpTransaction.cleanup();
  await receiptPublication.cleanup();
}

export async function install() {
  const projectArg = args();
  if (projectArg === null) throw new Error('args');
  await installProject({ project: projectArg });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await install(); process.stdout.write('tdai-memory install: ok\n'); } catch { process.stderr.write('tdai-memory install: failed\n'); process.exitCode = 1; }
}
