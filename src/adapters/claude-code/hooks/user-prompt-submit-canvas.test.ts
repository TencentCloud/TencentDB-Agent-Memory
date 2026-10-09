import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { recordShortTermToolEvent } from "../short-term/store.js";
import { handleUserPromptSubmit } from "./user-prompt-submit.js";

describe("UserPromptSubmit short-term canvas injection", () => {
  it("reads the active canvas from the short-term store", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "tdai-cc-canvas-inject-"));
    try {
      recordShortTermToolEvent({
        storageDir: dir,
        decision: { capture: true, reason: "high_signal_tool", writeRef: false },
        event: {
          sessionKey: "agent:claude-code-x:s1",
          sessionId: "s1",
          cwd: "C:/tmp/project",
          toolUseId: "toolu_1",
          toolName: "Bash",
          status: "success",
          endedAt: "2026-07-22T00:00:00Z",
          inputSummary: "npm test",
          resultSummary: "passed",
        },
      });

      const output = await handleUserPromptSubmit(
        { prompt: "continue", session_id: "s1", cwd: "C:/tmp/project" },
        {
          env: {
            MEMORY_TENCENTDB_CLAUDE_STORAGE_DIR: dir,
            MEMORY_TENCENTDB_SHORT_TERM: "true",
          },
          client: {
            recall: async () => ({ context: "long memory" }),
          },
        },
      );

      expect(output.hookSpecificOutput?.additionalContext).toContain("Long-term Recall");
      expect(output.hookSpecificOutput?.additionalContext).toContain("Short-term Task Canvas");
      expect(output.hookSpecificOutput?.additionalContext).toContain("flowchart TD");
      expect(output.hookSpecificOutput?.additionalContext).toContain("Bash");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("works when auto recall is disabled", async () => {
    const output = await handleUserPromptSubmit(
      { prompt: "continue", session_id: "s1", cwd: "C:/tmp/project" },
      {
        env: {
          MEMORY_TENCENTDB_AUTO_RECALL: "false",
          MEMORY_TENCENTDB_SHORT_TERM: "true",
        },
        shortTermCanvas: "flowchart TD\n  n1[\"OK PowerShell\"]",
        client: {
          recall: async () => {
            throw new Error("should not be called");
          },
        },
      },
    );

    expect(output.hookSpecificOutput?.additionalContext).toContain("Short-term Task Canvas");
    expect(output.hookSpecificOutput?.additionalContext).toContain("OK PowerShell");
  });
});
