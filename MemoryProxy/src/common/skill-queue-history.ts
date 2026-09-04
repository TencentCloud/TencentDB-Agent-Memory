import { createHash } from "node:crypto";

import type { HookCacheRepo } from "../db/hookCacheRepo.js";
import type { SkillQueueStrategy } from "../types.js";
import { hasSkillQueueMarkers, stripSkillQueueBlocks } from "./skill-queue-markers.js";

export interface SkillQueueIdentity {
  spaceId: string;
  userId: string;
  agentSource: string;
  sessionId: string;
}

interface QueueTarget {
  index: number;
  key: string;
}

export const SKILL_QUEUE_HISTORY_HOOK_PREFIX = "skill-queue-history-v1-";
const memoryHistory = new Map<string, Map<string, string>>();
const sessionLocks = new Map<string, Promise<void>>();
const MAX_MEMORY_SESSIONS = 1_000;

/** Reconstruct immutable dynamic snapshots because clients replay only their own history. */
export async function injectDynamicSkillQueue(
  body: Record<string, unknown>,
  blockText: string,
  strategy: SkillQueueStrategy,
  identity: SkillQueueIdentity,
  repo: HookCacheRepo | undefined,
  buildBlock: (text: string) => unknown,
): Promise<Record<string, unknown>> {
  if (strategy === "session_init") return body;
  const targets = collectUserQueues(body.input);
  if (targets.length === 0) return body;

  if (strategy === "latest_only") {
    if (!hasSkillQueueMarkers(blockText)) return body;
    const current = targets.at(-1)!;
    return appendSnapshots(stripClientSkillBlocks(body), [
      { blockText, target: current },
    ], buildBlock);
  }

  return withSessionLock(identityKey(identity), async () => {
    const current = targets.at(-1)!;
    const stored = await Promise.all(targets.map(async (target) => ({
      target,
      blockText: await loadSnapshot(identity, target.key, repo),
    })));
    const currentSnapshot = stored.at(-1)!;

    // A queue owns exactly one immutable snapshot. Tool loops reuse it byte-for-byte.
    if (currentSnapshot.blockText === null && hasSkillQueueMarkers(blockText)) {
      currentSnapshot.blockText = await saveSnapshot(identity, current.key, blockText, repo);
    }

    const snapshots = stored.flatMap(({ target, blockText: storedBlock }) =>
      storedBlock === null ? [] : [{ blockText: storedBlock, target }]
    );
    return appendSnapshots(stripClientSkillBlocks(body), snapshots, buildBlock);
  });
}

/** Return the current queue snapshot so callers can skip a repeated BM25 lookup. */
export async function getCurrentSkillQueueSnapshot(
  input: unknown,
  identity: SkillQueueIdentity,
  repo: HookCacheRepo | undefined,
): Promise<string | null> {
  const current = collectUserQueues(input).at(-1);
  if (!current) return null;
  return loadSnapshot(identity, current.key, repo);
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
  snapshots: Array<{ blockText: string; target: QueueTarget }>,
  buildBlock: (text: string) => unknown,
): Record<string, unknown> {
  const input = Array.isArray(body.input) ? [...body.input] : [];
  for (const snapshot of snapshots) {
    const { index } = snapshot.target;
    const message = input[index] as Record<string, unknown>;
    input[index] = {
      ...message,
      content: [...(message.content as unknown[]), buildBlock(snapshot.blockText)],
    };
  }
  return { ...body, input };
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

function identityKey(identity: SkillQueueIdentity): string {
  return JSON.stringify([identity.spaceId, identity.userId, identity.agentSource, identity.sessionId]);
}

async function loadSnapshot(
  identity: SkillQueueIdentity,
  queueKey: string,
  repo: HookCacheRepo | undefined,
): Promise<string | null> {
  const key = identityKey(identity);
  const local = memoryHistory.get(key);
  const localBlock = local?.get(queueKey);
  if (local && localBlock !== undefined) {
    touchMemoryHistory(key, local);
    return localBlock;
  }
  const persisted = await repo?.get(
    identity.spaceId,
    identity.userId,
    identity.agentSource,
    identity.sessionId,
    historyHookId(queueKey),
  );
  const raw = persisted?.[0]?.content;
  if (typeof raw === "string" && hasSkillQueueMarkers(raw)) {
    const sessionHistory = memoryHistory.get(key) ?? new Map<string, string>();
    sessionHistory.set(queueKey, raw);
    touchMemoryHistory(key, sessionHistory);
    return raw;
  }
  return null;
}

async function saveSnapshot(
  identity: SkillQueueIdentity,
  queueKey: string,
  blockText: string,
  repo: HookCacheRepo | undefined,
): Promise<string> {
  const key = identityKey(identity);
  let storedBlock = blockText;
  if (repo) {
    const inserted = await repo.putIfAbsent(
      identity.spaceId,
      identity.userId,
      identity.agentSource,
      identity.sessionId,
      historyHookId(queueKey),
      [{ type: "custom", content: blockText }],
    );
    if (!inserted) {
      const persisted = await repo.get(
        identity.spaceId,
        identity.userId,
        identity.agentSource,
        identity.sessionId,
        historyHookId(queueKey),
      );
      const winner = persisted?.[0]?.content;
      if (typeof winner === "string" && hasSkillQueueMarkers(winner)) storedBlock = winner;
    }
  }
  const sessionHistory = memoryHistory.get(key) ?? new Map<string, string>();
  sessionHistory.set(queueKey, storedBlock);
  touchMemoryHistory(key, sessionHistory);
  return storedBlock;
}

function historyHookId(queueKey: string): string {
  return `${SKILL_QUEUE_HISTORY_HOOK_PREFIX}${queueKey.replace(":", "-")}`;
}

function touchMemoryHistory(key: string, history: Map<string, string>): void {
  memoryHistory.delete(key);
  memoryHistory.set(key, history);
  if (memoryHistory.size > MAX_MEMORY_SESSIONS) {
    const oldest = memoryHistory.keys().next().value as string | undefined;
    if (oldest) memoryHistory.delete(oldest);
  }
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
