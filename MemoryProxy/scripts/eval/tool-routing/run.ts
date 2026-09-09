import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { buildEvalProviderRequest, loadCases, promptHash } from "./prompts.js";
import { parseCurl } from "./protocol.js";
import { experimentFingerprint } from "./experiment.js";
import { EvaluationBudget } from "./budget.js";
import { providerConfiguration, providerHistory, providerRequestParams } from "./provider-config.js";
import { createWorkspaceHost, resolveWorkspacePythonRuntime } from "./workspace-host.js";
import { scoreRecord, buildReport } from "./scorer.js";
import { validateEvalDataset } from "./dataset.js";
import type { EvalCase, ParsedCall, RunRecord, WorkspacePythonRuntime } from "./types.js";
export { parseCurl } from "./protocol.js";
type ProviderFetcher = (input: string, init: RequestInit) => Promise<Response>;

export async function fetchProviderWithRetry(
  fetcher: ProviderFetcher,
  input: string,
  init: RequestInit,
  maxAttempts = 3,
  pause: (milliseconds: number) => Promise<void> = (milliseconds) =>
    new Promise((resolvePause) => setTimeout(resolvePause, milliseconds)),
  requestTimeoutMs = 60_000,
  onAttempt?: (attempt: number, status?: number, error?: string) => void,
): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await fetcher(input, {
        ...init,
        signal: init.signal ?? AbortSignal.timeout(requestTimeoutMs),
      });
      onAttempt?.(attempt, response.status);
      const transient = response.status === 429 || response.status >= 500;
      if (!transient || attempt === maxAttempts) return response;
      await response.text();
    } catch (error) {
      onAttempt?.(attempt, undefined, (error as Error).message);
      lastError = error;
      if ((error as Error).message.startsWith("Evaluation cost budget")) throw error;
      if (attempt === maxAttempts) throw error;
    }
    await pause(500 * attempt);
  }
  throw lastError instanceof Error ? lastError : new Error("Provider request failed after retries");
}

export function classifyFirstAction(call: ParsedCall): NonNullable<RunRecord["first_action"]> {
  if (call.protocol_valid && call.family && call.tool) {
    return { kind: "cloud_tool", family: call.family, tool: call.tool };
  }
  if (call.family) return { kind: "invalid_tool", family: call.family, tool: call.tool };
  if (!/^\s*curl\b/.test(call.command)) return { kind: "local_bash" };
  return { kind: "invalid_tool", family: call.family, tool: call.tool };
}

/**
 * Decide whether the first observable action already settles the routing
 * question. Required routes marked must_precede_local_action continue only
 * after the expected cloud entry point; forbidden/optional routes need no
 * synthetic retry turn after their first decision.
 */
export function shouldTerminateAfterFirstAction(
  testCase: EvalCase,
  action: NonNullable<RunRecord["first_action"]>,
): boolean {
  const expected = testCase.expected;
  const policy = expected.route_policy;
  if (policy !== "required") return true;
  if (!expected.must_precede_local_action) return false;
  if (action.kind !== "cloud_tool") return true;
  if (expected.family && action.family !== expected.family) return true;
  const acceptableFirstTools = expected.first_tools?.length
    ? expected.first_tools
    : expected.acceptable_routes?.map((route) => route[0]).filter(Boolean);
  return Boolean(acceptableFirstTools?.length && (!action.tool || !acceptableFirstTools.includes(action.tool)));
}

export async function runModel(
  variant: "baseline" | "candidate",
  testCase: EvalCase,
  repetition: number,
  options: { experimentSha256?: string; fetcher?: ProviderFetcher; config?: RunRecord["request_config"]; budget?: EvaluationBudget;
    pythonRuntime?: WorkspacePythonRuntime } = {},
): Promise<RunRecord> {
  const requestedModel = process.env.TOOL_ROUTING_MODEL ?? "deepseek-v4-flash";
  const allowedActualModels = (process.env.TOOL_ROUTING_ALLOWED_ACTUAL_MODELS ?? requestedModel).split(",").map((value) => value.trim());
  const baseUrl = process.env.TOOL_ROUTING_API_BASE_URL?.replace(/\/$/, "");
  const url = process.env.TOOL_ROUTING_API_URL ?? (baseUrl ? `${baseUrl}/chat/completions` : undefined);
  const apiKey = process.env.TOOL_ROUTING_API_KEY;
  const config = options.config ?? providerConfiguration();
  const rendered = await buildEvalProviderRequest(variant, testCase, {
    messages: providerHistory(testCase.messages, config), requestParams: providerRequestParams(requestedModel, config),
  });
  const prompt = rendered.prompt;
  const record: RunRecord = {
    case_id: testCase.id, base_scenario_id: testCase.base_scenario_id,
    split: testCase.split, category: testCase.category, variant, repetition,
    requested_model: requestedModel, prompt_chars: prompt.length, prompt_bytes: Buffer.byteLength(prompt),
    prompt_sha256: promptHash(prompt), calls: [], request_config: config,
    experiment_sha256: options.experimentSha256, transport_attempts: [], usage_by_response: [],
    window_complete: false,
  };
  if (!url || !apiKey) return { ...record, error: "Provider API is not configured", termination_reason: "provider_error" };
  const messages = rendered.request.messages;
  const host = await createWorkspaceHost(testCase, { expectedPythonRuntime: options.pythonRuntime });
  record.workspace_python_runtime_sha256 = host.pythonRuntimeSha256;
  if (config.workspace_python_runtime_sha256 !== undefined
    && config.workspace_python_runtime_sha256 !== host.pythonRuntimeSha256) {
    await host.close(); throw new Error("Workspace Python differs from the frozen request configuration");
  }
  const requestBody = () => ({ ...rendered.request, messages });
  record.request_sha256 = experimentFingerprint(requestBody());
  let outstandingReservation: ReturnType<EvaluationBudget["reserve"]> | undefined;
  try {
    for (let turn = 0; turn < config.max_responses!; turn++) {
      let settle: ReturnType<EvaluationBudget["reserve"]> | undefined;
      const fetcher: ProviderFetcher = async (input, init) => {
        settle?.(); // Unknown usage on a previous transport attempt is not counted as zero.
        settle = options.budget?.reserve(Buffer.byteLength(String(init.body)), config.max_completion_tokens!);
        outstandingReservation = settle;
        return (options.fetcher ?? fetch)(input, init);
      };
      const response = await fetchProviderWithRetry(fetcher, url, {
        method: "POST", headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify(requestBody()),
      }, 3, undefined, config.request_timeout_ms ?? 60_000, (attempt, status, error) => {
        record.transport_attempts!.push({ response_index: turn, attempt, status, error });
      });
      if (!response.ok) throw new Error(`Provider HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
      const payload = await response.json() as any;
      settle?.(payload.usage);
      outstandingReservation = undefined;
      if (!payload.model) throw new Error("Provider response omitted actual model identity");
      if (record.actual_model && payload.model !== record.actual_model) throw new Error("Actual model changed within one run");
      record.actual_model = payload.model;
      if (!allowedActualModels.includes(payload.model)) throw new Error(`Unexpected actual model: ${payload.model}`);
      const usage = payload.usage;
      const turnPromptTokens = usage?.prompt_tokens;
      record.usage_by_response!.push({ prompt_tokens: turnPromptTokens, completion_tokens: usage?.completion_tokens,
        cache_hit_tokens: usage?.prompt_cache_hit_tokens ?? usage?.prompt_tokens_details?.cached_tokens,
        cache_miss_tokens: usage?.prompt_cache_miss_tokens });
      if (turn === 0 && turnPromptTokens !== undefined) record.prompt_tokens = turnPromptTokens;
      if (typeof turnPromptTokens === "number") record.total_prompt_tokens = (record.total_prompt_tokens ?? 0) + turnPromptTokens;
      if (typeof usage?.completion_tokens === "number") record.completion_tokens = (record.completion_tokens ?? 0) + usage.completion_tokens;
      const message = payload.choices?.[0]?.message;
      if (!message || message.role !== "assistant") {
        record.termination_reason = "invalid_response"; throw new Error("Provider response has no assistant message");
      }
      if (config.thinking_mode === "enabled" && typeof message.reasoning_content !== "string") {
        record.termination_reason = "invalid_response"; throw new Error("Thinking response omitted reasoning_content");
      }
      messages.push(message);
      const toolCalls = message.tool_calls ?? [];
      if (!toolCalls.length) {
        record.first_action ??= { kind: "text" };
        record.final_text = message.content ?? "";
        record.termination_reason = payload.choices?.[0]?.finish_reason === "length" ? "budget_exhausted" : "final_text";
        record.window_complete = true;
        break;
      }
      for (const call of toolCalls) {
        const before = host.calls.length;
        let args: Record<string, string>;
        let result: string;
        try {
          args = JSON.parse(call.function?.arguments ?? "{}");
          result = await host.execute(call.function?.name ?? "", args, turn);
        } catch { result = "Tool error: arguments must be a JSON object"; }
        const cloudCall = host.calls[before];
        record.first_action ??= cloudCall ? classifyFirstAction(cloudCall) : { kind: "local_bash" };
        messages.push({ role: "tool", tool_call_id: call.id, content: result });
      }
      // All routes use the same response budget. Continue after a correct call
      // to observe later unrelated calls; local coding always remains executable.
    }
    if (!record.termination_reason) {
      record.termination_reason = "budget_exhausted";
      record.window_complete = true;
    }
  } catch (error) {
    record.error = (error as Error).message;
    record.termination_reason ??= "provider_error";
  } finally {
    try { outstandingReservation?.(); }
    finally {
      record.calls = host.calls;
      record.local_actions = host.actions;
      if (testCase.coding_expectation) record.coding_progress = host.progress();
      record.history = messages;
      await host.close();
    }
  }
  return record;
}

const option = (name: string, fallback?: string) => {
  const i = process.argv.indexOf(name); return i < 0 ? fallback : process.argv[i + 1];
};
const has = (name: string) => process.argv.includes(name);
async function main() {
  const cases = loadCases(); validateEvalDataset(cases);
  const manifest = JSON.parse(readFileSync(new URL("./manifest.json", import.meta.url), "utf8"));
  for (const [name, expected] of Object.entries(manifest.files)) {
    if (promptHash(readFileSync(new URL(name, import.meta.url), "utf8")) !== expected) throw new Error(`Data/evidence hash mismatch: ${name}`);
  }
  if (process.env.TOOL_ROUTING_MODEL && process.env.TOOL_ROUTING_MODEL !== "deepseek-v4-flash") throw new Error("Use deepseek-v4-flash");
  process.env.TOOL_ROUTING_THINKING_MODE ??= "disabled";
  if (process.env.TOOL_ROUTING_THINKING_MODE !== "disabled") throw new Error("Use thinking=disabled");
  const config = providerConfiguration(12, 8192, 90_000);
  const saved = readFileSync(new URL("./results/per-case.jsonl", import.meta.url), "utf8").trim().split(/\r?\n/).map(line => JSON.parse(line));
  if (has("--dry-run") || has("--verify")) {
    let baselineMatches = 0, candidateMatches = 0;
    for (const c of cases) for (const variant of ["baseline", "candidate"] as const) {
      const built = await buildEvalProviderRequest(variant, c, { requestParams: providerRequestParams("deepseek-v4-flash", config) });
      const previous = saved.find(r => r.case_id === c.id && r.variant === variant);
      const same = experimentFingerprint(built.request) === previous?.request_sha256;
      if (variant === "baseline") { if (!same) throw new Error(`Baseline request changed: ${c.id}`); baselineMatches++; }
      else if (same) candidateMatches++;
    }
    const scores = saved.map(r => scoreRecord({ ...r, calls: r.calls.map((call: ParsedCall, i: number) => {
      const review = r.call_reviews[i];
      if (review.call_sha256 !== experimentFingerprint(call)) throw new Error("Recorded call hash mismatch");
      return { ...call, semantic_relevance: review.verdict };
    }) }, cases.find(c => c.id === r.case_id)!));
    const summary = JSON.parse(readFileSync(new URL("./results/summary.json", import.meta.url), "utf8"));
    for (const variant of ["baseline", "candidate"]) {
      const p = scores.filter(r => r.variant === variant && r.route_policy === "required");
      const b = scores.filter(r => r.variant === variant && r.category.endsWith("boundary-negative"));
      const c = scores.filter(r => r.variant === variant && r.category === "coding-negative");
      const actual = { required: p.filter(r => r.required_call_observed).length, first_tool_correct: p.filter(r => r.tool_correct).length,
        positive_extra: p.filter(r => r.positive_false_call).length, boundary_false: b.filter(r => r.false_call).length,
        coding_false: c.filter(r => r.false_call).length, coding_activity_unmet: c.filter(r => r.no_progress_or_early_abort).length };
      for (const [name, value] of Object.entries(actual)) if (summary.metrics[variant][name] !== value) throw new Error(`Saved score mismatch: ${variant}/${name}`);
    }
    console.log(JSON.stringify({ cases: cases.length, recorded_runs: saved.length, baseline_request_matches: baselineMatches,
      current_candidate_request_matches: candidateMatches, saved_metrics_verified: true }, null, 2)); return;
  }
  if (!has("--live")) throw new Error("Choose --verify or explicit --live");
  if (has("--probe-tokens")) {
    const output = option("--out"), endpoint = process.env.TOOL_ROUTING_API_URL
      ?? (process.env.TOOL_ROUTING_API_BASE_URL?.replace(/\/$/, "") + "/chat/completions");
    const apiKey = process.env.TOOL_ROUTING_API_KEY;
    if (!output || existsSync(output) || !apiKey || !endpoint || endpoint.startsWith("undefined")) throw new Error("Provide endpoint/key and a new --out path");
    const probe = JSON.parse(readFileSync(new URL("./results/token-probe.json", import.meta.url), "utf8"));
    const budget = new EvaluationBudget(Number(option("--budget", "0.1")));
    const observations = [];
    try {
      for (const entry of probe.requests) {
        const body = JSON.stringify(entry.body), settle = budget.reserve(Buffer.byteLength(body), entry.body.max_tokens);
        try {
          const response = await fetch(endpoint, { method: "POST", headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" }, body, signal: AbortSignal.timeout(90_000) });
          if (!response.ok) throw new Error(`Provider HTTP ${response.status}`);
          const payload = await response.json() as any; settle(payload.usage);
          observations.push({ case_id: entry.case_id, variant: entry.variant, request_sha256: experimentFingerprint(entry.body), actual_model: payload.model, usage: payload.usage });
        } finally { settle(); }
      }
    } finally { writeFileSync(output, JSON.stringify({ scope: "historical fixed token-probe inputs", observations, conservative_usd: budget.accountedUsd }, null, 2), { flag: "wx", mode: 0o600 }); }
    return;
  }
  const selected = has("--all") ? cases : cases.filter(c => c.id === option("--case"));
  if (!selected.length) throw new Error("Select --case ID or --all");
  const variant = option("--variant", "candidate");
  if (!["baseline", "candidate", "both"].includes(variant!)) throw new Error("Invalid variant");
  const output = option("--out");
  if (!output || existsSync(output) || existsSync(`${output}.report.json`)) throw new Error("Specify a new --out path");
  const runtime = resolveWorkspacePythonRuntime({ pythonExecutable: option("--python", process.env.TOOL_ROUTING_PYTHON_EXECUTABLE), pythonVersion: "3.14" });
  if (!runtime) throw new Error("Specify an absolute Python 3.14 executable with --python");
  process.env.TOOL_ROUTING_PYTHON_EXECUTABLE = runtime.executable;
  config.workspace_python_runtime_sha256 = promptHash(JSON.stringify(runtime));
  const budget = new EvaluationBudget(Number(option("--budget", "0.5")));
  const records: RunRecord[] = [];
  const safeJson = (v: unknown, pretty = false) => {
    const text = JSON.stringify(v, null, pretty ? 2 : undefined), key = process.env.TOOL_ROUTING_API_KEY;
    return key ? text.replaceAll(key, "[REDACTED]") : text;
  };
  writeFileSync(output, "", { flag: "wx", mode: 0o600 });
  outer: for (const c of selected) for (const v of variant === "both" ? ["baseline", "candidate"] as const : [variant as "baseline" | "candidate"]) {
    const record = await runModel(v, c, 1, { config, budget, pythonRuntime: runtime });
    records.push(record); appendFileSync(output, `${safeJson(record)}\n`);
    console.log(safeJson({ completed: records.length, case_id: c.id, variant: v, accounted_usd: budget.accountedUsd, error: record.error }));
    if (record.error) break outer;
  }
  writeFileSync(`${output}.report.json`, safeJson({ scope: "new-run-contract-scoring; no fresh semantic review", config, runtime,
    planned_runs: selected.length * (variant === "both" ? 2 : 1), observed_runs: records.length,
    conservative_usd: budget.accountedUsd, report: buildReport(records, selected) }, true), { flag: "wx", mode: 0o600 });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
