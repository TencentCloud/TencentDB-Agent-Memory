/**
 * SQLite FTS5 MATCH-query construction.
 *
 * Security invariant: callers provide text candidates, never FTS5 syntax.
 * This module extracts literal token parts, quotes every part, and owns every
 * operator inserted into the resulting expression.
 */

const SAFE_TOKEN_PART_RE = /[\p{L}\p{N}_]+/gu;

export interface Fts5LiteralQueryOptions {
  stopWords?: ReadonlySet<string>;
}

/** Encode one value as an FTS5 quoted string literal. */
export function quoteFts5Literal(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

/**
 * Build an OR query from tokenizer output while preserving literal words.
 *
 * Reserved words such as AND, OR, NOT, and NEAR are deliberately retained:
 * once quoted they are ordinary searchable terms and cannot affect grammar.
 * Dropping them would turn valid queries such as "near airport" into a
 * different search.
 */
export function buildFts5LiteralOrQuery(
  candidates: Iterable<string>,
  options: Fts5LiteralQueryOptions = {},
): string | null {
  const stopWords = options.stopWords;
  const tokens: string[] = [];
  const seen = new Set<string>();

  for (const candidate of candidates) {
    const parts = candidate.match(SAFE_TOKEN_PART_RE) ?? [];
    for (const part of parts) {
      if (stopWords?.has(part)) continue;

      // unicode61 is case-insensitive by default. Avoid emitting redundant
      // terms while preserving the first spelling for readable debug logs.
      const dedupeKey = part.toLowerCase();
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      tokens.push(part);
    }
  }

  if (tokens.length === 0) return null;
  return tokens.map(quoteFts5Literal).join(" OR ");
}
