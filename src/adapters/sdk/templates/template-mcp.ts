/**
 * Template: Pattern C — MCP server (stdin/stdout JSON-RPC).
 *
 * Demonstrates PlatformAdapterRuntime.bootstrap() with a caller-provided
 * HostAdapter. Replace TODO markers with your platform's MCP SDK calls.
 */

import { PlatformAdapterRuntime } from "../runtime.js";
import type {
  IPlatformAdapter,
  IPlatformAdapterContext,
  PlatformAdapterBootstrapOptions,
} from "../types.js";
import type { MemoryTdaiConfig } from "../../../config.js";
import type { StandaloneLLMConfig } from "../../standalone/llm-runner.js";
import { parseConfig } from "../../../config.js";

// ── Step 1: Implement IPlatformAdapter ────────────────────────────────

class MyMcpPlatformAdapter implements IPlatformAdapter {
  readonly platformId = "TODO: platform-id";

  async registerHandlers(ctx: IPlatformAdapterContext) {
    ctx.registerTool({
      name: "tdai_memory_search",
      description: "Search structured memories (L1).",
      routeTo: "memory_search",
    });
    ctx.registerTool({
      name: "tdai_conversation_search",
      description: "Search raw conversations (L0).",
      routeTo: "conversation_search",
    });
    ctx.registerTool({
      name: "tdai_recall",
      description: "Auto-recall for current prompt.",
      routeTo: "custom",
      customHandler: async (params) => {
        const q = String(params.query ?? ""); const sk = String(params.session_key ?? "");
        if (!q || !sk) throw new Error("Missing query/session_key");
        const r = await ctx.core.handleBeforeRecall(q, sk);
        return JSON.stringify({ prepend_context: r.prependContext ?? "", append_system_context: r.appendSystemContext ?? "", memory_count: r.recalledL1Memories?.length ?? 0 });
      },
    });
    ctx.registerTool({
      name: "tdai_capture",
      description: "Capture completed turn.",
      routeTo: "custom",
      customHandler: async (params) => {
        const uc = String(params.user_content ?? ""); const ac = String(params.assistant_content ?? ""); const sk = String(params.session_key ?? "");
        if (!uc || !ac || !sk) throw new Error("Missing user_content/assistant_content/session_key");
        const r = await ctx.core.handleTurnCommitted({ userText: uc, assistantText: ac, messages: [{ role: "user", content: uc }, { role: "assistant", content: ac }], sessionKey: sk });
        return JSON.stringify({ l0_recorded: r.l0RecordedCount });
      },
    });
    ctx.registerTool({
      name: "tdai_session_end",
      description: "Flush session.",
      routeTo: "custom",
      customHandler: async (params) => {
        const sk = String(params.session_key ?? ""); if (!sk) throw new Error("Missing session_key");
        await ctx.core.handleSessionEnd(sk); return JSON.stringify({ flushed: true });
      },
    });
  }
}

// ── Step 2: Bootstrap with caller-provided HostAdapter ─────────────────

export async function startMcpServer() {
  const dataDir = process.env.TDAI_DATA_DIR ?? `${process.env.HOME ?? process.env.USERPROFILE}/.memory-tencentdb/memory-tdai`;
  const debug = !!process.env.TDAI_MCP_DEBUG;

  // Build HostAdapter (caller owns this — not SDK)
  const llmConfig: StandaloneLLMConfig = {
    baseUrl: process.env.TDAI_LLM_BASE_URL ?? "https://api.openai.com/v1",
    apiKey: process.env.TDAI_LLM_API_KEY ?? "",
    model: process.env.TDAI_LLM_MODEL ?? "gpt-4o",
    maxTokens: Number(process.env.TDAI_LLM_MAX_TOKENS) || 4096,
    timeoutMs: Number(process.env.TDAI_LLM_TIMEOUT_MS) || 120_000,
  };
  const hostAdapter = PlatformAdapterRuntime.createStandaloneHostAdapter({ dataDir, llmConfig, logger: buildStderrLogger(debug) });

  // Parse memory config
  const memoryConfig: MemoryTdaiConfig = (() => {
    const raw: Record<string, unknown> = {};
    const env = process.env.TDAI_MEMORY_CONFIG;
    if (env) { try { const p = JSON.parse(env); if (p && typeof p === "object" && !Array.isArray(p)) Object.assign(raw, p); } catch {} }
    return parseConfig(raw);
  })();

  const opts: PlatformAdapterBootstrapOptions = { adapter: new MyMcpPlatformAdapter(), hostAdapter, dataDir, config: memoryConfig, debug };
  const result = await PlatformAdapterRuntime.bootstrap(opts);

  // ── Step 3: Wire to MCP transport ────────────────────────────────────
  //
  // import { Server } from "@modelcontextprotocol/sdk/server/index.js";
  // import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
  // import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
  //
  // const server = new Server({ name: "tdai-memory", version: "1.0.0" }, { capabilities: { tools: {} } });
  // server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: result.toolSchemas }));
  // server.setRequestHandler(CallToolRequestSchema, async (req) => result.executeTool(req.params.name, req.params.arguments ?? {}));
  // await server.connect(new StdioServerTransport());
  // process.on("SIGINT", result.shutdown);
  // process.on("SIGTERM", result.shutdown);

  return result;
}

function buildStderrLogger(debug: boolean) {
  const t = "[memory-tdai]";
  return { debug: debug ? (m: string) => process.stderr.write(`${t} DEBUG ${m}\n`) : undefined, info: (m: string) => process.stderr.write(`${t} INFO ${m}\n`), warn: (m: string) => process.stderr.write(`${t} WARN ${m}\n`), error: (m: string) => process.stderr.write(`${t} ERROR ${m}\n`) };
}
