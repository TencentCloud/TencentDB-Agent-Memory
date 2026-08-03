/**
 * State file operations (split from storage.ts).
 * `readStateFile` — read `<dataDir>/state.json` with default fallback (on
 *   missing or parse error).
 * `writeStateFile` — write state with `mkdir -p` of dirname.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import type { StorageContext } from "../storage-shim-types.js";

/** Read the state.json file */
export async function readStateFile<T>(
  ctx: StorageContext,
  defaultValue: T,
): Promise<T> {
  if (!existsSync(ctx.stateFile)) return defaultValue;
  try {
    const content = await readFile(ctx.stateFile, "utf-8");
    return JSON.parse(content) as T;
  } catch {
    return defaultValue;
  }
}

/** Write the state.json file */
export async function writeStateFile<T>(
  ctx: StorageContext,
  state: T,
): Promise<void> {
  await mkdir(dirname(ctx.stateFile), { recursive: true });
  await writeFile(ctx.stateFile, JSON.stringify(state, null, 2), "utf-8");
}
