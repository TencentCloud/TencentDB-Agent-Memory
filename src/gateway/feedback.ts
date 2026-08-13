/**
 * POST /memory/feedback — agent feedback loop (wave tdai-memory-subagents-2026-08-02, #4).
 *
 * The pi extension sends the raw 80-char dedup keys of the memory fragments it
 * recalled this session (key derivation lives in tdai-memory-filter.ts:60:
 * strip `- [<cat>] ` prefix → slice(0, 80) → trim). The gateway bumps the
 * `priority` of every L1 record whose trimmed content STARTS WITH a received
 * key. Only positive reinforcement — no penalty ever.
 *
 * Feedback semantics (ТЗ §5.17):
 *   - match: `content.trim().startsWith(key)` — a key may match several
 *     records (near-duplicate cluster members diverge in the first 80 chars,
 *     so each member sends its own key and the whole cluster gets bumped when
 *     ANY member matched);
 *   - cap: +1 max per record per run (one feedback POST = one run);
 *   - only positive.
 *
 * Write route: write-gate (Bearer OR x-memory-token), Content-Type JSON (415
 * otherwise). Fail-open: an unavailable vectors.db → 500 with an error JSON.
 */

import type http from "node:http";
import path from "node:path";
import {
  parseJsonBody,
  sendJson,
  sendError,
  openWritableSqlite,
} from "./http-utils.js";
import type { Logger } from "../core/types.js";
import { notifyCommitted } from "../core/record/commit-port.js";

// ============================
// Limits (safety nets, ТЗ §5.17)
// ============================

export const FEEDBACK_MAX_KEYS = 200;
export const FEEDBACK_MAX_KEY_CHARS = 200;
/** +1 max per record per feedback run (cap). */
export const FEEDBACK_CAP_PER_RECORD = 1;

// ============================
// Pure matching
// ============================

/**
 * Match received keys against record rows. Pure + testable without a DB:
 * a record is a match when its TRIM-med content starts with a key.
 */
export function matchFeedbackKeys(
  rows: Array<{ record_id: string; content: string }>,
  keys: string[],
): string[] {
  const matched = new Set<string>();
  for (const row of rows) {
    const content = typeof row.content === "string" ? row.content.trim() : "";
    if (!content) continue;
    for (const key of keys) {
      if (content.startsWith(key)) {
        matched.add(row.record_id);
        break; // one match per record is enough
      }
    }
  }
  return [...matched];
}

/** Validate a raw feedback body. Returns an error string or null when valid. */
export function validateFeedbackBody(
  body: unknown,
): { keys: string[] } | string {
  if (!body || typeof body !== "object") return "body must be a JSON object";
  const rawKeys = (body as { keys?: unknown }).keys;
  if (!Array.isArray(rawKeys)) return "missing required field: keys (string[])";
  if (rawKeys.length > FEEDBACK_MAX_KEYS)
    return `too many keys (max ${FEEDBACK_MAX_KEYS})`;
  const keys: string[] = [];
  for (const k of rawKeys) {
    if (typeof k !== "string") return "keys must be an array of strings";
    const trimmed = k.trim();
    if (trimmed.length === 0) continue;
    if (trimmed.length > FEEDBACK_MAX_KEY_CHARS)
      return `key too long (max ${FEEDBACK_MAX_KEY_CHARS} chars)`;
    keys.push(trimmed);
  }
  return { keys };
}

// ============================
// SQLite bump
// ============================

/** Upper bound of the L1 priority scale (l1-writer.ts:46). */
const MAX_PRIORITY = 100;

export interface FeedbackBumpResult {
  matched: number;
  bumped: number;
}

/**
 * Match + bump in one read-write pass: read all L1 rows, match keys in
 * process, then UPDATE priority for each matched record — capped at +1 per
 * record per run (a record matched by several keys bumps once). Returns
 * matched/bumped counts. Throws on DB failure (caller → 500).
 */
export function bumpFeedbackPriorities(
  dbPath: string,
  keys: string[],
  capPerRecord = FEEDBACK_CAP_PER_RECORD,
): FeedbackBumpResult {
  if (keys.length === 0) return { matched: 0, bumped: 0 };
  const db = openWritableSqlite(dbPath);
  try {
    const rows = db
      .prepare("SELECT record_id, content, priority FROM l1_records")
      .all() as Array<{
      record_id: string;
      content: string;
      priority: number;
    }>;
    const matchedIds = matchFeedbackKeys(rows, keys);
    if (matchedIds.length === 0) return { matched: 0, bumped: 0 };

    // The ceiling is the extraction contract (l1-writer.ts:46): priority lives
    // in 0..100, and -1 is a sentinel for a strict global instruction, not a
    // small number — bumping it would silently turn the strictest rule into an
    // ordinary one. Without the clamp a record that keeps being confirmed
    // drifts arbitrarily high (the live tree already holds 35 rows above 100,
    // up to 481) and stops being comparable with every other record.
    const priorityById = new Map(rows.map((r) => [r.record_id, r.priority]));
    const update = db.prepare(
      "UPDATE l1_records SET priority = MIN(priority + ?, ?) WHERE record_id = ?",
    );
    let bumped = 0;
    for (const id of matchedIds) {
      const current = priorityById.get(id) ?? 0;
      // Reported as matched but not bumped: SQLite counts the row either way,
      // so the honest number has to come from the value we already read.
      if (current < 0 || current >= MAX_PRIORITY) continue;
      for (let i = 0; i < capPerRecord; i++) {
        update.run(1, MAX_PRIORITY, id);
      }
      bumped++;
    }
    // tz-03b: the only direct SQL mutation of l1_records outside the store.
    // It changes no row COUNT, but the port is about mutations, not about
    // arithmetic — leaving it out would make "all mutations pass through one
    // point" false for the one path that proves it.
    notifyCommitted({
      carrier: "l1",
      kind: "update",
      affected: bumped,
      source: "feedback",
      at: new Date().toISOString(),
    });
    return { matched: matchedIds.length, bumped };
  } finally {
    db.close();
  }
}

// ============================
// Route handler
// ============================

/** What the gateway remembers about one recall event (tz-04 C4). */
export interface RecallEventSummary {
  recallId: string;
  at: string;
  sessionKey: string;
  count: number;
}

export interface FeedbackRouteContext {
  dataDir: string;
  logger: Logger;
  /** Recent recall events, for linking a feedback to the one it came from. */
  findRecallEvent?: (recallId: string) => RecallEventSummary | undefined;
}

/**
 * POST /memory/feedback — write-gate already ran; this handler validates the
 * body, bumps priorities and reports counts. 400 on invalid body, 415 on
 * wrong Content-Type, 500 on DB failure.
 */
export async function handleMemoryFeedback(
  ctx: FeedbackRouteContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const contentType = req.headers["content-type"];
  if (
    typeof contentType !== "string" ||
    !contentType.toLowerCase().startsWith("application/json")
  ) {
    sendError(res, 415, "Content-Type must be application/json");
    return;
  }

  let body: unknown;
  try {
    body = await parseJsonBody<unknown>(req);
  } catch {
    sendError(res, 400, "Invalid JSON body");
    return;
  }

  const validated = validateFeedbackBody(body);
  if (typeof validated === "string") {
    sendError(res, 400, validated);
    return;
  }

  // The link is reported, never required: a client that sends no id (or an id
  // the gateway has already forgotten) gets exactly the old behaviour.
  const recallId = (body as { recall_id?: unknown }).recall_id;
  const linkedTo =
    typeof recallId === "string" && recallId
      ? (ctx.findRecallEvent?.(recallId) ?? null)
      : null;

  try {
    const result = bumpFeedbackPriorities(
      path.join(ctx.dataDir, "vectors.db"),
      validated.keys,
    );
    if (typeof recallId === "string" && recallId) {
      ctx.logger.info?.(
        `[memory/feedback] recall_id=${recallId} linked=${linkedTo ? "yes" : "unknown"} ` +
          `matched=${result.matched} bumped=${result.bumped}`,
      );
    }
    sendJson(res, 200, {
      received: validated.keys.length,
      matched: result.matched,
      bumped: result.bumped,
      capPerRecord: FEEDBACK_CAP_PER_RECORD,
      linkedTo,
    });
  } catch (err) {
    ctx.logger.warn(
      `[memory/feedback] bump failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    sendError(res, 500, "feedback bump failed");
  }
}
