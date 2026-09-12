#!/usr/bin/env node
/**
 * tdai-capture-hook — Claude Code Stop hook for automatic turn capture.
 *
 * Claude Code fires this script after every assistant response. The hook
 * reads the session transcript, extracts the last user/assistant exchange,
 * and appends it to a pending-queue file that ClaudeCodeMcpServer drains
 * on the next recall. This keeps the hook fast (<100 ms) and avoids any
 * SQLite concurrency conflict with the running MCP server.
 *
 * Register in .claude/settings.json:
 *   {
 *     "hooks": {
 *       "Stop": [{
 *         "hooks": [{ "type": "command", "command": "tdai-capture-hook" }]
 *       }]
 *     }
 *   }
 *
 * The hook inherits env vars from the shell, not from mcpServers.env.
 * If you set a custom TDAI_DATA_DIR for the MCP server, export it in your
 * shell profile or prefix the command:
 *   "command": "TDAI_DATA_DIR=/your/path tdai-capture-hook"
 *
 * Required env (must match the MCP server):
 *   TDAI_DATA_DIR   — defaults to ~/.tdai/claude-code if unset
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// ============================
// Types
// ============================

interface StopHookPayload {
  hook_event_name?: string;
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
}

interface ContentBlock {
  type: string;
  text?: string;
}

/** One entry appended to the pending queue. */
interface QueueEntry {
  sessionKey: string;
  userText: string;
  assistantText: string;
  ts: number;
}

// ============================
// Transcript parsing
// ============================

/**
 * Flatten a message content value to plain text.
 * Handles both string content and content-block arrays (rich messages).
 * Tool-use blocks and image blocks are silently dropped.
 */
function extractText(content: string | ContentBlock[] | undefined): string {
  if (!content) return "";
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => (b.text as string).trim())
    .filter(Boolean)
    .join("\n");
}

/**
 * Parse a single JSONL line from the Claude Code transcript.
 *
 * Claude Code uses (at minimum) two transcript shapes depending on version:
 *   Shape A (≥ 1.x):  { "type": "user"|"assistant", "message": { "role": ..., "content": ... } }
 *   Shape B (legacy): { "role": "user"|"assistant", "content": ... }
 *
 * Returns { role, text } or null if the line is not a conversation message.
 */
function parseLine(line: string): { role: string; text: string } | null {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }

  // Shape A
  if (typeof obj["type"] === "string" && obj["message"] && typeof obj["message"] === "object") {
    const msg = obj["message"] as Record<string, unknown>;
    const role = msg["role"] as string | undefined;
    if (!role) return null;
    const text = extractText(msg["content"] as string | ContentBlock[] | undefined);
    return { role, text };
  }

  // Shape B
  if (typeof obj["role"] === "string") {
    const text = extractText(obj["content"] as string | ContentBlock[] | undefined);
    return { role: obj["role"] as string, text };
  }

  return null;
}

/**
 * Scan the transcript file and return the last user+assistant pair.
 * We scan all lines and keep the most recent occurrence of each role,
 * which guarantees we get the current turn even when the file contains
 * the full session history.
 */
function extractLastTurn(
  transcriptPath: string,
): { userText: string; assistantText: string } | null {
  if (!fs.existsSync(transcriptPath)) return null;

  let raw: string;
  try {
    raw = fs.readFileSync(transcriptPath, "utf8");
  } catch {
    return null;
  }

  let lastUser = "";
  let lastAssistant = "";

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const parsed = parseLine(trimmed);
    if (!parsed) continue;

    if (parsed.role === "user" && parsed.text) {
      lastUser = parsed.text;
    } else if (parsed.role === "assistant" && parsed.text) {
      lastAssistant = parsed.text;
    }
  }

  if (!lastUser && !lastAssistant) return null;
  return { userText: lastUser, assistantText: lastAssistant };
}

// ============================
// Queue file helpers
// ============================

/**
 * Append one capture entry to the pending queue.
 * Uses appendFileSync — each JSONL line is written atomically on Linux/macOS.
 */
function enqueue(queuePath: string, entry: QueueEntry): void {
  const dir = path.dirname(queuePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(queuePath, JSON.stringify(entry) + "\n", "utf8");
}

// ============================
// Main
// ============================

function main(): void {
  // Read hook payload (Claude Code writes JSON to stdin and closes it)
  let raw = "";
  try {
    raw = fs.readFileSync("/dev/stdin", "utf8").trim();
  } catch {
    // stdin not available or empty — nothing to do
    process.exit(0);
  }

  if (!raw) process.exit(0);

  let payload: StopHookPayload;
  try {
    payload = JSON.parse(raw) as StopHookPayload;
  } catch {
    process.exit(0);
  }

  const { session_id, transcript_path } = payload;

  if (!transcript_path) {
    // Some Claude Code versions omit transcript_path — nothing we can parse
    process.exit(0);
  }

  const turn = extractLastTurn(transcript_path);
  if (!turn || (!turn.userText && !turn.assistantText)) {
    process.exit(0);
  }

  const dataDir = path.resolve(
    process.env["TDAI_DATA_DIR"] ?? path.join(os.homedir(), ".tdai", "claude-code"),
  );

  const sessionKey =
    session_id ??
    process.env["CLAUDE_CODE_SESSION_ID"] ??
    "default";

  const queuePath = path.join(dataDir, "hook-queue.jsonl");

  enqueue(queuePath, {
    sessionKey,
    userText: turn.userText,
    assistantText: turn.assistantText,
    ts: Date.now(),
  });

  process.stderr.write(
    `[tdai-hook] queued 1 turn for session=${sessionKey} ` +
    `(${turn.userText.slice(0, 40).replace(/\n/g, " ")}…)\n`,
  );

  process.exit(0);
}

main();
