/**
 * TDAI Memory MCP Server — exposes TdaiCore as a Model Context Protocol server.
 *
 * One server covers every MCP-compatible client: Claude Code, Codex, Cursor,
 * Cline, etc. The server runs as a child process spawned by the client and
 * communicates over stdio JSON-RPC.
 *
 * Tool surface (5 tools):
 *   tdai_memory_search         — L1 structured memory search
 *   tdai_conversation_search   — L0 raw conversation search
 *   tdai_recall                — auto-recall (called from host UserPromptSubmit hook)
 *   tdai_capture               — turn capture (called from host Stop hook)
 *   tdai_session_end           — session flush (called from host SessionEnd hook)
 *
 * Tools alone do not fire auto-recall/capture — MCP has no lifecycle events.
 * The host (Claude Code, Codex, etc.) must wire its own hooks to call these
 * tools at the right moments. See README.md for the host-side recipe.
 *
 * Lifecycle:
 *   1. Load config from env (mirror Gateway config, minus server section)
 *   2. Construct McpHostAdapter + TdaiCore
 *   3. await core.initialize()
 *   4. Connect MCP server via StdioServerTransport
 *   5. SIGINT/SIGTERM → bounded destroy (drain bgTasks → close stores)
 */

import path from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { TdaiCore } from "../../core/tdai-core.js";
import { SessionFilter } from "../../utils/session-filter.js";
import { initDataDirectories } from "../../utils/pipeline-factory.js";
import { parseConfig } from "../../config.js";
import type { MemoryTdaiConfig } from "../../config.js";
import type { StandaloneLLMConfig } from "../standalone/llm-runner.js";
import { normalizeDisableThinking } from "../../utils/no-think-fetch.js";
import { getEnv } from "../../utils/env.js";

import { McpHostAdapter, createStderrLogger } from "./host-adapter.js";
import type { McpHostAdapterOptions } from "./host-adapter.js";

const TAG = "[memory-tdai] [mcp-server]";
const VERSION = "0.1.0";

// Rate limiting: global token-bucket to prevent tool-call abuse.
// 20 calls per 30s window — covers normal use (~3 calls/turn × 6 turns)
// while blocking tight-loop abuse from a runaway LLM.
const RATE_WINDOW_MS = 30_000;
const MAX_CALLS_PER_WINDOW = 20;
const toolCallTimestamps: number[] = [];

/**
 * Validate session_key before it reaches file path construction.
 * Rejects path-like values that could escape the data directory.
 */
function validateSessionKey(key: string): void {
  if (!key || typeof key !== "string") throw new Error("Missing required parameter: session_key");
  if (key.length > 256) throw new Error("session_key too long (max 256 chars)");
  if (key.includes("/") || key.includes("\\") || key.includes("..")) {
    throw new Error("session_key must not contain path separators");
  }
  if (path.isAbsolute(key)) throw new Error("session_key must not be an absolute path");
}

// ============================
// MCP server entry point
// ============================

export async function startMcpServer(): Promise<void> {
  const debugEnabled = !!getEnv("TDAI_MCP_DEBUG");
  const logger = createStderrLogger(debugEnabled);

  logger.info(`${TAG} starting (v${VERSION})`);

  // ── Resolve config ────────────────────────────────────────────────────
  const cfg = loadMcpConfig();
  const dataDir = cfg.dataDir;
  const llmConfig = cfg.llm;
  const memoryConfig = cfg.memory;

  // ── Boot TdaiCore ─────────────────────────────────────────────────────
  initDataDirectories(dataDir);

  const adapterOpts: McpHostAdapterOptions = {
    dataDir,
    llmConfig,
    logger,
    defaultUserId: getEnv("TDAI_USER_ID") ?? "default_user",
  };
  const hostAdapter = new McpHostAdapter(adapterOpts);

  const sessionFilter = new SessionFilter(memoryConfig.capture.excludeAgents);
  const core = new TdaiCore({
    hostAdapter,
    config: memoryConfig,
    sessionFilter,
  });

  await core.initialize();
  logger.info(`${TAG} TdaiCore ready: dataDir=${dataDir}`);

  // ── Construct MCP server ──────────────────────────────────────────────
  const server = new Server(
    {
      name: "tdai-memory",
      version: VERSION,
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  // ── tools/list handler ────────────────────────────────────────────────
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "tdai_memory_search",
        description:
          "Search through the user's long-term structured memories (L1). " +
          "Use this when you need to recall specific information about the " +
          "user's preferences, past events, instructions, or context from " +
          "previous conversations. Returns relevant memory records ranked " +
          "by relevance.",
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "Search query describing what you want to recall about the user.",
            },
            limit: {
              type: "number",
              description: "Maximum number of results to return (default: 5, max: 20).",
            },
            type: {
              type: "string",
              enum: ["persona", "episodic", "instruction"],
              description: "Optional filter by memory type.",
            },
            scene: {
              type: "string",
              description: "Optional filter by scene name.",
            },
          },
          required: ["query"],
        },
      },
      {
        name: "tdai_conversation_search",
        description:
          "Search through past conversation history (raw L0 dialogue records). " +
          "Use this when tdai_memory_search (structured memories) doesn't have " +
          "the information you need, or when you want to find specific past " +
          "conversations, dialogue context, or exact words the user said before.",
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "Search query describing what conversation content you want to find.",
            },
            limit: {
              type: "number",
              description: "Maximum number of messages to return (default: 5, max: 20).",
            },
            session_key: {
              type: "string",
              description: "Optional: filter results to a specific session.",
            },
          },
          required: ["query"],
        },
      },
      {
        name: "tdai_recall",
        description:
          "Auto-recall relevant memories for the current user prompt. " +
          "Host hook (UserPromptSubmit) should call this BEFORE the agent " +
          "starts reasoning, then prepend the returned prepend_context to " +
          "the user's prompt. Returns both prepend_context (per-turn) and " +
          "append_system_context (persona/scene — cacheable).",
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "User's prompt text to recall memories for.",
            },
            session_key: {
              type: "string",
              description: "Session key (stable across reconnects).",
            },
          },
          required: ["query", "session_key"],
        },
      },
      {
        name: "tdai_capture",
        description:
          "Capture a completed conversation turn. Host hook (Stop) should " +
          "call this AFTER the agent has finished responding. Triggers L0 " +
          "recording + pipeline scheduling for L1/L2/L3 extraction.",
        inputSchema: {
          type: "object",
          properties: {
            user_content: {
              type: "string",
              description: "User's original message text for this turn.",
            },
            assistant_content: {
              type: "string",
              description: "Assistant's response text for this turn.",
            },
            session_key: {
              type: "string",
              description: "Session key.",
            },
            session_id: {
              type: "string",
              description: "Optional sub-session ID.",
            },
            messages: {
              type: "array",
              description: "Optional full turn messages including tool calls. If omitted, a simple [user, assistant] pair is used.",
            },
          },
          required: ["user_content", "assistant_content", "session_key"],
        },
      },
      {
        name: "tdai_session_end",
        description:
          "Notify end of a session. Flushes per-session buffered L1/L2 work. " +
          "Host hook (SessionEnd) should call this. Does NOT tear down the " +
          "server — other sessions may still be active.",
        inputSchema: {
          type: "object",
          properties: {
            session_key: {
              type: "string",
              description: "Session key to flush.",
            },
          },
          required: ["session_key"],
        },
      },
    ],
  }));

  // ── tools/call handler ────────────────────────────────────────────────
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const toolName = request.params.name;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    const startMs = Date.now();

    // Rate limiting: prevent tool-call abuse from runaway LLM loop
    const now = Date.now();
    while (toolCallTimestamps.length > 0 && now - toolCallTimestamps[0] > RATE_WINDOW_MS) {
      toolCallTimestamps.shift();
    }
    if (toolCallTimestamps.length >= MAX_CALLS_PER_WINDOW) {
      return {
        content: [{
          type: "text",
          text: `Rate limit exceeded: max ${MAX_CALLS_PER_WINDOW} tool calls per ${RATE_WINDOW_MS / 1000}s window.`,
        }],
        isError: true,
      };
    }
    toolCallTimestamps.push(now);

    try {
      switch (toolName) {
        case "tdai_memory_search": {
          const query = String(args.query ?? "");
          const limit = Math.min(Math.max(Number(args.limit) || 5, 1), 20);
          const type = typeof args.type === "string" ? args.type : undefined;
          const scene = typeof args.scene === "string" ? args.scene : undefined;
          if (!query) throw new Error("Missing required parameter: query");

          const result = await core.searchMemories({ query, limit, type, scene });
          logToolCall(logger, toolName, startMs, { total: result.total, strategy: result.strategy });
          return {
            content: [{ type: "text", text: result.text }],
          };
        }

        case "tdai_conversation_search": {
          const query = String(args.query ?? "");
          const limit = Math.min(Math.max(Number(args.limit) || 5, 1), 20);
          const sessionKey = typeof args.session_key === "string" ? args.session_key : undefined;
          if (!query) throw new Error("Missing required parameter: query");

          const result = await core.searchConversations({ query, limit, sessionKey });
          logToolCall(logger, toolName, startMs, { total: result.total });
          return {
            content: [{ type: "text", text: result.text }],
          };
        }

        case "tdai_recall": {
          const query = String(args.query ?? "");
          const sessionKey = String(args.session_key ?? "");
          if (!query || !sessionKey) {
            throw new Error("Missing required parameters: query, session_key");
          }
          validateSessionKey(sessionKey);

          const result = await core.handleBeforeRecall(query, sessionKey);
          logToolCall(logger, toolName, startMs, {
            prependLen: result.prependContext?.length ?? 0,
            appendLen: result.appendSystemContext?.length ?? 0,
            strategy: result.recallStrategy ?? "unknown",
          });
          // Return both fields so the host can decide where to inject each.
          // prependContext goes into the user message; appendSystemContext
          // goes into the system prompt (and is cacheable across turns).
          const payload = JSON.stringify({
            prepend_context: result.prependContext ?? "",
            append_system_context: result.appendSystemContext ?? "",
            strategy: result.recallStrategy ?? "unknown",
            memory_count: result.recalledL1Memories?.length ?? 0,
          });
          return {
            content: [{ type: "text", text: payload }],
          };
        }

        case "tdai_capture": {
          const userContent = String(args.user_content ?? "");
          const assistantContent = String(args.assistant_content ?? "");
          const sessionKey = String(args.session_key ?? "");
          const sessionId = typeof args.session_id === "string" ? args.session_id : undefined;
          if (!userContent || !assistantContent || !sessionKey) {
            throw new Error("Missing required parameters: user_content, assistant_content, session_key");
          }
          validateSessionKey(sessionKey);

          // Accept optional messages[] so the host can pass the full turn
          // history including tool-call messages (not just user + assistant).
          // When omitted, fall back to a simple [user, assistant] pair.
          const rawMessages = args.messages;
          const messages: unknown[] = Array.isArray(rawMessages) && rawMessages.length > 0
            ? rawMessages as unknown[]
            : [
                { role: "user", content: userContent },
                { role: "assistant", content: assistantContent },
              ];

          const result = await core.handleTurnCommitted({
            userText: userContent,
            assistantText: assistantContent,
            messages,
            sessionKey,
            sessionId,
          });
          logToolCall(logger, toolName, startMs, {
            l0Recorded: result.l0RecordedCount,
            schedulerNotified: result.schedulerNotified,
          });
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                l0_recorded: result.l0RecordedCount,
                scheduler_notified: result.schedulerNotified,
                l0_vectors_written: result.l0VectorsWritten,
              }),
            }],
          };
        }

        case "tdai_session_end": {
          const sessionKey = String(args.session_key ?? "");
          if (!sessionKey) throw new Error("Missing required parameter: session_key");
          validateSessionKey(sessionKey);

          await core.handleSessionEnd(sessionKey);
          logToolCall(logger, toolName, startMs, { flushed: true });
          return {
            content: [{ type: "text", text: JSON.stringify({ flushed: true }) }],
          };
        }

        default:
          throw new Error(`Unknown tool: ${toolName}`);
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error(`${TAG} [tool] ${toolName} failed (${Date.now() - startMs}ms): ${errMsg}`);
      return {
        content: [{ type: "text", text: `Tool call failed: ${errMsg}` }],
        isError: true,
      };
    }
  });

  // ── Connect via stdio transport ───────────────────────────────────────
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info(`${TAG} MCP server connected on stdio`);

  // ── Signal-driven teardown ────────────────────────────────────────────
  const SHUTDOWN_TIMEOUT_MS = 5_000;
  let shuttingDown = false;

  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`${TAG} received ${signal}, shutting down...`);

    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        (async () => {
          await server.close();
          await core.destroy();
        })(),
        new Promise<never>((_, reject) => {
          timeoutId = setTimeout(
            () => reject(new Error("shutdown timeout")),
            SHUTDOWN_TIMEOUT_MS,
          );
        }),
      ]);
      logger.info(`${TAG} shutdown complete`);
    } catch (err) {
      logger.warn(
        `${TAG} shutdown timed out: ${err instanceof Error ? err.message : String(err)}` +
        ` — flushing VectorStore before forced exit`,
      );
      // Best-effort: close the VectorStore handle so SQLite WAL is checkpointed
      // before we hard-exit. core.destroy() does this on the happy path; on the
      // timeout path we do it manually to minimise data-loss window.
      try { core.getVectorStore()?.close(); } catch { /* ignore */ }
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
      process.exit(0);
    }
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

// ============================
// Helpers
// ============================

function logToolCall(
  logger: ReturnType<typeof createStderrLogger>,
  toolName: string,
  startMs: number,
  details: Record<string, unknown>,
): void {
  const elapsed = Date.now() - startMs;
  const detailStr = Object.entries(details)
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");
  logger.info(`${TAG} [tool] ${toolName} ok (${elapsed}ms): ${detailStr}`);
}

// ============================
// Config loading (env-only, mirrors loadGatewayConfig minus server block)
// ============================

interface McpServerConfig {
  dataDir: string;
  llm: StandaloneLLMConfig;
  memory: MemoryTdaiConfig;
}

function loadMcpConfig(): McpServerConfig {
  const home = getEnv("HOME") ?? getEnv("USERPROFILE") ?? "/tmp";

  // Data dir — same defaults as Gateway so MCP server reads the same data
  // when the user runs both on the same machine.
  const root = getEnv("MEMORY_TENCENTDB_ROOT") ?? path.join(home, ".memory-tencentdb");
  const defaultDataDir = path.join(root, "memory-tdai");
  const rawBaseDir = getEnv("TDAI_DATA_DIR") ?? defaultDataDir;
  const dataDir = rawBaseDir.startsWith("~/")
    ? path.join(home, rawBaseDir.slice(2))
    : rawBaseDir;

  // LLM config — same env vars as Gateway.
  const llm: StandaloneLLMConfig = {
    baseUrl: getEnv("TDAI_LLM_BASE_URL") ?? "https://api.openai.com/v1",
    apiKey: getEnv("TDAI_LLM_API_KEY") ?? "",
    model: getEnv("TDAI_LLM_MODEL") ?? "gpt-4o",
    maxTokens: parseInt(getEnv("TDAI_LLM_MAX_TOKENS") ?? "4096", 10),
    timeoutMs: parseInt(getEnv("TDAI_LLM_TIMEOUT_MS") ?? "120000", 10),
    disableThinking: normalizeDisableThinking(
      (getEnv("TDAI_LLM_DISABLE_THINKING") ?? false) as boolean | string,
    ),
  };

  // Memory config — start with plugin defaults; user can override via
  // TDAI_MEMORY_CONFIG env (JSON string) if they need fine-grained control.
  let memoryRaw: Record<string, unknown> = {};
  const memoryEnv = getEnv("TDAI_MEMORY_CONFIG");
  if (memoryEnv) {
    try {
      const parsed = JSON.parse(memoryEnv);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        memoryRaw = parsed as Record<string, unknown>;
      }
    } catch {
      // Silently fall back to defaults — bad JSON should not block startup.
    }
  }
  const memory = parseConfig(memoryRaw);

  return { dataDir, llm, memory };
}

// ============================
// Bootstrap when run directly
// ============================

startMcpServer().catch((err) => {
  process.stderr.write(
    `${TAG} FATAL: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`,
  );
  process.exit(1);
});
