/**
 * Template: Pattern B — HTTP sidecar client (any language, but shows TS).
 *
 * Use this when the target platform runs in a different language or
 * process, and communicates with TdaiCore over HTTP. The standalone
 * Gateway wraps TdaiCore in an HTTP server; the adapter is a thin HTTP
 * client that maps the host's lifecycle events to Gateway endpoints.
 *
 * This template shows the TypeScript version of the client. For Python,
 * copy hermes-plugin/memory/memory_tencentdb/client.py as the baseline.
 *
 * Replace every `TODO` with your platform's specific API.
 */

// ── Minimal HTTP client (stdlib only, no framework dependency) ─────────

const DEFAULT_BASE_URL = "http://127.0.0.1:8420";

class GatewayClient {
  constructor(private baseUrl: string = DEFAULT_BASE_URL) {}

  private async post(path: string, body: Record<string, unknown>): Promise<unknown> {
    const resp = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      throw new Error(`Gateway ${path} returned ${resp.status}`);
    }
    return resp.json();
  }

  // ── Tool endpoints ──────────────────────────────────────────────────

  async searchMemories(query: string, limit = 5, type?: string, scene?: string) {
    return this.post("/search/memories", { query, limit, ...(type ? { type } : {}), ...(scene ? { scene } : {}) });
  }

  async searchConversations(query: string, limit = 5, sessionKey?: string) {
    return this.post("/search/conversations", { query, limit, ...(sessionKey ? { session_key: sessionKey } : {}) });
  }

  async recall(query: string, sessionKey: string) {
    return this.post("/recall", { query, session_key: sessionKey });
  }

  async capture(userContent: string, assistantContent: string, sessionKey: string) {
    return this.post("/capture", {
      user_content: userContent,
      assistant_content: assistantContent,
      session_key: sessionKey,
    });
  }

  async endSession(sessionKey: string) {
    return this.post("/session/end", { session_key: sessionKey });
  }
}

// ── Step 1: Wire to your host ──────────────────────────────────────────

export async function startSidecarAdapter() {
  const client = new GatewayClient(
    process.env.TDAI_GATEWAY_URL ?? DEFAULT_BASE_URL,
  );

  // ── Register tools ───────────────────────────────────────────────────
  // TODO: Replace with your host's tool-registration API

  const tools = [
    {
      name: "memory_tencentdb_memory_search",
      description: "Search structured memories (L1)",
      execute: async (params: Record<string, unknown>) => {
        const result = await client.searchMemories(
          String(params.query),
          Number(params.limit) || 5,
          typeof params.type === "string" ? params.type : undefined,
          typeof params.scene === "string" ? params.scene : undefined,
        );
        return JSON.stringify(result);
      },
    },
    {
      name: "memory_tencentdb_conversation_search",
      description: "Search raw conversations (L0)",
      execute: async (params: Record<string, unknown>) => {
        const result = await client.searchConversations(
          String(params.query),
          Number(params.limit) || 5,
          typeof params.session_key === "string" ? params.session_key : undefined,
        );
        return JSON.stringify(result);
      },
    },
  ];

  // TODO: myHost.registerTools(tools);

  // ── Wire lifecycle ───────────────────────────────────────────────────
  // TODO: Replace with your host's hook system

  // myHost.on("beforePrompt", async (query, sessionKey) => {
  //   const result = await client.recall(query, sessionKey);
  //   return result.context; // inject into prompt
  // });

  // myHost.on("afterTurn", async (userContent, assistantContent, sessionKey) => {
  //   // Fire-and-forget — don't block the next turn
  //   client.capture(userContent, assistantContent, sessionKey).catch(() => {});
  // });

  // myHost.on("sessionEnd", async (sessionKey) => {
  //   await client.endSession(sessionKey);
  // });

  return { client };
}
