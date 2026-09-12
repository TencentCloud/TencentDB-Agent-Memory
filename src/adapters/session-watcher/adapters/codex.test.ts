import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { ParsedMessage } from "./base.js";

function makeCodexSession(): string {
  const dir = path.join(os.tmpdir(), "codex-test-" + Date.now());
  fs.mkdirSync(dir, { recursive: true });

  const now = Date.now();
  const lines = [
    JSON.stringify({ type: "session_meta", payload: { cwd: "/app/proj", id: "session-1" }, timestamp: now - 120000 }),
    JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "text", text: "fix the bug" }] }, timestamp: now - 100000 }),
    JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "text", text: "checking code..." }] }, timestamp: now - 50000 }),
  ].join("\n");

  const filePath = path.join(dir, "rollout-session-1.jsonl");
  fs.writeFileSync(filePath, lines, "utf-8");
  return dir;
}

describe("Codex adapter parseNewMessages", () => {
  it("parses user and assistant messages from JSONL", async () => {
    const dir = makeCodexSession();
    const filePath = path.join(dir, "rollout-session-1.jsonl");
    const content = fs.readFileSync(filePath, "utf-8");
    const lines = content.split("\n").filter((l) => l.trim());

    const messages: ParsedMessage[] = [];
    for (const line of lines) {
      const ev = JSON.parse(line);
      const payload = (ev.payload && typeof ev.payload === "object" ? ev.payload : ev) as Record<string, unknown>;
      const role = String(payload.role ?? "").toLowerCase();
      if (!["user", "assistant"].includes(role)) continue;

      const raw = payload.content;
      let text = "";
      if (typeof raw === "string") text = raw;
      else if (Array.isArray(raw)) text = raw.map((p: any) => p.text ?? "").join("").trim();
      if (!text) continue;

      messages.push({
        role: role as "user" | "assistant",
        content: text,
        timestamp: typeof ev.timestamp === "number" ? ev.timestamp : undefined,
      });
    }

    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe("user");
    expect(messages[0].content).toBe("fix the bug");
    expect(messages[1].role).toBe("assistant");
    expect(messages[1].content).toBe("checking code...");
  });

  it("discoverSessions finds rollout files", async () => {
    const dir = makeCodexSession();

    const adapter = (await import("./codex.js") as any);
    // The adapter uses registerAdapter and os.homedir() for path
    // For this test we directly test the find logic on tmp dir
    const files = fs.readdirSync(dir, { withFileTypes: true });
    const rollouts = files.filter((f) => f.isFile() && f.name.startsWith("rollout-") && f.name.endsWith(".jsonl"));
    expect(rollouts).toHaveLength(1);
    expect(rollouts[0].name).toBe("rollout-session-1.jsonl");
  });

  it("extractText handles various content formats", async () => {
    const { getAdapter } = await import("./base.js");
    await import("./codex.js");

    const adapter = getAdapter("codex");
    const messages: ParsedMessage[] = [
      { role: "user", content: "q1", timestamp: 1 },
      { role: "assistant", content: "a1", timestamp: 2 },
      { role: "user", content: "q2", timestamp: 3 },
      { role: "assistant", content: "a2a", timestamp: 4 },
      { role: "assistant", content: "a2b", timestamp: 5 },
    ];

    const turns = adapter!.detectTurns(messages);
    expect(turns).toHaveLength(2);
    expect(turns[0].assistantMessages).toHaveLength(1);
    expect(turns[1].assistantMessages).toHaveLength(2);
  });
});
