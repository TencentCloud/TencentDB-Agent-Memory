import fs from "node:fs/promises";
import path from "node:path";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const CONFIG = {
  providers: (process.env.E2E_PROVIDERS || "all").split(",").map((s) => s.trim()).filter(Boolean),
  outDir: process.env.E2E_OUT_DIR || path.join("tmp", "issue120-e2e-results"),
  delayMs: Number(process.env.E2E_DELAY_MS || 1200),
  maxOutputTokens: Number(process.env.E2E_MAX_OUTPUT_TOKENS || 400),
  requestTimeoutMs: Number(process.env.E2E_REQUEST_TIMEOUT_MS || 45000),
  turnCount: Number(process.env.E2E_TURNS || 3),
  dryRun: process.argv.includes("--dry-run") || process.env.E2E_DRY_RUN === "1",
};
const regradeIndex = process.argv.indexOf("--regrade");
const REGRADE_PATH = regradeIndex >= 0 ? process.argv[regradeIndex + 1] : "";

const EXPECTED = {
  product: "Aurora Ledger",
  release_target: "2026-08-15",
  owner: "Lin Wei",
  database: "TencentDB for PostgreSQL",
  feature_flag_storage: "config_flags table",
  compliance: "EU data residency",
  smoke_test: "npm run test:smoke",
  ready: true,
};

const TURNS = [
  "Extract the remembered release facts into compact JSON only. Include all known fields.",
  "Refine the same brief with risk and mitigation. Compact JSON only.",
  "Return the final task result as JSON only with keys: product, release_target, owner, database, feature_flag_storage, compliance, primary_risk, mitigation, smoke_test, ready.",
];

function makeStableSystem() {
  const lines = [
    "You are an E2E task runner for a prompt-cache comparison.",
    "Complete the user's release-brief task using the supplied relevant memories.",
    "Return compact JSON only. Do not include markdown.",
    "Use only facts present in the conversation or relevant memories.",
  ];
  for (let i = 1; i <= 120; i++) {
    lines.push(`Stable shared instruction ${String(i).padStart(3, "0")}: preserve exact behavior across cache scenarios and keep outputs deterministic.`);
  }
  return lines.join("\n");
}

function makeRecallLines() {
  const filler = "Cache probe filler: stable project notes, architectural constraints, and repeated acceptance context.";
  return [
    "[M1] Product name: Aurora Ledger. Release target: 2026-08-15. Release owner: Lin Wei.",
    "[M2] Required database: TencentDB for PostgreSQL. Do not switch this release to Redis or a document database.",
    "[M3] Feature flags are stored in the config_flags table. The team explicitly rejected Redis for this decision.",
    "[M4] Compliance requirement: EU data residency. The final brief must mention this exactly.",
    "[M5] Primary risk: the batch importer can double entries when retrying after HTTP 429 responses.",
    "[M6] Mitigation: add an idempotency key and deduplicate by source_event_id before insert.",
    "[M7] Acceptance smoke test command: npm run test:smoke.",
    "[M8] Readiness decision: ready is true after the mitigation and smoke-test command are included in the final brief.",
    ...Array.from({ length: 22 }, (_, i) => `[P${String(i + 1).padStart(2, "0")}] ${filler} Line ${i + 1}.`),
  ];
}

function buildRecallBlock(lines) {
  return `<relevant-memories>\nThe following recalled memories are relevant to the current task:\n\n${lines.join("\n")}\n</relevant-memories>`;
}

function buildScenarioTurns(scenario) {
  const selectedTurns = CONFIG.turnCount <= 2 ? [TURNS[0], TURNS[TURNS.length - 1]] : TURNS;
  const recallLines = makeRecallLines();
  const fullRecall = buildRecallBlock(recallLines);
  const budgetedRecall = buildRecallBlock(recallLines.slice(0, 9));
  const turns = [];

  for (let i = 0; i < selectedTurns.length; i++) {
    const userText = selectedTurns[i];
    if (scenario === "show_injected_risk") {
      turns.push({
        requestUser: `${fullRecall}\n\n${userText}`,
        persistedUser: `${fullRecall}\n\n${userText}`,
        recallChars: fullRecall.length,
      });
      continue;
    }

    const injectRecall = i === 0 ? budgetedRecall : "";
    turns.push({
      requestUser: injectRecall ? `${injectRecall}\n\n${userText}` : userText,
      persistedUser: userText,
      recallChars: injectRecall.length,
    });
  }

  return turns;
}

function truncateText(text, max = 2000) {
  const value = String(text ?? "");
  return value.length > max ? `${value.slice(0, max)}...` : value;
}

function summarizeJsonError(text) {
  return truncateText(String(text ?? "").replace(/\s+/g, " ").trim(), 500);
}

async function postJson(url, headers, body) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CONFIG.requestTimeoutMs);
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    return {
      ok: false,
      status: 0,
      error: err?.name === "AbortError"
        ? `request timed out after ${CONFIG.requestTimeoutMs}ms`
        : summarizeJsonError(err?.message ?? String(err)),
    };
  } finally {
    clearTimeout(timeout);
  }
  const text = await response.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { non_json_body: summarizeJsonError(text) };
  }
  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      error: summarizeJsonError(json.error?.message ?? json.message ?? json.non_json_body ?? text),
    };
  }
  return { ok: true, status: response.status, json };
}

function extractResponsesText(json) {
  if (typeof json.output_text === "string") return json.output_text;
  const chunks = [];
  for (const item of json.output ?? []) {
    for (const part of item.content ?? []) {
      if (typeof part.text === "string") chunks.push(part.text);
    }
  }
  return chunks.join("\n").trim();
}

function extractJsonObject(text) {
  const raw = String(text ?? "").trim();
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : raw;
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(candidate.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

function norm(value) {
  return String(value ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

function flattenValue(value) {
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.map(flattenValue).join(" ");
  }
  if (typeof value === "object") {
    return Object.entries(value).map(([key, val]) => `${key} ${flattenValue(val)}`).join(" ");
  }
  return String(value);
}

function hasExpectedTokens(actual, expected) {
  const actualNorm = norm(actual);
  const tokens = norm(expected).match(/[a-z0-9_:+.-]+/g) ?? [];
  return tokens.every((token) => actualNorm.includes(token));
}

function gradeFinal(text) {
  const parsed = extractJsonObject(text);
  const checks = {};
  if (!parsed || typeof parsed !== "object") {
    return { pass: false, parsed: null, checks: { parse_json: false }, score: 0 };
  }

  checks.parse_json = true;
  for (const [key, expected] of Object.entries(EXPECTED)) {
    checks[key] = typeof expected === "boolean"
      ? parsed[key] === expected
      : hasExpectedTokens(flattenValue(parsed[key]), expected);
  }
  const risk = norm(flattenValue(parsed.primary_risk));
  const mitigation = norm(flattenValue(parsed.mitigation));
  checks.primary_risk = risk.includes("batch importer")
    && risk.includes("429")
    && (risk.includes("double") || risk.includes("duplicate"));
  checks.mitigation = mitigation.includes("idempotency")
    && mitigation.includes("source_event_id");

  const values = Object.values(checks);
  const passed = values.filter(Boolean).length;
  return {
    pass: values.every(Boolean),
    parsed,
    checks,
    score: Number((passed / values.length).toFixed(4)),
  };
}

function usageFromDeepSeek(json) {
  const usage = json.usage ?? {};
  const promptTokens = usage.prompt_tokens ?? usage.input_tokens ?? 0;
  const hitTokens = usage.prompt_cache_hit_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? 0;
  const missTokens = usage.prompt_cache_miss_tokens ?? Math.max(0, promptTokens - hitTokens);
  return {
    prompt_tokens: promptTokens,
    cache_hit_tokens: hitTokens,
    cache_miss_tokens: missTokens,
    cache_hit_ratio: promptTokens > 0 ? Number((hitTokens / promptTokens).toFixed(4)) : 0,
    output_tokens: usage.completion_tokens ?? usage.output_tokens ?? 0,
  };
}

function usageFromResponses(json) {
  const usage = json.usage ?? {};
  const details = usage.input_tokens_details ?? usage.prompt_tokens_details ?? {};
  const inputTokens = usage.input_tokens ?? usage.prompt_tokens ?? 0;
  const cachedTokens = details.cached_tokens ?? usage.cached_tokens ?? 0;
  return {
    input_tokens: inputTokens,
    cached_tokens: cachedTokens,
    miss_tokens: Math.max(0, inputTokens - cachedTokens),
    cache_hit_ratio: inputTokens > 0 ? Number((cachedTokens / inputTokens).toFixed(4)) : 0,
    output_tokens: usage.output_tokens ?? usage.completion_tokens ?? 0,
  };
}

function addUsage(total, usage) {
  for (const [key, value] of Object.entries(usage)) {
    if (typeof value === "number" && key !== "cache_hit_ratio") {
      total[key] = (total[key] ?? 0) + value;
    }
  }
}

function finalizeUsage(total) {
  if ("prompt_tokens" in total) {
    total.cache_hit_ratio = total.prompt_tokens > 0
      ? Number(((total.cache_hit_tokens ?? 0) / total.prompt_tokens).toFixed(4))
      : 0;
  }
  if ("input_tokens" in total) {
    total.cache_hit_ratio = total.input_tokens > 0
      ? Number(((total.cached_tokens ?? 0) / total.input_tokens).toFixed(4))
      : 0;
  }
  return total;
}

async function runDeepSeekScenario(scenario) {
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) return { skipped: "missing DEEPSEEK_API_KEY" };

  const baseUrl = (process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com/v1").replace(/\/$/, "");
  const model = process.env.DEEPSEEK_MODEL || "deepseek-v4-pro";
  const messages = [{ role: "system", content: makeStableSystem() }];
  const turns = buildScenarioTurns(scenario);
  const rows = [];
  const total = {};
  let finalText = "";

  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i];
    const requestMessages = [...messages, { role: "user", content: turn.requestUser }];
    const result = await postJson(`${baseUrl}/chat/completions`, {
      authorization: `Bearer ${key}`,
    }, {
      model,
      messages: requestMessages,
      temperature: 0,
      max_tokens: CONFIG.maxOutputTokens,
      enable_thinking: false,
    });
    if (!result.ok) {
      return { error: result.error, status: result.status, rows, total: finalizeUsage(total) };
    }

    const text = result.json.choices?.[0]?.message?.content?.trim() ?? "";
    const usage = usageFromDeepSeek(result.json);
    rows.push({ turn: i + 1, recall_chars: turn.recallChars, usage, output_preview: truncateText(text, 300) });
    addUsage(total, usage);
    messages.push({ role: "user", content: turn.persistedUser });
    messages.push({ role: "assistant", content: text });
    finalText = text;
    await sleep(CONFIG.delayMs);
  }

  return {
    model,
    scenario,
    rows,
    total: finalizeUsage(total),
    final_output: truncateText(finalText, 4000),
    grade: gradeFinal(finalText),
  };
}

async function runResponsesScenario(scenario) {
  const key = process.env.PIXEL_API_KEY || process.env.OPENAI_API_KEY;
  if (!key) return { skipped: "missing PIXEL_API_KEY/OPENAI_API_KEY" };

  const baseUrl = (process.env.PIXEL_BASE_URL || "https://api.ai-pixel.online").replace(/\/$/, "");
  const model = process.env.PIXEL_MODEL || "gpt-5.5";
  const history = [];
  const turns = buildScenarioTurns(scenario);
  const rows = [];
  const total = {};
  let finalText = "";

  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i];
    const input = [...history, { role: "user", content: turn.requestUser }];
    const result = await postJson(`${baseUrl}/v1/responses`, {
      authorization: `Bearer ${key}`,
    }, {
      model,
      instructions: makeStableSystem(),
      input,
      store: false,
      reasoning: { effort: process.env.PIXEL_REASONING_EFFORT || "xhigh" },
      max_output_tokens: CONFIG.maxOutputTokens,
    });
    if (!result.ok) {
      return { error: result.error, status: result.status, rows, total: finalizeUsage(total) };
    }

    const text = extractResponsesText(result.json);
    const usage = usageFromResponses(result.json);
    rows.push({ turn: i + 1, recall_chars: turn.recallChars, usage, output_preview: truncateText(text, 300) });
    addUsage(total, usage);
    history.push({ role: "user", content: turn.persistedUser });
    history.push({ role: "assistant", content: text });
    finalText = text;
    await sleep(CONFIG.delayMs);
  }

  return {
    model,
    scenario,
    rows,
    total: finalizeUsage(total),
    final_output: truncateText(finalText, 4000),
    grade: gradeFinal(finalText),
  };
}

function compareScenarioResults(provider, baseline, optimized) {
  const sameTaskPass = Boolean(baseline?.grade?.pass && optimized?.grade?.pass);
  const baselineTotal = baseline?.total ?? {};
  const optimizedTotal = optimized?.total ?? {};
  const promptTokenKey = "prompt_tokens" in baselineTotal ? "prompt_tokens" : "input_tokens";
  const missTokenKey = "cache_miss_tokens" in baselineTotal ? "cache_miss_tokens" : "miss_tokens";
  const hitKey = "cache_hit_tokens" in baselineTotal ? "cache_hit_tokens" : "cached_tokens";

  const beforeTokens = baselineTotal[promptTokenKey] ?? 0;
  const afterTokens = optimizedTotal[promptTokenKey] ?? 0;
  const beforeMiss = baselineTotal[missTokenKey] ?? 0;
  const afterMiss = optimizedTotal[missTokenKey] ?? 0;
  const beforeHit = baselineTotal[hitKey] ?? 0;
  const afterHit = optimizedTotal[hitKey] ?? 0;

  return {
    provider,
    same_task_pass: sameTaskPass,
    baseline_grade: baseline?.grade?.score ?? null,
    optimized_grade: optimized?.grade?.score ?? null,
    token_key: promptTokenKey,
    baseline_tokens: beforeTokens,
    optimized_tokens: afterTokens,
    token_delta: afterTokens - beforeTokens,
    token_delta_pct: beforeTokens > 0 ? Number((((afterTokens - beforeTokens) / beforeTokens) * 100).toFixed(2)) : null,
    hit_tokens_before: beforeHit,
    hit_tokens_after: afterHit,
    miss_token_key: missTokenKey,
    baseline_miss_tokens: beforeMiss,
    optimized_miss_tokens: afterMiss,
    miss_delta: afterMiss - beforeMiss,
    miss_delta_pct: beforeMiss > 0 ? Number((((afterMiss - beforeMiss) / beforeMiss) * 100).toFixed(2)) : null,
    cache_hit_ratio_before: baselineTotal.cache_hit_ratio ?? null,
    cache_hit_ratio_after: optimizedTotal.cache_hit_ratio ?? null,
    cache_hit_ratio_delta_pp: baselineTotal.cache_hit_ratio != null && optimizedTotal.cache_hit_ratio != null
      ? Number(((optimizedTotal.cache_hit_ratio - baselineTotal.cache_hit_ratio) * 100).toFixed(2))
      : null,
  };
}

async function runProvider(provider, onProgress = async () => {}) {
  if (CONFIG.dryRun) {
    const baseline = {
      scenario: "show_injected_risk",
      total: provider === "deepseek"
        ? { prompt_tokens: 100, cache_hit_tokens: 70, cache_miss_tokens: 30, output_tokens: 10, cache_hit_ratio: 0.7 }
        : { input_tokens: 100, cached_tokens: 20, miss_tokens: 80, output_tokens: 10, cache_hit_ratio: 0.2 },
      final_output: JSON.stringify({
        ...EXPECTED,
        primary_risk: "the batch importer can double entries when retrying after HTTP 429 responses",
        mitigation: "add an idempotency key and deduplicate by source_event_id before insert",
      }),
    };
    baseline.grade = gradeFinal(baseline.final_output);
    const optimized = {
      scenario: "ABC_combined",
      total: provider === "deepseek"
        ? { prompt_tokens: 50, cache_hit_tokens: 35, cache_miss_tokens: 15, output_tokens: 10, cache_hit_ratio: 0.7 }
        : { input_tokens: 50, cached_tokens: 20, miss_tokens: 30, output_tokens: 10, cache_hit_ratio: 0.4 },
      final_output: baseline.final_output,
    };
    optimized.grade = gradeFinal(optimized.final_output);
    return { provider, baseline, optimized, comparison: compareScenarioResults(provider, baseline, optimized) };
  }

  const runner = provider === "deepseek" ? runDeepSeekScenario : runResponsesScenario;
  const result = { provider, baseline: null, optimized: null, comparison: null };
  const baseline = await runner("show_injected_risk");
  result.baseline = baseline;
  await onProgress(result);
  const optimized = await runner("ABC_combined");
  result.optimized = optimized;
  result.comparison = baseline.skipped || optimized.skipped || baseline.error || optimized.error
      ? null
      : compareScenarioResults(provider, baseline, optimized);
  await onProgress(result);
  return result;
}

async function main() {
  if (REGRADE_PATH) {
    const raw = JSON.parse(await fs.readFile(REGRADE_PATH, "utf8"));
    for (const result of raw.results ?? []) {
      if (result.baseline?.final_output) result.baseline.grade = gradeFinal(result.baseline.final_output);
      if (result.optimized?.final_output) result.optimized.grade = gradeFinal(result.optimized.final_output);
      if (result.baseline?.grade && result.optimized?.grade && !result.baseline.error && !result.optimized.error) {
        result.comparison = compareScenarioResults(result.provider, result.baseline, result.optimized);
      }
    }
    const outPath = REGRADE_PATH.replace(/\.json$/i, ".regraded.json");
    await fs.writeFile(outPath, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
    console.log(JSON.stringify({
      report: outPath,
      comparisons: (raw.results ?? []).map((r) => r.comparison),
    }, null, 2));
    return;
  }

  const selected = CONFIG.providers.includes("all") ? ["deepseek", "pixel_responses"] : CONFIG.providers;
  await fs.mkdir(CONFIG.outDir, { recursive: true });

  const results = [];
  const jsonPath = path.join(CONFIG.outDir, `issue120-e2e-${Date.now()}.json`);
  const makeReport = () => ({
    generated_at: new Date().toISOString(),
    dry_run: CONFIG.dryRun,
    task: {
      description: "Issue #120 E2E comparison: same release-brief task, showInjected risk baseline vs ABC combined.",
      expected: EXPECTED,
      turns: CONFIG.turnCount <= 2 ? 2 : TURNS.length,
    },
    results,
  });

  for (const provider of selected) {
    const normalized = provider === "pixel" || provider === "gpt" ? "pixel_responses" : provider;
    if (!["deepseek", "pixel_responses"].includes(normalized)) {
      results.push({ provider, error: "unknown provider" });
      await fs.writeFile(jsonPath, `${JSON.stringify(makeReport(), null, 2)}\n`, "utf8");
      continue;
    }
    const slot = results.push({ provider: normalized, status: "running" }) - 1;
    const providerResult = await runProvider(normalized, async (partial) => {
      results[slot] = partial;
      await fs.writeFile(jsonPath, `${JSON.stringify(makeReport(), null, 2)}\n`, "utf8");
    });
    results[slot] = providerResult;
    await fs.writeFile(jsonPath, `${JSON.stringify(makeReport(), null, 2)}\n`, "utf8");
  }

  console.log(JSON.stringify({
    report: jsonPath,
    dry_run: CONFIG.dryRun,
    comparisons: results.map((r) => r.comparison ?? { provider: r.provider, skipped: r.baseline?.skipped || r.optimized?.skipped, error: r.baseline?.error || r.optimized?.error }),
  }, null, 2));
}

main().catch((err) => {
  console.error(err?.stack || String(err));
  process.exitCode = 1;
});
