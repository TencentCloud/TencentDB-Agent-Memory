/**
 * Size cap for the L2/L3 LLM agent `read` tool.
 *
 * Scene files grow without bound (every consolidation adds a block), so a
 * `read` that returns the whole file can push the tool-loop conversation past
 * the model context window and make every later step fail with
 * `context_length_exceeded`. The cap keeps the head of the file (where new
 * dated blocks are prepended) and appends a marker that tells the model how
 * much was left out.
 */

/** Default max UTF-8 bytes returned by one `read` call, marker included. */
export const DEFAULT_READ_MAX_BYTES = 64 * 1024;

// Room for "\n…[truncated: showing first N of M bytes]" with 16-digit numbers.
const MARKER_RESERVE_BYTES = 80;

/**
 * Return `content` unchanged when it fits in `maxBytes` (UTF-8), otherwise the
 * longest head that fits plus a `[truncated ...]` marker, so the result never
 * exceeds `maxBytes`. The cut never lands inside a multi-byte character.
 */
export function capReadContent(content: string, maxBytes: number = DEFAULT_READ_MAX_BYTES): string {
  const bytes = Buffer.from(content, "utf8");
  const total = bytes.length;
  if (total <= maxBytes) return content;

  let end = Math.max(0, maxBytes - MARKER_RESERVE_BYTES);
  // Back off over UTF-8 continuation bytes (10xxxxxx) so the cut starts a character.
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return `${bytes.subarray(0, end).toString("utf8")}\n…[truncated: showing first ${end} of ${total} bytes]`;
}
