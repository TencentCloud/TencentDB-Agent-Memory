import { afterEach, describe, expect, it, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { BackendClient } from "../src/offload/backend-client.js";
const limit = 16 * 1024 * 1024;
const logger = { info() {}, debug() {}, warn() {}, error() {} };
const servers: http.Server[] = [];
afterEach(async () => {
  if (vi.isFakeTimers()) { vi.clearAllTimers(); vi.useRealTimers(); }
  await Promise.all(servers.splice(0).map(async server => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }));
});
async function endpoint(handler: http.RequestListener) {
  const server = http.createServer(handler); servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
describe("offload response lifecycle and byte limits", () => {
  it("settles a truncated response promptly instead of leaving a pending call", async () => {
    const url = await endpoint((req, res) => {
      req.resume(); res.writeHead(200, { "Content-Length": 1024 }); res.write("{");
      setTimeout(() => res.destroy(), 20);
    });
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    try {
      const outcome = await Promise.race([
        new BackendClient(url, logger).storeState({}).then(() => "resolved", () => "rejected"),
        new Promise<string>(resolve => { watchdog = setTimeout(() => resolve("pending"), 750); }),
      ]);
      expect(outcome).toBe("rejected");
    } finally { clearTimeout(watchdog); }
  });
  it("does not retain a timeout when request construction rejects a header", async () => {
    vi.useFakeTimers();
    const client = new BackendClient("http://127.0.0.1:1", logger, undefined, undefined, undefined, () => "bad\nheader");
    await expect(client.storeState({})).rejects.toThrow();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("decodes UTF-8 after collecting bytes even when a codepoint spans chunks", async () => {
    const expected = "fixture-😀-漢字";
    const data = Buffer.from(JSON.stringify({ insertedId: expected }));
    const split = data.indexOf(Buffer.from("😀")) + 1;
    const url = await endpoint((req, res) => {
      req.resume(); res.write(data.subarray(0, split));
      setTimeout(() => res.end(data.subarray(split)), 30);
    });
    expect(await new BackendClient(url, logger).storeState({})).toEqual({ insertedId: expected });
  });
  it("rejects an advertised oversized response immediately", async () => {
    const url = await endpoint((req, res) => { req.resume(); res.setHeader("Content-Length", limit + 1); res.flushHeaders(); });
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    try {
      const outcome = await Promise.race([
        new BackendClient(url, logger).storeState({}).then(() => "resolved", (error: Error) => error.message),
        new Promise<string>(resolve => { watchdog = setTimeout(() => resolve("pending"), 750); }),
      ]);
      expect(outcome).toBe("Backend response exceeds 16 MiB");
    } finally { clearTimeout(watchdog); }
  });
  it("bounds chunked responses even without a Content-Length header", async () => {
    const url = await endpoint((req, res) => {
      req.resume(); res.write('{"insertedId":"'); res.end("a".repeat(limit) + '"}');
    });
    await expect(new BackendClient(url, logger).storeState({})).rejects.toThrow("Backend response exceeds 16 MiB");
  });
  it("accepts valid JSON exactly at the documented byte limit", async () => {
    const emptyBytes = Buffer.byteLength(JSON.stringify({ insertedId: "" }));
    const value = "a".repeat(limit - emptyBytes);
    const body = JSON.stringify({ insertedId: value }); expect(Buffer.byteLength(body)).toBe(limit);
    const url = await endpoint((req, res) => { req.resume(); res.end(body); });
    const result = await new BackendClient(url, logger).storeState({});
    expect(result.insertedId?.length).toBe(value.length);
  });
});
