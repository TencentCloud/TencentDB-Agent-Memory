/**
 * Offline prompt-cache A/B for DeepSeek / OpenAI-compatible relays.
 * No OpenClaw required. Loads .env from repo root.
 *
 * Usage:
 *   1. Fill .env (DS_BASE_URL, DS_API_KEY, DS_MODEL)
 *   2. node scripts/benchmark-prompt-cache.mjs
 *
 * Variants:
 *   - legacy:    stable block AFTER base system (appendSystemContext-like)
 *   - optimized: stable block BEFORE base system (prependSystemContext-like)
 *
 * Never logs API keys or full response text.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

// ─── env ─────────────────────────────────────────────────────────────────────

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const text = fs.readFileSync(filePath, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

loadEnvFile(path.join(ROOT, ".env"));

const CFG = {
  baseUrl: (process.env.DS_BASE_URL || "").replace(/\/+$/, ""),
  apiKey: process.env.DS_API_KEY || "",
  model: process.env.DS_MODEL || "deepseek-chat",
  timeoutMs: Number(process.env.DS_TIMEOUT_MS || 60_000),
  turns: Math.max(2, Number(process.env.DS_TURNS || 4)),
  warmOnly: String(process.env.DS_WARM_ONLY ?? "true").toLowerCase() !== "false",
  outDir: path.resolve(ROOT, process.env.DS_OUT_DIR || "benchmark-runs"),
};

// ─── fixtures (stable vs dynamic) ────────────────────────────────────────────

const STABLE_PERSONA = `<user-persona>
用户偏好：中文简答；技术细节优先可验证事实；时间相关用 Asia/Shanghai。
身份摘要：软件工程师，关注 Agent Memory、prompt cache 与 OpenAI-compatible 接口。
工作习惯：喜欢可复现实验、明确配置默认值、拒绝把密钥写入仓库。
</user-persona>`;

const STABLE_SCENE = `<scene-navigation>
## 场景索引（稳定块）
- [开发] 本地插件调试与 vitest 回归
- [评测] prefix-matching cache A/B（legacy vs optimized system layout）
- [运维] 中转站 OpenAI-compatible /chat/completions
路径占位：memory-tdai/persona.md · scene-index.json
</scene-navigation>`;

const STABLE_TOOLS = `<memory-tools-guide>
## 记忆工具调用指南
- tdai_memory_search：结构化 L1
- tdai_conversation_search：原始 L0
每轮合计最多 3 次搜索。
</memory-tools-guide>`;

const STABLE_BLOCK = [STABLE_PERSONA, STABLE_SCENE, STABLE_TOOLS].join("\n\n");

const BASE_SYSTEM = `You are a helpful assistant for prompt-cache benchmark.
Reply in one short Chinese sentence. Do not invent credentials.
Benchmark-id: issue-120-layout-ab.`;

const USER_TURNS = [
  "请用一句话说明什么是 prompt prefix cache。",
  "上一问里 cache 命中依赖什么前缀条件？",
  "若系统提示尾部每轮变化，对 prefix cache 有何影响？",
  "请对比 system 前部稳定块与尾部稳定块的缓存差异。",
  "总结本轮评测的目的（一句）。",
  "再给一句可执行的优化建议。",
];

function dynamicRecall(turnIndex) {
  return `<relevant-memories>
以下是当前对话召回的相关记忆（动态，每轮不同）：
- [episodic|评测] 第 ${turnIndex + 1} 轮动态召回片段 #${crypto.randomBytes(3).toString("hex")}
- [instruction] 仅作参考，不代表任务进度
</relevant-memories>`;
}

// ─── layout builders ─────────────────────────────────────────────────────────

function buildSystem(variant) {
  if (variant === "optimized") {
    // prependSystemContext-like: stable BEFORE base (cache-friendly prefix)
    return `${STABLE_BLOCK}\n\n${BASE_SYSTEM}`;
  }
  // legacy: stable AFTER base (appendSystemContext-like, after volatile boundary)
  return `${BASE_SYSTEM}\n\n${STABLE_BLOCK}`;
}

function buildMessages(variant, turnIndex, history) {
  const system = buildSystem(variant);
  const userText = USER_TURNS[turnIndex % USER_TURNS.length];
  const recall = dynamicRecall(turnIndex);
  // dynamic recall prepended to user (current plugin default)
  const userContent = `${recall}\n\n${userText}`;
  return {
    system,
    messages: [
      { role: "system", content: system },
      ...history,
      { role: "user", content: userContent },
    ],
    userText,
    userContent,
  };
}

// ─── usage parsing (DeepSeek / OpenAI-compatible variants) ───────────────────

function pickNum(...vals) {
  for (const v of vals) {
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) {
      return Number(v);
    }
  }
  return null;
}

/**
 * Normalize provider usage into cache hit/miss when possible.
 * DeepSeek often: prompt_cache_hit_tokens / prompt_cache_miss_tokens
 * Some relays: cached_tokens under prompt_tokens_details
 */
function parseUsage(usage) {
  if (!usage || typeof usage !== "object") {
    return {
      promptTokens: null,
      completionTokens: null,
      cacheReadTokens: null,
      cacheMissTokens: null,
      cacheHitRate: null,
      rawKeys: [],
    };
  }
  const details = usage.prompt_tokens_details || usage.input_tokens_details || {};
  const promptTokens = pickNum(usage.prompt_tokens, usage.input_tokens, usage.total_tokens);
  const completionTokens = pickNum(usage.completion_tokens, usage.output_tokens);

  let cacheRead = pickNum(
    usage.prompt_cache_hit_tokens,
    usage.cache_read_input_tokens,
    usage.cached_tokens,
    details.cached_tokens,
    details.cache_read_tokens,
    details.cached_tokens_details?.cached_tokens,
  );
  let cacheMiss = pickNum(
    usage.prompt_cache_miss_tokens,
    usage.cache_creation_input_tokens,
    details.cache_miss_tokens,
  );

  // If only cached_tokens + prompt_tokens: miss ≈ prompt - cached
  if (cacheRead != null && cacheMiss == null && promptTokens != null) {
    cacheMiss = Math.max(0, promptTokens - cacheRead);
  }

  let cacheHitRate = null;
  if (cacheRead != null && cacheMiss != null) {
    const denom = cacheRead + cacheMiss;
    if (denom > 0) cacheHitRate = cacheRead / denom;
  } else if (cacheRead != null && promptTokens != null && promptTokens > 0) {
    cacheHitRate = cacheRead / promptTokens;
  }

  return {
    promptTokens,
    completionTokens,
    cacheReadTokens: cacheRead,
    cacheMissTokens: cacheMiss,
    cacheHitRate,
    rawKeys: Object.keys(usage),
  };
}

// ─── HTTP ────────────────────────────────────────────────────────────────────

function chatUrl() {
  const base = CFG.baseUrl;
  if (base.endsWith("/chat/completions")) return base;
  if (base.endsWith("/v1")) return `${base}/chat/completions`;
  return `${base}/chat/completions`;
}

async function chatCompletions(messages) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CFG.timeoutMs);
  try {
    const res = await fetch(chatUrl(), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${CFG.apiKey}`,
      },
      body: JSON.stringify({
        model: CFG.model,
        messages,
        temperature: 0,
        max_tokens: 64,
        stream: false,
      }),
      signal: controller.signal,
    });
    const text = await res.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error(`Non-JSON response HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    if (!res.ok) {
      const msg = body?.error?.message || body?.message || text.slice(0, 200);
      throw new Error(`HTTP ${res.status}: ${msg}`);
    }
    const content =
      body?.choices?.[0]?.message?.content ??
      body?.choices?.[0]?.text ??
      "";
    return {
      content: typeof content === "string" ? content : JSON.stringify(content),
      usage: parseUsage(body?.usage),
      rawUsage: body?.usage ?? null,
      id: body?.id ?? null,
    };
  } finally {
    clearTimeout(timer);
  }
}

// ─── run one variant ─────────────────────────────────────────────────────────

async function runVariant(variant) {
  const history = [];
  const turns = [];
  for (let i = 0; i < CFG.turns; i++) {
    const built = buildMessages(variant, i, history);
    const t0 = Date.now();
    let result;
    try {
      result = await chatCompletions(built.messages);
    } catch (err) {
      turns.push({
        turn: i,
        cold: i === 0,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        ms: Date.now() - t0,
      });
      break;
    }
    const ms = Date.now() - t0;
    const assistantText =
      typeof result.content === "string"
        ? result.content.slice(0, 120)
        : "";
    turns.push({
      turn: i,
      cold: i === 0,
      ok: true,
      ms,
      usage: result.usage,
      // truncated preview only
      assistantPreview: assistantText.replace(/\s+/g, " ").slice(0, 80),
      systemChars: built.system.length,
      userChars: built.userContent.length,
      stableBlockChars: STABLE_BLOCK.length,
    });
    history.push({ role: "user", content: built.userContent });
    history.push({ role: "assistant", content: result.content || "(empty)" });
  }
  return summarize(variant, turns);
}

function summarize(variant, turns) {
  const okTurns = turns.filter((t) => t.ok);
  const sample = CFG.warmOnly ? okTurns.filter((t) => !t.cold) : okTurns;
  const withCache = sample.filter((t) => t.usage?.cacheHitRate != null);
  const avg = (arr, f) =>
    arr.length ? arr.reduce((s, x) => s + (f(x) ?? 0), 0) / arr.length : null;

  const hitRate =
    withCache.length > 0
      ? withCache.reduce((s, t) => s + t.usage.cacheHitRate, 0) / withCache.length
      : null;
  const cacheReadSum = withCache.reduce(
    (s, t) => s + (t.usage.cacheReadTokens ?? 0),
    0,
  );
  const cacheMissSum = withCache.reduce(
    (s, t) => s + (t.usage.cacheMissTokens ?? 0),
    0,
  );

  return {
    variant,
    turns,
    aggregate: {
      warmOnly: CFG.warmOnly,
      okTurns: okTurns.length,
      sampleTurns: sample.length,
      turnsWithCacheFields: withCache.length,
      avgHitRate: hitRate,
      avgHitRatePct: hitRate != null ? +(hitRate * 100).toFixed(2) : null,
      sumCacheReadTokens: withCache.length ? cacheReadSum : null,
      sumCacheMissTokens: withCache.length ? cacheMissSum : null,
      avgLatencyMs: avg(sample, (t) => t.ms),
      cacheFieldsMissing:
        sample.length > 0 && withCache.length === 0
          ? "Relay may strip cache usage fields — layout still exercised, hit rate N/A"
          : null,
    },
  };
}

// ─── main ────────────────────────────────────────────────────────────────────

function maskKey(k) {
  if (!k) return "(empty)";
  if (k.length <= 8) return "****";
  return `${k.slice(0, 4)}…${k.slice(-4)}`;
}

async function main() {
  console.log("=== prompt-cache layout A/B (no OpenClaw) ===");
  console.log(`baseUrl : ${CFG.baseUrl || "(missing)"}`);
  console.log(`model   : ${CFG.model}`);
  console.log(`apiKey  : ${maskKey(CFG.apiKey)}`);
  console.log(`turns   : ${CFG.turns} (warmOnly=${CFG.warmOnly})`);
  console.log(`stable  : ${STABLE_BLOCK.length} chars`);
  console.log("");

  if (!CFG.baseUrl || !CFG.apiKey) {
    console.error(
      "Missing DS_BASE_URL or DS_API_KEY.\n" +
        "Edit .env in repo root, then re-run:\n" +
        "  node scripts/benchmark-prompt-cache.mjs",
    );
    process.exit(1);
  }

  fs.mkdirSync(CFG.outDir, { recursive: true });

  const legacy = await runVariant("legacy");
  console.log(
    `[legacy]    sample=${legacy.aggregate.sampleTurns} ` +
      `hitRate=${legacy.aggregate.avgHitRatePct ?? "N/A"}% ` +
      `read=${legacy.aggregate.sumCacheReadTokens ?? "?"} ` +
      `miss=${legacy.aggregate.sumCacheMissTokens ?? "?"} ` +
      `avgMs=${legacy.aggregate.avgLatencyMs?.toFixed?.(0) ?? "?"}`,
  );
  if (legacy.aggregate.cacheFieldsMissing) {
    console.log(`  note: ${legacy.aggregate.cacheFieldsMissing}`);
  }

  // brief pause so provider cache window is less noisy between variants
  await new Promise((r) => setTimeout(r, 1500));

  const optimized = await runVariant("optimized");
  console.log(
    `[optimized] sample=${optimized.aggregate.sampleTurns} ` +
      `hitRate=${optimized.aggregate.avgHitRatePct ?? "N/A"}% ` +
      `read=${optimized.aggregate.sumCacheReadTokens ?? "?"} ` +
      `miss=${optimized.aggregate.sumCacheMissTokens ?? "?"} ` +
      `avgMs=${optimized.aggregate.avgLatencyMs?.toFixed?.(0) ?? "?"}`,
  );
  if (optimized.aggregate.cacheFieldsMissing) {
    console.log(`  note: ${optimized.aggregate.cacheFieldsMissing}`);
  }

  let deltaPct = null;
  if (
    legacy.aggregate.avgHitRate != null &&
    optimized.aggregate.avgHitRate != null
  ) {
    deltaPct = +(
      (optimized.aggregate.avgHitRate - legacy.aggregate.avgHitRate) *
      100
    ).toFixed(2);
  }

  console.log("");
  console.log("=== summary ===");
  console.log(
    `hitRateDelta (optimized - legacy): ${
      deltaPct != null ? `${deltaPct > 0 ? "+" : ""}${deltaPct} pp` : "N/A"
    }`,
  );

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outPath = path.join(CFG.outDir, `prompt-cache-ab-${stamp}.json`);
  const report = {
    meta: {
      createdAt: new Date().toISOString(),
      baseUrlHost: (() => {
        try {
          return new URL(CFG.baseUrl).host;
        } catch {
          return "(invalid-url)";
        }
      })(),
      model: CFG.model,
      turns: CFG.turns,
      warmOnly: CFG.warmOnly,
      stableBlockChars: STABLE_BLOCK.length,
      // never write api key
    },
    legacy: {
      aggregate: legacy.aggregate,
      turns: legacy.turns.map((t) => ({
        turn: t.turn,
        cold: t.cold,
        ok: t.ok,
        error: t.error,
        ms: t.ms,
        usage: t.usage,
        systemChars: t.systemChars,
        userChars: t.userChars,
      })),
    },
    optimized: {
      aggregate: optimized.aggregate,
      turns: optimized.turns.map((t) => ({
        turn: t.turn,
        cold: t.cold,
        ok: t.ok,
        error: t.error,
        ms: t.ms,
        usage: t.usage,
        systemChars: t.systemChars,
        userChars: t.userChars,
      })),
    },
    hitRateDeltaPp: deltaPct,
  };

  fs.writeFileSync(outPath, JSON.stringify(report, null, 2), "utf8");
  console.log(`report: ${outPath}`);

  // also write latest pointer
  const latest = path.join(CFG.outDir, "prompt-cache-ab-latest.json");
  fs.writeFileSync(latest, JSON.stringify(report, null, 2), "utf8");
  console.log(`latest: ${latest}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack || err.message : err);
  process.exit(1);
});
