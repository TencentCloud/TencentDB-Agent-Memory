import { describe, expect, it } from "vitest";
import { parseModelRef } from "./model-ref.js";

describe("parseModelRef", () => {
  it("parses a simple provider/model reference", () => {
    expect(parseModelRef("openai/gpt-4o")).toEqual({
      provider: "openai",
      model: "gpt-4o",
    });
  });

  it("keeps namespace slashes in the model id", () => {
    expect(parseModelRef("siliconflow/deepseek-ai/DeepSeek-V4-Flash")).toEqual({
      provider: "siliconflow",
      model: "deepseek-ai/DeepSeek-V4-Flash",
    });
  });

  it("trims surrounding whitespace", () => {
    expect(parseModelRef("  custom-host/org/model-v2  ")).toEqual({
      provider: "custom-host",
      model: "org/model-v2",
    });
  });

  it("rejects invalid model references", () => {
    expect(parseModelRef(undefined)).toBeUndefined();
    expect(parseModelRef("")).toBeUndefined();
    expect(parseModelRef("bare-model-name")).toBeUndefined();
    expect(parseModelRef("/missing-provider")).toBeUndefined();
    expect(parseModelRef("missing-model/")).toBeUndefined();
  });
});
