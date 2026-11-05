/** OKF 0.2 consumer semantics. Optional/unknown metadata never prevents consumption. */
import { parseFrontmatter, sourceEntries, type PageFrontmatter, type ActorEvent } from "./ingest-v2/frontmatter.js";

export const OKF_VERSION = "0.2";
export const OKF_SPEC_COMMIT = "ad30107c31c06aec8a7d5636e0d1058118604e6f";
export interface OkfMetadata {
  version: string;
  status: string;
  stale: boolean;
  trust: "unverified" | "machine-confirmed" | "human-reviewed";
  verificationPredatesContent: boolean;
  frontmatter: PageFrontmatter;
  warnings: string[];
}

function events(value: unknown): ActorEvent[] {
  const list = Array.isArray(value) ? value : value ? [value] : [];
  return list.filter((v): v is ActorEvent => !!v && typeof v === "object" && typeof v.by === "string");
}
function instant(value: unknown): number | undefined {
  if (typeof value !== "string" || !/T.*(?:Z|[+-]\d\d:\d\d)$/.test(value)) return undefined;
  const n = Date.parse(value);
  return Number.isFinite(n) ? n : undefined;
}

export function readOkfMetadata(content: string, now = Date.now()): OkfMetadata {
  const { frontmatter: fm, hasFrontmatter } = parseFrontmatter(content);
  const warnings: string[] = [];
  if (!hasFrontmatter) warnings.push("Missing or invalid YAML frontmatter");
  const verification = events(fm.verified);
  const staleAt = instant(fm.stale_after);
  if (fm.stale_after !== undefined && staleAt === undefined) warnings.push("Invalid stale_after datetime/UTC offset");
  const generatedAt = instant(fm.generated ? fm.generated.at : fm.timestamp);
  const verifiedAt = verification.map((e) => instant(e.at)).filter((n): n is number => n !== undefined);
  if (fm.verified !== undefined && verification.length === 0) warnings.push("Invalid or empty verified family");
  if (fm.generated && !fm.generated.by) warnings.push("generated.by is missing");
  if (fm.status && !["draft", "stable", "deprecated"].includes(fm.status)) warnings.push("Unknown status");
  for (const s of sourceEntries(fm.sources)) {
    if (typeof s === "string") warnings.push("Legacy string source; migrate to OKF source object");
    else if (!s.resource.trim()) warnings.push("Empty source resource");
  }
  if (fm.generated?.at !== undefined && instant(fm.generated.at) === undefined) warnings.push("Invalid generated.at datetime/UTC offset");
  for (const e of verification) if (instant(e.at) === undefined) warnings.push("Invalid verified.at datetime/UTC offset");
  const sourceList = sourceEntries(fm.sources);
  if (fm.sources !== undefined && (!Array.isArray(fm.sources) || sourceList.length !== fm.sources.length)) warnings.push("Invalid source entry");
  const sourceIds = sourceList.flatMap((s) => typeof s !== "string" && s.id ? [s.id] : []);
  if (new Set(sourceIds).size !== sourceIds.length) warnings.push("Duplicate sources[].id; attribution is ambiguous");
  const ids = new Set(sourceEntries(fm.sources).flatMap((s) => typeof s !== "string" && s.id ? [s.id] : []));
  for (const m of content.matchAll(/\[\^([^\]]+)\](?!:)/g)) {
    if (!ids.has(m[1])) warnings.push(`Footnote has no sources[].id: ${m[1]}`);
  }
  if (fm.type === "Attested Computation" && !fm.runtime) warnings.push("Attested Computation requires runtime");
  return {
    version: OKF_VERSION,
    status: typeof fm.status === "string" ? fm.status : "stable",
    stale: staleAt !== undefined && now >= staleAt,
    trust: verification.some((e) => e.by.startsWith("human:")) ? "human-reviewed" : verification.length ? "machine-confirmed" : "unverified",
    verificationPredatesContent: generatedAt !== undefined && verifiedAt.length > 0 && verifiedAt.reduce((latest, at) => Math.max(latest, at), -Infinity) < generatedAt,
    frontmatter: fm, warnings: [...new Set(warnings)],
  };
}
