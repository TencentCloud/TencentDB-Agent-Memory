/**
 * StandaloneLLMRunner — powered by Vercel AI SDK (`ai` + `@ai-sdk/openai`).
 *
 * This runner does NOT depend on OpenClaw's `runEmbeddedPiAgent`. It is designed
 * for the Hermes Gateway scenario where TDAI runs as an independent Node.js sidecar
 * without the OpenClaw host.
 *
 * Capabilities:
 * - `enableTools: false`: pure text output (L1 extraction, L1 dedup)
 * - `enableTools: true`: automatic tool-call loop with local file operations
 *   (L2 scene, L3 persona) via AI SDK's `maxSteps`
 *
 * Tool sandbox:
 *   When tools are enabled, three basic file operations are exposed:
 *   `read_file`, `write_to_file`, `replace_in_file`.
 *   All file paths are resolved relative to `workspaceDir`, enforcing sandbox boundaries.
 */

import fsPromises from "node:fs/promises";
import path from "node:path";
import { generateText, tool, stepCountIs, jsonSchema } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { report } from "../../core/report/reporter.js";
import type {
  LLMRunner,
  LLMRunParams,
  LLMRunnerFactory,
  LLMRunnerCreateOptions,
  Logger,
} from "../../core/types.js";

const TAG = "[memory-tdai] [standalone-runner]";

// Max iterations in the tool-call loop to prevent infinite loops
const MAX_TOOL_ITERATIONS = 20;

// ============================
// Configuration
// ============================

export interface StandaloneLLMConfig {
  /** OpenAI-compatible API base URL (e.g. "https://api.openai.com/v1"). */
  baseUrl: string;
  /** API key for authentication. */
  apiKey: string;
  /** Default model name (e.g. "gpt-4o"). */
  model: string;
  /** Default max output tokens. */
  maxTokens?: number;
  /** Request timeout in milliseconds (default: 120_000). */
  timeoutMs?: number;
}

// ============================
// Sandboxed tool execution helpers
// ============================

function resolveSandboxedPath(workspaceDir: string, relativePath: string): string | null {
  const resolved = path.resolve(workspaceDir, relativePath);
  if (!resolved.startsWith(path.resolve(workspaceDir))) {
    return null;
  }
  return resolved;
}

// ============================
// Tool definitions (Vercel AI SDK `tool()` format)
// ============================

function createSandboxedTools(workspaceDir: string, logger?: Logger) {
  return {
    read_file: tool({
      description: "Read the contents of a file at the given relative path.",
      inputSchema: jsonSchema<{ path: string }>({
        type: "object",
        properties: {
          path: { type: "string", description: "Relative file path to read." },
        },
        required: ["path"],
      }),
      execute: (async (args: { path: string }) => {
        const resolved = resolveSandboxedPath(workspaceDir, args.path);
        if (!resolved) return JSON.stringify({ error: `Path "${args.path}" escapes workspace boundary.` });
        try {
          return await fsPromises.readFile(resolved, "utf-8");
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger?.warn?.(`${TAG} read_file failed: ${msg}`);
          return JSON.stringify({ error: msg });
        }
      }) as any,
    }),

    write_to_file: tool({
      description: "Write content to a file at the given relative path. Creates or overwrites.",
      inputSchema: jsonSchema<{ path: string; content: string }>({
        type: "object",
        properties: {
          path: { type: "string", description: "Relative file path to write." },
          content: { type: "string", description: "Content to write." },
        },
        required: ["path", "content"],
      }),
      execute: (async (args: { path: string; content: string }) => {
        const resolved = resolveSandboxedPath(workspaceDir, args.path);
        if (!resolved) return JSON.stringify({ error: `Path "${args.path}" escapes workspace boundary.` });
        try {
          await fsPromises.mkdir(path.dirname(resolved), { recursive: true });
          await fsPromises.writeFile(resolved, args.content, "utf-8");
          return JSON.stringify({ success: true });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger?.warn?.(`${TAG} write_to_file failed: ${msg}`);
          return JSON.stringify({ error: msg });
        }
      }) as any,
    }),

    replace_in_file: tool({
      description: "Replace an exact substring in a file with new content.",
      inputSchema: jsonSchema<{ path: string; old_str: string; new_str: string }>({
        type: "object",
        properties: {
          path: { type: "string", description: "Relative file path." },
          old_str: { type: "string", description: "Exact string to find and replace." },
          new_str: { type: "string", description: "Replacement string." },
        },
        required: ["path", "old_str", "new_str"],
      }),
      execute: (async (args: { path: string; old_str: string; new_str: string }) => {
        const resolved = resolveSandboxedPath(workspaceDir, args.path);
        if (!resolved) return JSON.stringify({ error: `Path "${args.path}" escapes workspace boundary.` });
        if (!args.old_str) return JSON.stringify({ error: "old_str cannot be empty." });
        try {
          const existing = await fsPromises.readFile(resolved, "utf-8");
          if (!existing.includes(args.old_str)) {
            return JSON.stringify({ error: `old_str not found in file "${args.path}".` });
          }
          const updated = existing.replace(args.old_str, args.new_str);
          await fsPromises.writeFile(resolved, updated, "utf-8");
          return JSON.stringify({ success: true });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger?.warn?.(`${TAG} replace_in_file failed: ${msg}`);
          return JSON.stringify({ error: msg });
        }
      }) as any,
    }),
  };
}

// ============================
// StandaloneLLMRunner
// ============================

export class StandaloneLLMRunner implements LLMRunner {
  private config: StandaloneLLMConfig;
  private model: string;
  private enableTools: boolean;
  private logger?: Logger;

  constructor(opts: {
    config: StandaloneLLMConfig;
    model?: string;
    enableTools?: boolean;
    logger?: Logger;
  }) {
    this.config = opts.config;
    this.model = opts.model ?? opts.config.model;
    this.enableTools = opts.enableTools ?? false;
    this.logger = opts.logger;
  }

  async run(params: LLMRunParams): Promise<string> {
    const runStartMs = Date.now();
    const timeoutMs = params.timeoutMs ?? this.config.timeoutMs ?? 120_000;
    const maxTokens = params.maxTokens ?? this.config.maxTokens ?? 4096;
    const workspaceDir = params.workspaceDir ?? process.cwd();

    this.logger?.debug?.(
      `${TAG} run() start: taskId=${params.taskId}, model=${this.model}, ` +
      `tools=${this.enableTools}, timeout=${timeoutMs}ms`,
    );

    // Create OpenAI-compatible provider via AI SDK
    // Use "compatible" mode to call /chat/completions (not Responses API),
    // which works with all OpenAI-compatible backends (DeepSeek, Qwen, etc.)
    const provider = createOpenAI({
      baseURL: this.config.baseUrl,
      apiKey: this.config.apiKey,
      compatibility: "compatible",
    });

    // For pure text tasks like L1 extraction, avoid exposing any tools.
    const tools = this.enableTools
      ? createSandboxedTools(workspaceDir, this.logger)
      : undefined;

    try {
      const result = await generateText({
        model: provider.chat(this.model),
        system: params.systemPrompt,
        prompt: params.prompt,
        ...(tools ? { tools } : {}),
        stopWhen: stepCountIs(this.enableTools ? MAX_TOOL_ITERATIONS : 1),
        maxOutputTokens: maxTokens,
        abortSignal: AbortSignal.timeout(timeoutMs),
      });

      const text = result.text.trim();
      const totalMs = Date.now() - runStartMs;

      this.logger?.debug?.(
        `${TAG} run() completed: ${totalMs}ms, steps=${result.steps.length}, output=${text.length} chars`,
      );

      // Log tool usage if any
      if (result.steps.length > 1) {
        const toolCalls = result.steps.flatMap((s) => s.toolCalls ?? []);
        this.logger?.debug?.(
          `${TAG} Tool calls: ${toolCalls.map((tc) => tc.toolName).join(", ")}`,
        );
      }

      // Metric
      if (params.instanceId) {
        report("llm_call", {
          taskId: params.taskId,
          provider: "standalone",
          model: this.model,
          inputLength: params.prompt.length,
          outputLength: text.length,
          totalDurationMs: totalMs,
          success: true,
          error: null,
        });
      }

      return text;
    } catch (err) {
      const totalMs = Date.now() - runStartMs;
      const errMsg = err instanceof Error ? err.message : String(err);
      this.logger?.error(`${TAG} run() failed after ${totalMs}ms: ${errMsg}`);

      if (params.instanceId) {
        report("llm_call", {
          taskId: params.taskId,
          provider: "standalone",
          model: this.model,
          inputLength: params.prompt.length,
          outputLength: 0,
          totalDurationMs: totalMs,
          success: false,
          error: errMsg,
        });
      }

      throw err;
    }
  }
}

// ============================
// StandaloneLLMRunnerFactory
// ============================

export interface StandaloneLLMRunnerFactoryOptions {
  /** LLM API configuration. */
  config: StandaloneLLMConfig;
  /** Logger instance. */
  logger?: Logger;
}

/**
 * Factory that creates StandaloneLLMRunner instances.
 *
 * Used by the Gateway and Hermes host adapters.
 */
export class StandaloneLLMRunnerFactory implements LLMRunnerFactory {
  private config: StandaloneLLMConfig;
  private logger?: Logger;

  constructor(opts: StandaloneLLMRunnerFactoryOptions) {
    this.config = opts.config;
    this.logger = opts.logger;
  }

  createRunner(opts?: LLMRunnerCreateOptions): LLMRunner {
    const enableTools = opts?.enableTools ?? false;
    const modelRef = opts?.modelRef;

    // Parse "provider/model" → just use the model part for OpenAI-compatible API
    let model = this.config.model;
    if (modelRef) {
      const slashIdx = modelRef.indexOf("/");
      model = slashIdx > 0 ? modelRef.slice(slashIdx + 1) : modelRef;
    }

    this.logger?.debug?.(
      `${TAG} Creating StandaloneLLMRunner: model=${model}, tools=${enableTools}`,
    );

    return new StandaloneLLMRunner({
      config: this.config,
      model,
      enableTools,
      logger: this.logger,
    });
  }
}
