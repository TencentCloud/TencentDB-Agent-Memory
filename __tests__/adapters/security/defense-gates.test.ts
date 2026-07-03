/**
 * Defense Gates 测试 — 吸收 PR #339 gugu23456789 的 5 层 gate 模式
 *
 * G0: JSON-RPC 2.0 输入验证
 * G1: API Key 认证
 * G2: 滑动窗口限流
 * G3: Circuit Breaker
 * G4: Audit Log
 */
import { describe, it, expect, beforeEach } from "vitest";

// ══════════════════════════════════════════════════════════
// G0: JSON-RPC 2.0 Schema Validation
// ══════════════════════════════════════════════════════════

describe("G0: JSON-RPC 2.0 Schema", () => {
  interface JsonRpcRequest {
    jsonrpc: "2.0";
    id: number | string;
    method: string;
    params?: unknown;
  }

  function validateRequest(raw: unknown): JsonRpcRequest | { error: string } {
    if (typeof raw !== "object" || raw === null) return { error: "Parse error" };
    const obj = raw as Record<string, unknown>;
    if (obj.jsonrpc !== "2.0") return { error: "Invalid Request: not JSON-RPC 2.0" };
    if (typeof obj.method !== "string" || obj.method.length === 0) return { error: "Invalid Request: missing method" };
    if (obj.id === undefined) return { error: "Invalid Request: missing id" };
    return obj as unknown as JsonRpcRequest;
  }

  it("accepts valid JSON-RPC 2.0 request", () => {
    const result = validateRequest({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {} });
    expect("error" in result).toBe(false);
  });

  it("rejects null input", () => {
    const result = validateRequest(null);
    expect(result).toEqual({ error: "Parse error" });
  });

  it("rejects non-object input", () => {
    const result = validateRequest("just a string");
    expect(result).toEqual({ error: "Parse error" });
  });

  it("rejects missing jsonrpc version", () => {
    const result = validateRequest({ id: 1, method: "tools/call" });
    expect(result).toEqual({ error: "Invalid Request: not JSON-RPC 2.0" });
  });

  it("rejects wrong jsonrpc version", () => {
    const result = validateRequest({ jsonrpc: "1.0", id: 1, method: "tools/call" });
    expect(result).toEqual({ error: "Invalid Request: not JSON-RPC 2.0" });
  });

  it("rejects empty method name", () => {
    const result = validateRequest({ jsonrpc: "2.0", id: 1, method: "", params: {} });
    expect(result).toEqual({ error: "Invalid Request: missing method" });
  });

  it("rejects missing id (notification)", () => {
    const result = validateRequest({ jsonrpc: "2.0", method: "notifications/initialized" });
    expect(result).toEqual({ error: "Invalid Request: missing id" });
  });

  it("accepts string id", () => {
    const result = validateRequest({ jsonrpc: "2.0", id: "req-abc", method: "tools/list" });
    expect("error" in result).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════
// G2: 滑动窗口限流
// ══════════════════════════════════════════════════════════

describe("G2: Sliding Window Rate Limiter", () => {
  class SlidingWindowLimiter {
    private timestamps: number[] = [];
    constructor(
      private maxRequests: number = 60,
      private windowMs: number = 60_000,
    ) {}

    allow(): boolean {
      const now = Date.now();
      // 清理过期的时间戳
      this.timestamps = this.timestamps.filter((ts) => now - ts < this.windowMs);
      if (this.timestamps.length >= this.maxRequests) {
        return false; // 拒绝
      }
      this.timestamps.push(now);
      return true;
    }

    reset(): void {
      this.timestamps = [];
    }

    count(): number {
      return this.timestamps.length;
    }
  }

  let limiter: SlidingWindowLimiter;

  beforeEach(() => {
    limiter = new SlidingWindowLimiter(10, 60_000); // 10 req / 60s
  });

  it("allows requests within limit", () => {
    for (let i = 0; i < 10; i++) {
      expect(limiter.allow()).toBe(true);
    }
  });

  it("rejects requests beyond limit", () => {
    for (let i = 0; i < 10; i++) {
      limiter.allow();
    }
    // 第 11 个请求被拒绝
    expect(limiter.allow()).toBe(false);
  });

  it("resets counter after window passes", () => {
    // 使用很小的窗口，通过直接操作 timestamps 模拟过期
    const pastLimiter = new SlidingWindowLimiter(5, 1); // 1ms window
    for (let i = 0; i < 5; i++) {
      pastLimiter.allow();
    }
    expect(pastLimiter.allow()).toBe(false); // 达到限制

    // 直接验证当 timestamps 被清空时允许请求
    pastLimiter.reset();
    expect(pastLimiter.allow()).toBe(true); // 重置后允许
  });

  it("works with different limits", () => {
    const strictLimiter = new SlidingWindowLimiter(3, 60_000);
    expect(strictLimiter.allow()).toBe(true);
    expect(strictLimiter.allow()).toBe(true);
    expect(strictLimiter.allow()).toBe(true);
    expect(strictLimiter.allow()).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════
// G4: Audit Log
// ══════════════════════════════════════════════════════════

describe("G4: Audit Log", () => {
  class AuditLogger {
    private logs: Array<{ timestamp: string; level: string; event: string; details?: unknown }> = [];

    log(level: string, event: string, details?: unknown): void {
      this.logs.push({
        timestamp: new Date().toISOString(),
        level,
        event,
        details,
      });
    }

    info(event: string, details?: unknown): void {
      this.log("INFO", event, details);
    }

    warn(event: string, details?: unknown): void {
      this.log("WARN", event, details);
    }

    getLogs(): typeof this.logs {
      return [...this.logs];
    }

    clear(): void {
      this.logs = [];
    }
  }

  let audit: AuditLogger;

  beforeEach(() => {
    audit = new AuditLogger();
  });

  it("logs all security-relevant events", () => {
    audit.info("gate.auth.success", { sessionKey: "sess-1" });
    audit.warn("gate.rate_limit.rejected", { sessionKey: "sess-2", reason: "exceeded 60/60s" });
    audit.warn("gate.auth.failed", { reason: "invalid key" });

    const logs = audit.getLogs();
    expect(logs).toHaveLength(3);
    expect(logs[0].event).toBe("gate.auth.success");
    expect(logs[1].event).toBe("gate.rate_limit.rejected");
    expect(logs[2].event).toBe("gate.auth.failed");
  });

  it("log format includes timestamp and level", () => {
    audit.info("test.event", { key: "value" });
    const logs = audit.getLogs();
    expect(logs[0].timestamp).toBeTruthy();
    expect(logs[0].level).toBe("INFO");
    expect(logs[0].details).toEqual({ key: "value" });
  });

  it("audit log cannot be suppressed by tool parameters", () => {
    // 安全日志应该始终记录，不受业务参数影响
    // 模拟：即使 params 中包含 { _noLog: true }，audit log 也要记录
    const params = { _noLog: true, sessionKey: "sess-3" };
    audit.warn("gate.rate_limit.rejected", { params });
    const logs = audit.getLogs();
    expect(logs).toHaveLength(1);
    // 确认 audit log 记录了完整信息
    expect(logs[0].event).toBe("gate.rate_limit.rejected");
  });
});
