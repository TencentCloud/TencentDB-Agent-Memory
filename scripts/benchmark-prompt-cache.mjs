#!/usr/bin/env node

import { pathToFileURL } from "node:url";

/**
 * Controlled prompt-cache A/B runner for OpenAI-compatible providers.
 *
 * Required environment variables:
 *   PROMPT_CACHE_BENCH_BASE_URL
 *   PROMPT_CACHE_BENCH_API_KEY
 *   PROMPT_CACHE_BENCH_MODEL
 *
 * Optional:
 *   PROMPT_CACHE_BENCH_TURNS       default 3, minimum 3
 *   PROMPT_CACHE_BENCH_DELAY_MS    default 3000
 */

const baseUrl = process.env.PROMPT_CACHE_BENCH_BASE_URL?.trim();
const apiKey = process.env.PROMPT_CACHE_BENCH_API_KEY?.trim();
const model = process.env.PROMPT_CACHE_BENCH_MODEL?.trim();
const turns = Math.max(3, Number.parseInt(process.env.PROMPT_CACHE_BENCH_TURNS ?? "3", 10) || 3);
const delayMs = Math.max(0, Number.parseInt(process.env.PROMPT_CACHE_BENCH_DELAY_MS ?? "3000", 10) || 0);

const invokedDirectly = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (invokedDirectly) {
  if (!baseUrl || !apiKey || !model) {
    console.error(
      "Set PROMPT_CACHE_BENCH_BASE_URL, PROMPT_CACHE_BENCH_API_KEY, and " +
      "PROMPT_CACHE_BENCH_MODEL before running this benchmark.",
    );
    process.exitCode = 2;
  } else {
    await main();
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function normalizeUsage(usage) {
  if (!usage || typeof usage !== "object") return { available: false };

  const promptTokens = readNumber(usage.prompt_tokens);
  const directHit = readNumber(usage.prompt_cache_hit_tokens);
  const detailHit = readNumber(usage.prompt_tokens_details?.cached_tokens);
  const hitTokens = directHit ?? detailHit;
  const directMiss = readNumber(usage.prompt_cache_miss_tokens);
  const missTokens = directMiss ?? (
    promptTokens !== undefined && hitTokens !== undefined
      ? Math.max(0, promptTokens - hitTokens)
      : undefined
  );

  if (hitTokens === undefined || missTokens === undefined) {
    return {
      available: false,
      promptTokens: promptTokens ?? null,
      reason: "provider response did not expose cache hit/miss token details",
    };
  }

  const total = hitTokens + missTokens;
  return {
    available: true,
    promptTokens: promptTokens ?? total,
    hitTokens,
    missTokens,
    hitRate: total > 0 ? hitTokens / total : null,
  };
}

export function buildRequest(variant, turn, experimentId, modelId = model) {
  const stableMemory = [
    "<user-persona>",
    "The user expects cache-stable implementation guidance. ".repeat(160),
    "</user-persona>",
    "<memory-tools-guide>Use memory search when deeper context is required.</memory-tools-guide>",
  ].join("\n");
  const hostStable = "# Host instructions\nAnswer with exactly OK.";
  const volatileHostTail = `# Runtime\nrequest=${turn}\nchannel=benchmark`;
  const experimentMarker = `<experiment>${experimentId}</experiment>`;
  const dynamicRecall = [
    "<relevant-memories>",
    `Turn-specific recalled fact ${turn}. ` + "dynamic ".repeat(80),
    "</relevant-memories>",
  ].join("\n");
  const userPrompt = "Confirm the benchmark request with exactly OK.";

  const optimized = variant === "optimized";
  return {
    model: modelId,
    messages: [
      {
        role: "system",
        content: optimized
          ? `${experimentMarker}\n\n${stableMemory}\n\n${hostStable}\n\n${volatileHostTail}`
          : `${experimentMarker}\n\n${hostStable}\n\n${volatileHostTail}\n\n${stableMemory}`,
      },
      {
        role: "user",
        content: optimized
          ? `${userPrompt}\n\n${dynamicRecall}`
          : `${dynamicRecall}\n\n${userPrompt}`,
      },
    ],
    temperature: 0,
    max_tokens: 8,
    stream: false,
  };
}

async function callProvider(body) {
  const endpoint = `${baseUrl.replace(/\/$/, "")}/chat/completions`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const payload = await response.json().catch(() => undefined);
  if (!response.ok) {
    const message = payload?.error?.message ?? payload?.message ?? `HTTP ${response.status}`;
    throw new Error(`Provider request failed: ${message}`);
  }
  return normalizeUsage(payload?.usage);
}

export function aggregate(samples) {
  const measured = samples.slice(1).filter((sample) => sample.available);
  if (measured.length === 0) {
    return {
      available: false,
      reason: samples.find((sample) => sample.reason)?.reason ?? "no measurable warm requests",
    };
  }
  const hitTokens = measured.reduce((sum, sample) => sum + sample.hitTokens, 0);
  const missTokens = measured.reduce((sum, sample) => sum + sample.missTokens, 0);
  const total = hitTokens + missTokens;
  return {
    available: true,
    measuredTurns: measured.length,
    hitTokens,
    missTokens,
    hitRate: total > 0 ? hitTokens / total : null,
  };
}

async function runVariant(variant) {
  const experimentId = `${variant}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const samples = [];
  for (let turn = 1; turn <= turns; turn += 1) {
    if (turn > 1 && delayMs > 0) await sleep(delayMs);
    const usage = await callProvider(buildRequest(variant, turn, experimentId));
    samples.push({ turn, ...usage });
  }
  return { variant, samples, warmAggregate: aggregate(samples) };
}

async function main() {
  const startedAt = new Date().toISOString();
  const legacy = await runVariant("legacy");
  const optimized = await runVariant("optimized");
  const before = legacy.warmAggregate;
  const after = optimized.warmAggregate;
  const hitRateDelta = before.available && after.available
    ? after.hitRate - before.hitRate
    : null;

  console.log(JSON.stringify({
    startedAt,
    providerEndpoint: baseUrl,
    model,
    turns,
    delayMs,
    variants: [legacy, optimized],
    hitRateDelta,
  }, null, 2));
}
