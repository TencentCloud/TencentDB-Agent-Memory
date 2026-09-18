import { createHash } from "node:crypto";

/** Sort object keys only. Prompt text, arrays and absent-vs-null values retain their meaning. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item ?? null)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value).filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right, "en"))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  const result = JSON.stringify(value);
  if (result === undefined) throw new Error("Experiment identity contains a non-JSON value");
  return result;
}

export function experimentFingerprint(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
