import type { ContextFormatOptions, RecallResponse } from "./types.js";

function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 32)).trimEnd()}\n... [truncated]`;
}

export function formatClaudeCodeAdditionalContext(input: {
  recall?: RecallResponse;
  shortTermCanvas?: string;
  options: ContextFormatOptions;
}): string {
  const sections: string[] = [];

  const recallContext = input.recall?.context?.trim();
  if (recallContext) {
    const meta: string[] = [];
    if (input.recall?.strategy) meta.push(`strategy=${input.recall.strategy}`);
    if (typeof input.recall?.memory_count === "number") meta.push(`memory_count=${input.recall.memory_count}`);
    sections.push(
      [
        "## TencentDB-Agent-Memory Long-term Recall",
        meta.length > 0 ? `Metadata: ${meta.join(", ")}` : undefined,
        truncateText(recallContext, input.options.recallMaxChars),
      ].filter(Boolean).join("\n\n"),
    );
  }

  const canvas = input.shortTermCanvas?.trim();
  if (canvas) {
    sections.push(
      [
        "## TencentDB-Agent-Memory Short-term Task Canvas",
        "This is current-task scratch context captured from recent tool activity.",
        truncateText(canvas, input.options.canvasMaxChars),
      ].join("\n\n"),
    );
  }

  return sections.length > 0
    ? `<tencentdb-agent-memory>\n\n${sections.join("\n\n---\n\n")}\n\n</tencentdb-agent-memory>`
    : "";
}

