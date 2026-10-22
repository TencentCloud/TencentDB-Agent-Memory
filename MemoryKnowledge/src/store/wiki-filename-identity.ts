import { posix } from "node:path";

export function filenameCollisionKey(name: string): string {
  const portablePath = posix.normalize(name.replace(/\\/g, "/"));
  return portablePath.normalize("NFC").toLocaleLowerCase("en-US");
}

export function findDuplicateWikiFilename(names: string[]): string | null {
  const seen = new Set<string>();
  for (const name of names) {
    const key = filenameCollisionKey(name);
    if (seen.has(key)) return name;
    seen.add(key);
  }
  return null;
}
