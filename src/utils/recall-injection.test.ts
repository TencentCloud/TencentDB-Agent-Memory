import { describe, expect, it } from "vitest";

import {
  stripInjectedRecallFromMessage,
  stripInjectedRecallText,
} from "./recall-injection.js";

function injected(content: string, prompt = "请继续分析这个问题"): string {
  return `<relevant-memories>
以下是当前对话召回的相关记忆，不代表当前任务进程，仅作为参考：

- [persona] ${content}
</relevant-memories>

${prompt}`;
}

describe("recall injection stripping", () => {
  it("strips generated recall blocks from plain user text", () => {
    const result = stripInjectedRecallText(injected("用户偏好简洁 TypeScript 示例"));

    expect(result?.text).toBe("请继续分析这个问题");
    expect(result?.strippedChars).toBeGreaterThan(0);
  });

  it("does not strip user-authored relevant-memory examples without the generated marker", () => {
    const text = "<relevant-memories>this is documentation, not injected recall</relevant-memories>\n请解释这段 XML";

    expect(stripInjectedRecallText(text)).toBeUndefined();
  });

  it("strips only user messages unless showInjected is enabled", () => {
    const user = { role: "user", content: injected("动态召回") };
    const assistant = { role: "assistant", content: injected("不应处理") };

    expect(stripInjectedRecallFromMessage(user)?.message.content).toBe("请继续分析这个问题");
    expect(stripInjectedRecallFromMessage(assistant)).toBeUndefined();
    expect(stripInjectedRecallFromMessage(user, { showInjected: true })).toBeUndefined();
  });

  it("strips generated recall from text parts and preserves non-text parts", () => {
    const image = { type: "image", source: "memory://image" };
    const message = {
      role: "user",
      content: [
        { type: "text", text: injected("多模态场景") },
        image,
      ],
    };

    const result = stripInjectedRecallFromMessage(message);

    expect(result?.message.content).toEqual([
      { type: "text", text: "请继续分析这个问题" },
      image,
    ]);
  });

  it("prevents generated recall from accumulating across persisted turns by default", () => {
    const persisted: Array<{ role: "user"; content: string }> = [];

    for (let i = 1; i <= 3; i++) {
      const result = stripInjectedRecallFromMessage({
        role: "user" as const,
        content: injected(`turn ${i}`, `第 ${i} 轮真实用户输入`),
      });
      persisted.push(result?.message ?? { role: "user", content: injected(`turn ${i}`) });
    }

    expect(persisted.map((m) => m.content).join("\n")).not.toContain("<relevant-memories>");
    expect(persisted.map((m) => m.content)).toEqual([
      "第 1 轮真实用户输入",
      "第 2 轮真实用户输入",
      "第 3 轮真实用户输入",
    ]);
  });
});
