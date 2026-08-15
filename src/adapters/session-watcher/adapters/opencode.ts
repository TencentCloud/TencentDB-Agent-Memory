/**
 * OpenCode Session Adapter — reads ~/.local/share/opencode/opencode.db (READ-ONLY).
 *
 * OpenCode uses a SQLite database:
 *   session: id, directory, title, time_created, time_updated
 *   message:  id, session_id, data — JSON {role, parts[{type:"text"/"tool_call", ...}]}
 *   part:     message_id, session_id, data — fine-grained parts
 *
 * We read only (mode=ro), no writes to the OpenCode database.
 */

import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import os from "node:os";
import type {
  SessionAdapter,
  SessionInfo,
  ParsedMessage,
  ParsedTurn,
} from "./base.js";
import { registerAdapter } from "./base.js";

const DB_PATH = path.join(os.homedir(), ".local", "share", "opencode", "opencode.db");

function createAdapter(): SessionAdapter {
  return {
    name: "opencode",

    sessionDir() {
      return path.join(os.homedir(), ".local", "share", "opencode");
    },

    async discoverSessions() {
      const sessions: SessionInfo[] = [];
      try {
        const db = new DatabaseSync(DB_PATH, { readOnly: true });
        const rows = db
          .prepare(
            "SELECT id, directory, title, time_created FROM session WHERE directory IS NOT NULL ORDER BY time_created DESC",
          )
          .all() as Array<{
          id: string;
          directory: string;
          title: string;
          time_created: number;
        }>;
        for (const row of rows) {
          sessions.push({
            sessionKey: String(row.id),
            sessionId: String(row.id),
            projectPath: row.directory || undefined,
            startedAt: row.time_created
              ? new Date(row.time_created * 1000).toISOString()
              : undefined,
          });
        }
        db.close();
      } catch (err) {
        process.stderr.write(
          `[adapter:opencode] DB read error: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
      return sessions;
    },

    async parseNewMessages(
      sessionKey: string,
      sinceTimestamp: number,
    ): Promise<ParsedMessage[]> {
      const messages: ParsedMessage[] = [];
      try {
        const db = new DatabaseSync(DB_PATH, { readOnly: true });
        const sinceSeconds = Math.floor(sinceTimestamp / 1000);

        const rows = db
          .prepare(
            `SELECT m.id, m.data, m.time_created
             FROM message m
             WHERE m.session_id = ?
               AND m.time_created > ?
             ORDER BY m.time_created ASC`,
          )
          .all(sessionKey, sinceSeconds) as Array<{
          id: string;
          data: string;
          time_created: number;
        }>;

        for (const row of rows) {
          try {
            const m = JSON.parse(row.data);
            const role = m.role as string | undefined;
            if (!role || !["user", "assistant", "system"].includes(role)) continue;

            // Extract text content from parts
            let content = "";
            const parts = m.parts ?? [];
            for (const p of parts) {
              if (p?.type === "text" && typeof p.text === "string") {
                content += p.text;
              }
            }

            if (!content && role === "user") {
              // Fallback: try direct content field
              content = typeof m.content === "string" ? m.content : "";
            }

            if (content) {
              messages.push({
                role: role as "user" | "assistant" | "system",
                content: content.trim(),
                timestamp: row.time_created * 1000,
              });
            }
          } catch {
            // Skip malformed messages
          }
        }
        db.close();
      } catch (err) {
        process.stderr.write(
          `[adapter:opencode] parse error for session ${sessionKey}: ${err instanceof Error ? err.message : String(err)}\n`,
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

      // Don't forget the last turn
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

registerAdapter("opencode", createAdapter);
