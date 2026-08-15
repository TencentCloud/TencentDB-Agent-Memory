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
 *   `read`, `write`, `edit` — aligned with OpenClaw host tool names.
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
import type { LLMUsage } from "../../core/report/metric-tracking-runner.js";

const TAG = "[memory-tdai] [standalone-runner]";

// Max iterations in the tool-call loop to prevent infinite loops
const MAX_TOOL_ITERATIONS = 20;

// ============================
// experimental_telemetry.metadata 组装
// ============================

/**
 * 组装传给 Vercel AI SDK 的 experimental_telemetry.metadata。
 *
 * 字段策略：
 *   - instanceId  : 始终写入（未传时降级为 "unknown"）
 *   - traceName   : 存在时 → 写入 langfuseTraceName + langfuseUpdateParent=true
 *                  （让 Langfuse 用业务语义命名 trace，覆盖默认的 Unnamed）
 *   - tags        : 非空数组才写入（避免空 tag 污染 Langfuse 索引）
 *   - sessionId   : 非空字符串才写入（Langfuse UI 顶级筛选字段）
 *   - userId      : 非空字符串才写入（Langfuse UI 顶级筛选字段）
 *
 * 未传对应字段时，metadata 里也不出现该键 —— 保持与旧行为完全一致。
 */
function buildTelemetryMetadata(params: LLMRunParams): Record<string, unknown> {
  const meta: Record<string, unknown> = {
    instanceId: params.instanceId ?? "unknown",
  };
  if (params.traceName) {
    meta.langfuseTraceName = params.traceName;
    // langfuseUpdateParent=true 让子 span 的 name/attrs 传播到 Langfuse trace 根
    meta.langfuseUpdateParent = true;
  }
  if (Array.isArray(params.tags) && params.tags.length > 0) {
    meta.tags = params.tags;
  }
  if (typeof params.sessionId === "string" && params.sessionId.length > 0) {
    meta.sessionId = params.sessionId;
  }
  if (typeof params.userId === "string" && params.userId.length > 0) {
    meta.userId = params.userId;
  }
  return meta;
}

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
  /**
   * LLM 访问模式（gateway 层解释；runner 拿到的是已解析后的 baseUrl/apiKey）：
   *   - "openai": 直连通用 OpenAI 兼容服务（默认，向后兼容）
   *   - "proxy":  走 context_proxy，运行时会自动把 baseUrl 拼成
   *               `${baseUrl}/proxy/<instanceId>/v1`，apiKey 用 metadata.systemUser.memory.userKey
   */
  provider?: "openai" | "proxy";
  /** provider=proxy 时的可选配置。 */
  proxy?: {
    /** 是否用 memory systemUser.userKey 作为 Authorization（默认 true）。 */
    useMemorySystemUserKey?: boolean;
  };
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
    read: tool({
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
          const content = await fsPromises.readFile(resolved, "utf-8");
          logger?.debug?.(`${TAG} read: "${args.path}" → ${content.length} chars`);
          return content;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger?.warn?.(`${TAG} read failed: ${msg}`);
          return JSON.stringify({ error: msg });
        }
      }) as any,
    }),

    write: tool({
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
          logger?.debug?.(`${TAG} write: "${args.path}" → ${args.content.length} chars`);
          return JSON.stringify({ success: true });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger?.warn?.(`${TAG} write failed: ${msg}`);
          return JSON.stringify({ error: msg });
        }
      }) as any,
    }),

    edit: tool({
      description: "Apply one or more text replacements to a file. Each edit replaces an exact substring.",
      inputSchema: jsonSchema<{ path: string; edits: Array<{ oldText: string; newText: string }> }>({
        type: "object",
        properties: {
          path: { type: "string", description: "Relative file path." },
          edits: {
            type: "array",
            description: "Array of replacements to apply sequentially.",
            items: {
              type: "object",
              properties: {
                oldText: { type: "string", description: "Exact string to find." },
                newText: { type: "string", description: "Replacement string." },
              },
              required: ["oldText", "newText"],
            },
          },
        },
        required: ["path", "edits"],
      }),
      execute: (async (args: { path: string; edits: Array<{ oldText: string; newText: string }> }) => {
        const resolved = resolveSandboxedPath(workspaceDir, args.path);
        if (!resolved) return JSON.stringify({ error: `Path "${args.path}" escapes workspace boundary.` });
        if (!args.edits || args.edits.length === 0) return JSON.stringify({ error: "edits array cannot be empty." });
        try {
          let content = await fsPromises.readFile(resolved, "utf-8");
          for (const edit of args.edits) {
            if (!edit.oldText) return JSON.stringify({ error: "oldText cannot be empty." });
            if (!content.includes(edit.oldText)) {
              return JSON.stringify({ error: `oldText not found in file "${args.path}": ${edit.oldText.slice(0, 80)}` });
            }
            content = content.replace(edit.oldText, edit.newText);
          }
          await fsPromises.writeFile(resolved, content, "utf-8");
          logger?.debug?.(`${TAG} edit: "${args.path}" → ${args.edits.length} replacement(s), ${content.length} chars`);
          return JSON.stringify({ success: true });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger?.warn?.(`${TAG} edit failed: ${msg}`);
          return JSON.stringify({ error: msg });
        }
      }) as any,
    }),
  };
}

/** Read-only tool subset — currently empty.
 *
 * Historically returned `{ read: all.read }` so the AI SDK wouldn't reject
 * an empty tools object. In practice this caused weak models (e.g. small
 * Doubao endpoints) to hallucinate calls like `read({"path":"."})` during
 * pure-text tasks (L1 extraction), triggering EISDIR on the sandbox dir
 * and burning a turn on a useless tool call.
 *
 * Modern AI SDK (v6) accepts an undefined `tools` field, so the runner now
 * skips the `tools`/`stopWhen` parameters entirely when tools are disabled
 * — see `generateText` invocation below.
 */
function createReadOnlyTools(_workspaceDir: string, _logger?: Logger) {
  return {};
}

// ============================
// StandaloneLLMRunner
// ============================

export class StandaloneLLMRunner implements LLMRunner {
  private config: StandaloneLLMConfig;
  private model: string;
  private enableTools: boolean;
  private logger?: Logger;

  /**
   * Side-channel: 最近一次 run() 调用的 token usage。
   * 由 MetricTrackingRunner 装饰器读取，用于精确上报 credit。
   * 不改变 LLMRunner 接口签名。
   */
  lastUsage?: LLMUsage;

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
    // Per-call overrides — when the caller supplies their own tools (e.g.
    // SkillExtractor's skill_list/skill_view/skill_manage), they trump the
    // runner-level enableTools default. This lets one runner instance
    // serve both pure-text L1 extraction and tool-driven skill review.
    const callerProvidedTools = params.tools && Object.keys(params.tools).length > 0;
    const effectiveEnableTools = params.enableTools ?? this.enableTools;
    const maxIterations = params.maxIterations ?? MAX_TOOL_ITERATIONS;

    this.logger?.debug?.(
      `${TAG} run() start: taskId=${params.taskId}, model=${this.model}, ` +
      `tools=${effectiveEnableTools}${callerProvidedTools ? "(caller)" : ""}, timeout=${timeoutMs}ms`,
    );

    // ── Direct-fetch fallback for pure-text tasks (no tools) ──
    //
    // The Vercel AI SDK's createOpenAI({ compatibility: "compatible" }) path
    // requests `stream: true` regardless of the caller's intent, then parses
    // the SSE response. Some OpenAI-compatible backends (notably OmniRoute
    // 3.8.48) emit trailing SSE comments and an empty `usage` chunk that the
    // SDK's stream parser rejects with "Invalid JSON response" — even though
    // the model itself returned valid JSON.
    //
    // For pure-text tasks (L1 extraction, summarization) we bypass the SDK
    // and use a plain fetch. The model-protocol contract is identical for
    // non-tool use cases, and we get a clean response without the parser
    // mismatch.
    //
    // For tool-enabled tasks (L2 scene extraction) we also bypass the SDK
    // because the AI SDK's tool-using path goes through the same broken
    // SSE parser. We send tool definitions as OpenAI function-calling
    // format and parse the response manually. If the LLM returns tool_calls,
    // we extract the first tool's arguments as the response text. If the
    // LLM returns text, we use that directly. The scene-extractor parses
    // text output for persona update signals and uses the file system
    // independently, so partial tool-support is fine.
    const useDirectFetch = true;
    if (useDirectFetch) {
      // Build tools up-front so directFetch can include them in the request.
      let tools: Record<string, unknown> | undefined;
      if (callerProvidedTools && effectiveEnableTools) {
        tools = params.tools;
      } else if (effectiveEnableTools && params.storage) {
        const { createStorageTools } = await import("./storage-tools.js");
        tools = createStorageTools(params.storage, params.storagePrefix ?? "", this.logger);
      } else if (effectiveEnableTools) {
        tools = createSandboxedTools(workspaceDir, this.logger);
      }
      const directFetchParams = tools ? { ...params, tools } : params;
      return this.directFetch(directFetchParams, runStartMs, timeoutMs, maxTokens);
    }
  }

  // SDK path removed — directFetch handles all LLM calls.
  // (The Vercel AI SDK's OpenAI-compatible provider has a broken SSE parser
  //  on certain backends; see directFetch for the bypass logic.)

  /**
   * Direct-fetch path for LLM calls.
   *
   * Bypasses the Vercel AI SDK's OpenAI-compatible provider because that
   * implementation has a broken SSE parser on certain backends (notably
   * OmniRoute 3.8.48's trailing-comment format). Plain fetch + `stream: false`
   * works against every OpenAI-compatible endpoint we care about.
   *
   * Handles both text-only tasks (L1 extraction) and tool-using tasks (L2
   * scene extraction). For tool-using tasks, we send the tool definitions
   * as OpenAI function-calling format and parse the response — if the LLM
   * returns tool_calls, we extract the first tool's arguments as the
   * response text; otherwise we use the message content directly.
   */
  private async directFetch(
    params: LLMRunParams,
    runStartMs: number,
    timeoutMs: number,
    maxTokens: number,
  ): Promise<string> {
    const toolsList = this.buildOpenAITools(params.tools);
    const messages: Array<Record<string, unknown>> = [
      ...(params.systemPrompt ? [{ role: "system", content: params.systemPrompt }] : []),
      { role: "user", content: params.prompt },
    ];
    return this.directFetchInternal(messages, toolsList, params, runStartMs, timeoutMs, maxTokens, 0);
  }

  /**
   * Internal recursion for tool execution: send messages to LLM, if it returns
   * tool_calls, execute them, append results, recurse. Returns final text.
   */
  private async directFetchInternal(
    messages: Array<Record<string, unknown>>,
    toolsList: Array<{ type: "function"; function: { name: string; description?: string; parameters: unknown } }>,
    params: LLMRunParams,
    runStartMs: number,
    timeoutMs: number,
    maxTokens: number,
    depth: number,
  ): Promise<string> {
    const MAX_DEPTH = 8;
    if (depth >= MAX_DEPTH) {
      this.logger?.warn?.(`${TAG} [direct] max tool-call depth reached (${MAX_DEPTH}), returning last text`);
      return "";
    }
    const url = `${this.config.baseUrl.replace(/\/+$/, "")}/chat/completions`;
    const tools = params.tools as Record<string, unknown> | undefined;
    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      max_tokens: maxTokens,
      stream: false,
    };
    if (toolsList.length > 0) {
      body.tools = toolsList;
      body.tool_choice = "auto";
    }

    this.logger?.debug?.(
      `${TAG} [direct] POST ${url} model=${this.model} maxTokens=${maxTokens} tools=${toolsList.length}`,
    );

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    const combinedSignal = params.abortSignal
      ? AbortSignal.any([controller.signal, params.abortSignal])
      : controller.signal;

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: combinedSignal,
      });

      const totalMs = Date.now() - runStartMs;
      clearTimeout(timeoutId);

      if (!response.ok) {
        const errText = await response.text().catch(() => "");
        this.logger?.error?.(`${TAG} [direct] HTTP ${response.status} after ${totalMs}ms: ${errText.slice(0, 500)}`);
        throw new Error(`LLM HTTP ${response.status}: ${errText.slice(0, 500)}`);
      }

      const json = (await response.json()) as {
        choices?: Array<{
          message?: {
            content?: string | null;
            tool_calls?: Array<{ function?: { name?: string; arguments?: string } }>;
          };
        }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
      };

      const choice = json.choices?.[0]?.message;
      let text = (choice?.content ?? "").trim();
      const toolCalls = choice?.tool_calls ?? [];

      // Tool execution loop: if the LLM returned tool_calls, execute them,
      // append results to the message history, and call the LLM again.
      // Repeats until the LLM returns text (no tool_calls) or maxIterations.
      if (toolCalls.length > 0 && toolsList.length > 0) {
        const toolResultMessages: Array<{ role: "tool"; tool_call_id: string; content: string }> = [];
        for (const tc of toolCalls) {
          const name = tc.function?.name ?? "";
          const argsJson = tc.function?.arguments ?? "{}";
          const toolDef = tools[name];
          const execute = (toolDef as any)?.execute;
          if (typeof execute !== "function") {
            toolResultMessages.push({
              role: "tool",
              tool_call_id: tc.id ?? "",
              content: JSON.stringify({ error: `Tool "${name}" has no execute()` }),
            });
            continue;
          }
          let parsedArgs: unknown = {};
          try { parsedArgs = JSON.parse(argsJson); } catch { /* keep as {} */ }
          this.logger?.debug?.(
            `${TAG} [direct] executing tool: ${name}(${JSON.stringify(parsedArgs).slice(0, 100)})`,
          );
          let result: unknown;
          try {
            result = await Promise.resolve(execute.call(toolDef, parsedArgs, { toolCallId: tc.id, messages: [] }));
          } catch (toolErr) {
            result = { error: toolErr instanceof Error ? toolErr.message : String(toolErr) };
          }
          const resultText = typeof result === "string" ? result : JSON.stringify(result);
          toolResultMessages.push({
            role: "tool",
            tool_call_id: tc.id ?? "",
            content: resultText,
          });
        }
        this.logger?.debug?.(
          `${TAG} [direct] tool_call round: ${toolCalls.length} call(s), results=${toolResultMessages.length}`,
        );
        // Build follow-up messages with assistant + tool results and recurse.
        const followUpMessages = [
          ...body.messages,
          { role: "assistant" as const, content: text, tool_calls: toolCalls },
          ...toolResultMessages,
        ];
        return await this.directFetchInternal(
          followUpMessages,
          toolsList,
          params,
          runStartMs,
          timeoutMs,
          maxTokens,
          depth + 1,
        );
      }

      // Side-channel usage for MetricTrackingRunner
      if (json.usage) {
        this.lastUsage = {
          promptTokens: json.usage.prompt_tokens ?? 0,
          completionTokens: json.usage.completion_tokens ?? 0,
          totalTokens: json.usage.total_tokens ?? (json.usage.prompt_tokens ?? 0) + (json.usage.completion_tokens ?? 0),
        };
      } else {
        this.lastUsage = undefined;
      }

      this.logger?.debug?.(
        `${TAG} [direct] completed: ${totalMs}ms, output=${text.length} chars`,
      );

      if (params.instanceId) {
        report("llm_call", {
          taskId: params.taskId,
          provider: "standalone-direct",
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
      clearTimeout(timeoutId);
      const errMsg = err instanceof Error ? err.message : String(err);
      this.logger?.error?.(`${TAG} [direct] failed after ${totalMs}ms: ${errMsg}`);

      if (params.instanceId) {
        report("llm_call", {
          taskId: params.taskId,
          provider: "standalone-direct",
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

  /**
   * Convert AI SDK tool definitions to OpenAI function-calling format.
   *
   * The AI SDK's `tool()` wraps a JSON schema under an `inputSchema` field.
   * OpenAI expects `parameters` at the top level, with `type: "function"`.
   * This adapter handles both: AI SDK-style tools (`{ description, inputSchema }`)
   * and pre-formatted OpenAI-style tools (passed through as-is).
   */
  private buildOpenAITools(
    tools: Record<string, unknown> | undefined,
  ): Array<{ type: "function"; function: { name: string; description?: string; parameters: unknown } }> {
    if (!tools) return [];
    const out: Array<{ type: "function"; function: { name: string; description?: string; parameters: unknown } }> = [];
    for (const [name, def] of Object.entries(tools)) {
      const d = def as Record<string, unknown>;
      // AI SDK tool format: { description, inputSchema, execute }
      if (d.inputSchema && typeof d.inputSchema === "object") {
        out.push({
          type: "function",
          function: {
            name,
            description: typeof d.description === "string" ? d.description : undefined,
            parameters: d.inputSchema,
          },
        });
      } else if (d.parameters && typeof d.parameters === "object") {
        // Already OpenAI-format
        out.push({
          type: "function",
          function: {
            name,
            description: typeof d.description === "string" ? d.description : undefined,
            parameters: d.parameters,
          },
        });
      }
    }
    return out;
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
