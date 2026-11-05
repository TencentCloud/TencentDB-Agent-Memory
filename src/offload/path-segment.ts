const UNSAFE_PATH_SEGMENT_RE = /[<>:"/\\|?*\x00-\x1f]/g;

/** Sanitize untrusted text before using it as one filesystem path segment. */
export function sanitizePathSegment(value: string, fallback = "item"): string {
  const safe = String(value ?? "")
    .replace(UNSAFE_PATH_SEGMENT_RE, "_")
    .replace(/\.{2,}/g, "_")
    .slice(0, 120);
  const trimmed = safe.trim();
  return trimmed.length === 0 || trimmed === "." ? fallback : safe;
}
