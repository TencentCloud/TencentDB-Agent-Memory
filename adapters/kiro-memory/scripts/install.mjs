import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import { loadConfig } from '../src/core/config.js';

const sha256 = (source) => createHash('sha256').update(source).digest('hex');
const args = () => process.argv.length === 4 && process.argv[2] === '--project' && process.argv[3].length > 0 ? process.argv[3] : null;
const atomicJson = async (path, value) => {
  const source = `${JSON.stringify(value, null, 2)}\n`;
  const temp = `${path}.${randomUUID()}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(temp, source, { encoding: 'utf8', mode: 0o600 });
  await rename(temp, path);
  return source;
};
const missing = async (path) => { try { await access(path); return false; } catch { return true; } };
const hookDefinition = (adapterPath) => ({
  version: 'v1',
  hooks: {
    UserPromptSubmit: [{ name: 'tdai-memory-recall', enabled: true, command: `"${process.execPath}" "${join(adapterPath, 'src', 'cli.js')}" recall`, timeout: 5 }],
    PostToolUse: [{ name: 'tdai-memory-tool-trace', enabled: true, matcher: '*', command: `"${process.execPath}" "${join(adapterPath, 'src', 'cli.js')}" post-tool-use`, timeout: 5 }],
    Stop: [{ name: 'tdai-memory-stop', enabled: true, command: `"${process.execPath}" "${join(adapterPath, 'src', 'cli.js')}" stop`, timeout: 5 }],
  },
});

async function install() {
  const projectArg = args();
  if (projectArg === null) throw new Error('args');
  loadConfig(process.env);
  const project = resolve(projectArg);
  const adapterPath = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const hookPath = join(project, '.kiro', 'hooks', 'tdai-memory.json');
  const receiptPath = join(project, '.kiro', 'tdai-memory-install.json');
  const hook = hookDefinition(adapterPath);
  const expected = `${JSON.stringify(hook, null, 2)}\n`;
  if (!(await missing(hookPath)) && await readFile(hookPath, 'utf8') !== expected) throw new Error('conflict');
  if (await missing(hookPath)) await atomicJson(hookPath, hook);
  const actual = await readFile(hookPath, 'utf8');
  await atomicJson(receiptPath, { version: 1, hook_path: '.kiro/hooks/tdai-memory.json', hook_sha256: sha256(actual), adapter_path: adapterPath });
}

try { await install(); process.stdout.write('tdai-memory install: ok\n'); } catch { process.stderr.write('tdai-memory install: failed\n'); process.exitCode = 1; }
