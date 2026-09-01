import { createHash } from "node:crypto";

import type { HookCacheRepo } from "../db/hookCacheRepo.js";
import { hasSkillQueueMarkers, stripSkillQueueBlocks } from "./skill-queue-markers.js";

export type SkillQueueStrategy = "session_init" | "every_queue" | "latest_only";

export interface SkillQueueIdentity {
  spaceId: string;
  userId: string;
  agentSource: string;
  sessionId: string;
}

interface SkillQueueSnapshot {
  queueKey: string;
  listingHash: string;
  blockText: string;
}

interface SkillQueueHistory {
  version: 1;
  revision: number;
  snapshots: SkillQueueSnapshot[];
}

interface QueueTarget {
  index: number;
  key: string;
}

const HISTORY_HOOK = "skill-queue-history-v1";
const HISTORY_SESSION_SUFFIX = "::skill-queue";
const memoryHistory = new Map<string, SkillQueueHistory>();
const sessionLocks = new Map<string, Promise<void>>();

/** Stable assets always occupy the first Responses message, as before. */
export function injectStableAssetBlock(
  body: Record<string, unknown>,
  injectionBlock: unknown,
): Record<string, unknown> {
  const input = body.input;
  if (!Array.isArray(input)) return body;
  const targetIndex = input.findIndex((item) => {
    const message = item as Record<string, unknown> | null;
    return message?.type === "message" && Array.isArray(message.content);
  });
  if (targetIndex < 0) return body;
  const newInput = [...input];
  const target = newInput[targetIndex] as Record<string, unknown>;
  newInput[targetIndex] = {
    ...target,
    content: [...(target.content as unknown[]), injectionBlock],
  };
  return { ...body, input: newInput };
}

/** Reconstruct immutable dynamic snapshots because clients replay only their own history. */
export async function injectDynamicSkillQueue(
  body: Record<string, unknown>,
  blockText: string,
  strategy: SkillQueueStrategy,
  identity: SkillQueueIdentity,
  repo: HookCacheRepo | undefined,
  buildBlock: (text: string) => unknown,
): Promise<Record<string, unknown>> {
  if (strategy === "session_init" || !hasSkillQueueMarkers(blockText)) return body;
  const targets = collectUserQueues(body.input);
  if (targets.length === 0) return body;

  if (strategy === "latest_only") {
    const current = targets.at(-1)!;
    return appendSnapshots(stripClientSkillBlocks(body), [
      { ...makeSnapshot(current.key, blockText), target: current },
    ], buildBlock);
  }

  return withSessionLock(identityKey(identity), async () => {
    const history = await loadHistory(identity, repo);
    const targetByKey = new Map(targets.map((target) => [target.key, target]));
    const visible = history.snapshots.filter((snapshot) => targetByKey.has(snapshot.queueKey));
    const current = targets.at(-1)!;
    const listingHash = hash(blockText);
    const currentSnapshots = visible.filter((snapshot) => snapshot.queueKey === current.key);
    const alreadyCurrent = currentSnapshots.some((snapshot) => snapshot.listingHash === listingHash);
    const needsSnapshot = !alreadyCurrent &&
      (currentSnapshots.length === 0 || currentSnapshots.at(-1)?.listingHash !== listingHash);

    if (needsSnapshot) visible.push(makeSnapshot(current.key, blockText));
    const nextHistory: SkillQueueHistory = {
      version: 1,
      revision: history.revision + 1,
      snapshots: visible,
    };
    await saveHistory(identity, repo, nextHistory);

    const snapshots = nextHistory.snapshots.flatMap((snapshot) => {
      const target = targetByKey.get(snapshot.queueKey);
      return target ? [{ ...snapshot, target }] : [];
    });
    return appendSnapshots(stripClientSkillBlocks(body), snapshots, buildBlock);
  });
}

function collectUserQueues(input: unknown): QueueTarget[] {
  if (!Array.isArray(input)) return [];
  const occurrences = new Map<string, number>();
  const queues: QueueTarget[] = [];
  input.forEach((item, index) => {
    const message = item as Record<string, unknown> | null;
    if (message?.type !== "message" || message.role !== "user" || !Array.isArray(message.content)) return;
    const text = stripSkillQueueBlocks(message.content.map((part) => {
      const value = (part as { text?: unknown })?.text;
      return typeof value === "string" ? value : "";
    }).join("\n")).replace(/\s+/g, " ").trim();
    const contentHash = hash(text);
    const occurrence = (occurrences.get(contentHash) ?? 0) + 1;
    occurrences.set(contentHash, occurrence);
    queues.push({ index, key: `${contentHash}:${occurrence}` });
  });
  return queues;
}

function stripClientSkillBlocks(body: Record<string, unknown>): Record<string, unknown> {
  const input = body.input;
  if (!Array.isArray(input)) return body;
  return {
    ...body,
    input: input.map((item) => {
      const message = item as Record<string, unknown> | null;
      if (!message || !Array.isArray(message.content)) return item;
      return {
        ...message,
        content: message.content.filter((part) => {
          const text = (part as { text?: unknown })?.text;
          return typeof text !== "string" || !hasSkillQueueMarkers(text);
        }),
      };
    }),
  };
}

function appendSnapshots(
  body: Record<string, unknown>,
  snapshots: Array<SkillQueueSnapshot & { target: QueueTarget }>,
  buildBlock: (text: string) => unknown,
): Record<string, unknown> {
  const input = Array.isArray(body.input) ? [...body.input] : [];
  const byIndex = new Map<number, string[]>();
  for (const snapshot of snapshots) {
    const blocks = byIndex.get(snapshot.target.index) ?? [];
    blocks.push(snapshot.blockText);
    byIndex.set(snapshot.target.index, blocks);
  }
  for (const [index, blocks] of byIndex) {
    const message = input[index] as Record<string, unknown>;
    input[index] = {
      ...message,
      content: [...(message.content as unknown[]), ...blocks.map(buildBlock)],
    };
  }
  return { ...body, input };
}

function makeSnapshot(queueKey: string, blockText: string): SkillQueueSnapshot {
  return { queueKey, listingHash: hash(blockText), blockText };
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

function identityKey(identity: SkillQueueIdentity): string {
  return [identity.spaceId, identity.userId, identity.agentSource, identity.sessionId].join(":");
}

async function loadHistory(
  identity: SkillQueueIdentity,
  repo: HookCacheRepo | undefined,
): Promise<SkillQueueHistory> {
  const key = identityKey(identity);
  const local = memoryHistory.get(key);
  const persisted = await repo?.get(
    identity.spaceId,
    identity.userId,
    identity.agentSource,
    identity.sessionId + HISTORY_SESSION_SUFFIX,
    HISTORY_HOOK,
  );
  const raw = persisted?.[0]?.content;
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as SkillQueueHistory;
      if (parsed.version === 1 && Array.isArray(parsed.snapshots)) {
        const persistedHistory = { ...parsed, revision: parsed.revision ?? 0 };
        const latest = local && local.revision > persistedHistory.revision
          ? local
          : persistedHistory;
        memoryHistory.set(key, latest);
        return latest;
      }
    } catch {
      // Corrupt persistence falls back to the in-process copy.
    }
  }
  return local ?? { version: 1, revision: 0, snapshots: [] };
}

async function saveHistory(
  identity: SkillQueueIdentity,
  repo: HookCacheRepo | undefined,
  history: SkillQueueHistory,
): Promise<void> {
  memoryHistory.set(identityKey(identity), history);
  await repo?.put(
    identity.spaceId,
    identity.userId,
    identity.agentSource,
    identity.sessionId + HISTORY_SESSION_SUFFIX,
    HISTORY_HOOK,
    [{ type: "custom", content: JSON.stringify(history) }],
  );
}

async function withSessionLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = sessionLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.then(() => current);
  sessionLocks.set(key, tail);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (sessionLocks.get(key) === tail) sessionLocks.delete(key);
  }
}

/** Test-only: simulate a Proxy process restart. */
export function __resetSkillQueueMemoryForTests(): void {
  memoryHistory.clear();
  sessionLocks.clear();
}
