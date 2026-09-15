import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  BEHAVIOR_EVIDENCE_VERSION,
  type CapabilityRecord,
  type IntegrityCheck,
} from "./protocol.js";
import type { BehaviorEvidence, EvaluationEpisodeResult } from "./evidence.js";
import { EvaluationTrajectory, type TrajectoryEvent } from "./trajectory.js";

export const MEM2ACT_ADAPTER_VERSION = "direction-a.mem2act-adapter.v1" as const;
export const MEM2ACT_ENVIRONMENT_VERSION = "direction-a.mem2act-environment.v1" as const;

export interface Mem2ActTurn {
  role: "user" | "assistant" | "tool" | "system";
  content?: string;
  source_id: string;
  name?: string;
  tool_call_id?: string;
  tool_calls?: unknown[];
}

export interface Mem2ActConversation {
  session_id: string;
  original_conversation_ids: string[];
  turns: Mem2ActTurn[];
  turn_count: number;
  has_tool_calls: boolean;
  token_count: number;
}

export interface Mem2ActToolCall {
  name: string;
  arguments: Record<string, unknown>;
  grounding_info?: Record<string, { source_text?: string; type?: string }>;
}

export interface Mem2ActQa {
  qa_id: string;
  source_conversation_ids: string[];
  evolution_chain: Array<{ attribute?: string; source_id: string; fact?: string; source_text?: string }>;
  query: string;
  tool_call: Mem2ActToolCall;
  target_tool_schema: { name: string; description?: string; parameters: Record<string, unknown>; required?: unknown };
  complexity_metadata: Record<string, unknown> & { level?: string };
}

export interface Mem2ActDatasetAudit {
  version: typeof MEM2ACT_ADAPTER_VERSION;
  conversations: number;
  qaTasks: number;
  uniqueQaIds: boolean;
  uniqueSessionIds: boolean;
  validQaSchemas: number;
  validConversationSchemas: number;
  sourceReferences: number;
  missingSourceReferences: Array<{ qaId: string; sourceId: string }>;
  schemaInvalidQaIds: string[];
  ineligibleQaIds: string[];
  eligibleQaIds: string[];
  complexityCounts: Record<string, number>;
  integrity: IntegrityCheck[];
}

export interface Mem2ActDataset {
  conversations: Mem2ActConversation[];
  qa: Mem2ActQa[];
  conversationBySourceId: Map<string, Mem2ActConversation>;
  audit: Mem2ActDatasetAudit;
}

export interface Mem2ActProbeTask {
  version: typeof MEM2ACT_ADAPTER_VERSION;
  qaId: string;
  sampleRank: number;
  sampleHash: string;
  query: string;
  sourceConversationIds: string[];
  sourceSessionIds: string[];
  history: Mem2ActTurn[];
  targetToolSchema: Mem2ActQa["target_tool_schema"];
  goldToolCall: Mem2ActToolCall;
  complexityMetadata: Mem2ActQa["complexity_metadata"];
  promptInputHash: string;
}

export interface ParsedToolAction {
  name: string;
  arguments: Record<string, unknown>;
}

export interface Mem2ActVerification {
  exactMatch: boolean;
  nameMatch: boolean;
  argumentsMatch: boolean;
  groundedArgumentKeys: string[];
  ungroundedArgumentKeys: string[];
  evidence: BehaviorEvidence[];
  trajectory: TrajectoryEvent[];
  episodeResult: EvaluationEpisodeResult;
  capabilities: CapabilityRecord[];
}

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJsonLines<T>(text: string, label: string): T[] {
  return text.split(/\r?\n/).filter((line) => line.trim()).map((line, index) => {
    try { return JSON.parse(line) as T; }
    catch { throw new Error(`${label} line ${index + 1} is not valid JSON`); }
  });
}

function validQa(value: Mem2ActQa): boolean {
  return typeof value.qa_id === "string" && value.qa_id.length > 0
    && Array.isArray(value.source_conversation_ids) && value.source_conversation_ids.every((id) => typeof id === "string" && id.length > 0)
    && typeof value.query === "string" && value.query.length > 0
    && isRecord(value.tool_call) && typeof value.tool_call.name === "string" && isRecord(value.tool_call.arguments)
    && isRecord(value.target_tool_schema) && typeof value.target_tool_schema.name === "string" && isRecord(value.target_tool_schema.parameters)
    && value.target_tool_schema.name === value.tool_call.name;
}

function validConversation(value: Mem2ActConversation): boolean {
  return typeof value.session_id === "string" && value.session_id.length > 0
    && Array.isArray(value.original_conversation_ids) && value.original_conversation_ids.every((id) => typeof id === "string" && id.length > 0)
    && Array.isArray(value.turns) && value.turns.every((turn) => isRecord(turn) && typeof turn.role === "string" && typeof turn.source_id === "string")
    // The official field is a semantic dialogue-turn count; tool result events make
    // the serialized event array longer, so equality with turns.length is not valid.
    && Number.isInteger(value.turn_count) && value.turn_count > 0
    && typeof value.has_tool_calls === "boolean" && Number.isFinite(value.token_count);
}

export async function loadOfficialMem2ActSmall(qaPath: string, conversationPath: string): Promise<Mem2ActDataset> {
  const qa = parseJsonLines<Mem2ActQa>(await readFile(qaPath, "utf8"), "Mem2Act QA");
  const conversations = parseJsonLines<Mem2ActConversation>(await readFile(conversationPath, "utf8"), "Mem2Act conversation");
  const qaIds = qa.map((item) => item.qa_id);
  const sessionIds = conversations.map((item) => item.session_id);
  const conversationBySourceId = new Map<string, Mem2ActConversation>();
  const duplicateSourceIds: string[] = [];
  for (const conversation of conversations) {
    for (const sourceId of conversation.original_conversation_ids) {
      if (conversationBySourceId.has(sourceId)) duplicateSourceIds.push(sourceId);
      conversationBySourceId.set(sourceId, conversation);
    }
  }
  const missingSourceReferences = qa.flatMap((item) => item.source_conversation_ids
    .filter((sourceId) => !conversationBySourceId.has(sourceId))
    .map((sourceId) => ({ qaId: item.qa_id, sourceId })));
  const schemaInvalidQaIds = qa.filter((item) => !validQa(item)).map((item) => item.qa_id).sort();
  const ineligibleQaIds = [...new Set([...missingSourceReferences.map((item) => item.qaId), ...schemaInvalidQaIds])].sort();
  const ineligible = new Set(ineligibleQaIds);
  const complexityCounts: Record<string, number> = {};
  for (const item of qa) {
    const level = item.complexity_metadata?.level ?? "UNAVAILABLE";
    complexityCounts[level] = (complexityCounts[level] ?? 0) + 1;
  }
  const validQaSchemas = qa.filter(validQa).length;
  const validConversationSchemas = conversations.filter(validConversation).length;
  const integrity: IntegrityCheck[] = [
    { check: "OFFICIAL_SMALL_QA_COUNT_400", passed: qa.length === 400, details: String(qa.length) },
    { check: "OFFICIAL_SMALL_CONVERSATION_COUNT_429", passed: conversations.length === 429, details: String(conversations.length) },
    { check: "UNIQUE_QA_IDS", passed: new Set(qaIds).size === qaIds.length },
    { check: "UNIQUE_SESSION_IDS", passed: new Set(sessionIds).size === sessionIds.length },
    { check: "QA_SCHEMA_INVALID_DECLARED_NOT_SILENT", passed: true, details: `${validQaSchemas}/${qa.length} schema-valid; invalid=${schemaInvalidQaIds.join(",") || "none"}` },
    { check: "CONVERSATION_SCHEMA_VALID", passed: validConversationSchemas === conversations.length, details: `${validConversationSchemas}/${conversations.length}` },
    { check: "SOURCE_ID_UNIQUELY_MAPS_TO_SESSION", passed: duplicateSourceIds.length === 0, details: `${duplicateSourceIds.length} duplicates` },
    { check: "TURN_COUNT_INTERPRETED_AS_OFFICIAL_SEMANTIC_COUNT", passed: true, details: "turn_count is validated as a positive integer, not equated to serialized event count" },
    { check: "MISSING_SOURCE_REFS_DECLARED_NOT_SILENT", passed: true, details: `${missingSourceReferences.length} references across ${ineligibleQaIds.length} QA tasks` },
  ];
  if (integrity.some((check) => !check.passed)) throw new Error(`Mem2Act official small schema integrity failed: ${integrity.filter((check) => !check.passed).map((check) => check.check).join(", ")}`);
  return { conversations, qa, conversationBySourceId, audit: {
    version: MEM2ACT_ADAPTER_VERSION, conversations: conversations.length, qaTasks: qa.length,
    uniqueQaIds: new Set(qaIds).size === qaIds.length, uniqueSessionIds: new Set(sessionIds).size === sessionIds.length,
    validQaSchemas, validConversationSchemas,
    sourceReferences: qa.reduce((sum, item) => sum + item.source_conversation_ids.length, 0),
    missingSourceReferences, schemaInvalidQaIds, ineligibleQaIds,
    eligibleQaIds: qa.filter((item) => !ineligible.has(item.qa_id)).map((item) => item.qa_id).sort(),
    complexityCounts, integrity,
  } };
}

function relevantTurns(dataset: Mem2ActDataset, sourceIds: string[]): { turns: Mem2ActTurn[]; sessionIds: string[] } {
  const turns: Mem2ActTurn[] = [];
  const sessionIds: string[] = [];
  for (const sourceId of sourceIds) {
    const conversation = dataset.conversationBySourceId.get(sourceId);
    if (!conversation) throw new Error(`Mem2Act source is unavailable: ${sourceId}`);
    if (!sessionIds.includes(conversation.session_id)) sessionIds.push(conversation.session_id);
    const sourceTurns = conversation.turns.filter((turn) => turn.source_id === sourceId);
    if (sourceTurns.length === 0) throw new Error(`Mem2Act source has no turns: ${sourceId}`);
    turns.push(...sourceTurns);
  }
  return { turns, sessionIds };
}

export function selectMem2ActHashSample(dataset: Mem2ActDataset, seed: number, count = 3): Mem2ActProbeTask[] {
  if (!Number.isInteger(seed) || !Number.isInteger(count) || count < 1 || count > 3) throw new Error("Mem2Act sample requires an integer seed and count 1..3");
  const eligible = new Set(dataset.audit.eligibleQaIds);
  return dataset.qa.filter((item) => eligible.has(item.qa_id))
    .map((item) => ({ item, hash: sha256(`${seed}\0${item.qa_id}`) }))
    .sort((a, b) => a.hash.localeCompare(b.hash) || a.item.qa_id.localeCompare(b.item.qa_id))
    .slice(0, count)
    .map(({ item, hash }, index) => {
      const { turns, sessionIds } = relevantTurns(dataset, item.source_conversation_ids);
      const promptInput = { query: item.query, history: turns, targetToolSchema: item.target_tool_schema };
      return { version: MEM2ACT_ADAPTER_VERSION, qaId: item.qa_id, sampleRank: index + 1, sampleHash: hash,
        query: item.query, sourceConversationIds: [...item.source_conversation_ids], sourceSessionIds: sessionIds,
        history: turns, targetToolSchema: item.target_tool_schema, goldToolCall: item.tool_call,
        complexityMetadata: item.complexity_metadata, promptInputHash: sha256(JSON.stringify(promptInput)) };
    });
}

export function renderMem2ActPrompt(task: Mem2ActProbeTask): string {
  const history = task.history.map((turn, index) => JSON.stringify({ event: index + 1, role: turn.role, content: turn.content,
    tool_calls: turn.tool_calls, tool_name: turn.name, tool_call_id: turn.tool_call_id, source_id: turn.source_id })).join("\n");
  return [
    "Historical tool-use events (chronological within each declared source conversation):",
    history,
    "",
    `Current user query: ${task.query}`,
    "",
    `Available target tool schema: ${JSON.stringify(task.targetToolSchema)}`,
    "",
    "Return exactly one JSON object with this shape: {\"name\":\"tool name\",\"arguments\":{...}}. Do not add markdown or explanation.",
  ].join("\n");
}

export function parseMem2ActToolAction(text: string): ParsedToolAction {
  const stripped = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("Mem2Act action parser found no JSON object");
  const value = JSON.parse(stripped.slice(start, end + 1)) as unknown;
  if (!isRecord(value) || typeof value.name !== "string" || !isRecord(value.arguments)) throw new Error("Mem2Act action must contain string name and object arguments");
  return { name: value.name, arguments: value.arguments };
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function historyContains(history: Mem2ActTurn[], sourceText: string | undefined): boolean {
  if (!sourceText?.trim()) return false;
  return history.some((turn) => typeof turn.content === "string" && turn.content.includes(sourceText));
}

export function verifyMem2ActAction(task: Mem2ActProbeTask, action: ParsedToolAction): Mem2ActVerification {
  const nameMatch = action.name === task.goldToolCall.name;
  const argumentsMatch = canonical(action.arguments) === canonical(task.goldToolCall.arguments);
  const groundedArgumentKeys: string[] = [];
  const ungroundedArgumentKeys: string[] = [];
  for (const [key, expected] of Object.entries(task.goldToolCall.arguments)) {
    const ground = task.goldToolCall.grounding_info?.[key];
    const predictionMatches = canonical(action.arguments[key]) === canonical(expected);
    (predictionMatches && historyContains(task.history, ground?.source_text) ? groundedArgumentKeys : ungroundedArgumentKeys).push(key);
  }
  const trajectory = new EvaluationTrajectory();
  trajectory.append("TURN_STARTED", { environment: "Mem2ActBench/toolmembench_small", qaId: task.qaId });
  trajectory.append("RECALL_COMPLETED", { sourceConversationIds: task.sourceConversationIds, historyEventCount: task.history.length,
    promptInputHash: task.promptInputHash, goldVisibleToAgent: false });
  const actionEvent = trajectory.append("ACTION_OBSERVED", { actionKind: "TOOL_CALL", toolName: action.name, toolArguments: action.arguments });
  const verifierEventId = randomUUID();
  const exactMatch = nameMatch && argumentsMatch;
  trajectory.finalize(exactMatch, { verifierEventId, verifier: "EXACT_TOOL_NAME_AND_DEEP_ARGUMENT_EQUALITY", outcome: exactMatch ? "SUCCESS" : "FAILURE" });
  trajectory.assertFinalized();
  const evidence: BehaviorEvidence[] = [
    ...task.sourceConversationIds.map((sourceId) => ({ tier: "E0" as const, sourceRef: sourceId, fact: `History source ${sourceId} was supplied to the action probe`, supported: true })),
    { version: BEHAVIOR_EVIDENCE_VERSION, tier: "E1", actionEventId: actionEvent.eventId,
      memoryGroupId: `mem2act-history:${task.qaId}`, relation: groundedArgumentKeys.length > 0 ? "USED" : "NO_LINK",
      rationale: groundedArgumentKeys.length > 0 ? `Observed action used grounded history arguments: ${groundedArgumentKeys.join(", ")}` : "No predicted argument was both gold-matching and traceable to declared history text" },
    { version: BEHAVIOR_EVIDENCE_VERSION, tier: "E2", verifierEventId, actionEventIds: [actionEvent.eventId],
      outcome: exactMatch ? "SUCCESS" : "FAILURE", score: exactMatch ? 1 : 0,
      reason: `Programmatic verifier: nameMatch=${nameMatch}; argumentsMatch=${argumentsMatch}` },
  ];
  const capabilities: CapabilityRecord[] = [
    { component: "mem2act", capability: "agentTrajectory", status: "AVAILABLE" },
    { component: "mem2act", capability: "toolAction", status: "AVAILABLE" },
    { component: "mem2act", capability: "toolArgs", status: "AVAILABLE" },
    { component: "mem2act", capability: "programmaticVerifier", status: "AVAILABLE" },
    { component: "mem2act", capability: "userRevision", status: "UNAVAILABLE", reason: "This probe is tool-action grounded, not a revision-feedback environment" },
  ];
  const integrity: IntegrityCheck[] = [
    { check: "GOLD_NOT_IN_AGENT_PROMPT", passed: true, details: "Gold tool_call is held by the verifier only" },
    { check: "STRUCTURED_TOOL_ACTION_OBSERVED", passed: true, details: action.name },
    { check: "PROGRAMMATIC_VERIFIER_EXECUTED", passed: true, details: exactMatch ? "SUCCESS" : "FAILURE" },
    { check: "CORE_SCHEMA_REWRITE_REQUIRED", passed: true, details: "No: represented by existing EvaluationTrajectory and E0/E1/E2 evidence" },
  ];
  const episodeResult: EvaluationEpisodeResult = { episodeId: task.qaId, evidence, revisionPairs: [], probes: [], longitudinal: [], trialOutcomes: [], costs: [], integrity, capabilities };
  return { exactMatch, nameMatch, argumentsMatch, groundedArgumentKeys, ungroundedArgumentKeys,
    evidence, trajectory: trajectory.events, episodeResult, capabilities };
}

export function mem2ActEnvironmentDescriptor() {
  return { version: MEM2ACT_ENVIRONMENT_VERSION, environmentId: "Mem2ActBench/toolmembench_small",
    domain: "memory-grounded tool selection and argument generation", taskUnit: "one QA record joined to source conversation turns",
    historyStructure: "ordered turns selected by source_conversation_ids/source_id", actionSpace: "one target tool schema",
    outcomeVerifier: "exact tool name plus recursively canonicalized argument equality", memoryAccessPolicy: "DECLARED_HISTORY_CONTEXT_ONLY",
    networkToolExecution: false, externalSideEffects: false };
}
