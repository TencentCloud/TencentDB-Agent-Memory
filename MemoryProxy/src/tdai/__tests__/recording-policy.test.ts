import { describe, expect, it } from "vitest";
import { shouldRecordTdaiTurn } from "../recorder.js";

describe("shouldRecordTdaiTurn", () => {
  it("skips intermediate headless tool-call responses", () => {
    expect(shouldRecordTdaiTurn(true, {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "call-1", function: { name: "bash", arguments: "{}" } }],
    })).toBe(false);
  });

  it("records a final headless response", () => {
    expect(shouldRecordTdaiTurn(true, {
      role: "assistant",
      content: "Final answer",
    })).toBe(true);
  });

  it("uses the stream tool-call count for headless responses", () => {
    const response = { role: "assistant", content: "Final answer" };
    expect(shouldRecordTdaiTurn(true, response, 1)).toBe(false);
    expect(shouldRecordTdaiTurn(true, response, 0)).toBe(true);
  });

  it("preserves recording behavior outside the headless policy", () => {
    expect(shouldRecordTdaiTurn(false, {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "call-1" }],
    })).toBe(true);
  });

  it("requires a non-empty headless final response without changing other clients", () => {
    expect(shouldRecordTdaiTurn(true, null)).toBe(false);
    expect(shouldRecordTdaiTurn(true, { role: "assistant", content: "" })).toBe(false);
    expect(shouldRecordTdaiTurn(false, null)).toBe(true);
  });
});
