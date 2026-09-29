import { describe, it, expect } from "vitest";
import { estimateAnthropicInputTokens } from "../common/token-estimate.js";

describe("estimateAnthropicInputTokens（count_tokens 本地兜底）", () => {
  it("按 system/messages/tools 序列化长度估算，返回正整数", () => {
    const n = estimateAnthropicInputTokens({
      model: "m",
      system: "you are a helpful assistant",
      messages: [
        { role: "user", content: "hello world this is a longer message" },
        { role: "assistant", content: "hi there" },
      ],
      tools: [{ name: "f", description: "tool", input_schema: { type: "object" } }],
    });
    expect(Number.isInteger(n)).toBe(true);
    expect(n).toBeGreaterThan(0);
  });

  it("文本越长估算越大", () => {
    const short = estimateAnthropicInputTokens({
      messages: [{ role: "user", content: "hi" }],
    });
    const long = estimateAnthropicInputTokens({
      messages: [{ role: "user", content: "x".repeat(500) }],
    });
    expect(long).toBeGreaterThan(short);
  });

  it("空 body 也返回 >= 1", () => {
    expect(estimateAnthropicInputTokens({})).toBeGreaterThanOrEqual(1);
  });

  it("异常输入（null / 字符串 / 数组 / 非 JSON）不抛错且返回 >= 1", () => {
    expect(estimateAnthropicInputTokens(null)).toBeGreaterThanOrEqual(1);
    expect(estimateAnthropicInputTokens("hello")).toBeGreaterThanOrEqual(1);
    expect(estimateAnthropicInputTokens([1, 2, 3])).toBeGreaterThanOrEqual(1);
    expect(estimateAnthropicInputTokens(42)).toBeGreaterThanOrEqual(1);
  });

  // ── 以下三条是「口径回归」：锁定 tiktoken(cl100k) 口径，防止退回 chars/4 ──
  // 期望值取自 scripts/qa/token-estimate-vs-upstream.mjs 的实测（cl100k_base）。

  it("中文按 tokenizer 计数：100 个汉字 ≈ 131 tokens（旧 chars/4 仅 ~37，低估 68%）", () => {
    const n = estimateAnthropicInputTokens({
      messages: [{ role: "user", content: "记忆代理".repeat(25) }],
    });
    expect(n).toBeGreaterThanOrEqual(120);
    expect(n).toBeLessThanOrEqual(145);
  });

  it("同样 200 字符下，中文 token 数远高于 ASCII（旧 chars/4 无法区分二者）", () => {
    const zh = estimateAnthropicInputTokens({
      messages: [{ role: "user", content: "汉".repeat(200) }],
    });
    const ascii = estimateAnthropicInputTokens({
      messages: [{ role: "user", content: "a".repeat(200) }],
    });
    // 实测：中文 406 vs ASCII 31；旧口径下两者几乎相同（52 / 53）
    expect(zh).toBeGreaterThan(ascii * 8);
  });

  it("英文不再被高估：440 字符 ≈ 97 tokens（旧 chars/4 为 ~124，高估 42%）", () => {
    const n = estimateAnthropicInputTokens({
      messages: [
        { role: "user", content: "the quick brown fox jumps over the lazy dog ".repeat(10) },
      ],
    });
    expect(n).toBeGreaterThanOrEqual(85);
    expect(n).toBeLessThanOrEqual(110);
  });
});
