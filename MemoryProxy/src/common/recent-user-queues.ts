import { stripSkillQueueBlocks } from "./skill-queue-markers.js";

/** Build a bounded, chronological query from the latest real user queues. */
export function extractRecentUserQueues(
  input: unknown,
  extractText: (content: unknown) => string | null,
  windowSize = 3,
  maxChars = 6000,
): string {
  if (!Array.isArray(input) || windowSize < 1 || maxChars < 1) return "";
  const queues: string[] = [];
  for (let index = input.length - 1; index >= 0 && queues.length < windowSize; index -= 1) {
    const item = input[index] as Record<string, unknown> | null;
    if (!item || item.type !== "message" || item.role !== "user") continue;
    const text = stripSkillQueueBlocks(extractText(item.content) ?? "");
    if (text) queues.push(text);
  }
  return queues.reverse().join("\n\n").slice(-maxChars).trimStart();
}
