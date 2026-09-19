import { randomUUID } from "node:crypto";
import type { CoreSkillClient } from "../skill/core-client.js";
import { renderForgetPreview } from "./forget-redaction.js";
import type { ForgetExecutionResult, ForgetTarget } from "./forget-pending-store.js";

export interface ForgetIdentity {
  userId: string;
  teamId: string;
  agentId: string;
  serviceId: string;
}

type CoreClient = Pick<CoreSkillClient, "post">;

interface SkillSearchHit {
  skill_id: string;
  name: string;
  description?: string;
  snippet?: string;
  version: number;
  owner_agent_id?: string;
  team_id?: string;
}

interface MemoryPromptRecord {
  memory_prompt_id: string;
  name: string;
  layer: "l1" | "l2" | "l3";
  prompt: string;
  version: number;
  status: "active" | "deleting";
}

interface EffectiveMemoryPrompt {
  memory_prompt_id: string;
  prompt: string;
  layer: "l1" | "l2" | "l3";
  source: "agent" | "team" | "instance" | "system";
  version: number;
}

interface MemoryPromptSetting {
  target_type: "instance" | "team" | "agent";
  team_id?: string;
  agent_id?: string;
  memory_prompt_id: string;
}

const PROMPT_LAYERS = ["l1", "l2", "l3"] as const;
const SETTINGS_PAGE_SIZE = 100;

export class ForgetService {
  constructor(
    private readonly core: CoreClient,
    private readonly createKey: () => string = randomUUID,
  ) {}

  async discover(identity: ForgetIdentity, keyword: string): Promise<ForgetTarget[]> {
    const [skills, prompts] = await Promise.all([
      this.discoverSkills(identity, keyword),
      this.discoverMemoryPrompts(identity, keyword),
    ]);
    return [...skills, ...prompts];
  }

  async execute(identity: ForgetIdentity, target: ForgetTarget): Promise<ForgetExecutionResult> {
    if (target.teamId !== identity.teamId || target.agentId !== identity.agentId) {
      throw new Error("forget target no longer belongs to this session");
    }

    if (target.kind === "skill") {
      await this.core.post(
        "/v3/skill/delete",
        {
          user_id: identity.userId,
          team_id: identity.teamId,
          agent_id: identity.agentId,
          skill_id: target.id,
        },
        { serviceId: identity.serviceId },
      );
    } else {
      const settings = await this.listAllPromptSettings(identity, target.id);
      if (!this.isAgentPrivate(settings, identity)) {
        throw new Error("memory prompt is shared or no longer assigned to this agent");
      }
      await this.core.post(
        "/v3/memory-prompt/delete",
        { memory_prompt_ids: [target.id] },
        { serviceId: identity.serviceId },
      );
    }

    return { kind: target.kind, name: target.name };
  }

  private async discoverSkills(identity: ForgetIdentity, keyword: string): Promise<ForgetTarget[]> {
    const result = await this.core.post<{ items: SkillSearchHit[] }>(
      "/v3/skill/search",
      {
        team_id: identity.teamId,
        agent_id: identity.agentId,
        query: keyword,
        top_k: 10,
        mode: "bm25",
      },
      { serviceId: identity.serviceId },
    );

    return result.items
      .filter((skill) => !skill.owner_agent_id || skill.owner_agent_id === identity.agentId)
      .filter((skill) => !skill.team_id || skill.team_id === identity.teamId)
      .map((skill) => ({
        key: this.createKey(),
        kind: "skill" as const,
        id: skill.skill_id,
        name: skill.name,
        teamId: identity.teamId,
        agentId: identity.agentId,
        preview: renderForgetPreview(skill.snippet || skill.description || skill.name),
        detail: `version ${skill.version}`,
        impact: "Deletes this Skill and all of its versions.",
      }));
  }

  private async discoverMemoryPrompts(identity: ForgetIdentity, keyword: string): Promise<ForgetTarget[]> {
    const normalizedKeyword = keyword.toLowerCase();
    const effective = await Promise.all(PROMPT_LAYERS.map((layer) =>
      this.core.post<EffectiveMemoryPrompt>(
        "/v3/memory-prompt/get",
        { team_id: identity.teamId, agent_id: identity.agentId, layer },
        { serviceId: identity.serviceId },
      ),
    ));

    const uniqueIds = [...new Set(effective
      .filter((prompt) => prompt.source === "agent" && !prompt.memory_prompt_id.startsWith("builtin:"))
      .map((prompt) => prompt.memory_prompt_id))];

    const candidates: ForgetTarget[] = [];
    for (const id of uniqueIds) {
      const [record, settings] = await Promise.all([
        this.core.post<MemoryPromptRecord>(
          "/v3/memory-prompt/get",
          { memory_prompt_id: id },
          { serviceId: identity.serviceId },
        ),
        this.listAllPromptSettings(identity, id),
      ]);
      if (record.status !== "active" || !this.isAgentPrivate(settings, identity)) continue;
      if (!`${record.name}\n${record.prompt}`.toLowerCase().includes(normalizedKeyword)) continue;

      candidates.push({
        key: this.createKey(),
        kind: "memory-prompt",
        id: record.memory_prompt_id,
        name: record.name,
        teamId: identity.teamId,
        agentId: identity.agentId,
        preview: renderForgetPreview(record.prompt),
        detail: `${record.layer.toUpperCase()}, version ${record.version}`,
        impact: "Deletes this Memory Prompt and clears its agent setting.",
      });
    }
    return candidates;
  }

  private async listAllPromptSettings(
    identity: ForgetIdentity,
    memoryPromptId: string,
  ): Promise<MemoryPromptSetting[]> {
    const all: MemoryPromptSetting[] = [];
    for (let offset = 0; ; offset += SETTINGS_PAGE_SIZE) {
      const page = await this.core.post<{ items: MemoryPromptSetting[] }>(
        "/v3/memory-prompt/setting/list",
        { memory_prompt_id: memoryPromptId, limit: SETTINGS_PAGE_SIZE, offset },
        { serviceId: identity.serviceId },
      );
      all.push(...page.items);
      if (page.items.length < SETTINGS_PAGE_SIZE) return all;
    }
  }

  private isAgentPrivate(settings: MemoryPromptSetting[], identity: ForgetIdentity): boolean {
    return settings.length > 0 && settings.every((setting) =>
      setting.target_type === "agent"
      && setting.team_id === identity.teamId
      && setting.agent_id === identity.agentId,
    );
  }
}
