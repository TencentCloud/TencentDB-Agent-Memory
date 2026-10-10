/**
 * Recall results → the `additionalContext` block Claude Code injects before a turn.
 *
 * Layout follows the OpenClaw client adapter: stable material (persona, scene
 * navigation, tool guide) is sent once per session; the per-prompt L1 hits are
 * sent on every prompt.
 */

export interface L1Item {
  id: string;
  content: string;
  type: string;
  score?: number;
}

export interface SceneEntry {
  path: string;
  summary?: string;
  updated_at?: string;
}

export const MEMORY_TOOLS_GUIDE = `<memory-tools-guide>
When the injected memory does not answer the question, use the memory tools before searching the filesystem:
- tdai_memory_search: structured memories (L1) — preferences, past events, decisions, rules.
- tdai_conversation_search: raw conversation messages (L0) — exact wording, timelines, tool traffic.
- tdai_scenario_read: a scene block from Scene Navigation, by its path.
- tdai_wiki_search / tdai_wiki_read: the team wiki, when a Knowledge Service is configured.
Keep it to three memory searches per turn; if nothing turns up, answer from what you have.
</memory-tools-guide>`;

export function formatL1Memories(items: L1Item[]): string | undefined {
  if (items.length === 0) return undefined;
  const lines = ["<relevant-memories>"];
  for (const item of items) {
    const tag = item.type ? `[${item.type}]` : "";
    lines.push(`- ${tag} ${item.content}`.trim());
  }
  lines.push("</relevant-memories>");
  return lines.join("\n");
}

export function formatSessionContext(persona: string | null, scenes: SceneEntry[], includeGuide = true): string | undefined {
  const parts: string[] = [];
  if (persona && persona.trim()) {
    parts.push("<user-persona>", persona.trim(), "</user-persona>");
  }
  if (scenes.length > 0 && !(persona && persona.includes("Scene Navigation"))) {
    parts.push("<scene-navigation>");
    parts.push("Scene memory index. Read a block with tdai_scenario_read and its path.");
    for (const scene of scenes) {
      parts.push(scene.summary ? `- ${scene.path} — ${scene.summary}` : `- ${scene.path}`);
    }
    parts.push("</scene-navigation>");
  }
  if (includeGuide) parts.push(MEMORY_TOOLS_GUIDE);
  const text = parts.join("\n").trim();
  return text || undefined;
}

export function formatRecallContext(input: {
  l1Items: L1Item[];
  persona: string | null;
  scenes: SceneEntry[];
  includeSessionContext: boolean;
}): string | undefined {
  const blocks = [
    input.includeSessionContext ? formatSessionContext(input.persona, input.scenes) : undefined,
    formatL1Memories(input.l1Items),
  ].filter((block): block is string => Boolean(block));
  return blocks.length > 0 ? blocks.join("\n\n") : undefined;
}
