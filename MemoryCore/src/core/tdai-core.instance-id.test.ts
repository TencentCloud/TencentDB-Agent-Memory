/**
 * Per-task instanceId plumbing for runL1WithStore / runL2WithStore /
 * runL3WithStore.
 *
 * In service mode a single shared TdaiCore executes pipeline tasks for many
 * instances concurrently (worker concurrency defaults to 60). Previously the
 * executor set `this.instanceId` via `setInstanceId()` and the run*WithStore
 * methods read it back — so a task for instance A could race with a task for
 * instance B and get billed / routed / logged under the wrong tenant. The
 * fix threads the task's instanceId through as an explicit parameter.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { HostAdapter } from "./types.js";

const captured = vi.hoisted(() => ({
  l1: [] as Array<Record<string, unknown>>,
  l2: [] as Array<Record<string, unknown>>,
  l3: [] as Array<Record<string, unknown>>,
}));

vi.mock("../utils/pipeline-factory.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils/pipeline-factory.js")>();
  return {
    ...actual,
    createL1Runner: vi.fn((opts: Record<string, unknown>) => {
      captured.l1.push(opts);
      return async () => ({});
    }),
    createL2Runner: vi.fn((opts: Record<string, unknown>) => {
      captured.l2.push(opts);
      return async () => ({});
    }),
    createL3Runner: vi.fn((opts: Record<string, unknown>) => {
      captured.l3.push(opts);
      return async () => ({});
    }),
  };
});

import { TdaiCore } from "./tdai-core.js";

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

function makeCore(llm: Record<string, unknown>): TdaiCore {
  const hostAdapter = {
    hostType: "standalone",
    getLogger: () => logger,
    getRuntimeContext: () => ({ dataDir: "/tmp/tdai-core-iid-test" }),
    getLLMRunnerFactory: () => ({
      createRunner: () => ({ run: async () => "" }),
    }),
  } as unknown as HostAdapter;
  return new TdaiCore({
    hostAdapter,
    config: { llm } as never,
  });
}

const DISABLED_LLM = {
  enabled: false,
  provider: "openai",
  baseUrl: "https://llm.invalid",
  apiKey: "k",
  model: "m",
};

describe("TdaiCore per-task instanceId", () => {
  beforeEach(() => {
    captured.l1.length = 0;
    captured.l2.length = 0;
    captured.l3.length = 0;
  });

  it("runL1WithStore resolves getInstanceId() from the explicit arg, not the shared field", async () => {
    const core = makeCore({ ...DISABLED_LLM });
    core.setInstanceId("inst-B");

    await core.runL1WithStore("sess-1", {} as never, {} as never, undefined, undefined, "inst-A");

    expect(captured.l1).toHaveLength(1);
    const getInstanceId = captured.l1[0].getInstanceId as () => string | undefined;
    expect(getInstanceId()).toBe("inst-A");
  });

  it("runL2WithStore passes the explicit instanceId to createL2Runner", async () => {
    const core = makeCore({ ...DISABLED_LLM });
    core.setInstanceId("inst-B");

    await core.runL2WithStore("sess-1", {} as never, undefined, undefined, undefined, undefined, "inst-A");

    expect(captured.l2).toHaveLength(1);
    expect(captured.l2[0].instanceId).toBe("inst-A");
  });

  it("runL3WithStore passes the explicit instanceId to createL3Runner", async () => {
    const core = makeCore({ ...DISABLED_LLM });
    core.setInstanceId("inst-B");

    await core.runL3WithStore({} as never, undefined, undefined, undefined, "inst-A");

    expect(captured.l3).toHaveLength(1);
    expect(captured.l3[0].instanceId).toBe("inst-A");
  });

  it("falls back to this.instanceId when the arg is omitted (backward compat)", async () => {
    const core = makeCore({ ...DISABLED_LLM });
    core.setInstanceId("inst-B");

    await core.runL1WithStore("sess-1", {} as never, {} as never);

    const getInstanceId = captured.l1[0].getInstanceId as () => string | undefined;
    expect(getInstanceId()).toBe("inst-B");
  });

  it("resolveRuntimeLlm uses the explicit instanceId in the proxy URL", () => {
    process.env.TDAI_MEMORY_SYSTEM_USER_KEY = `sk-mem-${"a".repeat(32)}`;
    try {
      const core = makeCore({
        enabled: true,
        provider: "proxy",
        baseUrl: "https://proxy.internal",
        apiKey: "unused",
        model: "m",
      });
      core.setInstanceId("inst-B");

      const resolve = (core as unknown as {
        resolveRuntimeLlm(iid?: string): { baseUrl: string };
      }).resolveRuntimeLlm.bind(core);

      expect(resolve("inst-A").baseUrl).toBe("https://proxy.internal/proxy/inst-A/v1");
      expect(resolve().baseUrl).toBe("https://proxy.internal/proxy/inst-B/v1");
    } finally {
      delete process.env.TDAI_MEMORY_SYSTEM_USER_KEY;
    }
  });
});
