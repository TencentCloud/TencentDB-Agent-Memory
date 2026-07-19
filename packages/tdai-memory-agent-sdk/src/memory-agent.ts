import { randomUUID } from "node:crypto";
import { GatewayClient } from "./gateway/client.js";
import { GatewaySupervisor } from "./gateway/supervisor.js";
import type {
  AgentSdkDriver,
  AgentSdkRunInput,
  AgentSdkRunResult,
  AgentSdkSession,
  CaptureResponse,
  GatewayClientLike,
  GatewaySupervisorLike,
  InjectMemory,
  MemoryAgentOptions,
  MemoryAgentRunResult,
  MemoryAgentSessionOptions,
  MemoryAgentStreamEvent,
  RecallResponse,
} from "./types.js";

const DEFAULT_PROMPT_TEMPLATE: InjectMemory = (memoryText, userPrompt) => {
  if (!memoryText.trim()) return userPrompt;
  return [
    "# Long-term Memory Context",
    "",
    memoryText,
    "",
    "# User Request",
    "",
    userPrompt,
  ].join("\n");
};

export function createMemoryAgent(options: MemoryAgentOptions): MemoryAgent {
  return new MemoryAgent(options);
}

export class MemoryAgent {
  private readonly driver: AgentSdkDriver;
  private readonly gateway: GatewayClientLike;
  private readonly supervisor: GatewaySupervisorLike;
  private readonly sessionKey?: string;
  private readonly userId?: string;
  private readonly strict: boolean;
  private readonly injectMemory: InjectMemory;
  private readonly ownsSupervisor: boolean;

  constructor(options: MemoryAgentOptions) {
    this.driver = options.driver;
    this.sessionKey = options.sessionKey;
    this.userId = options.userId;
    this.strict = options.strict ?? false;
    this.injectMemory = options.injectMemory ?? DEFAULT_PROMPT_TEMPLATE;

    if (options.supervisor) {
      this.supervisor = options.supervisor;
      this.ownsSupervisor = false;
    } else {
      this.supervisor = new GatewaySupervisor({
        ...options.gatewayOptions,
        agentSdkName: options.agentSdkName,
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

  async startSession(options: MemoryAgentSessionOptions = {}): Promise<MemoryAgentSession> {
    await this.supervisor.ensureRunning();
    const driverSession = await this.driver.startSession(options);
    return new MemoryAgentSession({
      driverSession,
      gateway: this.gateway,
      supervisor: this.supervisor,
      sessionKey: options.sessionKey ?? this.sessionKey ?? `agent-sdk:${this.driver.name}:${randomUUID()}`,
      sessionId: options.sessionId,
      userId: options.userId ?? this.userId,
      strict: this.strict,
      injectMemory: this.injectMemory,
    });
  }

  async close(): Promise<void> {
    if (this.ownsSupervisor) {
      await this.supervisor.close();
    }
  }
}

interface MemoryAgentSessionDeps {
  driverSession: AgentSdkSession;
  gateway: GatewayClientLike;
  supervisor: GatewaySupervisorLike;
  sessionKey: string;
  sessionId?: string;
  userId?: string;
  strict: boolean;
  injectMemory: InjectMemory;
}

export class MemoryAgentSession {
  private readonly driverSession: AgentSdkSession;
  private readonly gateway: GatewayClientLike;
  private readonly supervisor: GatewaySupervisorLike;
  private readonly sessionKey: string;
  private readonly sessionId?: string;
  private readonly userId?: string;
  private readonly strict: boolean;
  private readonly injectMemory: InjectMemory;

  constructor(deps: MemoryAgentSessionDeps) {
    this.driverSession = deps.driverSession;
    this.gateway = deps.gateway;
    this.supervisor = deps.supervisor;
    this.sessionKey = deps.sessionKey;
    this.sessionId = deps.sessionId;
    this.userId = deps.userId;
    this.strict = deps.strict;
    this.injectMemory = deps.injectMemory;
  }

  async *stream(input: AgentSdkRunInput): AsyncIterable<MemoryAgentStreamEvent> {
    await this.supervisor.ensureRunning();

    const turnStartedAt = Date.now();
    let recall: RecallResponse | null = null;
    let prompt = input.prompt;
    try {
      recall = await this.gateway.recall({
        query: input.prompt,
        sessionKey: this.sessionKey,
        userId: this.userId,
      });
      yield {
        type: "memory.recall",
        context: recall.context,
        strategy: recall.strategy,
        memoryCount: recall.memoryCount,
      };
      if (recall.context.trim()) {
        prompt = this.injectMemory(recall.context, input.prompt);
        yield { type: "memory.injected", prompt };
      }
    } catch (error) {
      yield { type: "memory.error", phase: "recall", error };
      if (this.strict) throw error;
    }

    const assistantChunks: string[] = [];
    for await (const event of this.driverSession.stream({ ...input, prompt })) {
      if (event.type === "agent.text.delta") {
        assistantChunks.push(event.text);
      } else if (event.type === "agent.completed" && event.text) {
        const current = assistantChunks.join("");
        if (!current || current !== event.text) {
          assistantChunks.length = 0;
          assistantChunks.push(event.text);
        }
      }
      yield event;
    }

    const assistantText = assistantChunks.join("");
    const assistantTimestamp = Math.max(Date.now(), turnStartedAt + 1);
    let capture: CaptureResponse | null = null;
    try {
      capture = await this.gateway.capture({
        userContent: input.prompt,
        assistantContent: assistantText,
        sessionKey: this.sessionKey,
        sessionId: this.sessionId,
        userId: this.userId,
        startedAt: Math.max(0, turnStartedAt - 1),
        messages: [
          { role: "user", content: input.prompt, timestamp: turnStartedAt },
          { role: "assistant", content: assistantText, timestamp: assistantTimestamp },
        ],
      });
      yield { type: "memory.capture", response: capture };
    } catch (error) {
      yield { type: "memory.error", phase: "capture", error };
      if (this.strict) throw error;
    }
  }

  async run(input: AgentSdkRunInput): Promise<MemoryAgentRunResult> {
    const events: MemoryAgentStreamEvent[] = [];
    const textChunks: string[] = [];
    let rawResult: unknown;
    let recalled: RecallResponse | null = null;
    let captured: CaptureResponse | null = null;

    for await (const event of this.stream(input)) {
      events.push(event);
      if (event.type === "agent.text.delta") {
        textChunks.push(event.text);
      } else if (event.type === "agent.completed") {
        rawResult = event.result;
        if (event.text) {
          textChunks.length = 0;
          textChunks.push(event.text);
        }
      } else if (event.type === "memory.recall") {
        recalled = {
          context: event.context,
          strategy: event.strategy,
          memoryCount: event.memoryCount,
        };
      } else if (event.type === "memory.capture") {
        captured = event.response;
      }
    }

    return {
      text: textChunks.join(""),
      rawResult,
      memory: { recalled, captured },
      events,
    };
  }

  async end(): Promise<void> {
    try {
      await this.gateway.endSession({
        sessionKey: this.sessionKey,
        userId: this.userId,
      });
    } catch (error) {
      if (this.strict) throw error;
    } finally {
      await this.driverSession.close?.();
    }
  }
}

export async function runAgentSession(session: AgentSdkSession, input: AgentSdkRunInput): Promise<AgentSdkRunResult> {
  if (session.run) return session.run(input);

  const events = [];
  const textChunks: string[] = [];
  let rawResult: unknown;
  for await (const event of session.stream(input)) {
    events.push(event);
    if (event.type === "agent.text.delta") {
      textChunks.push(event.text);
    } else if (event.type === "agent.completed") {
      rawResult = event.result;
      if (event.text) {
        textChunks.length = 0;
        textChunks.push(event.text);
      }
    }
  }
  return { text: textChunks.join(""), rawResult, events };
}
