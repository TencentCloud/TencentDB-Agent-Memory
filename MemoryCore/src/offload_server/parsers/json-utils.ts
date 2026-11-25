/**
 * JSON / Mermaid extraction utilities for LLM response parsing.
 */

/**
 * Extract JSON from raw LLM output. Tolerates markdown fences, extra text.
 */
export function extractJson<T>(raw: string): T | null {
  if (!raw || typeof raw !== "string") return null;

  const trimmed = raw.trim();

  // 1. Direct parse
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    // continue
  }

  // 2. Extract from ```json ... ``` fence
  const jsonFenceMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (jsonFenceMatch) {
    try {
      return JSON.parse(jsonFenceMatch[1].trim()) as T;
    } catch {
      // continue
    }
  }

  // Try the outer array/object first, rather than an object nested in an array.
  const candidates = [
    { start: trimmed.indexOf("{"), end: trimmed.lastIndexOf("}") },
    { start: trimmed.indexOf("["), end: trimmed.lastIndexOf("]") },
  ].filter(({ start, end }) => start >= 0 && end > start)
    .sort((a, b) => a.start - b.start);
  for (const { start, end } of candidates) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1)) as T;
    } catch {
      // continue
    }
  }

  return null;
}

/**
 * Extract mermaid content from a ```mermaid ... ``` code fence.
 */
export function extractMermaidFromFence(raw: string): string | null {
  if (!raw) return null;
  const match = raw.match(/```mermaid\s*\n?([\s\S]*?)```/);
  return match ? match[1].trim() : null;
}

/**
 * Parse JSONL (newline-delimited JSON) string into array.
 * Corrupted lines are silently skipped (logged via optional callback).
 */
export function parseJsonl<T>(
  content: string,
  onBadLine?: (line: string, error: unknown) => void,
): T[] {
  if (!content || !content.trim()) return [];
  const results: T[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      results.push(JSON.parse(trimmed) as T);
    } catch (err) {
      onBadLine?.(trimmed, err);
    }
  }
  return results;
}

/**
 * Serialize array to JSONL string (trailing newline).
 */
export function serializeJsonl<T>(items: T[]): string {
  if (items.length === 0) return "";
  return items.map((item) => JSON.stringify(item)).join("\n") + "\n";
}
