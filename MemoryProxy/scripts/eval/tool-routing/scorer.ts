import { readFileSync, writeFileSync } from "node:fs";

import type { EvalCase, RunRecord } from "./types.js";

interface ScoredRecord extends RunRecord {
  should_call: boolean;
  called: boolean;
  effective: boolean;
  false_call: boolean;
  non_cloud_bash_call: boolean;
  family_correct: boolean;
  tool_correct: boolean;
  endpoint_correct: boolean;
  body_correct: boolean;
  protocol_correct: boolean;
}

function inferredFamily(call: RunRecord["calls"][number]): "memory" | "skill" | "knowledge" | undefined {
  if (call.family) return call.family;
  if (call.command.includes("/memory-bridge/")) return "memory";
  if (call.command.includes("/skill-bridge/")) return "skill";
  if (call.command.includes("/tools/list") || call.command.includes("/tools/call")) return "knowledge";
  return undefined;
}

function readJsonl<T>(path: string): T[] {
  return readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as T);
}

function score(record: RunRecord, testCase: EvalCase): ScoredRecord {
  const calls = record.calls;
  const cloudCalls = calls.filter((call) => inferredFamily(call));
  const expected = testCase.expected;
  const called = cloudCalls.length > 0;
  const familyCorrect = !expected.family || cloudCalls.some((call) => inferredFamily(call) === expected.family);
  const toolCorrect = !expected.tools?.length || cloudCalls.some((call) =>
    call.tool && expected.tools!.includes(call.tool));
  const allToolsCorrect = !expected.tools_all?.length || expected.tools_all.every((tool) =>
    cloudCalls.some((call) => call.tool === tool));
  const endpointCorrect = !expected.endpoints?.length || expected.endpoints.every((endpoint) =>
    cloudCalls.some((call) => call.endpoint === endpoint || call.endpoint?.endsWith(endpoint)));
  const bodyCorrect = !expected.body_requires?.length || cloudCalls.some((call) =>
    expected.body_requires!.every((key) => Object.hasOwn(call.body ?? {}, key)));
  const protocolCorrect = cloudCalls.length > 0 && cloudCalls.every((call) => call.protocol_valid)
    && endpointCorrect && bodyCorrect;
  const effective = expected.should_call && called && familyCorrect && toolCorrect && allToolsCorrect && protocolCorrect;
  return {
    ...record,
    should_call: expected.should_call,
    called,
    effective,
    false_call: !expected.should_call && called,
    non_cloud_bash_call: calls.some((call) => !inferredFamily(call)),
    family_correct: expected.should_call && familyCorrect,
    tool_correct: expected.should_call && toolCorrect && allToolsCorrect,
    endpoint_correct: expected.should_call && endpointCorrect,
    body_correct: expected.should_call && bodyCorrect,
    protocol_correct: expected.should_call && protocolCorrect,
  };
}

function rate(rows: ScoredRecord[], key: keyof ScoredRecord, filter: (r: ScoredRecord) => boolean): number | null {
  const selected = rows.filter(filter);
  if (!selected.length) return null;
  return selected.filter((row) => Boolean(row[key])).length / selected.length;
}

function aggregate(rows: ScoredRecord[]) {
  const validRows = rows.filter((row) => !row.error);
  const positives = (r: ScoredRecord) => r.should_call;
  const negatives = (r: ScoredRecord) => !r.should_call;
  return {
    runs: rows.length,
    valid_runs: validRows.length,
    failed_runs: rows.length - validRows.length,
    unique_cases: new Set(validRows.map((r) => r.case_id)).size,
    effective_call_rate: rate(validRows, "effective", positives),
    false_call_rate: rate(validRows, "false_call", negatives),
    non_cloud_bash_call_rate: rate(validRows, "non_cloud_bash_call", negatives),
    family_selection_accuracy: rate(validRows, "family_correct", positives),
    tool_selection_accuracy: rate(validRows, "tool_correct", positives),
    endpoint_accuracy: rate(validRows, "endpoint_correct", positives),
    body_accuracy: rate(validRows, "body_correct", positives),
    protocol_accuracy: rate(validRows, "protocol_correct", positives),
    mean_prompt_tokens: validRows.some((r) => r.prompt_tokens !== undefined)
      ? validRows.reduce((sum, r) => sum + (r.prompt_tokens ?? 0), 0) / validRows.length
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
  metric: "effective" | "false_call" | "tool_correct",
  iterations = 2000,
): { difference: number; ci95: [number, number]; clusters: number } | null {
  const byCase = new Map<string, { baseline: number[]; candidate: number[] }>();
  for (const row of rows) {
    if (row.error) continue;
    const eligible = metric === "false_call" ? !row.should_call : row.should_call;
    if (!eligible) continue;
    const cluster = byCase.get(row.case_id) ?? { baseline: [], candidate: [] };
    cluster[row.variant].push(Number(Boolean(row[metric])));
    byCase.set(row.case_id, cluster);
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

function average(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function buildReport(records: RunRecord[], cases: EvalCase[]) {
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
    return score(record, testCase);
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
  const bootstrap = {
    effective_call_rate: pairedClusterCi(scored, "effective"),
    false_call_rate: pairedClusterCi(scored, "false_call"),
    tool_selection_accuracy: pairedClusterCi(scored, "tool_correct"),
  };
  const baseline = byVariant.baseline;
  const candidate = byVariant.candidate;
  const tokenReduction = baseline.mean_prompt_tokens && candidate.mean_prompt_tokens !== null
    ? 1 - candidate.mean_prompt_tokens / baseline.mean_prompt_tokens
    : null;
  const codingBaseline = byCategory["coding-negative"]?.baseline.false_call_rate ?? null;
  const codingCandidate = byCategory["coding-negative"]?.candidate.false_call_rate ?? null;
  const enoughData = baseline.valid_runs > 0 && candidate.valid_runs > 0
    && bootstrap.effective_call_rate && bootstrap.false_call_rate && bootstrap.tool_selection_accuracy;
  const acceptance = enoughData ? {
    effective_call_non_inferior: bootstrap.effective_call_rate!.ci95[0] >= -0.02,
    tool_selection_drop_within_2pp: bootstrap.tool_selection_accuracy!.difference >= -0.02,
    false_call_point_estimate_improves: bootstrap.false_call_rate!.difference < 0,
    false_call_ci_not_clearly_worse: bootstrap.false_call_rate!.ci95[0] <= 0,
    prompt_tokens_reduced_at_least_20pct: tokenReduction !== null && tokenReduction >= 0.20,
    coding_negative_false_calls_not_higher: codingBaseline !== null && codingCandidate !== null
      && codingCandidate <= codingBaseline,
  } : null;
  return {
    scoring_version: 2,
    generated_at: new Date().toISOString(),
    limitation: "Controlled tool-routing benchmark without production traffic; it does not represent the production distribution.",
    scoring_notes: {
      false_call: "Counts attempted Memory/Skill/Knowledge bridge calls only; ordinary non-cloud Bash calls are reported separately.",
      endpoint: "Expected contract paths are matched against the suffix of the full proxy URL path.",
      retries: "When a logical job has multiple JSONL attempts, only the latest attempt is scored.",
    },
    by_variant: byVariant,
    by_category: byCategory,
    prompt_token_reduction: tokenReduction,
    paired_cluster_bootstrap: bootstrap,
    acceptance,
    errors: scored.filter((row) => row.error).map((row) => ({ case_id: row.case_id, variant: row.variant, error: row.error })),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const inputIndex = process.argv.indexOf("--input");
  const outputIndex = process.argv.indexOf("--out");
  if (inputIndex < 0) throw new Error("Usage: scorer.ts --input results.jsonl [--out report.json]");
  const cases = readJsonl<EvalCase>(new URL("./dataset.jsonl", import.meta.url).pathname);
  const report = buildReport(readJsonl<RunRecord>(process.argv[inputIndex + 1]), cases);
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (outputIndex >= 0) writeFileSync(process.argv[outputIndex + 1], json);
  else process.stdout.write(json);
}
