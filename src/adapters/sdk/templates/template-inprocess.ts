/**
 * Template: Pattern A — In-process TypeScript host.
 *
 * Use this when the target platform is a TS/JS agent framework with a
 * native plugin API (similar to OpenClaw). The Core runs in the same
 * Node.js process as the host — no HTTP hops, no serialization.
 *
 * Replace every `TODO` with your platform's specific API.
 */

import { PlatformAdapterRuntime } from "../runtime.js";
import type {
  IPlatformAdapter,
  IPlatformAdapterContext,
  PlatformAdapterBootstrapOptions,
} from "../types.js";
import type { MemoryTdaiConfig } from "../../../config.js";

// ── Step 1: Implement IPlatformAdapter ────────────────────────────────

class MyPlatformAdapter implements IPlatformAdapter {
  readonly platformId = "TODO: your-platform-id";

  async registerHandlers(ctx: IPlatformAdapterContext) {
    // Register the two universal memory search tools.
    // routeTo = "memory_search" / "conversation_search" means the SDK
    // provides the handler — zero code from you for these.
    ctx.registerTool({
      name: "memory_search",
      description: "TODO: description",
      routeTo: "memory_search",
    });
    ctx.registerTool({
      name: "conversation_search",
      description: "TODO: description",
      routeTo: "conversation_search",
    });

    // Wire lifecycle events. For each event you handle, the SDK has a
    // default handler that calls the correct core method. Pass `undefined`
    // as the second arg to use the default.
    //
    // If your host's event shape differs, provide a custom handler:
    //   ctx.onLifecycle("before_prompt", async (payload, ctx) => {
    //     const adapted = adaptMyPayload(payload);
    //     await ctx.core.handleBeforeRecall(adapted.query, adapted.sessionKey);
    //   });

    ctx.onLifecycle("before_prompt"); // → core.handleBeforeRecall
    ctx.onLifecycle("after_turn");    // → core.handleTurnCommitted
    ctx.onLifecycle("session_end");   // → core.handleSessionEnd
    // shutdown auto-registered by runtime — don't add it here
  }
}

// ── Step 2: Bootstrap ──────────────────────────────────────────────────

export async function startMyPlatformAdapter(dataDir: string, config: MemoryTdaiConfig) {
  const adapter = new MyPlatformAdapter();
  const opts: PlatformAdapterBootstrapOptions = {
    adapter,
    dataDir,
    config,
    llmBaseUrl: process.env.LLM_BASE_URL ?? "https://api.openai.com/v1",
    llmApiKey: process.env.LLM_API_KEY ?? "",
    llmModel: process.env.LLM_MODEL ?? "gpt-4o",
    debug: !!process.env.TDAI_DEBUG,
  };

  const { core, shutdown } = await PlatformAdapterRuntime.bootstrap(opts);

  // ── Step 3: Bridge to your host's plugin API ───────────────────────

  // TODO: Register tools with your host:
  //   const schemas = (core as any).__sdk_toolSchemas;
  //   for (const s of schemas) {
  //     myHost.registerTool({
  //       name: s.name,
  //       description: s.description,
  //       parameters: s.inputSchema,
  //       execute: async (params) => {
  //         return (core as any).__sdk_executeTool(s.name, params);
  //       },
  //     });
  //   }

  // TODO: Wire lifecycle hooks:
  //   const callbacks = (core as any).__sdk_lifecycleCallbacks;
  //   myHost.on("beforePrompt", async (payload) => {
  //     for (const h of callbacks.get("before_prompt") ?? []) {
  //       await h(payload, /* ctx from bootstrap */);
  //     }
  //   });

  // TODO: Wire shutdown:
  //   myHost.on("stop", shutdown);

  return { core, shutdown };
}
