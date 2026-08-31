import type {
  CaptureResponse,
  ConversationSearchResponse,
  HealthResponse,
  MemorySearchResponse,
  RecallResponse,
  SeedResponse,
  SessionEndResponse,
} from "./types.js";

export class ResultFormatter {
  constructor(private readonly maxChars = 12_000) {}

  health(result: HealthResponse): string {
    return this.limit([
      "## Agent Memory Health",
      "",
      `Status: ${result.status}`,
      `Version: ${result.version}`,
      `Uptime: ${Math.round(result.uptime)}s`,
      `Vector store: ${result.stores.vectorStore ? "available" : "unavailable"}`,
      `Embedding service: ${result.stores.embeddingService ? "available" : "unavailable"}`,
    ].join("\n"));
  }

  recall(result: RecallResponse): string {
    return this.limit([
      "## Agent Memory Recall",
      "",
      `Strategy: ${result.strategy ?? "unknown"}`,
      `Memory count: ${result.memory_count ?? 0}`,
      "",
      "<context>",
      result.context || "No relevant long-term memory was found.",
      "</context>",
      "",
      "Use `agent_memory_search` for structured facts or `agent_conversation_search` for exact prior wording.",
    ].join("\n"));
  }

  memorySearch(result: MemorySearchResponse): string {
    return this.limit(`## Agent Memory Search Results\n\nTotal: ${result.total}\nStrategy: ${result.strategy}\n\n${result.results}`);
  }

  conversationSearch(result: ConversationSearchResponse): string {
    return this.limit(`## Agent Conversation Search Results\n\nTotal: ${result.total}\n\n${result.results}`);
  }

  capture(result: CaptureResponse): string {
    return this.limit([
      "## Agent Memory Capture",
      "",
      `L0 recorded: ${result.l0_recorded}`,
      `Scheduler notified: ${String(result.scheduler_notified)}`,
      "",
      "Capture accepted. L1/L2/L3 extraction may run asynchronously.",
    ].join("\n"));
  }

  sessionEnd(result: SessionEndResponse): string {
    return this.limit(`## Agent Memory Session End\n\nFlushed: ${String(result.flushed)}`);
  }

  seed(result: SeedResponse): string {
    return this.limit([
      "## Agent Memory Seed",
      "",
      `Sessions processed: ${result.sessions_processed}`,
      `Rounds processed: ${result.rounds_processed}`,
      `Messages processed: ${result.messages_processed}`,
      `L0 recorded: ${result.l0_recorded}`,
      `Duration: ${result.duration_ms}ms`,
      `Output directory: ${result.output_dir}`,
    ].join("\n"));
  }

  unavailable(action: string, reason: string): string {
    return this.limit([
      `Agent Memory ${action} is temporarily unavailable.`,
      `Reason: ${reason}`,
      "Impact: Continue the main Codex task with the context already available.",
      "Recovery: The adapter will retry the Gateway on a later call.",
    ].join("\n"));
  }

  private limit(value: string): string {
    if (value.length <= this.maxChars) return value;
    const suffix = "\n\n[Result truncated by the Codex adapter]";
    return `${value.slice(0, Math.max(0, this.maxChars - suffix.length))}${suffix}`;
  }
}
