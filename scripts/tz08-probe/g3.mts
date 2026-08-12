/**
 * tz-08 g3 (S3) — the authorization model, carried over as it is (ТЗ D1c).
 *
 * Reading is auth-free loopback; writing goes through the gate. The wrapper
 * must neither weaken the gate nor carry the credential where it is not
 * needed — a secret sent on a route that does not want it is a secret in one
 * more log.
 *
 * Observed at a recording proxy the host talks through, so the legs are about
 * what actually left the wrapper, not about what its code appears to do.
 *
 * FALSIFY=token-on-read — the read is issued instead by a deliberately broken
 * consumer that attaches the credential to every request. The leg "read
 * carries no credential" must go false.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { must, finish } from "../tz07-probe/assert.mts";
import {
  startFakeLlm,
  startGateway,
  startHost,
  writeSandboxConfig,
} from "./harness.mts";
import {
  describeHost,
  resolveLauncherPath,
} from "../../src/consumer/hosts/registry.js";
import { createMemoryConsumer } from "../../src/consumer/client.js";
import { createWriteTokenReader } from "../../src/consumer/token.js";

const FALSIFY = process.env.FALSIFY ?? "";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "tz08-g3-"));
const dataDir = path.join(home, "memory", "tdai");
fs.mkdirSync(dataDir, { recursive: true });

const llm = await startFakeLlm();
const port = 29_600 + Math.floor(Math.random() * 90);
const gateway = await startGateway({
  home,
  dataDir,
  port,
  configPath: writeSandboxConfig(path.join(home, "gateway.yaml"), {
    dataDir,
    port,
    llmUrl: llm.url,
  }),
});
const token = fs
  .readFileSync(path.join(home, "memory", "tdai-gateway.token"), "utf-8")
  .trim();

/** Everything the wrapper sent, in order. */
const seen: Array<{ method: string; path: string; hasToken: boolean }> = [];
const proxy = http.createServer((req, res) => {
  const url = req.url ?? "";
  seen.push({
    method: req.method ?? "",
    path: url.split("?")[0] ?? "",
    hasToken: Boolean(req.headers["x-memory-token"]),
  });
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    void fetch(`${gateway.url}${url}`, {
      method: req.method,
      headers: Object.fromEntries(
        Object.entries(req.headers).filter(
          ([k, v]) =>
            typeof v === "string" && k !== "host" && k !== "content-length",
        ) as [string, string][],
      ),
      ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
    })
      .then(async (upstream) => {
        const body = await upstream.text();
        res.writeHead(upstream.status, {
          "Content-Type":
            upstream.headers.get("content-type") ?? "application/json",
        });
        res.end(body);
      })
      .catch(() => {
        res.writeHead(502).end("{}");
      });
  });
});
await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
const proxyUrl = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;

const lookup = describeHost("codex", {
  launcherPath: resolveLauncherPath(),
  gatewayUrl: proxyUrl,
});
if (!lookup.ok) throw new Error(lookup.message);
const host = await startHost(lookup.descriptor, { TDAI_GATEWAY_URL: proxyUrl });

try {
  if (FALSIFY === "token-on-read") {
    // A consumer that attaches the credential to everything it sends.
    const broken = createMemoryConsumer({
      baseUrl: proxyUrl,
      writeToken: createWriteTokenReader({ baseUrl: proxyUrl }),
      fetchImpl: async (input, init) =>
        fetch(input, {
          ...init,
          headers: {
            ...(init?.headers as Record<string, string>),
            "x-memory-token": token,
          },
        }),
    });
    await broken.search({ query: "что-нибудь" });
  } else {
    await host.call("tools/call", {
      name: "memory_search",
      arguments: { query: "что-нибудь", limit: 3 },
    });
  }

  await host.call("tools/call", {
    name: "memory_note",
    arguments: { content: "Заметка под гейтом" },
  });

  const reads = seen.filter((r) => r.path === "/memory/search");
  const writes = seen.filter((r) => r.path === "/memory/note");
  console.log("что ушло от обёртки:", JSON.stringify(seen));

  must("чтение состоялось", reads.length > 0);
  must(
    "на чтение credential не носится",
    reads.every((r) => !r.hasToken),
  );
  must(
    "на запись credential носится",
    writes.length > 0 && writes.every((r) => r.hasToken),
  );

  // The gate itself, unchanged by the wrapper.
  const blindWrite = await fetch(`${gateway.url}/memory/note`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: "без токена" }),
  });
  const openRead = await fetch(`${gateway.url}/memory/search?query=x`);
  console.log(
    `прямой запрос: write без токена ${blindWrite.status}, read без токена ${openRead.status}`,
  );
  must("запись без токена отклонена", blindWrite.status === 401);
  must("чтение без токена работает", openRead.status === 200);
} finally {
  host.stop();
  await new Promise<void>((r) => proxy.close(() => r()));
  await gateway.stop();
  await llm.close();
  fs.rmSync(home, { recursive: true, force: true });
}

finish();
