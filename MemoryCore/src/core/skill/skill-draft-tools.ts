import { tool } from "ai";
import { z } from "zod";
import type { SkillDraftSession } from "./skill-draft-session.js";

const draftId = z.string().min(1).max(128);
const revision = z.number().int().nonnegative();
const pageFields = { offset: z.number().int().nonnegative().optional(), length: z.number().int().min(4).max(16_384).optional() };
const body = z.string().min(1).max(4_000_000);

/** Every execute validates itself, including when a custom runner bypasses SDK parsing. */
export function createSkillDraftTools(session: SkillDraftSession): Record<string, unknown> {
  function checked<S extends z.ZodType>(description: string, schema: S, execute: (input: z.output<S>) => unknown | Promise<unknown>) {
    return tool({ description, inputSchema: schema, execute: async input => {
      try {
        const parsed = schema.safeParse(input);
        if (!parsed.success) return JSON.stringify({ error: "DRAFT_INVALID_TOOL_INPUT", message: "Invalid arguments. Use draft_id/expected_revision for writes and the declared bounded page fields.", issues: parsed.error.issues.slice(0, 5).map(issue => ({ path: issue.path, message: issue.message })) });
        return JSON.stringify(await execute(parsed.data));
      } catch (error) {
        return JSON.stringify({ error: typeof (error as { code?: unknown })?.code === "string" ? (error as { code: string }).code : "DRAFT_TOOL_ERROR", message: (error instanceof Error ? error.message : String(error)).slice(0, 2048) });
      }
    } });
  }
  return {
    skill_list: checked("Read a bounded page of visible skills, or search by query. Listing does not create drafts or select the whole library for publication.", z.object({ query: z.string().max(1000).optional(), top_k: z.number().int().min(1).max(50).optional(), offset: z.number().int().nonnegative().optional() }).strict(), input => session.list(input)),
    skill_view: checked("Open a fixed source version or read an existing private draft. Returns draft_id/draft_revision/base_version and a bounded body/manifest page. Follow next_offset to read the complete body before overwrite. Protected and non-owner sources remain readable but read_only.", z.object({ skill_id: z.string().min(1).max(256).optional(), version: z.number().int().positive().optional(), draft_id: draftId.optional(), ...pageFields, manifest_offset: z.number().int().nonnegative().optional(), manifest_limit: z.number().int().min(1).max(20).optional() }).strict().refine(input => Boolean(input.skill_id) !== Boolean(input.draft_id), "Provide exactly one of skill_id or draft_id").refine(input => !input.draft_id || input.version === undefined, "A private draft is already bound to its source version"), input => session.view(input)),
    skill_create: checked("Stage a complete new private SKILL.md. Returns only draft_id/revision, not a live skill/version. Bodies over 50k can be staged for semantic review before publication.", z.object({ name: z.string().min(1).max(64), content: body, metadata: z.record(z.string(), z.json()).optional() }).strict(), input => session.create(input)),
    skill_update: checked("Replace a private draft body after reading its complete current body. Preserves untouched user metadata/resources; expected_revision is the private revision, not the live base version.", z.object({ draft_id: draftId, expected_revision: revision, content: body }).strict(), input => session.update(input)),
    skill_patch: checked("Patch a fully read private body. old_string must be unique unless replace_all is explicitly safe. No live Core writes occur.", z.object({ draft_id: draftId, expected_revision: revision, old_string: z.string().min(1).max(4_000_000), new_string: z.string().max(4_000_000), replace_all: z.boolean().optional() }).strict(), input => session.patch(input)),
    skill_files_read: checked("Read a bounded byte page of a draft-owned resource, loaded at the fixed base_version. Continue using next_offset before overwriting. MIME and executable attributes come from the original manifest; binary defaults to base64.", z.object({ draft_id: draftId, path: z.string().min(1).max(512), ...pageFields, encoding: z.enum(["utf-8", "base64"]).optional() }).strict(), input => session.readFile(input)),
    skill_files_write: checked("Create or overwrite a private resource. Existing resources must first be fully read. Omitted MIME/executable attributes preserve their previous values. Scripts are stored, never executed.", z.object({ draft_id: draftId, expected_revision: revision, path: z.string().min(1).max(512), content: z.string().max(6_666_668), encoding: z.enum(["utf-8", "base64"]).optional(), mime_type: z.string().min(1).max(256).optional(), is_executable: z.boolean().optional() }).strict(), input => session.writeFile(input)),
  };
}
