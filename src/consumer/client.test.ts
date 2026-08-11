/**
 * tz-08 Ф1 — the client is transport, and its error model is the product.
 *
 * The cases that matter are the ones a caller would otherwise misread: an
 * unreachable gateway and a rebuilding index must NOT look like "memory holds
 * nothing", because a session that believes memory is empty writes down what
 * it already knows (ТЗ R2/S4).
 */
import { describe, it, expect } from "vitest";
import http from "node:http";
import { createMemoryConsumer } from "./client.js";

/** A stub gateway that answers exactly what the case is about. */
async function serve(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<{ url: string; close: () => Promise<void>; seen: RequestLog[] }> {
  const seen: RequestLog[] = [];
  const server = http.createServer((req, res) => {
    seen.push({
      method: req.method ?? "",
      url: req.url ?? "",
      token: req.headers["x-memory-token"],
      authorization: req.headers["authorization"],
    });
    handler(req, res);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    seen,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

interface RequestLog {
  method: string;
  url: string;
  token?: string | string[];
  authorization?: string;
}

const json = (res: http.ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};

const TOKEN = "tok-abc";

function consumer(url: string, token: string | undefined = TOKEN) {
  return createMemoryConsumer({ baseUrl: url, writeToken: async () => token });
}

describe("search", () => {
  it("passes the query through and returns what the server said", async () => {
    const s = await serve((_req, res) =>
      json(res, 200, { results: "one line", total: 1, strategy: "hybrid" }),
    );
    const r = await consumer(s.url).search({ query: "релиз", limit: 7 });
    await s.close();
    expect(r).toEqual({
      ok: true,
      results: "one line",
      total: 1,
      strategy: "hybrid",
    });
    // limit travels untouched: clamping lives on the server.
    expect(s.seen[0]?.url).toBe(
      "/memory/search?query=%D1%80%D0%B5%D0%BB%D0%B8%D0%B7&limit=7",
    );
  });

  it("never carries the write credential on a read", async () => {
    const s = await serve((_req, res) =>
      json(res, 200, { results: "", total: 0, strategy: "fts" }),
    );
    await consumer(s.url).search({ query: "x" });
    await s.close();
    expect(s.seen[0]?.token).toBeUndefined();
    expect(s.seen[0]?.authorization).toBeUndefined();
  });

  it("reports a rebuilding index as gated, not as an empty result", async () => {
    const s = await serve((_req, res) =>
      json(res, 200, {
        results: "",
        total: 0,
        strategy: "gated",
        gated: true,
      }),
    );
    const r = await consumer(s.url).search({ query: "x" });
    await s.close();
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.kind).toBe("gated");
  });

  it("reports an unreachable gateway as a value, not an exception or a blank", async () => {
    // Bound then closed: the port is guaranteed dead, no guessing.
    const s = await serve(() => undefined);
    const url = s.url;
    await s.close();
    const r = await consumer(url).search({ query: "x" });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.kind).toBe("unavailable");
  });

  it("keeps 4xx, 401 and 5xx apart", async () => {
    for (const [status, kind] of [
      [400, "bad-request"],
      [401, "unauthorized"],
      [500, "server-error"],
    ] as const) {
      const s = await serve((_req, res) => json(res, status, { error: "no" }));
      const r = await consumer(s.url).search({ query: "x" });
      await s.close();
      expect([status, r.ok === false && r.kind]).toEqual([status, kind]);
    }
  });

  it("treats a 200 with an unreadable body as a server error, not as empty", async () => {
    const s = await serve((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{not json");
    });
    const r = await consumer(s.url).search({ query: "x" });
    await s.close();
    expect(r.ok === false && r.kind).toBe("server-error");
  });
});

describe("note", () => {
  it("carries the credential and returns the write result", async () => {
    const s = await serve((_req, res) =>
      json(res, 200, {
        l0_recorded: 1,
        scheduler_notified: true,
        session_key: "s",
      }),
    );
    const r = await consumer(s.url).note({ content: "заметка" });
    await s.close();
    expect(r).toEqual({
      ok: true,
      l0Recorded: 1,
      schedulerNotified: true,
      sessionKey: "s",
    });
    expect(s.seen[0]?.token).toBe(TOKEN);
  });

  it("re-reads the credential once after a 401 and stops there", async () => {
    let calls = 0;
    const s = await serve((_req, res) => {
      calls += 1;
      if (calls === 1) return json(res, 401, { error: "unauthorized" });
      json(res, 200, {
        l0_recorded: 1,
        scheduler_notified: false,
        session_key: "s",
      });
    });
    const tokens = ["stale", "fresh"];
    let asked = 0;
    const c = createMemoryConsumer({
      baseUrl: s.url,
      writeToken: async (force) => {
        asked += 1;
        return force ? tokens[1] : tokens[0];
      },
    });
    const r = await c.note({ content: "x" });
    await s.close();
    expect(r.ok).toBe(true);
    expect([calls, asked]).toEqual([2, 2]);
    expect(s.seen.map((x) => x.token)).toEqual(["stale", "fresh"]);
  });

  it("gives up after a second 401 instead of hammering the gate", async () => {
    let calls = 0;
    const s = await serve((_req, res) => {
      calls += 1;
      json(res, 401, { error: "unauthorized" });
    });
    const r = await consumer(s.url).note({ content: "x" });
    await s.close();
    expect(r.ok === false && r.kind).toBe("unauthorized");
    expect(calls).toBe(2);
  });

  it("does not retry a 500 — one user action must not become several writes", async () => {
    let calls = 0;
    const s = await serve((_req, res) => {
      calls += 1;
      json(res, 500, { error: "boom" });
    });
    const r = await consumer(s.url).note({ content: "x" });
    await s.close();
    expect(r.ok === false && r.kind).toBe("server-error");
    expect(calls).toBe(1);
  });
});
