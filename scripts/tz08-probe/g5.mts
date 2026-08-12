/**
 * tz-08 g5 (S5) — retrieval belongs to the server, not to the wrapper (ТЗ D1a).
 *
 * The consumer boundary must carry the server's retrieval, whatever it is
 * configured to be. If the wrapper did its own matching, every host would get
 * the same answer no matter how the gateway is set up — and the gateway's
 * strategy would stop being the thing that decides.
 *
 * The lever is the gateway's own `embedding` configuration: two REAL gateways
 * over the same corpus, one with an embedding service (hybrid retrieval) and
 * one without (fts only). One host, one query, two gateway URLs — the answers
 * must carry the two different strategies the servers actually ran.
 *
 * FALSIFY=client-side-search — the answer is produced instead by a consumer
 * that fetches and matches on its own and stamps its own strategy. The legs
 * about the server deciding must go false.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { must, finish } from "../tz07-probe/assert.mts";
import {
  startFakeEmbeddings,
  startFakeLlm,
  startGateway,
  startHost,
  waitFor,
  writeSandboxConfig,
} from "./harness.mts";
import {
  describeHost,
  resolveLauncherPath,
} from "../../src/consumer/hosts/registry.js";

const FALSIFY = process.env.FALSIFY ?? "";
const EMBED_DIM = 8;
const QUERY = "потребител";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "tz08-g5-"));
const llm = await startFakeLlm();
const embeddings = await startFakeEmbeddings(EMBED_DIM);

/** One gateway with its own data dir, differing only in retrieval config. */
async function boot(name: string, withEmbedding: boolean) {
  const dataDir = path.join(home, name, "memory", "tdai");
  fs.mkdirSync(dataDir, { recursive: true });
  const port = 29_800 + Math.floor(Math.random() * 90);
  return startGateway({
    home: path.join(home, name),
    dataDir,
    port,
    configPath: writeSandboxConfig(path.join(home, `${name}.yaml`), {
      dataDir,
      port,
      llmUrl: llm.url,
      embedding: withEmbedding
        ? { provider: "openai", baseUrl: embeddings.url, dim: EMBED_DIM }
        : { provider: "none" },
    }),
  });
}

const hybrid = await boot("hybrid", true);
const keyword = await boot("keyword", false);

const lookup = describeHost("pi", {
  launcherPath: resolveLauncherPath(),
  gatewayUrl: hybrid.url,
});
if (!lookup.ok) throw new Error(lookup.message);
const { descriptor } = lookup;

/** Ask one gateway through a host started against that gateway. */
async function ask(url: string): Promise<{ strategy: string; total: number }> {
  const host = await startHost(descriptor, { TDAI_GATEWAY_URL: url });
  try {
    await host.call("tools/call", {
      name: "memory_note",
      arguments: { content: `Заметка для потребителя памяти на ${url}` },
    });
    let answer: { strategy?: string; total?: number } = {};
    await waitFor(`${url} to answer with a memory`, async () => {
      const reply = await host.call("tools/call", {
        name: "memory_search",
        arguments: { query: QUERY, limit: 3 },
      });
      answer = ((reply.result as { structuredContent?: typeof answer })
        .structuredContent ?? {}) as typeof answer;
      return (answer.total ?? 0) > 0;
    });
    if (FALSIFY === "client-side-search") {
      // A wrapper that searches for itself: it reads the raw records and
      // decides, so the gateway's configuration stops mattering.
      const raw = (await (
        await fetch(`${url}/memory/search?query=${encodeURIComponent(QUERY)}`)
      ).json()) as { results?: string };
      const hits = (raw.results ?? "")
        .split("\n")
        .filter((line) => line.toLowerCase().includes(QUERY));
      return { strategy: "local", total: hits.length };
    }
    return { strategy: answer.strategy ?? "", total: answer.total ?? 0 };
  } finally {
    host.stop();
  }
}

try {
  const withVectors = await ask(hybrid.url);
  const withoutVectors = await ask(keyword.url);
  console.log("gateway с эмбеддингами:", JSON.stringify(withVectors));
  console.log("gateway без эмбеддингов:", JSON.stringify(withoutVectors));

  must(
    "обе выдачи непустые",
    withVectors.total > 0 && withoutVectors.total > 0,
  );
  must(
    "gateway с эмбеддингами отдал гибридную стратегию",
    withVectors.strategy === "hybrid",
  );
  must(
    "gateway без эмбеддингов отдал только полнотекстовую",
    withoutVectors.strategy === "fts",
  );
  must(
    "стратегию выбирает сервер, а не обёртка",
    withVectors.strategy !== withoutVectors.strategy,
  );
  must(
    "эмбеддинги реально вызывались продуктовым путём",
    embeddings.calls() > 0,
  );
} finally {
  await hybrid.stop();
  await keyword.stop();
  await llm.close();
  await embeddings.close();
  fs.rmSync(home, { recursive: true, force: true });
}

finish();
