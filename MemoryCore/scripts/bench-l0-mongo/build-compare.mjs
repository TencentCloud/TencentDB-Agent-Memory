/**
 * Build the standalone 100M comparison page served from this folder.
 *
 *   node build-compare.mjs
 *
 * Three runs, three roles:
 *   W1   — latest (9/1, w:1)           → headline numbers
 *   MAJ  — same spec, w:majority (8/31) → stall baseline
 *   OLD  — pre-upgrade (8/26–28)       → magnitude reference only (broken index)
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "compare-8c32g.html");

const W1 = JSON.parse(readFileSync(join(HERE, "reports/l0-bench-2026-09-01T14-02-56-975Z.json"), "utf8"));
const MAJ = JSON.parse(readFileSync(join(HERE, "reports/l0-bench-2026-08-31T07-18-23-351Z.json"), "utf8"));
const OLD = JSON.parse(readFileSync(join(HERE, "reports/l0-bench-100M-FULL-merged.json"), "utf8"));

const RTT_MS = 37;

const STALL_WINDOWS_MAJ = [
  { from: "15:39:39", to: "15:40:39", qps: 0, docs: 67_821_000, kind: "完全停顿" },
  { from: "15:43:39", to: "15:44:39", qps: 4_900, docs: 76_822_000, kind: "严重降速" },
  { from: "15:46:39", to: "15:47:39", qps: 0, docs: 81_119_000, kind: "完全停顿" },
  { from: "15:47:39", to: "15:48:39", qps: 11_150, docs: 81_788_000, kind: "停顿尾声" },
  { from: "15:55:39", to: "15:56:39", qps: 0, docs: 97_079_000, kind: "完全停顿" },
];

const FLOW_MAJ = { isLaggedCount: 3, isLaggedTimeMicros: 54_999_988 };

function curve(report, maxPoints = 200) {
  const w = report.write100m;
  const base = w.docs - w.insert.docs;
  const s = w.insert.samples ?? [];
  const step = Math.max(1, Math.ceil(s.length / maxPoints));
  const out = [];
  for (let i = 0; i < s.length; i += step) {
    const x = s[i];
    out.push({ pct: ((base + x.docs) / w.docs) * 100, qps: x.intervalDocsPerSec, tMin: x.tMs / 60000, docs: base + x.docs });
  }
  return out;
}

const w1Curve = curve(W1);
const majCurve = curve(MAJ);
const oldCurve = curve(OLD);

const fmt = (n, d = 0) => Number(n).toLocaleString("en-US", { maximumFractionDigits: d, minimumFractionDigits: d });
const srv = (ms) => Math.max(0.1, ms - RTT_MS);

const W = 1000, H = 340, PAD = { l: 78, r: 20, t: 22, b: 46 };
const PW = W - PAD.l - PAD.r, PH = H - PAD.t - PAD.b;

function lineChart({ series, yMax, yTicks, xLabel, yLabel, xMax = 100, logY = false }) {
  const ys = (v) => {
    if (!logY) return PAD.t + PH - (v / yMax) * PH;
    const lv = Math.log10(Math.max(v, 100));
    const l0 = Math.log10(100), l1 = Math.log10(yMax);
    return PAD.t + PH - ((lv - l0) / (l1 - l0)) * PH;
  };
  const xs = (v) => PAD.l + (v / xMax) * PW;
  let g = "";
  for (const t of yTicks) {
    const y = ys(t);
    g += `<line x1="${PAD.l}" y1="${y.toFixed(1)}" x2="${PAD.l + PW}" y2="${y.toFixed(1)}" class="grid"/>`;
    g += `<text x="${PAD.l - 10}" y="${(y + 4).toFixed(1)}" class="ax" text-anchor="end">${fmt(t)}</text>`;
  }
  for (let p = 0; p <= xMax; p += xMax / 10) {
    const x = xs(p);
    g += `<line x1="${x.toFixed(1)}" y1="${PAD.t}" x2="${x.toFixed(1)}" y2="${PAD.t + PH}" class="grid"/>`;
    g += `<text x="${x.toFixed(1)}" y="${PAD.t + PH + 20}" class="ax" text-anchor="middle">${fmt(p)}</text>`;
  }
  let paths = "";
  for (const s of series) {
    const d = s.points.map((p, i) => `${i ? "L" : "M"}${xs(p.x).toFixed(1)},${ys(p.y).toFixed(1)}`).join("");
    paths += `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="${s.dash ? 1.6 : 2.2}"${s.dash ? ' stroke-dasharray="5 4"' : ""} stroke-linejoin="round"/>`;
    if (s.dots) for (const p of s.points) {
      paths += `<circle cx="${xs(p.x).toFixed(1)}" cy="${ys(p.y).toFixed(1)}" r="2.6" fill="${s.color}"><title>${s.name} — ${p.t}</title></circle>`;
    }
  }
  const legend = series.map((s, i) => `<g transform="translate(${PAD.l + 12 + i * 280},${PAD.t + 6})">
    <rect width="26" height="3.5" y="5" rx="1.7" fill="${s.color}"${s.dash ? ' opacity="0.75"' : ""}/>
    <text x="34" y="11" class="lg">${s.name}</text></g>`).join("");
  return `<svg viewBox="0 0 ${W} ${H}" class="chart"><rect x="${PAD.l}" y="${PAD.t}" width="${PW}" height="${PH}" class="plot"/>
    ${g}${paths}${legend}
    <text x="${PAD.l + PW / 2}" y="${H - 8}" class="axl" text-anchor="middle">${xLabel}</text>
    <text x="16" y="${PAD.t + PH / 2}" class="axl" text-anchor="middle" transform="rotate(-90 16 ${PAD.t + PH / 2})">${yLabel}</text></svg>`;
}

function barChart(rows, { unit = "", color = "#3b82f6" } = {}) {
  const max = Math.max(...rows.map((r) => r.value));
  return `<div class="bars">${rows.map((r) => `<div class="bar-row">
    <div class="bar-lab">${r.label}</div>
    <div class="bar-track"><div class="bar-fill" style="width:${((r.value / max) * 100).toFixed(1)}%;background:${r.color || color}"></div></div>
    <div class="bar-val">${fmt(r.value, r.decimals ?? 0)}${unit}</div></div>`).join("")}</div>`;
}

function stackedLatencyChart(rows) {
  const max = Math.max(...rows.map((r) => r.total));
  return `<div class="bars">${rows.map((r) => `<div class="bar-row">
    <div class="bar-lab">${r.label}</div>
    <div class="bar-track"><div class="bar-stack">
      <div class="seg rtt" style="width:${((RTT_MS / max) * 100).toFixed(1)}%"></div>
      <div class="seg srv" style="width:${(((r.total - RTT_MS) / max) * 100).toFixed(1)}%;background:${r.color}"></div>
    </div></div>
    <div class="bar-val">${fmt(srv(r.total), 1)} ms</div></div>`).join("")}
    <div class="bar-row" style="margin-top:14px"><div class="bar-lab"></div>
    <div class="bar-track" style="border:none;background:none;height:auto">
      <span class="lgd"><i style="background:#374151"></i>跨地域 RTT ${RTT_MS} ms</span>
      <span class="lgd"><i style="background:#3b82f6"></i>服务端耗时</span></div>
    <div class="bar-val" style="color:var(--fg3);font-size:12px">右侧=服务端</div></div></div>`;
}

const qpsOverlay = lineChart({
  series: [
    { name: "w:1（9/1，32 分钟）", color: "#22c55e", dots: true,
      points: w1Curve.map((p) => ({ x: p.pct, y: p.qps, t: `${p.tMin.toFixed(0)}min · ${fmt(p.qps)}/s` })) },
    { name: "w:majority（8/31，39 分钟）", color: "#f59e0b",
      points: majCurve.map((p) => ({ x: p.pct, y: p.qps, t: `${p.tMin.toFixed(0)}min · ${fmt(p.qps)}/s` })) },
    { name: "升配前（索引已损坏）", color: "#ef4444", dash: true,
      points: oldCurve.map((p) => ({ x: p.pct, y: p.qps, t: `${p.tMin.toFixed(0)}min · ${fmt(p.qps)}/s` })) },
  ],
  yMax: 100000, yTicks: [100, 1000, 10000, 100000], logY: true,
  xLabel: "写入进度（% of 1 亿条）", yLabel: "瞬时吞吐 docs/s（对数轴）",
});

const qpsW1Linear = lineChart({
  series: [
    { name: "w:1 — 瞬时吞吐", color: "#22c55e", dots: true,
      points: w1Curve.map((p) => ({ x: p.tMin, y: p.qps, t: `${p.tMin.toFixed(0)}min · ${fmt(p.qps)}/s` })) },
    { name: "w:majority — 瞬时吞吐", color: "#f59e0b",
      points: majCurve.map((p) => ({ x: p.tMin, y: p.qps, t: `${p.tMin.toFixed(0)}min · ${fmt(p.qps)}/s` })) },
  ],
  yMax: 90000, yTicks: [0, 20000, 40000, 60000, 80000], xMax: 40,
  xLabel: "耗时（分钟）", yLabel: "瞬时吞吐 docs/s",
});

const w1i = W1.write100m.insert, maji = MAJ.write100m.insert, odi = OLD.write100m.insert;
const w1s = w1i.stalls ?? {}, majs = { zeroWindows: 3, slowBatches: "?", longestBatchMs: maji.batchLatency.maxMs };

const QUERY_LABEL = {
  searchL0Fts: "BM25 关键词检索（命中）",
  searchL0FtsEmpty: "BM25 关键词检索（无命中）",
  sessionReplay: "会话回放（按 session 分页）",
  queryL0ForL1: "L1 聚合取数（按 session_key）",
  paginated: "租户维度分页列表",
  countL0: "租户维度计数",
};
const queryRows = Object.entries(W1.query ?? {}).map(([name, q]) => ({ name, q }));

const latRow = (L, tag) => `<tr><td>${tag}</td>
  <td class="num">${fmt(L.p50Ms)}</td><td class="num">${fmt(L.p90Ms)}</td><td class="num">${fmt(L.p95Ms)}</td>
  <td class="num">${fmt(L.p99Ms)}</td><td class="num">${fmt(L.p999Ms ?? 0)}</td><td class="num ${L.maxMs > 10000 ? "down" : ""}">${fmt(L.maxMs)}</td></tr>`;

const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>MongoDB L0 一亿条压测报告</title>
<style>
  :root{--bg:#0b0f17;--card:#121826;--card2:#0e1420;--line:#1f2937;--fg:#e5e7eb;--fg2:#9aa4b2;--fg3:#6b7280;
    --green:#22c55e;--red:#ef4444;--blue:#3b82f6;--amber:#f59e0b;--purple:#a855f7}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.7 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
  .wrap{max-width:1120px;margin:0 auto;padding:44px 26px 80px}
  h1{font-size:30px;margin:0 0 8px} h2{font-size:20px;margin:52px 0 16px;padding-bottom:10px;border-bottom:1px solid var(--line)}
  h3{font-size:15px;margin:26px 0 10px;color:var(--fg2);font-weight:600}
  p{margin:12px 0} .sub{color:var(--fg2);font-size:14px;margin-bottom:20px}
  code{background:#1b2333;padding:2px 6px;border-radius:4px;font-size:13px;font-family:ui-monospace,Menlo,monospace}
  .pills{display:flex;flex-wrap:wrap;gap:8px;margin:18px 0 26px}
  .pill{background:var(--card);border:1px solid var(--line);border-radius:999px;padding:5px 13px;font-size:13px;color:var(--fg2)}
  .pill.on{border-color:#166534;background:#0d2016;color:#86efac}
  .pill.warn{border-color:#78350f;background:#1f1508;color:#fcd34d}
  .verdict{background:linear-gradient(180deg,#101a12,#0d1410);border:1px solid #1c3b25;border-left:3px solid var(--green);
    border-radius:10px;padding:20px 24px;margin:24px 0} .verdict b{color:#86efac}
  .grid2{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin:18px 0}
  .stat{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:18px 20px}
  .stat .k{font-size:12.5px;color:var(--fg3)} .stat .v{font-size:27px;font-weight:650;margin:6px 0 2px}
  .stat .d{font-size:12.5px;color:var(--fg2)} .up{color:var(--green)} .down{color:var(--red)} .neutral{color:var(--fg)}
  table{width:100%;border-collapse:collapse;margin:16px 0;font-size:14px}
  th,td{text-align:right;padding:10px 12px;border-bottom:1px solid var(--line)}
  th:first-child,td:first-child{text-align:left}
  th{color:var(--fg3);font-weight:600;font-size:12.5px;border-bottom:1px solid #2a3444}
  tbody tr:hover{background:#0f1521} .num{font-family:ui-monospace,Menlo,monospace;font-size:13.5px}
  .chart{width:100%;height:auto;background:var(--card2);border:1px solid var(--line);border-radius:10px;margin:16px 0}
  .plot{fill:#0a0f18;stroke:none} .grid{stroke:#1c2432;stroke-width:1}
  .ax{fill:#6b7280;font-size:11px;font-family:ui-monospace,Menlo,monospace} .axl{fill:#9aa4b2;font-size:12.5px} .lg{fill:#c7d0dc;font-size:12.5px}
  .bars{margin:14px 0} .bar-row{display:grid;grid-template-columns:230px 1fr 120px;align-items:center;gap:14px;margin:9px 0}
  .bar-lab{font-size:13.5px;color:var(--fg2)} .bar-track{background:#0d1420;border-radius:5px;height:22px;overflow:hidden;border:1px solid var(--line)}
  .bar-fill{height:100%;border-radius:4px} .bar-stack{display:flex;height:100%} .seg{height:100%} .seg.rtt{background:#374151}
  .bar-val{text-align:right;font-family:ui-monospace,Menlo,monospace;font-size:13px;color:var(--fg)}
  .note{background:var(--card2);border:1px solid var(--line);border-left:3px solid var(--amber);border-radius:8px;padding:15px 19px;margin:18px 0;font-size:14px;color:var(--fg2)}
  .note b{color:#fcd34d} .note.info{border-left-color:var(--blue)} .note.info b{color:#93c5fd}
  .note.ok{border-left-color:var(--green)} .note.ok b{color:#86efac}
  ul{margin:12px 0;padding-left:22px} li{margin:7px 0}
  .foot{margin-top:60px;padding-top:22px;border-top:1px solid var(--line);color:var(--fg3);font-size:12.5px}
  .lgd{display:inline-flex;align-items:center;gap:7px;margin-right:22px;font-size:12.5px;color:var(--fg2)}
  .lgd i{width:14px;height:10px;border-radius:2px;display:inline-block}
</style>
</head>
<body><div class="wrap">

<h1>MongoDB L0 一亿条压测报告</h1>
<p class="sub">
  实例 <code>28.79.181.33:7026</code> · 8C32G500G · 跨地域 RTT ${RTT_MS}ms<br/>
  最新：<code>l0_bench_w1_r1_s100m</code>（9/1，w:1）· 对比：<code>l0_bench_8c32g_r3_s100m</code>（8/31，w:majority）<br/>
  两次均为 batch=1000、并发=8，唯一变量是写关注。
</p>

<div class="pills">
  <span class="pill on">1 亿条 × 2 轮均完成</span>
  <span class="pill on">w:1 — 0 stall · 32 分钟</span>
  <span class="pill on">BM25 READY</span>
  <span class="pill warn">w:majority — 3 次完全停顿</span>
</div>

<div class="verdict">
  <p><b>结论：改成 w:1 后 WriteStall 完全消除，1 亿条 32 分钟写完，0 错误，最长单批 1.2 秒。</b></p>
  <p style="color:var(--fg2)">
    w:majority 那轮（8/31）平均 ${fmt(maji.docsPerSec)} docs/s、3 次完全停顿、最长单批 ${fmt(maji.batchLatency.maxMs / 1000, 1)} 秒——
    根因是复制跟不上导致 flow control 限流（<code>isLaggedCount=3</code>）。
    改成 w:1 后（9/1）平均 ${fmt(w1i.docsPerSec)} docs/s、<b>零吞吐窗口 0 次</b>、最长单批 ${fmt(w1i.batchLatency.maxMs / 1000, 1)} 秒。
    查询性能不受写关注影响，仅列 w:1 轮结果；延迟均扣除 ${RTT_MS}ms RTT 给出服务端耗时。
  </p>
</div>

<h2>一、写入对比：w:1 vs w:majority</h2>

<div class="grid2">
  <div class="stat"><div class="k">w:1 总耗时</div><div class="v up">${(w1i.wallMs / 60000).toFixed(1)} 分钟</div>
    <div class="d">w:majority ${(maji.wallMs / 60000).toFixed(1)} 分钟</div></div>
  <div class="stat"><div class="k">w:1 平均吞吐</div><div class="v up">${fmt(w1i.docsPerSec)} docs/s</div>
    <div class="d">w:majority ${fmt(maji.docsPerSec)} docs/s</div></div>
  <div class="stat"><div class="k">w:1 零吞吐窗口</div><div class="v up">${w1s.zeroWindows ?? 0} 次</div>
    <div class="d">w:majority ${majs.zeroWindows} 次</div></div>
  <div class="stat"><div class="k">w:1 最长单批</div><div class="v up">${fmt(w1i.batchLatency.maxMs / 1000, 1)} 秒</div>
    <div class="d">w:majority ${fmt(maji.batchLatency.maxMs / 1000, 1)} 秒</div></div>
</div>

<table>
  <thead><tr><th>指标</th><th>w:1（9/1）</th><th>w:majority（8/31）</th><th>升配前（参考）</th></tr></thead>
  <tbody>
    <tr><td>写关注</td><td class="num up">w:1</td><td class="num">w:majority</td><td class="num">w:majority</td></tr>
    <tr><td>总耗时</td><td class="num up">${(w1i.wallMs / 60000).toFixed(1)} min</td><td class="num">${(maji.wallMs / 60000).toFixed(1)} min</td><td class="num">${(odi.wallMs / 3600000).toFixed(1)} h</td></tr>
    <tr><td>平均吞吐</td><td class="num up">${fmt(w1i.docsPerSec)} /s</td><td class="num">${fmt(maji.docsPerSec)} /s</td><td class="num">${fmt(odi.docsPerSec)} /s</td></tr>
    <tr><td>峰值吞吐</td><td class="num">${fmt(Math.max(...w1Curve.map((p) => p.qps)))} /s</td><td class="num">${fmt(Math.max(...majCurve.map((p) => p.qps)))} /s</td><td class="num">${fmt(Math.max(...oldCurve.map((p) => p.qps)))} /s</td></tr>
    <tr><td>零吞吐窗口</td><td class="num up">${w1s.zeroWindows ?? 0}</td><td class="num down">${majs.zeroWindows}</td><td class="num">—</td></tr>
    <tr><td>慢批次 (>5s)</td><td class="num up">${w1s.slowBatches ?? 0}</td><td class="num down">有</td><td class="num">—</td></tr>
    <tr><td>写入错误</td><td class="num">${w1i.errors}</td><td class="num">${maji.errors}</td><td class="num">${odi.errors}</td></tr>
    <tr><td>BM25 索引</td><td class="num up">READY</td><td class="num up">READY</td><td class="num down">构建失败</td></tr>
  </tbody>
</table>

<h3>批延迟分位对比（batch=1000）</h3>
<table>
  <thead><tr><th>运行</th><th>p50</th><th>p90</th><th>p95</th><th>p99</th><th>p999</th><th>max</th></tr></thead>
  <tbody>
    ${latRow(w1i.batchLatency, "w:1（9/1）")}
    ${latRow(maji.batchLatency, "w:majority（8/31）")}
  </tbody>
</table>
<p style="color:var(--fg2);font-size:13.5px">
  w:majority 的 p99（${fmt(maji.batchLatency.p99Ms)}ms）看起来比 w:1（${fmt(w1i.batchLatency.p99Ms)}ms）更好，
  但 max 高达 ${fmt(maji.batchLatency.maxMs / 1000, 0)} 秒——极端长尾被 majority 等待「拉平」了，真正的问题在 max 和零吞吐窗口。
  w:1 的 p999 仅 ${fmt(w1i.batchLatency.p999Ms)}ms，分布干净。
</p>

<h2>二、QPS 曲线</h2>
<p>横轴统一为写入进度百分比。w:1（绿）全程平滑下滑；w:majority（橙）有三次断崖归零。</p>
${qpsOverlay}

<h3>按实际分钟（线性轴）</h3>
${qpsW1Linear}

<h3>w:1 分阶段平均吞吐</h3>
${barChart([25, 50, 75, 100].map((hi, i) => {
  const lo = [0, 25, 50, 75][i];
  const seg = w1Curve.filter((p) => p.pct > lo && p.pct <= hi);
  return { label: `${lo}–${hi}%`, value: Math.round(seg.reduce((a, b) => a + b.qps, 0) / Math.max(1, seg.length)), color: ["#22c55e", "#4ade80", "#86efac", "#bbf7d0"][i] };
}), { unit: " docs/s" })}

<h2>三、w:majority 的 WriteStall 分析</h2>

<div class="note ok">
  <p style="margin:0"><b>w:1 已验证消除此问题。</b>以下分析针对 w:majority 那轮，供理解根因；w:1 轮零吞吐窗口 = ${w1s.zeroWindows ?? 0}。</p>
</div>

<h3>精确时间窗口（2026-08-31，w:majority 轮）</h3>
<table>
  <thead><tr><th>窗口</th><th>瞬时吞吐</th><th>累计文档</th><th>判定</th></tr></thead>
  <tbody>${STALL_WINDOWS_MAJ.map((s) => `<tr>
    <td class="num">${s.from} → ${s.to}</td>
    <td class="num ${s.qps === 0 ? "down" : ""}">${fmt(s.qps)} /s</td>
    <td class="num">${fmt(s.docs)}</td><td>${s.kind}</td></tr>`).join("")}
  </tbody>
</table>

<h3>证据：flow control 触发 ${FLOW_MAJ.isLaggedCount} 次</h3>
<p>PRIMARY 上 <code>serverStatus().flowControl.isLaggedCount = ${FLOW_MAJ.isLaggedCount}</code>，与 3 次完全停顿数量一致。
<code>w:1</code> 不等从节点确认，绕开了这条限流路径。</p>

<h2>四、查询性能（w:1 轮，1 亿条）</h2>
<div class="note info"><p style="margin:0">不与升配前对比（索引已损坏）。串行单连接 200 次，延迟扣除 ${RTT_MS}ms RTT 给出服务端耗时。</p></div>
<table>
  <thead><tr><th>查询</th><th>实测 p50</th><th>服务端</th><th>实测 QPS</th><th>同机房理论 QPS</th><th>行数</th></tr></thead>
  <tbody>${queryRows.map(({ name, q }) => {
    const s = srv(q.latency.p50Ms);
    return `<tr><td>${QUERY_LABEL[name] ?? name}</td>
      <td class="num">${fmt(q.latency.p50Ms, 1)} ms</td><td class="num up">${fmt(s, 1)} ms</td>
      <td class="num">${fmt(q.qps, 1)}</td><td class="num up">${fmt(1000 / s, 0)}</td><td class="num">${fmt(q.lastHits)}</td></tr>`;
  }).join("")}
</tbody></table>
<h3>延迟拆解</h3>
${stackedLatencyChart(queryRows.map(({ name, q }) => ({ label: QUERY_LABEL[name] ?? name, total: q.latency.p50Ms, color: name.startsWith("search") ? "#a855f7" : "#3b82f6" })))}

<h2>五、结论</h2>
<ul>
  <li><b>w:1 验证通过。</b>1 亿条 32 分钟、${fmt(w1i.docsPerSec)} docs/s、0 错误、0 stall、BM25 READY。</li>
  <li><b>w:majority 的 stall 根因是复制跟不上。</b>flow control 触发 3 次 = 3 次完全停顿；改成 w:1 后问题消除。</li>
  <li><b>查询瓶颈是网络。</b>扣 RTT 后多数查询服务端 &lt;10ms；同机房或提并发可大幅改善。</li>
  <li><b>生产建议。</b>w:1 牺牲跨节点持久性保证；若业务需要 majority 安全，需控制写入速率或优化从节点复制能力。</li>
</ul>

<div class="foot">
  报告生成于 ${new Date().toLocaleString("zh-CN")} ·
  w:1 数据 <code>l0-bench-2026-09-01T14-02-56-975Z.json</code> ·
  w:majority 数据 <code>l0-bench-2026-08-31T07-18-23-351Z.json</code> ·
  重新生成：<code>node build-compare.mjs</code>
</div>
</div></body></html>`;

writeFileSync(OUT, html);
console.log(`✓ ${OUT}`);
console.log(`  w:1  ${fmt(w1i.docsPerSec)}/s  stall=${w1s.zeroWindows ?? 0}  max=${fmt(w1i.batchLatency.maxMs)}ms`);
console.log(`  maj  ${fmt(maji.docsPerSec)}/s  stall=${majs.zeroWindows}  max=${fmt(maji.batchLatency.maxMs)}ms`);
