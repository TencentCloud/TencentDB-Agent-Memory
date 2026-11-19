/**
 * Offload Session Utilities — unified sessionId sanitization.
 *
 * sessionId: opaque identifier from client (free format, e.g. "main:main", "coding:session-001")
 * sanitizedSessionId: filesystem-safe version used for:
 *   - File/directory paths (offload/{sanitizedSessionId}/)
 *   - Distributed lock keys
 *   - Task queue session identifiers
 *
 * Conversion: replace all non-alphanumeric/dot/hyphen/underscore chars with "_"
 */

/**
 * Convert a raw sessionId to a filesystem-safe string.
 * Replaces colons and other unsafe characters with underscores.
 */
export function sanitizeSessionId(sessionId: string): string {
  const replaced = sessionId.replace(/[^a-zA-Z0-9._\-]/g, "_");
  // `.` is allowed inside a name (e.g. "main.session"), but a dot-only
  // segment ("." / "..") is a path traversal marker: `offload/../x` resolves
  // outside the offload directory. Keep the value inside `offload/` by
  // mapping dots to underscores, consistent with MemoryKnowledge's
  // sanitizeUsername.
  if (/^\.+$/.test(replaced)) return replaced.replace(/\./g, "_");
  return replaced;
}

/**
 * Build the offload storage base path for a session.
 */
export function buildOffloadBasePath(sessionId: string): string {
  return `offload/${sanitizeSessionId(sessionId)}`;
}

// Legacy compat: keep old name as alias (will remove after all callers migrated)
export const toSessionId = sanitizeSessionId;
