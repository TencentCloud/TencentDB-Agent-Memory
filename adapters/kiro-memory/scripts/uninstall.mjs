import { createHash } from 'node:crypto';
import { access, link, lstat, mkdir, readFile, rename, rmdir, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { buildMcpEntry, publishContentNoReplace } from './install.mjs';

const sha256 = (source) => createHash('sha256').update(source).digest('hex');
const BUSY = Symbol('busy');
const args = () => process.argv.length === 4 && process.argv[2] === '--project' && process.argv[3].length > 0 ? process.argv[3] : null;
const currentAdapterPath = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const hash = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const validReceipt = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.adapter_path !== currentAdapterPath) return false;
  if (value.version === 1) return Object.keys(value).length === 4
    && value.hook_path === '.kiro/hooks/tdai-memory.json' && hash(value.hook_sha256);
  return value.version === 2 && Object.keys(value).length === 4
    && value.hook?.path === '.kiro/hooks/tdai-memory.json' && hash(value.hook?.sha256)
    && value.mcp?.path === '.kiro/settings/mcp.json' && value.mcp?.server_name === 'tdai-memory'
    && hash(value.mcp?.entry_sha256);
};

const exists = async (path) => {
  try { await access(path); return true; } catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
};

const readIfPresent = async (path, { deferBusy = false } = {}) => {
  try { return await readFile(path, 'utf8'); } catch (error) {
    if (error?.code === 'ENOENT') return null;
    if (deferBusy && error?.code === 'EPERM') return BUSY;
    throw error;
  }
};

const objectKind = async (path) => {
  try { return (await lstat(path)).isFile() ? 'regular' : 'object'; } catch (error) { if (error?.code === 'ENOENT') return 'missing'; throw error; }
};

const stageNoReplace = async (originalPath, transactionPath) => {
  const transactionKind = await objectKind(transactionPath);
  if (transactionKind === 'object') throw new Error('object');
  if (transactionKind === 'regular') return 'staged';
  const originalKind = await objectKind(originalPath);
  if (originalKind === 'object') throw new Error('object');
  if (originalKind === 'missing') return 'missing';
  try {
    await rename(originalPath, transactionPath);
    const stagedKind = await objectKind(transactionPath);
    if (stagedKind === 'object') {
      if (await objectKind(originalPath) === 'missing') {
        try { await rename(transactionPath, originalPath); } catch { /* keep the object quarantined if its path was concurrently occupied */ }
      }
      throw new Error('object');
    }
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
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try { await remove(path); return true; } catch (error) {
      if (error?.code === 'ENOENT') return true;
      const transient = error?.code === 'EPERM' || error?.code === 'EBUSY';
      if (transient && attempt < 2) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
        continue;
      }
      if (deferBusy && transient) return false;
      throw error;
    }
  }
  return false;
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

const restoreTransaction = async ({ transactionHook, hookPath, transactionMcp, mcpPath, transactionReceipt, receiptPath, transactionDirectory }) => {
  try { if (await exists(transactionHook)) await restoreNoReplace(transactionHook, hookPath); } catch { /* keep the recoverable quarantine */ }
  try { if (transactionMcp && await exists(transactionMcp)) await restoreNoReplace(transactionMcp, mcpPath); } catch { /* keep the recoverable quarantine */ }
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
  const mcpPath = join(root, '.kiro', 'settings', 'mcp.json');
  const transactionDirectory = join(root, '.kiro', '.tdai-memory-uninstall');
  const transactionReceipt = join(transactionDirectory, 'receipt.quarantine');
  const transactionHook = join(transactionDirectory, 'hook.quarantine');
  const transactionMcp = join(transactionDirectory, 'mcp.quarantine');
  const transactionMcpPublished = join(transactionDirectory, 'mcp.published');
  let mcpPublishedSource = null;
  const restore = async () => {
    if (mcpPublishedSource !== null && await exists(transactionMcp) && await exists(mcpPath)) {
      try {
        await rename(mcpPath, transactionMcpPublished);
        if (await readFile(transactionMcpPublished, 'utf8') === mcpPublishedSource) {
          await restoreNoReplace(transactionMcp, mcpPath);
          await unlinkIfPresent(transactionMcpPublished);
        } else {
          await restoreNoReplace(transactionMcpPublished, mcpPath);
        }
      } catch { /* retain transaction evidence */ }
    }
    await restoreTransaction({ transactionHook, hookPath, transactionMcp, mcpPath, transactionReceipt, receiptPath, transactionDirectory });
  };

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

  const receiptSource = await readIfPresent(transactionReceipt, { deferBusy: true });
  if (receiptSource === BUSY) return;
  if (receiptSource === null) {
    if (await exists(transactionHook)) throw new Error('receipt');
    await removeEmptyTransaction(transactionDirectory);
    return;
  }

  let receipt;
  try { receipt = JSON.parse(receiptSource); } catch {
    await restore();
    throw new Error('receipt');
  }
  if (!validReceipt(receipt)) {
    await restore();
    throw new Error('receipt');
  }

  if (receipt.version === 2 && !(await exists(transactionHook)) && !(await exists(hookPath))) {
    const currentMcp = await readIfPresent(mcpPath);
    let owned = false;
    if (currentMcp !== null) {
      try { owned = Object.hasOwn(JSON.parse(currentMcp)?.mcpServers ?? {}, 'tdai-memory'); } catch { owned = true; }
    }
    if (!owned && !(await exists(transactionMcp))) {
      await unlinkIfPresent(transactionReceipt, unlinkQuarantine);
      await removeEmptyTransaction(transactionDirectory);
      return;
    }
  }

  const hasMcpState = await exists(transactionMcp) || await exists(mcpPath);
  if (receipt.version === 2 && hasMcpState) {
    const sourcePath = await exists(transactionMcp) ? transactionMcp : mcpPath;
    let mcpSource;
    mcpSource = await readIfPresent(sourcePath, { deferBusy: true });
    if (mcpSource === BUSY || mcpSource === null) return;
    let mcp;
    try { mcp = JSON.parse(mcpSource); } catch { await restore(); throw new Error('changed'); }
    const entry = mcp?.mcpServers?.['tdai-memory'];
    const expectedEntry = buildMcpEntry(currentAdapterPath, root);
    if (!entry || sha256(JSON.stringify(entry)) !== receipt.mcp.entry_sha256
      || sha256(JSON.stringify(expectedEntry)) !== receipt.mcp.entry_sha256) {
      await restore(); throw new Error('changed');
    }
    const { ['tdai-memory']: _owned, ...remainingServers } = mcp.mcpServers;
    const modified = `${JSON.stringify({ ...mcp, mcpServers: remainingServers }, null, 2)}\n`;
    mcpPublishedSource = modified;
    let mcpStage;
    try { mcpStage = await stageNoReplace(mcpPath, transactionMcp); } catch { await restore(); throw new Error('changed'); }
    if (mcpStage === 'busy' || mcpStage === 'missing') return;
    try {
      const current = await readIfPresent(mcpPath, { deferBusy: true });
      if (current === BUSY) return;
      if (current === null) await publishContentNoReplace(mcpPath, modified);
      else if (current !== modified) throw new Error('changed');
    } catch { await restore(); throw new Error('changed'); }
  }

  let hookStage;
  try { hookStage = await stageNoReplace(hookPath, transactionHook); } catch (error) {
    await restore();
    throw error;
  }
  if (hookStage === 'busy') return;
  if (hookStage === 'missing') {
    if (receipt.version === 2) await unlinkIfPresent(transactionMcp, unlinkQuarantine);
    await unlinkIfPresent(transactionReceipt, unlinkQuarantine);
    await removeEmptyTransaction(transactionDirectory);
    return;
  }
  await afterHookStaged();
  await afterHookQuarantined();

  const hookSource = await readIfPresent(transactionHook, { deferBusy: true });
  if (hookSource === BUSY) return;
  const hookHash = receipt.version === 2 ? receipt.hook.sha256 : receipt.hook_sha256;
  if (hookSource !== null && sha256(hookSource) !== hookHash) {
    await restore();
    throw new Error('changed');
  }

  if (!(await unlinkIfPresent(transactionHook, unlinkQuarantine, true))) return;
  if (receipt.version === 2 && !(await unlinkIfPresent(transactionMcp, unlinkQuarantine, true))) return;
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
