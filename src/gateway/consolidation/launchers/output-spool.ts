/**
 * Bounded child output (tz-06 Ф2, критерий 8).
 *
 * A role that prints 8 MB used to put 8 MB into the run summary and into
 * memory. What a caller actually needs is the TAIL (the error is at the end)
 * plus a pointer to the whole thing on disk — so the buffer is capped and the
 * full stream is spooled next to the attempt.
 *
 * The spool is best-effort: an unwritable scratch dir must not fail a run
 * that is otherwise fine.
 */
import fs from "node:fs";
import path from "node:path";

/** Kept in memory per stream. The tail is what diagnoses a failure. */
export const OUTPUT_TAIL_BYTES = 64 * 1024;
export const ARTIFACTS_DIR = "artifacts";

export interface Spool {
  write: (chunk: Buffer) => void;
  /** Tail of the stream, at most OUTPUT_TAIL_BYTES. */
  tail: () => string;
  /** Bytes seen, including what the tail dropped. */
  bytes: () => number;
  /** Path of the full spool file, when one could be opened. */
  file: string | null;
  close: () => void;
}

export function createSpool(cwd: string, name: string): Spool {
  const chunks: Buffer[] = [];
  let held = 0;
  let total = 0;

  let stream: fs.WriteStream | null = null;
  let file: string | null = null;
  try {
    const dir = path.join(cwd, ARTIFACTS_DIR);
    fs.mkdirSync(dir, { recursive: true });
    file = path.join(dir, `${name}.log`);
    stream = fs.createWriteStream(file, { flags: "a" });
    // A spool that dies mid-run must not take the run with it.
    stream.on("error", () => {
      stream = null;
    });
  } catch {
    stream = null;
    file = null;
  }

  const trim = (): void => {
    while (held > OUTPUT_TAIL_BYTES && chunks.length > 1) {
      held -= chunks.shift()!.length;
    }
    if (held > OUTPUT_TAIL_BYTES && chunks.length === 1) {
      const only = chunks[0]!;
      chunks[0] = only.subarray(only.length - OUTPUT_TAIL_BYTES);
      held = chunks[0].length;
    }
  };

  return {
    write: (chunk: Buffer) => {
      total += chunk.length;
      stream?.write(chunk);
      chunks.push(chunk);
      held += chunk.length;
      trim();
    },
    tail: () => {
      const joined = Buffer.concat(chunks);
      return joined.length > OUTPUT_TAIL_BYTES
        ? joined.subarray(joined.length - OUTPUT_TAIL_BYTES).toString("utf-8")
        : joined.toString("utf-8");
    },
    bytes: () => total,
    get file() {
      return file;
    },
    close: () => {
      stream?.end();
    },
  } as Spool;
}
