import { createHash } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import { captureTurn, retryQueuedCaptures } from "./capture.mjs";
import { loadConfig } from "./config.mjs";
import { GatewayClient } from "./gateway-client.mjs";
import { inspectTurn } from "./privacy.mjs";
import { recallCrossSession } from "./recall.mjs";
import { savePendingTurn, takePendingTurn } from "./state-store.mjs";

const CLIENTS = new Set(["codex", "claude", "zcode"]);
const RUNTIME_DIR = fileURLToPath(new URL("../runtime/", import.meta.url));
const STATUS_LOG = join(RUNTIME_DIR, "logs", "status.jsonl");
const PROCESS_STARTED_AT = Date.now();
const PROCESS_BUDGET_MS = 4_200;
const FINALIZATION_RESERVE_MS = 150;
const RETRY_START_RESERVE_MS = 900;
const WORK_DEADLINE = PROCESS_STARTED_AT + PROCESS_BUDGET_MS - FINALIZATION_RESERVE_MS;

function sessionDigest(value) {
  if (typeof value !== "string" || value === "") return "none";
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 16);
}

function eventName(value) {
  if (value === "UserPromptSubmit" || value === "Stop") return value;
  return "unknown";
}

function errorClass(error) {
  return typeof error?.name === "string" && error.name !== "" ? error.name : "Error";
}

async function writeStatus({ client, event, session, status, error }) {
  try {
    await mkdir(join(RUNTIME_DIR, "logs"), { recursive: true });
    await appendFile(STATUS_LOG, `${JSON.stringify({
      timestamp: new Date().toISOString(),
      client: CLIENTS.has(client) ? client : "unknown",
      event,
      session,
      status,
      errorClass: error ? errorClass(error) : null
    })}\n`, "utf8");
  } catch {
    // Diagnostics are fail-open and never include turn content or credentials.
  }
}

async function readInputLine() {
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of input) return line;
  return "";
}

function sourceSessionId(input) {
  const sessionId = typeof input?.session_id === "string" ? input.session_id : "";
  return sessionId.trim() === "" ? "" : sessionId;
}

function configWithinDeadline(config, deadline) {
  const remaining = Math.max(1, deadline - Date.now());
  return {
    ...config,
    timeouts: {
      recallMs: Math.min(config.timeouts.recallMs, remaining),
      captureMs: Math.min(config.timeouts.captureMs, remaining)
    }
  };
}

async function userPromptSubmit(client, input, deadline) {
  const sessionId = sourceSessionId(input);
  const prompt = typeof input.prompt === "string" ? input.prompt : "";
  const inspected = inspectTurn(prompt, "");
  const skip = inspected.skip;
  await savePendingTurn({
    client,
    sourceSessionId: sessionId,
    prompt: skip ? "" : inspected.user,
    skip,
    submittedAt: new Date().toISOString()
  }, { deadline });
  if (skip) return { output: {}, status: "opt-out" };

  const config = await loadConfig();
  const additionalContext = await recallCrossSession(
    new GatewayClient(configWithinDeadline(config, deadline)),
    inspected.user,
    config.recall
  );
  if (!additionalContext) return { output: {}, status: "recall-empty" };
  return {
    output: {
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext
      }
    },
    status: "recalled"
  };
}

async function stop(client, input, deadline) {
  const sessionId = sourceSessionId(input);
  const pending = await takePendingTurn(
    { client, sourceSessionId: sessionId },
    { consume: false, deadline }
  );
  if (pending?.skip) return { output: {}, status: "opt-out" };
  let capture = { captured: false, queued: false, skipped: true };
  const captureCurrentTurn = (gatewayClient) => captureTurn({
    gatewayClient,
    client,
    sourceSessionId: sessionId,
    user: pending.prompt,
    assistant: typeof input.last_assistant_message === "string" ? input.last_assistant_message : "",
    submittedAt: pending.submittedAt,
    completedAt: new Date().toISOString(),
    runtimeDir: RUNTIME_DIR,
    deadline
  });

  let config;
  let gatewayClient;
  try {
    config = await loadConfig();
    gatewayClient = new GatewayClient(configWithinDeadline(config, deadline));
  } catch {
    if (pending && !pending.skip) {
      capture = await captureCurrentTurn({
        addConversation: async () => { throw new Error("Gateway unavailable"); }
      });
    }
    return { output: {}, status: capture.queued ? "queued" : "skipped" };
  }

  if (pending && !pending.skip) {
    capture = await captureCurrentTurn(gatewayClient);
  }
  const retry = deadline - Date.now() >= RETRY_START_RESERVE_MS
    ? await retryQueuedCaptures({
        gatewayClient,
        retryBatchSize: config.queue.retryBatchSize,
        retryBudgetMs: Math.min(config.queue.retryBudgetMs, 800),
        runtimeDir: RUNTIME_DIR,
        deadline
      })
    : { budgetExceeded: deadline <= Date.now() };
  const captureStatus = capture.captured ? "captured" : capture.queued ? "queued" : "skipped";
  return {
    output: {},
    status: retry.budgetExceeded ? `${captureStatus}-retry-timeout` : captureStatus
  };
}

async function handle(client, input, deadline) {
  if (!CLIENTS.has(client)) return { output: {}, status: "invalid-client" };
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { output: {}, status: "invalid-input" };
  }
  if (sourceSessionId(input) === "") return { output: {}, status: "invalid-session" };
  if (input.hook_event_name === "UserPromptSubmit") return userPromptSubmit(client, input, deadline);
  if (input.hook_event_name === "Stop") return stop(client, input, deadline);
  return { output: {}, status: "unknown-event" };
}

let output = {};
let client = typeof process.argv[2] === "string" ? process.argv[2].toLowerCase() : "";
let event = "unknown";
let session = "none";
let status = "error";
let caughtError = null;

try {
  const input = JSON.parse(await readInputLine());
  event = eventName(input?.hook_event_name);
  session = sessionDigest(sourceSessionId(input));
  const result = await handle(client, input, WORK_DEADLINE);
  output = result.output;
  status = result.status;
} catch (error) {
  caughtError = error;
} finally {
  await writeStatus({ client, event, session, status, error: caughtError });
  process.stdout.write(`${JSON.stringify(output)}\n`);
}
