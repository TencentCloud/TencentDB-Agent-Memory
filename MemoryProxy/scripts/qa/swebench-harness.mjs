#!/usr/bin/env node
// SWE-bench 评测骨架（题目二·任务一 的 turn/成功率验证入口）。
//
// 设计：
//   - 默认跑内置 3 个 JS 函数级 demo（可在本机端到端产出 pass@1 / token / 耗时）；
//   - 传 --input <file.jsonl> 可换成 SWE-bench 风格任务
//     （每行 { instance_id, problem_statement, patch?, test_patch? }）；
//   - 真实 SWE-bench 需要 git checkout + pytest，本骨架把「执行测试」留成
//     executeTests(instance, patch) 接口，默认返回 { executed: false }；
//     接入真实 evaluator 时只需替换该函数。
//
// 用法：
//   node tools-2026/swebench-harness.mjs [--agent workbuddy|codex] [--model claude-sonnet-4-5] [--limit N] [--input file.jsonl] [--inherit 经验.txt]
//   --inherit：经验继承模式（文档第 5 节：前序 Case 学习、后序 Case 验证）。
//     同一批任务跑两遍：无经验 baseline vs 注入前序经验（[团队经验] 前缀），
//     输出 pass@1 与平均 token 的对比，验证「经验能否提升后序任务成功率」。
import vm from "node:vm";
import fs from "node:fs";

const KEY = process.env.TENCENT_MEMORY_API_KEY;
if (!KEY) throw new Error("缺少 TENCENT_MEMORY_API_KEY 环境变量");
const argv = process.argv.slice(2);
const opt = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : def;
};
const AGENT = opt("agent", "workbuddy");
const MODEL = opt("model", "claude-sonnet-4-5");
const LIMIT = Number(opt("limit", "10"));
const INPUT = opt("input", "");
const INHERIT_FILE = opt("inherit", "");
let inheritText = "";
if (INHERIT_FILE) {
  inheritText = fs.readFileSync(INHERIT_FILE, "utf8").trim();
  console.log(`[inherit] 前序经验（${inheritText.length} chars）已加载：${inheritText.slice(0, 80)}...`);
}

// ── 内置 demo：JS 函数级任务（node 可直接断言）─────────────────────────────
const DEMO_TASKS = [
  {
    id: "demo-quicksort",
    problem: `修复下面这个快速排序实现：空数组和单元素数组会抛错或死循环。
\`\`\`js
function quickSort(arr) {
  if (arr.length <= 1) return arr;
  const pivot = arr[0];
  const left = [], right = [];
  for (let i = 1; i < arr.length; i++) {
    if (arr[i] < pivot) left.push(arr[i]); else right.push(arr[i]);
  }
  return [...quickSort(left), pivot, ...quickSort(right)];
}
\`\`\`
给出修复后的完整函数（只输出代码块）。`,
    test: `const cases = [
  [[], []],
  [[5], [5]],
  [[3,1,2], [1,2,3]],
  [[5,4,3,2,1], [1,2,3,4,5]],
  [[2,2,1,1], [1,1,2,2]],
];
for (const [input, want] of cases) {
  const got = quickSort(input);
  if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error("case fail " + JSON.stringify(input));
}
return true;`,
  },
  {
    id: "demo-debounce",
    problem: `实现一个 debounce 函数：debounce(fn, delay) 返回新函数，连续调用时只在最后一次调用后 delay 毫秒执行一次 fn，并透传参数。
给出完整实现（只输出代码块）。`,
    test: `const calls = [];
const debounced = debounce((x) => calls.push(x), 20);
debounced(1); debounced(2); debounced(3);
return new Promise((resolve) => {
  setTimeout(() => { resolve(calls.length === 1 && calls[0] === 3); }, 60);
});`,
  },
  {
    id: "demo-valid-parens",
    problem: `实现 isValidParentheses(s)：判断括号字符串是否合法（()[]{} 匹配，顺序正确）。
示例：isValidParentheses("()[]{}") === true；isValidParentheses("([)]") === false。
给出完整实现（只输出代码块）。`,
    test: `const cases = [
  ["()", true],
  ["()[]{}", true],
  ["([)]", false],
  ["{[]}", true],
  ["", true],
  ["(]", false],
];
for (const [s, want] of cases) {
  if (isValidParentheses(s) !== want) throw new Error("case fail " + JSON.stringify(s));
}
return true;`,
  },
];

const CALL_RE = /(memory-bridge\/v3|skill-bridge\/v3|tdai_memory_search|tdai_conversation_search|tdai_atomic_query|skill_search|skill_view|skill_files_read)/;

function extractCodeBlock(reply) {
  const fence = String(reply).match(/```(?:js|javascript|ts|typescript)?\s*\n([\s\S]*?)```/);
  if (fence) return fence[1];
  return null;
}

/** 执行测试的接入点：demo 用 node:vm 跑；真实 SWE-bench 替换成 pytest 调用。 */
async function executeTests(task, code) {
  if (!task.test) return { executed: false, passed: null, reason: "no local test" };
  try {
    const script = `${code}\n;(function(){\n${task.test}\n})()`;
    const sandbox = vm.createContext({
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      console,
    });
    const result = await Promise.race([
      vm.runInNewContext(script, sandbox, { timeout: 5000 }),
      new Promise((_, rej) => setTimeout(() => rej(new Error("test timeout")), 8000)),
    ]);
    return { executed: true, passed: result === true, reason: null };
  } catch (err) {
    return { executed: true, passed: false, reason: String(err).slice(0, 200) };
  }
}

async function askLlm(problem) {
  const url =
    AGENT === "codex"
      ? "http://127.0.0.1:8096/codex/default/v1/responses"
      : "http://127.0.0.1:8096/workbuddy/default/v1/chat/completions";
  const body =
    AGENT === "codex"
      ? { model: MODEL, input: [{ type: "message", role: "user", content: [{ type: "input_text", text: problem }] }], stream: false }
      : { model: MODEL, messages: [{ role: "user", content: problem }] };
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${KEY}`,
    "x-team-id": process.env.TDAI_TEST_TEAM_ID || "team-xxxxxxxx",
    "x-agent-id": process.env.TDAI_TEST_AGENT_ID || "agt-xxxxxxxx",
    "x-task-id": process.env.TDAI_TEST_TASK_ID || "task-xxxxxxxx",
    "x-conversation-id": `swe-${Date.now()}-${Math.floor(Math.random() * 1e4)}`,
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120000);
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: controller.signal,
  }).finally(() => clearTimeout(timer));
  const data = await res.json();
  const reply =
    data.choices?.[0]?.message?.content ??
    data.output?.find((o) => o?.type === "message")?.content?.map((c) => c?.text ?? "").join("") ??
    JSON.stringify(data).slice(0, 300);
  const usage = data.usage ?? {};
  return {
    reply: String(reply),
    promptTokens: usage.prompt_tokens ?? usage.input_tokens ?? 0,
    completionTokens: usage.completion_tokens ?? usage.output_tokens ?? 0,
  };
}

async function runOne(task, withInherit = false) {
  const t0 = Date.now();
  const problem =
    withInherit && inheritText
      ? `[团队经验（前序任务沉淀，来源可追溯）]\n${inheritText}\n\n当前任务：\n${task.problem}`
      : task.problem;
  const { reply, promptTokens, completionTokens } = await askLlm(problem);
  const code = extractCodeBlock(reply);
  const verdict = await executeTests(task, code ?? "");
  const misused = CALL_RE.test(reply); // 工具误用检测（SWE-bench 任务不应调记忆/skill）
  return {
    id: task.id,
    passed: verdict.passed,
    executed: verdict.executed,
    reason: verdict.reason,
    codeExtracted: !!code,
    misusedTool: misused,
    promptTokens,
    completionTokens,
    durationMs: Date.now() - t0,
    replyPreview: reply.replace(/\s+/g, " ").slice(0, 80),
  };
}

const tasks = INPUT
  ? fs.readFileSync(INPUT, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
  : DEMO_TASKS;

const results = [];
const inherited = [];
for (const t of tasks.slice(0, LIMIT)) {
  try {
    const r = await runOne(t);
    results.push(r);
    console.log(
      `${r.passed === true ? "✓" : "✗"} ${r.id.padEnd(16)} pass=${String(r.passed).padEnd(5)} ` +
        `prompt=${r.promptTokens} total=${r.promptTokens + r.completionTokens} ${r.reason ?? ""}`.slice(0, 140),
    );
  } catch (err) {
    results.push({ id: t.id, error: String(err) });
    console.log(`✗ ${t.id} ERROR ${err}`);
  }
  if (inheritText) {
    try {
      const r = await runOne(t, true);
      inherited.push(r);
      console.log(
        `  [inherit] ${r.id.padEnd(14)} pass=${String(r.passed).padEnd(5)} ` +
          `prompt=${r.promptTokens} total=${r.promptTokens + r.completionTokens} ${r.reason ?? ""}`.slice(0, 120),
      );
    } catch (err) {
      inherited.push({ id: t.id, error: String(err) });
      console.log(`  [inherit] ${t.id} ERROR ${err}`);
    }
  }
}

function summarize(run) {
  const executed = run.filter((r) => r.executed);
  const passed = executed.filter((r) => r.passed === true).length;
  const avgPrompt = run.filter((r) => r.promptTokens).reduce((s, r) => s + r.promptTokens, 0) /
    Math.max(1, run.filter((r) => r.promptTokens).length);
  const avgLatency = run.reduce((s, r) => s + (r.durationMs ?? 0), 0) / Math.max(1, run.length);
  return {
    passAt1: executed.length ? `${Math.round((passed / executed.length) * 100)}%` : "n/a",
    passed,
    executed: executed.length,
    avgPromptTokens: Math.round(avgPrompt),
    avgLatencyMs: Math.round(avgLatency),
  };
}

const summary = {
  agent: AGENT,
  model: MODEL,
  inherit: inheritText ? true : false,
  tasks: results.length,
  baseline: summarize(results),
  inherited: inheritText ? summarize(inherited) : null,
  results,
};
const outFile = argv[argv.indexOf("--output") + 1] || "tools-2026/swebench-result.json";
fs.writeFileSync(outFile, JSON.stringify(summary, null, 2));
const b = summary.baseline;
console.log(`\n[baseline ] pass@1=${b.passAt1} (${b.passed}/${b.executed})  平均 prompt=${b.avgPromptTokens}  平均耗时=${b.avgLatencyMs}ms`);
if (summary.inherited) {
  const i = summary.inherited;
  console.log(`[inherit  ] pass@1=${i.passAt1} (${i.passed}/${i.executed})  平均 prompt=${i.avgPromptTokens}  平均耗时=${i.avgLatencyMs}ms`);
}
console.log(`→ ${outFile}`);
