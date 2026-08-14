import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readConversationMessagesGroupedBySessionId } from "./l0-recorder.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

describe("L0 JSONL composite paging", () => {
  it("drains equal-timestamp rows oldest-first without gaps or duplicates", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-l0-page-"));
    roots.push(root);
    const conversations = path.join(root, "conversations");
    fs.mkdirSync(conversations);
    const recordedAt = "2026-08-14T00:00:00.000Z";
    const rows = ["l0-c", "l0-a", "l0-b"].map((id) => ({
      sessionKey: "agent:test",
      sessionId: "session-1",
      projectId: "/repo",
      recordedAt,
      id,
      role: "user",
      content: `message ${id}`,
      timestamp: Date.parse(recordedAt),
    }));
    fs.writeFileSync(
      path.join(conversations, "2026-08-14.jsonl"),
      `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
    );

    const first = await readConversationMessagesGroupedBySessionId(
      "agent:test",
      root,
      undefined,
      undefined,
      2,
    );
    expect(first[0]?.messages.map(({ id }) => id)).toEqual(["l0-a", "l0-b"]);

    const second = await readConversationMessagesGroupedBySessionId(
      "agent:test",
      root,
      Date.parse(recordedAt),
      undefined,
      2,
      "l0-b",
    );
    expect(second[0]?.messages.map(({ id }) => id)).toEqual(["l0-c"]);
  });
});
