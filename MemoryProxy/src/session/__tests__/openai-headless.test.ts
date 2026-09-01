import { describe, expect, it } from "vitest";
import {
  buildHeadlessSessionResetMessage,
  isOpenAIHeadless,
} from "../openai-headless.js";

const functionTool = (name: string) => ({ type: "function", function: { name } });

describe("OpenAI native form headless detection", () => {
  it("keeps interactive Cursor requests on the session-init path", () => {
    expect(isOpenAIHeadless("cursor", { tools: [functionTool("AskQuestion")] })).toBe(false);
  });

  it("bypasses Cursor requests with an empty or missing tool preset", () => {
    expect(isOpenAIHeadless("cursor", {})).toBe(true);
    expect(isOpenAIHeadless("cursor", { tools: [] })).toBe(true);
    expect(isOpenAIHeadless("cursor", { tools: [functionTool("Shell")] })).toBe(true);
  });

  it("preserves the existing dsh empty-tools behaviour", () => {
    expect(isOpenAIHeadless("dsh", {})).toBe(false);
    expect(isOpenAIHeadless("dsh", { tools: [] })).toBe(false);
    expect(isOpenAIHeadless("dsh", { tools: [functionTool("ask_user_question")] })).toBe(false);
    expect(isOpenAIHeadless("dsh", { tools: [functionTool("shell")] })).toBe(true);
  });

  it("uses the client-specific native tool in session-reset guidance", () => {
    expect(buildHeadlessSessionResetMessage("cursor")).toContain("AskQuestion");
    expect(buildHeadlessSessionResetMessage("cursor")).not.toContain("dsh 客户端");
    expect(buildHeadlessSessionResetMessage("dsh")).toContain("ask_user_question");
  });
});
