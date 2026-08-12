/**
 * tz-08 g1 (S1) — parity: one query through three host forms, one answer.
 *
 * Live: a real gateway process, three real MCP child processes started by the
 * registry's own command lines. The corpus is seeded first — three hosts
 * agreeing that memory is empty is not parity.
 *
 * FALSIFY=host-local-filter — one host's answer gets its own post-processing,
 * the way a wrapper that "helpfully" trims results would. The parity leg must
 * go false.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { must, finish } from "../tz07-probe/assert.mts";
import {
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

const FALSIFY = process.env.FALSIFY ?? "";
const QUERY = "граница потребителя";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "tz08-g1-"));
const dataDir = path.join(home, "memory", "tdai");
fs.mkdirSync(dataDir, { recursive: true });

const llm = await startFakeLlm();
const port = 29_400 + Math.floor(Math.random() * 90);
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
  hosts.push(await startHost(descriptor, { TDAI_GATEWAY_URL: gateway.url }));
}

async function search(hostIndex: number): Promise<string> {
  const reply = await hosts[hostIndex]!.call("tools/call", {
    name: "memory_search",
    arguments: { query: QUERY, limit: 5 },
  });
  const result = reply.result as {
    structuredContent?: { results: string; total: number; strategy: string };
  };
  const body = JSON.stringify(result.structuredContent ?? reply);
  // A wrapper that post-processes per host stops following the server.
  return FALSIFY === "host-local-filter" && hostIndex === 2
    ? body.slice(0, 40)
    : body;
}

try {
  await hosts[0]!.call("tools/call", {
    name: "memory_note",
    arguments: { content: `Проверяется ${QUERY} памяти под тремя хостами` },
  });
  await waitFor("the seeded note to become searchable", async () => {
    const body = await search(0);
    return !body.includes("No matching memories");
  });

  console.log("три формы запуска:");
  for (const host of hosts) console.log(`  ${host.commandLine}`);

  const answers = [await search(0), await search(1), await search(2)];
  for (const [i, body] of answers.entries()) {
    console.log(`\n${hosts[i]!.id}: ${body}`);
  }

  must(
    "выдача непустая (иначе паритет доказывает пустоту)",
    !answers[0]!.includes("No matching memories"),
  );
  must("три хоста дали идентичный ответ", new Set(answers).size === 1);
  must(
    "три разные строки запуска",
    new Set(hosts.map((h) => h.commandLine)).size === 3,
  );
} finally {
  for (const host of hosts) host.stop();
  await gateway.stop();
  await llm.close();
  fs.rmSync(home, { recursive: true, force: true });
}

finish();
