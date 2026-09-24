/** Normalize and validate user-provided Git sparse-checkout paths. */
export function normalizeSparsePaths(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new Error("sparse_paths must be an array of relative paths");
  }

  const normalized: string[] = [];
  const seen = new Set<string>();

  for (const raw of value) {
    if (typeof raw !== "string") {
      throw new Error("sparse_paths entries must be strings");
    }

    const trimmed = raw.trim();
    const path = trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
    const segments = path.split("/");
    if (
      !path ||
      path.startsWith("/") ||
      raw.includes("\\") ||
      segments.some((segment) => !segment || segment === "." || segment === "..")
    ) {
      throw new Error(`sparse_paths contains an invalid relative path: ${raw}`);
    }

    if (!seen.has(path)) {
      seen.add(path);
      normalized.push(path);
    }
  }

  return normalized;
}
