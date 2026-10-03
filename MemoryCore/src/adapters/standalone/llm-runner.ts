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
import { generateText, streamText, tool, stepCountIs, jsonSchema, Output, APICallError, NoObjectGeneratedError } from "ai";
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
// Structured output capability fallback (issue #1210)
// ============================

/**
 * Conservative test: does this error PROVE that the provider/gateway lacks
 * structured-output support?
 *
 * TWO conditions must both hold:
 *   1. The error text mentions the structured-output surface
 *      (response_format / json_schema / json_object / structured output).
 *   2. The error text carries capability semantics — "not supported",
 *      "unsupported", "unknown/unrecognized parameter", "does not support".
 *
 * This keeps OUR bugs loud: "Invalid schema for response_format" or
 * "invalid json_schema: missing required property" mention the surface but
 * are schema-authoring errors — they must THROW so we fix the schema, not
 * silently degrade. Same for auth failures, model-not-found, context-length,
 * quota, 429/5xx and unknown 400s.
 */
const STRUCTURED_SURFACE_RE = /response_format|json_schema|json_object|structured[\s_-]?output/i;
const CAPABILITY_PHRASE_RE =
  /not\s+supported|unsupported|does\s+not\s+support|doesn['’]t\s+support|no\s+support\s+for|unknown\s+(?:parameter|field|argument|request)|unrecognized/i;
/**
 * Schema-AUTHORING errors: the provider rejected OUR schema (invalid
 * keyword, missing required property, validation failure). These mention the
 * structured surface and often the word "unsupported", but the missing
 * capability belongs to the schema, not the endpoint — they must THROW so
 * the schema gets fixed instead of silently degrading (review F5).
 */
const SCHEMA_AUTHORING_ERROR_RE =
  /invalid\s+(?:json_)?schema|schema\s+(?:validation|keyword|error)|unsupported\s+(?:schema\s+)?keyword|missing\s+required/i;

function isStructuredCapabilityError(err: unknown): boolean {
  if (!APICallError.isInstance(err)) return false;
  const status = err.statusCode;
  if (status !== 400 && status !== 422) return false;
  let dataStr = "";
  if (err.data != null) {
    try {
      dataStr = JSON.stringify(err.data);
    } catch {
      dataStr = String(err.data);
    }
  }
  const evidence = `${err.responseBody ?? ""}\n${dataStr}\n${err.message ?? ""}`;
  if (SCHEMA_AUTHORING_ERROR_RE.test(evidence)) return false;
  return STRUCTURED_SURFACE_RE.test(evidence) && CAPABILITY_PHRASE_RE.test(evidence);
}

/** Usage shape shared by AI SDK results and NoObjectGeneratedError. */
type UsageLike = { inputTokens?: number; outputTokens?: number; totalTokens?: number } | undefined;

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
  /**
   * 是否用流式请求(streamText)调用上游。默认 false(generateText 非流式)。
   * 个别 OpenAI 兼容上游只接受流式请求时置 true。
   *
   * ⚠️ 仅 StandaloneLLMRunner(含 gateway/local/knowledge-ingest)路径生效;
   * OpenClaw host runner 不使用此 runner,该开关被忽略。不会把增量 token
   * 透传给调用方,只是"以流式协议请求上游后等待完整文本"的兼容层。
   */
  stream?: boolean;
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
          logger?.debug?.(`${TAG} write: "${args.path}" → ${Buffer.byteLength(args.content, "utf8")} bytes`);
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
            // Pass a replacer function so `$&`, `$'`, "$`", `$1`, `$$` in newText are
            // inserted literally. A plain string replacement would expand them as
            // special patterns -- `$'` (matched substring's suffix) duplicates the rest
            // of the file on every edit, growing scene blocks exponentially.
            content = content.replace(edit.oldText, () => edit.newText);
          }
          await fsPromises.writeFile(resolved, content, "utf-8");
          logger?.debug?.(
            `${TAG} edit: "${args.path}" → ${args.edits.length} replacement(s), ${Buffer.byteLength(content, "utf8")} bytes`,
          );
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
  private stream: boolean;
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
    stream?: boolean;
    logger?: Logger;
  }) {
    this.config = opts.config;
    this.model = opts.model ?? opts.config.model;
    this.enableTools = opts.enableTools ?? false;
    this.stream = opts.stream ?? opts.config.stream ?? false;
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

    // Create OpenAI-compatible provider via AI SDK
    // provider.chat() below selects /chat/completions explicitly, including
    // for OpenAI-compatible backends (DeepSeek, Qwen, etc.).
    const provider = createOpenAI({
      baseURL: this.config.baseUrl,
      apiKey: this.config.apiKey,
    });

    // Select tools based on mode + storage
    // Service mode (COS): use storage-backed tools → LLM reads/writes via StorageAdapter
    // Standalone mode (local FS): use sandboxed FS tools → LLM reads/writes local files
    // enableTools=false: omit tools entirely so the model cannot hallucinate calls.
    // Caller-provided tools (params.tools) override the defaults — used by
    // SkillExtractor to inject domain-specific tools (skill_list, etc.).
    let tools: Record<string, unknown> | undefined;
    if (callerProvidedTools && effectiveEnableTools) {
      tools = params.tools;
      this.logger?.debug?.(`${TAG} Using caller-provided tools: [${Object.keys(tools!).join(", ")}]`);
    } else if (effectiveEnableTools && params.storage) {
      const { createStorageTools } = await import("./storage-tools.js");
      tools = createStorageTools(params.storage, params.storagePrefix ?? "", this.logger);
      this.logger?.debug?.(`${TAG} Using storage-backed tools (prefix="${params.storagePrefix ?? ""}")`);
    } else if (effectiveEnableTools) {
      tools = createSandboxedTools(workspaceDir, this.logger);
    } else {
      tools = undefined; // pure-text task — never expose any tool to the model
    }

    try {
      // H-11 Step 2: combine internal timeout with caller-provided abortSignal
      // (e.g. pipeline-worker lost its lock and wants the LLM call to bail out).
      // AbortSignal.any (Node 20+) aborts when ANY of the listed signals abort.
      const timeoutSignal = AbortSignal.timeout(timeoutMs);
      const combinedSignal = params.abortSignal
        ? AbortSignal.any([timeoutSignal, params.abortSignal])
        : timeoutSignal;

      const callParams = {
        model: provider.chat(this.model),
        system: params.systemPrompt,
        prompt: params.prompt,
        // Only attach tools when actually enabled — passing an empty object
        // (or even a tools-only-with-`read`) makes some OpenAI-compatible
        // backends emit spurious tool calls on pure-text tasks.
        ...(tools && Object.keys(tools).length > 0
          ? { tools, stopWhen: stepCountIs(maxIterations) }
          : {}),
        maxOutputTokens: maxTokens,
        abortSignal: combinedSignal,
        experimental_telemetry: {
          isEnabled: true,
          functionId: params.taskId,
          metadata: buildTelemetryMetadata(params),
        },
      };

      // ── Structured output path (issue #1210) ──
      // Only when NO tools are attached: structured output constrains the
      // final text response. Tool-driven workflows (L2 scene, skill review)
      // keep their plain multi-step text flow untouched.
      if (params.structuredOutput && !(tools && Object.keys(tools).length > 0)) {
        // await (not bare return): rejections must flow through this try's
        // catch so the failure log + llm_call metric fire exactly once for
        // every path (review N2).
        return await this.runStructuredOutput(params, callParams, runStartMs);
      }

      return await this.executePlainCall(params, callParams, runStartMs);
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

  // ============================
  // Execution helpers
  // ============================

  /**
   * Plain-text model call (no structured output) — the pre-#1210 execution
   * path, extracted verbatim so the unstructured path AND structured tier 3
   * share ONE callParams / abortSignal / runStartMs (issue #1210 review F9:
   * tier fallback must not reset the per-run deadline or duration origin).
   */
  private async executePlainCall(
    params: LLMRunParams,
    callParams: Record<string, unknown>,
    runStartMs: number,
  ): Promise<string> {
    // stream=true → streamText(给只吃流式的上游);否则 generateText。
    // 读 totalUsage 而不是单 step 的 usage —— tool-call 多 step 时后者只报最后一步,
    // 会漏掉前序工具调用请求的用量,导致 credit 计费偏低。
    const { text, usage, steps } = this.stream
      ? await (async () => {
          const streamResult = streamText(callParams as Parameters<typeof streamText>[0]);
          return {
            text: ((await streamResult.text) ?? "").trim(),
            usage: await streamResult.totalUsage,
            steps: await streamResult.steps,
          };
        })()
      : await (async () => {
          const genResult = await generateText(callParams as Parameters<typeof generateText>[0]);
          return {
            text: (genResult.text ?? "").trim(),
            usage: genResult.totalUsage,
            steps: genResult.steps,
          };
        })();

    const totalMs = Date.now() - runStartMs;

    // 暴露 token usage 到 side-channel（供 MetricTrackingRunner 读取）
    // AI SDK 用 inputTokens/outputTokens,我们的内部 LLMUsage 沿用旧命名
    // promptTokens/completionTokens 以匹配 MetricTrackingRunner。
    if (usage) {
      const promptTokens = usage.inputTokens ?? 0;
      const completionTokens = usage.outputTokens ?? 0;
      this.lastUsage = {
        promptTokens,
        completionTokens,
        totalTokens: usage.totalTokens ?? promptTokens + completionTokens,
      };
    } else {
      this.lastUsage = undefined;
    }

    this.logger?.debug?.(
      `${TAG} run() completed: ${totalMs}ms, steps=${steps.length}, output=${text.length} chars`,
    );

    // Log each step's activity (tool calls + text output)
    for (const step of steps) {
      const calls = step.toolCalls ?? [];
      const textLen = step.text?.length ?? 0;
      if (calls.length > 0) {
        const callSummary = calls.map((tc) =>
          `${tc.toolName}(${JSON.stringify(tc.input).slice(0, 120)})`,
        ).join(", ");
        this.logger?.debug?.(
          `${TAG} step[${step.stepNumber}] toolCalls: ${callSummary}`,
        );
      }
      if (textLen > 0) {
        this.logger?.debug?.(
          `${TAG} step[${step.stepNumber}] text: ${textLen} chars, finishReason=${step.finishReason}`,
        );
      }
      if (calls.length === 0 && textLen === 0) {
        this.logger?.debug?.(
          `${TAG} step[${step.stepNumber}] empty (no tools, no text), finishReason=${step.finishReason}`,
        );
      }
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
  }

  // ============================
  // Structured output tiers (issue #1210)
  // ============================

  /**
   * Tiered structured-output execution:
   *
   *   tier 1  Output.object + JSON Schema → provider json_schema mode
   *           + canonical runtime validation of the parsed value
   *   tier 2  Output.json → provider json_object mode + canonical validation
   *   tier 3  plain text generation (executePlainCall, shared deadline)
   *
   * Degradation happens ONLY on isStructuredCapabilityError (explicit
   * capability evidence). Canonical-validation failures and
   * NoObjectGeneratedError never re-call the LLM: the raw text from the SAME
   * response is returned so the caller's tolerant parser can try to salvage
   * it, and the caller re-validates the repaired result (extractor-side
   * post-repair canonical check).
   *
   * All tiers share the caller's runStartMs — one deadline, one duration
   * origin, no reset on fallback (review F9).
   */
  private async runStructuredOutput(
    params: LLMRunParams,
    callParams: Record<string, unknown>,
    runStartMs: number,
  ): Promise<string> {
    const { schema, schemaName, validate } = params.structuredOutput!;
    const validateCanonical = (value: unknown, tier: string): boolean => {
      if (!validate) return true;
      const ok = validate(value);
      if (!ok) {
        this.logger?.warn?.(
          `${TAG} structured output failed canonical validation (${tier} → legacy parser) taskId=${params.taskId}`,
        );
      }
      return ok;
    };

    // ── Tier 1: JSON Schema constrained generation (strict by default —
    // @ai-sdk/openai sends json_schema with strict:true unless overridden).
    try {
      const { text, value } = await this.executeOutputCall({
        ...callParams,
        output: Output.object({
          schema: jsonSchema(schema as Parameters<typeof jsonSchema>[0]),
          ...(schemaName ? { name: schemaName } : {}),
        }),
      });
      this.logger?.debug?.(`${TAG} structured output mode=json_schema taskId=${params.taskId}`);
      this.reportStructuredCall(params, runStartMs, true, text, validateCanonical(value, "json_schema") ? null : "canonical_validation_failed");
      return text;
    } catch (err) {
      const salvaged = this.salvageValidationFailure(err, params, runStartMs, "json_schema");
      if (salvaged !== undefined) return salvaged;
      if (!isStructuredCapabilityError(err)) {
        // No failure metric here — the error propagates to run()'s catch,
        // which logs + reports the failure exactly once (review N2).
        throw err;
      }
      this.logger?.warn?.(
        `${TAG} structured output unsupported (json_schema → json_object) taskId=${params.taskId} ` +
        `status=${(err as APICallError).statusCode}: ${capabilityEvidence(err)}`,
      );
    }

    // ── Tier 2: JSON Object mode + canonical validation.
    try {
      const { text, value } = await this.executeOutputCall({
        ...callParams,
        output: Output.json(),
      });
      this.logger?.debug?.(`${TAG} structured output mode=json_object taskId=${params.taskId}`);
      this.reportStructuredCall(params, runStartMs, true, text, validateCanonical(value, "json_object") ? null : "canonical_validation_failed");
      return text;
    } catch (err) {
      const salvaged = this.salvageValidationFailure(err, params, runStartMs, "json_object");
      if (salvaged !== undefined) return salvaged;
      if (!isStructuredCapabilityError(err)) {
        // No failure metric here — the error propagates to run()'s catch,
        // which logs + reports the failure exactly once (review N2).
        throw err;
      }
      this.logger?.warn?.(
        `${TAG} structured output unsupported (json_object → legacy text) taskId=${params.taskId} ` +
        `status=${(err as APICallError).statusCode}: ${capabilityEvidence(err)}`,
      );
    }

    // ── Tier 3: existing plain-text path — same callParams (same
    // abortSignal/deadline) and the same runStartMs; no re-entry into run().
    this.logger?.debug?.(`${TAG} structured output mode=legacy_text taskId=${params.taskId}`);
    return this.executePlainCall(params, callParams, runStartMs);
  }

  /**
   * Single LLM call with an `output` specification. Works for both transports
   * (generateText / streamText) — AI SDK v6 supports output on both and
   * rejects the output promise on failure, carrying the raw model text on
   * NoObjectGeneratedError.text.
   *
   * streamText quirk (review F3): when the HTTP request itself fails (e.g.
   * 400), the SDK surfaces the failure via the onError callback and rejects
   * the output promise with an opaque "No output generated. Check the stream
   * for errors." — WITHOUT statusCode/responseBody. We capture the original
   * error from onError and rethrow it in preference to the opaque wrapper so
   * tier classification sees the real provider error.
   */
  private async executeOutputCall(
    callParams: Record<string, unknown>,
  ): Promise<{ text: string; value: unknown }> {
    if (this.stream) {
      let streamError: { error: unknown } | undefined;
      const streamResult = streamText({
        ...callParams,
        onError: (event: { error: unknown }) => {
          streamError = event;
          this.logger?.debug?.(
            `${TAG} structured stream error: ${event.error instanceof Error ? event.error.message : String(event.error)}`,
          );
        },
      } as Parameters<typeof streamText>[0]);
      try {
        const value = await streamResult.output;
        const text = ((await streamResult.text) ?? "").trim();
        this.setLastUsage(await streamResult.totalUsage);
        return { text: text || JSON.stringify(value), value };
      } catch (err) {
        // If the stream itself errored, that error is the root cause —
        // the output-promise rejection is just an opaque symptom of it.
        if (streamError !== undefined) {
          throw streamError.error;
        }
        throw err;
      }
    }
    const result = await generateText(callParams as Parameters<typeof generateText>[0]);
    this.setLastUsage(result.totalUsage);
    const text = (result.text ?? "").trim();
    return { text: text || JSON.stringify(result.output), value: result.output };
  }

  /**
   * NoObjectGeneratedError = the model DID respond, but the response failed
   * JSON parsing or schema validation. Never re-call the LLM: return the raw
   * text from this same response and let the caller's legacy parser try to
   * salvage it (zero extra tokens, zero extra latency).
   */
  private salvageValidationFailure(
    err: unknown,
    params: LLMRunParams,
    startMs: number,
    tier: string,
  ): string | undefined {
    if (!NoObjectGeneratedError.isInstance(err)) return undefined;
    const text = typeof err.text === "string" ? err.text : "";
    this.setLastUsage(err.usage);
    this.logger?.warn?.(
      `${TAG} structured output validation failed (${tier} → legacy parser) taskId=${params.taskId}, ` +
      `textLen=${text.length}, cause=${err.cause instanceof Error ? err.cause.message : String(err.cause)}`,
    );
    this.reportStructuredCall(params, startMs, true, text, "validation_failed");
    return text;
  }

  private setLastUsage(usage: UsageLike): void {
    if (usage) {
      const promptTokens = usage.inputTokens ?? 0;
      const completionTokens = usage.outputTokens ?? 0;
      this.lastUsage = {
        promptTokens,
        completionTokens,
        totalTokens: usage.totalTokens ?? promptTokens + completionTokens,
      };
    } else {
      this.lastUsage = undefined;
    }
  }

  private reportStructuredCall(
    params: LLMRunParams,
    startMs: number,
    success: boolean,
    text: string,
    error: string | null,
  ): void {
    if (!params.instanceId) return;
    report("llm_call", {
      taskId: params.taskId,
      provider: "standalone",
      model: this.model,
      inputLength: params.prompt.length,
      outputLength: text.length,
      totalDurationMs: Date.now() - startMs,
      success,
      error,
    });
  }
}

/** Short evidence snippet for capability-degradation warn logs. */
function capabilityEvidence(err: unknown): string {
  if (!APICallError.isInstance(err)) return "";
  const body = (err.responseBody ?? "").replace(/\s+/g, " ").slice(0, 200);
  return body || err.message.slice(0, 200);
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
