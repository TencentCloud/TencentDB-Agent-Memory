import { McpHostAdapterBase, sessionKeyFromEnv } from "../mcp-host-adapter-base.js";

export class ClaudeCodeHostAdapter extends McpHostAdapterBase {
  readonly hostType = "claude-code" as const;
  protected readonly platformId = "claude-code";

  protected resolveSessionKey(explicit: string | undefined): string {
    return sessionKeyFromEnv(explicit, "CLAUDE_CODE_SESSION_ID");
  }
}

