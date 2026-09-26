/**
 * Regression tests for https://github.com/TencentCloud/TencentDB-Agent-Memory/issues/1157
 *
 * undici@8 runs `setGlobalDispatcher(new Agent())` at module load when
 * `Symbol.for("undici.globalDispatcher.2")` is unset. That also overwrites the
 * legacy `Symbol.for("undici.globalDispatcher.1")` slot that Node's built-in
 * fetch reads — discarding a pre-configured dispatcher such as Node's
 * EnvHttpProxyAgent (NODE_USE_ENV_PROXY=1), so process-wide fetch() silently
 * bypasses HTTP(S)_PROXY.
 *
 * Importing this module (via the static import chain
 * gateway/server.ts → store-pool.ts → tcvdb.ts → tcvdb-client.ts) must not
 * clobber a pre-existing legacy global dispatcher.
 */
import { afterEach, describe, expect, it } from "vitest";
import http from "node:http";
import { AddressInfo } from "node:net";

const LEGACY_GLOBAL_DISPATCHER = Symbol.for("undici.globalDispatcher.1");
const V2_GLOBAL_DISPATCHER = Symbol.for("undici.globalDispatcher.2");

/** Minimal dispatcher stand-in: only needs a dispatch method to be a valid sentinel. */
class SentinelDispatcher {
  dispatch(): boolean {
    return false;
  }
}

describe("tcvdb-client import side effects", () => {
  const g = globalThis as Record<symbol, unknown>;
  let savedV1: unknown;
  let savedV2: unknown;

  afterEach(() => {
    // restore whatever the test run had before, so other suites are unaffected.
    // (the globals are defined with configurable:false — reassign, don't delete)
    if (savedV1 !== undefined) g[LEGACY_GLOBAL_DISPATCHER] = savedV1;
    if (savedV2 !== undefined) g[V2_GLOBAL_DISPATCHER] = savedV2;
  });

  it("does not clobber a pre-existing legacy global dispatcher on import", async () => {
    savedV1 = g[LEGACY_GLOBAL_DISPATCHER];
    savedV2 = g[V2_GLOBAL_DISPATCHER];
    const sentinel = new SentinelDispatcher();
    g[LEGACY_GLOBAL_DISPATCHER] = sentinel;
    // simulate a fresh process where undici@8 has not initialized .2 yet
    // (reassignment, since the property may be defined as configurable:false)
    g[V2_GLOBAL_DISPATCHER] = undefined;

    await import("./tcvdb-client.js");

    expect(g[LEGACY_GLOBAL_DISPATCHER]).toBe(sentinel);
  });
});

describe("TcvdbClient.request", () => {
  it("round-trips a VectorDB API envelope over HTTP", async () => {
    const seen: Array<{ path: string; auth: string | undefined; body: string }> = [];
    const server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        seen.push({ path: req.url ?? "", auth: req.headers.authorization, body: raw });
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ code: 0, msg: "ok", affectedCount: 3 }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;

    try {
      // import after the side-effect test above has restored globals
      const { TcvdbClient } = await import("./tcvdb-client.js");
      const client = new TcvdbClient({
        url: `127.0.0.1:${port}`, // intentionally scheme-less: constructor must prepend http://
        username: "root",
        apiKey: "test-key",
        database: "db_test",
        timeout: 5000,
      });

      const affected = await client.deleteDoc("coll", { filter: "1=1" });
      expect(affected).toBe(3);
      expect(seen).toHaveLength(1);
      expect(seen[0].path).toBe("/document/delete");
      expect(seen[0].auth).toBe("Bearer account=root&api_key=test-key");
      expect(JSON.parse(seen[0].body)).toMatchObject({
        database: "db_test",
        collection: "coll",
        filter: "1=1",
      });
    } finally {
      server.close();
    }
  });
});
