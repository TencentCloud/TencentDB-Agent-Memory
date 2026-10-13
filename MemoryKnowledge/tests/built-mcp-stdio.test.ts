import { describe, expect, it, afterAll, beforeAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const address = srv.address();
      if (!address || typeof address === "string") {
        srv.close(() => reject(new Error("Unable to obtain address")));
        return;
      }
      const port = address.port;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

async function stopProcess(child?: ChildProcess, timeoutMs = 4000): Promise<void> {
  if (!child) return;
  if (child.exitCode !== null || child.signalCode !== null) return;

  await new Promise<void>((resolve, reject) => {
    let sigtermTimer: NodeJS.Timeout | null = null;
    let sigkillTimer: NodeJS.Timeout | null = null;

    const cleanup = () => {
      if (sigtermTimer) clearTimeout(sigtermTimer);
      if (sigkillTimer) clearTimeout(sigkillTimer);
      child.removeListener("exit", onExit);
      child.removeListener("error", onError);
    };

    const onExit = () => {
      cleanup();
      resolve();
    };

    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };

    child.once("exit", onExit);
    child.once("error", onError);

    try {
      child.kill("SIGTERM");
    } catch (err: any) {
      cleanup();
      if (err?.code === "ESRCH") {
        resolve();
      } else {
        reject(err);
      }
      return;
    }

    sigtermTimer = setTimeout(() => {
      if (child.exitCode !== null || child.signalCode !== null) {
        cleanup();
        resolve();
        return;
      }
      try {
        child.kill("SIGKILL");
      } catch (err: any) {
        cleanup();
        if (err?.code === "ESRCH") {
          resolve();
        } else {
          reject(err);
        }
        return;
      }

      sigkillTimer = setTimeout(() => {
        cleanup();
        if (child.exitCode === null && child.signalCode === null) {
          reject(new Error(`Process ${child.pid} failed to terminate after SIGKILL within ${timeoutMs}ms`));
        } else {
          resolve();
        }
      }, timeoutMs);
    }, timeoutMs);
  });
}

async function waitForHttpOk(url: string, timeoutMs = 15000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // not ready
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Timed out waiting for HTTP OK at ${url} after ${timeoutMs}ms`);
}

interface McpClientHandle {
  process: ChildProcess;
  sendRpc: (msg: Record<string, unknown>) => Promise<any>;
}

function spawnMcpClient(
  binMcpPath: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): McpClientHandle {
  const mcpProcess = spawn(process.execPath, [binMcpPath], {
    cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  mcpProcess.stderr!.on("data", () => {});

  let buffer = "";
  const pendingResponses = new Map<number, (res: any) => void>();
  let fatalError: Error | null = null;

  mcpProcess.on("error", (err) => {
    fatalError = err;
    for (const [, resolver] of pendingResponses) {
      resolver({ error: { message: err.message } });
    }
    pendingResponses.clear();
  });

  mcpProcess.on("exit", (code, signal) => {
    if ((code !== null && code !== 0) || signal !== null) {
      if (!fatalError) {
        fatalError = new Error(`MCP process exited unexpectedly with code ${code}, signal ${signal}`);
      }
      for (const [, resolver] of pendingResponses) {
        resolver({ error: { message: fatalError.message } });
      }
      pendingResponses.clear();
    }
  });

  mcpProcess.stdout!.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let parsed: any;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        fatalError = new Error(`Malformed MCP stdout (not valid JSON-RPC): ${trimmed}`);
        for (const [, resolver] of pendingResponses) {
          resolver({ error: { message: fatalError.message } });
        }
        pendingResponses.clear();
        return;
      }

      if (parsed && typeof parsed.id === "number" && pendingResponses.has(parsed.id)) {
        const resolver = pendingResponses.get(parsed.id)!;
        pendingResponses.delete(parsed.id);
        resolver(parsed);
      }
    }
  });

  function sendRpc(msg: Record<string, unknown>): Promise<any> {
    return new Promise((resolve, reject) => {
      if (fatalError) {
        return reject(fatalError);
      }
      const id = msg.id as number | undefined;
      let timer: NodeJS.Timeout | null = null;

      if (id !== undefined) {
        timer = setTimeout(() => {
          if (pendingResponses.has(id)) {
            pendingResponses.delete(id);
            reject(new Error(`Timeout waiting for JSON-RPC response for message id ${id}`));
          }
        }, 10000);

        pendingResponses.set(id, (val) => {
          if (timer) clearTimeout(timer);
          if (fatalError) return reject(fatalError);
          resolve(val);
        });
      }

      mcpProcess.stdin!.write(JSON.stringify(msg) + "\n");
      if (id === undefined) {
        resolve(null);
      }
    });
  }

  return { process: mcpProcess, sendRpc };
}

describe("Real built stdio MCP CLI (bin/mcp.mjs)", () => {
  let tmpDir: string;
  let serverProcess: ChildProcess;
  let mcpProcess: ChildProcess | undefined;
  let foreignMcpProcess: ChildProcess | undefined;
  let port: number;
  let baseUrl: string;
  let serviceKey: string;
  let seededWikiId: string;
  const projectRoot = fileURLToPath(new URL("..", import.meta.url));
  const binServer = join(projectRoot, "bin", "server.mjs");
  const binMcp = join(projectRoot, "bin", "mcp.mjs");
  const distMcp = join(projectRoot, "dist", "mcp", "server.mjs");

  const distinctiveRef = "architecture-overview";
  const distinctiveContent = "---\nlocked: true\n---\n\nDistinctive synthetic MCP page #42.\n";

  beforeAll(async () => {
    if (!existsSync(distMcp)) {
      throw new Error(`dist/mcp/server.mjs not found at ${distMcp}. Run build first.`);
    }

    tmpDir = mkdtempSync(join(tmpdir(), "knowledge-built-mcp-test-"));
    port = await getFreePort();
    baseUrl = `http://127.0.0.1:${port}`;
    serviceKey = `mcp-service-key-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const cleanServerEnv: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      NODE_ENV: "production",
      PORT: String(port),
      HOST: "127.0.0.1",
      KNOWLEDGE_HOST: "127.0.0.1",
      KNOWLEDGE_SERVICE_KEY: serviceKey,
      KNOWLEDGE_ALLOW_INSECURE_NO_KEY_LISTEN: "false",
      KNOWLEDGE_DATA_DIR: join(tmpDir, "data"),
      KNOWLEDGE_DB_PATH: join(tmpDir, "data", "knowledge.db"),
      KNOWLEDGE_PUBLIC_BASE_URL: `${baseUrl}/v3`,
      API_PREFIX: "/v3",
      LOG_LEVEL: "silent",
      CLICKHOUSE_URL: "",
      KNOWLEDGE_CLICKHOUSE_ENABLED: "false",
      LANGFUSE_PUBLIC_KEY: "",
      LANGFUSE_SECRET_KEY: "",
      LANGFUSE_BASE_URL: "",
      LLM_API_KEY: "",
      LLM_BASE_URL: "",
      LLM_MODE: "proxy",
      TMC_CALLBACK_URL: "",
    };

    serverProcess = spawn(process.execPath, [binServer], {
      cwd: tmpDir,
      env: cleanServerEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });

    serverProcess.stdout!.on("data", () => {});
    serverProcess.stderr!.on("data", () => {});
    serverProcess.on("error", (err) => {
      console.error("Backing server process error:", err);
    });

    await waitForHttpOk(`${baseUrl}/health`, 15000);

    // 1. Seed a wiki identity on the backing server under mcp-service-id
    const seedRes = await fetch(`${baseUrl}/v3/wiki/create`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${serviceKey}`,
        "x-tdai-service-id": "mcp-service-id",
      },
      body: JSON.stringify({
        team_id: "mcp-team-id",
        name: "MCP Seeded Wiki",
        user_id: "mcp-user-id",
      }),
    });
    const seedJson = (await seedRes.json()) as { code: number; data: { wiki_id: string } };
    expect(seedJson.code).toBe(0);
    expect(seedJson.data.wiki_id).toBeDefined();
    seededWikiId = seedJson.data.wiki_id;

    // 2. Seed a distinctive page in the seeded wiki
    const pageWriteRes = await fetch(`${baseUrl}/v3/wiki/page/write`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${serviceKey}`,
        "x-tdai-service-id": "mcp-service-id",
      },
      body: JSON.stringify({
        team_id: "mcp-team-id",
        wiki_id: seededWikiId,
        pages: [
          {
            ref: distinctiveRef,
            content: distinctiveContent,
          },
        ],
      }),
    });
    expect(pageWriteRes.status).toBe(200);
    const pageWriteJson = (await pageWriteRes.json()) as { code: number };
    expect(pageWriteJson.code).toBe(0);
  });

  afterAll(async () => {
    let cleanupError: unknown = null;
    try {
      await stopProcess(foreignMcpProcess);
    } catch (err) {
      cleanupError = cleanupError ?? err;
    }
    try {
      await stopProcess(mcpProcess);
    } catch (err) {
      cleanupError = cleanupError ?? err;
    }
    try {
      await stopProcess(serverProcess);
    } catch (err) {
      cleanupError = cleanupError ?? err;
    }

    if (tmpDir && existsSync(tmpDir)) {
      try {
        rmSync(tmpDir, { recursive: true, force: true });
      } catch {}
    }

    if (cleanupError) {
      throw cleanupError;
    }
  });

  it("performs MCP initialize, tools/list, wiki_list, and reads distinctive page with verified identity and content", async () => {
    const cleanMcpEnv: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      NODE_ENV: "production",
      KNOWLEDGE_API_URL: baseUrl,
      KNOWLEDGE_SERVICE_KEY: serviceKey,
      KNOWLEDGE_API_TOKEN: serviceKey,
      KNOWLEDGE_SERVICE_ID: "mcp-service-id",
      LOG_LEVEL: "silent",
      CLICKHOUSE_URL: "",
      KNOWLEDGE_CLICKHOUSE_ENABLED: "false",
      LANGFUSE_PUBLIC_KEY: "",
      LANGFUSE_SECRET_KEY: "",
      LANGFUSE_BASE_URL: "",
      LLM_API_KEY: "",
      LLM_BASE_URL: "",
      LLM_MODE: "proxy",
      TMC_CALLBACK_URL: "",
    };

    const client = spawnMcpClient(binMcp, tmpDir, cleanMcpEnv);
    mcpProcess = client.process;

    // 1. Initialize Handshake
    const initRes = await client.sendRpc({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "smoke-client", version: "1.0.0" },
      },
    });

    expect(initRes.error).toBeUndefined();
    expect(initRes.result).toBeDefined();
    expect(initRes.result.serverInfo.name).toBe("knowledge-mcp");
    expect(initRes.result.serverInfo.version).toBe("0.1.0");
    expect(initRes.result.capabilities.tools).toBeDefined();

    // 2. Initialized Notification
    await client.sendRpc({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });

    // 3. List Tools Contract Verification
    const listRes = await client.sendRpc({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    });

    expect(listRes.error).toBeUndefined();
    expect(listRes.result).toBeDefined();
    expect(Array.isArray(listRes.result.tools)).toBe(true);

    const tools = listRes.result.tools as Array<{
      name: string;
      description: string;
      inputSchema: { properties: Record<string, unknown>; required: string[] };
    }>;

    // Verify all 12 registered tools exist; verify code_graph_list does not exist
    expect(tools.length).toBe(12);
    const toolNames = tools.map((t) => t.name);
    expect(toolNames).toContain("wiki_search");
    expect(toolNames).toContain("wiki_read");
    expect(toolNames).toContain("wiki_list");
    expect(toolNames).toContain("wiki_graph");
    expect(toolNames).toContain("code_search");
    expect(toolNames).toContain("code_explore");
    expect(toolNames).toContain("code_callers");
    expect(toolNames).toContain("code_callees");
    expect(toolNames).toContain("code_impact");
    expect(toolNames).toContain("code_node");
    expect(toolNames).toContain("code_status");
    expect(toolNames).toContain("code_files");
    expect(toolNames).not.toContain("code_graph_list");

    // Verify schemas
    const wikiListTool = tools.find((t) => t.name === "wiki_list");
    expect(wikiListTool).toBeDefined();
    expect(wikiListTool?.inputSchema.required).toEqual(["wiki_id"]);

    const wikiReadTool = tools.find((t) => t.name === "wiki_read");
    expect(wikiReadTool).toBeDefined();
    expect(wikiReadTool?.inputSchema.required).toEqual(["wiki_id", "refs"]);

    // 4. Call wiki_list with seeded wiki identity
    const listCallRes = await client.sendRpc({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "wiki_list",
        arguments: { wiki_id: seededWikiId },
      },
    });

    expect(listCallRes.error).toBeUndefined();
    expect(listCallRes.result).toBeDefined();
    expect(listCallRes.result.isError).toBe(false);
    expect(Array.isArray(listCallRes.result.content)).toBe(true);
    expect(listCallRes.result.content.length).toBeGreaterThanOrEqual(1);
    expect(listCallRes.result.content[0].type).toBe("text");
    expect(JSON.parse(listCallRes.result.content[0].text)).toEqual({ items: [] });

    // 5. Call wiki_read and verify exact distinctive page content returned
    const readCallRes = await client.sendRpc({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "wiki_read",
        arguments: {
          wiki_id: seededWikiId,
          refs: [distinctiveRef],
        },
      },
    });

    expect(readCallRes.error).toBeUndefined();
    expect(readCallRes.result).toBeDefined();
    expect(readCallRes.result.isError).toBe(false);
    expect(Array.isArray(readCallRes.result.content)).toBe(true);
    expect(readCallRes.result.content.length).toBeGreaterThanOrEqual(1);
    expect(readCallRes.result.content[0].type).toBe("text");

    const readParsed = JSON.parse(readCallRes.result.content[0].text) as {
      items: Array<{ ref: string; content: string }>;
    };
    expect(Array.isArray(readParsed.items)).toBe(true);
    expect(readParsed.items.length).toBe(1);
    expect(readParsed.items[0].ref).toBe(distinctiveRef);
    expect(readParsed.items[0].content).toBe(distinctiveContent);
    expect(readParsed.items[0].content).toContain("locked: true");

    // 6. Call Tool for unknown tool
    const unknownRes = await client.sendRpc({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: {
        name: "unknown_nonexistent_tool",
        arguments: {},
      },
    });

    expect(unknownRes.result.isError).toBe(true);
    expect(unknownRes.result.content[0].text).toContain("Unknown tool: unknown_nonexistent_tool");
  });

  it("rejects wiki_read when called from a foreign service tenant", async () => {
    const foreignMcpEnv: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      NODE_ENV: "production",
      KNOWLEDGE_API_URL: baseUrl,
      KNOWLEDGE_SERVICE_KEY: serviceKey,
      KNOWLEDGE_API_TOKEN: serviceKey,
      KNOWLEDGE_SERVICE_ID: "foreign-service-tenant",
      LOG_LEVEL: "silent",
      CLICKHOUSE_URL: "",
      KNOWLEDGE_CLICKHOUSE_ENABLED: "false",
      LANGFUSE_PUBLIC_KEY: "",
      LANGFUSE_SECRET_KEY: "",
      LANGFUSE_BASE_URL: "",
      LLM_API_KEY: "",
      LLM_BASE_URL: "",
      LLM_MODE: "proxy",
      TMC_CALLBACK_URL: "",
    };

    const foreignClient = spawnMcpClient(binMcp, tmpDir, foreignMcpEnv);
    foreignMcpProcess = foreignClient.process;

    // 1. Handshake
    const initRes = await foreignClient.sendRpc({
      jsonrpc: "2.0",
      id: 101,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "foreign-smoke-client", version: "1.0.0" },
      },
    });
    expect(initRes.error).toBeUndefined();
    expect(initRes.result?.serverInfo?.name).toBe("knowledge-mcp");

    await foreignClient.sendRpc({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });

    // 2. Attempt to read seeded wiki created under mcp-service-id
    const foreignReadRes = await foreignClient.sendRpc({
      jsonrpc: "2.0",
      id: 102,
      method: "tools/call",
      params: {
        name: "wiki_read",
        arguments: {
          wiki_id: seededWikiId,
          refs: [distinctiveRef],
        },
      },
    });

    expect(foreignReadRes.result).toBeDefined();
    expect(foreignReadRes.result.isError).toBe(true);
    expect(Array.isArray(foreignReadRes.result.content)).toBe(true);
    expect(foreignReadRes.result.content[0].text).toContain("wiki not found");

    await stopProcess(foreignMcpProcess);
    foreignMcpProcess = undefined;
  });
});
