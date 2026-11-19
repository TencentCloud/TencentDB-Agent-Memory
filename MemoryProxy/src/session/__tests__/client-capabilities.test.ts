import { describe, expect, it } from "vitest";

import { detectClientCapabilities } from "../client-capabilities.js";

describe("detectClientCapabilities", () => {
  it("keeps memory enabled for dsh PTC requests that only expose run_code", () => {
    const capabilities = detectClientCapabilities("dsh", {
      tools: [{ type: "function", function: { name: "run_code" } }],
    });

    expect(capabilities).toEqual({
      askUserQuestion: false,
      memoryPipeline: true,
    });
  });

  it("keeps both form and memory enabled when dsh exposes ask_user_question", () => {
    const capabilities = detectClientCapabilities("dsh", {
      tools: [{ name: "ask_user_question" }, { name: "read_file" }],
    });

    expect(capabilities).toEqual({
      askUserQuestion: true,
      memoryPipeline: true,
    });
  });

  it("keeps memory enabled when workbuddy cannot render an ask card", () => {
    const capabilities = detectClientCapabilities("workbuddy", {
      tools: [{ name: "Read" }],
    });

    expect(capabilities).toEqual({
      askUserQuestion: false,
      memoryPipeline: true,
    });
  });
});
