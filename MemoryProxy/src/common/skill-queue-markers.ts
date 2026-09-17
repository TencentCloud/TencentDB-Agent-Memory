export const SKILL_QUEUE_START = "<!-- tdai:skill-queue:start -->";
export const SKILL_QUEUE_END = "<!-- tdai:skill-queue:end -->";

const SKILL_QUEUE_BLOCK = new RegExp(
  `<tdai_injections>\\s*${SKILL_QUEUE_START}[\\s\\S]*?${SKILL_QUEUE_END}\\s*</tdai_injections>\\n?`
    + `|${SKILL_QUEUE_START}[\\s\\S]*?${SKILL_QUEUE_END}\\n?`,
  "g",
);
const MARKED_SKILL_QUEUE_BLOCK = new RegExp(
  `${SKILL_QUEUE_START}[\\s\\S]*?${SKILL_QUEUE_END}`,
);

export function hasSkillQueueMarkers(text: string): boolean {
  return text.includes(SKILL_QUEUE_START) && text.includes(SKILL_QUEUE_END);
}

export function extractMarkedSkillQueueBlock(text: string): string | null {
  return text.match(MARKED_SKILL_QUEUE_BLOCK)?.[0] ?? null;
}

/** Remove Proxy-owned Skill blocks before building a semantic user query. */
export function stripSkillQueueBlocks(text: string): string {
  return text.replace(SKILL_QUEUE_BLOCK, "").trim();
}
