export function findExistingRawFilenames(
  filenames: readonly string[],
  existingFilenames: readonly string[],
): string[] {
  const existing = new Set(existingFilenames);
  return [...new Set(filenames.filter((filename) => existing.has(filename)))];
}

export function formatOverwriteFilenames(filenames: readonly string[]): string {
  return filenames.map((filename) => `「${filename}」`).join('、 ');
}
