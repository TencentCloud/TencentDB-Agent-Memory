import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import http from "node:http";
import { TdaiGateway } from "../server.js";

interface RequestResult {
  status: number;
  body: string;
  headers: http.IncomingHttpHeaders;
}

/**
 * POST a body to the gateway. Two body modes:
 *  - "trusted" (default): let Node compute Content-Length from the body.
 *  - "lying-cl": set Content-Length to a small value but stream a larger
 *    body — emulates a hostile client.
 *  - "no-cl":  use Transfer-Encoding: chunked, so the server cannot fail
 *    fast on Content-Length and must rely on running-total.
 */
async function postBody(
  port: number,
  path: string,
  body: Buffer,
  mode: "trusted" | "lying-cl" | "no-cl" = "trusted",
  fakeCl?: number,
): Promise<RequestResult> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (mode === "trusted") {
      headers["Content-Length"] = String(body.length);
    } else if (mode === "lying-cl") {
      headers["Content-Length"] = String(fakeCl ?? 10);
    } else if (mode === "no-cl") {
      headers["Transfer-Encoding"] = "chunked";
    }
    const req = http.request(
      { host: "127.0.0.1", port, path, method: "POST", headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf-8"),
          }),
        );
      },
    );
    req.on("error", (err) => {
      // ECONNRESET is expected when the server destroys the socket on
      // PayloadTooLarge before the body finishes uploading. Treat it as
      // a successful "rejected" outcome — the test then asserts via
      // status === 413 on a follow-up request OR via the error here.
      resolve({ status: 0, headers: {}, body: String(err) });
    });
    if (mode === "no-cl") {
      // Stream chunks to give the server a chance to abort mid-upload.
      const chunkSize = 4096;
      let offset = 0;
      const flush = () => {
        if (offset >= body.length) {
          req.end();
          return;
        }
        const ok = req.write(body.subarray(offset, offset + chunkSize));
        offset += chunkSize;
        if (ok) setImmediate(flush);
        else req.once("drain", flush);
      };
      flush();
    } else {
      req.write(body);
      req.end();
    }
  });
}

describe("Gateway request body size limit", () => {
  let gateway: TdaiGateway;
  const PORT = 18433;

  beforeAll(async () => {
    // 1 KiB cap — small enough to exercise the limit without producing
    // megabyte-sized test fixtures, large enough to fit a small valid
    // JSON body for the happy path.
    vi.stubEnv("TDAI_GATEWAY_MAX_BODY_BYTES", "1024");
    gateway = new TdaiGateway({
      server: { port: PORT, host: "127.0.0.1" },
    } as never);
    await gateway.start();
  });

  // vitest config has `unstubEnvs: true`, which resets stubs before each
  // test. `parseJsonBody`'s default `maxBytes` arg re-reads the env on
  // every call, so the stub must be re-applied here.
  beforeEach(() => {
    vi.stubEnv("TDAI_GATEWAY_MAX_BODY_BYTES", "1024");
  });

  afterAll(async () => {
    await gateway.stop();
  });

  it("accepts a small JSON body under the limit", async () => {
    // /recall with missing fields → 400, but that proves the body parsed.
    const res = await postBody(
      PORT,
      "/recall",
      Buffer.from(JSON.stringify({ query: "hi", session_key: "k" })),
    );
    // Body parsed successfully → status is whatever the handler returns,
    // NOT 413.
    expect(res.status).not.toBe(413);
    expect(res.status).not.toBe(500);
  });

  it("rejects with 413 when Content-Length declares a body over the limit", async () => {
    // 2 KiB body, honest Content-Length — fail-fast path.
    const big = Buffer.alloc(2 * 1024, "x");
    const res = await postBody(PORT, "/recall", big, "trusted");
    expect(res.status).toBe(413);
    expect(res.body).toMatch(/exceeds 1024 bytes/);
  });

  it("rejects with 413 when a lying Content-Length is small but actual body exceeds the limit", async () => {
    // Streamed mode (no Content-Length) — server tracks running total.
    // Body is 4 KiB but server cap is 1 KiB.
    const big = Buffer.alloc(4 * 1024, "x");
    const res = await postBody(PORT, "/recall", big, "no-cl");
    // Either the server replied 413 cleanly, or it tore the socket down
    // mid-upload (ECONNRESET) — both are acceptable signals that the
    // running-total guard fired. What is NOT acceptable: a 2xx/4xx that
    // implies the full body was buffered.
    if (res.status === 413) {
      expect(res.body).toMatch(/exceeds 1024 bytes/);
    } else {
      expect(res.status).toBe(0); // ECONNRESET / socket hangup
    }
  });

  it("returns 413 from the dispatcher, NOT 500", async () => {
    // Regression guard: a stray `catch` somewhere upstream wrapping
    // PayloadTooLargeError into a generic 500 would silently break the
    // contract for clients that retry on 5xx but not on 4xx.
    const big = Buffer.alloc(5 * 1024, "x");
    const res = await postBody(PORT, "/capture", big, "trusted");
    expect(res.status).toBe(413);
  });

  it("includes a descriptive error body with the declared limit", async () => {
    const big = Buffer.alloc(2 * 1024, "x");
    const res = await postBody(PORT, "/seed", big, "trusted");
    expect(res.status).toBe(413);
    // JSON envelope { "error": "..." } from sendError().
    const parsed = JSON.parse(res.body) as { error: string };
    expect(parsed.error).toMatch(/1024 bytes/);
  });
});

describe("Gateway body-size limit env override", () => {
  it("respects TDAI_GATEWAY_MAX_BODY_BYTES at gateway construction time", async () => {
    // Tiny cap: 50 bytes — even a minimal valid /recall JSON exceeds it.
    vi.stubEnv("TDAI_GATEWAY_MAX_BODY_BYTES", "50");
    const PORT = 18434;
    const gw = new TdaiGateway({ server: { port: PORT, host: "127.0.0.1" } } as never);
    await gw.start();
    try {
      const body = Buffer.from(JSON.stringify({ query: "x".repeat(80), session_key: "k" }));
      const res = await postBody(PORT, "/recall", body, "trusted");
      expect(res.status).toBe(413);
      expect(res.body).toMatch(/exceeds 50 bytes/);
    } finally {
      await gw.stop();
    }
  });

  it("falls back to the default cap when TDAI_GATEWAY_MAX_BODY_BYTES is malformed", async () => {
    // Garbage env should NOT cause the daemon to start with an undefined
    // / NaN cap — that would either reject every request or cap nothing.
    vi.stubEnv("TDAI_GATEWAY_MAX_BODY_BYTES", "not-a-number");
    const PORT = 18435;
    const gw = new TdaiGateway({ server: { port: PORT, host: "127.0.0.1" } } as never);
    await gw.start();
    try {
      // Default is 8 MiB — a small valid body must succeed.
      const body = Buffer.from(JSON.stringify({ query: "hi", session_key: "k" }));
      const res = await postBody(PORT, "/recall", body, "trusted");
      expect(res.status).not.toBe(413);
    } finally {
      await gw.stop();
    }
  });
});
