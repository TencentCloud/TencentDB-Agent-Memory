import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runner = path.join(pluginRoot, "scripts/hooks/runner.mjs");

async function startGateway() {
  const requests = [];
  let failCapture = false;
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
    requests.push({ path: request.url, body });
    response.setHeader("content-type", "application/json");
    if (request.url === "/recall") {
      response.end(JSON.stringify({ context: "remember the launch date", memory_count: 1 }));
      return;
    }
    if (request.url === "/capture") {
      if (failCapture) {
        failCapture = false;
        response.statusCode = 503;
        response.end(JSON.stringify({ error: "temporarily unavailable" }));
        return;
      }
      response.end(JSON.stringify({ l0_recorded: 2, scheduler_notified: true }));
      return;
    }
    if (request.url === "/session/end") {
      response.end(JSON.stringify({ flushed: true }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "missing route" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing test address");
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    setFailCapture() { failCapture = true; },
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

async function fixtureModule(directory) {
  const file = path.join(directory, "gateway-client.mjs");
  await writeFile(file, `
export function resolveTdaiIdentity({ sessionId }) {
  if (!process.env.TDAI_USER_ID) throw new Error("missing identity");
  return { serviceId: "svc", instanceId: "inst", teamId: "team", agentId: "agent", userId: process.env.TDAI_USER_ID, sessionId, sessionKey: "codex:test" };
}
export function gatewayClientOptionsFromEnv() { return { baseUrl: process.env.TDAI_GATEWAY_URL }; }
async function request(path, body) {
  const response = await fetch(process.env.TDAI_GATEWAY_URL + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error("gateway status " + response.status);
  return response.json();
}
export class GatewayMemoryClient {
  async recall(input) { return request("/recall", input); }
  async capture(input) { return request("/capture", input); }
  async endSession(input) { return request("/session/end", input); }
}
`, "utf8");
  return file;
}

function runHook(event, payload, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [runner, event], {
      cwd: pluginRoot,
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("close", (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(JSON.stringify(payload));
  });
}

function stateFile(dataDir) {
  const digest = createHash("sha256").update("codex:test").digest("hex").slice(0, 32);
  return path.join(dataDir, `session-${digest}.json`);
}

test("hooks recall, capture exactly once, and clean up at SessionEnd", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "tdai-hook-data-"));
  const fixtureDir = await mkdtemp(path.join(os.tmpdir(), "tdai-hook-fixture-"));
  const modulePath = await fixtureModule(fixtureDir);
  const gateway = await startGateway();
  const env = {
    PLUGIN_DATA: dataDir,
    TDAI_GATEWAY_URL: gateway.url,
    TDAI_GATEWAY_CLIENT_MODULE: modulePath,
    TDAI_SERVICE_ID: "svc",
    TDAI_INSTANCE_ID: "inst",
    TDAI_TEAM_ID: "team",
    TDAI_AGENT_ID: "agent",
    TDAI_USER_ID: "user",
  };
  try {
    assert.equal((await runHook("SessionStart", { session_id: "session-1" }, env)).status, 0);
    const recall = await runHook("UserPromptSubmit", {
      session_id: "session-1", prompt: "When is launch?", prompt_timestamp_ms: 100,
    }, env);
    assert.equal(recall.status, 0);
    assert.match(recall.stdout, /additionalContext/);
    assert.match(recall.stdout, /historical evidence/);
    const firstStop = await runHook("Stop", {
      session_id: "session-1", last_assistant_message: "It launches Friday.", assistant_timestamp_ms: 200,
    }, env);
    assert.equal(firstStop.status, 0);
    const secondStop = await runHook("Stop", {
      session_id: "session-1", last_assistant_message: "It launches Friday.", assistant_timestamp_ms: 200,
    }, env);
    assert.equal(secondStop.status, 0);
    assert.equal(gateway.requests.filter((request) => request.path === "/capture").length, 1);
    const state = JSON.parse(await readFile(stateFile(dataDir), "utf8"));
    assert.equal(state.pending, null);
    assert.equal(JSON.stringify(state).includes("TDAI_GATEWAY_API_KEY"), false);
    assert.equal((await runHook("SessionEnd", { session_id: "session-1" }, env)).status, 0);
    await assert.rejects(readFile(stateFile(dataDir)));
  } finally {
    await gateway.close();
  }
});

test("failed capture stays pending and succeeds on a later Stop", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "tdai-hook-data-"));
  const fixtureDir = await mkdtemp(path.join(os.tmpdir(), "tdai-hook-fixture-"));
  const modulePath = await fixtureModule(fixtureDir);
  const gateway = await startGateway();
  const env = {
    PLUGIN_DATA: dataDir, TDAI_GATEWAY_URL: gateway.url, TDAI_GATEWAY_CLIENT_MODULE: modulePath,
    TDAI_SERVICE_ID: "svc", TDAI_INSTANCE_ID: "inst", TDAI_TEAM_ID: "team",
    TDAI_AGENT_ID: "agent", TDAI_USER_ID: "user",
  };
  try {
    await runHook("UserPromptSubmit", { session_id: "session-2", prompt: "remember this", prompt_timestamp_ms: 300 }, env);
    gateway.setFailCapture();
    const failed = await runHook("Stop", { session_id: "session-2", last_assistant_message: "saved", assistant_timestamp_ms: 400 }, env);
    assert.equal(failed.status, 0);
    assert.match(failed.stderr, /gateway status 503/);
    const pending = JSON.parse(await readFile(stateFile(dataDir), "utf8"));
    assert.equal(pending.pending.prompt, "remember this");
    await runHook("Stop", { session_id: "session-2", last_assistant_message: "saved", assistant_timestamp_ms: 400 }, env);
    assert.equal(gateway.requests.filter((request) => request.path === "/capture").length, 2);
  } finally {
    await gateway.close();
  }
});

test("Stop clears a stale pending turn that was already captured", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "tdai-hook-data-"));
  const fixtureDir = await mkdtemp(path.join(os.tmpdir(), "tdai-hook-fixture-"));
  const modulePath = await fixtureModule(fixtureDir);
  const gateway = await startGateway();
  const env = {
    PLUGIN_DATA: dataDir, TDAI_GATEWAY_URL: gateway.url, TDAI_GATEWAY_CLIENT_MODULE: modulePath,
    TDAI_SERVICE_ID: "svc", TDAI_INSTANCE_ID: "inst", TDAI_TEAM_ID: "team",
    TDAI_AGENT_ID: "agent", TDAI_USER_ID: "user",
  };
  try {
    await runHook("UserPromptSubmit", {
      session_id: "session-stale", prompt: "already captured", prompt_timestamp_ms: 500,
    }, env);
    await runHook("Stop", {
      session_id: "session-stale", last_assistant_message: "done", assistant_timestamp_ms: 600,
    }, env);
    const statePath = stateFile(dataDir);
    const captured = JSON.parse(await readFile(statePath, "utf8"));
    await writeFile(statePath, `${JSON.stringify({
      ...captured,
      pending: {
        turnId: captured.lastCapturedTurnId,
        prompt: "already captured",
        promptTimestampMs: 500,
        assistantContent: "done",
        assistantTimestampMs: 600,
      },
    })}\n`, "utf8");

    await runHook("Stop", { session_id: "session-stale" }, env);

    const cleaned = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(cleaned.pending, null);
    assert.equal(cleaned.capturePhase, "captured");
    assert.equal(gateway.requests.filter((request) => request.path === "/capture").length, 1);
  } finally {
    await gateway.close();
  }
});

test("SessionEnd keeps state when the Gateway flush fails", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "tdai-hook-data-"));
  const fixtureDir = await mkdtemp(path.join(os.tmpdir(), "tdai-hook-fixture-"));
  const modulePath = await fixtureModule(fixtureDir);
  const gateway = await startGateway();
  const env = {
    PLUGIN_DATA: dataDir, TDAI_GATEWAY_URL: gateway.url, TDAI_GATEWAY_CLIENT_MODULE: modulePath,
    TDAI_SERVICE_ID: "svc", TDAI_INSTANCE_ID: "inst", TDAI_TEAM_ID: "team",
    TDAI_AGENT_ID: "agent", TDAI_USER_ID: "user",
  };
  try {
    await runHook("UserPromptSubmit", { session_id: "session-end-failure", prompt: "keep me" }, env);
    const statePath = stateFile(dataDir);
    await assert.doesNotReject(readFile(statePath));
    const result = await runHook("SessionEnd", { session_id: "session-end-failure" }, {
      ...env,
      TDAI_GATEWAY_URL: "http://127.0.0.1:1",
    });
    assert.equal(result.status, 0);
    await assert.doesNotReject(readFile(statePath));
  } finally {
    await gateway.close();
  }
});

test("SessionEnd preserves a retryable pending turn after a successful flush", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "tdai-hook-data-"));
  const fixtureDir = await mkdtemp(path.join(os.tmpdir(), "tdai-hook-fixture-"));
  const modulePath = await fixtureModule(fixtureDir);
  const gateway = await startGateway();
  const env = {
    PLUGIN_DATA: dataDir, TDAI_GATEWAY_URL: gateway.url, TDAI_GATEWAY_CLIENT_MODULE: modulePath,
    TDAI_SERVICE_ID: "svc", TDAI_INSTANCE_ID: "inst", TDAI_TEAM_ID: "team",
    TDAI_AGENT_ID: "agent", TDAI_USER_ID: "user",
  };
  try {
    await runHook("UserPromptSubmit", { session_id: "session-end-pending", prompt: "retry me" }, env);
    gateway.setFailCapture();
    await runHook("Stop", {
      session_id: "session-end-pending", last_assistant_message: "not yet", assistant_timestamp_ms: 700,
    }, env);
    const result = await runHook("SessionEnd", { session_id: "session-end-pending" }, env);
    assert.equal(result.status, 0);
    const state = JSON.parse(await readFile(stateFile(dataDir), "utf8"));
    assert.equal(state.pending.prompt, "retry me");
  } finally {
    await gateway.close();
  }
});

test("missing identity is fail-open for hooks", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "tdai-hook-data-"));
  const fixtureDir = await mkdtemp(path.join(os.tmpdir(), "tdai-hook-fixture-"));
  const modulePath = await fixtureModule(fixtureDir);
  const result = await runHook("SessionStart", { session_id: "session-3" }, {
    PLUGIN_DATA: dataDir, TDAI_GATEWAY_CLIENT_MODULE: modulePath, TDAI_USER_ID: "",
  });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "{}\n");
  assert.match(result.stderr, /missing identity/i);
  assert.deepEqual(await readdir(dataDir), []);
});
