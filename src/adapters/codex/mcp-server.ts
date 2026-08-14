#!/usr/bin/env node

/**
 * Codex MCP adapter.
 *
 * Exposes TDAI memory reads and writes as local stdio MCP tools. stdout is
 * reserved for JSON-RPC; all operational logging goes to stderr.
 */

import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import packageJson from "../../../package.json" with { type: "json" };
import { TdaiCore } from "../../core/tdai-core.js";
import type {
  CaptureResult,
  ConversationSearchParams,
  Logger,
  MemorySearchParams,
  RecallResult,
} from "../../core/types.js";
import { loadGatewayConfig } from "../../gateway/config.js";
import { getEnv } from "../../utils/env.js";
import { CodexHostAdapter } from "./host-adapter.js";

const TAG = "[memory-tdai] [codex-mcp]";

const SERVER_INSTRUCTIONS = [
  "Use memory_recall or the search tools when durable user/project context can improve the task.",
  "Use memory_capture after a meaningful exchange to store the user's request and the verified outcome.",
  "Never store secrets, credentials, authentication tokens, or raw untrusted tool output.",
  "memory_capture is a durable write; memory_recall, memory_search, and conversation_search are read-only.",
].join(" ");

export type CodexMemoryCore = Pick<
  TdaiCore,
  | "handleBeforeRecall"
  | "handleTurnCommitted"
  | "searchMemories"
  | "searchConversations"
  | "handleSessionEnd"
>;

export interface CreateCodexMcpServerOptions {
  defaultSessionKey: string;
}

function textResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

function jsonResult(value: unknown): CallToolResult {
  return textResult(JSON.stringify(value, null, 2));
}

function errorResult(error: unknown): CallToolResult {
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [{ type: "text", text: `TDAI memory operation failed: ${message}` }],
    isError: true,
  };
}

function resolveSessionKey(requested: string | undefined, fallback: string): string {
  const value = requested?.trim();
  return value || fallback;
}

/**
 * Derive a stable, non-sensitive project key without persisting the full path.
 */
export function createDefaultCodexSessionKey(workspaceDir: string): string {
  const normalized = path.resolve(workspaceDir);
  const digest = createHash("sha256").update(normalized).digest("hex").slice(0, 12);
  return `codex:${digest}`;
}

/** Register Codex-facing tools on an MCP server. */
export function createCodexMcpServer(
  core: CodexMemoryCore,
  options: CreateCodexMcpServerOptions,
): McpServer {
  const server = new McpServer(
    {
      name: "tencentdb-agent-memory-codex",
      version: packageJson.version,
    },
    { instructions: SERVER_INSTRUCTIONS },
  );

  const sessionKeySchema = z.string().trim().min(1).max(512).optional().describe(
    "Stable conversation or project key. Uses a workspace-derived default when omitted.",
  );

  server.registerTool(
    "memory_recall",
    {
      title: "Recall relevant memory",
      description: "Recall dynamic memories and stable persona/scene context for the current task.",
      inputSchema: {
        query: z.string().trim().min(1).max(100_000).describe("Current task or question."),
        session_key: sessionKeySchema,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ query, session_key }) => {
      try {
        const sessionKey = resolveSessionKey(session_key, options.defaultSessionKey);
        const result: RecallResult = await core.handleBeforeRecall(query, sessionKey);
        const context = [result.prependContext, result.appendSystemContext]
          .filter((part): part is string => Boolean(part?.trim()))
          .join("\n\n");
        return jsonResult({
          session_key: sessionKey,
          context,
          strategy: result.recallStrategy ?? "none",
          memory_count: result.recalledL1Memories?.length ?? 0,
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "memory_search",
    {
      title: "Search structured memory",
      description: "Search L1 structured memories using the configured keyword/vector strategy.",
      inputSchema: {
        query: z.string().trim().min(1).max(100_000),
        limit: z.number().int().min(1).max(50).optional(),
        type: z.string().trim().min(1).max(128).optional(),
        scene: z.string().trim().min(1).max(256).optional(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args) => {
      try {
        const params: MemorySearchParams = args;
        const result = await core.searchMemories(params);
        return jsonResult(result);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "conversation_search",
    {
      title: "Search raw conversation memory",
      description: "Search L0 captured conversations, including data written before L1 extraction runs.",
      inputSchema: {
        query: z.string().trim().min(1).max(100_000),
        limit: z.number().int().min(1).max(50).optional(),
        session_key: sessionKeySchema,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ query, limit, session_key }) => {
      try {
        const params: ConversationSearchParams = {
          query,
          limit,
          sessionKey: resolveSessionKey(session_key, options.defaultSessionKey),
        };
        const result = await core.searchConversations(params);
        return jsonResult(result);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "memory_capture",
    {
      title: "Capture a completed exchange",
      description: "Durably write one completed Codex exchange to L0 memory and notify the extraction pipeline.",
      inputSchema: {
        user_content: z.string().trim().min(1).max(200_000).describe("The user's request or decision."),
        assistant_content: z.string().trim().min(1).max(200_000).describe(
          "The verified answer, implementation outcome, or decision to remember.",
        ),
        session_key: sessionKeySchema,
        session_id: z.string().trim().min(1).max(512).optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ user_content, assistant_content, session_key, session_id }) => {
      try {
        const sessionKey = resolveSessionKey(session_key, options.defaultSessionKey);
        const result: CaptureResult = await core.handleTurnCommitted({
          userText: user_content,
          assistantText: assistant_content,
          messages: [
            { role: "user", content: user_content },
            { role: "assistant", content: assistant_content },
          ],
          sessionKey,
          sessionId: session_id,
          startedAt: Date.now(),
        });
        return jsonResult({
          session_key: sessionKey,
          l0_recorded: result.l0RecordedCount,
          scheduler_notified: result.schedulerNotified,
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "memory_session_end",
    {
      title: "Flush session memory",
      description: "Flush pending L1 extraction work for one session before ending it.",
      inputSchema: { session_key: sessionKeySchema },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ session_key }) => {
      try {
        const sessionKey = resolveSessionKey(session_key, options.defaultSessionKey);
        await core.handleSessionEnd(sessionKey);
        return jsonResult({ session_key: sessionKey, flushed: true });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  return server;
}

export function createStderrLogger(): Logger {
  const write = (level: string, message: string) => {
    process.stderr.write(`${TAG} [${level}] ${message}\n`);
  };
  return {
    debug: (message) => write("debug", message),
    info: (message) => write("info", message),
    warn: (message) => write("warn", message),
    error: (message) => write("error", message),
  };
}

/** Start the production stdio server. */
export async function runCodexMcpServer(): Promise<void> {
  const config = loadGatewayConfig();
  const logger = createStderrLogger();
  const workspaceDir = path.resolve(getEnv("TDAI_CODEX_WORKSPACE") ?? process.cwd());
  const defaultSessionKey = getEnv("TDAI_CODEX_SESSION_KEY")?.trim()
    || createDefaultCodexSessionKey(workspaceDir);

  const hostAdapter = new CodexHostAdapter({
    dataDir: config.data.baseDir,
    workspaceDir,
    llmConfig: config.llm,
    logger,
    userId: getEnv("TDAI_CODEX_USER_ID")?.trim() || undefined,
    sessionKey: defaultSessionKey,
  });
  const core = new TdaiCore({ hostAdapter, config: config.memory });
  const server = createCodexMcpServer(core, { defaultSessionKey });
  const transport = new StdioServerTransport();
  let closing: Promise<void> | undefined;

  const shutdown = (): Promise<void> => {
    closing ??= (async () => {
      await server.close().catch(() => {});
      await core.destroy().catch((error) => {
        logger.error(`Core shutdown failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    })();
    return closing;
  };

  process.once("SIGINT", () => void shutdown().finally(() => process.exit(0)));
  process.once("SIGTERM", () => void shutdown().finally(() => process.exit(0)));
  process.stdin.once("end", () => void shutdown());

  await core.initialize();
  await server.connect(transport);
  logger.info(`Codex MCP server ready: dataDir=${config.data.baseDir}, session=${defaultSessionKey}`);
}

const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (entryPath && entryPath === fileURLToPath(import.meta.url)) {
  runCodexMcpServer().catch((error) => {
    process.stderr.write(`${TAG} fatal: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
