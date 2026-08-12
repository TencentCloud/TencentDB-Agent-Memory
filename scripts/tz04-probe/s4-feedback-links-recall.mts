/**
 * tz-04 C4 live probe: a feedback points back at the recall it came from.
 *
 * Before this, `/memory/feedback` said "these 80-char keys were useful" and
 * nothing tied that to a turn: two recalls in the same session were
 * indistinguishable, so no measurement could ever ask "did THIS recall help?".
 * The probe drives a REAL gateway over HTTP: recall → take `recall_id` from
 * the response → feedback with it → the response links the two, and the
 * record's priority actually went up.
 *
 * FALSIFY=drop-id — the feedback is sent WITHOUT `recall_id` (the pre-fix
 * client). Expected outcome, pinned: `linkedTo === null` — the bump still
 * happens, but nothing says which recall earned it.
 */
import fs from "node:fs";
import path from "node:path";
import { makeSandbox } from "../tz09-probe/sandbox.mts";
import { must, finish } from "../tz07-probe/assert.mts";
import { TdaiGateway } from "../../src/gateway/server.js";
import { parseConfig } from "../../src/config.js";
import { VectorStore } from "../../src/core/store/sqlite.js";
import { openReadonlySqlite } from "../../src/gateway/http-utils.js";
import type { Logger } from "../../src/core/types.js";

const FALSIFY = process.env.FALSIFY ?? "";
const KEY = "Деплой идёт через rsync без --delete, иначе снесёт auths";

const logger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const sbx = makeSandbox([]);
const dataDir = sbx.dataDir;
fs.mkdirSync(path.join(dataDir, "records"), { recursive: true });

const seed = new VectorStore(path.join(dataDir, "vectors.db"), 4, logger);
seed.init();
seed.upsertL1(
  {
    id: "fb-1",
    content: KEY,
    type: "instruction",
    priority: 40,
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
seed.close();

const priorityOf = (id: string): number => {
  const db = openReadonlySqlite(path.join(dataDir, "vectors.db"));
  const row = db
    .prepare("SELECT priority FROM l1_records WHERE record_id = ?")
    .get(id) as { priority: number } | undefined;
  db.close();
  return row?.priority ?? -1;
};

const port = 29_700 + Math.floor(Math.random() * 200);
const baseUrl = `http://127.0.0.1:${port}`;
const gateway = new TdaiGateway({
  data: { baseDir: dataDir },
  server: { port, host: "127.0.0.1", corsOrigins: [] },
  memory: parseConfig({ recall: { strategy: "keyword" } }),
});
await gateway.start();

const info = (await (await fetch(`${baseUrl}/memory/info`)).json()) as {
  tokenPath: string;
};
const token = fs.readFileSync(info.tokenPath, "utf-8").trim();

const recall = (await (
  await fetch(`${baseUrl}/recall`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: "деплой rsync", session_key: "s-probe" }),
  })
).json()) as { recall_id?: string; memory_count?: number };

const before = priorityOf("fb-1");
const feedbackBody: Record<string, unknown> = { keys: [KEY.slice(0, 80)] };
if (FALSIFY !== "drop-id") feedbackBody.recall_id = recall.recall_id;

const feedback = (await (
  await fetch(`${baseUrl}/memory/feedback`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-memory-token": token },
    body: JSON.stringify(feedbackBody),
  })
).json()) as {
  matched?: number;
  bumped?: number;
  linkedTo?: { recallId: string; sessionKey: string; count: number } | null;
};
const after = priorityOf("fb-1");

const status = (await (await fetch(`${baseUrl}/status`)).json()) as {
  lastRecall?: { recallId?: string } | null;
};
await gateway.stop();

console.log(`FALSIFY=${FALSIFY || "(нет)"}`);
console.log(
  `  /recall     -> recall_id=${recall.recall_id} memory_count=${recall.memory_count}`,
);
console.log(
  `  /feedback   -> matched=${feedback.matched} bumped=${feedback.bumped} ` +
    `linkedTo=${JSON.stringify(feedback.linkedTo)}`,
);
console.log(`  приоритет fb-1: ${before} → ${after}`);
console.log(`  /status lastRecall.recallId=${status.lastRecall?.recallId}`);

must(
  "recall отдал идентификатор события, и /status показывает тот же",
  typeof recall.recall_id === "string" &&
    recall.recall_id.length === 36 &&
    status.lastRecall?.recallId === recall.recall_id,
);
must(
  "фидбек связан с событием: тот же id и та же сессия",
  feedback.linkedTo?.recallId === recall.recall_id &&
    feedback.linkedTo?.sessionKey === "s-probe",
);
must("приоритет записи поднялся на +1", after === before + 1);

sbx.cleanup();
finish();
