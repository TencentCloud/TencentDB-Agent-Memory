/**
 * tz-09 Codex gate r2, MAJOR: дверь apply решала по СОСТОЯНИЮ и никогда по
 * лизе. Перехват run'а (`claimRun` другим владельцем) поднимает fence и
 * меняет leaseOwner, но состояние остаётся `reviewed` — значит процесс,
 * лизу уже потерявший, проходил `beginApplying` и мутировал стор.
 *
 * Проба: один и тот же одобренный кандидат применяется дважды —
 *   A) лиза у ЭТОГО процесса → apply обязан пройти;
 *   B) run перехвачен чужим владельцем (fence вырос) → apply обязан отказать
 *      ДО первой мутации (запись в l1 не меняется).
 *
 * ФАЛЬСИФИКАЦИЯ: FALSIFY=shadow — тот же перехват в gateMode=shadow, где
 * гейт только предупреждает. Отказ обязан исчезнуть, а запись — измениться:
 * это доказывает, что отказ даёт именно проверка лизы.
 */
import fs from "node:fs";
import path from "node:path";
import { makeSandbox } from "./sandbox.mts";
import { must, finish } from "../tz07-probe/assert.mts";
import { VectorStore } from "../../src/core/store/sqlite.js";
import { ApplyExecutor } from "../../src/gateway/apply-executor.js";
import {
  createRun,
  readRun,
  updateRun,
} from "../../src/gateway/control-plane/run-repo.js";
import { claimRun } from "../../src/gateway/control-plane/lease.js";
import { runOwnerId } from "../../src/gateway/control-plane/owner.js";
import { digestOf } from "../../src/gateway/apply-executor/op-journal.js";
import { openReadonlySqlite } from "../../src/gateway/http-utils.js";
import type { EmbeddingService } from "../../src/core/store/embedding.js";
import type { Logger } from "../../src/core/types.js";

const MODE = process.env.FALSIFY === "shadow" ? "shadow" : "enforce";
const DIMS = 4;
const UPDATED = "2026-08-01T00:00:00Z";

const vec = (seed: number) => {
  const v = new Float32Array(DIMS);
  v[seed % DIMS] = 1;
  return v;
};
const embedding: EmbeddingService = {
  embed: async (t: string) => vec(t.length),
  embedBatch: async (ts: string[]) => ts.map((t) => vec(t.length)),
  getDimensions: () => DIMS,
  getProviderInfo: () => ({ provider: "fake", model: "fake" }),
  isReady: () => true,
  startWarmup: () => undefined,
  close: async () => undefined,
};
const logger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: (m: string) => console.log(`  warn: ${m}`),
  error: () => undefined,
};

const sbx = makeSandbox([]);
const dataDir = sbx.dataDir;
fs.mkdirSync(path.join(dataDir, ".metadata"), { recursive: true });

const store = new VectorStore(path.join(dataDir, "vectors.db"), DIMS, logger);
store.init();
const seed = (id: string) =>
  store.upsertL1(
    {
      id,
      content: `original ${id}`,
      type: "episodic",
      priority: 50,
      scene_name: "test",
      source_message_ids: [],
      metadata: {},
      timestamps: [UPDATED],
      createdAt: UPDATED,
      updatedAt: UPDATED,
      sessionKey: "probe",
      sessionId: "probe",
      projectId: "",
      scope: "global",
    } as never,
    vec(id.length),
  );
seed("lease_a");
seed("lease_b");

const contractJson = JSON.stringify({
  policy: {
    opsSubset: ["rewriteRecord"],
    caps: { deletePerRun: 5, rewritePerRun: 5 },
  },
});
const now = () => new Date().toISOString();
const mine = runOwnerId(process.pid);

function contentOf(id: string): string {
  const db = openReadonlySqlite(path.join(dataDir, "vectors.db"));
  try {
    const row = db
      .prepare("SELECT content FROM l1_records WHERE record_id = ?")
      .get(id) as { content?: string } | undefined;
    return row?.content ?? "<нет>";
  } finally {
    db.close();
  }
}

/** Готовит одобренный критиком run под указанным владельцем лизы. */
function approvedRun(runId: string, diff: unknown, stealBy?: string): number {
  createRun(
    dataDir,
    {
      runId,
      roleId: "memory-keeper",
      contractHash: "h",
      contractJson,
      binding: "{}",
    },
    now(),
  );
  claimRun(dataDir, runId, mine, { nowMs: Date.now(), ttlMs: 60_000 });
  updateRun(
    dataDir,
    runId,
    {
      state: "reviewed",
      candidateDigest: digestOf(JSON.stringify(diff)),
      verdictDigest: "v",
      criticReceipt: '{"verdict":"approve"}',
    },
    now(),
  );
  if (stealBy !== undefined) {
    // Ровно то, что делает живой перехват: чужой владелец, fence +1,
    // состояние `reviewed` не трогается.
    const claim = claimRun(dataDir, runId, stealBy, {
      nowMs: Date.now(),
      ttlMs: 60_000,
      force: true,
    });
    if (!claim.ok) console.log(`  перехват не удался: ${claim.reason}`);
  }
  return readRun(dataDir, runId)?.fence ?? -1;
}

const executor = new ApplyExecutor({
  dataDir,
  logger,
  vectorStore: store,
  embeddingService: embedding,
  runRepo: true,
});

async function applyOnce(runId: string, id: string, stealBy?: string) {
  const diff = {
    rewriteRecord: [{ id, updatedAt: UPDATED, content: `APPLIED ${id}` }],
  };
  const fence = approvedRun(runId, diff, stealBy);
  let verdict: string;
  try {
    const res = await executor.apply(
      {
        diff,
        manifest: { baseline: {} },
        context: { presentedRecordIds: [id] },
      },
      { runId, gateMode: MODE },
    );
    verdict = `${res.status}${res.error === undefined ? "" : `: ${res.error}`}`;
  } catch (err) {
    verdict = err instanceof Error ? err.message : String(err);
  }
  console.log(
    `${runId}: fence=${fence} владелец=${readRun(dataDir, runId)?.leaseOwner} → ${verdict}`,
  );
  console.log(`  запись ${id}: ${contentOf(id)}`);
  return contentOf(id).startsWith("APPLIED");
}

console.log(`gateMode=${MODE} мой владелец=${mine}`);
const okOwned = await applyOnce("run-b4-owned", "lease_a");
const okStolen = await applyOnce(
  "run-b4-stolen",
  "lease_b",
  "otherhost:999999",
);
must("A. со своей лизой apply прошёл", okOwned);
must("B. с перехваченной лизой стор не изменён", okStolen === false);

store.close();
sbx.cleanup();
finish();
