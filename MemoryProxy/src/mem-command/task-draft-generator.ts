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
  /** API 端点（不含 /chat/completions）。 */
  url: string;
  /** API Key，以 Bearer 头传递。 */
  apiKey: string;
  /** 单次调用超时（毫秒）。建议 15000-30000（草稿要写完整）。 */
  timeoutMs: number;
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

  const systemPrompt =
    input.mode === "create"
      ? (input.lockedTitle ? SYSTEM_PROMPT_CREATE_LOCKED_TITLE : SYSTEM_PROMPT_CREATE)
      : SYSTEM_PROMPT_UPDATE;
  const userMessage = buildUserMessage(input);

  let lastError = "unknown";
  for (let attempt = 1; attempt <= LLM_RETRY_MAX_ATTEMPTS; attempt++) {
    const result = await attemptDraftOnce(cfg, input, systemPrompt, userMessage, attempt);
    if (result.ok) {
      if (attempt > 1) {
        // 打点：让运维知道触发过 retry，但最终成功了
        console.log(
          `[task-draft] mode=${input.mode} RETRY_SUCCEEDED attempt=${attempt}/${LLM_RETRY_MAX_ATTEMPTS} prev_error=${JSON.stringify(lastError)}`,
        );
      }
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
  try {
    resp = await fetch(`${cfg.url}/chat/completions`, {
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
        response_format: { type: "json_object" },
      }),
      signal: AbortSignal.timeout(effectiveTimeoutMs),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `LLM request failed: ${msg}` };
  }

  if (!resp.ok) {
    console.log(
      `[task-draft] mode=${input.mode} attempt=${attempt} FAIL=http_status status=${resp.status}`,
    );
    return { ok: false, error: `LLM upstream ${resp.status}` };
  }

  let payload: unknown;
  try {
    payload = await resp.json();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `LLM response not JSON: ${msg}` };
  }

  // 观测：finish_reason + usage.completion_tokens。三种典型值：
  //   - "stop"          正常完成
  //   - "length"        触到 max_tokens 被截断 → 需要扩大 max_tokens
  //   - "content_filter" 触发安全策略 → prompt/context 有问题
  //   - null            上游没吐（多半是空对象场景）
  const finishReason =
    (payload as { choices?: Array<{ finish_reason?: string | null }> }).choices?.[0]
      ?.finish_reason ?? "unknown";
  const usage = (payload as { usage?: { completion_tokens?: number; total_tokens?: number } })
    .usage;
  const completionTokens = usage?.completion_tokens ?? -1;

  const choices = (payload as { choices?: Array<{ message?: { content?: string } }> }).choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    return { ok: false, error: "LLM response has no choices" };
  }
  const content = choices[0]?.message?.content;
  if (typeof content !== "string" || content.length === 0) {
    return { ok: false, error: "LLM response content empty" };
  }

  // 观测公共字段（每条 FAIL 日志都会带这三个，方便一眼看出根因）
  const obs = `attempt=${attempt} finish_reason=${finishReason} completion_tokens=${completionTokens}`;

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
