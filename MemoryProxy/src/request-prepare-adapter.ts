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

// ─── Dynamic import + no-op fallback ────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _mod: any = null;
let _available = false;

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
function stageOptions(config: ProxyConfig): Record<string, unknown> | undefined {
  const opts = config.costGuard.options.requestPrepare;
  if (!opts || typeof opts !== "object") return undefined;
  const payload = opts as Record<string, unknown>;
  const controlPlane = config.costGuard.options.controlPlane;
  if (payload.enabled === false && controlPlane === undefined) return undefined;
  // The extension owns this shared private configuration. The host forwards it
  // as an opaque value and does not parse its shape.
  return { ...payload, controlPlane };
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
  protocol: "anthropic" | "openai";
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
    return scalarProjection(result);
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
 */
function reportPrepareObservations(
  args: PrepareUpstreamRequestArgs,
  options: Record<string, unknown>,
  result: unknown,
): void {
  const lf = args.lf;
  if (!lf) return;
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
}

// ─── Response notification ──────────────────────────────────────────────────

/** A tool call as it left the upstream, before any client-side normalization. */
export interface UpstreamToolCall {
  id: string;
  name: string;
  /** Raw, unparsed argument JSON exactly as the upstream emitted it. */
  arguments: string;
}

/** Everything the host observed on a completed upstream response. */
export interface UpstreamResponse {
  protocol: "anthropic" | "openai";
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
 * Why the raw arguments matter: agent clients re-serialize tool calls against
 * their own schema and drop anything it does not declare, so whatever the
 * extension may have added is gone by the next request. This is its only chance
 * to see them intact. The host does not parse them.
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
    await _mod.observeUpstreamResponse(response);
  } catch (err: unknown) {
    pipe.error("UPSTREAM_RESPONSE_NOTIFY", err);
  }
}
