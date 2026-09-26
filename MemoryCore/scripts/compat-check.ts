/**
 * Behavioral-equivalence regression test for fastEstimateTokens.
 *
 * The optimized implementation (src/offload/fast-token-estimate.ts) reads code points
 * from a pre-built `cps` array instead of calling `text.charCodeAt(i)` on every access.
 * This test guards against accidental behavioral divergence by comparing the OPTIMIZED
 * function's output against the ORIGINAL implementation extracted from git history
 * (git show <optimization-commit>^:.../fast-token-estimate.ts), which uses `charCodeAt`
 * directly. This is ground-truth comparison — no hand-reimplemented reference.
 *
 * If a future refactor changes behavior, this test fails loudly instead of silently
 * drifting the token budget.
 *
 * Run:  node --import tsx scripts/compat-check.ts
 * Exit: 0 = equivalent, 1 = divergence found
 */
import { fastEstimateTokens, fastEstimateMessages } from "../src/offload/fast-token-estimate.ts";
import { execSync } from "child_process";
import { writeFileSync, mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// Locate the optimization commit (the one that introduced the cps[] rewrite).
// Fallback: compare against HEAD~1 if this file is run inside the repo tree.
function originalSourcePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "orig-token-"));
  const out = join(dir, "orig.ts");
  try {
    execSync(
      `git show 7f5dfdb^:MemoryCore/src/offload/fast-token-estimate.ts`,
      { cwd: process.cwd(), encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] },
    ); // probe
    const src = execSync(
      `git show 7f5dfdb^:MemoryCore/src/offload/fast-token-estimate.ts`,
      { cwd: process.cwd(), encoding: "utf-8" },
    );
    writeFileSync(out, src);
    return out;
  } catch {
    // fallback: HEAD~1
    const src = execSync(`git show HEAD~1:MemoryCore/src/offload/fast-token-estimate.ts`, {
      cwd: process.cwd(),
      encoding: "utf-8",
    });
    writeFileSync(out, src);
    return out;
  }
}

const origPath = originalSourcePath();
const orig = await import(origPath);
const originalEstimateTokens: (t: string) => number = orig.fastEstimateTokens;
const originalEstimateMessages: (m: any[]) => number = orig.fastEstimateMessages;

// ── Test corpus: covers every branch ──
const corpus: string[] = [
  "",
  "Hello world this is a test of token estimation!",
  "人工智能记忆系统可以自动捕获结构化知识并做影响分析。",
  "エージェントの記憶システムは会話から知識を自動抽出します。",
  "Les agents construisent un système de mémoire française avec café et naïve.",
  "function estimate(text){ let t=0; for(const c of text) t+=cost(c); return t; }",
  "🚀🔥💡 emoji test with surrogate pairs wechat 😀😎",
  "mixed 中文 English と日本語 での café 测试",
  JSON.stringify([{ role: "user", content: "Hello" }, { role: "assistant", content: "Hi 你好" }], null, 2).repeat(50),
  "a".repeat(100000),
  "数据".repeat(50000),
  "1,234,567.89",
  "word'apostrophe混合 and café naïve test résumé",
  "普通文本 only ascii and 中文 mixed と日本語 での café 测试 with emoji 🚀",
];

let failures = 0;
const mismatches: string[] = [];
for (const text of corpus) {
  const got = fastEstimateTokens(text);
  const ref = originalEstimateTokens(text);
  if (got !== ref) {
    failures++;
    mismatches.push(`text=${JSON.stringify(text.slice(0, 40))} optimized=${got} original=${ref}`);
  }
}

// fastEstimateMessages equivalence
const msgs = [
  { role: "user", content: "Hello 世界" },
  { role: "assistant", content: "Hi there café" },
];
const mOpt = fastEstimateMessages(msgs);
const mRef = originalEstimateMessages(msgs);
if (mOpt !== mRef) {
  failures++;
  mismatches.push(`fastEstimateMessages optimized=${mOpt} original=${mRef}`);
}

if (failures > 0) {
  console.error(`FAIL: ${failures} divergence(s) between optimized and original fastEstimateTokens`);
  for (const m of mismatches) console.error("  " + m);
  process.exit(1);
}
console.log(`PASS: optimized fastEstimateTokens matches original (charCodeAt) on ${corpus.length} inputs (+ fastEstimateMessages)`);
