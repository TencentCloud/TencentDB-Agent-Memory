import type {
  CaptureResponse,
  ConversationSearchRequest,
  ConversationSearchResponse,
  MemorySearchRequest,
  MemorySearchResponse,
  RecallResponse,
  SessionEndResponse,
} from "../../gateway/types.js";
import type { GatewayMemoryClient } from "../gateway-client/index.js";
import {
  createGatewayPlatformAdapter,
  type GatewayPlatformAdapter,
  type GatewayPlatformContext,
} from "../gateway-client/index.js";

export interface ClaudeCodeSessionKeyInput {
  /** Absolute or project-root workspace path used by Claude Code for the run. */
  workspaceDir: string;
  /** Preferred stable conversation/thread id when the hook runner provides one. */
  conversationId?: string;
  /** Hook invocation/session id. Used when no conversation id exists. */
  sessionId?: string;
}

export interface ClaudeCodeGatewayContext extends Partial<ClaudeCodeSessionKeyInput> {
  /** Precomputed TDAI session key. Overrides workspace/conversation derivation. */
  sessionKey?: string;
  /** Optional user id forwarded to the Gateway. */
  userId?: string;
}

export interface ClaudeCodeHookInput {
  session_id: string;
  transcript_path?: string;
  cwd: string;
  hook_event_name?: string;
}

export interface ClaudeCodeHookContextOptions {
  userId?: string;
}

export interface ClaudeCodeGatewayAdapterOptions {
  client: GatewayMemoryClient;
  resolveContext: () => ClaudeCodeGatewayContext | Promise<ClaudeCodeGatewayContext>;
}

export interface ClaudeCodeCompletedTurn {
  userText: string;
  assistantText: string;
  messages?: unknown[];
}

export interface ClaudeCodeGatewayAdapter {
  readonly platform: "claude-code";
  prefetchForPrompt(prompt: string): Promise<RecallResponse>;
  captureCompletedTurn(turn: ClaudeCodeCompletedTurn): Promise<CaptureResponse>;
  searchMemories(params: MemorySearchRequest): Promise<MemorySearchResponse>;
  searchConversations(
    params: Omit<ConversationSearchRequest, "session_key"> & { sessionKey?: string },
  ): Promise<ConversationSearchResponse>;
  flushSession(): Promise<SessionEndResponse>;
}

export function createClaudeCodeSessionKey(input: ClaudeCodeSessionKeyInput): string {
  const workspace = normalizeWorkspaceDir(input.workspaceDir);
  const conversation = input.conversationId ?? input.sessionId ?? "default";
  return `claude-code:${workspace}:${conversation}`;
}

export function createClaudeCodeContextFromHookInput(
  input: ClaudeCodeHookInput,
  opts: ClaudeCodeHookContextOptions = {},
): ClaudeCodeGatewayContext {
  return {
    workspaceDir: input.cwd,
    sessionId: input.session_id,
    userId: opts.userId,
  };
}

export function createClaudeCodeGatewayAdapter(
  opts: ClaudeCodeGatewayAdapterOptions,
): ClaudeCodeGatewayAdapter {
  const adapter = createGatewayPlatformAdapter({
    client: opts.client,
    platform: "claude-code",
    resolveContext: async () => toGatewayContext(await opts.resolveContext()),
  });

  return {
    platform: "claude-code",

    prefetchForPrompt(prompt: string): Promise<RecallResponse> {
      return adapter.prefetch(prompt);
    },

    captureCompletedTurn(turn: ClaudeCodeCompletedTurn): Promise<CaptureResponse> {
      return adapter.captureTurn(turn);
    },

    searchMemories(params: MemorySearchRequest): Promise<MemorySearchResponse> {
      return adapter.searchMemories(params);
    },

    searchConversations(
      params: Omit<ConversationSearchRequest, "session_key"> & { sessionKey?: string },
    ): Promise<ConversationSearchResponse> {
      return adapter.searchConversations(params);
    },

    flushSession(): Promise<SessionEndResponse> {
      return adapter.endSession();
    },
  };
}

function toGatewayContext(ctx: ClaudeCodeGatewayContext): GatewayPlatformContext {
  const sessionKey = ctx.sessionKey ?? deriveSessionKey(ctx);

  return {
    sessionKey,
    sessionId: ctx.sessionId ?? ctx.conversationId,
    userId: ctx.userId,
  };
}

function deriveSessionKey(ctx: ClaudeCodeGatewayContext): string {
  if (!ctx.workspaceDir) {
    throw new Error("Claude Code Gateway adapter requires either sessionKey or workspaceDir");
  }

  return createClaudeCodeSessionKey({
    workspaceDir: ctx.workspaceDir,
    conversationId: ctx.conversationId,
    sessionId: ctx.sessionId,
  });
}

function normalizeWorkspaceDir(workspaceDir: string): string {
  const normalized = workspaceDir.replace(/\\/g, "/").replace(/\/+$/, "");
  return normalized || ".";
}
