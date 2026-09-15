import { describe, expect, it } from "vitest";
import {
  HERMES_BYPASS_TEXT,
  isClarifyAnswerEnvelope,
  unwrapClarifyAnswer,
} from "../extractor.js";
import { ASSET_CONFIRM_NO } from "../form.js";

describe("unwrapClarifyAnswer（hermes clarify 结果信封）", () => {
  it("正常回答：只取 user_response，不把回显的 question/choices 带下去", () => {
    const payload = JSON.stringify({
      question: "请选择 Team（若选择跳过，本次 Session 将不注入团队资产）",
      choices_offered: ["Team1 (00000001)", "Team2 (00000002)"],
      user_response: "Team1 (00000001)",
    });
    expect(unwrapClarifyAnswer(payload)).toBe("Team1 (00000001)");
  });

  it("user_response 是数组时用 ' | ' 连接（multi_select 形态）", () => {
    const payload = JSON.stringify({ question: "q", user_response: ["A", "B"] });
    expect(unwrapClarifyAnswer(payload)).toBe("A | B");
  });

  it("error 信封（无 UI 形态）→ bypass 文本", () => {
    const payload = JSON.stringify({
      error: "Clarify tool is not available in this execution context.",
    });
    expect(unwrapClarifyAnswer(payload)).toBe(HERMES_BYPASS_TEXT);
    expect(HERMES_BYPASS_TEXT).toContain(ASSET_CONFIRM_NO);
  });

  it("超时 / one-shot → bypass 文本", () => {
    const timeout = JSON.stringify({
      question: "q",
      user_response: "The user did not provide a response within the time limit",
    });
    const oneshot = JSON.stringify({
      question: "q",
      user_response: "[oneshot mode: no user available. Pick the best option]",
    });
    expect(unwrapClarifyAnswer(timeout)).toBe(HERMES_BYPASS_TEXT);
    expect(unwrapClarifyAnswer(oneshot)).toBe(HERMES_BYPASS_TEXT);
  });

  it("空 user_response → 空串（交给状态机按未识别重试）", () => {
    expect(unwrapClarifyAnswer(JSON.stringify({ question: "q", user_response: "" }))).toBe("");
  });

  it("不是信封的文本/JSON → null（保持其它客户端的原路径）", () => {
    expect(unwrapClarifyAnswer("普通文本答案")).toBeNull();
    expect(unwrapClarifyAnswer("{bad json")).toBeNull();
    expect(unwrapClarifyAnswer(JSON.stringify({ status: "ok", result: 1 }))).toBeNull();
    expect(isClarifyAnswerEnvelope(JSON.stringify({ foo: "bar" }))).toBe(false);
  });
});
