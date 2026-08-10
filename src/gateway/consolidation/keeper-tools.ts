/**
 * Keeper-tools resolution + copy. The static fetch_dups.py / fetch_blocks.py
 * / fetch_records.py / dump_bullets.py ship with the repo and are copied into
 * `<runScratch>/tools/` so the sub-session works in its sandbox.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { OrchestratorContext } from "./context.js";

/**
 * Resolve the keeper-tools dir. The gateway always runs from the source
 * tree (`bun src/gateway/server.ts` / `npx tsx src/gateway/server.ts`) —
 * dist/ never bundles the orchestrator. Env override wins when set.
 */
export function resolveKeeperToolsDir(): string | null {
  const envOverride = process.env.TDAI_KEEPER_TOOLS_DIR;
  if (envOverride) {
    return fs.existsSync(path.join(envOverride, "fetch_dups.py"))
      ? envOverride
      : null;
  }
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const candidates = [
      path.join(here, "keeper-tools"),
      path.join(here, "..", "consolidation", "keeper-tools"),
    ];
    for (const cand of candidates) {
      if (fs.existsSync(path.join(cand, "fetch_dups.py"))) return cand;
    }
  } catch {
    // fall through
  }
  return null;
}

/**
 * Copy the role's tools into `<runScratch>/tools/`. Only the files named by
 * the contract's `tools_subset` are copied — the whole catalogue used to be
 * cp'd regardless of the contract (tz-01 criterion 3). An empty subset means
 * the role asked for no tools; nothing is copied and that is logged.
 *
 * FAIL-OPEN on infrastructure errors (missing source dir, fs failure): warn +
 * continue, never aborts the run.
 */
export async function copyKeeperTools(
  ctx: OrchestratorContext,
  runScratch: string,
  toolsSubset: ReadonlySet<string> | null,
): Promise<string | null> {
  const src = resolveKeeperToolsDir();
  if (!src) {
    ctx.logger.warn?.(
      "[memory-keeper] keeper-tools dir not found — sub-session will generate its own scripts",
    );
    return null;
  }
  const dst = path.join(runScratch, "tools");
  if (toolsSubset === null) {
    // Legacy role with no declared tools: keep the old whole-catalogue copy
    // (the contract resolver already warned about the missing declaration).
    try {
      await fs.promises.cp(src, dst, { recursive: true });
      return dst;
    } catch (err) {
      ctx.logger.warn?.(
        `[memory-keeper] copy keeper-tools failed (${err instanceof Error ? err.message : String(err)}) — continuing without tools`,
      );
      return null;
    }
  }
  if (toolsSubset.size === 0) {
    ctx.logger.info?.(
      "[memory-keeper] role contract declares an empty tools_subset — no tools copied",
    );
    return null;
  }
  try {
    await fs.promises.mkdir(dst, { recursive: true });
    for (const tool of toolsSubset) {
      const from = path.join(src, tool);
      if (!fs.existsSync(from)) {
        ctx.logger.warn?.(
          `[memory-keeper] tools_subset lists "${tool}", which is not in ${src} — skipped`,
        );
        continue;
      }
      await fs.promises.cp(from, path.join(dst, tool), { recursive: true });
    }
    return dst;
  } catch (err) {
    ctx.logger.warn?.(
      `[memory-keeper] copy keeper-tools failed (${err instanceof Error ? err.message : String(err)}) — continuing without tools`,
    );
    return null;
  }
}
