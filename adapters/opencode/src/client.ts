import { GATEWAY_MAX_MESSAGE_CHARS, type AdapterConfig } from "./config.js";
import { boundText } from "./sanitize.js";
import type { CapturedTurn, RecallBundle } from "./types.js";

interface Envelope<T> { code?: number; message?: string; request_id?: string; data?: T }

export class GatewayError extends Error {
  constructor(message: string, readonly code: number, readonly requestId = "") {
    super(message);
    this.name = "GatewayError";
  }
}

function compact(body: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(body).filter(([, value]) => value !== undefined));
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function contentItems<T extends { content: string }>(value: unknown): T[] {
  return Array.isArray(value)
    ? value.filter((item): item is T => !!item && typeof item === "object" && typeof (item as { content?: unknown }).content === "string")
    : [];
}

export class MemoryGatewayClient {
  constructor(private readonly config: AdapterConfig) {}

  private isolation(sessionId?: string): Record<string, unknown> {
    return compact({
      team_id: this.config.teamId,
      agent_id: this.config.agentId,
      user_id: this.config.userId,
      task_id: this.config.taskId,
      session_id: sessionId,
    });
  }

  private async post<T>(path: string, body: Record<string, unknown>, external?: AbortSignal): Promise<T> {
    const controller = new AbortController();
    const abort = () => controller.abort(external?.reason);
    external?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => controller.abort(new Error("request timeout")), this.config.timeoutMs);
    try {
      const response = await fetch(`${this.config.endpoint}${path}`, {
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
      let envelope: Envelope<T>;
      try { envelope = JSON.parse(text) as Envelope<T>; }
      catch { throw new GatewayError(text || `HTTP ${response.status}`, response.status); }
      if (!response.ok || envelope.code !== 0) {
        throw new GatewayError(envelope.message || `HTTP ${response.status}`,
          typeof envelope.code === "number" && envelope.code !== 0 ? envelope.code : response.status,
          envelope.request_id || response.headers.get("x-trace-id") || "");
      }
      return (envelope.data ?? {}) as T;
    } catch (error) {
      if (error instanceof GatewayError) throw error;
      if (controller.signal.aborted && !external?.aborted) throw new GatewayError(`Request timed out after ${this.config.timeoutMs} ms`, -1);
      throw new GatewayError(`Gateway request failed: ${message(error)}`, -1);
    } finally {
      clearTimeout(timer);
      external?.removeEventListener("abort", abort);
    }
  }

  async recall(query: string, signal?: AbortSignal): Promise<RecallBundle> {
    const jobs = await Promise.allSettled([
      this.post<{ messages?: RecallBundle["conversations"] }>("/v3/conversation/search", {
        ...this.isolation(), query, limit: this.config.recallLimit,
      }, signal),
      this.post<{ items?: RecallBundle["atomic"] }>("/v3/atomic/search", {
        ...this.isolation(), query, limit: this.config.recallLimit,
      }, signal),
      this.post<{ content?: string | null }>("/v3/core/read", this.isolation(), signal),
      this.config.skillEnabled
        ? this.post<{ listing?: string }>("/v3/skill/listing", {
            ...this.isolation(), query, char_budget: Math.min(4_000, this.config.maxContextChars),
          }, signal)
        : Promise.resolve({ listing: "" }),
    ]);
    const bundle: RecallBundle = { conversations: [], atomic: [], core: null, skills: null, warnings: [] };
    const [conversations, atomic, core, skills] = jobs;
    if (conversations?.status === "fulfilled") bundle.conversations = contentItems(conversations.value.messages);
    else if (conversations) bundle.warnings.push(`conversation: ${message(conversations.reason)}`);
    if (atomic?.status === "fulfilled") bundle.atomic = contentItems(atomic.value.items);
    else if (atomic) bundle.warnings.push(`atomic: ${message(atomic.reason)}`);
    if (core?.status === "fulfilled") bundle.core = typeof core.value.content === "string" ? core.value.content : null;
    else if (core) bundle.warnings.push(`core: ${message(core.reason)}`);
    if (skills?.status === "fulfilled") bundle.skills = typeof skills.value.listing === "string" ? skills.value.listing : null;
    else if (skills) bundle.warnings.push(`skills: ${message(skills.reason)}`);
    if (jobs.every((job) => job.status === "rejected")) throw new GatewayError("All recall pipelines failed", -1);
    return bundle;
  }

  async captureL0(turn: CapturedTurn): Promise<void> {
    // Bound again at the transport boundary so records persisted by older adapter
    // versions cannot remain permanently pending after a Gateway rejects them.
    const maxChars = Math.min(this.config.maxMessageChars, GATEWAY_MAX_MESSAGE_CHARS);
    await this.post("/v3/conversation/add", {
      ...this.isolation(turn.sessionId),
      messages: [
        { role: "user", content: boundText(turn.user, maxChars), timestamp: new Date(Math.max(0, turn.capturedAtMs - 1)).toISOString() },
        { role: "assistant", content: boundText(turn.assistant, maxChars), timestamp: new Date(turn.capturedAtMs).toISOString() },
      ],
    });
  }

  async captureSkill(turn: CapturedTurn): Promise<void> {
    await this.post("/v3/skill/conversation/add", {
      ...this.isolation(turn.sessionId),
      messages: turn.skillMessages,
    });
  }

  searchAtomic(query: string, limit: number, signal?: AbortSignal): Promise<unknown> {
    return this.post("/v3/atomic/search", { ...this.isolation(), query, limit }, signal);
  }

  searchConversation(query: string, limit: number, sessionId?: string, signal?: AbortSignal): Promise<unknown> {
    return this.post("/v3/conversation/search", compact({ ...this.isolation(), query, limit, session_id: sessionId }), signal);
  }

  searchSkills(query: string, limit: number, signal?: AbortSignal): Promise<unknown> {
    return this.post("/v3/skill/search", { ...this.isolation(), query, top_k: limit }, signal);
  }

  getSkill(skillId: string, version?: number, signal?: AbortSignal): Promise<unknown> {
    return this.post("/v3/skill/get", compact({
      ...this.isolation(), skill_id: skillId, version, include_content: true, include_manifest: true,
    }), signal);
  }

  async status(signal?: AbortSignal): Promise<{ atomic: number }> {
    const data = await this.post<{ total?: number }>("/v3/atomic/count", this.isolation(), signal);
    return { atomic: typeof data.total === "number" ? data.total : 0 };
  }
}
