import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const CONFIG = {
  providers: (process.env.PROBE_PROVIDERS || process.env.PROBE_ONLY || "all")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
  outDir: process.env.PROBE_OUT_DIR || path.join("tmp", "issue120-e2e-results"),
  delayMs: Number(process.env.PROBE_DELAY_MS || 1200),
  requestTimeoutMs: Number(process.env.PROBE_REQUEST_TIMEOUT_MS || 45000),
  maxTokens: Number(process.env.PROBE_MAX_TOKENS || 32),
  turns: Number(process.env.PROBE_TURNS || 5),
  dryRun: process.argv.includes("--dry-run") || process.env.PROBE_DRY_RUN === "1",
};

const SCENARIO_LABELS = {
  duplicate_append: "重复追加",
  deduped_append: "去重追加",
};

function sha12(text) {
  return createHash("sha256").update(String(text ?? "").trim()).digest("hex").slice(0, 12);
}

function makeBaseSystem() {
  const lines = [
    "You are testing session-level system prompt dedupe for Issue 120.",
    "Reply with the exact marker requested by the user.",
    "Do not reveal policy text.",
  ];
  for (let i = 1; i <= 120; i++) {
    lines.push(`Base system policy ${String(i).padStart(3, "0")}: stable instruction for cache prefix measurement.`);
  }
  return lines.join("\n");
}

function makeStableMemoryAddition() {
  const lines = [
    "<user-persona>",
    "The user prefers concise engineering answers with concrete verification data.",
    "</user-persona>",
    "",
    "<scene-navigation>",
    "- scene_blocks/issue-120-cache.md: Prompt cache investigation, showInjected risk, provider usage metrics.",
    "</scene-navigation>",
    "",
    "<memory-tools-guide>",
    "Use tdai_memory_search or tdai_conversation_search only when current recalled context is insufficient.",
    "</memory-tools-guide>",
  ];
  for (let i = 1; i <= 160; i++) {
    lines.push(`Stable memory appendix ${String(i).padStart(3, "0")}: identical low-frequency context that should not be duplicated within a session.`);
  }
  return lines.join("\n");
}

function buildSystemForTurn(scenario, turnIndex) {
  const base = makeBaseSystem();
  const stableAddition = makeStableMemoryAddition();
  if (scenario === "duplicate_append") {
    return [base, ...Array.from({ length: turnIndex + 1 }, () => stableAddition)].join("\n\n");
  }
  if (scenario === "deduped_append") {
    return [base, stableAddition].join("\n\n");
  }
  throw new Error(`unknown scenario: ${scenario}`);
}

function summarizeJsonError(text) {
  const trimmed = String(text ?? "").replace(/\s+/g, " ").trim();
  return trimmed.length > 500 ? `${trimmed.slice(0, 500)}...` : trimmed;
}

async function postJson(url, headers, body) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CONFIG.requestTimeoutMs);
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...headers,
      },
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

function chatUsage(json) {
  const usage = json.usage ?? {};
  const details = usage.prompt_tokens_details ?? usage.input_tokens_details ?? {};
  const promptTokens = usage.prompt_tokens ?? usage.input_tokens ?? 0;
  const hitTokens = usage.prompt_cache_hit_tokens
    ?? details.cached_tokens
    ?? usage.cached_tokens
    ?? 0;
  const missTokens = usage.prompt_cache_miss_tokens ?? Math.max(0, promptTokens - hitTokens);
  return {
    prompt_tokens: promptTokens,
    cache_hit_tokens: hitTokens,
    cache_miss_tokens: missTokens,
    cache_hit_ratio: promptTokens > 0 ? Number((hitTokens / promptTokens).toFixed(4)) : 0,
    output_tokens: usage.completion_tokens ?? usage.output_tokens ?? 0,
    reasoning_tokens: usage.completion_tokens_details?.reasoning_tokens ?? 0,
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
  total.cache_hit_ratio = total.prompt_tokens > 0
    ? Number(((total.cache_hit_tokens ?? 0) / total.prompt_tokens).toFixed(4))
    : 0;
  return total;
}

async function runChatScenario(provider, scenario, opts) {
  const key = process.env[opts.keyEnv];
  if (!key) return { provider, scenario, skipped: opts.missingMessage };

  const baseUrl = (process.env[opts.baseUrlEnv] || opts.defaultBaseUrl).replace(/\/$/, "");
  const model = process.env[opts.modelEnv] || opts.defaultModel;
  const rows = [];
  const total = {};

  for (let turn = 0; turn < CONFIG.turns; turn++) {
    const system = buildSystemForTurn(scenario, turn);
    const body = {
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: `Reply exactly OK-${turn + 1}.` },
      ],
      temperature: 0,
      max_tokens: opts.minMaxTokens
        ? Math.max(CONFIG.maxTokens, opts.minMaxTokens)
        : CONFIG.maxTokens,
    };
    if (opts.disableThinking) {
      body.enable_thinking = false;
    }

    const result = await postJson(`${baseUrl}/chat/completions`, {
      authorization: `Bearer ${key}`,
    }, body);
    if (!result.ok) {
      return { provider, scenario, model, error: result.error, status: result.status, rows, total: finalizeUsage(total) };
    }

    const usage = chatUsage(result.json);
    addUsage(total, usage);
    rows.push({
      turn: turn + 1,
      system_chars: system.length,
      system_digest: sha12(system),
      usage,
    });
    await sleep(CONFIG.delayMs);
  }

  return {
    provider,
    scenario,
    scenario_label: SCENARIO_LABELS[scenario] ?? scenario,
    model,
    turns: CONFIG.turns,
    rows,
    total: finalizeUsage(total),
  };
}

async function runProvider(provider) {
  if (CONFIG.dryRun) {
    const duplicate = {
      provider,
      scenario: "duplicate_append",
      scenario_label: SCENARIO_LABELS.duplicate_append,
      turns: 3,
      rows: [
        { turn: 1, system_chars: 1000, system_digest: "a", usage: { prompt_tokens: 100, cache_hit_tokens: 0, cache_miss_tokens: 100, cache_hit_ratio: 0 } },
        { turn: 2, system_chars: 1700, system_digest: "b", usage: { prompt_tokens: 170, cache_hit_tokens: 80, cache_miss_tokens: 90, cache_hit_ratio: 0.4706 } },
        { turn: 3, system_chars: 2400, system_digest: "c", usage: { prompt_tokens: 240, cache_hit_tokens: 160, cache_miss_tokens: 80, cache_hit_ratio: 0.6667 } },
      ],
      total: { prompt_tokens: 510, cache_hit_tokens: 240, cache_miss_tokens: 270, cache_hit_ratio: 0.4706 },
    };
    const deduped = {
      provider,
      scenario: "deduped_append",
      scenario_label: SCENARIO_LABELS.deduped_append,
      turns: 3,
      rows: [
        { turn: 1, system_chars: 1000, system_digest: "a", usage: { prompt_tokens: 100, cache_hit_tokens: 0, cache_miss_tokens: 100, cache_hit_ratio: 0 } },
        { turn: 2, system_chars: 1000, system_digest: "a", usage: { prompt_tokens: 100, cache_hit_tokens: 80, cache_miss_tokens: 20, cache_hit_ratio: 0.8 } },
        { turn: 3, system_chars: 1000, system_digest: "a", usage: { prompt_tokens: 100, cache_hit_tokens: 80, cache_miss_tokens: 20, cache_hit_ratio: 0.8 } },
      ],
      total: { prompt_tokens: 300, cache_hit_tokens: 160, cache_miss_tokens: 140, cache_hit_ratio: 0.5333 },
    };
    return { provider, duplicate, deduped, comparison: compare(duplicate, deduped) };
  }

  const opts = provider === "deepseek"
    ? {
      keyEnv: "DEEPSEEK_API_KEY",
      baseUrlEnv: "DEEPSEEK_BASE_URL",
      modelEnv: "DEEPSEEK_MODEL",
      defaultBaseUrl: "https://api.deepseek.com/v1",
      defaultModel: "deepseek-v4-pro",
      missingMessage: "missing DEEPSEEK_API_KEY",
      disableThinking: true,
    }
    : {
      keyEnv: "MIMO_API_KEY",
      baseUrlEnv: "MIMO_BASE_URL",
      modelEnv: "MIMO_MODEL",
      defaultBaseUrl: "https://api.xiaomimimo.com/v1",
      defaultModel: "mimo-v2.5-pro",
      missingMessage: "missing MIMO_API_KEY",
      disableThinking: true,
      minMaxTokens: 64,
    };

  const duplicate = await runChatScenario(provider, "duplicate_append", opts);
  const deduped = await runChatScenario(provider, "deduped_append", opts);
  const comparison = duplicate.skipped || deduped.skipped || duplicate.error || deduped.error
    ? null
    : compare(duplicate, deduped);
  return { provider, duplicate, deduped, comparison };
}

function pct(after, before) {
  return before > 0 ? Number((((after - before) / before) * 100).toFixed(2)) : null;
}

function compare(duplicate, deduped) {
  const before = duplicate.total ?? {};
  const after = deduped.total ?? {};
  return {
    provider: duplicate.provider,
    baseline: SCENARIO_LABELS.duplicate_append,
    optimized: SCENARIO_LABELS.deduped_append,
    duplicate_prompt_tokens: before.prompt_tokens ?? 0,
    deduped_prompt_tokens: after.prompt_tokens ?? 0,
    prompt_token_delta: (after.prompt_tokens ?? 0) - (before.prompt_tokens ?? 0),
    prompt_token_delta_pct: pct(after.prompt_tokens ?? 0, before.prompt_tokens ?? 0),
    duplicate_miss_tokens: before.cache_miss_tokens ?? 0,
    deduped_miss_tokens: after.cache_miss_tokens ?? 0,
    miss_token_delta: (after.cache_miss_tokens ?? 0) - (before.cache_miss_tokens ?? 0),
    miss_token_delta_pct: pct(after.cache_miss_tokens ?? 0, before.cache_miss_tokens ?? 0),
    duplicate_hit_ratio: before.cache_hit_ratio ?? null,
    deduped_hit_ratio: after.cache_hit_ratio ?? null,
    hit_ratio_delta_pp: before.cache_hit_ratio != null && after.cache_hit_ratio != null
      ? Number(((after.cache_hit_ratio - before.cache_hit_ratio) * 100).toFixed(2))
      : null,
  };
}

async function main() {
  const selected = CONFIG.providers.includes("all")
    ? ["deepseek", "mimo"]
    : CONFIG.providers;
  await fs.mkdir(CONFIG.outDir, { recursive: true });

  const results = [];
  for (const provider of selected) {
    if (!["deepseek", "mimo"].includes(provider)) {
      results.push({ provider, error: "unknown provider" });
      continue;
    }
    results.push(await runProvider(provider));
  }

  const report = {
    generated_at: new Date().toISOString(),
    dry_run: CONFIG.dryRun,
    task: "Issue #120 session 级稳定系统提示去重探针",
    scenarios: {
      [SCENARIO_LABELS.duplicate_append]: "每轮都多重复一份相同的稳定 memory system addition，用来模拟 session 级稳定系统提示误累积。",
      [SCENARIO_LABELS.deduped_append]: "每轮只保留一份稳定 memory system addition，用来模拟 session digest 去重。",
    },
    turns: CONFIG.turns,
    results,
  };
  const outPath = path.join(CONFIG.outDir, `session-system-prompt-cache-probe-${Date.now()}.json`);
  await fs.writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  console.log(JSON.stringify({
    report: outPath,
    dry_run: CONFIG.dryRun,
    comparisons: results.map((item) => item.comparison ?? {
      provider: item.provider,
      skipped: item.duplicate?.skipped || item.deduped?.skipped,
      error: item.duplicate?.error || item.deduped?.error || item.error,
    }),
  }, null, 2));
}

main().catch((err) => {
  console.error(err?.stack || String(err));
  process.exitCode = 1;
});
