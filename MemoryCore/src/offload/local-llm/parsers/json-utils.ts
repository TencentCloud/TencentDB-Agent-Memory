/**
 * Tolerant JSON parsing utilities for LLM responses.
 *
 * LLMs often wrap JSON in markdown code fences, include trailing commas,
 * or prepend known reasoning wrappers. These utilities handle those bounded
 * deviations without searching arbitrary prose for JSON.
 */

import { extractStructuredJson } from "../../../utils/structured-output.js";

/**
 * Extract JSON from LLM output — handles code fences and known wrappers.
 * Returns the parsed object/array, or null if parsing fails.
 */
export function extractJson<T = unknown>(raw: string): T | null {
  return extractStructuredJson<T>(raw);
}

/**
 * Extract mermaid content from a code fence.
 * Returns the raw mermaid text (without fence markers).
 */
export function extractMermaidFromFence(text: string): string | null {
  if (!text) return null;
  const match = text.match(/```mermaid\s*\n?([\s\S]*?)```/);
  if (match) return match[1].trim();
  // Fallback: if no fence, return as-is (might already be raw mermaid)
  if (text.includes("flowchart") || text.includes("graph")) return text.trim();
  return null;
}

// ─── Internal Helpers ────────────────────────────────────────────────────────
