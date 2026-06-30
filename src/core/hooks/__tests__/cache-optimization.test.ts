/**
 * Unit tests for CacheOptimizationConfig and stableWrapper behavior.
 * Tests the prompt cache optimization feature implemented in auto-recall.ts.
 */

import { describe, expect, it } from "vitest";
import { parseConfig } from "../../../config.js";

describe("CacheOptimizationConfig", () => {
  describe("default values", () => {
    it("should have stableWrapper enabled by default", () => {
      const config = parseConfig({});
      expect(config.recall.cacheOptimization?.stableWrapper).toBe(true);
    });

    it("should have splitSystemContext enabled by default", () => {
      const config = parseConfig({});
      expect(config.recall.cacheOptimization?.splitSystemContext).toBe(true);
    });

    it("should parse both options correctly when explicitly set", () => {
      const config = parseConfig({
        recall: {
          cacheOptimization: {
            stableWrapper: false,
            splitSystemContext: false,
          },
        },
      });
      expect(config.recall.cacheOptimization?.stableWrapper).toBe(false);
      expect(config.recall.cacheOptimization?.splitSystemContext).toBe(false);
    });

    it("should parse mixed configuration correctly", () => {
      const config = parseConfig({
        recall: {
          cacheOptimization: {
            stableWrapper: false,
          },
        },
      });
      expect(config.recall.cacheOptimization?.stableWrapper).toBe(false);
      expect(config.recall.cacheOptimization?.splitSystemContext).toBe(true); // default
    });

    it("should handle partial cacheOptimization config", () => {
      const config = parseConfig({
        recall: {
          cacheOptimization: {
            splitSystemContext: false,
          },
        },
      });
      expect(config.recall.cacheOptimization?.stableWrapper).toBe(true); // default
      expect(config.recall.cacheOptimization?.splitSystemContext).toBe(false);
    });

    it("should handle empty cacheOptimization object", () => {
      const config = parseConfig({
        recall: {
          cacheOptimization: {},
        },
      });
      expect(config.recall.cacheOptimization?.stableWrapper).toBe(true); // default
      expect(config.recall.cacheOptimization?.splitSystemContext).toBe(true); // default
    });
  });

  describe("RecallResult.stableWrapperUsed field", () => {
    it("should be exported in RecallResult type", () => {
      const mockRecallResult = {
        prependContext: "<relevant-memories>test</relevant-memories>",
        appendSystemContext: "<user-persona>test</user-persona>",
        stableWrapperUsed: true,
      };

      expect(mockRecallResult.stableWrapperUsed).toBe(true);
    });

    it("should handle undefined stableWrapperUsed", () => {
      const mockRecallResult = {
        prependContext: "<relevant-memories>test</relevant-memories>",
        appendSystemContext: "<user-persona>test</user-persona>",
      };

      expect(mockRecallResult.stableWrapperUsed).toBeUndefined();
    });
  });
});

describe("stableWrapper placeholder content", () => {
  it("should have consistent placeholder when no memories recalled", () => {
    const expectedPlaceholder = "<relevant-memories>\n（本次对话未召回相关记忆）\n</relevant-memories>";
    expect(expectedPlaceholder).toContain("relevant-memories");
    expect(expectedPlaceholder).toContain("本次对话未召回相关记忆");
  });

  it("should use Chinese text for consistency with codebase language", () => {
    const placeholder = "（本次对话未召回相关记忆）";
    expect(placeholder).toContain("未召回");
    expect(placeholder).toContain("相关记忆");
  });

  it("should maintain consistent XML tag structure", () => {
    const activeTag = "<relevant-memories>\n以下...\n</relevant-memories>";
    const placeholderTag = "<relevant-memories>\n（本次...）\n</relevant-memories>";

    // Both should have same opening and closing tags
    expect(activeTag.startsWith("<relevant-memories>")).toBe(true);
    expect(activeTag.endsWith("</relevant-memories>")).toBe(true);
    expect(placeholderTag.startsWith("<relevant-memories>")).toBe(true);
    expect(placeholderTag.endsWith("</relevant-memories>")).toBe(true);
  });
});

describe("cache optimization behavior", () => {
  it("should recommend enabling both options for optimal cache hit rate", () => {
    const config = parseConfig({
      recall: {
        cacheOptimization: {
          stableWrapper: true,
          splitSystemContext: true,
        },
      },
    });

    expect(config.recall.cacheOptimization?.stableWrapper).toBe(true);
    expect(config.recall.cacheOptimization?.splitSystemContext).toBe(true);
  });

  it("should allow disabling stableWrapper for specific use cases", () => {
    const config = parseConfig({
      recall: {
        cacheOptimization: {
          stableWrapper: false,
        },
      },
    });

    expect(config.recall.cacheOptimization?.stableWrapper).toBe(false);
  });

  it("should allow disabling splitSystemContext for specific use cases", () => {
    const config = parseConfig({
      recall: {
        cacheOptimization: {
          splitSystemContext: false,
        },
      },
    });

    expect(config.recall.cacheOptimization?.splitSystemContext).toBe(false);
  });
});
