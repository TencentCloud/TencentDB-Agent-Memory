/**
 * InjectionPipeline: coordinates the full injection flow.
 *
 * Flow: raw body → Adapter.parse() → AgentContext → execute hooks → Adapter.serialize() → modified body
 */

import type { ProtocolAdapter } from "./adapters/interface.js";
import type { AgentProfile } from "./agents/interface.js";
import type {
  AgentContext,
  AgentContextMetadata,
  ContextBlock,
  HookRegistry,
  InjectionHook,
  InjectionPoint,
} from "./types.js";
import {
  appendTextToMessage,
  getLastUserMessage,
  getMessageText,
  getSystemMessage,
  isFirstTurn,
  prependTextToMessage,
} from "./context.js";
import type { HookCacheRepo } from "../db/hookCacheRepo.js";
import type { InjectionObserver, HookResult } from "./observer.js";
import { NoopInjectionObserver } from "./observer.js";

/** Optional pipeline behaviors (agent detection, etc.). */
export interface InjectionPipelineOptions {
  /**
   * Agent profile lookup by `agentSource` string (e.g. "codebuddy", "claude-code").
   * The URL path prefix already carries agent identity; content-based detection
   * (`detectAgent`) is kept only as a legacy fallback for paths without a prefix.
   */
  agentProfiles?: Map<string, AgentProfile>;
  /**
   * Legacy: peek the system prompt text and return the matching AgentProfile.
   * Only consulted when `agentProfiles` lookup via `agentSource` misses.
   * @deprecated Prefer `agentProfiles` (URL-path-based, zero-cost lookup).
   */
  detectAgent?: (systemText: string) => AgentProfile | null;
  /**
   * Optional hook-cache repo. When provided, hooks declaring
   * `cacheStrategy ∈ {"session_init", "hybrid"}` will read prewarmed blocks
   * from the repo (keyed by `ctx.metadata.custom.session.session_id`).
   * If omitted, ALL hooks run as if `cacheStrategy="none"` (legacy behavior).
   */
  hookCacheRepo?: HookCacheRepo;
}

/**
 * The injection pipeline. Orchestrates parse → inject → serialize.
 */
export class InjectionPipeline {
  private agentProfiles?: Map<string, AgentProfile>;
  private detectAgent?: (systemText: string) => AgentProfile | null;
  private hookCacheRepo?: HookCacheRepo;
  private observer: InjectionObserver;

  constructor(
    private registry: HookRegistry,
    private adapters: Map<string, ProtocolAdapter>,
    options: InjectionPipelineOptions = {},
    observer?: InjectionObserver,
  ) {
    this.agentProfiles = options.agentProfiles;
    this.detectAgent = options.detectAgent;
    this.hookCacheRepo = options.hookCacheRepo;
    this.observer = observer ?? new NoopInjectionObserver();
  }

  /**
   * Process a raw request body through the injection pipeline.
   *
   * @param body Raw request body (protocol-specific format)
   * @param metadata Request metadata
   * @returns Modified request body with injected content
   */
  async process(
    body: Record<string, unknown>,
    metadata: AgentContextMetadata,
  ): Promise<Record<string, unknown>> {
    const pipelineStartMs = Date.now();

    // ── Observer: pipeline start ─────────────────────────────────────────
    safeCall(() => this.observer.onPipelineStart(metadata));

    try {
      // 1. Get the appropriate adapter
      const adapter = this.adapters.get(metadata.protocol);
      if (!adapter) {
        throw new Error(
          `No adapter found for protocol "${metadata.protocol}"`,
        );
      }

      // 2. Parse → AgentContext
      const ctx: AgentContext = adapter.parse(body, metadata);

      // 2.5 Detect the agent profile.
      //     Priority: ① agentProfiles lookup by metadata.agentSource (URL path prefix),
      //               ② legacy detectAgent (system prompt content scanning, for un-prefixed paths).
      //     A matching Profile enables precise anchor landing; otherwise hooks fall
      //     back to coarse-grained `point` behavior.
      {
        let profile: AgentProfile | null = null;

        // ① Fast path: URL-path-based lookup (zero cost, no string scanning)
        if (this.agentProfiles) {
          profile = this.agentProfiles.get(metadata.agentSource) ?? null;
        }

        // ② Legacy fallback: scan system prompt text (for paths without agent prefix)
        if (!profile && this.detectAgent) {
          const sysMsg = getSystemMessage(ctx);
          if (sysMsg) {
            profile = this.detectAgent(getMessageText(sysMsg));
          }
        }

        if (profile) {
          ctx.metadata.custom = {
            ...(ctx.metadata.custom ?? {}),
            agentProfile: profile,
          };
        }
      }

      // 3. Execute hooks at each injection point
      const hookResults: HookResult[] = await this.executeHooks(ctx);

      // 4. Serialize → modified body
      const result = adapter.serialize(ctx);

      // ── Observer: pipeline end ──────────────────────────────────────────
      const durationMs = Date.now() - pipelineStartMs;
      safeCall(() => this.observer.onPipelineEnd(metadata, durationMs, hookResults));

      return result;
    } catch (err) {
      // ── Observer: pipeline error ────────────────────────────────────────
      const error = err instanceof Error ? err : new Error(String(err));
      safeCall(() => this.observer.onPipelineError(metadata, error));
      throw err; // re-throw so callers can handle it
    }
  }

  // ── Hook Execution ──────────────────────────────────────────────────────────

  /**
   * Execute all registered hooks in the correct order for each injection point.
   *
   * Strategy routing per hook (`hook.cacheStrategy`, default `"none"`):
   *   - `"none"`         → run `execute(ctx)` (original behavior).
   *   - `"session_init"` → read prewarmed blocks from `hookCacheRepo`, SKIP execute.
   *   - `"hybrid"`       → union of prewarmed blocks + `execute(ctx)` result,
   *                        deduplicated by `metadata.cacheKey ?? content`.
   *
   * When `hookCacheRepo` is not configured, or the current request lacks a
   * `sessionId` in metadata, every hook falls back to `"none"` behavior to
   * preserve legacy semantics.
   */
  private async executeHooks(ctx: AgentContext): Promise<HookResult[]> {
    const executionOrder: InjectionPoint[] = [
      "system.prefix",
      "system.before_tools",
      "system.after_tools",
      "system.suffix",
      "tools.prepend",
      "tools.append",
      "user.first_turn",
      "user.before",
      "user.after",
    ];

    const sessionId = this.getSessionId(ctx);
    // Hook cache 隔离键 —— userId 从 metadata 里取（handler 层已透传）；
    // 缺省时 fallback 到 "anonymous"（与 handler 层一致，防止未鉴权请求撞
    // 到已鉴权用户的缓存）。agentSource 由 URL path 派生，缺省 "claude-code"。
    // spaceId 是 P4 新增（kernel-sts）；缺省时 Repo 用 `_default` 兜底段。
    const userId = (ctx.metadata.userId && ctx.metadata.userId.length > 0)
      ? ctx.metadata.userId
      : "anonymous";
    const agentSource = ctx.metadata.agentSource || "claude-code";
    const spaceId = ctx.metadata.spaceId ?? "";
    const results: HookResult[] = [];

    for (const point of executionOrder) {
      const hooks = this.registry.getHooks(point);
      for (const hook of hooks) {
        const hookStartMs = Date.now();
        // ── Observer: hook start ──────────────────────────────────────────
        safeCall(() => this.observer.onHookStart(hook, point));

        try {
          const blocks = await this.resolveHookBlocks(hook, ctx, spaceId, userId, agentSource, sessionId);
          const durationMs = Date.now() - hookStartMs;

          if (blocks.length > 0) {
            // 💡 显式打印注入成功的日志和文本前 120 字符预览，极大方便开发者排查和联调
            console.log(
              `[injection] ✓ Hook "${hook.id}" successfully injected ${blocks.length} block(s) ` +
              `at point "${point}" (cacheStrategy=${hook.cacheStrategy ?? "none"})`
            );
            for (const b of blocks) {
              if (b.type === "text") {
                const preview = b.content.replace(/\s+/g, " ").slice(0, 120);
                console.log(`[injection]   → text preview: "${preview}..."`);
              } else if (b.type === "custom") {
                console.log(`[injection]   → custom tool: "${b.metadata?.tool_name}"`);
              }
            }
            this.applyInjection(ctx, hook, point, blocks);
          }

          // ── Observer: hook done ─────────────────────────────────────────
          safeCall(() =>
            this.observer.onHookDone(hook, point, blocks, durationMs, hook.cacheStrategy),
          );

          results.push({
            hookId: hook.id,
            point,
            blockCount: blocks.length,
            durationMs,
            cacheStrategy: hook.cacheStrategy ?? "none",
          });
        } catch (err) {
          const durationMs = Date.now() - hookStartMs;
          const error = err instanceof Error ? err : new Error(String(err));

          // Hook failure is non-fatal — log and continue
          console.error(
            `[injection] Hook "${hook.id}" failed at point "${point}":`,
            error.message,
          );

          // ── Observer: hook error ────────────────────────────────────────
          safeCall(() => this.observer.onHookError(hook, point, error, durationMs));

          results.push({
            hookId: hook.id,
            point,
            blockCount: 0,
            durationMs,
            error: error.message,
            cacheStrategy: hook.cacheStrategy ?? "none",
          });
        }
      }
    }

    return results;
  }

  /** Read `session_id` from metadata.custom.session (set in handler.ts). */
  private getSessionId(ctx: AgentContext): string | null {
    const custom = ctx.metadata.custom as Record<string, unknown> | undefined;
    const session = custom?.session as Record<string, unknown> | undefined;
    const sid = session?.session_id;
    return typeof sid === "string" && sid.length > 0 ? sid : null;
  }

  /**
   * Produce the final ContextBlock[] for a single hook by routing on
   * `cacheStrategy`. Caching is opt-in and degrades safely.
   */
  private async resolveHookBlocks(
    hook: InjectionHook,
    ctx: AgentContext,
    spaceId: string,
    userId: string,
    agentSource: string,
    sessionId: string | null,
  ): Promise<ContextBlock[]> {
    const strategy = hook.cacheStrategy ?? "none";

    // Fast path: no cache configured, or no session_id available — legacy.
    if (!this.hookCacheRepo || !sessionId || strategy === "none") {
      return await hook.execute(ctx);
    }

    if (strategy === "session_init") {
      const cached = await this.hookCacheRepo.get(spaceId, userId, agentSource, sessionId, hook.id);
      if (cached !== null) {
        console.log(`[hook-cache] session=${sessionId} hook=${hook.id} hit blocks=${cached.length}`);
        return cached;
      }

      // Cache miss safety net. This is expected on the very first request of
      // a fresh session: session_init's prewarm is fire-and-forget, so the
      // pipeline commonly runs before the cache is populated. It also covers
      // prewarm failures and cache-store outages/TTL expiry. Fall back to
      // hook.execute() and self-heal the cache so subsequent turns hit the
      // fast path.
      //
      // Exception: `metadata.readOnly === true` (FORK 请求) —— cache-miss 时**不
      // self-heal put**。因为 fork 请求的目的是复用 MAIN 已建的 cache 命中；如果
      // miss 时 self-heal，写入内容可能跟 MAIN 那次不 byte-level 一致，反而破坏
      // 后续主对话的 cache 语义。
      const fresh = await hook.execute(ctx);
      const readOnly = ctx.metadata.readOnly === true;
      if (fresh.length > 0 && !readOnly) {
        try {
          this.hookCacheRepo.put(spaceId, userId, agentSource, sessionId, hook.id, fresh);
          console.log(`[hook-cache] session=${sessionId} hook=${hook.id} miss → self-heal put (blocks=${fresh.length})`);
        } catch (err) {
          console.warn(
            `[injection] session_init cache self-heal put failed (session=${sessionId} hook=${hook.id}):`,
            err instanceof Error ? err.message : String(err),
          );
        }
      } else if (readOnly) {
        console.log(`[hook-cache] session=${sessionId} hook=${hook.id} miss (readOnly, no self-heal) blocks=${fresh.length}`);
      } else {
        console.log(`[hook-cache] session=${sessionId} hook=${hook.id} miss + execute returned empty (no self-heal)`);
      }
      return fresh;
    }

    // strategy === "hybrid"
    const cached = await this.hookCacheRepo.get(spaceId, userId, agentSource, sessionId, hook.id) ?? [];
    const fresh = await hook.execute(ctx);
    if (cached.length === 0) return fresh;
    if (fresh.length === 0) return cached;
    return mergeBlocks(cached, fresh);
  }

  // ── Injection Application ───────────────────────────────────────────────────

  /**
   * Apply injected blocks to the context.
   *
   * Precedence (matches design 3.10.4): if the hook declares an `anchor`, a
   * matching AgentProfile is present, and the semantic slot resolves to a real
   * structural key → land precisely via the profile. Otherwise fall back to the
   * coarse-grained `point` behavior.
   */
  private applyInjection(
    ctx: AgentContext,
    hook: InjectionHook,
    point: InjectionPoint,
    blocks: ContextBlock[],
  ): void {
    const text = blocks
      .filter((b) => b.type === "text")
      .map((b) => b.content)
      .join("\n");

    // ── Dynamic anchor path ──────────────────────────────────────────────────
    const profile = ctx.metadata.custom?.agentProfile as AgentProfile | undefined;
    if (hook.anchor && profile && text.length > 0) {
      const sysMsg = getSystemMessage(ctx);
      if (sysMsg) {
        const key = hook.anchor.rawKey
          ?? (hook.anchor.slot ? profile.resolveSlot(hook.anchor.slot) : null);
        const currentText = getMessageText(sysMsg);
        const segments = profile.parse(currentText);
        if (key && segments.some((s) => s.key === key)) {
          const newSegments = profile.applyAnchor(
            segments,
            { key, relation: hook.anchor.relation },
            text,
          );
          // The system message text is authoritative — replace its blocks with
          // the rebuilt prompt so later hooks see the updated text.
          sysMsg.blocks = [{ type: "text", content: profile.rebuild(newSegments) }];
          return; // anchor hit — done
        }
        // Slot unresolved / structure missing → fall through to `point` (warn).
        console.warn(
          `[injection] anchor slot "${hook.anchor.slot ?? hook.anchor.rawKey}" `
            + `unresolved on agent "${profile.id}", fallback to point "${point}"`,
        );
      }
    }

    // ── Fallback / generic path: coarse-grained `point` landing ───────────────
    this.applyByPoint(ctx, point, blocks);
  }

  /**
   * Coarse-grained point-based injection (the original behavior, kept intact).
   */
  private applyByPoint(
    ctx: AgentContext,
    point: InjectionPoint,
    blocks: ContextBlock[],
  ): void {
    switch (point) {
      case "system.prefix": {
        const sysMsg = getSystemMessage(ctx);
        if (!sysMsg) break;
        // Prepend text blocks at the beginning of system message
        for (let i = blocks.length - 1; i >= 0; i--) {
          if (blocks[i].type === "text") {
            prependTextToMessage(sysMsg, blocks[i].content);
          }
        }
        break;
      }

      case "system.suffix": {
        const sysMsg = getSystemMessage(ctx);
        if (!sysMsg) break;
        // Append text blocks at the end of system message
        for (const block of blocks) {
          if (block.type === "text") {
            appendTextToMessage(sysMsg, block.content);
          }
        }
        break;
      }

      case "system.before_tools":
      case "system.after_tools": {
        // Fallback semantics for anchor-unresolved hooks: append to the end of
        // the system message. The previous behavior for `system.before_tools`
        // was to prepend (顶到最前面)，会把 knowledge/skill/rules 等资产块甩到
        // 用户 persona 前面污染开场，尤其在子 agent / 简化 system prompt 场景
        // (锚点永远解析不到) 直接看到 <knowledge_tools> 位于 offset 0。
        // 统一收敛为 "锚点找不到 → 挂到系统提示词末尾"，跟 system.suffix 行为
        // 一致，跟 asset-reflection / tdai-tools 这些 suffix 类块的落位对齐。
        const sysMsg = getSystemMessage(ctx);
        if (!sysMsg) break;
        for (const block of blocks) {
          if (block.type === "text") {
            appendTextToMessage(sysMsg, block.content);
          }
        }
        break;
      }

      case "user.first_turn": {
        if (!isFirstTurn(ctx)) break;
        // Fall through to user.before behavior
        const lastUserMsg = getLastUserMessage(ctx);
        if (!lastUserMsg) break;
        for (let i = blocks.length - 1; i >= 0; i--) {
          if (blocks[i].type === "text") {
            prependTextToMessage(lastUserMsg, blocks[i].content);
          }
        }
        break;
      }

      case "user.before": {
        const lastUserMsg = getLastUserMessage(ctx);
        if (!lastUserMsg) break;
        for (let i = blocks.length - 1; i >= 0; i--) {
          if (blocks[i].type === "text") {
            prependTextToMessage(lastUserMsg, blocks[i].content);
          }
        }
        break;
      }

      case "user.after": {
        const lastUserMsg = getLastUserMessage(ctx);
        if (!lastUserMsg) break;
        for (const block of blocks) {
          if (block.type === "text") {
            appendTextToMessage(lastUserMsg, block.content);
          }
        }
        break;
      }

      case "tools.append": {
        if (!ctx.tools) ctx.tools = [];
        for (const block of blocks) {
          if (block.type === "custom" && block.metadata?.tool_name) {
            ctx.tools.push({
              name: block.metadata.tool_name as string,
              description: block.content,
              parameters: (block.metadata.parameters as Record<string, unknown>) ?? {},
            });
          }
        }
        break;
      }

      case "tools.prepend": {
        const existingTools = ctx.tools ?? [];
        const newTools = [];
        for (const block of blocks) {
          if (block.type === "custom" && block.metadata?.tool_name) {
            newTools.push({
              name: block.metadata.tool_name as string,
              description: block.content,
              parameters: (block.metadata.parameters as Record<string, unknown>) ?? {},
            });
          }
        }
        ctx.tools = [...newTools, ...existingTools];
        break;
      }
    }
  }
}

/**
 * Call a function safely — catch any error and silently discard.
 * Used for observer calls so that observer failures never propagate to the pipeline.
 */
function safeCall(fn: () => void): void {
  try {
    fn();
  } catch {
    // observer errors are intentionally swallowed
  }
}

/**
 * Merge cached blocks with freshly executed blocks, deduplicating by
 * `metadata.cacheKey` when present, otherwise by `(type, content)`.
 * Order: cached first (stable, prewarmed), then unique fresh entries appended.
 */
function mergeBlocks(cached: ContextBlock[], fresh: ContextBlock[]): ContextBlock[] {
  const keyOf = (b: ContextBlock): string => {
    const ck = b.metadata?.cacheKey;
    if (typeof ck === "string" && ck.length > 0) return `k:${ck}`;
    return `c:${b.type}::${b.content}`;
  };
  const seen = new Set<string>();
  const out: ContextBlock[] = [];
  for (const b of cached) {
    const k = keyOf(b);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(b);
    }
  }
  for (const b of fresh) {
    const k = keyOf(b);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(b);
    }
  }
  return out;
}
