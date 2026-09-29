import { describe, it, expect } from "vitest";
import {
  toAnthropicErrorBody,
  toOpenAiErrorBody,
  isAnthropicErrorJson,
  isOpenAiErrorJson,
} from "../upstream/protocol-errors.js";

describe("协议错误体转换（protocol-errors）", () => {
  it("OpenAI 风格错误 → Anthropic 风格", () => {
    const text = JSON.stringify({
      error: { message: "bad request", type: "invalid_request_error", code: "E1" },
    });
    expect(JSON.parse(toAnthropicErrorBody(text))).toEqual({
      type: "error",
      error: { type: "invalid_request_error", message: "bad request" },
    });
  });

  it("Anthropic 风格错误 → OpenAI 风格", () => {
    const text = JSON.stringify({
      type: "error",
      error: { type: "overloaded_error", message: "upstream busy" },
    });
    expect(JSON.parse(toOpenAiErrorBody(text))).toEqual({
      error: { type: "overloaded_error", message: "upstream busy" },
    });
  });

  it("已是目标 schema 的错误体保持不变", () => {
    const anthropic = JSON.stringify({
      type: "error",
      error: { type: "api_error", message: "boom" },
    });
    expect(toAnthropicErrorBody(anthropic)).toBe(anthropic);

    const openAi = JSON.stringify({
      error: { message: "boom", type: "api_error" },
    });
    expect(toOpenAiErrorBody(openAi)).toBe(openAi);
  });

  it("非 JSON / 无法识别的错误体原样透传", () => {
    expect(toAnthropicErrorBody("<html>502</html>")).toBe("<html>502</html>");
    expect(toOpenAiErrorBody("plain text")).toBe("plain text");
    expect(toAnthropicErrorBody(JSON.stringify({ ok: 1 }))).toBe(JSON.stringify({ ok: 1 }));
  });

  it("识别函数只命中各自 schema", () => {
    const anthropic = { type: "error", error: { type: "x", message: "m" } };
    const openAi = { error: { message: "m", type: "x" } };
    expect(isAnthropicErrorJson(anthropic)).toBe(true);
    expect(isAnthropicErrorJson(openAi)).toBe(false);
    expect(isOpenAiErrorJson(anthropic)).toBe(false);
    expect(isOpenAiErrorJson(openAi)).toBe(true);
  });
});
