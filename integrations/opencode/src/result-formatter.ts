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
  constructor(private readonly maxChars: number) {}

  health(result: HealthResponse): string {
    return this.limit(
      [
        "## Agent Memory Health",
        "",
        `Status: ${result.status}`,
        `Version: ${result.version}`,
        `Vector store: ${String(result.stores.vectorStore)}`,
        `Embedding service: ${String(result.stores.embeddingService)}`,
      ].join("\n"),
    );
  }

  recall(result: RecallResponse): string {
    return this.limit(
      [
        "## Agent Memory Recall",
        "",
        `Strategy: ${result.strategy ?? "unknown"}`,
        `Memory count: ${result.memory_count ?? 0}`,
        "",
        result.context || "No relevant memory found.",
      ].join("\n"),
    );
  }

  capture(result: CaptureResponse): string {
    return this.limit(
      [
        "## Agent Memory Capture",
        "",
        `L0 recorded: ${result.l0_recorded}`,
        `Scheduler notified: ${String(result.scheduler_notified)}`,
        "",
        "L1/L2/L3 extraction may continue asynchronously.",
      ].join("\n"),
    );
  }

  memorySearch(result: MemorySearchResponse): string {
    return this.limit(
      [
        "## Agent Memory Search Results",
        "",
        `Total: ${result.total}`,
        `Strategy: ${result.strategy}`,
        "",
        result.results || "No matching memories found.",
      ].join("\n"),
    );
  }

  conversationSearch(result: ConversationSearchResponse): string {
    return this.limit(
      [
        "## Agent Conversation Search Results",
        "",
        `Total: ${result.total}`,
        "",
        result.results || "No matching conversations found.",
      ].join("\n"),
    );
  }

  sessionEnd(result: SessionEndResponse): string {
    return this.limit(
      `## Agent Memory Session End\n\nFlushed: ${String(result.flushed)}`,
    );
  }

  seed(result: SeedResponse): string {
    return this.limit(
      [
        "## Agent Memory Seed",
        "",
        `Sessions processed: ${result.sessions_processed}`,
        `Rounds processed: ${result.rounds_processed}`,
        `Messages processed: ${result.messages_processed}`,
        `L0 recorded: ${result.l0_recorded}`,
        `Duration: ${result.duration_ms}ms`,
        `Output directory: ${result.output_dir}`,
      ].join("\n"),
    );
  }

  unavailable(action: string, reason: string): string {
    return this.limit(
      [
        `Agent Memory ${action} is temporarily unavailable.`,
        `Reason: ${reason}`,
        "Impact: Continue the main OpenCode task with the context already available.",
        "Recovery: The adapter will retry the Gateway on a later operation.",
      ].join("\n"),
    );
  }

  limit(value: string, reservedChars = 0): string {
    const available = Math.max(0, this.maxChars - reservedChars);
    if (value.length <= available) return value;
    const suffix = "\n\n[Result truncated by the OpenCode adapter]";
    if (available <= suffix.length) return suffix.slice(0, available);
    return `${value.slice(0, available - suffix.length)}${suffix}`;
  }
}
