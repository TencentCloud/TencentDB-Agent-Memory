#!/usr/bin/env node
/**
 * Codex UserPromptSubmit hook: recall relevant memories from the TdaiGateway
 * and return them as additionalContext for Codex to inject.
 * Receives the hook payload as JSON on stdin. Fails silently (no output) on error.
 *
 * Zero-dependency Node.js (no bash/jq/curl) so the hook runs on any
 * platform Codex runs on — Windows included.
 */

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
  process.exit(0); // Malformed payload — nothing to recall.
}

const prompt = typeof payload.prompt === "string" ? payload.prompt : "";
const sessionId = typeof payload.session_id === "string" ? payload.session_id : "";

// Nothing to recall without a prompt; exit cleanly with no output.
if (!prompt) process.exit(0);

try {
  // Gateway /recall expects { query, session_key } (snake_case per gateway types.ts).
  const res = await fetch(new URL("/recall", GATEWAY), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: prompt, session_key: sessionId }),
    signal: AbortSignal.timeout(12000),
  });
  const body = await res.json();
  const context = typeof body.context === "string" ? body.context : "";

  if (context) {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "UserPromptSubmit",
          additionalContext: context,
        },
      }) + "\n",
    );
  }
} catch {
  // Gateway unreachable/slow — stay silent, never block the prompt.
}
process.exit(0);
