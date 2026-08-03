/**
 * GET /memory/blocks — scene/persona block stats + content fetch.
 *
 * `?path=<rel>` reads the CONTENT of one addressable block. Without the
 * `path` param, returns a stats list (size, char count, per-kind limit).
 *
 * collectBlockStats is reused by the P10 dashboard (memory_health.md).
 *
 * Split from memory-routes.ts to keep that file ≤150 lines.
 */

import fs from "node:fs";
import path from "node:path";
import type http from "node:http";
import { sendJson, sendError } from "../http-utils.js";
import { isAddressableBlockPath } from "../block-paths.js";
import type {
  MemoryBlocksResponse,
  MemoryBlockInfo,
} from "../types.js";
import type { MemoryRoutesContext } from "./context.js";

const SCENE_LIMIT_CHARS = 1500;
const PERSONA_LIMIT_CHARS = 2000;

/** Collect scene block + persona stats. Char count is the relevant measure —
 * the memory-keeper role caps are char-based (scene 1500, persona 2000). */
export function collectBlockStats(
  dataDir: string,
): { blocks: MemoryBlockInfo[]; overLimit: MemoryBlockInfo[] } {
  const blocks: MemoryBlockInfo[] = [];
  const sceneRoot = path.join(dataDir, "scene_blocks");
  try {
    const slugs = fs
      .readdirSync(sceneRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
    for (const slug of slugs) {
      let files: string[];
      try {
        files = fs.readdirSync(path.join(sceneRoot, slug));
      } catch {
        continue;
      }
      for (const file of files.sort()) {
        if (!file.endsWith(".md")) continue;
        const fullPath = path.join(sceneRoot, slug, file);
        try {
          const raw = fs.readFileSync(fullPath, "utf-8");
          blocks.push({
            path: `scene_blocks/${slug}/${file}`,
            kind: "scene",
            filename: file,
            project: slug,
            size: raw.length,
            limit: SCENE_LIMIT_CHARS,
            over: raw.length > SCENE_LIMIT_CHARS,
          });
        } catch {
          // File raced away between readdir and readFile — skip.
        }
      }
    }
  } catch {
    // scene_blocks/ not present yet.
  }

  const personaPath = path.join(dataDir, "persona.md");
  try {
    const raw = fs.readFileSync(personaPath, "utf-8");
    blocks.push({
      path: "persona.md",
      kind: "persona",
      filename: "persona.md",
      size: raw.length,
      limit: PERSONA_LIMIT_CHARS,
      over: raw.length > PERSONA_LIMIT_CHARS,
    });
  } catch {
    // No persona yet.
  }

  return { blocks, overLimit: blocks.filter((b) => b.over) };
}

export async function handleMemoryBlocks(
  ctx: MemoryRoutesContext,
  url: URL,
  res: http.ServerResponse,
): Promise<void> {
  const dataDir = ctx.config.data.baseDir;

  // `?path=<rel>` — read the CONTENT of one addressable block.
  const rel = url.searchParams.get("path");
  if (rel !== null) {
    if (!isAddressableBlockPath(rel)) {
      sendError(res, 400, `Not an addressable memory block: ${rel}`);
      return;
    }
    try {
      const resolved = path.resolve(dataDir, rel);
      const rootReal = await fs.promises.realpath(dataDir);
      let targetReal: string;
      try {
        targetReal = await fs.promises.realpath(resolved);
      } catch {
        sendError(res, 404, `Block not found: ${rel}`);
        return;
      }
      const rootPrefix = rootReal.endsWith(path.sep) ? rootReal : rootReal + path.sep;
      if (targetReal !== rootReal && !targetReal.startsWith(rootPrefix)) {
        sendError(res, 400, `Block escapes data root: ${rel}`);
        return;
      }
      if (!isAddressableBlockPath(path.relative(rootReal, targetReal))) {
        sendError(res, 400, `Block escapes allowlist: ${rel}`);
        return;
      }
      const stat = await fs.promises.stat(targetReal);
      if (!stat.isFile()) {
        sendError(res, 400, `Not a file: ${rel}`);
        return;
      }
      const content = await fs.promises.readFile(targetReal, "utf-8");
      const kind = rel === "persona.md" ? "persona" : "scene";
      sendJson(res, 200, { path: rel, kind, content });
    } catch (err) {
      sendError(res, 500, `Failed to read block: ${err instanceof Error ? err.message : String(err)}`);
    }
    return;
  }

  const { blocks } = collectBlockStats(dataDir);
  const response: MemoryBlocksResponse = {
    limits: { scene: SCENE_LIMIT_CHARS, persona: PERSONA_LIMIT_CHARS },
    blocks,
  };
  sendJson(res, 200, response);
}
