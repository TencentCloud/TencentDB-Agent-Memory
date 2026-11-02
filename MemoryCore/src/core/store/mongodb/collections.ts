/**
 * MongoDB collection naming for the phase-1 memory/skill backend.
 *
 * Each instance gets its own database (`MongoConfig.database`, delivered
 * verbatim — never derived). Collections inside are **bare-named**: unlike
 * TCVDB (which prefixes `{db}_` because its collections share a flat namespace),
 * Mongo collections are naturally database-scoped, so `db1.l0_conversations`
 * and `db2.l0_conversations` coexist without collision.
 */

/** Collection name constants (bare, no `{db}_` prefix — D4). */
export const COLLECTIONS = {
  L0: "l0_conversations",
  L1: "l1_memories",
  PROFILES: "profiles",
  AUDIT: "memory_audit",
  KNOWLEDGE: "knowledge",
  MEMORY_PROMPTS: "memory_prompts",
  MEMORY_PROMPT_SETTINGS: "memory_prompt_settings",
  MEMORY_PROMPT_SETTING_LOGS: "memory_prompt_setting_logs",
  MEMORY_GENERATION_REFS: "memory_generation_refs",
  SKILLS: "skills",
} as const;

export type CollectionName = (typeof COLLECTIONS)[keyof typeof COLLECTIONS];

/**
 * Validate / sanitize a MongoDB database name.
 *
 * The name is delivered by config (`MongoConfig.database`) and used verbatim,
 * but we defensively strip characters MongoDB forbids in db names
 * (`/\. "$*<>:|?` and NUL) and enforce the 63-byte limit. Throws when the
 * result is empty so a misconfiguration fails loudly rather than writing to a
 * surprising database.
 */
export function sanitizeDbName(database: string): string {
  const cleaned = (database ?? "")
    .trim()
    // eslint-disable-next-line no-control-regex
    .replace(/[/\\. "$*<>:|?\u0000]/g, "_")
    .slice(0, 63);
  if (!cleaned) {
    throw new Error(`[mongo] invalid database name: "${database}" (empty after sanitization)`);
  }
  return cleaned;
}
