/**
 * SkillSelectionService —— skill 资产的选择适配层：
 *   候选召回 → 通用选择策略（`src/selection`）决策 → 按候选版本加载正文。
 *
 * skill 专属的部分（候选来源、判断标准、正文加载）都在这里；策略本身与资产无关。
 */

import { SkillCandidateProvider } from "../candidate-provider.js";
import type { ListingCandidate } from "../core-client.js";
import { SkillLoader } from "../skill-loader.js";
import { buildSearchQuery } from "./query.js";
import { buildSelectionContext } from "../../selection/context.js";
import { createSelectionStrategy } from "../../selection/registry.js";
import type { SelectionStrategy } from "../../selection/types.js";
import { log } from "../../report/log.js";
import type { CoreSkillConfig, SelectionStrategiesConfig, SkillSelectionConfig } from "../../types.js";

/** 给策略模型的判断标准（skill 专属）。 */
export const SKILL_SELECTION_INSTRUCTIONS = [
  "You are selecting at most ONE skill to load for the assistant's current turn.",
  "",
  "A skill is a reusable playbook (conventions, commands, pitfalls, workflows).",
  "Pick a skill ONLY when it would materially help with the user's current request.",
  "",
  "Prefer the MOST SPECIFIC applicable skill:",
  "  - A skill that targets the concrete technology, module, API, class, error, or symptom",
  "    named in the request is more valuable than a broadly-applicable one.",
  "  - A GENERIC process/workflow skill — one that describes a general multi-step procedure",
  "    applicable to almost any task of this kind (e.g. a generic \"reproduce → locate →",
  "    patch → run tests\" bug-fixing workflow) — must be chosen ONLY when NO other candidate",
  "    specifically addresses the request's concrete subject.",
  "  - Whenever a domain/symptom-specific candidate applies, pick it OVER the generic",
  "    workflow skill, even if the generic one also seems relevant. The assistant already",
  "    knows the general workflow; the specific skill is what adds value.",
  "",
  "Answer \"none\" when:",
  "  - the request is casual conversation, a simple question, or pure code reading;",
  "  - no candidate actually covers the request's domain;",
  "  - the only applicable candidate is a generic workflow skill that adds nothing beyond",
  "    the assistant's existing general competence;",
  "  - you are unsure whether any candidate applies.",
].join("\n");

export const SKILL_NONE_DESCRIPTION = "No candidate skill materially helps with the current request.";

export interface SelectionScope {
  team_id: string;
  agent_id: string;
  space_id?: string;
}

export type SelectionDecision =
  | { kind: "load"; skillId: string; version: number; name: string; content: string }
  | { kind: "skip"; reason: string };

export interface SelectRequest {
  scope: SelectionScope;
  taskId?: string;
  /** 候选缓存隔离键（session 粒度）。 */
  sessionScope: string;
  /** 已剔除注入块的对话（user / assistant 文本）。 */
  dialogue: Array<{ role: string; text: string }>;
  /** 已加载过的 skill —— 策略再次选中它们时视为无需新加载。 */
  loadedSkillIds?: ReadonlySet<string>;
  /** 仅用于日志。 */
  logBase?: Record<string, unknown>;
}

export class SkillSelectionService {
  readonly strategy: SelectionStrategy;
  private readonly candidates: SkillCandidateProvider;
  private readonly loader: SkillLoader;

  constructor(
    private readonly selection: SkillSelectionConfig,
    strategies: SelectionStrategiesConfig,
    coreSkill: CoreSkillConfig,
    defaultTaskId?: string,
    deps?: {
      candidateProvider?: SkillCandidateProvider;
      loader?: SkillLoader;
      strategy?: SelectionStrategy;
    },
  ) {
    this.candidates = deps?.candidateProvider ?? new SkillCandidateProvider(coreSkill, defaultTaskId);
    this.loader = deps?.loader ?? new SkillLoader(coreSkill);
    this.strategy = deps?.strategy ?? createSelectionStrategy(selection.strategy, strategies);
  }

  get candidateProvider(): SkillCandidateProvider {
    return this.candidates;
  }

  async select(req: SelectRequest): Promise<SelectionDecision> {
    const sel = this.selection;
    const logBase = { ...req.logBase, strategy: this.strategy.name, model: this.strategy.model };
    if (!this.strategy.isUsable()) return { kind: "skip", reason: "strategy_not_configured" };

    const candidateSet = await this.candidates.get({
      scope: req.scope,
      agentDetail: null,
      taskDetail: null,
      taskId: req.taskId,
      sessionScope: req.sessionScope,
      conversationQuery: sel.useConversationQuery ? buildSearchQuery({ messages: req.dialogue }) : undefined,
      maxCandidates: sel.maxCandidates,
    });
    const candidates = candidateSet.candidates;
    if (candidates.length === 0) return { kind: "skip", reason: "no_candidates" };

    const byOptionId = new Map<string, ListingCandidate>();
    const options = candidates.map((c) => {
      const id = `${c.skill_id}@${c.version}`;
      byOptionId.set(id, c);
      return { id, label: c.name, description: c.description };
    });

    const context = buildSelectionContext({ messages: req.dialogue, charBudget: sel.contextCharBudget });
    const outcome = await this.strategy.select({
      context,
      instructions: SKILL_SELECTION_INSTRUCTIONS,
      noneDescription: SKILL_NONE_DESCRIPTION,
      options,
    });
    if (outcome.kind !== "selected") {
      const reason = outcome.kind === "none" ? (outcome.reason ?? "model_none") : outcome.reason;
      log.info("skill.selection.decision", {
        ...logBase, candidates: candidates.length, decision: "skip", reason,
        confidence: outcome.kind === "none" ? outcome.confidence : undefined,
      });
      return { kind: "skip", reason };
    }
    const picked = byOptionId.get(outcome.optionId);
    if (!picked) {
      // 策略契约保证 optionId 来自 options；防御性兜底，不信任第三方实现。
      log.warn("skill.selection.decision", { ...logBase, decision: "skip", reason: "invalid_option" });
      return { kind: "skip", reason: "invalid_option" };
    }
    if (req.loadedSkillIds?.has(picked.skill_id)) {
      return { kind: "skip", reason: "already_loaded" };
    }

    const loaded = await this.loader.load({
      scope: req.scope,
      skillId: picked.skill_id,
      version: picked.version,
      contentCharBudget: sel.contentCharBudget,
    });
    if (loaded.kind !== "loaded") {
      const reason = `load_${loaded.reason}`;
      log.info("skill.selection.decision", {
        ...logBase, candidates: candidates.length, decision: "skip", reason,
        skillId: picked.skill_id, version: picked.version, confidence: outcome.confidence,
      });
      return { kind: "skip", reason };
    }

    log.info("skill.selection.decision", {
      ...logBase, candidates: candidates.length, decision: "load",
      skillId: loaded.skillId, version: loaded.version,
      contentLen: loaded.content.length, confidence: outcome.confidence,
    });
    return {
      kind: "load",
      skillId: loaded.skillId,
      version: loaded.version,
      name: loaded.name,
      content: loaded.content,
    };
  }
}
