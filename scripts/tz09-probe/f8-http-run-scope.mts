/**
 * tz-09 live probe: the HTTP apply path is run-scoped too.
 *
 * The critic found two ways it was not: the RunContext built in apply-route
 * carried no gate mode (so `enforce` silently degraded to shadow over HTTP)
 * and no candidate digest (so no operation was ever journalled). This probe
 * drives a REAL gateway over HTTP and checks both against the store.
 *
 * FALSIFY=1 boots the same gateway in shadow, where the very same request
 * mutates the store — the difference between the two runs is the gate.
 */
import fs from "node:fs";
import path from "node:path";
import { makeSandbox } from "./sandbox.mts";
import { TdaiGateway } from "../../src/gateway/server.js";
import { parseConfig } from "../../src/config.js";
import { VectorStore } from "../../src/core/store/sqlite.js";
import {
  createRun,
  updateRun,
} from "../../src/gateway/control-plane/run-repo.js";
import { digestOf } from "../../src/gateway/apply-executor/op-journal.js";
import { listOps } from "../../src/gateway/control-plane/oplog.js";
import type { Logger } from "../../src/core/types.js";

const MODE = process.env.FALSIFY === "1" ? "shadow" : "enforce";
const logger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const sbx = makeSandbox([]);
const dataDir = sbx.dataDir;
fs.mkdirSync(path.join(dataDir, "scene_blocks", "_global"), {
  recursive: true,
});
fs.mkdirSync(path.join(dataDir, "records"), { recursive: true });
fs.mkdirSync(path.join(dataDir, ".metadata"), { recursive: true });

// Seed through the same store class the gateway opens.
const seedStore = new VectorStore(path.join(dataDir, "vectors.db"), 4, logger);
seedStore.init();
for (const id of ["h_1", "h_2"]) {
  const v = new Float32Array(4);
  v[id.length % 4] = 1;
  seedStore.upsertL1(
    {
      id,
      content: `content of ${id}`,
      type: "episodic",
      priority: 50,
      scene_name: "test",
      source_message_ids: [],
      metadata: {},
      timestamps: ["2026-08-01T00:00:00Z"],
      createdAt: "2026-08-01T00:00:00Z",
      updatedAt: "2026-08-01T00:00:00Z",
      sessionKey: "probe",
      sessionId: "probe",
      projectId: "",
      scope: "global",
    } as never,
    v,
  );
}
seedStore.close();

// The run may only rewrite blocks — a delete is outside its subset.
createRun(
  dataDir,
  {
    runId: "run-http",
    roleId: "memory-keeper",
    contractHash: "h",
    contractJson: JSON.stringify({
      policy: {
        opsSubset: ["rewriteBlock"],
        caps: { deletePerRun: 5, rewritePerRun: 5 },
      },
    }),
    binding: "{}",
  },
  new Date().toISOString(),
);

const port = 29_400 + Math.floor(Math.random() * 200);
const baseUrl = `http://127.0.0.1:${port}`;
const gateway = new TdaiGateway({
  data: { baseDir: dataDir },
  server: { port, host: "127.0.0.1", corsOrigins: [] },
  memory: parseConfig({ consolidation: { applyGateMode: MODE } }),
});
await gateway.start();

const info = (await (await fetch(`${baseUrl}/memory/info`)).json()) as {
  tokenPath: string;
};
const token = fs.readFileSync(info.tokenPath, "utf-8").trim();

const countL1 = (): number => {
  const s = new VectorStore(path.join(dataDir, "vectors.db"), 4, logger);
  s.init();
  const n = s.countL1();
  s.close();
  return n;
};

const before = countL1();
// The HTTP body carries the diff, so the receipt has to name these bytes:
// what the route may NOT do is decide the policy, which is what this probes.
const httpDiff = {
  deleteL1: [{ id: "h_1", updatedAt: "2026-08-01T00:00:00Z" }],
};
updateRun(
  dataDir,
  "run-http",
  {
    state: "reviewed",
    candidateDigest: digestOf(JSON.stringify(httpDiff)),
    verdictDigest: "v",
    criticReceipt: '{"verdict":"approve"}',
  },
  new Date().toISOString(),
);

const res = await fetch(`${baseUrl}/memory/apply`, {
  method: "POST",
  headers: { "Content-Type": "application/json", "x-memory-token": token },
  body: JSON.stringify({
    runId: "run-http",
    diff: httpDiff,
    manifest: { baseline: {} },
    context: { presentedRecordIds: ["h_1"] },
  }),
});
const body = (await res.json()) as { status?: string; error?: string };
await gateway.stop();

console.log(`applyGateMode=${MODE}`);
console.log(
  `  POST /memory/apply -> ${res.status} status=${body.status} ` +
    `L1 ${before}→${countL1()}${body.error === undefined ? "" : ` error=${body.error}`}`,
);
console.log(
  `  oplog rows for run-http: ${JSON.stringify(
    listOps(dataDir, "run-http").map(
      (o) => `${o.opIndex}:${o.opType}/${o.state}`,
    ),
  )}`,
);

sbx.cleanup();
