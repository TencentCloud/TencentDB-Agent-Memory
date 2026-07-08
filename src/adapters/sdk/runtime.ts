/**
 * PlatformAdapterRuntime — SDK bootstrap for new TDAI adapter platforms.
 *
 * A single call to `PlatformAdapterRuntime.bootstrap(impl, opts)`:
 *   1. Initialize data dirs + TdaiCore via the caller-provided HostAdapter
 *   2. Build PlatformAdapterContext with registerTool / onLifecycle
 *   3. Call impl.registerHandlers(ctx)
 *   4. Return typed { core, toolSchemas, executeTool, lifecycleCallbacks, shutdown }
 *
 * The caller owns HostAdapter construction and signal wiring. The SDK
 * owns Core lifecycle, tool routing, and error degradation.
 */

import { TdaiCore } from "../../core/tdai-core.js";
import { SessionFilter } from "../../utils/session-filter.js";
import { initDataDirectories, resetStores } from "../../utils/pipeline-factory.js";
import { McpHostAdapter } from "../mcp/host-adapter.js";
import type { StandaloneLLMConfig } from "../standalone/llm-runner.js";
import type { HostAdapter, Logger, CompletedTurn } from "../../core/types.js";
import type {
  IPlatformAdapter,
  IPlatformAdapterContext,
  PlatformToolDefinition,
  PlatformLifecycleEvent,
  PlatformLifecycleHandler,
  PlatformAdapterBootstrapOptions,
  PlatformAdapterBootstrapResult,
} from "./types.js";

const TAG = "[memory-tdai] [sdk]";

// ── Logger ─────────────────────────────────────────────────────────────

function buildLogger(debug: boolean): Logger {
  const tag = `${TAG} [runtime]`;
  return {
    debug: debug ? (msg: string) => process.stderr.write(`${tag} DEBUG ${msg}\n`) : undefined,
    info: (msg: string) => process.stderr.write(`${tag} INFO ${msg}\n`),
    warn: (msg: string) => process.stderr.write(`${tag} WARN ${msg}\n`),
    error: (msg: string) => process.stderr.write(`${tag} ERROR ${msg}\n`),
  };
}

// ── Default lifecycle handlers ─────────────────────────────────────────

function defaultLifecycleHandler(event: PlatformLifecycleEvent): PlatformLifecycleHandler {
  switch (event) {
    case "before_prompt":
      return async (payload, ctx) => {
        const p = payload as { query?: string; session_key?: string };
        if (!p.query || !p.session_key) { ctx.logger.warn?.(`${TAG} before_prompt: missing query/session_key`); return; }
        await ctx.core.handleBeforeRecall(p.query, p.session_key);
      };

    case "after_turn":
      return async (payload, ctx) => {
        const p = payload as { user_content?: string; assistant_content?: string; session_key?: string; session_id?: string; messages?: unknown[] };
        if (!p.user_content || !p.assistant_content || !p.session_key) { ctx.logger.warn?.(`${TAG} after_turn: missing content/session_key`); return; }
        const turn: CompletedTurn = {
          userText: p.user_content, assistantText: p.assistant_content,
          messages: p.messages ?? [{ role: "user", content: p.user_content }, { role: "assistant", content: p.assistant_content }],
          sessionKey: p.session_key, sessionId: p.session_id,
        };
        await ctx.core.handleTurnCommitted(turn);
      };

    case "session_end":
      return async (payload, ctx) => {
        const p = payload as { session_key?: string };
        if (p.session_key) await ctx.core.handleSessionEnd(p.session_key);
      };

    case "shutdown":
      return async (_payload, ctx) => { await ctx.core.destroy(); };
  }
}

// ── Default tool handlers ──────────────────────────────────────────────

async function handleMemorySearch(params: Record<string, unknown>, ctx: IPlatformAdapterContext): Promise<string> {
  const query = String(params.query ?? "");
  if (!query) throw new Error("Missing required parameter: query");
  const limit = Math.min(Math.max(Number(params.limit) || 5, 1), 20);
  const type = typeof params.type === "string" ? params.type : undefined;
  const scene = typeof params.scene === "string" ? params.scene : undefined;
  return (await ctx.core.searchMemories({ query, limit, type, scene })).text;
}

async function handleConversationSearch(params: Record<string, unknown>, ctx: IPlatformAdapterContext): Promise<string> {
  const query = String(params.query ?? "");
  if (!query) throw new Error("Missing required parameter: query");
  const limit = Math.min(Math.max(Number(params.limit) || 5, 1), 20);
  const sessionKey = typeof params.session_key === "string" ? params.session_key : undefined;
  return (await ctx.core.searchConversations({ query, limit, sessionKey })).text;
}

// ── Tool schema builder ────────────────────────────────────────────────

function buildToolSchema(def: PlatformToolDefinition): Record<string, unknown> {
  const props: Record<string, unknown> = {
    query: { type: "string", description: "Search query." },
    limit: { type: "number", description: "Maximum number of results to return (default: 5, max: 20)." },
    ...(def.extraParameters ?? {}),
  };
  if (def.routeTo === "memory_search") {
    props.type = { type: "string", enum: ["persona", "episodic", "instruction"], description: "Optional filter by memory type." };
    props.scene = { type: "string", description: "Optional filter by scene name." };
  }
  if (def.routeTo === "conversation_search") {
    props.session_key = { type: "string", description: "Optional session filter." };
  }
  return { type: "object", properties: props, required: ["query"] };
}

// ── Runtime ────────────────────────────────────────────────────────────

export class PlatformAdapterRuntime {
  /**
   * Bootstrap: caller provides a HostAdapter, SDK does the rest.
   *
   * Returns typed result — no any-cast metadata on core.
   */
  static async bootstrap(opts: PlatformAdapterBootstrapOptions): Promise<PlatformAdapterBootstrapResult> {
    const logger = buildLogger(opts.debug ?? false);
    logger.info(`${TAG} bootstrapping platform "${opts.adapter.platformId}"`);

    // 1. Init data dirs
    initDataDirectories(opts.dataDir);

    // 2. Build + init TdaiCore via caller's HostAdapter
    const sessionFilter = new SessionFilter(opts.config.capture.excludeAgents);
    const core = new TdaiCore({ hostAdapter: opts.hostAdapter, config: opts.config, sessionFilter });
    await core.initialize();
    logger.info(`${TAG} TdaiCore ready (dataDir=${opts.dataDir})`);

    // 3. Tool + lifecycle registries
    const registeredTools: Array<{ def: PlatformToolDefinition; handler: (p: Record<string, unknown>) => Promise<string> }> = [];
    const lifecycleCallbacks = new Map<PlatformLifecycleEvent, PlatformLifecycleHandler[]>();

    // 4. Build context
    const ctx: IPlatformAdapterContext = {
      core, config: opts.config, logger,

      registerTool(def: PlatformToolDefinition): void {
        let handler: (p: Record<string, unknown>) => Promise<string>;
        switch (def.routeTo) {
          case "memory_search":       handler = (p) => handleMemorySearch(p, ctx); break;
          case "conversation_search": handler = (p) => handleConversationSearch(p, ctx); break;
          case "custom":
            if (!def.customHandler) throw new Error(`Tool "${def.name}" has routeTo="custom" but no customHandler`);
            handler = def.customHandler; break;
          default: throw new Error(`Unknown routeTo: ${(def as any).routeTo}`);
        }
        registeredTools.push({ def, handler });
        logger.debug?.(`${TAG} registered tool: ${def.name} → ${def.routeTo}`);
      },

      onLifecycle(event: PlatformLifecycleEvent, handler?: PlatformLifecycleHandler): void {
        const h = handler ?? defaultLifecycleHandler(event);
        if (!lifecycleCallbacks.has(event)) lifecycleCallbacks.set(event, []);
        lifecycleCallbacks.get(event)!.push(h);
        logger.debug?.(`${TAG} registered lifecycle: ${event}`);
      },
    };

    // 5. Call implementor
    await opts.adapter.registerHandlers(ctx);
    logger.info(`${TAG} platform "${opts.adapter.platformId}" registered ${registeredTools.length} tools, ${lifecycleCallbacks.size} lifecycle hooks`);

    // 6. Default shutdown if implementor didn't register one
    if (!lifecycleCallbacks.has("shutdown") || lifecycleCallbacks.get("shutdown")!.length === 0) {
      lifecycleCallbacks.set("shutdown", [defaultLifecycleHandler("shutdown")]);
    }

    // 7. Build typed result
    const toolSchemas = registeredTools.map((t) => ({
      name: t.def.name,
      description: t.def.description,
      inputSchema: buildToolSchema(t.def),
    }));

    const executeTool = async (name: string, params: Record<string, unknown>) => {
      const tool = registeredTools.find((t) => t.def.name === name);
      if (!tool) throw new Error(`Unknown tool: ${name}`);
      const startMs = Date.now();
      try {
        const text = await tool.handler(params);
        logger.debug?.(`${TAG} tool ${name} ok (${Date.now() - startMs}ms)`);
        return { content: [{ type: "text" as const, text }] };
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        logger.error(`${TAG} tool ${name} failed (${Date.now() - startMs}ms): ${errMsg}`);
        return { content: [{ type: "text" as const, text: `Tool call failed: ${errMsg}` }], isError: true };
      }
    };

    const shutdown = async () => {
      logger.info(`${TAG} shutting down...`);
      for (const h of lifecycleCallbacks.get("shutdown") ?? []) {
        try { await h({}, ctx); } catch (err) {
          logger.warn(`${TAG} shutdown handler error: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      resetStores(opts.dataDir);
    };

    return { core, toolSchemas, executeTool, lifecycleCallbacks, shutdown };
  }

  /**
   * Convenience factory: build a McpHostAdapter (standalone/stdio style)
   * from LLM config. Covers Pattern B (sidecar) and Pattern C (MCP).
   */
  static createStandaloneHostAdapter(opts: {
    dataDir: string;
    llmConfig: StandaloneLLMConfig;
    logger: Logger;
    defaultUserId?: string;
  }): HostAdapter {
    return new McpHostAdapter(opts);
  }
}
