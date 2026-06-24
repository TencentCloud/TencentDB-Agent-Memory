import { describe, expect, it } from "vitest";
import { registerOffload } from "./index.js";

function makeLogger() {
  const messages: string[] = [];
  const log = (message: string) => messages.push(message);

  return {
    logger: {
      debug: log,
      info: log,
      warn: log,
      error: log,
    },
    messages,
  };
}

describe("offload local model resolution", () => {
  it("preserves slash-delimited namespaces inside the model id", () => {
    const { logger, messages } = makeLogger();

    registerOffload({
      logger,
      config: {
        models: {
          providers: {
            siliconflow: {
              baseUrl: "https://api.siliconflow.example/v1",
              apiKey: "sk-test",
            },
          },
        },
      },
      on: () => {},
      registerContextEngine: () => ({ ok: true }),
    }, {
      mode: "local",
      model: "siliconflow/deepseek-ai/DeepSeek-V4-Flash",
    } as any);

    expect(messages).toContain(
      "[context-offload] [local-llm] Initialized: model=deepseek-ai/DeepSeek-V4-Flash, baseUrl=https://api.siliconflow.example/v1",
    );
  });
});
