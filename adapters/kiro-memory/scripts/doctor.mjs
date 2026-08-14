import { createHash } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import { loadConfig } from '../src/core/config.js';

const sha256 = (source) => createHash('sha256').update(source).digest('hex');
const args = () => process.argv.length === 4 && process.argv[2] === '--project' && process.argv[3].length > 0 ? process.argv[3] : null;
const validReceipt = (value) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === 4 && value.version === 1 && value.hook_path === '.kiro/hooks/tdai-memory.json'
  && typeof value.hook_sha256 === 'string' && /^[a-f0-9]{64}$/.test(value.hook_sha256)
  && typeof value.adapter_path === 'string' && value.adapter_path.length > 0;
const validHook = (value) => value && value.version === 'v1' && value.hooks && typeof value.hooks === 'object'
  && ['UserPromptSubmit', 'PostToolUse', 'Stop'].every((trigger) => Array.isArray(value.hooks[trigger]) && value.hooks[trigger].length === 1)
  && value.hooks.UserPromptSubmit[0].name === 'tdai-memory-recall'
  && value.hooks.PostToolUse[0].name === 'tdai-memory-tool-trace' && value.hooks.PostToolUse[0].matcher === '*'
  && value.hooks.Stop[0].name === 'tdai-memory-stop'
  && Object.values(value.hooks).flat().every((item) => item.enabled === true && item.timeout === 5 && typeof item.command === 'string');
const check = async (name, work) => { try { await work(); process.stdout.write(`${name}: pass\n`); return true; } catch { process.stdout.write(`${name}: fail\n`); return false; } };

const projectArg = args();
const project = projectArg === null ? null : resolve(projectArg);
const adapterPath = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const results = [];
results.push(await check('node', async () => { if (Number(process.versions.node.split('.')[0]) < 20) throw new Error('node'); }));
results.push(await check('config', async () => { loadConfig(process.env); }));
results.push(await check('cli', async () => { await access(join(adapterPath, 'src', 'cli.js')); }));
results.push(await check('hook-receipt', async () => {
  if (project === null) throw new Error('args');
  const receipt = JSON.parse(await readFile(join(project, '.kiro', 'tdai-memory-install.json'), 'utf8'));
  const hookSource = await readFile(join(project, '.kiro', 'hooks', 'tdai-memory.json'), 'utf8');
  if (!validReceipt(receipt) || receipt.adapter_path !== adapterPath || sha256(hookSource) !== receipt.hook_sha256 || !validHook(JSON.parse(hookSource))) throw new Error('hook');
}));
if (results.some((result) => !result)) process.exitCode = 1;
