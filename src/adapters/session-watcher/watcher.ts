/**
 * Session Watcher — passive auto-capture and auto-recall for agent sessions.
 *
 * Periodically polls session data via adapters. When new turns are detected:
 *   1. RECALL: On new user message → call Gateway /recall → write context file
 *   2. CAPTURE: On completed turn → call Gateway /capture with {user, assistant, session}
 *
 * The agent reads recall context from ~/.agent-memory/recall/{sessionKey}.md
 * (configured via agent system prompt).
 */

import fs from "node:fs";
import path from "node:path";
import type { TdaiMcpConfig } from "./config.js";
import type { GatewayMemoryClient } from "./gateway-client.js";
import {
  getAdapter,
  type ParsedTurn,
  type SessionAdapter,
  type SessionInfo,
} from "./adapters/base.js";
import "./adapters/opencode.js";
import "./adapters/codex.js";

interface SessionCursor {
  sessionKey: string;
  lastTimestamp: number;
  adapter: string;
}

export class SessionWatcher {
  private config: TdaiMcpConfig;
  private client: GatewayMemoryClient;
  private timer?: ReturnType<typeof setInterval>;
  private cursors: Map<string, SessionCursor> = new Map();
  /** Cached adapter instances so adapter-internal state survives across polls. */
  private adapters: Map<string, SessionAdapter> = new Map();
  /** Last user message per session waiting for an assistant response. */
  private pendingUsers: Map<string, ParsedMessage> = new Map();
  /** User messages already recalled, keyed `${adapter}:${sessionKey}`. */
  private recalledUsers: Map<string, Set<string>> = new Map();
  private running = false;

  constructor(config: TdaiMcpConfig, client: GatewayMemoryClient) {
    this.config = config;
    this.client = client;
  }

  async start(): Promise<void> {
    this.running = true;

    fs.mkdirSync(this.config.agentMemory.contextDir, { recursive: true });
    fs.mkdirSync(this.config.agentMemory.stateDir, { recursive: true });

    this.loadCursors();

    const intervalMs = this.config.watcher.pollIntervalMs;
    process.stderr.write(
      `[session-watcher] Started (interval=${intervalMs}ms, adapters=${this.config.watcher.adapters.join(",")})\n`,
    );

    this.poll().catch((err) => {
      process.stderr.write(
        `[session-watcher] Initial poll error: ${err.message}\n`,
      );
    });

    this.timer = setInterval(() => {
      this.poll().catch((err) => {
        process.stderr.write(`[session-watcher] Poll error: ${err.message}\n`);
      });
    }, intervalMs);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.saveCursors();
    process.stderr.write("[session-watcher] Stopped\n");
  }

  private async poll(): Promise<void> {
    if (!this.running) return;

    for (const adapterName of this.config.watcher.adapters) {
      let adapter = this.adapters.get(adapterName);
      if (!adapter) {
        adapter = getAdapter(adapterName);
        if (!adapter) {
          process.stderr.write(
            `[session-watcher] Unknown adapter: ${adapterName}\n`,
          );
          continue;
        }
        // Cache the instance so adapters can keep internal state (e.g. seen
        // message ids, incremental file offsets) across polling cycles.
        this.adapters.set(adapterName, adapter);
      }

      try {
        const sessions = await adapter.discoverSessions();
        for (const session of sessions) {
          await this.processSession(adapter, session);
        }
      } catch (err) {
        process.stderr.write(
          `[session-watcher] Adapter ${adapterName} error: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
    }
  }

  private async processSession(
    adapter: SessionAdapter,
    session: SessionInfo,
  ): Promise<void> {
    const cursor = this.getCursor(session.sessionKey, adapter.name);
    const newMessages = await adapter.parseNewMessages(
      session.sessionKey,
      cursor.lastTimestamp,
    );

    if (newMessages.length === 0) return;

    const lastMsg = newMessages[newMessages.length - 1];
    const newTimestamp = lastMsg.timestamp ?? Date.now();
    this.updateCursor(session.sessionKey, adapter.name, newTimestamp);

    // A user message seen on a previous poll is prepended so the assistant
    // response that arrives in THIS poll (without its user in the same batch)
    // still forms a complete turn and is captured.
    const stateKey = `${adapter.name}:${session.sessionKey}`;
    const pendingUser = this.pendingUsers.get(stateKey) ?? null;
    const combined: ParsedMessage[] = pendingUser
      ? [pendingUser, ...newMessages]
      : newMessages;

    const turns = adapter.detectTurns(combined);

    for (const turn of turns) {
      await this.doRecallOnce(turn.userMessage, stateKey, session.sessionKey);

      const assistantText = turn.assistantMessages
        .map((m) => m.content)
        .join("\n")
        .trim();
      if (assistantText) {
        await this.doCapture(
          turn.userMessage.content,
          assistantText,
          session,
        );
      }
    }

    // Track a user message with no assistant yet so recall fires before the
    // agent responds and its response is captured on a later poll.
    const pending = this.findPendingUser(combined);
    if (pending) {
      await this.doRecallOnce(pending, stateKey, session.sessionKey);
      this.pendingUsers.set(stateKey, pending);
    } else {
      this.pendingUsers.delete(stateKey);
    }
  }

  /**
   * Return the last user message that has no following non-user message
   * (i.e. a turn that is still waiting for an assistant response).
   */
  private findPendingUser(msgs: ParsedMessage[]): ParsedMessage | null {
    let pending: ParsedMessage | null = null;
    for (const m of msgs) {
      if (m.role === "user") pending = m;
      else pending = null;
    }
    return pending;
  }

  private async doRecallOnce(
    user: ParsedMessage,
    stateKey: string,
    sessionKey: string,
  ): Promise<void> {
    if (!user.content) return;
    if (user.timestamp !== undefined) {
      const seenKey = `${user.timestamp}|${user.content}`;
      let seen = this.recalledUsers.get(stateKey);
      if (!seen) {
        seen = new Set();
        this.recalledUsers.set(stateKey, seen);
      }
      if (seen.has(seenKey)) return; // already recalled (e.g. pending → completed)
      if (seen.size > 1000) seen.clear(); // bounded growth
      seen.add(seenKey);
    }
    await this.doRecall(user.content, sessionKey);
  }

  private async doRecall(
    userText: string,
    sessionKey: string,
  ): Promise<void> {
    try {
      const result = await this.client.recall({
        query: userText,
        session_key: sessionKey,
      });

      const contextFile = path.join(
        this.config.agentMemory.contextDir,
        `${sessionKey}.md`,
      );

      const content = [
        "<!-- Auto-generated by AgentMemory Session Watcher -->",
        "<!-- Read this file at the start of each conversation turn -->",
        "",
        result.context || "(no relevant memories found)",
        "",
        `_strategy: ${result.strategy ?? "unknown"}, memories: ${result.memory_count ?? 0}_`,
      ].join("\n");

      fs.writeFileSync(contextFile, content, "utf-8");
      process.stderr.write(
        `[session-watcher] RECALL: ${sessionKey} → ${contextFile} (${result.memory_count ?? 0} memories)\n`,
      );
    } catch (err) {
      process.stderr.write(
        `[session-watcher] RECALL failed for ${sessionKey}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }

  private async doCapture(
    userContent: string,
    assistantContent: string,
    session: SessionInfo,
  ): Promise<void> {
    try {
      const result = await this.client.capture({
        user_content: userContent,
        assistant_content: assistantContent,
        session_key: session.sessionKey,
        session_id: session.sessionId,
      });
      process.stderr.write(
        `[session-watcher] CAPTURE: ${session.sessionKey} → l0=${result.l0_recorded}, notified=${result.scheduler_notified}\n`,
      );
    } catch (err) {
      process.stderr.write(
        `[session-watcher] CAPTURE failed for ${session.sessionKey}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }

  private getCursor(sessionKey: string, adapter: string): SessionCursor {
    const key = `${adapter}:${sessionKey}`;
    if (this.cursors.has(key)) return this.cursors.get(key)!;
    return { sessionKey, lastTimestamp: 0, adapter };
  }

  private updateCursor(
    sessionKey: string,
    adapter: string,
    timestamp: number,
  ): void {
    const key = `${adapter}:${sessionKey}`;
    this.cursors.set(key, { sessionKey, lastTimestamp: timestamp, adapter });
  }

  private loadCursors(): void {
    const file = path.join(this.config.agentMemory.stateDir, "cursors.json");
    try {
      if (fs.existsSync(file)) {
        const data = JSON.parse(fs.readFileSync(file, "utf-8"));
        for (const [key, cursor] of Object.entries(data)) {
          this.cursors.set(key, cursor as SessionCursor);
        }
      }
    } catch {
      // Start fresh
    }
  }

  private saveCursors(): void {
    const file = path.join(this.config.agentMemory.stateDir, "cursors.json");
    const data: Record<string, SessionCursor> = {};
    const entries = [...this.cursors.entries()];

    // Evict entries older than 7 days
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const recent = entries.filter(([, c]) => c.lastTimestamp > cutoff);

    // Hard cap at 100 entries, keep most recent
    const capped = recent
      .sort((a, b) => b[1].lastTimestamp - a[1].lastTimestamp)
      .slice(0, 100);

    for (const [key, cursor] of capped) {
      data[key] = cursor;
    }

    // Drop in-memory pending-user / recall state for evicted sessions.
    const keptKeys = new Set(capped.map(([key]) => key));
    for (const key of [...this.pendingUsers.keys()]) {
      if (!keptKeys.has(key)) this.pendingUsers.delete(key);
    }
    for (const key of [...this.recalledUsers.keys()]) {
      if (!keptKeys.has(key)) this.recalledUsers.delete(key);
    }

    try {
      fs.mkdirSync(this.config.agentMemory.stateDir, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf-8");
    } catch {
      // Best effort
    }
  }
}
