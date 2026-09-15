/**
 * Atomic file write — write to a temp file in the same directory, then rename
 * over the target. rename(2) is atomic on POSIX within a single filesystem, so
 * a reader never observes a half-written file and a crash mid-write leaves the
 * previous version intact (or, worst case, an orphan temp file).
 *
 * Why this matters for TDAI: L3 persona (`persona.md`) and L2 scene index are
 * derived state written via a raw `fs.writeFile` read-modify-write, with no
 * lock or atomicity. Under the multi-tenant retrofit a single dataDir is still
 * owned by one process, but concurrent pipeline stages (or a crash) can corrupt
 * a plain write. See design §8.5 red line 3 / issue §2.
 *
 * Contract reminder: this guards against torn writes within one process/host.
 * It does NOT make two processes sharing one dataDir safe — that remains a hard
 * "single dataDir, single process" constraint.
 */

import fs from "node:fs/promises";
import path from "node:path";

/**
 * Atomically write `content` to `filePath`.
 *
 * The temp file is created in the same directory as the target (rename across
 * filesystems is not atomic and would throw EXDEV). The temp name embeds the pid
 * and a counter so concurrent writers in the same process don't collide.
 */
let counter = 0;
export async function atomicWriteFile(
  filePath: string,
  content: string | Uint8Array,
  encoding: BufferEncoding = "utf-8",
): Promise<void> {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  // eslint-disable-next-line no-plusplus
  const tmpPath = path.join(dir, `.${base}.${process.pid}.${counter++}.tmp`);
  try {
    await fs.writeFile(tmpPath, content, encoding);
    await fs.rename(tmpPath, filePath);
  } catch (err) {
    // Best-effort cleanup of the temp file if rename never happened.
    await fs.rm(tmpPath, { force: true }).catch(() => {});
    throw err;
  }
}
