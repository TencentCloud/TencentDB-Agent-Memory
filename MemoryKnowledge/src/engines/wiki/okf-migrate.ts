/** Explicit legacy migration; never guesses authorship, verification or source credibility. */
import { parseDocument } from "yaml";
import { sourceEntries } from "./ingest-v2/frontmatter.js";

export function migrateOkfPage(content: string): { content: string; changed: boolean; warnings: string[] } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) throw new Error("Missing frontmatter; explicit type is required before migration");
  const doc = parseDocument(match[1]);
  const fm = doc.toJS();
  if (doc.errors.length || !fm || Array.isArray(fm) || typeof fm.type !== "string" || !fm.type.trim()) throw new Error("Invalid concept frontmatter/type");
  const warnings: string[] = [];
  let changed = false;
  if (Array.isArray(fm.sources)) {
    const sources = sourceEntries(fm.sources);
    if (sources.length !== fm.sources.length) throw new Error("Invalid sources; refusing lossy migration");
    if (sources.some((s) => typeof s === "string")) {
      doc.set("sources", sources.map((s) => typeof s === "string"
        ? { resource: `raw source: ${s}`, tdai_raw_source: s } : s));
      changed = true;
    }
  }
  if (fm.timestamp && !fm.generated) warnings.push("Legacy timestamp retained: original producer unknown; consumer uses timestamp fallback");
  // Do not normalize other metadata or strip locked. Body is byte-for-byte untouched.
  return { content: changed ? `---\n${doc.toString()}---\n${content.slice(match[0].length)}` : content, changed, warnings };
}
