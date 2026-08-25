import { describe, expect, it } from "vitest";
import { renderSkillToolsBlock } from "../skill-tools-injector.js";
import { renderTdaiMemoryToolsBlock } from "../tdai-tools-injector.js";

describe("Cursor-compatible bridge tool instructions", () => {
  const base = "https://proxy.example.com";
  const session = "cursor-session-1";

  it("renders a PowerShell-safe memory bridge example", () => {
    const text = renderTdaiMemoryToolsBlock(base, session, "default", "cursor");
    expect(text).toContain("Invoke-RestMethod");
    expect(text).toContain("ConvertTo-Json -Compress");
    expect(text).toContain(`'x-conversation-id'='${session}'`);
    expect(text).toContain("Do not execute the Bash curl examples");
  });

  it("renders a PowerShell-safe skill bridge example", () => {
    const text = renderSkillToolsBlock(base, false, session, "default", "cursor");
    expect(text).toContain("Invoke-RestMethod");
    expect(text).toContain("include_manifest=$true");
    expect(text).toContain(`'x-conversation-id'='${session}'`);
    expect(text).toContain("Do not use the `curl` alias");
  });

  it("does not change bridge instructions for non-Cursor clients", () => {
    const memory = renderTdaiMemoryToolsBlock(base, session, "default", "codebuddy");
    const skill = renderSkillToolsBlock(base, false, session, "default", "codebuddy");
    expect(memory).not.toContain("Cursor PowerShell compatibility");
    expect(memory).not.toContain("Invoke-RestMethod");
    expect(skill).not.toContain("Shell 兼容（必须遵守）");
    expect(skill).not.toContain("Invoke-RestMethod");
  });
});
