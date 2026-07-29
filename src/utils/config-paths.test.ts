import { describe, expect, it, beforeEach } from "vitest";
import { resolveConfigDir, resolveDataDir, safePathExists, resetPathCache } from "./config-paths.js";

describe("config-paths: platform-aware directory resolution", () => {
  beforeEach(() => {
    resetPathCache();
  });

  describe("resolveConfigDir", () => {
    it("returns XDG_CONFIG_HOME path on Linux when env var is set", () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, "platform", { value: "linux" });
      try {
        const originalXdg = process.env.XDG_CONFIG_HOME;
        process.env.XDG_CONFIG_HOME = "/custom/config";
        const result = resolveConfigDir("test-app");
        expect(result).toBe("/custom/config/test-app");
        if (originalXdg !== undefined) {
          process.env.XDG_CONFIG_HOME = originalXdg;
        } else {
          delete process.env.XDG_CONFIG_HOME;
        }
      } finally {
        Object.defineProperty(process, "platform", { value: originalPlatform });
      }
    });

    it("returns ~/.config path on Linux when XDG_CONFIG_HOME is not set", () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, "platform", { value: "linux" });
      try {
        delete process.env.XDG_CONFIG_HOME;
        const result = resolveConfigDir("test-app");
        expect(result).toContain(".config");
        expect(result).toContain("test-app");
      } finally {
        Object.defineProperty(process, "platform", { value: originalPlatform });
      }
    });

    it("returns Library/Application Support path on macOS", () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, "platform", { value: "darwin" });
      try {
        const result = resolveConfigDir("test-app");
        expect(result).toContain("Library");
        expect(result).toContain("Application Support");
        expect(result).toContain("test-app");
      } finally {
        Object.defineProperty(process, "platform", { value: originalPlatform });
      }
    });
  });

  describe("resolveDataDir", () => {
    it("returns XDG_DATA_HOME path on Linux when env var is set", () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, "platform", { value: "linux" });
      try {
        const originalXdg = process.env.XDG_DATA_HOME;
        process.env.XDG_DATA_HOME = "/custom/data";
        const result = resolveDataDir("test-app");
        expect(result).toBe("/custom/data/test-app");
        if (originalXdg !== undefined) {
          process.env.XDG_DATA_HOME = originalXdg;
        } else {
          delete process.env.XDG_DATA_HOME;
        }
      } finally {
        Object.defineProperty(process, "platform", { value: originalPlatform });
      }
    });
  });

  describe("safePathExists", () => {
    it("returns true for existing files", () => {
      const result = safePathExists(__filename);
      expect(result).toBe(true);
    });

    it("returns false for non-existent paths and caches the result", () => {
      const nonExistentPath = "/nonexistent/path/that/will/never/exist/config.json";
      const result1 = safePathExists(nonExistentPath);
      expect(result1).toBe(false);
      const result2 = safePathExists(nonExistentPath);
      expect(result2).toBe(false);
    });

    it("resets cache after resetPathCache is called", () => {
      const nonExistentPath = "/nonexistent/path/for/cache/test.json";
      safePathExists(nonExistentPath);
      resetPathCache();
      const result = safePathExists(nonExistentPath);
      expect(result).toBe(false);
    });
  });
});
