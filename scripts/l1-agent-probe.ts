import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseConfig } from "../src/config.js";
import { readMemoryRecords } from "../src/core/record/l1-reader.js";
import { listAttempts } from "../src/gateway/control-plane/attempt-repo.js";
import { TdaiGateway } from "../src/gateway/server.js";
import { createGatewayL1Dispatcher } from "../src/gateway/l1/l1-dispatcher-factory.js";
import { installL1RolePackages } from "../src/gateway/l1/l1-role-installer.js";
import { freePort } from "../src/test-support/free-port.js";
import { CheckpointManager } from "../src/utils/checkpoint.js";
import { createL1Runner } from "../src/utils/pipeline-factory/l1-runner.js";
import { initStores } from "../src/utils/pipeline-factory.js";
import {
  assertProbeLines,
  postJson,
  reopenL1CommitForProbe,
  silenceConsole,
  waitForL1Commit,
} from "./l1-agent-probe-support.js";

const SESSION_KEY = "probe-l1-agent";
const PROJECT_ID = "isolated-probe";
const API_KEY = "isolated-probe-key";
const logger = { info() {}, warn() {}, error() {}, debug() {} };

if (!process.argv.includes("--isolated")) {
  throw new Error("refusing non-isolated probe; pass --isolated");
}

const root = mkdtempSync(path.join(tmpdir(), "tdai-l1-agent-probe-"));
const dataDir = path.join(root, "memory");
const scratchRoot = path.join(root, "scratch");
const port = await freePort();
const config = parseConfig({
  capture: { enabled: true },
  extraction: { enabled: true, role: "l1-extractor" },
  embedding: { provider: "none" },
  pipeline: {
    everyNConversations: 1,
    enableWarmup: false,
    l1IdleTimeoutSeconds: 1,
    l2DelayAfterL1Seconds: 3600,
    l2MinIntervalSeconds: 3600,
    l2MaxIntervalSeconds: 7200,
  },
  consolidation: { enabled: false },
});

let gateway: TdaiGateway | undefined;
let started = false;
let restoreConsole = () => {};
let outputLines: string[] = [];

try {
  installL1RolePackages({ dataDir });
  restoreConsole = silenceConsole();
  gateway = new TdaiGateway({
    server: { host: "127.0.0.1", port, corsOrigins: [], apiKey: API_KEY },
    data: { baseDir: dataDir, scratchRoot },
    memory: config,
    logging: { level: "info" },
  });
  await gateway.start();
  started = true;

  const now = Date.now();
  const capture = await postJson<{ l0_recorded: number }>(port, "/capture", {
    session_key: SESSION_KEY,
    session_id: "probe-turn-1",
    project_id: PROJECT_ID,
    user_content:
      "Persistent user instruction: always use dark theme in every code editor.",
    assistant_content: "Understood; this is a durable global preference.",
    messages: [
      {
        id: "probe-user-1",
        role: "user",
        content:
          "Persistent user instruction: always use dark theme in every code editor.",
        timestamp: new Date(now - 1_000).toISOString(),
      },
      {
        id: "probe-assistant-1",
        role: "assistant",
        content: "Understood; this is a durable global preference.",
        timestamp: new Date(now).toISOString(),
      },
    ],
  }, API_KEY);
  const assignment = await waitForL1Commit(dataDir, SESSION_KEY);
  const attempts = listAttempts(dataDir, assignment.runId!);
  const extractor = attempts.find(({ kind }) => kind === "launch");
  const search = await postJson<{ total: number }>(port, "/search/memories", {
    query: "dark theme",
    limit: 1,
  }, API_KEY);
  const checkpoint = new CheckpointManager(dataDir, logger);
  const cursor = checkpoint.getRunnerState(
    await checkpoint.read(),
    SESSION_KEY,
  );
  const beforeReplay = (await readMemoryRecords(SESSION_KEY, dataDir)).length;
  reopenL1CommitForProbe({
    dataDir,
    assignmentId: assignment.assignmentId,
    cohortId: assignment.cohortId,
    runId: assignment.runId!,
  });
  const replayStores = await initStores(config, dataDir, logger);
  const runner = createL1Runner({
    pluginDataDir: dataDir,
    cfg: config,
    vectorStore: replayStores.vectorStore,
    embeddingService: replayStores.embeddingService,
    logger,
    dispatcher: createGatewayL1Dispatcher({
      dataDir,
      scratchRoot,
      config,
      logger,
    }),
  });
  await runner({ sessionKey: SESSION_KEY });
  const afterReplay = (await readMemoryRecords(SESSION_KEY, dataDir)).length;
  outputLines = [
    `L0_CAPTURED=${capture.l0_recorded}`,
    `EXTRACTOR_ATTEMPT=${extractor?.outcome ?? "missing"}`,
    `L1_SEARCH_HITS=${search.total}`,
    `CURSOR_ADVANCED=${cursor.last_l1_cursor > 0}`,
    `REPLAY_DUPLICATES=${afterReplay - beforeReplay}`,
  ];
  assertProbeLines(outputLines);
} finally {
  if (started) await gateway?.stop();
  rmSync(root, { recursive: true, force: true });
  restoreConsole();
}

for (const line of outputLines) console.log(line);
console.log("PASS=agentic-l1");
