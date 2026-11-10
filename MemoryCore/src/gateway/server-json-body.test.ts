/**
 * v1 handlers must reject non-object JSON bodies with 400 — a body of
 * `null`, `[]`, `"x"` or `1` parses fine but `body.x` access throws a
 * TypeError that surfaces as a 500.
 */
import { describe, it, expect, vi } from "vitest";
import { PassThrough } from "node:stream";
import type http from "node:http";
import { TdaiGateway, isPlainObject } from "./server.js";

describe("isPlainObject", () => {
  it("accepts plain objects", () => {
    expect(isPlainObject({})).toBe(true);
    expect(isPlainObject({ a: 1 })).toBe(true);
    expect(isPlainObject(Object.create(null))).toBe(true);
  });

  it("rejects non-object JSON values", () => {
    expect(isPlainObject(null)).toBe(false);
    expect(isPlainObject([])).toBe(false);
    expect(isPlainObject([1, 2])).toBe(false);
    expect(isPlainObject("x")).toBe(false);
    expect(isPlainObject(1)).toBe(false);
    expect(isPlainObject(true)).toBe(false);
    expect(isPlainObject(undefined)).toBe(false);
  });
});

function fakeReqWith(bodyJson: string): http.IncomingMessage {
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

describe("v1 handler non-object body rejection", () => {
  async function runRecall(bodyJson: string) {
    const handleBeforeRecall = vi.fn(async () => ({}));
    const gw = Object.create(TdaiGateway.prototype) as Record<string, unknown>;
    gw.logger = { debug() {}, info() {}, warn() {}, error() {} };
    gw.core = { handleBeforeRecall };
    const res = fakeRes();
    await (gw as unknown as {
      handleRecall(req: http.IncomingMessage, res: unknown): Promise<void>;
    }).handleRecall(fakeReqWith(bodyJson), res);
    return { res, handleBeforeRecall };
  }

  it.each(["null", "[1,2]", '"x"', "1"])("rejects %s with 400", async (bodyJson) => {
    const { res, handleBeforeRecall } = await runRecall(bodyJson);
    expect(res.status).toBe(400);
    expect(res.body).toContain("Request body must be a JSON object");
    expect(handleBeforeRecall).not.toHaveBeenCalled();
  });

  it("still reaches the field check for object bodies", async () => {
    const { res } = await runRecall("{}");
    expect(res.status).toBe(400);
    expect(res.body).toContain("Missing required fields");
  });
});
