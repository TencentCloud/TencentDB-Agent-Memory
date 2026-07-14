import path from "node:path";
import { MemoryPlatformAdapter, type MemoryAdapterOptions } from "../platform/memory-adapter.js";
import { normalizeSessionPart, type MemoryAdapterRuntime, type MemoryPlatformBridge, type MemoryPromptContext, type MemoryTurnPayload } from "../platform/bridge.js";
import type { MemoryGatewayClientOptions } from "../platform/gateway-client.js";

export interface CodexMemoryAdapterOptions extends MemoryGatewayClientOptions {
  userId?: string;
  sessionId?: string;
  sessionKey?: string;
  workspaceDir?: string;
}

export type CodexPromptContext = MemoryPromptContext;

export class CodexMemoryBridge implements MemoryPlatformBridge {
  private readonly runtime: MemoryAdapterRuntime;

  constructor(opts: CodexMemoryAdapterOptions = {}) {
    const workspaceDir = opts.workspaceDir ?? process.env.CODEX_WORKSPACE_DIR ?? process.cwd();
    const sessionId = normalizeSessionPart(
      opts.sessionId ?? process.env.CODEX_SESSION_ID,
      path.basename(workspaceDir) || "default-session",
    );
    const userId = normalizeSessionPart(
      opts.userId ?? process.env.CODEX_USER_ID ?? process.env.USERNAME ?? process.env.USER,
      "default_user",
    );
    const sessionKey = opts.sessionKey ?? process.env.CODEX_SESSION_KEY ?? `codex:${userId}:${sessionId}`;

    this.runtime = {
      platform: "codex",
      userId,
      sessionId,
      sessionKey,
      workspaceDir,
    };
  }

  getRuntime(): MemoryAdapterRuntime {
    return { ...this.runtime };
  }
}

export class CodexMemoryAdapter extends MemoryPlatformAdapter {
  constructor(opts: CodexMemoryAdapterOptions = {}) {
    const adapterOptions: MemoryAdapterOptions = {
      ...opts,
      bridge: new CodexMemoryBridge(opts),
    };
    super(adapterOptions);
  }

  async recordTurn(turn: MemoryTurnPayload): Promise<{ l0Recorded: number; schedulerNotified: boolean }> {
    return this.capture(turn);
  }
}

export function createCodexMemoryAdapter(opts: CodexMemoryAdapterOptions = {}): CodexMemoryAdapter {
  return new CodexMemoryAdapter(opts);
}
