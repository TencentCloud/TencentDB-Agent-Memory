/**
 * Environment variables shared by every TDAI entry point, MCP and HTTP alike.
 *
 * Transport-specific variables live in the loader that owns them:
 *   bin/shared.ts       — TDAI_SESSION_KEY (MCP)
 *   bin/shared-http.ts  — TDAI_PORT, TDAI_HOST, TDAI_GATEWAY_API_KEY,
 *                         TDAI_CORS_ORIGINS (HTTP)
 *
 * Required:
 *   TDAI_LLM_BASE_URL            — OpenAI-compatible API base URL
 *   TDAI_LLM_API_KEY             — API key for the LLM endpoint
 *   TDAI_LLM_MODEL               — model name (e.g. "gpt-4o", "deepseek-chat")
 *
 * Optional:
 *   TDAI_DATA_DIR                — storage root (default: ~/.tdai/<platform>)
 *   TDAI_LLM_MAX_TOKENS          — max output tokens for extraction pipelines
 *   TDAI_LLM_TIMEOUT_MS          — LLM request timeout in ms
 *   TDAI_LLM_DISABLE_THINKING    — disable reasoning tokens:
 *                                   false / true / vllm / deepseek / dashscope /
 *                                   openai / anthropic / kimi / gemini
 *   TDAI_USER_ID                 — default user identifier (default: "default_user").
 *                                  Reserved: recorded in RuntimeContext but not
 *                                  yet used to scope storage. Running two users
 *                                  against one server shares one memory store.
 *   TDAI_MEMORY_CONFIG           — JSON string with MemoryTdaiConfig overrides
 */

import os from "node:os";
import path from "node:path";
import { normalizeDisableThinking } from "../src/utils/no-think-fetch.js";
import type { StandaloneLLMConfig } from "../src/adapters/standalone/llm-runner.js";

/** The subset of server options derivable from transport-neutral env vars. */
export interface CommonEnvOptions {
  dataDir: string;
  llmConfig: StandaloneLLMConfig;
  memoryConfigOverride?: Record<string, unknown>;
  userId?: string;
}

/**
 * Read an integer env var.
 * Returns undefined when unset, and warns-then-ignores when unparseable —
 * a silent NaN would otherwise reach `listen()` or the LLM client.
 */
export function parseIntEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;

  const value = Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    process.stderr.write(`[tdai] Warning: ${name}="${raw}" is not an integer — ignored.\n`);
    return undefined;
  }
  return value;
}

/** Load the env vars every entry point needs, exiting on missing required ones. */
export function loadCommonEnv(defaultDirName: string): CommonEnvOptions {
  const baseUrl = process.env["TDAI_LLM_BASE_URL"];
  const apiKey = process.env["TDAI_LLM_API_KEY"];
  const model = process.env["TDAI_LLM_MODEL"];

  if (!baseUrl || !apiKey || !model) {
    process.stderr.write(
      "[tdai] Fatal: TDAI_LLM_BASE_URL, TDAI_LLM_API_KEY, and TDAI_LLM_MODEL are required.\n",
    );
    process.exit(1);
  }

  const dataDir = path.resolve(
    process.env["TDAI_DATA_DIR"] ?? path.join(os.homedir(), ".tdai", defaultDirName),
  );

  let memoryConfigOverride: Record<string, unknown> | undefined;
  const rawMemoryConfig = process.env["TDAI_MEMORY_CONFIG"];
  if (rawMemoryConfig) {
    try {
      memoryConfigOverride = JSON.parse(rawMemoryConfig) as Record<string, unknown>;
    } catch {
      process.stderr.write("[tdai] Warning: TDAI_MEMORY_CONFIG is not valid JSON — ignored.\n");
    }
  }

  return {
    dataDir,
    llmConfig: {
      baseUrl,
      apiKey,
      model,
      maxTokens: parseIntEnv("TDAI_LLM_MAX_TOKENS"),
      timeoutMs: parseIntEnv("TDAI_LLM_TIMEOUT_MS"),
      disableThinking: normalizeDisableThinking(process.env["TDAI_LLM_DISABLE_THINKING"]),
    },
    memoryConfigOverride,
    userId: process.env["TDAI_USER_ID"],
  };
}
