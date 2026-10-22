import { mkdtempSync, rmSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StorageAdapter } from "../core/storage/adapter.js";
import { LocalStorageBackend } from "../core/storage/local-backend.js";
import { TdaiGateway } from "./server.js";

class CaptureResponse {
  statusCode = 0;
  body = "";

  setHeader(): this {
    return this;
  }

  writeHead(statusCode: number): this {
    this.statusCode = statusCode;
    return this;
  }

  end(chunk?: string | Buffer): this {
    this.body += chunk?.toString() ?? "";
    return this;
  }

  on(): this {
    return this;
  }
}

describe("offload request body limit", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("accepts a valid offload payload larger than the default 1 MiB route limit", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "tdai-offload-body-"));
    tempDirs.push(dataDir);

    const gateway = new TdaiGateway({
      deployMode: "standalone",
      data: { baseDir: dataDir },
      server: { host: "127.0.0.1", port: 0 },
    });
    const core = (gateway as unknown as {
      core: { setStorage(adapter: StorageAdapter): void };
    }).core;
    core.setStorage(new StorageAdapter(new LocalStorageBackend({ rootDir: dataDir })));

    const payload = JSON.stringify({
      session_id: "large-context",
      messages: [],
      ratio: 0,
      context_window: 2_000_000,
      total_tokens: 0,
      message_tokens: [],
      padding: "x".repeat(1024 * 1024),
    });
    const payloadBytes = Buffer.byteLength(payload);
    expect(payloadBytes).toBeGreaterThan(1024 * 1024);

    const req = Readable.from([Buffer.from(payload)]) as Readable & {
      method: string;
      url: string;
      headers: Record<string, string>;
      socket: { remoteAddress: string };
    };
    Object.assign(req, {
      method: "POST",
      url: "/v2/offload/compact",
      headers: {
        authorization: "Bearer test-key",
        "content-length": String(payloadBytes),
        "content-type": "application/json",
        "x-tdai-service-id": "offload-body-limit-test",
      },
      socket: { remoteAddress: "127.0.0.1" },
    });
    const res = new CaptureResponse();

    await (gateway as unknown as {
      handleRequest(req: Readable, res: ServerResponse): Promise<void>;
    }).handleRequest(req, res as unknown as ServerResponse);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({
      code: 0,
      data: { report: { resolvedLevel: "fastpath" } },
    });
  });

  it("honors the configured offload body limit", async () => {
    vi.stubEnv("MEMORY_OFFLOAD_MAX_BODY_BYTES", String(2 * 1024 * 1024));
    vi.resetModules();
    const { TdaiGateway: FreshGateway } = await import("./server.js");

    const dataDir = mkdtempSync(path.join(tmpdir(), "tdai-offload-body-configured-"));
    tempDirs.push(dataDir);
    const gateway = new FreshGateway({
      deployMode: "standalone",
      data: { baseDir: dataDir },
      server: { host: "127.0.0.1", port: 0 },
    });
    const core = (gateway as unknown as {
      core: { setStorage(adapter: StorageAdapter): void };
    }).core;
    core.setStorage(new StorageAdapter(new LocalStorageBackend({ rootDir: dataDir })));

    const payload = JSON.stringify({
      session_id: "configured-limit",
      messages: [],
      ratio: 0,
      context_window: 2_000_000,
      total_tokens: 0,
      message_tokens: [],
      // Schema ignores unknown fields; this makes the otherwise-valid request
      // cross the default 1 MiB parser boundary without slowing compaction.
      padding: "x".repeat(1024 * 1024),
    });
    const payloadBytes = Buffer.byteLength(payload);
    expect(payloadBytes).toBeGreaterThan(1024 * 1024);
    const req = Readable.from([Buffer.from(payload)]) as Readable & {
      method: string;
      url: string;
      headers: Record<string, string>;
      socket: { remoteAddress: string };
    };
    Object.assign(req, {
      method: "POST",
      url: "/v2/offload/compact",
      headers: {
        authorization: "Bearer test-key",
        "content-length": String(payloadBytes),
        "content-type": "application/json",
        "x-tdai-service-id": "offload-body-limit-test",
      },
      socket: { remoteAddress: "127.0.0.1" },
    });
    const res = new CaptureResponse();

    await (gateway as unknown as {
      handleRequest(req: Readable, res: ServerResponse): Promise<void>;
    }).handleRequest(req, res as unknown as ServerResponse);

    expect(res.statusCode).toBe(200);
  });
});
