/**
 * compat-check-scoped-key.ts — behavioral-equivalence + speed check for the
 * optimized ScopedStorageBackend.key().
 *
 * - Behavioral: compare the REAL adapter (createScopedStorageAdapter) stored
 *   keys against the OLD regex-based key() logic extracted from git history,
 *   across valid keys, ".." traversal (must throw), and leading-slash/backslash
 *   (must throw). 0 mismatches required.
 * - Speed: time real adapter.getObject (no-op backend) to exercise the real
 *   key() path and report ns/op vs the baseline (~249 ns/op from Loop1).
 *
 * Run: node --import tsx scripts/compat-check-scoped-key.ts
 */
import { performance } from "node:perf_hooks";
import { createScopedStorageAdapter, StorageAdapter } from "../src/core/storage/adapter.js";

// ── fake in-memory backend: records every key it receives ──
class RecordingBackend {
  type = "local" as const;
  lastKey: string | null = null;
  async putObject(key: string) { this.lastKey = key; }
  async appendObject(key: string) { this.lastKey = key; }
  async getObject(key: string) { this.lastKey = key; this.lastKey = key; return null; }
  async exists(key: string) { this.lastKey = key; return false; }
  async listObjects(prefix: string) { this.lastKey = prefix; return { entries: [], nextMarker: undefined }; }
  async deleteObject(key: string) { this.lastKey = key; }
  async deleteByPrefix(prefix: string) { this.lastKey = prefix; }
}

const PREFIX = "users/u_abc/sessions/s_xyz/memory/";

// ── OLD regex key() logic (from git history, pre-optimization) ──
function oldKey(prefix: string, key: string): string {
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

async function main() {
  const backend = new RecordingBackend();
  const inner = new StorageAdapter(backend as any);
  const adapter: StorageAdapter = createScopedStorageAdapter(inner, "users/u_abc/sessions/s_xyz/memory");
  // StorageAdapter is an fs-like wrapper; the real key() lives on the
  // underlying IStorageBackend (ScopedStorageBackend), reachable via getBackend().
  const be: any = (adapter as any).getBackend();

  let mism = 0;
  async function compare(label: string, input: string) {
    let oldOut: string | null = null, oldThrew = false;
    try { oldOut = oldKey(PREFIX, input); } catch { oldThrew = true; }
    let newOut: string | null = null, newThrew = false;
    try {
      backend.lastKey = null;
      await be.getObject(input); // routes through the REAL key()
      newOut = backend.lastKey;
    } catch { newThrew = true; }
    if (oldThrew !== newThrew || oldOut !== newOut) {
      mism++;
      console.log(`# MISMATCH ${label}: ${JSON.stringify(input)} old=${oldOut}(threw=${oldThrew}) new=${newOut}(threw=${newThrew})`);
    }
  }

  const valid = [
    "l1/2026-08-21.jsonl", "l2/rec_001.json", "persona/current.json",
    "scene/active.json", "state/checkpoint.json", "a/b/c", "a//b",
    "a\\b", "a/./b", "no_slash", "x//y//z", "a/./b/./c", "deep/a/b/c/d",
  ];
  for (const k of valid) await compare("valid", k);

  const mustThrow = ["/a/b", "\\a", "a/../b", "..", "a/..", "../x", "a/b/../.."];
  for (const k of mustThrow) await compare("throw", k);

  console.log(`# behavioral mismatches (real adapter vs old regex): ${mism}`);

  // ── speed: time REAL key() via getObject loop (no-op backend) ──
  const CALLS: string[] = [];
  for (let i = 0; i < 4000; i++) CALLS.push(valid[i % valid.length]);
  for (let w = 0; w < 15; w++) for (const k of CALLS) await be.getObject(k);
  const rounds = 7;
  const samples: number[] = [];
  let iters = 2000;
  for (let r = 0; r < rounds; r++) {
    const t0 = performance.now();
    for (let it = 0; it < iters; it++) for (const k of CALLS) await be.getObject(k);
    const dt = performance.now() - t0;
    if (dt < 200 && r === 0) { iters = Math.ceil((iters * 400) / dt); r--; continue; }
    samples.push((dt * 1e6) / (iters * CALLS.length));
  }
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  const variance = samples.reduce((a, b) => a + (b - mean) ** 2, 0) / samples.length;
  const cv = (Math.sqrt(variance) / mean) * 100;
  const baseline = 249.3; // Loop1 remote baseline ns/op
  const impr = ((baseline - mean) / baseline) * 100;
  console.log(`# real key() ns/op (mean): ${mean.toFixed(1)}  cv=${cv.toFixed(2)}%`);
  console.log(`# improvement vs Loop1 baseline (249.3 ns/op): ${impr.toFixed(1)}%`);
  console.log(`# RESULT: ${mism === 0 && impr > 15 ? "PASS" : "CHECK"} (mism=${mism}, impr=${impr.toFixed(1)}%)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
