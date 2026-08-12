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
  freePort,
  startFakeEmbeddings,
  startFakeLlm,
  startGateway,
  startHost,
  waitFor,
  writeSandboxConfig,
} from "./harness.mts";
import {
  describeAllHosts,
  resolveLauncherPath,
} from "../../src/consumer/hosts/registry.js";
import type { HostDescriptor } from "../../src/consumer/hosts/types.js";

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
  const port = await freePort();
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

const descriptors = describeAllHosts({
  launcherPath: resolveLauncherPath(),
  gatewayUrl: hybrid.url,
});

interface Answer {
  strategy: string;
  total: number;
}

/** What the gateway itself answers, asked directly — the reference. */
async function askDirectly(url: string): Promise<Answer> {
  const raw = (await (
    await fetch(`${url}/memory/search?query=${encodeURIComponent(QUERY)}`)
  ).json()) as { strategy?: string; total?: number };
  return { strategy: raw.strategy ?? "", total: raw.total ?? 0 };
}

/**
 * The reference, once the corpus has stopped moving.
 *
 * Extraction runs after a note lands, so a memory can appear between the
 * reference read and the wrapper read. Two consecutive identical answers mean
 * the comparison is about the wrapper and not about that timing.
 */
async function settledDirect(url: string): Promise<Answer> {
  let previous = await askDirectly(url);
  await waitFor(`${url} corpus to settle`, async () => {
    await new Promise((r) => setTimeout(r, 1000));
    const current = await askDirectly(url);
    const same =
      current.total === previous.total &&
      current.strategy === previous.strategy;
    previous = current;
    return same;
  });
  return previous;
}

/** Read through one host form, writing nothing. */
async function readThrough(
  url: string,
  descriptor: HostDescriptor,
): Promise<Answer> {
  const host = await startHost(descriptor, { TDAI_GATEWAY_URL: url });
  try {
    const reply = await host.call("tools/call", {
      name: "memory_search",
      arguments: { query: QUERY, limit: 3 },
    });
    const answer = ((reply.result as { structuredContent?: Partial<Answer> })
      .structuredContent ?? {}) as Partial<Answer>;
    if (FALSIFY === "client-side-search") {
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

/** Ask one gateway through a host started against that gateway. */
async function ask(
  url: string,
  descriptor: HostDescriptor = descriptors[0]!,
): Promise<Answer> {
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

  // …and the wrapper carries THAT answer, not one of its own: every host form
  // is compared against what the gateway says when asked directly.
  for (const gateway of [hybrid, keyword]) {
    const direct = await settledDirect(gateway.url);
    for (const descriptor of descriptors) {
      const through = await readThrough(gateway.url, descriptor);
      console.log(
        `${descriptor.id} через обёртку ${JSON.stringify(through)} против прямого запроса ${JSON.stringify(direct)}`,
      );
      must(
        `${descriptor.id}: ответ обёртки совпал с прямым запросом к gateway`,
        through.strategy === direct.strategy && through.total === direct.total,
      );
    }
  }
} finally {
  await hybrid.stop();
  await keyword.stop();
  await llm.close();
  await embeddings.close();
  fs.rmSync(home, { recursive: true, force: true });
}

finish();
