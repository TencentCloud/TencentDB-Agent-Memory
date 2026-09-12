/**
 * MCP Server + Session Watcher configuration from environment variables.
 */

export interface TdaiMcpConfig {
  gateway: {
    host: string;
    port: number;
    apiKey?: string;
    baseUrl: string;
  };
  watcher: {
    /** Polling interval in milliseconds (default: 5000 = 5s) */
    pollIntervalMs: number;
    /** Target adapters to watch ("opencode", "codex") */
    adapters: string[];
  };
  agentMemory: {
    /** Directory for recall context files that agents read */
    contextDir: string;
    /** Directory for watcher state (cursors) */
    stateDir: string;
  };
}

export function loadConfig(): TdaiMcpConfig {
  const host = process.env.TDAI_GATEWAY_HOST ?? "127.0.0.1";
  const port = parseInt(process.env.TDAI_GATEWAY_PORT ?? "8420", 10);
  const apiKey = process.env.TDAI_GATEWAY_API_KEY ?? undefined;
  const pollIntervalMs = parseInt(process.env.TDAI_WATCHER_POLL_MS ?? "5000", 10);
  const adaptersStr = process.env.TDAI_WATCHER_ADAPTERS ?? "opencode,codex";
  const adapters = adaptersStr.split(",").map((s) => s.trim()).filter(Boolean);

  const homeDir = process.env.HOME ?? process.env.USERPROFILE ?? "/tmp";
  const dataDir = process.env.TDAI_MCP_DATA_DIR ?? `${homeDir}/.agent-memory`;

  return {
    gateway: {
      host,
      port,
      apiKey,
      baseUrl: `http://${host}:${port}`,
    },
    watcher: {
      pollIntervalMs,
      adapters,
    },
    agentMemory: {
      contextDir: `${dataDir}/recall`,
      stateDir: `${dataDir}/watcher-state`,
    },
  };
}
