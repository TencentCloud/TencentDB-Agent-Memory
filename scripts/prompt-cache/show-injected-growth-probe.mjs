import fs from "node:fs/promises";
import path from "node:path";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const CONFIG = {
  outDir: process.env.PROBE_OUT_DIR || path.join("tmp", "issue120-e2e-results"),
  delayMs: Number(process.env.PROBE_DELAY_MS || 1200),
  requestTimeoutMs: Number(process.env.PROBE_REQUEST_TIMEOUT_MS || 90000),
  turns: Number(process.env.PROBE_TURNS || 10),
  maxTokens: Number(process.env.MIMO_MAX_TOKENS || 64),
};

function makeStableSystem() {
  const lines = [
    "You are testing showInjected history growth for Issue 120.",
    "Reply with the exact marker OK.",
  ];
  for (let i = 1; i <= 120; i++) {
    lines.push(`Stable prefix line ${String(i).padStart(3, "0")}: keep this instruction identical across all requests.`);
  }
  return lines.join("\n");
}

function makeRecallBlock(turn) {
  const lines = [
    `[M1:T${turn}] Product name: Aurora Ledger. Release target: 2026-08-15. Release owner: Lin Wei.`,
    `[M2:T${turn}] Required database: TencentDB for PostgreSQL. Do not switch to Redis or a document database.`,
    `[M3:T${turn}] Feature flags are stored in the config_flags table. The team explicitly rejected Redis.`,
    `[M4:T${turn}] Compliance requirement: EU data residency. The final brief must mention this exactly.`,
    `[M5:T${turn}] Primary risk: the batch importer can double entries when retrying after HTTP 429 responses.`,
    `[M6:T${turn}] Mitigation: add an idempotency key and deduplicate by source_event_id before insert.`,
    `[M7:T${turn}] Acceptance smoke test command: npm run test:smoke.`,
    `[M8:T${turn}] Readiness decision: ready is true after the mitigation and smoke-test command are included.`,
  ];
  for (let i = 1; i <= 72; i++) {
    lines.push(`[P${String(i).padStart(2, "0")}:T${turn}] Cache probe filler for stable project context, architecture constraints, and acceptance notes.`);
  }
  return `<relevant-memories>\n${lines.join("\n")}\n</relevant-memories>`;
}

function makeBudgetedRecallBlock(turn) {
  const lines = [
    `[M1:T${turn}] Product name: Aurora Ledger. Release target: 2026-08-15. Release owner: Lin Wei.`,
    `[M2:T${turn}] Required database: TencentDB for PostgreSQL. Do not switch to Redis or a document database.`,
    `[M3:T${turn}] Feature flags are stored in the config_flags table. The team explicitly rejected Redis.`,
    `[M4:T${turn}] Compliance requirement: EU data residency. The final brief must mention this exactly.`,
    `[M5:T${turn}] Primary risk: the batch importer can double entries when retrying after HTTP 429 responses.`,
    `[M6:T${turn}] Mitigation: add an idempotency key and deduplicate by source_event_id before insert.`,
    `[M7:T${turn}] Acceptance smoke test command: npm run test:smoke.`,
    `[M8:T${turn}] Readiness decision: ready is true after the mitigation and smoke-test command are included.`,
  ];
  for (let i = 1; i <= 12; i++) {
    lines.push(`[P${String(i).padStart(2, "0")}:T${turn}] Budgeted cache probe filler for project context and acceptance notes.`);
  }
  return `<relevant-memories>\n${lines.join("\n")}\n</relevant-memories>`;
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
  } finally {
    clearTimeout(timeout);
  }
  const text = await response.text();
  const json = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(json.error?.message ?? json.message ?? text);
  }
  return json;
}

function usageFromChat(json) {
  const usage = json.usage ?? {};
  const details = usage.prompt_tokens_details ?? usage.input_tokens_details ?? {};
  const promptTokens = usage.prompt_tokens ?? usage.input_tokens ?? 0;
  const hitTokens = usage.prompt_cache_hit_tokens ?? details.cached_tokens ?? usage.cached_tokens ?? 0;
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

function summarizeRows(rows, total) {
  const first = rows[0]?.usage?.prompt_tokens ?? 0;
  const last = rows.at(-1)?.usage?.prompt_tokens ?? 0;
  total.cache_hit_ratio = total.prompt_tokens > 0
    ? Number(((total.cache_hit_tokens ?? 0) / total.prompt_tokens).toFixed(4))
    : 0;
  return {
    first_prompt_tokens: first,
    last_prompt_tokens: last,
    growth: last - first,
    avg_growth_after_first: rows.length > 1 ? Number(((last - first) / (rows.length - 1)).toFixed(2)) : 0,
    total,
    total_recall_chars: rows.reduce((sum, row) => sum + row.recall_chars, 0),
  };
}

async function runScenario(name, buildUser, persistUser) {
  const key = process.env.MIMO_API_KEY;
  if (!key) throw new Error("missing MIMO_API_KEY");
  const baseUrl = (process.env.MIMO_BASE_URL || "https://api.xiaomimimo.com/v1").replace(/\/$/, "");
  const model = process.env.MIMO_MODEL || "mimo-v2.5-pro";
  const messages = [{ role: "system", content: makeStableSystem() }];
  const rows = [];
  const total = {};

  for (let turn = 1; turn <= CONFIG.turns; turn++) {
    const userText = `Reply exactly OK. Turn ${turn}.`;
    const recall = makeRecallBlock(turn);
    const budgetedRecall = makeBudgetedRecallBlock(turn);
    const requestUser = buildUser({ turn, recall, budgetedRecall, userText });
    const injectedChars = requestUser.includes(recall)
      ? recall.length
      : requestUser.includes(budgetedRecall)
        ? budgetedRecall.length
        : 0;
    const json = await postJson(`${baseUrl}/chat/completions`, {
      authorization: `Bearer ${key}`,
    }, {
      model,
      messages: [...messages, { role: "user", content: requestUser }],
      temperature: 0,
      max_tokens: CONFIG.maxTokens,
      enable_thinking: false,
    });
    const usage = usageFromChat(json);
    rows.push({ turn, recall_chars: injectedChars, usage });
    addUsage(total, usage);
    messages.push({ role: "user", content: persistUser({ turn, recall, budgetedRecall, userText }) });
    messages.push({ role: "assistant", content: json.choices?.[0]?.message?.content?.trim() ?? "" });
    await sleep(CONFIG.delayMs);
  }

  return {
    scenario: name,
    model: process.env.MIMO_MODEL || "mimo-v2.5-pro",
    rows,
    summary: summarizeRows(rows, total),
  };
}

async function main() {
  const scenarios = [
    {
      name: "baseline_no_injection",
      buildUser: ({ userText }) => userText,
      persistUser: ({ userText }) => userText,
    },
    {
      name: "A_ephemeral",
      buildUser: ({ recall, userText }) => `${recall}\n\n${userText}`,
      persistUser: ({ userText }) => userText,
    },
    {
      name: "B_dedupe",
      buildUser: ({ turn, recall, userText }) => turn === 1 ? `${recall}\n\n${userText}` : userText,
      persistUser: ({ userText }) => userText,
    },
    {
      name: "C_budget",
      buildUser: ({ budgetedRecall, userText }) => `${budgetedRecall}\n\n${userText}`,
      persistUser: ({ userText }) => userText,
    },
    {
      name: "ABC_combined",
      buildUser: ({ turn, budgetedRecall, userText }) => turn === 1 ? `${budgetedRecall}\n\n${userText}` : userText,
      persistUser: ({ userText }) => userText,
    },
    {
      name: "show_injected_preserved_history",
      buildUser: ({ recall, userText }) => `${recall}\n\n${userText}`,
      persistUser: ({ recall, userText }) => `${recall}\n\n${userText}`,
    },
  ];

  const results = [];
  for (const scenario of scenarios) {
    results.push(await runScenario(scenario.name, scenario.buildUser, scenario.persistUser));
  }

  await fs.mkdir(CONFIG.outDir, { recursive: true });
  const report = path.join(CONFIG.outDir, `issue120-showinjected-growth-mimo-${Date.now()}.json`);
  await fs.writeFile(report, `${JSON.stringify({
    generated_at: new Date().toISOString(),
    provider: "mimo",
    task: "Issue #120 showInjected growth probe",
    results,
  }, null, 2)}\n`, "utf8");

  console.log(JSON.stringify({
    report,
    summaries: results.map((result) => ({ scenario: result.scenario, ...result.summary })),
  }, null, 2));
}

main().catch((err) => {
  console.error(err?.stack || String(err));
  process.exitCode = 1;
});
