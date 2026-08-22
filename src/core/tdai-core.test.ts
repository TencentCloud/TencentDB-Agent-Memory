import { describe, expect, it } from "vitest";
import { parseConfig } from "../config.js";
import { TdaiCore } from "./tdai-core.js";
import type {
  HostAdapter,
  LLMRunParams,
  LLMRunner,
  LLMRunnerCreateOptions,
  Logger,
} from "./types.js";

const logger: Logger = {
  info() {},
  warn() {},
  error() {},
};

describe("TdaiCore", () => {
  it("passes layer-specific model refs when creating standalone pipeline runners", () => {
    const createRunnerCalls: Array<LLMRunnerCreateOptions | undefined> = [];
    const runner: LLMRunner = {
      async run(_params: LLMRunParams) {
        return "";
      },
    };

    const hostAdapter: HostAdapter = {
      hostType: "standalone",
      getLogger: () => logger,
      getRuntimeContext: () => ({
        userId: "user-1",
        sessionId: "session-1",
        sessionKey: "agent:main:session-1",
        platform: "standalone",
        workspaceDir: "/tmp",
        dataDir: "/tmp/memory-tdai-test",
      }),
      getLLMRunnerFactory: () => ({
        createRunner(opts) {
          createRunnerCalls.push(opts);
          return runner;
        },
      }),
    };

    const cfg = parseConfig({
      extraction: { model: "openai/l1-mini" },
      persona: { model: "openai/persona-large" },
      llm: { enabled: true, apiKey: "test-key" },
    });

    const core = new TdaiCore({ hostAdapter, config: cfg });
    const coreInternals = core as unknown as {
      scheduler: {
        setL1Runner(runner: unknown): void;
        setPersister(persister: unknown): void;
        setL2Runner(runner: unknown): void;
        setL3Runner(runner: unknown): void;
      };
      wirePipelineRunners(): void;
    };
    coreInternals.scheduler = {
      setL1Runner() {},
      setPersister() {},
      setL2Runner() {},
      setL3Runner() {},
    };

    coreInternals.wirePipelineRunners();

    expect(createRunnerCalls).toEqual([
      { enableTools: false, modelRef: "openai/l1-mini" },
      { enableTools: true, modelRef: "openai/persona-large" },
    ]);
  });
});
