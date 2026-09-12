import { McpHostAdapterBase, sessionKeyFromEnv } from "../mcp-host-adapter-base.js";

export class CodexHostAdapter extends McpHostAdapterBase {
  readonly hostType = "codex" as const;
  protected readonly platformId = "codex";

  protected resolveSessionKey(explicit: string | undefined): string {
    // Codex CLI does not currently set a per-session env var.
    // Falls back to a process-stable UUID (one session per server restart).
    // Users can set TDAI_SESSION_KEY for cross-session continuity.
    return sessionKeyFromEnv(explicit, "CODEX_SESSION_ID");
  }
}
