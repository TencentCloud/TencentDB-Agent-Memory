import {
  TdaiGatewayClient,
  createGatewaySessionKey,
  type TdaiGatewayClientOptions,
} from "../gateway-client.js";
import type { CaptureResponse, RecallResponse } from "../../gateway/types.js";

export interface GatewayMemoryClient {
  recall(body: { query: string; session_key: string; user_id?: string }): Promise<RecallResponse>;
  capture(body: {
    user_content: string;
    assistant_content: string;
    session_key: string;
    session_id?: string;
    user_id?: string;
    messages?: unknown[];
  }): Promise<CaptureResponse>;
}

export interface DifyWorkflowMemoryAdapterOptions {
  gateway?: TdaiGatewayClientOptions;
  client?: GatewayMemoryClient;
  platform?: string;
  defaultUserId?: string;
}

export interface DifyWorkflowInput {
  query?: string;
  user_content?: string;
  assistant_content?: string;
  answer?: string;
  conversation_id?: string;
  session_id?: string;
  user?: string;
  user_id?: string;
  inputs?: Record<string, unknown>;
  messages?: unknown[];
}

export interface DifyRecallResult {
  session_key: string;
  memory_context: string;
  memory_count: number;
  strategy?: string;
}

export interface DifyCaptureResult extends CaptureResponse {
  session_key: string;
}

export class DifyWorkflowMemoryAdapter {
  private readonly client: GatewayMemoryClient;
  private readonly platform: string;
  private readonly defaultUserId: string;

  constructor(opts: DifyWorkflowMemoryAdapterOptions) {
    if (!opts.client && !opts.gateway) {
      throw new Error("DifyWorkflowMemoryAdapter requires either `client` or `gateway` options");
    }
    this.client = opts.client ?? new TdaiGatewayClient(opts.gateway!);
    this.platform = opts.platform ?? "dify";
    this.defaultUserId = opts.defaultUserId ?? "default_user";
  }

  /**
   * Call before the Dify LLM node. Return `memory_context` as a workflow
   * variable and inject it into the system prompt or user prompt template.
   */
  async recall(input: DifyWorkflowInput): Promise<DifyRecallResult> {
    const query = readString(input, "query", "user_content", "prompt", "message");
    if (!query) throw new Error("Dify recall requires `query` or `inputs.query`");

    const identity = this.resolveIdentity(input);
    const result = await this.client.recall({
      query,
      session_key: identity.sessionKey,
      user_id: identity.userId,
    });

    return {
      session_key: identity.sessionKey,
      memory_context: result.context,
      memory_count: result.memory_count ?? 0,
      strategy: result.strategy,
    };
  }

  /**
   * Call after the Dify answer node. This stores the completed turn in L0 and
   * lets the Gateway schedule L1/L2/L3 processing.
   */
  async capture(input: DifyWorkflowInput): Promise<DifyCaptureResult> {
    const userContent = readString(input, "user_content", "query", "prompt", "message");
    const assistantContent = readString(input, "assistant_content", "answer", "response", "output");
    if (!userContent) throw new Error("Dify capture requires `user_content` or `query`");
    if (!assistantContent) throw new Error("Dify capture requires `assistant_content` or `answer`");

    const identity = this.resolveIdentity(input);
    const result = await this.client.capture({
      user_content: userContent,
      assistant_content: assistantContent,
      session_key: identity.sessionKey,
      session_id: identity.sessionId,
      user_id: identity.userId,
      messages: input.messages,
    });

    return {
      ...result,
      session_key: identity.sessionKey,
    };
  }

  buildSessionKey(input: DifyWorkflowInput): string {
    return this.resolveIdentity(input).sessionKey;
  }

  private resolveIdentity(input: DifyWorkflowInput): {
    userId: string;
    conversationId: string;
    sessionId?: string;
    sessionKey: string;
  } {
    const userId = readString(input, "user_id", "user") ?? this.defaultUserId;
    const conversationId =
      readString(input, "conversation_id", "conversationId") ??
      readString(input, "session_id", "sessionId") ??
      "default_conversation";
    const sessionId = readString(input, "session_id", "sessionId");
    return {
      userId,
      conversationId,
      sessionId,
      sessionKey: createGatewaySessionKey({
        platform: this.platform,
        userId,
        conversationId,
        sessionId,
      }),
    };
  }
}

export function createDifyWorkflowMemoryAdapter(
  opts: DifyWorkflowMemoryAdapterOptions,
): DifyWorkflowMemoryAdapter {
  return new DifyWorkflowMemoryAdapter(opts);
}

function readString(input: DifyWorkflowInput, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const direct = (input as Record<string, unknown>)[key];
    if (typeof direct === "string" && direct.trim()) return direct;
    const nested = input.inputs?.[key];
    if (typeof nested === "string" && nested.trim()) return nested;
  }
  return undefined;
}
