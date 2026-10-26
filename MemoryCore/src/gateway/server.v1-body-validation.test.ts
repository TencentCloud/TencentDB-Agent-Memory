import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { clampV1SearchLimit, isNonEmptyString, parseJsonObjectBody, V1_SEARCH_MAX_LIMIT } from "./server.js";

let server: http.Server | undefined;

afterEach(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = undefined;
});

/** POST `raw` to a server whose handler runs parseJsonObjectBody and reports the outcome. */
async function parse(raw: string): Promise<{ ok: boolean; value?: unknown; error?: string }> {
  server = http.createServer(async (req, res) => {
    try {
      const value = await parseJsonObjectBody(req);
      res.end(JSON.stringify({ ok: true, value }));
    } catch (err) {
      res.end(JSON.stringify({ ok: false, error: (err as Error).message }));
    }
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  const res = await fetch(`http://127.0.0.1:${port}/`, { method: "POST", body: raw });
  return (await res.json()) as { ok: boolean; value?: unknown; error?: string };
}

describe("parseJsonObjectBody", () => {
  it("accepts JSON objects", async () => {
    expect(await parse('{"query":"q"}')).toEqual({ ok: true, value: { query: "q" } });
  });

  it.each(["null", "[]", "[1,2]", '"str"', "42", "true"])("rejects non-object body %s as Invalid JSON body", async (raw) => {
    expect(await parse(raw)).toEqual({ ok: false, error: "Invalid JSON body" });
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
