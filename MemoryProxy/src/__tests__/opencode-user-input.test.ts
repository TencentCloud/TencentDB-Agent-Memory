import { describe, expect, it } from "vitest";
import { extractLatestUserMessage } from "../tdai/recorder.js";
import { opencodeAdapter } from "../agent-adapters/opencode.js";

describe("OpenCode user input with recalled memory", () => {
  it("classifies the OpenCode 2.0 title request as auxiliary", () => {
    expect(opencodeAdapter.classifyRequest({
      messages: [
        { role: "system", content: "You are a title generator. You output ONLY a thread title. Nothing else." },
        { role: "user", content: "用户问题" },
      ],
    })).toBe("auxiliary");
    expect(opencodeAdapter.classifyRequest({
      messages: [
        { role: "system", content: "You are an AI agent running in OpenCode" },
        { role: "user", content: "用户问题" },
      ],
    })).toBe("main");
  });

  it("keeps the human message when L1 recall is prepended in the user role", () => {
    const messages = [
      { role: "system", content: "agent instructions" },
      {
        role: "user",
        content: "<tdai_recalled_l1_memories>\nprevious private memory\n</tdai_recalled_l1_memories>\n你好，我在用 hyhmodel",
      },
    ];

    expect(extractLatestUserMessage(messages)).toEqual({
      role: "user",
      content: "你好，我在用 hyhmodel",
    });
  });

  it("does not report recall-only context as a new human input", () => {
    const messages = [
      { role: "user", content: "第一轮真实问题" },
      { role: "assistant", content: "回答" },
      { role: "user", content: "<tdai_recalled_l1_memories>\nprevious private memory\n</tdai_recalled_l1_memories>" },
    ];

    expect(extractLatestUserMessage(messages)?.content).toBe("第一轮真实问题");
    expect(opencodeAdapter.extractUserText(messages[2].content)).toBeNull();
  });

  it("cleans recalled memory in content-block messages too", () => {
    expect(opencodeAdapter.extractUserText([
      { type: "text", text: "<tdai_recalled_l1_memories>旧记忆</tdai_recalled_l1_memories>" },
      { type: "text", text: "新的用户问题" },
    ])).toBe("新的用户问题");
  });
});
