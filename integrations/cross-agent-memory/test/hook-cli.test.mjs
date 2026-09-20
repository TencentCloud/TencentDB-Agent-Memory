import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { enqueueCapture, savePendingTurn, takePendingTurn } from "../src/state-store.mjs";

const adapterDir = fileURLToPath(new URL("../", import.meta.url));
const hookCli = join(adapterDir, "src", "hook-cli.mjs");
const configPath = join(adapterDir, "config.local.json");
const runtimeDir = join(adapterDir, "runtime");

function envelope(data) {
  return JSON.stringify({ code: 0, message: "ok", request_id: randomUUID(), data });
}

async function readRequestBody(request) {
  let source = "";
  for await (const chunk of request) source += chunk;
  return JSON.parse(source);
}

async function startGateway() {
  const requests = [];
  const abortedRequests = [];
  const hangingResponses = new Set();
  const server = createServer(async (request, response) => {
    const body = await readRequestBody(request);
    requests.push({ path: request.url, body });
    if (
      body.query === "hang request private prompt" ||
      body.query === "default deadline current prompt" ||
      (request.url === "/v3/conversation/add" &&
        body.messages?.[0]?.content === "default deadline current prompt") ||
      (request.url === "/v3/conversation/query" && body.session_id === "codex-hanging-old-record")
    ) {
      hangingResponses.add(response);
      response.on("close", () => {
        hangingResponses.delete(response);
        abortedRequests.push({ path: request.url, body });
      });
      return;
    }
    if (request.url === "/v3/conversation/add" &&
        body.messages?.[0]?.content === "capture failure current prompt") {
      response.writeHead(503, { "Content-Type": "application/json" });
      response.end(envelope({ accepted: false }));
      return;
    }
    response.writeHead(200, { "Content-Type": "application/json" });
    if (request.url === "/v3/conversation/search") {
      response.end(envelope({ messages: [{ content: "历史参考内容" }] }));
    } else if (request.url === "/v3/atomic/search") {
      response.end(envelope({ items: [] }));
    } else if (request.url === "/v3/core/read") {
      response.end(envelope({ content: "" }));
    } else if (request.url === "/v3/conversation/query") {
      response.end(envelope({ messages: [] }));
    } else {
      response.end(envelope({ accepted: true }));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    endpoint: `http://127.0.0.1:${server.address().port}`,
    requests,
    abortedRequests,
    async close() {
      for (const response of hangingResponses) response.destroy();
      await new Promise((resolve) => server.close(resolve));
    }
  };
}

async function runHook(client, input, timeoutMs = 4_500) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [hookCli, client], {
      cwd: dirname(hookCli),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`hook process exceeded ${timeoutMs}ms`));
    }, timeoutMs);
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      let output;
      try {
        assert.equal(code, 0, `stderr: ${stderr}`);
        output = JSON.parse(stdout);
        assert.equal(typeof output, "object");
        assert.notEqual(output, null);
        assert.equal(Array.isArray(output), false);
        assert.equal(stdout, `${JSON.stringify(output)}\n`);
      } catch (error) {
        reject(error);
        return;
      }
      resolve({ output, stdout, stderr });
    });
    child.stdin.end(`${input}\n`);
  });
}

function isSharedRuntimeEntry(name) {
  return new Set([
    "capture-queue.jsonl",
    "capture-queue.lock",
    "capture-spool",
    "logs",
    "pending",
    "warnings.log"
  ]).has(name) || name.startsWith(".capture-queue-rebuild-");
}

async function queuedRecords() {
  const source = await readFile(join(runtimeDir, "capture-queue.jsonl"), "utf8");
  return source.trimEnd().split("\n").map((line) => JSON.parse(line));
}

async function durableCaptureRecords() {
  const records = [];
  try {
    records.push(...await queuedRecords());
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  try {
    for (const name of await readdir(join(runtimeDir, "capture-spool"))) {
      records.push(JSON.parse(await readFile(join(runtimeDir, "capture-spool", name), "utf8")));
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return records;
}

async function clearQueue() {
  await rm(join(runtimeDir, "capture-queue.jsonl"), { force: true });
  await rm(join(runtimeDir, "capture-spool"), { recursive: true, force: true });
}

async function pendingRecord(client, sourceSessionId) {
  const digest = createHash("sha256")
    .update(`${client.toLowerCase()}\0${sourceSessionId}`, "utf8")
    .digest("hex");
  return JSON.parse(await readFile(join(runtimeDir, "pending", `${digest}.json`), "utf8"));
}

async function runtimeText(path = runtimeDir) {
  let entries;
  try {
    entries = await readdir(path, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return "";
    throw error;
  }
  if (path === runtimeDir) entries = entries.filter((entry) => isSharedRuntimeEntry(entry.name));
  let output = "";
  for (const entry of entries) {
    const child = join(path, entry.name);
    try {
      if (entry.isDirectory()) output += await runtimeText(child);
      else output += await readFile(child, "utf8");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return output;
}

async function directorySnapshot(path) {
  const records = [];
  let entries;
  try {
    entries = await readdir(path, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return records;
    throw error;
  }
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) {
      records.push([entry.name, await directorySnapshot(child)]);
    } else {
      records.push([entry.name, await readFile(child, "utf8")]);
    }
  }
  return records;
}

async function persistedTurnState() {
  let queue = null;
  try {
    queue = await readFile(join(runtimeDir, "capture-queue.jsonl"), "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return JSON.stringify({
    pending: await directorySnapshot(join(runtimeDir, "pending")),
    spool: await directorySnapshot(join(runtimeDir, "capture-spool")),
    queue
  });
}

function primaryFirst(primaryError, cleanupErrors, message) {
  if (primaryError && cleanupErrors.length > 0) {
    return new AggregateError([primaryError, ...cleanupErrors], message);
  }
  if (primaryError) return primaryError;
  if (cleanupErrors.length === 1) return cleanupErrors[0];
  if (cleanupErrors.length > 1) return new AggregateError(cleanupErrors, message);
  return null;
}

async function runCleanups(primaryError, cleanups, message) {
  const cleanupErrors = [];
  for (const cleanup of cleanups) {
    try { await cleanup(); } catch (error) { cleanupErrors.push(error); }
  }
  const failure = primaryFirst(primaryError, cleanupErrors, message);
  if (failure) throw failure;
}

async function isolateAdapterState() {
  await mkdir(runtimeDir, { recursive: true });
  const backupDir = join(runtimeDir, `.hook-cli-test-backup-${process.pid}-${randomUUID()}`);
  await mkdir(backupDir);
  let prepared = false;
  const restore = async () => {
    const cleanupErrors = [];
    if (prepared) {
      let runtimeNames = [];
      try { runtimeNames = await readdir(runtimeDir); } catch (error) { cleanupErrors.push(error); }
      for (const name of runtimeNames.filter(isSharedRuntimeEntry)) {
        try { await rm(join(runtimeDir, name), { recursive: true, force: true }); }
        catch (error) { cleanupErrors.push(error); }
      }
      try { await rm(configPath, { force: true }); } catch (error) { cleanupErrors.push(error); }
    }
    let backupNames = [];
    try { backupNames = await readdir(backupDir); } catch (error) { cleanupErrors.push(error); }
    for (const name of backupNames) {
      const destination = name === "config.local.json" ? configPath : join(runtimeDir, name);
      try { await rename(join(backupDir, name), destination); }
      catch (error) { cleanupErrors.push(error); }
    }
    if (cleanupErrors.length === 0) {
      try { await rm(backupDir, { recursive: true, force: true }); }
      catch (error) { cleanupErrors.push(error); }
    }
    const failure = primaryFirst(null, cleanupErrors, "adapter state restoration failed");
    if (failure) throw failure;
  };

  try {
    for (const name of await readdir(runtimeDir)) {
      if (!isSharedRuntimeEntry(name)) continue;
      await rename(join(runtimeDir, name), join(backupDir, name));
    }
    try {
      await rename(configPath, join(backupDir, "config.local.json"));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    prepared = true;
    return restore;
  } catch (error) {
    await runCleanups(error, [restore], "adapter isolation and restoration failed");
    throw error;
  }
}

test("shared hook CLI preserves the three-client process contract and fails open without leaking content", async () => {
  let restore;
  let gateway;
  let primaryError;
  try {
    restore = await isolateAdapterState();
    gateway = await startGateway();
    const privatePrompt = "please retain PRIVATE-PROMPT-7193";
    const privateAssistant = "PRIVATE-ASSISTANT-2841";
    const apiKey = "PRIVATE-API-KEY-6637";
    const stderrOutputs = [];
    const writeConfig = () => writeFile(configPath, JSON.stringify({
      endpoint: gateway.endpoint,
      apiKey,
      serviceId: "test-service",
      identity: {
        teamId: "test-team",
        agentId: "test-agent",
        userId: "test-user",
        taskId: "test-task"
      },
      timeouts: { recallMs: 1_000, captureMs: 1_000 },
      recall: { l0Limit: 3, l1Limit: 5, maxContextChars: 2_000 },
      queue: { retryBatchSize: 3, retryBudgetMs: 800 }
    }), "utf8");

    const writeDefaultConfig = () => writeFile(configPath, JSON.stringify({
      endpoint: gateway.endpoint,
      apiKey,
      serviceId: "test-service",
      identity: {
        teamId: "test-team",
        agentId: "test-agent",
        userId: "test-user",
        taskId: "test-task"
      }
    }), "utf8");

    await writeConfig();
    const invalidSessions = [
      ["missing", {}],
      ["non-string", { session_id: 17 }],
      ["empty", { session_id: "" }],
      ["whitespace", { session_id: " \t " }]
    ];
    for (const client of ["codex", "claude", "zcode"]) {
      const seededEmptyPrompt = `SEEDED-EMPTY-SESSION-${client}-6632`;
      assert.equal(await savePendingTurn({
        client,
        sourceSessionId: "",
        prompt: seededEmptyPrompt,
        skip: false,
        submittedAt: "2026-08-08T00:00:00.000Z"
      }, { runtimeDir }), true);
      const beforeRequests = gateway.requests.length;
      const beforeState = await persistedTurnState();
      const malformedSecrets = [];
      for (const [label, session] of invalidSessions) {
        const secret = `MALFORMED-${client}-${label}-PROMPT-8197`;
        malformedSecrets.push(secret);
        const result = await runHook(client, JSON.stringify({
          ...session,
          hook_event_name: "UserPromptSubmit",
          prompt: secret
        }));
        stderrOutputs.push(result.stderr);
        assert.deepEqual(result.output, {});
        assert.equal(result.stdout, "{}\n");
      }
      for (const [label, session] of invalidSessions) {
        const secret = `MALFORMED-${client}-${label}-ANSWER-2746`;
        malformedSecrets.push(secret);
        const result = await runHook(client, JSON.stringify({
          ...session,
          hook_event_name: "Stop",
          stop_hook_active: false,
          last_assistant_message: secret
        }));
        stderrOutputs.push(result.stderr);
        assert.deepEqual(result.output, {});
        assert.equal(result.stdout, "{}\n");
      }
      assert.equal(gateway.requests.length, beforeRequests);
      assert.equal(await persistedTurnState(), beforeState);
      assert.equal((await takePendingTurn({
        client,
        sourceSessionId: ""
      }, { runtimeDir })).prompt, seededEmptyPrompt);
      const persistedRuntime = await runtimeText();
      for (const secret of malformedSecrets) {
        assert.equal(persistedRuntime.includes(secret), false);
      }
    }

    for (const client of ["codex", "claude", "zcode"]) {
      const paddedSessionId = `  padded-${client}-${randomUUID()}  `;
      const beforeRequests = gateway.requests.length;
      await runHook(client, JSON.stringify({
        session_id: paddedSessionId,
        hook_event_name: "UserPromptSubmit",
        prompt: `padded valid ${client} prompt`
      }));
      await runHook(client, JSON.stringify({
        session_id: paddedSessionId,
        hook_event_name: "Stop",
        last_assistant_message: `padded valid ${client} answer`
      }));
      const expectedMemorySession = `${client}-${createHash("sha256")
        .update(paddedSessionId, "utf8")
        .digest("hex")
        .slice(0, 24)}`;
      const newRequests = gateway.requests.slice(beforeRequests);
      assert.equal(newRequests.some((item) =>
        item.path === "/v3/conversation/add" && item.body.session_id === expectedMemorySession), true);
    }

    for (const client of ["codex", "claude", "zcode"]) {
      const sessionId = `${client}-${randomUUID()}`;
      const recalled = await runHook(client, JSON.stringify({
        session_id: sessionId,
        turn_id: "turn-1",
        hook_event_name: "UserPromptSubmit",
        prompt: privatePrompt
      }));
      stderrOutputs.push(recalled.stderr);
      assert.equal(recalled.output.hookSpecificOutput.hookEventName, "UserPromptSubmit");
      assert.match(recalled.output.hookSpecificOutput.additionalContext, /历史参考内容/);

      const stopped = await runHook(client, JSON.stringify({
        session_id: sessionId,
        hook_event_name: "Stop",
        stop_hook_active: false,
        transcript_path: "NEVER-READ-TRANSCRIPT-9912",
        last_assistant_message: privateAssistant
      }));
      stderrOutputs.push(stopped.stderr);
      assert.deepEqual(stopped.output, {});
      assert.equal(stopped.stdout, "{}\n");
      assert.equal(gateway.requests.some((item) => item.body.session_id?.startsWith(`${client}-`)), true);
    }

    for (const client of ["codex", "claude", "zcode"]) {
      const before = gateway.requests.length;
      const sessionId = `${client}-opt-out-${randomUUID()}`;
      const submit = await runHook(client, JSON.stringify({
        session_id: sessionId,
        hook_event_name: "UserPromptSubmit",
        prompt: "[不记忆] private opt-out prompt"
      }));
      const stop = await runHook(client, JSON.stringify({
        session_id: sessionId,
        hook_event_name: "Stop",
        last_assistant_message: "private opt-out answer"
      }));
      stderrOutputs.push(submit.stderr, stop.stderr);
      assert.deepEqual(submit.output, {});
      assert.deepEqual(stop.output, {});
      assert.equal(submit.stdout, "{}\n");
      assert.equal(stop.stdout, "{}\n");
      assert.equal(gateway.requests.length, before);
    }

    for (const [label, privateSkippedPrompt, sentinel] of [
      ["directive", "/nomemory OPT-OUT-SENTINEL-4091", "OPT-OUT-SENTINEL-4091"],
      ["credential", "api_key=CREDENTIAL-SENTINEL-7812", "CREDENTIAL-SENTINEL-7812"],
      ["json-password", '{"password":"JSON-PASSWORD-SENTINEL-6314"}', "JSON-PASSWORD-SENTINEL-6314"],
      ["json-token", '{"token":"JSON-TOKEN-SENTINEL-5228"}', "JSON-TOKEN-SENTINEL-5228"],
      ["json-api-key", '{"api_key":"JSON-API-KEY-SENTINEL-9406"}', "JSON-API-KEY-SENTINEL-9406"]
    ]) {
      const sessionId = `${label}-${randomUUID()}`;
      await runHook("codex", JSON.stringify({
        session_id: sessionId,
        hook_event_name: "UserPromptSubmit",
        prompt: `stale ${label} prompt that must be overwritten`
      }));
      await enqueueCapture({
        memorySessionId: `codex-private-skip-old-${label}`,
        messages: [
          { role: "user", content: `old queued ${label} prompt`, timestamp: "2026-08-08T00:00:00.000Z" },
          { role: "assistant", content: `old queued ${label} answer`, timestamp: "2026-08-08T00:00:01.000Z" }
        ]
      }, { runtimeDir });
      const before = gateway.requests.length;
      const submit = await runHook("codex", JSON.stringify({
        session_id: sessionId,
        hook_event_name: "UserPromptSubmit",
        prompt: privateSkippedPrompt
      }));
      stderrOutputs.push(submit.stderr);
      assert.deepEqual(submit.output, {});
      assert.equal(gateway.requests.length, before);
      const savedMarker = await pendingRecord("codex", sessionId);
      assert.deepEqual({
        client: savedMarker.client,
        prompt: savedMarker.prompt,
        skip: savedMarker.skip
      }, {
        client: "codex",
        prompt: "",
        skip: true
      });
      assert.equal(Number.isFinite(new Date(savedMarker.submittedAt).getTime()), true);
      await runHook("codex", JSON.stringify({
        session_id: sessionId,
        hook_event_name: "Stop",
        last_assistant_message: `answer for ${label} must also be skipped`
      }));
      assert.equal(gateway.requests.length, before);
      const persistedRuntime = await runtimeText();
      assert.equal(persistedRuntime.includes(privateSkippedPrompt), false);
      assert.equal(persistedRuntime.includes(sentinel), false);
      await clearQueue();
    }

    const continuationSession = `continuation-${randomUUID()}`;
    await runHook("codex", JSON.stringify({
      session_id: continuationSession,
      hook_event_name: "UserPromptSubmit",
      prompt: "continuation current prompt"
    }));
    gateway.requests.length = 0;
    await runHook("codex", JSON.stringify({
      session_id: continuationSession,
      hook_event_name: "Stop",
      stop_hook_active: false,
      last_assistant_message: "continuation intermediate answer"
    }));
    await runHook("codex", JSON.stringify({
      session_id: continuationSession,
      hook_event_name: "Stop",
      stop_hook_active: true,
      last_assistant_message: "continuation final answer"
    }));
    const continuationWrites = gateway.requests.filter((item) => item.path === "/v3/conversation/add");
    assert.deepEqual(continuationWrites.map((item) => item.body.messages.map(({ role, content }) => ({ role, content }))), [
      [
        { role: "user", content: "continuation current prompt" },
        { role: "assistant", content: "continuation intermediate answer" }
      ],
      [
        { role: "user", content: "continuation current prompt" },
        { role: "assistant", content: "continuation final answer" }
      ]
    ]);

    gateway.requests.length = 0;
    await runHook("codex", JSON.stringify({
      session_id: `wrong-session-${randomUUID()}`,
      hook_event_name: "Stop",
      stop_hook_active: true,
      last_assistant_message: "must not pair with continuation prompt"
    }));
    assert.equal(gateway.requests.some((item) => item.path === "/v3/conversation/add"), false);

    await runHook("codex", JSON.stringify({
      session_id: continuationSession,
      hook_event_name: "UserPromptSubmit",
      prompt: "next prompt overwrites continuation"
    }));
    gateway.requests.length = 0;
    await runHook("codex", JSON.stringify({
      session_id: continuationSession,
      hook_event_name: "Stop",
      stop_hook_active: false,
      last_assistant_message: "next final answer"
    }));
    const nextWrite = gateway.requests.find((item) => item.path === "/v3/conversation/add");
    assert.deepEqual(nextWrite.body.messages.map(({ role, content }) => ({ role, content })), [
      { role: "user", content: "next prompt overwrites continuation" },
      { role: "assistant", content: "next final answer" }
    ]);

    const orderedSession = `ordered-${randomUUID()}`;
    const orderedSubmit = await runHook("codex", JSON.stringify({
      session_id: orderedSession,
      hook_event_name: "UserPromptSubmit",
      prompt: "current ordered prompt"
    }));
    stderrOutputs.push(orderedSubmit.stderr);
    await enqueueCapture({
      memorySessionId: "codex-seeded-old-record",
      messages: [
        { role: "user", content: "old queued prompt", timestamp: "2026-08-08T00:00:00.000Z" },
        { role: "assistant", content: "old queued answer", timestamp: "2026-08-08T00:00:01.000Z" }
      ]
    }, { runtimeDir });
    gateway.requests.length = 0;
    const orderedStop = await runHook("codex", JSON.stringify({
      session_id: orderedSession,
      hook_event_name: "Stop",
      last_assistant_message: "current ordered answer"
    }));
    stderrOutputs.push(orderedStop.stderr);
    assert.deepEqual(orderedStop.output, {});
    assert.equal(orderedStop.stdout, "{}\n");
    assert.deepEqual(gateway.requests.map((item) => item.path), [
      "/v3/conversation/add",
      "/v3/conversation/query",
      "/v3/conversation/add"
    ]);
    assert.equal(gateway.requests[0].body.messages[0].content, "current ordered prompt");
    assert.equal(gateway.requests[0].body.messages[1].content, "current ordered answer");
    assert.equal(gateway.requests[2].body.messages[0].content, "old queued prompt");

    const captureFailureSession = `capture-failure-${randomUUID()}`;
    const captureFailureSubmit = await runHook("codex", JSON.stringify({
      session_id: captureFailureSession,
      hook_event_name: "UserPromptSubmit",
      prompt: "capture failure current prompt"
    }));
    const captureFailure = await runHook("codex", JSON.stringify({
      session_id: captureFailureSession,
      hook_event_name: "Stop",
      last_assistant_message: "capture failure current answer"
    }));
    stderrOutputs.push(captureFailureSubmit.stderr, captureFailure.stderr);
    assert.equal(captureFailure.stdout, "{}\n");
    assert.deepEqual((await queuedRecords()).at(-1).messages.map(({ role, content }) => ({ role, content })), [
      { role: "user", content: "capture failure current prompt" },
      { role: "assistant", content: "capture failure current answer" }
    ]);
    await clearQueue();

    const retryHangSession = `retry-hang-${randomUUID()}`;
    const retryHangSubmit = await runHook("codex", JSON.stringify({
      session_id: retryHangSession,
      hook_event_name: "UserPromptSubmit",
      prompt: "retry hang current prompt"
    }));
    await enqueueCapture({
      memorySessionId: "codex-hanging-old-record",
      messages: [
        { role: "user", content: "hanging old prompt", timestamp: "2026-08-08T00:00:00.000Z" },
        { role: "assistant", content: "hanging old answer", timestamp: "2026-08-08T00:00:01.000Z" }
      ]
    }, { runtimeDir });
    const retryStarted = Date.now();
    const retryHang = await runHook("codex", JSON.stringify({
      session_id: retryHangSession,
      hook_event_name: "Stop",
      last_assistant_message: "retry hang current answer"
    }));
    stderrOutputs.push(retryHangSubmit.stderr, retryHang.stderr);
    const retryElapsed = Date.now() - retryStarted;
    assert.equal(retryHang.stdout, "{}\n");
    assert.ok(retryElapsed >= 650 && retryElapsed < 2_000, `retry took ${retryElapsed}ms`);
    assert.equal(gateway.abortedRequests.some((item) =>
      item.path === "/v3/conversation/query" && item.body.session_id === "codex-hanging-old-record"), true);
    assert.equal((await queuedRecords()).some((record) => record.memorySessionId === "codex-hanging-old-record"), true);
    await clearQueue();

    const hangingStarted = Date.now();
    const hanging = await runHook("zcode", JSON.stringify({
      session_id: `hang-${randomUUID()}`,
      hook_event_name: "UserPromptSubmit",
      prompt: "hang request private prompt"
    }));
    stderrOutputs.push(hanging.stderr);
    assert.deepEqual(hanging.output, {});
    assert.equal(hanging.stdout, "{}\n");
    assert.ok(Date.now() - hangingStarted < 5_000);

    await clearQueue();
    await writeDefaultConfig();
    const deadlineSession = `default-deadline-${randomUUID()}`;
    await runHook("codex", JSON.stringify({
      session_id: deadlineSession,
      hook_event_name: "UserPromptSubmit",
      prompt: "default deadline current prompt"
    }));
    const pendingDigest = createHash("sha256")
      .update(`codex\0${deadlineSession}`, "utf8")
      .digest("hex");
    const pendingLock = join(runtimeDir, "pending", `${pendingDigest}.pending-lock`);
    const queueLock = join(runtimeDir, "capture-queue.lock");
    await mkdir(pendingLock);
    await mkdir(queueLock);
    const releasePending = setTimeout(() => {
      void rm(pendingLock, { recursive: true, force: true });
    }, 550);
    const deadlineStarted = Date.now();
    let deadlineStop;
    try {
      deadlineStop = await runHook("codex", JSON.stringify({
        session_id: deadlineSession,
        hook_event_name: "Stop",
        stop_hook_active: false,
        last_assistant_message: "default deadline current answer"
      }), 4_900);
    } finally {
      clearTimeout(releasePending);
      await rm(pendingLock, { recursive: true, force: true });
      await rm(queueLock, { recursive: true, force: true });
    }
    const deadlineElapsed = Date.now() - deadlineStarted;
    stderrOutputs.push(deadlineStop.stderr);
    assert.equal(deadlineStop.stdout, "{}\n");
    assert.ok(deadlineElapsed < 4_500, `default-contention Stop took ${deadlineElapsed}ms`);
    const spoolNames = await readdir(join(runtimeDir, "capture-spool"));
    const durableCurrentTurn = await Promise.all(spoolNames.map(async (name) =>
      JSON.parse(await readFile(join(runtimeDir, "capture-spool", name), "utf8"))));
    assert.equal(durableCurrentTurn.some((record) =>
      record.messages?.[0]?.content === "default deadline current prompt" &&
      record.messages?.[1]?.content === "default deadline current answer"), true);
    await clearQueue();

    for (const [client, source] of [
      ["codex", "not JSON"],
      ["claude", JSON.stringify({ session_id: "unknown", hook_event_name: "UnknownEvent", prompt: privatePrompt })],
      ["invalid-client", JSON.stringify({ session_id: "invalid-client", hook_event_name: "UserPromptSubmit", prompt: privatePrompt })]
    ]) {
      const result = await runHook(client, source);
      stderrOutputs.push(result.stderr);
      assert.deepEqual(result.output, {});
      assert.equal(result.stdout, "{}\n");
    }

    await rm(configPath, { force: true });
    const missingConfig = await runHook("codex", JSON.stringify({
      session_id: "missing-config",
      hook_event_name: "UserPromptSubmit",
      prompt: privatePrompt
    }));
    stderrOutputs.push(missingConfig.stderr);
    assert.deepEqual(missingConfig.output, {});
    assert.equal(missingConfig.stdout, "{}\n");

    for (const [configCase, configSource] of [
      ["missing-stop-config", null],
      ["invalid-stop-config", "{}"]
    ]) {
      await writeConfig();
      const sessionId = `${configCase}-${randomUUID()}`;
      const configSubmit = await runHook("claude", JSON.stringify({
        session_id: sessionId,
        hook_event_name: "UserPromptSubmit",
        prompt: `${configCase} current prompt`
      }));
      if (configSource === null) await rm(configPath, { force: true });
      else await writeFile(configPath, configSource, "utf8");
      const stopped = await runHook("claude", JSON.stringify({
        session_id: sessionId,
        hook_event_name: "Stop",
        last_assistant_message: `${configCase} current answer`
      }));
      stderrOutputs.push(configSubmit.stderr, stopped.stderr);
      assert.equal(stopped.stdout, "{}\n");
      const queued = (await durableCaptureRecords()).at(-1);
      assert.deepEqual(queued.messages.map(({ role, content }) => ({ role, content })), [
        { role: "user", content: `${configCase} current prompt` },
        { role: "assistant", content: `${configCase} current answer` }
      ]);
      await clearQueue();
    }

    const logSource = await readFile(join(runtimeDir, "logs", "status.jsonl"), "utf8");
    const diagnostics = `${stderrOutputs.join("")}\n${logSource}`;
    for (const secret of [
      privatePrompt,
      privateAssistant,
      apiKey,
      "NEVER-READ-TRANSCRIPT-9912",
      "current ordered prompt",
      "current ordered answer",
      "old queued prompt",
      "old queued answer",
      "capture failure current prompt",
      "capture failure current answer",
      "retry hang current prompt",
      "retry hang current answer",
      "hanging old prompt",
      "hanging old answer",
      "missing-stop-config current prompt",
      "missing-stop-config current answer",
      "invalid-stop-config current prompt",
      "invalid-stop-config current answer"
    ]) {
      assert.equal(diagnostics.includes(secret), false);
    }
    for (const line of logSource.trim().split("\n")) {
      const record = JSON.parse(line);
      assert.deepEqual(Object.keys(record).sort(), [
        "client", "errorClass", "event", "session", "status", "timestamp"
      ]);
      assert.match(record.session, /^(?:[a-f0-9]{16}|none)$/);
    }
  } catch (error) {
    primaryError = error;
  } finally {
    await runCleanups(primaryError, [
      async () => { if (gateway) await gateway.close(); },
      async () => { if (restore) await restore(); }
    ], "hook process test and cleanup failed");
  }
});
