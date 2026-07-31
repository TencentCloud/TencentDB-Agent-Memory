import { describe, expect, it } from "vitest";
import { resolveAfterToolCallMessages } from "./after-tool-call.js";

describe("resolveAfterToolCallMessages", () => {
  it("uses event messages when present", () => {
    const eventMessages = [{ role: "user", content: "from event" }];
    const ctxMessages = [{ role: "user", content: "from ctx" }];

    expect(resolveAfterToolCallMessages({ messages: eventMessages }, { messages: ctxMessages })).toEqual({
      messages: eventMessages,
      source: "event.messages",
    });
  });

  it("falls back to context messages when event messages are missing", () => {
    const ctxMessages = [{ role: "assistant", content: "from ctx" }];

    expect(resolveAfterToolCallMessages({}, { messages: ctxMessages })).toEqual({
      messages: ctxMessages,
      source: "ctx.messages",
    });
  });

  it("falls back to OpenClaw session params messages", () => {
    const sessionMessages = [{ role: "tool", content: "result" }];

    expect(resolveAfterToolCallMessages({}, { params: { session: { messages: sessionMessages } } })).toEqual({
      messages: sessionMessages,
      source: "ctx.params.session.messages",
    });
  });

  it("prefers a non-empty fallback over an empty event messages array", () => {
    const ctxMessages = [{ role: "user", content: "from ctx" }];

    expect(resolveAfterToolCallMessages({ messages: [] }, { historyMessages: ctxMessages })).toEqual({
      messages: ctxMessages,
      source: "ctx.historyMessages",
    });
  });
});
