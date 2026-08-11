/** Truncate a string to `max` characters (suffix with "..."). */
export function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 3)}...` : s;
}

/**
 * Split records into fixed-size chunks (night multi-batch slices).
 * Empty input → a single empty chunk: the pipeline still runs once
 * (spawn → out/result.json → caps → apply) instead of short-circuiting.
 */
export function chunkRecords<T>(records: T[], size: number): T[][] {
  if (records.length === 0) return [[]];
  const chunks: T[][] = [];
  for (let i = 0; i < records.length; i += size) {
    chunks.push(records.slice(i, i + size));
  }
  return chunks;
}
