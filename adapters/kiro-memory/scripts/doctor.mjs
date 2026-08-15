import { createHash } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import { loadConfig } from '../src/core/config.js';
import { buildHookDefinition } from './install.mjs';

const sha256 = (source) => createHash('sha256').update(source).digest('hex');
const args = () => process.argv.length === 4 && process.argv[2] === '--project' && process.argv[3].length > 0 ? process.argv[3] : null;
const adapterPath = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const validReceipt = (value) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === 4 && value.version === 1 && value.hook_path === '.kiro/hooks/tdai-memory.json'
  && typeof value.hook_sha256 === 'string' && /^[a-f0-9]{64}$/.test(value.hook_sha256)
  && typeof value.adapter_path === 'string' && value.adapter_path === adapterPath;
const sameJson = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const check = async (name, work) => { try { await work(); process.stdout.write(`${name}: pass\n`); return true; } catch { process.stdout.write(`${name}: fail\n`); return false; } };

export async function doctor() {
  const projectArg = args(); const project = projectArg === null ? null : resolve(projectArg); const results = [];
  results.push(await check('node', async () => { if (Number(process.versions.node.split('.')[0]) < 20) throw new Error('node'); }));
  results.push(await check('config', async () => { loadConfig(process.env); }));
  results.push(await check('cli', async () => { await access(join(adapterPath, 'src', 'cli.js')); }));
  results.push(await check('hook-receipt', async () => {
    if (project === null) throw new Error('args');
    const receipt = JSON.parse(await readFile(join(project, '.kiro', 'tdai-memory-install.json'), 'utf8'));
    const hookSource = await readFile(join(project, '.kiro', 'hooks', 'tdai-memory.json'), 'utf8');
    const hook = JSON.parse(hookSource);
    if (!validReceipt(receipt) || sha256(hookSource) !== receipt.hook_sha256 || !sameJson(hook, buildHookDefinition(adapterPath))) throw new Error('hook');
  }));
  return results.every(Boolean);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!(await doctor())) process.exitCode = 1;
}
