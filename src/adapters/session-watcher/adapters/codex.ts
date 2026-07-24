/**
 * Codex Session Adapter — reads ~/.codex/sessions/**\/rollout-*.jsonl (READ-ONLY).
 *
 * Codex writes each session as a JSONL file where each line is an event:
 *   {"type":"session_meta","payload":{"cwd":"...","id":"..."}}
 *   {"type":"response_item","payload":{"type":"message","role":"...","content":[...]}}
 *   {"type":"response_item","payload":{"type":"function_call","name":"...","arguments":"..."}}
 */

import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import type {
  SessionAdapter,
  SessionInfo,
  ParsedMessage,
  ParsedTurn,
} from "./base.js";
import { registerAdapter } from "./base.js";

const SESSIONS_DIR = path.join(os.homedir(), ".codex", "sessions");

function findRolloutFiles(): string[] {
  const results: string[] = [];
  if (!fs.existsSync(SESSIONS_DIR)) return results;

  function walk(dir: string) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.startsWith("rollout-") && entry.name.endsWith(".jsonl")) {
        results.push(full);
      }
    }
  }
  walk(SESSIONS_DIR);
  return results;
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (typeof part === "object" && part !== null) {
          const p = part as Record<string, unknown>;
          return String(p.text ?? p.input_text ?? p.output_text ?? "");
        }
        return "";
      })
      .join("\n")
      .trim();
  }
  return String(content ?? "");
}

function createAdapter(): SessionAdapter {
  // Keep track of file sizes for incremental reading
  const fileCursors = new Map<string, number>();

  return {
    name: "codex",

    sessionDir() {
      return SESSIONS_DIR;
    },

    async discoverSessions() {
      const sessions: SessionInfo[] = [];
      const files = findRolloutFiles();
      for (const file of files) {
        const sessionKey = path.basename(file, ".jsonl");
        sessions.push({
          sessionKey,
          sessionId: sessionKey,
        });
      }
      return sessions;
    },

    async parseNewMessages(
      sessionKey: string,
      sinceTimestamp: number,
    ): Promise<ParsedMessage[]> {
      const messages: ParsedMessage[] = [];

      // Find the rollout file
      const files = findRolloutFiles();
      const file = files.find(
        (f) => path.basename(f, ".jsonl") === sessionKey,
      );
      if (!file) return messages;

      try {
        const content = fs.readFileSync(file, "utf-8");
        const lines = content.split("\n").filter((l) => l.trim());

        for (const line of lines) {
          try {
            const ev = JSON.parse(line);
            const ts = typeof ev.timestamp === "number"
              ? ev.timestamp
              : typeof ev.timestamp === "string"
              ? new Date(ev.timestamp).getTime()
              : undefined;

            if (sinceTimestamp > 0 && ts && ts <= sinceTimestamp) continue;

            const payload =
              typeof ev.payload === "object" && ev.payload !== null
                ? (ev.payload as Record<string, unknown>)
                : ev;

            const role = String(payload.role ?? "").toLowerCase();
            if (!["user", "assistant", "system"].includes(role)) continue;

            const text = extractText(payload.content);
            if (!text) continue;

            messages.push({
              role: role as "user" | "assistant" | "system",
              content: text,
              timestamp: ts,
            });
          } catch {
            // Skip malformed lines
          }
        }
      } catch (err) {
        process.stderr.write(
          `[adapter:codex] parse error for ${sessionKey}: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }

      return messages;
    },

    detectTurns(msgs: ParsedMessage[]): ParsedTurn[] {
      const turns: ParsedTurn[] = [];
      let currentUser: ParsedMessage | null = null;
      let currentAssistants: ParsedMessage[] = [];
      let sessionKey = "";

      for (const msg of msgs) {
        if (msg.role === "user") {
          if (currentUser && currentAssistants.length > 0) {
            turns.push({
              sessionKey,
              sessionId: sessionKey,
              userMessage: currentUser,
              assistantMessages: [...currentAssistants],
            });
          }
          currentUser = msg;
          currentAssistants = [];
        } else if (
          (msg.role === "assistant" || msg.role === "tool" || msg.role === "system") &&
          currentUser
        ) {
          currentAssistants.push(msg);
        }
      }

      if (currentUser && currentAssistants.length > 0) {
        turns.push({
          sessionKey,
          sessionId: sessionKey,
          userMessage: currentUser,
          assistantMessages: [...currentAssistants],
        });
      }

      return turns;
    },
  };
}

registerAdapter("codex", createAdapter);
