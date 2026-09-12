import { McpHostAdapterBase, sessionKeyFromEnv } from "../mcp-host-adapter-base.js";

export class CursorHostAdapter extends McpHostAdapterBase {
  readonly hostType = "cursor" as const;
  protected readonly platformId = "cursor";

  protected resolveSessionKey(explicit: string | undefined): string {
    return sessionKeyFromEnv(explicit, "CURSOR_SESSION_ID");
  }
}

