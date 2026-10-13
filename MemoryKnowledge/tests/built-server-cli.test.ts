import { describe, expect, it, afterAll, beforeAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  mkdirSync,
  copyFileSync,
  cpSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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
      // Server not ready yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Timed out waiting for HTTP OK at ${url} after ${timeoutMs}ms`);
}

describe("Real built server CLI (bin/server.mjs)", () => {
  let tmpDir: string;
  let serverProcess: ChildProcess;
  let specialProcess: ChildProcess | undefined;
  let specialMcpProcess: ChildProcess | undefined;
  let importProcess: ChildProcess | undefined;
  let port: number;
  let baseUrl: string;
  let serviceKey: string;
  let seededWikiId: string;
  const projectRoot = fileURLToPath(new URL("..", import.meta.url));
  const binServer = join(projectRoot, "bin", "server.mjs");
  const binMcp = join(projectRoot, "bin", "mcp.mjs");
  const distServer = join(projectRoot, "dist", "server.mjs");

  beforeAll(async () => {
    if (!existsSync(distServer)) {
      throw new Error(`dist/server.mjs not found at ${distServer}. Run build first.`);
    }

    tmpDir = mkdtempSync(join(tmpdir(), "knowledge-built-cli-test-"));
    port = await getFreePort();
    baseUrl = `http://127.0.0.1:${port}`;
    serviceKey = `smoke-service-key-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const cleanEnv: NodeJS.ProcessEnv = {
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
      // Explicitly isolate from any inherited provider or telemetry settings
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
      env: cleanEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });

    serverProcess.stdout!.on("data", () => {});
    serverProcess.stderr!.on("data", () => {});
    serverProcess.on("error", (err) => {
      console.error("Built server CLI process error:", err);
    });

    await waitForHttpOk(`${baseUrl}/health`, 15000);
  });

  afterAll(async () => {
    let cleanupError: unknown = null;
    try { await stopProcess(importProcess); } catch (err) { cleanupError = err; }
    try {
      await stopProcess(specialMcpProcess);
    } catch (err) {
      cleanupError = cleanupError ?? err;
    }
    try {
      await stopProcess(specialProcess);
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

  it("serves GET /health with status ok", async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("ok");
  });

  it("verifies service authorization on protected endpoints", async () => {
    // 1. Missing bearer token -> 401
    const unauthRes = await fetch(`${baseUrl}/v3/wiki/list`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-tdai-service-id": "synth-service-id",
      },
      body: JSON.stringify({ team_id: "synth-team-id" }),
    });
    expect(unauthRes.status).toBe(401);
    const unauthBody = (await unauthRes.json()) as { code: number; message: string };
    expect(unauthBody.code).toBe(401);

    // 2. Invalid bearer token -> 401
    const badTokenRes = await fetch(`${baseUrl}/v3/wiki/list`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer invalid-service-key-wrong",
        "x-tdai-service-id": "synth-service-id",
      },
      body: JSON.stringify({ team_id: "synth-team-id" }),
    });
    expect(badTokenRes.status).toBe(401);

    // 3. Valid serviceKey -> 200
    const validRes = await fetch(`${baseUrl}/v3/wiki/list`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${serviceKey}`,
        "x-tdai-service-id": "synth-service-id",
      },
      body: JSON.stringify({ team_id: "synth-team-id" }),
    });
    expect(validRes.status).toBe(200);
    const validBody = (await validRes.json()) as {
      code: number;
      data: { items: unknown[]; total: number };
    };
    expect(validBody.code).toBe(0);
    expect(Array.isArray(validBody.data.items)).toBe(true);
    expect(typeof validBody.data.total).toBe("number");
  });

  it("creates, retrieves, and lists a seeded wiki with verified identity and contract", async () => {
    const seededName = "Seeded Smoke Wiki " + Date.now();

    // Create wiki
    const createRes = await fetch(`${baseUrl}/v3/wiki/create`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${serviceKey}`,
        "x-tdai-service-id": "synth-service-id",
      },
      body: JSON.stringify({
        team_id: "synth-team-id",
        name: seededName,
        user_id: "smoke-user-id",
      }),
    });

    expect([200, 201]).toContain(createRes.status);
    const createBody = (await createRes.json()) as {
      code: number;
      data: { wiki_id: string; name: string; team_id: string; service_url: string | null };
    };
    expect(createBody.code).toBe(0);
    expect(createBody.data.wiki_id).toMatch(/^wiki-[0-9a-z]{8}$/);
    expect(createBody.data.name).toBe(seededName);
    expect(createBody.data.team_id).toBe("synth-team-id");
    expect(createBody.data.service_url).toBe(`${baseUrl}/v3`);

    seededWikiId = createBody.data.wiki_id;

    // Retrieve wiki by ID
    const getRes = await fetch(`${baseUrl}/v3/wiki/get`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${serviceKey}`,
        "x-tdai-service-id": "synth-service-id",
      },
      body: JSON.stringify({ wiki_id: seededWikiId }),
    });

    expect(getRes.status).toBe(200);
    const getBody = (await getRes.json()) as {
      code: number;
      data: { wiki_id: string; name: string; team_id: string };
    };
    expect(getBody.code).toBe(0);
    expect(getBody.data.wiki_id).toBe(seededWikiId);
    expect(getBody.data.name).toBe(seededName);
    expect(getBody.data.team_id).toBe("synth-team-id");

    // List wikis and verify contract: data is an object containing items array and total count
    const listRes = await fetch(`${baseUrl}/v3/wiki/list`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${serviceKey}`,
        "x-tdai-service-id": "synth-service-id",
      },
      body: JSON.stringify({ team_id: "synth-team-id" }),
    });

    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as {
      code: number;
      data: { items: Array<{ wiki_id: string; name: string; team_id: string }>; total: number };
    };
    expect(listBody.code).toBe(0);
    expect(Array.isArray(listBody.data.items)).toBe(true);
    expect(listBody.data.total).toBeGreaterThanOrEqual(1);

    const found = listBody.data.items.find((w) => w.wiki_id === seededWikiId);
    expect(found).toBeDefined();
    expect(found?.name).toBe(seededName);
    expect(found?.team_id).toBe("synth-team-id");
  });

  it("regression: executes launcher and preserves import-without-start from path with spaces and #", async () => {
    const specialDir = join(tmpDir, "path with spaces and #hash");
    mkdirSync(join(specialDir, "bin"), { recursive: true });
    mkdirSync(join(specialDir, "dist"), { recursive: true });

    copyFileSync(binServer, join(specialDir, "bin", "server.mjs"));
    copyFileSync(binMcp, join(specialDir, "bin", "mcp.mjs"));
    cpSync(join(projectRoot, "dist"), join(specialDir, "dist"), { recursive: true });
    copyFileSync(join(projectRoot, "package.json"), join(specialDir, "package.json"));
    symlinkSync(join(projectRoot, "node_modules"), join(specialDir, "node_modules"), "dir");

    const specialPort = await getFreePort();
    const specialBaseUrl = `http://127.0.0.1:${specialPort}`;

    const specialEnv: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      NODE_ENV: "production",
      PORT: String(specialPort),
      HOST: "127.0.0.1",
      KNOWLEDGE_HOST: "127.0.0.1",
      KNOWLEDGE_SERVICE_KEY: serviceKey,
      KNOWLEDGE_ALLOW_INSECURE_NO_KEY_LISTEN: "false",
      KNOWLEDGE_DATA_DIR: join(specialDir, "data"),
      KNOWLEDGE_DB_PATH: join(specialDir, "data", "knowledge.db"),
      KNOWLEDGE_PUBLIC_BASE_URL: `${specialBaseUrl}/v3`,
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

    // 1. Direct server launcher execution test from special path
    specialProcess = spawn(process.execPath, [join(specialDir, "bin", "server.mjs")], {
      cwd: specialDir,
      env: specialEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });

    specialProcess.stdout!.on("data", () => {});
    specialProcess.stderr!.on("data", () => {});

    await waitForHttpOk(`${specialBaseUrl}/health`, 15000);
    const healthRes = await fetch(`${specialBaseUrl}/health`);
    expect(healthRes.status).toBe(200);

    await stopProcess(specialProcess);
    specialProcess = undefined;

    // 2. Direct MCP launcher execution test from special path
    const specialMcpEnv: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      NODE_ENV: "production",
      KNOWLEDGE_API_URL: baseUrl,
      KNOWLEDGE_SERVICE_KEY: serviceKey,
      KNOWLEDGE_API_TOKEN: serviceKey,
      KNOWLEDGE_SERVICE_ID: "special-service-id",
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

    specialMcpProcess = spawn(process.execPath, [join(specialDir, "bin", "mcp.mjs")], {
      cwd: specialDir,
      env: specialMcpEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });

    specialMcpProcess.stderr!.on("data", () => {});

    const initMcpPromise = new Promise<any>((resolve, reject) => {
      let buf = "";
      const timeout = setTimeout(() => {
        reject(new Error("Timeout waiting for MCP initialize response from special path"));
      }, 10000);

      const onData = (chunk: Buffer) => {
        buf += chunk.toString("utf8");
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const parsed = JSON.parse(trimmed);
            if (parsed.id === 1) {
              clearTimeout(timeout);
              specialMcpProcess?.stdout?.removeListener("data", onData);
              resolve(parsed);
              return;
            }
          } catch {}
        }
      };
      specialMcpProcess!.stdout!.on("data", onData);
      specialMcpProcess!.on("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });

    specialMcpProcess.stdin!.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "special-smoke-client", version: "1.0.0" },
        },
      }) + "\n",
    );

    const initMcpRes = await initMcpPromise;
    expect(initMcpRes.error).toBeUndefined();
    expect(initMcpRes.result?.serverInfo?.name).toBe("knowledge-mcp");

    await stopProcess(specialMcpProcess);
    specialMcpProcess = undefined;

    // 3. Import-without-start probe from special path (natural process exit required)
    const importerScript = join(specialDir, "test-importer.mjs");
    writeFileSync(
      importerScript,
      `import { createApp } from "./dist/server.mjs";
import { createMcpServer } from "./dist/mcp/server.mjs";

if (typeof createApp !== "function") {
  throw new Error("createApp is not a function");
}
if (typeof createMcpServer !== "function") {
  throw new Error("createMcpServer is not a function");
}
// Natural event loop exhaustion required; no process.exit(0)
`,
    );

    const probeExitResult = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      const imp = spawn(process.execPath, [importerScript], {
        cwd: specialDir,
        env: specialEnv,
        stdio: ["pipe", "pipe", "pipe"],
      });
      importProcess = imp;
      imp.stdout?.on("data", () => {});
      let stderrOut = "";
      imp.stderr?.on("data", (c) => { stderrOut += c.toString(); });
      const timer = setTimeout(() => {
        imp.kill("SIGKILL");
        reject(new Error(`Importer probe timed out; process did not exit naturally (indicates server started on import). Stderr: ${stderrOut}`));
      }, 5000);
      imp.once("exit", (code, signal) => {
        clearTimeout(timer);
        resolve({ code, signal });
      });
      imp.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    expect(probeExitResult.code).toBe(0);
    expect(probeExitResult.signal).toBeNull();
  });
});
