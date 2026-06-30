/**
 * Unit tests for LifecycleManager
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { DefaultLifecycleManager, LifecycleState } from "../lifecycle-manager.js";

describe("DefaultLifecycleManager", () => {
  let lifecycle: DefaultLifecycleManager;

  beforeEach(() => {
    lifecycle = new DefaultLifecycleManager({ platformId: "test-adapter" });
  });

  describe("getState/setState", () => {
    it("should start in NOT_INSTALLED state", () => {
      expect(lifecycle.getState()).toBe(LifecycleState.NOT_INSTALLED);
    });

    it("should track previous state", async () => {
      await lifecycle.install();
      expect(lifecycle.getPreviousState()).toBe(LifecycleState.INSTALLING);
    });
  });

  describe("version", () => {
    it("should get and set version", () => {
      lifecycle.setVersion("1.0.0");
      expect(lifecycle.getVersion()).toBe("1.0.0");
    });
  });

  describe("isInState", () => {
    it("should check current state", () => {
      expect(lifecycle.isInState(LifecycleState.NOT_INSTALLED)).toBe(true);
      expect(lifecycle.isInState(LifecycleState.RUNNING)).toBe(false);
    });
  });

  describe("canTransitionTo", () => {
    it("should allow valid transitions", () => {
      expect(lifecycle.canTransitionTo(LifecycleState.INSTALLING)).toBe(true);
    });

    it("should reject invalid transitions", () => {
      expect(lifecycle.canTransitionTo(LifecycleState.RUNNING)).toBe(false);
    });
  });

  describe("install", () => {
    it("should transition through states", async () => {
      const result = await lifecycle.install();

      expect(result).toBe(true);
      expect(lifecycle.getState()).toBe(LifecycleState.INSTALLED);
    });

    it("should call hooks", async () => {
      const beforeHook = vi.fn();
      const afterHook = vi.fn();

      lifecycle.setHooks({
        onBeforeInstall: beforeHook,
        onAfterInstall: afterHook,
      });

      await lifecycle.install();

      expect(beforeHook).toHaveBeenCalled();
      expect(afterHook).toHaveBeenCalledWith(true);
    });

    it("should handle errors", async () => {
      lifecycle.setHooks({
        onBeforeInstall: () => {
          throw new Error("Install failed");
        },
      });

      const result = await lifecycle.install();

      expect(result).toBe(false);
      expect(lifecycle.getState()).toBe(LifecycleState.ERROR);
    });
  });

  describe("start/stop", () => {
    it("should start from INSTALLED state", async () => {
      await lifecycle.install();
      const result = await lifecycle.start();

      expect(result).toBe(true);
      expect(lifecycle.getState()).toBe(LifecycleState.RUNNING);
    });

    it("should stop from RUNNING state", async () => {
      await lifecycle.install();
      await lifecycle.start();
      const result = await lifecycle.stop();

      expect(result).toBe(true);
      expect(lifecycle.getState()).toBe(LifecycleState.STOPPED);
    });

    it("should not start from wrong state", async () => {
      const result = await lifecycle.start();

      expect(result).toBe(false);
    });
  });

  describe("uninstall", () => {
    it("should uninstall from STOPPED state", async () => {
      await lifecycle.install();
      await lifecycle.start();
      await lifecycle.stop();
      const result = await lifecycle.uninstall();

      expect(result).toBe(true);
      expect(lifecycle.getState()).toBe(LifecycleState.UNINSTALLED);
    });

    it("should call hooks", async () => {
      await lifecycle.install();
      await lifecycle.start();
      await lifecycle.stop();

      const beforeHook = vi.fn();
      const afterHook = vi.fn();

      lifecycle.setHooks({
        onBeforeUninstall: beforeHook,
        onAfterUninstall: afterHook,
      });

      await lifecycle.uninstall();

      expect(beforeHook).toHaveBeenCalled();
      expect(afterHook).toHaveBeenCalledWith(true);
    });
  });

  describe("upgrade", () => {
    it("should upgrade version", async () => {
      lifecycle.setVersion("1.0.0");
      await lifecycle.install();
      await lifecycle.start();

      const result = await lifecycle.upgrade("1.0.0", "2.0.0");

      expect(result).toBe(true);
      expect(lifecycle.getVersion()).toBe("2.0.0");
    });

    it("should call hooks", async () => {
      lifecycle.setVersion("1.0.0");
      await lifecycle.install();
      await lifecycle.start();

      const beforeHook = vi.fn();
      const afterHook = vi.fn();

      lifecycle.setHooks({
        onBeforeUpgrade: beforeHook,
        onAfterUpgrade: afterHook,
      });

      await lifecycle.upgrade("1.0.0", "2.0.0");

      expect(beforeHook).toHaveBeenCalledWith("1.0.0", "2.0.0");
      expect(afterHook).toHaveBeenCalledWith("1.0.0", "2.0.0", true);
    });
  });

  describe("health checks", () => {
    it("should register and run health checks", async () => {
      const check = vi.fn().mockResolvedValue({
        healthy: true,
        name: "test_check",
        durationMs: 10,
      });

      lifecycle.registerHealthCheck({ name: "test_check", check });

      const results = await lifecycle.runHealthChecks();

      expect(results).toHaveLength(2); // Default + custom
      expect(check).toHaveBeenCalled();
    });

    it("should handle check failures", async () => {
      lifecycle.registerHealthCheck({
        name: "failing_check",
        check: async () => {
          throw new Error("Check failed");
        },
      });

      const results = await lifecycle.runHealthChecks();
      const failingCheck = results.find(r => r.name === "failing_check");

      expect(failingCheck?.healthy).toBe(false);
      expect(failingCheck?.error).toContain("Check failed");
    });

    it("should track last health check", async () => {
      lifecycle.registerHealthCheck({
        name: "test_check",
        check: async () => ({ healthy: true, name: "test_check", durationMs: 0 }),
      });

      await lifecycle.runHealthChecks();

      const lastCheck = lifecycle.getLastHealthCheck();
      expect(lastCheck.length).toBeGreaterThan(0);
    });

    it("should report overall health", async () => {
      lifecycle.registerHealthCheck({
        name: "critical_check",
        critical: true,
        check: async () => ({ healthy: false, name: "critical_check", durationMs: 0 }),
      });

      await lifecycle.runHealthChecks();

      expect(lifecycle.isHealthy()).toBe(false);
    });

    it("should unregister health checks", () => {
      lifecycle.registerHealthCheck({ name: "temp_check", check: async () => ({ healthy: true, name: "temp_check", durationMs: 0 }) });

      const result = lifecycle.unregisterHealthCheck("temp_check");

      expect(result).toBe(true);
    });
  });

  describe("state change hooks", () => {
    it("should call onStateChange hook", async () => {
      const stateChangeHook = vi.fn();
      lifecycle.setHooks({ onStateChange: stateChangeHook });

      await lifecycle.install();

      expect(stateChangeHook).toHaveBeenCalledWith(
        LifecycleState.INSTALLING,
        LifecycleState.INSTALLED
      );
    });

    it("should call onError hook on errors", async () => {
      const errorHook = vi.fn();
      lifecycle.setHooks({
        onBeforeInstall: () => { throw new Error("Test error"); },
        onError: errorHook,
      });

      await lifecycle.install();

      expect(errorHook).toHaveBeenCalled();
    });
  });

  describe("dispose", () => {
    it("should clean up resources", () => {
      lifecycle.registerHealthCheck({ name: "check", check: async () => ({ healthy: true, name: "check", durationMs: 0 }) });

      lifecycle.dispose();

      // After dispose, no health checks should remain
      expect(lifecycle.getLastHealthCheck().length).toBe(0);
    });
  });
});
