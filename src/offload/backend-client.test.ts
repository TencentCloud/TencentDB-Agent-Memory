import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BackendClient } from "./backend-client.js";
import type { PluginLogger } from "./types.js";

const httpMocks = vi.hoisted(() => ({
  request: vi.fn(),
}));

vi.mock("node:http", () => ({
  request: httpMocks.request,
}));

vi.mock("node:https", () => ({
  request: httpMocks.request,
}));

const logger: PluginLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

function makeSuccessfulRequest() {
  const req = new EventEmitter() as EventEmitter & {
    write: ReturnType<typeof vi.fn>;
    end: ReturnType<typeof vi.fn>;
    destroy: (err?: Error) => void;
  };
  req.write = vi.fn();
  req.end = vi.fn();
  req.destroy = (err?: Error) => {
    if (err) req.emit("error", err);
  };
  return req;
}

beforeEach(() => {
  vi.clearAllMocks();
  httpMocks.request.mockImplementation((_opts, callback: (res: EventEmitter & { statusCode: number; statusMessage: string }) => void) => {
    const req = makeSuccessfulRequest();
    queueMicrotask(() => {
      const res = new EventEmitter() as EventEmitter & {
        statusCode: number;
        statusMessage: string;
      };
      res.statusCode = 200;
      res.statusMessage = "OK";
      callback(res);
      res.emit("data", Buffer.from(JSON.stringify({ entries: [], insertedId: "state-1" })));
      res.emit("end");
    });
    return req;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("BackendClient", () => {
  it("uses the configured backend timeout for L1 backend calls", async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const client = new BackendClient("http://backend.example", logger, undefined, 4_321);

    await client.l1Summarize({ recentMessages: "hello", toolPairs: [] });

    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 4_321);
  });

  it("uses the configured backend timeout for state store uploads", async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const client = new BackendClient("http://backend.example", logger, undefined, 4_321);

    await client.storeState({ stage: "L3.report" });

    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 4_321);
  });
});
