import { createHash } from "node:crypto";
import type { EvalCase } from "./types.js";
import { matchRequestGuards } from "./request-guards.js";

const LABEL_LEAKAGE_PATTERNS: RegExp[] = [
  /(?:请|不要|无需|必须)(?:调用|使用|加载|检索).{0,30}(?:skill|工具|知识库|memory|记忆)/iu,
  /(?:列表中没有|列表无匹配|没有匹配项).{0,20}(?:skill|技能)/iu,
  /(?:只是变量名|只是注释|只是文本|不涉及我们的对话)/iu,
  /\b(?:call|use|load|avoid)\s+(?:the\s+)?(?:skill|memory|knowledge)\b/iu,
];

export interface DatasetValidationSummary {
  cases: number;
  base_scenarios: number;
  by_track: Record<string, number>;
  by_provenance: Record<string, number>;
}

export function validateDatasetFreeze(
  datasetContent: string,
  manifestContent: string | undefined,
  requireFrozen: boolean,
): { hash_matches: boolean; review_status: string | null } {
  if (!manifestContent) {
    if (requireFrozen) throw new Error("Approved dataset requires a frozen manifest");
    return { hash_matches: false, review_status: null };
  }
  const manifest = JSON.parse(manifestContent) as { dataset_sha256?: string; review_status?: string };
  const actual = createHash("sha256").update(datasetContent).digest("hex");
  const hashMatches = manifest.dataset_sha256 === actual;
  if (!hashMatches) throw new Error("Dataset SHA-256 does not match its manifest");
  if (requireFrozen && manifest.review_status !== "approved-frozen") {
    throw new Error("Approved dataset manifest must have review_status=approved-frozen");
  }
  return { hash_matches: true, review_status: manifest.review_status ?? null };
}

function increment(target: Record<string, number>, key: string): void {
  target[key] = (target[key] ?? 0) + 1;
}

/** Preparation/allow lists never declare a necessary event. */
export function hasNecessaryRoute(expected: EvalCase["expected"]): boolean {
  const named = (tool: string) => typeof tool === "string" && tool.trim().length > 0;
  return Boolean(expected.tools?.some(named) || expected.tools_all?.some(named)
    || expected.acceptable_routes?.some((route) => route.length > 0 && route.every(named))
    || expected.required_events?.some((event) => event.any_of_tools.some(named)));
}

export function validateEvalDataset(cases: EvalCase[]): DatasetValidationSummary {
  const errors: string[] = [];
  const ids = new Set<string>();
  const splitByBase = new Map<string, Set<string>>();
  const casesByBase = new Map<string, EvalCase[]>();
  const byTrack: Record<string, number> = {};
  const byProvenance: Record<string, number> = {};

  for (const testCase of cases) {
    if (ids.has(testCase.id)) errors.push(`${testCase.id}: duplicate case id`);
    ids.add(testCase.id);
    const baseId = testCase.base_scenario_id ?? testCase.id;
    const splits = splitByBase.get(baseId) ?? new Set<string>();
    splits.add(testCase.split);
    splitByBase.set(baseId, splits);

    const variants = casesByBase.get(baseId) ?? [];
    variants.push(testCase);
    casesByBase.set(baseId, variants);
    increment(byTrack, testCase.track ?? "missing");
    increment(byProvenance, testCase.provenance.kind);
    if (!testCase.messages.length) errors.push(`${testCase.id}: case is missing messages`);
    if (testCase.messages.at(-1)?.role !== "user") errors.push(`${testCase.id}: final message must be user`);
    const policy = testCase.expected.route_policy;
    if (testCase.expected.allow_post_validation_extract && (!testCase.coding_expectation?.read_paths?.length
      || !testCase.coding_expectation.changed_paths?.length || !testCase.coding_expectation.test_command)) {
      errors.push(`${testCase.id}: post-validation extraction requires explicit read/change/test expectations`);
    }
    if (policy === "required" && !hasNecessaryRoute(testCase.expected)) {
      errors.push(`${testCase.id}: required route must declare necessary tools, tools_all, acceptable_routes or required_events; allowed_tools is not sufficient`);
    }
    if (testCase.expected.must_precede_local_action && policy !== "required") {
      errors.push(`${testCase.id}: must_precede_local_action is only valid for required routes`);
    }
    if (testCase.expected.acceptable_routes?.some((route) => route.length === 0)) {
      errors.push(`${testCase.id}: acceptable_routes cannot contain an empty route`);
    }
    if (testCase.expected.required_events?.some((event) => !event.any_of_tools.length)) {
      errors.push(`${testCase.id}: required_events cannot contain an empty any_of_tools`);
    }
    const stepIds = new Set<string>();
    for (const step of testCase.mock_steps ?? []) {
      if (!step.id || stepIds.has(step.id)) errors.push(`${testCase.id}: duplicate or empty fixture step id`);
      stepIds.add(step.id);
      try { matchRequestGuards({}, step.request_guards); }
      catch (error) { errors.push(`${testCase.id}: invalid fixture request guard: ${(error as Error).message}`); }
    }
    for (const step of testCase.mock_steps ?? []) {
      if (step.requires?.some((id) => !stepIds.has(id) || id === step.id)) {
        errors.push(`${testCase.id}: fixture prerequisite is missing or self-referential`);
      }
    }
    const allowedArgumentKeys = new Set<string>();
    for (const argument of testCase.expected.allowed_arguments ?? []) {
      const key = `${argument.tool}\u0000${argument.field}`;
      if (!argument.tool?.trim() || !argument.field?.trim() || !argument.one_of?.length
        || argument.one_of.some((value) => !["string", "number", "boolean"].includes(typeof value)
          || (typeof value === "number" && !Number.isFinite(value))) || allowedArgumentKeys.has(key)) {
        errors.push(`${testCase.id}: allowed_arguments must have unique tool/field pairs and nonempty scalar choices`);
      }
      allowedArgumentKeys.add(key);
    }
    if (testCase.track === "core" && testCase.provenance.prompt_transformation === "synthetic") {
      errors.push(`${testCase.id}: synthetic prompt is not allowed in the core track`);
    }
    if (!["zh-native", "zh-adapted"].includes(testCase.language_track)) {
      errors.push(`${testCase.id}: unsupported language_track`);
    }
    if (testCase.language_track === "zh-native") {
      if (testCase.provenance.language_origin !== "native-zh") {
        errors.push(`${testCase.id}: zh-native case must declare provenance.language_origin=native-zh`);
      }
      if (testCase.schema_version === 2 && (testCase.provenance.source_release_year ?? 0) < 2025) {
        errors.push(`${testCase.id}: zh-native pilot source must be released in 2025 or later`);
      }
      if (testCase.provenance.prompt_transformation === "translated") {
        errors.push(`${testCase.id}: translated prompts are not allowed in the zh-native track`);
      }
      if (!/[\p{Script=Han}]/u.test(testCase.messages.at(-1)?.content ?? "")) {
        errors.push(`${testCase.id}: zh-native final user message must contain Chinese text`);
      }
      const descriptions = (testCase.skill_menu ?? []).map((skill) => skill.description);
      const chineseDescriptions = descriptions.filter((description) => /[\p{Script=Han}]/u.test(description));
      if (descriptions.length > 0 && chineseDescriptions.length / descriptions.length < 0.9) {
        errors.push(`${testCase.id}: at least 90% of injected skill descriptions must contain Chinese text`);
      }
    }
    if (testCase.language_track === "zh-adapted") {
      if (!["translated-zh", "native-en", "mixed"].includes(testCase.provenance.language_origin ?? "")
        || !/[\p{Script=Han}]/u.test(testCase.messages.at(-1)?.content ?? "")) {
        errors.push(`${testCase.id}: zh-adapted requires non-native Chinese provenance and a Chinese final user message`);
      }
    }
    const names = (testCase.skill_menu ?? []).map((skill) => skill.name);
    if (new Set(names).size !== names.length) errors.push(`${testCase.id}: duplicate skill names in menu`);
    const finalPrompt = testCase.messages.at(-1)?.content ?? "";
    if (testCase.track === "core" && LABEL_LEAKAGE_PATTERNS.some((pattern) => pattern.test(finalPrompt))) {
      errors.push(`${testCase.id}: possible label leakage in final user prompt`);
    }
    const pendingToolIds = new Set<string>();
    for (const message of testCase.messages) {
      if (message.role === "assistant") {
        for (const call of message.tool_calls ?? []) pendingToolIds.add(call.id);
      } else if (message.role === "tool") {
        if (!message.tool_call_id || !pendingToolIds.delete(message.tool_call_id)) {
          errors.push(`${testCase.id}: tool result has no matching preceding call`);
        }
      } else if (pendingToolIds.size) {
        errors.push(`${testCase.id}: user message precedes outstanding tool results`);
      }
    }
    if (pendingToolIds.size) errors.push(`${testCase.id}: incomplete historical tool exchange`);
  }

  for (const [baseId, splits] of splitByBase) {
    if (splits.size > 1) errors.push(`${baseId}: counterfactual base appears in multiple splits`);
  }
  const promptOwners = new Map<string, string>();
  for (const [baseId, variants] of casesByBase) {
    const legacyMenuPair = variants.every((testCase) => testCase.schema_version === 2);
    if (legacyMenuPair && variants.length !== 2) errors.push(`${baseId}: counterfactual base must contain exactly two cases`);
    const menuSizes = variants.map((testCase) => testCase.skill_menu?.length ?? 0).sort((a, b) => a - b);
    if (legacyMenuPair && menuSizes.join(",") !== "50,100") errors.push(`${baseId}: variants must be the K50/K100 pair`);
    const promptKeys = new Set(variants.map((testCase) => JSON.stringify(testCase.messages)));
    if (legacyMenuPair && promptKeys.size !== 1) errors.push(`${baseId}: K50/K100 variants must keep identical conversation text`);
    const policies = new Set(variants.map((testCase) => testCase.expected.route_policy));
    if (legacyMenuPair && policies.size !== 1) errors.push(`${baseId}: K50/K100 variants must keep identical route policy`);
    if (!legacyMenuPair && variants.filter((testCase) => testCase.primary_condition).length > 1) {
      errors.push(`${baseId}: multiple primary conditions would inflate independent sample count`);
    }
    for (const promptKey of promptKeys) {
      const previousOwner = promptOwners.get(promptKey);
      if (previousOwner && previousOwner !== baseId) {
        errors.push(`${baseId}: conversation duplicates unrelated base ${previousOwner}`);
      } else {
        promptOwners.set(promptKey, baseId);
      }
    }
  }
  if (errors.length) throw new Error(`Dataset validation failed:\n- ${errors.join("\n- ")}`);
  return {
    cases: cases.length,
    base_scenarios: splitByBase.size,
    by_track: byTrack,
    by_provenance: byProvenance,
  };
}
