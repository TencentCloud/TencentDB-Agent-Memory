/**
 * TdaiIntentToolsInjector — 按对话内容动态裁剪记忆检索教学模板。
 *
 * 与旧静态模板（TdaiMemoryToolsInjector，整段 <tdai_memory_tools> 约 15k token）不同：
 * 本注入器根据本轮用户 query 的意图，只注入与本轮相关的单条 recipe
 * （正确路径 + 必带 header + body + use），命中才注入、未命中零开销。
 *
 * 与 TdaiL1RecallInjector 并存（recallL1=true 时同时注册）：
 *  - 自动召回负责「直接给结果」——日常命中的 L1 记忆自动注入 user.before；
 *  - 本注入器负责「给方法」——用户明确要搜索、或需要查 L0 原文 / L2 场景时，
 *    模型拿到正确路径主动调用，不再像之前那样猜错 URL（如 /memory/...、/skill-bridge/...）。
 *
 * 意图识别（阶段三，hybrid）：
 *  1) 快路径：保守关键词规则，命中立即注入（零额外调用）；
 *  2) 语义路径：关键词未命中但 query 含弱记忆信号时，调用上游 LLM 分类器
 *     （复用 chat 端点，temperature=0，只输出 recipe 数组），语义理解新说法；
 *  3) 兜底：LLM 调用失败 / 返回空时回退到关键词结果（为空则不注入）。
 */

import type { AgentContext, CacheStrategy, ContextBlock, HookPriority, InjectionHook } from "../types.js";
import { getLogLevel } from "../../report/log.js";
import { createHash } from "node:crypto";
import { HOOK_PRIORITY } from "../types.js";
import { getLastUserMessage, getMessageText } from "../context.js";
import { extractUserQueryText } from "../../tdai/recorder.js";
import { getTdaiIdentity } from "../../tdai/identity.js";
import { detectPlatform, detectShellTool } from "../shell-template.js";
import { resolveInjectionTuning } from "../tuning.js";
import type { InjectionTuningConfig } from "../../types.js";

export interface TdaiIntentToolsInjectorConfig {
  /** Base URL the LLM should curl. E.g. http://127.0.0.1:8096 */
  proxyBaseUrl: string;
  /** 阶段三语义分类器（复用上游 chat 端点）；不传则退化为纯关键词模式。 */
  classifier?: {
    mode: "keyword" | "llm" | "hybrid";
    baseUrl: string;
    apiKey: string;
    model: string;
    maxTokens: number;
    timeoutMs: number;
  };
  /** 意图向量检索（Qwen3-Embedding 等 OpenAI 兼容 embedding 端点）。 */
  embedding?: {
    baseUrl: string;
    apiKey: string;
    model: string;
    dimensions: number;
    minScore: number;
    timeoutMs: number;
  };
  /** 注入微调（A/B）：memoryToolsGuide=on-intent 时，命中意图补 2 行"必须查"规则。 */
  tuning?: InjectionTuningConfig;
}

export type TdaiMemoryRecipeId =
  | "tdai_memory_search"
  | "tdai_atomic_query"
  | "tdai_conversation_search"
  | "tdai_conversation_query"
  | "tdai_scenario_ls"
  | "tdai_read_scene";

interface IntentRule {
  name: string;
  keywords: string[];
  recipes: TdaiMemoryRecipeId[];
}

/** 保守意图规则：命中关键词才注入对应 recipe。 */
const INTENT_RULES: IntentRule[] = [
  {
    name: "显式搜索记忆",
    keywords: [
      "搜索记忆", "记忆搜索", "查记忆", "搜记忆", "检索记忆", "记忆检索", "查一下记忆", "搜索一下记忆",
      "都记得什么", "记得什么", "回忆一下", "回忆起", "查历史", "查记录",
      "搜索用户", "搜索身份", "查一下记忆库", "记忆里有什么", "记忆中有",
      "查看记忆", "查看一下记忆", "查看你的记忆", "查看一下你的记忆", "查看我的记忆", "查看一下我的记忆",
      "看看记忆", "看看你的记忆", "看看我的记忆", "我的记忆", "你的记忆", "记忆库",
      "用记忆", "记忆功能", "帮我搜记忆", "帮我查记忆", "有哪些信息",
    ],
    recipes: ["tdai_memory_search", "tdai_conversation_search"],
  },
  {
    name: "L0 对话历史",
    keywords: [
      "之前说", "上次说", "聊过", "说过什么", "我们聊", "之前那个", "上次那个",
      "之前我们", "历史对话", "之前谈", "上次谈", "之前讨论", "还记不记得", "之前提",
      "之前讲过", "上次讲过",
    ],
    recipes: ["tdai_conversation_search"],
  },
  {
    name: "L1 原子记忆",
    keywords: [
      "我叫什么", "我的名字", "我是谁", "我的身份", "我的偏好", "我喜欢", "我不喜欢",
      "我的习惯", "我的团队", "我的任务", "我常用", "我的信息",
    ],
    recipes: ["tdai_memory_search"],
  },
  {
    name: "L2 场景",
    keywords: ["场景索引", "场景文件", "查场景", "scene_blocks"],
    recipes: ["tdai_scenario_ls", "tdai_read_scene"],
  },
];

/** 弱记忆信号：只决定"是否值得调一次 LLM 分类器"，不直接决定注入什么。 */
const WEAK_SIGNALS = [
  "记忆", "记得", "忆", "历史", "之前", "上次", "聊过", "说过",
  "搜索", "检索", "回忆", "信息", "记录", "记住",
];

/**
 * 剥离本轮已注入到 user 消息里的 XML 块（自动召回 / 工具模板 / 会话上下文），
 * 只保留用户原始文本，避免把注入内容当成意图 query（曾导致纯编码任务
 * 被误判为记忆意图 → 误注入记忆 recipe，见 [intent-vec] query="<tdai_recalled...>"）。
 */
export function stripInjectedBlocks(text: string): string {
  return text
    .replace(/<tdai_recalled_l1_memories>[\s\S]*?<\/tdai_recalled_l1_memories>/g, "")
    .replace(/<tdai_memory_tools>[\s\S]*?<\/tdai_memory_tools>/g, "")
    .replace(/<session_context>[\s\S]*?<\/session_context>/g, "")
    .replace(/<tdai_profile_memory>[\s\S]*?<\/tdai_profile_memory>/g, "")
    .trim();
}

/** 分类器看到的 recipe 目录（id + 一句话用途）。 */
const RECIPE_CATALOG: Array<{ id: TdaiMemoryRecipeId; desc: string }> = [
  { id: "tdai_memory_search", desc: "搜索 L1 原子记忆（用户偏好、历史结论、规则、身份信息）" },
  { id: "tdai_atomic_query", desc: "按类型/分页拉取 L1 记忆列表（不做语义检索）" },
  { id: "tdai_conversation_search", desc: "在 L0 原始对话中检索具体消息（找原文/引用/时间线）" },
  { id: "tdai_conversation_query", desc: "按 session 顺序取 L0 历史消息" },
  { id: "tdai_scenario_ls", desc: "列出 L2 场景路径索引" },
  { id: "tdai_read_scene", desc: "按 path 读取 L2 场景文件全文" },
];

function hasWeakMemorySignal(query: string): boolean {
  return WEAK_SIGNALS.some((s) => query.includes(s));
}

/** 从 LLM 输出中解析 recipe 数组（容忍多余文字，只取第一个 JSON 数组）。 */
function parseRecipeArray(content: string): TdaiMemoryRecipeId[] {
  const m = content.match(/\[[\s\S]*?\]/);
  if (!m) return [];
  try {
    const arr = JSON.parse(m[0]) as unknown;
    if (!Array.isArray(arr)) return [];
    const valid = new Set<string>(RECIPE_CATALOG.map((r) => r.id));
    return arr.filter((x): x is TdaiMemoryRecipeId => typeof x === "string" && valid.has(x));
  } catch {
    return [];
  }
}

/** 按 query 命中意图，返回需注入的 recipe 列表（去重、保持规则顺序）。 */
export function selectRecipesForQuery(query: string): TdaiMemoryRecipeId[] {
  const q = query.toLowerCase();
  const selected: TdaiMemoryRecipeId[] = [];
  for (const rule of INTENT_RULES) {
    if (rule.keywords.some((k) => q.includes(k))) {
      for (const r of rule.recipes) {
        if (!selected.includes(r)) selected.push(r);
      }
    }
  }
  return selected;
}

/** 渲染被选中 recipe 的精简块（路径 + header + body + use）。 */
export function renderIntentMemoryToolsBlock(
  proxyBaseUrl: string,
  sessionId: string | undefined,
  spaceId: string | undefined,
  recipeIds: TdaiMemoryRecipeId[],
  agentSource?: string,
  includeGuideRules = false,
  tools?: Array<{ name?: unknown; function?: { name?: unknown } }>,
): string {
  const base = proxyBaseUrl.replace(/\/$/, "");
  const bridge = `${base}/memory-bridge/v3`;
  const sid = sessionId || "<session_id>";
  const serviceHeader = spaceId ? `x-tdai-service-id: ${spaceId}` : "x-tdai-service-id: default";

  const RECIPES: Record<TdaiMemoryRecipeId, string[]> = {
    tdai_memory_search: [
      `  <recipe name="tdai_memory_search">`,
      `    curl: ${bridge}/atomic/search`,
      `    headers: ${serviceHeader}; x-conversation-id: ${sid}; Content-Type: application/json`,
      `    body: {"query": "<检索文本>", "limit": 5}`,
      `    use: 搜索 L1 原子记忆（用户偏好、历史结论、规则等），默认跨 self + imported 记忆；命中项在 data.items[]`,
      `  </recipe>`,
    ],
    tdai_atomic_query: [
      `  <recipe name="tdai_atomic_query">`,
      `    curl: ${bridge}/atomic/query`,
      `    headers: ${serviceHeader}; x-conversation-id: ${sid}; Content-Type: application/json`,
      `    body: {"type": "?episodic|persona|instruction", "limit": 20, "offset": 0}`,
      `    use: 按类型 / 分页拉取 L1 记忆（不做语义检索）`,
      `  </recipe>`,
    ],
    tdai_conversation_search: [
      `  <recipe name="tdai_conversation_search">`,
      `    curl: ${bridge}/conversation/search`,
      `    headers: ${serviceHeader}; x-conversation-id: ${sid}; Content-Type: application/json`,
      `    body: {"query": "<检索文本>", "limit": 5}`,
      `    use: 在 L0 原始对话中检索（找具体消息原文 / 引用 / 时间线）；命中项在 data.messages[]`,
      `  </recipe>`,
    ],
    tdai_conversation_query: [
      `  <recipe name="tdai_conversation_query">`,
      `    curl: ${bridge}/conversation/query`,
      `    headers: ${serviceHeader}; x-conversation-id: ${sid}; Content-Type: application/json`,
      `    body: {"session_id": "<sid>", "limit": 50, "offset": 0}`,
      `    use: 按 session 顺序取 L0 历史消息`,
      `  </recipe>`,
    ],
    tdai_scenario_ls: [
      `  <recipe name="tdai_scenario_ls">`,
      `    curl: ${bridge}/scenario/ls`,
      `    headers: ${serviceHeader}; x-conversation-id: ${sid}; Content-Type: application/json`,
      `    body: {"path_prefix": "?可选前缀"}`,
      `    use: 列出 L2 scene_blocks 路径索引（含 summary）`,
      `  </recipe>`,
    ],
    tdai_read_scene: [
      `  <recipe name="tdai_read_scene">`,
      `    curl: ${bridge}/scenario/read`,
      `    headers: ${serviceHeader}; x-conversation-id: ${sid}; Content-Type: application/json`,
      `    body: {"path": "<scene path>", "agent_id": "?可选，读 imported 记忆时传"}`,
      `    use: 按 path 读取 L2 场景文件全文（path 先经 scenario_ls 或 <l2_scene_index> 获取）`,
      `  </recipe>`,
    ],
  };

  const lines: string[] = [
    "<tdai_memory_tools>",
    "本轮相关的记忆检索方法（proxy 自动注入身份鉴权，body 只传业务字段）：",
    "路径必须用 memory-bridge 前缀（改成 skill-bridge 会 404）。Windows 用 curl.exe，-d 的 JSON 用单引号包裹。",
    ...(includeGuideRules
      ? ["命中场景必须查再答：涉及历史/身份/要求回忆/答案依赖历史事实；查无结果明说“没找到”，不编造。"]
      : []),
    ...recipeIds.flatMap((id) => RECIPES[id]),
    buildToolHint(agentSource, tools),
    "</tdai_memory_tools>",
  ];
  return lines.join("\n");
}

/**
 * 按客户端 + 平台自动选择 shell 工具名（系统替模型决定，模型零判断）：
 *  - claude-code（Windows）：工具名 PowerShell（实测该客户端未注册 Bash/LS）；
 *  - codex / workbuddy / codebuddy / dsh / 其它：工具名 Bash（实测 Bash 可执行 curl.exe）。
 */
function buildToolHint(
  agentSource?: string,
  tools?: Array<{ name?: unknown; function?: { name?: unknown } }>,
): string {
  const registered = detectShellTool(tools);
  const toolName =
    registered ??
    (agentSource === "claude-code" && detectPlatform().preferred === "powershell"
      ? "PowerShell"
      : "Bash");
  if (toolName === "PowerShell") {
    return (
      `这些 recipe 不是原生工具：调用客户端注册的 PowerShell 工具执行（不要用 Bash——本客户端未注册）；` +
      `命令必须以 curl.exe 开头（不要写 curl——PowerShell 里 curl 是 Invoke-WebRequest 别名，` +
      `会报 Cannot bind parameter 'Headers'）。`
    );
  }
  return (
    `这些 recipe 不是原生工具：调用客户端注册的 ${toolName} 工具执行 curl 真正拿到结果；` +
    `客户端确实没有 ${toolName} 时，基于已注入记忆直接回答。`
  );
}

export class TdaiIntentToolsInjector implements InjectionHook {
  id = "tdai-intent-tools-injector";
  point = "user.before" as const;
  priority: HookPriority = HOOK_PRIORITY.MEMORY + 1;
  description = "Inject only the memory-bridge recipe(s) relevant to the current turn (dynamic trimming)";
  /** 每轮内容随 query 变化，不参与 session 前缀缓存。 */
  cacheStrategy: CacheStrategy = "none";

  constructor(private cfg: TdaiIntentToolsInjectorConfig) {}

  async execute(ctx: AgentContext): Promise<ContextBlock[]> {
    const identity = getTdaiIdentity(ctx.metadata.custom);
    if (!identity) return [];
    const lastUser = getLastUserMessage(ctx);
    if (!lastUser) return [];
    const query = extractUserQueryText(stripInjectedBlocks(getMessageText(lastUser))).trim().slice(0, 2048);
    if (!query) return [];

    const session = (ctx.metadata.custom as Record<string, unknown> | undefined)?.session as
      | Record<string, unknown>
      | undefined;
    const spaceId = typeof session?.space_id === "string" ? session.space_id : undefined;
    const agentSource = ctx.metadata.agentSource;

    // 快路径：关键词命中 → 直接注入（零额外调用）。
    const kwRecipes = selectRecipesForQuery(query);
    if (kwRecipes.length > 0) {
      if (getLogLevel() === "debug") console.log(`[intent-kw] query="${query.slice(0, 60)}" recipes=${JSON.stringify(kwRecipes)}`);
    }

    // 语义路径：关键词未命中且 query 有弱记忆信号。
    if (kwRecipes.length === 0 && hasWeakMemorySignal(query)) {
      // ① 向量检索（教学模板 RAG）：调用成功则直接采用其结果（空也信任，避免误注入）。
      const vec = await this.classifyWithEmbedding(query);
      if (vec.ok) {
        if (vec.recipes.length > 0) {
          return this.renderBlocks(identity.sessionId, spaceId, vec.recipes, agentSource);
        }
        return [];
      }
      // ② 向量不可用 / 调用失败 → LLM 分类兜底。
      const classifier = this.cfg.classifier;
      if (classifier && classifier.mode !== "keyword") {
        const llmRecipes = await this.classifyWithLlm(query);
        if (llmRecipes.length > 0) {
          return this.renderBlocks(identity.sessionId, spaceId, llmRecipes, agentSource, ctx.tools);
        }
      }
      return [];
    }

    if (kwRecipes.length === 0) return [];
    return this.renderBlocks(identity.sessionId, spaceId, kwRecipes, agentSource, ctx.tools);
  }

  private renderBlocks(
    sessionId: string,
    spaceId: string | undefined,
    recipeIds: TdaiMemoryRecipeId[],
    agentSource?: string,
    tools?: Array<{ name?: unknown; function?: { name?: unknown } }>,
  ): ContextBlock[] {
    const t = resolveInjectionTuning(this.cfg.tuning, agentSource);
    const includeGuideRules = t.memoryToolsGuide === "on-intent";
    const content = renderIntentMemoryToolsBlock(
      this.cfg.proxyBaseUrl,
      sessionId,
      spaceId,
      recipeIds,
      agentSource,
      includeGuideRules,
      tools,
    );
    return [
      {
        type: "text",
        content,
        metadata: {
          source: this.id,
          sessionId,
          cacheKey: `tdai-intent-tools:${recipeIds.join("+")}`,
        },
      },
    ];
  }

  private async classifyWithLlm(query: string): Promise<TdaiMemoryRecipeId[]> {
    const c = this.cfg.classifier;
    if (!c) return [];
    const base = c.baseUrl.replace(/\/$/, "");
    const catalogText = RECIPE_CATALOG.map((r) => `- ${r.id}: ${r.desc}`).join("\n");
    const sys =
      "你是记忆检索意图分类器。根据用户最近一句话，判断是否需要调用记忆检索接口，以及调用哪些。可选接口：\n" +
      catalogText +
      "\n规则：只要用户提到「你记得什么/你的记忆/记住的/之前聊过/我的信息/历史/回忆」等回忆性质内容，就选 tdai_memory_search（必要时加 tdai_conversation_search）；需要找对话原文时加 tdai_conversation_search；普通问候、闲聊、技术答疑输出 []。\n" +
      '只输出一个 JSON 数组（如 ["tdai_memory_search"]），元素只能从可选接口名中选，不要输出任何其它文字。';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), c.timeoutMs);
    try {
      const res = await fetch(`${base}/chat/completions`, {
        method: "POST",
        signal: controller.signal,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${c.apiKey}` },
        body: JSON.stringify({
          model: c.model,
          max_tokens: c.maxTokens,
          temperature: 0,
          messages: [
            { role: "system", content: sys },
            { role: "user", content: query.slice(0, 500) },
          ],
        }),
      });
      if (!res.ok) return [];
      const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
      const content = data.choices?.[0]?.message?.content ?? "";
      const recipes = parseRecipeArray(content);
      console.log(
        `[intent-llm] query="${query.slice(0, 80)}" raw="${content.slice(0, 120)}" recipes=${JSON.stringify(recipes)}`,
      );
      return recipes;
    } catch {
      return [];
    } finally {
      clearTimeout(timer);
    }
  }

  /** recipe 目录的向量缓存（懒加载，一次初始化后复用）。 */
  private recipeVectorsPromise: Promise<Map<TdaiMemoryRecipeId, number[]>> | null = null;

  private getRecipeVectors(): Promise<Map<TdaiMemoryRecipeId, number[]>> {
    if (!this.recipeVectorsPromise) {
      this.recipeVectorsPromise = this.embedTexts(RECIPE_CATALOG.map((r) => r.desc)).then((vecs) => {
        const map = new Map<TdaiMemoryRecipeId, number[]>();
        RECIPE_CATALOG.forEach((r, i) => map.set(r.id, vecs[i] ?? []));
        return map;
      });
    }
    return this.recipeVectorsPromise;
  }

  private async embedTexts(texts: string[]): Promise<number[][]> {
    const e = this.cfg.embedding;
    if (!e || !e.baseUrl || !e.apiKey || texts.length === 0) throw new Error("embedding not configured");
    const base = e.baseUrl.replace(/\/$/, "");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), e.timeoutMs);
    try {
      const res = await fetch(`${base}/embeddings`, {
        method: "POST",
        signal: controller.signal,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${e.apiKey}` },
        body: JSON.stringify({ model: e.model, input: texts, dimensions: e.dimensions }),
      });
      if (!res.ok) throw new Error(`embedding http ${res.status}`);
      const data = (await res.json()) as { data?: Array<{ embedding?: number[] }> };
      return (data.data ?? []).map((d) => d.embedding ?? []);
    } finally {
      clearTimeout(timer);
    }
  }

  /** 查询向量缓存：同一句用户消息重复出现时不再调 embedding。 */
  private queryVecCache = new Map<string, number[]>();
  private static QUERY_VEC_CACHE_MAX = 512;

  private async embedQueryVector(query: string): Promise<number[]> {
    const trimmed = query.trim();
    // 短查询对向量意图是噪声，关键词路径已覆盖，直接跳过省一次调用
    if (trimmed.length < 4) return [];
    const key = createHash("sha256").update(trimmed).digest("hex").slice(0, 24);
    const hit = this.queryVecCache.get(key);
    if (hit) return hit;
    const vecs = await this.embedTexts([trimmed]);
    const vec = vecs[0] ?? [];
    if (this.queryVecCache.size >= TdaiIntentToolsInjector.QUERY_VEC_CACHE_MAX) {
      this.queryVecCache.clear();
    }
    this.queryVecCache.set(key, vec);
    return vec;
  }

  /** 向量语义选择：返回 { ok, recipes }，ok=false 表示调用失败（上层走 LLM 兜底）。 */
  private async classifyWithEmbedding(query: string): Promise<{ ok: boolean; recipes: TdaiMemoryRecipeId[] }> {
    const e = this.cfg.embedding;
    if (!e || !e.baseUrl || !e.apiKey) return { ok: false, recipes: [] };
    try {
      const [recipeVectors, qv] = await Promise.all([this.getRecipeVectors(), this.embedQueryVector(query)]);
      if (!qv || qv.length === 0) return { ok: false, recipes: [] };
      const scored: Array<{ id: TdaiMemoryRecipeId; score: number }> = [];
      for (const [id, vec] of recipeVectors) {
        if (!vec || vec.length === 0) continue;
        scored.push({ id, score: cosineSimilarity(qv, vec) });
      }
      scored.sort((a, b) => b.score - a.score);
      const selected = scored
        .filter((s) => s.score >= e.minScore)
        .slice(0, 2)
        .map((s) => s.id);
      console.log(
        `[intent-vec] query="${query.slice(0, 60)}" scores=${scored
          .map((s) => `${s.id}=${s.score.toFixed(3)}`)
          .join(" ")} recipes=${JSON.stringify(selected)}`,
      );
      return { ok: true, recipes: selected };
    } catch {
      return { ok: false, recipes: [] };
    }
  }
}

/** 余弦相似度。 */
function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
