import { createHmac, randomUUID } from "node:crypto";

import type {
  ChatMessage,
  SessionResolution,
} from "./types.js";
import { canonicalizeMessage, findLastUserIndex } from "./chat-protocol.js";

interface LineageNode {
  sessionKey: string;
  children: Set<string>;
  lastSeenAt: number;
}

/**
 * Resolves stable conversation identity from otherwise stateless chat requests.
 *
 * The cumulative HMAC chain lets a later request prove that it extends a
 * previously observed transcript without persisting the transcript itself.
 * When an already-observed prefix grows through a different next message, the
 * resolver creates a new session key for that conversation branch.
 */
export class SessionLineage {
  private readonly secret: string;
  private readonly nodes = new Map<string, LineageNode>();
  private readonly maxNodes: number;

  constructor(options: { secret: string; maxNodes?: number }) {
    if (!options.secret) throw new Error("Session lineage secret must not be empty");
    this.secret = options.secret;
    this.maxNodes = options.maxNodes ?? 20_000;
  }

  resolve(
    messages: ChatMessage[],
    options: {
      namespace: string;
      explicitSessionKey?: string;
    },
  ): SessionResolution {
    const hashes = this.hashMessages(messages, options.namespace);
    const now = Date.now();
    const explicit = options.explicitSessionKey?.trim();
    let sessionKey = explicit || "";
    let forked = false;

    if (!sessionKey) {
      let matchedCount = 0;
      let matchedSession = "";
      for (let index = 0; index < hashes.length; index += 1) {
        const node = this.nodes.get(hashes[index]);
        if (!node) break;
        matchedCount = index + 1;
        matchedSession = node.sessionKey;
      }

      if (matchedCount === 0) {
        sessionKey = this.newSessionKey();
      } else if (matchedCount === hashes.length) {
        sessionKey = matchedSession;
      } else {
        const parent = this.nodes.get(hashes[matchedCount - 1]);
        const nextHash = hashes[matchedCount];
        const diverges = !!parent && parent.children.size > 0 && !parent.children.has(nextHash);
        sessionKey = diverges ? this.newSessionKey() : matchedSession;
        forked = diverges;
      }
    }

    this.recordChain(hashes, sessionKey, now);
    this.pruneIfNeeded();

    const lastUserIndex = findLastUserIndex(messages);
    const turnKey = lastUserIndex >= 0
      ? hashes[lastUserIndex]
      : hashes.at(-1) ?? this.digest(options.namespace, "empty-turn");

    return {
      sessionKey,
      turnKey,
      tailHash: hashes.at(-1) ?? this.digest(options.namespace, "empty-tail"),
      namespace: options.namespace,
      forked,
    };
  }

  /**
   * Add the upstream assistant message to the chain. This makes the next
   * request, which normally contains that assistant message in its history,
   * resolve to the same session.
   */
  commitAssistant(
    resolution: SessionResolution,
    assistantMessage: ChatMessage,
  ): string {
    const nextHash = this.digest(
      resolution.namespace,
      `${resolution.tailHash}\n${canonicalizeMessage(assistantMessage)}`,
    );
    const parent = this.nodes.get(resolution.tailHash);
    parent?.children.add(nextHash);
    this.nodes.set(nextHash, {
      sessionKey: resolution.sessionKey,
      children: this.nodes.get(nextHash)?.children ?? new Set<string>(),
      lastSeenAt: Date.now(),
    });
    this.pruneIfNeeded();
    return nextHash;
  }

  private hashMessages(messages: ChatMessage[], namespace: string): string[] {
    const hashes: string[] = [];
    let previous = this.digest(namespace, "root");
    for (const message of messages) {
      previous = this.digest(
        namespace,
        `${previous}\n${canonicalizeMessage(message)}`,
      );
      hashes.push(previous);
    }
    return hashes;
  }

  private recordChain(hashes: string[], sessionKey: string, now: number): void {
    for (let index = 0; index < hashes.length; index += 1) {
      const hash = hashes[index];
      const existing = this.nodes.get(hash);
      if (existing) {
        existing.lastSeenAt = now;
      } else {
        this.nodes.set(hash, {
          sessionKey,
          children: new Set<string>(),
          lastSeenAt: now,
        });
      }
      if (index > 0) this.nodes.get(hashes[index - 1])?.children.add(hash);
    }
  }

  private digest(namespace: string, value: string): string {
    return createHmac("sha256", this.secret)
      .update(namespace)
      .update("\0")
      .update(value)
      .digest("hex");
  }

  private newSessionKey(): string {
    return `model-proxy:${randomUUID()}`;
  }

  private pruneIfNeeded(): void {
    if (this.nodes.size <= this.maxNodes) return;
    const removeCount = this.nodes.size - this.maxNodes;
    const oldest = [...this.nodes.entries()]
      .sort((a, b) => a[1].lastSeenAt - b[1].lastSeenAt)
      .slice(0, removeCount);
    for (const [hash] of oldest) this.nodes.delete(hash);
  }
}
