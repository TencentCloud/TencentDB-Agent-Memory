import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { callApi } from "../src/mcp/http-client.js";

const marker = "synthetic-private-memory-and-key";
const servers: Server[] = [];
async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test address");
  return `http://127.0.0.1:${address.port}`;
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  })));
});

function captureLogs() {
  return [vi.spyOn(console, "log"), vi.spyOn(console, "warn"), vi.spyOn(console, "error")]
    .map((spy) => spy.mockImplementation(() => {}));
}
async function failureText(promise: Promise<unknown>): Promise<string> {
  try { await promise; return "UNEXPECTED SUCCESS"; }
  catch (error) { return String(error); }
}

describe("MCP HTTP credential and diagnostic boundaries", () => {
  it.each([301, 302, 303, 307, 308])("refuses HTTP %i before contacting the redirect target", async (status) => {
    captureLogs();
    let targetRequests = 0;
    const target = await listen(createServer((_request, response) => {
      targetRequests++;
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ code: 0, data: { leaked: true } }));
    }));
    const origin = await listen(createServer((_request, response) => {
      response.writeHead(status, { Location: target + "/capture" });
      response.end();
    }));
    const error = await failureText(callApi({ baseUrl: origin, token: marker },
      "/wiki/page/read", { content: marker }));
    expect(targetRequests).toBe(0);
    expect(error).not.toBe("UNEXPECTED SUCCESS");
    expect(error).not.toContain(marker);
  });

  it.each([null, [], {}, { code: false }, { code: "0" }])("rejects a malformed response envelope: %j", async (envelope) => {
    captureLogs();
    const origin = await listen(createServer((_request, response) => {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify(envelope));
    }));
    const error = await failureText(callApi({ baseUrl: origin }, "/wiki/page/read", {}));
    expect(error).toContain("request rejected");
  });

  it("keeps an application error message out of logs and tool-facing errors", async () => {
    const logs = captureLogs();
    const origin = await listen(createServer((_request, response) => {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ code: marker, message: marker, data: { content: marker } }));
    }));
    const error = await failureText(callApi({ baseUrl: origin }, "/wiki/page/read", {}));
    expect(error).not.toBe("UNEXPECTED SUCCESS");
    expect(error).not.toContain(marker);
    expect(JSON.stringify(logs.flatMap((spy) => spy.mock.calls))).not.toContain(marker);
  });

  it("keeps invalid JSON response snippets out of logs", async () => {
    const logs = captureLogs();
    const origin = await listen(createServer((_request, response) => {
      response.end(`not-json-${marker}`);
    }));
    const error = await failureText(callApi({ baseUrl: origin }, "/wiki/page/read", {}));
    expect(error).not.toBe("UNEXPECTED SUCCESS");
    expect(error).not.toContain(marker);
    expect(JSON.stringify(logs.flatMap((spy) => spy.mock.calls))).not.toContain(marker);
  });

  it("keeps transport exceptions and configured URL credentials out of diagnostics", async () => {
    const logs = captureLogs();
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error(marker));
    const error = await failureText(callApi({ baseUrl: `http://${marker}@127.0.0.1:9` }, "/wiki/page/read", {}));
    expect(error).not.toBe("UNEXPECTED SUCCESS");
    expect(error).not.toContain(marker);
    expect(JSON.stringify(logs.flatMap((spy) => spy.mock.calls))).not.toContain(marker);
  });
});
