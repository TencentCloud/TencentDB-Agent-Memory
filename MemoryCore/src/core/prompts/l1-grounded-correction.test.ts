import { describe, expect, it } from "vitest";

import {
  EXTRACT_MEMORIES_SYSTEM_PROMPT,
  EXTRACT_WORK_MEMORIES_SYSTEM_PROMPT,
  USER_GROUNDED_ASSISTANT_CORRECTION_RULES,
} from "./l1-extraction.js";

describe("L1 user-grounded assistant correction rules", () => {
  it("allows a final assistant restatement only when a user supplied the correction", () => {
    expect(USER_GROUNDED_ASSISTANT_CORRECTION_RULES).toContain(
      "user 明确给出正确事实、纠正、确认或认可",
    );
    expect(USER_GROUNDED_ASSISTANT_CORRECTION_RULES).toContain(
      "assistant 只是完整复述该用户信息",
    );
    expect(USER_GROUNDED_ASSISTANT_CORRECTION_RULES).toContain(
      "用户确认/纠正的事实或决定",
    );
  });

  it("keeps unilateral assistant conclusions excluded", () => {
    expect(USER_GROUNDED_ASSISTANT_CORRECTION_RULES).toContain(
      "不得提取 AI 助手单方面生成的判断、建议、猜测或输出",
    );
  });

  it("does not infer a correction when the user only says the assistant is wrong", () => {
    expect(USER_GROUNDED_ASSISTANT_CORRECTION_RULES).toContain(
      'user 只说"你错了"而未提供正确事实',
    );
    expect(USER_GROUNDED_ASSISTANT_CORRECTION_RULES).toContain(
      "不得从 assistant 输出推断或提取该结论",
    );
  });

  it("prefers the complete fact already stated by the user", () => {
    expect(USER_GROUNDED_ASSISTANT_CORRECTION_RULES).toContain(
      "正确事实已完整出现在 user 消息中",
    );
    expect(USER_GROUNDED_ASSISTANT_CORRECTION_RULES).toContain(
      "不得为了使用 assistant 输出而改写、扩大或替代用户原意",
    );
  });

  it("requires both source message ids and rejects assistant-user conflicts", () => {
    expect(USER_GROUNDED_ASSISTANT_CORRECTION_RULES).toContain(
      "必须同时包含提供纠正或确认的 user 消息 ID",
    );
    expect(USER_GROUNDED_ASSISTANT_CORRECTION_RULES).toContain(
      "承载最终完整表述的 assistant 消息 ID",
    );
    expect(USER_GROUNDED_ASSISTANT_CORRECTION_RULES).toContain(
      "assistant 最终表述与 user 的明确纠正冲突",
    );
  });

  it("applies the same guarded exception to chat and work prompts", () => {
    for (const prompt of [
      EXTRACT_MEMORIES_SYSTEM_PROMPT,
      EXTRACT_WORK_MEMORIES_SYSTEM_PROMPT,
    ]) {
      expect(prompt).toContain(USER_GROUNDED_ASSISTANT_CORRECTION_RULES);
    }
    expect(EXTRACT_MEMORIES_SYSTEM_PROMPT).toContain(
      '不满足上述"用户锚定的助手纠正结论"例外',
    );
  });
});
