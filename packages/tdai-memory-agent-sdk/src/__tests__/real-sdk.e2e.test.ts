import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createMemoryAgent, GatewayClient } from "../index.js";
import { createMockDriver } from "../drivers/mock.js";
import { createCodexDriver } from "../drivers/codex.js";
import { createClaudeCodeDriver } from "../drivers/claude-code.js";
import { withCodexMemory } from "../wrappers/codex.js";
import { withClaudeCodeMemory } from "../wrappers/claude-code.js";
import type { AgentSdkDriver, AgentSdkName } from "../types.js";

type CodexThreadLike = {
  runStreamed(prompt: string, options?: { signal?: AbortSignal }): AsyncIterable<unknown>;
};

const e2eEnabled = process.env.TDAI_AGENT_SDK_E2E === "1";
const describeE2E = e2eEnabled ? describe.sequential : describe.skip;

const tempRoots: string[] = [];
const REAL_SDK_CALL_TIMEOUT_MS = 90_000;

afterEach(async () => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describeE2E("tdai-memory-agent-sdk real Gateway and real SDK E2E", () => {
  it("captures through a real Gateway into isolated memory data", async () => {
    const port = await findFreePort();
    const rootDir = makeTempRoot("gateway");
    const gatewayUrl = `http://127.0.0.1:${port}`;
    const marker = `tdai-agent-sdk-${Date.now()}`;
    const agent = createMemoryAgent({
      agentSdkName: "codex-sdk",
      driver: createMockDriver({
        responder: () => [
          "TDAI_AGENT_SDK_OK.",
          `I will keep ${marker} as the scenario marker for the next adapter test.`,
          "The SDK wrapper should pass through the agent response and then capture this turn to L0.",
        ].join(" "),
      }),
      gatewayOptions: {
        rootDir,
        gatewayUrl,
        gatewayCwd: repoRoot(),
        startupTimeoutMs: 60_000,
        requestTimeoutMs: 120_000,
      },
      sessionKey: `e2e:${marker}`,
      userId: "tdai-agent-sdk-e2e",
      strict: true,
    });

    try {
      const session = await agent.startSession();
      const result = await session.run({
        prompt: [
          `We are debugging the TypeScript Agent SDK memory adapter. Scenario marker: ${marker}.`,
          "The expected behavior is pre-turn recall, normal SDK response streaming, and post-turn L0 capture.",
          "Return a short implementation note that includes the marker.",
        ].join(" "),
      });
      expect(result.text).toContain("TDAI_AGENT_SDK_OK");
      expect(result.memory.captured?.l0Recorded).toBeGreaterThan(0);

      const client = new GatewayClient({ gatewayUrl });
      await eventually(async () => {
        const search = await client.searchConversations({ query: marker, sessionKey: `e2e:${marker}` });
        expect(search.results).toContain(marker);
      }, 30_000);

      await session.end();
    } finally {
      await agent.close();
    }
  });

  it("runs the real Codex SDK when explicitly enabled", async () => {
    if (process.env.TDAI_AGENT_SDK_REAL_CODEX !== "1") {
      expect(true).toBe(true);
      return;
    }
    await runRealAgentSmoke("codex-sdk", createCodexDriver());
    await runRealCodexWrapperSmoke();
  });

  it("runs the real Claude Code Agent SDK when explicitly enabled", async () => {
    if (process.env.TDAI_AGENT_SDK_REAL_CLAUDE_CODE !== "1") {
      expect(true).toBe(true);
      return;
    }
    await runRealAgentSmoke("claude-code-sdk", createClaudeCodeDriver({ options: realClaudeCodeOptions() }));
    await runRealClaudeCodeWrapperSmoke();
  });
});

async function runRealAgentSmoke(agentSdkName: AgentSdkName, driver: AgentSdkDriver): Promise<void> {
  const runtime = await makeRealSdkRuntime(agentSdkName);
  const marker = `tdai-real-sdk-${agentSdkName}-${Date.now()}`;
  const sessionKey = `e2e:${agentSdkName}:${Date.now()}`;
  const agent = createMemoryAgent({
    agentSdkName,
    driver,
    gatewayOptions: {
      ...runtime,
      gatewayCwd: repoRoot(),
      startupTimeoutMs: 60_000,
      requestTimeoutMs: 120_000,
    },
    sessionKey,
    userId: "tdai-agent-sdk-e2e",
    strict: true,
  });

  try {
    const session = await agent.startSession();
    const result = await runWithTimeout(
      (signal) => session.run({
        prompt: [
          `We are running a real ${agentSdkName} SDK smoke test for the memory adapter.`,
          `Use scenario marker ${marker}.`,
          "Summarize how the adapter should recall memory before the model call and record L0 after the model call.",
          "Keep the answer concise and include the marker once.",
        ].join(" "),
        signal,
      }),
      REAL_SDK_CALL_TIMEOUT_MS,
    );
    expect(result.text.trim().length).toBeGreaterThan(0);
    expect(result.memory.captured).not.toBeNull();
    expect(result.memory.captured?.l0Recorded).toBeGreaterThan(0);

    const client = new GatewayClient({ gatewayUrl: runtime.gatewayUrl });
    await expectL0Contains(client, marker, sessionKey);
  } finally {
    await agent.close();
  }
}

async function runRealCodexWrapperSmoke(): Promise<void> {
  const { Codex } = await import("@openai/codex-sdk");
  const runtime = await makeRealSdkRuntime("codex-sdk");
  const marker = `tdai-real-wrapper-codex-${Date.now()}`;
  const rawClient = new Codex();
  const memoryCodex = withCodexMemory(rawClient, {
    gatewayOptions: {
      ...runtime,
      gatewayCwd: repoRoot(),
      startupTimeoutMs: 60_000,
      requestTimeoutMs: 120_000,
    },
    sessionKey: `e2e:codex-wrapper:${Date.now()}`,
    userId: "tdai-agent-sdk-e2e",
    strict: true,
  });

  try {
    const thread = await memoryCodex.startThread<CodexThreadLike>();
    const events = [];
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REAL_SDK_CALL_TIMEOUT_MS);
    try {
      for await (const event of thread.runStreamed(
        [
          `Real Codex wrapper smoke test marker: ${marker}.`,
          "Explain in one concise paragraph that the wrapped thread should preserve raw stream events while the memory layer records L0.",
          "Include the marker once.",
        ].join(" "),
        { signal: controller.signal },
      )) {
        events.push(event);
      }
    } finally {
      clearTimeout(timeout);
    }
    expect(events.length).toBeGreaterThan(0);

    const client = new GatewayClient({ gatewayUrl: runtime.gatewayUrl });
    await expectL0Contains(client, marker, memoryCodex.memory.sessionKey);
  } finally {
    await memoryCodex.endMemorySession().catch(() => undefined);
    await memoryCodex.close();
  }
}

async function runRealClaudeCodeWrapperSmoke(): Promise<void> {
  const { query } = await import("@anthropic-ai/claude-agent-sdk");
  const runtime = await makeRealSdkRuntime("claude-code-sdk");
  const marker = `tdai-real-wrapper-claude-code-${Date.now()}`;
  const memoryClaude = withClaudeCodeMemory({ query }, {
    gatewayOptions: {
      ...runtime,
      gatewayCwd: repoRoot(),
      startupTimeoutMs: 60_000,
      requestTimeoutMs: 120_000,
    },
    sessionKey: `e2e:claude-code-wrapper:${Date.now()}`,
    userId: "tdai-agent-sdk-e2e",
    strict: true,
  });

  try {
    const result = await runWithTimeout(
      (signal) => memoryClaude.query({
        prompt: [
          `Real Claude Code wrapper smoke test marker: ${marker}.`,
          "Explain in one concise paragraph that the wrapped query should preserve the raw SDK result while the memory layer records L0.",
          "Include the marker once.",
        ].join(" "),
        options: {
          signal,
          ...realClaudeCodeOptions(),
        },
      }),
      REAL_SDK_CALL_TIMEOUT_MS,
    );
    expect(result.length).toBeGreaterThan(0);

    const client = new GatewayClient({ gatewayUrl: runtime.gatewayUrl });
    await expectL0Contains(client, marker, memoryClaude.memory.sessionKey);
  } finally {
    await memoryClaude.endMemorySession().catch(() => undefined);
    await memoryClaude.close();
  }
}

function makeTempRoot(label: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `tdai-memory-agent-sdk-e2e-${label}-`));
  tempRoots.push(root);
  return root;
}

async function makeRealSdkRuntime(agentSdkName: AgentSdkName) {
  const port = await findFreePort();
  const rootDir = path.join(os.homedir(), ".tdai-memory", agentSdkName);
  const runId = `e2e-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return {
    rootDir,
    dataDir: path.join(rootDir, "data"),
    configPath: path.join(rootDir, "runtime", `${runId}.yaml`),
    logDir: path.join(rootDir, "logs", runId),
    runtimeDir: path.join(rootDir, "runtime", runId),
    gatewayUrl: `http://127.0.0.1:${port}`,
  };
}

function repoRoot(): string {
  return path.resolve(import.meta.dirname, "../../../..");
}

async function findFreePort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (!address || typeof address === "string") throw new Error("could not allocate test port");
  return address.port;
}

function runWithTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
): Promise<T>;
function runWithTimeout<T>(
  operation: (signal: AbortSignal) => AsyncIterable<T>,
  timeoutMs: number,
): Promise<T[]>;
async function runWithTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T> | AsyncIterable<T>,
  timeoutMs: number,
): Promise<T | T[]> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      controller.abort(new Error(`operation timed out after ${timeoutMs}ms`));
      reject(new Error(`operation timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    const result = operation(controller.signal);
    const resultPromise = isAsyncIterable(result) ? collectAsyncIterable(result) : result;
    return await Promise.race([resultPromise, timeoutPromise]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function realClaudeCodeOptions() {
  return {
    cwd: repoRoot(),
    maxTurns: 1,
    tools: [],
    disallowedTools: ["Bash", "Read", "Edit", "Write", "Grep", "Glob", "Task", "WebFetch", "WebSearch"],
    permissionMode: "dontAsk",
    persistSession: false,
    settingSources: [],
    thinking: { type: "disabled" },
  };
}

function isAsyncIterable<T>(value: unknown): value is AsyncIterable<T> {
  return value !== null && typeof value === "object" && Symbol.asyncIterator in value;
}

async function collectAsyncIterable<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of iterable) {
    items.push(item);
  }
  return items;
}

async function eventually(assertion: () => Promise<void>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function expectL0Contains(client: GatewayClient, marker: string, sessionKey: string): Promise<void> {
  await eventually(async () => {
    const search = await client.searchConversations({ query: marker, sessionKey });
    expect(search.total).toBeGreaterThan(0);
    expect(search.results).toContain(marker);
  }, 30_000);
}
