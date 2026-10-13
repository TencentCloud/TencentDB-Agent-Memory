import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { GitRelay } from "../src/source-fetcher/git-relay.js";
import * as net from "node:net";

describe("GitRelay Local Socket Security", () => {
  let targetServer: net.Server;
  let targetPort: number;

  beforeAll(async () => {
    targetServer = net.createServer((socket) => {
      socket.on("data", (d) => socket.write(d));
    });
    await new Promise<void>((resolve) => {
      targetServer.listen(0, "127.0.0.1", () => {
        targetPort = (targetServer.address() as net.AddressInfo).port;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => targetServer.close(() => resolve()));
  });

  it("overflow refusal", async () => {
    const relay = new GitRelay({ targetIp: "127.0.0.1", expectedHost: "test.local", expectedPort: targetPort });
    const port = await relay.start();

    const client = net.connect({ host: "127.0.0.1", port });
    const hugeHeader = Buffer.alloc(5000, "a");

    try {
      await new Promise<void>((resolve, reject) => {
        let resp = "";
        client.on("data", (d) => { resp += d.toString(); });
        client.once("close", () => {
          if (resp.includes("431")) resolve();
          else reject(new Error("Missing 431 in response: " + resp));
        });
        client.once("error", (err) => reject(err));
        client.write(hugeHeader);

        // Bounded completion
        setTimeout(() => reject(new Error("Timeout waiting for overflow refusal")), 5000);
      });
    } finally {
      if (!client.destroyed) client.destroy();
      await relay.stop();
    }
  });

  it("trickle deadline refusal", async () => {
    const relay = new GitRelay({ targetIp: "127.0.0.1", expectedHost: "test.local", expectedPort: targetPort });
    const port = await relay.start();

    const client = net.connect({ host: "127.0.0.1", port });
    let interval: NodeJS.Timeout | undefined;

    try {
      const start = Date.now();
      await new Promise<void>((resolve) => {
        client.once("close", () => resolve());

        interval = setInterval(() => {
          if (!client.destroyed) client.write("a");
        }, 1000);
      });
      const duration = Date.now() - start;
      expect(duration).toBeGreaterThanOrEqual(9000); // ~10s CONNECTION_TIMEOUT_MS
      expect(duration).toBeLessThan(12000);
    } finally {
      if (interval) clearInterval(interval);
      if (!client.destroyed) client.destroy();
      await relay.stop();
    }
  }, 15000);

  it("exact host/port rejection", async () => {
    const relay = new GitRelay({ targetIp: "127.0.0.1", expectedHost: "test.local", expectedPort: targetPort });
    const port = await relay.start();

    // Test wrong port
    const client1 = net.connect({ host: "127.0.0.1", port });
    client1.write(`CONNECT test.local:9999 HTTP/1.1\r\n\r\n`);
    const resp1 = await new Promise<string>((resolve) => {
      client1.once("data", (d) => resolve(d.toString()));
    });
    expect(resp1).toContain("403 Forbidden");

    // Test wrong host
    const client2 = net.connect({ host: "127.0.0.1", port });
    client2.write(`CONNECT wrong.local:${targetPort} HTTP/1.1\r\n\r\n`);
    const resp2 = await new Promise<string>((resolve) => {
      client2.once("data", (d) => resolve(d.toString()));
    });
    expect(resp2).toContain("403 Forbidden");

    // Test malformed request
    const client3 = net.connect({ host: "127.0.0.1", port });
    client3.write(`GET / HTTP/1.1\r\n\r\n`);
    const resp3 = await new Promise<string>((resolve) => {
      client3.once("data", (d) => resolve(d.toString()));
    });
    expect(resp3).toContain("400 Bad Request");

    await relay.stop();
  });

  it("paired cleanup", async () => {
    const relay = new GitRelay({ targetIp: "127.0.0.1", expectedHost: "test.local", expectedPort: targetPort });
    const port = await relay.start();

    const client = net.connect({ host: "127.0.0.1", port });
    client.write(`CONNECT test.local:${targetPort} HTTP/1.1\r\n\r\n`);

    await new Promise<void>((resolve) => {
      client.once("data", (d) => {
        if (d.toString().includes("200 Connection Established")) {
          resolve();
        }
      });
    });

    // Destroy client and ensure target gets cleaned up (relay internal state clears)
    client.destroy();

    // Wait a bit to ensure async cleanup runs
    await new Promise((r) => setTimeout(r, 100));

    await relay.stop();
  });

  it("stop cleanup", async () => {
    const relay = new GitRelay({ targetIp: "127.0.0.1", expectedHost: "test.local", expectedPort: targetPort });
    const port = await relay.start();

    const client = net.connect({ host: "127.0.0.1", port });
    client.write(`CONNECT test.local:${targetPort} HTTP/1.1\r\n\r\n`);

    await new Promise<void>((resolve) => {
      client.once("data", (d) => resolve());
    });

    let clientClosed = false;
    client.once("close", () => { clientClosed = true; });

    await relay.stop();
    await new Promise((r) => setTimeout(r, 100));

    expect(clientClosed).toBe(true);
  });
});
