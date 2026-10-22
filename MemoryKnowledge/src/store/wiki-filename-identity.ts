export function filenameCollisionKey(name: string): string {
  return name.normalize("NFC").toLocaleLowerCase("en-US");
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
