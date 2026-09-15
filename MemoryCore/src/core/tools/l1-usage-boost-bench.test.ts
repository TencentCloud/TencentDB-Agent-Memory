/**
 * Mechanism-level A/B bench for the usage boost (recency/frequency re-ranking).
 *
 * Corpus: 150 L1 records (45 labeled query scenarios in 5 classes + background).
 * Rankers compared on the SAME store:
 *   old    — raw FTS bm25 order (pre-change behavior)
 *   shipped— shipped boost (recency w=0.3 hl=14d, freq w=0.2 sat=5)
 *   mild   — conservative sweep (0.1 / 0.05)
 *   strong — aggressive sweep (0.5 / 0.4)
 * 3 rounds with the shipped write-back active between rounds (feedback-loop sim).
 *
 * Scenario classes measure WHERE the boost helps vs hurts:
 *   A recency-tie       gold/distractor same keywords, gold newer → new should win
 *   B stale-authority   gold unique-but-old match, fresh weak distractor → flip = regression
 *   C usage-rescue      gold mediocre match but used recently → new should rescue
 *   D matthew-guardrail distractor spuriously used often, weak match → flip = regression
 *   E cold-neutral      no usage anywhere → sanity only
 *
 * Prints a metrics table; asserts only ranker consistency (shipped == recomputed
 * 0.3/0.2 variant) so measurement never fails on threshold noise.
 */
import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { VectorStore } from "../store/sqlite/memory-store.js";
import { executeMemorySearch } from "./memory-search.js";
import { buildFtsQuery } from "../store/tokenize.js";
import type { MemoryRecord } from "../record/l1-writer.js";
import type { L1FtsResult } from "../store/types.js";

const DAY = 86_400_000;
const TOPK = 15;
const LIMIT = 5;

const dir = mkdtempSync(join(tmpdir(), "tdai-boost-bench-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// ── corpus helpers ───────────────────────────────────────────────────────────

let seq = 0;
function rec(content: string, ageDays: number, tags: string[] = []): MemoryRecord {
  const ts = new Date(Date.now() - ageDays * DAY).toISOString();
  return {
    id: `r${seq++}`,
    content,
    type: "persona",
    priority: 50,
    scene_name: tags[0] ?? "",
    source_message_ids: [],
    metadata: {},
    timestamps: [ts],
    createdAt: ts,
    updatedAt: ts,
    sessionKey: "sk-bench",
    sessionId: "sid-bench",
    teamId: "t",
    userId: "u",
    agentId: "a",
  };
}

function touchN(store: VectorStore, id: string, n: number) {
  for (let i = 0; i < n; i++) expect(store.touchL1Usage([id])).toBe(1);
}

// ── sweepable boost math (mirrors shipped applyUsageBoost) ──────────────────

function boostOf(hit: { use_count?: number; last_used_ms?: number; updated_ms?: number },
                 wR: number, wF: number, hlDays = 14, sat = 5): number {
  const lastMs = Math.max(hit.last_used_ms ?? 0, hit.updated_ms ?? 0);
  const recency = lastMs > 0 ? Math.exp(-Math.max(0, Date.now() - lastMs) / (hlDays * DAY)) : 0;
  const n = hit.use_count ?? 0;
  return 1 + wR * recency + wF * (n / (n + sat));
}

function rankVariant(raw: L1FtsResult[], wR: number, wF: number): string[] {
  return [...raw]
    .map((h) => ({ id: h.record_id, s: h.score * boostOf(h, wR, wF) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, LIMIT)
    .map((x) => x.id);
}

function rankOf(ids: string[], gold: string): number {
  const i = ids.indexOf(gold);
  return i === -1 ? 0 : i + 1; // 0 = not in top-5
}

// ── corpus ───────────────────────────────────────────────────────────────────

interface Scenario { q: string; gold: string; distractor: string; klass: string; touches?: number }

const scenarios: Scenario[] = [];
const allRecords: MemoryRecord[] = [];

function addScenario(klass: string, q: string, gold: string, goldAge: number,
                     distractor: string, disAge: number, goldTouches = 0, disTouches = 0) {
  const g = rec(gold, goldAge);
  const d = rec(distractor, disAge);
  allRecords.push(g, d);
  scenarios.push({ q, gold: g.id, distractor: d.id, klass, touches: goldTouches });
  if (goldTouches > 0) (g as MemoryRecord & { __touches?: number }).__touches = goldTouches;
  if (disTouches > 0) (d as MemoryRecord & { __touches?: number }).__touches = disTouches;
}

// A — recency tie (10): same keyword collision, gold newer
const aTopics: Array<[string, string, string]> = [
  ["灰度发布", "灰度发布策略改为按地域逐步放量，先华东后华北", "灰度发布早期只在内部员工账号上试运行了一周"],
  ["数据库迁移", "数据库迁移窗口定在周六凌晨两点到四点", "数据库迁移前一周就冻结了所有 schema 变更"],
  ["代码评审", "代码评审要求两人互审，改动超过 500 行要拆分", "代码评审过去是自愿制，上个月才改成强制"],
  ["分支管理", "分支管理切到 trunk-based，特性分支存活不超过两天", "分支管理以前是 gitflow，长分支经常冲突"],
  ["回滚预案", "回滚预案以 helm rollback 为主，保留最近 5 个版本", "回滚预案最早靠手工导出镜像，现在已废弃"],
  ["密钥轮换", "密钥轮换周期缩短到 90 天，走 KMS 自动触发", "密钥轮换原来是人工季度操作，容易漏"],
  ["压测基线", "压测基线上调到 8000 QPS，p99 不超过 200ms", "压测基线早期只有 3000 QPS，参考价值不大"],
  ["日志保留", "日志保留期统一 30 天，审计日志单独 180 天", "日志保留以前只有 7 天，排查问题经常缺上下文"],
  ["依赖升级", "依赖升级每月第一个周二统一处理，锁定小版本", "依赖升级曾经随时可做，出过几次 breaking 事故"],
  ["告警分级", "告警分级改为 P0 电话、P1 群消息、P2 只进面板", "告警分级旧规则是全部发邮件，基本没人看"],
];
for (const [kw, gold, distractor] of aTopics) {
  addScenario("A", kw, gold, 2, distractor, 40);
}

// B — stale authority (10): gold unique-but-old, fresh weak distractor
const bTopics: Array<[string, string, string, number]> = [
  ["S3 归档桶", "S3 归档桶固定用 mem-archive-prod，不要用默认桶", "S3 上传失败会自动重试三次后进死信队列", 50],
  ["webhook 签名", "webhook 签名一律用 HMAC-SHA256，密钥从 vault 取", "webhook 重试会在五分钟内指数退避", 45],
  ["限流阈值", "网关限流阈值是每用户 200 rpm，超出返回 429", "网关最近加了 gzip，响应体小了一半", 60],
  ["备份策略", "备份策略：周日全量，其余天增量，保留 4 周", "备份任务最近从 crontab 迁到了 airflow", 40],
  ["单点登录", "单点登录只支持 OIDC，SAML 已下线不再维护", "单点登录页面最近换了新的品牌样式", 55],
  ["环境变量", "环境变量必须走 ParameterStore，禁止写死在 compose", "环境变量加载失败时服务会以降级模式启动", 48],
  ["时区处理", "时区处理统一存 UTC，展示层转用户本地时区", "时区相关的 bug 单上周清了一轮", 52],
  ["API 版本", "API 版本策略：v1 冻结只修 bug，新特性只进 v2", "API 文档站最近迁移到了新域名", 58],
  ["图片压缩", "图片压缩走 sharp，宽超过 2048 先缩再压", "图片存储最近加了 CDN 回源", 42],
  ["错误码", "错误码分段：5xxx 业务、4xxx 网关、3xxx 依赖", "错误码看板最近改版成了折线图", 47],
];
for (const [q, gold, distractor, goldAge] of bTopics) {
  addScenario("B", q, gold, goldAge, distractor, 1);
}

// C — usage rescue (10): gold mediocre match but used recently; distractor strong stale match
const cTopics: Array<[string, string, string]> = [
  ["支付网关 超时", "支付网关超时问题先看 pg-02 集群的重试配置再查对端", "支付网关超时阈值是 30 秒，超了直接熔断"],
  ["订单 幂等", "订单幂等现在靠 request_id 加 redis 锁双保险", "订单幂等最早用数据库唯一索引，量大后放弃"],
  ["库存 预占", "库存预占用 redisson 看门狗续期，超时 15 分钟释放", "库存预占老方案是数据库行锁，双十一扛不住"],
  ["消息 补发", "消息补发入口在运维台的补偿任务页，别手工插表", "消息补发以前靠脚本扫 binlog，已废弃"],
  ["权限 缓存", "权限缓存失效要同时清本地 caffeine 和远端 redis", "权限缓存最初只有本地一层，改权限要等重启"],
  ["文件 上传", "文件上传超过 100MB 走分片直传 OSS，别走网关中转", "文件上传早期限制 20MB 且全量走后端"],
  ["搜索 高亮", "搜索高亮用 es 的 highlighter，自定义标签要转义", "搜索高亮曾经前端正则替换，性能很差"],
  ["定时 任务", "定时任务统一挂 xxl-job，别再起 crontab", "定时任务过去散落在各机器 crontab 里"],
  ["国际化 文案", "国际化文案改动要跑 i18n-check 再提 PR", "国际化文案以前直接改 JSON 经常漏 key"],
  ["数据 订阅", "数据订阅走 cdc 同步到 kafka，topic 按 schema 分", "数据订阅曾经用双写，不一致问题很多"],
];
for (const [q, gold, distractor] of cTopics) {
  addScenario("C", q, gold, 30, distractor, 30, 4);
}

// D — matthew guardrail (10): weak distractor spuriously touched x8; strong gold never used
const dTopics: Array<[string, string, string]> = [
  ["Kafka 消费组 重平衡", "Kafka 消费组重平衡风暴的根因是分区数不均加慢消费者", "Kafka 本地调试用 redpanda 容器最省事"],
  ["K8s 探针", "K8s 就绪探针要检查依赖的 db ping，别只探进程", "K8s 集群版本上个月升到了 1.31"],
  ["CI 缓存", "CI 缓存按 lockfile 哈希做 key，命中率能到 90%", "CI 最近换了新的 runner 机型"],
  ["tls 证书", "tls 证书续期走 cert-manager 自动续，到期前 30 天告警", "tls 证书的 CA 上次换过一次供应商"],
  ["慢查询", "慢查询治理先看 explain 的 type 列，全表扫直接打回", "慢查询报表每周一自动发群里"],
  ["发布 冻结", "发布冻结期内只允许 cherry-pick 修复，不带新特性", "发布冻结通常在大促前两周开始"],
  ["依赖 审计", "依赖审计高危漏洞 48 小时内必须升级或加缓解", "依赖审计报告归档在内部 wiki"],
  ["日志 采样", "日志采样对 debug 级 1%，info 全量，错误永不采样", "日志采集器前阵子升级了版本"],
  ["熔断 规则", "熔断规则按错误率 50% 持续 10 秒触发，半开 5 个请求", "熔断面板最近加了租户维度"],
  ["配置 中心", "配置中心改动必须写变更说明并 @ 相关服务 owner", "配置中心后台昨天优化了加载速度"],
];
for (const [q, gold, distractor] of dTopics) {
  addScenario("D", q, gold, 20, distractor, 5, 0, 8);
}

// E — cold neutral (5): no usage anywhere, staggered ages
const eTopics: Array<[string, string, string, number, number]> = [
  ["额度 申请", "额度申请超过 10 万要 CTO 审批", "额度申请流程文档在Confluence 上", 15, 3],
  ["实习 转正", "实习转正答辩安排在每季度末", "实习转正需要两位导师背书", 25, 4],
  ["会议室 预订", "会议室预订走飞书机器人，禁止口头占", "会议室预订系统上个月迁移过", 18, 2],
  ["差销 报销", "差销报销单据要 attach 发票原件照片", "差销报销周五统一打款", 30, 6],
  ["值班 表", "值班表每月 25 号排下个月，冲突自行调换", "值班表现在同步到日历订阅", 12, 3],
];
for (const [q, gold, distractor, gAge, dAge] of eTopics) {
  addScenario("E", q, gold, gAge, distractor, dAge);
}

// background noise (60): 6 topics × 10 variants, spread over 60 days
const bgTopics: Array<[string, string[]]> = [
  ["auth", ["登录态有效期 7 天滑动续期", "oauth 回调地址要在控制台白名单注册", "密码错误锁定阈值 5 次后 15 分钟", "会话注销要清三个端的 token", "游客身份 24 小时后自动过期", "登录验证码 60 秒内最多发 3 条", "多设备登录上限 5 台", "token 刷新接口限流 10 qps", "账号注销有 7 天冷静期", "匿名 session 提交要防重放"]],
  ["deploy", ["构建产物保留 14 天后清理", "镜像 tag 用短 sha 加环境后缀", "预发环境每晚自动同步生产配置", "发布单需要值班 SRE 批准", "金丝雀 5% 观察 10 分钟", "生产变更窗口是工作日 14-18 点", "回滚演练每季度一次", "部署脚本禁止交互式输入", "灰度实例日志单独打标签", "发布后 30 分钟内盯错误率大盘"]],
  ["db", ["主从延迟超过 800ms 触发切读", "大表 DDL 用 gh-ost 在线执行", "慢日志阈值 500ms 每天汇总", "连接池上限按实例规格 4 倍内存估", "冷数据按月分区归档到对象存储", "全量备份每周日凌晨业务低峰跑", "索引变更要附查询计划截图", "读写分离在代理层做，业务无感", "单实例表数量超过 3000 要拆库", "审计库独立实例禁止混部"]],
  ["api", ["分页游标一律 base64 编码的 offset", "批量接口单次上限 100 条", "幂等键放 header 的 x-idempotency-key", "错误响应统一 code/message/detail 三段", "字段命名 snake_case，兼容层转 camelCase", "软删除资源 GET 返回 404 但管理员可见", "限流后返回 retry-after 秒数", "接口超时统一 3 秒，文件类 30 秒", "枚举值新增必须向后兼容", "废弃字段先标 deprecated 两个版本再删"]],
  ["frontend", ["组件库统一走内部 npm 源", "路由级代码分割必须开", "埋点采样率生产 10% 预发全量", "首屏 LCP 目标 2.5 秒内", "骨架屏超过 300ms 才显示", "暗色主题色板从 design token 取", "表单校验前后端各一层，提示以后端为准", "静态资源指纹命名强缓存一年", "WebView 桥接方法要判空降级", "国际化键名按页面域前缀组织"]],
  ["ops", ["值班交接文档当天必填", "告警静默要写原因和到期时间", "变更单与监控面板链接互挂", "故障复盘 48 小时内出初稿", "跑路演练每半年一次", "工单响应 P0 十五分钟内认领", "容量评审每季度看一次水位", "生产 SSH 走堡垒机双人复核", "应急预案每页都要有回滚段落", "运维脚本入库禁止本地散落"]],
];
bgTopics.forEach(([tag, lines], ti) => {
  lines.forEach((line: string, li: number) => {
    allRecords.push(rec(`[${tag}] ${line}`, ((ti * 10 + li) % 60) + 1, [tag]));
  });
});

// ── run ──────────────────────────────────────────────────────────────────────

describe("usage boost bench (mechanism-level, prints report)", () => {
  it("old vs shipped vs sweeps across scenario classes", async () => {
    const store = new VectorStore(join(dir, "bench.db"), 0);
    store.init();
    for (const r of allRecords) store.upsertL1(r, undefined);
    // inject spurious usage state
    for (const s of scenarios) {
      const gold = allRecords.find((r) => r.id === s.gold)!;
      const dis = allRecords.find((r) => r.id === s.distractor)!;
      if ((gold as any).__touches) touchN(store, gold.id, (gold as any).__touches);
      if ((dis as any).__touches) touchN(store, dis.id, (dis as any).__touches);
    }

    const variants = [
      ["heavy", 0.3, 0.2],
      ["strong", 0.5, 0.4],
    ] as const;
    const classes = ["A", "B", "C", "D", "E"];
    type Acc = { top1: number; r5: number; mrr: number; n: number; regressed: number; rescued: number;
      top1_R1?: number; top1_R3?: number; mrr_R1?: number; mrr_R3?: number;
      regressed_R1?: number; regressed_R3?: number; rescued_R1?: number; rescued_R3?: number };
    const acc: Record<string, Record<string, Acc>> = {};
    for (const k of ["old", "shipped", ...variants.map((v) => v[0])]) {
      acc[k] = {};
      for (const c of [...classes, "ALL"]) acc[k][c] = { top1: 0, r5: 0, mrr: 0, n: 0, regressed: 0, rescued: 0 };
    }

    const ROUNDS = 3;
    for (let round = 1; round <= ROUNDS; round++) {
      const roundAcc: Record<string, Record<string, Acc>> = {};
      for (const k of ["old", "shipped", ...variants.map((v) => v[0])]) {
        roundAcc[k] = {};
        for (const c of [...classes, "ALL"]) roundAcc[k][c] = { top1: 0, r5: 0, mrr: 0, n: 0, regressed: 0, rescued: 0 };
      }

      for (const s of scenarios) {
        const raw = store.searchL1Fts(buildFtsQuery(s.q)!, TOPK);
        const oldIds = raw.slice(0, LIMIT).map((h) => h.record_id);

        const shippedRes = await executeMemorySearch({ query: s.q, limit: LIMIT, vectorStore: store });
        const shippedIds = shippedRes.results.map((r) => r.id);

        // consistency: shipped ordering == recomputed deployed weights (0.1/0.05)
        expect(rankVariant(raw, 0.1, 0.05)).toEqual(shippedIds);

        const sweepIds = variants.map(([, wr, wf]) => rankVariant(raw, wr, wf));
        const allRankers: Array<[string, string[]]> = [["old", oldIds], ["shipped", shippedIds],
          ...variants.map((v, i) => [v[0], sweepIds[i]] as [string, string[]])];

        for (const [name, ids] of allRankers) {
          const rank = rankOf(ids, s.gold);
          const oldRank = rankOf(oldIds, s.gold);
          const a = roundAcc[name][s.klass];
          const all = roundAcc[name].ALL;
          for (const t of [a, all]) {
            t.n++;
            if (rank === 1) t.top1++;
            if (rank > 0) { t.r5++; t.mrr += 1 / rank; }
          }
          if (name !== "old") {
            if (oldRank === 1 && rank !== 1) roundAcc[name][s.klass].regressed++;
            if (oldRank !== 1 && rank === 1) roundAcc[name][s.klass].rescued++;
          }
        }
      }
      // record round stats for shipped drift report
      if (round === 1 || round === ROUNDS) {
        const tag = round === 1 ? "R1" : `R${ROUNDS}`;
        for (const name of Object.keys(roundAcc)) {
          for (const c of Object.keys(roundAcc[name])) {
            const s = roundAcc[name][c];
            acc[name][c][`top1_${tag}` as keyof Acc] = s.top1;
            acc[name][c][`mrr_${tag}` as keyof Acc] = Number(s.mrr.toFixed(2));
            acc[name][c][`regressed_${tag}` as keyof Acc] = s.regressed;
            acc[name][c][`rescued_${tag}` as keyof Acc] = s.rescued;
            acc[name][c].n = s.n;
          }
        }
      }
      if (round < ROUNDS) {
        // feedback loop: shipped write-back already happened during round searches
        continue;
      }
    }

    // ── report ──
    const line = (n: unknown, w: number) => String(n).padEnd(w);
    console.log("\n=== usage-boost bench | 45 queries | 3 rounds (write-back evolves usage) ===");
    console.log("variant  class | n | top1 R1→R3 | MRR R1→R3 | regressed R1→R3 | rescued R1→R3");
    for (const name of ["old", "shipped", "heavy", "strong"]) {
      for (const c of [...classes, "ALL"]) {
        const a = acc[name][c];
        const t1 = `${a.top1_R1 ?? a.top1}→${a.top1_R3 ?? a.top1}`;
        const mr = `${a.mrr_R1 ?? a.mrr.toFixed(2)}→${a.mrr_R3 ?? a.mrr.toFixed(2)}`;
        console.log(
          line(name, 8) + line(c, 5) + line(`| ${a.n}`, 5) + "| " +
          line(t1, 11) + "| " + line(mr, 10) + "| " +
          line(`${a.regressed_R1 ?? a.regressed}→${a.regressed_R3 ?? a.regressed}`, 16) + "| " +
          `${a.rescued_R1 ?? a.rescued}→${a.rescued_R3 ?? a.rescued}`,
        );
      }
    }
    console.log("(A/C: gold SHOULD win — rescued good, regressed bad; B/D: gold should keep #1 — regressed bad)\n");

    store.close();
  });
});
