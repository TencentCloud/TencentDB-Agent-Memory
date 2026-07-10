/**
 * ClaudeCodeAdapter — unit tests (Gateway mode).
 *
 * Covers construction, core operations, and the static settings.json generator.
 * Actual Gateway HTTP behavior is tested in gateway-client.test.ts.
 */
import { describe, expect, it, vi, afterEach } from "vitest";

// ============================
// ClaudeCodeAdapter tests
// ============================

describe("ClaudeCodeAdapter — instantiation", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("creates adapter with default settings", async () => {
    const { ClaudeCodeAdapter } = await import("./adapter.js");
    const adapter = new ClaudeCodeAdapter();
    expect(adapter.platform).toBe("claude-code");
    expect(adapter.logger).toBeDefined();
    expect(adapter.client).toBeDefined();
  });

  it("accepts custom gateway URL and API key", async () => {
    const { ClaudeCodeAdapter } = await import("./adapter.js");
    const adapter = new ClaudeCodeAdapter({
      gatewayUrl: "http://localhost:9999",
      apiKey: "test-key",
    });
    expect(adapter.client).toBeDefined();
  });

  it("reads gateway URL from env var", async () => {
    vi.stubEnv("TDAI_GATEWAY_URL", "http://from-env:8420");

    const { ClaudeCodeAdapter } = await import("./adapter.js");
    const adapter = new ClaudeCodeAdapter();
    expect(adapter.client).toBeDefined();
  });
});

describe("ClaudeCodeAdapter — recall", () => {
  it("returns empty for empty input", async () => {
    const { ClaudeCodeAdapter } = await import("./adapter.js");
    const adapter = new ClaudeCodeAdapter();

    const result = await adapter.recall("", "");
    expect(result).toEqual({});
  });
});

describe("ClaudeCodeAdapter — capture", () => {
  it("skips when sessionKey is empty", async () => {
    const { ClaudeCodeAdapter } = await import("./adapter.js");
    const adapter = new ClaudeCodeAdapter();

    await expect(
      adapter.capture({
        userText: "hello",
        assistantText: "hi",
        messages: [],
        sessionKey: "",
      }),
    ).resolves.toBeUndefined();
  });

  it("skips when success is false", async () => {
    const { ClaudeCodeAdapter } = await import("./adapter.js");
    const adapter = new ClaudeCodeAdapter();

    await expect(
      adapter.capture({
        userText: "hello",
        assistantText: "hi",
        messages: [],
        sessionKey: "sess-1",
        success: false,
      }),
    ).resolves.toBeUndefined();
  });
});

describe("ClaudeCodeAdapter — searchMemories", () => {
  it("handles errors gracefully", async () => {
    const { ClaudeCodeAdapter } = await import("./adapter.js");
    const adapter = new ClaudeCodeAdapter();

    // Without a running Gateway, this should return empty gracefully
    const result = await adapter.searchMemories({ query: "test" });
    expect(result).toEqual({ text: "", total: 0 });
  });
});

describe("ClaudeCodeAdapter — searchConversations", () => {
  it("handles errors gracefully", async () => {
    const { ClaudeCodeAdapter } = await import("./adapter.js");
    const adapter = new ClaudeCodeAdapter();

    const result = await adapter.searchConversations({ query: "test" });
    expect(result).toEqual({ text: "", total: 0 });
  });
});

describe("ClaudeCodeAdapter — sessionEnd", () => {
  it("handles empty sessionKey without throwing", async () => {
    const { ClaudeCodeAdapter } = await import("./adapter.js");
    const adapter = new ClaudeCodeAdapter();

    await expect(adapter.sessionEnd("")).resolves.toBeUndefined();
  });
});

describe("ClaudeCodeAdapter — generateSettingsJson", () => {
  it("generates settings with hooks and MCP server by default", async () => {
    const { ClaudeCodeAdapter } = await import("./adapter.js");
    const settings = ClaudeCodeAdapter.generateSettingsJson();

    expect(settings).toHaveProperty("hooks");
    expect(settings).toHaveProperty("mcpServers");

    const hooks = settings.hooks as Record<string, unknown>;
    expect(hooks).toHaveProperty("preMessage");
    expect(hooks).toHaveProperty("postMessage");

    const mcpServers = settings.mcpServers as Record<string, unknown>;
    expect(mcpServers).toHaveProperty("memory-tdai");
  });

  it("generates settings without MCP when disabled", async () => {
    const { ClaudeCodeAdapter } = await import("./adapter.js");
    const settings = ClaudeCodeAdapter.generateSettingsJson({ enableMcp: false });

    expect(settings).toHaveProperty("hooks");
    expect(settings).not.toHaveProperty("mcpServers");
  });

  it("uses correct hook command format with npx", async () => {
    const { ClaudeCodeAdapter } = await import("./adapter.js");
    const settings = ClaudeCodeAdapter.generateSettingsJson({ runner: "npx" });

    const hooks = settings.hooks as Record<string, unknown>;
    const preMessage = (hooks.preMessage as Array<Record<string, unknown>>);
    expect(preMessage[0].run).toContain("npx");
    expect(preMessage[0].run).toContain("claude-code-recall");
  });

  it("uses custom runner when specified", async () => {
    const { ClaudeCodeAdapter } = await import("./adapter.js");
    const settings = ClaudeCodeAdapter.generateSettingsJson({ runner: "pnpm" });

    const hooks = settings.hooks as Record<string, unknown>;
    const preMessage = (hooks.preMessage as Array<Record<string, unknown>>);
    expect(preMessage[0].run).toContain("pnpm");
  });
});
