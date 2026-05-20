import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-codex-hooks-"));

const basePayload = {
  session_id: "hook-smoke-session",
  cwd: tmpDir,
  transcript_path: path.join(tmpDir, "transcript.jsonl"),
};

describe("Codex hook entry scripts", () => {
  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it.each([
    ["session-start.mjs", basePayload],
    ["user-prompt-submit.mjs", { ...basePayload, prompt: "remember this smoke test" }],
    ["pre-tool-use.mjs", { ...basePayload, tool_name: "Bash", tool_input: { command: "date" } }],
    ["post-tool-use.mjs", { ...basePayload, tool_name: "Bash", tool_response: "ok" }],
    ["stop.mjs", basePayload],
    ["pre-compact.mjs", { ...basePayload, reason: "smoke" }],
    ["post-compact.mjs", { ...basePayload, reason: "smoke" }],
    ["permission-request.mjs", { ...basePayload, tool_name: "Bash", permission: "allow" }],
  ])("%s exits cleanly and emits a valid hook envelope when present", async (script, payload) => {
    const result = await runHook(script, payload);
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    if (!result.stdout.trim()) return;
    expect(JSON.parse(result.stdout)).toEqual({
      hookSpecificOutput: expect.objectContaining({
        hookEventName: expect.any(String),
      }),
    });
  });
});

function runHook(script, payload) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(scriptsDir, script)], {
      env: {
        ...process.env,
        TDAI_DATA_DIR: tmpDir,
        TDAI_CODEX_AUTOSTART: "false",
        TDAI_CODEX_TOOL_OFFLOAD: "false",
        TDAI_GATEWAY_URL: "http://127.0.0.1:9",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(`${JSON.stringify(payload)}\n`);
  });
}
