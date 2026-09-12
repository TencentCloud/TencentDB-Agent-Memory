/**
 * Narrow HTTP client used by the Claude Code hook adapter.
 *
 * This intentionally is not a second public, cross-platform Gateway SDK. It
 * only models the four endpoints needed by Claude Code's lifecycle hooks.
 */

export interface ClaudeCodeGatewayClientOptions {
  baseUrl?: string;
  apiKey?: string;
  timeoutMs?: number;
  allowRemoteGateway?: boolean;
  fetchImpl?: typeof fetch;
}

export interface ClaudeCodeRecallResponse {
  /** Legacy response field currently returned by the Gateway. */
  context?: string;
  /** Forward-compatible fields used when the richer recall response lands. */
  prepend_context?: string;
  append_system_context?: string;
}

export interface ClaudeCodeMemorySearchResponse {
  results?: string;
  total?: number;
  strategy?: string;
}

export interface ClaudeCodeCaptureTurn {
  userText: string;
  assistantText: string;
  userTimestamp: number;
  assistantTimestamp: number;
  sessionKey: string;
  sessionId: string;
}

export interface ClaudeCodeGateway {
  recall(query: string, sessionKey: string): Promise<ClaudeCodeRecallResponse>;
  searchMemories(query: string, limit?: number): Promise<ClaudeCodeMemorySearchResponse>;
  capture(turn: ClaudeCodeCaptureTurn): Promise<void>;
  endSession(sessionKey: string): Promise<void>;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export class ClaudeCodeGatewayClient implements ClaudeCodeGateway {
  private readonly baseUrl: URL;
  private readonly apiKey?: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ClaudeCodeGatewayClientOptions = {}) {
    const baseUrl = new URL(options.baseUrl ?? "http://127.0.0.1:8420");
    if (baseUrl.protocol !== "http:" && baseUrl.protocol !== "https:") {
      throw new Error("Claude Code Gateway URL must use http or https");
    }
    if (baseUrl.username || baseUrl.password) {
      throw new Error("Claude Code Gateway URL must not contain credentials");
    }
    if (!options.allowRemoteGateway && !LOOPBACK_HOSTS.has(baseUrl.hostname.toLowerCase())) {
      throw new Error(
        "Remote Gateway URLs are disabled by default; set " +
        "TDAI_CLAUDE_CODE_ALLOW_REMOTE_GATEWAY=true to opt in",
      );
    }

    this.baseUrl = baseUrl;
    this.apiKey = options.apiKey?.trim() || undefined;
    this.timeoutMs = positiveInteger(options.timeoutMs, 4_000);
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  recall(query: string, sessionKey: string): Promise<ClaudeCodeRecallResponse> {
    return this.post<ClaudeCodeRecallResponse>("/recall", {
      query,
      session_key: sessionKey,
    });
  }

  searchMemories(query: string, limit = 5): Promise<ClaudeCodeMemorySearchResponse> {
    return this.post<ClaudeCodeMemorySearchResponse>("/search/memories", {
      query,
      limit,
    });
  }

  async capture(turn: ClaudeCodeCaptureTurn): Promise<void> {
    await this.post("/capture", {
      user_content: turn.userText,
      assistant_content: turn.assistantText,
      session_key: turn.sessionKey,
      session_id: turn.sessionId,
      // Stable timestamps make a retried hook idempotent at the Gateway's
      // existing per-session checkpoint boundary.
      messages: [
        {
          id: `claude-user-${turn.userTimestamp}`,
          role: "user",
          content: turn.userText,
          timestamp: turn.userTimestamp,
        },
        {
          id: `claude-assistant-${turn.assistantTimestamp}`,
          role: "assistant",
          content: turn.assistantText,
          timestamp: turn.assistantTimestamp,
        },
      ],
    });
  }

  async endSession(sessionKey: string): Promise<void> {
    await this.post("/session/end", { session_key: sessionKey });
  }

  private async post<T = unknown>(pathname: string, body: unknown): Promise<T> {
    const url = new URL(pathname, this.baseUrl);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;

    const response = await this.fetchImpl(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    const raw = await response.text();
    if (!response.ok) {
      const detail = raw.trim().slice(0, 300);
      throw new Error(
        `TencentDB Agent Memory Gateway ${pathname} returned HTTP ${response.status}` +
        (detail ? `: ${detail}` : ""),
      );
    }
    if (!raw.trim()) return undefined as T;

    try {
      return JSON.parse(raw) as T;
    } catch {
      throw new Error(`TencentDB Agent Memory Gateway ${pathname} returned invalid JSON`);
    }
  }
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}
