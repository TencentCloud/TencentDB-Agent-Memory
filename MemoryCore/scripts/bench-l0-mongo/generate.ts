/**
 * Fake L0 document generation for the bench.
 *
 * Design points:
 *  - `_id` = `msg-` + full UUID (32 hex), matching the production change in
 *    `src/gateway/v2-router.ts` — no truncation, no collisions at 1e8.
 *  - `tokens` (jieba FTS segmentation) is precomputed ONCE per template into a
 *    pool; the hot generation path never calls jieba, so write QPS reflects
 *    Mongo + network, not tokenization cost. Production pre-segments on the
 *    request path instead, which is a separate (bounded) cost.
 *  - Isolation dimensions (team/user/agent) and sessions are spread across
 *    pools so business-shaped queries hit an index instead of scanning.
 *  - `makeDoc(globalIndex, ctx)` is pure and cheap so workers can lazily
 *    generate their slice — essential for the 100M phase (never materialize
 *    all docs in memory).
 */

import { randomUUID } from "node:crypto";
import { tokenizeForFts } from "../../src/core/store/tokenize.js";
import type { L0Doc } from "../../src/core/store/mongodb/doc-mappers.js";

/** `msg-` + 32 hex (full UUID, hyphens stripped). Same shape as production. */
export function newMsgId(): string {
  return `msg-${randomUUID().replace(/-/g, "")}`;
}

/**
 * Seed sentences mixing zh/en so BM25 has real tokens to score. ~100 distinct
 * base sentences (the pool cycles through them) — richer than the original 16 so
 * the search index's term cardinality is closer to real traffic.
 */
const SEED_TEXTS: string[] = [
  "用户询问如何在生产环境部署 MongoDB 副本集并开启鉴权",
  "帮我排查一下订单服务的超时问题，日志里有大量连接被拒绝",
  "请总结这次需求评审的关键结论以及后续的排期计划",
  "我们想压测记忆存储的写入吞吐，目标是每秒插入多少条对话",
  "The customer wants to migrate their vector search workload to a keyword BM25 index",
  "分析一下这段代码的时间复杂度，并给出可能的优化方向",
  "把上一轮的对话内容整理成一个待办清单，按优先级排序",
  "数据库连接池配置多大合适，QPS 上来之后延迟怎么变化",
  "解释一下 Okapi BM25 的打分公式以及词频饱和的作用",
  "帮我写一个并发的批量插入脚本，控制每批的大小和并发度",
  "会议纪要：确认了灰度发布方案，下周一开始逐步放量",
  "检索召回率不够高，是不是分词的粒度需要调整一下",
  "线上出现了内存泄漏，帮我定位是哪个模块持有了大对象",
  "give me the p99 latency of the search endpoint under peak traffic",
  "把这个 JSON 报告可视化成柱状图，展示各档写入的 QPS 与分位延迟",
  "用户反馈搜索结果不相关，怀疑是隔离过滤没有正确下推",
  "帮我设计一个多租户的权限模型，按团队、用户和智能体三层隔离",
  "这个接口的幂等性怎么保证，重复提交会不会产生脏数据",
  "我们需要对历史对话做归档，冷数据迁移到成本更低的存储",
  "Explain how change streams keep the search index in sync with the collection",
  "帮我把这段 Python 改写成异步版本，用连接池复用 HTTP 客户端",
  "排查一下为什么消费者组出现了大量的重平衡和消息堆积",
  "给我一份本周的稳定性周报，包含告警数量和平均恢复时间",
  "我想给智能体加一个长期记忆，能跨会话召回用户的偏好",
  "分析这次慢查询，看看是缺索引还是查询计划选错了",
  "The embedding model latency spiked after we increased the batch size",
  "帮我写一个限流中间件，支持令牌桶和滑动窗口两种策略",
  "复盘一下昨晚的故障，根因是配置下发时覆盖了线上参数",
  "我们的向量维度是多少，召回时用余弦相似度还是内积",
  "把用户上传的长文档切块，做重叠窗口以提升检索的连续性",
  "帮我评估一下从单机 SQLite 迁移到分布式方案的收益和风险",
  "线上 CPU 打满了，火焰图显示大部分时间花在序列化上",
  "给这个 REST 接口补充 OpenAPI 文档和请求示例",
  "我们想 A/B 测试两种召回策略，怎么设计指标和分流",
  "帮我把提示词模板参数化，不同场景注入不同的系统指令",
  "The write amplification got worse after we added the full-text index",
  "排查网关返回 502，怀疑是上游超时导致连接被提前关闭",
  "帮我整理一份新人上手文档，包含本地启动四个服务的步骤",
  "我们要给检索结果加重排序，用交叉编码器还是规则打分",
  "分析这批对话里用户最常问的十个意图并归类",
  "帮我给缓存加一层布隆过滤器，减少无效的回源查询",
  "数据倾斜严重，某个租户的写入量占了整体的八成",
  "给我看一下最近一小时各接口的错误率和 P95 延迟趋势",
  "帮我把批处理任务改成流式处理，降低端到端的延迟",
  "We need to shard the collection by team_id to spread the write load",
  "排查一下定时任务偶发丢失，是不是分布式锁没拿到",
  "帮我写单元测试覆盖这个分页逻辑的边界条件",
  "我们的知识库更新后，旧的向量索引要不要重建",
  "分析这段 SQL 的执行计划，为什么走了全表扫描",
  "帮我把日志格式统一成结构化 JSON，方便后续采集",
  "线上偶发数据不一致，怀疑是读写分离的主从延迟造成的",
  "给智能体接入工具调用，先做天气查询和日程创建两个",
  "帮我评估一下把鉴权下沉到网关的可行性和改造成本",
  "The reranker improved precision but doubled the tail latency",
  "排查一下内存里的对象为什么一直不被回收，可能有闭包引用",
  "帮我设计一个回滚方案，出问题能在五分钟内切回旧版本",
  "我们要统计每个智能体的 token 消耗，做成本归因",
  "分析这次压测的瓶颈到底在客户端、网络还是数据库",
  "帮我把这个同步接口改成支持流式返回，边生成边下发",
  "线上搜索有时返回空结果，怀疑索引还没构建完成就被查询",
  "给我一份容量规划，按当前增速什么时候需要扩容",
  "帮我给这段代码加上超时和重试，避免级联失败",
  "We should pre-tokenize Chinese text so Lucene doesn't re-segment it",
  "排查一下为什么冷启动这么慢，是不是加载了太多依赖",
  "帮我把用户画像做成可增量更新的，不用每次全量重算",
  "分析这批错误日志，聚类出现次数最多的几种异常",
  "我们要给对话打标签，自动识别情绪和紧急程度",
  "帮我写一个健康检查接口，返回各依赖组件的连通性",
  "线上出现了雪崩，帮我加熔断和降级保护核心链路",
  "给我对比一下几种向量数据库在召回和成本上的差异",
  "帮我把这个长事务拆小，减少锁的持有时间",
  "The isolation filter must be pushed into the search compound query",
  "排查一下为什么某些请求的 trace 断了，缺失了下游 span",
  "帮我给前端加一个加载骨架屏，改善首屏体验",
  "我们要做灰度，按用户 ID 哈希分桶逐步放量",
  "分析这段对话为什么召回不到相关记忆，是不是过滤太严",
  "帮我把配置中心的热更新做好，改参数不用重启服务",
  "线上磁盘快满了，帮我定位是哪些集合占用最大",
  "给智能体加一个反思环节，在给出答案前先自检",
  "帮我评估把嵌入计算放到 GPU 上的吞吐提升",
  "We keep the message text for replay and index only the tokens field",
  "排查一下为什么批量写入偶尔报主键冲突，ID 生成有问题吗",
  "帮我把这个爬虫改成分布式的，任务用队列分发",
  "分析用户流失的关键节点，看看在哪一步放弃了",
  "帮我给接口加一层幂等键，防止网络重试导致重复下单",
  "我们要把检索、记忆、技能三种注入合并成一个管线",
  "线上偶发 OOM，帮我调一下 JVM 的堆和 GC 参数",
  "给我一份索引使用报告，哪些索引从没被命中过",
  "帮我把长对话做摘要压缩，只保留关键事实和决策",
  "The canary write proved the search index is queryable before the full load",
  "排查一下为什么跨地域访问延迟这么高，是不是没走就近节点",
  "帮我把权限校验的结果缓存起来，减少每次请求的开销",
  "我们要支持多语言检索，中英文混排时怎么分词",
  "分析这次发布后的指标回归，转化率有没有显著下降",
  "帮我写一个数据校验脚本，比对迁移前后的记录数和校验和",
  "线上有慢接口拖垮了整个线程池，帮我做隔离舱壁",
  "给智能体接入知识库，回答时带上引用来源",
  "帮我评估把同步日志改成异步落盘对写入延迟的影响",
  "We measure P50, P90, P95 and P99 to understand the latency distribution",
  "排查一下为什么某个会话的消息顺序乱了，时间戳是不是重复了",
];

export interface Template {
  text: string;
  tokens: string;
}

/** Build a pool of distinct-but-overlapping templates with precomputed tokens. */
export function buildTemplatePool(size: number): Template[] {
  const pool: Template[] = [];
  for (let i = 0; i < size; i++) {
    const seed = SEED_TEXTS[i % SEED_TEXTS.length];
    const text = `${seed}（样本 ${i}）`;
    pool.push({ text, tokens: tokenizeForFts(text) });
  }
  return pool;
}

export interface IsolationPools {
  teams: string[];
  users: string[];
  agents: string[];
}

export function buildIsolationPools(teams: number, users: number, agents: number): IsolationPools {
  const mk = (prefix: string, n: number) =>
    Array.from({ length: Math.max(1, n) }, (_, i) => `${prefix}-${i}`);
  return { teams: mk("team", teams), users: mk("user", users), agents: mk("agent", agents) };
}

export interface GenContext {
  pool: Template[];
  iso: IsolationPools;
  /** Number of distinct sessions to cycle across the dataset. */
  sessionsCount: number;
  /** Messages per session (a session's rows share session_key/isolation). */
  msgsPerSession: number;
  /** Base epoch ms; each doc gets baseMs + globalIndex to keep ordering stable. */
  baseMs: number;
}

export function defaultGenContext(
  poolSize: number,
  totalDocs: number,
  baseMs = Date.now(),
): GenContext {
  const pool = buildTemplatePool(poolSize);
  // Aim for a realistic-ish fan-out: many sessions, a handful of turns each.
  const msgsPerSession = 6;
  const sessionsCount = Math.max(1, Math.ceil(totalDocs / msgsPerSession));
  const teams = Math.max(4, Math.ceil(Math.sqrt(sessionsCount) / 4));
  const iso = buildIsolationPools(teams, teams * 3, teams * 2);
  return { pool, iso, sessionsCount, msgsPerSession, baseMs };
}

/** Pure, allocation-light doc factory. Safe to call from concurrent workers. */
export function makeDoc(globalIndex: number, ctx: GenContext): L0Doc {
  const sessionIdx = Math.floor(globalIndex / ctx.msgsPerSession) % ctx.sessionsCount;
  const sessionId = `sess-${sessionIdx}`;
  const team = ctx.iso.teams[sessionIdx % ctx.iso.teams.length];
  const user = ctx.iso.users[sessionIdx % ctx.iso.users.length];
  const agent = ctx.iso.agents[sessionIdx % ctx.iso.agents.length];
  const tpl = ctx.pool[globalIndex % ctx.pool.length];
  const ts = ctx.baseMs + globalIndex;
  return {
    _id: newMsgId(),
    session_key: sessionId,
    session_id: sessionId,
    team_id: team,
    task_id: "",
    user_id: user,
    agent_id: agent,
    role: globalIndex % 2 === 0 ? "user" : "assistant",
    message_text: tpl.text,
    tokens: tpl.tokens,
    recorded_at: new Date(ts).toISOString(),
    recorded_at_ms: ts,
    timestamp: ts,
  };
}

export interface QueryTarget {
  /** A session guaranteed to exist (index 0) with several messages. */
  sessionId: string;
  sessionKey: string;
  teamId: string;
  userId: string;
  agentId: string;
  /** A text whose tokens are guaranteed present in the dataset (BM25 hits). */
  hitText: string;
  /** A text whose tokens are absent (empty-result path). */
  missText: string;
}

/** Reconstruct a deterministic query target from the generation context. */
export function queryTargetFor(ctx: GenContext): QueryTarget {
  const sessionIdx = 0;
  return {
    sessionId: `sess-${sessionIdx}`,
    sessionKey: `sess-${sessionIdx}`,
    teamId: ctx.iso.teams[sessionIdx % ctx.iso.teams.length],
    userId: ctx.iso.users[sessionIdx % ctx.iso.users.length],
    agentId: ctx.iso.agents[sessionIdx % ctx.iso.agents.length],
    hitText: ctx.pool[0].text,
    // Pure latin gibberish — no CJK word that could tokenize back into the
    // corpus, so BM25 genuinely returns nothing (prices the no-hit path).
    missText: "zzqx wibblefrotz qwzxpl vhnkrt bxqztl mrrkgp",
  };
}
