import { createHash } from 'node:crypto';
import { access, link, mkdir, readFile, rename, rmdir, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const sha256 = (source) => createHash('sha256').update(source).digest('hex');
const args = () => process.argv.length === 4 && process.argv[2] === '--project' && process.argv[3].length > 0 ? process.argv[3] : null;
const currentAdapterPath = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const validReceipt = (value) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === 4 && value.version === 1 && value.hook_path === '.kiro/hooks/tdai-memory.json'
  && typeof value.hook_sha256 === 'string' && /^[a-f0-9]{64}$/.test(value.hook_sha256)
  && value.adapter_path === currentAdapterPath;

const exists = async (path) => {
  try { await access(path); return true; } catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
};

const readIfPresent = async (path) => {
  try { return await readFile(path, 'utf8'); } catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
};

const stageNoReplace = async (originalPath, transactionPath) => {
  if (await exists(transactionPath)) return 'staged';
  try {
    await rename(originalPath, transactionPath);
    return 'staged';
  } catch (error) {
    if (error?.code !== 'ENOENT' && error?.code !== 'EEXIST' && error?.code !== 'EPERM') throw error;
    if (await exists(transactionPath)) return 'staged';
    if (error?.code === 'EPERM') return 'busy';
    if (error?.code !== 'ENOENT') throw error;
    return 'missing';
  }
};

const unlinkIfPresent = async (path, remove = unlink, deferBusy = false) => {
  try { await remove(path); return true; } catch (error) {
    if (error?.code === 'ENOENT') return true;
    if (deferBusy && error?.code === 'EPERM') return false;
    throw error;
  }
};

const removeEmptyTransaction = async (path) => {
  try { await rmdir(path); } catch (error) {
    if (error?.code !== 'ENOENT' && error?.code !== 'ENOTEMPTY' && error?.code !== 'EPERM') throw error;
  }
};

const restoreNoReplace = async (quarantinePath, originalPath) => {
  try {
    await link(quarantinePath, originalPath);
    await unlink(quarantinePath);
    return 'restored';
  } catch (error) {
    if (error?.code === 'EEXIST' || (error?.code === 'ENOENT' && !(await exists(quarantinePath)))) return 'occupied';
    throw error;
  }
};

const restoreTransaction = async ({ transactionHook, hookPath, transactionReceipt, receiptPath, transactionDirectory }) => {
  try { if (await exists(transactionHook)) await restoreNoReplace(transactionHook, hookPath); } catch { /* keep the recoverable quarantine */ }
  try { if (await exists(transactionReceipt)) await restoreNoReplace(transactionReceipt, receiptPath); } catch { /* keep the recoverable quarantine */ }
  await removeEmptyTransaction(transactionDirectory);
};

export async function uninstallProject({
  project: projectArg,
  afterTransactionCreated = async () => {},
  afterReceiptStaged = async () => {},
  afterHookStaged = async () => {},
  afterHookQuarantined = async () => {},
  unlinkQuarantine = unlink,
} = {}) {
  if (typeof projectArg !== 'string' || projectArg.length === 0) throw new Error('args');
  const root = resolve(projectArg);
  const receiptPath = join(root, '.kiro', 'tdai-memory-install.json');
  const hookPath = join(root, '.kiro', 'hooks', 'tdai-memory.json');
  const transactionDirectory = join(root, '.kiro', '.tdai-memory-uninstall');
  const transactionReceipt = join(transactionDirectory, 'receipt.quarantine');
  const transactionHook = join(transactionDirectory, 'hook.quarantine');

  await mkdir(transactionDirectory, { recursive: true });
  await afterTransactionCreated();

  const receiptStage = await stageNoReplace(receiptPath, transactionReceipt);
  if (receiptStage === 'busy') return;
  if (receiptStage === 'missing') {
    if (await exists(transactionHook)) throw new Error('receipt');
    await removeEmptyTransaction(transactionDirectory);
    return;
  }
  await afterReceiptStaged();

  const receiptSource = await readIfPresent(transactionReceipt);
  if (receiptSource === null) {
    if (await exists(transactionHook)) throw new Error('receipt');
    await removeEmptyTransaction(transactionDirectory);
    return;
  }

  let receipt;
  try { receipt = JSON.parse(receiptSource); } catch {
    await restoreTransaction({ transactionHook, hookPath, transactionReceipt, receiptPath, transactionDirectory });
    throw new Error('receipt');
  }
  if (!validReceipt(receipt)) {
    await restoreTransaction({ transactionHook, hookPath, transactionReceipt, receiptPath, transactionDirectory });
    throw new Error('receipt');
  }

  const hookStage = await stageNoReplace(hookPath, transactionHook);
  if (hookStage === 'busy') return;
  if (hookStage === 'missing') {
    await unlinkIfPresent(transactionReceipt, unlinkQuarantine);
    await removeEmptyTransaction(transactionDirectory);
    return;
  }
  await afterHookStaged();
  await afterHookQuarantined();

  const hookSource = await readIfPresent(transactionHook);
  if (hookSource !== null && sha256(hookSource) !== receipt.hook_sha256) {
    await restoreTransaction({ transactionHook, hookPath, transactionReceipt, receiptPath, transactionDirectory });
    throw new Error('changed');
  }

  if (!(await unlinkIfPresent(transactionHook, unlinkQuarantine, true))) return;
  if (!(await unlinkIfPresent(transactionReceipt, unlinkQuarantine, true))) return;
  await removeEmptyTransaction(transactionDirectory);
}

async function uninstall() {
  const projectArg = args();
  if (projectArg === null) throw new Error('args');
  await uninstallProject({ project: projectArg });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await uninstall(); process.stdout.write('tdai-memory uninstall: ok\n'); } catch { process.stderr.write('tdai-memory uninstall: refused\n'); process.exitCode = 1; }
}
