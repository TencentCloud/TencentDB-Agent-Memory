/**
 * Regression coverage for #420: v1.0.0 OTel SDK 版本不匹配 — `new Resource()`
 * v1 API 与 `@opentelemetry/resources@^2.x` SDK 不兼容，会抛
 * `TypeError: Resource is not a constructor`，导致 OTLP 后端在生产环境静默
 * 退化为 console 输出，observability 完全失效。
 *
 * 这份测试在两种层面验证修复：
 * 1. 直接验证 v2.x `resourceFromAttributes()` factory 可以替换 v1 `new Resource()`。
 * 2. 验证 `OtlpObservabilityBackend.initialize()` 调用真实 OTel runtime 时，
 *    不会因为 Resource API 变化而抛错，并能在 OTLP endpoint 不可达时优雅降级。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("otlp-backend Resource API compatibility (#420)", () => {
  it("v2.x @opentelemetry/resources exports resourceFromAttributes (not Resource class)", async () => {
    const resourcesModule = await import("@opentelemetry/resources");
    // v2.x 移除 `Resource` 类，改为 `resourceFromAttributes()` factory。
    // 这是 v1 API (`new Resource({...})`) 抛出 `TypeError` 的根因。
    expect(typeof (resourcesModule as { Resource?: unknown }).Resource).toBe("undefined");
    expect(typeof (resourcesModule as { resourceFromAttributes?: unknown }).resourceFromAttributes).toBe(
      "function",
    );
  });

  it("resourceFromAttributes({...}) returns a Resource with the supplied attributes", async () => {
    const { resourceFromAttributes } = await import("@opentelemetry/resources");
    const { ATTR_SERVICE_NAME } = await import("@opentelemetry/semantic-conventions");

    const resource = resourceFromAttributes({
      [ATTR_SERVICE_NAME]: "tdai-memory-test",
    });

    expect(resource).toBeDefined();
    expect(resource.attributes[ATTR_SERVICE_NAME]).toBe("tdai-memory-test");
  });

  it("does not throw Resource constructor error when initializing OTLP backend", async () => {
    // 真实回归：v1.0.0 tag 上的 `otlp-backend.ts` 用 `new Resource({...})`，
    // 在 v2 SDK 下会抛 `TypeError: Resource is not a constructor`，
    // 被 try/catch 静默吞掉。修复后应当不再触发 Resource constructor 路径。
    const { OtlpObservabilityBackend } = await import("./otlp-backend.js");

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      const backend = new OtlpObservabilityBackend();

      // 用一个不存在的 endpoint，应当由网络层失败（OTLP exporter 内部超时），
      // 而不是被 `TypeError: Resource is not a constructor` 阻断。
      // 我们的 catch 会输出 console.error，所以这里 expect 调用过 console.error 即可。
      await backend.initialize({
        type: "otlp",
        otel: {
          enabled: true,
          endpoint: "http://127.0.0.1:1", // 不存在端口
          protocol: "http",
          serviceName: "tdai-memory-test",
        },
      });

      await backend.shutdown();

      // 关键断言：initialize 调用过程中没有出现 "Resource is not a constructor" 错误。
      const allCalls = [
        ...errorSpy.mock.calls.flat(),
        ...warnSpy.mock.calls.flat(),
        ...logSpy.mock.calls.flat(),
      ]
        .map((c) => String(c))
        .join("\n");

      expect(allCalls).not.toMatch(/Resource is not a constructor/);
    } finally {
      errorSpy.mockRestore();
      warnSpy.mockRestore();
      logSpy.mockRestore();
    }
  });
});

describe("OtlpObservabilityBackend lifecycle", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it("treats otel.enabled=false as no-op without throwing", async () => {
    const { OtlpObservabilityBackend } = await import("./otlp-backend.js");
    const backend = new OtlpObservabilityBackend();

    await expect(
      backend.initialize({
        type: "otlp",
        otel: { enabled: false },
      }),
    ).resolves.toBeUndefined();

    await expect(backend.shutdown()).resolves.toBeUndefined();
  });
});
