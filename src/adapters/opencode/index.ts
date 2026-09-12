/**
 * OpenCode plugin adapter for memory-tencentdb.
 *
 * Integrates the four-layer memory system (L0→L3) into OpenCode via
 * the shared Gateway Client baseline (#316), following the approved
 * cross-platform adapter pattern.
 *
 * ## Architecture
 * OpenCode hooks/tools → createOpenCodeMemoryPlugin
 *                           │
 *                           ▼
 *                   GatewayMemoryClient (HTTP)
 *                           │
 *                           ▼
 *                   TDAI Gateway → StandaloneHostAdapter → TdaiCore
 *                           │
 *                           ▼
 *                   StandaloneLLMRunner → OpenAI API
 *
 * ## Lifecycle mapping
 * | OpenCode Hook              | Gateway Call      | Core Operation     |
 * |---------------------------|-------------------|--------------------|
 * | chat.message              | prefetch()        | handleBeforeRecall |
 * | experimental.chat.system.transform | (cached)  | appendSystemContext |
 * | event("session.idle")     | captureTurn()     | handleTurnCommitted|
 * | tool: search_memories     | searchMemories()  | searchMemories()   |
 * | tool: search_conversations| searchConversations()| searchConversations()|
 * | event("session.deleted")  | endSession()      | session cleanup    |
 * | dispose                   | endSession() all  | graceful shutdown  |
 */

import { createHash } from "node:crypto";
import { basename } from "node:path";
import type { Plugin, Hooks, PluginInput } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin/tool";

import {
  GatewayMemoryClient,
  createGatewayPlatformAdapter,
} from "../gateway-client/index.js";
import type { GatewayPlatformAdapter } from "../gateway-client/index.js";

const DEFAULT_GATEWAY_URL = "http://127.0.0.1:8420";

// ── Plugin options ───────────────────────────────────────

export interface OpenCodeMemoryPluginOptions {
  gatewayUrl?: string;
  apiKey?: string;
  userId?: string;
  timeoutMs?: number;
}

// ── Internal state types ─────────────────────────────────

interface PendingTurn {
  userMessageID: string;
  sessionID: string;
  userText: string;
  createdAt: number;
}

interface AssistantRecord {
  sessionID: string;
  completed: boolean;
  failed: boolean;
  parentID?: string;
}

// ── Workspace identity helpers ───────────────────────────

function workspaceIdentity(directory: string, worktree?: string): string {
  const root = worktree || directory || "";
  const name = basename(root) || "workspace";
  const digest = createHash("sha256").update(root).digest("hex").slice(0, 12);
  return `${name}:${digest}`;
}

function buildSessionKey(sessionID: string, directory: string, worktree?: string): string {
  return `opencode:${workspaceIdentity(directory, worktree)}:${sessionID}`;
}

function extractUserPrompt(parts: ReadonlyArray<{ type: string; text?: string; synthetic?: boolean }>): string {
  return parts
    .filter((part) => part.type === "text" && part.synthetic !== true)
    .map((part) => (typeof part.text === "string" ? part.text.trim() : ""))
    .filter(Boolean)
    .join("\n")
    .trim();
}

function envOrDefault(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

// ── Plugin factory ───────────────────────────────────────

export function createOpenCodeMemoryPlugin(options: OpenCodeMemoryPluginOptions = {}): Plugin {
  return async (input: PluginInput): Promise<Hooks> => {
    const gatewayUrl = envOrDefault(
      options.gatewayUrl ?? process.env.MEMORY_TENCENTDB_GATEWAY_URL,
      DEFAULT_GATEWAY_URL,
    );
    const apiKey = envOrDefault(
      options.apiKey ?? process.env.MEMORY_TENCENTDB_GATEWAY_API_KEY,
      "",
    );
    const userId = envOrDefault(options.userId ?? process.env.MEMORY_TENCENTDB_USER_ID, "");

    const client = new GatewayMemoryClient({
      baseUrl: gatewayUrl,
      apiKey: apiKey || undefined,
      timeoutMs: options.timeoutMs,
    });

    // ── Per-session state ─────────────────────────────

    const adapters = new Map<string, GatewayPlatformAdapter>();
    const activeSessions = new Set<string>();

    // Turn tracking
    const pendingTurns = new Map<string, PendingTurn>();          // userMessageID → PendingTurn
    const latestTurnBySession = new Map<string, string>();        // sessionID → userMessageID
    const assistantRecords = new Map<string, AssistantRecord>();  // assistantMessageID → AssistantRecord
    const assistantTextParts = new Map<string, Map<string, string>>(); // assistantMessageID → (partID → text)
    const captureInFlight = new Set<string>();

    // Stable context cache: sessionID → appendSystemContext (L3 persona + L2 scene + tools guide)
    const appendContextCache = new Map<string, string>();

    // ── Session key / adapter helpers ─────────────────

    const sessionKeyFor = (sessionID: string): string =>
      buildSessionKey(sessionID, input.directory, input.worktree);

    const getOrCreateAdapter = (sessionID: string): GatewayPlatformAdapter => {
      const existing = adapters.get(sessionID);
      if (existing) return existing;
      const adapter = createGatewayPlatformAdapter({
        client,
        platform: "opencode",
        resolveContext: () => ({
          sessionKey: sessionKeyFor(sessionID),
          sessionId: sessionID,
          userId: userId || undefined,
        }),
      });
      adapters.set(sessionID, adapter);
      return adapter;
    };

    // ── Assistant text extraction ─────────────────────

    const assistantTextFor = (messageID: string): string =>
      [...(assistantTextParts.get(messageID)?.values() ?? [])]
        .map((t) => t.trim())
        .filter(Boolean)
        .join("\n")
        .trim();

    // ── Turn matching ─────────────────────────────────

    const findMatchingTurn = (sessionID: string, parentID?: string): PendingTurn | undefined => {
      if (parentID) {
        const exact = pendingTurns.get(parentID);
        if (exact && exact.sessionID === sessionID) return exact;
      }
      const fallbackID = latestTurnBySession.get(sessionID);
      return fallbackID ? pendingTurns.get(fallbackID) : undefined;
    };

    const refreshLatestTurn = (sessionID: string): void => {
      let latest: PendingTurn | undefined;
      for (const turn of pendingTurns.values()) {
        if (turn.sessionID !== sessionID) continue;
        if (!latest || turn.createdAt >= latest.createdAt) latest = turn;
      }
      if (latest) latestTurnBySession.set(sessionID, latest.userMessageID);
      else latestTurnBySession.delete(sessionID);
    };

    // ── Capture + cleanup ─────────────────────────────

    const captureAssistant = async (messageID: string): Promise<void> => {
      if (captureInFlight.has(messageID)) return;
      const record = assistantRecords.get(messageID);
      if (!record || !record.completed || record.failed) return;

      const turn = findMatchingTurn(record.sessionID, record.parentID);
      if (!turn) return;

      const assistantText = assistantTextFor(messageID);
      if (!assistantText) return;

      captureInFlight.add(messageID);

      try {
        await getOrCreateAdapter(record.sessionID).captureTurn({
          userText: turn.userText,
          assistantText,
          messages: [
            { role: "user", content: turn.userText, timestamp: turn.createdAt },
            { role: "assistant", content: assistantText, timestamp: Date.now() },
          ],
        });
        pendingTurns.delete(turn.userMessageID);
        refreshLatestTurn(record.sessionID);
        assistantRecords.delete(messageID);
        assistantTextParts.delete(messageID);
      } catch {
        // fail-open — capture failure must not block the user
      } finally {
        captureInFlight.delete(messageID);
      }
    };

    const captureCompletedForSession = async (sessionID: string): Promise<void> => {
      const completed = [...assistantRecords.values()].filter(
        (r) => r.sessionID === sessionID && r.completed && !r.failed,
      );
      const recordByMessageID = [...assistantRecords.entries()].reduce(
        (acc, [mid, rec]) => { acc.set(mid, rec); return acc; },
        new Map<string, AssistantRecord>(),
      );
      for (const [messageID, record] of recordByMessageID) {
        if (record.sessionID === sessionID && record.completed && !record.failed) {
          await captureAssistant(messageID);
        }
      }
    };

    const dismissSessionTurns = (sessionID: string): void => {
      for (const [mid, turn] of [...pendingTurns]) {
        if (turn.sessionID === sessionID) pendingTurns.delete(mid);
      }
      for (const [mid, record] of [...assistantRecords]) {
        if (record.sessionID === sessionID) {
          assistantRecords.delete(mid);
          assistantTextParts.delete(mid);
        }
      }
      latestTurnBySession.delete(sessionID);
    };

    const endSession = async (sessionID: string): Promise<void> => {
      await captureCompletedForSession(sessionID);
      try {
        await getOrCreateAdapter(sessionID).endSession();
      } catch {
        // fail-open
      }
      adapters.delete(sessionID);
      activeSessions.delete(sessionID);
      appendContextCache.delete(sessionID);
      dismissSessionTurns(sessionID);
    };

    // ═══════════════════════════════════════════════════
    //  Hooks + Tools
    // ═══════════════════════════════════════════════════

    return {
      // ── Stable system context injection ────────────
      // Injects L3 persona + L2 scene navigation + memory tools guide
      // into the system prompt. Cacheable across turns.

      "experimental.chat.system.transform": async (hookInput, output) => {
        const sid = hookInput.sessionID;
        if (!sid) return;
        const appendCtx = appendContextCache.get(sid);
        if (appendCtx) {
          output.system.push(appendCtx);
        }
      },

      // ── Per-turn recall + L1 injection ─────────────
      // Fires when a new user message arrives. Extracts the user prompt,
      // calls the Gateway for recall, injects L1 dynamic memories as a
      // synthetic text part, and caches stable context for system.transform.

      "chat.message": async (hookInput, output) => {
        const { sessionID, messageID } = hookInput;
        const userText = extractUserPrompt(output.parts);
        if (!userText) return;

        activeSessions.add(sessionID);

        const userMessageID = output.message.id || messageID;
        if (userMessageID) {
          pendingTurns.set(userMessageID, {
            userMessageID,
            sessionID,
            userText,
            createdAt: Date.now(),
          });
          latestTurnBySession.set(sessionID, userMessageID);
        }

        try {
          const adapter = getOrCreateAdapter(sessionID);
          const recalled = await adapter.prefetch(userText);

          if (recalled.appendSystemContext) {
            appendContextCache.set(sessionID, recalled.appendSystemContext);
          }

          if (recalled.prependContext) {
            output.parts.unshift({
              type: "text",
              text: recalled.prependContext,
              synthetic: true,
            } as Record<string, unknown> as (typeof output.parts)[number]);
          }
        } catch {
          // fail-open — recall failure must not block a turn
        }
      },

      // ── Event-driven turn capture ──────────────────
      // Tracks message lifecycle events to detect assistant completion
      // and trigger captureTurn + L0→L3 pipeline.

      event: async ({ event: evt }) => {
        try {
          const properties = evt.properties as Record<string, unknown> | undefined;
          if (!properties) return;

          // ── message.updated — track assistant completion ──
          if (evt.type === "message.updated") {
            const msg = properties.info as Record<string, unknown> | undefined;
            if (!msg || !msg.id || !msg.sessionID || msg.role !== "assistant") return;

            const messageID = String(msg.id);
            const sessionID = String(msg.sessionID);
            const time = msg.time as { completed?: number } | undefined;
            const completed = Boolean(time?.completed);
            const failed = Boolean(msg.error);

            activeSessions.add(sessionID);

            assistantRecords.set(messageID, {
              sessionID,
              completed,
              failed,
              parentID: typeof msg.parentID === "string" ? msg.parentID : undefined,
            });

            if (completed && !failed) {
              await captureAssistant(messageID);
            }
            return;
          }

          // ── message.part.updated — accumulate assistant text ──
          if (evt.type === "message.part.updated") {
            const part = properties.part as Record<string, unknown> | undefined;
            if (
              !part ||
              part.type !== "text" ||
              part.synthetic === true ||
              typeof part.text !== "string"
            ) return;

            const messageID = String(part.messageID ?? "");
            const partID = String(part.id || "text");
            if (!messageID) return;

            const record = assistantRecords.get(messageID);
            if (!record || record.failed) return;

            const parts = assistantTextParts.get(messageID) ?? new Map<string, string>();
            parts.set(partID, part.text as string);
            assistantTextParts.set(messageID, parts);

            if (record.completed) {
              await captureAssistant(messageID);
            }
            return;
          }

          // ── message.removed — cleanup tracking ──
          if (evt.type === "message.removed") {
            const messageID = String(properties.messageID ?? "");
            if (!messageID) return;
            const turn = pendingTurns.get(messageID);
            if (turn) {
              pendingTurns.delete(messageID);
              refreshLatestTurn(turn.sessionID);
            }
            assistantRecords.delete(messageID);
            assistantTextParts.delete(messageID);
            captureInFlight.delete(messageID);
            return;
          }

          // ── message.part.removed — cleanup part ──
          if (evt.type === "message.part.removed") {
            const messageID = String(properties.messageID ?? "");
            const partID = String(properties.partID ?? "");
            if (messageID && partID) {
              assistantTextParts.get(messageID)?.delete(partID);
            }
            return;
          }

          // ── session.idle / session.status(idle) — capture all pending ──
          const idleSessionID =
            evt.type === "session.idle"
              ? String(properties.sessionID ?? "")
              : evt.type === "session.status" &&
                  (properties.status as { type?: string })?.type === "idle"
                ? String(properties.sessionID ?? "")
                : "";

          if (idleSessionID) {
            await captureCompletedForSession(idleSessionID);
            return;
          }

          // ── session.error — dismiss pending turns ──
          if (evt.type === "session.error") {
            const sessionID = String(properties.sessionID ?? "");
            if (sessionID) dismissSessionTurns(sessionID);
            return;
          }

          // ── session.deleted — flush & cleanup ──
          if (evt.type === "session.deleted") {
            const sessionID = String(
              properties.sessionID ?? (properties.info as { id?: string })?.id ?? "",
            );
            if (sessionID) await endSession(sessionID);
          }
        } catch {
          // fail-open — event handler errors must not affect the agent
        }
      },

      // ── Memory search tools ────────────────────────
      // Agent-callable tools for active memory retrieval.

      tool: {
        search_memories: tool({
          description:
            "Search structured memories (L1 atoms). Use for recalling user preferences, " +
            "historical events, decisions, and other key information. Returns results sorted by relevance.",
          args: {
            query: tool.schema.string().describe("Search keywords or natural language query"),
            limit: tool.schema.number().optional().default(10).describe("Max results (1-50)"),
            type: tool.schema.string().optional().describe("Filter by memory type, e.g. preference, event, decision"),
            scene: tool.schema.string().optional().describe("Filter by scene / scene block"),
          },
          execute: async (args) => {
            try {
              const result = await client.searchMemories({
                query: args.query,
                limit: args.limit,
                type: args.type,
                scene: args.scene,
              });
              return {
                output: result.results || "No relevant memories found.",
              };
            } catch (err) {
              return {
                output: `Memory search failed: ${err instanceof Error ? err.message : String(err)}`,
              };
            }
          },
        }),

        search_conversations: tool({
          description:
            "Search raw conversation transcripts (L0). Use for locating specific message text, " +
            "timeline details, and context. Can complement or cross-validate memory_search results.",
          args: {
            query: tool.schema.string().describe("Search keywords or natural language query"),
            limit: tool.schema.number().optional().default(10).describe("Max results (1-50)"),
          },
          execute: async (args, ctx) => {
            try {
              const result = await client.searchConversations({
                query: args.query,
                limit: args.limit,
                session_key: sessionKeyFor(ctx.sessionID),
              });
              return {
                output: result.results || "No relevant conversations found.",
              };
            } catch (err) {
              return {
                output: `Conversation search failed: ${err instanceof Error ? err.message : String(err)}`,
              };
            }
          },
        }),
      },

      // ── Cleanup ────────────────────────────────────
      dispose: async () => {
        const sessions = [...activeSessions];
        await Promise.allSettled(sessions.map((sid) => endSession(sid)));
      },
    };
  };
}
