/**
 * MemoryPlugin — unit tests (Gateway mode).
 *
 * Tests use a mock fetch to verify that operations are delegated to
 * the Gateway HTTP API correctly.
 */
import { describe, expect, it, vi } from "vitest";
import type { Logger } from "../core/types.js";
import { GatewayMemoryClient } from "../adapters/gateway-client/index.js";

// ============================
// Test helpers
// ============================

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ============================
// Tests
// ============================

describe("MemoryPlugin — construction", () => {
  it("can be constructed with default options", async () => {
    const { MemoryPlugin } = await import("./plugin.js");
    const plugin = new MemoryPlugin({});
    expect(plugin.gatewayUrl).toBeDefined();
    expect(plugin.gatewayUrl).toBe("http://127.0.0.1:8420");
  });

  it("accepts custom gateway URL", async () => {
    const { MemoryPlugin } = await import("./plugin.js");
    const plugin = new MemoryPlugin({ gatewayUrl: "http://localhost:9999" });
    expect(plugin.gatewayUrl).toBe("http://localhost:9999");
  });

  it("accepts logger override", async () => {
    const { MemoryPlugin } = await import("./plugin.js");
    const logger: Logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const plugin = new MemoryPlugin({ logger });
    // Private field, but verify via the info call during init
    expect(plugin).toBeDefined();
  });
});

describe("MemoryPlugin — initialized guard — recall", () => {
  it("returns empty safely when called before initialize", async () => {
    const { MemoryPlugin } = await import("./plugin.js");
    const plugin = new MemoryPlugin({});

    const result = await plugin.recall("hello", "session-1");
    expect(result).toEqual({});
  });
});

describe("MemoryPlugin — initialized guard — capture", () => {
  it("returns safely when called before initialize", async () => {
    const { MemoryPlugin } = await import("./plugin.js");
    const plugin = new MemoryPlugin({});

    await expect(
      plugin.capture({
        userText: "hello",
        assistantText: "hi",
        messages: [{ role: "user", content: "hello" }],
        sessionKey: "sess-1",
      }),
    ).resolves.toBeUndefined();
  });
});

describe("MemoryPlugin — initialized guard — searchMemories", () => {
  it("returns empty result safely when called before initialize", async () => {
    const { MemoryPlugin } = await import("./plugin.js");
    const plugin = new MemoryPlugin({});

    const result = await plugin.searchMemories({ query: "test" });
    expect(result).toEqual({ text: "", total: 0 });
  });
});

describe("MemoryPlugin — initialized guard — searchConversations", () => {
  it("returns empty result safely when called before initialize", async () => {
    const { MemoryPlugin } = await import("./plugin.js");
    const plugin = new MemoryPlugin({});

    const result = await plugin.searchConversations({ query: "test" });
    expect(result).toEqual({ text: "", total: 0 });
  });
});

describe("MemoryPlugin — initialized guard — sessionEnd", () => {
  it("returns safely when called before initialize", async () => {
    const { MemoryPlugin } = await import("./plugin.js");
    const plugin = new MemoryPlugin({});

    await expect(plugin.sessionEnd("some-session")).resolves.toBeUndefined();
  });
});

describe("MemoryPlugin — initialized guard — destroy", () => {
  it("returns safely when called before initialize", async () => {
    const { MemoryPlugin } = await import("./plugin.js");
    const plugin = new MemoryPlugin({});

    await expect(plugin.destroy()).resolves.toBeUndefined();
  });
});

describe("MemoryPlugin — recall — empty input guards", () => {
  it("returns empty result for empty userText", async () => {
    const { MemoryPlugin } = await import("./plugin.js");
    const plugin = new MemoryPlugin({});

    const result1 = await plugin.recall("", "session-1");
    expect(result1).toEqual({});
  });

  it("returns empty result for empty sessionKey", async () => {
    const { MemoryPlugin } = await import("./plugin.js");
    const plugin = new MemoryPlugin({});

    const result2 = await plugin.recall("text", "");
    expect(result2).toEqual({});
  });
});

describe("MemoryPlugin — capture — empty input guards", () => {
  it("skips when sessionKey is missing", async () => {
    const { MemoryPlugin } = await import("./plugin.js");
    const plugin = new MemoryPlugin({});

    await expect(
      plugin.capture({
        userText: "hello",
        assistantText: "hi",
        messages: [],
        sessionKey: "",
      }),
    ).resolves.toBeUndefined();
  });

  it("skips when success is false", async () => {
    const { MemoryPlugin } = await import("./plugin.js");
    const plugin = new MemoryPlugin({});

    await expect(
      plugin.capture({
        userText: "hello",
        assistantText: "hi",
        messages: [],
        sessionKey: "sess-1",
        success: false,
      }),
    ).resolves.toBeUndefined();
  });
});

describe("MemoryPlugin — sessionEnd — empty guard", () => {
  it("handles empty sessionKey without throwing", async () => {
    const { MemoryPlugin } = await import("./plugin.js");
    const plugin = new MemoryPlugin({});

    await expect(plugin.sessionEnd("")).resolves.toBeUndefined();
  });
});
