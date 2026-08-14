import { createHash } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const sha256 = (source) => createHash('sha256').update(source).digest('hex');
const args = () => process.argv.length === 4 && process.argv[2] === '--project' && process.argv[3].length > 0 ? process.argv[3] : null;
const validReceipt = (value) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === 4 && value.version === 1 && value.hook_path === '.kiro/hooks/tdai-memory.json'
  && typeof value.hook_sha256 === 'string' && /^[a-f0-9]{64}$/.test(value.hook_sha256)
  && typeof value.adapter_path === 'string' && value.adapter_path.length > 0;

async function uninstall() {
  const projectArg = args(); if (projectArg === null) throw new Error('args');
  const root = resolve(projectArg); const receiptPath = join(root, '.kiro', 'tdai-memory-install.json'); const hookPath = join(root, '.kiro', 'hooks', 'tdai-memory.json');
  let receiptSource;
  try { receiptSource = await readFile(receiptPath, 'utf8'); } catch (error) { if (error?.code === 'ENOENT') return; throw error; }
  let receipt; try { receipt = JSON.parse(receiptSource); } catch { throw new Error('receipt'); }
  if (!validReceipt(receipt)) throw new Error('receipt');
  let hook; try { hook = await readFile(hookPath, 'utf8'); } catch { throw new Error('hook'); }
  if (sha256(hook) !== receipt.hook_sha256) throw new Error('changed');
  await rm(hookPath); await rm(receiptPath);
}

try { await uninstall(); process.stdout.write('tdai-memory uninstall: ok\n'); } catch { process.stderr.write('tdai-memory uninstall: refused\n'); process.exitCode = 1; }
