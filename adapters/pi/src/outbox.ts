import { mkdir, readdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ConversationItem } from "@tencentdb-agent-memory/memory-sdk-ts-v2";
import type { LoadedConfig } from "./types.js";

const OUTBOX_VERSION = 1;
const OUTBOX_DIRECTORY = "tdai-memory-outbox";
export const MAX_DELIVERY_ATTEMPTS = 3;
export const DEFAULT_LEASE_TIMEOUT_MS = 60_000;

// Pi may ask for a flush at session start and again when a turn settles. This
// queue removes duplicate work inside one process; atomic record leases below
// also protect independent Pi processes sharing the same agent directory.
const activeFlushes = new Map<string, Promise<FlushResult>>();

export interface CaptureRecord {
  version: typeof OUTBOX_VERSION;
  id: string;
  createdAt: string;
  scope: string;
  sessionId: string;
  messages: ConversationItem[];
  attempts: number;
  nextAttemptAt?: string;
}

export interface FlushResult {
  delivered: number;
  pending: number;
  invalid: number;
  dead: number;
}

export interface OutboxOptions {
  directory?: string;
  /** Internal/test hook. Production callers use the current time. */
  now?: () => Date;
  /** Internal/test hook. Production uses bounded exponential backoff. */
  retryDelayMs?: (attempts: number) => number;
  /** A claim left by a crashed process becomes recoverable after this period. */
  leaseTimeoutMs?: number;
}

async function defaultDirectory(): Promise<string> {
  // Loaded lazily so importing this module (e.g. from an isolated test
  // subprocess) does not pull in the full Pi extension runtime.
  const { getAgentDir } = await import("@earendil-works/pi-coding-agent");
  return join(getAgentDir(), OUTBOX_DIRECTORY);
}

async function directoryFor(options: OutboxOptions): Promise<string> {
  return options.directory ?? (await defaultDirectory());
}

function scopeFor(config: LoadedConfig): string {
  return JSON.stringify({
    endpoint: config.endpoint,
    serviceId: config.serviceId,
    teamId: config.teamId,
    agentId: config.agentId,
    userId: config.userId,
  });
}

function isConversationItem(value: unknown): value is ConversationItem {
  return Boolean(
    value &&
      typeof value === "object" &&
      ["user", "assistant", "system"].includes((value as { role?: unknown }).role as string) &&
      typeof (value as { content?: unknown }).content === "string",
  );
}

function parseRecord(value: unknown): CaptureRecord | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Partial<CaptureRecord>;
  if (
    candidate.version !== OUTBOX_VERSION ||
    typeof candidate.id !== "string" ||
    typeof candidate.createdAt !== "string" ||
    typeof candidate.scope !== "string" ||
    typeof candidate.sessionId !== "string" ||
    !Array.isArray(candidate.messages) ||
    candidate.messages.length === 0 ||
    !candidate.messages.every(isConversationItem)
  ) {
    return undefined;
  }
  const attempts = candidate.attempts ?? 0;
  if (!Number.isSafeInteger(attempts) || attempts < 0) return undefined;
  if (
    candidate.nextAttemptAt !== undefined &&
    (typeof candidate.nextAttemptAt !== "string" || Number.isNaN(Date.parse(candidate.nextAttemptAt)))
  ) {
    return undefined;
  }
  return { ...candidate, attempts } as CaptureRecord;
}

async function listRecordFiles(directory: string): Promise<string[]> {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function listLeasedRecordFiles(directory: string): Promise<string[]> {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.includes(".json.lease-"))
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function readRecord(path: string): Promise<CaptureRecord | undefined> {
  try {
    return parseRecord(JSON.parse(await readFile(path, "utf8")) as unknown);
  } catch {
    return undefined;
  }
}

async function writeRecord(path: string, record: CaptureRecord): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await rename(temporary, path);
}

function retryDelayMs(attempts: number, options: OutboxOptions): number {
  if (options.retryDelayMs) return Math.max(0, options.retryDelayMs(attempts));
  return Math.min(30_000, 1_000 * 2 ** Math.max(0, attempts - 1));
}

function leasePathFor(path: string, claimedAtMs: number): string {
  // The claim time is embedded in the filename because rename() preserves the
  // record's original mtime: without it, a record that sat in the outbox past
  // the lease timeout would carry that stale age into its lease and look
  // reclaimable to a concurrent flusher the moment it is claimed.
  return `${path}.lease-${process.pid}-${claimedAtMs}-${randomUUID()}`;
}

function claimedAtFromLeasePath(leasePath: string): number | undefined {
  const match = /\.json\.lease-\d+-(\d+)-/.exec(leasePath);
  if (!match) return undefined;
  const claimedAt = Number(match[1]);
  return Number.isFinite(claimedAt) && claimedAt > 0 ? claimedAt : undefined;
}

function originalPathForLease(path: string): string | undefined {
  const marker = path.indexOf(".json.lease-");
  return marker === -1 ? undefined : path.slice(0, marker + ".json".length);
}

async function restoreLease(leasePath: string, recordPath: string): Promise<void> {
  try {
    await rename(leasePath, recordPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function reclaimExpiredLeases(directory: string, now: Date, options: OutboxOptions): Promise<void> {
  const timeoutMs = options.leaseTimeoutMs ?? DEFAULT_LEASE_TIMEOUT_MS;
  for (const name of await listLeasedRecordFiles(directory)) {
    const leasePath = join(directory, name);
    const recordPath = originalPathForLease(leasePath);
    if (!recordPath) continue;
    try {
      // A lease is alive while its claim stamp (embedded atomically in the
      // filename at claim time) is fresh, OR while a delivery heartbeat keeps
      // refreshing its mtime. Only restore when both have gone stale - i.e.
      // the holder crashed without renewing its lease.
      const claimedAt = claimedAtFromLeasePath(leasePath);
      const metadata = await stat(leasePath);
      const nowMs = now.getTime();
      const live = (claimedAt !== undefined && nowMs - claimedAt < timeoutMs) || nowMs - metadata.mtimeMs < timeoutMs;
      if (live) continue;
      await restoreLease(leasePath, recordPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

export async function enqueueCapture(
  config: LoadedConfig,
  sessionId: string,
  messages: ConversationItem[],
  options: OutboxOptions = {},
): Promise<CaptureRecord> {
  const directory = await directoryFor(options);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const record: CaptureRecord = {
    version: OUTBOX_VERSION,
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    scope: scopeFor(config),
    sessionId,
    messages,
    attempts: 0,
  };
  const target = join(directory, `${record.createdAt.replaceAll(":", "-")}-${record.id}.json`);
  await writeRecord(target, record);
  return record;
}

export async function flushOutbox(
  config: LoadedConfig,
  deliver: (record: CaptureRecord) => Promise<void>,
  options: OutboxOptions = {},
): Promise<FlushResult> {
  const directory = await directoryFor(options);
  const previous = activeFlushes.get(directory) ?? Promise.resolve({ delivered: 0, pending: 0, invalid: 0, dead: 0 });
  const queued = previous.catch(() => undefined).then(async () => flushOutboxOnce(config, deliver, directory, options));
  activeFlushes.set(directory, queued);
  void queued.finally(() => {
    if (activeFlushes.get(directory) === queued) activeFlushes.delete(directory);
  });
  return queued;
}

async function flushOutboxOnce(
  config: LoadedConfig,
  deliver: (record: CaptureRecord) => Promise<void>,
  directory: string,
  options: OutboxOptions,
): Promise<FlushResult> {
  const now = options.now?.() ?? new Date();
  await reclaimExpiredLeases(directory, now, options);
  const files = await listRecordFiles(directory);
  let delivered = 0;
  let invalid = 0;
  let pending = 0;
  let dead = 0;
  const expectedScope = scopeFor(config);

  for (const file of files) {
    const path = join(directory, file);
    // Claim now, not from the loop-start `now`: a delay before this record's
    // turn (a slow lease reclaim, an earlier record's failed delivery) could
    // otherwise exceed the lease timeout and stamp a stale claim time.
    const claimedAtMs = (options.now?.() ?? new Date()).getTime();
    const leasedPath = leasePathFor(path, claimedAtMs);
    try {
      // Same-filesystem rename is atomic: only one independent Pi process can
      // claim this record before making a network request.
      await rename(path, leasedPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }

    // rename() preserves the record's mtime, so a record that sat in the
    // outbox past the lease timeout would carry that stale age into its lease
    // and look reclaimable to a concurrent flusher the moment it is claimed.
    // Stamp the lease with the claim time so its age is measured from the
    // claim, not from the original enqueue.
    try {
      await utimes(leasedPath, new Date(claimedAtMs), new Date(claimedAtMs));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    const record = await readRecord(leasedPath);
    if (!record) {
      invalid += 1;
      await restoreLease(leasedPath, path);
      continue;
    }
    if (record.scope !== expectedScope) {
      pending += 1;
      await restoreLease(leasedPath, path);
      continue;
    }
    if (record.nextAttemptAt && Date.parse(record.nextAttemptAt) > now.getTime()) {
      pending += 1;
      await restoreLease(leasedPath, path);
      break;
    }
    // A delivery that outlives the lease timeout must keep renewing the lease
    // so a concurrent flusher cannot reclaim the record mid-flight. The
    // heartbeat refreshes the lease's mtime every third of the timeout.
    const timeoutMs = options.leaseTimeoutMs ?? DEFAULT_LEASE_TIMEOUT_MS;
    const heartbeatMs = Math.max(1, Math.floor(timeoutMs / 3));
    const heartbeat = setInterval(async () => {
      try {
        await utimes(leasedPath, new Date(), new Date());
      } catch {
        // Lease already gone (removed or reclaimed): nothing left to renew.
      }
    }, heartbeatMs);
    try {
      await deliver(record);
      await rm(leasedPath, { force: true });
      delivered += 1;
    } catch {
      const attempts = record.attempts + 1;
      if (attempts >= MAX_DELIVERY_ATTEMPTS) {
        // A permanently failing record must not block every later conversation.
        // Keep it beside the outbox for inspection rather than deleting it.
        await rename(leasedPath, `${path}.dead`);
        dead += 1;
        continue;
      }
      const retryRecord: CaptureRecord = {
        ...record,
        attempts,
        nextAttemptAt: new Date(now.getTime() + retryDelayMs(attempts, options)).toISOString(),
      };
      await writeRecord(leasedPath, retryRecord);
      await restoreLease(leasedPath, path);
      // Preserve FIFO while a transient failure is still eligible for retry.
      pending += 1;
      break;
    } finally {
      clearInterval(heartbeat);
    }
  }
  return { delivered, pending, invalid, dead };
}

export async function outboxCount(config: LoadedConfig, options: OutboxOptions = {}): Promise<number> {
  const directory = await directoryFor(options);
  const expectedScope = scopeFor(config);
  const files = [...await listRecordFiles(directory), ...await listLeasedRecordFiles(directory)];
  let count = 0;
  for (const file of files) {
    const record = await readRecord(join(directory, file));
    if (record?.scope === expectedScope) count += 1;
  }
  return count;
}
