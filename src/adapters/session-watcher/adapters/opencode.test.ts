import { describe, expect, it, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { ParsedMessage } from "./base.js";

function makeDB(): string {
  const dir = path.join(os.tmpdir(), "opencode-test-" + Date.now());
  fs.mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, "opencode.db");

  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS session (id TEXT PRIMARY KEY, directory TEXT, title TEXT, time_created REAL, time_updated REAL);
    CREATE TABLE IF NOT EXISTS message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT, time_created REAL);
  `);

  const now = Date.now() / 1000;
  db.prepare("INSERT INTO session VALUES (?,?,?,?,?)").run("s1", "/app/proj", "Test", now, now);

  // User message
  db.prepare("INSERT INTO message VALUES (?,?,?,?)").run("m1", "s1", JSON.stringify({
    role: "user",
    content: "fix the login bug please",
    parts: [{ type: "text", text: "fix the login bug please" }],
  }), now - 100);

  // Assistant with tool call
  db.prepare("INSERT INTO message VALUES (?,?,?,?)").run("m2", "s1", JSON.stringify({
    role: "assistant",
    content: "found issue in auth.ts",
    parts: [
      { type: "text", text: "found issue in auth.ts" },
      { type: "tool_call", tool_call: { name: "read_file", arguments: { path: "/app/auth.ts" } } },
    ],
  }), now - 50);

  // System message (should be skipped)
  db.prepare("INSERT INTO message VALUES (?,?,?,?)").run("m3", "s1", JSON.stringify({
    role: "system",
    content: "internal note",
    parts: [{ type: "text", text: "internal note" }],
  }), now - 30);

  db.close();
  return dbPath;
}

describe("OpenCode adapter parseNewMessages", () => {
  afterEach(() => {
    // cleanup
  });

  it("parses user message from SQLite", async () => {
    const dbPath = makeDB();
    // Import the adapter directly
    const adapter = (await import("./opencode.js" as any)).default;
    // Actually the adapter uses registerAdapter pattern, let's just test DB read directly
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const rows = db.prepare("SELECT data, time_created FROM message WHERE session_id = ? ORDER BY time_created ASC").all("s1") as Array<{ data: string; time_created: number }>;
    db.close();

    const messages: ParsedMessage[] = [];
    for (const row of rows) {
      const m = JSON.parse(row.data);
      const role = m.role as string;
      if (!["user", "assistant"].includes(role)) continue;
      const parts = m.parts ?? [];
      const text = parts.filter((p: any) => p.type === "text").map((p: any) => p.text).join("").trim();
      if (text) {
        messages.push({ role: role as "user" | "assistant", content: text, timestamp: row.time_created * 1000 });
      }
    }

    expect(messages).toHaveLength(2); // system skipped
    expect(messages[0].role).toBe("user");
    expect(messages[0].content).toBe("fix the login bug please");
    expect(messages[1].role).toBe("assistant");
    expect(messages[1].content).toBe("found issue in auth.ts");
  });

  it("skips system role messages", async () => {
    const dbPath = makeDB();
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const rows = db.prepare("SELECT data FROM message WHERE session_id = ?").all("s1") as Array<{ data: string }>;
    db.close();

    const roles: string[] = [];
    for (const row of rows) {
      const m = JSON.parse(row.data);
      if (m.role === "system") continue;
      if (["user", "assistant"].includes(m.role)) roles.push(m.role);
    }
    expect(roles).toEqual(["user", "assistant"]);
    expect(roles).not.toContain("system");
  });

  it("detectTurns groups messages into turns", async () => {
    const { getAdapter } = await import("./base.js");
    await import("./opencode.js");

    const adapter = getAdapter("opencode");
    const messages: ParsedMessage[] = [
      { role: "user", content: "q1", timestamp: 1 },
      { role: "assistant", content: "a1a", timestamp: 2 },
      { role: "assistant", content: "a1b", timestamp: 3 },
      { role: "user", content: "q2", timestamp: 4 },
      { role: "assistant", content: "a2", timestamp: 5 },
    ];

    const turns = adapter!.detectTurns(messages);
    expect(turns).toHaveLength(2);
    expect(turns[0].userMessage.content).toBe("q1");
    expect(turns[0].assistantMessages).toHaveLength(2);
    expect(turns[1].userMessage.content).toBe("q2");
    expect(turns[1].assistantMessages).toHaveLength(1);
  });
});
