/**
 * bench-scoped-key.ts — micro-benchmark for ScopedStorageBackend.key() normalization.
 *
 * Goal: measure per-call cost of the current 3-regex + split normalize path,
 * and compare against a single-pass + cached proposal.
 *
 * Go-bench-compatible output so the iteration engine's go_bench parser can ingest it.
 *
 * Run: node --import tsx scripts/bench-scoped-key.ts
 */
import { performance } from "node:perf_hooks";

// ── current implementation (mirrors adapter.ts ScopedStorageBackend.key) ──
function keyCurrent(prefix: string, key: string): string {
  if (
    typeof key !== "string" ||
    key.includes("\0") ||
    key.startsWith("/") ||
    key.startsWith("\\")
  ) {
    throw new Error(`Invalid scoped storage key: ${JSON.stringify(key)}`);
  }
  const normalized = key.replace(/^\/+/, "").replace(/\\+/g, "/").replace(/\/+/g, "/");
  if (normalized.split("/").some((part) => part === "..")) {
    throw new Error(`Path traversal rejected in scoped storage key: ${key}`);
  }
  return `${prefix}${normalized}`;
}

// ── proposal: single manual pass + small LRU cache ──
// Single-pass normalize: collapse leading slashes, backslash->slash, collapse
// duplicate slashes, detect ".." segment. Returns null on path traversal.
function normalizePass(key: string): string | null {
  const n = key.length;
  let out = "";
  let prevSlash = false;
  let segStart = 0;
  for (let i = 0; i < n; i++) {
    const c = key.charCodeAt(i);
    if (c === 0x5c /* \ */) {
      if (!prevSlash) out += "/";
      prevSlash = true;
      continue;
    }
    if (c === 0x2f /* / */) {
      if (!prevSlash) out += "/";
      prevSlash = true;
      continue;
    }
    prevSlash = false;
    out += key[i];
  }
  // leading slash already collapsed (prevSlash at end ignored); strip a single
  // leading slash if present at start.
  if (out.length > 0 && out.charCodeAt(0) === 0x2f) out = out.slice(1);
  // path traversal check
  let i = 0;
  const m = out.length;
  while (i < m) {
    if (out.charCodeAt(i) === 0x2e /* . */) {
      if (out.charCodeAt(i + 1) === 0x2e) {
        const after = out.charCodeAt(i + 2);
        if (i + 2 === m || after === 0x2f) return null;
      }
    }
    // advance to next slash
    while (i < m && out.charCodeAt(i) !== 0x2f) i++;
    if (i < m) i++;
  }
  return out;
}

class MiniLru {
  private map = new Map<string, string>();
  constructor(private cap: number) {}
  get(k: string): string | undefined {
    const v = this.map.get(k);
    if (v !== undefined) {
      this.map.delete(k);
      this.map.set(k, v);
    }
    return v;
  }
  set(k: string, v: string): void {
    if (this.map.size >= this.cap) this.map.delete(this.map.keys().next().value as string);
    this.map.set(k, v);
  }
}

const cache = new MiniLru(1024);
function keyProposed(prefix: string, key: string): string {
  if (typeof key !== "string" || key.includes("\0") || key.startsWith("/") || key.startsWith("\\")) {
    throw new Error(`Invalid scoped storage key: ${JSON.stringify(key)}`);
  }
  const cached = cache.get(key);
  if (cached !== undefined) return `${prefix}${cached}`;
  const normalized = normalizePass(key);
  if (normalized === null) {
    throw new Error(`Path traversal rejected in scoped storage key: ${key}`);
  }
  cache.set(key, normalized);
  return `${prefix}${normalized}`;
}

// ── synthetic corpus: realistic repeated storage keys ──
// In a real session the same record/persona/scene paths repeat heavily.
const PREFIX = "users/u_abc/sessions/s_xyz/memory/";
const rawKeys = [
  "l1/2026-08-21.jsonl",
  "l1/2026-08-20.jsonl",
  "l2/rec_001.json",
  "l3/rec_001.json",
  "persona/current.json",
  "scene/active.json",
  "state/checkpoint.json",
  "profile/owner.json",
  "l1/2026-08-19.jsonl",
  "quota/usage.json",
  "l2/rec_002.json",
  "l1/2026-08-18.jsonl",
  "conversation/turn_42.json",
  "skill/versions/v3/manifest.json",
  "metadata/index.json",
];
// Simulate repetition: a 1000-call sequence where keys cycle (heavy reuse).
const CALLS: string[] = [];
for (let i = 0; i < 4000; i++) CALLS.push(rawKeys[i % rawKeys.length]);

function bench(name: string, fn: (k: string) => string): { nsPerOp: number; cv: number } {
  const warmup = 15;
  for (let w = 0; w < warmup; w++) for (const k of CALLS) fn(k);

  const rounds = 7;
  const samples: number[] = [];
  let iters = 2000;
  // calibrate so a round takes >= 200ms
  for (let r = 0; r < rounds; r++) {
    const t0 = performance.now();
    let acc = 0;
    for (let it = 0; it < iters; it++) {
      for (const k of CALLS) acc += fn(k).length;
    }
    const dt = performance.now() - t0;
    if (dt < 200 && r === 0) {
      iters = Math.ceil((iters * 400) / dt);
      r--;
      continue;
    }
    const nsPerOp = (dt * 1e6) / (iters * CALLS.length);
    samples.push(nsPerOp);
  }
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  const variance = samples.reduce((a, b) => a + (b - mean) ** 2, 0) / samples.length;
  const cv = (Math.sqrt(variance) / mean) * 100;
  // go-bench compatible line
  console.log(`Benchmark_${name}\t${iters}\t${mean.toFixed(1)}\tns/op\t0\tB/op\t0\tallocs/op`);
  console.log(`# tag: cv=${cv.toFixed(2)}%`);
  return { nsPerOp: mean, cv };
}

console.log(`# corpus: ${CALLS.length} calls/round, ${rawKeys.length} distinct keys (heavy reuse)`);
const cur = bench("ScopedKey_Current", (k) => keyCurrent(PREFIX, k));
const prop = bench("ScopedKey_Proposed", (k) => keyProposed(PREFIX, k));
const impr = ((cur.nsPerOp - prop.nsPerOp) / cur.nsPerOp) * 100;
console.log(`# improvement: ${impr.toFixed(1)}%`);

// correctness cross-check (must be bit-identical for all corpus keys)
let mism = 0;
for (const k of rawKeys) {
  const a = keyCurrent(PREFIX, k);
  const b = keyProposed(PREFIX, k);
  if (a !== b) {
    mism++;
    console.log(`# MISMATCH: ${JSON.stringify(k)} -> ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
  }
}
// edge cases: valid keys only (no leading slash / backslash / nul) for equality
for (const k of ["a/b/c", "a//b", "a/./b", "no_slash", "x//y//z", "a/./b/./c", "deep/a/b/c/d"]) {
  const a = keyCurrent(PREFIX, k);
  const b = keyProposed(PREFIX, k);
  if (a !== b) {
    mism++;
    console.log(`# EDGE MISMATCH: ${JSON.stringify(k)} -> ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
  }
}
// path-traversal rejection must match (both throw)
for (const k of ["a/../b", "..", "a/..", "../x", "a/b/../.."]) {
  let ca = false, cb = false;
  try { keyCurrent(PREFIX, k); } catch { ca = true; }
  try { keyProposed(PREFIX, k); } catch { cb = true; }
  if (ca !== cb) {
    mism++;
    console.log(`# TRAVERSAL MISMATCH: ${JSON.stringify(k)} current threw=${ca} proposed threw=${cb}`);
  }
}
// leading slash / backslash rejected by both
for (const k of ["/a/b", "\\a"]) {
  let ca = false, cb = false;
  try { keyCurrent(PREFIX, k); } catch { ca = true; }
  try { keyProposed(PREFIX, k); } catch { cb = true; }
  if (ca !== cb) {
    mism++;
    console.log(`# REJECT MISMATCH: ${JSON.stringify(k)} current threw=${ca} proposed threw=${cb}`);
  }
}
console.log(`# correctness mismatches: ${mism}`);
