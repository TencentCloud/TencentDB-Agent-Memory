import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as http from "node:http";
import {
  initServerOpikTracer,
  isTracerEnabled as isServerTracerEnabled,
  traceServerModelIo,
  traceServerCompaction,
  traceServerTaskDecision,
  flushServerOpikTracer,
} from "../src/offload_server/opik-tracer.js";
import {
  initOffloadOpikTracer,
  isOffloadTracerEnabled,
  traceOffloadDecision,
  traceOffloadModelIo,
  traceMessagesSnapshot,
  flushOffloadOpikTracer,
} from "../src/offload/opik-tracer.js";

describe("Opik tracer integration with local HTTP receiver", () => {
  let server: http.Server;
  let serverUrl: string;
  const receivedRequests: Array<{
    method: string;
    url: string;
    headers: http.IncomingHttpHeaders;
    body: string;
  }> = [];

  const loggedErrors: string[] = [];
  const testLogger = {
    info: (msg: string) => {},
    warn: (msg: string) => {
      loggedErrors.push(msg);
    },
    debug: (msg: string) => {},
  };

  const prevEnv: Record<string, string | undefined> = {
    OPIK_ENABLED: process.env.OPIK_ENABLED,
    OPIK_URL_OVERRIDE: process.env.OPIK_URL_OVERRIDE,
    OPIK_API_KEY: process.env.OPIK_API_KEY,
    OPIK_WORKSPACE: process.env.OPIK_WORKSPACE,
    OPIK_PROJECT_NAME: process.env.OPIK_PROJECT_NAME,
  };

  beforeAll(async () => {
    // Start local HTTP receiver for Opik API calls
    server = http.createServer((req, res) => {
      let data = "";
      req.on("data", (chunk) => {
        data += chunk;
      });
      req.on("end", () => {
        receivedRequests.push({
          method: req.method ?? "UNKNOWN",
          url: req.url ?? "/",
          headers: req.headers,
          body: data,
        });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok" }));
      });
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address() as { port: number; address: string };
        serverUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });

    // Configure environment variables for offload_server opik tracer
    process.env.OPIK_ENABLED = "true";
    process.env.OPIK_URL_OVERRIDE = `${serverUrl}/api`;
    process.env.OPIK_API_KEY = "dummy-synthetic-api-key";
    process.env.OPIK_WORKSPACE = "synthetic-workspace";
    process.env.OPIK_PROJECT_NAME = "synthetic-project";

    // Initialize both tracers
    await initServerOpikTracer(testLogger);

    const openClawConfig = {
      plugins: {
        entries: {
          "opik-openclaw": {
            enabled: true,
            config: {
              enabled: true,
              apiUrl: `${serverUrl}/api`,
              apiKey: "dummy-synthetic-api-key",
              workspaceName: "synthetic-workspace",
              projectName: "synthetic-project",
            },
          },
        },
      },
    };
    initOffloadOpikTracer(openClawConfig, testLogger);
  });

  afterAll(async () => {
    try {
      await flushServerOpikTracer();
      await flushOffloadOpikTracer();
    } catch {
      // ignore flush errors during teardown
    }

    // Restore previous environment variables
    for (const [key, val] of Object.entries(prevEnv)) {
      if (val !== undefined) {
        process.env[key] = val;
      } else {
        delete process.env[key];
      }
    }

    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  it("verifies both tracers initialize successfully without errors", () => {
    expect(loggedErrors).toEqual([]);
    expect(isServerTracerEnabled()).toBe(true);
    expect(isOffloadTracerEnabled()).toBe(true);
  });

  it("verifies server opik tracer generates synthetic model I/O trace", async () => {
    const startCount = receivedRequests.length;

    traceServerModelIo({
      sessionId: "session-test-server-1",
      stage: "L1.model_io",
      model: "test-model-llama",
      systemPrompt: "You are a helpful synthetic test assistant.",
      userPrompt: "Hello synthetic test",
      responseContent: "Synthetic model response content",
      usage: { promptTokens: 12, completionTokens: 8, totalTokens: 20 },
      status: "ok",
      durationMs: 450,
      logger: testLogger,
    });

    await flushServerOpikTracer();

    expect(receivedRequests.length).toBeGreaterThan(startCount);
    const traceReqs = receivedRequests.filter((r) => r.body.includes("session-test-server-1"));
    expect(traceReqs.length).toBeGreaterThan(0);
    expect(traceReqs[0].body).toContain("synthetic-project");
  });

  it("verifies server compaction and task decision tracing sends HTTP payloads", async () => {
    const startCount = receivedRequests.length;

    traceServerCompaction({
      sessionId: "session-compaction-1",
      level: "summary",
      ratio: 0.5,
      contextWindow: 4096,
      totalTokensBefore: 3000,
      totalTokensAfter: 1500,
      originalMsgCount: 10,
      compactedMsgCount: 4,
      report: { status: "compacted" },
      messages: [{ role: "user", content: "synthetic message" }],
      durationMs: 320,
      logger: testLogger,
    });

    traceServerTaskDecision({
      sessionId: "session-task-decision-1",
      judgment: { needsOffload: false, score: 0.95 },
      durationMs: 80,
      logger: testLogger,
    });

    await flushServerOpikTracer();

    expect(receivedRequests.length).toBeGreaterThan(startCount);
    const compactionReq = receivedRequests.find((r) => r.body.includes("session-compaction-1"));
    expect(compactionReq).toBeDefined();

    const decisionReq = receivedRequests.find((r) => r.body.includes("session-task-decision-1"));
    expect(decisionReq).toBeDefined();
  });

  it("verifies offload tracer generates decision, model I/O, and snapshot traces", async () => {
    const startCount = receivedRequests.length;

    traceOffloadDecision({
      sessionKey: "session-offload-1",
      stage: "L2.decision",
      input: { phase: "pre-process", tokenCount: 500 },
      output: { action: "keep" },
      logger: testLogger,
    });

    traceOffloadModelIo({
      sessionKey: "session-offload-1",
      stage: "L1.model",
      provider: "synthetic-provider",
      model: "test-model-7b",
      url: "http://localhost:11434/api/generate",
      systemPrompt: "System instruction",
      userPrompt: "User question",
      responseContent: "Answer",
      status: "ok",
      durationMs: 250,
      logger: testLogger,
    });

    traceMessagesSnapshot({
      sessionKey: "session-offload-1",
      stage: "L3.snapshot",
      messages: [{ role: "assistant", content: "Snapshot msg" }],
      label: "before-compaction",
      logger: testLogger,
    });

    await flushOffloadOpikTracer();

    expect(receivedRequests.length).toBeGreaterThan(startCount);
    const offloadReq = receivedRequests.find((r) => r.body.includes("session-offload-1"));
    expect(offloadReq).toBeDefined();
  });
});
