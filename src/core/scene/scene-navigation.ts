/**
 * Scene navigation: generates a summary navigation section appended to persona.md.
 *
 * The navigation includes **absolute** file paths so the agent can directly
 * use read_file for on-demand scene loading (progressive disclosure).
 */

import path from "node:path";
import type { SceneIndexEntry } from "./scene-index.js";

const NAV_HEADER = "---\n## 🗺️ Scene Navigation (Scene Index)";
export const DEFAULT_SCENE_NAV_TOP_N = 5;
export const DEFAULT_SCENE_NAV_MAX_CHARS = 2000;

const NAV_FOOTER = `📌 使用说明：
- Path 是 scene block 的绝对路径，可直接使用 read_file 读取完整内容
- 热度：该场景被记忆命中的累计次数，越高越重要
- Summary：场景的核心要点摘要`;

const NAV_OMITTED_NOTICE = "Additional scenes omitted to keep the system prompt cache-friendly.";

export interface SceneNavigationOptions {
  topN?: number;
  maxChars?: number;
  now?: Date;
}

export function getSceneNavigationHeatBucket(heat: number): number {
  if (!Number.isFinite(heat) || heat <= 0) return 0;
  return Math.floor(heat / 10) + 1;
}

export function getSceneNavigationRecencyBucket(updated: string, now: Date): number {
  if (!updated) return 0;
  const updatedAt = new Date(updated);
  if (Number.isNaN(updatedAt.getTime())) return 0;

  const ageMs = now.getTime() - updatedAt.getTime();
  if (ageMs < 0) return 3;

  const hourMs = 60 * 60 * 1000;
  const dayMs = 24 * hourMs;
  if (ageMs <= 12 * hourMs) return 3;
  if (ageMs <= dayMs) return 2;
  if (ageMs <= 7 * dayMs) return 1;
  return 0;
}

export function scoreSceneForNavigation(entry: SceneIndexEntry, now: Date): number {
  const heatBucket = getSceneNavigationHeatBucket(entry.heat);
  const recencyBucket = getSceneNavigationRecencyBucket(entry.updated, now);
  const summaryBucket = entry.summary.trim().length > 0 ? 1 : 0;
  return heatBucket * 10 + recencyBucket * 2 + summaryBucket;
}

export function selectTopScenesForNavigation(
  entries: SceneIndexEntry[],
  options?: SceneNavigationOptions,
): SceneIndexEntry[] {
  const topN = normalizePositiveInteger(options?.topN, DEFAULT_SCENE_NAV_TOP_N);
  const now = options?.now ?? new Date();

  return [...entries]
    .sort((a, b) => {
      const scoreDiff = scoreSceneForNavigation(b, now) - scoreSceneForNavigation(a, now);
      if (scoreDiff !== 0) return scoreDiff;
      return a.filename.localeCompare(b.filename);
    })
    .slice(0, topN);
}

/**
 * Generate the scene navigation Markdown section.
 *
 * @param entries - Scene index entries
 * @param dataDir - Absolute path to the plugin data directory; when provided,
 *                  scene paths are rendered as absolute paths so the agent can
 *                  call read_file directly without path concatenation.
 */
export function generateSceneNavigation(
  entries: SceneIndexEntry[],
  dataDir?: string,
  options?: SceneNavigationOptions,
): string {
  if (entries.length === 0) return "";

  const topScenes = selectTopScenesForNavigation(entries, options);
  const topN = normalizePositiveInteger(options?.topN, DEFAULT_SCENE_NAV_TOP_N);
  const maxChars = normalizePositiveInteger(options?.maxChars, DEFAULT_SCENE_NAV_MAX_CHARS);

  const blocks = topScenes.map((e) => {
    const scenePath = dataDir
      ? path.join(dataDir, "scene_blocks", e.filename)
      : `scene_blocks/${e.filename}`;
    const pathLine = `### Path: ${scenePath}`;
    const heatLine = `**热度**: ${e.heat} | **热度档位**: ${getSceneNavigationHeatBucket(e.heat)}`;
    const summaryLine = `Summary: ${e.summary}`;
    return `${pathLine}\n${heatLine}\n${summaryLine}`;
  });

  const intro = [
    `Showing top ${Math.min(topN, entries.length)} scenes out of ${entries.length}.`,
    "Only high-value scenes are listed here to keep the system prompt cache-friendly.",
    "More scenes remain available in the existing scene index and scene block files.",
    "Use memory/search/read tools when the listed scenes are insufficient.",
  ].join("\n");

  return buildNavigationWithinBudget(intro, blocks, maxChars, topScenes.length < entries.length);
}

/**
 * Strip the scene navigation section from persona content.
 */
export function stripSceneNavigation(personaContent: string): string {
  const idx = personaContent.indexOf(NAV_HEADER);
  if (idx === -1) return personaContent;
  return personaContent.slice(0, idx).trimEnd();
}

function buildNavigationWithinBudget(
  intro: string,
  blocks: string[],
  maxChars: number,
  hasUnlistedScenes: boolean,
): string {
  const selectedBlocks: string[] = [];
  let omitted = hasUnlistedScenes;

  for (const block of blocks) {
    const candidateBlocks = [...selectedBlocks, block];
    const candidate = renderNavigation(intro, candidateBlocks, omitted);
    if (candidate.length <= maxChars) {
      selectedBlocks.push(block);
      continue;
    }
    omitted = true;
    break;
  }

  let output = renderNavigation(intro, selectedBlocks, omitted || selectedBlocks.length < blocks.length);
  if (output.length <= maxChars) return output;

  while (selectedBlocks.length > 0 && output.length > maxChars) {
    selectedBlocks.pop();
    output = renderNavigation(intro, selectedBlocks, true);
  }

  if (output.length <= maxChars) return output;
  return renderNavigation(intro, [], false);
}

function renderNavigation(intro: string, blocks: string[], omitted: boolean): string {
  const body = blocks.length > 0 ? `\n\n${blocks.join("\n\n")}` : "";
  const omittedText = omitted ? `\n\n${NAV_OMITTED_NOTICE}` : "";
  return `${NAV_HEADER}\n${intro}${body}${omittedText}\n\n${NAV_FOOTER}`;
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  if (value == null || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.floor(value);
}
