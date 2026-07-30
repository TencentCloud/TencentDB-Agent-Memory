#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const openclawBin = path.resolve(
  process.env.PROMPT_CACHE_OPENCLAW_BIN
    ?? path.join(
      repoRoot,
      "benchmark-runs/issue-120/env/openclaw-2026.5.28/node_modules/.bin/openclaw",
    ),
);
const publishedPlugin = path.join(
  repoRoot,
  "benchmark-runs/issue-120/instances/openclaw-2026.5.28-published-0.3.6"
    + "/state/extensions/memory-tencentdb",
);
const pluginPath = path.resolve(
  process.env.PROMPT_CACHE_OPENCLAW_PLUGIN_PATH ?? publishedPlugin,
);
const apiKeyFile = path.resolve(
  process.env.PROMPT_CACHE_BENCH_API_KEY_FILE
    ?? "/tmp/issue-120-deepseek.key",
);
const upstreamBaseUrl = (
  process.env.PROMPT_CACHE_BENCH_BASE_URL ?? "https://api.deepseek.com/v1"
).replace(/\/$/, "");
const model = process.env.PROMPT_CACHE_BENCH_MODEL ?? "deepseek-v4-pro";
const turns = Math.max(
  3,
  Number.parseInt(process.env.PROMPT_CACHE_OPENCLAW_TURNS ?? "3", 10) || 3,
);
const delayMs = Math.max(
  0,
  Number.parseInt(process.env.PROMPT_CACHE_BENCH_DELAY_MS ?? "3000", 10) || 0,
);
const group = process.env.PROMPT_CACHE_OPENCLAW_GROUP ?? "off";
const groupIds = { off: "g0", inert: "g1", recall: "g2" };
const keepRuntimeArtifacts =
  process.env.PROMPT_CACHE_KEEP_RUNTIME_ARTIFACTS === "1";

if (!(group in groupIds)) {
  console.error("PROMPT_CACHE_OPENCLAW_GROUP must be off, inert, or recall.");
  process.exit(2);
}

const runId = `${new Date().toISOString().replaceAll(/[:.]/g, "-")}-${crypto.randomUUID()}`;
const runRoot = path.resolve(
  process.env.PROMPT_CACHE_OPENCLAW_RUN_ROOT
    ?? path.join(
      repoRoot,
      "benchmark-runs/issue-120/deepseek-v4-pro/openclaw",
      groupIds[group],
      runId,
    ),
);

function readSecureKey(file) {
  const stat = fs.statSync(file);
  if (!stat.isFile()) throw new Error("API key path is not a regular file");
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
    throw new Error("API key file must not be accessible by group or other users");
  }
  const value = fs.readFileSync(file, "utf8").trim();
  if (!value) throw new Error("API key file is empty");
  return value;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function commonPrefixBytes(left, right) {
  const limit = Math.min(left.length, right.length);
  let index = 0;
  while (index < limit && left.charCodeAt(index) === right.charCodeAt(index)) {
    index += 1;
  }
  return Buffer.byteLength(left.slice(0, index));
}

function textFromContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object" && typeof part.text === "string") {
        return part.text;
      }
      return "";
    })
    .join("");
}

function summarizeRequest(bodyText, priorBodyText) {
  let body;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return {
      parseError: true,
      bodyBytes: Buffer.byteLength(bodyText),
      bodySha256: sha256(bodyText),
    };
  }
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const messageSummaries = messages.map((message) => {
    const text = textFromContent(message?.content);
    return {
      role: message?.role,
      chars: text.length,
      sha256: sha256(text),
      recallMarkerCount: (text.match(/<relevant-memories(?:\s|>)/gi) ?? []).length,
      ledgerMarkerCount: (text.match(/data-ledger-version="1"/gi) ?? []).length,
      memoryRefCount: (text.match(/<memory-ref\s/gi) ?? []).length,
      benchmarkKeywordCount: (text.match(/ORBITALCACTUS/g) ?? []).length,
    };
  });
  return {
    model: body.model,
    stream: body.stream,
    bodyBytes: Buffer.byteLength(bodyText),
    bodySha256: sha256(bodyText),
    commonPrefixBytesWithPriorRequest: priorBodyText === undefined
      ? null
      : commonPrefixBytes(priorBodyText, bodyText),
    messageCount: messages.length,
    roles: messages.map((message) => message?.role),
    totalMessageChars: messageSummaries.reduce((sum, item) => sum + item.chars, 0),
    recallMarkerCount: messageSummaries.reduce(
      (sum, item) => sum + item.recallMarkerCount,
      0,
    ),
    benchmarkKeywordCount: messageSummaries.reduce(
      (sum, item) => sum + item.benchmarkKeywordCount,
      0,
    ),
    messages: messageSummaries,
  };
}

function run(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      ...options,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      resolve({ code, signal, stdout, stderr });
    });
  });
}

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

async function seedRecallDatabase(stateDir, env) {
  const dataDir = path.join(stateDir, "memory-tdai");
  const dbPath = path.join(dataDir, "vectors.db");
  fs.mkdirSync(dataDir, { recursive: true });
  const now = new Date().toISOString();
  const schema = `
    CREATE TABLE IF NOT EXISTS l1_records (
      record_id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      type TEXT DEFAULT '',
      priority INTEGER DEFAULT 50,
      scene_name TEXT DEFAULT '',
      session_key TEXT DEFAULT '',
      session_id TEXT DEFAULT '',
      timestamp_str TEXT DEFAULT '',
      timestamp_start TEXT DEFAULT '',
      timestamp_end TEXT DEFAULT '',
      created_time TEXT DEFAULT '',
      updated_time TEXT DEFAULT '',
      metadata_json TEXT DEFAULT '{}'
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS l1_fts USING fts5(
      content,
      content_original UNINDEXED,
      record_id UNINDEXED,
      type UNINDEXED,
      priority UNINDEXED,
      scene_name UNINDEXED,
      session_key UNINDEXED,
      session_id UNINDEXED,
      timestamp_str UNINDEXED,
      timestamp_start UNINDEXED,
      timestamp_end UNINDEXED,
      metadata_json UNINDEXED
    );
  `;
  const rows = Array.from({ length: 5 }, (_, index) => {
    const id = `issue120-seed-${index + 1}`;
    const content = [
      `ORBITALCACTUS deterministic recalled memory ${index + 1}.`,
      "This is synthetic benchmark material with no user data.",
      "stable-memory-segment ".repeat(58),
    ].join(" ");
    const values = [
      sqlString(id),
      sqlString(content),
      sqlString("fact"),
      "80",
      sqlString("issue-120"),
      sqlString("agent:main:seed"),
      sqlString("seed-session"),
      sqlString(now),
      sqlString(now),
      sqlString(now),
      sqlString(now),
      sqlString(now),
      sqlString("{}"),
    ].join(", ");
    const ftsValues = [
      sqlString(content),
      sqlString(content),
      sqlString(id),
      sqlString("fact"),
      "80",
      sqlString("issue-120"),
      sqlString("agent:main:seed"),
      sqlString("seed-session"),
      sqlString(now),
      sqlString(now),
      sqlString(now),
      sqlString("{}"),
    ].join(", ");
    return `
      INSERT INTO l1_records VALUES (${values});
      INSERT INTO l1_fts (
        content, content_original, record_id, type, priority, scene_name,
        session_key, session_id, timestamp_str, timestamp_start, timestamp_end,
        metadata_json
      ) VALUES (${ftsValues});
    `;
  }).join("\n");
  const result = await run("sqlite3", [dbPath, `${schema}\n${rows}`], {
    cwd: dataDir,
    env,
  });
  if (result.code !== 0) {
    throw new Error(`Failed to seed recall database: ${result.stderr.slice(-2000)}`);
  }
  return {
    dbPath,
    records: 5,
    approximateContentChars: 5 * (
      "ORBITALCACTUS deterministic recalled memory 1.".length
      + "This is synthetic benchmark material with no user data.".length
      + "stable-memory-segment ".repeat(58).length
    ),
  };
}

function findAgentMeta(value) {
  if (!value || typeof value !== "object") return undefined;
  if (
    value.agentMeta
    && typeof value.agentMeta === "object"
    && (value.agentMeta.usage || value.agentMeta.lastCallUsage)
  ) {
    return value.agentMeta;
  }
  for (const child of Object.values(value)) {
    const found = findAgentMeta(child);
    if (found) return found;
  }
  return undefined;
}

function sanitizeAgentMeta(meta) {
  if (!meta) return undefined;
  return {
    provider: meta.provider,
    model: meta.model,
    contextTokens: meta.contextTokens,
    usage: meta.usage,
    lastCallUsage: meta.lastCallUsage,
    promptTokens: meta.promptTokens,
    compactionCount: meta.compactionCount,
  };
}

function captureUsageFromSse(text, onUsage) {
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const value = line.slice(5).trim();
    if (!value || value === "[DONE]") continue;
    try {
      const parsed = JSON.parse(value);
      if (parsed?.usage) onUsage(parsed.usage);
    } catch {
      // A chunk boundary may split an SSE line. The caller also feeds the
      // complete accumulated response at stream end.
    }
  }
}

function aggregateWarm(samples) {
  const warm = samples.slice(1);
  const hitTokens = warm.reduce(
    (sum, sample) => sum + (sample.providerUsage?.prompt_cache_hit_tokens ?? 0),
    0,
  );
  const missTokens = warm.reduce(
    (sum, sample) => sum + (sample.providerUsage?.prompt_cache_miss_tokens ?? 0),
    0,
  );
  return {
    samples: warm.length,
    hitTokens,
    missTokens,
    hitRate: hitTokens + missTokens > 0
      ? hitTokens / (hitTokens + missTokens)
      : null,
  };
}

function validateTranscriptReplay(samples) {
  return samples.slice(1).map((sample, index) => {
    const priorTurn = samples[index];
    const priorUserIndex = 1 + (index * 2);
    const priorUser = priorTurn.request?.messages?.at(-1);
    const replayedUser = sample.request?.messages?.[priorUserIndex];
    return {
      fromTurn: priorTurn.turn,
      toTurn: sample.turn,
      expectedMessageIndex: priorUserIndex,
      priorUserSha256: priorUser?.sha256,
      replayedUserSha256: replayedUser?.sha256,
      hashEqual: Boolean(
        priorUser?.role === "user"
        && replayedUser?.role === "user"
        && priorUser.sha256 === replayedUser.sha256,
      ),
    };
  });
}

const apiKey = readSecureKey(apiKeyFile);
const requests = [];
let priorBodyText;
const server = http.createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const bodyBuffer = Buffer.concat(chunks);
  const bodyText = bodyBuffer.toString("utf8");
  const capture = {
    requestIndex: requests.length + 1,
    ...summarizeRequest(bodyText, priorBodyText),
    providerUsage: undefined,
  };
  priorBodyText = bodyText;
  requests.push(capture);

  try {
    const upstreamPath = request.url?.startsWith("/v1/")
      ? request.url.slice(3)
      : request.url;
    const upstream = await fetch(`${upstreamBaseUrl}${upstreamPath}`, {
      method: request.method,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": request.headers["content-type"] ?? "application/json",
      },
      body: bodyBuffer,
      signal: AbortSignal.timeout(180_000),
    });
    response.statusCode = upstream.status;
    for (const [name, value] of upstream.headers.entries()) {
      if (
        !["content-length", "content-encoding", "transfer-encoding", "connection"]
          .includes(name.toLowerCase())
      ) {
        response.setHeader(name, value);
      }
    }

    if (!upstream.body) {
      response.end();
      return;
    }
    const reader = upstream.body.getReader();
    const allResponseChunks = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const buffer = Buffer.from(value);
      allResponseChunks.push(buffer);
      response.write(buffer);
    }
    response.end();
    const responseText = Buffer.concat(allResponseChunks).toString("utf8");
    if (responseText.trimStart().startsWith("{")) {
      try {
        capture.providerUsage = JSON.parse(responseText)?.usage;
      } catch {
        // Keep the response opaque if the upstream returned malformed JSON.
      }
    } else {
      captureUsageFromSse(responseText, (usage) => {
        capture.providerUsage = usage;
      });
    }
  } catch (error) {
    response.statusCode = 502;
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ error: { message: "benchmark proxy failure" } }));
    capture.proxyError = error instanceof Error ? error.message : String(error);
  }
});

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const address = server.address();
if (!address || typeof address === "string") throw new Error("Proxy address unavailable");
const proxyBaseUrl = `http://127.0.0.1:${address.port}/v1`;

const homeDir = path.join(runRoot, "home");
const stateDir = path.join(runRoot, "state");
const workspaceDir = path.join(runRoot, "workspace");
fs.mkdirSync(homeDir, { recursive: true });
fs.mkdirSync(stateDir, { recursive: true });
fs.mkdirSync(workspaceDir, { recursive: true });

const pluginConfig = {
  capture: { enabled: false },
  extraction: { enabled: false },
  recall: {
    enabled: group === "recall",
    strategy: "keyword",
    maxResults: 5,
    scoreThreshold: 0,
    historyMode: "persist-dedup",
    maxSessionRecallChars: 32_000,
  },
  embedding: { enabled: false, provider: "none" },
  offload: { enabled: false },
};
const config = {
  models: {
    mode: "merge",
    providers: {
      "issue120-proxy": {
        baseUrl: proxyBaseUrl,
        apiKey: "isolated-local-proxy",
        api: "openai-completions",
        models: [{
          id: model,
          name: "Issue 120 DeepSeek V4 Pro proxy",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 1_000_000,
          contextTokens: 1_000_000,
          maxTokens: 8_192,
        }],
      },
    },
  },
  agents: {
    defaults: {
      workspace: workspaceDir,
      model: { primary: `issue120-proxy/${model}` },
    },
  },
  ...(group === "off" ? {} : {
    plugins: {
      load: { paths: [pluginPath] },
      allow: ["memory-tencentdb"],
      entries: {
        "memory-tencentdb": {
          enabled: true,
          hooks: { allowConversationAccess: true },
          config: pluginConfig,
        },
      },
    },
  }),
};
const configPath = path.join(stateDir, "openclaw.json");
fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, {
  mode: 0o600,
});

const env = {
  ...process.env,
  OPENCLAW_HOME: homeDir,
  OPENCLAW_STATE_DIR: stateDir,
  OPENCLAW_CONFIG_PATH: configPath,
};
delete env.DEEPSEEK_API_KEY;

const recallFixture = group === "recall"
  ? await seedRecallDatabase(stateDir, env)
  : null;
const samples = [];
try {
  for (let turn = 1; turn <= turns; turn += 1) {
    if (turn > 1 && delayMs > 0) await sleep(delayMs);
    const requestCountBefore = requests.length;
    const commandResult = await run(
      openclawBin,
      [
        "agent",
        "--local",
        "--json",
        "--model",
        `issue120-proxy/${model}`,
        "--thinking",
        "off",
        "--session-key",
        `agent:main:issue120-${groupIds[group]}-session`,
        "--message",
        [
          "ORBITALCACTUS issue 120 isolated cache benchmark.",
          `Turn ${String(turn).padStart(4, "0")}.`,
          "Do not call tools. Reply with exactly: OK",
        ].join(" "),
        "--timeout",
        "180",
      ],
      { cwd: workspaceDir, env },
    );
    if (commandResult.code !== 0) {
      throw new Error(
        `OpenClaw exited ${commandResult.code}: `
        + commandResult.stderr.slice(-2000),
      );
    }
    const payload = JSON.parse(commandResult.stdout);
    const turnRequests = requests.slice(requestCountBefore);
    samples.push({
      turn,
      providerRequestCount: turnRequests.length,
      providerUsage: turnRequests.at(-1)?.providerUsage,
      request: turnRequests.at(-1)
        ? {
          bodyBytes: turnRequests.at(-1).bodyBytes,
          bodySha256: turnRequests.at(-1).bodySha256,
          commonPrefixBytesWithPriorRequest:
            turnRequests.at(-1).commonPrefixBytesWithPriorRequest,
          messageCount: turnRequests.at(-1).messageCount,
          roles: turnRequests.at(-1).roles,
          totalMessageChars: turnRequests.at(-1).totalMessageChars,
          recallMarkerCount: turnRequests.at(-1).recallMarkerCount,
          benchmarkKeywordCount: turnRequests.at(-1).benchmarkKeywordCount,
          messages: turnRequests.at(-1).messages,
        }
        : undefined,
      openclawAgentMeta: sanitizeAgentMeta(findAgentMeta(payload)),
      stderrBytes: Buffer.byteLength(commandResult.stderr),
    });
  }
} finally {
  await new Promise((resolve) => server.close(resolve));
}

const result = {
  schemaVersion: 1,
  kind: "openclaw-deepseek-cache-reproduction",
  generatedAt: new Date().toISOString(),
  runRoot,
  environment: {
    openclaw: "2026.5.28",
    plugin: group === "off" ? "not loaded" : pluginPath,
    providerProtocol: "openai-completions via local recording proxy",
    model,
    runtimeArtifactsRetained: keepRuntimeArtifacts,
  },
  group,
  groupId: groupIds[group],
  turns,
  delayMs,
  coldSampleExcluded: true,
  pluginConfig: group === "off" ? null : pluginConfig,
  recallFixture,
  samples,
  transcriptReplay: validateTranscriptReplay(samples),
  warmAggregate: aggregateWarm(samples),
};
const resultPath = path.join(runRoot, "result.json");
fs.writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`, {
  mode: 0o600,
});
if (!keepRuntimeArtifacts) {
  for (const directory of [homeDir, stateDir, workspaceDir]) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
console.log(JSON.stringify({
  resultPath,
  group,
  warmAggregate: result.warmAggregate,
  transcriptReplay: result.transcriptReplay,
  samples: samples.map((sample) => ({
    turn: sample.turn,
    providerRequestCount: sample.providerRequestCount,
    providerUsage: sample.providerUsage,
    request: sample.request && {
      bodyBytes: sample.request.bodyBytes,
      commonPrefixBytesWithPriorRequest:
        sample.request.commonPrefixBytesWithPriorRequest,
      messageCount: sample.request.messageCount,
      recallMarkerCount: sample.request.recallMarkerCount,
    },
  })),
}, null, 2));
