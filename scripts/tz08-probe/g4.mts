/**
 * tz-08 g4 (S4) — unavailability is not emptiness (ТЗ D1e, acceptance 5).
 *
 * "Nothing found" tells a session its memory holds nothing, so it writes down
 * what it already knows. A gateway that is down, and a memory that is
 * rebuilding, must therefore arrive as their own distinguishable answers —
 * never as an empty list.
 *
 * The `gated` shape is produced by a stub that speaks the server's documented
 * answer (200 + `gated: true` + empty result). That the REAL gateway produces
 * exactly that shape is pinned separately, against a real gateway, in
 * src/consumer/server-contract.test.ts — here the question is only whether the
 * consumer keeps it distinguishable.
 *
 * FALSIFY=empty-on-error — failures are collapsed into an empty result, the
 * way a wrapper that "just returns []" would. The legs must go false.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { must, finish } from "../tz07-probe/assert.mts";
import {
  freePort,
  startFakeLlm,
  startGateway,
  startHost,
  waitFor,
  writeSandboxConfig,
} from "./harness.mts";
import type { McpHost } from "./harness.mts";
import {
  describeAllHosts,
  resolveLauncherPath,
} from "../../src/consumer/hosts/registry.js";
import { createMemoryConsumer } from "../../src/consumer/client.js";
import type { ConsumerResult, SearchOk } from "../../src/consumer/types.js";

const FALSIFY = process.env.FALSIFY ?? "";

/** What a wrapper that collapses failures into "nothing found" would give. */
function collapse(
  answer: string,
  isFailure = answer.includes("isError"),
): string {
  return FALSIFY === "empty-on-error" && isFailure
    ? JSON.stringify({ results: "", total: 0 })
    : answer;
}

const home = fs.mkdtempSync(path.join(os.tmpdir(), "tz08-g4-"));
const dataDir = path.join(home, "memory", "tdai");
fs.mkdirSync(dataDir, { recursive: true });

const llm = await startFakeLlm();
const port = await freePort();
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

const ctx = { launcherPath: resolveLauncherPath(), gatewayUrl: gateway.url };
const hosts: McpHost[] = [];
for (const descriptor of describeAllHosts(ctx)) {
  hosts.push(await startHost(descriptor));
}

async function search(index: number, query: string): Promise<string> {
  const reply = await hosts[index]!.call("tools/call", {
    name: "memory_search",
    arguments: { query, limit: 3 },
  });
  return collapse(JSON.stringify(reply.result));
}

try {
  // Baseline: with a real answer available, the probe can tell full from empty.
  await hosts[0]!.call("tools/call", {
    name: "memory_note",
    arguments: { content: "Заметка для базовой линии g4" },
  });
  await waitFor("the corpus to become searchable", async () =>
    (await search(0, "потребител")).includes("Found"),
  );
  const alive = await search(0, "потребител");
  console.log("живой ответ:", alive);
  must("при живом gateway выдача непустая", alive.includes("Found"));

  // An empty answer from a healthy gateway is an ORDINARY answer.
  const nothing = await search(0, "заведомо-отсутствующая-строка-xyzzy");
  console.log("пустой ответ:", nothing);
  must(
    "пустая выдача живого gateway — это не ошибка",
    nothing.includes("No matching memories") && !nothing.includes("isError"),
  );

  // A rebuilding memory: the one 200 that still means "no answer right now".
  const stub = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({ results: "", total: 0, strategy: "gated", gated: true }),
    );
  });
  await new Promise<void>((r) => stub.listen(0, "127.0.0.1", r));
  const stubUrl = `http://127.0.0.1:${(stub.address() as { port: number }).port}`;
  const gatedAnswer: ConsumerResult<SearchOk> = await createMemoryConsumer({
    baseUrl: stubUrl,
    writeToken: async () => undefined,
  }).search({ query: "x" });
  await new Promise<void>((r) => stub.close(() => r()));
  const gatedText = collapse(JSON.stringify(gatedAnswer), !gatedAnswer.ok);
  console.log("переиндексация:", gatedText);
  must(
    "переиндексация — отдельный вид, а не пустая выдача",
    gatedText.includes('"kind":"gated"'),
  );

  // And the gateway going away.
  await gateway.stop();
  const dead = [
    await search(0, "x"),
    await search(1, "x"),
    await search(2, "x"),
  ];
  for (const [i, body] of dead.entries())
    console.log(`${hosts[i]!.id} без gateway: ${body}`);
  must(
    "недоступность различима у всех трёх хостов",
    dead.every((body) => body.includes("unavailable")),
  );
  must(
    "недоступность не выглядит как пустая выдача",
    dead.every(
      (body) => !body.includes('"total":0') || body.includes("unavailable"),
    ),
  );
} finally {
  for (const host of hosts) host.stop();
  await gateway.stop();
  await llm.close();
  fs.rmSync(home, { recursive: true, force: true });
}

finish();
