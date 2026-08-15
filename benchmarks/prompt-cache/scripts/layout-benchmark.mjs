#!/usr/bin/env node

import { DEFAULT_VARIANTS, runSyntheticSession } from "../lib/prompt-layout.mjs";
import { writeResult } from "../lib/result-file.mjs";

const turns = Math.max(
  3,
  Number.parseInt(process.env.PROMPT_CACHE_BENCH_TURNS ?? "6", 10) || 6,
);

const result = {
  schemaVersion: 1,
  kind: "offline-layout",
  generatedAt: new Date().toISOString(),
  warning: [
    "Synthetic request layout only.",
    "Byte-prefix length is not provider cache-hit evidence.",
    "No OpenClaw transcript, compaction, or truncation is executed.",
  ],
  variants: DEFAULT_VARIANTS.map((variant) => runSyntheticSession(variant, turns)),
};

const output = await writeResult("offline-layout", result);
console.log(JSON.stringify({ output, ...result }, null, 2));
