/** Resolved content access, never evidence of adoption or task success. */
export interface ResolvedSkillAccess {
  skillId: string;
  skillVersion: number;
}

/** Read only the Core response; request versions may have been overridden by a pin. */
export function extractResolvedSkillAccess(
  endpoint: string,
  status: number,
  responseText: string,
): ResolvedSkillAccess | undefined {
  if ((endpoint !== "get" && endpoint !== "get-by-name") || status < 200 || status >= 300) return;
  try {
    const env = JSON.parse(responseText);
    if (!env || env.code !== 0) return;
    const data = env.data;
    if (!data || typeof data.skill_id !== "string" || !data.skill_id.trim()) return;
    if (!Number.isSafeInteger(data.version) || data.version <= 0) return;
    // Metadata-only reads do not establish that the Skill body was opened.
    if (typeof data.content !== "string") return;
    return { skillId: data.skill_id, skillVersion: data.version };
  } catch {
    // Malformed upstream responses must still pass through the bridge unchanged.
    return;
  }
}
