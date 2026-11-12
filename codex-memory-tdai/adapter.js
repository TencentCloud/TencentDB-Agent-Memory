/**
 * Codex platform adapter for TDAI memory.
 *
 * Differences from the SDK defaults (Whale shape):
 *   - capture: Codex's Stop payload only carries `transcript_path`; the last
 *     user/assistant turn must be read from the transcript JSONL file.
 *   - recall output: Codex expects `hookSpecificOutput.additionalContext`
 *     instead of `decision`/`additional_context`.
 */

import { readFile } from "node:fs/promises";

import { defineAdapter } from "./vendor/tdai-sdk/index.js";

export const adapter = defineAdapter({
  name: "codex",

  // Scan the last 20 transcript lines (JSONL) for the latest user/assistant
  // turn, mirroring the gateway contract used by the Whale capture hook.
  async parseCapturePayload(payload) {
    const sessionKey = typeof payload?.session_id === "string" ? payload.session_id : "";
    const transcriptPath =
      typeof payload?.transcript_path === "string" ? payload.transcript_path : "";
    if (!transcriptPath) return null;

    let userContent = "";
    let assistantContent = "";
    try {
      const lines = (await readFile(transcriptPath, "utf-8"))
        .split("\n")
        .filter(Boolean)
        .slice(-20);
      for (const line of lines) {
        try {
          const msg = JSON.parse(line);
          if (msg.role === "user" && typeof msg.content === "string") userContent = msg.content;
          if (msg.role === "assistant" && typeof msg.content === "string")
            assistantContent = msg.content;
        } catch {
          // Skip malformed transcript lines.
        }
      }
    } catch {
      // Transcript missing/unreadable — treated as nothing to capture.
      return null;
    }

    if (!userContent && !assistantContent) return null;
    return { userContent, assistantContent, sessionKey };
  },

  formatRecallOutput(context) {
    return JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: context,
      },
    });
  },
});
