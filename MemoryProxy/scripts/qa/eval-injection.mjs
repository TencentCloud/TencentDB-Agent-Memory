// 注入优化评测：正例（应调用记忆/skill 工具）vs 负例（纯 coding/问候，不应调用）。
// 用法：node tools-2026/eval-injection.mjs [输出文件.json] [--model <模型名>]
//   --model 默认 claude-sonnet-4-5（映射到使用者自定义的上游模型）；跨模型对比时传
//   上游支持的其他模型名（需在 creditPricing 里注册，否则 404）。
const BASE = "http://127.0.0.1:8096/workbuddy/default/v1/chat/completions";
const KEY = process.env.TENCENT_MEMORY_API_KEY;
if (!KEY) throw new Error("缺少 TENCENT_MEMORY_API_KEY 环境变量");

const argv = process.argv.slice(2);
const modelArgIdx = argv.indexOf("--model");
const MODEL = modelArgIdx >= 0 ? argv[modelArgIdx + 1] : "claude-sonnet-4-5";
const outArg = argv.find((a, i) => a !== "--model" && argv[i - 1] !== "--model");

const CASES = [
  // 正例：应触发记忆/skill 工具调用
  { id: "p1-identity", label: "身份查询", q: "我叫什么名字？", expect: "call", expected: ["tdai_memory_search"] },
  { id: "p2-history", label: "历史对话", q: "我们上次聊了什么？你还记得吗", expect: "call", expected: ["tdai_conversation_search"] },
  { id: "p3-memory", label: "记忆盘点", q: "把你知道的关于我的信息都告诉我", expect: "call", expected: ["tdai_memory_search", "tdai_conversation_search"] },
  { id: "p4-fact", label: "历史结论", q: "之前讨论过的那个方案，最后结论是什么", expect: "call", expected: ["tdai_conversation_search", "tdai_memory_search"] },
  { id: "p5-skill-search", label: "技能检索", q: "搜索一下团队里有没有做 session init 测试的 skill", expect: "call", expected: ["skill_search"] },
  { id: "p6-skill-view", label: "技能打开", q: "打开 session-init-test 这个 skill，看看里面写了什么", expect: "call", expected: ["skill_view"] },
  // 负例：不应触发记忆/skill 工具
  { id: "n1-greet", label: "问候", q: "你好", expect: "nocall" },
  { id: "n2-coding", label: "纯编码", q: "用 Python 写一个快速排序函数", expect: "nocall" },
  { id: "n3-explain", label: "技术答疑", q: "解释一下 TCP 三次握手的过程", expect: "nocall" },
  { id: "n4-debug", label: "排错", q: "这个报错是什么意思：TypeError: x is not a function", expect: "nocall" },
  { id: "n5-refactor", label: "代码修改", q: "给下面这个函数加上参数类型注解", expect: "nocall" },
  { id: "n6-weather", label: "无关闲聊", q: "今天天气怎么样", expect: "nocall" },
];

const CALL_RE =
  /(memory-bridge\/v3|skill-bridge\/v3|tdai_memory_search|tdai_conversation_search|tdai_atomic_query|skill_search|skill_view|skill_files_read)/;

// 从回复里提取模型实际调用的工具（路径 → 工具名）
const TOOL_PATH_RE = [
  [/atomic\/search/, "tdai_memory_search"],
  [/conversation\/search/, "tdai_conversation_search"],
  [/skill\/search/, "skill_search"],
  [/get-by-name/, "skill_view"],
  [/files\/read/, "skill_files_read"],
  [/\/extract/, "skill_extract"],
];

function detectTools(text) {
  const used = [];
  for (const [re, name] of TOOL_PATH_RE) {
    if (re.test(text) && !used.includes(name)) used.push(name);
  }
  // 注入的 recipe 标签也算"识别并引用"（模型写了 <tdai_conversation_search> 等）
  for (const name of ["tdai_memory_search", "tdai_conversation_search", "tdai_atomic_query", "tdai_scenario_ls", "tdai_read_scene"]) {
    if (new RegExp(`<${name}>`).test(text) && !used.includes(name)) used.push(name);
  }
  return used;
}

function detectCall(text) {
  const hasBridge = CALL_RE.test(text);
  const hasCurl = /curl/i.test(text);
  // 显式调用：回复里给出 curl + 桥路径命令
  if (hasBridge && hasCurl) return true;
  // 引用注入的 recipe 标签（识别正确但以标签形式输出调用）
  if (/<tdai_(memory|conversation)_search>/.test(text)) return true;
  // 自动召回路径：模型明确提到"根据记忆检索/记忆里"并给出具体信息（L1 自动召回已生效）
  return /(根据记忆|基于记忆|记忆检索|检索结果显示|记忆里显示|我记得你)/.test(text);
}

async function runCase(c) {
  const body = {
    model: MODEL,
    messages: [{ role: "user", content: c.q }],
  };
  const res = await fetch(`${BASE}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${KEY}`,
      "x-conversation-id": `evh-${c.id}`,
      // header 预选：新会话直接注册，跳过 Session Init 表单
      "x-team-id": process.env.TDAI_TEST_TEAM_ID || "team-xxxxxxxx",
      "x-agent-id": process.env.TDAI_TEST_AGENT_ID || "agt-xxxxxxxx",
      "x-task-id": process.env.TDAI_TEST_TASK_ID || "task-xxxxxxxx",
    },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  const reply =
    data.choices?.[0]?.message?.content ??
    data.error?.message ??
    JSON.stringify(data).slice(0, 200);
  const usage = data.usage ?? {};
  return {
    id: c.id,
    label: c.label,
    expect: c.expect,
    called: detectCall(String(reply)),
    toolsUsed: detectTools(String(reply)),
    toolChoiceCorrect: (() => {
      const tools = detectTools(String(reply));
      return tools.length > 0 && (c.expected ?? []).some((t) => tools.includes(t));
    })(),
    promptTokens: usage.prompt_tokens ?? 0,
    completionTokens: usage.completion_tokens ?? 0,
    totalTokens: usage.total_tokens ?? 0,
    reply: String(reply).replace(/\s+/g, " ").slice(0, 120),
  };
}

const results = [];
for (const c of CASES) {
  try {
    const r = await runCase(c);
    results.push(r);
    const ok = r.expect === "call" ? r.called : !r.called;
    console.log(
      `${ok ? "✓" : "✗"} ${r.id.padEnd(12)} ${r.label.padEnd(6)} ` +
        `expect=${r.expect.padEnd(6)} called=${String(r.called).padEnd(5)} ` +
        `tools=[${(r.toolsUsed ?? []).join(",")}] ` +
        `prompt=${r.promptTokens} total=${r.totalTokens}  ${r.reply.slice(0, 50)}`,
    );
  } catch (err) {
    results.push({ id: c.id, label: c.label, expect: c.expect, error: String(err) });
    console.log(`✗ ${c.id} ERROR ${err}`);
  }
}

const positive = results.filter((r) => r.expect === "call" && !r.error);
const negative = results.filter((r) => r.expect === "nocall" && !r.error);
const validRate =
  positive.length ? (positive.filter((r) => r.called).length / positive.length) * 100 : 0;
const falseRate =
  negative.length ? (negative.filter((r) => r.called).length / negative.length) * 100 : 0;
const toolChoiceRate = positive.length
  ? (positive.filter((r) => r.toolChoiceCorrect).length / positive.length) * 100
  : 0;
const avgPrompt = results.filter((r) => r.promptTokens).reduce((s, r) => s + r.promptTokens, 0) /
  Math.max(1, results.filter((r) => r.promptTokens).length);

const summary = {
  cases: results.length,
  validCallRate: `${validRate.toFixed(0)}%`,
  falseCallRate: `${falseRate.toFixed(0)}%`,
  toolChoiceRate: `${toolChoiceRate.toFixed(0)}%`,
  avgPromptTokens: Math.round(avgPrompt),
  results,
};

const outFile = process.argv[2];
if (outFile) {
  const fs = await import("node:fs");
  fs.writeFileSync(outFile, JSON.stringify(summary, null, 2));
  console.log(`\nsaved → ${outFile}`);
}
console.log(
  `\n有效调用率=${summary.validCallRate}  误调用率=${summary.falseCallRate}  ` +
    `工具选择正确率=${summary.toolChoiceRate}  ` +
    `平均 prompt_tokens=${summary.avgPromptTokens}`,
);
