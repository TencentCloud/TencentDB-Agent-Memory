import { createHash, randomUUID } from "node:crypto";
import type { IntegrityCheck, RecallCandidate, RecallSnapshot } from "./protocol.js";
import type { Mem2ActDataset, Mem2ActProbeTask, Mem2ActQa, Mem2ActTurn, ParsedToolAction } from "./mem2act.js";
import { createRecallSnapshot } from "./recall-snapshot.js";

export const ONLINE_EVIDENCE_VERSION = "direction-a.online-evidence.v2" as const;
export const ONLINE_FEATURE_VERSION = "direction-a.online-feature.v1" as const;
export const ONLINE_SPLIT_VERSION = "direction-a.online-split.v1" as const;
export const ONLINE_SEED = 20260830;

export type TriAvailability = "AVAILABLE" | "UNAVAILABLE" | "UNRESOLVED";

export interface OnlineE1Evidence {
  version: typeof ONLINE_EVIDENCE_VERSION;
  tier: "E1";
  actionEventId: string;
  memoryGroupId: string;
  relation: "USED" | "CONTRADICTED" | "CONSISTENT_WITH" | "NO_LINK";
  linkedArgumentKeys: string[];
  rationale: string;
}

export interface OnlineE2Evidence {
  version: typeof ONLINE_EVIDENCE_VERSION;
  tier: "E2";
  status: "AVAILABLE" | "UNAVAILABLE";
  verifierEventId?: string;
  linkedE1ActionEventIds: string[];
  outcome?: "SUCCESS" | "FAILURE" | "PARTIAL";
  score?: number;
  reason: string;
}

export interface OnlineEvidenceBundle {
  version: typeof ONLINE_EVIDENCE_VERSION;
  outcomeVerifierCapability: "AVAILABLE" | "UNAVAILABLE";
  e0SourceRefs: string[];
  e1: OnlineE1Evidence | null;
  e2: OnlineE2Evidence;
}

export interface OnlineMem2ActTask {
  qaId: string;
  query: string;
  sourceConversationIds: string[];
  sourceSessionIds: string[];
  historyBySource: Record<string, Mem2ActTurn[]>;
  targetSourceId: string;
  targetGroupId: string;
  targetToolSchema: Mem2ActQa["target_tool_schema"];
  goldToolCall: Mem2ActQa["tool_call"];
  complexityMetadata: Mem2ActQa["complexity_metadata"];
  componentId: string;
  taskInputHash: string;
}

export interface OnlinePoolManifest {
  version: typeof ONLINE_SPLIT_VERSION;
  seed: number;
  candidateTasks: number;
  componentCount: number;
  sourcePrimary: OnlineMem2ActTask[];
  sourceReserve: OnlineMem2ActTask[];
  targetPrimary: OnlineMem2ActTask[];
  targetReserve: OnlineMem2ActTask[];
  excludedQaIds: string[];
  isolation: { sharedComponentOverlap: 0; sourceSessionTargetSessionOverlap: 0 };
}

export interface X0Features {
  version: typeof ONLINE_FEATURE_VERSION;
  structural: Record<string, number>;
  semantic: Record<string, number>;
  agentBehavior: Record<string, number>;
  outcomeLinked: Record<string, number | "UNAVAILABLE">;
  capability: Record<string, 0 | 1>;
}

const sha = (value: string): string => createHash("sha256").update(value).digest("hex");
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
};

function flattenScalars(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(flattenScalars);
  if (value && typeof value === "object") return Object.values(value as Record<string, unknown>).flatMap(flattenScalars);
  return value === null || value === undefined ? [] : [String(value)];
}

function visibleText(turns: readonly Mem2ActTurn[]): string {
  return turns.map((turn) => turn.content ?? "").join("\n");
}

function normalizedTerms(text: string): Set<string> {
  return new Set(text.normalize("NFKC").toLocaleLowerCase("en-US").match(/[\p{L}\p{N}_-]+/gu) ?? []);
}

export function jaccardText(left: string, right: string): number {
  const a = normalizedTerms(left); const b = normalizedTerms(right);
  const union = new Set([...a, ...b]);
  return union.size === 0 ? 0 : [...a].filter((term) => b.has(term)).length / union.size;
}

export function deriveOnlineEvidence(input: {
  sourceRefs: string[];
  memoryGroupId: string;
  targetMemoryText: string;
  action?: ParsedToolAction;
  verifierCapability: boolean;
  verifierSuccess?: boolean;
}): OnlineEvidenceBundle {
  let e1: OnlineE1Evidence | null = null;
  if (input.action) {
    const target = input.targetMemoryText.toLocaleLowerCase("en-US");
    const linkedArgumentKeys = Object.entries(input.action.arguments).filter(([, value]) =>
      flattenScalars(value).some((scalar) => scalar.length > 0 && target.includes(scalar.toLocaleLowerCase("en-US")))).map(([key]) => key);
    e1 = { version: ONLINE_EVIDENCE_VERSION, tier: "E1", actionEventId: randomUUID(), memoryGroupId: input.memoryGroupId,
      relation: linkedArgumentKeys.length > 0 ? "USED" : "NO_LINK", linkedArgumentKeys,
      rationale: linkedArgumentKeys.length > 0 ? `Action arguments grounded in target memory: ${linkedArgumentKeys.join(",")}` : "No action argument is visibly grounded in the target memory" };
  }
  const e1Linked = e1 !== null && e1.relation !== "NO_LINK";
  const e2: OnlineE2Evidence = !input.verifierCapability
    ? { version: ONLINE_EVIDENCE_VERSION, tier: "E2", status: "UNAVAILABLE", linkedE1ActionEventIds: [], reason: "Outcome verifier capability is unavailable" }
    : !e1Linked
      ? { version: ONLINE_EVIDENCE_VERSION, tier: "E2", status: "UNAVAILABLE", linkedE1ActionEventIds: [], reason: "Verifier capability exists, but no Memory-linked E1 behavior exists" }
      : { version: ONLINE_EVIDENCE_VERSION, tier: "E2", status: "AVAILABLE", verifierEventId: randomUUID(),
        linkedE1ActionEventIds: [e1!.actionEventId], outcome: input.verifierSuccess ? "SUCCESS" : "FAILURE", score: input.verifierSuccess ? 1 : 0,
        reason: "Programmatic outcome is linked through the observed Memory-grounded E1 action" };
  return { version: ONLINE_EVIDENCE_VERSION, outcomeVerifierCapability: input.verifierCapability ? "AVAILABLE" : "UNAVAILABLE",
    e0SourceRefs: [...input.sourceRefs], e1, e2 };
}

class UnionFind {
  private parent = new Map<string, string>();
  find(value: string): string {
    if (!this.parent.has(value)) this.parent.set(value, value);
    const parent = this.parent.get(value)!;
    if (parent !== value) this.parent.set(value, this.find(parent));
    return this.parent.get(value)!;
  }
  union(left: string, right: string): void {
    const a = this.find(left); const b = this.find(right);
    if (a !== b) this.parent.set(b, a);
  }
}

function buildTask(dataset: Mem2ActDataset, qa: Mem2ActQa, componentId: string, seed: number): OnlineMem2ActTask {
  const historyBySource: Record<string, Mem2ActTurn[]> = {};
  const sourceSessionIds: string[] = [];
  for (const sourceId of qa.source_conversation_ids) {
    const conversation = dataset.conversationBySourceId.get(sourceId)!;
    historyBySource[sourceId] = conversation.turns.filter((turn) => turn.source_id === sourceId);
    if (!sourceSessionIds.includes(conversation.session_id)) sourceSessionIds.push(conversation.session_id);
  }
  const targetSourceId = [...qa.source_conversation_ids].sort((a, b) => sha(`${seed}\0${qa.qa_id}\0${a}`).localeCompare(sha(`${seed}\0${qa.qa_id}\0${b}`)))[0];
  const targetGroupId = `mg_mem2act_${sha(`${qa.qa_id}\0${targetSourceId}`).slice(0, 20)}`;
  const visibleInput = { qaId: qa.qa_id, query: qa.query, sourceConversationIds: qa.source_conversation_ids,
    historyBySource, targetSourceId, targetToolSchema: qa.target_tool_schema };
  return { qaId: qa.qa_id, query: qa.query, sourceConversationIds: [...qa.source_conversation_ids], sourceSessionIds,
    historyBySource, targetSourceId, targetGroupId, targetToolSchema: qa.target_tool_schema, goldToolCall: qa.tool_call,
    complexityMetadata: qa.complexity_metadata, componentId, taskInputHash: sha(canonical(visibleInput)) };
}

export function buildOnlineMem2ActPools(dataset: Mem2ActDataset, seed = ONLINE_SEED): OnlinePoolManifest {
  const baseEligible = new Set(dataset.audit.eligibleQaIds);
  const eligible = dataset.qa.filter((qa) => baseEligible.has(qa.qa_id) && qa.source_conversation_ids.length > 0
    && qa.source_conversation_ids.every((sourceId) => (dataset.conversationBySourceId.get(sourceId)?.turns.some((turn) => turn.source_id === sourceId)) === true));
  const uf = new UnionFind();
  const sessionsByQa = new Map<string, string[]>();
  for (const qa of eligible) {
    const sessions = [...new Set(qa.source_conversation_ids.map((sourceId) => dataset.conversationBySourceId.get(sourceId)!.session_id))];
    sessionsByQa.set(qa.qa_id, sessions);
    for (let index = 1; index < sessions.length; index += 1) uf.union(sessions[0], sessions[index]);
    if (sessions.length === 1) uf.find(sessions[0]);
  }
  const qaByComponent = new Map<string, Mem2ActQa[]>();
  for (const qa of eligible) {
    const component = uf.find(sessionsByQa.get(qa.qa_id)![0]);
    const rows = qaByComponent.get(component) ?? []; rows.push(qa); qaByComponent.set(component, rows);
  }
  const components = [...qaByComponent.entries()].map(([root, rows]) => {
    const sessions = [...new Set(rows.flatMap((row) => sessionsByQa.get(row.qa_id)!))].sort();
    const componentId = `mc_${sha(canonical(sessions)).slice(0, 20)}`;
    const tasks = rows.map((qa) => buildTask(dataset, qa, componentId, seed))
      .sort((a, b) => sha(`${seed}\0task\0${a.qaId}`).localeCompare(sha(`${seed}\0task\0${b.qaId}`)));
    return { root, componentId, sessions, tasks, order: sha(`${seed}\0component\0${componentId}`) };
  }).sort((a, b) => a.order.localeCompare(b.order));
  const source: OnlineMem2ActTask[] = []; const target: OnlineMem2ActTask[] = [];
  const sourceSessions = new Set<string>(); const targetSessions = new Set<string>();
  let side: "source" | "target" = "source";
  for (const component of components) {
    if (side === "source" && source.length >= 96) side = "target";
    if (side === "target" && target.length >= 64) continue;
    const destination = side === "source" ? source : target;
    const sessionSet = side === "source" ? sourceSessions : targetSessions;
    const limit = side === "source" ? 96 : 64;
    destination.push(...component.tasks.slice(0, Math.max(0, limit - destination.length)));
    component.sessions.forEach((session) => sessionSet.add(session));
  }
  if (source.length !== 96 || target.length !== 64) throw new Error(`Mem2Act pool capacity failed: source=${source.length}, target=${target.length}`);
  const overlap = [...sourceSessions].filter((session) => targetSessions.has(session));
  if (overlap.length > 0) throw new Error("Mem2Act source/target session components overlap");
  const selected = new Set([...source, ...target].map((task) => task.qaId));
  return { version: ONLINE_SPLIT_VERSION, seed, candidateTasks: eligible.length, componentCount: components.length,
    sourcePrimary: source.slice(0, 64), sourceReserve: source.slice(64), targetPrimary: target.slice(0, 48), targetReserve: target.slice(48),
    excludedQaIds: dataset.qa.map((qa) => qa.qa_id).filter((id) => !selected.has(id)).sort(),
    isolation: { sharedComponentOverlap: 0, sourceSessionTargetSessionOverlap: 0 } };
}

export function renderOnlineMem2ActPrompt(task: OnlineMem2ActTask, includedSourceIds: readonly string[]): string {
  const history = includedSourceIds.flatMap((sourceId) => task.historyBySource[sourceId].map((turn) => ({ source_id: sourceId,
    role: turn.role, content: turn.content, tool_calls: turn.tool_calls, tool_name: turn.name, tool_call_id: turn.tool_call_id })));
  return ["Frozen post-budget memory context:", history.length ? history.map((event, index) => JSON.stringify({ event: index + 1, ...event })).join("\n") : "[none]",
    "", `Current user query: ${task.query}`, "", `Available target tool schema: ${JSON.stringify(task.targetToolSchema)}`, "",
    "Return exactly one JSON object: {\"name\":\"tool name\",\"arguments\":{...}}. Do not add markdown or explanation."].join("\n");
}

export function buildMem2ActR0(task: OnlineMem2ActTask): RecallSnapshot {
  const candidates: RecallCandidate[] = task.sourceConversationIds.map((sourceId, rank) => ({ id: sourceId,
    content: visibleText(task.historyBySource[sourceId]), type: "benchmark_memory", scoreKind: "UNAVAILABLE",
    renderedLine: `- [benchmark_memory|${rank}] ${visibleText(task.historyBySource[sourceId])}` }));
  return createRecallSnapshot({ query: task.query, strategy: "keyword-diagnostic-v1:official-source-order", candidates,
    budgetedCandidates: candidates.map((candidate, originalRank) => ({ ...candidate, decision: "BUDGET_DISABLED", originalRank, renderedLineAfterBudget: candidate.renderedLine })),
    prependContext: candidates.map((candidate) => candidate.renderedLine).join("\n"), accessPolicy: "AUTO_INJECTION_ONLY", memoryToolsGuideIncluded: false });
}

export function verifyToolActionExact(action: ParsedToolAction | undefined, task: OnlineMem2ActTask): boolean | undefined {
  return action ? action.name === task.goldToolCall.name && canonical(action.arguments) === canonical(task.goldToolCall.arguments) : undefined;
}

export function extractX0Features(task: OnlineMem2ActTask, r0: RecallSnapshot, action: ParsedToolAction | undefined,
  evidence: OnlineEvidenceBundle, parserRetryCount = 0): X0Features {
  const targetText = visibleText(task.historyBySource[task.targetSourceId]);
  const targetRank = task.sourceConversationIds.indexOf(task.targetSourceId);
  const actionScalars = action ? flattenScalars(action.arguments) : [];
  const groundedScalars = actionScalars.filter((value) => targetText.toLocaleLowerCase("en-US").includes(value.toLocaleLowerCase("en-US")));
  const exactOutcome = evidence.e2.status === "AVAILABLE" ? (evidence.e2.outcome === "SUCCESS" ? 1 : 0) : "UNAVAILABLE";
  return { version: ONLINE_FEATURE_VERSION,
    structural: { retrievalRank: targetRank, recallCandidates: r0.candidates.length, injectedCandidates: r0.injectedCandidateIds.length,
      groupSize: 1, targetCharacters: targetText.length, totalVisibleCharacters: task.sourceConversationIds.reduce((sum, id) => sum + visibleText(task.historyBySource[id]).length, 0),
      targetTurns: task.historyBySource[task.targetSourceId].length, sourceSessions: task.sourceSessionIds.length, targetActuallyInjected: r0.injectedCandidateIds.includes(task.targetSourceId) ? 1 : 0,
      provenanceValid: task.sourceSessionIds.length > 0 ? 1 : 0, scoreSemanticsUnavailable: 1, budgetKept: 1 },
    semantic: { queryTargetJaccard: jaccardText(task.query, targetText), queryAllMemoryJaccard: jaccardText(task.query,
      task.sourceConversationIds.map((id) => visibleText(task.historyBySource[id])).join("\n")), schemaTargetJaccard: jaccardText(JSON.stringify(task.targetToolSchema), targetText),
      targetFractionVisible: targetText.length / Math.max(1, task.sourceConversationIds.reduce((sum, id) => sum + visibleText(task.historyBySource[id]).length, 0)) },
    agentBehavior: { actionParsed: action ? 1 : 0, predictedArgumentCount: action ? Object.keys(action.arguments).length : 0,
      targetGroundedArgumentCount: groundedScalars.length, targetGroundedArgumentRate: actionScalars.length ? groundedScalars.length / actionScalars.length : 0,
      predictedToolMatchesAvailableSchema: action?.name === task.targetToolSchema.name ? 1 : 0, parserRetryCount },
    outcomeLinked: { e2Available: evidence.e2.status === "AVAILABLE" ? 1 : 0, e2Success: exactOutcome },
    capability: { agentTrajectory: action ? 1 : 0, toolAction: action ? 1 : 0, toolArgs: action ? 1 : 0,
      outcomeVerifier: evidence.outcomeVerifierCapability === "AVAILABLE" ? 1 : 0, revisionPair: 0, localActionProbe: 1, longitudinalIdentity: 0 } };
}

export function causalLabel(fullSuccess: boolean | undefined, removeSuccess: boolean | undefined): "POSITIVE" | "NON_POSITIVE" | "HARMFUL" | "INCONCLUSIVE" {
  if (fullSuccess === undefined || removeSuccess === undefined) return "INCONCLUSIVE";
  if (fullSuccess && !removeSuccess) return "POSITIVE";
  if (!fullSuccess && removeSuccess) return "HARMFUL";
  return "NON_POSITIVE";
}

export function oneSidedExactBinomialUpper(failures: number, trials: number, confidence = 0.95): number | "UNAVAILABLE" {
  if (!Number.isInteger(failures) || !Number.isInteger(trials) || failures < 0 || trials < 0 || failures > trials) throw new Error("Invalid binomial counts");
  if (trials === 0) return "UNAVAILABLE";
  if (failures === trials) return 1;
  const alpha = 1 - confidence;
  const cdf = (probability: number) => {
    if (probability <= 0) return 1;
    if (probability >= 1) return failures === trials ? 1 : 0;
    let probabilityMass = Math.pow(1 - probability, trials);
    let sum = probabilityMass;
    for (let count = 0; count < failures; count += 1) {
      probabilityMass *= ((trials - count) / (count + 1)) * (probability / (1 - probability));
      sum += probabilityMass;
    }
    return sum;
  };
  let low = 0; let high = 1;
  for (let iteration = 0; iteration < 100; iteration += 1) {
    const middle = (low + high) / 2;
    if (cdf(middle) > alpha) low = middle; else high = middle;
  }
  return (low + high) / 2;
}

export function auditOnlinePools(pools: OnlinePoolManifest): IntegrityCheck[] {
  const sourceIds = new Set([...pools.sourcePrimary, ...pools.sourceReserve].map((task) => task.qaId));
  const targetIds = new Set([...pools.targetPrimary, ...pools.targetReserve].map((task) => task.qaId));
  const sourceComponents = new Set([...pools.sourcePrimary, ...pools.sourceReserve].map((task) => task.componentId));
  const targetComponents = new Set([...pools.targetPrimary, ...pools.targetReserve].map((task) => task.componentId));
  return [
    { check: "SOURCE_PRIMARY_64", passed: pools.sourcePrimary.length === 64 },
    { check: "SOURCE_RESERVE_32", passed: pools.sourceReserve.length === 32 },
    { check: "TARGET_PRIMARY_48", passed: pools.targetPrimary.length === 48 },
    { check: "TARGET_RESERVE_16", passed: pools.targetReserve.length === 16 },
    { check: "QA_ID_DISJOINT", passed: [...sourceIds].every((id) => !targetIds.has(id)) },
    { check: "SESSION_COMPONENT_DISJOINT", passed: [...sourceComponents].every((id) => !targetComponents.has(id)) },
    { check: "ONE_TARGET_GROUP_PER_TASK", passed: [...pools.sourcePrimary, ...pools.sourceReserve, ...pools.targetPrimary, ...pools.targetReserve]
      .every((task) => task.targetSourceId.length > 0 && task.targetGroupId.length > 0) },
  ];
}

export function targetPublicRecord(task: OnlineMem2ActTask) {
  return { qaId: task.qaId, componentId: task.componentId, sourceSessionHashes: task.sourceSessionIds.map((id) => sha(id)),
    sourceCount: task.sourceConversationIds.length, targetGroupId: task.targetGroupId, targetSourceHash: sha(task.targetSourceId),
    taskInputHash: task.taskInputHash };
}

export function adaptLegacyLongMemEvalAvailability(outcomeVerifierAvailable: boolean, e1Available: boolean) {
  return { version: ONLINE_EVIDENCE_VERSION, outcomeVerifierCapability: outcomeVerifierAvailable ? "AVAILABLE" : "UNAVAILABLE",
    E0: "AVAILABLE", E1: e1Available ? "AVAILABLE" : "UNAVAILABLE",
    E2: outcomeVerifierAvailable && e1Available ? "AVAILABLE" : "UNAVAILABLE",
    reason: outcomeVerifierAvailable && !e1Available ? "QA verifier exists, but no Memory-linked Agent behavior exists; E2 must abstain" : undefined };
}

