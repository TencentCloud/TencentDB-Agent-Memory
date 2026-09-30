import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { getShortTermPaths } from "../short-term/store.js";
import { handlePostToolUse } from "./post-tool-use.js";

describe("handlePostToolUse", () => {
  it("captures high-signal tool events into the short-term store", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "tdai-cc-post-tool-"));
    try {
      await handlePostToolUse({
        hook_event_name: "PostToolUse",
        session_id: "s1",
        cwd: "C:/tmp/project",
        tool_name: "Bash",
        tool_use_id: "toolu_1",
        tool_input: { command: "npm test" },
        tool_response: { stdout: "passed" },
      }, {
        env: { MEMORY_TENCENTDB_CLAUDE_STORAGE_DIR: dir },
      });

      const paths = getShortTermPaths({ storageDir: dir, cwd: "C:/tmp/project", sessionId: "s1" });
      expect(existsSync(paths.jsonlPath)).toBe(true);
      expect(existsSync(paths.mmdPath)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
