/**
 * The dashboard's view of the L0 cursor and its counter (tz-03a, ТЗ A2e :78).
 *
 * A2e requires `l0Count` to have a NAMED consumer or be deleted. Until now the
 * dashboard printed neither the cursor nor the counter, so the field was read
 * by nobody at all. Both are printed here, and next to them the live count
 * computed at dashboard time: a consumer that only echoes the stored number
 * cannot show a drift, and drift is the single thing worth watching about a
 * value that used to be accumulated.
 *
 * Fail-open like the rest of the dashboard: a missing checkpoint or an
 * unreadable store yields "n/a", never a throw.
 */
import fs from "node:fs";
import path from "node:path";
import { countL0UpTo, countNewL0Since } from "./diff-builder.js";
import { CONSOLIDATION_CHECKPOINT_FILENAME } from "./checkpoint.js";
import { sceneBlocksRoot } from "../../core/scene/scene-paths.js";
import { openReadonlySqlite } from "../http-utils.js";

/**
 * The named consumer of `l1Count`/`sceneCount` (tz-03b, the same A2e rule).
 * Stored value against a live recount, so a drift is visible without a test.
 *
 * The live L1 recount reads the sqlite file directly and degrades to "n/a"
 * elsewhere — this is a local dashboard, not the counting path. The counter
 * ITSELF goes through `store.countL1()` (layer-counters.ts), which is what
 * keeps `backend-parity`.
 */
export function layerCountersSection(dataDir: string): string[] {
  const lines = ["## Layer counters", ""];
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(
      fs.readFileSync(
        path.join(dataDir, ".metadata", CONSOLIDATION_CHECKPOINT_FILENAME),
        "utf-8",
      ),
    ) as Record<string, unknown>;
  } catch {
    lines.push("n/a (no consolidation checkpoint yet)", "");
    return lines;
  }

  lines.push(
    counterLine("l1Count", parsed.l1Count, liveL1(dataDir)),
    counterLine("sceneCount", parsed.sceneCount, liveScenes(dataDir)),
    "",
  );
  return lines;
}

function counterLine(
  name: string,
  storedRaw: unknown,
  live: number | null,
): string {
  if (typeof storedRaw !== "number") {
    return `- ${name}: not recorded yet (the next mutation fills it in)`;
  }
  if (live === null) return `- ${name}: ${storedRaw} (live count n/a)`;
  return (
    `- ${name}: ${storedRaw}` +
    (live === storedRaw
      ? " (matches the carrier)"
      : ` — **live count is ${live}**, the stored value drifted`)
  );
}

function liveL1(dataDir: string): number | null {
  try {
    const db = openReadonlySqlite(path.join(dataDir, "vectors.db"));
    try {
      const row = db.prepare("SELECT COUNT(*) AS c FROM l1_records").get() as
        { c: number } | undefined;
      return row?.c ?? null;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

function liveScenes(dataDir: string): number | null {
  const root = sceneBlocksRoot(dataDir);
  try {
    let total = 0;
    for (const e of fs.readdirSync(root, { withFileTypes: true })) {
      if (e.isFile() && e.name.endsWith(".md")) total += 1;
      else if (e.isDirectory()) {
        total += fs
          .readdirSync(path.join(root, e.name))
          .filter((b) => b.endsWith(".md")).length;
      }
    }
    return total;
  } catch {
    return null;
  }
}

export function l0CursorSection(dataDir: string): string[] {
  const lines = ["## L0 cursor", ""];
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(
      fs.readFileSync(
        path.join(dataDir, ".metadata", CONSOLIDATION_CHECKPOINT_FILENAME),
        "utf-8",
      ),
    ) as Record<string, unknown>;
  } catch {
    lines.push("n/a (no consolidation checkpoint yet)", "");
    return lines;
  }

  const cursor = {
    recordedAt: typeof parsed.l0Cursor === "string" ? parsed.l0Cursor : "",
    recordId: typeof parsed.l0CursorId === "string" ? parsed.l0CursorId : "",
  };
  const stored = typeof parsed.l0Count === "number" ? parsed.l0Count : 0;
  const dbPath = path.join(dataDir, "vectors.db");
  const live = countL0UpTo(dbPath, cursor);
  const fresh = countNewL0Since(dbPath, cursor);

  lines.push(
    `- l0Cursor: ${cursor.recordedAt || "(none)"} / ${cursor.recordId || "(no id)"}`,
    `- l0Count: ${stored}` +
      (live === null
        ? " (live count n/a — store unreadable)"
        : live === stored
          ? " (matches the store)"
          : ` — **live count is ${live}**, the stored value drifted`),
    `- new since the cursor: ${fresh === null ? "n/a" : fresh}`,
    "",
  );
  return lines;
}
