/**
 * API-key scoped conversation-id fallback.
 *
 * The proxy cannot return a generated id to every agent framework, so it keeps
 * a bounded in-process active-session registry. Explicit session headers remain
 * authoritative and are merely observed so a later tool-loop request that lost
 * extra headers can still rejoin the same session.
 */
import { createHash, randomUUID } from "node:crypto";
import type { AutoConversationIdConfig } from "../types.js";
import { isFreshConversation } from "./session-key.js";

interface ActiveConversation {
  conversationId: string;
  lastSeenAt: number;
  firstMessageHash?: string;
}

export interface ConversationResolutionInput {
  explicitId: string | null;
  keyScope: string;
  messages: Array<{ role?: string; content?: unknown }>;
  config: AutoConversationIdConfig;
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (!part || typeof part !== "object") return "";
      const value = part as Record<string, unknown>;
      return typeof value.text === "string" ? value.text : "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

function firstUserMessageHash(messages: ConversationResolutionInput["messages"]): string | undefined {
  for (const message of messages) {
    if (message?.role !== "user") continue;
    const text = contentText(message.content);
    if (!text) continue;
    return createHash("sha256").update(text).digest("hex").slice(0, 20);
  }
  return undefined;
}

export class AutoConversationRegistry {
  private readonly entries = new Map<string, ActiveConversation>();
  private readonly activeByKey = new Map<string, string>();

  constructor(private readonly now: () => number = Date.now) {}

  resolve(input: ConversationResolutionInput): string | null {
    const { config, explicitId, keyScope, messages } = input;
    if (!config.enabled) return explicitId;

    const now = this.now();
    const ttlMs = config.ttlMinutes * 60_000;
    const hash = firstUserMessageHash(messages);
    const partition = config.strategy === "per-key-msg" && hash
      ? `${keyScope}:msg:${hash}`
      : keyScope;

    this.removeExpired(now, ttlMs);

    if (explicitId) {
      this.touch(partition, { conversationId: explicitId, lastSeenAt: now, firstMessageHash: hash });
      this.activeByKey.set(keyScope, partition);
      this.enforceCapacity(config.maxEntries);
      return explicitId;
    }

    let lookupKey = partition;
    let current = this.entries.get(lookupKey);

    // A pure tool-result continuation may not contain the first user message.
    // Fall back to the most recently active partition for this API key scope.
    if (!current && !hash) {
      const activeKey = this.activeByKey.get(keyScope);
      if (activeKey) {
        lookupKey = activeKey;
        current = this.entries.get(activeKey);
      }
    }

    const fresh = isFreshConversation(messages);
    const sameFirstMessage = !!current && !!hash && current.firstMessageHash === hash;
    // Rotate only when a fresh request has an actual first-message identity.
    // Anthropic tool_result continuations can contain a single role=user block
    // with no text; treating that shape as a new conversation would sever the
    // very tool loop this registry exists to preserve.
    if (!current || (fresh && !!hash && !sameFirstMessage)) {
      current = {
        conversationId: randomUUID(),
        lastSeenAt: now,
        firstMessageHash: hash,
      };
      lookupKey = partition;
    } else {
      current = { ...current, lastSeenAt: now, firstMessageHash: current.firstMessageHash ?? hash };
    }

    this.touch(lookupKey, current);
    this.activeByKey.set(keyScope, lookupKey);
    this.enforceCapacity(config.maxEntries);
    return current.conversationId;
  }

  get size(): number {
    return this.entries.size;
  }

  private touch(key: string, value: ActiveConversation): void {
    this.entries.delete(key);
    this.entries.set(key, value);
  }

  private removeExpired(now: number, ttlMs: number): void {
    for (const [key, value] of this.entries) {
      if (now - value.lastSeenAt >= ttlMs) this.entries.delete(key);
    }
    for (const [keyScope, partition] of this.activeByKey) {
      if (!this.entries.has(partition)) this.activeByKey.delete(keyScope);
    }
  }

  private enforceCapacity(maxEntries: number): void {
    while (this.entries.size > maxEntries) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (!oldest) break;
      this.entries.delete(oldest);
    }
    for (const [keyScope, partition] of this.activeByKey) {
      if (!this.entries.has(partition)) this.activeByKey.delete(keyScope);
    }
  }
}

const sharedRegistry = new AutoConversationRegistry();

export function resolveAutoConversationId(input: ConversationResolutionInput): string | null {
  return sharedRegistry.resolve(input);
}
