import { randomUUID } from "node:crypto";
import { GatewayClient } from "../gateway/client.js";
import { GatewaySupervisor } from "../gateway/supervisor.js";
import { createMemoryAgent, type MemoryAgentSession } from "../memory-agent.js";
import { runFromStream, streamFromUnknownResult, withAbortController } from "../drivers/common.js";
import type {
  AgentSdkDriver,
  AgentSdkName,
  AgentSdkRunInput,
  AgentSdkRunResult,
  AgentSdkSession,
  GatewayClientLike,
  GatewaySupervisorLike,
  GatewaySupervisorOptions,
  InjectMemory,
  JsonRecord,
  Logger,
  MemoryAgentStreamEvent,
} from "../types.js";

export interface MemoryWrapperOptions {
  gateway?: GatewayClientLike;
  supervisor?: GatewaySupervisorLike;
  gatewayOptions?: Omit<GatewaySupervisorOptions, "agentSdkName">;
  sessionKey?: string;
  userId?: string;
  strict?: boolean;
  injectMemory?: InjectMemory;
  logger?: Logger;
}

export class MemoryWrapperRuntime {
  readonly sessionKey: string;

  private readonly agentSdkName: AgentSdkName;
  private readonly gateway: GatewayClientLike;
  private readonly supervisor: GatewaySupervisorLike;
  private readonly userId?: string;
  private readonly strict: boolean;
  private readonly injectMemory?: InjectMemory;
  private readonly logger?: Logger;
  private readonly ownsSupervisor: boolean;

  constructor(agentSdkName: AgentSdkName, options: MemoryWrapperOptions) {
    this.agentSdkName = agentSdkName;
    this.sessionKey = options.sessionKey ?? `agent-sdk:${agentSdkName}:${randomUUID()}`;
    this.userId = options.userId;
    this.strict = options.strict ?? false;
    this.injectMemory = options.injectMemory;
    this.logger = options.logger;

    if (options.supervisor) {
      this.supervisor = options.supervisor;
      this.ownsSupervisor = false;
    } else {
      this.supervisor = new GatewaySupervisor({
        ...options.gatewayOptions,
        agentSdkName,
        apiKey: options.gatewayOptions?.apiKey,
        logger: options.logger,
      });
      this.ownsSupervisor = true;
    }

    this.gateway = options.gateway ?? new GatewayClient({
      gatewayUrl: this.supervisor.endpoints.gatewayUrl,
      apiKey: this.supervisor.endpoints.apiKey,
      timeoutMs: options.gatewayOptions?.requestTimeoutMs,
    });
  }

  async startMemorySession(driverSession: AgentSdkSession, sessionKey = this.sessionKey): Promise<MemoryAgentSession> {
    const driver: AgentSdkDriver = {
      name: this.agentSdkName,
      startSession: async () => driverSession,
    };
    const agent = createMemoryAgent({
      agentSdkName: this.agentSdkName,
      driver,
      gateway: this.gateway,
      supervisor: this.supervisor,
      sessionKey,
      userId: this.userId,
      strict: this.strict,
      injectMemory: this.injectMemory,
      logger: this.logger,
    });
    return agent.startSession();
  }

  async flush(sessionKey = this.sessionKey): Promise<void> {
    try {
      await this.gateway.endSession({ sessionKey, userId: this.userId });
    } catch (error) {
      if (this.strict) throw error;
    }
  }

  async close(): Promise<void> {
    if (this.ownsSupervisor) {
      await this.supervisor.close();
    }
  }
}

export class InvokedAgentSession implements AgentSdkSession {
  constructor(
    private readonly invoke: (prompt: string, signal?: AbortSignal) => unknown,
  ) {}

  async *stream(input: AgentSdkRunInput) {
    yield* streamFromUnknownResult(await this.invoke(input.prompt, input.signal));
  }

  run(input: AgentSdkRunInput): Promise<AgentSdkRunResult> {
    return runFromStream(this, input);
  }
}

export async function runRawWithMemory(options: {
  runtime: MemoryWrapperRuntime;
  sessionKey?: string;
  prompt: string;
  signal?: AbortSignal;
  invoke: (prompt: string, signal?: AbortSignal) => unknown;
}): Promise<unknown> {
  const memorySession = await options.runtime.startMemorySession(
    new InvokedAgentSession(options.invoke),
    options.sessionKey,
  );
  const result = await memorySession.run({ prompt: options.prompt, signal: options.signal });
  return result.rawResult ?? result.text;
}

export async function* streamRawWithMemory(options: {
  runtime: MemoryWrapperRuntime;
  sessionKey?: string;
  prompt: string;
  signal?: AbortSignal;
  invoke: (prompt: string, signal?: AbortSignal) => unknown;
}): AsyncIterable<unknown> {
  const memorySession = await options.runtime.startMemorySession(
    new InvokedAgentSession(options.invoke),
    options.sessionKey,
  );
  let sawRawEvent = false;
  for await (const event of memorySession.stream({ prompt: options.prompt, signal: options.signal })) {
    if (event.type === "agent.event") {
      sawRawEvent = true;
      yield event.event;
    } else if (event.type === "agent.text.delta" && !sawRawEvent) {
      yield event.text;
    }
  }
}

export function readStringPrompt(value: unknown, methodName: string): string {
  if (typeof value === "string") return value;
  throw new Error(`${methodName} memory wrapper currently supports string prompts only.`);
}

export function readSignal(options: unknown): AbortSignal | undefined {
  if (!isRecord(options)) return undefined;
  return options.signal instanceof AbortSignal ? options.signal : undefined;
}

export function readAbortSignal(options: unknown): AbortSignal | undefined {
  if (!isRecord(options)) return undefined;
  if (options.abortController instanceof AbortController) {
    return options.abortController.signal;
  }
  return readSignal(options);
}

export function withSignal<T>(options: T, signal?: AbortSignal): T {
  if (!signal) return options;
  if (isRecord(options)) {
    return { ...options, signal } as T;
  }
  return { signal } as T;
}

export { withAbortController };

export function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export type MemoryPassthroughEvent = MemoryAgentStreamEvent;
