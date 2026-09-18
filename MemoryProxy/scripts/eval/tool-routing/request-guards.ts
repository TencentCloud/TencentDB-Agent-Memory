/** Deterministic fixture gates. A query match is never a semantic verdict. */
export type RequestGuard =
  | { kind: "query-concepts"; field: string; all_of: Array<{ concept: string; any_of: string[] }> }
  | { kind: "iso-instant"; field: string; equals: string }
  | { kind: "integer-range"; field: string; min: number; max: number; default?: number }
  | { kind: "string-enum"; field: string; values: string[]; default?: string };

export type RequestGuardStatus = "match" | "no_match" | "needs_review";

export interface RequestGuardResult {
  status: RequestGuardStatus;
  /** Matching copy only: callers must retain the original request in traces. */
  normalized_body: Record<string, unknown>;
  /** True whenever any query-concepts guard was evaluated, including matches. */
  semantic_review_required: boolean;
  reasons: string[];
}

const MISSING = Symbol("missing");
const UNSAFE_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function fieldParts(field: string): string[] {
  const parts = field.split(".");
  if (!field.trim() || parts.some((part) => !part || UNSAFE_KEYS.has(part))) {
    throw new TypeError(`Invalid guard field: ${field}`);
  }
  return parts;
}

function readField(body: Record<string, unknown>, parts: string[]): unknown {
  let value: unknown = body;
  for (const part of parts) {
    if (!value || typeof value !== "object" || Array.isArray(value)
      || !Object.prototype.hasOwnProperty.call(value, part)) return MISSING;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

function writeField(body: Record<string, unknown>, parts: string[], value: unknown): boolean {
  let parent = body;
  for (const part of parts.slice(0, -1)) {
    if (!Object.prototype.hasOwnProperty.call(parent, part)) parent[part] = {};
    const child = parent[part];
    if (!child || typeof child !== "object" || Array.isArray(child)) return false;
    parent = child as Record<string, unknown>;
  }
  parent[parts.at(-1)!] = value;
  return true;
}

function normalizeText(text: string): string {
  return text.normalize("NFKC").toLocaleLowerCase("en-US").replace(/\s+/gu, " ").trim();
}

function includesTerm(text: string, term: string): boolean {
  let from = 0;
  while (from <= text.length) {
    const at = text.indexOf(term, from);
    if (at === -1) return false;
    const before = text[at - 1] ?? "";
    const after = text[at + term.length] ?? "";
    const badStart = /^[a-z0-9_]/u.test(term) && /[a-z0-9_]/u.test(before);
    const badEnd = /[a-z0-9_]$/u.test(term) && /[a-z0-9_]/u.test(after);
    if (!badStart && !badEnd) return true;
    from = at + 1;
  }
  return false;
}

interface Instant { seconds: number; fraction: string; normalized: string }

/** Strict RFC3339 calendar values; preserve fractions beyond JS millisecond precision. */
function parseInstant(input: string): Instant | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?([Zz]|[+-]\d{2}:\d{2})$/u.exec(input);
  if (!match) return null;
  const [, ys, mos, ds, hs, mis, ss, fractional = "", zone] = match;
  const [year, month, day, hour, minute, second] = [ys, mos, ds, hs, mis, ss].map(Number);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return null;
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, 0);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  let offsetMinutes = 0;
  if (zone.toUpperCase() !== "Z") {
    const zh = Number(zone.slice(1, 3));
    const zm = Number(zone.slice(4, 6));
    if (zh > 23 || zm > 59) return null;
    offsetMinutes = (zh * 60 + zm) * (zone[0] === "+" ? 1 : -1);
  }
  const seconds = date.getTime() / 1000 - offsetMinutes * 60;
  const fraction = fractional.replace(/0+$/u, "");
  const base = new Date(seconds * 1000).toISOString().replace(/\.000Z$/u, "");
  return { seconds, fraction, normalized: base + (fraction ? "." + fraction : "") + "Z" };
}

export function matchRequestGuards(
  body: Record<string, unknown>,
  guards: readonly RequestGuard[] = [],
): RequestGuardResult {
  const result: RequestGuardResult = {
    status: "match", normalized_body: structuredClone(body), semantic_review_required: false, reasons: [],
  };
  const record = (status: RequestGuardStatus, reason: string) => {
    if (status === "no_match" || (status === "needs_review" && result.status === "match")) result.status = status;
    result.reasons.push(reason);
  };
  for (const guard of guards) {
    const parts = fieldParts(guard.field);
    let value = readField(result.normalized_body, parts);
    if (guard.kind === "query-concepts") {
      result.semantic_review_required = true;
      if (!guard.all_of.length || guard.all_of.some((group) => !group.concept.trim()
        || !group.any_of.length || group.any_of.some((term) => !normalizeText(term)))) {
        throw new TypeError(`Invalid query concept configuration: ${guard.field}`);
      }
      if (typeof value !== "string" || !value.trim()) {
        record("no_match", `${guard.field}: query must be a nonempty string`);
        continue;
      }
      const query = normalizeText(value);
      const missing = guard.all_of.filter((group) => !group.any_of.some((term) => includesTerm(query, normalizeText(term))));
      if (missing.length) {
        record("needs_review", `${guard.field}: unrecognized concepts [${missing.map((group) => group.concept).join(", ")}]; withhold fixture evidence pending semantic review`);
      } else {
        record("match", `${guard.field}: lexical concept coverage only; independent semantic review remains required`);
      }
    } else if (guard.kind === "iso-instant") {
      const expected = parseInstant(guard.equals);
      if (!expected) throw new TypeError(`Invalid expected ISO instant: ${guard.equals}`);
      const actual = typeof value === "string" ? parseInstant(value) : null;
      if (!actual || actual.seconds !== expected.seconds || actual.fraction !== expected.fraction) {
        record("no_match", `${guard.field}: value is not the required ISO instant`);
      } else {
        writeField(result.normalized_body, parts, actual.normalized);
        record("match", `${guard.field}: equivalent ISO instant`);
      }
    } else if (guard.kind === "integer-range") {
      if (!Number.isSafeInteger(guard.min) || !Number.isSafeInteger(guard.max) || guard.min > guard.max
        || (guard.default !== undefined && (!Number.isSafeInteger(guard.default) || guard.default < guard.min || guard.default > guard.max))) {
        throw new TypeError(`Invalid integer range configuration: ${guard.field}`);
      }
      if (value === MISSING && guard.default !== undefined) {
        value = guard.default;
        if (!writeField(result.normalized_body, parts, value)) {
          record("no_match", `${guard.field}: parent must be an object`);
          continue;
        }
      }
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value < guard.min || value > guard.max) {
        record("no_match", `${guard.field}: integer outside [${guard.min}, ${guard.max}]`);
      } else record("match", `${guard.field}: integer within admitted range`);
    } else if (guard.kind === "string-enum") {
      if (!guard.values.length || guard.values.some((item) => typeof item !== "string")
        || (guard.default !== undefined && !guard.values.includes(guard.default))) {
        throw new TypeError(`Invalid string enum configuration: ${guard.field}`);
      }
      if (value === MISSING && guard.default !== undefined) {
        value = guard.default;
        if (!writeField(result.normalized_body, parts, value)) {
          record("no_match", `${guard.field}: parent must be an object`);
          continue;
        }
      }
      if (typeof value !== "string" || !guard.values.includes(value)) {
        record("no_match", `${guard.field}: value outside admitted string representations`);
      } else record("match", `${guard.field}: admitted string representation`);
    } else {
      throw new TypeError("Unsupported request guard kind");
    }
  }
  return result;
}
