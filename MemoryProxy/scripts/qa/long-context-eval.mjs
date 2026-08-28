// 长上下文评测（针对「Token 成本失控 + 长上下文腐烂」）：
// 构造 20 轮对话，关键信息放第 1 轮，最后提问召回。
// 对比：全量历史（需在压缩关闭时跑，得基线）vs 压缩（keepRounds=3，早期信息被压缩掉）
//       vs 压缩但关键信息在保留窗口内。
// 注意：full 组在压缩开启时也会被压缩（压缩是全局开关），所以 full 基线需在
//       PROXY_CONTEXT_COMPACTION=false 时单独跑（lc-baseline：prompt=981/recalled=true）。
// 指标：prompt_tokens（成本）+ 是否召回关键信息（准确率）。
// 用法：node tools-2026/long-context-eval.mjs [--conversation lc-01]
const KEY = process.env.TENCENT_MEMORY_API_KEY;
if (!KEY) throw new Error("缺少 TENCENT_MEMORY_API_KEY 环境变量");
const BASE = "http://127.0.0.1:8096/workbuddy/default/v1/chat/completions";
const conv = process.argv[2] || "lc-01";

// 20 轮填充对话，第 1 轮埋关键信息
const ROUNDS = 20;
const KEY_INFO = "ABC-123-SECRET";
const messages = [];
for (let i = 1; i <= ROUNDS; i++) {
  if (i === 1) {
    messages.push({ role: "user", content: `初始化项目，密钥设置为 ${KEY_INFO}，记录一下` });
    messages.push({ role: "assistant", content: `好的，已记录密钥 ${KEY_INFO}。` });
  } else {
    messages.push({ role: "user", content: `继续第 ${i} 轮：给工具函数补注释（${"x".repeat(120)}）` });
    messages.push({ role: "assistant", content: `第 ${i} 轮完成：已补充注释。` });
  }
}
messages.push({ role: "user", content: "我们第一轮设置的密钥是什么？请直接回答" });

async function ask(label, msgs) {
  const res = await fetch(BASE, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${KEY}`,
      "x-conversation-id": `${conv}-${label}`,
      "x-team-id": process.env.TDAI_TEST_TEAM_ID || "team-xxxxxxxx",
      "x-agent-id": process.env.TDAI_TEST_AGENT_ID || "agt-xxxxxxxx",
      "x-task-id": process.env.TDAI_TEST_TASK_ID || "task-xxxxxxxx",
    },
    body: JSON.stringify({ model: "claude-sonnet-4-5", messages: msgs }),
  });
  const data = await res.json();
  const reply = data.choices?.[0]?.message?.content ?? JSON.stringify(data).slice(0, 120);
  const usage = data.usage ?? {};
  return {
    label,
    recalled: String(reply).includes(KEY_INFO),
    promptTokens: usage.prompt_tokens ?? 0,
    totalTokens: usage.total_tokens ?? 0,
    reply: String(reply).replace(/\s+/g, " ").slice(0, 90),
  };
}

const results = [];
// a) 全量历史
results.push(await ask("full", messages));
// b) 压缩 keepRounds=3：第 1 轮被压缩（Proxy 配置 compaction 后）
results.push(await ask("compact3", messages));
// c) 关键信息放最近窗口：把 KEY_INFO 换到倒数第 2 轮
const msgsC = messages.map((m) => ({ ...m }));
msgsC[ROUNDS * 2 - 2] = { role: "user", content: `重申密钥：${KEY_INFO}` };
msgsC[ROUNDS * 2 - 1] = { role: "assistant", content: `已记录 ${KEY_INFO}。` };
results.push(await ask("recent", msgsC));

for (const r of results) {
  console.log(
    `${r.recalled ? "✓" : "✗"} ${r.label.padEnd(9)} prompt=${String(r.promptTokens).padEnd(5)} ` +
      `total=${String(r.totalTokens).padEnd(5)} recalled=${String(r.recalled).padEnd(5)} ${r.reply}`,
  );
}
const full = results[0];
const comp = results[1];
console.log(
  `\n[提示] full 组在压缩开启时也会被压缩；full 基线请用压缩关闭时的结果（lc-baseline: prompt=981/recalled=true）。` +
    `\n本次（压缩开）：compact3 prompt=${comp.promptTokens}（vs 基线 981，约 -${Math.round((1 - comp.promptTokens / 981) * 100)}%）` +
    `，recalled=${comp.recalled}；recent prompt=${results[2].promptTokens}，recalled=${results[2].recalled}。` +
    `\n结论：压缩降 token 明显，但窗口外关键信息丢失 → 必须配 L1 自动召回/摘要补偿。`,
);
