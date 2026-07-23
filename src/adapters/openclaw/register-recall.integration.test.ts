import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildGeneratedRecallContext } from "../../utils/recall-injection.js";

const coreMocks = vi.hoisted(() => ({
  handleBeforeRecall: vi.fn(),
}));

vi.mock("../../core/tdai-core.js", () => ({
  TdaiCore: class {
    initialize = vi.fn(async () => undefined);
    getVectorStore = vi.fn(() => undefined);
    getEmbeddingService = vi.fn(() => undefined);
    setInstanceId = vi.fn();
    handleBeforeRecall = coreMocks.handleBeforeRecall;
    isSchedulerStarted = vi.fn(() => true);
    handleTurnCommitted = vi.fn(async () => ({
      l0RecordedCount: 0,
      schedulerNotified: false,
      l0VectorsWritten: 0,
      capturedMessages: [],
    }));
    searchMemories = vi.fn(async () => ({ results: [] }));
    searchConversations = vi.fn(async () => ({ results: [] }));
    destroy = vi.fn(async () => undefined);
  },
}));

vi.mock("./host-adapter.js", () => ({
  OpenClawHostAdapter: class {},
}));

vi.mock("../../utils/clean-context-runner.js", () => ({
  setPreferredEmbeddedAgentRuntime: vi.fn(),
  prewarmEmbeddedAgent: vi.fn(),
}));

vi.mock("../../utils/pipeline-factory.js", () => ({
  initDataDirectories: vi.fn(),
  resetStores: vi.fn(),
}));

vi.mock("../../core/report/reporter.js", () => ({
  getOrCreateInstanceId: vi.fn(async () => "test-instance"),
  initReporter: vi.fn(),
  report: vi.fn(),
  resetReporter: vi.fn(),
}));

vi.mock("../../core/profile/profile-sync.js", () => ({
  ensureL2L3Local: vi.fn(async () => undefined),
}));

import register from "../../../index.js";

type HookHandler = (event: Record<string, unknown>, ctx?: Record<string, unknown>) => unknown;

interface FakeOpenClawApi {
  config: Record<string, unknown>;
  logger: {
    debug: ReturnType<typeof vi.fn>;
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };
  on: (name: string, handler: HookHandler) => void;
  pluginConfig: Record<string, unknown>;
  registerCli: ReturnType<typeof vi.fn>;
  registerTool: ReturnType<typeof vi.fn>;
  registrationMode: string;
  runtime: {
    agent: Record<string, unknown>;
    state: { resolveStateDir: () => string };
    version?: string;
  };
}

function createFakeApi(params: {
  version?: string;
  injectionMode: "prepend" | "append";
  showInjected?: boolean;
}): {
  api: FakeOpenClawApi;
  getHook: (name: string) => HookHandler;
} {
  const hooks = new Map<string, HookHandler>();
  const api: FakeOpenClawApi = {
    config: {
      plugins: {
        entries: {
          "memory-tencentdb": {
            hooks: { allowConversationAccess: true },
          },
        },
      },
    },
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    on: (name, handler) => {
      hooks.set(name, handler);
    },
    pluginConfig: {
      capture: { enabled: false },
      embedding: { enabled: false, provider: "none" },
      offload: { enabled: false },
      recall: {
        enabled: true,
        injectionMode: params.injectionMode,
        showInjected: params.showInjected ?? false,
      },
    },
    registerCli: vi.fn(),
    registerTool: vi.fn(),
    registrationMode: "runtime",
    runtime: {
      agent: {},
      state: { resolveStateDir: () => "/tmp/memory-tencentdb-register-test" },
      ...(params.version ? { version: params.version } : {}),
    },
  };

  register(api as unknown as Parameters<typeof register>[0]);
  return {
    api,
    getHook: (name) => {
      const hook = hooks.get(name);
      if (!hook) throw new Error(`Hook not registered: ${name}`);
      return hook;
    },
  };
}

describe("OpenClaw register recall integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    coreMocks.handleBeforeRecall.mockResolvedValue({
      appendSystemContext: "<user-persona>stable</user-persona>",
      prependContext: buildGeneratedRecallContext(["- [fact] dynamic"]),
      recallStrategy: "hybrid",
    });
  });

  it.each([
    {
      version: "2026.4.25",
      expectedStable: "appendSystemContext",
      expectedDynamic: "prependContext",
    },
    {
      version: "2026.4.26",
      expectedStable: "prependSystemContext",
      expectedDynamic: "prependContext",
    },
    {
      version: "2026.4.27",
      expectedStable: "prependSystemContext",
      expectedDynamic: "appendContext",
    },
    {
      version: undefined,
      expectedStable: "appendSystemContext",
      expectedDynamic: "prependContext",
    },
  ])(
    "shapes hooks safely for host version $version",
    async ({ version, expectedStable, expectedDynamic }) => {
      const { getHook } = createFakeApi({
        version,
        injectionMode: "append",
      });

      const result = await getHook("before_prompt_build")(
        { prompt: "question", messages: [] },
        { sessionKey: `session-${version ?? "unknown"}` },
      ) as Record<string, unknown>;

      expect(result[expectedStable]).toBe("<user-persona>stable</user-persona>");
      expect(result[expectedDynamic]).toContain("<relevant-memories>");
      expect(result.recallStrategy).toBe("hybrid");
    },
  );

  it.each([
    { version: "2026.4.25", placement: "prepend" as const },
    { version: "2026.4.27", placement: "append" as const },
  ])(
    "cleans persisted generated recall using the effective $placement placement",
    ({ version, placement }) => {
      const { getHook } = createFakeApi({
        version,
        injectionMode: "append",
      });
      const recall = buildGeneratedRecallContext(["- [fact] dynamic"]);
      const content = placement === "append"
        ? `question\n\n${recall}`
        : `${recall}\n\nquestion`;

      const result = getHook("before_message_write")({
        message: { role: "user", content },
      }) as { message?: { content?: unknown } } | undefined;

      expect(result?.message?.content).toBe("question");
    },
  );

  it("preserves injected recall when showInjected is enabled", () => {
    const { getHook } = createFakeApi({
      version: "2026.4.27",
      injectionMode: "append",
      showInjected: true,
    });
    const recall = buildGeneratedRecallContext(["- [fact] dynamic"]);

    expect(
      getHook("before_message_write")({
        message: { role: "user", content: `question\n\n${recall}` },
      }),
    ).toBeUndefined();
  });

  it.each([
    {
      version: "2026.4.25",
      placement: "prepend" as const,
      content: (recall: string) => `other prepend\n\n${recall}\n\nquestion`,
      expected: "other prepend\n\nquestion",
    },
    {
      version: "2026.4.27",
      placement: "append" as const,
      content: (recall: string) => `question\n\n${recall}\n\nother append`,
      expected: "question\n\nother append",
    },
  ])(
    "removes tracked recall surrounded by other hooks in $placement mode",
    async ({ version, content, expected }) => {
      const { getHook } = createFakeApi({
        version,
        injectionMode: "append",
      });
      const sessionKey = `merged-${version}`;
      const promptResult = await getHook("before_prompt_build")(
        { prompt: "question", messages: [] },
        { sessionKey },
      ) as Record<string, unknown>;
      const recall = String(promptResult.prependContext ?? promptResult.appendContext);

      const result = getHook("before_message_write")(
        { message: { role: "user", content: content(recall) } },
        { sessionKey },
      ) as { message?: { content?: unknown } } | undefined;

      expect(result?.message?.content).toBe(expected);
    },
  );
});
