import { describe, it, expect } from "vitest";
import { loadClaudeCodeConfig, resolveSessionKey } from "./config";

// ─── loadClaudeCodeConfig ────────────────────────────────────────────────────

describe("loadClaudeCodeConfig", () => {
  describe("默认值（空 env）", () => {
    it("host/port/userId/baseUrl 均取默认", () => {
      const cfg = loadClaudeCodeConfig({});
      expect(cfg.gatewayHost).toBe("127.0.0.1");
      expect(cfg.gatewayPort).toBe(8420);
      expect(cfg.gatewayBaseUrl).toBe("http://127.0.0.1:8420");
      expect(cfg.userId).toBe("default_user");
      expect(cfg.apiKey).toBeUndefined();
    });
  });

  describe("host/port 覆盖", () => {
    it("TDAI_GATEWAY_HOST / TDAI_GATEWAY_PORT 生效", () => {
      const cfg = loadClaudeCodeConfig({
        TDAI_GATEWAY_HOST: "0.0.0.0",
        TDAI_GATEWAY_PORT: "9000",
      });
      expect(cfg.gatewayHost).toBe("0.0.0.0");
      expect(cfg.gatewayPort).toBe(9000);
      expect(cfg.gatewayBaseUrl).toBe("http://0.0.0.0:9000");
    });

    it("port 非数字时回退默认 8420", () => {
      const cfg = loadClaudeCodeConfig({ TDAI_GATEWAY_PORT: "abc" });
      expect(cfg.gatewayPort).toBe(8420);
    });
  });

  describe("baseUrl 覆盖", () => {
    it("TDAI_GATEWAY_BASE_URL 优先于 host:port 拼接", () => {
      const cfg = loadClaudeCodeConfig({
        TDAI_GATEWAY_HOST: "10.0.0.1",
        TDAI_GATEWAY_PORT: "9999",
        TDAI_GATEWAY_BASE_URL: "https://gateway.internal/example",
      });
      expect(cfg.gatewayBaseUrl).toBe("https://gateway.internal/example");
      // host/port 仍按各自 env 解析，不受 baseUrl 影响
      expect(cfg.gatewayHost).toBe("10.0.0.1");
      expect(cfg.gatewayPort).toBe(9999);
    });
  });

  describe("apiKey 双名回退", () => {
    it("TDAI_MCP_API_KEY 设置时优先取它", () => {
      const cfg = loadClaudeCodeConfig({
        TDAI_MCP_API_KEY: "mcp-key",
        TDAI_GATEWAY_API_KEY: "gw-key",
      });
      expect(cfg.apiKey).toBe("mcp-key");
    });

    it("仅 TDAI_GATEWAY_API_KEY 设置时回退取它", () => {
      const cfg = loadClaudeCodeConfig({ TDAI_GATEWAY_API_KEY: "gw-key" });
      expect(cfg.apiKey).toBe("gw-key");
    });

    it("两者都未设置时 apiKey 为 undefined", () => {
      const cfg = loadClaudeCodeConfig({});
      expect(cfg.apiKey).toBeUndefined();
    });

    it("apiKey 两端空白被 trim", () => {
      const cfg = loadClaudeCodeConfig({ TDAI_MCP_API_KEY: "  secret  " });
      expect(cfg.apiKey).toBe("secret");
    });

    it("apiKey 为纯空白时视为未设置（undefined）", () => {
      const cfg = loadClaudeCodeConfig({ TDAI_MCP_API_KEY: "   " });
      expect(cfg.apiKey).toBeUndefined();
    });

    it("MCP key 为空白时回退到 GATEWAY key", () => {
      const cfg = loadClaudeCodeConfig({
        TDAI_MCP_API_KEY: "   ",
        TDAI_GATEWAY_API_KEY: "gw-key",
      });
      expect(cfg.apiKey).toBe("gw-key");
    });
  });

  describe("userId", () => {
    it("TDAI_USER_ID 设置时取它", () => {
      const cfg = loadClaudeCodeConfig({ TDAI_USER_ID: "alice" });
      expect(cfg.userId).toBe("alice");
    });

    it("TDAI_USER_ID 空白时回退 default_user", () => {
      const cfg = loadClaudeCodeConfig({ TDAI_USER_ID: "  " });
      expect(cfg.userId).toBe("default_user");
    });
  });
});

// ─── resolveSessionKey ───────────────────────────────────────────────────────

describe("resolveSessionKey", () => {
  it("session_id 非空 → 直接返回（trim 后）", () => {
    expect(resolveSessionKey("  sess-abc  ")).toBe("sess-abc");
  });

  it("session_id 缺省 → 回退 cwd::date", () => {
    const key = resolveSessionKey(
      undefined,
      "d:/GK/Project/NEKO",
      new Date("2026-07-01T10:00:00Z"),
    );
    expect(key).toBe("d:/GK/Project/NEKO::2026-07-01");
  });

  it("Windows 反斜杠归一为 /", () => {
    const key = resolveSessionKey(
      undefined,
      "d:\\GK\\Project\\NEKO",
      new Date("2026-07-01T10:00:00Z"),
    );
    expect(key).toBe("d:/GK/Project/NEKO::2026-07-01");
  });

  it("cwd 尾斜杠被去掉", () => {
    const key = resolveSessionKey(
      undefined,
      "/home/user/proj/",
      new Date("2026-07-01T10:00:00Z"),
    );
    expect(key).toBe("/home/user/proj::2026-07-01");
  });

  it("session_id 为纯空白 → 触发回退", () => {
    const key = resolveSessionKey(
      "   ",
      "/home/user/proj",
      new Date("2026-07-01T10:00:00Z"),
    );
    expect(key).toBe("/home/user/proj::2026-07-01");
  });

  it("cwd 缺省时用 process.cwd()", () => {
    const key = resolveSessionKey(undefined, undefined, new Date("2026-07-01T10:00:00Z"));
    // 不断言具体值（依赖运行环境），只断言后缀格式
    expect(key).toMatch(/::2026-07-01$/);
    expect(key.length).toBeGreaterThan("2026-07-01".length + 2);
  });
});
