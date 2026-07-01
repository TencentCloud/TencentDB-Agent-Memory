const DEFAULT_SEARCH_LIMIT = 5;
const MAX_SEARCH_LIMIT = 20;

export function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

export function compactObject(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

export function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function requireString(args: Record<string, unknown>, key: string): string {
  const value = optionalString(args, key);
  if (!value) throw new Error(`Missing required argument: ${key}`);
  return value;
}

export function coerceSearchLimit(value: unknown, fallback = DEFAULT_SEARCH_LIMIT, maximum = MAX_SEARCH_LIMIT): number {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return fallback;
  const n = typeof value === "number" ? value : Number.parseFloat(String(value));
  if (!Number.isFinite(n)) return fallback;
  if (n < 1) return 1;
  if (n > maximum) return maximum;
  return Math.floor(n);
}

export function optionalSearchLimit(args: Record<string, unknown>, key = "limit"): number | undefined {
  if (!(key in args) || args[key] === undefined || args[key] === null || args[key] === "") {
    return undefined;
  }
  return coerceSearchLimit(args[key]);
}

export function truncateForLog(value: string, maxLength = 80): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}
