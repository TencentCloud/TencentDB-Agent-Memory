/**
 * Request-Preparation Adapter — the host's second (and last) bridge to the
 * optional private extension package, sibling to `guard-adapter.ts`.
 *
 * `guard-adapter.ts` owns the *routing* half of the extension: deciding where a
 * request goes. This file owns the *request-preparation* half: an optional
 * stage that runs immediately before the upstream request body is built, and
 * which may rewrite that body (and its message array) in place.
 *
 * The host is deliberately opaque to what the rewriting actually does. It hands
 * the extension one untouched slice of the opaque `costGuard.options` payload
 * plus the transport context of the pending upstream call, and gets back a
 * result it never interprets — only a flat scalar projection of it is forwarded
 * to the observability sinks. No stage semantics, thresholds, heuristics, or
 * algorithm names live in this repo; they are owned entirely by the extension.
 *
 * That opacity is the point: this package is published, the extension is not.
 *
 * ### Configuration
 *
 * Nothing new is parsed by the host. `parseCostGuard()` already folds every
 * unrecognized key under the YAML `costGuard:` block into `costGuard.options`
 * verbatim, so the stage is configured by adding one key there:
 *
 * ```yaml
 * costGuard:
 *   requestPrepare:      # opaque — shape is owned by the private extension
 *     enabled: true
 *     ...
 * ```
 *
 * Absent that key the stage is dormant and every export here is a no-op. It
 * shares the `costGuard:` block for lack of a better home, but not the
 * `costGuard.enabled` switch: that one governs routing, and the two are
 * independently useful.
 *
 * ### Graceful degradation
 *
 * The extension is an optional peer dependency, so it is simply missing in most
 * builds. Every export tolerates that, tolerates an extension too old to expose
 * a given entry point, and tolerates the stage throwing: the request forwards
 * unchanged rather than failing. Preparation is an optimization, never a
 * correctness requirement.
 */

import type { ProxyConfig } from "./types.js";
import type { Pipeline } from "./logger.js";
import { log } from "./report/log.js";
import { langfuseReportGeneration, type LangfuseTurnContext } from "./langfuse.js";
import { opikCreateLlmSpan } from "./opik.js";

// ─── Dynamic import + no-op fallback ────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _mod: any = null;
let _available = false;

/**
 * Response cleanup policy keyed by the scalar stats object returned to a
 * handler. WeakMap keeps extension-only metadata out of logs/ClickHouse and
 * releases it with the request.
 */
const responseCleanupPolicies = new WeakMap<Record<string, unknown>, ReadonlySet<string>>();

const EXTENSION_MODULE = "@context-proxy/cost-guard";
try {
  _mod = await import(/* @vite-ignore */ EXTENSION_MODULE);
  _available = true;
} catch {
  // Extension package not installed — every export below degrades to a no-op.
}

/**
 * The opaque per-stage payload, or `undefined` when the stage is off.
 *
 * Deliberately independent of `costGuard.enabled`: that switch governs
 * routing, and an operator may well want the request rewritten without letting
 * the extension pick the upstream. The stage is on when its own block exists
 * and something can still say yes to a given request.
 *
 * `enabled` is the only key the host ever reads out of the payload — it is a
 * generic switch that says nothing about what the stage does, and reading it
 * keeps startup logging honest. Everything else stays opaque.
 *
 * That switch is a deployment *default*, not a verdict: when the control plane
 * is configured it decides per request, so `enabled: false` has to keep the
 * stage wired or the operator would be left with an off switch and no on
 * switch. `guard-adapter.ts` treats `costGuard.enabled` the same way, for the
 * same reason. With no control plane the default is all there is, and the stage
 * stays dormant.
 */
/**
 * Router `analyze*` credentials already live on `costGuard.options`. The host
 * does not interpret `requestPrepare` — it only copies these sibling keys so
 * the extension can default its own fields when they are omitted.
 *
 * Keys stay `analyzeModel` / `analyzeUrl` / `analyzeApiKey`. Never fold them
 * onto `url` / `apiKey`: `requestPrepare.url` is the compressor endpoint.
 */
export function copyAnalyzeSiblings(options: Record<string, unknown>): {
  analyzeModel?: string;
  analyzeUrl?: string;
  analyzeApiKey?: string;
} {
  const out: Record<string, string> = {};
  for (const key of ["analyzeModel", "analyzeUrl", "analyzeApiKey"] as const) {
    const value = options[key];
    if (typeof value === "string" && value.trim() !== "") out[key] = value;
  }
  return out;
}

function stageOptions(config: ProxyConfig): Record<string, unknown> | undefined {
  const opts = config.costGuard.options.requestPrepare;
  if (!opts || typeof opts !== "object") return undefined;
  const payload = opts as Record<string, unknown>;
  const controlPlane = config.costGuard.options.controlPlane;
  if (payload.enabled === false && controlPlane === undefined) return undefined;
  // The extension owns this shared private configuration. The host forwards it
  // as an opaque value and does not parse its shape.
  return { ...payload, controlPlane, ...copyAnalyzeSiblings(config.costGuard.options) };
}

/**
 * Whether the stage is wired for this config: its resources are worth bringing
 * up and its hooks will be called. It says nothing about whether any individual
 * request gets prepared — that is the extension's call, per request.
 */
export function isRequestPrepareActive(config: ProxyConfig): boolean {
  return _available && _mod !== null && stageOptions(config) !== undefined;
}

/**
 * Whether the stage prepares requests by default, as opposed to waiting for the
 * control plane to turn it on. Startup logging only: it exists so an operator
 * reading the boot log can tell "on" from "on if the control plane says so".
 */
export function isRequestPrepareEnabledByDefault(config: ProxyConfig): boolean {
  const opts = config.costGuard.options.requestPrepare;
  if (!opts || typeof opts !== "object") return false;
  return (opts as Record<string, unknown>).enabled !== false;
}

/** Bridge the host logger into the shape the extension expects. */
const extensionLogger = {
  info: (msg: string, meta?: Record<string, unknown>) => log.info(msg, meta),
  warn: (msg: string, meta?: Record<string, unknown>) => log.warn(msg, meta),
};

// ─── Lifecycle ──────────────────────────────────────────────────────────────

/**
 * Bring up whatever process-wide resources the stage needs (caches, model
 * warm-up). Safe to call when the stage is unconfigured or the extension is
 * absent. Warm-up runs detached — a slow or failing warm-up must not hold up
 * server startup, since the stage falls back to a cold path on its own.
 */
export function initRequestPrepare(config: ProxyConfig): void {
  const options = stageOptions(config);
  if (!options) return;

  if (typeof _mod.initRequestPrepare === "function") {
    try {
      _mod.initRequestPrepare(options, config.redis, extensionLogger);
    } catch (err: unknown) {
      log.warn("request_prepare.init_failed", { error: String(err) });
    }
  }

  if (typeof _mod.warmRequestPrepare === "function") {
    void Promise.resolve()
      .then(() => _mod.warmRequestPrepare())
      .catch((err: unknown) => {
        log.warn("request_prepare.warm_failed", { error: String(err) });
      });
  }
}

/** Release the stage's process-wide resources. Call during shutdown. */
export async function shutdownRequestPrepare(): Promise<void> {
  if (!_available || !_mod) return;
  if (typeof _mod.shutdownRequestPrepare !== "function") return;
  try {
    await _mod.shutdownRequestPrepare();
  } catch (err: unknown) {
    log.warn("request_prepare.shutdown_failed", { error: String(err) });
  }
}

// ─── Request phase ──────────────────────────────────────────────────────────

/**
 * Wire protocol of the upstream call, as the stage understands it.
 *
 * `responses` is its own value rather than an `openai` variant: the Responses
 * body carries tool calls and tool results as separate top-level `input[]`
 * items keyed by `call_id`, so the stage cannot reuse the Chat Completions
 * `messages[]` shape for either compression or CFQ injection.
 */
export type PreparedProtocol = "anthropic" | "openai" | "responses";

/** Transport context of the upstream call the stage is preparing for. */
export interface UpstreamCallContext {
  upstreamUrl: string;
  headers: Record<string, string>;
  model: string;
  tools?: unknown;
  system?: unknown;
  bodyOverrides?: Record<string, unknown>;
}

export interface PrepareUpstreamRequestArgs {
  config: ProxyConfig;
  protocol: PreparedProtocol;
  /** Rewritten in place by the stage. */
  body: Record<string, unknown>;
  /** Rewritten in place by the stage. */
  messages: unknown[];
  /** Per-conversation isolation key, as used everywhere else in the host. */
  sessionKey: string;
  /** Tenant context already present in the proxy request path. */
  spaceId?: string;
  pipe: Pipeline;
  upstreamCall: UpstreamCallContext;
  /**
   * The denoised latest user question, when the agent profile could resolve
   * one. Passing it lets the stage work from the user's actual ask instead of
   * re-deriving it from a message array full of IDE/environment noise.
   */
  userQuery?: string;
  /**
   * Turn context for attaching internal preparation observations to the same
   * Langfuse trace as the upstream generation. Optional so older call sites
   * and tests stay valid; without it, observations are skipped.
   */
  lf?: LangfuseTurnContext;
  /**
   * Opik trace ID for attaching preparation LLM spans. When provided,
   * non-cache-hit observations are also reported as Opik spans (in addition
   * to Langfuse generations). Optional for backward compatibility.
   */
  opikTraceId?: string;
  /**
   * Key ID for the Opik project name dimension. Required when opikTraceId is set.
   */
  opikKeyId?: string;
  /**
   * When true, skip the preparation (compression) stage entirely. Used by
   * `/cost-guard/cheap` mode which only wants routing, not compression.
   */
  skipPrepare?: boolean;
}

/**
 * Flatten an arbitrary extension result into the scalar-only blob the host is
 * willing to log.
 *
 * Deliberately name-agnostic: rather than reaching for known fields (which
 * would bake the extension's vocabulary into this repo), it keeps every
 * top-level scalar and drops everything else. Nested payloads are dropped both
 * to stay opaque and because they can be very large.
 */
function scalarProjection(result: unknown): Record<string, unknown> | null {
  if (!result || typeof result !== "object") return null;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(result as Record<string, unknown>)) {
    if (typeof value === "number" || typeof value === "boolean") {
      out[key] = value;
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Run the preparation stage over a pending upstream request.
 *
 * `body` and `messages` are rewritten in place, so callers must invoke this
 * *after* every host-side mutation (injection, agent overrides) and *before*
 * the upstream body is serialized.
 *
 * Returns an opaque stats blob suitable for the observability sinks, or null
 * when the stage did not run or reported nothing worth recording. Never
 * throws — a failing stage leaves the request untouched.
 */
export async function prepareUpstreamRequest(
  args: PrepareUpstreamRequestArgs,
): Promise<Record<string, unknown> | null> {
  if (args.skipPrepare) return null;
  const options = stageOptions(args.config);
  if (!options) return null;
  if (typeof _mod.prepareUpstreamRequest !== "function") return null;

  try {
    const result = await _mod.prepareUpstreamRequest(
      args.protocol,
      options,
      args.body,
      args.messages,
      args.sessionKey,
      args.pipe,
      args.upstreamCall,
      args.userQuery,
      args.spaceId,
    );
    reportPrepareObservations(args, options, result);
    let stats = scalarProjection(result);
    if (typeof _mod.getResponseCleanupPolicy === "function") {
      const rawPolicy = _mod.getResponseCleanupPolicy(result);
      if (Array.isArray(rawPolicy)) {
        const toolNames = rawPolicy.filter(
          (name: unknown): name is string => typeof name === "string" && name.length > 0,
        );
        if (toolNames.length > 0) {
          // Injection can be the only work performed, in which case there are
          // no scalar stats. Create an otherwise-empty carrier for the WeakMap.
          stats ??= {};
          responseCleanupPolicies.set(stats, new Set(toolNames));
        }
      }
    }
    return stats;
  } catch (err: unknown) {
    args.pipe.error("REQUEST_PREPARE", err);
    return null;
  }
}

/**
 * Forward opaque per-remote preparation observations to Langfuse as separate
 * generations under the turn trace — same pattern as the router's
 * `[internal] <model>` analyzer spans. The host never interprets the fields;
 * it only copies what the extension hands back.
 *
 * Additionally, when `args.opikTraceId` is set, non-cache-hit observations
 * are also reported as Opik LLM spans under the same turn trace, recording
 * the full input/output of each compression API call for traceability.
 */
function reportPrepareObservations(
  args: PrepareUpstreamRequestArgs,
  options: Record<string, unknown>,
  result: unknown,
): void {
  const lf = args.lf;
  if (!lf && !args.opikTraceId) return;
  if (typeof _mod.listPrepareObservations !== "function") return;
  let observations: unknown;
  try {
    observations = _mod.listPrepareObservations(result, options);
  } catch (err: unknown) {
    args.pipe.error("REQUEST_PREPARE_OBSERVE", err);
    return;
  }
  if (!Array.isArray(observations) || observations.length === 0) return;

  for (const raw of observations) {
    if (!raw || typeof raw !== "object") continue;
    const obs = raw as Record<string, unknown>;
    if (typeof obs.name !== "string" || typeof obs.model !== "string") continue;
    if (typeof obs.startTime !== "string" || typeof obs.endTime !== "string") continue;

    // ── Langfuse generation (existing) ──────────────────────────────────
    if (lf) {
      try {
        langfuseReportGeneration({
          traceId: lf.traceId,
          name: obs.name,
          model: obs.model,
          startTime: obs.startTime,
          endTime: obs.endTime,
          input: obs.input,
          output: obs.output,
          usage:
            obs.usage && typeof obs.usage === "object"
              ? (obs.usage as Record<string, unknown>)
              : undefined,
          traceName: lf.traceName,
          userId: lf.userId,
          sessionId: lf.sessionId,
          tags: [
            ...lf.tags,
            ...(Array.isArray(obs.tags)
              ? obs.tags.filter((t): t is string => typeof t === "string")
              : []),
          ],
          observationMetadata:
            obs.metadata && typeof obs.metadata === "object"
              ? (obs.metadata as Record<string, unknown>)
              : { kind: "internal" },
        });
      } catch (err: unknown) {
        args.pipe.error("REQUEST_PREPARE_LANGFUSE", err);
      }
    }

    // ── Opik span: record each compression API call's input/output ───────
    // Skip cache-hit observations: they didn't actually call an external API.
    // The extension signals a cache hit via `obs.cacheHit === true` or the
    // `metadata.cacheHit` flag — either is treated as a skip condition.
    if (args.opikTraceId) {
      const isCacheHit =
        obs.cacheHit === true ||
        (obs.metadata &&
          typeof obs.metadata === "object" &&
          (obs.metadata as Record<string, unknown>).cacheHit === true);
      if (!isCacheHit) {
        try {
          opikCreateLlmSpan(args.config, {
            traceId: args.opikTraceId,
            projectName: args.opikKeyId ?? "unknown",
            name: `[prepare] ${obs.name}`,
            startTime: obs.startTime,
            endTime: obs.endTime,
            inputMessages: obs.input != null ? [{ role: "system", content: obs.input }] : [],
            outputMessage: obs.output != null
              ? { role: "assistant", content: obs.output }
              : null,
            model: obs.model,
            usage:
              obs.usage && typeof obs.usage === "object"
                ? (obs.usage as Record<string, unknown>)
                : {},
            tags: [
              "prepare",
              `stage:${obs.name}`,
              ...(Array.isArray(obs.tags)
                ? obs.tags.filter((t): t is string => typeof t === "string")
                : []),
            ],
          });
        } catch (err: unknown) {
          args.pipe.error("REQUEST_PREPARE_OPIK", err);
        }
      }
    }
  }
}

// ─── Response notification ──────────────────────────────────────────────────

/** A tool call as it left the upstream, before any client-side normalization. */
export interface UpstreamToolCall {
  /**
   * The id the *next* request will reference this call by — `tool_use.id` /
   * `tool_calls[].id`, and for Responses the `call_id`, never the item `id`.
   * A follow-up turn pairs its tool result on this value alone.
   */
  id: string;
  name: string;
  /** Raw, unparsed argument JSON exactly as the upstream emitted it. */
  arguments: string;
}

/** Everything the host observed on a completed upstream response. */
export interface UpstreamResponse {
  protocol: PreparedProtocol;
  sessionKey: string;
  model: string;
  stream: boolean;
  turnSeq: number;
  /** Assistant text, concatenated across content blocks or stream deltas. */
  text: string;
  toolCalls: UpstreamToolCall[];
  /** Raw usage as the upstream reported it; empty when it reported none. */
  usage: Record<string, unknown>;
}

/**
 * Tell the extension an upstream response completed, and what was in it.
 *
 * A deliberately broad, one-way notification rather than a hook for one
 * specific need: the host reports what it already has and the extension takes
 * what it wants. That keeps this the *only* response-side entry point no matter
 * what the extension grows into, which is the property worth protecting in a
 * published codebase — one generic hook a reader can understand beats several
 * narrow ones that each hint at their purpose.
 *
 * Why the raw arguments matter: whatever the extension added to a tool schema
 * never survives the round trip — the client either drops it when it
 * re-serializes the call against its own schema, or the host strips it on the
 * way out (see {@link stripInjectedToolArguments}). This is its only chance to
 * see them intact. The host does not parse them.
 *
 * Fire-and-forget, and never throws — nothing here is on the critical path.
 */
export async function notifyUpstreamResponse(
  config: ProxyConfig,
  response: UpstreamResponse,
  pipe: Pipeline,
): Promise<void> {
  if (!stageOptions(config)) return;
  if (typeof _mod.observeUpstreamResponse !== "function") return;
  try {
    const retained = await _mod.observeUpstreamResponse(response);
    reportSideChannelRetention(response, retained, pipe);
  } catch (err: unknown) {
    pipe.error("UPSTREAM_RESPONSE_NOTIFY", err);
  }
}

/**
 * Log what this response contributed to the extension's response-side channel.
 *
 * Why this is worth a dedicated line: the next turn logs a *miss* when it
 * cannot find what it expected, but a miss has three different owners — the
 * model never produced the value, our stream assembly mangled it, or the
 * extension's store was unreachable when we tried to save it. All three look
 * identical downstream, and the third is silent by design (the store degrades
 * to a no-op rather than failing a request). Only the response side can tell
 * them apart, so it has to say so here.
 *
 * `retained` is whatever the extension chose to keep; the host does not
 * interpret it beyond comparing it against what it offered. The richer
 * breakdown comes from an optional read-only entry point, so an extension too
 * old to expose it simply yields a shorter line instead of breaking.
 */
function reportSideChannelRetention(
  response: UpstreamResponse,
  retained: unknown,
  pipe: Pipeline,
): void {
  const offered = response.toolCalls.length;
  // Nothing to say about a turn that made no tool calls: plain prose answers
  // are the common case and would drown the signal.
  if (offered === 0) return;

  const kept = typeof retained === "number" ? retained : undefined;

  if (typeof _mod?.inspectUpstreamCfq !== "function") {
    pipe.info(
      "CFQ_OBSERVE",
      `tool_calls=${offered}${kept !== undefined ? ` retained=${kept}` : ""} detail=unavailable`,
    );
    return;
  }

  let obs: {
    toolCalls?: number;
    withCfq?: number;
    malformed?: number;
    cacheReady?: boolean;
  };
  try {
    obs = _mod.inspectUpstreamCfq(response) ?? {};
  } catch (err: unknown) {
    pipe.error("CFQ_OBSERVE", err);
    return;
  }

  const addressable = obs.toolCalls ?? offered;
  const produced = obs.withCfq ?? 0;
  const malformed = obs.malformed ?? 0;
  const storeReady = obs.cacheReady !== false;
  const base =
    `protocol=${response.protocol} stream=${response.stream} ` +
    `tool_calls=${addressable} with_cfq=${produced} malformed=${malformed} ` +
    `retained=${kept ?? "?"} store=${storeReady ? "ready" : "unavailable"}`;

  // Ordered by who has to act on it, most actionable first.
  if (!storeReady) {
    pipe.info(
      "CFQ_SIDE_CHANNEL_DOWN",
      `⚠️ ${base} — the store was unreachable, so nothing was saved and the ` +
        `next turn will miss regardless of what the model produced (ours to fix)`,
    );
    return;
  }
  if (malformed > 0) {
    pipe.info(
      "CFQ_ARGS_MALFORMED",
      `⚠️ ${base} — ${malformed} tool call(s) carried the field but it did not ` +
        `survive parsing (truncated stream assembly, ours to fix)`,
    );
    return;
  }
  if (produced === 0) {
    pipe.info(
      "CFQ_NOT_PRODUCED",
      `⚠️ ${base} — the model populated no focus question on any tool call, so ` +
        `the next turn has nothing to find (model/schema side, not a loss)`,
    );
    return;
  }
  if (kept !== undefined && kept < produced) {
    pipe.info(
      "CFQ_RETENTION_GAP",
      `⚠️ ${base} — fewer values were kept than produced (ours to fix)`,
    );
    return;
  }
  pipe.info("CFQ_OBSERVE", base);
}

// ─── Outbound tool-call cleanup ─────────────────────────────────────────────

/**
 * Remove the fields the extension added to tool schemas from a tool call on its
 * way back to the client.
 *
 * The client validates tool arguments against the schema *it* published, which
 * never had these fields; strict clients reject the whole call with an
 * unexpected-parameter error and refuse to run the tool. The extension has
 * already taken what it needs in {@link notifyUpstreamResponse}, so nothing is
 * lost by removing them here.
 *
 * Both helpers no-op when the extension is absent — no extension means nothing
 * was injected in the first place. The host never names the fields; only the
 * side that adds them knows what they are.
 *
 * @returns the rewritten JSON, or null when there was nothing to remove
 */
export function stripInjectedToolArguments(args: string): string | null {
  if (!_available || !_mod) return null;
  if (typeof _mod.stripCfqFromArguments !== "function") return null;
  try {
    return _mod.stripCfqFromArguments(args) as string | null;
  } catch {
    return null;
  }
}

/**
 * In-place variant for protocols that carry tool arguments as an object rather
 * than a serialized string.
 *
 * @returns whether anything was removed
 */
export function stripInjectedToolInput(input: unknown): boolean {
  if (!_available || !_mod) return false;
  if (typeof _mod.stripCfqFromInput !== "function") return false;
  try {
    return _mod.stripCfqFromInput(input) === true;
  } catch {
    return false;
  }
}

/**
 * Whether this exact preparation run added extension-owned fields to the
 * named tool. A false result means the response must remain byte-for-byte
 * untouched, even if it happens to contain a similarly named client field.
 */
export function shouldStripInjectedTool(
  preparedStats: Record<string, unknown> | null | undefined,
  toolName: string | undefined,
): boolean {
  if (!preparedStats || !toolName) return false;
  return responseCleanupPolicies.get(preparedStats)?.has(toolName) === true;
}

/** Whether this request has any response cleanup work at all. */
export function hasInjectedToolCleanup(
  preparedStats: Record<string, unknown> | null | undefined,
): boolean {
  if (!preparedStats) return false;
  return (responseCleanupPolicies.get(preparedStats)?.size ?? 0) > 0;
}
