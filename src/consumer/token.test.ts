/**
 * tz-08 Ф2 — the write credential is discovered, never assumed.
 *
 * Two things are being proven here, and they are both product properties:
 *   1. the path comes from the gateway (`GET /memory/info`), so nothing in the
 *      consumer knows where a token file lives — tz-07 made that path depend
 *      on configuration, and a hardcoded copy would break silently on any
 *      host that configured its data dir differently;
 *   2. the value never reaches a log line, in ANY failure branch.
 *
 * The last case runs the REAL client against a stub gateway: a stale token,
 * one 401, one re-read, one retry, and no more.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createWriteTokenReader } from "./token.js";
import { createMemoryConsumer } from "./client.js";

let tmp: string;
let tokenFile: string;
let logs: string[];

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tz08-token-"));
  tokenFile = path.join(tmp, "tdai-gateway.token");
  logs = [];
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const logger = { warn: (m: string) => void logs.push(m) };

interface Stub {
  url: string;
  close: () => Promise<void>;
  /** Requests seen, in order: `${method} ${path}`. */
  seen: string[];
  noteTokens: (string | undefined)[];
}

/**
 * A stub gateway. `infoPath` is what `/memory/info` claims — a function so a
 * case can move the token file between calls, the way a restarted gateway
 * with a reconfigured data dir would.
 */
async function serve(opts: {
  infoPath?: () => string | undefined;
  infoStatus?: number;
  note?: (n: number) => { status: number };
}): Promise<Stub> {
  const seen: string[] = [];
  const noteTokens: (string | undefined)[] = [];
  let notes = 0;
  const server = http.createServer((req, res) => {
    const url = (req.url ?? "").split("?")[0] ?? "";
    seen.push(`${req.method} ${url}`);
    if (url === "/memory/info") {
      const status = opts.infoStatus ?? 200;
      const tokenPath = opts.infoPath?.();
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          dataDir: tmp,
          ...(tokenPath ? { tokenPath } : {}),
          version: "test",
        }),
      );
      return;
    }
    if (url === "/memory/note") {
      notes += 1;
      noteTokens.push(req.headers["x-memory-token"] as string | undefined);
      const { status } = opts.note?.(notes) ?? { status: 200 };
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify(
          status === 200
            ? { l0_recorded: 1, scheduler_notified: false, session_key: "s" }
            : { error: "unauthorized" },
        ),
      );
      return;
    }
    res.writeHead(404).end("{}");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    seen,
    noteTokens,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

describe("write credential", () => {
  it("asks the gateway where the token file is and reads it from there", async () => {
    fs.writeFileSync(tokenFile, "secret-value-aaa\n");
    const s = await serve({ infoPath: () => tokenFile });
    const read = createWriteTokenReader({ baseUrl: s.url, logger });

    expect(await read()).toBe("secret-value-aaa");
    // Second call is served from the process cache: no second discovery.
    expect(await read()).toBe("secret-value-aaa");
    await s.close();
    expect(s.seen).toEqual(["GET /memory/info"]);
  });

  it("re-discovers the path on a forced refresh, so a moved file is found", async () => {
    // The gateway restarts against a different data dir: new path, new value.
    const moved = path.join(tmp, "moved.token");
    fs.writeFileSync(tokenFile, "old-value\n");
    fs.writeFileSync(moved, "new-value\n");
    let current = tokenFile;
    const s = await serve({ infoPath: () => current });
    const read = createWriteTokenReader({ baseUrl: s.url, logger });

    expect(await read()).toBe("old-value");
    current = moved;
    expect(await read(true)).toBe("new-value");
    await s.close();
    expect(s.seen).toEqual(["GET /memory/info", "GET /memory/info"]);
  });

  it("reports every unusable source as a value, never as a throw", async () => {
    const cases: Array<[string, () => Promise<unknown>]> = [
      [
        "no tokenPath in the answer",
        async () => {
          const s = await serve({ infoPath: () => undefined });
          const r = await createWriteTokenReader({
            baseUrl: s.url,
            logger,
          })();
          await s.close();
          return r;
        },
      ],
      [
        "info route refuses",
        async () => {
          const s = await serve({ infoPath: () => tokenFile, infoStatus: 503 });
          const r = await createWriteTokenReader({
            baseUrl: s.url,
            logger,
          })();
          await s.close();
          return r;
        },
      ],
      [
        "file is missing",
        async () => {
          const s = await serve({ infoPath: () => tokenFile });
          const r = await createWriteTokenReader({
            baseUrl: s.url,
            logger,
          })();
          await s.close();
          return r;
        },
      ],
      [
        "file is empty",
        async () => {
          fs.writeFileSync(tokenFile, "   \n");
          const s = await serve({ infoPath: () => tokenFile });
          const r = await createWriteTokenReader({
            baseUrl: s.url,
            logger,
          })();
          await s.close();
          return r;
        },
      ],
      [
        "gateway is not listening",
        async () => {
          const s = await serve({ infoPath: () => tokenFile });
          const url = s.url;
          await s.close();
          return createWriteTokenReader({ baseUrl: url, logger })();
        },
      ],
    ];
    for (const [name, run] of cases) {
      expect([name, await run()]).toEqual([name, undefined]);
    }
    // Every branch said something — an absent credential is never silent.
    expect(logs.length).toBe(cases.length);
  });

  it("never writes the token value into a log line", async () => {
    const value = "s3cr3t-must-not-appear";
    fs.writeFileSync(tokenFile, `${value}\n`);
    // Succeed once (value in memory), then force a refresh into every failure
    // branch that could be tempted to print what it had.
    const s = await serve({ infoPath: () => tokenFile });
    const read = createWriteTokenReader({ baseUrl: s.url, logger });
    expect(await read()).toBe(value);
    fs.rmSync(tokenFile);
    expect(await read(true)).toBeUndefined();
    await s.close();
    expect(await read(true)).toBeUndefined();

    expect(logs.length).toBeGreaterThan(0);
    expect(logs.filter((l) => l.includes(value))).toEqual([]);
  });

  it("recovers a rotated token with exactly one extra write attempt", async () => {
    // The live shape: a cached token goes stale (gateway regenerated the file),
    // the write gets 401, the reader re-reads, the write succeeds. Once.
    fs.writeFileSync(tokenFile, "stale-token\n");
    const s = await serve({
      infoPath: () => tokenFile,
      note: (n) => ({ status: n === 1 ? 401 : 200 }),
    });
    const read = createWriteTokenReader({ baseUrl: s.url, logger });
    expect(await read()).toBe("stale-token");
    fs.writeFileSync(tokenFile, "fresh-token\n");

    const consumer = createMemoryConsumer({ baseUrl: s.url, writeToken: read });
    const r = await consumer.note({ content: "заметка" });
    await s.close();

    expect(r.ok).toBe(true);
    expect(s.noteTokens).toEqual(["stale-token", "fresh-token"]);
    expect(s.seen.filter((x) => x === "POST /memory/note").length).toBe(2);
  });
});
