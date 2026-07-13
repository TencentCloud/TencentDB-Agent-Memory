/**
 * CodexAdapter — unit tests (Gateway mode).
 *
 * Covers construction, session key derivation, and core operations.
 * Actual Gateway HTTP behavior is tested in gateway-client.test.ts.
 */
import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";

describe("CodexAdapter — instantiation", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("creates adapter with default settings", async () => {
    const { CodexAdapter } = await import("./adapter.js");
    const adapter = new CodexAdapter();
    expect(adapter.platform).toBe("codex");
    expect(adapter.logger).toBeDefined();
    expect(adapter.client).toBeDefined();
  });

  it("accepts custom gateway URL and API key", async () => {
    const { CodexAdapter } = await import("./adapter.js");
    const adapter = new CodexAdapter({
      gatewayUrl: "http://localhost:9999",
      apiKey: "test-key",
    });
    expect(adapter.client).toBeDefined();
  });

  it("reads gateway URL from env var", async () => {
    vi.stubEnv("TDAI_GATEWAY_URL", "http://from-env:8420");

    const { CodexAdapter } = await import("./adapter.js");
    const adapter = new CodexAdapter();
    expect(adapter.client).toBeDefined();
  });

  it("accepts custom workspaceRoot", async () => {
    const { CodexAdapter } = await import("./adapter.js");
    const adapter = new CodexAdapter({ workspaceRoot: "/home/user/my-project" });
    expect(adapter.workspaceRoot).toBe("/home/user/my-project");
  });

  it("defaults workspaceRoot to process.cwd()", async () => {
    const { CodexAdapter } = await import("./adapter.js");
    const adapter = new CodexAdapter();
    expect(adapter.workspaceRoot).toBe(process.cwd());
  });
});

describe("CodexAdapter — session key", () => {
  it("derives session key from workspaceRoot and sessionId", async () => {
    const { CodexAdapter } = await import("./adapter.js");
    const adapter = new CodexAdapter({ workspaceRoot: "/home/user/cool-project" });

    const key = adapter.resolveSessionKey("conv-123");
    expect(key).toContain("cool-project");
    expect(key).toContain("conv-123");
    expect(key).toMatch(/^codex:/);
  });

  it("derives default session key without sessionId", async () => {
    const { CodexAdapter } = await import("./adapter.js");
    const adapter = new CodexAdapter({ workspaceRoot: "/home/user/my-project" });

    const key = adapter.resolveSessionKey();
    expect(key).toContain("my-project");
    expect(key).toMatch(/default$/);
  });

  it("handles workspaceRoot with trailing slash", async () => {
    const { CodexAdapter } = await import("./adapter.js");
    const adapter = new CodexAdapter({ workspaceRoot: "/home/user/my-project/" });

    const key = adapter.resolveSessionKey("test");
    expect(key).toContain("my-project");
    expect(key).toContain("test");
  });

  it("handles Windows-style paths", async () => {
    const { CodexAdapter } = await import("./adapter.js");
    const adapter = new CodexAdapter({ workspaceRoot: "C:\\Users\\dev\\my-project" });

    const key = adapter.resolveSessionKey("conv-1");
    expect(key).toContain("my-project");
  });
});

describe("CodexAdapter — recall", () => {
  it("returns empty for empty input", async () => {
    const { CodexAdapter } = await import("./adapter.js");
    const adapter = new CodexAdapter();

    const result = await adapter.recall("", "");
    expect(result).toEqual({});
  });
});

describe("CodexAdapter — capture", () => {
  it("skips when sessionKey is empty", async () => {
    const { CodexAdapter } = await import("./adapter.js");
    const adapter = new CodexAdapter();

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
    const { CodexAdapter } = await import("./adapter.js");
    const adapter = new CodexAdapter();

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

describe("CodexAdapter — sessionEnd", () => {
  it("handles empty sessionKey without throwing", async () => {
    const { CodexAdapter } = await import("./adapter.js");
    const adapter = new CodexAdapter();

    await expect(adapter.sessionEnd("")).resolves.toBeUndefined();
  });
});
