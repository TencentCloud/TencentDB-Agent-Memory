import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { _testExports } from "../offload/index.js";
import { OffloadContextEngine } from "./context-engine.js";
import { registerOffloadClient } from "./index.js";
import { defaultOffloadClientConfig } from "./types.js";

const roots: string[] = [];
const logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

const turn = {
  advancementKey: "turn-42",
  admission: { entryId: "user-42", timestamp: 1000 },
  terminal: { entryId: "assistant-42", timestamp: 2000 },
  messages: [
    { role: "user", content: "remember this" },
    { role: "assistant", content: "noted" },
  ],
  sessionId: "session-1",
  sessionKey: "agent:main:session-1",
};

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "tdai-turn-ledger-"));
  roots.push(root);
  return root;
}

function makeClientEngine(stateRoot: string): OffloadContextEngine {
  return new OffloadContextEngine(
    {} as any,
    defaultOffloadClientConfig(),
    logger,
    { stateRoot },
  );
}

function makeLocalEngine(dataRoot: string): InstanceType<typeof _testExports.OffloadContextEngine> {
  return new _testExports.OffloadContextEngine({
    sessions: {} as any,
    logger,
    pCfg: {},
    getContextWindow: () => 128000,
    notifyL2NewNullEntries: () => {},
    clearL2Timeout: () => {},
    l4State: { pendingResult: null },
    flushL1: async () => {},
    backendClient: null,
    judgeL15: async () => {},
    disposeL15: () => {},
    dataRoot,
  });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("durable context-engine turn advancement", () => {
  it("declares the durable contract implemented by the client engine", async () => {
    const engine = makeClientEngine(await makeRoot());

    expect(engine.info.transcriptSemantics).toEqual({
      currentTurnFence: "before-current-turn-entry-v1",
      turnAdvancementIdempotency: "atomic-idempotent-v1",
    });
    expect(typeof engine.commitTurn).toBe("function");
  });

  it("returns duplicate after a client engine restart commits the same key", async () => {
    const stateRoot = await makeRoot();
    const first = makeClientEngine(stateRoot);
    const second = makeClientEngine(stateRoot);

    await expect(first.commitTurn!(turn)).resolves.toEqual({ status: "committed" });
    await expect(second.commitTurn!(turn)).resolves.toEqual({ status: "duplicate" });
  });

  it("commits exactly one of two concurrent client-engine retries", async () => {
    const stateRoot = await makeRoot();
    const first = makeClientEngine(stateRoot);
    const second = makeClientEngine(stateRoot);

    const statuses = await Promise.all([
      first.commitTurn!(turn),
      second.commitTurn!(turn),
    ]);

    expect(statuses.map((result) => result.status).sort()).toEqual(["committed", "duplicate"]);
  });

  it("keeps identical key and session id in different session keys independent", async () => {
    const engine = makeClientEngine(await makeRoot());

    const first = await engine.commitTurn!({ ...turn, sessionKey: "agent:first:session-1" });
    const second = await engine.commitTurn!({ ...turn, sessionKey: "agent:second:session-1" });

    expect([first.status, second.status]).toEqual(["committed", "committed"]);
  });

  it("declares the durable contract implemented by the local engine", async () => {
    const engine = makeLocalEngine(await makeRoot());

    expect(engine.info.transcriptSemantics).toEqual({
      currentTurnFence: "before-current-turn-entry-v1",
      turnAdvancementIdempotency: "atomic-idempotent-v1",
    });
  });

  it("binds the registered client factory to the host agent state root", async () => {
    const stateRoot = await makeRoot();
    let factory: ((ctx: { agentDir?: string }) => OffloadContextEngine) | undefined;
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 200 }));

    registerOffloadClient({
      on: () => {},
      registerContextEngine: (_id, registeredFactory) => {
        factory = registeredFactory;
        return { ok: true };
      },
      logger,
    }, {
      enabled: true,
      serverUrl: "http://offload.test",
      apiKey: "test-key",
      serviceId: "test-service",
    });

    const engine = await factory!({ agentDir: stateRoot });
    expect(engine.info.transcriptSemantics).toEqual({
      currentTurnFence: "before-current-turn-entry-v1",
      turnAdvancementIdempotency: "atomic-idempotent-v1",
    });
  });

  it("shares pre-turn context across factory engine instances", async () => {
    const stateRoot = await makeRoot();
    let factory: ((ctx: { agentDir?: string }) => OffloadContextEngine) | undefined;
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 200 }));

    registerOffloadClient({
      on: () => {},
      registerContextEngine: (_id, registeredFactory) => {
        factory = registeredFactory;
        return { ok: true };
      },
      logger,
    }, {
      enabled: true,
      serverUrl: "http://offload.test",
      apiKey: "test-key",
      serviceId: "test-service",
    });

    const first = await factory!({ agentDir: stateRoot });
    const second = await factory!({ agentDir: stateRoot });
    await first.assemble({
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      messages: [{ role: "user", content: "current prompt" }],
      prompt: "current prompt",
      tokenBudget: 128000,
    });

    expect(second.getContext("agent:main:session-1")?.prompt).toBe("current prompt");
  });

  it("returns duplicate after a local engine restart commits the same key", async () => {
    const dataRoot = await makeRoot();
    const first = makeLocalEngine(dataRoot);
    const second = makeLocalEngine(dataRoot);

    await expect(first.commitTurn!(turn)).resolves.toEqual({ status: "committed" });
    await expect(second.commitTurn!(turn)).resolves.toEqual({ status: "duplicate" });
  });
});
