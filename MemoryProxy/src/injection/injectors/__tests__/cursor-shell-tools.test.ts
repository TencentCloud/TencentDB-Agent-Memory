import { describe, expect, it } from "vitest";
import { renderSkillToolsBlock } from "../skill-tools-injector.js";
import { renderTdaiMemoryToolsBlock } from "../tdai-tools-injector.js";

describe("Cursor-compatible bridge tool instructions", () => {
  const base = "https://proxy.example.com";
  const session = "cursor-session-1";

  it("renders a PowerShell-safe memory bridge example", () => {
    const text = renderTdaiMemoryToolsBlock(base, session, "default");
    expect(text).toContain("Invoke-RestMethod");
    expect(text).toContain("ConvertTo-Json -Compress");
    expect(text).toContain(`'x-conversation-id'='${session}'`);
    expect(text).toContain("禁止直接执行下面的 Bash curl 示例");
  });

  it("renders a PowerShell-safe skill bridge example", () => {
    const text = renderSkillToolsBlock(base, false, session, "default");
    expect(text).toContain("Invoke-RestMethod");
    expect(text).toContain("include_manifest=$true");
    expect(text).toContain(`'x-conversation-id'='${session}'`);
    expect(text).toContain("禁止使用 `curl`");
  });
});
