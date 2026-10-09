import { MemoryPlatformAdapter, type MemoryAdapterOptions } from "../platform/memory-adapter.js";
import {
  normalizeSessionPart,
  type MemoryAdapterRuntime,
  type MemoryPlatformBridge,
  type MemoryPromptContext,
  type MemoryTurnPayload,
} from "../platform/bridge.js";
import type { MemoryGatewayClientOptions } from "../platform/gateway-client.js";

export interface DifyRequestContext {
  appId?: string;
  userId?: string;
  conversationId?: string;
  workflowRunId?: string;
  messageId?: string;
  query?: string;
  answer?: string;
  inputs?: Record<string, unknown>;
}

export interface DifyMemoryAdapterOptions extends MemoryGatewayClientOptions, DifyRequestContext {
  sessionId?: string;
  sessionKey?: string;
  workspaceDir?: string;
}

export type DifyPromptContext = MemoryPromptContext;

export interface DifyTurnPayload {
  query: string;
  answer: string;
  inputs?: Record<string, unknown>;
  rawRequest?: unknown;
  rawResponse?: unknown;
}

export class DifyMemoryBridge implements MemoryPlatformBridge {
  private readonly runtime: MemoryAdapterRuntime;
  private readonly requestContext: DifyRequestContext;

  constructor(opts: DifyMemoryAdapterOptions = {}) {
    const workspaceDir = opts.workspaceDir ?? process.env.DIFY_WORKSPACE_DIR ?? process.cwd();
    const appId = normalizeSessionPart(opts.appId ?? process.env.DIFY_APP_ID, "default-app");
    const userId = normalizeSessionPart(opts.userId ?? process.env.DIFY_USER_ID, "default_user");
    const conversationId = normalizeSessionPart(
      opts.conversationId ?? process.env.DIFY_CONVERSATION_ID,
      opts.workflowRunId ?? process.env.DIFY_WORKFLOW_RUN_ID ?? opts.messageId ?? process.env.DIFY_MESSAGE_ID ?? "default-conversation",
    );
    const sessionId = normalizeSessionPart(opts.sessionId, conversationId);
    const sessionKey = opts.sessionKey ?? process.env.DIFY_SESSION_KEY ?? `dify:${appId}:${userId}:${sessionId}`;

    this.runtime = {
      platform: "dify",
      userId,
      sessionId,
      sessionKey,
      workspaceDir,
    };
    this.requestContext = {
      appId,
      userId,
      conversationId,
      workflowRunId: opts.workflowRunId,
      messageId: opts.messageId,
      query: opts.query,
      answer: opts.answer,
      inputs: opts.inputs,
    };
  }

  getRuntime(): MemoryAdapterRuntime {
    return { ...this.runtime };
  }

  buildTurn(turn: MemoryTurnPayload): MemoryTurnPayload {
    return {
      ...turn,
      messages: turn.messages ?? [
        {
          role: "user",
          content: turn.userContent,
          metadata: this.buildMessageMetadata("query"),
        },
        {
          role: "assistant",
          content: turn.assistantContent,
          metadata: this.buildMessageMetadata("answer"),
        },
      ],
    };
  }

  getRequestContext(): DifyRequestContext {
    return { ...this.requestContext, inputs: this.requestContext.inputs ? { ...this.requestContext.inputs } : undefined };
  }

  private buildMessageMetadata(kind: "query" | "answer"): Record<string, unknown> {
    return {
      platform: "dify",
      kind,
      appId: this.requestContext.appId,
      conversationId: this.requestContext.conversationId,
      workflowRunId: this.requestContext.workflowRunId,
      messageId: this.requestContext.messageId,
      inputs: this.requestContext.inputs,
    };
  }
}

export class DifyMemoryAdapter extends MemoryPlatformAdapter {
  private readonly difyBridge: DifyMemoryBridge;

  constructor(opts: DifyMemoryAdapterOptions = {}) {
    const bridge = new DifyMemoryBridge(opts);
    const adapterOptions: MemoryAdapterOptions = {
      ...opts,
      bridge,
    };
    super(adapterOptions);
    this.difyBridge = bridge;
  }

  getDifyContext(): DifyRequestContext {
    return this.difyBridge.getRequestContext();
  }

  async buildPromptContext(query?: string): Promise<DifyPromptContext> {
    const effectiveQuery = query ?? this.getDifyContext().query ?? "";
    return super.buildPromptContext(effectiveQuery);
  }

  async recordDifyTurn(turn?: DifyTurnPayload): Promise<{ l0Recorded: number; schedulerNotified: boolean }> {
    const ctx = this.getDifyContext();
    const effectiveTurn = turn ?? {
      query: ctx.query ?? "",
      answer: ctx.answer ?? "",
      inputs: ctx.inputs,
    };
    return this.capture({
      userContent: effectiveTurn.query,
      assistantContent: effectiveTurn.answer,
      messages: [
        {
          role: "user",
          content: effectiveTurn.query,
          metadata: { platform: "dify", inputs: effectiveTurn.inputs, rawRequest: effectiveTurn.rawRequest },
        },
        {
          role: "assistant",
          content: effectiveTurn.answer,
          metadata: { platform: "dify", rawResponse: effectiveTurn.rawResponse },
        },
      ],
    });
  }
}

export function createDifyMemoryAdapter(opts: DifyMemoryAdapterOptions = {}): DifyMemoryAdapter {
  return new DifyMemoryAdapter(opts);
}
