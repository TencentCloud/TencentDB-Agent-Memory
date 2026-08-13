import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ConversationItem } from "@tencentdb-agent-memory/memory-sdk-ts-v2";
import type { LoadedConfig } from "./types.js";

const OUTBOX_VERSION = 1;
const OUTBOX_DIRECTORY = "tdai-memory-outbox";
export const MAX_DELIVERY_ATTEMPTS = 3;

// Pi may ask for a flush at session start and again when a turn settles. A
// process-local queue prevents both calls from delivering the same file.
const activeFlushes = new Map<string, Promise<FlushResult>>();

export interface CaptureRecord {
  version: typeof OUTBOX_VERSION;
  id: string;
  createdAt: string;
  scope: string;
  sessionId: string;
  messages: ConversationItem[];
  attempts: number;
}

export interface FlushResult {
  delivered: number;
  pending: number;
  invalid: number;
  dead: number;
}

export interface OutboxOptions {
  directory?: string;
}

function defaultDirectory(): string {
  return join(getAgentDir(), OUTBOX_DIRECTORY);
}

function directoryFor(options: OutboxOptions): string {
  return options.directory ?? defaultDirectory();
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

export async function enqueueCapture(
  config: LoadedConfig,
  sessionId: string,
  messages: ConversationItem[],
  options: OutboxOptions = {},
): Promise<CaptureRecord> {
  const directory = directoryFor(options);
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
  const directory = directoryFor(options);
  const previous = activeFlushes.get(directory) ?? Promise.resolve({ delivered: 0, pending: 0, invalid: 0, dead: 0 });
  const queued = previous.catch(() => undefined).then(async () => flushOutboxOnce(config, deliver, directory));
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
): Promise<FlushResult> {
  const files = await listRecordFiles(directory);
  let delivered = 0;
  let invalid = 0;
  let pending = 0;
  let dead = 0;
  const expectedScope = scopeFor(config);

  for (const file of files) {
    const path = join(directory, file);
    const record = await readRecord(path);
    if (!record) {
      invalid += 1;
      continue;
    }
    if (record.scope !== expectedScope) {
      pending += 1;
      continue;
    }
    try {
      await deliver(record);
      await rm(path, { force: true });
      delivered += 1;
    } catch {
      const retryRecord = { ...record, attempts: record.attempts + 1 };
      await writeRecord(path, retryRecord);
      if (retryRecord.attempts >= MAX_DELIVERY_ATTEMPTS) {
        // A permanently invalid record must not block every later conversation.
        // Keep it beside the outbox for inspection rather than deleting it.
        await rename(path, `${path}.dead`);
        dead += 1;
        continue;
      }
      // Preserve FIFO while a transient failure is still eligible for retry.
      pending += 1;
      break;
    }
  }
  return { delivered, pending, invalid, dead };
}

export async function outboxCount(config: LoadedConfig, options: OutboxOptions = {}): Promise<number> {
  const directory = directoryFor(options);
  const expectedScope = scopeFor(config);
  const files = await listRecordFiles(directory);
  let count = 0;
  for (const file of files) {
    const record = await readRecord(join(directory, file));
    if (record?.scope === expectedScope) count += 1;
  }
  return count;
}
