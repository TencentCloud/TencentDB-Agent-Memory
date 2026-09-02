import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { hostname as defaultHostname } from 'node:os';
import { basename, dirname, join } from 'node:path';

const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
const DEFAULT_LOCK_RETRY_MS = 20;
const DEFAULT_STALE_AFTER_MS = 30_000;
const DEFAULT_HEARTBEAT_MS = 5_000;
const LOCK_OWNER_VERSION = 2;
const RENAME_RETRY_ATTEMPTS = 20;
const RENAME_RETRY_DELAY_MS = 10;
const retryableRenameErrors = new Set(['EACCES', 'EBUSY', 'EPERM']);

const wait = (durationMs) => new Promise((resolve) => setTimeout(resolve, durationMs));

const isPositiveFiniteNumber = (value) => Number.isFinite(value) && value > 0;
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, keys) => isObject(value)
  && Object.keys(value).length === keys.length
  && keys.every((key) => Object.hasOwn(value, key));
const canonicalIso = (value) => typeof value === 'string'
  && !Number.isNaN(Date.parse(value))
  && new Date(value).toISOString() === value;
const validOwner = (owner) => exactKeys(owner, [
  'version', 'owner_token', 'pid', 'hostname', 'created_at', 'heartbeat_at',
])
  && owner.version === LOCK_OWNER_VERSION
  && typeof owner.owner_token === 'string' && owner.owner_token.length > 0
  && Number.isInteger(owner.pid) && owner.pid > 0
  && typeof owner.hostname === 'string' && owner.hostname.length > 0
  && canonicalIso(owner.created_at)
  && canonicalIso(owner.heartbeat_at)
  && Date.parse(owner.heartbeat_at) >= Date.parse(owner.created_at);

const defaultProcessState = (pid) => {
  try {
    process.kill(pid, 0);
    return 'alive';
  } catch (error) {
    return error?.code === 'ESRCH' ? 'dead' : 'unknown';
  }
};

export class SessionLockTimeoutError extends Error {
  constructor() {
    super('Session lock acquisition timed out');
    this.name = 'SessionLockTimeoutError';
  }
}

const readOwner = async (lockPath) => {
  let source;
  try {
    source = await readFile(join(lockPath, 'owner'), 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    try {
      await lstat(lockPath);
      return { status: 'invalid', owner: null };
    } catch (statError) {
      if (statError?.code === 'ENOENT') return { status: 'missing', owner: null };
      throw statError;
    }
  }
  let owner;
  try { owner = JSON.parse(source); } catch { return { status: 'invalid', owner: null }; }
  return validOwner(owner) ? { status: 'valid', owner } : { status: 'invalid', owner: null };
};

export async function inspectSessionLock(lockPath, {
  staleAfterMs = DEFAULT_STALE_AFTER_MS,
  nowMs = Date.now,
  currentHostname = defaultHostname(),
  getProcessState = defaultProcessState,
} = {}) {
  if (!isPositiveFiniteNumber(staleAfterMs)
    || typeof nowMs !== 'function'
    || typeof currentHostname !== 'string' || currentHostname.length === 0
    || typeof getProcessState !== 'function') throw new Error('Invalid session lock options');
  const inspected = await readOwner(lockPath);
  if (inspected.status !== 'valid') return { status: inspected.status };
  const { owner } = inspected;
  if (nowMs() - Date.parse(owner.heartbeat_at) <= staleAfterMs) return { status: 'active' };
  if (owner.hostname !== currentHostname) return { status: 'stale_unverified' };
  const state = getProcessState(owner.pid);
  if (state === 'dead') return { status: 'stale_reclaimable' };
  if (state === 'alive') return { status: 'active' };
  return { status: 'stale_unverified' };
}

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
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const nowMs = options.nowMs ?? Date.now;
  const currentHostname = options.currentHostname ?? defaultHostname();
  const getProcessState = options.getProcessState ?? defaultProcessState;
  if (
    !isPositiveFiniteNumber(timeoutMs)
    || !isPositiveFiniteNumber(retryMs)
    || !isPositiveFiniteNumber(staleAfterMs)
    || !isPositiveFiniteNumber(heartbeatMs)
    || heartbeatMs >= staleAfterMs
    || typeof nowMs !== 'function'
    || typeof currentHostname !== 'string' || currentHostname.length === 0
    || typeof getProcessState !== 'function'
    || typeof operation !== 'function'
  ) {
    throw new Error('Invalid session lock options');
  }

  const startedAt = nowMs();
  let acquired = false;
  let ownerId;
  let heartbeatTimer;
  let heartbeatPromise = Promise.resolve();
  try {
    await mkdir(dirname(lockPath), { recursive: true });
    while (nowMs() - startedAt < timeoutMs) {
      try {
        await mkdir(lockPath);
        ownerId = randomUUID();
        const acquiredAt = new Date(nowMs()).toISOString();
        const owner = {
          version: LOCK_OWNER_VERSION,
          owner_token: ownerId,
          pid: process.pid,
          hostname: currentHostname,
          created_at: acquiredAt,
          heartbeat_at: acquiredAt,
        };
        await writeFile(join(lockPath, 'owner'), `${JSON.stringify(owner)}\n`, { encoding: 'utf8', flag: 'wx' });
        acquired = true;
        heartbeatTimer = setInterval(() => {
          heartbeatPromise = heartbeatPromise.then(async () => {
            const inspected = await readOwner(lockPath);
            if (inspected.status !== 'valid' || inspected.owner.owner_token !== ownerId) return;
            await writeJsonAtomically(join(lockPath, 'owner'), {
              ...inspected.owner,
              heartbeat_at: new Date(nowMs()).toISOString(),
            });
          }).catch(() => {});
        }, heartbeatMs);
        heartbeatTimer.unref?.();
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
    throw new SessionLockTimeoutError();
  } finally {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    await heartbeatPromise;
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
