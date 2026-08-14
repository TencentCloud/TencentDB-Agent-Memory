import {
  GatewayMemoryAdapter,
  createGatewayAdapterOptions,
  registerMemoryPlatformAdapter,
  type GatewayCaptureParams,
  type GatewayConversationSearchParams,
  type MemoryAdapterProviderConfig,
  type GatewayMemoryAdapterOptions,
  type GatewayMemorySearchParams,
  type GatewayRecallParams,
  type MemoryPlatformAdapterDefinition,
  type PlatformEnv,
} from "../sdk/index.js";

export interface CodexMemoryGatewayClientEnv extends PlatformEnv {
  CODEX_WORKSPACE?: string;
  CODEX_SESSION_ID?: string;
  CODEX_USER_ID?: string;
}

export type CodexMemoryGatewayClientOptions = Partial<Omit<GatewayMemoryAdapterOptions, "platform">> & {
  platform?: "codex";
};
export type CodexRecallParams = GatewayRecallParams;
export type CodexCaptureParams = GatewayCaptureParams;
export type CodexMemorySearchParams = GatewayMemorySearchParams;
export type CodexConversationSearchParams = GatewayConversationSearchParams;

export const CodexMemoryPlatformAdapter: MemoryPlatformAdapterDefinition<CodexMemoryGatewayClientEnv> = {
  platform: "codex",
  fromEnv(env) {
    return {
      baseUrl: env.MEMORY_TENCENTDB_GATEWAY_URL,
      apiKey: env.MEMORY_TENCENTDB_GATEWAY_API_KEY ?? env.TDAI_GATEWAY_API_KEY,
      sessionKey: env.CODEX_SESSION_ID ?? env.CODEX_WORKSPACE ?? process.cwd(),
      userId: env.CODEX_USER_ID,
    };
  },
  fromConfig(config: MemoryAdapterProviderConfig, env = process.env) {
    return {
      baseUrl: config.baseUrl as string | undefined ?? env.MEMORY_TENCENTDB_GATEWAY_URL,
      apiKey: config.apiKey as string | undefined ?? env.MEMORY_TENCENTDB_GATEWAY_API_KEY ?? env.TDAI_GATEWAY_API_KEY,
      timeoutMs: config.timeoutMs as number | undefined,
      sessionEndTimeoutMs: config.sessionEndTimeoutMs as number | undefined,
      fetchImpl: config.fetchImpl as typeof fetch | undefined,
      sessionKey: config.sessionKey as string | undefined ?? env.CODEX_SESSION_ID ?? env.CODEX_WORKSPACE ?? process.cwd(),
      userId: config.userId as string | undefined ?? env.CODEX_USER_ID,
    };
  },
};

registerMemoryPlatformAdapter(CodexMemoryPlatformAdapter);

export class CodexMemoryGatewayClient extends GatewayMemoryAdapter {
  static fromEnv(env: CodexMemoryGatewayClientEnv = process.env): CodexMemoryGatewayClient {
    const defaults = CodexMemoryPlatformAdapter.fromEnv(env);
    return new CodexMemoryGatewayClient({
      baseUrl: defaults.baseUrl,
      apiKey: defaults.apiKey,
      sessionKey: defaults.sessionKey,
      userId: defaults.userId,
    });
  }

  constructor(opts: CodexMemoryGatewayClientOptions = {}) {
    super(createGatewayAdapterOptions({ platform: "codex" }, opts));
  }
}
