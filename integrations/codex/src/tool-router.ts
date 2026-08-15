import type { AdapterLogger, CaptureRequest, McpTextResult } from "./types.js";
import type { CodexAdapterConfig } from "./types.js";
import { GatewayClient } from "./gateway-client.js";
import { GatewaySupervisor } from "./gateway-supervisor.js";
import { ResultFormatter } from "./result-formatter.js";
import { SessionResolver } from "./session-resolver.js";
import type { ToolName } from "./tools.js";

const BREAKER_THRESHOLD = 5;
const BREAKER_COOLDOWN_MS = 60_000;
const RECOVER_COOLDOWN_MS = 15_000;

type Args = Record<string, unknown>;

function textResult(text: string, isError = false): McpTextResult {
  return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
}

function requiredString(args: Args, name: string): string {
  const value = args[name];
  if (typeof value !== "string" || !value.trim()) throw new Error(`Missing required parameter: ${name}`);
  return value.trim();
}

function optionalString(args: Args, name: string): string | undefined {
  const value = args[name];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function limit(args: Args): number {
  const value = args.limit;
  return typeof value === "number" && Number.isInteger(value) ? Math.min(50, Math.max(1, value)) : 5;
}

export class ToolRouter {
  private consecutiveFailures = 0;
  private openUntilMs = 0;
  private lastRecoverAttemptMs = 0;

  constructor(
    private readonly config: CodexAdapterConfig,
    private readonly client: GatewayClient,
    private readonly supervisor: GatewaySupervisor,
    private readonly sessions: SessionResolver,
    private readonly formatter: ResultFormatter,
    private readonly logger: AdapterLogger,
  ) {}

  async call(name: ToolName, args: Args = {}): Promise<McpTextResult> {
    if (name === "agent_memory_health") return this.health();
    if (this.breakerOpen()) return textResult(this.formatter.unavailable("request", "circuit breaker is open"), true);
    if (!(await this.ensureAvailable())) return textResult(this.formatter.unavailable(this.actionName(name), "Gateway is not connected"), true);

    try {
      const result = await this.dispatch(name, args);
      this.recordSuccess();
      return textResult(result);
    } catch (error) {
      this.recordFailure();
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.warn(`${name} failed: ${reason}`);
      return textResult(this.formatter.unavailable(this.actionName(name), reason), true);
    }
  }

  private async health(): Promise<McpTextResult> {
    try {
      if (!(await this.ensureAvailable())) return textResult(this.formatter.unavailable("health check", "Gateway is not connected"), true);
      const result = await this.client.health();
      this.recordSuccess();
      return textResult(this.formatter.health(result));
    } catch (error) {
      this.recordFailure();
      return textResult(this.formatter.unavailable("health check", error instanceof Error ? error.message : String(error)), true);
    }
  }

  private async dispatch(name: ToolName, args: Args): Promise<string> {
    switch (name) {
      case "agent_memory_recall":
        return this.formatter.recall(await this.client.recall({
          query: requiredString(args, "query"),
          session_key: this.sessions.resolve(optionalString(args, "session_key")),
          user_id: optionalString(args, "user_id") ?? this.config.userId,
        }));
      case "agent_memory_capture":
        return this.formatter.capture(await this.client.capture(this.captureRequest(args)));
      case "agent_memory_search":
        return this.formatter.memorySearch(await this.client.searchMemories({
          query: requiredString(args, "query"),
          limit: limit(args),
          type: optionalString(args, "type"),
          scene: optionalString(args, "scene"),
        }));
      case "agent_conversation_search":
        return this.formatter.conversationSearch(await this.client.searchConversations({
          query: requiredString(args, "query"),
          limit: limit(args),
          session_key: optionalString(args, "session_key"),
        }));
      case "agent_memory_session_end":
        return this.formatter.sessionEnd(await this.client.sessionEnd({
          session_key: this.sessions.resolve(optionalString(args, "session_key")),
          user_id: optionalString(args, "user_id") ?? this.config.userId,
        }));
      case "agent_memory_seed":
        if (!("data" in args)) throw new Error("Missing required parameter: data");
        return this.formatter.seed(await this.client.seed({
          data: args.data,
          session_key: optionalString(args, "session_key"),
          strict_round_role: typeof args.strict_round_role === "boolean" ? args.strict_round_role : undefined,
          auto_fill_timestamps: typeof args.auto_fill_timestamps === "boolean" ? args.auto_fill_timestamps : undefined,
          config_override: typeof args.config_override === "object" && args.config_override !== null
            ? args.config_override as Record<string, unknown>
            : undefined,
        }));
      case "agent_memory_health":
        throw new Error("Health is handled separately.");
    }
  }

  private captureRequest(args: Args): CaptureRequest {
    const userContent = requiredString(args, "user_content");
    const assistantContent = requiredString(args, "assistant_content");
    const rawMessages = Array.isArray(args.messages) ? stripMessageTimestamps(args.messages) : undefined;
    const generatedMessages = [
      { role: "user", content: userContent },
      { role: "assistant", content: assistantContent },
    ];
    return {
      user_content: userContent,
      assistant_content: assistantContent,
      session_key: this.sessions.resolve(optionalString(args, "session_key")),
      session_id: optionalString(args, "session_id"),
      user_id: optionalString(args, "user_id") ?? this.config.userId,
      messages: this.config.captureMode === "raw" ? rawMessages ?? generatedMessages
        : this.config.captureMode === "turn" ? rawMessages ?? generatedMessages
          : generatedMessages,
    };
  }

  private async ensureAvailable(): Promise<boolean> {
    const now = Date.now();
    if (now - this.lastRecoverAttemptMs < RECOVER_COOLDOWN_MS) return this.supervisor.isRunning();
    this.lastRecoverAttemptMs = now;
    return this.supervisor.ensureRunning();
  }

  private breakerOpen(): boolean {
    if (Date.now() >= this.openUntilMs) {
      this.openUntilMs = 0;
      return false;
    }
    return true;
  }

  private recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.openUntilMs = 0;
  }

  private recordFailure(): void {
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= BREAKER_THRESHOLD) this.openUntilMs = Date.now() + BREAKER_COOLDOWN_MS;
  }

  private actionName(name: ToolName): string {
    return name.replace(/^agent_memory_/, "").replace(/^agent_/, "").replaceAll("_", " ");
  }
}

/**
 * Gateway capture uses the core's current time as the cursor floor. Codex
 * messages exist before the HTTP request reaches that core, so forwarding
 * their original timestamps can make a brand-new turn look already captured.
 * Let the Gateway assign capture-time timestamps instead. Historical imports
 * that require source timestamps must use `agent_memory_seed`.
 */
function stripMessageTimestamps(messages: unknown[]): unknown[] {
  return messages.map((message) => {
    if (!message || typeof message !== "object" || Array.isArray(message)) return message;
    const { timestamp: _timestamp, ...withoutTimestamp } = message as Record<string, unknown>;
    return withoutTimestamp;
  });
}
