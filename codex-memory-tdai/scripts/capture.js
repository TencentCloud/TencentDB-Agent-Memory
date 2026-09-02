#!/usr/bin/env node
/**
 * Codex Stop hook: capture the last user/assistant turn from the transcript and
 * send it to the TdaiGateway for memory storage (fire-and-forget).
 * Receives the hook payload as JSON on stdin.
 *
 * Zero-dependency Node.js (no bash/jq/curl) so the hook runs on any
 * platform Codex runs on — Windows included.
 */

import { readFileSync } from "node:fs";

const GATEWAY = process.env.TDAI_GATEWAY_URL || "http://127.0.0.1:8420";

async function readStdin() {
  let data = "";
  process.stdin.setEncoding("utf-8");
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

let payload = {};
try {
  payload = JSON.parse(await readStdin());
} catch {
  process.exit(0); // Malformed payload — nothing to capture.
}

const sessionId = typeof payload.session_id === "string" ? payload.session_id : "";
const transcriptPath = typeof payload.transcript_path === "string" ? payload.transcript_path : "";

// Scan the last 20 transcript lines (JSONL) for the latest user/assistant turn,
// mirroring the gateway contract used by the Whale capture hook.
let userText = "";
let assistantText = "";
if (transcriptPath) {
  try {
    const lines = readFileSync(transcriptPath, "utf-8").split("\n").filter(Boolean).slice(-20);
    for (const line of lines) {
      try {
        const msg = JSON.parse(line);
        if (msg.role === "user" && typeof msg.content === "string") userText = msg.content;
        if (msg.role === "assistant" && typeof msg.content === "string") assistantText = msg.content;
      } catch {
        // Skip malformed transcript lines.
      }
    }
  } catch {
    // Transcript missing/unreadable — treated as nothing to capture.
  }
}

// Skip if there's nothing meaningful to capture.
if (!userText && !assistantText) process.exit(0);

try {
  // Gateway /capture expects { user_content, assistant_content, session_key }.
  await fetch(new URL("/capture", GATEWAY), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      user_content: userText,
      assistant_content: assistantText,
      session_key: sessionId,
    }),
    signal: AbortSignal.timeout(25000),
  });
} catch {
  // Fire-and-forget — capture failures must never surface to the user.
}
process.exit(0);
