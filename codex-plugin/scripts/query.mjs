#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  cwdFromPayload,
  ensureGateway,
  expandHome,
  gatewayStderrLogPath,
  gatewayStdoutLogPath,
  gatewayUrl,
  healthCheck,
  hookLogPath,
  httpPost,
  projectLabel,
  rememberText,
  sessionEnd,
  sessionIdFromPayload,
  sessionKeyFromPayload,
  sessionKeyPrefixesForCwd
} from "./lib.mjs";
import { normalizeL1Concurrency } from "./seed-constants.mjs";

const command = process.argv[2] || "status";
const args = process.argv.slice(3);
const payload = {
  cwd: process.env.CLAUDE_PROJECT_DIR || process.cwd(),
  session_id: process.env.TDAI_CODEX_MANUAL_SESSION_ID || "manual"
};

if (command === "status") {
  console.log(JSON.stringify({
    healthy: await healthCheck(),
    gatewayUrl: gatewayUrl(),
    logs: {
      hook: hookLogPath(),
      gatewayStdout: gatewayStdoutLogPath(),
      gatewayStderr: gatewayStderrLogPath(),
    },
    sessionKey: sessionKeyFromPayload(payload),
    project: projectLabel(payload)
  }, null, 2));
} else if (command === "memory") {
  const query = args.join(" ").trim();
  if (!query) usage(2);
  const result = await httpPost("/search/memories", {
    query: `Codex project cwd: ${cwdFromPayload(payload)}\n${query}`,
    limit: 10,
    session_key_prefixes: sessionKeyPrefixesForCwd(cwdFromPayload(payload))
  });
  console.log(result?.results || "");
} else if (command === "conversation") {
  const query = args.join(" ").trim();
  if (!query) usage(2);
  const result = await httpPost("/search/conversations", {
    query,
    limit: 10,
    session_key_prefixes: sessionKeyPrefixesForCwd(cwdFromPayload(payload))
  });
  console.log(result?.results || "");
} else if (command === "remember") {
  const text = args.join(" ").trim() || (await readTextFromStdin());
  if (!text) usage(2);
  const result = await rememberText(payload, text);
  console.log(JSON.stringify(result, null, 2));
} else if (command === "flush") {
  const result = await sessionEnd(payload, "manual_flush");
  console.log(JSON.stringify(result, null, 2));
} else if (command === "seed") {
  const file = args[0];
  if (!file) usage(2);
  const ok = await ensureGateway();
  if (!ok) {
    console.error("TDAI Gateway unavailable");
    process.exit(1);
  }
  const fullPipelineTimeoutMs = positiveNumber(process.env.TDAI_CODEX_FULL_PIPELINE_TIMEOUT_MS, 900000);
  const seedTimeoutMs = positiveNumber(process.env.TDAI_CODEX_SEED_TIMEOUT_MS, 960000);
  const l1Concurrency = normalizeL1Concurrency(process.env.TDAI_CODEX_SEED_L1_CONCURRENCY, 1);
  const dataPath = path.resolve(expandHome(file));
  const data = JSON.parse(await readFile(dataPath, "utf-8"));
  const result = await httpPost("/seed", {
    data,
    session_key: sessionKeyFromPayload(payload),
    l1_concurrency: l1Concurrency,
    wait_for_full_pipeline: process.env.TDAI_CODEX_SEED_FULL_PIPELINE !== "false",
    full_pipeline_timeout_ms: fullPipelineTimeoutMs
  }, seedTimeoutMs);
  console.log(JSON.stringify(result, null, 2));
} else if (command === "import-codex-history") {
  const { importCodexHistoryCli } = await import("./import-codex-history.mjs");
  await importCodexHistoryCli(args);
} else if (command === "doctor") {
  const { doctorCli } = await import("./doctor.mjs");
  await doctorCli(args);
} else if (command === "offload") {
  const { offloadCli } = await import("./offload-store.mjs");
  await offloadCli(args, {
    sessionKey: sessionKeyFromPayload(payload),
    sessionId: sessionIdFromPayload(payload)
  });
} else {
  usage(2);
}

function usage(code = 0) {
  console.error("Usage: node scripts/query.mjs [status|memory <query>|conversation <query>|remember <text>|flush|seed <json-file>|import-codex-history [options]|doctor [options]|offload <list|node|canvas>]");
  process.exit(code);
}

async function readTextFromStdin() {
  if (process.stdin.isTTY) return "";
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  return input.trim();
}

function positiveNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
