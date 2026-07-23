import type { RecallResponse } from "./types.js";

function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 32)).trimEnd()}\n... [truncated]`;
}

export function formatPiAgentMemoryContext(input: {
  recall?: RecallResponse;
  maxChars: number;
}): string {
  const recallContext = input.recall?.context?.trim();
  if (!recallContext) return "";

  const metadata: string[] = [];
  if (input.recall?.strategy) metadata.push(`strategy=${input.recall.strategy}`);
  if (typeof input.recall?.memory_count === "number") metadata.push(`memory_count=${input.recall.memory_count}`);

  return [
    "<tencentdb-agent-memory>",
    "## Long-term Memory Recall for Pi Agent",
    metadata.length > 0 ? `Metadata: ${metadata.join(", ")}` : undefined,
    truncateText(recallContext, input.maxChars),
    "</tencentdb-agent-memory>",
  ].filter(Boolean).join("\n\n");
}