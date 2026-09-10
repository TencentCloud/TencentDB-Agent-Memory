import { createHash } from "node:crypto";

import type { PiMemoryConfig } from "./config.js";

interface ResponseEnvelope<T> {
  code?: number;
  message?: string;
  request_id?: string;
  data?: T;
}

/** The v3 conversation schema caps every individual message at 8192 characters. */
export const MAX_CONVERSATION_MESSAGE_CHARS = 8_192;
/** The v3 semantic-search schemas cap query text at 2048 characters. */
export const MAX_SEARCH_QUERY_CHARS = 2_048;
const MAX_DIAGNOSTIC_CHARS = 512;
const CAPTURE_TRUNCATION_SUFFIX = "\n...[message truncated]";

export interface AtomicMemory {
  id: string;
  type: string;
  content: string;
  background?: string;
  created_at?: string;
  updated_at?: string;
  score?: number;
}

export interface ConversationMemory {
  id?: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp?: string;
  score?: number;
}

export interface ScenarioSummary {
  path: string;
  summary?: string;
  created_at?: string;
  updated_at?: string;
}

export interface RecallBundle {
  atomic: AtomicMemory[];
  scenarios: ScenarioSummary[];
  core: string | null;
  warnings: string[];
}

export interface CaptureTurn {
  sessionId: string;
  user: string;
  assistant: string;
  capturedAtMs: number;
  /** Stable Pi message/run identity used only for local duplicate suppression. */
  captureId?: string;
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
    super(boundDiagnostic(message));
    this.name = "TdaiClientError";
  }
}

function compactBody(body: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(body).filter(([, value]) => value !== undefined));
}

function redactDiagnostic(value: string): string {
  return value
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
    .replace(/([a-z][a-z\d+.-]*:\/\/)[^/\s@]+@/gi, "$1[REDACTED]@")
    .replace(
      /(["']?(?:api[_-]?key|authorization|password|secret|token)["']?\s*[:=]\s*["']?)[^"'\s,}]+/gi,
      "$1[REDACTED]",
    );
}

function boundDiagnostic(value: string): string {
  const sanitized = redactDiagnostic(value).trim();
  if (sanitized.length <= MAX_DIAGNOSTIC_CHARS) return sanitized;
  return sanitized.slice(0, MAX_DIAGNOSTIC_CHARS - 3).trimEnd() + "...";
}

function errorText(error: unknown): string {
  return boundDiagnostic(error instanceof Error ? error.message : String(error));
}

/** A bounded, secret-redacted message suitable for logs and model-visible tool errors. */
export function diagnosticText(error: unknown): string {
  if (error instanceof TdaiClientError) {
    const request = error.requestId ? ", request " + error.requestId : "";
    return boundDiagnostic(error.message + " (code " + error.code + request + ")");
  }
  return errorText(error);
}

export function boundConversationMessage(value: string): string {
  if (value.length <= MAX_CONVERSATION_MESSAGE_CHARS) return value;
  const bodyLength = Math.max(0, MAX_CONVERSATION_MESSAGE_CHARS - CAPTURE_TRUNCATION_SUFFIX.length);
  return value.slice(0, bodyLength).trimEnd() + CAPTURE_TRUNCATION_SUFFIX;
}

export function boundSearchQuery(value: string): string {
  return value.length <= MAX_SEARCH_QUERY_CHARS ? value : value.slice(0, MAX_SEARCH_QUERY_CHARS);
}

export function turnKey(
  turn: Pick<CaptureTurn, "sessionId" | "user" | "assistant" | "captureId">,
): string {
  return createHash("sha256")
    .update(turn.sessionId)
    .update("\0")
    .update(turn.captureId ?? "")
    .update("\0")
    .update(turn.user)
    .update("\0")
    .update(turn.assistant)
    .digest("hex");
}

export class TdaiMemoryClient implements MemoryClientLike {
  constructor(private readonly config: PiMemoryConfig) {}

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
    if (externalSignal?.aborted) {
      controller.abort(externalSignal.reason);
    } else {
      externalSignal?.addEventListener("abort", onExternalAbort, { once: true });
    }
    const timer = setTimeout(() => controller.abort(new Error("request timeout")), this.config.timeoutMs);

    try {
      const response = await fetch(this.config.endpoint + path, {
        method: "POST",
        headers: {
          Authorization: "Bearer " + this.config.apiKey,
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

      if (!envelope || typeof envelope !== "object") {
        throw new TdaiClientError(
          "MemoryCore returned a malformed response",
          response.ok ? -1 : response.status,
          response.headers.get("x-trace-id") || "",
        );
      }

      if (!response.ok || envelope.code !== 0) {
        throw new TdaiClientError(
          envelope.message || "MemoryCore request failed with HTTP " + response.status,
          typeof envelope.code === "number" && envelope.code !== 0 ? envelope.code : response.status,
          response.headers.get("x-trace-id") || envelope.request_id || "",
        );
      }
      return (envelope.data ?? {}) as T;
    } catch (error) {
      if (error instanceof TdaiClientError) throw error;
      if (externalSignal?.aborted) {
        throw new TdaiClientError("MemoryCore request aborted by caller", -1);
      }
      if (controller.signal.aborted) {
        throw new TdaiClientError("MemoryCore request timed out after " + this.config.timeoutMs + " ms", -1);
      }
      throw new TdaiClientError("MemoryCore request failed: " + errorText(error), -1);
    } finally {
      clearTimeout(timer);
      externalSignal?.removeEventListener("abort", onExternalAbort);
    }
  }

  async searchAtomic(query: string, limit: number, signal?: AbortSignal): Promise<AtomicMemory[]> {
    const data = await this.post<{ items?: AtomicMemory[] }>(
      "/v3/atomic/search",
      { ...this.isolation(), query: boundSearchQuery(query), limit },
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
      compactBody({
        ...this.isolation(),
        query: boundSearchQuery(query),
        limit,
        session_id: sessionId,
      }),
      signal,
    );
    return Array.isArray(data.messages) ? data.messages : [];
  }

  async recall(query: string, signal?: AbortSignal): Promise<RecallBundle> {
    const operations: Array<{
      kind: "atomic" | "core" | "scenarios";
      promise: Promise<unknown>;
    }> = [
      {
        kind: "atomic",
        promise: this.searchAtomic(query, this.config.recallLimit, signal),
      },
    ];

    if (this.config.includeCore) {
      operations.push({
        kind: "core",
        promise: this.post<{ content?: string | null }>("/v3/core/read", this.isolation(), signal),
      });
    }
    if (this.config.includeScenarios && this.config.scenarioLimit > 0) {
      operations.push({
        kind: "scenarios",
        promise: this.post<{ entries?: ScenarioSummary[] }>(
          "/v3/scenario/ls",
          this.isolation(),
          signal,
        ),
      });
    }

    const settled = await Promise.allSettled(operations.map((operation) => operation.promise));
    const bundle: RecallBundle = { atomic: [], scenarios: [], core: null, warnings: [] };
    let atomicSucceeded = false;
    let firstFailure: unknown;

    for (const [index, result] of settled.entries()) {
      const operation = operations[index];
      if (!operation) continue;
      if (result.status === "rejected") {
        firstFailure ??= result.reason;
        bundle.warnings.push(operation.kind + ": " + diagnosticText(result.reason));
        continue;
      }
      if (operation.kind === "atomic") {
        atomicSucceeded = true;
        bundle.atomic = result.value as AtomicMemory[];
      } else if (operation.kind === "core") {
        const data = result.value as { content?: string | null };
        bundle.core = typeof data.content === "string" ? data.content : null;
      } else {
        const data = result.value as { entries?: ScenarioSummary[] };
        bundle.scenarios = Array.isArray(data.entries)
          ? data.entries.slice(0, this.config.scenarioLimit)
          : [];
      }
    }

    // L1 is the required recall layer. Optional L2/L3 data must never be
    // injected by itself when the primary semantic search failed.
    if (!atomicSucceeded) {
      if (firstFailure) throw firstFailure;
      throw new TdaiClientError("L1 atomic recall unavailable", -1);
    }
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
          {
            role: "user",
            content: boundConversationMessage(turn.user),
            timestamp: userTime,
          },
          {
            role: "assistant",
            content: boundConversationMessage(turn.assistant),
            timestamp: assistantTime,
          },
        ],
      },
      signal,
    );
  }

  async check(signal?: AbortSignal): Promise<number> {
    const data = await this.post<{ total?: number }>("/v3/atomic/count", this.isolation(), signal);
    return typeof data.total === "number" ? data.total : 0;
  }
}
