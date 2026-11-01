import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/mcp/server.js";
import { callApi } from "../src/mcp/http-client.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";

vi.mock("../src/mcp/http-client.js", () => ({ callApi: vi.fn() }));
const marker = "synthetic-private-mcp-diagnostic";
const peers: { client: Client; server: ReturnType<typeof createMcpServer> }[] = [];
let logs: ReturnType<typeof vi.spyOn>[];
beforeEach(() => {
  vi.mocked(callApi).mockReset();
  logs = ["log", "warn", "error"].map((method) => vi.spyOn(console, method as "log").mockImplementation(() => {}));
});
afterEach(async () => {
  for (const peer of peers.splice(0)) { await peer.client.close(); await peer.server.close(); }
  vi.restoreAllMocks();
});
function diagnostics() { return JSON.stringify(logs.flatMap((spy) => spy.mock.calls)); }
async function connect() {
  const server = createMcpServer({ baseUrl: "http://127.0.0.1:9" });
  const client = new Client({ name: "synthetic-mcp-diagnostics", version: "1" });
  peers.push({ client, server });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);
  return client;
}
async function direct(mode: "success" | "failure") {
  const root = mkdtempSync(join(tmpdir(), "mcp-diagnostic-"));
  try {
    const preload = join(root, "preload.mjs");
    // The actual SDK class is patched only in this disposable child process.
    const sdk = new URL("../node_modules/@modelcontextprotocol/sdk/dist/esm/server/index.js", import.meta.url).href;
    writeFileSync(preload, `import {Server} from ${JSON.stringify(sdk)};Server.prototype.connect=async function(){${mode === "failure" ? "throw new Error(process.env.MCP_SYNTHETIC_MARKER)" : "return"}};`);
    return await new Promise<{ code: number; output: string }>((resolve, reject) => {
      execFile(process.execPath, ["--import", "tsx", "--import", preload, fileURLToPath(new URL("../src/mcp/server.ts", import.meta.url))], {
        timeout: 10000, env: { ...process.env, LOG_LEVEL: "debug", MCP_SYNTHETIC_MARKER: marker,
          KNOWLEDGE_API_URL: `http://synthetic-user:${marker}@127.0.0.1:9/${marker}` },
      }, (error, stdout, stderr) => {
        if (error && (typeof error.code !== "number" || error.killed)) return reject(new Error("Synthetic MCP child did not complete"));
        resolve({ code: typeof error?.code === "number" ? error.code : 0, output: stdout + stderr });
      });
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
}

describe("Knowledge MCP diagnostic privacy", () => {
  it("omits arbitrary unknown tool names from diagnostics", async () => {
    const client = await connect(); const result = await client.callTool({ name: marker, arguments: { private: marker } });
    expect(result.isError).toBe(true); expect(callApi).not.toHaveBeenCalled(); expect(diagnostics()).not.toContain(marker);
  });
  it("uses a fixed unknown-tool response without reflecting caller input", async () => {
    const client = await connect(); const result = await client.callTool({ name: marker });
    expect(result).toMatchObject({ isError: true, content: [{ type: "text", text: "Unknown tool" }] });
  });
  it("keeps injected HTTP-client failure details out of diagnostics", async () => {
    vi.mocked(callApi).mockRejectedValue(new Error(marker)); const client = await connect();
    const result = await client.callTool({ name: "wiki_read", arguments: { wiki_id: "synthetic-wiki", ref: marker } });
    expect(result.isError).toBe(true); expect(diagnostics()).not.toContain(marker);
  });
  it("preserves successful structured tool data without logging it", async () => {
    vi.mocked(callApi).mockResolvedValue({ private: marker }); const client = await connect();
    const result = await client.callTool({ name: "wiki_read", arguments: { wiki_id: "synthetic-wiki", ref: marker } });
    expect(result).toMatchObject({ isError: false, content: [{ type: "text", text: JSON.stringify({ private: marker }, null, 2) }] });
    expect(callApi).toHaveBeenCalledWith(expect.anything(), expect.any(String), { wiki_id: "synthetic-wiki", ref: marker });
    expect(diagnostics()).not.toContain(marker);
  });
  it.each([false, true])("preserves intentional text tool data with isError=%s", async (isError) => {
    vi.mocked(callApi).mockResolvedValue({ text: marker, isError }); const client = await connect();
    const result = await client.callTool({ name: "wiki_read", arguments: {} });
    expect(result).toMatchObject({ isError, content: [{ type: "text", text: marker }] }); expect(diagnostics()).not.toContain(marker);
  });
  it("preserves tool discovery without calling the HTTP API", async () => {
    const client = await connect(); const result = await client.listTools();
    expect(result.tools.map((tool) => tool.name)).toContain("wiki_read"); expect(callApi).not.toHaveBeenCalled();
  });
  it.each([false, true])("keeps actual stdio stdout protocol-only with HTTP call=%s", async (callHttp) => {
    const client = new Client({ name: "synthetic-stdio-diagnostics", version: "1" });
    const transport = new StdioClientTransport({ command: process.execPath,
      args: ["--import", "tsx", fileURLToPath(new URL("../src/mcp/server.ts", import.meta.url))],
      stderr: "pipe", env: { LOG_LEVEL: "debug", KNOWLEDGE_API_URL: "http://127.0.0.1:9" },
    });
    const protocolErrors: Error[] = [];
    transport.onerror = (error) => { protocolErrors.push(error); };
    try {
      await client.connect(transport);
      transport.stderr?.on("data", () => {});
      if (callHttp) {
        const response = await client.callTool({ name: "wiki_read", arguments: { wiki_id: "synthetic-wiki", ref: "synthetic-ref" } });
        expect(response.isError).toBe(true);
      } else {
        expect((await client.listTools()).tools.map((tool) => tool.name)).toContain("wiki_read");
      }
      expect(protocolErrors).toEqual([]);
    } finally { await client.close(); await transport.close(); }
  });
  it("keeps configured URL credentials/path out of direct startup diagnostics", async () => {
    const result = await direct("success"); expect(result.code).toBe(0); expect(result.output).toContain("MCP server connected"); expect(result.output).not.toContain(marker);
  });
  it("keeps connection failure details out of diagnostics while exiting nonzero", async () => {
    const result = await direct("failure"); expect(result.code).toBe(1); expect(result.output).not.toContain(marker);
  });
});
