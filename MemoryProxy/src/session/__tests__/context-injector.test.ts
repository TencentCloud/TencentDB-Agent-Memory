import { describe, expect, it } from "vitest";
import { injectSessionContextWithToggles } from "../context-injector.js";

const agent = { id: "agent-1", name: "Agent" };

describe("missing task context", () => {
  it("informs the model that only Agent-scoped assets are active", () => {
    const result = injectSessionContextWithToggles([], agent, null, { injectAgentContext: true, injectTaskContext: true }, "session");
    expect(String(result[0]?.content)).toContain("如需任务级记忆请添加 x-task-id");
  });

  it("respects injectTaskContext=false for the missing-task notice", () => {
    const result = injectSessionContextWithToggles([], agent, null, { injectAgentContext: true, injectTaskContext: false }, "session");
    expect(String(result[0]?.content)).not.toContain("[Task]");
  });
});
