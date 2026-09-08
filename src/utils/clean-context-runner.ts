/**
 * CleanContextRunner: executes LLM calls in a fully isolated context
 * using the host's embedded agent runner (runEmbeddedAgent / runEmbeddedPiAgent).
 *
 * Resolution order (three-level graceful degradation):
 *   1. runtime.agent.runEmbeddedAgent   — official name (OpenClaw >= 2026.5, including 8.x)
 *   2. runtime.agent.runEmbeddedPiAgent — legacy alias  (OpenClaw < 2026.8)
 *   3. dist/extensionAPI.js fallback    — file-based legacy bridge (OpenClaw < 2026.8)
 *
 * Guarantees:
 * 1. Blank conversation history (temporary session file)
 * 2. Independent system prompt (only the task prompt)
 * 3. No tool calls when enableTools=false (disableTools:true — no tool definitions sent to API)
 * 4. No contamination from the main agent's context
 */

import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getEnv } from "./env.js";
import { report } from "../core/report/reporter.js";
import { runDetachedWork } from "./detached-work.js";
import { parseVersionXYZ, compareVersionXYZ } from "./ensure-hook-policy.js";
import type { Logger } from "../core/types.js";

/**
 * Resolve a preferred temporary directory for memory-tdai operations.
 *
 * Previously imported from `openclaw/plugin-sdk` as `resolvePreferredOpenClawTmpDir`,
 * but that export was removed in openclaw 2026.2.23+. This local implementation
 * provides equivalent behavior:
 *   1. Try `/tmp/openclaw` (if writable)
 *   2. Fall back to `os.tmpdir()/openclaw-<uid>`
 */
function resolveOpenClawTmpDir(): string {
  const POSIX_DIR = "/tmp/openclaw";
  try {
    if (fsSync.existsSync(POSIX_DIR)) {
      fsSync.accessSync(POSIX_DIR, fsSync.constants.W_OK | fsSync.constants.X_OK);
      return POSIX_DIR;
    }
    // Try to create it
    fsSync.mkdirSync(POSIX_DIR, { recursive: true, mode: 0o700 });
    return POSIX_DIR;
  } catch {
    // Fall back to os.tmpdir()
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
    const suffix = uid === undefined ? "openclaw" : `openclaw-${uid}`;
    const fallback = path.join(os.tmpdir(), suffix);
    fsSync.mkdirSync(fallback, { recursive: true });
    return fallback;
  }
}

const TAG = "[memory-tdai] [runner]";

type RunnerLogger = Logger;

// Dynamic import type — the embedded agent runner function signature.
// Defined locally to avoid depending on a specific OpenClaw version's type index
// (runEmbeddedPiAgent was removed from the type exports in OpenClaw 8.x).
type RunEmbeddedAgentFn = (...args: unknown[]) => Promise<unknown>;

export interface EmbeddedAgentRuntimeLike {
  runEmbeddedAgent?: RunEmbeddedAgentFn;   // official name (OpenClaw >= 2026.5)
  runEmbeddedPiAgent?: RunEmbeddedAgentFn; // legacy alias  (OpenClaw < 2026.8)
}

let _preferredAgentRuntime: EmbeddedAgentRuntimeLike | undefined;

export function setPreferredEmbeddedAgentRuntime(
  agentRuntime: EmbeddedAgentRuntimeLike | undefined,
): void {
  _preferredAgentRuntime = agentRuntime;
}

/**
 * Three-level graceful degradation for resolving the embedded agent runner:
 *   1. runtime.agent.runEmbeddedAgent   (8.x+, also available in 7.x)
 *   2. runtime.agent.runEmbeddedPiAgent (legacy alias, available in <= 7.x)
 *   3. dist/extensionAPI.js fallback    (file-based legacy bridge)
 */
function resolveInjectedRunner(
  agentRuntime?: EmbeddedAgentRuntimeLike,
): { fn: RunEmbeddedAgentFn; source: string } | undefined {
  // ① runEmbeddedAgent (official name, preferred)
  if (typeof agentRuntime?.runEmbeddedAgent === "function") {
    return { fn: agentRuntime.runEmbeddedAgent, source: "injected:runEmbeddedAgent" };
  }
  if (typeof _preferredAgentRuntime?.runEmbeddedAgent === "function") {
    return { fn: _preferredAgentRuntime.runEmbeddedAgent, source: "preferred:runEmbeddedAgent" };
  }
  // ② runEmbeddedPiAgent (legacy alias)
  if (typeof agentRuntime?.runEmbeddedPiAgent === "function") {
    return { fn: agentRuntime.runEmbeddedPiAgent, source: "injected:runEmbeddedPiAgent" };
  }
  if (typeof _preferredAgentRuntime?.runEmbeddedPiAgent === "function") {
    return { fn: _preferredAgentRuntime.runEmbeddedPiAgent, source: "preferred:runEmbeddedPiAgent" };
  }
  return undefined;
}

async function resolveRunner(
  agentRuntime: EmbeddedAgentRuntimeLike | undefined,
  logger?: RunnerLogger,
): Promise<RunEmbeddedAgentFn> {
  const injected = resolveInjectedRunner(agentRuntime);
  if (injected) {
    logger?.debug?.(
      `${TAG} resolveRunner: using ${injected.source}`,
    );
    logger?.debug?.(`${TAG} [l1-debug] RESOLVE source=${injected.source}`);
    return injected.fn;
  }
  // ③ fallback: load from dist/extensionAPI.js (legacy bridge for very old versions)
  logger?.debug?.(`${TAG} [l1-debug] RESOLVE source=dist-fallback`);
  return loadLegacyDistBridge(logger);
}

// ── Core import (mirrors voice-call/core-bridge.ts — dist/ only, no jiti) ──

let _rootCache: string | null = null;

function findPackageRoot(startDir: string, name: string): string | null {
  let dir = startDir;
  for (;;) {
    const pkgPath = path.join(dir, "package.json");
    try {
      if (fsSync.existsSync(pkgPath)) {
        const raw = fsSync.readFileSync(pkgPath, "utf8");
        const pkg = JSON.parse(raw) as { name?: string };
        if (pkg.name === name) return dir;
      }
    } catch { /* ignore */ }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function resolveOpenClawRoot(): string {
  if (_rootCache) return _rootCache;
  const override = getEnv("OPENCLAW_ROOT")?.trim();
  if (override) { _rootCache = override; return override; }

  const candidates = new Set<string>();
  if (process.argv[1]) candidates.add(path.dirname(process.argv[1]));
  candidates.add(process.cwd());
  try { candidates.add(path.dirname(fileURLToPath(import.meta.url))); } catch { /* ignore */ }

  for (const start of candidates) {
    const found = findPackageRoot(start, "openclaw");
    if (found) { _rootCache = found; return found; }
  }
  throw new Error("Unable to resolve OpenClaw root. Set OPENCLAW_ROOT or run `pnpm build`.");
}

let _loadPromise: Promise<RunEmbeddedAgentFn> | null = null;

/**
 * Legacy fallback (level 3): dynamically load runEmbeddedPiAgent from
 * OpenClaw's dist/extensionAPI.js. This file exists in OpenClaw <= 7.x
 * but was removed in 8.x. Only reached when both injected names fail.
 */
function loadLegacyDistBridge(logger?: RunnerLogger): Promise<RunEmbeddedAgentFn> {
  if (_loadPromise) return _loadPromise;

  _loadPromise = (async () => {
    const t0 = Date.now();
    const distPath = path.join(resolveOpenClawRoot(), "dist", "extensionAPI.js");
    if (!fsSync.existsSync(distPath)) {
      throw new Error(`Missing core module at ${distPath}. This file was removed in OpenClaw 8.x. Ensure runtime.agent.runEmbeddedAgent is injected by the host, or downgrade OpenClaw to <= 7.x.`);
    }
    const mod = await import(pathToFileURL(distPath).href);
    // Try both names: runEmbeddedAgent (if exported) or runEmbeddedPiAgent (legacy)
    const fn = mod.runEmbeddedAgent ?? mod.runEmbeddedPiAgent;
    if (typeof fn !== "function") {
      throw new Error("Neither runEmbeddedAgent nor runEmbeddedPiAgent exported from dist/extensionAPI.js");
    }
    logger?.info(`${TAG} loadLegacyDistBridge: dist/ import OK (${Date.now() - t0}ms)`);
    return fn as RunEmbeddedAgentFn;
  })();

  _loadPromise.catch(() => { _loadPromise = null; });
  return _loadPromise;
}

/**
 * Pre-warm the embedded agent import. Call this during plugin init to avoid
 * the cold-start penalty on the first actual extraction run.
 * Returns immediately (fire-and-forget) — errors are swallowed.
 */
export function prewarmEmbeddedAgent(
  logger?: RunnerLogger,
  agentRuntime?: EmbeddedAgentRuntimeLike,
): void {
  if (resolveInjectedRunner(agentRuntime)) {
    logger?.debug?.(
      `${TAG} prewarmEmbeddedAgent: runtime capability already available, skipping legacy preload`,
    );
    return;
  }

  loadLegacyDistBridge(logger).catch((err) => {
    logger?.warn(`${TAG} prewarmEmbeddedAgent: failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
  });
}

function collectText(payloads: Array<{ text?: string; isError?: boolean }> | undefined): string {
  const texts = (payloads ?? [])
    .filter((p) => !p.isError && typeof p.text === "string")
    .map((p) => p.text ?? "");
  return texts.join("\n").trim();
}

// ── Model resolution utilities ──

/** Parsed model reference: { provider, model } */
export interface ModelRef {
  provider: string;
  model: string;
}

/**
 * Parse a "provider/model" string into its components.
 * Returns undefined if the input is empty or doesn't contain a "/".
 *
 * Examples:
 *   "azure/gpt-5.2-chat"          → { provider: "azure", model: "gpt-5.2-chat" }
 *   "custom-host/org/model-v2"    → { provider: "custom-host", model: "org/model-v2" }
 *   ""                            → undefined
 *   "bare-model-name"             → undefined (no "/" — may be an alias)
 */
export function parseModelRef(raw: string | undefined): ModelRef | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;

  const slashIdx = trimmed.indexOf("/");
  if (slashIdx <= 0 || slashIdx === trimmed.length - 1) return undefined;

  return {
    provider: trimmed.slice(0, slashIdx),
    model: trimmed.slice(slashIdx + 1),
  };
}

/**
 * Resolve the user's default model from the main OpenClaw config.
 *
 * Resolution order:
 * 1. Read `agents.defaults.model` (string or { primary })
 * 2. If the value contains "/", parse directly
 * 3. If not (may be an alias), look up in `agents.defaults.models` alias table
 * 4. Return undefined if nothing resolves — let the core use its built-in default
 */
export function resolveModelFromMainConfig(config: unknown): ModelRef | undefined {
  if (!config || typeof config !== "object") return undefined;

  const cfg = config as Record<string, unknown>;
  const agents = cfg.agents as Record<string, unknown> | undefined;
  if (!agents || typeof agents !== "object") return undefined;

  const defaults = agents.defaults as Record<string, unknown> | undefined;
  if (!defaults || typeof defaults !== "object") return undefined;

  // Step 1: extract raw model value (string | { primary?: string })
  const modelCfg = defaults.model;
  let raw: string | undefined;
  if (typeof modelCfg === "string") {
    raw = modelCfg.trim();
  } else if (modelCfg && typeof modelCfg === "object") {
    const primary = (modelCfg as Record<string, unknown>).primary;
    raw = typeof primary === "string" ? primary.trim() : undefined;
  }
  if (!raw) return undefined;

  // Step 2: try direct "provider/model" parse
  const direct = parseModelRef(raw);
  if (direct) return direct;

  // Step 3: alias lookup — raw doesn't contain "/", check agents.defaults.models
  const models = defaults.models as Record<string, unknown> | undefined;
  if (!models || typeof models !== "object") return undefined;

  const rawLower = raw.toLowerCase();
  for (const [key, entry] of Object.entries(models)) {
    if (!entry || typeof entry !== "object") continue;
    const alias = (entry as Record<string, unknown>).alias;
    if (typeof alias !== "string") continue;
    if (alias.trim().toLowerCase() !== rawLower) continue;

    // key is "provider/model" format
    const resolved = parseModelRef(key);
    if (resolved) return resolved;
  }

  return undefined;
}

export interface CleanContextRunnerOptions {
  config: unknown; // OpenClawConfig
  provider?: string;
  model?: string;
  /**
   * Convenience field: full "provider/model" string.
   * Takes precedence over separate `provider`/`model` fields.
   * When all three (modelRef, provider, model) are omitted,
   * automatically falls back to the main config's `agents.defaults.model`.
   */
  modelRef?: string;
  /** Preferred runtime seam. When absent, falls back to the legacy dist bridge. */
  agentRuntime?: EmbeddedAgentRuntimeLike;
  /** Allow the LLM to use tools (read_file, write_to_file, etc). Default: false */
  enableTools?: boolean;
  /** Logger instance for detailed tracing */
  logger?: RunnerLogger;
  /**
   * OpenClaw host version string (e.g. "2026.8.2").
   * Obtained from `api.runtime.version` at plugin registration time.
   * Used for version-gated behavior (e.g. sessionKey vs sessionFile).
   * When undefined, falls back to reading package.json from the OpenClaw root.
   */
  hostVersion?: string;
}

// ── OpenClaw version detection for sessionKey / sessionFile branching ──

/**
 * Minimum OpenClaw version that supports `sessionKey` (sessionFile is @deprecated).
 * Before 2026.6.11, `sessionFile: string` is a required parameter.
 */
const SESSION_KEY_MIN_XYZ: readonly [number, number, number] = [2026, 6, 11];

/** Cache: undefined = not probed, null = couldn't determine, tuple = resolved. */
let _openClawVersionXYZ: [number, number, number] | null | undefined;

/**
 * Resolve the installed OpenClaw version as [x, y, z].
 *
 * Dual-path:
 *   1. `hostVersion` from `api.runtime.version` (fast, available on newer hosts).
 *   2. Fallback: read `<openclaw-root>/package.json` via fs (works on all versions).
 *
 * Result is cached for the process lifetime.
 */
function resolveOpenClawVersionXYZ(hostVersion?: string, logger?: RunnerLogger): [number, number, number] | null {
  if (_openClawVersionXYZ !== undefined) {
    return _openClawVersionXYZ;
  }

  // ① api.runtime.version (fast path)
  const fromRuntime = parseVersionXYZ(hostVersion);
  if (fromRuntime) {
    _openClawVersionXYZ = fromRuntime;
    logger?.debug?.(`${TAG} [version-detect] resolved from api.runtime.version: ${hostVersion} → [${fromRuntime}]`);
    return fromRuntime;
  }
  logger?.debug?.(`${TAG} [version-detect] api.runtime.version unavailable (raw=${JSON.stringify(hostVersion)}), trying package.json fallback`);

  // ② package.json fallback
  try {
    const root = resolveOpenClawRoot();
    const pkgPath = path.join(root, "package.json");
    const raw = fsSync.readFileSync(pkgPath, "utf8");
    const pkg = JSON.parse(raw) as { version?: string };
    const fromPkg = parseVersionXYZ(pkg.version);
    _openClawVersionXYZ = fromPkg;
    if (fromPkg) {
      logger?.debug?.(`${TAG} [version-detect] resolved from package.json (${pkgPath}): ${pkg.version} → [${fromPkg}]`);
    } else {
      logger?.warn?.(`${TAG} [version-detect] package.json version unparsable: ${JSON.stringify(pkg.version)}`);
    }
    return fromPkg;
  } catch (err) {
    _openClawVersionXYZ = null;
    logger?.warn?.(`${TAG} [version-detect] package.json fallback failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * Should we pass `sessionKey` (>= 6.11) or `sessionFile` (< 6.11)?
 *
 * When version cannot be determined: default to `sessionFile` (safest for
 * old hosts — "cannot read api.runtime.version" is itself a strong signal
 * of an old host that needs sessionFile).
 */
function shouldUseSessionKey(hostVersion?: string, logger?: RunnerLogger): boolean {
  const xyz = resolveOpenClawVersionXYZ(hostVersion, logger);
  const use = xyz !== null && compareVersionXYZ(xyz, SESSION_KEY_MIN_XYZ) >= 0;
  logger?.debug?.(`${TAG} [version-detect] shouldUseSessionKey=${use} (resolved=[${xyz}], min=[${SESSION_KEY_MIN_XYZ}])`);
  return use;
}

// Stable empty directory used as default workspaceDir so that:
// 1. Bootstrap/skills scans find nothing → clean LLM context
// 2. The path is constant → plugin cacheKey stays stable (no re-registration)
let _cleanWorkspaceDir: string | undefined;
async function getCleanWorkspaceDir(): Promise<string> {
  if (_cleanWorkspaceDir) return _cleanWorkspaceDir;
  const dir = path.join(resolveOpenClawTmpDir(), "memory-tdai-clean-workspace");
  await fs.mkdir(dir, { recursive: true });
  _cleanWorkspaceDir = dir;
  return dir;
}

export class CleanContextRunner {
  private options: CleanContextRunnerOptions;
  private logger: RunnerLogger | undefined;
  /** Resolved provider after modelRef / config fallback */
  private resolvedProvider: string | undefined;
  /** Resolved model after modelRef / config fallback */
  private resolvedModel: string | undefined;

  constructor(options: CleanContextRunnerOptions) {
    this.options = options;
    this.logger = options.logger;

    // Model resolution priority:
    // 1. modelRef ("provider/model" string)  — highest
    // 2. explicit provider + model fields
    // 3. main config agents.defaults.model   — automatic fallback
    // 4. undefined (let core use built-in default)
    const fromRef = parseModelRef(options.modelRef);
    if (fromRef) {
      this.resolvedProvider = fromRef.provider;
      this.resolvedModel = fromRef.model;
    } else if (options.provider || options.model) {
      this.resolvedProvider = options.provider;
      this.resolvedModel = options.model;
    } else {
      // No explicit model specified — fall back to main config
      const fromConfig = resolveModelFromMainConfig(options.config);
      if (fromConfig) {
        this.resolvedProvider = fromConfig.provider;
        this.resolvedModel = fromConfig.model;
        this.logger?.debug?.(
          `${TAG} Using model from main config: ${fromConfig.provider}/${fromConfig.model}`,
        );
      }
      // else: both undefined → core will use its built-in default (anthropic/claude-opus-4-6)
    }
  }

  /**
   * Run a prompt in a fully isolated clean context.
   * Returns the LLM's text output.
   *
   * When `workspaceDir` is provided it overrides the default `process.cwd()`,
   * letting the LLM's file-tool calls resolve paths relative to a custom root.
   */
  async run(params: {
    prompt: string;
    /** Optional system prompt. When provided, `prompt` is used as the user message. */
    systemPrompt?: string;
    taskId: string;
    timeoutMs?: number;
    maxTokens?: number;
    workspaceDir?: string;
    /** Plugin instance ID for llm_call metric (optional) */
    instanceId?: string;
    /** Agent ID for OpenClaw 8.2+ session ownership check (optional, parsed from sessionKey) */
    agentId?: string;
  }): Promise<string> {
    const runStartMs = Date.now();
    this.logger?.debug?.(`${TAG} run() start: taskId=${params.taskId}, timeout=${params.timeoutMs ?? 120_000}ms, tools=${this.options.enableTools ? "enabled" : "disabled"}, workspaceDir=${params.workspaceDir ?? "(default)"}`);

    const tmpDir = await fs.mkdtemp(
      path.join(resolveOpenClawTmpDir(), `memory-tdai-${params.taskId}-`),
    );
    const cleanWorkspace = params.workspaceDir ?? await getCleanWorkspaceDir();
    this.logger?.debug?.(`${TAG} run() tmpDir=${tmpDir}, cleanWorkspace=${cleanWorkspace}`);

    try {
      // Phase 1: Resolve embedded agent runner (three-level graceful degradation)
      const importStartMs = Date.now();
      const embeddedAgentRunner = await resolveRunner(
        this.options.agentRuntime,
        this.logger,
      );
      const importElapsedMs = Date.now() - importStartMs;
      this.logger?.debug?.(`${TAG} run() runner resolution phase: ${importElapsedMs}ms`);

      // Derive a config with plugins disabled to prevent loadOpenClawPlugins
      // from re-registering plugins when the workspaceDir differs from the
      // gateway's original workspace (cacheKey mismatch triggers full reload).
      //
      // Security: restrict available tools to the minimal set needed for
      // scene extraction (read/write/edit). This prevents the LLM from
      // accessing exec, sessions, browser, cron, or any other powerful tools.
      // File deletion is handled via "soft-delete" (write empty) + cleanup afterward.
      const cleanConfig = {
        ...(this.options.config as Record<string, unknown>),
        plugins: {
          ...((this.options.config as Record<string, unknown>)?.plugins as Record<string, unknown> | undefined),
          enabled: false,
        },
        tools: {
          ...((this.options.config as Record<string, unknown>)?.tools as Record<string, unknown> | undefined),
          // When enableTools=true, restrict to the minimal set needed for
          // scene extraction (read/write/edit).
          // When enableTools=false, pass an empty allow list — disableTools:true
          // will prevent tools from being sent to the API entirely.
          allow: this.options.enableTools ? ["read", "write", "edit"] : [],
        },
        // Override the full agent system prompt with the caller's extraction-specific
        // system prompt. This replaces OpenClaw's default system prompt (identity,
        // AGENTS.md, workspace context, tool guidance, etc.) to:
        //   1. Save ~5000 tokens per LLM call
        //   2. Avoid instruction interference with extraction prompts
        agents: {
          ...((this.options.config as Record<string, unknown>)?.agents as Record<string, unknown> | undefined),
          defaults: {
            ...(((this.options.config as Record<string, unknown>)?.agents as Record<string, unknown> | undefined)?.defaults as Record<string, unknown> | undefined),
            systemPromptOverride:
              params.systemPrompt ||
              "You are a precise data extraction and generation assistant. Follow the user instructions exactly. Respond only with the requested output format.",
          },
        },
      };

      // systemPrompt is now in config.agents.defaults.systemPromptOverride
      // (actual [system] role), so user prompt only contains the actual content.
      const effectivePrompt = params.prompt;

      const ts = Date.now();
      const sessionId = `memory-${params.taskId}-session-${ts}`;
      const runId = `memory-${params.taskId}-run-${ts}`;

      // Version-gated session identity: sessionKey (>= 6.11) vs sessionFile (< 6.11).
      // Cannot pass both — 8.2's ownership checker rejects non-marker sessionFile
      // when sessionKey is also present. See 8.x版本兼容方案-问题3 for details.
      const useSessionKey = shouldUseSessionKey(this.options.hostVersion, this.logger);
      const sessionKey = `agent:${params.agentId ?? "main"}:${sessionId}`;
      const sessionFile = path.join(tmpDir, "session.json");
      this.logger?.debug?.(`${TAG} run() session identity: useSessionKey=${useSessionKey}, sessionId=${sessionId}, runId=${runId}, provider=${this.resolvedProvider ?? "(default)"}, model=${this.resolvedModel ?? "(default)"}`);

      // [l1-debug] INVOKE — what are we about to send to the embedded agent?
      const sysPromptOverrideLen =
        ((cleanConfig.agents as Record<string, unknown> | undefined)?.defaults as Record<string, unknown> | undefined)?.systemPromptOverride
          ? String(
              ((cleanConfig.agents as Record<string, unknown>).defaults as Record<string, unknown>).systemPromptOverride,
            ).length
          : 0;
      const toolsAllow =
        ((cleanConfig.tools as Record<string, unknown> | undefined)?.allow as unknown[] | undefined) ?? [];
      this.logger?.debug?.(
        `${TAG} [l1-debug] INVOKE taskId=${params.taskId}, provider=${this.resolvedProvider ?? "(default)"}, model=${this.resolvedModel ?? "(default)"}, promptLen=${effectivePrompt.length}, sysPromptOverrideLen=${sysPromptOverrideLen}, toolsAllow=${JSON.stringify(toolsAllow)}, timeoutMs=${params.timeoutMs ?? 120_000}`,
      );

      // Phase 2: Embedded agent run (LLM call + tool calls)
      // Wrapped in runDetachedWork to acquire an independent gateway root work
      // admission on OpenClaw >= 7.2. Without this, async L1/L2/L3 calls after
      // agent_end are rejected with GatewayDrainingError because the parent
      // rootWork is already released. On <= 7.1-2 (no admission mechanism)
      // runDetachedWork falls back to direct execution.
      const agentStartMs = Date.now();
      // extraSystemPrompt: fallback for openclaw < 2026.4.7 which does not support
      // config.agents.defaults.systemPromptOverride. On newer versions the
      // override takes precedence and this becomes a no-op append.
      const effectiveSystemPrompt =
        params.systemPrompt ||
        "You are a precise data extraction and generation assistant. Follow the user instructions exactly. Respond only with the requested output format.";
      const result = await runDetachedWork(() => embeddedAgentRunner({
        sessionId,
        // Version-gated: >= 6.11 uses sessionKey; < 6.11 uses sessionFile.
        // MUST NOT pass both — 8.2 ownership checker rejects non-marker sessionFile.
        ...(useSessionKey ? { sessionKey } : { sessionFile }),
        workspaceDir: cleanWorkspace,
        config: cleanConfig,
        prompt: effectivePrompt,
        timeoutMs: params.timeoutMs ?? 120_000,
        runId,
        provider: this.resolvedProvider,
        model: this.resolvedModel,
        // OpenClaw 8.2+ session ownership: agentId identifies the owning agent.
        // Optional — 7.x ignores it; 8.x requires it for resolveSqliteScope.
        ...(params.agentId ? { agentId: params.agentId } : {}),
        // When enableTools=false, pass disableTools:true so that no tool
        // definitions are sent to the API. This avoids polluting the LLM
        // context with tool schemas and prevents the model from attempting
        // tool calls during pure text extraction tasks.
        // If a provider (e.g. qwencode) rejects empty tools[], users should
        // switch to StandaloneLLMRunner via LLM configuration instead.
        disableTools: !this.options.enableTools,
        extraSystemPrompt: effectiveSystemPrompt,
        streamParams: {
          maxTokens: params.maxTokens,
        },
      }), this.logger);
      const agentElapsedMs = Date.now() - agentStartMs;
      this.logger?.debug?.(`${TAG} run() embedded agent completed: ${agentElapsedMs}ms`);

      // [l1-debug] RESULT — what did the embedded agent return?
      {
        const payloadsRaw = (result as Record<string, unknown> | undefined)?.payloads;
        const payloads = Array.isArray(payloadsRaw)
          ? (payloadsRaw as Array<Record<string, unknown>>)
          : [];
        const payloadKinds = payloads.map((p) => {
          if (typeof p?.type === "string") return p.type as string;
          if (typeof p?.kind === "string") return p.kind as string;
          return Object.keys(p ?? {}).slice(0, 3).join("|") || "unknown";
        });
        const errorPayloadCount = payloads.filter((p) => p?.isError === true).length;
        const joinedText = payloads
          .filter((p) => !p?.isError && typeof p?.text === "string")
          .map((p) => String(p.text ?? ""))
          .join("\n");
        const textPreview = joinedText.replace(/\s+/g, " ").slice(0, 200);
        this.logger?.debug?.(
          `${TAG} [l1-debug] RESULT taskId=${params.taskId}, elapsedMs=${agentElapsedMs}, payloadCount=${payloads.length}, payloadKinds=${JSON.stringify(payloadKinds)}, errorPayloadCount=${errorPayloadCount}, textLen=${joinedText.length}, textPreview=${JSON.stringify(textPreview)}`,
        );
      }

      // Phase 3: Collect output
      const text = collectText((result as Record<string, unknown>).payloads as Array<{ text?: string; isError?: boolean }> | undefined);
      const totalMs = Date.now() - runStartMs;

      if (!text) {
        // Empty output is normal when the LLM decides there is nothing to
        // extract (e.g. trivial greetings).  Log a warning instead of
        // throwing so the caller can handle it gracefully.
        this.logger?.warn?.(`${TAG} run() empty output after ${totalMs}ms (import=${importElapsedMs}ms, agent=${agentElapsedMs}ms) — treating as empty result`);
        // [l1-debug] EMPTY_DUMP — dump the full result shape so we can see where text went
        try {
          const dump = JSON.stringify(result, (_k, v) => {
            if (typeof v === "string" && v.length > 500) return v.slice(0, 500) + `…(+${v.length - 500})`;
            return v;
          }).slice(0, 2048);
          this.logger?.warn?.(`${TAG} [l1-debug] EMPTY_DUMP taskId=${params.taskId}, resultJson=${dump}`);
        } catch (dumpErr) {
          this.logger?.warn?.(`${TAG} [l1-debug] EMPTY_DUMP taskId=${params.taskId}, dumpFailed=${dumpErr instanceof Error ? dumpErr.message : String(dumpErr)}`);
        }
        // llm_call metric (empty output)
        if (params.instanceId && this.logger) {
          report("llm_call", {
            taskId: params.taskId,
            provider: this.resolvedProvider ?? "default",
            model: this.resolvedModel ?? "default",
            inputLength: params.prompt.length,
            outputLength: 0,
            totalDurationMs: totalMs,
            success: true,
            error: "empty_output",
          });
        }
        return "";
      }

      this.logger?.debug?.(`${TAG} run() completed: ${totalMs}ms total (import=${importElapsedMs}ms, agent=${agentElapsedMs}ms), output=${text.length} chars`);

      // ── llm_call metric (success) ──
      if (params.instanceId && this.logger) {
        report("llm_call", {
          taskId: params.taskId,
          provider: this.resolvedProvider ?? "default",
          model: this.resolvedModel ?? "default",
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
      this.logger?.error(`${TAG} run() failed after ${totalMs}ms: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
      // ── llm_call metric (failure) ──
      if (params.instanceId && this.logger) {
        report("llm_call", {
          taskId: params.taskId,
          provider: this.resolvedProvider ?? "default",
          model: this.resolvedModel ?? "default",
          inputLength: params.prompt.length,
          outputLength: 0,
          totalDurationMs: totalMs,
          success: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      throw err;
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}
