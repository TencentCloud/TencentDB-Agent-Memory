import { afterEach, describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { BackendClient } from "../src/offload/backend-client.js";

const marker = "synthetic-private-offload-value";
const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }));
});
async function endpoint(handler: http.RequestListener) {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
function client(url: string) {
  const logs: string[] = [];
  const log = (message: string) => { logs.push(message); };
  return { backend: new BackendClient(url, { info: log, debug: log, warn: log, error: log }, "fixture-key", undefined, undefined, () => "fixture-user", () => "fixture-task"), logs };
}

describe("offload backend transport error privacy", () => {
  it("retains authentication, identity headers and successful caller results", async () => {
    const received: http.IncomingHttpHeaders[] = [];
    const url = await endpoint((req, res) => {
      received.push(req.headers); req.resume();
      res.end(JSON.stringify({ insertedId: "fixture-id" }));
    });
    const { backend, logs } = client(url);
    expect(await backend.storeState({ value: marker })).toEqual({ insertedId: "fixture-id" });
    expect(received[0]?.authorization).toBe("Bearer fixture-key");
    expect(received[0]?.["x-user-id"]).toBe("fixture-user");
    expect(received[0]?.["x-task-id"]).toBe("fixture-task");
    expect(logs.join("\n")).not.toContain(marker);
    expect(logs.join("\n")).not.toContain("fixture-key");
  });
  it("omits non-success response bodies from logs and caller errors", async () => {
    const url = await endpoint((req, res) => { req.resume(); res.statusCode = 401; res.end(marker); });
    const { backend, logs } = client(url);
    const error = await backend.storeState({}).catch((error: Error) => error);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("401");
    expect((error as Error).message).not.toContain(marker);
    expect(logs.join("\n")).not.toContain(marker);
  });
  it("omits malformed JSON from logs and caller errors", async () => {
    const url = await endpoint((req, res) => { req.resume(); res.end(marker); });
    const { backend, logs } = client(url);
    await expect(backend.storeState({})).rejects.toThrow("Backend response JSON parse error");
    expect(logs.join("\n")).not.toContain(marker);
  });
  it("does not log credentials embedded in a configured URL", async () => {
    const url = await endpoint((req, res) => { req.resume(); res.end("{}"); });
    const credentialUrl = new URL(url); credentialUrl.username = "fixture-user"; credentialUrl.password = marker;
    const { backend, logs } = client(credentialUrl.href);
    expect(await backend.storeState({})).toEqual({});
    expect(logs.join("\n")).not.toContain(marker);
  });
  it("preserves the original serialization exception without logging it", async () => {
    const original = new Error(marker);
    const { backend, logs } = client("http://127.0.0.1:1");
    const payload = { get value(): string { throw original; } };
    await expect(backend.storeState(payload)).rejects.toBe(original);
    expect(logs.join("\n")).not.toContain(marker);
  });
  it("rejects unsupported URL protocols before any network request", async () => {
    let hits = 0;
    const url = await endpoint((req, res) => { hits++; req.resume(); res.end("{}"); });
    const { backend } = client(url.replace("http:", "ftp:"));
    await expect(backend.storeState({})).rejects.toThrow("Backend URL must use HTTP or HTTPS");
    expect(hits).toBe(0);
  });
  it.each([301, 302, 303, 307, 308])("does not follow %i or expose its body", async (status) => {
    let forwarded = 0;
    const destination = await endpoint((req, res) => { forwarded++; req.resume(); res.end("{}"); });
    const url = await endpoint((req, res) => { req.resume(); res.writeHead(status, { Location: destination }); res.end(marker); });
    const { backend, logs } = client(url);
    const error = await backend.storeState({ value: marker }).catch((error: Error) => error);
    expect(error).toBeInstanceOf(Error);
    expect(forwarded).toBe(0);
    expect((error as Error).message).toContain(String(status));
    expect((error as Error).message).not.toContain(marker);
    expect(logs.join("\n")).not.toContain(marker);
  });
});
