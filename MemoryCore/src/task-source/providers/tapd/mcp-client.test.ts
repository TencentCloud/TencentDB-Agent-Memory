import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { TapdMcpClient, parseJsonRpcBody } from "./mcp-client.js";

type Handler = (res: ServerResponse) => void;

let server: Server | undefined;
const open: ServerResponse[] = [];

async function serve(handler: Handler): Promise<string> {
  server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      open.push(res);
      handler(res);
    });
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

afterEach(async () => {
  for (const res of open.splice(0)) res.destroy();
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((r) => server!.close(() => r()));
    server = undefined;
  }
});

const ok = { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: '{"data":[{"id":"1"}],"count":1}' }] } };

describe("TapdMcpClient", () => {
  it("times out when the gateway stalls after sending headers", async () => {
    const endpoint = await serve((res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.write('{"jsonrpc":');
    });
    const client = new TapdMcpClient({ endpoint, token: "t", timeoutMs: 200 });
    await expect(client.call("stories_get", {})).rejects.toMatchObject({ code: "task_source_timeout" });
  }, 10_000);

  it("parses an SSE-framed JSON-RPC response", async () => {
    const endpoint = await serve((res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end(`event: message\ndata: ${JSON.stringify(ok)}\n\n`);
    });
    const client = new TapdMcpClient({ endpoint, token: "t" });
    await expect(client.call("stories_get", {})).resolves.toEqual([{ id: "1" }]);
  });

  it("still parses plain JSON responses", async () => {
    const endpoint = await serve((res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(ok));
    });
    const client = new TapdMcpClient({ endpoint, token: "t" });
    await expect(client.call("stories_get", {})).resolves.toEqual([{ id: "1" }]);
  });

  it("maps an unparseable body to task_source_upstream_error", async () => {
    const endpoint = await serve((res) => {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html>bad gateway</html>");
    });
    const client = new TapdMcpClient({ endpoint, token: "t" });
    await expect(client.call("stories_get", {})).rejects.toMatchObject({ code: "task_source_upstream_error" });
  });
});

describe("parseJsonRpcBody", () => {
  it("picks the last JSON-RPC response among SSE events, skipping notifications", () => {
    const body = [
      'data: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}',
      "",
      "data: " + JSON.stringify(ok),
      "",
      "",
    ].join("\r\n");
    expect(parseJsonRpcBody(body, "text/event-stream; charset=utf-8")).toEqual(ok);
  });
});
