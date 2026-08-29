/**
 * Guard Adapter — minimal bridge between host project and @context-proxy/cost-guard.
 *
 * This file and its sibling `request-prepare-adapter.ts` are the only two in
 * the host that import the cost-guard package: this one owns the *routing* half
 * (where a request goes), the sibling owns the *request-preparation* half (an
 * optional rewrite of the outgoing body). Keep every other module free of it.
 *
 * It maps host's ProxyConfig → GuardConfig and injects host's log/opik as GuardDeps.
 *
 * **Graceful degradation**: If the private extension package is not available
 * (e.g. submodule not initialized), all functions fall back to a passthrough
 * mode that forwards requests directly to the default upstream.
 *
 * Re-exports for handler convenience:
 *   ForwardTarget, ForwardTargetRequest
 */

import type { ProxyConfig } from "./types.js";
import { log } from "./report/log.js";
import { RedisSessionStore } from "./redis-session-store.js";
import { matchWhitelistEndpoint } from "./routes/whitelist.js";
import { opikCreateTrace, opikCreateLlmSpan, uuidv7 } from "./opik.js";
import { langfuseReportGeneration } from "./langfuse.js";
import { judgeAgentTurn, judgeUserTurn, readJudgeTransport } from "./judge-client.js";

// Optional Opik/Langfuse hooks — invoked only when the private extension is loaded
// and produces telemetry. Kept out of the primary bridge flow to avoid coupling
// the passthrough path with observability wiring.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ExtensionTelemetry = { duration: number; input: string; output: string; model: string; usage: Record<string, unknown>; tags: string[] };
type ExtensionTelemetryCtx = {
  traceId: string;
  langfuseTraceId?: string;
  traceName?: string;
  traceTags?: string[];
  keyId: string;
  sessionKey: string;
  turnSeq: number;
  startTime: string;
  spaceId?: string;
  triggeredBy?: string;
};

// ─── Transport types (host-side, generic) ───────────────────────────────────

/** Retry fallback target. */
interface RetryTarget {
  url: string;
  model: string;
  authHeaders: Record<string, string> | null;
}

/** Analyzer trace returned by cost-guard for host observability. */
export interface AnalyzerTrace {
  duration: number;
  input: string;
  output: string;
  model: string;
  usage: Record<string, unknown>;
  tags: string[];
}

/**
 * ForwardTarget — the generic forwarding instruction returned by the extension.
 *
 * Routing semantics remain opaque, but observability fields are preserved so
 * the host can attach route/judge attribution to its own logs and traces.
 */
export interface ForwardTarget {
  url: string;
  model: string;
  authHeaders: Record<string, string> | null;
  bodyOverrides: Record<string, unknown> | null;
  retryTarget: RetryTarget | null;
  logLine: string;
  logLineExtra: string;
  tags: string[];
  analyzerTrace: AnalyzerTrace | null;
  logMeta: Record<string, unknown>;
  /**
   * Monotonic per-session turn sequence number provided by the extension.
   * 0 = not tracked (extension disabled/unavailable) — the handler falls back
   * to its stateless countHumanTurns() in that case. Survives context
   * compaction, unlike the stateless count, so (sessionKey, turnSeq) stays
   * collision-free.
   */
  turnSeq: number;
  /**
   * The model the client asked for, when the extension chose to forward to a
   * different one. "" = forwarded as requested, which is also what every
   * passthrough returns.
   *
   * Carried for cost accounting only: `credit_saved` prices one usage record
   * twice, once under this model and once under the model actually called. The
   * host never makes a forwarding decision from it.
   */
  routedFrom: string;
}

/** resolveForwardTarget 的输入参数。 */
export interface ForwardTargetRequest {
  keyId: string;
  messages: unknown[];
  protocol: "openai" | "anthropic";
  hasTools: boolean;
  body: Record<string, unknown>;
  modelId: string;
  defaultUpstreamUrl: string;
  requestPath: string;
  /** 原始请求头（小写键），用于 agent profile 检测与 session key 解析。 */
  headers?: Record<string, string>;
  /** Parent trace ID for observability reporting (Opik/Langfuse). */
  traceId?: string;
  /** ISO 8601 timestamp when the request started. */
  startTime?: string;
  /** Space/tenant ID extracted from the request path. */
  spaceId?: string;
  /**
   * When true, run the request through the cost-guard extension. When
   * false / undefined (the default) the handler returns a passthrough target
   * that forwards directly to `defaultUpstreamUrl` — cost-guard is opt-in per
   * request via the `/cost-guard` URL marker (see `hasCostGuardMarker`).
   */
  useGuard?: boolean;
  /**
   * Agent name extracted from URL path prefix (e.g. "claude-code", "codebuddy").
   * Used by the cost-guard extension to look up per-agent cheap model overrides.
   * Optional — if not provided, falls back to top-level cheap config.
   */
  agentName?: string;
}

// ─── Dynamic import + passthrough fallback ──────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let CostGuardClass: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let extensionModule: any = null;
let setDebugFn: ((enabled: boolean) => void) | null = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let resolveAgentProfileFn: ((ctx: any, pinned?: string) => any) | null = null;
let costGuardAvailable = false;

// Try to load the private extension package at module init time.
// If the submodule is not initialized, we silently fall back to passthrough.
// Use a variable to prevent TypeScript from statically resolving the module.
const COST_GUARD_MODULE = "@context-proxy/cost-guard";
try {
  const mod = await import(/* @vite-ignore */ COST_GUARD_MODULE);
  extensionModule = mod;
  CostGuardClass = mod.CostGuard;
  setDebugFn = mod.setAnalyzerDebug;
  resolveAgentProfileFn = mod.resolveAgentProfile;
  costGuardAvailable = true;
} catch {
  // extension not available — passthrough mode
}

/** Whether the private extension package is loaded. */
export function isCostGuardAvailable(): boolean {
  return costGuardAvailable;
}

/**
 * Toggle the extension's debug logging.
 * No-op if the extension is not available.
 */
export function setExtensionDebug(enabled: boolean): void {
  if (setDebugFn) {
    setDebugFn(enabled);
  }
}

/**
 * Start the private management listener using opaque extension options. The
 * host neither parses MongoDB settings nor owns the control-plane protocol.
 */
export async function startPrivateControlPlane(config: ProxyConfig): Promise<boolean> {
  if (!extensionModule || typeof extensionModule.startManagedControlPlane !== "function") return false;
  const requestPrepare = config.costGuard.options.requestPrepare;
  const compressorEnabled = Boolean(
    requestPrepare &&
    typeof requestPrepare === "object" &&
    !Array.isArray(requestPrepare) &&
    (requestPrepare as Record<string, unknown>).enabled === true,
  );
  return extensionModule.startManagedControlPlane(
    config.costGuard.options,
    { routerEnabled: config.costGuard.enabled, compressorEnabled },
  ) as Promise<boolean>;
}

/** Stop the private management listener during host shutdown. */
export async function shutdownPrivateControlPlane(): Promise<void> {
  if (!extensionModule || typeof extensionModule.shutdownManagedControlPlane !== "function") return;
  await extensionModule.shutdownManagedControlPlane();
}

// ─── Singleton CostGuard instance ────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let guardInstance: any = null;

/** Singleton Redis session store (shared across guard instances). */
let redisSessionStore: RedisSessionStore | null = null;

/**
 * Get the singleton extension instance (creates on first call).
 * Returns null if the extension is not available.
 */
function getCostGuard(config: ProxyConfig): unknown {
  if (!costGuardAvailable || !CostGuardClass) return null;
  if (!guardInstance) {
    // Opaque private options are forwarded to the extension untouched; the host
    // never inspects or defaults any of the extension's routing parameters.
    const options: Record<string, unknown> = { ...config.costGuard.options };
    const extraOptions = options.badcaseCollector;
    delete options.badcaseCollector;
    // Belongs to the request-preparation adapter, not the router. Dropping it
    // keeps credentials nested inside it out of a component that has no use
    // for them.
    delete options.requestPrepare;
    const guardConfig = {
      ...options,
      enabled: config.costGuard.enabled,
      agentProfile: config.costGuard.agentProfile,
      anthropicUpstreamUrl: config.costGuard.anthropicUpstream?.url ?? "",
    };

    // Create session store based on config. Redis is required for the
    // extension's task-archive / judge side keys in multi-instance deploys.
    // When Redis is off, inject the extension's in-memory store so the new
    // FileSessionStore default does not write ~/.cost-guard on this host.
    let sessionStore: unknown;
    if (config.redis.enabled) {
      redisSessionStore = new RedisSessionStore(config.redis);
      sessionStore = redisSessionStore;
      log.info("guard_adapter.redis_session_store", { keyPrefix: config.redis.keyPrefix });
    } else {
      try {
        const MemoryStore = extensionModule.MemorySessionStore as (new () => unknown) | undefined;
        if (typeof MemoryStore === "function") {
          sessionStore = new MemoryStore();
          log.info("guard_adapter.memory_session_store", {});
        }
      } catch {
        // Older / mocked extension modules may not export MemorySessionStore.
      }
    }

    const judgeTransport = readJudgeTransport(options);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    guardInstance = new CostGuardClass(guardConfig, {
      log,
      sessionStore,
      ...(judgeTransport
        ? {
            judgeAgentTurn: async (request: {
              sessionKey: string;
              messages: unknown[];
            }) => judgeAgentTurn(judgeTransport, {
              sessionId: request.sessionKey,
              messages: request.messages,
            }),
            judgeUserTurn: async (request: {
              sessionKey: string;
              userQuery: string;
              requestId?: string;
            }) => judgeUserTurn(judgeTransport, {
              sessionId: request.sessionKey,
              userQuery: request.userQuery,
              requestId: request.requestId,
            }),
          }
        : {}),

      // ── Badcase reporting: structured event to Opik ──
      reportBadcase: (report: Record<string, unknown>) => {
        const traceId = uuidv7();
        const now = new Date().toISOString();
        const input: Record<string, unknown> = {
          route: report.route,
          confidence: report.confidence,
          reason: report.reason,
        };
        if (report.reason === "user_negative") {
          input.user_signal_text = report.userSignalText;
        } else {
          input.review_reason = report.reviewReason;
        }
        opikCreateTrace(config, {
          traceId,
          projectName: "context-proxy-badcases",
          name: `badcase-${report.reason}`,
          startTime: now,
          input,
          tags: [report.reason as string],
        });
      },

    });

    // Forward the optional opaque review options to the extension, if supported.
    if (guardInstance.setBadcaseConfig && extraOptions !== undefined) {
      guardInstance.setBadcaseConfig(extraOptions);
    }
  }
  return guardInstance;
}

// ─── URL resolution ─────────────────────────────────────────────────────────

/**
 * Join a base URL with the standard endpoint extracted from the request path.
 *
 * 从 `WHITELIST_ENDPOINTS` 表匹配用户请求路径对应的 upstream endpoint。
 * 匹配时会自动剥离 `/proxy/{spaceId}` 前缀与 query string。
 *
 * 兜底行为：若请求路径不在白名单内，退回历史默认（`/chat/completions`），
 * 并打 `log.warn("joinUrl.fallback")`，便于后续观察是否有需要补入白名单的端点。
 *
 * @exported for unit testing; not part of the module's public API surface.
 */
export function joinUrl(base: string, requestPath: string): string {
  const normalizedBase = base.replace(/\/+$/, "");
  const baseWithoutQuery = normalizedBase.split("?")[0] ?? normalizedBase;

  // agentUpstreams 或完整 endpoint base 已含路径时勿再拼接。
  if (
    baseWithoutQuery.endsWith("/messages") ||
    baseWithoutQuery.endsWith("/chat/completions")
  ) {
    return normalizedBase;
  }

  const entry = matchWhitelistEndpoint(requestPath);
  if (entry) {
    return `${normalizedBase}${entry.upstreamEndpoint}`;
  }

  // Fallback: 按请求路径后缀推断 Anthropic / OpenAI endpoint。
  const endpoint = requestPath.endsWith("/messages")
    ? "/messages"
    : "/chat/completions";
  log.warn("joinUrl.fallback", { requestPath, endpoint });
  return `${normalizedBase}${endpoint}`;
}

function buildPassthroughTarget(req: ForwardTargetRequest): ForwardTarget {
  return {
    url: joinUrl(req.defaultUpstreamUrl, req.requestPath),
    model: req.modelId,
    authHeaders: null,
    bodyOverrides: null,
    retryTarget: null,
    logLine: "passthrough",
    logLineExtra: "",
    tags: [],
    analyzerTrace: null,
    logMeta: {},
    turnSeq: 0,
    routedFrom: "",
  };
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Gracefully close the Redis session store connection (if active).
 * Call during process shutdown.
 */
export async function shutdownGuard(): Promise<void> {
  if (redisSessionStore) {
    await redisSessionStore.close();
    redisSessionStore = null;
  }
}

/**
 * Resolve the per-conversation session key from request headers via the agent
 * profile. Falls back to `fallbackKeyId` when the profile provides no session
 * header (or when cost-guard is unavailable).
 */
export function resolveSessionKey(
  config: ProxyConfig,
  headers: Record<string, string>,
  path: string,
  body: Record<string, unknown>,
  fallbackKeyId: string,
): string {
  if (!resolveAgentProfileFn) return fallbackKeyId;
  try {
    const profile = resolveAgentProfileFn({ headers, path, body }, config.costGuard.agentProfile);
    const sessionKey = profile.sessionKey(headers);
    return sessionKey || fallbackKeyId;
  } catch {
    return fallbackKeyId;
  }
}

/**
 * Resolve the denoised latest user query via the agent profile.
 *
 * Returns the user's real question (IDE noise / system-reminders stripped) on a
 * fresh human turn, and "" on a tool-loop continuation (last user message is a
 * pure tool_result) or when cost-guard is unavailable. Used as the turn trace's
 * input so it reflects the user's actual ask rather than the raw request body.
 */
export function resolveLatestUserQuery(
  config: ProxyConfig,
  headers: Record<string, string>,
  path: string,
  body: Record<string, unknown>,
  messages: unknown[],
): string {
  if (!resolveAgentProfileFn) return "";
  try {
    const profile = resolveAgentProfileFn({ headers, path, body }, config.costGuard.agentProfile);
    return profile.latestUserQuery(messages) || "";
  } catch {
    return "";
  }
}

/**
 * Resolve forwarding target.
 *
 * If the extension is available and enabled, delegates to its
 * resolveForwardTarget(). Otherwise returns a passthrough target that forwards
 * directly to defaultUpstreamUrl.
 *
 * The caller normalizes `req.requestPath` to the canonical upstream endpoint
 * (e.g. "/messages", "/chat/completions") so the extension's own URL joining
 * matches the host's whitelist behavior; the host then trusts the returned
 * `url`/`retryTarget.url` verbatim and only keeps transport-level fields.
 */
export async function resolveForwardTarget(
  config: ProxyConfig,
  req: ForwardTargetRequest,
): Promise<ForwardTarget> {
  // Passthrough paths — all return the same shape; the reason is logged so we
  // can tell *why* a given request skipped the extension after the fact.
  // default_passthrough is the new default (no marker on the URL — info so
  // routine traffic remains greppable); the other two are deployment state
  // that's already visible at startup (debug — replay with LOG_LEVEL=debug
  // when troubleshooting).
  if (!req.useGuard) {
    log.info("guard_adapter.passthrough", { reason: "default_passthrough", requestPath: req.requestPath });
    return buildPassthroughTarget(req);
  }
  const guard = getCostGuard(config);
  if (!guard) {
    log.debug("guard_adapter.passthrough", { reason: "extension_unavailable", requestPath: req.requestPath });
    return buildPassthroughTarget(req);
  }
  // Preserve the historical master switch unless the private control plane is
  // configured to make a request-specific activation decision.
  if (!config.costGuard.enabled && config.costGuard.options.controlPlane === undefined) {
    log.debug("guard_adapter.passthrough", { reason: "extension_disabled", requestPath: req.requestPath });
    return buildPassthroughTarget(req);
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw = (await (guard as any).resolveForwardTarget(req)) as {
    url: string;
    model: string;
    authHeaders: Record<string, string> | null;
    bodyOverrides: Record<string, unknown> | null;
    retryTarget: RetryTarget | null;
    logLine?: string;
    logLineExtra?: string;
    tags?: unknown[];
    analyzerTrace?: AnalyzerTrace | null;
    turnSeq?: number;
    logMeta?: Record<string, unknown>;
  };

  // The extension stamps `logMeta.routedFrom` only when it forwarded to a model
  // other than the requested one; the rest of that blob stays opaque.
  const routedFrom = raw.logMeta?.routedFrom;

  return {
    url: raw.url,
    model: raw.model,
    authHeaders: raw.authHeaders ?? null,
    bodyOverrides: raw.bodyOverrides ?? null,
    retryTarget: raw.retryTarget ?? null,
    logLine: typeof raw.logLine === "string" ? raw.logLine : "",
    logLineExtra: typeof raw.logLineExtra === "string" ? raw.logLineExtra : "",
    tags: Array.isArray(raw.tags)
      ? raw.tags.filter((tag): tag is string => typeof tag === "string")
      : [],
    analyzerTrace: raw.analyzerTrace ?? null,
    logMeta: raw.logMeta && typeof raw.logMeta === "object" ? raw.logMeta : {},
    turnSeq: raw.turnSeq ?? 0,
    routedFrom: typeof routedFrom === "string" ? routedFrom : "",
  };
}

// ─── Extension telemetry forwarding (used only when the private extension is loaded) ───

/** Forward a returned analyzer trace after the host has created its turn trace. */
export function reportAnalyzerTrace(
  config: ProxyConfig,
  trace: AnalyzerTrace,
  ctx: ExtensionTelemetryCtx,
): void {
  forwardExtensionTelemetry(config, trace, ctx);
}

/**
 * Forward an opaque telemetry payload from the private extension to the
 * configured observability sinks (Opik + Langfuse). The payload shape is
 * owned by the extension; the host merely passes it through without
 * interpretation.
 *
 * This function is never called when the extension is unavailable
 * (passthrough mode).
 */
function forwardExtensionTelemetry(
  config: ProxyConfig,
  trace: ExtensionTelemetry,
  ctx: ExtensionTelemetryCtx,
): void {
  const endTime = new Date().toISOString();
  const sessionId = ctx.sessionKey || ctx.keyId;
  const sessionSuffix = `:${sessionId}`;
  const pureKeyId = ctx.keyId.endsWith(sessionSuffix)
    ? ctx.keyId.slice(0, -sessionSuffix.length)
    : ctx.keyId;
  const tags = [...(trace.tags || []), `session:${sessionId}`];

  opikCreateLlmSpan(config, {
    traceId: ctx.traceId,
    projectName: pureKeyId,
    name: `[internal] ${trace.model}`,
    startTime: ctx.startTime,
    endTime,
    inputMessages: trace.input ? [{ role: "user", content: trace.input }] : [],
    outputMessage: trace.output ? { role: "assistant", content: trace.output } : null,
    model: trace.model,
    usage: trace.usage,
    tags,
  });

  if (trace.duration > 0) {
    const end = new Date(Date.parse(ctx.startTime) + trace.duration).toISOString();
    langfuseReportGeneration({
      traceId: ctx.langfuseTraceId ?? ctx.traceId,
      name: `[internal] ${trace.model}`,
      model: trace.model,
      startTime: ctx.startTime,
      endTime: end,
      input: trace.input ? [{ role: "user", content: trace.input }] : undefined,
      output: trace.output ? { role: "assistant", content: trace.output } : undefined,
      usage: trace.usage && Object.keys(trace.usage).length > 0 ? trace.usage : undefined,
      traceName: ctx.traceName ?? `${trace.model} / ${pureKeyId}`,
      userId: pureKeyId,
      sessionId,
      tags: ctx.traceTags ?? [`session:${sessionId}`],
      observationMetadata: { kind: "internal", tags: trace.tags },
    });
  }
}
