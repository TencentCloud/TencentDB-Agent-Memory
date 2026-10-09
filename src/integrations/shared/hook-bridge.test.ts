import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const servers = new Set<ReturnType<typeof createServer>>();
const tempDirs = new Set<string>();

afterEach(async () => {
  await Promise.all([...servers].map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve());
  })));
  servers.clear();
  await Promise.all([...tempDirs].map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.clear();
});

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString("utf-8");
  return text ? JSON.parse(text) : {};
}

async function startGateway(handler: (
  req: IncomingMessage,
  body: unknown,
  res: ServerResponse,
) => void | Promise<void>) {
  const calls: Array<{
    method: string | undefined;
    url: string | undefined;
    body: any;
  }> = [];
  const server = createServer(async (req, res) => {
    const body = await readJsonBody(req);
    calls.push({ method: req.method, url: req.url, body });
    await handler(req, body, res);
  });
  servers.add(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Gateway did not bind to a TCP port");
  return { url: `http://127.0.0.1:${address.port}`, calls };
}

async function makeTempDir(prefix: string) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.add(dir);
  return dir;
}

async function runHook(payload: unknown, env: Record<string, string>) {
  const child = spawn(process.execPath, [
    "--import",
    "tsx",
    join(process.cwd(), "src/integrations/shared/hook-bridge.ts"),
  ], {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    stdio: "pipe",
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString("utf-8");
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf-8");
  });

  child.stdin.end(JSON.stringify(payload));
  const [code] = await once(child, "exit") as [number | null, NodeJS.Signals | null];
  return { code, stdout, stderr };
}

describe("memory-tencentdb hook bridge", () => {
  it("recalls context on UserPromptSubmit and writes prompt cache", async () => {
    const cacheDir = await makeTempDir("memory-hook-cache-");
    const auditLog = join(cacheDir, "audit.jsonl");
    const gateway = await startGateway((req, _body, res) => {
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/search/conversations") {
        res.end(JSON.stringify({ results: "Raw session memory", total: 1 }));
        return;
      }
      res.end(JSON.stringify({ context: "Relevant memory block" }));
    });

    const result = await runHook({
      hook_event_name: "UserPromptSubmit",
      prompt: "What did we decide about Codex?",
      session_key: "session-a",
      session_id: "run-a",
      turn_id: "turn-a",
    }, {
      MEMORY_TENCENTDB_GATEWAY_URL: gateway.url,
      MEMORY_TENCENTDB_HOOK_PLATFORM: "codex",
      MEMORY_TENCENTDB_HOOK_EVENT: "UserPromptSubmit",
      MEMORY_TENCENTDB_HOOK_CACHE_DIR: cacheDir,
      MEMORY_TENCENTDB_HOOK_AUDIT_LOG: auditLog,
    });

    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(JSON.parse(result.stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: [
          "Relevant memory block",
          "",
          "Relevant prior conversation memory from memory-tencentdb (session-scoped):",
          "",
          "Raw session memory",
        ].join("\n"),
      },
    });
    expect(gateway.calls).toEqual([
      {
        method: "POST",
        url: "/recall",
        body: {
          query: "What did we decide about Codex?",
          session_key: "session-a",
        },
      },
      {
        method: "POST",
        url: "/search/conversations",
        body: {
          query: "What did we decide about Codex?",
          limit: 3,
          session_key: "session-a",
        },
      },
    ]);
    const cache = JSON.parse(await readFile(join(cacheDir, "last-prompts.json"), "utf-8"));
    expect(Object.values(cache)).toEqual([
      expect.objectContaining({
        prompt: "What did we decide about Codex?",
        sessionKey: "session-a",
        sessionId: "run-a",
        turnId: "turn-a",
      }),
    ]);
    const audit = await readFile(auditLog, "utf-8");
    expect(audit).toContain("\"outcome\":\"recall\"");
    expect((await stat(join(cacheDir, "last-prompts.json"))).mode & 0o777).toBe(0o600);
  });

  it.each([
    { failingPath: "/search/conversations", expected: "Structured memory" },
    { failingPath: "/recall", expected: "Conversation fallback" },
  ])("keeps recall useful when $failingPath fails", async ({ failingPath, expected }) => {
    const cacheDir = await makeTempDir("memory-hook-cache-");
    const gateway = await startGateway((req, _body, res) => {
      res.setHeader("Content-Type", "application/json");
      if (req.url === failingPath) {
        res.statusCode = 503;
        res.end(JSON.stringify({ error: "temporarily unavailable" }));
        return;
      }
      if (req.url === "/recall") {
        res.end(JSON.stringify({ context: "Structured memory" }));
        return;
      }
      res.end(JSON.stringify({ results: "Conversation fallback", total: 1 }));
    });

    const result = await runHook({
      hook_event_name: "UserPromptSubmit",
      prompt: "Recall with graceful degradation",
      session_key: "session-degraded",
    }, {
      MEMORY_TENCENTDB_GATEWAY_URL: gateway.url,
      MEMORY_TENCENTDB_HOOK_PLATFORM: "codex",
      MEMORY_TENCENTDB_HOOK_EVENT: "UserPromptSubmit",
      MEMORY_TENCENTDB_HOOK_CACHE_DIR: cacheDir,
    });

    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(JSON.parse(result.stdout).hookSpecificOutput.additionalContext).toContain(expected);
  });

  it("captures a Stop turn by pairing the cached prompt with the assistant message", async () => {
    const cacheDir = await makeTempDir("memory-hook-cache-");
    const gateway = await startGateway((req, _body, res) => {
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/recall") {
        res.end(JSON.stringify({ context: "cached context" }));
        return;
      }
      if (req.url === "/search/conversations") {
        res.end(JSON.stringify({ results: "", total: 0 }));
        return;
      }
      res.end(JSON.stringify({ ok: true }));
    });
    const env = {
      MEMORY_TENCENTDB_GATEWAY_URL: gateway.url,
      MEMORY_TENCENTDB_HOOK_PLATFORM: "claude-code",
      MEMORY_TENCENTDB_HOOK_CACHE_DIR: cacheDir,
    };

    await runHook({
      hook_event_name: "UserPromptSubmit",
      prompt: "Please remember issue 235 adapter proof.",
      session_key: "session-b",
      session_id: "run-b",
      turn_id: "turn-b",
    }, {
      ...env,
      MEMORY_TENCENTDB_HOOK_EVENT: "UserPromptSubmit",
    });
    const result = await runHook({
      hook_event_name: "Stop",
      session_key: "session-b",
      session_id: "run-b",
      turn_id: "turn-b",
      last_assistant_message: "The adapter proof is recorded.",
    }, {
      ...env,
      MEMORY_TENCENTDB_HOOK_EVENT: "Stop",
    });

    expect(result).toMatchObject({ code: 0, stdout: "", stderr: "" });
    expect(gateway.calls.map((call) => call.url)).toEqual([
      "/recall",
      "/search/conversations",
      "/capture",
    ]);
    expect(gateway.calls[2].body).toEqual({
      user_content: "Please remember issue 235 adapter proof.",
      assistant_content: "The adapter proof is recorded.",
      session_key: "session-b",
      session_id: "run-b",
      messages: [
        { role: "user", content: "Please remember issue 235 adapter proof.", timestamp: expect.any(Number) },
        { role: "assistant", content: "The adapter proof is recorded.", timestamp: expect.any(Number) },
      ],
      started_at: expect.any(Number),
    });
  });

  it("falls back globally only when explicitly enabled and scoped history is empty", async () => {
    const cacheDir = await makeTempDir("memory-hook-cache-");
    let searches = 0;
    const gateway = await startGateway((req, _body, res) => {
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/recall") {
        res.end(JSON.stringify({ context: "" }));
        return;
      }
      searches += 1;
      res.end(JSON.stringify(searches === 1
        ? { results: "", total: 0 }
        : { results: "Global conversation memory", total: 1 }));
    });

    const result = await runHook({
      hook_event_name: "UserPromptSubmit",
      prompt: "Find a decision from another session",
      session_key: "session-global",
    }, {
      MEMORY_TENCENTDB_GATEWAY_URL: gateway.url,
      MEMORY_TENCENTDB_HOOK_PLATFORM: "codex",
      MEMORY_TENCENTDB_HOOK_EVENT: "UserPromptSubmit",
      MEMORY_TENCENTDB_HOOK_CACHE_DIR: cacheDir,
      MEMORY_TENCENTDB_GLOBAL_L0_FALLBACK: "1",
    });

    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(JSON.parse(result.stdout).hookSpecificOutput.additionalContext)
      .toContain("memory-tencentdb (global-scoped)");
    expect(gateway.calls.map((call) => call.body)).toEqual([
      { query: "Find a decision from another session", session_key: "session-global" },
      { query: "Find a decision from another session", limit: 3, session_key: "session-global" },
      { query: "Find a decision from another session", limit: 3 },
    ]);
  });

  it("captures a duplicated Stop hook only once", async () => {
    const cacheDir = await makeTempDir("memory-hook-cache-");
    const auditLog = join(cacheDir, "audit.jsonl");
    const gateway = await startGateway((req, _body, res) => {
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/recall") {
        res.end(JSON.stringify({ context: "" }));
        return;
      }
      if (req.url === "/search/conversations") {
        res.end(JSON.stringify({ results: "", total: 0 }));
        return;
      }
      res.end(JSON.stringify({ ok: true }));
    });
    const env = {
      MEMORY_TENCENTDB_GATEWAY_URL: gateway.url,
      MEMORY_TENCENTDB_HOOK_PLATFORM: "codex",
      MEMORY_TENCENTDB_HOOK_CACHE_DIR: cacheDir,
      MEMORY_TENCENTDB_HOOK_AUDIT_LOG: auditLog,
    };
    await runHook({
      hook_event_name: "UserPromptSubmit",
      prompt: "Capture this turn once.",
      session_key: "session-dedupe",
      session_id: "run-dedupe",
      turn_id: "turn-dedupe",
    }, { ...env, MEMORY_TENCENTDB_HOOK_EVENT: "UserPromptSubmit" });

    const stop = {
      hook_event_name: "Stop",
      session_key: "session-dedupe",
      session_id: "run-dedupe",
      turn_id: "turn-dedupe",
      last_assistant_message: "Captured exactly once.",
    };
    await runHook(stop, { ...env, MEMORY_TENCENTDB_HOOK_EVENT: "Stop" });
    await runHook(stop, { ...env, MEMORY_TENCENTDB_HOOK_EVENT: "Stop" });

    expect(gateway.calls.filter((call) => call.url === "/capture")).toHaveLength(1);
    expect(await readFile(auditLog, "utf-8")).toContain("capture_skipped_duplicate");
  });

  it("does not deduplicate identical content from two distinct prompt turns", async () => {
    const cacheDir = await makeTempDir("memory-hook-cache-");
    const gateway = await startGateway((req, _body, res) => {
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/recall") {
        res.end(JSON.stringify({ context: "" }));
        return;
      }
      if (req.url === "/search/conversations") {
        res.end(JSON.stringify({ results: "", total: 0 }));
        return;
      }
      res.end(JSON.stringify({ ok: true }));
    });
    const env = {
      MEMORY_TENCENTDB_GATEWAY_URL: gateway.url,
      MEMORY_TENCENTDB_HOOK_PLATFORM: "claude-code",
      MEMORY_TENCENTDB_HOOK_CACHE_DIR: cacheDir,
    };
    const prompt = {
      hook_event_name: "UserPromptSubmit",
      prompt: "Repeatable question",
      session_key: "session-repeat",
      session_id: "run-repeat",
    };
    const stop = {
      hook_event_name: "Stop",
      session_key: "session-repeat",
      session_id: "run-repeat",
      last_assistant_message: "Repeatable answer",
    };

    await runHook(prompt, { ...env, MEMORY_TENCENTDB_HOOK_EVENT: "UserPromptSubmit" });
    await runHook(stop, { ...env, MEMORY_TENCENTDB_HOOK_EVENT: "Stop" });
    await runHook(prompt, { ...env, MEMORY_TENCENTDB_HOOK_EVENT: "UserPromptSubmit" });
    await runHook(stop, { ...env, MEMORY_TENCENTDB_HOOK_EVENT: "Stop" });

    expect(gateway.calls.filter((call) => call.url === "/capture")).toHaveLength(2);
  });

  it("releases a capture claim after a transient Gateway failure", async () => {
    const cacheDir = await makeTempDir("memory-hook-cache-");
    let attempts = 0;
    const gateway = await startGateway((_req, _body, res) => {
      res.setHeader("Content-Type", "application/json");
      attempts += 1;
      if (attempts === 1) {
        res.statusCode = 503;
        res.end(JSON.stringify({ error: "try again" }));
        return;
      }
      res.end(JSON.stringify({ ok: true }));
    });
    const payload = {
      hook_event_name: "Stop",
      prompt: "Retry this hook capture.",
      last_assistant_message: "The retry succeeded.",
      session_key: "session-hook-retry",
      turn_id: "turn-hook-retry",
    };
    const env = {
      MEMORY_TENCENTDB_GATEWAY_URL: gateway.url,
      MEMORY_TENCENTDB_HOOK_PLATFORM: "codex",
      MEMORY_TENCENTDB_HOOK_EVENT: "Stop",
      MEMORY_TENCENTDB_HOOK_CACHE_DIR: cacheDir,
    };

    const first = await runHook(payload, env);
    const second = await runHook(payload, env);

    expect(first).toMatchObject({ code: 0, stderr: expect.stringContaining("try again") });
    expect(second).toMatchObject({ code: 0, stderr: "" });
    expect(gateway.calls.filter((call) => call.url === "/capture")).toHaveLength(2);
  });

  it("captures only the latest turn from a session-wide transcript", async () => {
    const cacheDir = await makeTempDir("memory-hook-cache-");
    const transcriptPath = join(cacheDir, "transcript.jsonl");
    await writeFile(transcriptPath, [
      JSON.stringify({ role: "user", content: "Earlier question", timestamp: 100 }),
      JSON.stringify({ role: "assistant", content: "Earlier answer", timestamp: 101 }),
      JSON.stringify({ role: "user", content: "Current question", timestamp: 200 }),
      JSON.stringify({ role: "assistant", content: "Current answer", timestamp: 201 }),
    ].join("\n"), "utf-8");
    const gateway = await startGateway((_req, _body, res) => {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: true }));
    });

    const result = await runHook({
      hook_event_name: "Stop",
      session_key: "session-transcript",
      session_id: "run-transcript",
      turn_id: "turn-transcript",
      transcript_path: transcriptPath,
      last_assistant_message: "Current answer",
    }, {
      MEMORY_TENCENTDB_GATEWAY_URL: gateway.url,
      MEMORY_TENCENTDB_HOOK_PLATFORM: "codex",
      MEMORY_TENCENTDB_HOOK_EVENT: "Stop",
      MEMORY_TENCENTDB_HOOK_CACHE_DIR: cacheDir,
    });

    expect(result).toMatchObject({ code: 0, stdout: "", stderr: "" });
    expect(gateway.calls).toHaveLength(1);
    expect(gateway.calls[0].body).toMatchObject({
      user_content: "Current question",
      assistant_content: "Current answer",
      messages: [
        { role: "user", content: "Current question", timestamp: expect.any(Number) },
        { role: "assistant", content: "Current answer", timestamp: expect.any(Number) },
      ],
      started_at: expect.any(Number),
    });
    expect(gateway.calls[0].body.started_at)
      .toBeLessThan(gateway.calls[0].body.messages[0].timestamp);
  });

  it("flushes the session when Stop cannot reconstruct a complete turn", async () => {
    const cacheDir = await makeTempDir("memory-hook-cache-");
    const gateway = await startGateway((_req, _body, res) => {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ flushed: true }));
    });

    const result = await runHook({
      hook_event_name: "Stop",
      session_key: "session-c",
      session_id: "run-c",
    }, {
      MEMORY_TENCENTDB_GATEWAY_URL: gateway.url,
      MEMORY_TENCENTDB_HOOK_PLATFORM: "codex",
      MEMORY_TENCENTDB_HOOK_EVENT: "Stop",
      MEMORY_TENCENTDB_HOOK_CACHE_DIR: cacheDir,
    });

    expect(result).toMatchObject({ code: 0, stdout: "", stderr: "" });
    expect(gateway.calls).toEqual([
      {
        method: "POST",
        url: "/session/end",
        body: {
          session_key: "session-c",
        },
      },
    ]);
  });
});
