/**
 * Integrity check helpers for /memory/validate.
 *
 * checkJsonIntegrity: every line of records/*.jsonl and every scene_index/*.json.
 * checkSceneMeta: META-frontmatter presence on every scene block.
 * checkVecMetaCounts: vec-vs-meta count consistency (exported for P10 dashboard).
 *
 * Split from validate.ts to keep that file ≤150 lines.
 */

import fs from "node:fs";
import path from "node:path";
import { openReadonlySqlite, type ReadonlySqlite } from "../http-utils.js";
import type { MemoryValidateResponse } from "../types.js";

const META_START = "-----META-START-----";
const META_END = "-----META-END-----";

/** JSON integrity: every line of records/*.jsonl and every scene_index/*.json. */
export function checkJsonIntegrity(
  dataDir: string,
): MemoryValidateResponse["checks"]["json"] {
  const malformed: Array<{ file: string; line: number }> = [];
  let checkedFiles = 0;

  const recordsDir = path.join(dataDir, "records");
  try {
    for (const file of fs.readdirSync(recordsDir).sort()) {
      if (!file.endsWith(".jsonl")) continue;
      checkedFiles++;
      const lines = fs.readFileSync(path.join(recordsDir, file), "utf-8").split("\n");
      lines.forEach((line, i) => {
        if (!line.trim()) return;
        try {
          JSON.parse(line);
        } catch {
          malformed.push({ file: `records/${file}`, line: i + 1 });
        }
      });
    }
  } catch {
    // records/ not present yet.
  }

  const indexDir = path.join(dataDir, ".metadata", "scene_index");
  try {
    for (const file of fs.readdirSync(indexDir)) {
      if (!file.endsWith(".json")) continue;
      checkedFiles++;
      try {
        JSON.parse(fs.readFileSync(path.join(indexDir, file), "utf-8"));
      } catch {
        malformed.push({ file: `.metadata/scene_index/${file}`, line: 1 });
      }
    }
  } catch {
    // No scene index yet.
  }

  return { checkedFiles, malformed, valid: malformed.length === 0 };
}

/** META frontmatter presence on every scene block. */
export function checkSceneMeta(
  dataDir: string,
): MemoryValidateResponse["checks"]["meta"] {
  const missingMeta: string[] = [];
  let checked = 0;
  const sceneRoot = path.join(dataDir, "scene_blocks");
  try {
    const slugs = fs
      .readdirSync(sceneRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
    for (const slug of slugs) {
      let files: string[];
      try {
        files = fs.readdirSync(path.join(sceneRoot, slug));
      } catch {
        continue;
      }
      for (const file of files) {
        if (!file.endsWith(".md")) continue;
        checked++;
        try {
          const raw = fs.readFileSync(path.join(sceneRoot, slug, file), "utf-8");
          if (!raw.includes(META_START) || !raw.includes(META_END)) {
            missingMeta.push(`scene_blocks/${slug}/${file}`);
          }
        } catch {
          missingMeta.push(`scene_blocks/${slug}/${file}`);
        }
      }
    }
  } catch {
    // No scene blocks yet.
  }
  return { checked, missingMeta, valid: missingMeta.length === 0 };
}

/**
 * Count logical rows of the l1_vec vec0 table. The `l1_vec_rowids` SHADOW
 * table holds one row per logical vector and is queryable without the
 * extension on both runtimes. Falls back to the virtual table when the
 * shadow layout is absent.
 */
function countVecRows(db: ReadonlySqlite): number | null {
  try {
    return (db.prepare("SELECT COUNT(*) AS c FROM l1_vec_rowids").get() as { c: number } | null)?.c ?? 0;
  } catch {
    try {
      return (db.prepare("SELECT COUNT(*) AS c FROM l1_vec").get() as { c: number } | null)?.c ?? 0;
    } catch {
      return null;
    }
  }
}

/** vec-vs-meta count consistency. Exported for the P10 dashboard. */
export function checkVecMetaCounts(
  dataDir: string,
): MemoryValidateResponse["checks"]["vecMeta"] {
  const dbPath = path.join(dataDir, "vectors.db");
  try {
    const db = openReadonlySqlite(dbPath);
    try {
      const metaRow = db.prepare("SELECT COUNT(*) AS c FROM l1_records").get() as { c: number } | null;
      const metaCount = metaRow?.c ?? 0;
      const vecCount = countVecRows(db);
      if (vecCount === null) {
        return { metaCount, vecCount: null, consistent: null, note: "l1_vec unavailable (no vec0 table yet)" };
      }
      return { metaCount, vecCount, consistent: vecCount === metaCount };
    } finally {
      db.close();
    }
  } catch (err) {
    return {
      metaCount: null,
      vecCount: null,
      consistent: null,
      note: `vectors.db unavailable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
