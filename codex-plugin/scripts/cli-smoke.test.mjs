import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-codex-cli-"));

describe("Codex adapter CLI entry scripts", () => {
  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("imports Codex JSONL history in dry-run mode", async () => {
    const sessionsDir = path.join(tmpDir, "sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });
    const cwd = path.join(tmpDir, "project");
    fs.mkdirSync(cwd, { recursive: true });
    const sessionPath = path.join(sessionsDir, "sample.jsonl");
    fs.writeFileSync(sessionPath, [
      JSON.stringify({ type: "session_meta", timestamp: "2026-05-20T00:00:00.000Z", payload: { id: "smoke", cwd, source: "codex-cli" } }),
      JSON.stringify({ type: "response_item", timestamp: "2026-05-20T00:00:01.000Z", payload: { type: "message", role: "user", content: [{ text: "What did we decide?" }] } }),
      JSON.stringify({ type: "response_item", timestamp: "2026-05-20T00:00:02.000Z", payload: { type: "message", role: "assistant", content: [{ text: "We decided to keep the adapter portable." }] } }),
      "",
    ].join("\n"));

    const result = await runScript("import-codex-history.mjs", [
      "--sessions-dir", sessionsDir,
      "--no-archived",
      "--dry-run",
      "--cwd", cwd,
      "--limit", "1",
    ]);
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(expect.objectContaining({
      sessionsPrepared: 1,
      roundsPrepared: 1,
      messagesPrepared: 2,
      skipped: expect.objectContaining({ parseError: 0 }),
    }));
  });

  it("prints query status JSON without autostarting Gateway", async () => {
    const result = await runScript("query.mjs", ["status"], {
      CLAUDE_PROJECT_DIR: tmpDir,
      TDAI_CODEX_AUTOSTART: "false",
      TDAI_CODEX_GATEWAY_URL: "http://127.0.0.1:9",
      TDAI_CODEX_DATA_DIR: tmpDir,
    });
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(expect.objectContaining({
      healthy: false,
      gatewayUrl: "http://127.0.0.1:9",
      sessionKey: expect.stringContaining("codex:"),
    }));
  });
});

function runScript(script, args = [], env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(scriptsDir, script), ...args], {
      env: {
        ...process.env,
        TDAI_DATA_DIR: tmpDir,
        TDAI_CODEX_AUTOSTART: "false",
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}
