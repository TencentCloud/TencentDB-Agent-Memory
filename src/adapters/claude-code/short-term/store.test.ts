import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { getShortTermPaths, readActiveShortTermCanvas, recordShortTermToolEvent } from "./store.js";

describe("Claude Code short-term store", () => {
  it("writes refs, jsonl, mmd, and state for captured tool events", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "tdai-cc-store-"));
    try {
      const record = recordShortTermToolEvent({
        storageDir: dir,
        decision: { capture: true, reason: "high_signal_tool", writeRef: true },
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
          rawInput: { command: "npm test" },
          rawResult: { stdout: "passed" },
        },
      });

      const paths = getShortTermPaths({ storageDir: dir, cwd: "C:/tmp/project", sessionId: "s1" });
      expect(record?.node_id).toBe("n1");
      expect(existsSync(paths.jsonlPath)).toBe(true);
      expect(existsSync(paths.mmdPath)).toBe(true);
      expect(existsSync(paths.statePath)).toBe(true);
      expect(readFileSync(paths.jsonlPath, "utf-8")).toContain("toolu_1");
      expect(readActiveShortTermCanvas({ storageDir: dir, cwd: "C:/tmp/project", sessionId: "s1" })).toContain("flowchart TD");
      expect(record?.result_ref).toBe("refs/toolu_1.md");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
