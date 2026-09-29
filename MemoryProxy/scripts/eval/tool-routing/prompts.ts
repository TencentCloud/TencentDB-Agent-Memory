import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { renderTdaiMemoryToolsBlock } from "../../../src/injection/injectors/tdai-tools-injector.js";
import { renderSkillToolsBlock } from "../../../src/injection/injectors/skill-tools-injector.js";
import { wrapAvailableSkillsBlock } from "../../../src/injection/injectors/skill-injector.js";
import { renderKnowledgeToolsBlock } from "../../../src/injection/injectors/knowledge-tools-injector.js";
import { WORKSPACE_TOOLS } from "./workspace-host.js";
import type { EvalCase } from "./types.js";

export const promptHash = (value: string) => createHash("sha256").update(value).digest("hex");
export type PreparedCase = EvalCase & { baseline_resources: string };
const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const baseline = read("./baseline/system.txt");
const baselineKnowledge = read("./baseline/knowledge.txt");
const candidateLayout = read("./fixtures/layout.txt");
const fill = (template: string, values: Record<string, string>) => template.replace(/\{\{([A-Z_]+)\}\}/g, (_, key: string) => {
  if (!(key in values)) throw new Error(`Unknown template slot: ${key}`);
  return values[key];
});

export function loadCases(path = new URL("./dataset.jsonl", import.meta.url)): PreparedCase[] {
  const assets = JSON.parse(read("./fixtures/text.json")) as Record<string, string>;
  for (const [id, text] of Object.entries(assets)) if (promptHash(text) !== id) throw new Error(`Fixture hash mismatch: ${id}`);
  const hydrate = (value: any): any => {
    if (Array.isArray(value)) return value.map(hydrate);
    if (value && typeof value === "object") {
      if (Object.keys(value).length === 1 && typeof value.$fixture === "string") {
        if (!(value.$fixture in assets)) throw new Error(`Missing fixture: ${value.$fixture}`);
        return assets[value.$fixture];
      }
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, hydrate(v)]));
    }
    return value;
  };
  return readFileSync(path, "utf8").trim().split(/\r?\n/).map(line => hydrate(JSON.parse(line)));
}

export async function buildEvalProviderRequest(variant: "baseline" | "candidate", item: EvalCase,
  options: { messages?: unknown[]; requestParams?: Record<string, unknown> } = {}) {
  const c = item as PreparedCase;
  if (c.profile_memory) throw new Error("The frozen layout has no profile-memory slot");
  const listing = ["<available_skills>", ...(c.skill_menu ?? []).map(s => `- ${s.name}: ${s.description}`), "</available_skills>"].join("\n");
  const context = ["<evaluation_context>", `workspace_repo: ${c.workspace_repo ?? "acme/proxy"}`,
    ...(c.current_context ? [`current_context: ${c.current_context}`] : []), "</evaluation_context>"].join("\n");
  let prompt: string;
  if (variant === "baseline") {
    prompt = fill(baseline, { LISTING: listing, KNOWLEDGE: fill(baselineKnowledge, { RESOURCES: c.baseline_resources }), CONTEXT: context });
  } else {
    const resources = (c.knowledge_resources ?? []).map(r => ({ summary: null, team_id: "team-1", user_id: "user-1",
      created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z", ...r }));
    prompt = fill(candidateLayout, {
      SKILL_TOOLS: renderSkillToolsBlock("https://proxy.test", false, "session-1", "space-1").trimEnd(),
      AVAILABLE: wrapAvailableSkillsBlock(listing).trimEnd(),
      KNOWLEDGE: (renderKnowledgeToolsBlock(resources, "space-1", { sessionKey: "session-1", userId: "user-1", teamId: "team-1", agentId: "agent-1" }) ?? "").trimEnd(),
      MEMORY: renderTdaiMemoryToolsBlock("https://proxy.test", "session-1", "space-1").trimEnd(), CONTEXT: context,
    });
  }
  return { prompt, request: { ...(options.requestParams ?? { model: "deepseek-v4-flash", temperature: 0, top_p: 1,
    max_tokens: 8192, thinking: { type: "disabled" } }), messages: [{ role: "system", content: prompt },
    ...structuredClone(options.messages ?? c.messages)], tools: structuredClone(WORKSPACE_TOOLS) } };
}
