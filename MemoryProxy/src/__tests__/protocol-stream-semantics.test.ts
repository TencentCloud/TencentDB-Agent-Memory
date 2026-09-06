import { describe, it, expect } from "vitest";
import {
  responsesBodyToChat,
  chatBodyToResponses,
} from "../common/responses-chat-compat.js";
import {
  responsesToAnthropic,
  anthropicToResponses,
} from "../common/responses-anthropic-compat.js";

const userMsg = { role: "user", content: "hi" };

describe("协议接线 stream 语义透传（非流式请求不能被强制成流式）", () => {
  it("responsesBodyToChat：显式 stream:false → 上游 Chat 也非流式", () => {
    const chat = responsesBodyToChat(
      { model: "m", input: "hi", stream: false },
      {},
    );
    expect(chat.stream).toBe(false);
  });

  it("responsesBodyToChat：缺省/stream:true → 保持 codexHandler 的流式口径", () => {
    expect(responsesBodyToChat({ model: "m", input: "hi" }, {}).stream).toBe(true);
    expect(
      responsesBodyToChat({ model: "m", input: "hi", stream: true }, {}).stream,
    ).toBe(true);
  });

  it("chatBodyToResponses：缺省与 stream:false → Responses 非流式；stream:true → 流式", () => {
    expect(
      chatBodyToResponses({ model: "m", messages: [userMsg] }).stream,
    ).toBe(false);
    expect(
      chatBodyToResponses(
        { model: "m", messages: [userMsg], stream: false },
        {},
      ).stream,
    ).toBe(false);
    expect(
      chatBodyToResponses(
        { model: "m", messages: [userMsg], stream: true },
        {},
      ).stream,
    ).toBe(true);
  });

  it("anthropicToResponses：Anthropic 客户端 stream:false → Responses 上游非流式", () => {
    const out = anthropicToResponses(
      { model: "m", messages: [userMsg], stream: false },
      {},
    );
    expect(out.stream).toBe(false);
  });

  it("responsesToAnthropic：Responses 客户端 stream:false → Anthropic 上游非流式", () => {
    const out = responsesToAnthropic(
      { model: "m", input: "hi", stream: false },
      {},
    );
    expect(out.stream).toBeFalsy();
  });
});
