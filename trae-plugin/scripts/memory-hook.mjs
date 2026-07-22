// trae-plugin/scripts/memory-hook.mjs
// Trae lifecycle hook entry point - reads stdin JSON → calls compiled hook-handler → outputs additionalContext

// NOTE: dist/ is built by `pnpm build` (tsdown). Import paths below assume the current
// tsdown layout (dist/src/adapters/..., fixedExtension:false); if build config changes,
// update these paths. The inline FetchGatewayClient is transitional — replace with
// PR #316's GatewayMemoryClient once it merges (structurally compatible).
import { handleTraeHook } from "../../dist/src/adapters/trae/hook-handler.js";
import { TdaiBridge } from "../../dist/src/adapters/tdai-bridge/tdai-bridge.js";

// Minimal GatewayClient implementation using fetch (mirrors mcp-server.ts client)
class FetchGatewayClient {
  constructor(baseUrl, apiKey, timeoutMs = 10000) {
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
    this.timeoutMs = timeoutMs;
  }

  async fetchEndpoint(path, body) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const responseBody = await response.text();
        const error = new Error(`HTTP ${response.status}: ${response.statusText}`);
        error.status = response.status;
        error.responseBody = responseBody;
        throw error;
      }

      return await response.json();
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async recall(body) {
    return this.fetchEndpoint("/recall", body);
  }

  async capture(body) {
    return this.fetchEndpoint("/capture", body);
  }

  async searchMemories(body) {
    return this.fetchEndpoint("/search/memories", body);
  }

  async searchConversations(body) {
    return this.fetchEndpoint("/search/conversations", body);
  }

  async endSession(body) {
    return this.fetchEndpoint("/session/end", body);
  }
}

function requireEnv(k) {
  const v = process.env[k];
  if (!v) throw new Error(`missing env var: ${k}`);
  return v;
}

async function readStdinJson() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf-8"));
  } catch {
    return {};
  }
}

async function main() {
  const event = process.argv[2];
  const input = await readStdinJson();

  const client = new FetchGatewayClient(
    requireEnv("TDAI_GATEWAY_URL"),
    requireEnv("TDAI_GATEWAY_API_KEY"),
    Number(process.env.TDAI_GATEWAY_TIMEOUT_MS ?? 10000)
  );

  const bridge = new TdaiBridge(client);
  const sessionKey = process.env.TRAE_SESSION_KEY ?? "trae-default";

  const out = await handleTraeHook(event, input, bridge, sessionKey);
  process.stdout.write(JSON.stringify(out));
}

main().catch((err) => {
  console.error("[memory-hook] error:", err.message);
  process.exit(1);
});
