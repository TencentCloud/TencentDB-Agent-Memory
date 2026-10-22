import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const SUPPORTED_SOURCE_EXTENSIONS = [".md", ".markdown", ".txt"] as const;

export function isSupportedWikiSourceFilename(name: string): boolean {
  const lower = name.toLowerCase();
  return SUPPORTED_SOURCE_EXTENSIONS.some((ext) => lower.endsWith(ext));
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
