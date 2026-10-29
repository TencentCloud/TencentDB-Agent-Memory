import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { formatSpec } from "../../document-converter/format-registry.js";

export function isSupportedWikiSourceFilename(name: string): boolean {
  // Follow the same registry as upload/conversion, including newly supported
  // rich documents. Unknown formats and preview-only formats are not ingested.
  const spec = formatSpec(name);
  return spec !== undefined && spec.converter !== "none";
}

export function findWikiSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) files.push(...findWikiSourceFiles(full));
    else if (isSupportedWikiSourceFilename(entry)) files.push(full);
  }
  return files;
}
