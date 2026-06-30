/**
 * Unit tests for ToolRegistry
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { DefaultToolRegistry } from "../tool-registry.js";

describe("DefaultToolRegistry", () => {
  let registry: DefaultToolRegistry;

  const mockTool = {
    name: "test_tool",
    label: "Test Tool",
    description: "A test tool",
    parameters: {
      type: "object" as const,
      properties: {
        query: { type: "string" as const, description: "Search query" },
      },
      required: ["query"],
    },
  };

  beforeEach(() => {
    registry = new DefaultToolRegistry({ platformId: "test" });
  });

  describe("register", () => {
    it("should register a tool", () => {
      registry.register(mockTool.name, mockTool);

      expect(registry.isRegistered("test_tool")).toBe(true);
    });

    it("should allow overwriting existing tool", () => {
      registry.register(mockTool.name, mockTool);
      registry.register(mockTool.name, { ...mockTool, description: "Updated" });

      expect(registry.isRegistered("test_tool")).toBe(true);
      expect(registry.get("test_tool")?.description).toBe("Updated");
    });
  });

  describe("registerExecutor", () => {
    it("should register an executor for a tool", async () => {
      const executor = vi.fn().mockResolvedValue("result");

      registry.register(mockTool.name, mockTool);
      registry.registerExecutor(mockTool.name, executor);

      const result = await registry.execute("call-1", mockTool.name, { query: "test" });

      expect(executor).toHaveBeenCalledWith({ query: "test" });
      expect(result).toBe("result");
    });

    it("should allow registering executor for unregistered tool", () => {
      const executor = vi.fn();
      // Should not throw, just warn
      expect(() => registry.registerExecutor("unregistered_tool", executor)).not.toThrow();
    });
  });

  describe("unregister", () => {
    it("should unregister a tool", () => {
      registry.register(mockTool.name, mockTool);
      const executor = vi.fn();
      registry.registerExecutor(mockTool.name, executor);

      const result = registry.unregister(mockTool.name);

      expect(result).toBe(true);
      expect(registry.isRegistered("test_tool")).toBe(false);
    });

    it("should return false for non-existent tool", () => {
      const result = registry.unregister("non_existent");
      expect(result).toBe(false);
    });
  });

  describe("get", () => {
    it("should return tool definition", () => {
      registry.register(mockTool.name, mockTool);

      const tool = registry.get("test_tool");

      expect(tool).toBeDefined();
      expect(tool?.name).toBe("test_tool");
      expect(tool?.label).toBe("Test Tool");
    });

    it("should return undefined for non-existent tool", () => {
      const tool = registry.get("non_existent");
      expect(tool).toBeUndefined();
    });
  });

  describe("getAll/getEnabled", () => {
    it("should return all registered tools", () => {
      registry.register("tool1", mockTool);
      registry.register("tool2", { ...mockTool, name: "tool2" });

      const tools = registry.getAll();
      expect(tools.length).toBe(2);
    });

    it("should return only enabled tools", () => {
      registry.register("tool1", mockTool);
      registry.register("tool2", { ...mockTool, name: "tool2" });
      registry.disable("tool1");

      const enabled = registry.getEnabled();
      expect(enabled.length).toBe(1);
      expect(enabled[0].name).toBe("tool2");
    });
  });

  describe("enable/disable", () => {
    it("should enable a tool", () => {
      registry.register(mockTool.name, { ...mockTool, enabled: false });

      expect(registry.isEnabled("test_tool")).toBe(false);

      registry.enable("test_tool");

      expect(registry.isEnabled("test_tool")).toBe(true);
    });

    it("should disable a tool", () => {
      registry.register(mockTool.name, mockTool);

      registry.disable("test_tool");

      expect(registry.isEnabled("test_tool")).toBe(false);
    });
  });

  describe("execute", () => {
    it("should execute a tool successfully", async () => {
      const executor = vi.fn().mockResolvedValue({ result: "success" });

      registry.register(mockTool.name, mockTool);
      registry.registerExecutor(mockTool.name, executor);

      const result = await registry.execute("call-1", mockTool.name, { query: "test" });

      expect(result).toEqual({ result: "success" });
    });

    it("should throw when tool not found", async () => {
      await expect(registry.execute("call-1", "non_existent", {}))
        .rejects.toThrow("Tool not found: non_existent");
    });

    it("should throw when tool disabled", async () => {
      registry.register(mockTool.name, { ...mockTool, enabled: false });
      registry.registerExecutor(mockTool.name, vi.fn());

      await expect(registry.execute("call-1", mockTool.name, {}))
        .rejects.toThrow("Tool disabled: test_tool");
    });

    it("should throw when no executor registered", async () => {
      registry.register(mockTool.name, mockTool);

      await expect(registry.execute("call-1", mockTool.name, {}))
        .rejects.toThrow("No executor registered");
    });

    it("should call interceptors", async () => {
      const beforeInterceptor = vi.fn();
      const afterInterceptor = vi.fn();
      const executor = vi.fn().mockResolvedValue("result");

      registry.register(mockTool.name, mockTool);
      registry.registerExecutor(mockTool.name, executor);
      registry.addInterceptor({
        beforeExecute: beforeInterceptor,
        afterExecute: afterInterceptor,
      });

      await registry.execute("call-1", mockTool.name, { query: "test" });

      expect(beforeInterceptor).toHaveBeenCalled();
      expect(afterInterceptor).toHaveBeenCalled();
    });
  });

  describe("interceptors", () => {
    it("should call error interceptor on failure", async () => {
      const errorInterceptor = vi.fn();
      const executor = vi.fn().mockRejectedValue(new Error("Test error"));

      registry.register(mockTool.name, mockTool);
      registry.registerExecutor(mockTool.name, executor);
      registry.addInterceptor({
        onError: errorInterceptor,
      });

      await expect(registry.execute("call-1", mockTool.name, {}))
        .rejects.toThrow("Test error");

      expect(errorInterceptor).toHaveBeenCalled();
    });
  });

  describe("history and metrics", () => {
    it("should record call history", async () => {
      registry.register(mockTool.name, mockTool);
      registry.registerExecutor(mockTool.name, vi.fn().mockResolvedValue("result"));

      await registry.execute("call-1", mockTool.name, { query: "test" });

      const history = registry.getHistory();
      expect(history.length).toBe(1);
      expect(history[0].callId).toBe("call-1");
      expect(history[0].toolName).toBe("test_tool");
    });

    it("should return correct metrics", async () => {
      registry.register(mockTool.name, mockTool);
      registry.registerExecutor(mockTool.name, vi.fn().mockResolvedValue("result"));

      await registry.execute("call-1", mockTool.name, { query: "test" });

      const metrics = registry.getMetrics();
      expect(metrics.totalCalls).toBe(1);
      expect(metrics.successCount).toBe(1);
      expect(metrics.errorCount).toBe(0);
    });

    it("should clear history", async () => {
      registry.register(mockTool.name, mockTool);
      registry.registerExecutor(mockTool.name, vi.fn().mockResolvedValue("result"));

      await registry.execute("call-1", mockTool.name, {});

      registry.clearHistory();

      expect(registry.getHistory().length).toBe(0);
    });
  });

  describe("generateCallId", () => {
    it("should generate unique call IDs", () => {
      const id1 = registry.generateCallId();
      const id2 = registry.generateCallId();

      expect(id1).not.toBe(id2);
      expect(id1).toContain("test");
    });
  });
});
