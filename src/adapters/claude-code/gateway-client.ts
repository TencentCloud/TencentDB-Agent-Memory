import {
  GatewayMemoryAdapter,
  createGatewayAdapterOptions,
  registerMemoryPlatformAdapter,
  type GatewayMemoryAdapterOptions,
  type MemoryAdapterProviderConfig,
  type MemoryPlatformAdapterDefinition,
  type PlatformEnv,
} from "../sdk/index.js";

export interface ClaudeCodeMemoryAdapterEnv extends PlatformEnv {
  CLAUDE_CODE_MEMORY_GATEWAY_URL?: string;
  CLAUDE_CODE_MEMORY_API_KEY?: string;
  CLAUDE_CODE_WORKSPACE?: string;
  CLAUDE_CODE_SESSION_ID?: string;
  CLAUDE_CODE_USER_ID?: string;
}

export type ClaudeCodeMemoryAdapterOptions = Partial<Omit<GatewayMemoryAdapterOptions, "platform">> & {
  platform?: "claude-code";
};

export const ClaudeCodeMemoryPlatformAdapter: MemoryPlatformAdapterDefinition<ClaudeCodeMemoryAdapterEnv> = {
  platform: "claude-code",
  fromEnv(env) {
    return {
      baseUrl: env.CLAUDE_CODE_MEMORY_GATEWAY_URL ?? env.MEMORY_TENCENTDB_GATEWAY_URL,
      apiKey: env.CLAUDE_CODE_MEMORY_API_KEY ?? env.MEMORY_TENCENTDB_GATEWAY_API_KEY ?? env.TDAI_GATEWAY_API_KEY,
      sessionKey: env.CLAUDE_CODE_SESSION_ID ?? env.CLAUDE_CODE_WORKSPACE ?? process.cwd(),
      userId: env.CLAUDE_CODE_USER_ID,
    };
  },
  fromConfig(config: MemoryAdapterProviderConfig, env = process.env) {
    return {
      baseUrl: config.baseUrl as string | undefined ?? env.CLAUDE_CODE_MEMORY_GATEWAY_URL ?? env.MEMORY_TENCENTDB_GATEWAY_URL,
      apiKey: config.apiKey as string | undefined ?? env.CLAUDE_CODE_MEMORY_API_KEY ?? env.MEMORY_TENCENTDB_GATEWAY_API_KEY ?? env.TDAI_GATEWAY_API_KEY,
      timeoutMs: config.timeoutMs as number | undefined,
      sessionEndTimeoutMs: config.sessionEndTimeoutMs as number | undefined,
      fetchImpl: config.fetchImpl as typeof fetch | undefined,
      sessionKey: config.sessionKey as string | undefined ?? env.CLAUDE_CODE_SESSION_ID ?? env.CLAUDE_CODE_WORKSPACE ?? process.cwd(),
      userId: config.userId as string | undefined ?? env.CLAUDE_CODE_USER_ID,
    };
  },
};

registerMemoryPlatformAdapter(ClaudeCodeMemoryPlatformAdapter);

export class ClaudeCodeMemoryAdapter extends GatewayMemoryAdapter {
  static fromEnv(env: ClaudeCodeMemoryAdapterEnv = process.env): ClaudeCodeMemoryAdapter {
    const defaults = ClaudeCodeMemoryPlatformAdapter.fromEnv(env);
    return new ClaudeCodeMemoryAdapter({
      baseUrl: defaults.baseUrl,
      apiKey: defaults.apiKey,
      sessionKey: defaults.sessionKey,
      userId: defaults.userId,
    });
  }

  constructor(opts: ClaudeCodeMemoryAdapterOptions = {}) {
    super(createGatewayAdapterOptions({ platform: "claude-code" }, opts));
  }
}
