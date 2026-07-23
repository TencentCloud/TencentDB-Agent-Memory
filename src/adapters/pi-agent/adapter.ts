import { loadPiAgentAdapterConfig } from "./config.js";
import { PiAgentGatewayClient } from "./gateway-client.js";
import { PiAgentLifecycleAdapter } from "./lifecycle.js";
import { PiAgentMemoryTools } from "./tools.js";
import type {
  PiAgentAdapterConfig,
  PiAgentBeforeAgentStartEvent,
  PiAgentContextInjector,
  PiAgentExtensionContext,
  PiAgentSessionEvent,
  PiAgentToolEvent,
} from "./types.js";

export interface PiAgentMemoryAdapterOptions {
  config?: Partial<PiAgentAdapterConfig>;
  env?: NodeJS.ProcessEnv;
  client?: PiAgentGatewayClient;
  injectContext?: PiAgentContextInjector;
}

export class PiAgentMemoryAdapter {
  readonly config: PiAgentAdapterConfig;
  readonly client: PiAgentGatewayClient;
  readonly lifecycle: PiAgentLifecycleAdapter;
  readonly tools: PiAgentMemoryTools;

  constructor(options: PiAgentMemoryAdapterOptions = {}) {
    this.config = { ...loadPiAgentAdapterConfig(options.env), ...(options.config ?? {}) };
    this.client = options.client ?? new PiAgentGatewayClient({
      baseUrl: this.config.gatewayUrl,
      apiKey: this.config.gatewayApiKey,
    });
    this.lifecycle = new PiAgentLifecycleAdapter(this.client, this.config, options.injectContext);
    this.tools = new PiAgentMemoryTools(this.client);
  }

  onBeforeAgentStart(event: PiAgentBeforeAgentStartEvent, ctx?: PiAgentExtensionContext) {
    return this.lifecycle.onBeforeAgentStart(event, ctx);
  }

  onSessionShutdown(event: PiAgentSessionEvent, ctx?: PiAgentExtensionContext) {
    return this.lifecycle.onSessionShutdown(event, ctx);
  }

  onSessionStart(event: PiAgentSessionEvent, ctx?: PiAgentExtensionContext) {
    return this.lifecycle.onSessionStart(event, ctx);
  }

  onSessionEnd(event: PiAgentSessionEvent, ctx?: PiAgentExtensionContext) {
    return this.lifecycle.onSessionEnd(event, ctx);
  }

  onToolResult(_event: PiAgentToolEvent) {
    return {
      captured: false,
      skippedReason: "Pi Agent v1 reserves tool_result short-term capture for the next stage.",
    };
  }

  memorySearch(args: Parameters<PiAgentMemoryTools["memorySearch"]>[0]) {
    return this.tools.memorySearch(args);
  }

  conversationSearch(args: Parameters<PiAgentMemoryTools["conversationSearch"]>[0]) {
    return this.tools.conversationSearch(args);
  }

  contextGet(args: Parameters<PiAgentMemoryTools["contextGet"]>[0]) {
    return this.tools.contextGet(args);
  }
}