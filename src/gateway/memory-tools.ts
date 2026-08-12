/**
 * Memory tools for the main agent (wave tdai-memory-subagents-2026-08-02, #12).
 *
 *   GET  /memory/search — search L1 memories (auth-free loopback, like /status).
 *   POST /memory/note   — write an L0 note that flows into L1 extraction
 *                         (write-gate: Bearer OR x-memory-token; JSON body).
 *
 * The pi extension exposes both as MCP tools (memory_search / memory_note).
 */

import type http from "node:http";
import type { TdaiCore } from "../core/tdai-core.js";
import type { Logger } from "../core/types.js";
import { parseJsonBody, sendJson, sendError } from "./http-utils.js";

// ============================
// /memory/search
// ============================

export interface MemorySearchRouteResponse {
  results: string;
  total: number;
  strategy: string;
  gated?: boolean;
}

export interface MemoryToolsContext {
  core: TdaiCore;
  logger: Logger;
}

/**
 * Can this gateway be trusted to answer "the memory holds nothing"?
 *
 * No, in three cases, and they are worth telling apart from an empty memory
 * only in the log: a full reindex is running, the store is degraded (a locked
 * or broken open — it serves no rows at all), or there is no store. A session
 * told "nothing found" writes down what it already knows, and that is how
 * duplicates are born (ТЗ D1e/R2/S4), so all three answer `gated` instead.
 */
function isMemoryUnreadable(ctx: MemoryToolsContext): boolean {
  const store = ctx.core.getVectorStore();
  if (!store) return true;
  if (store.isDegraded?.() ?? false) return true;
  return store.isReindexing?.() ?? false;
}

/**
 * GET /memory/search?query=&limit=&type=&scene= — auth-free loopback.
 * Reuses the same search the tdai_memory_search tool uses (executeMemorySearch
 * via TdaiCore). During a full reindex it returns an empty result (fail-open,
 * same posture as POST /search/memories).
 */
export async function handleMemorySearch(
  ctx: MemoryToolsContext,
  url: URL,
  res: http.ServerResponse,
): Promise<void> {
  const query = url.searchParams.get("query") ?? "";
  if (!query.trim()) {
    sendError(res, 400, "Missing required parameter: query");
    return;
  }
  const limitRaw = parseInt(url.searchParams.get("limit") ?? "5", 10);
  const limit = Number.isFinite(limitRaw) ? Math.min(50, Math.max(1, limitRaw)) : 5;

  if (isMemoryUnreadable(ctx)) {
    sendJson(res, 200, { results: "", total: 0, strategy: "gated", gated: true } satisfies MemorySearchRouteResponse);
    return;
  }

  try {
    const result = await ctx.core.searchMemories({
      query,
      limit,
      type: url.searchParams.get("type") ?? undefined,
      scene: url.searchParams.get("scene") ?? undefined,
    });
    const response: MemorySearchRouteResponse = {
      results: result.text,
      total: result.total,
      strategy: result.strategy,
    };
    sendJson(res, 200, response);
  } catch (err) {
    ctx.logger.warn(`[memory/search] failed: ${err instanceof Error ? err.message : String(err)}`);
    sendError(res, 500, "memory search failed");
  }
}

// ============================
// /memory/note
// ============================

export interface MemoryNoteRequest {
  /** The note text — recorded as an L0 user message and fed into L1 extraction. */
  content: string;
  /** Optional session key (default "pi-note"). */
  session_key?: string;
  /** Optional project id (git-root of cwd). */
  project_id?: string;
}

export interface MemoryNoteResponse {
  l0_recorded: number;
  scheduler_notified: boolean;
  session_key: string;
}

const NOTE_MAX_CONTENT_CHARS = 10_000;

/**
 * POST /memory/note — write-gate already ran. Records an L0 note through the
 * existing capture path (l0-recorder / auto-capture) so it lands in L1
 * extraction — the L0 capture path itself is untouched (INVARIANT nogo-l0-path).
 */
export async function handleMemoryNote(
  ctx: MemoryToolsContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const contentType = req.headers["content-type"];
  if (typeof contentType !== "string" || !contentType.toLowerCase().startsWith("application/json")) {
    sendError(res, 415, "Content-Type must be application/json");
    return;
  }

  let body: MemoryNoteRequest;
  try {
    body = await parseJsonBody<MemoryNoteRequest>(req);
  } catch {
    sendError(res, 400, "Invalid JSON body");
    return;
  }

  const content = typeof body.content === "string" ? body.content.trim() : "";
  if (!content) {
    sendError(res, 400, "Missing required field: content");
    return;
  }
  if (content.length > NOTE_MAX_CONTENT_CHARS) {
    sendError(res, 400, `content too long (max ${NOTE_MAX_CONTENT_CHARS} chars)`);
    return;
  }
  const sessionKey = typeof body.session_key === "string" && body.session_key.trim() ? body.session_key.trim() : "pi-note";
  const projectId = typeof body.project_id === "string" ? body.project_id.slice(0, 512) : "";

  // A degraded store takes the write and drops it: handleTurnCommitted still
  // answers l0_recorded=1 while nothing reaches l0_conversations, so the host
  // believes it has remembered something it has not. Refuse instead.
  if (ctx.core.getVectorStore()?.isDegraded?.() ?? true) {
    sendError(res, 503, "memory store is unavailable — the note was not recorded");
    return;
  }

  try {
    const result = await ctx.core.handleTurnCommitted({
      userText: content,
      assistantText: "",
      messages: [{ role: "user", content }],
      sessionKey,
      sessionId: sessionKey,
      // Spread (not a literal key) so the committed tree — whose CompletedTurn
      // has no projectId — typechecks; the merged I3/I4 tree consumes it.
      ...(projectId ? { projectId } : {}),
    });
    const response: MemoryNoteResponse = {
      l0_recorded: result.l0RecordedCount,
      scheduler_notified: result.schedulerNotified,
      session_key: sessionKey,
    };
    sendJson(res, 200, response);
  } catch (err) {
    ctx.logger.warn(`[memory/note] failed: ${err instanceof Error ? err.message : String(err)}`);
    sendError(res, 500, "memory note failed");
  }
}
