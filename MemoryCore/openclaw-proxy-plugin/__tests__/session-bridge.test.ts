import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import type { ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/core";
import register, { withOpenClawConversationId, wrapMemoryProxyStream } from "../index.js";

const SESSION_A_HEADER = "openclaw-fa57a52dbf08190218529730a3e99db6946c6c29220fb6e0551e21598b0b05db";

describe("MemoryProxy OpenClaw session bridge", () => {
  it.each(["session-a", "  session-a  "])("同一会话稳定映射到已知 SHA-256 值，忽略两端空白：%s", (sessionId) => {
    const first = withOpenClawConversationId({ sessionId });
    const second = withOpenClawConversationId({ sessionId });

    expect(first?.headers?.["x-conversation-id"]).toBe(SESSION_A_HEADER);
    expect(second?.headers?.["x-conversation-id"]).toBe(SESSION_A_HEADER);
  });

  it("maps different sessionIds to different conversation headers", () => {
    const first = withOpenClawConversationId({ sessionId: "session-a" });
    const second = withOpenClawConversationId({ sessionId: "session-b" });

    expect(first?.headers?.["x-conversation-id"]).not.toBe(
      second?.headers?.["x-conversation-id"],
    );
    expect(second?.headers?.["x-conversation-id"]).toBe("openclaw-e8de016fbd70182f6d2325e81df82550f3f46aaed8e784533131489144d4856d");
  });

  it("preserves non-conversation headers and replaces existing conversation casing", () => {
    const result = withOpenClawConversationId({
      sessionId: "session-a",
      headers: {
        Authorization: "Bearer token",
        "x-team-id": "team-1",
        "X-Conversation-ID": "static-value",
      },
    });

    expect(result?.headers).toEqual({
      Authorization: "Bearer token",
      "x-team-id": "team-1",
      "x-conversation-id": SESSION_A_HEADER,
    });
  });

  it.each([undefined, "", "   "])("缺失或空会话身份原样透传并告警：%s", (sessionId) => {
    const inner = vi.fn(() => ({ stream: true })) as any;
    const logger = { warn: vi.fn() } as any;
    const wrapped = wrapMemoryProxyStream({ streamFn: inner } as ProviderWrapStreamFnContext, logger);
    const options = { sessionId, headers: { "x-team-id": "team-1" } };

    wrapped?.({} as never, {} as never, options);

    expect(inner).toHaveBeenCalledWith({}, {}, options);
    expect(options.headers).toEqual({ "x-team-id": "team-1" });
    expect(options.headers?.["x-conversation-id"]).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("Missing native options.sessionId"));
  });

  it("injects the same conversation header on every wrapped provider request", () => {
    const inner = vi.fn(() => ({ stream: true })) as any;
    const logger = { warn: vi.fn() } as any;
    const wrapped = wrapMemoryProxyStream({ streamFn: inner } as ProviderWrapStreamFnContext, logger);

    wrapped?.({} as never, {} as never, { sessionId: "session-a" });
    wrapped?.({} as never, {} as never, { sessionId: "session-a" });

    expect(inner).toHaveBeenCalledTimes(2);
    for (const call of inner.mock.calls) {
      expect(call[2]?.headers?.["x-conversation-id"]).toBe(SESSION_A_HEADER);
    }
  });

  it.each(["session-ascii", "中文会话", "q\u0307-session", "a".repeat(128), "中".repeat(83)])("原生合法 Unicode/边界身份生成固定 ASCII header：%s", (sessionId) => {
    // v2026.8.2 限制为 NFC、最多 128 字符，且加 .jsonl 后 UTF-8 字节数不超过 255。
    expect(sessionId.normalize("NFC")).toBe(sessionId);
    expect(sessionId).toMatch(/^[\p{L}\p{N}][\p{L}\p{N}\p{M}._-]{0,127}$/u);
    expect(Buffer.byteLength(`${sessionId}.jsonl`, "utf8")).toBeLessThanOrEqual(255);
    const options = withOpenClawConversationId({ sessionId });
    const header = options!.headers!["x-conversation-id"];
    expect(header).toMatch(/^openclaw-[0-9a-f]{64}$/);
    expect(header).toHaveLength(73);
    expect(header).not.toContain(sessionId);
    expect(new Headers(options!.headers).get("x-conversation-id")).toBe(header);
    expect(withOpenClawConversationId({ sessionId })!.headers!["x-conversation-id"]).toBe(header);
  });

  it("registers only the memory-proxy provider wrapper", () => {
    const registerProvider = vi.fn();
    register({ registerProvider } as any);

    expect(registerProvider).toHaveBeenCalledTimes(1);
    expect(registerProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "memory-proxy",
        auth: [],
        wrapStreamFn: expect.any(Function),
      }),
    );
    const manifest = JSON.parse(readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"));
    expect(manifest.providers).toEqual([registerProvider.mock.calls[0][0].id]);
  });
});
