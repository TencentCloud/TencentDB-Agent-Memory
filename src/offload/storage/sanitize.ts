/**
 * Sanitize layer (split from storage.ts).
 * Layer 0: `sanitizeText` strips unsafe chars from arbitrary text.
 * Layer 1: `sanitizeJsonLine` does the same for JSON strings with roundtrip.
 * Layer 3: `validateEntry` enforces entry schema (must have string tool_call_id).
 * `parseJsonlSafe` is a tolerant JSONL parser used by readers/writers.
 * `safeStringifyEntry` is the canonical "write" sanitizer.
 * `extractConfirmedIdsFromEntries` / `extractDeletedIdsFromEntries` are status
 * tag extractors used by L2 aggregation / merge dedup.
 */

const UNSAFE_CHAR_RE =
  /[\uFFFD\u0000-\u0008\u000B\u000C\u000E-\u001F\u0080-\u009F\uD800-\uDFFF\u200B-\u200F\u2028\u2029\uFEFF]/gu;

/** Layer 0 — Source text sanitize. Strips unsafe characters from arbitrary text. */
export function sanitizeText(text: string): string {
  if (typeof text !== "string") return text;
  return text.replace(UNSAFE_CHAR_RE, "");
}

/** Layer 1 — Write sanitize. Strips unsafe characters from a JSON string with roundtrip verification. */
export function sanitizeJsonLine(jsonStr: string): string {
  let cleaned = jsonStr.replace(UNSAFE_CHAR_RE, "");
  try {
    JSON.parse(cleaned);
    return cleaned;
  } catch {
    /* fall through */
  }
  cleaned = jsonStr.replace(
    /[^\x09\x0A\x0D\x20-\x7E\u00A0-\u024F\u3400-\u4DBF\u4E00-\u9FFF\uFF00-\uFFEF]/g,
    "",
  );
  try {
    JSON.parse(cleaned);
    return cleaned;
  } catch {
    /* fall through */
  }
  try {
    const obj = JSON.parse(jsonStr.replace(/[^\x20-\x7E\t\n\r]/g, ""));
    return JSON.stringify(obj);
  } catch {
    return "{}";
  }
}

/** Layer 3 — Entry schema validation. */
export function validateEntry(entry: unknown): boolean {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry))
    return false;
  const e = entry as Record<string, unknown>;
  if (typeof e.tool_call_id !== "string" || (e.tool_call_id as string).length === 0)
    return false;
  return true;
}

/** Layer 2+3+4 — Safe JSONL parser with tolerance, validation, and metrics. */
export function parseJsonlSafe(
  content: string,
  options?: { sourceLabel?: string; skipValidation?: boolean },
): {
  entries: Array<Record<string, unknown>>;
  corruptCount: number;
  invalidCount: number;
  corruptSample: string | null;
} {
  const entries: Array<Record<string, unknown>> = [];
  let corruptCount = 0;
  let invalidCount = 0;
  let corruptSample: string | null = null;
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      try {
        parsed = JSON.parse(trimmed.replace(UNSAFE_CHAR_RE, ""));
      } catch {
        corruptCount++;
        if (corruptSample === null) {
          corruptSample = trimmed.slice(0, 200);
        }
        continue;
      }
    }
    if (!options?.skipValidation && !validateEntry(parsed)) {
      invalidCount++;
      continue;
    }
    entries.push(parsed as Record<string, unknown>);
  }
  return { entries, corruptCount, invalidCount, corruptSample };
}

export function safeStringifyEntry(entry: Record<string, unknown>): string {
  return sanitizeJsonLine(JSON.stringify(entry));
}

/** Extract confirmed (offloaded) tool_call_ids from entries. */
export function extractConfirmedIdsFromEntries(
  entries: Array<{ tool_call_id: string; offloaded?: unknown }>,
): Set<string> {
  const ids = new Set<string>();
  for (const entry of entries) {
    if (entry.offloaded) {
      const id = entry.tool_call_id;
      if (!id) continue;
      ids.add(id);
      const normalized = id.replace(/_/g, "");
      if (normalized !== id) ids.add(normalized);
    }
  }
  return ids;
}

/** Extract aggressively deleted tool_call_ids from entries. */
export function extractDeletedIdsFromEntries(
  entries: Array<{ tool_call_id: string; offloaded?: unknown }>,
): Set<string> {
  const ids = new Set<string>();
  for (const entry of entries) {
    if (entry.offloaded === "deleted") {
      const id = entry.tool_call_id;
      if (!id) continue;
      ids.add(id);
      const normalized = id.replace(/_/g, "");
      if (normalized !== id) ids.add(normalized);
    }
  }
  return ids;
}
