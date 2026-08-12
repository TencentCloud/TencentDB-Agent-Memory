/**
 * tz-10b S2 live probe: every fragment of the injected context has a source.
 *
 * The claim is not "the assembler produced an envelope" — it is that the text
 * a real gateway sends over HTTP IS the envelope's `renderedContext`, and that
 * each block of it names the item it came from, with scope, score reason and
 * token cost. A fragment nobody owns is an assembly defect (tz-10:165).
 *
 * FALSIFY=orphan-fragment — the probe assembles once more with its OWN
 * renderer that appends a paragraph carrying no item (the product code gets no
 * test hook). Expected outcome, pinned: the "every fragment has a source" leg
 * goes red while the equality leg stays green.
 */
import fs from "node:fs";
import path from "node:path";
import { makeSandbox } from "../tz09-probe/sandbox.mts";
import { must, finish } from "../tz07-probe/assert.mts";
import { TdaiGateway } from "../../src/gateway/server.js";
import { parseConfig } from "../../src/config.js";
import { VectorStore } from "../../src/core/store/sqlite.js";
import { performAutoRecall } from "../../src/core/hooks/auto-recall/recall.js";
import {
  assembleContext,
  DEFAULT_PRECEDENCE,
} from "../../src/core/context/assemble.js";
import { createCharTokenizer } from "../../src/core/context/tokenizer.js";
import type {
  ContextSegment,
  MemoryItem,
} from "../../src/core/context/types.js";
import type { Logger } from "../../src/core/types.js";
import { MEMORY_TOOLS_GUIDE } from "../../src/core/hooks/auto-recall/types.js";

const FALSIFY = process.env.FALSIFY ?? "";
const QUERY = "деплой rsync";

const logger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const sbx = makeSandbox([]);
const dataDir = sbx.dataDir;
fs.mkdirSync(path.join(dataDir, "records"), { recursive: true });
fs.writeFileSync(
  path.join(dataDir, "persona.md"),
  "Пользователь пишет телеграфно и не любит воду.",
  "utf-8",
);

const store = new VectorStore(path.join(dataDir, "vectors.db"), 4, logger);
store.init();
store.upsertL1(
  {
    id: "l1-1",
    content: "деплой идёт через rsync без --delete",
    type: "instruction",
    priority: 50,
    scene_name: "s",
    source_message_ids: [],
    metadata: {},
    timestamps: ["2026-08-13T00:00:00.000Z"],
    createdAt: "2026-08-13T00:00:00.000Z",
    updatedAt: "2026-08-13T00:00:00.000Z",
    sessionKey: "probe",
    sessionId: "probe",
    projectId: "",
    scope: "global",
  } as never,
  new Float32Array([1, 0, 0, 0]),
);

const port = 29_900 + Math.floor(Math.random() * 90);
const baseUrl = `http://127.0.0.1:${port}`;
const cfg = parseConfig({ recall: { strategy: "keyword" } });
const gateway = new TdaiGateway({
  data: { baseDir: dataDir },
  server: { port, host: "127.0.0.1", corsOrigins: [] },
  memory: cfg,
});
await gateway.start();

const http = (await (
  await fetch(`${baseUrl}/recall`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: QUERY, session_key: "s-probe" }),
  })
).json()) as { context?: string };
await gateway.stop();

// The same pipeline, in-process, to get the envelope behind that text. Same
// store, same query, same config — the assembly is deterministic, so the two
// runs must produce the same string.
const result = await performAutoRecall({
  userText: QUERY,
  actorId: "u",
  sessionKey: "s-probe",
  cfg,
  pluginDataDir: dataDir,
  vectorStore: store,
});
store.close();
const envelope = result!.envelope!;

// Blocks come from the envelope itself: splitting the rendered string back
// apart would be the reverse parse tz-10 C10.2 forbids. The tools guide is the
// one block allowed to own no item — prompt scaffolding, not memory — and it is
// recognised by carrying no itemIds, not by its text.
let segments: ContextSegment[] = envelope.segments.filter(
  (s) => s.text !== MEMORY_TOOLS_GUIDE,
);

if (FALSIFY === "orphan-fragment") {
  const orphaned = assembleContext({
    items: envelope.included,
    policy: { precedence: DEFAULT_PRECEDENCE, dedup: "exact" },
    budget: { total: cfg.recall.contextBudgetTokens, reservedForUser: 0 },
    tokenizer: createCharTokenizer(),
    render: (included: MemoryItem[]): ContextSegment[] => [
      ...included.map((i) => ({
        slot: "prepend" as const,
        itemIds: [i.memoryId],
        text: i.content,
      })),
      {
        slot: "append",
        itemIds: [],
        text: "<injected-from-nowhere>лишний абзац</injected-from-nowhere>",
      },
    ],
    request: { requestId: "falsify", sessionKey: "s-probe", sessionId: "" },
  });
  segments = orphaned.segments;
}

console.log(`FALSIFY=${FALSIFY || "(нет)"}`);
console.log(
  `  бюджет: total=${envelope.budget.total} used=${envelope.budget.used} ` +
    `резерв=${envelope.budget.reservedForUser} overhead=${envelope.budget.renderOverhead} ` +
    `токенайзер=${envelope.budget.tokenizerId}@${envelope.budget.tokenizerVersion}`,
);
for (const item of envelope.included) {
  console.log(
    `  item ${item.memoryId} kind=${item.kind} scope=${item.scope.projectId || "(global)"} ` +
      `reasons=${item.score.reasons.join("|") || "-"} tokenCost=${item.tokenCost}`,
  );
}
for (const segment of segments) {
  console.log(
    `  фрагмент [${segment.text.slice(0, 32).replace(/\n/g, " ")}…] → items=${segment.itemIds.join(",") || "(нет)"}`,
  );
}

must(
  "то, что ушло по HTTP, и есть renderedContext конверта",
  typeof http.context === "string" && http.context === envelope.renderedContext,
);
must(
  "каждый фрагмент контекста назван по item-у (кроме статичного guide)",
  segments.length > 0 && segments.every((s) => s.itemIds.length > 0),
);
must(
  "склейка фрагментов и есть отрендеренный контекст",
  envelope.segments.map((s) => s.text).join("\n\n") ===
    envelope.renderedContext,
);
must(
  "у каждого включённого item-а есть id, причина и стоимость",
  envelope.included.length > 0 &&
    envelope.included.every(
      (i) =>
        i.memoryId.length > 0 && i.score.reasons.length > 0 && i.tokenCost > 0,
    ),
);

sbx.cleanup();
finish();
