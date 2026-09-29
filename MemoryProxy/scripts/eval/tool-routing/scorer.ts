import type { EvalCase, RunRecord, ParsedCall } from "./types.js";
import { conservativePairedBounds, exactBinomialUpper } from "./statistics.js";
import { hasNecessaryRoute } from "./dataset.js";

export interface ScoredRecord extends RunRecord {
  positive_false_call: boolean;
  no_progress_or_early_abort: boolean;
  budget_exhausted: boolean;
  track: string;
  provenance_kind: string;
  skill_menu_size: number;
  scoring_window_calls: number;
  route_policy: "required" | "forbidden" | "optional";
  called: boolean;
  required_call_observed: boolean;
  route_complete: boolean;
  clean_route_success: boolean;
  optional_route_observed: boolean;
  false_call: boolean;
  non_cloud_bash_call: boolean;
  family_correct: boolean;
  tool_correct: boolean;
  endpoint_correct: boolean;
  body_correct: boolean;
  protocol_correct: boolean;
  has_argument_expectation: boolean;
  argument_correct: boolean;
  has_first_action_expectation: boolean;
  first_action_correct: boolean;
  has_milestone_expectation: boolean;
  milestone_complete: boolean;
  has_forbidden_expectation: boolean;
  forbidden_call: boolean;
}

function inferredFamily(call: RunRecord["calls"][number]): "memory" | "skill" | "knowledge" | undefined {
  if (call.family) return call.family;
  // Legacy malformed curl records may lack a parsed family. Inspect the request
  // target, not arbitrary source code or printed curl examples in a local command.
  const target = call.endpoint ?? call.url ?? (/^\s*(?:\S*\/)?curl(?:\s|$)/.test(call.command)
    ? call.command.match(/https?:\/\/[^\s'"]+/)?.[0] ?? "" : "");
  if (target.includes("/memory-bridge/")) return "memory";
  if (target.includes("/skill-bridge/")) return "skill";
  if (target.includes("/tools/list") || target.includes("/tools/call")) return "knowledge";
  return undefined;
}

/** Dot-separated object paths for deterministic resource identifiers, e.g. params.page_id. */
function argumentValue(body: Record<string, unknown> | undefined, field: string): unknown {
  let value: unknown = body;
  for (const key of field.split(".")) {
    if (value === null || typeof value !== "object" || !Object.hasOwn(value, key)) return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

/** Only explicit resource identities establish irrelevance; query semantics are not inferred. */
function resourceArgumentMismatch(call: ParsedCall, argument: { field: string; one_of: Array<string | number | boolean> }): boolean {
  const key = argument.field.split(".").at(-1)!;
  if (!/^(?:id|path|\w+_id|\w+_name)$/.test(key)) return false;
  const actual = argumentValue(call.body, argument.field);
  // Missing/empty/ill-typed identifiers are protocol errors, not evidence of a different resource.
  return typeof actual === "string" && actual.trim().length > 0
    && !argument.one_of.some((value) => Object.is(actual, value));
}

/** Score the entire recorded observation window, including every action in the terminal batch. */
export function scoreRecord(record: RunRecord, testCase: EvalCase): ScoredRecord {
  const routeCalls = record.calls;
  const expected = testCase.expected;
  const cloudCalls = routeCalls.filter((call) => inferredFamily(call));
  const called = cloudCalls.length > 0;
  const routePolicy = expected.route_policy;
  const events = expected.required_events ?? [];
  const wrongResource = (call: ParsedCall) => {
    if ((expected.arguments ?? []).some((argument) => argument.tool === call.tool && resourceArgumentMismatch(call, argument))) return true;
    const toolEvents = events.filter((event) => call.tool && event.any_of_tools.includes(call.tool));
    // Multiple required events may legitimately read distinct resources with the same tool.
    return toolEvents.length > 0 && toolEvents.every((event) =>
      (event.arguments ?? []).some((argument) => resourceArgumentMismatch(call, argument)));
  };
  const endpointMatches = (call: ParsedCall, endpoints?: string[]) => !endpoints?.length
    || endpoints.some((endpoint) => call.endpoint === endpoint || call.endpoint?.endsWith(endpoint));
  const bodyMatches = (call: ParsedCall, keys?: string[]) => !keys?.length
    || keys.every((key) => Object.hasOwn(call.body ?? {}, key));
  const legacyArgumentsMatch = (call: ParsedCall) => (expected.arguments ?? [])
    .filter((argument) => argument.tool === call.tool)
    .every((argument) => argument.one_of.some((value) => Object.is(argumentValue(call.body, argument.field), value)));
  // All constraints are evaluated on this same concrete call, never spliced from several attempts.
  const legacyContractMatches = (call: ParsedCall) => call.protocol_valid && call.semantic_relevance !== "irrelevant"
    && (!expected.family || inferredFamily(call) === expected.family)
    && endpointMatches(call, expected.endpoints) && bodyMatches(call, expected.body_requires)
    && legacyArgumentsMatch(call);
  const validLegacyCalls = cloudCalls.filter(legacyContractMatches);
  const firstCloud = cloudCalls[0];
  const firstEventTools = (expected.required_events ?? []).filter((event) => !event.after?.length)
    .flatMap((event) => event.any_of_tools);
  const entryTools = expected.first_tools?.length ? expected.first_tools
    : firstEventTools.length ? firstEventTools
      : expected.acceptable_routes?.length ? expected.acceptable_routes.map((route) => route[0]).filter(Boolean)
        : [...(expected.tools ?? []), ...(expected.allowed_tools ?? [])];
  const familyCorrect = Boolean(firstCloud && (!expected.family || inferredFamily(firstCloud) === expected.family));
  const toolCorrect = Boolean(firstCloud && (!entryTools.length || Boolean(firstCloud.tool && entryTools.includes(firstCloud.tool)))
    && (!expected.family || inferredFamily(firstCloud) === expected.family) && !wrongResource(firstCloud));
  const endpointCorrect = !expected.endpoints?.length || expected.endpoints.every((endpoint) =>
    validLegacyCalls.some((call) => endpointMatches(call, [endpoint])));
  const bodyCorrect = !expected.body_requires?.length || validLegacyCalls.some((call) =>
    (!expected.tools?.length || Boolean(call.tool && expected.tools.includes(call.tool))));
  const hasArgumentExpectation = Boolean(expected.arguments?.length
    || expected.required_events?.some((event) => event.arguments?.length));
  const hasFirstActionExpectation = Boolean(expected.first_tools?.length || expected.must_precede_local_action);
  const observedFirstTool = record.first_action?.kind === "cloud_tool"
    ? record.first_action.tool : (record.first_action ? undefined : routeCalls[0]?.tool);
  const firstActionCorrect = !hasFirstActionExpectation
    || (expected.first_tools?.length ? Boolean(observedFirstTool && expected.first_tools.includes(observedFirstTool))
      : record.first_action ? record.first_action.kind === "cloud_tool"
        : Boolean(routeCalls[0] && inferredFamily(routeCalls[0])));
  const acceptableRouteCorrect = !expected.acceptable_routes?.length
    || expected.acceptable_routes.some((route) => {
      let cursor = 0;
      for (const call of cloudCalls) {
        if (legacyContractMatches(call) && call.tool === route[cursor]) cursor++;
        if (cursor === route.length) return true;
      }
      return false;
    });
  const milestonePositions = new Map<string, { first: number; last: number }>();
  for (const milestone of expected.milestones ?? []) {
    const positions = [
      ...(milestone.fixture_steps ?? []).map((step) => routeCalls.findIndex((call) =>
        legacyContractMatches(call) && call.fixture_step_id === step)),
      ...(milestone.tools ?? []).map((tool) => routeCalls.findIndex((call) =>
        legacyContractMatches(call) && call.tool === tool)),
    ];
    if (positions.length && positions.every((position) => position >= 0)) {
      milestonePositions.set(milestone.id, { first: Math.min(...positions), last: Math.max(...positions) });
    }
  }
  const hasMilestoneExpectation = Boolean(expected.milestones?.length);
  const milestoneComplete = (expected.milestones ?? []).every((milestone) => {
    const position = milestonePositions.get(milestone.id);
    return Boolean(position && (milestone.after ?? []).every((dependency) => {
      const previous = milestonePositions.get(dependency);
      return previous && previous.last < position.first;
    }));
  });
  const eventPositions = new Map<string, number>();
  for (let pass = 0; pass < events.length; pass++) {
    for (const event of events) {
      if (eventPositions.has(event.id) || event.after?.some((id) => !eventPositions.has(id))) continue;
      const after = Math.max(-1, ...(event.after ?? []).map((id) => eventPositions.get(id)!));
      const position = routeCalls.findIndex((call, index) => index > after && call.protocol_valid && call.semantic_relevance !== "irrelevant"
        && Boolean(call.tool && event.any_of_tools.includes(call.tool))
        && (!(event.family ?? expected.family) || inferredFamily(call) === (event.family ?? expected.family))
        && endpointMatches(call, event.endpoints ?? expected.endpoints)
        && bodyMatches(call, event.body_requires ?? expected.body_requires) && legacyArgumentsMatch(call)
        && (event.arguments ?? []).every((argument) => argument.one_of.some((value) =>
          Object.is(argumentValue(call.body, argument.field), value))));
      if (position >= 0) eventPositions.set(event.id, position);
    }
  }
  const requiredToolsObserved = (!expected.tools?.length || validLegacyCalls.some((call) =>
    Boolean(call.tool && expected.tools?.includes(call.tool))))
    && (expected.tools_all ?? []).every((tool) => validLegacyCalls.some((call) => call.tool === tool));
  const legacyRequiredObserved = hasNecessaryRoute(expected) && requiredToolsObserved
    && validLegacyCalls.length > 0 && endpointCorrect && bodyCorrect;
  const eventComplete = events.length > 0 ? eventPositions.size === events.length : legacyRequiredObserved;
  // A constraint attached to an unused alternative does not require invoking that alternative.
  // The selected tools/routes/events already match every applicable argument on one call.
  const relevantTools = new Set([...(expected.tools ?? []), ...(expected.tools_all ?? []), ...(expected.acceptable_routes ?? []).flat()]);
  const argumentCorrect = !expected.arguments?.length || (events.length > 0 ? eventComplete
    : requiredToolsObserved && acceptableRouteCorrect && validLegacyCalls.some((call) => Boolean(call.tool
      && (relevantTools.size > 0 ? relevantTools.has(call.tool)
        : expected.arguments!.some((argument) => argument.tool === call.tool)))));
  const routeComplete = routePolicy === "required" && hasNecessaryRoute(expected) && eventComplete
    && firstActionCorrect && acceptableRouteCorrect && milestoneComplete;
  const allowedTools = new Set([
    ...(expected.allowed_tools ?? []), ...(expected.tools ?? []), ...(expected.tools_all ?? []),
    ...(expected.first_tools ?? []), ...events.flatMap((event) => event.any_of_tools),
    ...(expected.acceptable_routes ?? []).flat(), ...(expected.arguments ?? []).map((argument) => argument.tool),
    ...(testCase.mock_steps ?? []).filter((step) => (expected.milestones ?? [])
      .some((milestone) => milestone.fixture_steps?.includes(step.id))).map((step) => step.tool),
  ]);
  const hasExplicitAllowedSet = allowedTools.size > 0 || Boolean(expected.allowed_families?.length);
  let postValidationExtractObserved = false;
  const forbiddenCall = cloudCalls.some((call) => {
    if (call.semantic_relevance === "irrelevant") return true;
    if (expected.allow_post_validation_extract && call.tool === "skill_extract"
      && call.protocol_valid && call.coding_validated_before_call && !postValidationExtractObserved) {
      postValidationExtractObserved = true;
      return false;
    }
    const family = inferredFamily(call)!;
    if (expected.forbidden_families?.includes(family)
      || Boolean(call.tool && expected.forbidden_tools?.includes(call.tool))) return true;
    if (routePolicy === "forbidden") return true;
    if (routePolicy !== "required") return false;
    if ((expected.allowed_arguments ?? []).some((argument) => {
      if (argument.tool !== call.tool) return false;
      const actual = argumentValue(call.body, argument.field);
      // A supplied, well-typed value outside a frozen semantic scope is an
      // unrelated request. Missing/malformed arguments remain protocol failures.
      return ["string", "number", "boolean"].includes(typeof actual)
        && !(typeof actual === "string" && !actual.trim())
        && !argument.one_of.some((value) => Object.is(actual, value));
    })) return true;
    if (wrongResource(call)) return true;
    if (hasExplicitAllowedSet) return !Boolean(call.tool && allowedTools.has(call.tool))
      && !Boolean(expected.allowed_families?.includes(family));
    return Boolean(expected.family && family !== expected.family);
  });
  return {
    ...record,
    track: testCase.track,
    provenance_kind: testCase.provenance.kind,
    skill_menu_size: testCase.skill_menu?.length ?? 0,
    scoring_window_calls: routeCalls.length,
    route_policy: routePolicy,
    called,
    required_call_observed: routeComplete,
    route_complete: routeComplete,
    clean_route_success: routeComplete && !forbiddenCall,
    positive_false_call: routePolicy === "required" && forbiddenCall,
    no_progress_or_early_abort: record.coding_progress?.no_progress_or_early_abort ?? false,
    budget_exhausted: record.termination_reason === "budget_exhausted",
    optional_route_observed: routePolicy === "optional" && called,
    false_call: routePolicy === "forbidden" && forbiddenCall,
    non_cloud_bash_call: routeCalls.some((call) => !inferredFamily(call)),
    family_correct: routePolicy === "required" && familyCorrect,
    tool_correct: routePolicy === "required" && toolCorrect,
    endpoint_correct: routePolicy === "required" && endpointCorrect,
    body_correct: routePolicy === "required" && bodyCorrect,
    protocol_correct: routePolicy === "required" && cloudCalls.length > 0 && cloudCalls.every((call) => call.protocol_valid),
    has_argument_expectation: hasArgumentExpectation,
    argument_correct: routePolicy === "required" && argumentCorrect
      && (events.length === 0 || eventComplete),
    has_first_action_expectation: hasFirstActionExpectation,
    first_action_correct: routePolicy === "required" && firstActionCorrect,
    has_milestone_expectation: hasMilestoneExpectation,
    milestone_complete: routePolicy === "required" && milestoneComplete,
    has_forbidden_expectation: routePolicy === "forbidden" || routePolicy === "required"
      || Boolean(expected.forbidden_families?.length || expected.forbidden_tools?.length),
    forbidden_call: forbiddenCall,
  };
}

function rate(rows: ScoredRecord[], key: keyof ScoredRecord, filter: (r: ScoredRecord) => boolean): number | null {
  const selected = rows.filter(filter);
  if (!selected.length) return null;
  return selected.filter((row) => Boolean(row[key])).length / selected.length;
}

function aggregate(rows: ScoredRecord[]) {
  const validRows = rows.filter((row) => !row.error);
  const positives = (r: ScoredRecord) => r.route_policy === "required";
  const negatives = (r: ScoredRecord) => r.route_policy === "forbidden";
  const optional = (r: ScoredRecord) => r.route_policy === "optional";
  return {
    runs: rows.length,
    valid_runs: validRows.length,
    failed_runs: rows.length - validRows.length,
    observed_false_calls_including_incomplete: rows.filter((row) => row.false_call).length,
    observed_positive_false_calls_including_incomplete: rows.filter((row) => row.positive_false_call).length,
    unique_cases: new Set(validRows.map((r) => r.case_id)).size,
    denominators: { required: validRows.filter(positives).length, forbidden: validRows.filter(negatives).length,
      attempted_required: validRows.filter((r) => positives(r) && r.called).length,
      coding_progress: validRows.filter((r) => Boolean(r.coding_progress)).length, budget_exhausted: validRows.length },
    required_call_recall: rate(validRows, "required_call_observed", positives),
    route_completion_rate: rate(validRows, "route_complete", positives),
    clean_route_success_rate: rate(validRows, "clean_route_success", positives),
    false_call_rate: rate(validRows, "false_call", negatives),
    positive_false_call_rate: rate(validRows, "positive_false_call", positives),
    no_progress_or_early_abort_rate: rate(validRows, "no_progress_or_early_abort", (r) => Boolean(r.coding_progress)),
    budget_exhausted_rate: rate(validRows, "budget_exhausted", () => true),
    optional_route_observation_rate: rate(validRows, "optional_route_observed", optional),
    non_cloud_bash_call_rate: rate(validRows, "non_cloud_bash_call", negatives),
    family_selection_accuracy: rate(validRows, "family_correct", (r) => positives(r) && r.called),
    tool_selection_accuracy: rate(validRows, "tool_correct", (r) => positives(r) && r.called),
    endpoint_accuracy: rate(validRows, "endpoint_correct", (r) => positives(r) && r.called),
    body_accuracy: rate(validRows, "body_correct", (r) => positives(r) && r.called),
    protocol_accuracy: rate(validRows, "protocol_correct", (r) => positives(r) && r.called),
    argument_accuracy: rate(validRows, "argument_correct", (r) => positives(r) && r.called && r.has_argument_expectation),
    first_action_accuracy: rate(validRows, "first_action_correct", (r) => positives(r) && r.has_first_action_expectation),
    milestone_completion_rate: rate(validRows, "milestone_complete", (r) => positives(r) && r.has_milestone_expectation),
    forbidden_call_rate: rate(validRows, "forbidden_call", (r) => r.has_forbidden_expectation),
    mean_prompt_tokens: validRows.some((r) => r.prompt_tokens !== undefined)
      ? average(validRows.flatMap((r) => r.prompt_tokens === undefined ? [] : [r.prompt_tokens]))
      : null,
    mean_prompt_chars: rows.reduce((sum, r) => sum + r.prompt_chars, 0) / Math.max(rows.length, 1),
  };
}

function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = seed + 0x6d2b79f5 | 0;
    let value = Math.imul(seed ^ seed >>> 15, 1 | seed);
    value = value + Math.imul(value ^ value >>> 7, 61 | value) ^ value;
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}

function pairedClusterCi(
  rows: ScoredRecord[],
  metric: "required_call_observed" | "route_complete" | "clean_route_success" | "false_call" | "tool_correct",
  iterations = 2000,
  filter: (row: ScoredRecord) => boolean = () => true,
): { difference: number; ci95: [number, number]; clusters: number } | null {
  const byCase = new Map<string, { baseline: number[]; candidate: number[] }>();
  for (const row of rows) {
    if (row.error || !filter(row)) continue;
    const eligible = metric === "false_call"
      ? row.route_policy === "forbidden"
      : row.route_policy === "required" && (metric !== "tool_correct" || row.called);
    if (!eligible) continue;
    const clusterId = row.base_scenario_id ?? row.case_id;
    const cluster = byCase.get(clusterId) ?? { baseline: [], candidate: [] };
    cluster[row.variant].push(Number(Boolean(row[metric])));
    byCase.set(clusterId, cluster);
  }
  const pairs = [...byCase.values()].filter((v) => v.baseline.length && v.candidate.length)
    .map((v) => average(v.candidate) - average(v.baseline));
  if (!pairs.length) return null;
  const random = mulberry32(20260825);
  const samples: number[] = [];
  for (let i = 0; i < iterations; i++) {
    let sum = 0;
    for (let j = 0; j < pairs.length; j++) sum += pairs[Math.floor(random() * pairs.length)];
    samples.push(sum / pairs.length);
  }
  samples.sort((a, b) => a - b);
  return {
    difference: average(pairs),
    ci95: [samples[Math.floor(iterations * 0.025)], samples[Math.floor(iterations * 0.975)]],
    clusters: pairs.length,
  };
}

function pairedMenuSizeCi(
  rows: ScoredRecord[],
  variant: "baseline" | "candidate",
  metric: "route_complete" | "false_call" | "tool_correct",
  iterations = 2000,
): { difference: number; ci95: [number, number]; clusters: number } | null {
  const byBase = new Map<string, { 50: number[]; 100: number[] }>();
  for (const row of rows) {
    if (row.error || row.variant !== variant || (row.skill_menu_size !== 50 && row.skill_menu_size !== 100)) continue;
    const eligible = metric === "false_call"
      ? row.route_policy === "forbidden"
      : row.route_policy === "required" && (metric !== "tool_correct" || row.called);
    if (!eligible) continue;
    const baseId = row.base_scenario_id ?? row.case_id;
    const pair = byBase.get(baseId) ?? { 50: [], 100: [] };
    pair[row.skill_menu_size].push(Number(Boolean(row[metric])));
    byBase.set(baseId, pair);
  }
  const differences = [...byBase.values()]
    .filter((pair) => pair[50].length && pair[100].length)
    .map((pair) => average(pair[100]) - average(pair[50]));
  if (!differences.length) return null;
  const random = mulberry32(20260902 + (variant === "candidate" ? 1 : 0));
  const samples: number[] = [];
  for (let iteration = 0; iteration < iterations; iteration++) {
    let sum = 0;
    for (let index = 0; index < differences.length; index++) {
      sum += differences[Math.floor(random() * differences.length)];
    }
    samples.push(sum / differences.length);
  }
  samples.sort((left, right) => left - right);
  return {
    difference: average(differences),
    ci95: [samples[Math.floor(iterations * 0.025)], samples[Math.floor(iterations * 0.975)]],
    clusters: differences.length,
  };
}

function average(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function pairedPromptSavings(rows: ScoredRecord[]): number | null {
  const pairs = new Map<string, { baseline?: number; candidate?: number }>();
  for (const row of rows) {
    if (row.error || row.prompt_tokens === undefined) continue;
    const key = `${row.case_id}\u0000${row.repetition}`;
    const pair = pairs.get(key) ?? {};
    pair[row.variant] = row.prompt_tokens;
    pairs.set(key, pair);
  }
  const savings = [...pairs.values()]
    .filter((pair): pair is { baseline: number; candidate: number } =>
      pair.baseline !== undefined && pair.candidate !== undefined)
    .map((pair) => pair.baseline - pair.candidate);
  return savings.length ? average(savings) : null;
}

function worstPairedSystemPromptCharRatio(rows: ScoredRecord[]): number | null {
  const pairs = new Map<string, { baseline?: number; candidate?: number }>();
  for (const row of rows) {
    if (row.error) continue;
    const key = `${row.case_id}\u0000${row.repetition}`;
    const pair = pairs.get(key) ?? {};
    pair[row.variant] = row.prompt_chars;
    pairs.set(key, pair);
  }
  const ratios = [...pairs.values()].flatMap((pair) =>
    pair.baseline && pair.candidate !== undefined ? [pair.candidate / pair.baseline] : []);
  return ratios.length ? Math.max(...ratios) : null;
}

export type FormalMetric = "required_call_observed" | "clean_route_success" | "false_call"
  | "positive_false_call" | "no_progress_or_early_abort" | "budget_exhausted";
export type GateStatus = "pass" | "fail" | "insufficient";
export interface FormalMetricGate {
  id: string;
  metric: FormalMetric;
  /** One predeclared condition per independent base for this endpoint. */
  case_ids: string[];
  minimum_candidate_rate?: number;
  maximum_candidate_rate?: number;
  noninferiority_margin?: number;
  maximum_difference?: number;
  maximum_candidate_upper?: number;
  candidate_point_not_worse?: boolean;
}
export interface FormalEvaluationOptions {
  planned_jobs: Array<{ case_id: string; variant: RunRecord["variant"]; repetition: number; request_sha256?: string }>;
  primary_repetition: 1;
  expected_requested_model: string;
  allowed_actual_models: string[];
  expected_request_config: RunRecord["request_config"];
  experiment_sha256: string;
  alpha: number;
  gates: FormalMetricGate[];
  /** Token, contract, coding controls and cache have separate evidence producers. */
  external_gates?: Array<{ id: string; status: GateStatus; evidence: string }>;
}
export interface ReportOptions { formal?: FormalEvaluationOptions }

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value)
    .filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
function jobKey(job: { case_id: string; variant: string; repetition: number }): string {
  return `${job.case_id}\u0000${job.variant}\u0000${job.repetition}`;
}

function evaluateFormal(records: RunRecord[], cases: EvalCase[], formal: FormalEvaluationOptions) {
  const reasons: string[] = [];
  const add = (reason: string) => { if (!reasons.includes(reason)) reasons.push(reason); };
  const caseMap = new Map(cases.map((testCase) => [testCase.id, testCase]));
  if (caseMap.size !== cases.length) add("duplicate_case_ids");
  const plan = new Map(formal.planned_jobs.map((job) => [jobKey(job), job]));
  if (!plan.size || plan.size !== formal.planned_jobs.length) add("empty_or_duplicate_planned_jobs");
  if (formal.primary_repetition !== 1) add("formal_primary_repetition_must_be_1");
  if (!(formal.alpha > 0 && formal.alpha < 1)) add("invalid_alpha");
  if (!formal.experiment_sha256 || !formal.expected_requested_model || !formal.allowed_actual_models.length) add("missing_frozen_identity");
  if (!formal.gates.length || new Set(formal.gates.map((gate) => gate.id)).size !== formal.gates.length) add("empty_or_duplicate_metric_gates");
  const externalIds = (formal.external_gates ?? []).map((gate) => gate.id);
  if (new Set([...formal.gates.map((gate) => gate.id), ...externalIds]).size !== formal.gates.length + externalIds.length) add("duplicate_gate_ids");
  for (const job of plan.values()) {
    const testCase = caseMap.get(job.case_id);
    if (!testCase || !Number.isInteger(job.repetition) || job.repetition < 1
      || !["baseline", "candidate"].includes(job.variant)) add("invalid_planned_job");
    if (testCase && (testCase.split !== "test" || testCase.review_status !== "approved")) add("planned_cases_must_be_approved_test");
    if (testCase?.expected.route_policy === "required" && !hasNecessaryRoute(testCase.expected)) add("invalid_required_route_label");
    if (typeof job.request_sha256 !== "string" || !job.request_sha256.trim()) add("missing_planned_request_fingerprint");
  }
  const byJob = new Map<string, RunRecord>();
  for (const record of records) {
    const key = jobKey(record);
    const planned = plan.get(key);
    if (!planned) add("unexpected_jobs");
    if (byJob.has(key)) add("duplicate_logical_jobs_use_transport_attempts_instead");
    byJob.set(key, record);
    const testCase = caseMap.get(record.case_id);
    if (!testCase || record.split !== testCase.split || record.category !== testCase.category
      || (record.base_scenario_id ?? record.case_id) !== (testCase.base_scenario_id ?? testCase.id)) add("record_case_metadata_mismatch");
    if (record.error || record.window_complete !== true) add("unresolved_or_incomplete_windows");
    if (record.requested_model !== formal.expected_requested_model
      || !record.actual_model || !formal.allowed_actual_models.includes(record.actual_model)) add("model_identity_mismatch");
    if (canonicalJson(record.request_config) !== canonicalJson(formal.expected_request_config)) add("request_config_mismatch");
    if (formal.expected_request_config.workspace_python_runtime_sha256 !== undefined
      && record.workspace_python_runtime_sha256 !== formal.expected_request_config.workspace_python_runtime_sha256) add("workspace_runtime_mismatch");
    if (record.experiment_sha256 !== formal.experiment_sha256) add("experiment_fingerprint_mismatch");
    if (!record.request_sha256 || record.request_sha256 !== planned?.request_sha256) add("request_fingerprint_mismatch");
  }
  if ([...plan.keys()].some((key) => !byJob.has(key))) add("missing_planned_jobs");
  const gateResults = formal.gates.map((gate) => {
    const localReasons: string[] = [];
    if (!["required_call_observed", "clean_route_success", "false_call", "positive_false_call", "no_progress_or_early_abort", "budget_exhausted"].includes(gate.metric)) localReasons.push("unknown_metric");
    if (!gate.case_ids.length || new Set(gate.case_ids).size !== gate.case_ids.length) localReasons.push("empty_or_duplicate_gate_cases");
    const clusters = new Set<string>();
    const pairs: Array<{ baseline: boolean; candidate: boolean }> = [];
    const thresholds = [gate.minimum_candidate_rate, gate.maximum_candidate_rate, gate.noninferiority_margin,
      gate.maximum_difference, gate.maximum_candidate_upper];
    if (!thresholds.some((value) => value !== undefined) && gate.candidate_point_not_worse !== true) localReasons.push("no_preregistered_threshold");
    if (thresholds.some((value) => value !== undefined && (!Number.isFinite(value) || value < 0 || value > 1))) localReasons.push("invalid_threshold");
    for (const caseId of gate.case_ids) {
      const testCase = caseMap.get(caseId);
      if (!testCase) { localReasons.push("unknown_gate_case"); continue; }
      const cluster = testCase.base_scenario_id ?? testCase.id;
      if (clusters.has(cluster)) localReasons.push("nonindependent_conditions_in_gate");
      clusters.add(cluster);
      const positiveMetric = ["required_call_observed", "clean_route_success", "positive_false_call"].includes(gate.metric);
      if ((positiveMetric && testCase.expected.route_policy !== "required")
        || (gate.metric === "false_call" && testCase.expected.route_policy !== "forbidden")) localReasons.push("metric_denominator_policy_mismatch");
      const baseline = byJob.get(jobKey({ case_id: caseId, variant: "baseline", repetition: formal.primary_repetition }));
      const candidate = byJob.get(jobKey({ case_id: caseId, variant: "candidate", repetition: formal.primary_repetition }));
      if (!baseline || !candidate) { localReasons.push("missing_primary_pair"); continue; }
      if (gate.metric === "no_progress_or_early_abort" && (!baseline.coding_progress || !candidate.coding_progress)) localReasons.push("missing_coding_progress");
      if (gate.metric === "budget_exhausted" && (!baseline.termination_reason || !candidate.termination_reason)) localReasons.push("missing_termination_reason");
      pairs.push({ baseline: scoreRecord(baseline, testCase)[gate.metric], candidate: scoreRecord(candidate, testCase)[gate.metric] });
    }
    if (localReasons.length || !(formal.alpha > 0 && formal.alpha < 1) || !pairs.length) {
      return { id: gate.id, metric: gate.metric, status: "insufficient" as GateStatus,
        reasons: [...new Set(localReasons)], statistics: null, candidate_upper: null };
    }
    const statistics = conservativePairedBounds(pairs, formal.alpha);
    const upper = exactBinomialUpper(pairs.filter((pair) => pair.candidate).length, pairs.length, formal.alpha);
    let status: GateStatus = "pass";
    const check = (pointPasses: boolean, boundPasses: boolean, reason: string) => {
      if (!pointPasses) { status = "fail"; localReasons.push(reason); }
      else if (!boundPasses) { if (status !== "fail") status = "insufficient"; localReasons.push(reason); }
    };
    if (gate.minimum_candidate_rate !== undefined) check(statistics.candidate_rate >= gate.minimum_candidate_rate, true, "candidate_below_point_floor");
    if (gate.maximum_candidate_rate !== undefined) check(statistics.candidate_rate <= gate.maximum_candidate_rate, true, "candidate_above_point_ceiling");
    if (gate.noninferiority_margin !== undefined) check(statistics.difference > -gate.noninferiority_margin,
      statistics.lower > -gate.noninferiority_margin, "noninferiority_not_established");
    if (gate.maximum_difference !== undefined) check(statistics.difference <= gate.maximum_difference,
      statistics.upper <= gate.maximum_difference, "difference_upper_exceeds_margin");
    if (gate.maximum_candidate_upper !== undefined) check(statistics.candidate_rate <= gate.maximum_candidate_upper,
      upper <= gate.maximum_candidate_upper, "absolute_upper_exceeds_limit");
    if (gate.candidate_point_not_worse) {
      const higherIsBetter = gate.metric === "required_call_observed" || gate.metric === "clean_route_success";
      check(higherIsBetter ? statistics.difference >= 0 : statistics.difference <= 0, true, "candidate_point_estimate_worse");
    }
    return { id: gate.id, metric: gate.metric, status, reasons: localReasons, statistics, candidate_upper: upper };
  });
  const externalGates = (formal.external_gates ?? []).map((gate) => ({ ...gate,
    status: gate.evidence?.trim() && ["pass", "fail", "insufficient"].includes(gate.status)
      ? gate.status : "insufficient" as GateStatus }));
  const statuses = [...gateResults, ...externalGates].map((gate) => gate.status);
  const status: GateStatus = reasons.length ? "insufficient"
    : statuses.includes("fail") ? "fail" : statuses.includes("insufficient") ? "insufficient" : "pass";
  return {
    status,
    scope: "Only the explicitly preregistered metric and external gates; omitted goals are not validated.",
    primary_repetition: formal.primary_repetition,
    integrity: { valid: reasons.length === 0, reasons, planned_jobs: plan.size, observed_jobs: byJob.size },
    gates: gateResults,
    external_gates: externalGates,
    statistical_method: "exact-discordant-event-bounds",
    statistical_limitation: "Each bound is one-sided; gains do not offset losses in the lower bound. Bootstrap summaries are diagnostic only. Independence and representativeness require dataset review.",
  };
}

export function buildReport(records: RunRecord[], cases: EvalCase[], options: ReportOptions = {}) {
  const allAttempts = records;
  const formalEvaluation = options.formal ? evaluateFormal(allAttempts, cases, options.formal) : null;
  // Incremental resume files may contain an older failed attempt followed by a
  // successful retry for the same logical job. Score only the latest attempt.
  const latest = new Map<string, RunRecord>();
  for (const record of records) {
    latest.set(`${record.case_id}\u0000${record.variant}\u0000${record.repetition}`, record);
  }
  records = [...latest.values()];
  const caseMap = new Map(cases.map((testCase) => [testCase.id, testCase]));
  const scored = records.map((record) => {
    const testCase = caseMap.get(record.case_id);
    if (!testCase) throw new Error(`Unknown case_id: ${record.case_id}`);
    const row = scoreRecord(record, testCase);
    const earlier = allAttempts.filter((attempt) => jobKey(attempt) === jobKey(record))
      .map((attempt) => scoreRecord(attempt, testCase));
    row.false_call ||= earlier.some((attempt) => attempt.false_call);
    row.positive_false_call ||= earlier.some((attempt) => attempt.positive_false_call);
    row.forbidden_call ||= earlier.some((attempt) => attempt.forbidden_call);
    row.clean_route_success &&= !row.forbidden_call;
    return row;
  });
  const byVariant = Object.fromEntries((["baseline", "candidate"] as const).map((variant) => [
    variant,
    aggregate(scored.filter((row) => row.variant === variant)),
  ]));
  const byCategory = Object.fromEntries([...new Set(cases.map((c) => c.category))].map((category) => [
    category,
    Object.fromEntries((["baseline", "candidate"] as const).map((variant) => [
      variant,
      aggregate(scored.filter((row) => row.variant === variant && row.category === category)),
    ])),
  ]));
  const groupBy = (key: "track" | "provenance_kind" | "skill_menu_size") => Object.fromEntries(
    [...new Set(scored.map((row) => String(row[key])))].map((value) => [
      value,
      Object.fromEntries((['baseline', 'candidate'] as const).map((variant) => [
        variant,
        aggregate(scored.filter((row) => row.variant === variant && String(row[key]) === value)),
      ])),
    ]),
  );
  const bootstrap = {
    core_required_call_recall: pairedClusterCi(
      scored, "required_call_observed", 2000, (row) => row.track === "core",
    ),
    route_completion_rate: pairedClusterCi(scored, "route_complete"),
    clean_route_success_rate: pairedClusterCi(scored, "clean_route_success"),
    false_call_rate: pairedClusterCi(scored, "false_call"),
    core_tool_selection_accuracy: pairedClusterCi(
      scored, "tool_correct", 2000, (row) => row.track === "core",
    ),
    tool_selection_accuracy: pairedClusterCi(scored, "tool_correct"),
  };
  const skillMenuSizeEffect = Object.fromEntries((['baseline', 'candidate'] as const).map((variant) => [
    variant,
    {
      route_completion_rate: pairedMenuSizeCi(scored, variant, "route_complete"),
      false_call_rate: pairedMenuSizeCi(scored, variant, "false_call"),
      tool_selection_accuracy: pairedMenuSizeCi(scored, variant, "tool_correct"),
    },
  ]));
  const baseline = byVariant.baseline;
  const candidate = byVariant.candidate;
  const tokenReduction = baseline.mean_prompt_tokens && candidate.mean_prompt_tokens !== null
    ? 1 - candidate.mean_prompt_tokens / baseline.mean_prompt_tokens
    : null;
  const meanPairedPromptTokenSavings = pairedPromptSavings(scored);
  const worstSystemPromptCharRatio = worstPairedSystemPromptCharRatio(scored);
  const systemPromptCharReduction = baseline.mean_prompt_chars > 0
    ? 1 - candidate.mean_prompt_chars / baseline.mean_prompt_chars
    : null;
  const diagnosticGates: Record<string, boolean> | null = null;
  const datasetReviewStatus = Object.fromEntries(
    [...new Set(cases.map((testCase) => testCase.review_status))].map((status) => [
      status,
      cases.filter((testCase) => testCase.review_status === status).length,
    ]),
  );
  const acceptance = formalEvaluation ? Object.fromEntries([
    ["experiment_integrity", formalEvaluation.integrity.valid],
    ...formalEvaluation.gates.map((gate) => [gate.id, gate.status === "pass"]),
    ...formalEvaluation.external_gates.map((gate) => [gate.id, gate.status === "pass"]),
    ["formal_status_passed", formalEvaluation.status === "pass"],
  ]) as Record<string, boolean> : null;
  const reviewQueue = cases.flatMap((testCase) => {
    const rows = scored.filter((row) => row.case_id === testCase.id && !row.error);
    const baselineRows = rows.filter((row) => row.variant === "baseline");
    const candidateRows = rows.filter((row) => row.variant === "candidate");
    if (!baselineRows.length && !candidateRows.length) return [];
    const metric = (selected: ScoredRecord[], key: "route_complete" | "false_call" | "forbidden_call") =>
      selected.length ? average(selected.map((row) => Number(row[key]))) : null;
    const baselineRouteCompletion = metric(baselineRows, "route_complete");
    const candidateRouteCompletion = metric(candidateRows, "route_complete");
    const reasons: string[] = [];
    if (baselineRouteCompletion !== null && candidateRouteCompletion !== null
      && baselineRouteCompletion !== candidateRouteCompletion) {
      reasons.push("variant-disagreement");
    }
    const routePolicy = testCase.expected.route_policy;
    if (routePolicy === "required" && baselineRouteCompletion === 0 && candidateRouteCompletion === 0) {
      reasons.push("both-failed-positive");
    }
    if (routePolicy === "forbidden"
      && (metric(baselineRows, "false_call")! > 0 || metric(candidateRows, "false_call")! > 0)) {
      reasons.push("negative-cloud-call");
    }
    if (metric(baselineRows, "forbidden_call")! > 0 || metric(candidateRows, "forbidden_call")! > 0) {
      reasons.push("forbidden-call");
    }
    if (!reasons.length) return [];
    return [{
      case_id: testCase.id,
      base_scenario_id: testCase.base_scenario_id ?? testCase.id,
      category: testCase.category,
      track: testCase.track,
      reason: reasons.join(","),
      baseline_route_completion: baselineRouteCompletion,
      candidate_route_completion: candidateRouteCompletion,
      source_uri: testCase.provenance.uri,
      user_preview: (testCase.messages.at(-1)?.content ?? "")
        .replace(/\s+/g, " ").slice(0, 240),
    }];
  });
  return {
    scoring_version: 12,
    formal_evaluation: formalEvaluation,
    scored_records: scored,
    generated_at: new Date().toISOString(),
    limitation: "Controlled tool-routing benchmark without production traffic; it does not represent the production distribution.",
    scoring_notes: {
      false_call: "Counts attempted Memory/Skill/Knowledge bridge calls only; ordinary non-cloud Bash calls are reported separately.",
      positive_false_call: "Counts calls outside frozen allowed_arguments scopes, disallowed tools/families and explicitly wrong nonempty string resource identities (id, *_id, *_name, path) on every call, including before/after recovery. Missing or ill-typed identities and protocol failures are separate; free-text query irrelevance is not inferred.",
      arguments: "Each adopted alternative must meet its full contract on the same call; constraints for unused alternatives do not require those calls. Correct-resource retries can recover the route while protocol_accuracy retains any protocol error.",
      endpoint: "Expected contract paths are matched against the suffix of the full proxy URL path.",
      retries: "Diagnostic summaries use the latest attempt, retaining any earlier observed false call. Formal evaluation rejects duplicate jobs; request-level retries belong in transport_attempts.",
      inference: "Bootstrap outputs are exploratory only; formal inference requires an explicit frozen matrix and thresholds.",
      window: "All recorded calls are scored, including all calls in the response that completes a milestone.",
    },
    by_variant: byVariant,
    by_category: byCategory,
    by_track: groupBy("track"),
    by_provenance: groupBy("provenance_kind"),
    by_skill_menu_size: groupBy("skill_menu_size"),
    mean_paired_prompt_token_savings: meanPairedPromptTokenSavings,
    worst_paired_system_prompt_char_ratio: worstSystemPromptCharRatio,
    system_prompt_char_reduction: systemPromptCharReduction,
    first_request_prompt_token_reduction: tokenReduction,
    paired_cluster_bootstrap: bootstrap,
    skill_menu_size_effect: skillMenuSizeEffect,
    run_metadata: {
      requested_models: [...new Set(records.map((record) => record.requested_model))].sort(),
      actual_models: [...new Set(records.map((record) => record.actual_model).filter(Boolean))].sort(),
      repetitions: [...new Set(records.map((record) => record.repetition))].sort((left, right) => left - right),
      cases: cases.length,
      base_scenarios: new Set(cases.map((testCase) => testCase.base_scenario_id ?? testCase.id)).size,
    },
    dataset_review_status: datasetReviewStatus,
    diagnostic_gates: diagnosticGates,
    acceptance,
    review_queue: reviewQueue,
    errors: scored.filter((row) => row.error).map((row) => ({ case_id: row.case_id, variant: row.variant, error: row.error })),
  };
}

function percent(value: number | null | undefined): string {
  return value === null || value === undefined ? "—" : `${(value * 100).toFixed(2)}%`;
}

function numberValue(value: number | null | undefined): string {
  return value === null || value === undefined ? "—" : value.toFixed(2);
}

function confidenceInterval(value: { ci95: [number, number] } | null): string {
  return value ? `${percent(value.ci95[0])} ～ ${percent(value.ci95[1])}` : "—";
}

/** Human-facing companion to the stable JSON report consumed by CI. */
export function renderChineseReport(report: ReturnType<typeof buildReport>): string {
  const baseline = report.by_variant.baseline;
  const candidate = report.by_variant.candidate;
  const metricRows: Array<[string, keyof typeof baseline, "rate" | "number"]> = [
    ["应调用召回率", "required_call_recall", "rate"],
    ["首次路由正确率", "first_action_accuracy", "rate"],
    ["路由完成率", "route_completion_rate", "rate"],
    ["Clean route success", "clean_route_success_rate", "rate"],
    ["负例误调用率", "false_call_rate", "rate"],
    ["正例不必要调用率", "positive_false_call_rate", "rate"],
    ["工具族选择正确率", "family_selection_accuracy", "rate"],
    ["具体工具选择正确率", "tool_selection_accuracy", "rate"],
    ["多跳里程碑完成率", "milestone_completion_rate", "rate"],
    ["禁止调用率", "forbidden_call_rate", "rate"],
    ["协议正确率", "protocol_accuracy", "rate"],
    ["关键参数正确率", "argument_accuracy", "rate"],
    ["平均首轮 Prompt Token", "mean_prompt_tokens", "number"],
  ];
  const lines = [
    "# 工具路由评测报告",
    "",
    `生成时间：${report.generated_at}`,
    "",
    "> 限制：这是基于公开数据锚点和受控 fixture 的路由评测，不代表生产流量分布。",
    "",
    "## 运行元数据",
    "",
    `- 请求模型：${report.run_metadata.requested_models.join(", ") || "—"}`,
    `- 实际模型：${report.run_metadata.actual_models.join(", ") || "—"}`,
    `- Repetition：${report.run_metadata.repetitions.join(", ")}`,
    `- Case / 基础场景：${report.run_metadata.cases} / ${report.run_metadata.base_scenarios}`,
    "",
    "## 总体指标",
    "",
    "| 指标 | Baseline | Candidate |",
    "|---|---:|---:|",
    ...metricRows.map(([label, key, kind]) => {
      const formatter = kind === "rate" ? percent : numberValue;
      return `| ${label} | ${formatter(baseline[key] as number | null)} | ${formatter(candidate[key] as number | null)} |`;
    }),
    `| 平均配对首轮 Prompt Token 节省量 | — | ${numberValue(report.mean_paired_prompt_token_savings)} |`,
    `| 系统注入字符节省率 | — | ${percent(report.system_prompt_char_reduction)} |`,
    `| 最坏配对 Candidate/Baseline 字符比例 | — | ${percent(report.worst_paired_system_prompt_char_ratio)} |`,
    `| 首轮整体 Prompt Token 节省率 | — | ${percent(report.first_request_prompt_token_reduction)} |`,
    "",
    "## 按场景类别",
    "",
    "| 类别 | Baseline 路由完成率 | Candidate 路由完成率 | Baseline 误调用率 | Candidate 误调用率 |",
    "|---|---:|---:|---:|---:|",
    ...Object.entries(report.by_category).map(([category, variants]) =>
      `| ${category} | ${percent(variants.baseline.route_completion_rate)} | ${percent(variants.candidate.route_completion_rate)} | ${percent(variants.baseline.false_call_rate)} | ${percent(variants.candidate.false_call_rate)} |`),
    "",
    "## 分层结果",
    "",
    "| 维度 | 分组 | Baseline 路由完成率 | Candidate 路由完成率 | Baseline 误调用率 | Candidate 误调用率 |",
    "|---|---|---:|---:|---:|---:|",
    ...Object.entries(report.by_track).map(([group, variants]) =>
      `| 评测轨道 | ${group} | ${percent(variants.baseline.route_completion_rate)} | ${percent(variants.candidate.route_completion_rate)} | ${percent(variants.baseline.false_call_rate)} | ${percent(variants.candidate.false_call_rate)} |`),
    ...Object.entries(report.by_provenance).map(([group, variants]) =>
      `| Prompt 来源 | ${group} | ${percent(variants.baseline.route_completion_rate)} | ${percent(variants.candidate.route_completion_rate)} | ${percent(variants.baseline.false_call_rate)} | ${percent(variants.candidate.false_call_rate)} |`),
    ...Object.entries(report.by_skill_menu_size).map(([group, variants]) =>
      `| Skill 注入量 | ${group} | ${percent(variants.baseline.route_completion_rate)} | ${percent(variants.candidate.route_completion_rate)} | ${percent(variants.baseline.false_call_rate)} | ${percent(variants.candidate.false_call_rate)} |`),
    "",
    "## Skill 注入量配对效应",
    "",
    "下表为同一基础场景的 K100 − K50；路由完成率为负表示 skill 增多后变差，误调用率为正表示变差。",
    "",
    "| Variant | 指标 | 差值 | 95% CI | 配对场景数 |",
    "|---|---|---:|---:|---:|",
    ...(["baseline", "candidate"] as const).flatMap((variant) => {
      const effects = report.skill_menu_size_effect[variant];
      return ([
        ["路由完成率", effects.route_completion_rate],
        ["误调用率", effects.false_call_rate],
        ["工具选择正确率", effects.tool_selection_accuracy],
      ] as const).map(([label, effect]) =>
        `| ${variant} | ${label} | ${percent(effect?.difference)} | ${confidenceInterval(effect)} | ${effect?.clusters ?? "—"} |`);
    }),
    "",
    "## 验收结论",
    "",
    ...(report.formal_evaluation ? [
      `- 结论：${({ pass: "通过", fail: "未通过", insufficient: "证据不足" })[report.formal_evaluation.status]}`,
      `- 范围：仅覆盖预注册的指标与外部证据门槛；未配置的目标不在结论内。`,
      ...report.formal_evaluation.integrity.reasons.map((reason) => `- 完整性：${reason}`),
      ...report.formal_evaluation.gates.map((gate) => `- ${gate.id}：${gate.status}；${gate.reasons.join("、") || "满足预注册条件"}`),
      ...report.formal_evaluation.external_gates.map((gate) => `- ${gate.id}：${gate.status}；${gate.evidence}`),
    ] : ["- 仅为诊断报告：未提供正式冻结矩阵与门槛。Dev 样本及重复运行不能自动升级为正式验收。"]),
    "",
    "聚类 bootstrap 仅作诊断，不参与正式通过判定；全零差值的退化区间不能证明非劣。",
    "",
    "## 人工复核队列",
    "",
    `共 ${report.review_queue.length} 条需要重点复核。下表最多展示前 30 条。`,
    "",
    "| Case | 类别 | 原因 | Baseline 路由完成 | Candidate 路由完成 |",
    "|---|---|---|---:|---:|",
    ...report.review_queue.slice(0, 30).map((item) =>
      `| ${item.case_id} | ${item.category} | ${item.reason} | ${percent(item.baseline_route_completion)} | ${percent(item.candidate_route_completion)} |`),
    "",
    `失败运行数：${report.errors.length}`,
    "",
  ];
  return `${lines.join("\n")}\n`;
}
