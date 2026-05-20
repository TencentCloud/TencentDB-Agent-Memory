import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  beginTurn,
  configuredGatewayTokenPath,
  captureCurrentTurn,
  debug,
  ensureGatewayAuthToken,
  healthCheck,
  hookLogPath,
  httpPost,
  loadSessionState,
  recallForPrompt,
  readGatewayAuthToken,
  promptFromPayload,
  sanitizeMemoryText,
  sessionKeyFromPayload,
} from "./lib.mjs";
import { buildAdapterDoctorReport } from "./doctor.mjs";
import {
  lookupCodexOffload,
  recordCodexToolOffload,
} from "./offload-store.mjs";

let tmpDir;
let originalDataDir;
let originalAutostart;
let originalGatewayUrl;
let originalAllowNonLoopback;
let originalCodexGatewayToken;
let originalGatewayToken;
let originalTokenPath;

beforeEach(() => {
  originalDataDir = process.env.TDAI_CODEX_DATA_DIR;
  originalAutostart = process.env.TDAI_CODEX_AUTOSTART;
  originalGatewayUrl = process.env.TDAI_CODEX_GATEWAY_URL;
  originalAllowNonLoopback = process.env.TDAI_CODEX_ALLOW_NON_LOOPBACK;
  originalCodexGatewayToken = process.env.TDAI_CODEX_GATEWAY_TOKEN;
  originalGatewayToken = process.env.TDAI_GATEWAY_TOKEN;
  originalTokenPath = process.env.TDAI_TOKEN_PATH;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-codex-security-"));
  process.env.TDAI_CODEX_DATA_DIR = tmpDir;
});

afterEach(() => {
  if (originalDataDir === undefined) {
    delete process.env.TDAI_CODEX_DATA_DIR;
  } else {
    process.env.TDAI_CODEX_DATA_DIR = originalDataDir;
  }
  if (originalAutostart === undefined) {
    delete process.env.TDAI_CODEX_AUTOSTART;
  } else {
    process.env.TDAI_CODEX_AUTOSTART = originalAutostart;
  }
  if (originalGatewayUrl === undefined) {
    delete process.env.TDAI_CODEX_GATEWAY_URL;
  } else {
    process.env.TDAI_CODEX_GATEWAY_URL = originalGatewayUrl;
  }
  if (originalAllowNonLoopback === undefined) {
    delete process.env.TDAI_CODEX_ALLOW_NON_LOOPBACK;
  } else {
    process.env.TDAI_CODEX_ALLOW_NON_LOOPBACK = originalAllowNonLoopback;
  }
  if (originalCodexGatewayToken === undefined) {
    delete process.env.TDAI_CODEX_GATEWAY_TOKEN;
  } else {
    process.env.TDAI_CODEX_GATEWAY_TOKEN = originalCodexGatewayToken;
  }
  if (originalGatewayToken === undefined) {
    delete process.env.TDAI_GATEWAY_TOKEN;
  } else {
    process.env.TDAI_GATEWAY_TOKEN = originalGatewayToken;
  }
  if (originalTokenPath === undefined) {
    delete process.env.TDAI_TOKEN_PATH;
  } else {
    process.env.TDAI_TOKEN_PATH = originalTokenPath;
  }
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("Codex adapter security defaults", () => {
  it("strips injected memory blocks and redacts common secrets", () => {
    const githubToken = ["github", "pat", "1234567890abcdefghijklmnopqrstuvwxyz"].join("_");
    const awsAccessKey = `AKIA${"1234567890ABCDEF"}`;
    const keyKind = "PRIVATE KEY";
    const privateKeyBlock = [
      `-----BEGIN ${keyKind}-----`,
      "secret material",
      `-----END ${keyKind}-----`,
    ].join("\n");
    const cleaned = sanitizeMemoryText(`
keep this
<tdai-codex-memory-context>private injected context</tdai-codex-memory-context>
${githubToken}
${awsAccessKey}
${privateKeyBlock}
`);

    expect(cleaned).toContain("keep this");
    expect(cleaned).not.toContain("private injected context");
    expect(cleaned).not.toContain(githubToken);
    expect(cleaned).not.toContain(awsAccessKey);
    expect(cleaned).not.toContain("secret material");
    expect(cleaned).toContain("[REDACTED_GITHUB_TOKEN]");
    expect(cleaned).toContain("[REDACTED_AWS_ACCESS_KEY]");
    expect(cleaned).toContain("[REDACTED_PRIVATE_KEY]");
  });

  it("redacts local Gateway token diagnostics", () => {
    const token = "a".repeat(43);
    const cleaned = sanitizeMemoryText(`gateway token: ${token}`);

    expect(cleaned).not.toContain(token);
    expect(cleaned).toContain("[REDACTED");
  });

  it("redacts JSON-style credential fields", () => {
    const cleaned = sanitizeMemoryText(JSON.stringify({
      apiKey: "plain-secret-123",
      password: "hunter2",
      token: "abc123xyz",
      authorization: "Basic abc123",
      nested: {
        clientSecret: "client-secret-value",
        accessToken: "access-token-value",
      },
    }));

    expect(cleaned).not.toContain("plain-secret-123");
    expect(cleaned).not.toContain("hunter2");
    expect(cleaned).not.toContain("abc123xyz");
    expect(cleaned).not.toContain("Basic abc123");
    expect(cleaned).not.toContain("client-secret-value");
    expect(cleaned).not.toContain("access-token-value");
    expect(cleaned.match(/\[REDACTED\]/g)?.length).toBeGreaterThanOrEqual(6);
  });

  it("redacts env-style credential fields with prefixes", () => {
    const cleaned = sanitizeMemoryText([
      "CLIENT_SECRET=client-secret-value",
      "ACCESS_TOKEN=access-token-value",
      "DB_PASSWORD=hunter2",
    ].join("\n"));

    expect(cleaned).not.toContain("client-secret-value");
    expect(cleaned).not.toContain("access-token-value");
    expect(cleaned).not.toContain("hunter2");
    expect(cleaned).toContain("CLIENT_SECRET=[REDACTED]");
    expect(cleaned).toContain("ACCESS_TOKEN=[REDACTED]");
    expect(cleaned).toContain("DB_PASSWORD=[REDACTED]");
  });

  it("extracts Codex App prompts from user message content arrays", () => {
    const payload = {
      message: {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "capture this Codex App prompt" },
        ],
      },
    };

    expect(promptFromPayload(payload)).toBe("capture this Codex App prompt");
  });

  it("does not treat assistant messages as user prompts", () => {
    const payload = {
      message: {
        type: "message",
        role: "assistant",
        content: [
          { type: "output_text", text: "assistant output should not be captured" },
        ],
      },
      prompt: "",
    };

    expect(promptFromPayload(payload)).toBe("");
  });

  it("falls back to the latest real user message in the Codex transcript", () => {
    const transcriptPath = path.join(tmpDir, "rollout.jsonl");
    fs.writeFileSync(transcriptPath, [
      JSON.stringify({
        timestamp: "2026-05-20T05:00:00.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "earlier real prompt" }],
        },
      }),
      JSON.stringify({
        timestamp: "2026-05-20T05:01:00.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "<turn_aborted>\nsynthetic interruption" }],
        },
      }),
      JSON.stringify({
        timestamp: "2026-05-20T05:02:00.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "assistant response" }],
        },
      }),
      JSON.stringify({
        timestamp: "2026-05-20T05:03:00.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "latest real Codex App prompt" }],
        },
      }),
    ].join("\n") + "\n");

    expect(promptFromPayload({ transcript_path: transcriptPath })).toBe("latest real Codex App prompt");
  });

  it("stores transcript fallback text when beginning a turn", async () => {
    const transcriptPath = path.join(tmpDir, "begin-turn-rollout.jsonl");
    fs.writeFileSync(transcriptPath, JSON.stringify({
      timestamp: "2026-05-20T05:10:00.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "write this prompt into memory" }],
      },
    }) + "\n");

    const payload = {
      cwd: process.cwd(),
      session_id: "transcript-fallback",
      transcript_path: transcriptPath,
    };
    const sessionKey = sessionKeyFromPayload(payload);

    await beginTurn(payload);
    const state = await loadSessionState(sessionKey);

    expect(state.currentTurn.userPrompt).toBe("write this prompt into memory");
  });

  it("redacts full Authorization and Proxy-Authorization header values", () => {
    const cleaned = sanitizeMemoryText([
      "Authorization: Basic dXNlcjpwYXNz",
      "Proxy-Authorization: Token proxy-secret-value",
    ].join("\n"));

    expect(cleaned).not.toContain("dXNlcjpwYXNz");
    expect(cleaned).not.toContain("proxy-secret-value");
    expect(cleaned).toContain("Authorization=[REDACTED]");
    expect(cleaned).toContain("Proxy-Authorization=[REDACTED]");
  });

  it("writes redacted diagnostics to hook.log without throwing", () => {
    debug("Gateway failed with Authorization: Bearer diagnostic-secret-value");

    const log = fs.readFileSync(hookLogPath(), "utf-8");
    expect(log).toContain("Gateway failed");
    expect(log).toContain("Authorization=[REDACTED]");
    expect(log).not.toContain("diagnostic-secret-value");
  });

  it("writes Codex state and offload files with private permissions", async () => {
    const payload = { cwd: process.cwd(), session_id: "perm-test", prompt: "hello" };
    await beginTurn(payload);
    await recordCodexToolOffload({
      sessionKey: sessionKeyFromPayload(payload),
      sessionId: "perm-test",
      cwd: process.cwd(),
      toolName: "test-tool",
      toolUseId: "tool-1",
      inputSummary: "input",
      redactedOutput: "output".repeat(100),
      storedText: "stored output",
      policy: { name: "mild", score: 8 },
    });

    const sessionDir = path.join(tmpDir, "codex-adapter", "sessions");
    const sessionFile = path.join(sessionDir, fs.readdirSync(sessionDir)[0]);
    const offloadBase = path.join(tmpDir, "codex-adapter", "context-offload");
    const offloadRoot = path.join(offloadBase, fs.readdirSync(offloadBase)[0]);
    const refFile = path.join(offloadRoot, "refs", fs.readdirSync(path.join(offloadRoot, "refs"))[0]);

    expect(mode(sessionDir)).toBe("700");
    expect(mode(sessionFile)).toBe("600");
    expect(mode(offloadRoot)).toBe("700");
    expect(mode(refFile)).toBe("600");
  });

  it("scopes offload lookup by project cwd unless explicitly omitted", async () => {
    const cwdA = path.join(tmpDir, "project-a");
    const cwdB = path.join(tmpDir, "project-b");
    fs.mkdirSync(cwdA);
    fs.mkdirSync(cwdB);

    await recordCodexToolOffload(offloadParams(cwdA, "session-a", "tool-a"));
    await recordCodexToolOffload(offloadParams(cwdB, "session-b", "tool-b"));

    const scoped = await lookupCodexOffload({ cwd: cwdA, limit: 10 });
    expect(scoped.matches).toHaveLength(1);
    expect(scoped.matches[0].tool_call_id).toBe("tool-a");

    const all = await lookupCodexOffload({ limit: 10 });
    expect(all.matches.map((entry) => entry.tool_call_id).sort()).toEqual(["tool-a", "tool-b"]);
  });

  it("escapes Mermaid labels for offloaded tool results", async () => {
    const cwd = path.join(tmpDir, "project-mermaid");
    fs.mkdirSync(cwd);
    const result = await recordCodexToolOffload({
      ...offloadParams(cwd, "session-mermaid", "tool-mermaid"),
      toolName: "tool\"] --> EVIL[\"x",
      inputSummary: "payload <script>alert(1)</script> [brackets]",
    });

    const canvas = fs.readFileSync(result.paths.canvasPath, "utf-8");
    expect(canvas).not.toContain("<script>");
    expect(canvas).not.toContain("\"] --> EVIL");
    expect(canvas).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(canvas).toContain("&#91;brackets&#93;");
  });

  it("falls back to project-scoped local L0 JSONL search when Gateway recall is unavailable", async () => {
    process.env.TDAI_CODEX_AUTOSTART = "false";
    process.env.TDAI_CODEX_GATEWAY_URL = "http://127.0.0.1:9";
    const cwdA = path.join(tmpDir, "project-a");
    const cwdB = path.join(tmpDir, "project-b");
    fs.mkdirSync(cwdA);
    fs.mkdirSync(cwdB);

    const conversationsDir = path.join(tmpDir, "conversations");
    fs.mkdirSync(conversationsDir);
    fs.writeFileSync(path.join(conversationsDir, "2026-05-18.jsonl"), [
      JSON.stringify({
        sessionKey: sessionKeyFromPayload({ cwd: cwdA, session_id: "a" }),
        sessionId: "a",
        recordedAt: "2026-05-18T01:00:00.000Z",
        role: "assistant",
        content: "The project decision was to use SQLite for local recall.",
      }),
      JSON.stringify({
        sessionKey: sessionKeyFromPayload({ cwd: cwdB, session_id: "b" }),
        sessionId: "b",
        recordedAt: "2026-05-18T02:00:00.000Z",
        role: "assistant",
        content: "The project decision was to use a remote service.",
      }),
    ].join("\n") + "\n");

    const context = await recallForPrompt(
      { cwd: cwdA, session_id: "a" },
      "previous project decision SQLite",
      "prompt",
    );

    expect(context).toContain('source="local-jsonl-direct"');
    expect(context).toContain("SQLite for local recall");
    expect(context).not.toContain("remote service");
  });

  it("keeps a pending turn when capture cannot reach the Gateway", async () => {
    process.env.TDAI_CODEX_AUTOSTART = "false";
    process.env.TDAI_CODEX_GATEWAY_URL = "http://127.0.0.1:9";
    const payload = { cwd: process.cwd(), session_id: "capture-failure", prompt: "keep me pending" };
    const sessionKey = sessionKeyFromPayload(payload);

    await beginTurn(payload);
    const result = await captureCurrentTurn(payload, "stop");
    const state = await loadSessionState(sessionKey);

    expect(result).toEqual({ captured: false, reason: "gateway_unavailable" });
    expect(state.currentTurn.userPrompt).toBe("keep me pending");
    expect(state.turns || []).toHaveLength(0);
  });

  it("writes explicit env token to the token file used by the spawned Gateway", async () => {
    const customTokenPath = path.join(tmpDir, "custom-token");
    const defaultTokenPath = path.join(tmpDir, "codex-adapter", "gateway-token");
    fs.mkdirSync(path.dirname(defaultTokenPath), { recursive: true });
    fs.writeFileSync(defaultTokenPath, "stale-default-token\n", { mode: 0o600 });

    process.env.TDAI_TOKEN_PATH = customTokenPath;
    process.env.TDAI_CODEX_GATEWAY_TOKEN = "explicit-env-token";
    delete process.env.TDAI_GATEWAY_TOKEN;

    await expect(ensureGatewayAuthToken()).resolves.toBe("explicit-env-token");
    expect(fs.readFileSync(customTokenPath, "utf-8").trim()).toBe("explicit-env-token");
    await expect(readGatewayAuthToken()).resolves.toBe("explicit-env-token");
  });

  it("treats a custom token path as authoritative over a stale default token file", async () => {
    const customTokenPath = path.join(tmpDir, "custom-token");
    const defaultTokenPath = path.join(tmpDir, "codex-adapter", "gateway-token");
    fs.mkdirSync(path.dirname(defaultTokenPath), { recursive: true });
    fs.writeFileSync(defaultTokenPath, "stale-default-token\n", { mode: 0o600 });

    process.env.TDAI_TOKEN_PATH = customTokenPath;
    delete process.env.TDAI_CODEX_GATEWAY_TOKEN;
    delete process.env.TDAI_GATEWAY_TOKEN;

    const token = await ensureGatewayAuthToken();
    expect(token).not.toBe("stale-default-token");
    expect(fs.readFileSync(customTokenPath, "utf-8").trim()).toBe(token);
    await expect(readGatewayAuthToken()).resolves.toBe(token);
  });

  it("expands tilde token paths consistently for adapter and spawned Gateway env", async () => {
    const tokenFileName = `.tdai-codex-token-test-${process.pid}-${Date.now()}`;
    const expandedTokenPath = path.join(os.homedir(), tokenFileName);
    process.env.TDAI_TOKEN_PATH = `~/${tokenFileName}`;
    process.env.TDAI_CODEX_GATEWAY_TOKEN = "tilde-env-token";
    delete process.env.TDAI_GATEWAY_TOKEN;

    try {
      expect(configuredGatewayTokenPath()).toBe(expandedTokenPath);
      await expect(ensureGatewayAuthToken()).resolves.toBe("tilde-env-token");
      expect(fs.readFileSync(expandedTokenPath, "utf-8").trim()).toBe("tilde-env-token");
      await expect(readGatewayAuthToken()).resolves.toBe("tilde-env-token");
    } finally {
      fs.rmSync(expandedTokenPath, { force: true });
    }
  });

  it("creates generated Gateway tokens atomically across concurrent autostarts", async () => {
    const tokenPath = path.join(tmpDir, "concurrent-token");
    process.env.TDAI_TOKEN_PATH = tokenPath;
    delete process.env.TDAI_CODEX_GATEWAY_TOKEN;
    delete process.env.TDAI_GATEWAY_TOKEN;

    const tokens = await Promise.all(Array.from({ length: 12 }, () => ensureGatewayAuthToken()));
    const unique = new Set(tokens);

    expect(unique.size).toBe(1);
    expect(fs.readFileSync(tokenPath, "utf-8").trim()).toBe(tokens[0]);
  });

  it("does not overwrite an empty token file after an atomic-create race", async () => {
    const tokenPath = path.join(tmpDir, "empty-raced-token");
    fs.writeFileSync(tokenPath, "", { mode: 0o600 });
    process.env.TDAI_TOKEN_PATH = tokenPath;
    delete process.env.TDAI_CODEX_GATEWAY_TOKEN;
    delete process.env.TDAI_GATEWAY_TOKEN;

    await expect(ensureGatewayAuthToken()).rejects.toThrow(/already exists but is empty/);
    expect(fs.readFileSync(tokenPath, "utf-8")).toBe("");
  });

  it("does not send auth or payloads to non-loopback Gateway URLs unless explicitly enabled", async () => {
    process.env.TDAI_CODEX_GATEWAY_URL = "https://attacker.example";
    process.env.TDAI_CODEX_GATEWAY_TOKEN = "secret-token";
    delete process.env.TDAI_CODEX_ALLOW_NON_LOOPBACK;
    const fetchMock = vi.spyOn(globalThis, "fetch");

    await expect(healthCheck()).resolves.toBe(false);
    await expect(httpPost("/capture", { user_content: "secret" })).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("ships a portable adapter profile and doctor report for reuse", async () => {
    process.env.TDAI_CODEX_AUTOSTART = "false";
    process.env.TDAI_CODEX_GATEWAY_URL = "http://127.0.0.1:9";

    const report = await buildAdapterDoctorReport({
      pluginRoot: path.resolve("codex-plugin"),
    });

    expect(report.adapter.id).toBe("memory-tencentdb-codex");
    expect(report.checks.find((check) => check.name === "entrypoint:pluginManifest")?.ok).toBe(true);
    expect(report.checks.find((check) => check.name === "entrypoint:doctor")?.ok).toBe(true);
    expect(report.checks.find((check) => check.name === "portable:hooks.codex.json")?.ok).toBe(true);
    expect(report.checks.find((check) => check.name === "portable:.mcp.json")?.ok).toBe(true);
    expect(report.ok).toBe(true);
  });
});

function offloadParams(cwd, sessionId, toolUseId) {
  const payload = { cwd, session_id: sessionId };
  return {
    sessionKey: sessionKeyFromPayload(payload),
    sessionId,
    cwd,
    toolName: "test-tool",
    toolUseId,
    inputSummary: "input",
    redactedOutput: "output".repeat(100),
    storedText: "stored output",
    policy: { name: "mild", score: 8 },
  };
}

function mode(filePath) {
  return (fs.statSync(filePath).mode & 0o777).toString(8);
}
