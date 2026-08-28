// 分析最近一条 Opik trace 的注入块分布（字符数 + 估算 token）。
// 用法：node tools-2026/analyze-injection.mjs [traceId]
const BASE = "http://127.0.0.1:8080/v1/private";
const PROJECT = "usr-xxxxxxxx";

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

const argTrace = process.argv[2];
let trace;
if (argTrace) {
  trace = await getJson(`${BASE}/traces/${argTrace}?project_name=${PROJECT}`);
} else {
  const list = await getJson(`${BASE}/traces?project_name=${PROJECT}&page=1&size=5`);
  trace = list.content.find((t) => t.input?.messages?.length) ?? list.content[0];
}

const sysMsg = trace.input?.messages?.find((m) => m.role === "system");
const sys = typeof sysMsg?.content === "string" ? sysMsg.content : "";
console.log(`trace: ${trace.id}`);
console.log(`protocol=${trace.metadata?.protocol} agent=${trace.metadata?.agent_source} prompt_tokens=${trace.usage?.prompt_tokens ?? "-"}`);
console.log(`system chars: ${sys.length}`);

// 按顶层 <tag>...</tag> 拆分统计
const re = /<([A-Za-z0-9_\-]+)>/g;
const boundaries = [];
let m;
while ((m = re.exec(sys))) {
  const tag = m[1];
  const endIdx = sys.indexOf(`</${tag}>`, m.index);
  if (endIdx >= 0) {
    boundaries.push({ tag, start: m.index, end: endIdx + tag.length + 3, len: endIdx - m.index });
    re.lastIndex = endIdx + tag.length + 3;
  }
}
// 未闭合块（如 ### Skills 段）按文本段粗略切分
const chunks = boundaries.map((b) => ({ ...b }));
chunks.sort((a, b) => a.start - b.start);
const outside = [];
let prev = 0;
for (const c of chunks) {
  if (c.start > prev) outside.push({ tag: "(未闭合段)", start: prev, len: c.start - prev });
  prev = c.end;
}
if (prev < sys.length) outside.push({ tag: "(未闭合段)", start: prev, len: sys.length - prev });

const rows = [...chunks, ...outside].sort((a, b) => a.start - b.start);
let total = 0;
for (const r of rows) {
  total += r.len;
  console.log(
    `${r.tag.padEnd(24)} ${String(r.len).padStart(6)} chars  ~${Math.round(r.len / 2.2)} tok`,
  );
}
console.log(`total 覆盖: ${total} / ${sys.length}`);
