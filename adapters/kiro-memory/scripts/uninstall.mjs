import { createHash, randomUUID } from 'node:crypto';
import { link, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const sha256 = (source) => createHash('sha256').update(source).digest('hex');
const args = () => process.argv.length === 4 && process.argv[2] === '--project' && process.argv[3].length > 0 ? process.argv[3] : null;
const currentAdapterPath = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const validReceipt = (value) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === 4 && value.version === 1 && value.hook_path === '.kiro/hooks/tdai-memory.json'
  && typeof value.hook_sha256 === 'string' && /^[a-f0-9]{64}$/.test(value.hook_sha256)
  && value.adapter_path === currentAdapterPath;

const restoreNoReplace = async (quarantinePath, originalPath) => {
  try {
    await link(quarantinePath, originalPath);
    await unlink(quarantinePath);
    return 'restored';
  } catch (error) {
    if (error?.code === 'EEXIST') return 'occupied';
    throw error;
  }
};

export async function uninstallProject({ project: projectArg, afterHookQuarantined = async () => {} } = {}) {
  if (typeof projectArg !== 'string' || projectArg.length === 0) throw new Error('args');
  const root = resolve(projectArg);
  const receiptPath = join(root, '.kiro', 'tdai-memory-install.json');
  const hookPath = join(root, '.kiro', 'hooks', 'tdai-memory.json');
  const receiptQuarantine = join(root, '.kiro', `.tdai-memory-install.${randomUUID()}.quarantine`);
  const hookQuarantine = join(root, '.kiro', 'hooks', `.tdai-memory.${randomUUID()}.quarantine`);
  let receiptQuarantined = false;
  let hookQuarantined = false;
  let validated = false;

  try {
    try {
      await rename(receiptPath, receiptQuarantine);
      receiptQuarantined = true;
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }

    let receipt;
    try { receipt = JSON.parse(await readFile(receiptQuarantine, 'utf8')); } catch { throw new Error('receipt'); }
    if (!validReceipt(receipt)) throw new Error('receipt');

    try {
      await rename(hookPath, hookQuarantine);
      hookQuarantined = true;
    } catch { throw new Error('hook'); }
    await afterHookQuarantined();
    const hookSource = await readFile(hookQuarantine, 'utf8');
    if (sha256(hookSource) !== receipt.hook_sha256) throw new Error('changed');
    validated = true;

    await unlink(receiptQuarantine);
    receiptQuarantined = false;
    await unlink(hookQuarantine);
    hookQuarantined = false;
  } catch (error) {
    if (!validated) {
      try { if (hookQuarantined) await restoreNoReplace(hookQuarantine, hookPath); } catch { /* preserve quarantine on recovery failure */ }
      try { if (receiptQuarantined) await restoreNoReplace(receiptQuarantine, receiptPath); } catch { /* preserve quarantine on recovery failure */ }
    }
    throw error;
  }
}

async function uninstall() {
  const projectArg = args();
  if (projectArg === null) throw new Error('args');
  await uninstallProject({ project: projectArg });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await uninstall(); process.stdout.write('tdai-memory uninstall: ok\n'); } catch { process.stderr.write('tdai-memory uninstall: refused\n'); process.exitCode = 1; }
}
