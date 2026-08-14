/**
 * Zero-dependency HTTP client for the TencentDB Agent Memory v3 gateway.
 *
 * All data-plane calls carry the v3 strict-isolation fields (team / agent /
 * user / optional task) plus the service id and bearer token. Requests time
 * out, fail with a typed error, and never throw on a malformed HTTP body.
 */

import type { PiMemoryConfig } from "./config.js";

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
  skillMessages: SkillCaptureMessage[];
  capturedAtMs: number;
}

export type SkillCaptureRole = "user" | "assistant" | "tool_call" | "tool_result";

export interface SkillCaptureMessage {
  role: SkillCaptureRole;
  content: string;
  tool_name?: string;
  tool_call_id?: string;
  timestamp?: number | string;
}

/** Narrow interface used by the extension so tests can inject a fake client. */
export interface MemoryClientLike {
  recall(query: string, signal?: AbortSignal): Promise<RecallBundle>;
  listScenarios(signal?: AbortSignal): Promise<ScenarioSummary[]>;
  readCore(signal?: AbortSignal): Promise<string | null>;
  searchAtomic(query: string, limit: number, signal?: AbortSignal): Promise<AtomicMemory[]>;
  searchConversation(
    query: string,
    limit: number,
    sessionId?: string,
    signal?: AbortSignal,
  ): Promise<ConversationMemory[]>;
  captureConversation(turn: CaptureTurn, signal?: AbortSignal): Promise<void>;
  captureSkill(turn: CaptureTurn, signal?: AbortSignal): Promise<void>;
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
    if (externalSignal?.aborted) {
      throw new TdaiClientError("MemoryCore request aborted", -1);
    }

    const controller = new AbortController();
    const onExternalAbort = (): void => controller.abort(externalSignal?.reason);
    externalSignal?.addEventListener("abort", onExternalAbort, { once: true });
    const timer = setTimeout(() => controller.abort(new Error("request timeout")), this.config.timeoutMs);

    try {
      const response = await fetch(this.config.endpoint + path, {
        method: "POST",
        // Never follow redirects: the Authorization and x-tdai-service-id
        // headers must not be replayed to a different host.
        redirect: "error",
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
        // Never echo the raw body: it may be a WAF/proxy error page containing
        // request echoes or internal details.
        throw new TdaiClientError(
          `MemoryCore returned a non-JSON response (HTTP ${response.status})`,
          response.ok ? -1 : response.status,
          response.headers.get("x-trace-id") || "",
        );
      }

      if (!response.ok || (typeof envelope.code === "number" && envelope.code !== 0)) {
        // Bound the server-controlled message before it ever reaches logs or
        // model context.
        const serverMessage =
          typeof envelope.message === "string" && envelope.message.trim()
            ? envelope.message.trim().slice(0, 200)
            : "";
        throw new TdaiClientError(
          serverMessage || `MemoryCore request failed with HTTP ${response.status}`,
          typeof envelope.code === "number" && envelope.code !== 0 ? envelope.code : response.status,
          response.headers.get("x-trace-id") || envelope.request_id || "",
        );
      }

      return (envelope.data ?? {}) as T;
    } catch (error) {
      if (error instanceof TdaiClientError) throw error;
      if (controller.signal.aborted && !externalSignal?.aborted) {
        throw new TdaiClientError(`MemoryCore request timed out after ${this.config.timeoutMs} ms`, -1);
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

  async listScenarios(signal?: AbortSignal): Promise<ScenarioSummary[]> {
    const data = await this.post<{ entries?: ScenarioSummary[] }>("/v3/scenario/ls", this.isolation(), signal);
    return Array.isArray(data.entries) ? data.entries.slice(0, this.config.scenarioLimit) : [];
  }

  async readCore(signal?: AbortSignal): Promise<string | null> {
    const data = await this.post<{ content?: string | null }>("/v3/core/read", this.isolation(), signal);
    return typeof data.content === "string" ? data.content : null;
  }

  /**
   * Recall L1 atomic memories (hard dependency) plus, optionally, L2 scenario
   * summaries and the L3 core profile (soft enrichments). The optional layers
   * are fetched concurrently within a soft budget so a slow scenario/core read
   * never delays the first token; L1 waits on its own timeoutMs and is fatal
   * to recall when it fails.
   */
  async recall(query: string, signal?: AbortSignal): Promise<RecallBundle> {
    const bundle: RecallBundle = { atomic: [], scenarios: [], core: null, warnings: [] };

    // L1 is the core signal: wait for it unconditionally. A failure here is fatal.
    bundle.atomic = await this.searchAtomic(query, this.config.recallLimit, signal);

    const optionalOps: Array<{ kind: "scenarios" | "core"; promise: Promise<unknown> }> = [];
    if (this.config.includeScenarios && this.config.scenarioLimit > 0) {
      optionalOps.push({ kind: "scenarios", promise: this.listScenarios(signal) });
    }
    if (this.config.includeCore) {
      optionalOps.push({ kind: "core", promise: this.readCore(signal) });
    }
    if (optionalOps.length === 0) return bundle;

    const budget = new Promise<"budget-exceeded">((resolve) =>
      setTimeout(() => resolve("budget-exceeded"), this.config.recallBudgetMs),
    );
    const settled = await Promise.race([
      Promise.allSettled(optionalOps.map((op) => op.promise)),
      budget,
    ]);

    if (settled === "budget-exceeded") {
      for (const op of optionalOps) {
        bundle.warnings.push(`${op.kind}: recall budget exceeded`);
      }
      return bundle;
    }

    for (const [index, result] of (settled as PromiseSettledResult<unknown>[]).entries()) {
      const op = optionalOps[index];
      if (!op) continue;
      if (result.status === "rejected") {
        bundle.warnings.push(`${op.kind}: ${errorText(result.reason)}`);
        continue;
      }
      if (op.kind === "scenarios") bundle.scenarios = result.value as ScenarioSummary[];
      else bundle.core = result.value as string | null;
    }

    return bundle;
  }

  async captureConversation(turn: CaptureTurn, signal?: AbortSignal): Promise<void> {
    const userTime = new Date(Math.max(0, turn.capturedAtMs - 1)).toISOString();
    const assistantTime = new Date(turn.capturedAtMs).toISOString();
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

  async captureSkill(turn: CaptureTurn, signal?: AbortSignal): Promise<void> {
    await this.post(
      "/v3/skill/conversation/add",
      {
        ...this.isolation(),
        session_id: turn.sessionId,
        messages: turn.skillMessages,
      },
      signal,
    );
  }

  async check(signal?: AbortSignal): Promise<number> {
    const data = await this.post<{ total?: number }>("/v3/atomic/count", this.isolation(), signal);
    return typeof data.total === "number" ? data.total : 0;
  }
}
