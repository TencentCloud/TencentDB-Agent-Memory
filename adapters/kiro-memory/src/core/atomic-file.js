import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
const DEFAULT_LOCK_RETRY_MS = 20;
const RENAME_RETRY_ATTEMPTS = 20;
const RENAME_RETRY_DELAY_MS = 10;
const retryableRenameErrors = new Set(['EACCES', 'EBUSY', 'EPERM']);

const wait = (durationMs) => new Promise((resolve) => setTimeout(resolve, durationMs));

const isPositiveFiniteNumber = (value) => Number.isFinite(value) && value > 0;

async function releaseSessionLock(lockPath, ownerId) {
  let ownerContents;
  try {
    ownerContents = await readFile(join(lockPath, 'owner'), 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  let currentOwner;
  try {
    currentOwner = JSON.parse(ownerContents);
  } catch {
    return;
  }
  if (currentOwner?.owner_token !== ownerId) return;
  await rm(lockPath, { recursive: true, force: true });
}

export async function withSessionLock(lockPath, operation, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const retryMs = options.retryMs ?? DEFAULT_LOCK_RETRY_MS;
  if (
    !isPositiveFiniteNumber(timeoutMs)
    || !isPositiveFiniteNumber(retryMs)
  ) {
    throw new Error('Invalid session lock options');
  }

  const startedAt = Date.now();
  let acquired = false;
  let ownerId;
  try {
    await mkdir(dirname(lockPath), { recursive: true });
    while (Date.now() - startedAt < timeoutMs) {
      try {
        await mkdir(lockPath);
        ownerId = randomUUID();
        await writeFile(join(lockPath, 'owner'), `${JSON.stringify({
          owner_token: ownerId,
          pid: process.pid,
          created_at: new Date().toISOString(),
        })}\n`, { encoding: 'utf8', flag: 'wx' });
        acquired = true;
        return await operation();
      } catch (error) {
        if (ownerId !== undefined && !acquired) {
          await rm(lockPath, { recursive: true, force: true }).catch(() => {});
          ownerId = undefined;
        }
        if (error?.code !== 'EEXIST') throw error;
      }
      await wait(retryMs);
    }
    throw new Error('Session lock acquisition timed out');
  } finally {
    if (acquired) await releaseSessionLock(lockPath, ownerId);
  }
}

async function renameWithRetry(temporaryPath, targetPath) {
  let lastError;
  for (let attempt = 0; attempt < RENAME_RETRY_ATTEMPTS; attempt += 1) {
    try {
      await rename(temporaryPath, targetPath);
      return;
    } catch (error) {
      lastError = error;
      if (!retryableRenameErrors.has(error?.code) || attempt === RENAME_RETRY_ATTEMPTS - 1) {
        throw error;
      }
      await wait(RENAME_RETRY_DELAY_MS);
    }
  }
  throw lastError;
}

export async function writeJsonAtomically(targetPath, value) {
  const directory = dirname(targetPath);
  const temporaryPath = join(
    directory,
    `.${basename(targetPath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let handle;

  try {
    await mkdir(directory, { recursive: true });
    handle = await open(temporaryPath, 'wx');
    await handle.writeFile(`${JSON.stringify(value)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await renameWithRetry(temporaryPath, targetPath);
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}
