#!/usr/bin/env node

import fs from "node:fs";

import { buildRequest } from "../lib/prompt-layout.mjs";
import { aggregateWarmSamples, normalizeProviderUsage } from "../lib/provider-usage.mjs";
import { writeResult } from "../lib/result-file.mjs";

const baseUrl = process.env.PROMPT_CACHE_BENCH_BASE_URL?.trim();
const directApiKey = process.env.PROMPT_CACHE_BENCH_API_KEY?.trim();
const apiKeyFile = process.env.PROMPT_CACHE_BENCH_API_KEY_FILE?.trim();
const model = process.env.PROMPT_CACHE_BENCH_MODEL?.trim();
const turns = Math.max(
  3,
  Number.parseInt(process.env.PROMPT_CACHE_BENCH_TURNS ?? "6", 10) || 6,
);
const delayMs = Math.max(
  0,
  Number.parseInt(process.env.PROMPT_CACHE_BENCH_DELAY_MS ?? "3000", 10) || 0,
);

if (directApiKey && apiKeyFile) {
  console.error(
    "Set only one of PROMPT_CACHE_BENCH_API_KEY or "
    + "PROMPT_CACHE_BENCH_API_KEY_FILE.",
  );
  process.exit(2);
}

let apiKey = directApiKey;
if (!apiKey && apiKeyFile) {
  try {
    const stat = fs.statSync(apiKeyFile);
    if (!stat.isFile()) throw new Error("path is not a regular file");
    if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
      throw new Error("file must not be accessible by group or other users");
    }
    apiKey = fs.readFileSync(apiKeyFile, "utf8").trim();
  } catch (error) {
    console.error(`Cannot read secure API key file: ${error.message}`);
    process.exit(2);
  }
}

if (!baseUrl || !apiKey || !model) {
  console.error(
    "Missing PROMPT_CACHE_BENCH_BASE_URL, provider API key, or "
    + "PROMPT_CACHE_BENCH_MODEL. Use PROMPT_CACHE_BENCH_API_KEY_FILE "
    + "for a secure local credential. See benchmarks/prompt-cache/.env.example.",
  );
  process.exit(2);
}

const variantsById = {
  legacy: {
    id: "legacy",
    stablePlacement: "after-volatile",
    dynamicPlacement: "prepend",
    persistRecall: false,
  },
  optimized: {
    id: "optimized",
    stablePlacement: "before-volatile",
    dynamicPlacement: "prepend",
    persistRecall: false,
  },
};

const order = (process.env.PROMPT_CACHE_BENCH_ORDER ?? "legacy,optimized")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

if (
  order.length !== 2
  || new Set(order).size !== 2
  || order.some((id) => !(id in variantsById))
) {
  console.error("PROMPT_CACHE_BENCH_ORDER must be legacy,optimized or optimized,legacy.");
  process.exit(2);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
    signal: AbortSignal.timeout(120_000),
  });

  const payload = await response.json().catch(() => undefined);
  if (!response.ok) {
    const providerMessage = payload?.error?.message ?? payload?.message;
    throw new Error(
      `Provider request failed with HTTP ${response.status}`
      + (providerMessage ? `: ${String(providerMessage).slice(0, 300)}` : ""),
    );
  }
  return normalizeProviderUsage(payload?.usage);
}

async function runVariant(variant) {
  const experimentId = `${variant.id}-${Date.now()}-${crypto.randomUUID()}`;
  const samples = [];
  for (let turn = 1; turn <= turns; turn += 1) {
    if (turn > 1 && delayMs > 0) await sleep(delayMs);
    const request = buildRequest({
      variant,
      turn,
      experimentId,
      history: [],
      model,
    });
    const usage = await callProvider(request.body);
    samples.push({ turn, ...usage });
  }
  return {
    variant,
    samples,
    warmAggregate: aggregateWarmSamples(samples),
  };
}

const runs = [];
for (const id of order) {
  runs.push(await runVariant(variantsById[id]));
}

const byId = Object.fromEntries(runs.map((run) => [run.variant.id, run]));
const legacy = byId.legacy.warmAggregate;
const optimized = byId.optimized.warmAggregate;
const hitRateDelta = legacy.available && optimized.available
  ? optimized.hitRate - legacy.hitRate
  : null;

const result = {
  schemaVersion: 1,
  kind: "direct-provider-stable-placement",
  generatedAt: new Date().toISOString(),
  providerProtocol: "openai-compatible",
  model,
  turns,
  delayMs,
  order,
  coldSampleExcluded: true,
  isolation: {
    changedVariable: "stable system-memory placement around volatile host tail",
    dynamicPlacement: "prepend in both variants",
    persistedHistory: "not exercised",
    openclaw: "not exercised",
  },
  runs,
  hitRateDelta,
};

const output = await writeResult("provider", result);
console.log(JSON.stringify({ output, ...result }, null, 2));
