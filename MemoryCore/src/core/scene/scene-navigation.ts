/**
 * Scene navigation: generates a summary navigation section appended to persona.md.
 *
 * The navigation includes **absolute** file paths so the agent can directly
 * use read_file for on-demand scene loading (progressive disclosure).
 */

import path from "node:path";
import type { SceneIndexEntry } from "./scene-index.js";

const NAV_HEADER = "---\n## 🗺️ Scene Navigation (Scene Index)";

const NAV_FOOTER_LOCAL = `📌 使用说明：
- Path 是 scene block 的绝对路径，可直接使用 **read** 工具读取完整内容（参数: filePath）
- 热度：该场景被记忆命中的累计次数，越高越重要
- Summary：场景的核心要点摘要`;

/**
 * Footer for backends addressed by storage key rather than filesystem path.
 * The reading tool is a property of the mounted surface, not of the backend,
 * so it is supplied by whoever assembles the two.
 */
export function storageNavFooter(readTool: string): string {
  return `📌 使用说明：
- Path 是 scene block 的存储路径，请使用 **${readTool}** 工具读取完整内容（参数: path）
- 热度：该场景被记忆命中的累计次数，越高越重要
- Summary：场景的核心要点摘要`;
}

export interface SceneNavigationRenderOptions {
  /**
   * Resolves an entry to the path the reader must pass back. Callers hand in
   * the same resolver they serve reads from, so a rendered path is by
   * construction a path that can be read (design doc D12).
   */
  pathFor: (entry: SceneIndexEntry) => string;
  /** Tool the model should call, named in the intro line. */
  readTool: string;
  footer: string;
}

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
 * Generate the scene navigation Markdown section.
 *
 * @param entries - Scene index entries
 * @param dataDir - Absolute path to the plugin data directory; when provided
 *                  and useCos=false, paths are absolute for read_file.
 * @param useCos  - When true, paths use scenes/ prefix and footer says tdai_read_file.
 *
 * ⚠️ KNOWN BROKEN — the `useCos=true` branch emits unreadable paths. Do not
 * build on it, and do not "fix" it by renaming scenes/ -> scene_blocks/ alone.
 *
 * It is wrong on two levels: the directory name is a leftover from the deleted
 * CosPathResolver design (real layout is scene_blocks/), and the emitted key
 * also omits the profiles/{scope}/ segment, because navigation is generated
 * against a scoped storage view while the read tool holds an unscoped root.
 *
 * Left unfixed deliberately: no live read path reaches it. The Proxy reads L2
 * through /v3/scenario/ls + /v3/scenario/read, and the OpenClaw plugin builds
 * TdaiCore without a storage adapter, so useCos is always false there. The one
 * caller that can set useCos=true is the legacy POST /recall endpoint, which
 * currently has no consumer.
 *
 * Reviving POST /recall on the main path REQUIRES fixing this first. The real
 * fix is to make navigation and the read tool share one scoped resolver, which
 * is tracked as P10.
 *
 * See docs/design/mongodb/design/2026-08-27-core-storage-abstraction-design.md
 * (D13, §10.C3.1, known issue L6).
 */
export function generateSceneNavigation(entries: SceneIndexEntry[], dataDir?: string, useCos = false): string {
  return renderSceneNavigation(entries, {
    pathFor: (e) =>
      useCos
        ? `scenes/${e.filename}`
        : dataDir
          ? path.join(dataDir, "scene_blocks", e.filename)
          : `scene_blocks/${e.filename}`,
    readTool: useCos ? "tdai_read_file" : "read",
    footer: useCos ? storageNavFooter("tdai_read_file") : NAV_FOOTER_LOCAL,
  });
}

/**
 * Render the navigation section from entries and a caller-supplied resolver.
 *
 * Taking `pathFor` instead of a mode flag is the point: a backend renders the
 * paths it actually serves, so navigation and reads cannot drift apart the way
 * the `useCos` branch above did.
 */
export function renderSceneNavigation(
  entries: SceneIndexEntry[],
  opts: SceneNavigationRenderOptions,
): string {
  if (entries.length === 0) return "";

  const sorted = [...entries].sort((a, b) => b.heat - a.heat);

  const blocks = sorted.map((e) => {
    const pathLine = `### Path: ${opts.pathFor(e)}`;
    const heatLine = `**热度**: ${e.heat}${heatEmoji(e.heat)}${e.updated ? ` | **更新**: ${e.updated}` : ""}`;
    const summaryLine = `Summary: ${e.summary}`;
    return `${pathLine}\n${heatLine}\n${summaryLine}`;
  });

  return `${NAV_HEADER}\n*以下是当前场景记忆的索引，可根据需要 ${opts.readTool} 读取详细内容。*\n\n${blocks.join("\n\n")}\n\n${opts.footer}`;
}

/**
 * Strip the scene navigation section from persona content.
 */
export function stripSceneNavigation(personaContent: string): string {
  const idx = personaContent.indexOf(NAV_HEADER);
  if (idx === -1) return personaContent;
  return personaContent.slice(0, idx).trimEnd();
}
