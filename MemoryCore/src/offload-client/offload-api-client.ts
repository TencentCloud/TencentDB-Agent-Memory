/**
 * offload-client — HTTP client for Offload Server v2 API.
 */
import type { OffloadClientConfig, ToolPairPayload, RecentMessage, CompactionResult, Logger } from "./types.js";

export class OffloadApiClient {
  constructor(
    private config: OffloadClientConfig,
    private logger: Logger,
  ) {}

  /** Health check: GET /v2/offload/health. Returns true if server is reachable (any HTTP response = reachable). */
  async checkHealth(): Promise<boolean> {
    try {
      const status = await this.withTimeout(5000, async (signal) => {
        const res = await fetch(`${this.config.serverUrl}/v2/offload/health`, {
          method: "GET",
          headers: { Authorization: `Bearer ${this.config.apiKey}` },
          signal,
        });
        await discardBody(res);
        return res.status;
      });
      // Any HTTP response (including 401/403) means server is reachable
      return status < 500;
    } catch {
      return false;
    }
  }

  /**
   * Fire-and-forget: send tool pairs to ingest endpoint.
   * Does not throw — failures are logged as warnings.
   */
  async ingest(sessionId: string, toolPairs: ToolPairPayload[]): Promise<void> {
    return this.ingestWithContext(sessionId, toolPairs, undefined, undefined);
  }

  /**
   * Fire-and-forget: send tool pairs + optional context to ingest endpoint.
   * When prompt/recentMessages are provided, server triggers L1 with context (skip L1.5).
   */
  async ingestWithContext(
    sessionId: string,
    toolPairs: ToolPairPayload[],
    prompt?: string,
    recentMessages?: RecentMessage[],
  ): Promise<void> {
    const url = `${this.config.serverUrl}/v2/offload/ingest`;
    const payload: Record<string, unknown> = {
      session_id: sessionId,
      tool_pairs: toolPairs.map((tp) => ({
        tool_name: tp.toolName,
        tool_call_id: tp.toolCallId,
        params: tp.params,
        result: tp.result,
        error: tp.error,
        timestamp: tp.timestamp,
        duration_ms: tp.durationMs,
      })),
    };
    if (prompt) payload.prompt = prompt;
    if (recentMessages && recentMessages.length > 0) payload.recent_messages = recentMessages;
    const body = JSON.stringify(payload);

    try {
      await this.withTimeout(this.config.ingestTimeoutMs, async (signal) => {
        const res = await fetch(url, { method: "POST", headers: this.buildHeaders(), body, signal });
        await discardBody(res);
      });
    } catch (err) {
      this.logger.warn(`[offload-client] ingest failed: ${err}`);
    }
  }

  /**
   * Fire-and-forget: trigger L1.5 task judgment via ingest endpoint.
   * Sends prompt + recentMessages (empty toolPairs) to activate the L1.5 path on the server.
   */
  async ingestL15(sessionId: string, prompt: string, recentMessages?: RecentMessage[]): Promise<void> {
    const url = `${this.config.serverUrl}/v2/offload/ingest`;
    const payload: Record<string, unknown> = {
      session_id: sessionId,
      tool_pairs: [],
      prompt,
    };
    if (recentMessages && recentMessages.length > 0) payload.recent_messages = recentMessages;
    const body = JSON.stringify(payload);

    try {
      const status = await this.withTimeout(this.config.ingestTimeoutMs, async (signal) => {
        const res = await fetch(url, { method: "POST", headers: this.buildHeaders(), body, signal });
        await discardBody(res);
        return res.status;
      });

      if (status < 200 || status >= 300) {
        this.logger.warn(`[offload-client] ingestL15 returned ${status}`);
      }
    } catch (err) {
      this.logger.warn(`[offload-client] ingestL15 failed: ${err}`);
    }
  }

  /**
   * Synchronous compaction call. Returns compressed messages + report.
   * Returns null on timeout/failure (caller should keep original messages).
   */
  async compaction(req: {
    sessionId: string;
    messages: any[];
    ratio: number;
    contextWindow: number;
    totalTokens: number;
    messageTokens?: number[];
  }): Promise<CompactionResult | null> {
    const url = `${this.config.serverUrl}/v2/offload/compact`;
    const body = JSON.stringify({
      session_id: req.sessionId,
      messages: req.messages,
      ratio: req.ratio,
      context_window: req.contextWindow,
      total_tokens: req.totalTokens,
      message_tokens: req.messageTokens,
    });

    try {
      const result = await this.withTimeout(this.config.compactionTimeoutMs, async (signal) => {
        const response = await fetch(url, { method: "POST", headers: this.buildHeaders(), body, signal });
        if (!response.ok) {
          await discardBody(response);
          return { status: response.status, json: null };
        }
        // Body is read while the abort timer is still armed, so a server that
        // sends headers and then stalls cannot hang compaction indefinitely.
        return { status: response.status, json: (await response.json()) as any };
      });

      if (!result.json) {
        this.logger.warn(`[offload-client] compaction returned ${result.status}`);
        return null;
      }

      const json = result.json;
      if (json.code !== 0 || !json.data) {
        this.logger.warn(`[offload-client] compaction error: ${json.message ?? "unknown"}`);
        return null;
      }

      return { messages: json.data.messages, report: json.data.report };
    } catch (err) {
      this.logger.warn(`[offload-client] compaction failed: ${err}`);
      return null;
    }
  }

  /** Run `fn` with an AbortSignal that fires after `ms`; the timer is always cleared. */
  private async withTimeout<T>(ms: number, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    try {
      return await fn(controller.signal);
    } finally {
      clearTimeout(timer);
    }
  }

  private buildHeaders(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.config.apiKey}`,
      "X-TDAI-Service-Id": this.config.serviceId,
    };
  }
}

/** Release the connection back to the pool without buffering an unused body. */
async function discardBody(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    // ignore — body already consumed or stream errored
  }
}
