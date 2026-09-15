/**
 * Scene navigation: generates a summary navigation section appended to persona.md.
 *
 * The navigation includes **absolute** file paths so the agent can directly
 * use read_file for on-demand scene loading (progressive disclosure).
 */

import path from "node:path";
import type { SceneIndexEntry } from "./scene-index.js";

const NAV_HEADER = "---\n## 🗺️ Scene Navigation (Scene Index)";

const NAV_FOOTER = `📌 使用说明：
- Path 是 scene block 的绝对路径，可直接使用 read_file 读取完整内容
- 热度：该场景被记忆命中的累计次数，越高越重要
- Summary：场景的核心要点摘要`;

const NAV_FOOTER_STABLE = `📌 使用说明：
- Path 是 scene block 的绝对路径，可直接使用 read_file 读取完整内容
- 热度分档（核心 > 高 > 中 > 低 > 一般）表示该场景被记忆命中的相对频次，越高越重要
- Summary：场景的核心要点摘要`;

/**
 * Build a fire-emoji string based on heat value (visual priority cue for the agent).
 */
function heatEmoji(heat: number): string {
  if (heat >= 1000) return " 🔥🔥🔥🔥🔥";
  if (heat >= 500) return " 🔥🔥🔥🔥";
  if (heat >= 200) return " 🔥🔥🔥";
  if (heat >= 100) return " 🔥🔥";
  if (heat >= 50) return " 🔥";
  return "";
}

/**
 * Heat tiers used by the cache-stable renderer.
 *
 * Rendering the raw counter means *every* scene hit rewrites the navigation
 * block, and since the block lives in `appendSystemContext` (i.e. the tail of
 * the system prompt), that rewrite invalidates the whole prefix cache for
 * OpenAI-compatible providers.  Bucketing collapses the common case — a heat
 * bump from 137 to 138 — into a no-op.
 *
 * Boundaries mirror `heatEmoji` so the visual priority signal is preserved.
 */
const HEAT_TIERS: ReadonlyArray<{ min: number; label: string; emoji: string }> = [
  { min: 1000, label: "核心", emoji: " 🔥🔥🔥🔥🔥" },
  { min: 500, label: "高", emoji: " 🔥🔥🔥🔥" },
  { min: 200, label: "中高", emoji: " 🔥🔥🔥" },
  { min: 100, label: "中", emoji: " 🔥🔥" },
  { min: 50, label: "低", emoji: " 🔥" },
  { min: 0, label: "一般", emoji: "" },
];

/** Map a raw heat counter to its tier index (0 = hottest). */
export function heatTierIndex(heat: number): number {
  for (let i = 0; i < HEAT_TIERS.length; i++) {
    if (heat >= HEAT_TIERS[i].min) return i;
  }
  return HEAT_TIERS.length - 1;
}

export interface SceneNavigationOptions {
  /**
   * Render heat as a coarse tier and sort deterministically, and omit the
   * `updated` timestamp, so routine scene activity does not mutate the block.
   * Default: false (legacy byte-for-byte behaviour).
   */
  stable?: boolean;
}

/**
 * Generate the scene navigation Markdown section.
 *
 * @param entries - Scene index entries
 * @param dataDir - Absolute path to the plugin data directory; when provided,
 *                  scene paths are rendered as absolute paths so the agent can
 *                  call read_file directly without path concatenation.
 * @param opts    - Rendering options; `stable: true` produces cache-friendly output.
 */
export function generateSceneNavigation(
  entries: SceneIndexEntry[],
  dataDir?: string,
  opts?: SceneNavigationOptions,
): string {
  if (entries.length === 0) return "";

  const stable = opts?.stable === true;

  // Legacy: strict heat ordering (unstable — any counter bump can reorder).
  // Stable: order by tier, then by filename so ties are resolved deterministically
  // and an intra-tier heat change produces byte-identical output.
  const sorted = stable
    ? [...entries].sort((a, b) => {
        const ta = heatTierIndex(a.heat);
        const tb = heatTierIndex(b.heat);
        if (ta !== tb) return ta - tb;
        return a.filename.localeCompare(b.filename);
      })
    : [...entries].sort((a, b) => b.heat - a.heat);

  const blocks = sorted.map((e) => {
    const scenePath = dataDir
      ? path.join(dataDir, "scene_blocks", e.filename)
      : `scene_blocks/${e.filename}`;
    const pathLine = `### Path: ${scenePath}`;
    const tier = HEAT_TIERS[heatTierIndex(e.heat)];
    const heatLine = stable
      ? `**热度**: ${tier.label}${tier.emoji}`
      : `**热度**: ${e.heat}${heatEmoji(e.heat)}${e.updated ? ` | **更新**: ${e.updated}` : ""}`;
    const summaryLine = `Summary: ${e.summary}`;
    return `${pathLine}\n${heatLine}\n${summaryLine}`;
  });

  const footer = stable ? NAV_FOOTER_STABLE : NAV_FOOTER;
  return `${NAV_HEADER}\n*以下是当前场景记忆的索引，可根据需要 read_file 读取详细内容。*\n\n${blocks.join("\n\n")}\n\n${footer}`;
}

/**
 * Strip the scene navigation section from persona content.
 */
export function stripSceneNavigation(personaContent: string): string {
  const idx = personaContent.indexOf(NAV_HEADER);
  if (idx === -1) return personaContent;
  return personaContent.slice(0, idx).trimEnd();
}
