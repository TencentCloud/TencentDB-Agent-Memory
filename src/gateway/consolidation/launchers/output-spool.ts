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
  /** Resolves once the file is flushed and closed: the attempt row points at
   * this path, so a caller that reads it before `finish` reads a partial
   * file. */
  close: () => Promise<void>;
  /** True while the OS buffer is full — the caller should pause the pipe. */
  saturated: () => boolean;
  /** Fires once the stream has drained after `saturated` was true. */
  onDrain: (fn: () => void) => void;
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

  let full = false;
  let drainFn: (() => void) | undefined;

  return {
    write: (chunk: Buffer) => {
      total += chunk.length;
      if (stream !== null && !stream.write(chunk)) {
        // The write queue is above the high-water mark: keep pushing and the
        // unflushed chunks pile up in memory, which is the 8 MB problem this
        // module exists to prevent — only now on the disk side.
        full = true;
        stream.once("drain", () => {
          full = false;
          drainFn?.();
        });
      }
      chunks.push(chunk);
      held += chunk.length;
      trim();
    },
    saturated: () => full,
    onDrain: (fn: () => void) => {
      drainFn = fn;
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
    close: () =>
      new Promise<void>((resolve) => {
        if (stream === null) {
          resolve();
          return;
        }
        const s = stream;
        // Bounded: an unwritable disk must not wedge the run either.
        const t = setTimeout(resolve, 2000);
        s.end(() => {
          clearTimeout(t);
          resolve();
        });
      }),
  } as Spool;
}
