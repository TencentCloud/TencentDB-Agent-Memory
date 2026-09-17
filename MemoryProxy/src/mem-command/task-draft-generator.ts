/**
 * task-draft-generator · mem:create-task / mem:update-task 的 LLM 草稿生成器。
 *
 * proxy 首个"主动"向 LLM 发起请求的模块（其它 LLM 调用都是 passthrough 反向代理）。
 * 骨架仿 packages/cost-guard/src/compressor/cfq/llm-infer.ts —— 直接 fetch OpenAI
 * chat/completions + AbortSignal.timeout，不引第三方 SDK。
 *
 * 与 CFQ LLMInfer 的关键差异：
 * - CFQ 失败 = 返回 null 数组（silent fallback），因为 CFQ 是可选增强；
 * - 本模块失败 = 返回 { ok: false, error }（**显式错误**），因为 Task 是持久化实体，
 *   坏草稿会污染库；上层 command 会把 error 拼进"❌ Task 生成失败：..."文案。
 *
 * 使用方：mem-command/commands/create-task.ts / update-task.ts（阶段 3.2 / 3.3）
 *
 * 参考：docs/design/... TODO(阶段5) 补设计文档
 */

/** LLM 端点配置。字段与 LLMInferConfig 保持形状一致，便于将来抽公共。 */
export interface TaskDraftConfig {
  /** 总开关。默认 false —— 未启用时命令层直接返"未配置"错误。 */
  enabled: boolean;
  /** 模型名，如 "deepseek-v3-0324"。 */
  model: string;
  /**
   * API 端点 base（不含具体 endpoint）。按 protocol 拼接：
   *   openai:    `${url}/chat/completions`
   *   anthropic: `${url}/v1/messages`
   *   responses: `${url}/responses`
   */
  url: string;
  /** API Key。openai/responses 用 Bearer，anthropic 用 x-api-key。 */
  apiKey: string;
  /** 单次调用超时（毫秒）。建议 15000-30000（草稿要写完整）。 */
  timeoutMs: number;
  /**
   * 上游 API 家族。默认 "openai"（chat/completions）。
   * 决定 attemptDraftOnce 里请求 URL / headers / body / 响应解析的形状。
   */
  protocol?: "openai" | "anthropic" | "responses";
}

/** 最近对话消息片段（供 LLM 理解上下文）。 */
export interface DraftMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

/** 现有 Task（update 模式必填）。 */
export interface CurrentTask {
  title: string;
  description: string;
  status: string;
}

/** 生成器输入。 */
export interface TaskDraftInput {
  /** create：新建一个 task；update：基于现有 task 判定变更 + 改写。 */
  mode: "create" | "update";
  /** 用户 mem:create-task/update-task 后的额外提示（reason），可空。 */
  hint?: string;
  /** 最近对话消息（proxy 从 sessionMessages 剪出来，通常近 30 条）。 */
  recentMessages: DraftMessage[];
  /** update 模式必填，其它模式忽略。 */
  currentTask?: CurrentTask;
  /**
   * 仅 create 模式生效。用户已在 mem:create-task 后写明 title，proxy 强制锁定：
   * LLM 只负责根据对话生成 description，返回的 title 字段会被忽略。
   * 上层调用方需自行把 lockedTitle 传下来（generator 不做 40 字截断，调用方保证）。
   */
  lockedTitle?: string;
}

/** 生成器输出：成功携带结构化草稿；失败带 error 文案。 */
export type TaskDraftResult =
  | {
      ok: true;
      title: string;
      description: string;
      /** 建议状态，允许模型给出（可选）。 */
      suggestedStatus?: string;
      /**
       * 仅 update 模式有效。false 表示"最近对话未产生新进展，Task 无需更新"—— 上层
       * 应直接返"Task 无需更新"给用户，不再进弹窗流程。create 模式恒为 true。
       */
      changed: boolean;
    }
  | { ok: false; error: string };

/**
 * Status 校验（放宽版）：
 *   按 TAPD 需求 & 用户决策，proxy 不做 status 枚举校验，LLM 出啥透传啥；
 *   仅做 trim + 空/非字符串过滤，最终由内核决定是否接受。
 */
const MAX_STATUS_LEN = 40;
/** 输出 schema 上限。 */
const MAX_TITLE_LEN = 40;
const MAX_DESC_LEN = 300;
/** 最近对话截断（防 prompt 过长）。 */
const MAX_RECENT_MSGS = 30;
const MAX_MSG_CONTENT_LEN = 800;
/**
 * LLM 单次生成的 token 上限。
 *
 * 从 800 提到 2000（2026-08-18 修复）：实际观察到 desc + title + status + JSON
 * 结构字符总量在中英混杂场景经常 >800 而被截断，导致 JSON 中途结束 parse 失败。
 * 参考：wiki-ingest 用 8192，L1 extractor 用 4096；本处 draft 输出限制在 title≤40
 * + desc≤300 + status，理论最大 ~800 字符 → tokens 上限给 2000 有充分余量。
 */
const LLM_MAX_TOKENS = 2000;

/**
 * LLM 调用重试策略（2026-08-18 加入）。
 *
 * 触发场景：LLM 偶发抖动（空对象 / 截断 / 超时），单次成功率不到 100%，
 * 但连续 2 次全部空对象/截断的概率很低。用户视角：无感，一次点击 = 一次成功。
 *
 * 参数：
 *   - LLM_RETRY_MAX_ATTEMPTS=3：总共 3 次机会（1 次首发 + 2 次重试）
 *   - LLM_RETRY_BASE_DELAY_MS=200：指数退避基数，第 2 次等 200ms，第 3 次等 400ms
 *
 * 什么时候重试：只要 attemptDraftOnce 返回 ok=false 就重试（不区分具体错误类型，
 * 因为空对象 / 截断 / schema 违规 / 上游 5xx 都是"再来一次可能就好了"的情况）。
 * 什么时候不重试：cfg.enabled=false / 参数校验不通过 / 3 次都失败。
 */
const LLM_RETRY_MAX_ATTEMPTS = 3;
const LLM_RETRY_BASE_DELAY_MS = 200;

/**
 * 首次尝试的超时上限（2026-08-20）：现网观察到 gateway 偶发挂 20-30s，
 * 首次就用 cfg.timeoutMs（默认 30s）会让用户干等。首次改成 min(cfg.timeoutMs,
 * FIRST_TIMEOUT_MS=10s)，超时后立刻退避 200ms + retry，retry 用完整 timeoutMs
 * 兜底"真的慢但会成功"的场景。env TDAI_TASK_DRAFT_FIRST_TIMEOUT_MS 可覆盖。
 */
const LLM_FIRST_ATTEMPT_TIMEOUT_MS_DEFAULT = 10_000;

function firstAttemptTimeoutMs(configuredTimeoutMs: number): number {
  const raw = process.env.TDAI_TASK_DRAFT_FIRST_TIMEOUT_MS;
  let cap = LLM_FIRST_ATTEMPT_TIMEOUT_MS_DEFAULT;
  if (raw !== undefined && raw !== "") {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) cap = n;
  }
  // 不能超过配置本身（不然改动无效）
  return Math.min(configuredTimeoutMs, cap);
}

/**
 * 智能拼接 taskDraft 请求 URL —— 处理 "base 尾巴可能已经带了 endpoint 前缀段" 的坑。
 *
 * ## 背景（2026-09-01 修复 Claude Code 404）
 *
 * 主链路（guard-adapter.joinUrl）的约定：`upstream.agents[x].url` 里的 `/v1`、`/v2`
 * 尾巴是 base 的一部分，endpoint 只写路径尾段（如 anthropic 用 `/messages`）。
 * 例如配置里：
 *   claude-code.url = "https://copilot.tencent.com/v1"   （base 自带 /v1 尾巴）
 *   codebuddy.url   = "https://copilot.tencent.com/v2"   （base 自带 /v2 尾巴）
 *   codex.url       = "https://copilot.tencent.com"      （base 是根，不带前缀）
 *
 * 但 taskDraft 生成器为了自包含，写的 endpoint 是"完整路径"：
 *   anthropic  → "/v1/messages"
 *   openai     → "/chat/completions"（本来就没歧义）
 *   responses  → "/responses"
 *
 * 直接 `${base}${endpoint}` 会踩：
 *   base=".../v1" + endpoint="/v1/messages" → ".../v1/v1/messages" ❌ 404
 *
 * ## 拼接规则
 *
 * 1. base 已经完整以 endpoint 结尾 → 原样返回（幂等，处理 base 直接是完整 URL 的场景）
 * 2. base 已经以 endpoint **的开头段**结尾（如 base=`.../v1`，endpoint=`/v1/messages`）
 *    → 去掉 base 已有的那段前缀，只拼剩下的（`.../v1/messages`）
 * 3. base 与 endpoint 无重合 → 直接拼（`.../responses`）
 *
 * 参考主链路 joinUrl 的处理（guard-adapter.ts:326）。
 */
export function joinTaskDraftUrl(base: string, endpoint: string): string {
  const normalized = base.replace(/\/+$/, "");
  // 规则 1：完全相等
  if (normalized.endsWith(endpoint)) return normalized;
  // 规则 2：endpoint 可分段（如 "/v1/messages" → ["v1", "messages"]），从长到短
  // 检查 base 是否已经带了 endpoint 的开头段。命中即剥离。
  const segs = endpoint.split("/").filter(Boolean);
  for (let i = segs.length - 1; i > 0; i--) {
    const prefix = "/" + segs.slice(0, i).join("/");
    if (normalized.endsWith(prefix)) {
      return normalized + "/" + segs.slice(i).join("/");
    }
  }
  // 规则 3：无重合，直接拼
  return normalized + endpoint;
}

/**
 * 指令关键词剥离表：LLM 有时会把用户输入的原始指令字面搬进 title（如
 * "Fix mem:create-task LLM ..."），这些前缀既冗余又占字符预算。
 * 匹配到就截掉，让真正的语义部分能落到 40 字以内。
 */
const COMMAND_KEYWORD_PATTERNS = [
  /^\s*(?:mem:[a-z-]+)\s*[:：、,，]?\s*/i,
  /^\s*(?:fix|refactor|update|create|add|remove)\s+mem:[a-z-]+\s*[:：、,，]?\s*/i,
];

/**
 * create 模式 system prompt。
 *
 * 2026-08-18 强化（针对生产失败根因）：
 *   - 用 STRICT / MUST NOT / NEVER 等硬约束词，代替之前的 ≤ 40（LLM 会越界）
 *   - 加正确示例 + 反例，让 LLM 明确"什么是超长"、"什么是空对象"
 *   - 明确禁止空对象：如果信息不够也要给合理默认，避免 `{}`
 */
const SYSTEM_PROMPT_CREATE = `You are a task drafting assistant for a coding agent's memory system.

Given the recent conversation, generate ONE task that captures what the user is currently working on.

STRICT rules (violations will be rejected):
- title: MUST be 1 to 40 characters. NEVER exceed 40. Imperative form preferred.
- description: MUST be 1 to 300 characters, plain text. Cover three parts in order:
    背景 (background) → 目标 (goal) → 已知约束 (known constraints)
- suggestedStatus: short lowercase word (e.g. "running", "completed").
- NEVER return an empty object {}. If the conversation is unclear, infer a reasonable
  task from the most recent user message and produce a best-effort title + description.

Examples of GOOD output:
  {"title":"Refactor auth module","description":"背景：现有 auth 逻辑分散在 3 个文件。目标：合并到 auth-service。约束：不改动对外 API。","suggestedStatus":"running"}

Examples of BAD output (DO NOT produce these):
  {}                                                     // ❌ empty object
  {"title":"Fix mem:create-task LLM JSON parse failure and add retry logic here"}  // ❌ title too long
  {"title":"Refactor","description":""}                  // ❌ empty description

Return ONLY the JSON object with keys: title, description, suggestedStatus. No prose, no markdown fence.`;

/** create 模式（title 已锁定）system prompt —— 只让 LLM 出 description。 */
const SYSTEM_PROMPT_CREATE_LOCKED_TITLE = `You are a task drafting assistant for a coding agent's memory system.

The user has ALREADY specified the task title. Your ONLY job is to write a good description
based on the recent conversation that matches this title.

STRICT rules:
- description: MUST be 1 to 300 characters, plain text. Cover three parts:
    背景 → 目标 → 已知约束
- NEVER return an empty object {}. If unclear, infer a best-effort description from the title
  and most recent messages.
- Do NOT include title in the output (it is fixed by the user).

Return ONLY a JSON object with a single key: description. No prose, no markdown fence.`;

/** update 模式 system prompt。 */
const SYSTEM_PROMPT_UPDATE = `You are a task update assistant for a coding agent's memory system.

Given an existing task and recent conversation, decide:
1. Whether the conversation adds meaningful updates to the task.
2. If yes, produce an updated description and a suggested status.

Classify what changed into ONE OR MORE of these five categories (only if applicable):
  - 目标调整 (goal changes)
  - 约束 (constraint changes)
  - 进展 (progress)
  - 关联链接 (linked resources / references)
  - 参与 Agent (collaborating agents)

STRICT rules:
- If NO meaningful update → return {"changed": false}
- If YES → return {"changed": true, "title": ..., "description": ..., "suggestedStatus": ...}
- title: keep the original title unchanged (return it as-is); the caller ignores any change.
- description: MUST be 1 to 300 characters, rewrite/merge current description with categorized new info.
- suggestedStatus: short lowercase word; prefer "completed" if conversation signals done, else "running".
- NEVER return an empty object {}. If truly no update, return {"changed": false} explicitly.

Return ONLY a JSON object. No prose, no markdown fence.`;

/**
 * 构造发给 LLM 的 user message。
 */
function buildUserMessage(input: TaskDraftInput): string {
  const lines: string[] = [];

  if (input.mode === "update" && input.currentTask) {
    lines.push(
      "=== Current Task ===",
      `Title: ${input.currentTask.title}`,
      `Description: ${input.currentTask.description}`,
      `Status: ${input.currentTask.status}`,
      "",
    );
  }

  if (input.mode === "create" && input.lockedTitle) {
    lines.push(
      "=== Task Title (fixed by user, DO NOT change) ===",
      input.lockedTitle,
      "",
    );
  }

  if (input.hint && input.hint.trim().length > 0) {
    lines.push("=== User Hint ===", input.hint.trim(), "");
  }

  lines.push("=== Recent Conversation ===");
  const msgs = input.recentMessages.slice(-MAX_RECENT_MSGS);
  for (const m of msgs) {
    const content = m.content.length > MAX_MSG_CONTENT_LEN
      ? `${m.content.slice(0, MAX_MSG_CONTENT_LEN)}...[truncated]`
      : m.content;
    lines.push(`[${m.role}] ${content}`);
  }

  return lines.join("\n");
}

/**
 * 从 LLM 原始输出里提取 JSON 对象。
 *
 * 三级降级：
 *   1) 直接 JSON.parse —— 覆盖标准场景
 *   2) 剥离 markdown fence（```json ... ``` 或 ``` ... ```）后再 parse
 *   3) 括号平衡扫描：找到第一个 `{`，向后配对到匹配的 `}` 截取子串再 parse
 *      —— 覆盖 LLM 前后加了自然语言的场景，如：
 *      "好的，这是 JSON：{...}"、"Here you go:\n{...}\n希望有帮助"
 *
 * 扫描时会正确处理字符串字面量内的 `{` `}` `"`（不参与平衡计数）。
 *
 * 若三级都失败返回 null（调用方产出 "LLM output is not valid JSON" 错误）。
 */
export function extractJsonObject(raw: string): unknown | null {
  // 1) 直接 parse
  try {
    return JSON.parse(raw);
  } catch {
    // fall-through
  }

  // 2) 剥离 markdown fence
  const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenceMatch && fenceMatch[1]) {
    try {
      return JSON.parse(fenceMatch[1]);
    } catch {
      // fall-through
    }
  }

  // 3) 括号平衡扫描
  const balanced = findBalancedJsonObject(raw);
  if (balanced !== null) {
    try {
      return JSON.parse(balanced);
    } catch {
      // fall-through
    }
  }

  return null;
}

/**
 * 括号平衡扫描：从 raw 里找第一个能自洽闭合的 `{...}` 子串。
 * 状态机处理字符串字面量与转义，防止字符串里的 `{}` 干扰计数。
 */
function findBalancedJsonObject(raw: string): string | null {
  const start = raw.indexOf("{");
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < raw.length; i++) {
    const c = raw[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (c === "\\") {
        escaped = true;
      } else if (c === '"') {
        inString = false;
      }
      continue;
    }

    if (c === '"') {
      inString = true;
      continue;
    }
    if (c === "{") {
      depth++;
    } else if (c === "}") {
      depth--;
      if (depth === 0) {
        return raw.slice(start, i + 1);
      }
    }
  }
  return null;
}

/**
 * 归一化字符串字段：trim + 长度校验。
 *
 * mode:
 *   - "strict"（默认）：超长返 null（老行为，用于必须严格的场景）
 *   - "clip"：超长自动截到 maxLen（保留有效内容，用于 title/description
 *     这类"哪怕不完美也比失败强"的字段）
 *
 * 空字符串一律返 null（没有任何截断能救空串）。
 */
function normalizeStr(
  v: unknown,
  maxLen: number,
  mode: "strict" | "clip" = "strict",
): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (s.length === 0) return null;
  if (s.length > maxLen) {
    return mode === "clip" ? s.slice(0, maxLen).trim() : null;
  }
  return s;
}

/**
 * 从 title 里剥离 mem:xxx 之类的指令关键词前缀。
 * LLM 常把用户当前指令写进 title（如 "Fix mem:create-task JSON parse"），
 * 剥离后能让真正的语义部分不超字数上限。
 * 只剥前缀、不剥中间；空匹配就原样返回。
 */
function stripCommandKeywords(s: string): string {
  let out = s;
  for (const pat of COMMAND_KEYWORD_PATTERNS) {
    out = out.replace(pat, "");
  }
  return out.trim();
}

/** 归一化 status 字段：可选，允许缺失；不做枚举校验，只做基本清洗。 */
function normalizeStatus(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  if (s.length === 0 || s.length > MAX_STATUS_LEN) return undefined;
  return s;
}

/**
 * 生成 Task 草稿（带自动 retry）。
 *
 * 外层职责：
 *   - 前置参数校验（不重试）
 *   - 循环调 attemptDraftOnce，最多 LLM_RETRY_MAX_ATTEMPTS 次
 *   - 每次失败记录日志（attempt=N/M reason=xxx），指数退避后再试
 *
 * @returns { ok:true, ... } 或 { ok:false, error }
 */
export async function generateTaskDraft(
  cfg: TaskDraftConfig,
  input: TaskDraftInput,
): Promise<TaskDraftResult> {
  if (!cfg.enabled) {
    return { ok: false, error: "task_draft LLM disabled (config.memCommand.taskDraft.enabled=false)" };
  }
  if (input.mode === "update" && !input.currentTask) {
    return { ok: false, error: "update mode requires currentTask" };
  }
  if (!input.recentMessages || input.recentMessages.length === 0) {
    return { ok: false, error: "no recent messages to draft from" };
  }

  // 入口观测：每次 generateTaskDraft 都记录目标 upstream/model/protocol，方便对齐 handler 传参
  console.log(
    `[task-draft] START mode=${input.mode} protocol=${cfg.protocol ?? "openai"} url=${cfg.url} model=${cfg.model} msgs=${input.recentMessages.length}${input.lockedTitle ? ` lockedTitle="${input.lockedTitle}"` : ""}`,
  );

  const systemPrompt =
    input.mode === "create"
      ? (input.lockedTitle ? SYSTEM_PROMPT_CREATE_LOCKED_TITLE : SYSTEM_PROMPT_CREATE)
      : SYSTEM_PROMPT_UPDATE;
  const userMessage = buildUserMessage(input);

  let lastError = "unknown";
  for (let attempt = 1; attempt <= LLM_RETRY_MAX_ATTEMPTS; attempt++) {
    const result = await attemptDraftOnce(cfg, input, systemPrompt, userMessage, attempt);
    if (result.ok) {
      // 成功日志（每次都打，方便看抖动率和实际 attempt 消耗）
      // attempt>1 时额外带 RETRY_SUCCEEDED 关键字，便于日志聚合看"抖动最终自愈"的次数。
      const titlePreview = "title" in result && result.title
        ? result.title.length > 40 ? `${result.title.slice(0, 40)}...` : result.title
        : "(no-title)";
      const retryTag = attempt > 1 ? " RETRY_SUCCEEDED" : "";
      console.log(
        `[task-draft] OK${retryTag} mode=${input.mode} attempt=${attempt}/${LLM_RETRY_MAX_ATTEMPTS} title="${titlePreview}"${attempt > 1 ? ` prev_error=${JSON.stringify(lastError)}` : ""}`,
      );
      return result;
    }
    lastError = result.error;
    // 最后一次失败，不再等待
    if (attempt < LLM_RETRY_MAX_ATTEMPTS) {
      const delay = LLM_RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
      console.log(
        `[task-draft] mode=${input.mode} RETRY attempt=${attempt}/${LLM_RETRY_MAX_ATTEMPTS} error=${JSON.stringify(result.error)} next_delay_ms=${delay}`,
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  console.log(
    `[task-draft] mode=${input.mode} ALL_ATTEMPTS_FAILED total=${LLM_RETRY_MAX_ATTEMPTS} last_error=${JSON.stringify(lastError)}`,
  );
  return { ok: false, error: `LLM draft failed after ${LLM_RETRY_MAX_ATTEMPTS} attempts: ${lastError}` };
}

/**
 * 单次 LLM 调用 + 结果解析。**内部函数，外层不要直接调**。
 *
 * 与老的 generateTaskDraft 主体逻辑一致，只是：
 *   - 参数校验移到了外层
 *   - 加了 finish_reason / usage / http_status 观测日志（第一次成功也打，方便看抖动率）
 *
 * attempt 参数只用于日志。
 */
async function attemptDraftOnce(
  cfg: TaskDraftConfig,
  input: TaskDraftInput,
  systemPrompt: string,
  userMessage: string,
  attempt: number,
): Promise<TaskDraftResult> {
  let resp: Response;
  // 首次用短 timeout（默认 10s），后续用完整 cfg.timeoutMs
  const effectiveTimeoutMs = attempt === 1 ? firstAttemptTimeoutMs(cfg.timeoutMs) : cfg.timeoutMs;
  const protocol = cfg.protocol ?? "openai";
  // 记录拼接后的完整 URL，用于观测日志（定位路径拼错，如 /v1/v1/messages）
  let fetchUrl = cfg.url;
  try {
    if (protocol === "anthropic") {
      // Anthropic Messages API：/v1/messages，system 走顶层字段，x-api-key + anthropic-version
      // 拼接用 joinTaskDraftUrl：base 可能已经带 /v1 尾巴（主链路约定），避免拼成 /v1/v1/messages
      // ⚠️ copilot 上游对 /v1/messages **强制返 SSE 流式**（非流式返 200 + event-stream body
      // 会让 JSON.parse 直接爆 "Unexpected token 'e', event: mes..."）。因此显式设 stream:true
      // 并走 parseAnthropicStream 累积 content_block_delta。与 openai 分支的策略一致。
      fetchUrl = joinTaskDraftUrl(cfg.url, "/v1/messages");
      resp = await fetch(fetchUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": cfg.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: cfg.model,
          system: systemPrompt,
          messages: [{ role: "user", content: userMessage }],
          temperature: 0.3,
          max_tokens: LLM_MAX_TOKENS,
          stream: true,
        }),
        signal: AbortSignal.timeout(effectiveTimeoutMs),
      });
    } else if (protocol === "responses") {
      // OpenAI Responses API：/responses，instructions 走顶层字段，input[] 结构化，
      // token 上限字段名是 max_output_tokens。Bearer auth。
      // 上游 codex base 是根（不带 /v1/v2 前缀），joinTaskDraftUrl 里规则 3 走"直接拼"分支。
      // ⚠️ copilot 上游对 /responses 同样**强制返 SSE 流式**（非流式请求会被 200 + event-stream
      // body 回给你，客户端按 JSON 直接爆 "Unexpected token 'e', event: res..."）。因此
      // 显式 stream:true，走 parseResponsesStream 累积 response.output_text.delta。
      // 与 anthropic/openai 分支的策略一致 —— copilot 三协议全强制流式。
      fetchUrl = joinTaskDraftUrl(cfg.url, "/responses");
      resp = await fetch(fetchUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${cfg.apiKey}`,
        },
        body: JSON.stringify({
          model: cfg.model,
          instructions: systemPrompt,
          input: [
            { type: "message", role: "user", content: [{ type: "input_text", text: userMessage }] },
          ],
          temperature: 0.3,
          max_output_tokens: LLM_MAX_TOKENS,
          stream: true,
        }),
        signal: AbortSignal.timeout(effectiveTimeoutMs),
      });
    } else {
      // OpenAI chat/completions（默认）。
      // ⚠️ copilot 上游强制要求 stream:true（非流式返 400 "Non-stream chat request
      // is currently not supported"）。因此去掉 response_format（流式下部分上游不认），
      // JSON 靠 prompt 约束 + 三级 extractJsonObject 兜底。stream_options.include_usage
      // 让上游末尾额外回一个 usage chunk 用于观测。
      // base 通常自带 /v2 尾巴（主链路约定），joinTaskDraftUrl 里规则 3 走"直接拼"分支
      // 得到 .../v2/chat/completions（endpoint 与 base 无重合）。
      fetchUrl = joinTaskDraftUrl(cfg.url, "/chat/completions");
      resp = await fetch(fetchUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${cfg.apiKey}`,
        },
        body: JSON.stringify({
          model: cfg.model,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userMessage },
          ],
          temperature: 0.3,
          max_tokens: LLM_MAX_TOKENS,
          stream: true,
          stream_options: { include_usage: true },
        }),
        signal: AbortSignal.timeout(effectiveTimeoutMs),
      });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(
      `[task-draft] mode=${input.mode} attempt=${attempt} FAIL=fetch_error protocol=${protocol} url=${cfg.url} fullUrl=${fetchUrl} model=${cfg.model} error=${JSON.stringify(msg)}`,
    );
    return { ok: false, error: `LLM request failed: ${msg}` };
  }

  // 每次上游返回都打 HTTP 状态（成功/失败都记录，便于定位路径拼错 / 401 / 上游 502 等）
  console.log(
    `[task-draft] mode=${input.mode} attempt=${attempt} HTTP status=${resp.status} protocol=${protocol} url=${cfg.url} fullUrl=${fetchUrl} model=${cfg.model}`,
  );

  if (!resp.ok) {
    let errBodyPreview = "";
    try {
      const errText = await resp.text();
      errBodyPreview = errText.length > 500 ? `${errText.slice(0, 500)}...[truncated]` : errText;
    } catch {
      errBodyPreview = "[read body failed]";
    }
    console.log(
      `[task-draft] mode=${input.mode} attempt=${attempt} FAIL=http_status status=${resp.status} protocol=${protocol} url=${cfg.url} fullUrl=${fetchUrl} model=${cfg.model} body=${JSON.stringify(errBodyPreview)}`,
    );
    return { ok: false, error: `LLM upstream ${resp.status}` };
  }

  let finishReason = "unknown";
  let completionTokens = -1;
  let content: string | undefined;

  if (protocol === "openai") {
    // 流式：读 SSE 文本，累积 delta.content + 最后 finish_reason / usage
    const sse = await parseOpenAiStream(resp);
    if (sse === null) {
      return { ok: false, error: "LLM stream response unreadable" };
    }
    content = sse.content;
    finishReason = sse.finishReason;
    completionTokens = sse.completionTokens;
  } else if (protocol === "anthropic") {
    // Anthropic 上游同样只支持 SSE（copilot 尤其如此）。读事件流，累积
    // content_block_delta.delta.text_delta.text；stop_reason / output_tokens 走
    // message_delta 事件的 usage 字段。
    const sse = await parseAnthropicStream(resp);
    if (sse === null) {
      return { ok: false, error: "LLM stream response unreadable" };
    }
    content = sse.content;
    finishReason = sse.finishReason;
    completionTokens = sse.completionTokens;
  } else {
    // responses：copilot 上游同样强制 SSE。累积 response.output_text.delta 事件的 delta；
    // status / usage.output_tokens 走 response.completed 事件。
    const sse = await parseResponsesStream(resp);
    if (sse === null) {
      return { ok: false, error: "LLM stream response unreadable" };
    }
    content = sse.content;
    finishReason = sse.finishReason;
    completionTokens = sse.completionTokens;
  }

  // 三个协议分支 content 为空时都已提前 return，到这里 content 一定非空
  if (typeof content !== "string" || content.length === 0) {
    return { ok: false, error: "LLM response content empty" };
  }

  // 观测公共字段（每条 FAIL 日志都会带这些，方便一眼看出根因）
  const obs = `attempt=${attempt} protocol=${protocol} finish_reason=${finishReason} completion_tokens=${completionTokens}`;

  // 三级兜底：直接 parse → markdown fence → 括号平衡扫描
  const parsed = extractJsonObject(content);
  if (parsed === null) {
    // 关键排查日志：把 LLM 原始 content 前 500 字打出来，方便定位是哪种失败模式
    // （标准场景 / markdown fence / 前后带自然语言 / 完全无 JSON）
    // finish_reason=length 就说明是 max_tokens 截断，需要扩大上限
    console.log(
      `[task-draft] mode=${input.mode} FAIL=json_parse ${obs} content_preview=${JSON.stringify(previewContent(content))}`,
    );
    return { ok: false, error: "LLM output is not valid JSON" };
  }
  if (typeof parsed !== "object") {
    console.log(
      `[task-draft] mode=${input.mode} FAIL=not_object ${obs} parsed_type=${typeof parsed} content_preview=${JSON.stringify(previewContent(content))}`,
    );
    return { ok: false, error: "LLM output is not a JSON object" };
  }

  const obj = parsed as Record<string, unknown>;

  // update 模式：先看 changed 字段
  if (input.mode === "update" && obj.changed === false) {
    // 保留 currentTask 值原样返回，changed=false 上层直接跳过弹窗
    return {
      ok: true,
      changed: false,
      title: input.currentTask!.title,
      description: input.currentTask!.description,
      suggestedStatus: input.currentTask!.status,
    };
  }

  // create 模式 + lockedTitle：title 强制使用 lockedTitle，只解析 description
  //
  // 宽容策略（2026-08-18）：description 只在**完全缺失/空串/非字符串**时才失败；
  // 超长自动截断到 MAX_DESC_LEN——LLM 少写几个字比返错给用户强得多。
  if (input.mode === "create" && input.lockedTitle) {
    const description = normalizeStr(obj.description, MAX_DESC_LEN, "clip");
    if (!description) {
      console.log(
        `[task-draft] mode=create-locked FAIL=description ${obs} keys=${JSON.stringify(Object.keys(obj))} desc_type=${typeof obj.description} desc_len=${typeof obj.description === "string" ? obj.description.length : "n/a"} obj_preview=${JSON.stringify(previewObj(obj))}`,
      );
      return { ok: false, error: `description missing or empty` };
    }
    const suggestedStatus = normalizeStatus(obj.suggestedStatus);
    return {
      ok: true,
      changed: true,
      title: input.lockedTitle,
      description,
      ...(suggestedStatus ? { suggestedStatus } : {}),
    };
  }

  // title 归一化：先剥指令关键词前缀，再走 clip 模式。
  //   典型场景："Fix mem:create-task JSON parse failure"（42 字，会因超 40 拒绝）
  //   → 剥离 "Fix mem:create-task " → "JSON parse failure"（更精炼且不超字）
  const rawTitle = typeof obj.title === "string" ? stripCommandKeywords(obj.title) : obj.title;
  const title = normalizeStr(rawTitle, MAX_TITLE_LEN, "clip");
  if (!title) {
    console.log(
      `[task-draft] mode=${input.mode} FAIL=title ${obs} keys=${JSON.stringify(Object.keys(obj))} title_type=${typeof obj.title} title_len=${typeof obj.title === "string" ? obj.title.length : "n/a"} obj_preview=${JSON.stringify(previewObj(obj))}`,
    );
    return { ok: false, error: `title missing or empty` };
  }
  const description = normalizeStr(obj.description, MAX_DESC_LEN, "clip");
  if (!description) {
    console.log(
      `[task-draft] mode=${input.mode} FAIL=description ${obs} keys=${JSON.stringify(Object.keys(obj))} desc_type=${typeof obj.description} desc_len=${typeof obj.description === "string" ? obj.description.length : "n/a"} obj_preview=${JSON.stringify(previewObj(obj))}`,
    );
    return { ok: false, error: `description missing or empty` };
  }
  const suggestedStatus = normalizeStatus(obj.suggestedStatus);

  return {
    ok: true,
    changed: true,
    title,
    description,
    ...(suggestedStatus ? { suggestedStatus } : {}),
  };
}

/**
 * 日志辅助：截断长字符串，防止 LLM 洗版把日志撑爆。
 * 500 字够看清 JSON 结构与主要内容，多余的用 `...[truncated N]` 标记。
 */
function previewContent(s: string): string {
  const MAX = 500;
  return s.length > MAX ? `${s.slice(0, MAX)}...[truncated ${s.length - MAX}]` : s;
}

/**
 * 日志辅助：把已解析的 obj 序列化为紧凑字符串再截断（保留结构）。
 * 用于失败分支——让排查时能一眼看到 LLM 到底填了什么字段、什么值。
 */
function previewObj(obj: Record<string, unknown>): string {
  try {
    return previewContent(JSON.stringify(obj));
  } catch {
    return "[unserializable]";
  }
}

/**
 * 解析 OpenAI chat/completions 的 SSE 流式响应。
 *
 * copilot 上游只支持 stream:true，返回 `text/event-stream`，每行形如
 * `data: {...}`，末尾 `data: [DONE]`。这里累积所有 `choices[].delta.content`
 * 片段拼成完整正文，并记录最后一个非空 finish_reason，以及
 * stream_options.include_usage=true 时末尾 usage chunk 的 completion_tokens。
 *
 * 返回 null 表示流读取失败（body 读不到 / 无有效 content）。
 */
async function parseOpenAiStream(resp: Response): Promise<{
  content: string;
  finishReason: string;
  completionTokens: number;
} | null> {
  let text: string;
  try {
    text = await resp.text();
  } catch {
    return null;
  }

  const parts: string[] = [];
  let finishReason = "unknown";
  let completionTokens = -1;

  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line.startsWith("data:")) continue;
    const dataStr = line.slice(5).trim();
    if (!dataStr || dataStr === "[DONE]") continue;

    let evt: Record<string, unknown>;
    try {
      evt = JSON.parse(dataStr) as Record<string, unknown>;
    } catch {
      continue; // keep-alive / 半包等，忽略
    }

    const choices = evt.choices;
    if (Array.isArray(choices) && choices.length > 0) {
      const first = choices[0] as Record<string, unknown>;
      if (first.finish_reason && typeof first.finish_reason === "string") {
        finishReason = first.finish_reason;
      }
      const delta = first.delta as Record<string, unknown> | undefined;
      const deltaContent = delta?.content;
      if (typeof deltaContent === "string" && deltaContent.length > 0) {
        parts.push(deltaContent);
      }
    }

    const usage = evt.usage as Record<string, unknown> | undefined;
    if (usage && typeof usage.completion_tokens === "number") {
      completionTokens = usage.completion_tokens;
    }
  }

  const content = parts.join("");
  if (content.length === 0) return null;
  return { content, finishReason, completionTokens };
}

/**
 * 解析 Anthropic Messages API 的 SSE 流式响应。
 *
 * copilot 上游对 /v1/messages 强制返 SSE（`text/event-stream`），格式：
 *   event: message_start
 *   data: {"type":"message_start", "message":{...,"usage":{"input_tokens":N,"output_tokens":M}}}
 *
 *   event: content_block_start
 *   data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}
 *
 *   event: content_block_delta
 *   data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"..."}}
 *
 *   event: message_delta
 *   data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":42}}
 *
 *   event: message_stop
 *   data: {"type":"message_stop"}
 *
 * 提取：
 *   - content = 所有 content_block_delta.delta.text_delta.text 顺序拼接
 *   - finishReason = message_delta.delta.stop_reason（若无则 unknown）
 *   - completionTokens = message_delta.usage.output_tokens
 *     （若上游把 output_tokens 塞在 message_start.message.usage 里也接住，取最后一次覆盖）
 *
 * 与 parseOpenAiStream 一致：忽略 `event:` 行、忽略 keep-alive/半包 JSON、
 * 忽略非 text_delta 的 delta（如 input_json_delta 用于 tool_use，本场景不需要）。
 *
 * 返回 null 表示：body 读不到 / 累积到最后 content 为空（无 text_delta）。
 */
async function parseAnthropicStream(resp: Response): Promise<{
  content: string;
  finishReason: string;
  completionTokens: number;
} | null> {
  let text: string;
  try {
    text = await resp.text();
  } catch {
    return null;
  }

  const parts: string[] = [];
  let finishReason = "unknown";
  let completionTokens = -1;

  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    // 只关心 `data:` 行；`event:` 行仅用于分隔事件，不含负载
    if (!line.startsWith("data:")) continue;
    const dataStr = line.slice(5).trim();
    if (!dataStr) continue;

    let evt: Record<string, unknown>;
    try {
      evt = JSON.parse(dataStr) as Record<string, unknown>;
    } catch {
      continue; // keep-alive / 半包等，忽略
    }

    const evtType = evt.type;

    // 1) content_block_delta：累积文本
    if (evtType === "content_block_delta") {
      const delta = evt.delta as Record<string, unknown> | undefined;
      if (delta && delta.type === "text_delta" && typeof delta.text === "string" && delta.text.length > 0) {
        parts.push(delta.text);
      }
      continue;
    }

    // 2) message_delta：拿 stop_reason + output_tokens
    if (evtType === "message_delta") {
      const delta = evt.delta as Record<string, unknown> | undefined;
      if (delta && typeof delta.stop_reason === "string") {
        finishReason = delta.stop_reason;
      }
      const usage = evt.usage as Record<string, unknown> | undefined;
      if (usage && typeof usage.output_tokens === "number") {
        completionTokens = usage.output_tokens;
      }
      continue;
    }

    // 3) message_start：有些上游会把 output_tokens 塞在这里（可能为 0/1，先接住兜底）
    if (evtType === "message_start") {
      const message = evt.message as Record<string, unknown> | undefined;
      const usage = message?.usage as Record<string, unknown> | undefined;
      if (usage && typeof usage.output_tokens === "number" && completionTokens < 0) {
        completionTokens = usage.output_tokens;
      }
      continue;
    }
    // 其余 event（content_block_start / content_block_stop / message_stop / ping）无需处理
  }

  const content = parts.join("");
  if (content.length === 0) return null;
  return { content, finishReason, completionTokens };
}

/**
 * 解析 OpenAI Responses API 的 SSE 流式响应。
 *
 * copilot 上游对 /responses 强制返 SSE（`text/event-stream`）。事件流格式（
 * 见 https://platform.openai.com/docs/api-reference/responses-streaming）：
 *
 *   event: response.created
 *   data: {"type":"response.created","response":{"id":"resp_x","status":"in_progress",...}}
 *
 *   event: response.output_item.added
 *   data: {"type":"response.output_item.added","output_index":0,"item":{"type":"message",...}}
 *
 *   event: response.content_part.added
 *   data: {"type":"response.content_part.added","output_index":0,"content_index":0,"part":{"type":"output_text",...}}
 *
 *   event: response.output_text.delta
 *   data: {"type":"response.output_text.delta","output_index":0,"content_index":0,"delta":"..."}
 *
 *   event: response.output_text.done
 *   data: {"type":"response.output_text.done","output_index":0,"content_index":0,"text":"完整文本"}
 *
 *   event: response.completed
 *   data: {"type":"response.completed","response":{"status":"completed","usage":{"output_tokens":42},...}}
 *
 * 提取：
 *   - content = 所有 response.output_text.delta.delta 顺序拼接
 *     （fallback：若无 delta 事件但有 response.output_text.done，直接用 done.text）
 *   - finishReason = response.completed.response.status（"completed" / "incomplete" 等）
 *   - completionTokens = response.completed.response.usage.output_tokens
 *
 * 忽略 event: 分隔行 / 半包 JSON / 其它未识别事件（如 response.in_progress、
 * response.output_item.done、response.reasoning_summary_* 等）。
 *
 * 返回 null 表示：body 读不到 / 累积到最后 content 为空。
 */
async function parseResponsesStream(resp: Response): Promise<{
  content: string;
  finishReason: string;
  completionTokens: number;
} | null> {
  let text: string;
  try {
    text = await resp.text();
  } catch {
    return null;
  }

  const parts: string[] = [];
  // 兜底：若上游不发 delta 而只发一次 output_text.done（罕见但按规范允许），
  // 保留最后一次 done.text 作为 fallback。
  let doneText: string | null = null;
  let finishReason = "unknown";
  let completionTokens = -1;

  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line.startsWith("data:")) continue;
    const dataStr = line.slice(5).trim();
    if (!dataStr) continue;

    let evt: Record<string, unknown>;
    try {
      evt = JSON.parse(dataStr) as Record<string, unknown>;
    } catch {
      continue;
    }

    const evtType = evt.type;

    // 1) response.output_text.delta：主路径，累积增量文本
    if (evtType === "response.output_text.delta") {
      const delta = evt.delta;
      if (typeof delta === "string" && delta.length > 0) {
        parts.push(delta);
      }
      continue;
    }

    // 2) response.output_text.done：fallback，拿完整 text（当无 delta 时兜底用）
    if (evtType === "response.output_text.done") {
      const t = evt.text;
      if (typeof t === "string" && t.length > 0) {
        doneText = t;
      }
      continue;
    }

    // 3) response.completed：拿最终 status / usage
    if (evtType === "response.completed") {
      const response = evt.response as Record<string, unknown> | undefined;
      if (response) {
        if (typeof response.status === "string") {
          finishReason = response.status;
        }
        const usage = response.usage as Record<string, unknown> | undefined;
        if (usage && typeof usage.output_tokens === "number") {
          completionTokens = usage.output_tokens;
        }
      }
      continue;
    }
    // 其余事件（response.created / response.in_progress / response.output_item.* /
    // response.content_part.* / response.reasoning_summary_* / ping 等）无需处理
  }

  // 优先用 delta 拼接结果；delta 全无时才回落到 done.text
  const content = parts.length > 0 ? parts.join("") : (doneText ?? "");
  if (content.length === 0) return null;
  return { content, finishReason, completionTokens };
}
