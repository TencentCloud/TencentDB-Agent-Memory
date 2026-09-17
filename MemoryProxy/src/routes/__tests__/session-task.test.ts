/**
 * Unit tests for resolveTaskDraftConfig env override behavior.
 *
 * Verifies the precedence: env override > client request > error
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolveTaskDraftConfig, type TaskDraftUpstream } from "../session-task.js";

describe("resolveTaskDraftConfig", () => {
  // Store original env values to restore after each test
  const originalEnv: Record<string, string | undefined> = {};
  const envKeys = [
    "MEMORY_LLM_PROTOCOL",
    "MEMORY_LLM_API_KEY",
    "MEMORY_LLM_BASE_URL",
    "MEMORY_LLM_MODEL",
  ];

  beforeEach(() => {
    // Save original values
    for (const key of envKeys) {
      originalEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    // Restore original values
    for (const key of envKeys) {
      if (originalEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = originalEnv[key];
      }
    }
  });

  describe("all envs set → cfg reflects the override", () => {
    it("should use env values over client-passed values", () => {
      // Set env overrides
      process.env.MEMORY_LLM_PROTOCOL = "openai";
      process.env.MEMORY_LLM_API_KEY = "env-api-key";
      process.env.MEMORY_LLM_BASE_URL = "https://env-url.com/v1";
      process.env.MEMORY_LLM_MODEL = "env-model";

      // Client passes different values
      const upstream: TaskDraftUpstream = {
        protocol: "anthropic",
        apiKey: "client-api-key",
        upstreamUrl: "https://client-url.com/v1",
        model: "client-model",
      };

      const result = resolveTaskDraftConfig(upstream);

      expect("cfg" in result).toBe(true);
      if ("cfg" in result) {
        expect(result.cfg.protocol).toBe("openai"); // env wins
        expect(result.cfg.apiKey).toBe("env-api-key"); // env wins
        expect(result.cfg.url).toBe("https://env-url.com/v1"); // env wins
        expect(result.cfg.model).toBe("env-model"); // env wins
      }
    });

    it("should fix the 401 scenario: env protocol=openai overrides client protocol=anthropic", () => {
      // The key fix: client sends anthropic, but upstream needs openai
      process.env.MEMORY_LLM_PROTOCOL = "openai";
      process.env.MEMORY_LLM_API_KEY = "upstream-gateway-key";
      process.env.MEMORY_LLM_BASE_URL = "https://rcaaitoken.example.com/v1";
      process.env.MEMORY_LLM_MODEL = "claude-sonnet-4-6";

      const upstream: TaskDraftUpstream = {
        protocol: "anthropic", // Claude Code sends this
        apiKey: "user-proxy-key", // User's key for proxy, not for upstream
        upstreamUrl: "https://some-other-url.com",
        model: "some-model",
      };

      const result = resolveTaskDraftConfig(upstream);

      expect("cfg" in result).toBe(true);
      if ("cfg" in result) {
        // All should use env values, not client values
        expect(result.cfg.protocol).toBe("openai");
        expect(result.cfg.apiKey).toBe("upstream-gateway-key");
        expect(result.cfg.url).toBe("https://rcaaitoken.example.com/v1");
        expect(result.cfg.model).toBe("claude-sonnet-4-6");
      }
    });
  });

  describe("no envs set → unchanged 'follow-the-client' (Plan D) behavior", () => {
    it("should use client-passed values when no env vars are set", () => {
      const upstream: TaskDraftUpstream = {
        protocol: "anthropic",
        apiKey: "client-api-key",
        upstreamUrl: "https://client-url.com/v1",
        model: "client-model",
      };

      const result = resolveTaskDraftConfig(upstream);

      expect("cfg" in result).toBe(true);
      if ("cfg" in result) {
        expect(result.cfg.protocol).toBe("anthropic");
        expect(result.cfg.apiKey).toBe("client-api-key");
        expect(result.cfg.url).toBe("https://client-url.com/v1");
        expect(result.cfg.model).toBe("client-model");
      }
    });

    it("should return error when required client fields are missing", () => {
      const upstream: TaskDraftUpstream = {
        protocol: "anthropic",
        // Missing: apiKey, upstreamUrl, model
      };

      const result = resolveTaskDraftConfig(upstream);

      expect("error" in result).toBe(true);
      if ("error" in result) {
        expect(result.error).toContain("not configured");
      }
    });
  });

  describe("partially set → explicit fallback per field", () => {
    it("should use env for set fields, client for unset fields", () => {
      // Only protocol and apiKey from env
      process.env.MEMORY_LLM_PROTOCOL = "openai";
      process.env.MEMORY_LLM_API_KEY = "env-api-key";
      // BASE_URL and MODEL not set

      const upstream: TaskDraftUpstream = {
        protocol: "anthropic",
        apiKey: "client-api-key",
        upstreamUrl: "https://client-url.com/v1",
        model: "client-model",
      };

      const result = resolveTaskDraftConfig(upstream);

      expect("cfg" in result).toBe(true);
      if ("cfg" in result) {
        expect(result.cfg.protocol).toBe("openai"); // env wins
        expect(result.cfg.apiKey).toBe("env-api-key"); // env wins
        expect(result.cfg.url).toBe("https://client-url.com/v1"); // client fallback
        expect(result.cfg.model).toBe("client-model"); // client fallback
      }
    });

    it("should allow env to provide missing required fields", () => {
      // Client only has protocol, env provides the rest
      process.env.MEMORY_LLM_API_KEY = "env-api-key";
      process.env.MEMORY_LLM_BASE_URL = "https://env-url.com/v1";
      process.env.MEMORY_LLM_MODEL = "env-model";

      const upstream: TaskDraftUpstream = {
        protocol: "anthropic",
        // Missing required fields - but env will provide them
      };

      const result = resolveTaskDraftConfig(upstream);

      expect("cfg" in result).toBe(true);
      if ("cfg" in result) {
        expect(result.cfg.protocol).toBe("anthropic"); // client (no env override)
        expect(result.cfg.apiKey).toBe("env-api-key"); // env fills missing
        expect(result.cfg.url).toBe("https://env-url.com/v1"); // env fills missing
        expect(result.cfg.model).toBe("env-model"); // env fills missing
      }
    });

    it("should return error if neither env nor client provides required fields", () => {
      // Only protocol from env, nothing else
      process.env.MEMORY_LLM_PROTOCOL = "openai";

      const upstream: TaskDraftUpstream = {
        // Nothing provided
      };

      const result = resolveTaskDraftConfig(upstream);

      expect("error" in result).toBe(true);
      if ("error" in result) {
        expect(result.error).toContain("not configured");
        expect(result.error).toContain("MEMORY_LLM_MODEL");
        expect(result.error).toContain("MEMORY_LLM_BASE_URL");
        expect(result.error).toContain("MEMORY_LLM_API_KEY");
      }
    });
  });

  describe("protocol field special handling", () => {
    it("should not require protocol - it defaults in task-draft-generator", () => {
      const upstream: TaskDraftUpstream = {
        apiKey: "client-api-key",
        upstreamUrl: "https://client-url.com/v1",
        model: "client-model",
        // No protocol
      };

      const result = resolveTaskDraftConfig(upstream);

      expect("cfg" in result).toBe(true);
      if ("cfg" in result) {
        expect(result.cfg.protocol).toBeUndefined();
      }
    });
  });
});
