import { createHash } from "node:crypto";

import type { OpenCodeMemoryConfig } from "./config.js";

interface ResponseEnvelope<T> {
  code?: number;
  message?: string;
  request_id?: string;
  data?: T;
}

export interface AtomicMemory {
  id: string;
  type: string;
  content: string;
  background?: string;
  score?: number;
}

export interface ConversationMemory {
  id?: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp?: string;
  score?: number;
}

export interface RecallBundle {
  atomic: AtomicMemory[];
  core: string | null;
  warnings: string[];
}

export interface CaptureTurn {
  sessionId: string;
  user: string;
  assistant: string;
  capturedAtMs: number;
}

export interface MemoryClientLike {
  recall(query: string, signal?: AbortSignal): Promise<RecallBundle>;
  captureTurn(turn: CaptureTurn, signal?: AbortSignal): Promise<void>;
  searchAtomic(query: string, limit: number, signal?: AbortSignal): Promise<AtomicMemory[]>;
  searchConversation(
    query: string,
    limit: number,
    sessionId?: string,
    signal?: AbortSignal,
  ): Promise<ConversationMemory[]>;
  check(signal?: AbortSignal): Promise<number>;
}

export class TdaiClientError extends Error {
  constructor(
    message: string,
    readonly code: number,
    readonly requestId = "",
  ) {
    super(message);
    this.name = "TdaiClientError";
  }
}

function compactBody(body: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(body).filter(([, value]) => value !== undefined));
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function turnKey(turn: Pick<CaptureTurn, "sessionId" | "user" | "assistant">): string {
  return createHash("sha256")
    .update(turn.sessionId)
    .update("\0")
    .update(turn.user)
    .update("\0")
    .update(turn.assistant)
    .digest("hex");
}

export class TdaiMemoryClient implements MemoryClientLike {
  constructor(private readonly config: OpenCodeMemoryConfig) {}

  private isolation(): Record<string, unknown> {
    return compactBody({
      team_id: this.config.teamId,
      agent_id: this.config.agentId,
      user_id: this.config.userId,
      task_id: this.config.taskId,
    });
  }

  private async post<T>(
    path: string,
    body: Record<string, unknown>,
    externalSignal?: AbortSignal,
  ): Promise<T> {
    const controller = new AbortController();
    const onExternalAbort = () => controller.abort(externalSignal?.reason);
    externalSignal?.addEventListener("abort", onExternalAbort, { once: true });
    const timer = setTimeout(
      () => controller.abort(new Error("request timeout")),
      this.config.timeoutMs,
    );

    try {
      const response = await fetch(this.config.endpoint + path, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          "Content-Type": "application/json",
          "x-tdai-service-id": this.config.serviceId,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await response.text();
      let envelope: ResponseEnvelope<T>;
      try {
        envelope = JSON.parse(text) as ResponseEnvelope<T>;
      } catch {
        throw new TdaiClientError(
          text || "MemoryCore returned a non-JSON response",
          response.ok ? -1 : response.status,
          response.headers.get("x-trace-id") || "",
        );
      }

      if (!response.ok || envelope.code !== 0) {
        throw new TdaiClientError(
          envelope.message || `MemoryCore request failed with HTTP ${response.status}`,
          typeof envelope.code === "number" && envelope.code !== 0
            ? envelope.code
            : response.status,
          response.headers.get("x-trace-id") || envelope.request_id || "",
        );
      }
      return (envelope.data ?? {}) as T;
    } catch (error) {
      if (error instanceof TdaiClientError) throw error;
      if (controller.signal.aborted && !externalSignal?.aborted) {
        throw new TdaiClientError(
          `MemoryCore request timed out after ${this.config.timeoutMs} ms`,
          -1,
        );
      }
      throw new TdaiClientError(`MemoryCore request failed: ${errorText(error)}`, -1);
    } finally {
      clearTimeout(timer);
      externalSignal?.removeEventListener("abort", onExternalAbort);
    }
  }

  async searchAtomic(query: string, limit: number, signal?: AbortSignal): Promise<AtomicMemory[]> {
    const data = await this.post<{ items?: AtomicMemory[] }>(
      "/v3/atomic/search",
      { ...this.isolation(), query, limit },
      signal,
    );
    return Array.isArray(data.items) ? data.items : [];
  }

  async searchConversation(
    query: string,
    limit: number,
    sessionId?: string,
    signal?: AbortSignal,
  ): Promise<ConversationMemory[]> {
    const data = await this.post<{ messages?: ConversationMemory[] }>(
      "/v3/conversation/search",
      compactBody({ ...this.isolation(), query, limit, session_id: sessionId }),
      signal,
    );
    return Array.isArray(data.messages) ? data.messages : [];
  }

  async recall(query: string, signal?: AbortSignal): Promise<RecallBundle> {
    const [atomic, core] = await Promise.allSettled([
      this.searchAtomic(query, this.config.recallLimit, signal),
      this.post<{ content?: string | null }>("/v3/core/read", this.isolation(), signal),
    ]);
    const bundle: RecallBundle = { atomic: [], core: null, warnings: [] };

    if (atomic.status === "fulfilled") bundle.atomic = atomic.value;
    else bundle.warnings.push(`atomic: ${errorText(atomic.reason)}`);

    if (core.status === "fulfilled") {
      bundle.core = typeof core.value.content === "string" ? core.value.content : null;
    } else {
      bundle.warnings.push(`core: ${errorText(core.reason)}`);
    }

    if (atomic.status === "rejected" && core.status === "rejected") throw atomic.reason;
    return bundle;
  }

  async captureTurn(turn: CaptureTurn, signal?: AbortSignal): Promise<void> {
    const assistantTime = new Date(turn.capturedAtMs).toISOString();
    const userTime = new Date(Math.max(0, turn.capturedAtMs - 1)).toISOString();
    await this.post(
      "/v3/conversation/add",
      {
        ...this.isolation(),
        session_id: turn.sessionId,
        messages: [
          { role: "user", content: turn.user, timestamp: userTime },
          { role: "assistant", content: turn.assistant, timestamp: assistantTime },
        ],
      },
      signal,
    );
  }

  async check(signal?: AbortSignal): Promise<number> {
    const data = await this.post<{ total?: number }>(
      "/v3/atomic/count",
      this.isolation(),
      signal,
    );
    return typeof data.total === "number" ? data.total : 0;
  }
}
