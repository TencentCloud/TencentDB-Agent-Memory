import { createHash } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import { resolveConfig } from '../src/core/config.js';
import { buildHookDefinition, buildMcpEntry } from './install.mjs';

const sha256 = (source) => createHash('sha256').update(source).digest('hex');
const args = () => process.argv.length === 4 && process.argv[2] === '--project' && process.argv[3].length > 0 ? process.argv[3] : null;
const adapterPath = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const validReceipt = (value) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === 4 && value.version === 2 && value.adapter_path === adapterPath
  && value.hook?.path === '.kiro/hooks/tdai-memory.json' && /^[a-f0-9]{64}$/.test(value.hook?.sha256)
  && value.mcp?.path === '.kiro/settings/mcp.json' && value.mcp?.server_name === 'tdai-memory'
  && /^[a-f0-9]{64}$/.test(value.mcp?.entry_sha256);
const sameJson = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const check = async (name, work) => { try { await work(); process.stdout.write(`${name}: pass\n`); return true; } catch { process.stdout.write(`${name}: fail\n`); return false; } };

const readJsonOptional = async (path) => {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error?.code === 'ENOENT') return null; throw new Error('state journal'); }
};

export async function validateState(stateDir) {
  const manifest = await readJsonOptional(join(stateDir, 'state.json'));
  if (manifest !== null && (manifest.version !== 2 || manifest.adapter !== 'kiro-memory'
    || typeof manifest.created_at !== 'string' || Number.isNaN(Date.parse(manifest.created_at)))) throw new Error('state manifest');

  const journal = join(stateDir, '.migration', 'v1-to-v2');
  const plan = await readJsonOptional(join(journal, 'plan.json'));
  const progress = await readJsonOptional(join(journal, 'progress.json'));
  const receipt = await readJsonOptional(join(journal, 'receipt.json'));
  if (plan === null && progress === null && receipt === null) return;
  if (!plan || plan.version !== 1 || plan.migration !== 'v1-to-v2' || !Array.isArray(plan.objects) || plan.objects.length > 10000) throw new Error('migration journal');
  const nextIndex = progress === null ? 0 : progress.version === 1 && Number.isInteger(progress.next_index) ? progress.next_index : -1;
  if (nextIndex < 0 || nextIndex > plan.objects.length) throw new Error('migration journal');
  if (receipt !== null && (manifest === null || receipt.version !== 1 || receipt.migration !== 'v1-to-v2'
    || receipt.verified_objects !== plan.objects.length || nextIndex !== plan.objects.length)) throw new Error('migration journal');
}

export async function doctor() {
  const projectArg = args(); const project = projectArg === null ? null : resolve(projectArg); const results = [];
  let resolvedConfig = null;
  results.push(await check('node', async () => { if (Number(process.versions.node.split('.')[0]) < 20) throw new Error('node'); }));
  results.push(await check('config', async () => { if (project === null) throw new Error('args'); resolvedConfig = await resolveConfig({ env: process.env, workspace: project }); }));
  results.push(await check('cli', async () => { await access(join(adapterPath, 'src', 'cli.js')); }));
  results.push(await check('hook-receipt', async () => {
    if (project === null) throw new Error('args');
    const receipt = JSON.parse(await readFile(join(project, '.kiro', 'tdai-memory-install.json'), 'utf8'));
    const hookSource = await readFile(join(project, '.kiro', 'hooks', 'tdai-memory.json'), 'utf8');
    const hook = JSON.parse(hookSource);
    const mcp = JSON.parse(await readFile(join(project, '.kiro', 'settings', 'mcp.json'), 'utf8'));
    const entry = mcp?.mcpServers?.['tdai-memory'];
    if (!validReceipt(receipt) || sha256(hookSource) !== receipt.hook.sha256 || !sameJson(hook, buildHookDefinition(adapterPath))
      || !sameJson(entry, buildMcpEntry(adapterPath, project)) || sha256(JSON.stringify(entry)) !== receipt.mcp.entry_sha256) throw new Error('hook');
  }));
  results.push(await check('state', async () => {
    if (resolvedConfig === null) throw new Error('config');
    await validateState(resolvedConfig.config.stateDir);
  }));
  return results.every(Boolean);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!(await doctor())) process.exitCode = 1;
}
