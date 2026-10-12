/**
 * JSON / Mermaid extraction utilities for LLM response parsing.
 */

import { extractStructuredJson } from "../../utils/structured-output.js";

/**
 * Extract JSON from raw LLM output. Tolerates fences and known wrappers.
 */
export function extractJson<T>(raw: string): T | null {
  return extractStructuredJson<T>(raw);
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
