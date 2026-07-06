import {
  GatewayMemoryAdapter,
  createGatewayAdapterOptions,
  registerMemoryPlatformAdapter,
  type GatewayMemoryAdapterOptions,
  type MemoryAdapterProviderConfig,
  type MemoryPlatformAdapterDefinition,
  type PlatformEnv,
} from "../sdk/index.js";

export interface CodeBuddyMemoryAdapterEnv extends PlatformEnv {
  CODEBUDDY_MEMORY_GATEWAY_URL?: string;
  CODEBUDDY_MEMORY_API_KEY?: string;
  CODEBUDDY_WORKSPACE?: string;
  CODEBUDDY_SESSION_ID?: string;
  CODEBUDDY_USER_ID?: string;
}

export type CodeBuddyMemoryAdapterOptions = Partial<Omit<GatewayMemoryAdapterOptions, "platform">> & {
  platform?: "codebuddy";
};

export const CodeBuddyMemoryPlatformAdapter: MemoryPlatformAdapterDefinition<CodeBuddyMemoryAdapterEnv> = {
  platform: "codebuddy",
  fromEnv(env) {
    return {
      baseUrl: env.CODEBUDDY_MEMORY_GATEWAY_URL ?? env.MEMORY_TENCENTDB_GATEWAY_URL,
      apiKey: env.CODEBUDDY_MEMORY_API_KEY ?? env.MEMORY_TENCENTDB_GATEWAY_API_KEY ?? env.TDAI_GATEWAY_API_KEY,
      sessionKey: env.CODEBUDDY_SESSION_ID ?? env.CODEBUDDY_WORKSPACE ?? process.cwd(),
      userId: env.CODEBUDDY_USER_ID,
    };
  },
  fromConfig(config: MemoryAdapterProviderConfig, env = process.env) {
    return {
      baseUrl: config.baseUrl as string | undefined ?? env.CODEBUDDY_MEMORY_GATEWAY_URL ?? env.MEMORY_TENCENTDB_GATEWAY_URL,
      apiKey: config.apiKey as string | undefined ?? env.CODEBUDDY_MEMORY_API_KEY ?? env.MEMORY_TENCENTDB_GATEWAY_API_KEY ?? env.TDAI_GATEWAY_API_KEY,
      timeoutMs: config.timeoutMs as number | undefined,
      fetchImpl: config.fetchImpl as typeof fetch | undefined,
      sessionKey: config.sessionKey as string | undefined ?? env.CODEBUDDY_SESSION_ID ?? env.CODEBUDDY_WORKSPACE ?? process.cwd(),
      userId: config.userId as string | undefined ?? env.CODEBUDDY_USER_ID,
    };
  },
};

registerMemoryPlatformAdapter(CodeBuddyMemoryPlatformAdapter);

export class CodeBuddyMemoryAdapter extends GatewayMemoryAdapter {
  static fromEnv(env: CodeBuddyMemoryAdapterEnv = process.env): CodeBuddyMemoryAdapter {
    const defaults = CodeBuddyMemoryPlatformAdapter.fromEnv(env);
    return new CodeBuddyMemoryAdapter({
      baseUrl: defaults.baseUrl,
      apiKey: defaults.apiKey,
      sessionKey: defaults.sessionKey,
      userId: defaults.userId,
    });
  }

  constructor(opts: CodeBuddyMemoryAdapterOptions = {}) {
    super(createGatewayAdapterOptions({ platform: "codebuddy" }, opts));
  }
}
