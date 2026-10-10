import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { captureTurn, retryQueuedCaptures } from "../src/capture.mjs";
import { drainCaptureQueue, enqueueCapture } from "../src/state-store.mjs";

async function withRuntime(run) {
  const runtimeRoot = join(resolve(import.meta.dirname, ".."), "runtime");
  await mkdir(runtimeRoot, { recursive: true });
  const runtimeDir = await mkdtemp(join(runtimeRoot, "capture-test-"));
  try {
    await run(runtimeDir);
  } finally {
    await rm(runtimeDir, { recursive: true, force: true });
  }
}

const turn = {
  client: "codex",
  sourceSessionId: "source-session",
  user: "user content",
  assistant: "assistant content",
  submittedAt: "2026-08-08T00:00:00.000Z",
  completedAt: "2026-08-08T00:00:01.000Z"
};

function waitForChild(child, timeoutMs) {
  return new Promise((resolveChild, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("child exceeded retry lifecycle budget"));
    }, timeoutMs);
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => {
      clearTimeout(timer);
      code === 0 ? resolveChild() : reject(new Error(stderr || `child exited ${code}`));
    });
  });
}

test("captureTurn skips a credential-bearing turn before any gateway write", async () => {
  await withRuntime(async (runtimeDir) => {
    let writes = 0;
    const result = await captureTurn({
      ...turn,
      user: "api_key=private-key",
      runtimeDir,
      gatewayClient: { addConversation: async () => { writes += 1; } }
    });

    assert.deepEqual(result, { captured: false, queued: false, skipped: true });
    assert.equal(writes, 0);
    const queued = [];
    await drainCaptureQueue(3, async (record) => { queued.push(record); return true; }, { runtimeDir });
    assert.deepEqual(queued, []);
  });
});

test("captureTurn writes sanitized user and assistant messages with ISO timestamps", async () => {
  await withRuntime(async (runtimeDir) => {
    let received;
    const result = await captureTurn({
      ...turn,
      runtimeDir,
      user: `question data:text/plain;base64,${"A".repeat(500)}`,
      gatewayClient: { addConversation: async (sessionId, messages) => { received = { sessionId, messages }; } }
    });

    assert.deepEqual(result, { captured: true, queued: false });
    assert.match(received.sessionId, /^codex-[a-f0-9]{24}$/);
    assert.deepEqual(received.messages, [
      { role: "user", content: "question [已移除多媒体数据]", timestamp: "2026-08-08T00:00:00.000Z" },
      { role: "assistant", content: "assistant content", timestamp: "2026-08-08T00:00:01.000Z" }
    ]);
  });
});

test("captureTurn queues a sanitized write failure and fails open", async () => {
  await withRuntime(async (runtimeDir) => {
    const gatewayClient = {
      apiKey: "must-not-leak",
      addConversation: async () => { throw new Error("offline must-not-leak"); }
    };
    const result = await captureTurn({ ...turn, gatewayClient, runtimeDir });

    assert.deepEqual(result, { captured: false, queued: true });
    const queued = [];
    await drainCaptureQueue(3, async (record) => { queued.push(record); return false; }, { runtimeDir });
    assert.equal(queued.length, 1);
    assert.deepEqual(queued[0].messages.map(({ role, content, timestamp }) => ({ role, content, timestamp })), [
      { role: "user", content: "user content", timestamp: "2026-08-08T00:00:00.000Z" },
      { role: "assistant", content: "assistant content", timestamp: "2026-08-08T00:00:01.000Z" }
    ]);
    assert.equal(JSON.stringify(queued[0]).includes("must-not-leak"), false);
  });
});

test("captureTurn aborts a request by the aggregate deadline and durably spools the current turn", async () => {
  await withRuntime(async (runtimeDir) => {
    let receivedSignal;
    const started = Date.now();
    const result = await captureTurn({
      ...turn,
      runtimeDir,
      deadline: Date.now() + 900,
      gatewayClient: {
        addConversation: async (_sessionId, _messages, signal) => {
          receivedSignal = signal;
          await new Promise((resolveWait, reject) => {
            const timer = setTimeout(resolveWait, 350);
            signal?.addEventListener("abort", () => {
              clearTimeout(timer);
              reject(new Error("aborted"));
            }, { once: true });
          });
        }
      }
    });

    assert.equal(receivedSignal instanceof AbortSignal, true);
    assert.deepEqual(result, { captured: false, queued: true });
    assert.ok(Date.now() - started < 300);
    const spoolNames = await readdir(join(runtimeDir, "capture-spool"));
    assert.equal(spoolNames.length, 1);
    const durable = JSON.parse(await readFile(join(runtimeDir, "capture-spool", spoolNames[0]), "utf8"));
    assert.deepEqual(durable.messages.map(({ role, content }) => ({ role, content })), [
      { role: "user", content: "user content" },
      { role: "assistant", content: "assistant content" }
    ]);
  });
});

test("retryQueuedCaptures removes a record when query finds both role and content matches", async () => {
  await withRuntime(async (runtimeDir) => {
    await enqueueCapture({
      memorySessionId: "codex-session",
      messages: [
        { role: "user", content: "same user", timestamp: "2026-08-08T00:00:00.000Z" },
        { role: "assistant", content: "same assistant", timestamp: "2026-08-08T00:00:01.000Z" }
      ]
    }, { runtimeDir });
    let writes = 0;
    const result = await retryQueuedCaptures({
      gatewayClient: {
        queryConversation: async (sessionId, limit) => {
          assert.equal(sessionId, "codex-session");
          assert.equal(limit, 20);
          return { messages: [
            { role: "assistant", content: "same assistant", timestamp: "2026-08-08T00:00:02.900Z" },
            { role: "user", content: "same user", timestamp: "2026-08-07T23:59:58.100Z" }
          ] };
        },
        addConversation: async () => { writes += 1; }
      },
      retryBatchSize: 3,
      retryBudgetMs: 800,
      runtimeDir
    });

    assert.deepEqual(result, { processed: 1, removed: 1, remaining: 0, budgetExceeded: false });
    assert.equal(writes, 0);
  });
});

test("retryQueuedCaptures removes a record when the server rewrites matching message timestamps", async () => {
  await withRuntime(async (runtimeDir) => {
    await enqueueCapture({
      memorySessionId: "codex-session",
      messages: [
        { role: "user", content: "same user", timestamp: "2026-08-08T00:00:00.000Z" },
        { role: "assistant", content: "same assistant", timestamp: "2026-08-08T00:00:01.000Z" }
      ]
    }, { runtimeDir });
    let writes = 0;
    const result = await retryQueuedCaptures({
      gatewayClient: {
        queryConversation: async () => ({ messages: [
          { role: "assistant", content: "same assistant", timestamp: "2026-08-08T00:00:46.000Z" },
          { role: "user", content: "same user", timestamp: "2026-08-08T00:00:31.000Z" }
        ] }),
        addConversation: async () => { writes += 1; }
      },
      retryBatchSize: 3,
      retryBudgetMs: 800,
      runtimeDir
    });

    assert.deepEqual(result, { processed: 1, removed: 1, remaining: 0, budgetExceeded: false });
    assert.equal(writes, 0);
  });
});

test("retryQueuedCaptures preserves queued message multiplicity when only one duplicate exists", async () => {
  await withRuntime(async (runtimeDir) => {
    await enqueueCapture({
      memorySessionId: "codex-session",
      messages: [
        { role: "user", content: "repeat", timestamp: "2026-08-08T00:00:00.000Z" },
        { role: "user", content: "repeat", timestamp: "2026-08-08T00:00:01.000Z" }
      ]
    }, { runtimeDir });
    let writes = 0;
    const result = await retryQueuedCaptures({
      gatewayClient: {
        queryConversation: async () => ({ messages: [
          { role: "user", content: "repeat", timestamp: "2026-08-08T00:00:45.000Z" },
          { role: "user", content: "repeat ", timestamp: "2026-08-08T00:00:46.000Z" }
        ] }),
        addConversation: async () => { writes += 1; }
      },
      retryBatchSize: 3,
      retryBudgetMs: 800,
      runtimeDir
    });

    assert.deepEqual(result, { processed: 1, removed: 1, remaining: 0, budgetExceeded: false });
    assert.equal(writes, 1);
  });
});

test("retryQueuedCaptures writes unmatched records, stops on failure, and leaves later records queued", async () => {
  await withRuntime(async (runtimeDir) => {
    for (const content of ["one", "two", "three"]) {
      await enqueueCapture({
        memorySessionId: `codex-${content}`,
        messages: [
          { role: "user", content, timestamp: "2026-08-08T00:00:00.000Z" },
          { role: "assistant", content: `reply:${content}`, timestamp: "2026-08-08T00:00:01.000Z" }
        ]
      }, { runtimeDir });
    }
    const writes = [];
    const result = await retryQueuedCaptures({
      gatewayClient: {
        queryConversation: async () => ({ messages: [] }),
        addConversation: async (sessionId) => {
          writes.push(sessionId);
          if (sessionId === "codex-two") throw new Error("still offline");
        }
      },
      retryBatchSize: 3,
      retryBudgetMs: 800,
      runtimeDir
    });

    assert.deepEqual(writes, ["codex-one", "codex-two"]);
    assert.deepEqual(result, { processed: 2, removed: 1, remaining: 2, budgetExceeded: false });
    const remaining = [];
    await drainCaptureQueue(3, async (record) => { remaining.push(record.memorySessionId); return true; }, { runtimeDir });
    assert.deepEqual(remaining, ["codex-two", "codex-three"]);
  });
});

test("retryQueuedCaptures processes at most three records and honors its total time budget", async () => {
  await withRuntime(async (runtimeDir) => {
    for (let index = 0; index < 4; index += 1) {
      await enqueueCapture({
        memorySessionId: `codex-${index}`,
        messages: [{ role: "user", content: String(index), timestamp: "2026-08-08T00:00:00.000Z" }]
      }, { runtimeDir });
    }
    const writes = [];
    const started = Date.now();
    const result = await retryQueuedCaptures({
      gatewayClient: {
        queryConversation: async () => ({ messages: [] }),
        addConversation: async (sessionId) => {
          writes.push(sessionId);
          if (sessionId === "codex-0") await new Promise((resolve) => setTimeout(resolve, 150));
        }
      },
      retryBatchSize: 99,
      retryBudgetMs: 40,
      runtimeDir
    });

    assert.ok(Date.now() - started < 130);
    assert.deepEqual(writes, ["codex-0"]);
    assert.deepEqual(result, { processed: 1, removed: 0, remaining: 4, budgetExceeded: true });
  });
});

test("a child process aborts a real hanging gateway request and exits within the Hook budget", async () => {
  await withRuntime(async (runtimeDir) => {
    const server = createServer(() => {});
    await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const endpoint = `http://127.0.0.1:${server.address().port}`;
    const captureUrl = pathToFileURL(join(resolve(import.meta.dirname, ".."), "src", "capture.mjs")).href;
    const gatewayUrl = pathToFileURL(join(resolve(import.meta.dirname, ".."), "src", "gateway-client.mjs")).href;
    const stateUrl = pathToFileURL(join(resolve(import.meta.dirname, ".."), "src", "state-store.mjs")).href;
    const script = `
      import { retryQueuedCaptures } from ${JSON.stringify(captureUrl)};
      import { GatewayClient } from ${JSON.stringify(gatewayUrl)};
      import { enqueueCapture } from ${JSON.stringify(stateUrl)};
      const runtimeDir = process.env.TEST_RUNTIME;
      await enqueueCapture({ memorySessionId: "codex-hanging", messages: [
        { role: "user", content: "hang", timestamp: "2026-08-08T00:00:00.000Z" }
      ] }, { runtimeDir });
      const gatewayClient = new GatewayClient({ endpoint: process.env.TEST_ENDPOINT, apiKey: "test-key", serviceId: "default",
        identity: { teamId: "team", agentId: "agent", userId: "user", taskId: "task" },
        timeouts: { recallMs: 5000, captureMs: 5000 } });
      const result = await retryQueuedCaptures({ gatewayClient, retryBatchSize: 1, retryBudgetMs: 80, runtimeDir });
      if (!result.budgetExceeded) process.exitCode = 2;
    `;
    const started = Date.now();
    const child = spawn(process.execPath, ["--input-type=module", "--eval", script], {
      env: { ...process.env, TEST_RUNTIME: runtimeDir, TEST_ENDPOINT: endpoint },
      stdio: ["ignore", "ignore", "pipe"]
    });
    try {
      await waitForChild(child, 800);
      assert.ok(Date.now() - started < 800);
    } finally {
      server.closeAllConnections();
      await new Promise((resolveClose) => server.close(resolveClose));
    }
  });
});
