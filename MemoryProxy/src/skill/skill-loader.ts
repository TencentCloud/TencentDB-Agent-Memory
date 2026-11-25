/**
 * SkillLoader —— proxy 自己读取选中 skill 的 SKILL.md 正文。
 *
 * 替代的是什么
 * ────────────
 * legacy 链路里，主模型看到 `<skill_tools>` 后自己 curl `/skill-bridge/v3/skill/get`
 * 拿正文。selection 链路取消了工具说明，正文必须由 proxy 自己加载 —— 本模块就是
 * 那一步，直连 core（不经 HTTP 回环到自己的 bridge）。
 *
 * 必须保住的约束（与 skill-bridge 的读路径语义一致）
 * ─────────────────────────────────────────────────
 *   1. 归属：请求带 team_id + agent_id，core 侧按 (team_id, owner_agent_id)
 *      判定归属；候选本身来自同一 scope 的 listing，因此不会越权到别的 agent。
 *   2. 版本：**显式传候选里的 version**，不读 head。否则 策略模型基于 v3 的描述
 *      做的判断，可能加载到刚被别人改写的 v4 正文。
 *   3. 一致性：core 返回的 skill_id / version 必须与请求一致，不一致即失败，
 *      绝不「悄悄换一个版本」注入。
 *   4. 预算：正文超 `contentCharBudget` → 明确拒绝，不注入截断后的残缺步骤
 *      （半截 workflow 比没有 workflow 更危险）。
 */

import {
  CoreSkillClient,
  getCoreSkillClient,
  type GetSkillResult,
} from "./core-client.js";
import type { CoreSkillConfig } from "../types.js";

const TAG = "[skill-loader]";

export interface LoadScope {
  team_id: string;
  agent_id: string;
  space_id?: string;
}

export type LoadOutcome =
  | { kind: "loaded"; skillId: string; version: number; name: string; content: string }
  | { kind: "failed"; reason: string };

export class SkillLoader {
  constructor(
    private readonly coreSkill: CoreSkillConfig,
    private readonly clientOverride?: CoreSkillClient,
  ) {}

  async load(args: {
    scope: LoadScope;
    skillId: string;
    /** 候选里的版本，必须显式传。 */
    version: number;
    contentCharBudget: number;
  }): Promise<LoadOutcome> {
    const { scope, skillId, version, contentCharBudget } = args;

    if (!scope.team_id || !scope.agent_id) return { kind: "failed", reason: "missing_identity" };
    if (!skillId || !Number.isInteger(version) || version < 1) {
      return { kind: "failed", reason: "invalid_target" };
    }

    let result: GetSkillResult;
    try {
      const client = this.clientOverride ?? getCoreSkillClient(this.coreSkill);
      result = await client.getSkill(
        {
          team_id: scope.team_id,
          agent_id: scope.agent_id,
          skill_id: skillId,
          version,
          include_content: true,
          // manifest 暂不使用 —— 首版只注入正文，不下发附件。
          include_manifest: false,
        },
        { serviceId: scope.space_id || undefined },
      );
    } catch (err) {
      console.warn(`${TAG} get failed skill=${skillId}@${version}: ${(err as Error).message}`);
      return { kind: "failed", reason: "core_error" };
    }

    // 一致性校验 —— core 必须回同一个 skill 的同一个版本。
    if (result.skill_id && result.skill_id !== skillId) {
      console.warn(`${TAG} skill_id mismatch, refusing to inject`);
      return { kind: "failed", reason: "id_mismatch" };
    }
    if (typeof result.version === "number" && result.version !== version) {
      console.warn(
        `${TAG} version mismatch skill=${skillId} want=${version} got=${result.version},`
          + ` refusing to inject`,
      );
      return { kind: "failed", reason: "version_mismatch" };
    }

    const content = typeof result.content === "string" ? result.content.trim() : "";
    if (!content) return { kind: "failed", reason: "empty_content" };

    if (content.length > contentCharBudget) {
      // 不截断 —— 半截 workflow 会让模型漏掉后续关键步骤。
      console.warn(
        `${TAG} content ${content.length} chars exceeds budget ${contentCharBudget},`
          + ` refusing to inject skill=${skillId}@${version}`,
      );
      return { kind: "failed", reason: "over_budget" };
    }

    return {
      kind: "loaded",
      skillId,
      version,
      name: result.name || skillId,
      content,
    };
  }
}
