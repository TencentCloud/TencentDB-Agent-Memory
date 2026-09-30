import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { BackendClient } from "./backend-client.js";

const mocks = vi.hoisted(() => ({
  capturedOptions: [] as any[],
  httpsRequest: vi.fn(),
}));

vi.mock("node:https", () => ({
  request: mocks.httpsRequest,
}));

function makeLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function mockHttpsResponse(body: unknown) {
  mocks.httpsRequest.mockImplementation((options: any, callback?: (res: any) => void) => {
    mocks.capturedOptions.push(options);

    const req = new EventEmitter() as any;
    req.write = vi.fn();
    req.destroy = vi.fn((err?: Error) => req.emit("error", err ?? new Error("destroyed")));
    req.end = vi.fn(() => {
      const res = new EventEmitter() as any;
      res.statusCode = 200;
      res.statusMessage = "OK";
      callback?.(res);
      res.emit("data", Buffer.from(JSON.stringify(body)));
      res.emit("end");
    });
    return req;
  });

  return mocks.capturedOptions;
}

describe("BackendClient", () => {
  beforeEach(() => {
    mocks.capturedOptions.length = 0;
    mocks.httpsRequest.mockReset();
  });

  it("keeps TLS verification enabled and honors the configured backend timeout", async () => {
    const logger = makeLogger();
    const capturedOptions = mockHttpsResponse({ entries: [] });
    const client = new BackendClient(
      "https://memory-backend.example",
      logger,
      undefined,
      12_345,
    );

    await client.l1Summarize({ recentMessages: "", toolPairs: [] });

    expect(capturedOptions).toHaveLength(1);
    expect(capturedOptions[0]).not.toHaveProperty("rejectUnauthorized", false);
    expect(logger.debug).toHaveBeenCalledWith(
      expect.stringContaining("timeout=12345ms"),
    );
  });
});
