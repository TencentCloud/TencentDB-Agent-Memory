import { log } from "../../report/log.js";
import {
  buildCapabilitySnapshot, describeRequestTools, observeCapabilityChoice,
} from "../../selection/capability-routing.js";
import { buildSelectionContext, extractRawDialogue } from "../../selection/context.js";
import { createSelectionStrategy } from "../../selection/registry.js";
import type { SelectionStrategy } from "../../selection/types.js";
import { SkillCandidateProvider } from "../../skill/candidate-provider.js";
import { isNewUserTurn } from "../../skill/selection/delivery/detect.js";
import { buildSearchQuery } from "../../skill/selection/query.js";
import type { ProxyConfig } from "../../types.js";
import type { InjectionRunnerInput } from "./injection-runner.js";

const MAX_PENDING_OBSERVATIONS = 8;
const RECENT_MESSAGES = 12;
const dependencies = new WeakMap<ProxyConfig, {
  strategy: SelectionStrategy;
  skills: SkillCandidateProvider;
}>();
let pendingObservations = 0;

type ShadowInput = Pick<InjectionRunnerInput,
  "skip" | "readOnly" | "config" | "protocol" | "body" | "messages" |
  "userId" | "spaceId" | "sessionKey" | "sessionInfo" | "assetCapabilities" | "traceId"
>;

/** Observe a choice using only this request's existing capabilities. */
export async function observeCapabilityRouting(input: ShadowInput): Promise<void> {
  const { config, sessionInfo, userId, spaceId, sessionKey, protocol } = input;
  const routing = config.capabilityRouting;
  if (!routing?.enabled || input.skip || input.readOnly || !config.selection) return;
  if (
    !userId || !spaceId || !sessionKey || sessionInfo?.user_id !== userId ||
    sessionInfo.space_id !== spaceId || typeof sessionInfo.team_id !== "string" ||
    !sessionInfo.team_id || typeof sessionInfo.agent_id !== "string" || !sessionInfo.agent_id
  ) return;
  if (!isNewUserTurn(input.messages, protocol)) return;
  const choice = input.body.tool_choice;
  if (choice !== undefined && choice !== "auto" &&
    !(protocol === "anthropic" && typeof choice === "object" && choice !== null &&
      (choice as { type?: unknown }).type === "auto")) return;
  if (pendingObservations >= MAX_PENDING_OBSERVATIONS) return;

  const started = performance.now();
  pendingObservations += 1;
  try {
    let deps = dependencies.get(config);
    if (!deps) {
      deps = {
        strategy: createSelectionStrategy(routing.strategy, config.selection.strategies),
        skills: new SkillCandidateProvider(config.coreSkill, config.sessionInit.defaultTaskId),
      };
      dependencies.set(config, deps);
    }
    if (!deps.strategy.isUsable()) return;

    const dialogue = extractRawDialogue(input.messages.slice(-RECENT_MESSAGES))
      .map((message) => ({ ...message, text: message.text.slice(-routing.contextCharBudget) }));
    const query = buildSearchQuery({ messages: dialogue });
    if (!query) return;
    const context = buildSelectionContext({ messages: dialogue, charBudget: routing.contextCharBudget })
      .slice(-routing.contextCharBudget);
    // Capture descriptors before awaiting Core. Injection may change the forwarded body.
    const tools = describeRequestTools(input.body.tools, protocol);
    const includeMemory = input.assetCapabilities?.chat_memory === true &&
      config.tdai.enabled && config.tdai.memory.enabled && Boolean(config.tdai.endpoint && config.tdai.apiKey);
    const includeSkills = input.assetCapabilities?.skill === true &&
      Boolean(config.coreSkill.endpoint && config.coreSkill.serviceToken);
    const skills = includeSkills ? (await deps.skills.get({
      scope: { space_id: spaceId, team_id: sessionInfo.team_id, agent_id: sessionInfo.agent_id },
      agentDetail: null,
      taskDetail: null,
      taskId: typeof sessionInfo.task_id === "string" ? sessionInfo.task_id : undefined,
      sessionScope: JSON.stringify([userId, sessionKey]),
      conversationQuery: query,
      maxCandidates: routing.secondPassTopK,
      throwOnCoreError: true,
    })).candidates : [];
    const snapshot = buildCapabilitySnapshot({ query, tools, skills, includeMemory });
    const observation = await observeCapabilityChoice(snapshot, context, routing, deps.strategy);
    log.info("capability_routing.shadow", {
      protocol, traceId: input.traceId, ...observation, candidates: snapshot.candidates.length,
      latencyMs: Math.round(performance.now() - started),
    });
  } catch {
    // Provider and Core errors may echo request data, so log only a classification.
    log.info("capability_routing.shadow", {
      protocol, traceId: input.traceId, kind: "direct", reason: "unavailable",
      latencyMs: Math.round(performance.now() - started),
    });
  } finally {
    pendingObservations -= 1;
  }
}
