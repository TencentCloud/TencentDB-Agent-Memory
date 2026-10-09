import { basename } from "node:path";

const UNSAFE_MMD_NAME_RE = /[<>:"/\\|?*\x00-\x1f]/g;

/** Sanitize a task label before using it in Mermaid content or filenames. */
export function sanitizeMmdLabel(label: string, fallback = "task"): string {
  const safe = String(label ?? "")
    .replace(UNSAFE_MMD_NAME_RE, "_")
    .replace(/\.{2,}/g, "_")
    .slice(0, 80);
  const trimmed = safe.trim();
  return trimmed.length === 0 || trimmed === "." ? fallback : safe;
}

/** Normalize a caller-provided MMD filename to a single safe `.mmd` segment. */
export function sanitizeMmdFilename(filename: string, fallback = "task"): string {
  const base = basename(String(filename ?? ""));
  const stem = base.endsWith(".mmd") ? base.slice(0, -".mmd".length) : base;
  return `${sanitizeMmdLabel(stem, fallback)}.mmd`;
}
