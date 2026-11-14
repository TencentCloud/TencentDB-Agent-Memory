import { PassThrough } from "node:stream";
import type http from "node:http";
import { describe, expect, it, vi } from "vitest";
import { clampV1SearchLimit, isNonEmptyString, TdaiGateway, V1_SEARCH_MAX_LIMIT } from "./server.js";

function fakeReq(bodyJson: string): http.IncomingMessage {
  const pt = new PassThrough();
  const req = pt as unknown as http.IncomingMessage;
  req.headers = {};
  queueMicrotask(() => pt.end(bodyJson));
  return req;
}

function fakeRes() {
  return {
    status: 0,
    body: "",
    writeHead(status: number) {
      this.status = status;
    },
    end(body?: string) {
      if (body) this.body = body;
    },
  };
}

function gatewayWith(core: Record<string, unknown>) {
  const gw = Object.create(TdaiGateway.prototype) as Record<string, unknown>;
  gw.logger = { debug() {}, info() {}, warn() {}, error() {} };
  gw.core = core;
  return gw as unknown as Record<string, (req: http.IncomingMessage, res: unknown) => Promise<void>>;
}

describe("v1 handlers reject wrongly-typed required fields", () => {
  it.each([
    '{"query":123,"session_key":"s"}',
    '{"query":{"a":1},"session_key":"s"}',
    '{"query":"q","session_key":["s"]}',
  ])("recall %s -> 400 without calling core", async (bodyJson) => {
    const handleBeforeRecall = vi.fn();
    const res = fakeRes();
    await gatewayWith({ handleBeforeRecall }).handleRecall(fakeReq(bodyJson), res);
    expect(res.status).toBe(400);
    expect(handleBeforeRecall).not.toHaveBeenCalled();
  });

  it("search/memories with non-string query -> 400", async () => {
    const searchMemories = vi.fn();
    const res = fakeRes();
    await gatewayWith({ searchMemories }).handleSearchMemories(fakeReq('{"query":42}'), res);
    expect(res.status).toBe(400);
    expect(searchMemories).not.toHaveBeenCalled();
  });

  it("search/memories clamps an oversized limit before reaching core", async () => {
    const searchMemories = vi.fn(async () => ({ text: "", total: 0, strategy: "x" }));
    const res = fakeRes();
    await gatewayWith({ searchMemories }).handleSearchMemories(fakeReq('{"query":"q","limit":1000000000}'), res);
    expect(res.status).toBe(200);
    expect(searchMemories).toHaveBeenCalledWith(expect.objectContaining({ query: "q", limit: V1_SEARCH_MAX_LIMIT }));
  });

  it("search/conversations defaults a missing limit to 5", async () => {
    const searchConversations = vi.fn(async () => ({ text: "", total: 0 }));
    const res = fakeRes();
    await gatewayWith({ searchConversations }).handleSearchConversations(fakeReq('{"query":"q"}'), res);
    expect(searchConversations).toHaveBeenCalledWith(expect.objectContaining({ limit: 5 }));
  });
});

describe("isNonEmptyString", () => {
  it("only accepts non-empty strings", () => {
    expect(isNonEmptyString("a")).toBe(true);
    for (const v of ["", 1, {}, [], null, undefined, true]) expect(isNonEmptyString(v)).toBe(false);
  });
});

describe("clampV1SearchLimit", () => {
  it("defaults to 5 for missing or non-numeric values", () => {
    for (const v of [undefined, null, "abc", {}, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(clampV1SearchLimit(v)).toBe(5);
    }
  });

  it("clamps to [1, V1_SEARCH_MAX_LIMIT] and floors fractions", () => {
    expect(clampV1SearchLimit(0)).toBe(1);
    expect(clampV1SearchLimit(-10)).toBe(1);
    expect(clampV1SearchLimit(7.9)).toBe(7);
    expect(clampV1SearchLimit("12")).toBe(12);
    expect(clampV1SearchLimit(1e9)).toBe(V1_SEARCH_MAX_LIMIT);
  });
});
