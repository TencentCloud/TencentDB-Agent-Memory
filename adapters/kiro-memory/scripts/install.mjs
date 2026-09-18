import { createHash, randomUUID } from 'node:crypto';
import { link, lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import { loadConfig } from '../src/core/config.js';

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
      { name: 'tdai-memory-tool-trace', trigger: 'PostToolUse', action: { type: 'command', command: buildHookCommand(adapterPath, 'post-tool-use', options) }, timeout: 5, enabled: true, matcher: '*' },
      { name: 'tdai-memory-stop', trigger: 'Stop', action: { type: 'command', command: buildHookCommand(adapterPath, 'stop', options) }, timeout: 5, enabled: true },
    ],
  };
}

export async function installProject({
  project: projectArg,
  env = process.env,
  adapterPath = adapterPathFor(),
  beforePublish,
  afterInitialTransactionCheck = async () => {},
  afterReceiptPublished = async () => {},
  beforeReceiptRollback = async () => {},
  afterHookPublished = async () => {},
} = {}) {
  if (typeof projectArg !== 'string' || projectArg.length === 0) throw new Error('args');
  loadConfig(env);
  const project = resolve(projectArg);
  const hookPath = join(project, '.kiro', 'hooks', 'tdai-memory.json');
  const receiptPath = join(project, '.kiro', 'tdai-memory-install.json');
  const hook = buildHookDefinition(adapterPath);
  const expected = `${JSON.stringify(hook, null, 2)}\n`;
  const receipt = { version: 1, hook_path: '.kiro/hooks/tdai-memory.json', hook_sha256: sha256(expected), adapter_path: adapterPath };
  const receiptExpected = `${JSON.stringify(receipt, null, 2)}\n`;
  await refuseUninstallTransaction(project);
  await afterInitialTransactionCheck();
  const receiptPublished = await publishContentNoReplace(receiptPath, receiptExpected);
  await afterReceiptPublished();
  try { await refuseUninstallTransaction(project); } catch (error) {
    if (receiptPublished === 'created') {
      await beforeReceiptRollback();
      await removeExpectedPublishedFile(receiptPath, receiptExpected);
    }
    throw error;
  }
  await publishHookNoReplace(hookPath, expected, { beforePublish });
  await afterHookPublished();
  if (await transactionExists(project) || await readFile(receiptPath, 'utf8').catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error)) !== receiptExpected) {
    await removeExpectedPublishedFile(hookPath, expected);
    throw new Error('lifecycle');
  }
  if (await readFile(hookPath, 'utf8') !== expected) throw new Error('conflict');
}

export async function install() {
  const projectArg = args();
  if (projectArg === null) throw new Error('args');
  await installProject({ project: projectArg });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await install(); process.stdout.write('tdai-memory install: ok\n'); } catch { process.stderr.write('tdai-memory install: failed\n'); process.exitCode = 1; }
}
