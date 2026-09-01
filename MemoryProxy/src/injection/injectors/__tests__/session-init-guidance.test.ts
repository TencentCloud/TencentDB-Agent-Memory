import { describe, expect, it } from "vitest";
import { renderSkillToolsBlock } from "../skill-tools-injector.js";
import { renderTdaiMemoryToolsBlock } from "../tdai-tools-injector.js";

describe("session-init tool guidance", () => {
  it("tells skill-enabled agents to use only the listed bridge paths", () => {
    const block = renderSkillToolsBlock("http://127.0.0.1:8096");

    expect(block).toContain("本段已在 session-init 完成后注入");
    expect(block).toContain("不要猜测或探测 /openapi.json");
  });

  it("tells memory-enabled agents that initialization is already complete", () => {
    const block = renderTdaiMemoryToolsBlock("http://127.0.0.1:8096");

    expect(block).toContain("会话初始化已完成");
    expect(block).toContain("不需要再次探测 session/team/agent metadata");
  });
});
