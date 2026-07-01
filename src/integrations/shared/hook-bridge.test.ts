import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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
    const gateway = await startGateway((_req, _body, res) => {
      res.setHeader("Content-Type", "application/json");
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
        additionalContext: "Relevant memory block",
      },
    });
    expect(gateway.calls).toEqual([
      {
        method: "POST",
        url: "/recall",
        body: {
          query: "What did we decide about Codex?",
          session_key: "session-a",
          include_l0: true,
          global_l0_fallback: false,
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
  });

  it("captures a Stop turn by pairing the cached prompt with the assistant message", async () => {
    const cacheDir = await makeTempDir("memory-hook-cache-");
    const gateway = await startGateway((_req, _body, res) => {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ context: "cached context", ok: true }));
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
      started_at: 1000,
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
    expect(gateway.calls.map((call) => call.url)).toEqual(["/recall", "/capture"]);
    expect(gateway.calls[1].body).toEqual({
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
