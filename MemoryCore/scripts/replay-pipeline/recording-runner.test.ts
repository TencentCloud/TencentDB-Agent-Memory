import { describe, it, expect } from "vitest";
import { RecordingLLMRunner, RecordingLLMRunnerFactory } from "./recording-runner.js";
import type { RecordedLlmCall } from "./recording-runner.js";
import type { LLMRunner, LLMRunParams, LLMRunnerFactory, LLMRunnerCreateOptions } from "../../src/core/types.js";

class FakeRunner implements LLMRunner {
  constructor(private output: string) {}
  async run(params: LLMRunParams): Promise<string> {
    void params;
    return this.output;
  }
}

class FakeFactory implements LLMRunnerFactory {
  constructor(private output: string) {}
  createRunner(_opts?: LLMRunnerCreateOptions): LLMRunner {
    return new FakeRunner(this.output);
  }
}

describe("RecordingLLMRunner", () => {
  it("records systemPrompt / prompt / response / duration", async () => {
    const sink: RecordedLlmCall[] = [];
    const recording = new RecordingLLMRunner(new FakeRunner("ok"), sink, "tag");

    const result = await recording.run({
      taskId: "l1-extraction",
      systemPrompt: "sys",
      prompt: "user",
    });

    expect(result).toBe("ok");
    expect(sink).toHaveLength(1);
    const call = sink[0]!;
    expect(call.taskId).toBe("l1-extraction");
    expect(call.systemPrompt).toBe("sys");
    expect(call.prompt).toBe("user");
    expect(call.response).toBe("ok");
    expect(call.success).toBe(true);
    expect(call.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("records failures with error message and re-throws", async () => {
    const sink: RecordedLlmCall[] = [];
    const failing: LLMRunner = {
      async run(): Promise<string> {
        throw new Error("boom");
      },
    };
    const recording = new RecordingLLMRunner(failing, sink, "tag");

    await expect(recording.run({ taskId: "l1", prompt: "p" })).rejects.toThrow("boom");
    expect(sink).toHaveLength(1);
    expect(sink[0]!.success).toBe(false);
    expect(sink[0]!.error).toBe("boom");
    expect(sink[0]!.response).toBe("");
  });
});

describe("RecordingLLMRunnerFactory", () => {
  it("wraps created runners into a shared sink", async () => {
    const sink: RecordedLlmCall[] = [];
    const factory = new RecordingLLMRunnerFactory(new FakeFactory("out"), sink, "tag");
    const runner = factory.createRunner({ enableTools: false });
    await runner.run({ taskId: "scene-extract", prompt: "p" });
    expect(sink).toHaveLength(1);
    expect(sink[0]!.taskId).toBe("scene-extract");
  });
});
