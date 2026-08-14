import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import { loadConfig } from '../src/core/config.js';

const sha256 = (source) => createHash('sha256').update(source).digest('hex');
const args = () => process.argv.length === 4 && process.argv[2] === '--project' && process.argv[3].length > 0 ? process.argv[3] : null;
const adapterPathFor = () => resolve(dirname(fileURLToPath(import.meta.url)), '..');
const atomicJson = async (path, value) => {
  const source = `${JSON.stringify(value, null, 2)}\n`;
  const temp = `${path}.${randomUUID()}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(temp, source, { encoding: 'utf8', mode: 0o600 });
  await rename(temp, path);
  return source;
};
const missing = async (path) => { try { await access(path); return false; } catch { return true; } };
const safeExecutable = (value) => typeof value === 'string' && value.length > 0 && !/[\r\n%]/.test(value);

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

export async function install() {
  const projectArg = args();
  if (projectArg === null) throw new Error('args');
  loadConfig(process.env);
  const project = resolve(projectArg);
  const adapterPath = adapterPathFor();
  const hookPath = join(project, '.kiro', 'hooks', 'tdai-memory.json');
  const receiptPath = join(project, '.kiro', 'tdai-memory-install.json');
  const hook = buildHookDefinition(adapterPath);
  const expected = `${JSON.stringify(hook, null, 2)}\n`;
  if (!(await missing(hookPath)) && await readFile(hookPath, 'utf8') !== expected) throw new Error('conflict');
  if (await missing(hookPath)) await atomicJson(hookPath, hook);
  const actual = await readFile(hookPath, 'utf8');
  await atomicJson(receiptPath, { version: 1, hook_path: '.kiro/hooks/tdai-memory.json', hook_sha256: sha256(actual), adapter_path: adapterPath });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await install(); process.stdout.write('tdai-memory install: ok\n'); } catch { process.stderr.write('tdai-memory install: failed\n'); process.exitCode = 1; }
}
