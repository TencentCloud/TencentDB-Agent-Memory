import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";

const children = new Set<ChildProcessWithoutNullStreams>();
const servers = new Set<ReturnType<typeof createServer>>();

afterEach(async () => {
  for (const child of children) {
    if (!child.killed) child.kill();
  }
  children.clear();
  await Promise.all([...servers].map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve());
  })));
  servers.clear();
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
    authorization: string | undefined;
    body: unknown;
  }> = [];
  const server = createServer(async (req, res) => {
    const body = await readJsonBody(req);
    calls.push({
      method: req.method,
      url: req.url,
      authorization: req.headers.authorization,
      body,
    });
    await handler(req, body, res);
  });
  servers.add(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Gateway did not bind to a TCP port");
  return { url: `http://127.0.0.1:${address.port}`, calls };
}

function spawnMcp(env: Record<string, string> = {}) {
  const child = spawn(process.execPath, ["./bin/memory-tencentdb-mcp.mjs"], {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    stdio: "pipe",
  });
  children.add(child);
  return child;
}

function readJsonLine(child: ChildProcessWithoutNullStreams): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString("utf-8");
      const lineEnd = buffer.indexOf("\n");
      if (lineEnd < 0) return;
      cleanup();
      resolve(JSON.parse(buffer.slice(0, lineEnd)));
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    const onExit = (code: number | null) => {
      cleanup();
      reject(new Error(`MCP server exited before response: ${code}`));
    };
    const cleanup = () => {
      child.stdout.off("data", onData);
      child.off("error", onError);
      child.off("exit", onExit);
    };
    child.stdout.on("data", onData);
    child.on("error", onError);
    child.on("exit", onExit);
  });
}

async function requestLine(child: ChildProcessWithoutNullStreams, request: unknown) {
  const response = readJsonLine(child);
  child.stdin.write(`${JSON.stringify(request)}\n`);
  return response;
}

describe("memory-tencentdb MCP bridge", () => {
  it("lists memory search tools", async () => {
    const child = spawnMcp();

    await expect(requestLine(child, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    })).resolves.toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: {
        tools: [
          { name: "memory_tencentdb_memory_search" },
          { name: "memory_tencentdb_conversation_search" },
        ],
      },
    });
  });

  it("forwards search calls to the Gateway with clamped limit and auth", async () => {
    const gateway = await startGateway((_req, _body, res) => {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ results: "remembered", total: 1, strategy: "vector" }));
    });
    const child = spawnMcp({
      MEMORY_TENCENTDB_GATEWAY_URL: gateway.url,
      MEMORY_TENCENTDB_GATEWAY_API_KEY: "secret",
    });

    const response = await requestLine(child, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "memory_tencentdb_memory_search",
        arguments: {
          query: "adapter",
          limit: 99,
          scene: "opencode",
        },
      },
    });

    expect(response).toMatchObject({
      jsonrpc: "2.0",
      id: 2,
      result: { content: [{ type: "text" }] },
    });
    expect(gateway.calls).toEqual([
      {
        method: "POST",
        url: "/search/memories",
        authorization: "Bearer secret",
        body: {
          query: "adapter",
          limit: 20,
          scene: "opencode",
        },
      },
    ]);
  });
});

