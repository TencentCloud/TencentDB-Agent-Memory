import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  appendInitNoticeToTerminalCompletion,
  buildInitLinkNotice,
  buildInitLinkUrl,
  claimInitLinkToken,
  completeInitLinkToken,
  createInitLinkSseInjector,
  createOrReusePendingToken,
  markInitLinkNoticeDelivered,
  releaseInitLinkToken,
  validateInitLinkToken,
  __resetInitLinkStoreForTests,
} from "../init-link.js";

const TOKEN_PARAMS = {
  compositeKey: "hermes:session-1",
  sessionId: "session-1",
  agentSource: "hermes",
  userId: "user-1",
  userKey: "key-1",
  spaceId: "space-1",
  purpose: "init" as const,
};
const NOTICE = "\n\nOpen the init link";

function streamFrom(chunks: Array<string | Uint8Array>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(
          typeof chunk === "string" ? encoder.encode(chunk) : chunk,
        );
      }
      controller.close();
    },
  });
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let output = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) return output + decoder.decode();
    output += decoder.decode(value, { stream: true });
  }
}

function sseEvent(
  delta: Record<string, unknown>,
  finishReason: string | null,
  newline = "\n",
): string {
  return `data: ${JSON.stringify({
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}${newline}${newline}`;
}

describe("init-link token state", () => {
  beforeEach(() => __resetInitLinkStoreForTests());

  it("reuses one pending token per identity and purpose", () => {
    const first = createOrReusePendingToken(TOKEN_PARAMS);
    const second = createOrReusePendingToken(TOKEN_PARAMS);
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.record.token).toBe(first.record.token);
  });

  it("does not deduplicate init and rebind tokens together", () => {
    const init = createOrReusePendingToken(TOKEN_PARAMS);
    const rebind = createOrReusePendingToken({
      ...TOKEN_PARAMS,
      purpose: "rebind",
    });
    expect(rebind.record.token).not.toBe(init.record.token);
  });

  it("atomically claims, releases, and completes a token", () => {
    const { record } = createOrReusePendingToken(TOKEN_PARAMS);
    const first = claimInitLinkToken(record.token);
    expect(first.ok).toBe(true);
    expect(claimInitLinkToken(record.token)).toEqual({
      ok: false,
      reason: "processing",
    });
    if (!first.ok) throw new Error("claim failed");
    expect(releaseInitLinkToken(record.token, first.claimId).ok).toBe(true);

    const retry = claimInitLinkToken(record.token);
    if (!retry.ok) throw new Error("retry claim failed");
    expect(completeInitLinkToken(record.token, retry.claimId).ok).toBe(true);
    expect(validateInitLinkToken(record.token)).toEqual({
      ok: false,
      reason: "consumed",
    });
  });

  it("records notice delivery once", () => {
    const { record } = createOrReusePendingToken(TOKEN_PARAMS);
    expect(markInitLinkNoticeDelivered(record.token)).toBe(true);
    expect(markInitLinkNoticeDelivered(record.token)).toBe(false);
  });

  it("reports a consumed token as consumed even after its expiry time", () => {
    const { record } = createOrReusePendingToken({
      ...TOKEN_PARAMS,
      ttlMinutes: 0.001,
    });
    const claim = claimInitLinkToken(record.token);
    if (!claim.ok) throw new Error("claim failed");
    expect(completeInitLinkToken(record.token, claim.claimId).ok).toBe(true);

    const now = vi.spyOn(Date, "now").mockReturnValue(record.expiresAt + 1);
    try {
      expect(validateInitLinkToken(record.token)).toEqual({
        ok: false,
        reason: "consumed",
      });
    } finally {
      now.mockRestore();
    }
  });
});

describe("appendInitNoticeToTerminalCompletion", () => {
  it("appends only to a successful terminal assistant message", () => {
    const body: Record<string, unknown> = {
      choices: [{
        finish_reason: "stop",
        message: { role: "assistant", content: "answer" },
      }],
    };
    expect(
      appendInitNoticeToTerminalCompletion(body, () => NOTICE),
    ).toBe(true);
    expect(
      (
        (body.choices as Array<Record<string, unknown>>)[0]
          .message as Record<string, unknown>
      ).content,
    ).toBe(`answer${NOTICE}`);
  });

  it.each([
    ["tool call", "tool_calls", [{ id: "call-1" }]],
    ["function call", "function_call", { name: "tool" }],
  ])("does not append to a %s response", (_label, field, value) => {
    const factory = vi.fn(() => NOTICE);
    const body: Record<string, unknown> = {
      choices: [{
        finish_reason: "tool_calls",
        message: { role: "assistant", content: "", [field]: value },
      }],
    };
    expect(appendInitNoticeToTerminalCompletion(body, factory)).toBe(false);
    expect(factory).not.toHaveBeenCalled();
  });

  it("does not append when content is non-string", () => {
    const factory = vi.fn(() => NOTICE);
    const body: Record<string, unknown> = {
      choices: [{
        finish_reason: "stop",
        message: { role: "assistant", content: null },
      }],
    };
    expect(appendInitNoticeToTerminalCompletion(body, factory)).toBe(false);
    expect(factory).not.toHaveBeenCalled();
  });
});

describe("createInitLinkSseInjector", () => {
  it("merges the notice into the terminal event before DONE", async () => {
    const delivered = vi.fn();
    const upstream = streamFrom([
      sseEvent({ content: "hello" }, null),
      sseEvent({}, "stop"),
      "data: [DONE]\n\n",
    ]);
    const output = await collect(
      upstream.pipeThrough(
        createInitLinkSseInjector(() => NOTICE, delivered),
      ),
    );
    expect(output).toContain(`"content":"${NOTICE.replace(/\n/g, "\\n")}"`);
    expect(output.indexOf("Open the init link")).toBeLessThan(
      output.indexOf("data: [DONE]"),
    );
    expect(delivered).toHaveBeenCalledTimes(1);
  });

  it("does not inject into a tool-call stream", async () => {
    const factory = vi.fn(() => NOTICE);
    const upstream = streamFrom([
      sseEvent({ tool_calls: [{ index: 0, function: { name: "clarify" } }] }, null),
      sseEvent({}, "tool_calls"),
      "data: [DONE]\n\n",
    ]);
    const output = await collect(
      upstream.pipeThrough(createInitLinkSseInjector(factory)),
    );
    expect(output).not.toContain("Open the init link");
    expect(factory).not.toHaveBeenCalled();
  });

  it("does not match data: [DONE] inside JSON content", async () => {
    const upstream = streamFrom([
      sseEvent({ content: "example: data: [DONE]" }, null),
      sseEvent({}, "stop"),
      "data: [DONE]\n\n",
    ]);
    const output = await collect(
      upstream.pipeThrough(createInitLinkSseInjector(() => NOTICE)),
    );
    expect(output).toContain("example: data: [DONE]");
    expect(output).toContain("Open the init link");
    expect(output.match(/data: \[DONE\]/g)).toHaveLength(2);
  });

  it("supports CRLF and event boundaries split across chunks", async () => {
    const event = sseEvent({}, "stop", "\r\n");
    const bytes = new TextEncoder().encode(event + "data: [DONE]\r\n\r\n");
    const output = await collect(
      streamFrom([
        bytes.slice(0, 5),
        bytes.slice(5, bytes.length - 3),
        bytes.slice(bytes.length - 3),
      ]).pipeThrough(createInitLinkSseInjector(() => NOTICE)),
    );
    expect(output).toContain("Open the init link");
    expect(output).toContain("data: [DONE]\r\n\r\n");
  });

  it("passes malformed and incomplete events through without injection", async () => {
    const factory = vi.fn(() => NOTICE);
    const input = 'data: {"choices":[invalid}\n\nincomplete';
    const output = await collect(
      streamFrom([input]).pipeThrough(createInitLinkSseInjector(factory)),
    );
    expect(output).toBe(input);
    expect(factory).not.toHaveBeenCalled();
  });

  it("preserves UTF-8 characters split across chunks", async () => {
    const input =
      sseEvent({ content: "🔧" }, null) +
      sseEvent({}, "stop") +
      "data: [DONE]\n\n";
    const bytes = new TextEncoder().encode(input);
    const emojiStart = bytes.findIndex((byte) => byte === 0xf0);
    const output = await collect(
      streamFrom([
        bytes.slice(0, emojiStart + 2),
        bytes.slice(emojiStart + 2),
      ]).pipeThrough(createInitLinkSseInjector(() => NOTICE)),
    );
    expect(output).toContain("🔧");
    expect(output).not.toContain("�");
  });
});

describe("notice text and URL", () => {
  it("uses the configured TTL in the notice", () => {
    expect(buildInitLinkNotice("http://u/1", "init", 7)).toContain(
      "7 分钟内有效",
    );
  });

  it("builds an encoded Hub URL", () => {
    expect(
      buildInitLinkUrl("http://hub:8125/", "http://proxy:8096", "tok/en+1"),
    ).toBe(
      "http://hub:8125/#/session-init?proxy=http%3A%2F%2Fproxy%3A8096&token=tok%2Fen%2B1",
    );
  });
});
