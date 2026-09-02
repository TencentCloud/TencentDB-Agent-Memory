import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseClaudeCodeTranscriptFile, transcriptRecordsToSeedSession } from "./transcript.js";

describe("Claude Code transcript mapper", () => {
  it("maps user/assistant text records into seed conversations", () => {
    const session = transcriptRecordsToSeedSession({
      sessionKey: "agent:claude-code-x:s1",
      sessionId: "s1",
      records: [
        {
          type: "user",
          timestamp: "2026-07-22T10:00:00Z",
          message: { role: "user", content: "remember this" },
        },
        {
          type: "assistant",
          timestamp: "2026-07-22T10:00:01Z",
          message: { role: "assistant", content: [{ type: "text", text: "got it" }] },
        },
      ],
    });

    expect(session).toEqual({
      sessionKey: "agent:claude-code-x:s1",
      sessionId: "s1",
      conversations: [[
        { role: "user", content: "remember this", timestamp: "2026-07-22T10:00:00Z" },
        { role: "assistant", content: "got it", timestamp: "2026-07-22T10:00:01Z" },
      ]],
    });
  });

  it("skips tool-only records and corrupt JSONL lines", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "tdai-claude-transcript-"));
    const file = path.join(dir, "transcript.jsonl");
    try {
      writeFileSync(file, [
        JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", content: "huge output" }] } }),
        "not-json",
        JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: "actual prompt" }] } }),
        JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", name: "Bash" }, { type: "text", text: "actual answer" }] } }),
      ].join("\n"));

      const session = parseClaudeCodeTranscriptFile({
        transcriptPath: file,
        sessionKey: "agent:claude-code-x:s1",
      });

      expect(session.conversations).toEqual([[
        { role: "user", content: "actual prompt" },
        { role: "assistant", content: "actual answer" },
      ]]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

