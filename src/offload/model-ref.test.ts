import { describe, expect, it } from "vitest";

import {
  getContextWindowForModelRef,
  parseOffloadModelRef,
} from "./model-ref.js";

describe("parseOffloadModelRef", () => {
  it("preserves namespaced model ids after the provider separator", () => {
    expect(parseOffloadModelRef("siliconflow/deepseek-ai/DeepSeek-V4-Flash")).toEqual({
      providerKey: "siliconflow",
      modelId: "deepseek-ai/DeepSeek-V4-Flash",
    });
  });

  it("returns null for aliases or malformed refs", () => {
    expect(parseOffloadModelRef("claude-code")).toBeNull();
    expect(parseOffloadModelRef("/missing-provider")).toBeNull();
    expect(parseOffloadModelRef("provider/")).toBeNull();
    expect(parseOffloadModelRef("   ")).toBeNull();
  });
});

describe("getContextWindowForModelRef", () => {
  it("matches provider model entries with slash-containing model ids", () => {
    const models = {
      providers: {
        siliconflow: {
          models: [
            { id: "deepseek-ai/DeepSeek-V4-Flash", contextWindow: 128000 },
            { id: "deepseek-ai", contextWindow: 4096 },
          ],
        },
      },
    };

    expect(
      getContextWindowForModelRef(models, "siliconflow/deepseek-ai/DeepSeek-V4-Flash"),
    ).toBe(128000);
  });
});
