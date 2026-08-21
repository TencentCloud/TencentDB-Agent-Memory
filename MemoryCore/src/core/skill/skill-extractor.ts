/**
 * SkillExtractor — 接受结构化 ExtractMessage[] 的抽取入口
 *
 * 与旧 SkillExtractor 的差异：
 *   - 入参 messages 必须是 `ExtractMessage[]`，不再接受裸字符串
 *   - 内部把 messages 串成 transcript（保留 role 标记）
 *   - 工具调用走 SkillToolsV2（操作 SkillCore）
 *   - 候选返回 ExtractedSkillCandidate 形态（含 skill_id / version）
 *
 * 每次调用都走 LLM，不做任何对话级去重/缓存 —— 缓存机制已移除。
 */

import type { ExtractMessage } from "./types.js";
import type { SkillCore } from "./skill-core.js";
import { createSkillTools, type ExtractedSkillCandidate } from "./skill-tools.js";
import type {
  ISkillExtractor,
  ConversationMessage,
  ExtractedCandidate,
} from "./queue/types.js";
import { metricProducer } from "../report/kafka-metric-producer.js";
import { trace } from "../report/trace.js";
import { obsLogger } from "../report/obs-logger.js";

const TAG = "[skill-extractor]";

export interface ExtractorRunner {
  run(params: {
    prompt: string;
    systemPrompt?: string;
    tools?: Record<string, unknown>;
    enableTools?: boolean;
    maxIterations?: number;
    /** Output token 上限；不填由 runner 兜底 (标准 runner 走 llm.maxTokens)。 */
    maxTokens?: number;
    taskId: string;
    timeoutMs?: number;
    signal?: AbortSignal;
    /** Langfuse trace name（用于 UI 筛选与命名，见 core/types.ts LLMRunParams）。 */
    traceName?: string;
    /** Langfuse tags（用于 UI 筛选）。 */
    tags?: string[];
    /** Langfuse 顶级 sessionId。 */
    sessionId?: string;
    /** Langfuse 顶级 userId。 */
    userId?: string;
    /** 实例 id；透传成 telemetry 的 instanceId（缺失时 runner 侧兜底 "unknown"）。 */
    instanceId?: string;
  }): Promise<string>;
}

export interface ExtractorOptions {
  core: SkillCore;
  runner?: ExtractorRunner;
  systemPrompt?: string;
  maxIterations?: number;
  /** Transcript head-tail truncation: chars to keep from the start (default 8000). */
  headChars?: number;
  /** Transcript head-tail truncation: chars to keep from the end (default 32000). */
  tailChars?: number;
  /**
   * Skill review 单次 LLM 调用输出 token 上限。不填 → 由 runner 继承 llm.maxTokens。
   * 与 llm.maxTokens 独立配置：skill review 输出（含 tool-call 参数里的 SKILL.md
   * 全文）通常比其它 stage 大，可能需要单独调高。
   */
  maxTokens?: number;
  /**
   * 预检索 skill 列表条数上限 (relevant BM25 search & recent 兜底共用)。
   * 构造器默认 0 (关闭); 生产 wiring 层 (tdai-core / server) 从 skill-config
   * 拿 resolved.extraction.prefixSkillsLimit (默认 20) 显式传入。测试构造无参
   * 时不触发额外的 query-gen LLM 调用。
   */
  prefixSkillsLimit?: number;
  logger?: { info(msg: string): void; warn(msg: string): void; error(msg: string): void };
}

export interface ExtractInput {
  user_id: string;
  team_id: string;
  agent_id: string;
  task_id?: string;
  session_id?: string;
  /** 实例 id（= space_id）；透传成 runner telemetry 的 instanceId。 */
  space_id?: string;
  messages: ExtractMessage[];
  options?: {
    max_iterations?: number;
  };
  /** 主 Agent 的抽取提示，有值时注入到抽取 LLM 的 user prompt 最前面。 */
  reason?: string;
}

export interface ExtractResult {
  candidates: ExtractedSkillCandidate[];
  text?: string;
}

export class SkillExtractor {
  private readonly core: SkillCore;
  private readonly runner?: ExtractorRunner;
  private readonly systemPrompt: string;
  private readonly maxIterations: number;
  private readonly headChars: number;
  private readonly tailChars: number;
  private readonly maxTokens?: number;
  private readonly prefixSkillsLimit: number;
  private readonly logger?: ExtractorOptions["logger"];

  constructor(opts: ExtractorOptions) {
    this.core = opts.core;
    this.runner = opts.runner;
    this.systemPrompt = opts.systemPrompt ?? "You are a Skill Review Agent. Use tools to look at existing skills, decide what to add/improve, and call skill_create / skill_update / skill_patch / skill_files_write to persist.";
    this.maxIterations = opts.maxIterations ?? 16;
    this.headChars = opts.headChars ?? 8000;
    this.tailChars = opts.tailChars ?? 32000;
    this.maxTokens = opts.maxTokens;
    // 构造器默认 0 (关闭前缀注入 → 不会触发额外的 query-gen LLM 调用);
    // 生产 wiring 会显式传入 resolved.extraction.prefixSkillsLimit (默认 20)。
    // <0 或非数字回落到 0 (等价于关闭), 而不是静默改到 20 —— 不想让配置错误
    // 变成"意外多花一次 LLM"。
    const rawLimit = opts.prefixSkillsLimit;
    this.prefixSkillsLimit = rawLimit === undefined
      ? 0
      : (Number.isFinite(rawLimit) && rawLimit >= 0 ? Math.floor(rawLimit) : 0);
    this.logger = opts.logger;
  }

  async extract(input: ExtractInput): Promise<ExtractResult> {
    const { messages } = input;
    if (!Array.isArray(messages) || messages.length === 0) {
      throw new Error("ExtractV2: messages must be a non-empty array of ExtractMessage");
    }
    // [obs] 一次抽取一条汇总事件；LLM 内部 iteration 走 langfuse trace（trace.report
    // → OTel Span → Langfuse SpanProcessor 过滤上报），这里只做「入口→出口」
    // 的耗时 / 候选数量汇总，用 task_id 做 anchor 跟 worker 段对齐。obsLogger
    // 内部 try/catch + FileLogger + 后端降级，logger 挂了也不影响抽取本身。
    const t0 = Date.now();
    const transcript = formatTranscript(messages);

    const truncated = truncateHeadTail(transcript, this.headChars, this.tailChars);

    // 预检索 skill 列表, 塞在 user prompt 前面, 让 review agent 一进场就能看到
    // agent 自己已经拥有哪些 skill (避免盲目 skill_create 撞 SKILL_NAME_DUPLICATE)。
    //
    // 三种模式, 由 prefixSkillsLimit + 该 agent 拥有的 skill 总数联合决定:
    //   full     — total ≤ limit: 全部注入; 不花 query-gen LLM。
    //   relevant — total > limit + query-gen 成功 + BM25 命中 ≥1: 相关性优先。
    //   recent   — total > limit + relevant 失败 (query-gen 抛 / 空 / 命中 0):
    //              退回按 updated_at DESC 的 top-N + "还有 X 条未显示" 提示。
    //   none     — prefixSkillsLimit=0 或 total=0。
    //
    // 关键: 一次 core.list({ limit }) 同时拿到 items + total, 之后所有分支复用,
    // 不再二次查库; total ≤ limit 的场景直接跳过 query-gen, 覆盖率反而更高。
    let prefixBlock = "";
    let prefixMode: "full" | "relevant" | "recent" | "none" = "none";
    let prefixQuery: string | undefined;
    if (this.prefixSkillsLimit > 0) {
      let recentPage: Awaited<ReturnType<typeof this.core.list>> | null = null;
      try {
        recentPage = await this.core.list({
          user_id: input.user_id,
          team_id: input.team_id,
          agent_id: input.agent_id,
          pagination: { limit: this.prefixSkillsLimit },
        });
      } catch (e) {
        // list 挂 → 后续分支也没数据可用, 直接进 none 分支。
        this.logger?.warn(`${TAG} prefix list failed: ${(e as Error).message}`);
      }
      if (recentPage && recentPage.items.length > 0) {
        if (recentPage.total <= this.prefixSkillsLimit) {
          // Case full: 拿到全部, 直接铺开; query-gen 完全省掉。
          prefixBlock = renderFullSkillsBlock(recentPage.items);
          prefixMode = "full";
        } else {
          // Case relevant: total 超 limit, 花一次 LLM query-gen + BM25 找最相关的。
          try {
            const relevant = await this.buildRelevantSkillsBlock(input, truncated);
            if (relevant) {
              prefixBlock = relevant.block;
              prefixMode = "relevant";
              prefixQuery = relevant.query;
            }
          } catch (e) {
            this.logger?.warn(`${TAG} buildRelevantSkillsBlock failed: ${(e as Error).message}`);
          }
          if (!prefixBlock) {
            // Case recent: relevant 失败, 用一开始拿到的 top-N 兜底, 附带
            // "还有 X 条未显示" 提示让 LLM 知道自己可以 skill_list 手动补拉。
            prefixBlock = renderRecentSkillsBlock(recentPage.items, recentPage.total);
            prefixMode = "recent";
          }
        }
      }
    }
    let prompt = prefixBlock ? `${prefixBlock}\n\n---\n\n${truncated}` : truncated;

    // 主 Agent 注入抽取提示（reason 非空时放在 prompt 最前面）
    if (input.reason && input.reason.trim().length > 0) {
      const hintBlock = [
        "## 主 Agent 的抽取提示",
        "以下是主 Agent 对本次对话的说明，请重点参考其意图进行抽取：",
        input.reason,
      ].join("\n");
      prompt = `${hintBlock}\n\n---\n\n${prompt}`;
    }

    const auditSink: ExtractedSkillCandidate[] = [];

    if (!this.runner) {
      // No runner injected (test environment / disabled) → 返回空候选
      this.logger?.info(`${TAG} no runner provided; returning empty candidates`);
      obsLogger.info("skill.extractor.extract", {
        task_id: input.task_id,
        dur_ms: Date.now() - t0,
        msg_count: messages.length,
        candidates: 0,
        skipped: "no_runner",
      });
      return { candidates: [] };
    }

    const tools = createSkillTools({
      core: this.core,
      user_id: input.user_id,
      team_id: input.team_id,
      agent_id: input.agent_id,
      task_id: input.task_id,
      auditSink,
      logger: this.logger,
    });

    let text: string;
    try {
      text = await this.runner.run({
        prompt,
        systemPrompt: this.systemPrompt,
        tools,
        enableTools: true,
        maxIterations: input.options?.max_iterations ?? this.maxIterations,
        maxTokens: this.maxTokens,
        taskId: `skill-extract-${input.task_id ?? "unknown"}`,
        // Langfuse trace 语义：让此次抽取在 Langfuse UI 有稳定 name / 可筛选 tags。
        // 详见 core/types.ts LLMRunParams 的 traceName/tags/sessionId/userId 注释。
        traceName: "skill.extract",
        tags: [
          "skill-extract",
          `team:${input.team_id}`,
          `agent:${input.agent_id}`,
        ],
        sessionId: input.session_id,
        userId: input.user_id,
        instanceId: input.space_id,
      });
    } catch (e) {
      // 一条 warn 汇总失败，包含 task_id / err_name / dur —— Worker 侧再按分类
      // (transient / permanent) 决定 requeue 还是 DLQ。这里不吞异常。
      const dur = Date.now() - t0;
      obsLogger.warn("skill.extractor.extract", {
        task_id: input.task_id,
        dur_ms: dur,
        msg_count: messages.length,
        candidates: auditSink.length,
        err_name: (e as Error).name,
        err_msg: (e as Error).message,
      });
      try {
        trace.report("skill.extractor.extract", {
          task_id: input.task_id,
          team_id: input.team_id,
          agent_id: input.agent_id,
          session_id: input.session_id,
          msg_count: messages.length,
          candidates: auditSink.length,
          dur_ms: dur,
          success: false,
          error: (e as Error).message,
        });
      } catch { /* noop */ }
      throw e;
    }

    try { metricProducer.send({ metric: "skill.extract.candidates", instanceId: input.team_id, value: auditSink.length }); } catch { /* noop */ }

    const dur = Date.now() - t0;
    obsLogger.info("skill.extractor.extract", {
      task_id: input.task_id,
      dur_ms: dur,
      msg_count: messages.length,
      candidates: auditSink.length,
      prompt_chars: prompt.length,
      prefix_mode: prefixMode,
      // 只截前 60 字符 (够识别关键词; 长了对 obs 无用)。
      prefix_query: prefixQuery ? prefixQuery.slice(0, 60) : undefined,
    });
    try {
      trace.report("skill.extractor.extract", {
        task_id: input.task_id,
        team_id: input.team_id,
        agent_id: input.agent_id,
        session_id: input.session_id,
        msg_count: messages.length,
        candidates: auditSink.length,
        prompt_chars: prompt.length,
        dur_ms: dur,
        success: true,
      });
    } catch { /* noop */ }

    return { candidates: auditSink, text };
  }

  /**
   * "可能与本对话相关"的 skill 预检索: 让 runner 用一次轻量 LLM 调用从
   * transcript 里挤 2-5 个 BM25 关键词, 再走 core.search 拿 top-N (受
   * prefixSkillsLimit 限制)。成功且非空 → 返回 { block, query }; query 为空
   * / search 空命中 / runner 缺失都返回 null 让上游走 recent 降级。
   *
   * 拆两步(而不是直接把 relevant 检索合进 review agent 的迭代里)的原因:
   *   1. 让 review agent 一进场就有个具体的候选池, 而不是先摸黑扫一遍再检索;
   *   2. query-gen 是短输出 (≤100 tokens), 不占 review agent 上下文;
   *   3. 失败可精确降级; review agent 内跑 skill_list 只会退化到"全 owner",
   *      本函数则可选 relevant 或 recent。
   */
  private async buildRelevantSkillsBlock(
    input: ExtractInput,
    transcript: string,
  ): Promise<{ block: string; query: string } | null> {
    if (!this.runner) return null;

    const query = await this.generateSearchQueryFromTranscript(input, transcript);
    if (!query) return null;

    let hits: Awaited<ReturnType<typeof this.core.search>>;
    try {
      hits = await this.core.search({
        user_id: input.user_id,
        team_id: input.team_id,
        agent_id: input.agent_id,
        query,
        top_k: this.prefixSkillsLimit,
      });
    } catch (e) {
      this.logger?.warn(`${TAG} relevant search failed for query='${query}': ${(e as Error).message}`);
      return null;
    }
    if (!hits.length) return null;

    const lines = hits.map((h) => formatSkillLine(h.skill.name, h.skill.description));
    const block = [
      `## Skills possibly relevant to this conversation (query='${query}', BM25 prefetched)`,
      "These were retrieved by pre-running skill_list(query=...) against your own skill pool.",
      "If any of these already covers the topic, prefer `skill_update` / `skill_patch` over creating a duplicate.",
      ...lines,
    ].join("\n");
    return { block, query };
  }

  /**
   * 让 runner 用一次无工具的短 LLM 调用从 transcript 里抽 2-5 个 BM25 关键词。
   * 返回值经过 sanitize (换行 / FTS5 保留词打成空格, 空串视为失败)。runner
   * 抛异常一律往外扔, 上游 (buildRelevantSkillsBlock) 会 catch 并降级。
   */
  private async generateSearchQueryFromTranscript(
    input: ExtractInput,
    transcript: string,
  ): Promise<string> {
    if (!this.runner) return "";
    const raw = await this.runner.run({
      systemPrompt: QUERY_GEN_SYSTEM_PROMPT,
      prompt: [
        "Below is a past conversation. Extract 2-5 short keywords (Chinese or English) that",
        "capture what the user was trying to do. These will feed a BM25 search over an",
        "existing skill library. Output the keywords on a single line, space-separated,",
        "no punctuation, no labels, no explanation.",
        "",
        "<<transcript>>",
        transcript,
        "<<end-of-transcript>>",
      ].join("\n"),
      enableTools: false,
      // 让 runner 别真跑 tool loop, 就当一次普通 completion 用。
      maxIterations: 1,
      // 关键词很短; 32 token 足够 5 词 ×~6 字符 CJK, 也帮 runner 快速返回。
      maxTokens: 64,
      taskId: `skill-extract-query-${input.task_id ?? "unknown"}`,
      // Langfuse 上可按此 traceName 单独筛这类 query-gen call, 跟主 skill.extract 分开。
      traceName: "skill.extract.query-gen",
      tags: [
        "skill-extract",
        "skill-extract-query-gen",
        `team:${input.team_id}`,
        `agent:${input.agent_id}`,
      ],
      sessionId: input.session_id,
      userId: input.user_id,
      instanceId: input.space_id,
    });
    return sanitizeGeneratedQuery(raw);
  }
}

// ═════════════════════════════════════════════════════════════════════
//  helpers
// ═════════════════════════════════════════════════════════════════════

/**
 * 把 ExtractMessage[] 序列化成给 Skill Review Agent 看的 transcript。
 *
 * 关键设计（对齐 SKILL_REVIEW_PROMPT 的 "Role isolation" 段）：
 *   - role 前缀用非自然的 `<<past-xxx>>` 双尖括号 tag，而不是 `[user]` / `[assistant]`。
 *     后者是 chat completion 的原生 role signal，模型会本能把 transcript 尾部的
 *     `[assistant]` 当成"该我续写下一 turn"的锚点，直接接着写主 agent 的回复。
 *     `<<past-user>>` 这类非典型 tag 打破这个暗示，让模型明确知道"这些是我在
 *     review 的历史内容，不是我要扮演的角色"。
 *   - 末尾追加 `<<end-of-transcript>>` 锚点 + 一句"现在按 system prompt 里的
 *     output contract 决策"。没有这个锚点时，模型看到 transcript 直接结束在
 *     一段 assistant 长回复上，很容易走"再续写一段类似风格"的路径。
 *
 * 相关背景：docs/2026-07-28 skill extractor role-capture 分析（trace
 * f546ab8c-c7c5-4598-a310-6b2162372e7c，抽取 LLM 完全忽略 SKILL_REVIEW_PROMPT
 * 契约，产出 1235 tokens 的主对话续写，零 tool call、零 "Nothing to save."）。
 */
function formatTranscript(messages: ExtractMessage[]): string {
  const body = messages.map((m) => `<<past-${m.role}>>\n${m.content}`).join("\n\n");
  return `${body}\n\n<<end-of-transcript>>\nAbove is the past conversation to review. Now decide, and respond only per the output contract in the system prompt.`;
}

function truncateHeadTail(s: string, head: number, tail: number): string {
  if (s.length <= head + tail) return s;
  return `${s.slice(0, head)}\n\n... [truncated ${s.length - head - tail} chars] ...\n\n${s.slice(-tail)}`;
}

/**
 * "从对话里挤 2-5 个 BM25 关键词" 的 system prompt。
 * 关键点:
 *   1. 明确说这些关键词后面要塞进 BM25 → 让 LLM 挑高信号词, 别造完整句子;
 *   2. 中英都行, jieba 会正确切;
 *   3. 单行输出 + 无标点 + 无标签; 后置 sanitize 也会强制这个 shape。
 */
const QUERY_GEN_SYSTEM_PROMPT = [
  "You are helping build a BM25 keyword query.",
  "Given a past user↔assistant conversation, output 2-5 short high-signal keywords",
  "(Chinese or English mixed as they appear in the transcript) that best represent",
  "what the user was trying to accomplish.",
  "",
  "Rules:",
  "- Output ONLY the keywords, on a single line, separated by single spaces.",
  "- No punctuation, no quotes, no bullets, no labels, no explanation.",
  "- Do NOT invent topics not present in the transcript.",
  "- Prefer nouns / product names / verbs; drop filler words (the, a, 一下, 帮我).",
  "- If the transcript is empty or has no clear intent, output an empty line.",
].join("\n");

/**
 * 生成的 query 有效化:
 *   - 只取第一行 (LLM 有时会先说 "Here are the keywords:" 再一行)
 *   - 去 FTS5 保留词 (AND/OR/NOT/NEAR) 直接删掉 (BM25 层再走 buildFtsQuery 兜底)
 *   - 去掉常见标点 (标点会让 BM25 tokenizer 抖动)
 *   - 折叠空白, trim
 *   - 保守长度: 上限 120 字符 (5 词 × ~24 char)
 * 输出空串 = 认为 LLM 没抽到; 上游走 recent 降级。
 */
function sanitizeGeneratedQuery(raw: string): string {
  if (typeof raw !== "string") return "";
  // 只取首个非空行 —— LLM 偶尔会在关键词前后加一行元数据。
  const firstLine = raw.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  if (!firstLine) return "";
  // 剔常见标点 / FTS5 保留词。用空格替换而非删除, 避免 "foo,bar" 变成 "foobar"。
  const noPunct = firstLine
    .replace(/[,;:!?"'`()\[\]{}<>|/\\*+=~@#$%^&]/g, " ")
    .replace(/[，。；：！？、（）【】《》「」『』]/g, " ")
    .replace(/\b(AND|OR|NOT|NEAR)\b/gi, " ");
  const collapsed = noPunct.replace(/\s+/g, " ").trim();
  if (!collapsed) return "";
  return collapsed.length > 120 ? collapsed.slice(0, 120).trimEnd() : collapsed;
}

/**
 * 拼一行 "- name — 描述截断到 100 char"。空描述回退到 "- name"。
 * 抽 recent / relevant / full 三个块共用, 避免行格式漂移。
 */
function formatSkillLine(name: string, description?: string): string {
  const desc = (description ?? "").trim().replace(/\s+/g, " ");
  const short = desc.length > 100 ? `${desc.slice(0, 100)}…` : desc;
  return short ? `- ${name} — ${short}` : `- ${name}`;
}

/**
 * "全量" 前缀块 —— 该 agent 的 skill 总数 ≤ prefixSkillsLimit, 直接铺开。
 * 语义上告诉 LLM "这就是你所有的 skill, 无遗漏", 相比 recent 段更强的先验。
 * 复用时无 truncated 提示 (因为没截断)。
 */
function renderFullSkillsBlock(items: Array<{ name: string; description?: string }>): string {
  const lines = items.map((s) => formatSkillLine(s.name, s.description));
  return [
    `## Skills you (this agent) own (${items.length} total — full list, no truncation)`,
    "This is your entire skill inventory. Consider `skill_update` / `skill_patch` on an existing skill before creating a new one.",
    ...lines,
  ].join("\n");
}

/**
 * "最近更新" 前缀块 —— relevant 分支失败时的兜底。附带 "还有 X 条未显示"
 * 提示, 让 LLM 知道可以主动 skill_list(query=...) 拉更多。
 */
function renderRecentSkillsBlock(
  items: Array<{ name: string; description?: string }>,
  total: number,
): string {
  const lines = items.map((s) => formatSkillLine(s.name, s.description));
  const omitted = total - items.length;
  const header = `## Skills you (this agent) own (${items.length} most-recently-updated of ${total} total, prefetched via skill_list)`;
  const hint = omitted > 0
    ? `Most recent first. ${omitted} more not shown — call skill_list(query=...) to search the rest. Consider \`skill_update\` / \`skill_patch\` on an existing skill before creating a new one.`
    : "Most recent first. Consider `skill_update` / `skill_patch` on an existing skill before creating a new one.";
  return [header, hint, ...lines].join("\n");
}

// ═════════════════════════════════════════════════════════════════════
//  ISkillExtractor adapter — 让 SkillConversationExtractWorker (agent 队列)
//  可以驱动 V2 extractor。Worker 持有的 ISkillExtractor 接口接受
//  conversation: ConversationMessage[] + agent_id；这里把它映射成 V2 的
//  ExtractMessage[] 形态。
// ═════════════════════════════════════════════════════════════════════

const ALLOWED_ROLES = new Set(["user", "assistant", "tool_call", "tool_result"]);

function toExtractMessages(conv: ConversationMessage[]): ExtractMessage[] {
  return conv.map((m) => ({
    role: (ALLOWED_ROLES.has(m.role) ? m.role : "user") as ExtractMessage["role"],
    content: m.content,
  }));
}

function toLegacyCandidates(items: ExtractedSkillCandidate[]): ExtractedCandidate[] {
  return items.map((c) => ({
    action: c.action as ExtractedCandidate["action"],
    name: c.name,
    skill_id: c.skill_id,
    version: c.version,
    description: c.description,
    confidence: c.confidence,
    reason: c.reason,
    file_path: c.file_path,
    file_type: c.file_type,
  }));
}

/**
 * 把 SkillExtractor 包装成 ISkillExtractor，方便 SkillConversationExtractWorker
 * (agent 队列) 直接驱动。
 *
 * 入参 input.agent_id 必须由调用方（trigger.archive 时）提供，来源是
 * SkillTaskEntry.agent_id。缺失时返回空候选并放一条 warn 日志——抽取依赖 owner
 * 校验，没有 agent_id 无法落库。
 */
export function createExtractorAdapter(
  v2: SkillExtractor,
  logger?: { warn(msg: string): void },
): ISkillExtractor {
  return {
    async extract(input) {
      const agentId = (input as { agent_id?: string }).agent_id;
      if (!agentId) {
        logger?.warn(
          `${TAG} V2 adapter: input.agent_id missing — skipping extract (returns empty candidates)`,
        );
        return { candidates: [] };
      }
      const r = await v2.extract({
        user_id: input.user_id ?? "",
        team_id: input.team_id,
        agent_id: agentId,
        task_id: input.task_id ?? input.taskId,
        // Langfuse trace 绑定字段：Worker 从 SkillTaskEntry 读到后透传到这里，
        // 缺失会让 trace sessionId=null / instanceId=unknown（按 session 筛不到）。
        session_id: input.session_id,
        space_id: input.space_id,
        messages: toExtractMessages(input.conversation),
        reason: (input as { reason?: string }).reason,
        options: (input as { options?: { max_iterations?: number } }).options,
      });
      return { candidates: toLegacyCandidates(r.candidates) };
    },
  };
}
