import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";

const MAX_DEPTH = 100;
const MAX_ENTRIES = 100000;

/**
 * Validates a project boundary to ensure it does not contain symlinks,
 * non-regular files, or excessively deep/large directory structures.
 *
 * Note: This implements a point-in-time check (TOCTOU limitation applies).
 * It relies on the trusted parent / single-writer assumption for the project directory.
 */
export async function validateProjectBoundary(projectPath: string): Promise<void> {
  let entriesCount = 0;

  async function walk(currentPath: string, depth: number): Promise<void> {
    if (depth > MAX_DEPTH) {
      throw new Error("Project structure validation failed: maximum directory depth exceeded");
    }

    let stats;
    try {
      stats = await lstat(currentPath);
    } catch (err: any) {
      throw new Error("Project structure validation failed: cannot access entry");
    }

    if (stats.isSymbolicLink()) {
      throw new Error("Project structure validation failed: symlinks are not allowed");
    }

    if (depth === 0 && !stats.isDirectory()) {
      throw new Error("Project structure validation failed: project root must be a directory");
    }

    if (stats.isDirectory()) {
      let entries;
      try {
        entries = await readdir(currentPath);
      } catch (err) {
        throw new Error("Project structure validation failed: cannot read directory");
      }

      for (const entry of entries) {
        entriesCount++;
        if (entriesCount > MAX_ENTRIES) {
          throw new Error("Project structure validation failed: maximum entry limit exceeded");
        }
        await walk(join(currentPath, entry), depth + 1);
      }
    } else if (stats.isFile()) {
      // Regular files are allowed. This includes the existing binary .codegraph index files.
    } else {
      // Not a symlink, directory, or regular file (socket, fifo, block device, etc)
      throw new Error("Project structure validation failed: invalid entry type detected");
    }
  }

  await walk(projectPath, 0);
}
